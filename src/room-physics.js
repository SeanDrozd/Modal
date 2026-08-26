// Pure physics functions for the room wave interference visualizer.
// No DOM dependency — loadable in Node (for tests) or browser (via <script>).
// Every function takes all state it needs as explicit arguments; nothing is
// closed over module-level mutable state, so these are safe to call from a
// test harness, the CPU render path, or (with the same math, in GLSL) a GPU
// shader path — this file is the reference implementation both should agree with.

(function(root, factory){
  const mod = factory();
  if(typeof module !== 'undefined' && module.exports){
    module.exports = mod; // Node / CommonJS (test harness)
  } else {
    root.RoomPhysics = mod; // browser global
  }
})(typeof self !== 'undefined' ? self : this, function(){

  const FT_TO_M = 0.3048;
  const C = 343; // speed of sound, m/s

  // ---- Crossover-aware gain: rolloff outside [freqLow, freqHigh] at a fixed slope ----
  function sourceGainAtFreq(source, f, slopeDbPerOct){
    slopeDbPerOct = slopeDbPerOct ?? 12;
    // A negative frequency has no physical meaning here, and (unlike f===0,
    // which the branches below already resolve to a gain of 0 via -Infinity dB)
    // it drives the log2 ratio negative, producing NaN — treat it as inaudible
    // rather than letting NaN escape and silently poison every field sum it
    // touches (see precomputeSourceImages, which also guards against this).
    if(!(f > 0)) return 0;
    let db = 0;
    if(f < source.freqLow && source.freqLow > 0){
      const octaves = Math.log2(source.freqLow / f);
      db = -slopeDbPerOct * octaves;
    } else if(f > source.freqHigh){
      const octaves = Math.log2(f / source.freqHigh);
      db = -slopeDbPerOct * octaves;
    }
    return Math.pow(10, db / 20);
  }

  // Shared "span with a smooth taper at each end" coverage helper: 1.0 inside
  // [start,end], tapering linearly to 0 over `taperFt` outside it. Used by both
  // panelCoverage (thin absorbers, taper is small) and openingOverlap (wall
  // openings, taper is room-scale) so a source/point sweeping across an edge
  // never sees a discontinuous jump in reflection amplitude (which otherwise
  // flips constructive/destructive interference for a fraction-of-an-inch move).
  function taperedCoverage(start, end, axisCoord, taperFt){
    if(axisCoord >= start && axisCoord <= end) return 1;
    if(axisCoord < start) return Math.max(0, 1 - (start - axisCoord) / taperFt);
    return Math.max(0, 1 - (axisCoord - end) / taperFt);
  }

  // ---- Wall opening (doorway/entryway): how much a wall's reflection at a
  // given along-wall coordinate is reduced. opening: { pos, width }. Position
  // is free -- an opening can sit anywhere along its wall, not just a fixed
  // corner. Returns 0 (no effect) .. 1 (fully inside the opening span).
  function openingOverlap(opening, axisCoord){
    const TAPER_FT = 3; // wider taper than panels -- an opening's edge is a room-scale acoustic transition, not a thin absorber's edge
    return taperedCoverage(opening.pos, opening.pos + opening.width, axisCoord, TAPER_FT);
  }

  // ---- Absorption panel: 0 (no extra absorption) .. 1 (fully absorptive), ----
  // depends on thickness vs. quarter-wavelength at frequency f.
  function panelAbsorptionAtFreq(panel, f){
    const lambda = C / f;
    const quarterWave = lambda / 4;
    const t = panel.thickness * FT_TO_M;
    const ratio = t / quarterWave;
    // Logistic ramp centered at ratio=0.5 (panel thickness = half a quarter-wavelength).
    // Slope of 14 keeps absorption negligible (<2%) well below the quarter-wave point —
    // e.g. a 1ft panel stays under ~2% through the 20-60Hz room-mode range, and only
    // becomes strongly absorptive (>50%) once thickness approaches the quarter-wavelength,
    // consistent with how porous absorbers actually behave.
    const x = (ratio - 0.5) * 14;
    return 1 / (1 + Math.exp(-x));
  }

  // Does the reflection point p (already on the wall's plane) fall within this
  // panel's along-wall span? Returns 0..1 with a smooth taper over TAPER_FT at
  // each end (see taperedCoverage).
  function panelCoverage(panel, axisCoord){
    const TAPER_FT = 0.5;
    return taperedCoverage(panel.pos, panel.pos + panel.length, axisCoord, TAPER_FT);
  }

  // wallName: 'left'|'right'|'front'|'back'. basePoint: {x,y,z}. panels: array.
  // panelsEnabled: bool. Returns the reflection amplitude for that wall at basePoint.
  function wallWithPanels(wallName, basePoint, baseAmp, freqForAbsorption, panels, panelsEnabled){
    if(!panelsEnabled) return baseAmp;
    const relevant = panels.filter(p => p.wall === wallName && p.enabled !== false);
    if(relevant.length === 0) return baseAmp;
    const axisCoord = (wallName === 'left' || wallName === 'right') ? basePoint.y : basePoint.x;
    let amp = baseAmp;
    for(const pnl of relevant){
      const coverage = panelCoverage(pnl, axisCoord);
      if(coverage > 0){
        const absorb = panelAbsorptionAtFreq(pnl, freqForAbsorption) * coverage;
        amp *= (1 - absorb);
      }
    }
    return amp;
  }

  // wallName: 'left'|'right'|'front'|'back'. basePoint: {x,y,z}. openings: array
  // of { wall, pos, width, factor, enabled }. openingsEnabled: bool (master
  // toggle). Returns the reflection amplitude for that wall at basePoint after
  // every relevant, enabled opening has reduced it -- multiple openings on the
  // same wall compound multiplicatively, same as overlapping panels do.
  function wallWithOpenings(wallName, basePoint, baseAmp, openings, openingsEnabled){
    if(!openingsEnabled) return baseAmp;
    const relevant = (openings || []).filter(o => o.wall === wallName && o.enabled !== false);
    if(relevant.length === 0) return baseAmp;
    const axisCoord = (wallName === 'left' || wallName === 'right') ? basePoint.y : basePoint.x;
    let amp = baseAmp;
    for(const o of relevant){
      const overlap = openingOverlap(o, axisCoord);
      if(overlap > 0){
        amp *= (1 - o.factor * overlap);
      }
    }
    return amp;
  }

  // ---- Six boundary reflection operators for a room { w, d, h } ----
  // ctx: { room, wallReflect, openings, openingsEnabled, panels, panelsEnabled }
  // Openings reduce a wall's base reflectivity first (sound passes through into
  // another space); panel absorption is then applied on top of whatever
  // reflectivity remains. Floor/ceiling are unaffected by either -- both
  // openings and panels are wall-mounted concepts in this model.
  function boundaryOps(freqForAbsorption, ctx){
    const { room, wallReflect, openings, openingsEnabled, panels, panelsEnabled } = ctx;
    const w = room.w, d = room.d, h = room.h;
    function wallAmp(wallName){
      return (p) => {
        const afterOpenings = wallWithOpenings(wallName, p, wallReflect, openings, openingsEnabled);
        return wallWithPanels(wallName, p, afterOpenings, freqForAbsorption, panels, panelsEnabled);
      };
    }
    return [
      { name:'left',  apply:(p)=>({x:-p.x, y:p.y, z:p.z}), amp: wallAmp('left') },
      { name:'right', apply:(p)=>({x:2*w-p.x, y:p.y, z:p.z}), amp: wallAmp('right') },
      { name:'front', apply:(p)=>({x:p.x, y:-p.y, z:p.z}), amp: wallAmp('front') },
      { name:'back',  apply:(p)=>({x:p.x, y:2*d-p.y, z:p.z}), amp: wallAmp('back') },
      { name:'floor', apply:(p)=>({x:p.x, y:p.y, z:-p.z}), amp:(p)=>wallReflect },
      { name:'ceil',  apply:(p)=>({x:p.x, y:p.y, z:2*h-p.z}), amp:(p)=>wallReflect }
    ];
  }

  // Generates image sources up to `order` bounces (1 = direct + 6 single-wall
  // bounces; 2 additionally includes every pair of DIFFERENT boundaries bounced
  // off in sequence). ctx: { room, wallReflect, openings, openingsEnabled, panels, panelsEnabled }
  function getImageSources(sx, sy, sz, order, freqForAbsorption, ctx){
    const ops = boundaryOps(freqForAbsorption, ctx);
    const direct = { x: sx, y: sy, z: sz, amp: 1.0 };
    let result = [direct];

    const firstOrder = ops.map(op => {
      const pos = op.apply(direct);
      const amp = op.amp(direct);
      return { ...pos, amp, lastOp: op.name };
    });
    result = result.concat(firstOrder);

    if(order >= 2){
      for(const img of firstOrder){
        for(const op of ops){
          if(op.name === img.lastOp) continue;
          const pos = op.apply(img);
          const amp = img.amp * op.amp(img);
          result.push({ ...pos, amp, lastOp: op.name });
        }
      }
    }
    return result;
  }

  // Precomputes each source's image-source list once per source (position/amp
  // only depend on source+room+panels+frequency, never on the grid point).
  // ctx: { room, wallReflect, openings, openingsEnabled, panels, panelsEnabled }
  function precomputeSourceImages(sources, order, freq, ctx){
    return sources.map(s => {
      const freqGain = sourceGainAtFreq(s, freq);
      // Written as !(freqGain >= 0.0005) rather than freqGain < 0.0005 so a
      // non-finite gain (NaN) is also dropped here — NaN fails every direct
      // comparison, so freqGain < 0.0005 would let it silently through instead
      // of being filtered like a genuinely-quiet source.
      if(!(freqGain >= 0.0005)) return null;
      const imgSources = getImageSources(s.x, s.y, s.z ?? 3, order, freq, ctx);
      const delaySec = s.delayMs / 1000;
      const levelGain = Math.pow(10, s.levelDb / 20) * freqGain;
      const extraPhase = 2 * Math.PI * freq * delaySec;
      return { imgSources, levelGain, extraPhase };
    });
  }

  // Sums complex pressure at (px,py,pz) from a precomputed source list.
  function computeFieldAtPoint(px, py, pz, precomputed, k){
    let re = 0, im = 0;
    for(const pre of precomputed){
      if(!pre) continue;
      const imgSources = pre.imgSources;
      const levelGain = pre.levelGain;
      const extraPhase = pre.extraPhase;
      for(const src of imgSources){
        const dx = (px - src.x) * FT_TO_M;
        const dy = (py - src.y) * FT_TO_M;
        const dz = (pz - src.z) * FT_TO_M;
        let r = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if(r < 0.3) r = 0.3;
        const amp = (src.amp / r) * levelGain;
        const phase = k*r + extraPhase;
        re += amp * Math.cos(phase);
        im += amp * Math.sin(phase);
      }
    }
    return { re, im };
  }

  // Convenience: full pressure-to-dB at one point, given app state. Mirrors what
  // draw() does per grid point, but callable standalone (e.g. for two-ear sampling,
  // or tests) without running the full grid.
  function fieldDbAtPoint(px, py, pz, sources, order, freq, ctx, refAmp){
    refAmp = refAmp ?? 1.0;
    const lambda = C / freq;
    const k = 2 * Math.PI / lambda;
    const precomputed = precomputeSourceImages(sources, order, freq, ctx);
    const { re, im } = computeFieldAtPoint(px, py, pz, precomputed, k);
    const mag = Math.sqrt(re*re + im*im);
    return 20 * Math.log10(Math.max(mag, 1e-6) / refAmp);
  }

  // ---- Two-ear listener sampling ----
  // Average adult inter-ear spacing is roughly 17cm (0.17m); this offsets a
  // listener position by half that distance to each side, perpendicular to a
  // given facing direction, to get left/right ear positions. Wavelength and
  // ear spacing start to overlap noticeably in the 200-500Hz range, so the two
  // ears can genuinely sample different points in the interference pattern —
  // negligible at bass frequencies, more meaningful higher up.
  const EAR_SPACING_M = 0.17;

  // facingDegrees: 0 = facing -y (toward the front wall/mains, "up" on the map,
  // since y increases downward on-screen), increasing clockwise, matching how
  // the room's x/y axes are used elsewhere in this file.
  function earPositions(listener, facingDegrees){
    const facing = facingDegrees ?? 0;
    const halfSpacingFt = (EAR_SPACING_M / 2) / FT_TO_M;
    const rad = facing * Math.PI / 180;
    // Facing vector (0deg = -y): (sin, -cos). Rightward perpendicular to that
    // (the direction from left ear to right ear, facing that way): (cos, sin).
    const dx = Math.cos(rad) * halfSpacingFt;
    const dy = Math.sin(rad) * halfSpacingFt;
    return {
      left:  { x: listener.x - dx, y: listener.y - dy, z: listener.z },
      right: { x: listener.x + dx, y: listener.y + dy, z: listener.z }
    };
  }

  // Evaluates the field at both ears for a listener position/orientation.
  // Returns per-ear dB plus the difference between them (a direct, quantified
  // measure of how much the two ears disagree at this frequency/position —
  // near-zero at bass, potentially large near 200-500Hz interference detail).
  function fieldDbAtEars(listener, facingDegrees, sources, order, freq, ctx, refAmp){
    const ears = earPositions(listener, facingDegrees);
    const leftDb = fieldDbAtPoint(ears.left.x, ears.left.y, ears.left.z, sources, order, freq, ctx, refAmp);
    const rightDb = fieldDbAtPoint(ears.right.x, ears.right.y, ears.right.z, sources, order, freq, ctx, refAmp);
    return { leftDb, rightDb, diffDb: Math.abs(leftDb - rightDb), earPositions: ears };
  }

  // ---- Axial room mode frequencies for one dimension ----
  function axialModes(dimFt, maxOrder, maxFreq){
    const dimM = dimFt * FT_TO_M;
    const modes = [];
    for(let n = 1; n <= maxOrder; n++){
      const f = (C / 2) * (n / dimM);
      if(f <= maxFreq) modes.push(f);
    }
    return modes;
  }

  // ---- Schroeder frequency ----
  // The crossover between "discrete, individually-identifiable room modes"
  // (below f_s) and "statistically dense/diffuse reverberant field" (above f_s),
  // per Schroeder's classic formula: f_s = 2000 * sqrt(T60 / V), with T60 in
  // seconds and V in cubic meters. Above this frequency, modes overlap so much
  // that a single-frequency room-mode visualization stops being a meaningful
  // diagnostic — the response is no longer dominated by a few distinct peaks/
  // nulls, so there's little point extending a room-mode tool's range past it.
  // T60 (reverberation time) isn't measured by this tool, so a typical
  // untreated-to-lightly-treated small/medium room value is assumed by default.
  function schroederFrequency(room, t60Seconds){
    const t60 = t60Seconds ?? 0.4;
    const volumeM3 = (room.w * room.d * room.h) * (FT_TO_M ** 3);
    if(volumeM3 <= 0) return 0;
    return 2000 * Math.sqrt(t60 / volumeM3);
  }

  // ---- Null-proximity classification ----
  // dB is a logarithm of pressure, so near a true destructive-interference null
  // (pressure -> 0), a vanishingly small position difference can swing dB by tens
  // of decibels even though the underlying LINEAR pressure values agree closely.
  // This means comparing two independent implementations (e.g. CPU JS vs GPU GLSL)
  // point-by-point in dB will show large, expected disagreement right at nulls —
  // that disagreement is a property of dB math near zero, not evidence either
  // implementation is wrong. Use this to separate "real" discrepancies (away from
  // nulls) from "expected" ones (near nulls) when comparing two field computations.
  function isNearNull(dbValue, thresholdDb){
    thresholdDb = thresholdDb ?? -40;
    return dbValue < thresholdDb;
  }

  // ---- Sub placement scoring ----
  // Scores one candidate sub position (combined with any other already-placed
  // sources — mains, other subs) by evaluating the field at multiple frequencies
  // across a target band, at one or more listening positions, and combining
  // three things a good sub position should deliver:
  //   1. Reasonably high average level (not stuck in a general low zone)
  //   2. Low variance across frequency AT EACH listener (flat response — avoids
  //      being loud at some frequencies and nulled at others, the classic
  //      "one big room-mode hole" problem)
  //   3. Consistency ACROSS listeners (a position that's great at one seat but
  //      terrible at another is a worse practical choice than one that's decent
  //      everywhere, even if its single-seat peak score is lower)
  //
  // Returns a single scalar score where HIGHER IS BETTER, plus the raw per-listener
  // per-frequency dB values for diagnostics/visualization.
  function scoreSubPosition(candidatePos, otherSources, room, freqList, listenerPositions, physicsCtx, reflectionOrder){
    const candidateSource = Object.assign(
      { name: 'candidate', levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000, enabled: true },
      candidatePos
    );
    const allSources = otherSources.concat([candidateSource]);

    const perListenerDb = []; // [listenerIdx][freqIdx] = dB
    for(const lp of listenerPositions){
      const dbRow = [];
      for(const f of freqList){
        const precomputed = precomputeSourceImages(allSources, reflectionOrder, f, physicsCtx);
        const k = 2 * Math.PI * f / C;
        const { re, im } = computeFieldAtPoint(lp.x, lp.y, lp.z, precomputed, k);
        const mag = Math.sqrt(re*re + im*im);
        dbRow.push(20 * Math.log10(Math.max(mag, 1e-6)));
      }
      perListenerDb.push(dbRow);
    }

    // Per-listener stats: mean level and standard deviation (flatness) across frequency.
    const listenerStats = perListenerDb.map(dbRow => {
      const mean = dbRow.reduce((a,b) => a+b, 0) / dbRow.length;
      const variance = dbRow.reduce((a,b) => a + (b-mean)*(b-mean), 0) / dbRow.length;
      const stdDev = Math.sqrt(variance);
      const minDb = Math.min(...dbRow);
      return { mean, stdDev, minDb };
    });

    // Combine across listeners: average mean level, but penalize by the WORST
    // listener's flatness and worst listener's minimum (so one bad seat can't be
    // hidden by averaging against good ones — matches "shouldn't be great at one
    // seat and terrible at another").
    const avgMean = listenerStats.reduce((a,s) => a+s.mean, 0) / listenerStats.length;
    const worstStdDev = Math.max(...listenerStats.map(s => s.stdDev));
    const worstMinDb = Math.min(...listenerStats.map(s => s.minDb));

    // Score weights: level matters, but flatness (avoiding deep nulls) matters more —
    // a loud position with a severe null at one frequency is a worse real-world
    // outcome than a slightly quieter but consistently flat one.
    const score = avgMean - (worstStdDev * 1.5) - Math.max(0, -worstMinDb - 20) * 0.5;

    return {
      score,
      avgMean,
      worstStdDev,
      worstMinDb,
      perListenerDb,
      listenerStats
    };
  }

  // ---- Candidate position filtering ----
  // A candidate is valid if it's inside the room, outside every off-limits zone,
  // and (if any preferred zones are defined) inside at least one preferred zone.
  // Zones are axis-aligned rectangles: { x, y, width, height } in feet.
  function isPointInRect(px, py, rect){
    return px >= rect.x && px <= rect.x + rect.width &&
           py >= rect.y && py <= rect.y + rect.height;
  }

  function isCandidateValid(px, py, room, offLimitZones, preferredZones, excludePoints, minSeparationFt){
    if(px < 0 || px > room.w || py < 0 || py > room.d) return false;
    for(const zone of (offLimitZones || [])){
      if(isPointInRect(px, py, zone)) return false;
    }
    if(preferredZones && preferredZones.length > 0){
      const inAnyPreferred = preferredZones.some(zone => isPointInRect(px, py, zone));
      if(!inAnyPreferred) return false;
    }
    // Enforce a minimum distance from any already-placed point (e.g. other subs
    // placed in earlier greedy rounds). Without this, the greedy search can
    // legitimately re-pick the exact same spot for multiple subs, since two
    // co-located subs simply sum louder rather than being penalized for
    // redundancy — nothing in the scoring function itself discourages stacking.
    if(excludePoints && excludePoints.length > 0 && minSeparationFt > 0){
      for(const p of excludePoints){
        const dist = Math.sqrt((px-p.x)**2 + (py-p.y)**2);
        if(dist < minSeparationFt) return false;
      }
    }
    return true;
  }

  // ---- Single-sub grid search optimizer ----
  // Scans a grid of candidate positions (respecting off-limits/preferred zones
  // and, if provided, a minimum separation from excludePoints), scores each with
  // scoreSubPosition, and returns the best one plus the full scored grid (useful
  // for visualizing "how good is every position", not just the winner).
  function optimizeSubPlacement(options){
    const {
      room, otherSources, freqList, listenerPositions, physicsCtx, reflectionOrder,
      offLimitZones, preferredZones, gridStepFt, subHeightFt, excludePoints, minSeparationFt
    } = options;
    const step = gridStepFt || 0.5;
    const z = subHeightFt ?? 1;

    const results = [];
    let best = null;

    for(let x = step/2; x < room.w; x += step){
      for(let y = step/2; y < room.d; y += step){
        if(!isCandidateValid(x, y, room, offLimitZones, preferredZones, excludePoints, minSeparationFt)) continue;
        const eval_ = scoreSubPosition({ x, y, z }, otherSources, room, freqList, listenerPositions, physicsCtx, reflectionOrder);
        const entry = { x, y, z, score: eval_.score, avgMean: eval_.avgMean, worstStdDev: eval_.worstStdDev, worstMinDb: eval_.worstMinDb };
        results.push(entry);
        if(best === null || entry.score > best.score) best = entry;
      }
    }

    return { best, allCandidates: results };
  }

  // ---- Multi-sub greedy sequential optimizer ----
  // Places subs one at a time: find the best position for sub 1 (given only the
  // mains/other fixed sources), fix it in place, then find the best position for
  // sub 2 GIVEN sub 1 is already there, and so on. This is a well-established
  // approximation for multi-source placement — it doesn't guarantee the globally
  // optimal N-sub arrangement (that would require searching all N-tuples of
  // positions jointly), but it turns an exponential search (candidates^N) into a
  // linear one (candidates*N), which is the difference between "usable" and
  // "computationally impossible" once N is more than 2 or so.
  //
  // Each already-placed sub is folded into `otherSources` for the next round, so
  // later subs are scored against the REAL combined field of everything placed
  // so far, not against the mains alone.
  function optimizeMultipleSubs(options){
    const {
      room, otherSources, numSubs, freqList, listenerPositions, physicsCtx,
      reflectionOrder, offLimitZones, preferredZones, gridStepFt, subHeightFt, minSeparationFt
    } = options;
    // Default separation: a fraction of the room's smaller dimension, so it
    // scales sensibly across room sizes rather than being a fixed number that's
    // too strict in a small room or too loose in a large one.
    const separation = minSeparationFt ?? Math.max(1, Math.min(room.w, room.d) * 0.15);

    const placedSubs = [];
    const placedPositions = [];
    const roundResults = []; // one optimizeSubPlacement result per sub placed, for diagnostics/visualization
    let currentOtherSources = otherSources.slice();

    for(let i = 0; i < numSubs; i++){
      const roundResult = optimizeSubPlacement({
        room, otherSources: currentOtherSources, freqList, listenerPositions,
        physicsCtx, reflectionOrder, offLimitZones, preferredZones, gridStepFt, subHeightFt,
        excludePoints: placedPositions, minSeparationFt: separation
      });
      roundResults.push(roundResult);
      if(roundResult.best === null){
        // No valid candidate left (e.g. zones fully exhausted, or every remaining
        // spot is too close to an already-placed sub) — stop rather than erroring;
        // return what was successfully placed so far.
        break;
      }
      const placedSub = Object.assign(
        { name: `Sub ${i+1}`, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80, enabled: true },
        { x: roundResult.best.x, y: roundResult.best.y, z: roundResult.best.z }
      );
      placedSubs.push(placedSub);
      placedPositions.push({ x: placedSub.x, y: placedSub.y });
      currentOtherSources = currentOtherSources.concat([placedSub]);
    }

    return { placedSubs, roundResults };
  }

  return {
    FT_TO_M, C,
    sourceGainAtFreq,
    openingOverlap,
    wallWithOpenings,
    panelAbsorptionAtFreq,
    panelCoverage,
    wallWithPanels,
    boundaryOps,
    getImageSources,
    precomputeSourceImages,
    computeFieldAtPoint,
    fieldDbAtPoint,
    axialModes,
    schroederFrequency,
    earPositions,
    fieldDbAtEars,
    isNearNull,
    scoreSubPosition,
    isPointInRect,
    isCandidateValid,
    optimizeSubPlacement,
    optimizeMultipleSubs
  };
});
