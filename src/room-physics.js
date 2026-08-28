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

  // ---- Crossover-aware gain: rolloff outside [freqLow, freqHigh] ----
  // slopeDbPerOct is per-source (source.rolloffDbPerOct in the UI), defaulting
  // to 24 dB/octave (a 4th-order Linkwitz-Riley slope, the common default for
  // AVR bass-management crossovers -- e.g. THX's 80Hz/LR4 spec) when a source
  // doesn't specify one, including every source from a preset saved before
  // this was configurable.
  function sourceGainAtFreq(source, f, slopeDbPerOct){
    slopeDbPerOct = slopeDbPerOct ?? source.rolloffDbPerOct ?? 24;
    // A negative frequency has no physical meaning here, and (unlike f===0,
    // which the branches below already resolve to a gain of 0 via -Infinity dB)
    // it drives the log2 ratio negative, producing NaN — treat it as inaudible
    // rather than letting NaN escape and silently poison every field sum it
    // touches (see precomputeModalField, which also guards against this).
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

  // ---- Wall/ceiling material: frequency-dependent reflectivity for a BARE ----
  // surface. Two distinct real mechanisms, selected by material.shape:
  //
  // shape: 'resonant' (default when omitted) -- ordinary drywall-on-studs/
  // joists construction behaves as a mass-spring-mass "membrane absorber":
  // the surface + the air cavity behind it resonate at a frequency set mostly
  // by mass and cavity depth, and the surface absorbs MORE right around that
  // resonance than elsewhere. Rigid materials (masonry/concrete) have no such
  // mechanism (peakDepth: 0 collapses this to a flat baseReflect).
  //   { baseReflect, peakFreq, peakDepth, bandwidth }
  //   peakFreq/bandwidth: center and width (Hz) of the extra-absorptive dip.
  //   peakDepth: 0..1, fraction of baseReflect additionally absorbed AT peakFreq.
  //
  // shape: 'porousRamp' -- broadband porous absorption (e.g. suspended
  // acoustic ceiling tile), as a SURFACE's own base behavior.
  // Absorption ramps UP with frequency (a logistic curve centered at midFreq)
  // -- the opposite trend from 'resonant'. Within this app's sub-300Hz range,
  // typical acoustic tile shows only modest absorption; it's much more
  // effective well above what a room-mode tool models -- itself a real,
  // worth-knowing fact (acoustic tile is not a bass fix).
  //   { shape:'porousRamp', baseReflect, midFreq, slope, maxAbsorb }
  //
  // A null/undefined material means "no material assigned" -- callers should
  // fall back to a plain flat scalar (e.g. the legacy wallReflect slider).
  //
  // These are illustrative/typical values (see WALL_MATERIALS below), not
  // measured data -- real wall/ceiling behavior depends on construction
  // details no small preset set can capture exactly. A reasonable
  // approximation, not a substitute for measurement.
  function wallMaterialReflectAtFreq(material, f){
    if(!material) return null;
    if(material.shape === 'porousRamp'){
      const x = (f - material.midFreq) * material.slope;
      const absorb = material.maxAbsorb / (1 + Math.exp(-x));
      return material.baseReflect * (1 - absorb);
    }
    if(!(material.peakDepth > 0)) return material.baseReflect;
    const x = (f - material.peakFreq) / material.bandwidth;
    const dip = material.peakDepth * Math.exp(-(x * x));
    return material.baseReflect * (1 - dip);
  }

  // Named presets for the "Wall material" / "Ceiling material" UI pickers.
  // Roughly: insulation in the cavity damps the panel's resonant motion,
  // converting more of it to heat (deeper AND broader absorption) rather than
  // letting it ring/re-radiate (hollowCavity's narrower, shallower dip);
  // masonry has no membrane at all; suspendedTile is ceiling-only in the UI
  // (walls essentially never use it) and uses the porousRamp shape instead.
  //
  // baseReflect/peakDepth calibrated against published low-frequency
  // absorption-coefficient (alpha) tables, converted to this module's
  // pressure-reflection convention via reflect = sqrt(1 - alpha):
  //   drywallHollow: 1/2" gypsum board nailed to 2x4 studs, 16" O.C. --
  //     alpha 0.29 @125Hz, 0.10 @250Hz, ~0.05-0.09 @500Hz-4kHz (flat baseline).
  //     drywallInsulated has no matching published curve; its deeper/wider
  //     dip is a physically-motivated scale-up of the hollow curve (damped
  //     cavity fill -> more energy converted to heat at resonance) rather
  //     than a directly sourced number.
  //   masonry: painted/bare concrete block or poured foundation --
  //     alpha ~0.01 (smooth painted concrete) to ~0.05 (porous block) @125Hz;
  //     0.03 taken as a representative mid-range value.
  // Previous defaults (reflect 0.75-0.90, i.e. alpha 0.19-0.44 baseline) were
  // roughly 2-4x too absorptive at bass frequencies for a BARE surface --
  // real hard/rigid low-frequency boundaries are close to rigid away from
  // their resonance, which these updated values now reflect.
  const WALL_MATERIALS = {
    drywallInsulated: { baseReflect: 0.97, peakFreq: 80, peakDepth: 0.20, bandwidth: 150 },
    drywallHollow:    { baseReflect: 0.97, peakFreq: 90, peakDepth: 0.14, bandwidth: 115 },
    masonry:          { baseReflect: 0.985, peakFreq: 0,  peakDepth: 0,    bandwidth: 1 },
    suspendedTile:    { shape: 'porousRamp', baseReflect: 0.75, midFreq: 280, slope: 0.03, maxAbsorb: 0.6 }
  };

  // ---- Six boundary reflection operators for a room { w, d, h } ----
  // ---- Rectangular-room modal (eigenfunction) solution ----
  // Replaces the old truncated image-source method entirely. For a rigid-wall
  // rectangular room, the exact steady-state pressure field is a sum over the
  // room's normal modes (nx,ny,nz):
  //
  //   p(r, r_s, f) = sum_n  A_n * psi_n(r) * psi_n(r_s) / (k_n^2 - k^2 - j*k*delta_n)
  //
  // where psi_n(r) = cos(nx*pi*x/Lx)*cos(ny*pi*y/Ly)*cos(nz*pi*z/Lz) is the
  // rigid-wall eigenfunction, k_n = pi*sqrt((nx/Lx)^2+(ny/Ly)^2+(nz/Lz)^2) is
  // the modal wavenumber, k = 2*pi*f/c is the driving wavenumber, A_n is a
  // normalization constant, and delta_n is per-mode damping derived from wall
  // absorption (see enumerateModes below). This is the same class of method
  // REW's own room simulator uses ("rigid boundary solution to the wave
  // equation, modified for lossy boundaries").
  //
  // Unlike the old image-source method, this has no "order" to truncate --
  // every mode below the cutoff is included exactly, so there's no tradeoff
  // between accuracy and how many terms you compute (more modes just extends
  // the cutoff higher, it doesn't refine modes already included).
  const MODE_CUTOFF_HZ = 300; // 1.5x this app's ~200Hz scope -- a mode's tail contributes below its own resonance, so the cutoff needs headroom above the range actually displayed

  function epsFactor(n){ return n === 0 ? 1 : 2; } // integral of cos^2(n*pi*x/L) over [0,L] is L if n=0, else L/2 -- this is the 1/that normalization factor

  // Same fallback-to-flat-scalar convention as estimatedT60's wallReflectFor:
  // a per-wall/ceiling material (frequency-dependent) if assigned, otherwise
  // the flat wallReflect/floorReflect scalar. Floor has no material concept
  // in this codebase (see estimatedT60), only a flat reflect value.
  function surfaceReflectAtFreq(surfaceName, freqForAbsorption, ctx){
    if(surfaceName === 'floor') return ctx.floorReflect ?? ctx.wallReflect;
    if(surfaceName === 'ceil'){
      const fromMaterial = ctx.ceilingMaterial ? wallMaterialReflectAtFreq(ctx.ceilingMaterial, freqForAbsorption) : null;
      return fromMaterial ?? ctx.wallReflect;
    }
    const material = ctx.wallMaterials && ctx.wallMaterials[surfaceName];
    const fromMaterial = material ? wallMaterialReflectAtFreq(material, freqForAbsorption) : null;
    return fromMaterial ?? ctx.wallReflect;
  }

  // ---- Enumerates every room mode with resonance frequency <= cutoffFreq ----
  // ctx: { room, wallReflect, floorReflect, ceilingMaterial, wallMaterials }.
  // Depends only on room geometry + wall materials, not on source/listener
  // position or the frequency being evaluated -- callers doing a frequency
  // sweep (spatiallyAveragedResponse) or many candidate evaluations
  // (scoreSubPosition) should compute this ONCE and reuse it, rather than
  // re-enumerating per frequency/candidate.
  //
  // Each mode's own damping (delta_n) is derived via the standard perturbative
  // (Kuttruff) coupled-mode result for lightly-damped walls -- valid here
  // since WALL_MATERIALS' reflect values are all >=0.97 (light damping is
  // exactly the regime this approximation assumes): a surface-area-weighted,
  // mode-shape-weighted average of each of the 6 surfaces' absorption
  // (alpha = 1 - reflect^2, evaluated at that mode's OWN resonance frequency
  // f_n -- the same alpha convention estimatedT60 already uses):
  //
  //   delta_n = (c / 4V) * sum_surfaces  alpha_s(f_n) * (integral of psi_n^2 over surface s)
  //
  // Because psi_n factors into cos(nx..)*cos(ny..)*cos(nz..), each surface's
  // integral collapses to a simple product of per-axis L/eps(n) terms -- e.g.
  // the left/right walls (area Ly*Lz) only depend on ny,nz (cos^2 of the
  // WALL-NORMAL index is always 1 exactly AT the wall, regardless of that
  // index -- only the two axes running ALONG the wall matter):
  //   S_x = (Ly/eps(ny)) * (Lz/eps(nz))   -- shared by left+right
  //   S_y = (Lx/eps(nx)) * (Lz/eps(nz))   -- shared by front+back
  //   S_z = (Lx/eps(nx)) * (Ly/eps(ny))   -- shared by floor+ceiling
  // This genuinely varies per mode under UNIFORM absorption too (a pure axial
  // mode's along-wall eps(0)=1 vs an oblique mode's eps>1 on multiple axes) --
  // that's real physics (different mode families couple to the boundaries
  // differently), not a bug. What SHOULD hold in the uniform-absorption case
  // is a looser, statistical one: delta_n averaged across many modes should
  // track alpha*S_total/(4V) (the Sabine-equivalent quantity) -- see the
  // cross-check test tying this to estimatedT60's existing Sabine output.
  //
  // Units: this formula is naturally a TEMPORAL damping rate (1/s, Kuttruff's
  // own convention). The complex denominator in precomputeModalField is
  // written in wavenumber space (k_n^2 - k^2 - j*k*delta_n), which needs
  // delta_n in units of 1/m (spatial) instead -- i.e. this temporal rate
  // divided by c. The code below folds that division in directly (1/(4V)
  // rather than c/(4V), since the c's cancel) rather than computing a
  // temporal rate and converting it separately.
  function enumerateModes(ctx, cutoffFreq){
    cutoffFreq = cutoffFreq ?? MODE_CUTOFF_HZ;
    const { room } = ctx;
    const Lx = room.w * FT_TO_M, Ly = room.d * FT_TO_M, Lz = room.h * FT_TO_M;
    if(!(Lx > 0) || !(Ly > 0) || !(Lz > 0)) return []; // degenerate room -- no modes, not NaN/Infinity

    const V = Lx * Ly * Lz;
    const piOverLx = Math.PI / Lx, piOverLy = Math.PI / Ly, piOverLz = Math.PI / Lz;
    const maxNx = Math.floor(2 * Lx * cutoffFreq / C);
    const maxNy = Math.floor(2 * Ly * cutoffFreq / C);
    const maxNz = Math.floor(2 * Lz * cutoffFreq / C);

    const modes = [];
    for(let nx = 0; nx <= maxNx; nx++){
      for(let ny = 0; ny <= maxNy; ny++){
        for(let nz = 0; nz <= maxNz; nz++){
          if(nx === 0 && ny === 0 && nz === 0) continue; // not a propagating mode (DC/uniform pressure)
          const kn = Math.PI * Math.sqrt((nx/Lx)**2 + (ny/Ly)**2 + (nz/Lz)**2);
          const fn = C * kn / (2 * Math.PI);
          if(fn > cutoffFreq) continue;

          const epsX = epsFactor(nx), epsY = epsFactor(ny), epsZ = epsFactor(nz);
          const An = C * C * epsX * epsY * epsZ / V;

          const Sx = (Ly / epsY) * (Lz / epsZ);
          const Sy = (Lx / epsX) * (Lz / epsZ);
          const Sz = (Lx / epsX) * (Ly / epsY);
          const alphaOf = (surfaceName) => {
            const r = surfaceReflectAtFreq(surfaceName, fn, ctx);
            return 1 - r * r;
          };
          // Kuttruff's coupled-mode damping is naturally a TEMPORAL rate (1/s):
          // delta_n_temporal = (c/4V) * sum(...). The complex denominator below
          // is written in wavenumber space (k_n^2 - k^2 - j*k*delta_n), which
          // needs delta_n in units of 1/m (spatial), i.e. delta_n_temporal/c --
          // the c cancels the leading (c/4V), leaving just 1/(4V) here.
          const deltaN = (1 / (4 * V)) * (
            alphaOf('left') * Sx + alphaOf('right') * Sx +
            alphaOf('front') * Sy + alphaOf('back') * Sy +
            alphaOf('floor') * Sz + alphaOf('ceil') * Sz
          );

          modes.push({ nx, ny, nz, kn, fn, deltaN, An, invLx: nx * piOverLx, invLy: ny * piOverLy, invLz: nz * piOverLz });
        }
      }
    }
    return modes;
  }

  // ---- Precomputes each mode's complex coefficient for one source set + ----
  // frequency. The complex division 1/(k_n^2-k^2-j*k*delta_n) and the
  // per-source coupling sum both happen ONCE per mode here, not once per
  // (mode x query point) -- computeFieldAtPoint then only needs a cheap
  // real-valued psi_n(point) evaluation and a complex multiply per mode.
  // modes: enumerateModes(ctx) output (caller-supplied so it can be reused
  // across a frequency sweep).
  function precomputeModalField(sources, freq, ctx, modes){
    const k = 2 * Math.PI * freq / C;
    const active = [];
    for(const s of sources){
      const freqGain = sourceGainAtFreq(s, freq);
      // Same NaN-safe guard as the old precomputeSourceImages: written as
      // !(freqGain >= 0.0005) so a non-finite gain is dropped here too.
      if(!(freqGain >= 0.0005)) continue;
      const levelGain = Math.pow(10, s.levelDb / 20) * freqGain;
      const extraPhase = 2 * Math.PI * freq * (s.delayMs / 1000);
      active.push({
        x: s.x * FT_TO_M, y: s.y * FT_TO_M, z: (s.z ?? 3) * FT_TO_M,
        levelGain, cosPhase: Math.cos(extraPhase), sinPhase: Math.sin(extraPhase)
      });
    }

    return modes.map(mode => {
      const Dr = mode.kn * mode.kn - k * k;
      const Di = -k * mode.deltaN;
      const denom = Dr * Dr + Di * Di;
      const invDr = denom > 0 ? Dr / denom : 0;
      const invDi = denom > 0 ? -Di / denom : 0; // 1/(Dr+jDi) = (Dr-jDi)/(Dr^2+Di^2)

      let sourceRe = 0, sourceIm = 0;
      for(const src of active){
        const psi = Math.cos(mode.invLx * src.x) * Math.cos(mode.invLy * src.y) * Math.cos(mode.invLz * src.z);
        const amp = src.levelGain * psi;
        sourceRe += amp * src.cosPhase;
        sourceIm += amp * src.sinPhase;
      }

      // coef = An * (sourceRe + j*sourceIm) * (invDr + j*invDi)
      const coefRe = mode.An * (sourceRe * invDr - sourceIm * invDi);
      const coefIm = mode.An * (sourceRe * invDi + sourceIm * invDr);
      return { invLx: mode.invLx, invLy: mode.invLy, invLz: mode.invLz, coefRe, coefIm };
    });
  }

  // Sums complex pressure at (px,py,pz) from a precomputeModalField result.
  function computeFieldAtPoint(px, py, pz, precomputed){
    const pxM = px * FT_TO_M, pyM = py * FT_TO_M, pzM = pz * FT_TO_M;
    let re = 0, im = 0;
    for(const mode of precomputed){
      const psi = Math.cos(mode.invLx * pxM) * Math.cos(mode.invLy * pyM) * Math.cos(mode.invLz * pzM);
      re += mode.coefRe * psi;
      im += mode.coefIm * psi;
    }
    return { re, im };
  }

  // Convenience: full pressure-to-dB at one point, given app state. Mirrors what
  // draw() does per grid point, but callable standalone (e.g. for two-ear sampling,
  // or tests) without running the full grid.
  function fieldDbAtPoint(px, py, pz, sources, freq, ctx, refAmp){
    refAmp = refAmp ?? 1.0;
    const modes = enumerateModes(ctx);
    const precomputed = precomputeModalField(sources, freq, ctx, modes);
    const { re, im } = computeFieldAtPoint(px, py, pz, precomputed);
    const mag = Math.sqrt(re*re + im*im);
    return 20 * Math.log10(Math.max(mag, 1e-6) / refAmp);
  }

  // ---- Spherical spatial sampling (moving-mic-style measurement) ----
  // Deterministically distributes `n` points through a sphere of `radiusFt`
  // around (cx,cy,cz): a Fibonacci-lattice direction for even angular
  // coverage, scaled by a cube-root radius fraction so the points fill the
  // sphere's VOLUME with roughly uniform density (equal expected volume per
  // point) rather than clustering on the outer shell. Deterministic (no RNG)
  // so the same inputs always produce the same cloud -- a UI value shouldn't
  // flicker between otherwise-identical redraws.
  function sphereSamplePoints(cx, cy, cz, radiusFt, n){
    const points = [];
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for(let i = 0; i < n; i++){
      const t = (i + 0.5) / n;
      const zUnit = 1 - 2 * t; // -1..1, evenly stepped
      const rXY = Math.sqrt(Math.max(0, 1 - zUnit * zUnit));
      const theta = goldenAngle * i;
      const r = radiusFt * Math.cbrt(t); // cube-root spacing -> uniform volume density
      points.push({
        x: cx + r * rXY * Math.cos(theta),
        y: cy + r * rXY * Math.sin(theta),
        z: cz + r * zUnit
      });
    }
    return points;
  }

  // ---- Spatially-averaged frequency response (moving-mic-method-style) ----
  // Approximates REW's "moving microphone method": rather than a single exact
  // point -- which can look artificially nulled or peaked, since a fraction-
  // of-an-inch shift right at a true null swings dB by tens of decibels even
  // though a real listener's ears/head occupy a small volume, not a
  // mathematical point -- this averages POWER across many points swept
  // through a small sphere, then converts the averaged power back to dB.
  // Power (not dB, and not raw linear pressure) is the physically appropriate
  // domain to average in: it mirrors what a physically moving mic captures
  // (energy over the swept volume) rather than a coherent sum across
  // positions, which could itself introduce cancellation artifacts.
  // sources/ctx: same shape precomputeModalField/enumerateModes expect.
  // Returns [{freq, db}, ...], one entry per input frequency, in order.
  // Enumerates modes ONCE for the whole sweep (they don't depend on freq),
  // reused across every frequency below.
  function spatiallyAveragedResponse(cx, cy, cz, freqs, sources, ctx, opts){
    const radiusFt = opts?.radiusFt ?? 2;
    const numPoints = opts?.numPoints ?? 20;
    const samplePoints = sphereSamplePoints(cx, cy, cz, radiusFt, numPoints);
    const modes = enumerateModes(ctx);
    return freqs.map(freq => {
      const precomputed = precomputeModalField(sources, freq, ctx, modes);
      let sumPower = 0;
      for(const p of samplePoints){
        const { re, im } = computeFieldAtPoint(p.x, p.y, p.z, precomputed);
        sumPower += re*re + im*im;
      }
      const avgPower = sumPower / samplePoints.length;
      const db = 10 * Math.log10(Math.max(avgPower, 1e-12));
      return { freq, db };
    });
  }

  // ---- Time alignment: delay each source so all arrive at a point together ----
  // Real speaker/sub distances from the listener differ, so their direct
  // sound arrives at different times -- AVR "speaker distance" settings (or
  // any DSP-based delay line) exist specifically to compensate for this.
  // Delay can only push a signal later, never earlier, so every source is
  // delayed relative to whichever one is FARTHEST away (that one gets 0 --
  // it's already the latest natural arrival, nothing to align it to).
  // sources: array of {id, x, y, z}. listener: {x, y, z}. Returns
  // [{id, delayMs}, ...], one entry per input source, in order.
  function timeAlignDelays(sources, listener){
    const distM = sources.map(s => {
      const dx = (s.x - listener.x) * FT_TO_M;
      const dy = (s.y - listener.y) * FT_TO_M;
      const dz = ((s.z ?? 0) - listener.z) * FT_TO_M;
      return Math.sqrt(dx*dx + dy*dy + dz*dz);
    });
    const maxDist = distM.length ? Math.max(...distM) : 0;
    return sources.map((s, i) => ({ id: s.id, delayMs: (maxDist - distM[i]) / C * 1000 }));
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
  function fieldDbAtEars(listener, facingDegrees, sources, freq, ctx, refAmp){
    const ears = earPositions(listener, facingDegrees);
    const leftDb = fieldDbAtPoint(ears.left.x, ears.left.y, ears.left.z, sources, freq, ctx, refAmp);
    const rightDb = fieldDbAtPoint(ears.right.x, ears.right.y, ears.right.z, sources, freq, ctx, refAmp);
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

  // ---- Reverberation time (T60) estimate, via Sabine's formula ----
  // T60 = 0.161 * V / A (metric: V in m^3, A in metric sabins/m^2), where A is
  // the room's total absorption: area x absorption-coefficient, summed over
  // all 6 surfaces. Each surface's absorption coefficient is 1 - R^2, where R
  // is the amplitude/pressure reflection coefficient this module already uses
  // everywhere else (enumerateModes' damping calc etc.) -- squaring it converts
  // to power/energy absorption, which is what Sabine's formula is defined in
  // terms of. Frequency-dependent, since wall/ceiling materials are (see
  // wallMaterialReflectAtFreq) -- callers pick whichever frequency matters to
  // them (e.g. the frequency currently on screen).
  // This is the whole-room diffuse-field average (Sabine assumes evenly-
  // distributed absorption); enumerateModes' per-mode damping is a different,
  // more detailed quantity that should track it in the uniform-absorption
  // case -- see the cross-check test tying the two together.
  // ctx: { wallReflect, floorReflect, wallMaterials, ceilingMaterial } -- a
  // subset of enumerateModes' ctx shape is fine; only these fields are read.
  function estimatedT60(room, freqForAbsorption, ctx){
    const { wallReflect, wallMaterials, ceilingMaterial } = ctx;
    const floorReflect = ctx.floorReflect ?? wallReflect;
    const ceilingFromMaterial = ceilingMaterial ? wallMaterialReflectAtFreq(ceilingMaterial, freqForAbsorption) : null;
    const ceilingReflect = ceilingFromMaterial ?? wallReflect;
    function wallReflectFor(wallName){
      const material = wallMaterials && wallMaterials[wallName];
      const fromMaterial = material ? wallMaterialReflectAtFreq(material, freqForAbsorption) : null;
      return fromMaterial ?? wallReflect;
    }
    const w = room.w, d = room.d, h = room.h;
    const surfaces = [
      { area: d*h, reflect: wallReflectFor('left') },
      { area: d*h, reflect: wallReflectFor('right') },
      { area: w*h, reflect: wallReflectFor('front') },
      { area: w*h, reflect: wallReflectFor('back') },
      { area: w*d, reflect: floorReflect },
      { area: w*d, reflect: ceilingReflect }
    ];
    let totalAbsorptionFt2 = 0;
    for(const s of surfaces){
      const alpha = 1 - s.reflect * s.reflect;
      totalAbsorptionFt2 += s.area * alpha;
    }
    const totalAbsorptionM2 = totalAbsorptionFt2 * (FT_TO_M ** 2);
    const volumeM3 = (w * d * h) * (FT_TO_M ** 3);
    if(totalAbsorptionM2 <= 0 || volumeM3 <= 0) return 0;
    return 0.161 * volumeM3 / totalAbsorptionM2;
  }

  // ---- Schroeder frequency ----
  // The crossover between "discrete, individually-identifiable room modes"
  // (below f_s) and "statistically dense/diffuse reverberant field" (above f_s),
  // per Schroeder's classic formula: f_s = 2000 * sqrt(T60 / V), with T60 in
  // seconds and V in cubic meters. Above this frequency, modes overlap so much
  // that a single-frequency room-mode visualization stops being a meaningful
  // diagnostic — the response is no longer dominated by a few distinct peaks/
  // nulls, so there's little point extending a room-mode tool's range past it.
  // T60 (reverberation time) isn't measured by this tool -- pass one in (e.g.
  // from estimatedT60 above) when you have real wall/ceiling/floor data to
  // work with; a typical untreated-to-lightly-treated small/medium room value
  // is assumed by default when the caller doesn't have one.
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

  // Soft repulsion penalty (dB) used only by 'nullAvoidance' mode, to counteract
  // its lack of any inherent spread-out incentive (see scoreSubPosition below).
  // 0 once a candidate is at least SPREAD_TARGET_FT from every already-placed
  // point; ramps up linearly to REDUNDANCY_PENALTY_DB right at/inside that
  // radius. This doesn't forbid close placement outright (isCandidateValid's
  // minSeparationFt already does that) -- it just makes the optimizer actually
  // prefer a meaningfully different spot unless the close one is genuinely a
  // much better null-avoider, rather than defaulting to "closest legal spot."
  function nullAvoidanceSpreadPenalty(candidatePos, alreadyPlaced, room){
    if(!alreadyPlaced || alreadyPlaced.length === 0) return 0;
    const SPREAD_TARGET_FT = Math.max(8, Math.min(room.w, room.d) * 0.5);
    const REDUNDANCY_PENALTY_DB = 12;
    const nearestDist = Math.min(...alreadyPlaced.map(p =>
      Math.sqrt((candidatePos.x - p.x) ** 2 + (candidatePos.y - p.y) ** 2)
    ));
    if(nearestDist >= SPREAD_TARGET_FT) return 0;
    const closeness = 1 - nearestDist / SPREAD_TARGET_FT; // 0..1, 1 = right at/inside the min separation floor
    return closeness * REDUNDANCY_PENALTY_DB;
  }

  // ---- Sub placement scoring ----
  // Scores one candidate sub position (combined with any other already-placed
  // sources — mains, other subs) by evaluating the field at multiple frequencies
  // across a target band, at one or more listening positions.
  //
  // mode: 'balanced' (default) combines three things a good sub position
  // should deliver:
  //   1. Reasonably high average level (not stuck in a general low zone)
  //   2. Low variance across frequency AT EACH listener (flat response — avoids
  //      being loud at some frequencies and nulled at others, the classic
  //      "one big room-mode hole" problem)
  //   3. Consistency ACROSS listeners (a position that's great at one seat but
  //      terrible at another is a worse practical choice than one that's decent
  //      everywhere, even if its single-seat peak score is lower)
  //
  // mode: 'nullAvoidance' is for someone with room correction/EQ available —
  // they can flatten peaks after the fact, but can't fill in a null (it's a
  // position-dependent cancellation, not a tonal dip a filter can undo), so
  // average level and peak-inclusive variance are irrelevant to them. This
  // mode scores purely by the worst (lowest) dB anywhere in the band, at the
  // worst listener position — a maximin objective that directly answers
  // "how deep is the deepest null this candidate produces," ignoring
  // everything else 'balanced' cares about.
  //
  // Unlike 'balanced' (which naturally spreads multi-sub placements out, since
  // averaging level/flatness across the room rewards covering different areas),
  // a pure maximin objective has NO inherent incentive to avoid clustering --
  // if the best null-avoiding spot for sub 2 happens to be right next to sub 1,
  // nothing here would prefer a more spread-out alternative. alreadyPlaced
  // (optional: array of {x,y}, e.g. subs placed in earlier rounds of a
  // multi-sub search) adds a soft repulsion penalty in 'nullAvoidance' mode
  // specifically to counteract that -- see nullAvoidanceSpreadPenalty below.
  //
  // Returns a single scalar score where HIGHER IS BETTER, plus the raw per-listener
  // per-frequency dB values for diagnostics/visualization.
  function scoreSubPosition(candidatePos, otherSources, room, freqList, listenerPositions, physicsCtx, mode, alreadyPlaced){
    const candidateSource = Object.assign(
      { name: 'candidate', levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000, enabled: true },
      candidatePos
    );
    const allSources = otherSources.concat([candidateSource]);
    const modes = enumerateModes(physicsCtx); // shared across every listener x frequency below -- doesn't depend on candidatePos

    const perListenerDb = []; // [listenerIdx][freqIdx] = dB
    for(const lp of listenerPositions){
      const dbRow = [];
      for(const f of freqList){
        const precomputed = precomputeModalField(allSources, f, physicsCtx, modes);
        const { re, im } = computeFieldAtPoint(lp.x, lp.y, lp.z, precomputed);
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
    // outcome than a slightly quieter but consistently flat one. In
    // 'nullAvoidance' mode, only the worst null anywhere matters (minus a soft
    // penalty for clustering near already-placed subs) -- see the function
    // comment above for why average level and peaks are excluded otherwise.
    //
    // The null penalty engages once the worst listener's minimum dips 20dB+
    // BELOW THE SCENE'S OWN AVERAGE LEVEL (avgMean), not below a hardcoded
    // absolute dB number -- absolute dB has no fixed "0dB is normal" reference
    // across room sizes/field methods (e.g. the modal method's overall
    // amplitude scale differs from a free-field convention), so anchoring the
    // penalty to the scene's own average keeps this scale-invariant.
    const score = mode === 'nullAvoidance'
      ? worstMinDb - nullAvoidanceSpreadPenalty(candidatePos, alreadyPlaced, room)
      : avgMean - (worstStdDev * 1.5) - Math.max(0, avgMean - worstMinDb - 20) * 0.5;

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
      room, otherSources, freqList, listenerPositions, physicsCtx,
      offLimitZones, preferredZones, gridStepFt, subHeightFt, excludePoints, minSeparationFt, mode
    } = options;
    const step = gridStepFt || 0.5;
    const z = subHeightFt ?? 1;

    const results = [];
    let best = null;

    for(let x = step/2; x < room.w; x += step){
      for(let y = step/2; y < room.d; y += step){
        if(!isCandidateValid(x, y, room, offLimitZones, preferredZones, excludePoints, minSeparationFt)) continue;
        const eval_ = scoreSubPosition({ x, y, z }, otherSources, room, freqList, listenerPositions, physicsCtx, mode, excludePoints);
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
      offLimitZones, preferredZones, gridStepFt, subHeightFt, minSeparationFt, mode
    } = options;
    // Default separation: a fraction of the room's smaller dimension, so it
    // scales sensibly across room sizes rather than being a fixed number that's
    // too strict in a small room or too loose in a large one. 25%/4ft (rather
    // than the previous 15%/1ft) so subs land meaningfully apart by default --
    // a couple feet of separation is essentially meaningless at sub
    // wavelengths (9-50+ ft across the usual 20-120Hz sub range).
    const separation = minSeparationFt ?? Math.max(4, Math.min(room.w, room.d) * 0.25);

    const placedSubs = [];
    const placedPositions = [];
    const roundResults = []; // one optimizeSubPlacement result per sub placed, for diagnostics/visualization
    let currentOtherSources = otherSources.slice();

    for(let i = 0; i < numSubs; i++){
      const roundResult = optimizeSubPlacement({
        room, otherSources: currentOtherSources, freqList, listenerPositions,
        physicsCtx, offLimitZones, preferredZones, gridStepFt, subHeightFt,
        excludePoints: placedPositions, minSeparationFt: separation, mode
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
    wallMaterialReflectAtFreq,
    WALL_MATERIALS,
    MODE_CUTOFF_HZ,
    enumerateModes,
    precomputeModalField,
    computeFieldAtPoint,
    fieldDbAtPoint,
    sphereSamplePoints,
    spatiallyAveragedResponse,
    axialModes,
    estimatedT60,
    schroederFrequency,
    timeAlignDelays,
    earPositions,
    fieldDbAtEars,
    isNearNull,
    nullAvoidanceSpreadPenalty,
    scoreSubPosition,
    isPointInRect,
    isCandidateValid,
    optimizeSubPlacement,
    optimizeMultipleSubs
  };
});
