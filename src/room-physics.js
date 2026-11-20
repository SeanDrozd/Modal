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

  // ---- Wall/ceiling material: frequency-dependent absorption for a BARE ----
  // surface. Two distinct real mechanisms, selected by material.shape:
  //
  // shape: 'resonant' (default when omitted) -- ordinary drywall-on-studs/
  // joists construction behaves as a mass-spring-mass "membrane absorber":
  // the surface + the air cavity behind it resonate at a frequency set mostly
  // by mass and cavity depth, and the surface absorbs MORE right around that
  // resonance than elsewhere. Rigid materials (masonry/concrete) have no such
  // mechanism (peakBoost: 0 collapses this to a flat baseAbsorption).
  //   { baseAbsorption, peakFreq, peakBoost, bandwidth }
  //   peakFreq/bandwidth: center and width (Hz) of the extra-absorptive bump.
  //   peakBoost: 0..1, absorption coefficient ADDED on top of baseAbsorption
  //   AT peakFreq (so absorption at peak = baseAbsorption + peakBoost).
  //
  // shape: 'porousRamp' -- broadband porous absorption (e.g. suspended
  // acoustic ceiling tile), as a SURFACE's own base behavior.
  // Absorption ramps UP with frequency (a logistic curve centered at midFreq)
  // -- the opposite trend from 'resonant'. Within this app's sub-300Hz range,
  // typical acoustic tile shows only modest absorption; it's much more
  // effective well above what a room-mode tool models -- itself a real,
  // worth-knowing fact (acoustic tile is not a bass fix).
  //   { shape:'porousRamp', baseAbsorption, midFreq, slope, maxAbsorbBoost }
  //
  // A null/undefined material means "no material assigned" -- callers should
  // fall back to a plain flat scalar (e.g. the legacy wallAbsorption slider).
  //
  // These are illustrative/typical values (see WALL_MATERIALS below), not
  // measured data -- real wall/ceiling behavior depends on construction
  // details no small preset set can capture exactly. A reasonable
  // approximation, not a substitute for measurement.
  function wallMaterialAbsorptionAtFreq(material, f){
    if(!material) return null;
    if(material.shape === 'porousRamp'){
      const x = (f - material.midFreq) * material.slope;
      const ramp = 1 / (1 + Math.exp(-x));
      return material.baseAbsorption + material.maxAbsorbBoost * ramp;
    }
    if(!(material.peakBoost > 0)) return material.baseAbsorption;
    const x = (f - material.peakFreq) / material.bandwidth;
    const boost = material.peakBoost * Math.exp(-(x * x));
    return material.baseAbsorption + boost;
  }

  // Named presets for the "Wall material" / "Ceiling material" UI pickers.
  // Roughly: insulation in the cavity damps the panel's resonant motion,
  // converting more of it to heat (deeper AND broader absorption) rather than
  // letting it ring/re-radiate (hollowCavity's narrower, shallower peak);
  // masonry has no membrane at all; suspendedTile is ceiling-only in the UI
  // (walls essentially never use it) and uses the porousRamp shape instead.
  //
  // baseAbsorption/peakBoost calibrated against published low-frequency
  // absorption-coefficient (alpha) tables:
  //   drywallHollow: 1/2" gypsum board nailed to 2x4 studs, 16" O.C. --
  //     alpha 0.29 @125Hz, 0.10 @250Hz, ~0.05-0.09 @500Hz-4kHz (flat baseline).
  //     drywallInsulated has no matching published curve; its deeper/wider
  //     peak is a physically-motivated scale-up of the hollow curve (damped
  //     cavity fill -> more energy converted to heat at resonance) rather
  //     than a directly sourced number.
  //   masonry: painted/bare concrete block or poured foundation --
  //     alpha ~0.01 (smooth painted concrete) to ~0.05 (porous block) @125Hz;
  //     0.03 taken as a representative mid-range value.
  // Previous defaults (alpha 0.06 baseline / 0.30-0.40 at peak, expressed
  // then as reflect 0.75-0.90) were roughly 2-4x too absorptive at bass
  // frequencies for a BARE surface -- real hard/rigid low-frequency
  // boundaries are close to rigid away from their resonance, which these
  // values reflect.
  //
  // bandwidth was also too wide: published membrane/panel-absorber curves
  // fall off substantially within about an octave of the resonance peak
  // (the peak is a fairly narrow feature, not a broad plateau), but the
  // previous 115-150Hz Gaussian widths left absorption nearly full-strength
  // even an octave-plus below peakFreq -- e.g. drywallInsulated at 32Hz
  // (more than an octave below its 80Hz peak) showed alpha~0.37, barely
  // under its actual 80Hz-peak alpha~0.40. Narrowed so absorption decays
  // faster away from resonance, consistent with how panel absorbers
  // actually behave; insulated stays wider than hollow (more cavity
  // damping broadens the resonance as well as deepening it).
  const WALL_MATERIALS = {
    drywallInsulated: { baseAbsorption: 0.06, peakFreq: 80, peakBoost: 0.34, bandwidth: 55 },
    drywallHollow:    { baseAbsorption: 0.06, peakFreq: 90, peakBoost: 0.25, bandwidth: 40 },
    masonry:          { baseAbsorption: 0.03, peakFreq: 0,  peakBoost: 0,    bandwidth: 1 },
    // suspendedTile: porous absorbers are inherently weak at bass (their
    // absorption mechanism needs airflow/particle velocity through the
    // material, which is minimal at long wavelengths near a rigid backing),
    // so baseAbsorption -- the floor this ramps up FROM, well below midFreq
    // -- should be modest like the other materials' baselines (~0.05-0.10,
    // in the ballpark of published ~125Hz mineral-fiber tile data), not the
    // ~0.44 this held before this fix (inherited unchanged from the old
    // reflect-space baseReflect:0.75 through the reflectivity->absorption
    // rewrite -- unlike the resonant wall materials, it was never actually
    // checked against low-frequency data). The high-frequency asymptote
    // (baseAbsorption+maxAbsorbBoost, reached well beyond this app's 300Hz
    // range) is kept at roughly its previous ~0.91, since real acoustic
    // tile genuinely does become highly absorptive at higher frequencies --
    // only the LOW end was wrong.
    suspendedTile:    { shape: 'porousRamp', baseAbsorption: 0.08, midFreq: 280, slope: 0.03, maxAbsorbBoost: 0.83 }
  };

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

  // Same fallback-to-flat-scalar convention as estimatedT60's wallAbsorptionFor:
  // a per-wall/ceiling material (frequency-dependent) if assigned, otherwise
  // the flat wallAbsorption/floorAbsorption scalar. Floor has no material
  // concept in this codebase (see estimatedT60), only a flat absorption value.
  function surfaceAbsorptionAtFreq(surfaceName, freqForAbsorption, ctx){
    if(surfaceName === 'floor') return ctx.floorAbsorption ?? ctx.wallAbsorption;
    if(surfaceName === 'ceil'){
      const fromMaterial = ctx.ceilingMaterial ? wallMaterialAbsorptionAtFreq(ctx.ceilingMaterial, freqForAbsorption) : null;
      return fromMaterial ?? ctx.wallAbsorption;
    }
    const material = ctx.wallMaterials && ctx.wallMaterials[surfaceName];
    const fromMaterial = material ? wallMaterialAbsorptionAtFreq(material, freqForAbsorption) : null;
    return fromMaterial ?? ctx.wallAbsorption;
  }

  // ---- Enumerates every room mode with resonance frequency <= cutoffFreq ----
  // ctx: { room, wallAbsorption, floorAbsorption, ceilingMaterial, wallMaterials }.
  // Depends only on room geometry + wall materials, not on source/listener
  // position or the frequency being evaluated -- callers doing a frequency
  // sweep (spatiallyAveragedResponse) or many candidate evaluations
  // (scoreSubPosition) should compute this ONCE and reuse it, rather than
  // re-enumerating per frequency/candidate.
  //
  // Each mode's own damping (delta_n) is derived via the standard perturbative
  // (Kuttruff) coupled-mode result for lightly-damped walls -- valid here
  // since WALL_MATERIALS' baseAbsorption values are all <=0.06 (light damping
  // is exactly the regime this approximation assumes): a surface-area-weighted,
  // mode-shape-weighted average of each of the 6 surfaces' absorption
  // coefficient (alpha, evaluated at that mode's OWN resonance frequency
  // f_n -- the same alpha convention estimatedT60 already uses):
  //
  //   delta_n = (c / 8) * sum_surfaces  alpha_s(f_n) * (integral of psi_n^2 over surface s) / (integral of psi_n^2 over the room)
  //
  // Because psi_n factors into cos(nx..)*cos(ny..)*cos(nz..), each surface's
  // integral collapses to a simple product of per-axis L/eps(n) terms -- e.g.
  // the left/right walls (area Ly*Lz) only depend on ny,nz (cos^2 of the
  // WALL-NORMAL index is always 1 exactly AT the wall, regardless of that
  // index -- only the two axes running ALONG the wall matter):
  //   S_x = (Ly/eps(ny)) * (Lz/eps(nz))   -- shared by left+right
  //   S_y = (Lx/eps(nx)) * (Lz/eps(nz))   -- shared by front+back
  //   S_z = (Lx/eps(nx)) * (Ly/eps(ny))   -- shared by floor+ceiling
  // and the volume integral is V / (eps(nx)*eps(ny)*eps(nz)). Dividing by
  // the volume integral, not by V alone, is what gives each mode family its
  // own decay rate: with uniform absorption an oblique mode decays at exactly
  // the Sabine rate alpha*S_total/(4V) (the diffuse-field limit, which is
  // where the alpha = 8 * wall admittance relation behind the 1/8 comes
  // from), a tangential mode somewhat slower and an axial mode slowest, the
  // classic result for a rectangular room (Morse; Kuttruff). Per pair of
  // walls this is alpha * eps(n along that axis) / (4 * L of that axis).
  //
  // Units: this formula is naturally a TEMPORAL damping rate (1/s, Kuttruff's
  // own convention). The complex denominator in precomputeModalField is
  // written in wavenumber space (k_n^2 - k^2 - j*k*delta_n), which needs
  // delta_n in units of 1/m (spatial) instead -- i.e. this temporal rate
  // divided by c. The code below folds that division in directly (the c's
  // cancel) rather than computing a temporal rate and converting it
  // separately.
  //
  // The (0,0,0) mode is included: it is the uniform pressurization of a
  // closed room ("room gain"), which is most of the response below the first
  // room mode. Its k_n is 0 and its mode shape is 1 everywhere, so it adds
  // the same pressure at every point and is damped like any other mode.
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
          const kn = Math.PI * Math.sqrt((nx/Lx)**2 + (ny/Ly)**2 + (nz/Lz)**2);
          const fn = C * kn / (2 * Math.PI);
          if(fn > cutoffFreq) continue;

          const epsX = epsFactor(nx), epsY = epsFactor(ny), epsZ = epsFactor(nz);
          const An = C * C * epsX * epsY * epsZ / V;

          const Sx = (Ly / epsY) * (Lz / epsZ);
          const Sy = (Lx / epsX) * (Lz / epsZ);
          const Sz = (Lx / epsX) * (Ly / epsY);
          const absorptionOf = (surfaceName) => surfaceAbsorptionAtFreq(surfaceName, fn, ctx);
          // Spatial (1/m) form of the damping rate above: the surface integrals
          // over the mode's own volume integral V/(epsX*epsY*epsZ), times 1/8.
          const deltaN = (epsX * epsY * epsZ / (8 * V)) * (
            absorptionOf('left') * Sx + absorptionOf('right') * Sx +
            absorptionOf('front') * Sy + absorptionOf('back') * Sy +
            absorptionOf('floor') * Sz + absorptionOf('ceil') * Sz
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

  // Batched twin of spatiallyAveragedResponse: computes the same spatially-
  // averaged response at MULTIPLE center points at once, sharing the
  // per-frequency precomputeModalField call across every center instead of
  // redoing it once per center (the dominant cost -- see scoreSubPosition's
  // identical frequency-outer/listener-inner pattern for the same reason).
  // For a single center, produces numerically identical results to
  // spatiallyAveragedResponse(centers[0].x, ...).
  // centers: [{x,y,z}, ...]
  // Returns { freqs, perCenterDb }, where perCenterDb[i][j] is the dB at
  // centers[i] for freqs[j] (same order as the input freqs array).
  function spatiallyAveragedResponseMulti(centers, freqs, sources, ctx, opts){
    const radiusFt = opts?.radiusFt ?? 2;
    const numPoints = opts?.numPoints ?? 20;
    const modes = enumerateModes(ctx);
    const centerSamples = centers.map(c => sphereSamplePoints(c.x, c.y, c.z, radiusFt, numPoints));
    const perCenterDb = centers.map(() => []);
    for(const freq of freqs){
      const precomputed = precomputeModalField(sources, freq, ctx, modes);
      centerSamples.forEach((samplePoints, i) => {
        let sumPower = 0;
        for(const p of samplePoints){
          const { re, im } = computeFieldAtPoint(p.x, p.y, p.z, precomputed);
          sumPower += re*re + im*im;
        }
        const avgPower = sumPower / samplePoints.length;
        perCenterDb[i].push(10 * Math.log10(Math.max(avgPower, 1e-12)));
      });
    }
    return { freqs, perCenterDb };
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

  // ---- Multi-seat listening rows (e.g. a couch, a row of recliners) ----
  // Generalizes earPositions' perpendicular-offset geometry from a fixed
  // 2-ear pair to N seats at configurable spacing, using the exact same
  // facing convention (0deg = -y, rightward perpendicular = (cos,sin)).
  // row: { x, y, z, facing, seats, spacingFt }. Seats are generated
  // symmetrically around the row's own (x,y) center point -- a 1-seat row
  // collapses to exactly that center point (offsetIndex 0), matching the
  // pre-multi-row single-listener case exactly.
  function rowSeatPositions(row){
    const n = Math.max(1, row.seats | 0);
    const rad = (row.facing ?? 0) * Math.PI / 180;
    const dx = Math.cos(rad), dy = Math.sin(rad);
    const positions = [];
    for(let i = 0; i < n; i++){
      const offsetIndex = i - (n - 1) / 2; // 0 = center (or the two middle seats, for even n)
      const dist = offsetIndex * row.spacingFt;
      positions.push({ x: row.x + dx*dist, y: row.y + dy*dist, z: row.z, offsetIndex });
    }
    return positions;
  }

  // The floor a row's couch or chairs take up, as an axis-aligned rectangle
  // { x, y, width, height } for marking it as an obstacle: one seat spacing
  // of width per seat along the row and `depthFt` (default 3) front to
  // back, centered on the row and clipped to the room. A row facing at an
  // angle gets the bounding box of its rotated footprint. Same facing
  // convention as rowSeatPositions (the row runs along (cos, sin)).
  function rowFootprintRect(row, room, depthFt = 3){
    const rad = (row.facing ?? 0) * Math.PI / 180;
    const halfLen = Math.max(1, row.seats | 0) * row.spacingFt / 2, halfDepth = depthFt / 2;
    const hx = Math.abs(Math.cos(rad)) * halfLen + Math.abs(Math.sin(rad)) * halfDepth;
    const hy = Math.abs(Math.sin(rad)) * halfLen + Math.abs(Math.cos(rad)) * halfDepth;
    const x0 = Math.max(0, row.x - hx), y0 = Math.max(0, row.y - hy);
    const x1 = Math.min(room.w, row.x + hx), y1 = Math.min(room.d, row.y + hy);
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  // ---- Listening-row/seat importance weighting ----
  // rank: 0-based index into an ordered list of rows (0 = rank 1, most
  // important) -- geometric falloff, so each successively lower-ranked row
  // still counts, just half as much as the one before it.
  function rowRankWeight(rank){
    return Math.pow(0.5, rank);
  }
  // offsetIndex/seats: as returned by rowSeatPositions -- the center seat(s)
  // get full weight, tapering linearly to half weight at the row's own edges.
  // A 1-seat row (maxOffset 0) always gets full weight.
  function seatCenterWeight(offsetIndex, seats){
    const maxOffset = (seats - 1) / 2;
    if(!(maxOffset > 0)) return 1;
    return 1 - 0.5 * (Math.abs(offsetIndex) / maxOffset);
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

  // ---- Reverberation time (T60) estimate, via Eyring's formula ----
  // T60 = 0.161 * V / (-S * ln(1 - avgAlpha)) (metric: V in m^3, S in m^2,
  // avgAlpha = A/S the area-weighted average absorption coefficient across
  // all 6 surfaces). Frequency-dependent, since wall/ceiling materials are
  // (see wallMaterialAbsorptionAtFreq) -- callers pick whichever frequency
  // matters to them (e.g. the frequency currently on screen).
  //
  // Eyring, not Sabine: Sabine's classic T60 = 0.161*V/A has a known flaw --
  // as avgAlpha -> 1 (a fully absorptive/anechoic room), A -> S but T60
  // asymptotes to a nonzero floor (0.161*V/S) instead of correctly going to
  // 0. Eyring's -ln(1-avgAlpha) denominator DOES go to 0 correctly as
  // avgAlpha -> 1. The two formulas nearly agree when avgAlpha is small
  // (since -ln(1-a) ~= a for small a, matching typical lightly-treated rooms
  // this app targets), but this app's own material presets can reach fairly
  // high average absorption without much effort, where Sabine's breakdown
  // would actually show up -- Eyring stays correct there at no real cost to
  // the common case.
  //
  // This is the whole-room diffuse-field average (both Sabine and Eyring
  // assume evenly-distributed absorption); enumerateModes' per-mode damping
  // is a different, more detailed quantity that should track it in the
  // uniform-absorption case -- see the cross-check test tying the two together.
  // ctx: { wallAbsorption, floorAbsorption, wallMaterials, ceilingMaterial }
  // -- a subset of enumerateModes' ctx shape is fine; only these fields are read.
  function estimatedT60(room, freqForAbsorption, ctx){
    const { wallAbsorption, wallMaterials, ceilingMaterial } = ctx;
    const floorAbsorption = ctx.floorAbsorption ?? wallAbsorption;
    const ceilingFromMaterial = ceilingMaterial ? wallMaterialAbsorptionAtFreq(ceilingMaterial, freqForAbsorption) : null;
    const ceilingAbsorption = ceilingFromMaterial ?? wallAbsorption;
    function wallAbsorptionFor(wallName){
      const material = wallMaterials && wallMaterials[wallName];
      const fromMaterial = material ? wallMaterialAbsorptionAtFreq(material, freqForAbsorption) : null;
      return fromMaterial ?? wallAbsorption;
    }
    const w = room.w, d = room.d, h = room.h;
    const surfaces = [
      { area: d*h, absorption: wallAbsorptionFor('left') },
      { area: d*h, absorption: wallAbsorptionFor('right') },
      { area: w*h, absorption: wallAbsorptionFor('front') },
      { area: w*h, absorption: wallAbsorptionFor('back') },
      { area: w*d, absorption: floorAbsorption },
      { area: w*d, absorption: ceilingAbsorption }
    ];
    let totalAbsorptionFt2 = 0;
    let totalAreaFt2 = 0;
    for(const s of surfaces){
      totalAbsorptionFt2 += s.area * s.absorption;
      totalAreaFt2 += s.area;
    }
    const totalAreaM2 = totalAreaFt2 * (FT_TO_M ** 2);
    const totalAbsorptionM2 = totalAbsorptionFt2 * (FT_TO_M ** 2);
    const volumeM3 = (w * d * h) * (FT_TO_M ** 3);
    if(totalAreaM2 <= 0 || volumeM3 <= 0) return 0;
    const avgAlpha = totalAbsorptionM2 / totalAreaM2;
    const eyringDenominator = -totalAreaM2 * Math.log(1 - avgAlpha);
    if(!(eyringDenominator > 0)) return 0; // avgAlpha<=0 (no absorption at all) -- degenerate, same defensive convention as other 0-volume/0-absorption guards in this file
    return 0.161 * volumeM3 / eyringDenominator;
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
  //
  // Each entry in listenerPositions may carry an optional `weight` (0..1,
  // typically rowRankWeight(rank)*seatCenterWeight(...) for a multi-row
  // listening setup) expressing how much that listener matters relative to
  // the others -- e.g. a rank-2 row's edge seat vs. the rank-1 row's center
  // seat. Omitted weights default to 1, which makes every formula below
  // reduce EXACTLY to its pre-weighting form when no caller passes weights --
  // this is a hard backward-compatibility requirement, not just a default.
  //
  // precomputedModes (optional, last arg): enumerateModes(physicsCtx) only
  // depends on room geometry + wall materials, never on candidatePos -- a
  // grid-search optimizer calling this once per candidate (hundreds to
  // thousands of times per run) was redoing that same work every single
  // call. Callers doing a grid search should enumerate once and pass the
  // result in here; omitted, this falls back to computing it itself so every
  // existing call site (tests included) keeps working unchanged.
  const RELIEF_DB = 15; // nullAvoidance: how much a fully-unimportant (weight 0) listener's null is forgiven
  // 'balanced' mode: how many dB of score a full point of worstStdDev (flatness
  // unevenness) costs, relative to avgMean's 1:1 weight. Lower values let raw
  // output matter more relative to flatness. For example, wall/corner placements
  // couple into every room mode more strongly than open-floor placements
  // (a real, physically modeled effect: every mode's shape function peaks at
  // the room's boundaries), genuinely raising avgMean there, but also tend to
  // produce a somewhat less even response at a fixed listening point, raising
  // worstStdDev too. At the previous 1.5, that flatness cost could outweigh a
  // real boundary-reinforcement gain by a hair in close cases; 1.0 keeps
  // flatness meaningfully penalized while letting a genuine level advantage
  // win more decisively.
  const BALANCED_FLATNESS_WEIGHT = 1.0;
  function scoreSubPosition(candidatePos, otherSources, room, freqList, listenerPositions, physicsCtx, mode, alreadyPlaced, precomputedModes){
    const candidateSource = Object.assign(
      { name: 'candidate', levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000, enabled: true },
      candidatePos
    );
    const allSources = otherSources.concat([candidateSource]);
    const modes = precomputedModes || enumerateModes(physicsCtx); // shared across every listener x frequency below -- doesn't depend on candidatePos

    // Looped frequency-outer, listener-inner (not the reverse) --
    // precomputeModalField's result depends only on the sources/frequency/
    // modes, never on the query point, so it's computed once per frequency
    // here and reused across every listener at that frequency, instead of
    // being redone once per (listener x frequency) pair. With a multi-row
    // listening setup easily putting 5-15+ weighted seats into
    // listenerPositions, that redundancy was the single biggest cost in the
    // whole optimizer grid search -- far more than enumerateModes itself.
    const perListenerDb = listenerPositions.map(() => []); // [listenerIdx][freqIdx] = dB
    for(const f of freqList){
      const precomputed = precomputeModalField(allSources, f, physicsCtx, modes);
      listenerPositions.forEach((lp, i) => {
        const { re, im } = computeFieldAtPoint(lp.x, lp.y, lp.z, precomputed);
        const mag = Math.sqrt(re*re + im*im);
        perListenerDb[i].push(20 * Math.log10(Math.max(mag, 1e-6)));
      });
    }

    const combined = scoreResponses(perListenerDb, listenerPositions.map(lp => lp.weight), mode);
    return {
      score: mode === 'nullAvoidance' ? combined.score - nullAvoidanceSpreadPenalty(candidatePos, alreadyPlaced, room) : combined.score,
      avgMean: combined.avgMean,
      worstStdDev: combined.worstStdDev,
      worstMinDb: combined.worstMinDb,
      perListenerDb,
      listenerStats: combined.listenerStats
    };
  }

  // Combines per-listener responses (perListenerDb[listener][freqIndex], in
  // dB) into the optimizer's score for `mode`, HIGHER IS BETTER, along with
  // the figures it is made of. weights[i] is listener i's importance (0..1,
  // 1 when omitted). This is the whole of scoreSubPosition's judgement apart
  // from its clustering penalty, split out so a placement can be judged by
  // the same formula from responses computed some other way (a denser
  // frequency list, spatial averaging). worstMinIndex is the frequency index
  // of worstMinDb.
  function scoreResponses(perListenerDb, weights, mode){
    // Per-listener stats: mean level and standard deviation (flatness) across
    // frequency, plus that listener's own importance weight (defaults to 1).
    const listenerStats = perListenerDb.map((dbRow, i) => {
      const mean = dbRow.reduce((a,b) => a+b, 0) / dbRow.length;
      const variance = dbRow.reduce((a,b) => a + (b-mean)*(b-mean), 0) / dbRow.length;
      const stdDev = Math.sqrt(variance);
      const minDb = Math.min(...dbRow);
      const minIndex = dbRow.indexOf(minDb);
      const weight = weights[i] ?? 1;
      return { mean, stdDev, minDb, minIndex, weight };
    });

    // Combine across listeners: WEIGHTED average mean level (a low-weight
    // listener's level counts for less), but still penalize by the true WORST
    // listener's flatness and true worst listener's minimum -- weighting never
    // hides a genuinely bad seat by averaging it away, it only scales how much
    // that seat's badness is allowed to drag the score down (see below).
    // No `|| 1` fallback on totalWeight, and no reduce-with-empty-array shortcut
    // below -- an empty listenerPositions (or an all-zero-weight scene) should
    // degrade to the same graceful NaN the rest of this function already
    // produces for degenerate input (see the empty-input test), not a
    // divide-by-a-fabricated-default or a crash on an undefined initial value.
    const totalWeight = listenerStats.reduce((a,s) => a+s.weight, 0);
    const avgMean = listenerStats.reduce((a,s) => a + s.mean*s.weight, 0) / totalWeight;
    // Found via a plain loop (not Math.max(...) + a strict-equality re-find) so
    // this stays correct when a stat is NaN (e.g. an empty freqList) -- NaN
    // comparisons are always false, which would make a find-by-equality miss
    // entirely; a `>`/`<` loop just harmlessly leaves the running entry as-is
    // in that case; an empty listenerPositions falls back to the same
    // -Infinity/+Infinity/weight-1 defaults Math.max/min(...[]) produced before.
    let worstStdDevEntry = listenerStats.length ? listenerStats[0] : { stdDev: -Infinity, weight: 1 };
    for(const s of listenerStats){ if(s.stdDev > worstStdDevEntry.stdDev) worstStdDevEntry = s; }
    let worstMinDbEntry = listenerStats.length ? listenerStats[0] : { minDb: Infinity, minIndex: -1, weight: 1 };
    for(const s of listenerStats){ if(s.minDb < worstMinDbEntry.minDb) worstMinDbEntry = s; }
    const worstStdDev = worstStdDevEntry.stdDev;
    const worstMinDb = worstMinDbEntry.minDb;

    // Score weights: level matters, but flatness (avoiding deep nulls) matters more —
    // a loud position with a severe null at one frequency is a worse real-world
    // outcome than a slightly quieter but consistently flat one. In
    // 'nullAvoidance' mode, only the worst null anywhere matters (minus a soft
    // penalty for clustering near already-placed subs, which scoreSubPosition
    // subtracts itself). See scoreSubPosition's comment for why average level
    // and peaks are excluded otherwise.
    //
    // The null penalty engages once the worst listener's minimum dips 20dB+
    // BELOW THE SCENE'S OWN AVERAGE LEVEL (avgMean), not below a hardcoded
    // absolute dB number -- absolute dB has no fixed "0dB is normal" reference
    // across room sizes/field methods (e.g. the modal method's overall
    // amplitude scale differs from a free-field convention), so anchoring the
    // penalty to the scene's own average keeps this scale-invariant.
    //
    // Both penalties are scaled by the OFFENDING listener's own weight -- a
    // bad null/rough response at a low-weight seat (e.g. a rank-3 row's edge
    // seat) barely dents the score; the identical problem at the rank-1 row's
    // center seat (weight 1) hits at full strength. 'nullAvoidance' mode has
    // no penalty term to scale (its score IS the raw worst dB value), so it's
    // given the analogous relief additively instead -- a low-weight listener's
    // null is partially forgiven (up to RELIEF_DB) rather than discounted.
    const score = mode === 'nullAvoidance'
      ? worstMinDb + (1 - worstMinDbEntry.weight) * RELIEF_DB
      : avgMean - (worstStdDev * BALANCED_FLATNESS_WEIGHT * worstStdDevEntry.weight) - Math.max(0, avgMean - worstMinDb - 20) * 0.5 * worstMinDbEntry.weight;

    return {
      score,
      avgMean,
      worstStdDev,
      worstMinDb,
      worstMinIndex: worstMinDbEntry.minIndex,
      listenerStats
    };
  }

  // ---- Plain-language results ----
  // How much the level differs from seat to seat, as a plus-or-minus figure:
  // half the gap between the loudest and quietest seat at each frequency,
  // averaged over the frequencies. perSeatDb[seat][freqIndex]. Zero for a
  // single seat.
  function seatToSeatVariationDb(perSeatDb){
    if(perSeatDb.length < 2) return 0;
    const numFreqs = perSeatDb[0].length;
    let sum = 0;
    for(let j = 0; j < numFreqs; j++){
      let min = Infinity, max = -Infinity;
      for(const seat of perSeatDb){ if(seat[j] < min) min = seat[j]; if(seat[j] > max) max = seat[j]; }
      sum += (max - min) / 2;
    }
    return sum / numFreqs;
  }
  // What moving from one placement to another amounts to, from the two
  // placements' scoreResponses results (same listeners, frequencies and
  // mode). gainDb is the change in score, so it is positive when `after` is
  // the better placement by the optimizer's own measure. verdict: 'major' at
  // PLACEMENT_GAIN_DB.major or more, 'modest' at .modest or more, 'worse'
  // when `after` scores lower by .modest or more, otherwise 'similar'.
  const PLACEMENT_GAIN_DB = { major: 6, modest: 2 };
  function comparePlacements(before, after){
    const gainDb = after.score - before.score;
    return {
      gainDb,
      levelGainDb: after.avgMean - before.avgMean,
      verdict: gainDb >= PLACEMENT_GAIN_DB.major ? 'major'
        : gainDb >= PLACEMENT_GAIN_DB.modest ? 'modest'
        : gainDb <= -PLACEMENT_GAIN_DB.modest ? 'worse' : 'similar'
    };
  }
  // The nearer side wall and the nearer end wall to a point, with the
  // distance to each: { side: { wall: 'left' | 'right', distFt }, end:
  // { wall: 'front' | 'back', distFt } }. The front wall is y = 0 and the
  // left wall x = 0; a point exactly midway reports left and front.
  function nearestWallDistances(pos, room){
    return {
      side: pos.x <= room.w - pos.x ? { wall: 'left', distFt: pos.x } : { wall: 'right', distFt: room.w - pos.x },
      end: pos.y <= room.d - pos.y ? { wall: 'front', distFt: pos.y } : { wall: 'back', distFt: room.d - pos.y }
    };
  }

  // ---- Default speaker placement ----
  // Azimuth of each standard channel as seen from the listener, in degrees:
  // 0 is straight ahead (toward the front wall, -y) and positive is to the
  // listener's right (+x). These follow Dolby's home-theater layout
  // guidance: fronts at 30, wides at 60, side surrounds at 100 (inside the
  // recommended 90 to 110) and surround backs at 150 (inside 135 to 150).
  const SPEAKER_AZIMUTH_DEG = { FL: -30, FR: 30, C: 0, SL: -100, SR: 100, SBL: -150, SBR: 150, FWL: -60, FWR: 60 };
  // Where each named channel would normally stand for a given seat: along
  // the line from the listener at the channel's azimuth, at the point where
  // that line reaches a rectangle `insetFt` (default 1.5) in from the walls.
  // A seat closer to a wall than the inset is treated as sitting on that
  // rectangle. Returns [{ name, x, y }] in the order given; names with no
  // entry in SPEAKER_AZIMUTH_DEG are skipped.
  function standardSpeakerPositions(room, listener, names, insetFt){
    const inset = insetFt ?? 1.5;
    const x0 = inset, x1 = room.w - inset, y0 = inset, y1 = room.d - inset;
    const lx = Math.min(x1, Math.max(x0, listener.x)), ly = Math.min(y1, Math.max(y0, listener.y));
    const positions = [];
    for(const name of names){
      if(!(name in SPEAKER_AZIMUTH_DEG)) continue;
      const az = SPEAKER_AZIMUTH_DEG[name] * Math.PI / 180;
      const dx = Math.sin(az), dy = -Math.cos(az);
      // distance along the ray to the first edge of the inset rectangle it meets
      const tx = dx > 0 ? (x1 - lx) / dx : dx < 0 ? (x0 - lx) / dx : Infinity;
      const ty = dy > 0 ? (y1 - ly) / dy : dy < 0 ? (y0 - ly) / dy : Infinity;
      const t = Math.min(tx, ty);
      positions.push({ name, x: lx + dx * t, y: ly + dy * t });
    }
    return positions;
  }

  // ---- Candidate position filtering ----
  // A candidate is valid if it's inside the room, outside every off-limits zone,
  // and (if any allowed zones are defined) inside at least one allowed zone.
  // ("Allowed zone" is a hard restriction: subs may ONLY be placed inside one, if
  // any exist. This is distinct from a "preferred zone", which is a soft scoring
  // bias applied later in scanGridCandidates -- see preferredZoneBonusDb -- and
  // never excludes a candidate outright.)
  // Zones are axis-aligned rectangles: { x, y, width, height } in feet.
  function isPointInRect(px, py, rect){
    return px >= rect.x && px <= rect.x + rect.width &&
           py >= rect.y && py <= rect.y + rect.height;
  }

  // Fraction (0..1) of the room's floor not covered by any of `zones`
  // ({ x, y, width, height } rects in feet, e.g. the off-limits zones).
  // Overlapping zones count once and anything outside the room is ignored:
  // the covered area is the union of the rects clipped to the room, summed
  // over the grid cells their edges cut the floor into (coordinate
  // compression), each cell being either wholly inside some rect or wholly
  // outside all of them.
  function freeFloorFraction(room, zones){
    const rects = [];
    for(const z of zones){
      const x0 = Math.max(0, z.x), x1 = Math.min(room.w, z.x + z.width);
      const y0 = Math.max(0, z.y), y1 = Math.min(room.d, z.y + z.height);
      if(x1 > x0 && y1 > y0) rects.push({ x0, x1, y0, y1 });
    }
    const xs = [...new Set(rects.flatMap(r => [r.x0, r.x1]))].sort((a, b) => a - b);
    const ys = [...new Set(rects.flatMap(r => [r.y0, r.y1]))].sort((a, b) => a - b);
    let covered = 0;
    for(let i = 0; i < xs.length - 1; i++){
      for(let j = 0; j < ys.length - 1; j++){
        const cx = (xs[i] + xs[i+1]) / 2, cy = (ys[j] + ys[j+1]) / 2;
        if(rects.some(r => cx > r.x0 && cx < r.x1 && cy > r.y0 && cy < r.y1)){
          covered += (xs[i+1] - xs[i]) * (ys[j+1] - ys[j]);
        }
      }
    }
    return 1 - covered / (room.w * room.d);
  }

  function isCandidateValid(px, py, room, offLimitZones, allowedZones, excludePoints, minSeparationFt){
    if(px < 0 || px > room.w || py < 0 || py > room.d) return false;
    for(const zone of (offLimitZones || [])){
      if(isPointInRect(px, py, zone)) return false;
    }
    if(allowedZones && allowedZones.length > 0){
      const inAnyAllowed = allowedZones.some(zone => isPointInRect(px, py, zone));
      if(!inAnyAllowed) return false;
    }
    // Enforce a minimum clearance from any already-placed point (e.g. other
    // subs placed in earlier greedy rounds). Without this, the greedy search
    // can legitimately re-pick the exact same spot for multiple subs, since
    // two co-located subs simply sum louder rather than being penalized for
    // redundancy: nothing in the scoring function itself discourages stacking.
    //
    // Checked as a SQUARE footprint (both the x and y offset must clear
    // minSeparationFt independently), not a circular radius. A circular
    // check under-excludes near the diagonals: a candidate offset by
    // (0.9*minSeparationFt, 0.9*minSeparationFt) is about 1.27*minSeparationFt
    // from the placed point in a straight line, so a circular radius check
    // would accept it even though it's well within minSeparationFt along
    // BOTH axes. Real subwoofer cabinets have a rectangular footprint, so a
    // square check is the physically appropriate one, and it strictly
    // subsumes the circular guarantee: any point this accepts is still at
    // least minSeparationFt away in straight-line distance too, since one of
    // the two axis offsets alone already reaches that value.
    if(excludePoints && excludePoints.length > 0 && minSeparationFt > 0){
      for(const p of excludePoints){
        if(Math.abs(px - p.x) < minSeparationFt && Math.abs(py - p.y) < minSeparationFt) return false;
      }
    }
    return true;
  }

  // A "preferred zone" is a soft bias, not a hard restriction: a candidate inside
  // one gets a flat score bonus, but candidates outside are still fully considered
  // (unlike an allowed zone, which excludes them via isCandidateValid above). This
  // lets a genuinely better spot elsewhere still win, while nudging the optimizer
  // toward the preferred area in close cases. Kept as a simple additive dB-scale
  // bonus rather than a multiplier, so it composes cleanly regardless of the
  // underlying score's sign or magnitude.
  const PREFERRED_ZONE_BONUS_DB = 3;
  function preferredZoneBonusDb(candidatePos, preferredZones){
    if(!preferredZones || preferredZones.length === 0) return 0;
    const inside = preferredZones.some(zone => isPointInRect(candidatePos.x, candidatePos.y, zone));
    return inside ? PREFERRED_ZONE_BONUS_DB : 0;
  }

  // ---- Shared grid-candidate scan ----
  // A generator, not a plain function, so the exact same "walk the grid,
  // validate a candidate, score it" logic can drive both a synchronous caller
  // (optimizeSubPlacement, below) and an async/chunked caller
  // (optimizeSubPlacementAsync) without duplicating the loop body between them.
  // Yields null for an invalid cell (rather than skipping it) so a caller that's
  // counting scanned cells for chunking purposes sees every grid cell, not just
  // the valid ones.
  function* scanGridCandidates(options){
    const {
      room, otherSources, freqList, listenerPositions, physicsCtx,
      offLimitZones, allowedZones, preferredZones, gridStepFt, subHeightFt, excludePoints, minSeparationFt, mode, precomputedModes
    } = options;
    const step = gridStepFt || 0.5;
    const z = subHeightFt ?? 1;
    // Enumerated once for the whole grid, not once per candidate -- modes only
    // depend on room geometry + wall materials (physicsCtx), never on the
    // candidate position, so re-deriving them per grid cell (hundreds to
    // thousands of times per search) was pure repeated work. See
    // scoreSubPosition's precomputedModes comment. A caller placing multiple
    // subs across several grid scans can pass precomputedModes to avoid
    // re-enumerating them once per sub too.
    const modes = precomputedModes || enumerateModes(physicsCtx);

    for(let x = step/2; x < room.w; x += step){
      for(let y = step/2; y < room.d; y += step){
        if(!isCandidateValid(x, y, room, offLimitZones, allowedZones, excludePoints, minSeparationFt)){
          yield null;
          continue;
        }
        const eval_ = scoreSubPosition({ x, y, z }, otherSources, room, freqList, listenerPositions, physicsCtx, mode, excludePoints, modes);
        // A preferred zone is a SOFT bias, unlike an allowed zone: it never
        // excludes a candidate (isCandidateValid above knows nothing about
        // it), it just adds a flat bonus to the score of any candidate that
        // falls inside one, so a genuinely better spot outside the zone can
        // still win. Applied here rather than inside scoreSubPosition to
        // keep that function's existing, already-tested balanced/
        // nullAvoidance formulas untouched.
        const bonus = preferredZoneBonusDb({ x, y }, preferredZones);
        yield { x, y, z, score: eval_.score + bonus, avgMean: eval_.avgMean, worstStdDev: eval_.worstStdDev, worstMinDb: eval_.worstMinDb };
      }
    }
  }

  // Total number of grid cells scanGridCandidates will walk for a given room and
  // step size, using the identical loop bounds -- kept in sync by construction so
  // it can never drift from the actual candidate count.
  function countGridCells(room, gridStepFt){
    const step = gridStepFt || 0.5;
    let n = 0;
    for(let x = step/2; x < room.w; x += step){
      for(let y = step/2; y < room.d; y += step) n++;
    }
    return n;
  }

  // ---- Single-sub grid search optimizer ----
  // Scans a grid of candidate positions (respecting off-limits/allowed zones, a
  // soft preferred-zone bonus, and, if provided, a minimum separation from
  // excludePoints), scores each with scoreSubPosition, and returns the best one
  // plus the full scored grid (useful for visualizing "how good is every
  // position", not just the winner).
  function optimizeSubPlacement(options){
    const results = [];
    let best = null;
    for(const entry of scanGridCandidates(options)){
      if(entry === null) continue;
      results.push(entry);
      if(best === null || entry.score > best.score) best = entry;
    }
    return { best, allCandidates: results };
  }

  // Async/chunked twin of optimizeSubPlacement, for callers (the UI) that need to
  // yield control back to the browser periodically during a long search instead
  // of freezing the tab for the whole synchronous scan. Behaviorally identical to
  // optimizeSubPlacement when onYield/onProgress are omitted -- both drive the
  // same scanGridCandidates generator, so there's only one copy of the actual
  // search logic to keep correct.
  //
  // options additionally accepts:
  //   onYield: () => Promise   -- awaited every yieldEvery scanned cells (default 150)
  //   onProgress: (fraction) => void -- called with 0 before scanning starts, then
  //                                      scanned/totalGridCells at each yield point
  //   yieldEvery: number -- chunk size, default 150
  async function optimizeSubPlacementAsync(options){
    const { onYield, onProgress, yieldEvery } = options;
    const chunkSize = yieldEvery || 150;
    const totalGridCells = countGridCells(options.room, options.gridStepFt);
    if(onProgress) onProgress(0);
    if(onYield) await onYield();

    const results = [];
    let best = null;
    let scanned = 0;
    for(const entry of scanGridCandidates(options)){
      scanned++;
      if(entry !== null){
        results.push(entry);
        if(best === null || entry.score > best.score) best = entry;
      }
      if(scanned % chunkSize === 0){
        if(onProgress) onProgress(scanned / totalGridCells);
        if(onYield) await onYield();
      }
    }

    return { best, allCandidates: results };
  }

  // Number of full coordinate-descent refinement passes run after the initial
  // greedy placement (see optimizeMultipleSubs below). Each pass re-optimizes
  // every already-placed sub in turn, holding the others fixed -- this can move
  // a sub that greedy locked in early to a better spot now that later subs'
  // positions are also known, which pure greedy sequential placement has no way
  // to do on its own. A pass exits early if nothing moved (the grid search is
  // deterministic, so "no sub's re-optimized position changed" means every
  // later pass would be identical too). Bounded rather than run-to-convergence
  // to keep total cost predictable: at most POLISH_PASSES x numSubs additional
  // full grid searches, the same order of magnitude as the initial greedy
  // placement itself, not exponential.
  const POLISH_PASSES = 2;

  // ---- Multi-sub greedy sequential optimizer ----
  // Places subs one at a time: find the best position for sub 1 (given only the
  // mains/other fixed sources), fix it in place, then find the best position for
  // sub 2 GIVEN sub 1 is already there, and so on. This is a well-established
  // approximation for multi-source placement — it doesn't guarantee the globally
  // optimal N-sub arrangement (that would require searching all N-tuples of
  // positions jointly), but it turns an exponential search (candidates^N) into a
  // linear one (candidates*N), which is the difference between "usable" and
  // "computationally impossible" once N is more than 2 or so. A bounded
  // coordinate-descent polish pass runs afterward to partially close that gap
  // -- see POLISH_PASSES above.
  //
  // Each already-placed sub is folded into `otherSources` for the next round, so
  // later subs are scored against the REAL combined field of everything placed
  // so far, not against the mains alone.
  function optimizeMultipleSubs(options){
    const {
      room, otherSources, numSubs, freqList, listenerPositions, physicsCtx,
      offLimitZones, allowedZones, preferredZones, gridStepFt, subHeightFt, minSeparationFt, mode
    } = options;
    // Default separation: a fraction of the room's smaller dimension, so it
    // scales sensibly across room sizes rather than being a fixed number
    // that's too strict in a small room or too loose in a large one. 25%/4ft
    // (rather than the previous 15%/1ft) so subs land meaningfully apart by
    // default, since a couple feet of separation is essentially meaningless
    // at sub wavelengths (9-50+ ft across the usual 20-120Hz sub range).
    // Math.max(3, ...) floors the EFFECTIVE separation at 3ft even if a
    // caller explicitly passes something smaller: with isCandidateValid's
    // square (not circular) exclusion check, that's a real 6x6ft clearance
    // around every already-placed sub, a reasonable minimum footprint for an
    // actual cabinet regardless of what a caller-supplied override asks for.
    const separation = Math.max(3, minSeparationFt ?? Math.max(4, Math.min(room.w, room.d) * 0.25));

    const placedSubs = [];
    // Seeded with every existing otherSources position (mains, and any subs
    // already placed before this call), not just subs placed during this
    // run. Without this, a newly-placed sub could land at or very near an
    // existing source's exact position, since isCandidateValid's
    // minSeparationFt check only ever excludes points already in this list.
    const placedPositions = otherSources.map(s => ({ x: s.x, y: s.y }));
    const roundResults = []; // one optimizeSubPlacement result per sub placed, for diagnostics/visualization
    let currentOtherSources = otherSources.slice();

    for(let i = 0; i < numSubs; i++){
      const roundResult = optimizeSubPlacement({
        room, otherSources: currentOtherSources, freqList, listenerPositions,
        physicsCtx, offLimitZones, allowedZones, preferredZones, gridStepFt, subHeightFt,
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

    // Coordinate-descent polish -- see polishSubPlacements for the full
    // explanation. roundResults (above) is left untouched; polish results go
    // in their own array so the "one roundResult per sub placed" invariant
    // callers/tests rely on keeps holding exactly as before. Every sub placed
    // above shares the same subHeightFt by construction (it came from this
    // same options.subHeightFt via scanGridCandidates), so passing that same
    // value through here reproduces the exact prior inlined behavior.
    const polish = polishSubPlacements({
      room, otherSources, subs: placedSubs, freqList, listenerPositions, physicsCtx,
      offLimitZones, allowedZones, preferredZones, gridStepFt, subHeightFt, minSeparationFt: separation, mode
    });

    return { placedSubs: polish.placedSubs, roundResults, polishResults: polish.polishResults };
  }

  // Coordinate-descent polish, as its own reusable entry point: given a set of
  // ALREADY-PLACED subs (however they got there -- a fresh greedy placement
  // above, or a caller's own real current sub positions), revisits each in
  // turn, holding every OTHER sub fixed, and re-runs the same single-sub grid
  // search for just that one -- see optimizeMultipleSubs' comment for why
  // greedy sequential placement alone can miss a better joint arrangement.
  // Works on COPIES (never mutates the caller's `subs` array/objects).
  //
  // Each sub's OWN `z` is used as its search height for that sub's round (an
  // optional `subHeightFt` override applies uniformly instead, when given) --
  // this matters for a caller re-optimizing real subs that may genuinely sit
  // at different heights, and is a strict generalization of the uniform-
  // height case (every sub optimizeMultipleSubs places already shares one
  // height by construction, so passing that value through as subHeightFt
  // reproduces identical behavior for that existing use case).
  //
  // Returns { placedSubs, polishResults, moved }, where moved[i] is true if
  // subs[i]'s position actually changed.
  function polishSubPlacements(options){
    const {
      room, otherSources, subs, freqList, listenerPositions, physicsCtx,
      offLimitZones, allowedZones, preferredZones, gridStepFt, subHeightFt, minSeparationFt, mode
    } = options;
    const separation = Math.max(3, minSeparationFt ?? Math.max(4, Math.min(room.w, room.d) * 0.25));
    const placedSubs = subs.map(s => Object.assign({}, s));
    const polishResults = [];
    const moved = placedSubs.map(() => false);
    if(placedSubs.length >= 2){
      for(let pass = 0; pass < POLISH_PASSES; pass++){
        let anyMoved = false;
        for(let k = 0; k < placedSubs.length; k++){
          // "Everyone else": mains/other fixed sources plus every OTHER
          // placed sub, excluding this one's own current position from both
          // the hard exclusion check and the nullAvoidance mode's spread
          // penalty -- both are driven from the same excludePoints list
          // passed into scanGridCandidates, so omitting this sub here is
          // what stops it from excluding/penalizing itself against its own
          // pre-polish position.
          const others = otherSources.concat(placedSubs.filter((_, idx) => idx !== k));
          const excludePoints = others.map(s => ({ x: s.x, y: s.y }));
          const roundResult = optimizeSubPlacement({
            room, otherSources: others, freqList, listenerPositions,
            physicsCtx, offLimitZones, allowedZones, preferredZones, gridStepFt,
            subHeightFt: subHeightFt ?? placedSubs[k].z,
            excludePoints, minSeparationFt: separation, mode
          });
          polishResults.push(roundResult);
          if(roundResult.best === null) continue; // no valid candidate; leave this sub where it is
          if(roundResult.best.x !== placedSubs[k].x || roundResult.best.y !== placedSubs[k].y){
            anyMoved = true;
            moved[k] = true;
          }
          placedSubs[k].x = roundResult.best.x;
          placedSubs[k].y = roundResult.best.y;
          placedSubs[k].z = roundResult.best.z;
        }
        if(!anyMoved) break; // converged; every later pass would be identical
      }
    }
    return { placedSubs, polishResults, moved };
  }

  // Async/chunked twin of polishSubPlacements, for the same reason
  // optimizeSubPlacementAsync exists. onProgress is called as
  // (fraction, k, 'polish') -- k is the index into `subs` currently being
  // re-optimized, matching the polish-phase signal optimizeMultipleSubsAsync
  // already uses internally.
  async function polishSubPlacementsAsync(options){
    const {
      room, otherSources, subs, freqList, listenerPositions, physicsCtx,
      offLimitZones, allowedZones, preferredZones, gridStepFt, subHeightFt, minSeparationFt, mode,
      onYield, onProgress, yieldEvery, precomputedModes
    } = options;
    const separation = Math.max(3, minSeparationFt ?? Math.max(4, Math.min(room.w, room.d) * 0.25));
    const modes = precomputedModes || enumerateModes(physicsCtx);
    const placedSubs = subs.map(s => Object.assign({}, s));
    const polishResults = [];
    const moved = placedSubs.map(() => false);
    if(placedSubs.length >= 2){
      for(let pass = 0; pass < POLISH_PASSES; pass++){
        let anyMoved = false;
        for(let k = 0; k < placedSubs.length; k++){
          const others = otherSources.concat(placedSubs.filter((_, idx) => idx !== k));
          const excludePoints = others.map(s => ({ x: s.x, y: s.y }));
          const roundResult = await optimizeSubPlacementAsync({
            room, otherSources: others, freqList, listenerPositions,
            physicsCtx, offLimitZones, allowedZones, preferredZones, gridStepFt,
            subHeightFt: subHeightFt ?? placedSubs[k].z,
            excludePoints, minSeparationFt: separation, mode,
            precomputedModes: modes, onYield, yieldEvery,
            onProgress: onProgress ? (fraction) => onProgress(fraction, k, 'polish') : undefined
          });
          polishResults.push(roundResult);
          if(roundResult.best === null) continue;
          if(roundResult.best.x !== placedSubs[k].x || roundResult.best.y !== placedSubs[k].y){
            anyMoved = true;
            moved[k] = true;
          }
          placedSubs[k].x = roundResult.best.x;
          placedSubs[k].y = roundResult.best.y;
          placedSubs[k].z = roundResult.best.z;
        }
        if(!anyMoved) break;
      }
    }
    return { placedSubs, polishResults, moved };
  }

  // Async/chunked twin of optimizeMultipleSubs, for the same reason
  // optimizeSubPlacementAsync exists: lets a UI caller run a multi-sub search
  // without freezing the tab. onProgress is called as (fraction, roundIndex) so
  // a caller can show e.g. "Optimizing sub 2 of 3... 40%" without tracking round
  // boundaries itself. Unlike optimizeMultipleSubs, enumerateModes is computed
  // once for the whole run (not once per round) and threaded through via
  // precomputedModes -- purely a perf win, produces numerically identical
  // placements, since physicsCtx never changes between rounds.
  async function optimizeMultipleSubsAsync(options){
    const {
      room, otherSources, numSubs, freqList, listenerPositions, physicsCtx,
      offLimitZones, allowedZones, preferredZones, gridStepFt, subHeightFt, minSeparationFt, mode,
      onYield, onProgress, yieldEvery
    } = options;
    const separation = Math.max(3, minSeparationFt ?? Math.max(4, Math.min(room.w, room.d) * 0.25));
    const modes = enumerateModes(physicsCtx);

    const placedSubs = [];
    const placedPositions = otherSources.map(s => ({ x: s.x, y: s.y }));
    const roundResults = [];
    let currentOtherSources = otherSources.slice();

    for(let i = 0; i < numSubs; i++){
      const roundResult = await optimizeSubPlacementAsync({
        room, otherSources: currentOtherSources, freqList, listenerPositions,
        physicsCtx, offLimitZones, allowedZones, preferredZones, gridStepFt, subHeightFt,
        excludePoints: placedPositions, minSeparationFt: separation, mode,
        precomputedModes: modes, onYield, yieldEvery,
        onProgress: onProgress ? (fraction) => onProgress(fraction, i) : undefined
      });
      roundResults.push(roundResult);
      if(roundResult.best === null) break;
      const placedSub = Object.assign(
        { name: `Sub ${i+1}`, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80, enabled: true },
        { x: roundResult.best.x, y: roundResult.best.y, z: roundResult.best.z }
      );
      placedSubs.push(placedSub);
      placedPositions.push({ x: placedSub.x, y: placedSub.y });
      currentOtherSources = currentOtherSources.concat([placedSub]);
    }

    // Coordinate-descent polish -- see polishSubPlacementsAsync for the full
    // explanation. onProgress gets a third argument, 'polish', only during
    // these rounds; the greedy rounds' calls above are unchanged (still just
    // (fraction, i)), so the existing onProgress contract for callers that
    // only look at the first two arguments keeps working as-is. `modes`
    // (already computed above) is passed through as precomputedModes to avoid
    // enumerating it a second time.
    const polish = await polishSubPlacementsAsync({
      room, otherSources, subs: placedSubs, freqList, listenerPositions, physicsCtx,
      offLimitZones, allowedZones, preferredZones, gridStepFt, subHeightFt, minSeparationFt: separation, mode,
      precomputedModes: modes, onYield, yieldEvery, onProgress
    });

    return { placedSubs: polish.placedSubs, roundResults, polishResults: polish.polishResults };
  }

  return {
    FT_TO_M, C,
    sourceGainAtFreq,
    wallMaterialAbsorptionAtFreq,
    WALL_MATERIALS,
    MODE_CUTOFF_HZ,
    enumerateModes,
    precomputeModalField,
    computeFieldAtPoint,
    fieldDbAtPoint,
    sphereSamplePoints,
    spatiallyAveragedResponse,
    spatiallyAveragedResponseMulti,
    axialModes,
    estimatedT60,
    schroederFrequency,
    timeAlignDelays,
    earPositions,
    fieldDbAtEars,
    rowSeatPositions,
    rowRankWeight,
    seatCenterWeight,
    isNearNull,
    nullAvoidanceSpreadPenalty,
    scoreSubPosition,
    BALANCED_FLATNESS_WEIGHT,
    PREFERRED_ZONE_BONUS_DB,
    preferredZoneBonusDb,
    SPEAKER_AZIMUTH_DEG,
    standardSpeakerPositions,
    scoreResponses,
    seatToSeatVariationDb,
    comparePlacements,
    nearestWallDistances,
    rowFootprintRect,
    isPointInRect,
    freeFloorFraction,
    isCandidateValid,
    scanGridCandidates,
    countGridCells,
    optimizeSubPlacement,
    optimizeSubPlacementAsync,
    optimizeMultipleSubs,
    optimizeMultipleSubsAsync,
    polishSubPlacements,
    polishSubPlacementsAsync
  };
});
