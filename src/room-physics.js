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
    // The page starts its floor-plan worker from this source text (see
    // createFloorPlanSolver), since a page opened from disk cannot start a
    // worker from a script file.
    mod.SOURCE = '(' + factory + ')';
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
    // suspendedTile: mineral-fiber lay-in tile in a grid with an air space above (the E-400 test mounting, a 400 mm plenum). The tile plus the air behind it absorbs much more bass than the tile alone: Armstrong's E-400 product-family data lists 0.28 to 0.33 at 125 Hz and 0.35 to 0.39 at 250 Hz for its common mineral-fiber tiles (Fine Fissured, Cirrus, Ultima; UL Classified Acoustical Performance Summary). The ramp below is fitted to those two bands (0.30 at 125 Hz, 0.39 at 250 Hz). No published data goes below 125 Hz, so the low end is an extrapolation that eases down to about 0.15 at 40 Hz instead of staying at the 125 Hz value. A shallower plenum than 400 mm absorbs less.
    suspendedTile:    { shape: 'porousRamp', baseAbsorption: 0.10, midFreq: 100, slope: 0.025, maxAbsorbBoost: 0.30 }
  };

  // ---- Bass traps: localized absorbers standing in a room corner ----
  // Each type is lab data for one 2 x 4 ft, 5.4 in deep panel, in sabins (ft^2) per unit by 1/3-octave band, measured by Riverbank Acoustical Laboratories under ASTM C423 / E795 mounting J: porous:   GIK Acoustics 244 Bass Trap, report A13-143 (2013) membrane: the same panel with its FRT range-limiter membrane, A13-179 The membrane type absorbs more below 100 Hz and less above 160 Hz. Reverberation-chamber data below 100 Hz is only approximate, since the chamber has few modes there.
  const BASS_TRAPS = {
    porous:   { sabinsPerUnit: [[40, 0.88], [50, 2.85], [63, 3.50], [80, 13.55], [100, 14.88], [125, 16.66], [160, 16.24], [200, 14.66], [250, 15.88]] },
    membrane: { sabinsPerUnit: [[40, 1.67], [50, 5.53], [63, 5.10], [80, 16.01], [100, 18.12], [125, 14.85], [160, 14.21], [200, 9.91], [250, 9.86]] }
  };
  const BASS_TRAP_UNIT_HEIGHT_FT = 4;
  // Lab sabins already include the boost of the panel's test position: one edge resting on the chamber floor, where a low-frequency field's mean square pressure is about twice the room average. The trap's own absorption area, before its position here is accounted for, is the lab value divided by that.
  const BASS_TRAP_LAB_COUPLING = 2;
  // A trap standing in a vertical corner sits where two walls meet, where the mean square pressure of a diffuse field is about 4 times the room average; estimatedT60 uses this for the trap's whole-room absorption.
  const BASS_TRAP_CORNER_COUPLING = 4;
  // How far a trap's acoustic center sits from its corner along the corner's diagonal, in feet (about half the panel's depth across it).
  const BASS_TRAP_CORNER_INSET_FT = 0.5;

  // A trap's own absorption area (m^2) at frequency f: the lab sabins at f, interpolated on log frequency between bands, scaled by its height in 4 ft panels and divided by BASS_TRAP_LAB_COUPLING. Below the lowest band (40 Hz) it falls as f^2, as a resonant or porous absorber does well below its working range; above the highest band it holds that band's value.
  function bassTrapAbsorptionM2(type, f, heightFt){
    const bands = BASS_TRAPS[type].sabinsPerUnit;
    let sabins;
    if(f <= bands[0][0]) sabins = bands[0][1] * (f / bands[0][0]) ** 2;
    else if(f >= bands[bands.length - 1][0]) sabins = bands[bands.length - 1][1];
    else {
      let i = 1;
      while(bands[i][0] < f) i++;
      const [f0, a0] = bands[i - 1], [f1, a1] = bands[i];
      sabins = a0 + (a1 - a0) * Math.log(f / f0) / Math.log(f1 / f0);
    }
    return sabins * FT_TO_M * FT_TO_M * (heightFt / BASS_TRAP_UNIT_HEIGHT_FT) / BASS_TRAP_LAB_COUPLING;
  }

  // The outside (90 degree) corner of the floor plan nearest (xFt, yFt), as { corner, x, y }: corner is its index in the polygon and (x, y) the trap's acoustic center, BASS_TRAP_CORNER_INSET_FT in from the corner along its diagonal. Traps only go in outside corners, where every mode of a rectangle has a pressure maximum.
  function bassTrapCorner(polygon, xFt, yFt){
    const n = polygon.length;
    let best = null, bestDist = Infinity;
    for(let i = 0; i < n; i++){
      if(!isConvexCorner(polygon, i)) continue;
      const c = polygon[i], dist = Math.hypot(c.x - xFt, c.y - yFt);
      if(dist < bestDist){ bestDist = dist; best = i; }
    }
    const c = polygon[best], p = polygon[(best - 1 + n) % n], q = polygon[(best + 1) % n];
    const inset = BASS_TRAP_CORNER_INSET_FT / Math.SQRT2;
    return { corner: best, x: c.x + Math.sign(p.x - c.x + q.x - c.x) * inset, y: c.y + Math.sign(p.y - c.y + q.y - c.y) * inset };
  }

  // The floor a trap at { corner } (see bassTrapCorner) takes up, as an { x, y, width, height } rectangle in feet: the square its two 1.4 ft legs span along the walls, so no sub is placed into it.
  function bassTrapFootprint(polygon, trap){
    const n = polygon.length, c = polygon[trap.corner], p = polygon[(trap.corner - 1 + n) % n], q = polygon[(trap.corner + 1) % n];
    const leg = 2 / Math.SQRT2, sx = Math.sign(p.x - c.x + q.x - c.x), sy = Math.sign(p.y - c.y + q.y - c.y);
    return { x: sx > 0 ? c.x : c.x - leg, y: sy > 0 ? c.y : c.y - leg, width: leg, height: leg };
  }

  // The mean of cos^2(kz * z) over a trap's height, z from the floor to heightM: how much of the mode's height variation the trap sees.
  function heightCosSquaredMean(kz, heightM){
    if(kz === 0 || !(heightM > 0)) return 1;
    return 0.5 + Math.sin(2 * kz * heightM) / (4 * kz * heightM);
  }

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
  // The damping (1/m) a mode gets from ctx.bassTraps, each { type, x, y, heightFt } with (x, y) its acoustic center in feet (see bassTrapCorner) standing from the floor to heightFt. A small absorber of area A at a point adds A * psi_n^2 there to the surface integral in delta_n below, so each trap adds scale * A(f_n) * psiSquared(trap), where scale is the mode's own 1 / (8 * volume integral of psi_n^2) and psiSquared gives psi_n^2 at the trap, averaged over its height.
  function bassTrapDamping(ctx, fn, scale, psiSquared){
    const traps = ctx.bassTraps;
    if(!traps || !traps.length) return 0;
    let sum = 0;
    traps.forEach((t, i) => { sum += bassTrapAbsorptionM2(t.type, fn, t.heightFt) * psiSquared(t, i); });
    return scale * sum;
  }

  // ctx: { room, wallAbsorption, floorAbsorption, ceilingMaterial, wallMaterials, bassTraps }.
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
    // A room that is not a rectangle carries its solved floor plan (see
    // solveFloorPlan), and its modes come from that instead of the formula.
    if(ctx.floorPlan) return enumerateFloorPlanModes(ctx, cutoffFreq);
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
          ) + bassTrapDamping(ctx, fn, epsX * epsY * epsZ / (8 * V), (t) =>
            Math.cos(nx * piOverLx * t.x * FT_TO_M) ** 2 * Math.cos(ny * piOverLy * t.y * FT_TO_M) ** 2 * heightCosSquaredMean(nz * piOverLz, t.heightFt * FT_TO_M));

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
    const plan = modes.floorPlan; // set for floor-plan modes, see enumerateFloorPlanModes
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
        levelGain, cosPhase: Math.cos(extraPhase), sinPhase: Math.sin(extraPhase),
        // floor-plan modes read the source's shape values from the plan's table, once per source
        shapes: plan && floorPlanShapesAt(plan, s.x, s.y), cosZ: []
      });
    }

    const precomputed = modes.map(mode => {
      const Dr = mode.kn * mode.kn - k * k;
      const Di = -k * mode.deltaN;
      const denom = Dr * Dr + Di * Di;
      const invDr = denom > 0 ? Dr / denom : 0;
      const invDi = denom > 0 ? -Di / denom : 0; // 1/(Dr+jDi) = (Dr-jDi)/(Dr^2+Di^2)

      let sourceRe = 0, sourceIm = 0;
      for(const src of active){
        const psi = plan
          ? src.shapes[mode.shape] * (src.cosZ[mode.nz] ?? (src.cosZ[mode.nz] = Math.cos(mode.invLz * src.z)))
          : Math.cos(mode.invLx * src.x) * Math.cos(mode.invLy * src.y) * Math.cos(mode.invLz * src.z);
        const amp = src.levelGain * psi;
        sourceRe += amp * src.cosPhase;
        sourceIm += amp * src.sinPhase;
      }

      // coef = An * (sourceRe + j*sourceIm) * (invDr + j*invDi)
      const coefRe = mode.An * (sourceRe * invDr - sourceIm * invDi);
      const coefIm = mode.An * (sourceRe * invDi + sourceIm * invDr);
      return plan
        ? { shape: mode.shape, nz: mode.nz, invLz: mode.invLz, coefRe, coefIm }
        : { invLx: mode.invLx, invLy: mode.invLy, invLz: mode.invLz, coefRe, coefIm };
    });
    if(plan) precomputed.floorPlan = plan;
    return precomputed;
  }

  // Sums complex pressure at (px,py,pz) from a precomputeModalField result.
  function computeFieldAtPoint(px, py, pz, precomputed){
    const pxM = px * FT_TO_M, pyM = py * FT_TO_M, pzM = pz * FT_TO_M;
    let re = 0, im = 0;
    const plan = precomputed.floorPlan;
    if(plan){
      // Floor-plan modes: each shape is read from the plan's table (a
      // weighted sum of up to four cells) once, then shared by that shape's
      // run of height cosines, which sit next to each other in the list.
      const { cells, weights } = floorPlanStencil(plan, px, py);
      const { numModes, shapes } = plan;
      const cosZ = [];
      for(let i = 0; i < precomputed.length; ){
        const shape = precomputed[i].shape;
        let phi = 0;
        for(let q = 0; q < cells.length; q++) phi += weights[q] * shapes[cells[q] * numModes + shape];
        for(; i < precomputed.length && precomputed[i].shape === shape; i++){
          const mode = precomputed[i];
          const psi = phi * (cosZ[mode.nz] ?? (cosZ[mode.nz] = Math.cos(mode.invLz * pzM)));
          re += mode.coefRe * psi;
          im += mode.coefIm * psi;
        }
      }
      return { re, im };
    }
    for(const mode of precomputed){
      const psi = Math.cos(mode.invLx * pxM) * Math.cos(mode.invLy * pyM) * Math.cos(mode.invLz * pzM);
      re += mode.coefRe * psi;
      im += mode.coefIm * psi;
    }
    return { re, im };
  }

  // Every mode's shape function at one point (feet), in the order of
  // `modes` (enumerateModes output). The shapes depend only on the room and
  // the point, not on the sources or the frequency, so a caller that
  // evaluates the same point again and again (a seat across a frequency
  // sweep, or across every candidate of a sub search) works them out once
  // and sums with fieldFromModeShapes instead of computeFieldAtPoint.
  function modeShapesAtPoint(px, py, pz, modes){
    const pxM = px * FT_TO_M, pyM = py * FT_TO_M, pzM = pz * FT_TO_M;
    const out = new Float64Array(modes.length);
    const plan = modes.floorPlan;
    if(plan){
      const { cells, weights } = floorPlanStencil(plan, px, py);
      const { numModes, shapes } = plan;
      const cosZ = [];
      for(let i = 0; i < modes.length; ){
        const shape = modes[i].shape;
        let phi = 0;
        for(let q = 0; q < cells.length; q++) phi += weights[q] * shapes[cells[q] * numModes + shape];
        for(; i < modes.length && modes[i].shape === shape; i++){
          const mode = modes[i];
          out[i] = phi * (cosZ[mode.nz] ?? (cosZ[mode.nz] = Math.cos(mode.invLz * pzM)));
        }
      }
      return out;
    }
    for(let i = 0; i < modes.length; i++){
      const mode = modes[i];
      out[i] = Math.cos(mode.invLx * pxM) * Math.cos(mode.invLy * pyM) * Math.cos(mode.invLz * pzM);
    }
    return out;
  }
  // computeFieldAtPoint for a point given as its modeShapesAtPoint (from the
  // same modes `precomputed` was built with). The same sum in the same
  // order, so the same result.
  function fieldFromModeShapes(shapes, precomputed){
    let re = 0, im = 0;
    for(let i = 0; i < precomputed.length; i++){
      re += precomputed[i].coefRe * shapes[i];
      im += precomputed[i].coefIm * shapes[i];
    }
    return { re, im };
  }

  // Factors computeFieldAtPoint's sum for a whole map at one listening
  // height. Every mode shape is cos(kx*x)*cos(ky*y)*cos(kz*z), and only a
  // few distinct kx values exist (11 for a 20 x 15 x 8 ft room's 261 modes),
  // so for each map row y this pre-sums every mode sharing a kx into one
  // complex value. The field at (x, rowYsFt[r]) is then the sum over columns
  // c of cos(kx[c] * x_m) * (sums[(r*nCols+c)*2], sums[(r*nCols+c)*2+1]),
  // the same result as computeFieldAtPoint with far fewer terms per point.
  function fieldRowSums(precomputed, pz, rowYsFt){
    const pzM = pz * FT_TO_M;
    const colOf = new Map(), kyOf = new Map(), pairOf = new Map();
    const kx = [], ky = [], pairs = [];
    for(const mode of precomputed){
      if(!colOf.has(mode.invLx)){ colOf.set(mode.invLx, kx.length); kx.push(mode.invLx); }
      if(!kyOf.has(mode.invLy)){ kyOf.set(mode.invLy, ky.length); ky.push(mode.invLy); }
      const key = mode.invLx + '|' + mode.invLy;
      let pair = pairOf.get(key);
      if(!pair){ pair = { col: colOf.get(mode.invLx), kyIdx: kyOf.get(mode.invLy), re: 0, im: 0 }; pairOf.set(key, pair); pairs.push(pair); }
      const cz = Math.cos(mode.invLz * pzM);
      pair.re += mode.coefRe * cz;
      pair.im += mode.coefIm * cz;
    }
    const nCols = kx.length, nRows = rowYsFt.length;
    const sums = new Float64Array(nRows * nCols * 2);
    const cosY = new Float64Array(ky.length);
    for(let r = 0; r < nRows; r++){
      const yM = rowYsFt[r] * FT_TO_M;
      for(let i = 0; i < ky.length; i++) cosY[i] = Math.cos(ky[i] * yM);
      const base = r * nCols * 2;
      for(const p of pairs){
        const c = cosY[p.kyIdx];
        sums[base + p.col*2] += p.re * c;
        sums[base + p.col*2 + 1] += p.im * c;
      }
    }
    return { kx: Float64Array.from(kx), nCols, nRows, sums };
  }

  // Convenience: full pressure-to-dB at one point, given app state. Mirrors what
  // draw() does per grid point, but callable standalone (e.g. for two-ear sampling,
  // or tests) without running the full grid.
  function fieldDbAtPoint(px, py, pz, sources, freq, ctx, refAmp){
    const modes = enumerateModes(ctx);
    const precomputed = precomputeModalField(sources, freq, ctx, modes);
    const { re, im } = computeFieldAtPoint(px, py, pz, precomputed);
    return pressureToDb(re, im, refAmp);
  }
  // A complex pressure (computeFieldAtPoint's re, im) in dB relative to
  // refAmp (default 1), floored at 1e-6 so a perfect null stays finite.
  function pressureToDb(re, im, refAmp){
    const mag = Math.sqrt(re*re + im*im);
    return 20 * Math.log10(Math.max(mag, 1e-6) / (refAmp ?? 1.0));
  }
  // The quietest and loudest level on an n x n grid over the floor plan at
  // height z (walls included), from one precomputeModalField result. A cheap
  // stand-in for the full render when only the range is needed. Grid points
  // outside a room.polygon are skipped.
  function sampleFieldDbRange(precomputed, room, z, n){
    n = n ?? 10;
    let min = Infinity, max = -Infinity;
    for(let j = 0; j < n; j++){
      const py = (j/(n-1)) * room.d;
      for(let i = 0; i < n; i++){
        const px = (i/(n-1)) * room.w;
        if(room.polygon && !isPointInPolygon(px, py, room.polygon)) continue;
        const { re, im } = computeFieldAtPoint(px, py, z, precomputed);
        const db = pressureToDb(re, im);
        if(db < min) min = db;
        if(db > max) max = db;
      }
    }
    return { min, max };
  }

  // ---- Rooms that are not rectangles: numeric floor-plan modes ----
  // A room whose floor plan is any polygon of right-angle corners (an L, a
  // T, a U, a notch) under a flat ceiling is that floor plan extruded
  // straight up. Its modes are exactly a floor-plan mode phi_m(x, y) times
  // the same height cosine a rectangle has, with k_n^2 = lambda_m +
  // (nz*pi/Lz)^2, where (lambda_m, phi_m) are the eigenpairs of the 2D
  // Laplacian on the floor plan with rigid (Neumann) walls. Only that 2D
  // problem has no formula, so solveFloorPlan computes it numerically and
  // every mode sum in this file then runs unchanged, reading mode shapes
  // from a table instead of computing cosines (see enumerateModes).
  //
  // A room is given as room.polygon: its corners in feet as [{x, y}, ...],
  // in order around the room (either direction), every wall parallel to
  // the x or the y axis. Wall i runs from corner i to corner i+1.

  // Area of a polygon [{x, y}, ...], in the square of its own units.
  function polygonArea(polygon){
    let twice = 0;
    for(let i = 0, j = polygon.length - 1; i < polygon.length; j = i++){
      twice += polygon[j].x * polygon[i].y - polygon[i].x * polygon[j].y;
    }
    return Math.abs(twice) / 2;
  }

  // True when (px, py) is inside the polygon or exactly on its boundary.
  function isPointInPolygon(px, py, polygon){
    let inside = false;
    for(let i = 0, j = polygon.length - 1; i < polygon.length; j = i++){
      const a = polygon[i], b = polygon[j];
      const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
      if(cross === 0 && px >= Math.min(a.x, b.x) && px <= Math.max(a.x, b.x) &&
         py >= Math.min(a.y, b.y) && py <= Math.max(a.y, b.y)) return true;
      // standard even-odd ray cast toward +x
      if((a.y > py) !== (b.y > py) && px < a.x + (b.x - a.x) * (py - a.y) / (b.y - a.y)) inside = !inside;
    }
    return inside;
  }

  // The four corners of a w x d rectangle, in the order the app keeps a
  // room's corners: from the front-left corner (0, 0) along the front wall,
  // so walls 0 to 3 are the front, right, back and left walls.
  function rectanglePolygon(w, d){
    return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d }, { x: 0, y: d }];
  }
  // A room's floor plan: its polygon, or for a plain { w, d } room the
  // rectangle from (0, 0).
  function floorPlanOf(room){
    return room.polygon || rectanglePolygon(room.w, room.d);
  }

  // Each wall of a floor plan, in polygon order: its end corners a and b,
  // whether it runs along x (`horizontal`), its length, and which side of
  // the room it bounds, 'front' | 'back' | 'left' | 'right'. A wall along x
  // with the room on its +y side is a front wall, one with the room on its
  // -y side a back wall, and likewise along y for left and right. An L room
  // has two front-facing walls, the front wall and the notch's inner wall.
  function floorPlanWalls(polygon){
    return polygon.map((a, i) => {
      const b = polygon[(i + 1) % polygon.length];
      const horizontal = a.y === b.y;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, eps = 1e-6;
      const side = horizontal
        ? (isPointInPolygon(mx, my + eps, polygon) ? 'front' : 'back')
        : (isPointInPolygon(mx + eps, my, polygon) ? 'left' : 'right');
      return { a, b, horizontal, lengthFt: Math.abs(b.x - a.x) + Math.abs(b.y - a.y), side };
    });
  }

  // How far a point is from the nearest wall of a floor plan, measured as
  // the larger of its x and y offsets from the nearest point of each wall
  // (the distance a square centered on the point can grow before it touches
  // a wall). Every wall runs along x or y, so this is the clearance a
  // rectangular object such as a sub cabinet has.
  function floorPlanClearance(px, py, polygon){
    let best = Infinity;
    for(let i = 0; i < polygon.length; i++){
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      const across = a.y === b.y ? Math.abs(py - a.y) : Math.abs(px - a.x);
      const along = a.y === b.y ? Math.max(0, Math.min(a.x, b.x) - px, px - Math.max(a.x, b.x)) : Math.max(0, Math.min(a.y, b.y) - py, py - Math.max(a.y, b.y));
      best = Math.min(best, Math.max(across, along));
    }
    return best;
  }

  // The point nearest (x, y) that is inside the room and at least insetFt
  // (default 0) from every wall in the floorPlanClearance sense. A
  // rectangle clamps each axis. In any other floor plan the allowed area's
  // edges lie on lines insetFt in from each wall, so the nearest allowed
  // point is the point itself, its projection onto one of those lines or a
  // crossing of two of them, whichever is nearest and allowed.
  function clampToFloorPlan(x, y, room, insetFt){
    const inset = insetFt ?? 0;
    const poly = room.polygon;
    if(!poly || poly.length === 4){
      const xs = poly ? poly.map(p => p.x) : [0, room.w], ys = poly ? poly.map(p => p.y) : [0, room.d];
      return {
        x: Math.max(Math.min(...xs) + inset, Math.min(Math.max(...xs) - inset, x)),
        y: Math.max(Math.min(...ys) + inset, Math.min(Math.max(...ys) - inset, y))
      };
    }
    const allowed = (px, py) => isPointInPolygon(px, py, poly) && floorPlanClearance(px, py, poly) >= inset - 1e-9;
    if(allowed(x, y)) return { x, y };
    const rows = [], cols = []; // the inset lines: { at, from, to }
    for(const wall of floorPlanWalls(poly)){
      const { a, b } = wall;
      if(wall.horizontal) rows.push({ at: a.y + (wall.side === 'front' ? inset : -inset), from: Math.min(a.x, b.x) - inset, to: Math.max(a.x, b.x) + inset });
      else cols.push({ at: a.x + (wall.side === 'left' ? inset : -inset), from: Math.min(a.y, b.y) - inset, to: Math.max(a.y, b.y) + inset });
    }
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const candidates = rows.map(r => ({ x: clamp(x, r.from, r.to), y: r.at }))
      .concat(cols.map(c => ({ x: c.at, y: clamp(y, c.from, c.to) })));
    for(const r of rows) for(const c of cols) candidates.push({ x: c.at, y: r.at });
    let best = null, bestDist = Infinity;
    for(const p of candidates){
      const dist = (p.x - x) ** 2 + (p.y - y) ** 2;
      if(dist < bestDist && allowed(p.x, p.y)){ best = p; bestDist = dist; }
    }
    return best || { x, y };
  }

  // The shortest wall the room editor allows, in feet.
  const FLOOR_PLAN_MIN_WALL_FT = 1;
  // A floor plan stretched or shrunk along 'x' or 'y' to `size` feet by
  // moving its farthest wall (every corner on the room's largest x or y),
  // so every other wall keeps its place and length. It never moves past
  // FLOOR_PLAN_MIN_WALL_FT beyond the next-farthest corner, so the shape
  // stays the same.
  function resizeFloorPlan(polygon, axis, size){
    const values = polygon.map(p => p[axis]);
    const max = Math.max(...values);
    const target = Math.max(size, Math.max(...values.filter(v => v < max)) + FLOOR_PLAN_MIN_WALL_FT);
    return polygon.map(p => p[axis] === max ? { ...p, [axis]: target } : { ...p });
  }

  // ---- Editing a floor plan ----
  // True when `polygon` is a room the solver and the editor accept: at least
  // four corners, every wall along x or y and at least FLOOR_PLAN_MIN_WALL_FT
  // long, each wall at a right angle to the next, and no wall touching any
  // other wall but its two neighbors.
  function isValidFloorPlan(polygon){
    const n = polygon.length;
    if(n < 4) return false;
    const tol = 1e-9;
    const walls = polygon.map((a, i) => ({ a, b: polygon[(i + 1) % n] }));
    for(let i = 0; i < n; i++){
      const { a, b } = walls[i], next = walls[(i + 1) % n];
      if(a.x !== b.x && a.y !== b.y) return false;
      if(Math.abs(b.x - a.x) + Math.abs(b.y - a.y) < FLOOR_PLAN_MIN_WALL_FT - tol) return false;
      if((a.y === b.y) === (next.a.y === next.b.y)) return false;
    }
    for(let i = 0; i < n; i++){
      for(let j = i + 2; j < n; j++){
        if(i === 0 && j === n - 1) continue; // neighbors around the end of the list
        const p = walls[i], q = walls[j];
        if(Math.max(Math.min(p.a.x, p.b.x), Math.min(q.a.x, q.b.x)) <= Math.min(Math.max(p.a.x, p.b.x), Math.max(q.a.x, q.b.x)) &&
           Math.max(Math.min(p.a.y, p.b.y), Math.min(q.a.y, q.b.y)) <= Math.min(Math.max(p.a.y, p.b.y), Math.max(q.a.y, q.b.y))) return false;
      }
    }
    return true;
  }

  // Each edit below returns { polygon, walls, shift } or null when the
  // result would not be a valid floor plan (isValidFloorPlan). walls[j] is
  // the index of the old wall whose settings (its material) new wall j
  // takes. The result is moved so its smallest x and y are 0, and shift
  // ({ x, y }, feet) is what was added to every coordinate: add it to
  // anything else placed in the room so it stays put against the walls.
  function finishFloorPlanEdit(polygon, walls){
    if(!isValidFloorPlan(polygon)) return null;
    const shift = { x: 0 - Math.min(...polygon.map(p => p.x)), y: 0 - Math.min(...polygon.map(p => p.y)) };
    return { polygon: polygon.map(p => ({ x: p.x + shift.x, y: p.y + shift.y })), walls, shift };
  }
  const sameWalls = (polygon) => polygon.map((_, i) => i);

  // Moves wall i straight across itself to x = `at` (a wall along y) or
  // y = `at` (a wall along x). Its two neighbors stretch or shrink to meet it.
  function moveFloorPlanWall(polygon, i, at){
    const n = polygon.length, a = polygon[i], b = polygon[(i + 1) % n];
    const axis = a.y === b.y ? 'y' : 'x';
    const moved = polygon.map((p, k) => k === i || k === (i + 1) % n ? { ...p, [axis]: at } : { ...p });
    return finishFloorPlanEdit(moved, sameWalls(polygon));
  }
  // Moves corner i to (x, y): the two walls that meet there each move
  // straight across themselves, so every corner stays a right angle.
  function moveFloorPlanCorner(polygon, i, x, y){
    const n = polygon.length, prev = (i - 1 + n) % n;
    const alongX = polygon[i].y === polygon[(i + 1) % n].y; // wall i runs along x, so wall prev runs along y
    const moved = polygon.map(p => ({ ...p }));
    for(const [wall, axis, at] of [[i, alongX ? 'y' : 'x', alongX ? y : x], [prev, alongX ? 'x' : 'y', alongX ? x : y]]){
      moved[wall][axis] = at;
      moved[(wall + 1) % n][axis] = at;
    }
    return finishFloorPlanEdit(moved, sameWalls(polygon));
  }
  // Sets wall i's length by moving the wall at its far end (the end with
  // the larger x or y), so the end nearer the front-left stays put, the
  // same way resizeFloorPlan grows a room.
  function setFloorPlanWallLength(polygon, i, lengthFt){
    const n = polygon.length, a = polygon[i], b = polygon[(i + 1) % n];
    const axis = a.y === b.y ? 'x' : 'y';
    return b[axis] >= a[axis]
      ? moveFloorPlanWall(polygon, (i + 1) % n, a[axis] + lengthFt)
      : moveFloorPlanWall(polygon, (i - 1 + n) % n, b[axis] + lengthFt);
  }
  // True when corner i is an outside corner (90 degrees inside the room),
  // false for an inside (270 degree) corner.
  function isConvexCorner(polygon, i){
    const n = polygon.length, c = polygon[i], p = polygon[(i - 1 + n) % n], q = polygon[(i + 1) % n];
    const eps = 1e-6;
    return isPointInPolygon(c.x + Math.sign(p.x - c.x + q.x - c.x) * eps, c.y + Math.sign(p.y - c.y + q.y - c.y) * eps, polygon);
  }
  // Cuts a notch out of outside corner i, `sizeFt` along each of its two
  // walls (capped at a third of each wall, and at least
  // FLOOR_PLAN_MIN_WALL_FT): the corner becomes three, and the notch's two
  // new walls each take the settings of the wall they run parallel to.
  function cutFloorPlanCorner(polygon, i, sizeFt){
    const n = polygon.length, prev = (i - 1 + n) % n;
    if(!isConvexCorner(polygon, i)) return null;
    const c = polygon[i], p = polygon[prev], q = polygon[(i + 1) % n];
    const step = (to) => {
      const len = Math.abs(to.x - c.x) + Math.abs(to.y - c.y);
      const d = Math.max(FLOOR_PLAN_MIN_WALL_FT, Math.min(sizeFt, len / 3));
      return { x: Math.sign(to.x - c.x) * d, y: Math.sign(to.y - c.y) * d };
    };
    const toP = step(p), toQ = step(q);
    const corners = [{ x: c.x + toP.x, y: c.y + toP.y }, { x: c.x + toP.x + toQ.x, y: c.y + toP.y + toQ.y }, { x: c.x + toQ.x, y: c.y + toQ.y }];
    const cut = polygon.slice(0, i).concat(corners, polygon.slice(i + 1)).map(v => ({ ...v }));
    // new walls, in order: ...prev (shortened), parallel to wall i, parallel to prev, i (shortened)...
    const walls = sameWalls(polygon).flatMap(k => k === prev ? [prev] : k === i ? [i, prev, i] : [k]);
    return finishFloorPlanEdit(cut, walls);
  }
  // Fills in the notch at inside corner i: the corner and its two
  // neighbors become the one outside corner that squares them off, and any
  // walls that then line up merge (the earlier one's settings are kept).
  function fillFloorPlanCorner(polygon, i){
    const n = polygon.length;
    if(isConvexCorner(polygon, i)) return null;
    const prev = (i - 1 + n) % n, next = (i + 1) % n;
    const c = polygon[i], p = polygon[prev], q = polygon[next];
    let pts = polygon.map((v, k) => ({ v: { ...v }, wall: k }));
    // corner `prev` takes the squared-off position; wall prev's slot is the
    // one wall `next`'s settings continue in
    pts[prev] = { v: { x: p.x + q.x - c.x, y: p.y + q.y - c.y }, wall: next };
    pts = pts.filter((_, k) => k !== i && k !== next);
    // drop repeated corners, then corners between two walls in line
    for(let changed = true; changed && pts.length >= 3; ){
      changed = false;
      for(let k = 0; k < pts.length && pts.length >= 3; k++){
        const a = pts[(k - 1 + pts.length) % pts.length].v, b = pts[k].v, d = pts[(k + 1) % pts.length].v;
        const repeated = b.x === d.x && b.y === d.y;
        const inLine = (a.x === b.x && b.x === d.x) || (a.y === b.y && b.y === d.y);
        if(repeated || inLine){
          // corner k goes; the wall leaving it merges into the wall arriving at it
          pts.splice(k, 1);
          changed = true;
          break;
        }
      }
    }
    return finishFloorPlanEdit(pts.map(e => e.v), pts.map(e => e.wall));
  }

  // The room shapes the setup guide offers, as a w x d ft floor plan with
  // its corners in the same order as rectanglePolygon (front wall first).
  // 'L' has a notch out of its back-right corner, 'T' a narrower back half
  // (a notch out of each back corner) and 'U' a notch in the middle of its
  // back wall; each notch is about 40% of the depth, rounded to half a foot.
  const FLOOR_PLAN_TEMPLATES = ['rectangle', 'L', 'T', 'U'];
  function floorPlanTemplate(kind, w, d){
    const half = (v) => Math.max(FLOOR_PLAN_MIN_WALL_FT, Math.round(v * 2) / 2);
    const ny = half(d * 0.4);
    if(kind === 'L'){
      const nx = half(w * 0.4);
      return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d - ny }, { x: w - nx, y: d - ny }, { x: w - nx, y: d }, { x: 0, y: d }];
    }
    if(kind === 'T'){
      const side = half(w / 4);
      return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d - ny }, { x: w - side, y: d - ny }, { x: w - side, y: d }, { x: side, y: d }, { x: side, y: d - ny }, { x: 0, y: d - ny }];
    }
    if(kind === 'U'){
      const arm = half(w / 3);
      return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d }, { x: w - arm, y: d }, { x: w - arm, y: d - ny }, { x: arm, y: d - ny }, { x: arm, y: d }, { x: 0, y: d }];
    }
    return rectanglePolygon(w, d);
  }
  // Replaces a floor plan with one of FLOOR_PLAN_TEMPLATES at the same
  // overall size, as an edit (see finishFloorPlanEdit): each new wall takes
  // the settings of the first old wall on the same side of the room.
  function floorPlanFromTemplate(polygon, kind){
    const w = Math.max(...polygon.map(p => p.x)) - Math.min(...polygon.map(p => p.x));
    const d = Math.max(...polygon.map(p => p.y)) - Math.min(...polygon.map(p => p.y));
    const shape = floorPlanTemplate(kind, w, d);
    const oldSides = floorPlanWalls(polygon).map(wall => wall.side);
    return finishFloorPlanEdit(shape, floorPlanWalls(shape).map(wall => oldSides.indexOf(wall.side)));
  }
  // Which of FLOOR_PLAN_TEMPLATES a floor plan is, in any size and either
  // way round, or null for any other shape: a rectangle has 4 corners, an L
  // 6, and of 8-corner plans a T is missing the two bounding-box corners at
  // one end of a side and a U none of them.
  function floorPlanTemplateKind(polygon){
    if(polygon.length === 4) return 'rectangle';
    if(polygon.length === 6) return 'L';
    if(polygon.length !== 8) return null;
    const xs = polygon.map(p => p.x), ys = polygon.map(p => p.y);
    const box = [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)], [Math.min(...xs), Math.max(...ys)]];
    const missing = box.filter(([x, y]) => !polygon.some(p => p.x === x && p.y === y));
    if(missing.length === 0) return 'U';
    if(missing.length === 2 && (missing[0][0] === missing[1][0] || missing[0][1] === missing[1][1])) return 'T';
    return null;
  }
  // A floor plan mirrored left to right (axis 'x') or front to back ('y'),
  // as an edit (see finishFloorPlanEdit). Every wall keeps its own
  // settings, so a mirrored wall's material goes with it to the other side.
  // Like rectanglePolygon, the list starts at the front wall's left end.
  function mirrorFloorPlan(polygon, axis){
    const n = polygon.length, max = Math.max(...polygon.map(p => p[axis]));
    // reversed, so the corners keep running the same way round
    const mirrored = polygon.map(p => ({ ...p, [axis]: max - p[axis] })).reverse();
    const walls = mirrored.map((_, j) => (2 * n - 2 - j) % n);
    const first = mirrored.reduce((best, p, k) => p.y < mirrored[best].y || (p.y === mirrored[best].y && p.x < mirrored[best].x) ? k : best, 0);
    const turn = (list) => list.slice(first).concat(list.slice(0, first));
    return finishFloorPlanEdit(turn(mirrored), turn(walls));
  }

  // The largest rectangle of floor that runs back from the front wall
  // (the room's smallest y), as { x, y, w, d } in feet: the part of the
  // room a screen on that wall faces. A rectangle room is the whole room;
  // in an L with its notch at the back it is the deeper arm or the full
  // width in front of the notch, whichever has more floor.
  function floorPlanFrontArea(polygon){
    const xs = [...new Set(polygon.map(p => p.x))].sort((a, b) => a - b);
    const front = Math.min(...polygon.map(p => p.y));
    // how far the floor runs back from the front wall in each strip between corners
    const depth = xs.slice(0, -1).map((x, i) => {
      const mid = (x + xs[i + 1]) / 2;
      const crossings = floorPlanWalls(polygon).filter(w => w.horizontal && Math.min(w.a.x, w.b.x) < mid && Math.max(w.a.x, w.b.x) > mid).map(w => w.a.y).sort((a, b) => a - b);
      return crossings[0] === front ? crossings[1] - front : 0;
    });
    let best = null;
    for(let i = 0; i < depth.length; i++){
      let d = Infinity;
      for(let j = i; j < depth.length && depth[j] > 0; j++){
        d = Math.min(d, depth[j]);
        const area = (xs[j + 1] - xs[i]) * d;
        if(!best || area > best.w * best.d) best = { x: xs[i], y: front, w: xs[j + 1] - xs[i], d };
      }
    }
    return best;
  }

  // Grid cell size for the floor-plan solve. Mode shapes below the 300 Hz
  // cutoff have a wavelength of 1.14 m or more, 11 cells at this size.
  const FLOOR_PLAN_CELL_M = 0.1;
  // Near an inside (270 degree) corner the mode shapes have a singular
  // gradient, which a uniform grid resolves slowly. Grid lines within
  // radiusCells cells of such a corner are spaced cellM * (distance /
  // radius) ^ exponent apart, never closer than cellM * minFraction.
  const CORNER_REFINE = { radiusCells: 2, exponent: 0.5, minFraction: 0.25 };

  // Grid lines along one axis: every value in `breaks` (the sorted wall
  // coordinates) is a line, so walls always fall exactly on cell edges, and
  // each span between two breaks is cut into equal-count cells no wider
  // than the local target size (see CORNER_REFINE; `refineAt` lists the
  // coordinates of the inside corners).
  function floorGridLines(breaks, refineAt, cellM){
    const refine = CORNER_REFINE, radius = refine.radiusCells * cellM;
    const lines = [breaks[0]];
    for(let b = 0; b + 1 < breaks.length; b++){
      const a = breaks[b], len = breaks[b + 1] - a;
      // cum[s]: how many cells of the local target size fit in the first s
      // of `steps` equal pieces of this span
      const steps = Math.max(16, Math.ceil(32 * len / cellM));
      const piece = len / steps;
      const cum = new Float64Array(steps + 1);
      for(let s = 0; s < steps; s++){
        const x = a + (s + 0.5) * piece;
        let fraction = 1;
        for(const r of refineAt){
          fraction = Math.min(fraction, Math.pow(Math.abs(x - r) / radius, refine.exponent));
        }
        cum[s + 1] = cum[s] + piece / (cellM * Math.max(refine.minFraction, fraction));
      }
      const n = Math.max(1, Math.ceil(cum[steps] - 1e-9));
      for(let i = 1, s = 0; i < n; i++){
        const target = i * cum[steps] / n;
        while(cum[s + 1] < target) s++;
        lines.push(a + (s + (target - cum[s]) / (cum[s + 1] - cum[s])) * piece);
      }
      lines.push(breaks[b + 1]);
    }
    return Float64Array.from(lines);
  }

  // The floor plan cut into rectangular cells: grid lines xs/ys in meters,
  // cellId[j*nx + i] the cell's number or -1 outside the room, and cellI/
  // cellJ each numbered cell's column and row. Cells are numbered along the
  // axis with fewer lines first, which keeps neighbors close in number
  // (a narrow matrix band, see factorShifted).
  function buildFloorGrid(polygon, cellM){
    const pts = polygon.map(p => ({ x: p.x * FT_TO_M, y: p.y * FT_TO_M }));
    const count = pts.length;
    let twiceArea = 0;
    for(let i = 0, j = count - 1; i < count; j = i++) twiceArea += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
    const refineX = [], refineY = [];
    for(let i = 0; i < count; i++){
      const prev = pts[(i + count - 1) % count], at = pts[i], next = pts[(i + 1) % count];
      if((at.x === next.x) === (at.y === next.y)) throw new Error('solveFloorPlan: every wall must run along x or y');
      // a turn against the polygon's own winding is an inside corner
      const turn = (at.x - prev.x) * (next.y - at.y) - (at.y - prev.y) * (next.x - at.x);
      if(turn * twiceArea < 0){ refineX.push(at.x); refineY.push(at.y); }
    }
    const sortedUnique = (values) => [...new Set(values)].sort((a, b) => a - b);
    const xs = floorGridLines(sortedUnique(pts.map(p => p.x)), refineX, cellM);
    const ys = floorGridLines(sortedUnique(pts.map(p => p.y)), refineY, cellM);
    const nx = xs.length - 1, ny = ys.length - 1;
    const cellId = new Int32Array(nx * ny).fill(-1);
    const cellI = [], cellJ = [];
    const rowsOuter = nx <= ny;
    for(let outer = 0; outer < (rowsOuter ? ny : nx); outer++){
      for(let inner = 0; inner < (rowsOuter ? nx : ny); inner++){
        const i = rowsOuter ? inner : outer, j = rowsOuter ? outer : inner;
        if(!isPointInPolygon((xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2, pts)) continue;
        cellId[j * nx + i] = cellI.length;
        cellI.push(i); cellJ.push(j);
      }
    }
    return { pts, xs, ys, nx, ny, cellId, cellI: Int32Array.from(cellI), cellJ: Int32Array.from(cellJ), numCells: cellI.length };
  }

  // The rigid-wall Laplacian on the grid as a symmetric matrix A (cell-
  // centered finite volumes: the flux through the face two cells share is
  // the difference of their values over the distance between their centers,
  // and a wall face carries no flux). With cell areas a, the discrete
  // problem K u = lambda * diag(a) * u is solved in the symmetric form
  // A v = lambda v, A = a^-1/2 K a^-1/2, v = a^1/2 u. Stored as each row's
  // diagonal plus its two entries left of the diagonal: lowIdx/lowVal[2k]
  // for the cell before it along x and [2k+1] along y (index -1 when that
  // neighbor is a wall). diagX is the x faces' share of the diagonal,
  // first[k] the lowest column row k reaches and band the widest reach.
  function floorPlanOperator(grid){
    const { xs, ys, nx, ny, cellId, cellI, cellJ, numCells: n } = grid;
    const hx = new Float64Array(n), hy = new Float64Array(n);
    for(let k = 0; k < n; k++){ hx[k] = xs[cellI[k] + 1] - xs[cellI[k]]; hy[k] = ys[cellJ[k] + 1] - ys[cellJ[k]]; }
    const diag = new Float64Array(n), diagX = new Float64Array(n);
    const lowIdx = new Int32Array(2 * n).fill(-1), lowVal = new Float64Array(2 * n);
    const first = new Int32Array(n);
    for(let k = 0; k < n; k++) first[k] = k;
    let band = 0;
    // joins cell k to its next cell m along x (axis 0) or y (axis 1)
    const couple = (k, m, axis, faceLen, centerDist) => {
      const g = faceLen / centerDist, ak = hx[k] * hy[k], am = hx[m] * hy[m];
      diag[k] += g / ak;
      diag[m] += g / am;
      if(axis === 0){ diagX[k] += g / ak; diagX[m] += g / am; }
      lowIdx[2 * m + axis] = k;
      lowVal[2 * m + axis] = -g / Math.sqrt(ak * am);
      if(k < first[m]) first[m] = k;
      if(m - k > band) band = m - k;
    };
    for(let k = 0; k < n; k++){
      const i = cellI[k], j = cellJ[k];
      const right = i + 1 < nx ? cellId[j * nx + i + 1] : -1;
      const up = j + 1 < ny ? cellId[(j + 1) * nx + i] : -1;
      if(right >= 0) couple(k, right, 0, hy[k], (xs[i + 2] - xs[i]) / 2);
      if(up >= 0) couple(k, up, 1, hx[k], (ys[j + 2] - ys[j]) / 2);
    }
    return { n, hx, hy, diag, diagX, lowIdx, lowVal, first, band };
  }

  // How far the grid's eigenvalue for unit eigenvector v sits below the
  // true one, to leading order. The grid's second difference along x is
  // d2/dx2 + (hx^2/12) d4/dx4 + ..., so with A = Ax + Ay split by axis the
  // grid eigenvalue is low by (hx^2 |Ax v|^2 + hy^2 |Ay v|^2) / 12
  // (first-order perturbation theory; the fourth derivative integrates by
  // parts onto the second because rigid flat walls leave no boundary
  // term). Adding it back takes a rectangle's eigenvalues from second-order
  // to fourth-order accurate in the cell size.
  function gridDispersionShift(op, v){
    const { n, hx, hy, diag, diagX, lowIdx, lowVal } = op;
    const ax = new Float64Array(n), ay = new Float64Array(n);
    for(let k = 0; k < n; k++){
      ax[k] += diagX[k] * v[k];
      ay[k] += (diag[k] - diagX[k]) * v[k];
      const mx = lowIdx[2 * k], my = lowIdx[2 * k + 1];
      if(mx >= 0){ ax[k] += lowVal[2 * k] * v[mx]; ax[mx] += lowVal[2 * k] * v[k]; }
      if(my >= 0){ ay[k] += lowVal[2 * k + 1] * v[my]; ay[my] += lowVal[2 * k + 1] * v[k]; }
    }
    let shift = 0;
    for(let k = 0; k < n; k++) shift += hx[k] * hx[k] * ax[k] * ax[k] + hy[k] * hy[k] * ay[k] * ay[k];
    return shift / 12;
  }

  // Factors A - sigma*I = L D L^T (L unit lower triangular, D diagonal)
  // into `store` ({ L, D }, reused between calls), keeping to each row's
  // own reach first[i] (an envelope factorization: nothing left of a row's
  // first entry ever fills in). Returns how many entries of D are negative,
  // which by Sylvester's law of inertia is exactly the number of
  // eigenvalues of A below sigma, and records the smallest |D| as
  // store.minPivot (NaN if the factorization broke down).
  function factorShifted(op, sigma, store){
    const { n, diag, lowIdx, lowVal, first, band } = op;
    const { L, D } = store;
    const B = band + 1;
    let negatives = 0, minPivot = Infinity;
    for(let i = 0; i < n; i++){
      const fi = first[i], rowI = i * B + band - i; // L[i][j] lives at L[rowI + j]
      L.fill(0, rowI + fi, rowI + i);
      if(lowIdx[2 * i] >= 0) L[rowI + lowIdx[2 * i]] = lowVal[2 * i];
      if(lowIdx[2 * i + 1] >= 0) L[rowI + lowIdx[2 * i + 1]] = lowVal[2 * i + 1];
      // first pass leaves u_j = L[i][j] * D[j] in the row, so the inner loop is a plain dot product
      for(let j = fi; j < i; j++){
        const rowJ = j * B + band - j;
        let sum = L[rowI + j];
        for(let k = Math.max(fi, first[j]); k < j; k++) sum -= L[rowI + k] * L[rowJ + k];
        L[rowI + j] = sum;
      }
      let d = diag[i] - sigma;
      for(let j = fi; j < i; j++){
        const u = L[rowI + j], l = u / D[j];
        d -= u * l;
        L[rowI + j] = l;
      }
      D[i] = d;
      if(d < 0) negatives++;
      if(!(Math.abs(d) >= minPivot)) minPivot = Math.abs(d);
    }
    store.minPivot = minPivot;
    return negatives;
  }

  // Solves (L D L^T) out = rhs with factorShifted's factors.
  function solveFactored(op, store, rhs, out){
    const { n, first, band } = op;
    const { L, D } = store;
    const B = band + 1;
    for(let i = 0; i < n; i++){
      const rowI = i * B + band - i;
      let sum = rhs[i];
      for(let k = first[i]; k < i; k++) sum -= L[rowI + k] * out[k];
      out[i] = sum;
    }
    for(let i = 0; i < n; i++) out[i] /= D[i];
    for(let i = n - 1; i >= 0; i--){
      const rowI = i * B + band - i, yi = out[i];
      for(let k = first[i]; k < i; k++) out[k] -= L[rowI + k] * yi;
    }
  }

  // Eigenvalues of a symmetric tridiagonal matrix by the implicit QL method
  // (EISPACK's tql2). d: the diagonal, replaced by the eigenvalues. e: the
  // off-diagonal, e[i] joining rows i and i+1, with e[n-1] = 0; destroyed.
  // z: zRows rows of n numbers, each multiplied by the eigenvector matrix,
  // so passing the identity (zRows = n) returns the eigenvectors as columns
  // and passing only its last row (zRows = 1) returns each eigenvector's
  // last component, which is all a convergence check needs.
  function tridiagEigen(d, e, n, z, zRows){
    const EPS = 2.220446049250313e-16;
    let f = 0, tst1 = 0;
    for(let l = 0; l < n; l++){
      tst1 = Math.max(tst1, Math.abs(d[l]) + Math.abs(e[l]));
      let m = l;
      while(m < n - 1 && Math.abs(e[m]) > EPS * tst1) m++;
      if(m > l){
        do {
          let g = d[l];
          let p = (d[l + 1] - g) / (2 * e[l]);
          let r = Math.sqrt(p * p + 1);
          if(p < 0) r = -r;
          d[l] = e[l] / (p + r);
          d[l + 1] = e[l] * (p + r);
          const dl1 = d[l + 1];
          let h = g - d[l];
          for(let i = l + 2; i < n; i++) d[i] -= h;
          f += h;
          p = d[m];
          let c = 1, c2 = 1, c3 = 1, s = 0, s2 = 0;
          const el1 = e[l + 1];
          for(let i = m - 1; i >= l; i--){
            c3 = c2; c2 = c; s2 = s;
            g = c * e[i];
            h = c * p;
            r = Math.sqrt(p * p + e[i] * e[i]);
            e[i + 1] = s * r;
            s = e[i] / r;
            c = p / r;
            p = c * d[i] - s * g;
            d[i + 1] = h + s * (c * g + s * d[i]);
            for(let k = 0; k < zRows; k++){
              h = z[k * n + i + 1];
              z[k * n + i + 1] = s * z[k * n + i] + c * h;
              z[k * n + i] = c * z[k * n + i] - s * h;
            }
          }
          p = -s * s2 * c3 * el1 * e[l] / dl1;
          e[l] = s * p;
          d[l] = c * p;
        } while(Math.abs(e[l]) > EPS * tst1);
      }
      d[l] += f;
      e[l] = 0;
    }
  }

  // One shift-and-invert Lanczos run for eigenpairs of A in [lo, hi): the
  // Lanczos recurrence on (A - sigma*I)^-1 (factored in `store`), whose
  // largest eigenvalues theta = 1 / (lambda - sigma) belong to the lambda
  // nearest sigma and so converge first. Every new vector is orthogonalized
  // against all earlier ones and against `locked`, eigenvectors already
  // found in this slice, which keeps the run inside what is still missing.
  // Stops as soon as `missing` eigenpairs in [lo, hi) have converged, or
  // when everything it can see in the slice has converged and it has also
  // converged values beyond both ends of it (it will find no more: Lanczos
  // from one start vector sees only one eigenvector of a repeated
  // eigenvalue, so the caller runs again with these locked). Returns
  // [{ lam, vec }] with unit-length vec.
  const RITZ_TOL = 1e-8;
  function lanczosRun(op, store, sigma, lo, hi, missing, noneBelowLo, locked, seed){
    const n = op.n;
    const mMax = Math.min(n - locked.length, Math.ceil(2.2 * missing + 30));
    const V = new Float64Array(mMax * n), alpha = new Float64Array(mMax), beta = new Float64Array(mMax);
    const w = new Float64Array(n);
    const dot = (a, b) => { let s = 0; for(let i = 0; i < n; i++) s += a[i] * b[i]; return s; };
    const removeAlong = (u) => { const s = dot(w, u); for(let i = 0; i < n; i++) w[i] -= s * u[i]; };
    const row = (k) => V.subarray(k * n, (k + 1) * n);

    // deterministic pseudo-random start (the same room always solves the same way)
    let state = (seed * 2654435761 + 12345) >>> 0;
    for(let i = 0; i < n; i++){
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      w[i] = state / 4294967296 - 0.5;
    }
    for(const u of locked) removeAlong(u);
    let norm = Math.sqrt(dot(w, w));

    let m = 0;
    for(let k = 0; k < mMax; k++){
      const vk = row(k);
      for(let i = 0; i < n; i++) vk[i] = w[i] / norm;
      solveFactored(op, store, vk, w);
      alpha[k] = dot(w, vk);
      for(let i = 0; i < n; i++) w[i] -= alpha[k] * vk[i];
      if(k > 0){ const prev = row(k - 1), b = beta[k - 1]; for(let i = 0; i < n; i++) w[i] -= b * prev[i]; }
      // full reorthogonalization, repeated once if the first pass removed a lot
      norm = Math.sqrt(dot(w, w));
      for(let pass = 0; pass < 2; pass++){
        for(const u of locked) removeAlong(u);
        for(let j = 0; j <= k; j++) removeAlong(row(j));
        const after = Math.sqrt(dot(w, w));
        const lostALot = after < 0.7 * norm;
        norm = after;
        if(!lostALot) break;
      }
      beta[k] = norm;
      m = k + 1;
      const exhausted = m === mMax || !(norm > 1e-13 * Math.abs(alpha[k]));
      if(!exhausted && (m < missing || (m - missing) % 4 !== 0)) continue;

      // Ritz values and their residuals |beta_m * (last component)|
      const theta = alpha.slice(0, m), off = beta.slice(0, m), lastComp = new Float64Array(m);
      off[m - 1] = 0;
      lastComp[m - 1] = 1;
      tridiagEigen(theta, off, m, lastComp, 1);
      let inSlice = 0, convergedInSlice = 0, convergedBelow = false, convergedAbove = false;
      for(let i = 0; i < m; i++){
        const lam = sigma + 1 / theta[i];
        const converged = Math.abs(norm * lastComp[i]) <= RITZ_TOL * Math.abs(theta[i]);
        if(lam >= lo && lam < hi){ inSlice++; if(converged) convergedInSlice++; }
        else if(converged && lam < lo) convergedBelow = true;
        else if(converged && lam >= hi) convergedAbove = true;
      }
      if(exhausted || convergedInSlice >= missing) break;
      if(inSlice === convergedInSlice && convergedAbove && (noneBelowLo || convergedBelow)) break;
    }

    // Ritz vectors of the converged values in the slice
    const d = alpha.slice(0, m), off = beta.slice(0, m);
    off[m - 1] = 0;
    const Z = new Float64Array(m * m);
    for(let i = 0; i < m; i++) Z[i * m + i] = 1;
    tridiagEigen(d, off, m, Z, m);
    const out = [];
    for(let i = 0; i < m; i++){
      const lam = sigma + 1 / d[i];
      if(!(lam >= lo && lam < hi)) continue;
      if(!(Math.abs(norm * Z[(m - 1) * m + i]) <= RITZ_TOL * Math.abs(d[i]))) continue;
      const vec = new Float64Array(n);
      for(let k = 0; k < m; k++){
        const c = Z[k * m + i], vk = row(k);
        for(let q = 0; q < n; q++) vec[q] += c * vk[q];
      }
      out.push({ lam, vec });
    }
    return out;
  }

  // Every eigenpair of A below lamMax, by spectrum slicing: [0, lamMax) is
  // cut into slices of about SLICE_MODES eigenvalues, the inertia count at
  // each slice boundary (factorShifted) says exactly how many eigenvalues
  // the slice holds, and Lanczos runs around the slice's midpoint repeat
  // until that many are found. Nothing below lamMax can be missed, repeated
  // eigenvalues included. Returns [{ lam, vec }] in ascending order.
  const SLICE_MODES = 40;
  function eigenpairsBelow(op, lamMax){
    const store = { L: new Float64Array(op.n * (op.band + 1)), D: new Float64Array(op.n), minPivot: 0 };
    // The factorization does not pivot, so a shift within rounding of an
    // eigenvalue of A (or of one of its leading blocks) leaves a pivot near
    // zero and factors too inaccurate to use. That is rare, and stepping
    // the shift aside by a thousandth of itself cures it (accuracy falls
    // off with closeness, so a smaller step would leave some error behind).
    const factorNear = (sigma) => {
      for(;; sigma *= 1.001){
        const negatives = factorShifted(op, sigma, store);
        if(store.minPivot > 1e-7 * sigma) return { sigma, negatives };
      }
    };
    const top = factorNear(lamMax);
    const slices = Math.max(1, Math.ceil(top.negatives / SLICE_MODES));
    const pairs = [];
    let below = 0, lo = -Infinity;
    for(let s = 0; s < slices; s++){
      const end = s === slices - 1 ? top : factorNear(lamMax * (s + 1) / slices);
      const hi = end.sigma, need = end.negatives - below;
      if(need > 0){
        const sigma = factorNear((Math.max(lo, 0) + hi) / 2).sigma;
        const found = [];
        for(let attempt = 0; found.length < need; attempt++){
          const got = lanczosRun(op, store, sigma, lo, hi, need - found.length, below === 0, found.map(p => p.vec), s * 16 + attempt);
          if(got.length === 0) throw new Error('solveFloorPlan: eigenvalue search stalled');
          for(const p of got) found.push(p);
        }
        found.sort((a, b) => a.lam - b.lam);
        for(const p of found) pairs.push(p);
      }
      below = end.negatives;
      lo = hi;
    }
    return pairs;
  }

  // ---- Solves a floor plan's modes (the slow, once-per-shape step) ----
  // polygon: the room's corners in feet (see above). opts.cellM: grid cell
  // size in meters (default FLOOR_PLAN_CELL_M; pass a larger one for a
  // quick preview). opts.cutoffHz: modes up to this frequency (default
  // MODE_CUTOFF_HZ). Takes a few tenths of a second to a few seconds, so
  // callers run it once per room shape (off the main thread in the app),
  // keep the result, and pass it to every other function as ctx.floorPlan.
  //
  // Returns the floor plan's mode table:
  //   polygon, cellM, cutoffHz: the inputs
  //   xs, ys, nx, ny: the grid lines in meters; every wall lies on one
  //   cellId[j*nx + i]: the cell's row in `shapes`, or -1 outside the room
  //   numCells, areaM2
  //   numModes, kSquared[m]: each mode's eigenvalue (its wavenumber squared,
  //     1/m^2), ascending; mode 0 is the uniform mode with kSquared 0
  //   shapes[cell*numModes + m]: mode m's value at the cell's center,
  //     scaled so its mean square over the floor is 1
  //   numWalls, wallWeights[m*numWalls + i]: the integral of mode m's
  //     square along wall i, in meters (the wall's length for mode 0),
  //     which is what sets how strongly that wall's material damps the mode
  function solveFloorPlan(polygon, opts){
    const cellM = opts?.cellM ?? FLOOR_PLAN_CELL_M;
    const cutoffHz = opts?.cutoffHz ?? MODE_CUTOFF_HZ;
    const grid = buildFloorGrid(polygon, cellM);
    const op = floorPlanOperator(grid);
    const lamMax = Math.pow(2 * Math.PI * cutoffHz / C, 2);
    // The grid's eigenvalues all sit a little low, so every true mode under
    // the cutoff is among those found; correct each, then keep the ones
    // still under it.
    const pairs = eigenpairsBelow(op, lamMax)
      .map(p => ({ lam: Math.max(0, p.lam) + gridDispersionShift(op, p.vec), vec: p.vec }))
      .filter(p => p.lam < lamMax)
      .sort((a, b) => a.lam - b.lam);
    const { xs, ys, nx, ny, cellId, numCells } = grid;
    const numModes = pairs.length, numWalls = polygon.length;
    const areaM2 = polygonArea(grid.pts);

    const kSquared = new Float64Array(numModes);
    const shapes = new Float32Array(numCells * numModes);
    for(let m = 0; m < numModes; m++){
      kSquared[m] = pairs[m].lam;
      const vec = pairs[m].vec;
      for(let k = 0; k < numCells; k++) shapes[k * numModes + m] = vec[k] * Math.sqrt(areaM2 / (op.hx[k] * op.hy[k]));
    }

    // Each wall is walked face by face. A shape's value on the wall comes
    // from the two cells in from that face, as the even parabola through
    // their centers (a rigid wall has zero slope across it); the nearest
    // cell's own value would be low by (k * cell)^2 / 8.
    const wallWeights = new Float64Array(numModes * numWalls);
    for(let e = 0; e < numWalls; e++){
      const a = grid.pts[e], b = grid.pts[(e + 1) % numWalls];
      const alongY = a.x === b.x;
      const lines = alongY ? ys : xs, from = Math.min(alongY ? a.y : a.x, alongY ? b.y : b.x), to = Math.max(alongY ? a.y : a.x, alongY ? b.y : b.x);
      const at = (alongY ? xs : ys).indexOf(alongY ? a.x : a.y); // the grid line the wall lies on
      for(let t = 0; t + 1 < lines.length; t++){
        if(lines[t] < from || lines[t + 1] > to) continue;
        const cellAt = (side) => {
          const i = alongY ? at + side : t, j = alongY ? t : at + side;
          return i >= 0 && i < nx && j >= 0 && j < ny ? cellId[j * nx + i] : -1;
        };
        const inward = cellAt(0) >= 0 ? 1 : -1; // exactly one side of a wall is inside the room
        const cell = cellAt(inward > 0 ? 0 : -1), next = cellAt(inward > 0 ? 1 : -2);
        const across = alongY ? xs : ys;
        const d1 = Math.abs((across[at + inward] - across[at]) / 2);
        const d2 = Math.abs(across[at + inward] - across[at]) + Math.abs((across[at + 2 * inward] - across[at + inward]) / 2);
        const c1 = next >= 0 ? d2 * d2 / (d2 * d2 - d1 * d1) : 1, c2 = next >= 0 ? -d1 * d1 / (d2 * d2 - d1 * d1) : 0;
        const faceLen = lines[t + 1] - lines[t];
        for(let m = 0; m < numModes; m++){
          const v = c1 * shapes[cell * numModes + m] + (next >= 0 ? c2 * shapes[next * numModes + m] : 0);
          wallWeights[m * numWalls + e] += v * v * faceLen;
        }
      }
    }

    return {
      polygon: polygon.map(p => ({ x: p.x, y: p.y })), cellM, cutoffHz,
      xs, ys, nx, ny, cellId, numCells, areaM2,
      numModes, kSquared, shapes, numWalls, wallWeights
    };
  }

  // Where to read a floor plan's mode shapes for a point (feet): up to four
  // cells and their weights, bilinear between the cell centers around the
  // point. Cells outside the room are left out and the rest reweighted, and
  // within half a cell of a wall the nearest centers are used as they are,
  // which matches a rigid wall (zero slope across it). A point outside the
  // room is first mirrored back in through the nearest point of the walls,
  // the same even reflection the rectangle's cosines give a point beyond a
  // wall (the spatial-averaging cloud of a seat near a wall reaches there).
  function floorPlanStencil(plan, xFt, yFt){
    if(!isPointInPolygon(xFt, yFt, plan.polygon)){
      let best = Infinity, qx = xFt, qy = yFt;
      const poly = plan.polygon;
      for(let i = 0, j = poly.length - 1; i < poly.length; j = i++){
        const a = poly[j], b = poly[i];
        const cx = Math.min(Math.max(xFt, Math.min(a.x, b.x)), Math.max(a.x, b.x));
        const cy = Math.min(Math.max(yFt, Math.min(a.y, b.y)), Math.max(a.y, b.y));
        const dist = (cx - xFt) * (cx - xFt) + (cy - yFt) * (cy - yFt);
        if(dist < best){ best = dist; qx = cx; qy = cy; }
      }
      const mx = 2 * qx - xFt, my = 2 * qy - yFt;
      if(isPointInPolygon(mx, my, poly)){ xFt = mx; yFt = my; } else { xFt = qx; yFt = qy; }
    }
    const { xs, ys, nx, ny, cellId } = plan;
    const bx = centerBracket(xs, nx, xFt * FT_TO_M), by = centerBracket(ys, ny, yFt * FT_TO_M);
    const cells = [], weights = [];
    let total = 0;
    for(let q = 0; q < 4; q++){
      const wx = q & 1 ? bx.t : 1 - bx.t, wy = q & 2 ? by.t : 1 - by.t;
      if(!(wx * wy > 0)) continue;
      const cell = cellId[(by.lower + (q >> 1)) * nx + bx.lower + (q & 1)];
      if(cell < 0) continue;
      cells.push(cell); weights.push(wx * wy);
      total += wx * wy;
    }
    for(let q = 0; q < weights.length; q++) weights[q] /= total;
    return { cells, weights };
  }
  // The pair of neighboring cell centers around v along one axis: `lower`
  // is the lower cell's index and t (0..1) how far v sits toward the next
  // center. Before the first center or past the last, t is 0. `cell` is
  // the index of the cell v is in.
  function centerBracket(lines, n, v){
    let lo = 0, hi = n - 1;
    while(lo < hi){ // the cell containing v
      const mid = (lo + hi + 1) >> 1;
      if(lines[mid] <= v) lo = mid; else hi = mid - 1;
    }
    const center = (i) => (lines[i] + lines[i + 1]) / 2;
    const lower = v < center(lo) ? lo - 1 : lo;
    if(lower < 0) return { lower: 0, t: 0, cell: lo };
    if(lower >= n - 1) return { lower: n - 1, t: 0, cell: lo };
    return { lower, t: (v - center(lower)) / (center(lower + 1) - center(lower)), cell: lo };
  }

  // The field of a precomputeModalField result for a solved floor plan, at
  // height pz (feet), at every cell center of the plan's grid:
  // [re0, im0, re1, im1, ...] by cell number. computeFieldAtPoint at any
  // point equals these values blended with floorPlanStencil's weights (the
  // sum is linear), so a map can blend four of them per pixel instead of
  // summing every mode. Each shape's height cosines are summed first.
  function floorPlanCellField(precomputed, pz){
    const { numModes, numCells, shapes } = precomputed.floorPlan;
    const pzM = pz * FT_TO_M;
    const shapeRe = new Float64Array(numModes), shapeIm = new Float64Array(numModes);
    for(const mode of precomputed){
      const cz = Math.cos(mode.invLz * pzM);
      shapeRe[mode.shape] += mode.coefRe * cz;
      shapeIm[mode.shape] += mode.coefIm * cz;
    }
    const out = new Float64Array(numCells * 2);
    for(let k = 0; k < numCells; k++){
      let re = 0, im = 0;
      for(let m = 0, base = k * numModes; m < numModes; m++){
        re += shapes[base + m] * shapeRe[m];
        im += shapes[base + m] * shapeIm[m];
      }
      out[2 * k] = re;
      out[2 * k + 1] = im;
    }
    return out;
  }
  // Every floor-plan mode's shape value at a point (feet).
  function floorPlanShapesAt(plan, xFt, yFt){
    const { cells, weights } = floorPlanStencil(plan, xFt, yFt);
    const { numModes, shapes } = plan;
    const out = new Float64Array(numModes);
    for(let q = 0; q < cells.length; q++){
      const base = cells[q] * numModes, wgt = weights[q];
      for(let m = 0; m < numModes; m++) out[m] += wgt * shapes[base + m];
    }
    return out;
  }

  // enumerateModes for a room with a solved floor plan (ctx.floorPlan):
  // every floor-plan mode times every height cosine that stays under the
  // cutoff. Each entry carries `shape` (the floor-plan mode's index into
  // the plan's tables) and nz in place of a rectangle mode's nx/ny/invLx/
  // invLy, and the returned array carries the plan itself as .floorPlan.
  // An and deltaN follow the same formulas as the rectangle's, with the
  // mode's own integrals: its volume integral is areaM2 * Lz / eps(nz)
  // (shapes have mean square 1), each wall's surface integral is that
  // wall's wallWeights entry times Lz / eps(nz), and the floor's and the
  // ceiling's are areaM2 each. Wall i's absorption is looked up as
  // ctx.wallMaterials[i].
  function enumerateFloorPlanModes(ctx, cutoffFreq){
    const plan = ctx.floorPlan;
    const Lz = ctx.room.h * FT_TO_M;
    const modes = [];
    modes.floorPlan = plan;
    if(!(Lz > 0)) return modes;
    const { numModes, numWalls, kSquared, wallWeights, areaM2 } = plan;
    const trapShapes = (ctx.bassTraps || []).map(t => floorPlanShapesAt(plan, t.x, t.y));
    for(let m = 0; m < numModes; m++){
      for(let nz = 0; ; nz++){
        const kz = nz * Math.PI / Lz;
        const kn = Math.sqrt(kSquared[m] + kz * kz);
        const fn = C * kn / (2 * Math.PI);
        if(fn > cutoffFreq) break;
        const epsZ = epsFactor(nz);
        let wallSum = 0;
        for(let i = 0; i < numWalls; i++) wallSum += surfaceAbsorptionAtFreq(i, fn, ctx) * wallWeights[m * numWalls + i];
        const deltaN = (wallSum / areaM2 + epsZ * (surfaceAbsorptionAtFreq('floor', fn, ctx) + surfaceAbsorptionAtFreq('ceil', fn, ctx)) / Lz) / 8
          + bassTrapDamping(ctx, fn, epsZ / (8 * areaM2 * Lz), (t, i) => trapShapes[i][m] ** 2 * heightCosSquaredMean(kz, t.heightFt * FT_TO_M));
        modes.push({ shape: m, nz, kn, fn, deltaN, An: C * C * epsZ / (areaM2 * Lz), invLz: kz });
      }
    }
    return modes;
  }

  // The resonance frequency (Hz) of each of a solved floor plan's modes
  // other than the uniform one, lowest first: the modes with no height
  // component, the floor plan's counterpart of a rectangle's width and
  // depth axial modes.
  function floorPlanModeFrequencies(plan){
    return Array.from(plan.kSquared.subarray(1), k2 => C * Math.sqrt(k2) / (2 * Math.PI));
  }

  // ---- Solving floor plans off the page's main thread ----
  // A full solve takes about 0.4 s for a typical L room and up to about
  // 2 s for the largest, so the page runs it in a Web Worker, first at the
  // preview cell size (about a third of the time, within a fraction of a dB
  // below 120 Hz) and then at full size, and keeps recent results.
  const FLOOR_PLAN_PREVIEW_CELL_M = 0.15;
  // Identifies a floor plan in the solver's cache.
  function floorPlanKey(polygon){
    return polygon.map(p => p.x + ',' + p.y).join(' ');
  }
  // What the worker does with each message the solver sends it
  // ({ key, polygon, cellM }): solve, and send back { key, cellM, plan }.
  function floorPlanWorkerReply(msg){
    return { key: msg.key, cellM: msg.cellM, plan: solveFloorPlan(msg.polygon, { cellM: msg.cellM }) };
  }
  // Keeps the floor plans the page asks for solved, one at a time in one
  // worker. options:
  //   startWorker: () => a Worker (or anything with postMessage, onmessage
  //     and terminate) that answers each message with floorPlanWorkerReply
  //   onSolved: () => void, called when a newer plan for the floor plan
  //     asked for most recently has arrived, or when its solve failed
  //     (the worker threw or died: see failed())
  //   cacheSize: how many floor plans to keep (default 6)
  // Only the floor plan asked for most recently is worked on: a full solve
  // of any other is stopped (the worker is replaced), and a preview of any
  // other finishes first, since it is short.
  function createFloorPlanSolver(options){
    const { startWorker, onSolved } = options;
    const cacheSize = options.cacheSize ?? 6;
    const cache = new Map(); // key -> { polygon, preview, full, waiters }, least recently asked first
    let worker = null, running = null, wanted = null;

    function entryFor(polygon){
      const key = floorPlanKey(polygon);
      let entry = cache.get(key);
      if(entry) cache.delete(key);
      else entry = { key, polygon: polygon.map(p => ({ x: p.x, y: p.y })), preview: null, full: null, waiters: [] };
      cache.set(key, entry);
      if(wanted && wanted !== key){
        // nobody needs the floor plan before this one any more
        const before = cache.get(wanted);
        if(before){ before.waiters.forEach(resolve => resolve(null)); before.waiters = []; }
      }
      wanted = key;
      for(const k of cache.keys()){
        if(cache.size <= cacheSize) break;
        if(k !== wanted && k !== running?.key) cache.delete(k);
      }
      work();
      return entry;
    }
    function work(){
      if(running){
        if(running.key === wanted || running.cellM === FLOOR_PLAN_PREVIEW_CELL_M) return;
        worker.terminate();
        worker = null;
        running = null;
      }
      const entry = cache.get(wanted);
      if(!entry || entry.full || entry.failed) return;
      if(!worker){
        worker = startWorker();
        worker.onmessage = (e) => received(e.data);
        worker.onerror = (e) => { if(e && e.preventDefault) e.preventDefault(); crashed(); };
      }
      running = { key: wanted, cellM: entry.preview ? FLOOR_PLAN_CELL_M : FLOOR_PLAN_PREVIEW_CELL_M };
      worker.postMessage({ key: wanted, polygon: entry.polygon, cellM: running.cellM });
    }
    function received({ key, cellM, plan }){
      running = null;
      const entry = cache.get(key);
      if(entry){
        if(cellM === FLOOR_PLAN_CELL_M){
          entry.full = plan;
          entry.waiters.forEach(resolve => resolve(plan));
          entry.waiters = [];
        } else entry.preview = plan;
      }
      work();
      if(entry && key === wanted && onSolved) onSolved();
    }
    // The running solve threw or the worker died: that floor plan is marked
    // failed (not tried again while it is kept), anyone waiting for it gets
    // null, and the next floor plan asked for starts a new worker.
    function crashed(){
      const key = running && running.key;
      running = null;
      if(worker){ worker.terminate(); worker = null; }
      const entry = key != null ? cache.get(key) : null;
      if(entry){
        entry.failed = true;
        entry.waiters.forEach(resolve => resolve(null));
        entry.waiters = [];
      }
      work();
      if(entry && key === wanted && onSolved) onSolved();
    }

    return {
      // The best plan solved so far for this floor plan (full size, else
      // the preview), or null while there is none yet. Makes it the floor
      // plan being worked on.
      planFor(polygon){
        const entry = entryFor(polygon);
        return entry.full || entry.preview;
      },
      // Resolves to the full-size plan, or to null if a different floor
      // plan is asked for before it is done.
      fullPlanFor(polygon){
        const entry = entryFor(polygon);
        return entry.full ? Promise.resolve(entry.full) : entry.failed ? Promise.resolve(null) : new Promise(resolve => entry.waiters.push(resolve));
      },
      // True when solving this floor plan failed (its preview may still be
      // there if only the full-size solve failed).
      failed(polygon){
        const entry = cache.get(floorPlanKey(polygon));
        return !!(entry && entry.failed);
      }
    };
  }

  // ---- Spherical spatial sampling (moving-mic-style measurement) ----
  // Deterministically distributes `n` points through a sphere of `radiusFt`
  // around (cx,cy,cz): a Fibonacci-lattice direction for even angular
  // coverage, scaled by a cube-root radius fraction so the points fill the
  // sphere's VOLUME with roughly uniform density (equal expected volume per
  // point) rather than clustering on the outer shell. Deterministic (no RNG)
  // so the same inputs always produce the same cloud -- a UI value shouldn't
  // flicker between otherwise-identical redraws.
  //
  // The radius fraction comes from the base-2 van der Corput sequence, not
  // from the same index fraction that sets the height. Sharing one variable
  // put every point above the center near it and every point below it far
  // out, so the cloud sat lower than its center.
  function vanDerCorput(i){
    let v = 0, f = 0.5;
    for(; i > 0; i >>= 1, f /= 2) if(i & 1) v += f;
    return v;
  }
  function sphereSamplePoints(cx, cy, cz, radiusFt, n){
    const points = [];
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for(let i = 0; i < n; i++){
      const t = (i + 0.5) / n;
      const zUnit = 1 - 2 * t; // -1..1, evenly stepped
      const rXY = Math.sqrt(Math.max(0, 1 - zUnit * zUnit));
      const theta = goldenAngle * i;
      const r = radiusFt * Math.cbrt(vanDerCorput(i + 1)); // cube-root spacing -> uniform volume density
      points.push({
        x: cx + r * rXY * Math.cos(theta),
        y: cy + r * rXY * Math.sin(theta),
        z: cz + r * zUnit
      });
    }
    return points;
  }

  // n frequencies from minHz to maxHz inclusive, evenly spaced on a log axis.
  function logSpacedFreqs(minHz, maxHz, n){
    const logMin = Math.log10(minHz), logMax = Math.log10(maxHz);
    const freqs = [];
    for(let i = 0; i < n; i++){
      const t = i / (n - 1);
      freqs.push(Math.pow(10, logMin + t * (logMax - logMin)));
    }
    return freqs;
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
  // The mode shapes at every sample point are worked out once and shared
  // by every frequency (see modeShapesAtPoint). A caller that averages at
  // the same centers again and again, with other sources each time, can
  // pass what does not change between its calls:
  //   opts.modes: the room's enumerateModes(ctx).
  //   opts.sampleShapes: centerSampleShapes(centers, modes, opts), one entry
  //     per center in the same order. It is the cloud, so opts.radiusFt and
  //     opts.numPoints are not read when it is given.
  function spatiallyAveragedResponseMulti(centers, freqs, sources, ctx, opts){
    const modes = opts?.modes || enumerateModes(ctx);
    const sampleShapes = opts?.sampleShapes || centerSampleShapes(centers, modes, opts);
    const perCenterDb = centers.map(() => []);
    for(const freq of freqs){
      const precomputed = precomputeModalField(sources, freq, ctx, modes);
      sampleShapes.forEach((samplePoints, i) => {
        let sumPower = 0;
        for(const shapes of samplePoints){
          const { re, im } = fieldFromModeShapes(shapes, precomputed);
          sumPower += re*re + im*im;
        }
        const avgPower = sumPower / samplePoints.length;
        perCenterDb[i].push(10 * Math.log10(Math.max(avgPower, 1e-12)));
      });
    }
    return { freqs, perCenterDb };
  }

  // modeShapesAtPoint at every point of the averaging cloud (opts.radiusFt,
  // opts.numPoints, as spatiallyAveragedResponseMulti) round each center:
  // [center][samplePoint] = shapes.
  function centerSampleShapes(centers, modes, opts){
    const radiusFt = opts?.radiusFt ?? 2;
    const numPoints = opts?.numPoints ?? 20;
    return centers.map(c => sphereSamplePoints(c.x, c.y, c.z, radiusFt, numPoints).map(p => modeShapesAtPoint(p.x, p.y, p.z, modes)));
  }

  // ---- Shortest path inside a floor plan ----
  // True when the straight segment from a to b stays on the floor (inside
  // the polygon or along a wall). The segment is cut wherever it meets a
  // wall's line within that wall, and the middle of each piece is tested.
  function floorPlanSegmentClear(a, b, polygon){
    const ts = [0, 1], dx = b.x - a.x, dy = b.y - a.y, eps = 1e-9;
    floorPlanWalls(polygon).forEach(({ a: p, b: q, horizontal }) => {
      const [d, from, at, lo, hi, other, otherFrom] = horizontal
        ? [dy, a.y, p.y, Math.min(p.x, q.x), Math.max(p.x, q.x), dx, a.x]
        : [dx, a.x, p.x, Math.min(p.y, q.y), Math.max(p.y, q.y), dy, a.y];
      if(Math.abs(d) < eps) return;
      const t = (at - from) / d, along = otherFrom + other * t;
      if(t > 0 && t < 1 && along >= lo - eps && along <= hi + eps) ts.push(t);
    });
    ts.sort((u, v) => u - v);
    for(let k = 1; k < ts.length; k++){
      if(ts[k] - ts[k - 1] < eps) continue;
      const t = (ts[k] + ts[k - 1]) / 2, x = a.x + dx * t, y = a.y + dy * t;
      if(!isPointInPolygon(x, y, polygon) && floorPlanClearance(x, y, polygon) > 1e-6) return false;
    }
    return true;
  }
  // Length in feet of the shortest path from a to b ({x, y} in feet) that
  // stays inside `polygon`: the straight line when nothing is in the way,
  // otherwise the path that bends round the room's inside corners (the
  // only places a shortest path inside a polygon bends), found with
  // Dijkstra over the corners each point can see.
  function floorPlanPathLength(a, b, polygon){
    if(floorPlanSegmentClear(a, b, polygon)) return Math.hypot(b.x - a.x, b.y - a.y);
    const nodes = [a].concat(polygon.filter((_, i) => !isConvexCorner(polygon, i)), [b]);
    const dist = nodes.map((_, i) => i === 0 ? 0 : Infinity), done = nodes.map(() => false);
    for(;;){
      let i = -1;
      dist.forEach((d, k) => { if(!done[k] && d < Infinity && (i < 0 || d < dist[i])) i = k; });
      if(i < 0) return Infinity;
      if(i === nodes.length - 1) return dist[i];
      done[i] = true;
      nodes.forEach((n, k) => {
        if(done[k] || !floorPlanSegmentClear(nodes[i], n, polygon)) return;
        dist[k] = Math.min(dist[k], dist[i] + Math.hypot(n.x - nodes[i].x, n.y - nodes[i].y));
      });
    }
  }
  // Distance in feet that sound travels from a source to a listener ({x,
  // y, z} in feet): the straight line, or in a room with room.polygon the
  // shortest path round any inside corner in the way. The walls are
  // vertical, so the height difference adds to that path as it does to a
  // straight line (the path unfolds flat).
  function soundPathFt(source, listener, room){
    const dz = (source.z ?? 0) - (listener.z ?? 0);
    const flat = room && room.polygon ? floorPlanPathLength(source, listener, room.polygon) : Math.hypot(source.x - listener.x, source.y - listener.y);
    return Math.hypot(flat, dz);
  }

  // ---- Time alignment: delay each source so all arrive at a point together ----
  // Real speaker/sub distances from the listener differ, so their direct
  // sound arrives at different times -- AVR "speaker distance" settings (or
  // any DSP-based delay line) exist specifically to compensate for this.
  // Delay can only push a signal later, never earlier, so every source is
  // delayed relative to whichever one is FARTHEST away (that one gets 0 --
  // it's already the latest natural arrival, nothing to align it to).
  // sources: array of {id, x, y, z}. listener: {x, y, z}. Returns
  // [{id, delayMs}, ...], one entry per input source, in order. With
  // `stepMs`, each delay is rounded to that step (TIME_ALIGN_STEP_MS is the
  // app's delay resolution). With a `room` that has room.polygon, each
  // distance is the path round any inside corner in the way (soundPathFt),
  // as an AVR's auto-setup microphone would measure it.
  const TIME_ALIGN_STEP_MS = 0.1;
  function timeAlignDelays(sources, listener, stepMs, room){
    const distM = sources.map(s => soundPathFt(s, listener, room) * FT_TO_M);
    const maxDist = distM.length ? Math.max(...distM) : 0;
    const perMs = stepMs ? 1 / stepMs : 0; // steps per ms: 10 for the 0.1 ms step, so rounded values stay clean decimals
    return sources.map((s, i) => {
      const delayMs = (maxDist - distM[i]) / C * 1000;
      return { id: s.id, delayMs: perMs ? Math.round(delayMs * perMs) / perMs : delayMs };
    });
  }
  // Copies of `sources`, each with the delay automatic time alignment to
  // `listener` gives it, at the app's delay resolution (see timeAlignDelays
  // for `room`).
  function timeAlignedSources(sources, listener, room){
    const delays = timeAlignDelays(sources, listener, TIME_ALIGN_STEP_MS, room);
    return sources.map((s, i) => Object.assign({}, s, { delayMs: delays[i].delayMs }));
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
  // Every seat of every row (rows in rank order, index 0 first), each with
  // its row's rank, its offsetIndex and its row's seat count, and the weight
  // the optimizer and the result card give it (rowRankWeight times
  // seatCenterWeight).
  function seatPositions(rows){
    const out = [];
    rows.forEach((row, rank) => {
      const seats = rowSeatPositions(row);
      for(const seat of seats){
        out.push({
          x: seat.x, y: seat.y, z: seat.z, rank, offsetIndex: seat.offsetIndex, rowSeatCount: seats.length,
          weight: rowRankWeight(rank) * seatCenterWeight(seat.offsetIndex, seats.length)
        });
      }
    });
    return out;
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
  // ctx: { wallAbsorption, floorAbsorption, wallMaterials, ceilingMaterial, bassTraps }
  // (bass traps count as corner traps, see BASS_TRAP_CORNER_COUPLING)
  // -- a subset of enumerateModes' ctx shape is fine; only these fields are read.
  // A room with room.polygon (see solveFloorPlan) uses the polygon's own
  // floor area and one wall per polygon edge, wall i's material being
  // wallMaterials[i].
  function roomFloorAreaFt2(room){
    return room.polygon ? polygonArea(room.polygon) : room.w * room.d;
  }
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
    const floorArea = roomFloorAreaFt2(room);
    const walls = room.polygon
      ? room.polygon.map((p, i) => {
          const q = room.polygon[(i + 1) % room.polygon.length];
          return { area: Math.hypot(q.x - p.x, q.y - p.y) * h, absorption: wallAbsorptionFor(i) };
        })
      : [
          { area: d*h, absorption: wallAbsorptionFor('left') },
          { area: d*h, absorption: wallAbsorptionFor('right') },
          { area: w*h, absorption: wallAbsorptionFor('front') },
          { area: w*h, absorption: wallAbsorptionFor('back') }
        ];
    const surfaces = walls.concat([
      { area: floorArea, absorption: floorAbsorption },
      { area: floorArea, absorption: ceilingAbsorption }
    ]);
    let totalAbsorptionFt2 = 0;
    let totalAreaFt2 = 0;
    for(const s of surfaces){
      totalAbsorptionFt2 += s.area * s.absorption;
      totalAreaFt2 += s.area;
    }
    const totalAreaM2 = totalAreaFt2 * (FT_TO_M ** 2);
    let totalAbsorptionM2 = totalAbsorptionFt2 * (FT_TO_M ** 2);
    for(const t of ctx.bassTraps || []) totalAbsorptionM2 += BASS_TRAP_CORNER_COUPLING * bassTrapAbsorptionM2(t.type, freqForAbsorption, t.heightFt);
    const volumeM3 = (floorArea * h) * (FT_TO_M ** 3);
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
    const volumeM3 = (roomFloorAreaFt2(room) * room.h) * (FT_TO_M ** 3);
    if(volumeM3 <= 0) return 0;
    return 2000 * Math.sqrt(t60 / volumeM3);
  }
  // The room's highest Schroeder frequency over 20 to 300 Hz (24 evenly
  // spaced samples), using the T60 estimatedT60 gives at each. Materials
  // absorb differently with frequency, so this is the worst case, a stable
  // bound that does not move with whichever frequency is being viewed.
  function maxSchroederFrequency(ctx){
    const SEARCH_MIN_HZ = 20, SEARCH_MAX_HZ = 300, SEARCH_POINTS = 24;
    let maxFs = 0;
    for(let i = 0; i < SEARCH_POINTS; i++){
      const f = SEARCH_MIN_HZ + (SEARCH_MAX_HZ - SEARCH_MIN_HZ) * i / (SEARCH_POINTS - 1);
      const fs = schroederFrequency(ctx.room, estimatedT60(ctx.room, f, ctx));
      if(fs > maxFs) maxFs = fs;
    }
    return maxFs;
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
  // precomputedModes (optional): enumerateModes(physicsCtx) only
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
  // seatAveraging ({ radiusFt, numPoints }, optional): each listener's
  // response is the spatial average over that cloud around it, as
  // measureAtSeats does with SEAT_AVERAGING, instead of the level at the
  // single point. A null at one point is often only inches wide, so a
  // single-point score can rank a position by a null the averaged measure
  // barely sees, and miss one it does. With SEAT_AVERAGING and the result
  // card's own frequencies as freqList, the responses scored are the ones
  // the card grades, so a search ranks positions the way its result will
  // be judged: the score is gradePlacement's stats.score, less the
  // nullAvoidance spread penalty below when other subs are near (and
  // scanGridCandidates adds its preferred-zone bonus on top). seatAveraging
  // may also carry spatiallyAveragedResponseMulti's sampleShapes for the
  // listeners.
  function scoreSubPosition(candidatePos, otherSources, room, freqList, listenerPositions, physicsCtx, mode, alreadyPlaced, precomputedModes, seatAveraging){
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
    const perListenerDb = seatAveraging
      ? spatiallyAveragedResponseMulti(listenerPositions, freqList, allSources, physicsCtx, Object.assign({ modes }, seatAveraging)).perCenterDb
      : listenerPositions.map(() => []); // [listenerIdx][freqIdx] = dB
    if(!seatAveraging) for(const f of freqList){
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
  // ---- Measuring a placement at the seats ----
  // How the frequency response chart and the result card measure: a
  // spatially averaged response (a 2 ft cloud of 20 points) at every seat
  // and at one reference point, the top row's own center, which is not
  // always a seat.
  const SEAT_AVERAGING = { radiusFt: 2, numPoints: 20 };
  // seats: from seatPositions. reference: {x, y, z}. Returns perSeatDb
  // [seat][freqIndex], referenceDb [freqIndex], and the quietest and loudest
  // seat at each frequency (seatMinDb, seatMaxDb).
  function measureAtSeats(seats, reference, freqs, sources, ctx){
    const { perCenterDb } = spatiallyAveragedResponseMulti(seats.concat([reference]), freqs, sources, ctx, SEAT_AVERAGING);
    const perSeatDb = perCenterDb.slice(0, seats.length);
    return {
      perSeatDb,
      referenceDb: perCenterDb[seats.length],
      seatMinDb: freqs.map((_, j) => Math.min(...perSeatDb.map(row => row[j]))),
      seatMaxDb: freqs.map((_, j) => Math.max(...perSeatDb.map(row => row[j])))
    };
  }
  // A placement graded the way the result card shows it: the reference
  // response (db), the weighted scoreResponses stats over every seat, and the
  // seat-to-seat variation.
  function gradePlacement(seats, reference, freqs, sources, ctx, mode){
    const m = measureAtSeats(seats, reference, freqs, sources, ctx);
    return {
      db: m.referenceDb,
      stats: scoreResponses(m.perSeatDb, seats.map(s => s.weight ?? 1), mode),
      seatToSeatDb: seatToSeatVariationDb(m.perSeatDb)
    };
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
  // Whether refined positions for existing subs are worth suggesting, judged
  // the way the result card grades them (gradePlacement over `freqs`).
  // `current` and `picked`
  // are the same subs in the same order, now and as the search placed them;
  // `otherSources` are the rest of the active sources. The current placement
  // is graded as it stands; the picked one with every source time-aligned to
  // `timeAlignTo` when given, since applying it re-runs automatic time
  // alignment. Returns { placedSubs, moved, gainDb }: the picked subs when
  // they grade at least PLACEMENT_GAIN_DB.modest higher, since a smaller
  // gain is what the card calls "Little to gain" and is not worth moving a
  // sub for; otherwise copies of `current` with every moved[i] false.
  // gainDb is null when the search moved nothing.
  function checkSubMoves(options){
    const { seats, reference, freqs, otherSources, current, picked, physicsCtx, mode, timeAlignTo } = options;
    const keep = (gainDb) => ({ placedSubs: current.map(s => Object.assign({}, s)), moved: current.map(() => false), gainDb });
    if(picked.every((p, i) => p.x === current[i].x && p.y === current[i].y && p.z === current[i].z)) return keep(null);
    let after = otherSources.concat(picked);
    if(timeAlignTo && after.length >= 2) after = timeAlignedSources(after, timeAlignTo, physicsCtx.room);
    const grade = (sources) => gradePlacement(seats, reference, freqs, sources, physicsCtx, mode).stats;
    const { gainDb } = comparePlacements(grade(otherSources.concat(current)), grade(after));
    if(gainDb < PLACEMENT_GAIN_DB.modest) return keep(gainDb);
    return { placedSubs: picked.map(p => Object.assign({}, p)), moved: picked.map((p, i) => p.x !== current[i].x || p.y !== current[i].y || p.z !== current[i].z), gainDb };
  }
  // The four walls straight to a point's left, right, front and back, each
  // with the distance to it and where it is: { left: { wall: 'left',
  // distFt, x }, right: { wall: 'right', distFt, x }, front: { wall:
  // 'front', distFt, y }, back: { wall: 'back', distFt, y } }. The front
  // wall is y = 0 and the left wall x = 0. In a room with room.polygon,
  // each is the first wall met going straight that way, so in an L room a
  // notch's wall counts where it is the nearer that way; each also gives
  // `index`, that wall's number in room.polygon.
  function wallsAround(pos, room){
    let left = 0, right = room.w, front = 0, back = room.d;
    const at = {}; // the polygon wall each of the four came from
    if(room.polygon){
      left = front = -Infinity; right = back = Infinity;
      floorPlanWalls(room.polygon).forEach((wall, i) => {
        const { a, b } = wall;
        if(wall.horizontal){
          if(pos.x < Math.min(a.x, b.x) || pos.x > Math.max(a.x, b.x)) return;
          if(a.y <= pos.y && a.y > front){ front = a.y; at.front = i; }
          if(a.y >= pos.y && a.y < back){ back = a.y; at.back = i; }
        } else {
          if(pos.y < Math.min(a.y, b.y) || pos.y > Math.max(a.y, b.y)) return;
          if(a.x <= pos.x && a.x > left){ left = a.x; at.left = i; }
          if(a.x >= pos.x && a.x < right){ right = a.x; at.right = i; }
        }
      });
    }
    const which = (wall, entry) => room.polygon ? { ...entry, index: at[wall] } : entry;
    return {
      left: which('left', { wall: 'left', distFt: pos.x - left, x: left }),
      right: which('right', { wall: 'right', distFt: right - pos.x, x: right }),
      front: which('front', { wall: 'front', distFt: pos.y - front, y: front }),
      back: which('back', { wall: 'back', distFt: back - pos.y, y: back })
    };
  }
  // The nearer side wall and the nearer end wall to a point (see
  // wallsAround): { side: the left or right entry, end: the front or back
  // entry }. A point exactly midway reports left and front.
  function nearestWallDistances(pos, room){
    const w = wallsAround(pos, room);
    return {
      side: w.left.distFt <= w.right.distFt ? w.left : w.right,
      end: w.front.distFt <= w.back.distFt ? w.front : w.back
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
  // the line from the listener at the channel's azimuth, at the first point
  // on that line `insetFt` (default 1.5) from a wall (floorPlanClearance),
  // which in a rectangle is where it reaches a rectangle inset that far.
  // A seat closer to a wall than the inset is first moved to the nearest
  // point that is not (clampToFloorPlan). Returns [{ name, x, y }] in the
  // order given; names with no entry in SPEAKER_AZIMUTH_DEG are skipped.
  function standardSpeakerPositions(room, listener, names, insetFt){
    const inset = insetFt ?? 1.5;
    const { x: lx, y: ly } = clampToFloorPlan(listener.x, listener.y, room, inset);
    // Each wall's no-go box: the wall grown by the inset on every side.
    const boxes = floorPlanWalls(floorPlanOf(room)).map(({ a, b }) => ({
      x0: Math.min(a.x, b.x) - inset, x1: Math.max(a.x, b.x) + inset,
      y0: Math.min(a.y, b.y) - inset, y1: Math.max(a.y, b.y) + inset
    }));
    // The interval of t over which lx + d*t lies between lo and hi. A ray
    // parallel to the slab that runs along its edge (l exactly lo or hi,
    // as for a seat moved onto a wall's inset line) does not count as
    // inside it, so it only grazes that wall's box.
    const slab = (l, d, lo, hi) => d > 0 ? [(lo - l) / d, (hi - l) / d] : d < 0 ? [(hi - l) / d, (lo - l) / d] : (l > lo && l < hi ? [-Infinity, Infinity] : [Infinity, -Infinity]);
    const positions = [];
    for(const name of names){
      if(!(name in SPEAKER_AZIMUTH_DEG)) continue;
      const az = SPEAKER_AZIMUTH_DEG[name] * Math.PI / 180;
      const dx = Math.sin(az), dy = -Math.cos(az);
      // distance along the ray to the first no-go box it enters
      let t = Infinity;
      for(const box of boxes){
        const [ax, bx] = slab(lx, dx, box.x0, box.x1), [ay, by] = slab(ly, dy, box.y0, box.y1);
        const enter = Math.max(ax, ay), exit = Math.min(bx, by);
        if(exit > enter && exit > 0) t = Math.min(t, Math.max(0, enter));
      }
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
  // A room with room.polygon counts only the floor inside it: the polygon's
  // corners are added to the cell edges, and a cell outside it is skipped.
  function freeFloorFraction(room, zones){
    const rects = [];
    for(const z of zones){
      const x0 = Math.max(0, z.x), x1 = Math.min(room.w, z.x + z.width);
      const y0 = Math.max(0, z.y), y1 = Math.min(room.d, z.y + z.height);
      if(x1 > x0 && y1 > y0) rects.push({ x0, x1, y0, y1 });
    }
    const poly = room.polygon || [];
    const xs = [...new Set(rects.flatMap(r => [r.x0, r.x1]).concat(poly.map(p => p.x)))].sort((a, b) => a - b);
    const ys = [...new Set(rects.flatMap(r => [r.y0, r.y1]).concat(poly.map(p => p.y)))].sort((a, b) => a - b);
    let covered = 0;
    for(let i = 0; i < xs.length - 1; i++){
      for(let j = 0; j < ys.length - 1; j++){
        const cx = (xs[i] + xs[i+1]) / 2, cy = (ys[j] + ys[j+1]) / 2;
        if(room.polygon && !isPointInPolygon(cx, cy, room.polygon)) continue;
        if(rects.some(r => cx > r.x0 && cx < r.x1 && cy > r.y0 && cy < r.y1)){
          covered += (xs[i+1] - xs[i]) * (ys[j+1] - ys[j]);
        }
      }
    }
    return 1 - covered / roomFloorAreaFt2(room);
  }

  // `rect` ({ x, y, width, height }) cut down to the part of it inside the
  // room's overall width and depth, or null when none of it is on the floor
  // (in a room with room.polygon, also when it lies wholly in a cut-out).
  function clipRectToRoom(rect, room){
    const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y);
    const x1 = Math.min(room.w, rect.x + rect.width), y1 = Math.min(room.d, rect.y + rect.height);
    if(!(x1 > x0 && y1 > y0)) return null;
    const clipped = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    return room.polygon && freeFloorFraction(room, [clipped]) > 1 - 1e-9 ? null : clipped;
  }

  // In a room with room.polygon, a candidate must also be inside the
  // polygon and not on one of its walls.
  function isCandidateValid(px, py, room, offLimitZones, allowedZones, excludePoints, minSeparationFt){
    if(px < 0 || px > room.w || py < 0 || py > room.d) return false;
    if(room.polygon && !(isPointInPolygon(px, py, room.polygon) && floorPlanClearance(px, py, room.polygon) > 0)) return false;
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
    //
    // A point that carries its own `keepOut` rectangle (a main speaker, see
    // sourceExclusionPoints) blocks the inside of that rectangle instead of
    // the minSeparationFt square.
    for(const p of (excludePoints || [])){
      const r = p.keepOut;
      if(r){
        if(px > r.x && px < r.x + r.width && py > r.y && py < r.y + r.height) return false;
      } else if(minSeparationFt > 0 && Math.abs(px - p.x) < minSeparationFt && Math.abs(py - p.y) < minSeparationFt){
        return false;
      }
    }
    return true;
  }

  // A source counts as a sub when its passband tops out at or below 150 Hz.
  function isSubSource(source){ return source.freqHigh <= 150; }

  // What a sub search has to keep clear of each existing source. A sub keeps
  // the search's full sub-to-sub separation (a plain { x, y } point, which
  // also counts toward nullAvoidance's spread penalty). A main speaker
  // blocks its keepOut rectangle (speakerKeepOut) instead, with no spread
  // penalty, since a sub beside a speaker is an ordinary placement.
  function sourceExclusionPoints(sources, room){
    return sources.map(s => isSubSource(s) ? { x: s.x, y: s.y } : { x: s.x, y: s.y, keepOut: speakerKeepOut(s, room) });
  }
  // The floor a main speaker takes from a sub search: SPEAKER_CLEARANCE_FT
  // on each side of it (a 2 ft wide box), stretched back to the wall nearest
  // it, since the gap between a speaker and its wall has no room for a sub.
  // A rect { x, y, width, height }.
  const SPEAKER_CLEARANCE_FT = 1;
  function speakerKeepOut(s, room){
    const c = SPEAKER_CLEARANCE_FT;
    let x0 = s.x - c, x1 = s.x + c, y0 = s.y - c, y1 = s.y + c;
    const { side, end } = nearestWallDistances(s, room);
    const wall = side.distFt <= end.distFt ? side.wall : end.wall;
    if(wall === 'left') x0 = side.x;
    else if(wall === 'right') x1 = side.x;
    else if(wall === 'front') y0 = end.y;
    else y1 = end.y;
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  // The sub a search places when it is adding a new one. Candidates are
  // scored as this source, so the search measures the sub that is then added.
  const NEW_SUB_DEFAULTS = { levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80, enabled: true };

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
  //
  // Two options make a candidate score as the sub that will really stand
  // there, both optional:
  //   candidateTemplate: source fields (levelDb, delayMs, freqLow, freqHigh,
  //     rolloffDbPerOct) the candidate takes; without it, it is
  //     scoreSubPosition's generic full-range source.
  //   timeAlignTo: a listener point {x,y,z}. When given, every source
  //     (the candidate included) gets the delay automatic time alignment to
  //     that point would give it with the candidate in place, recomputed
  //     per candidate, instead of the delays the sources came in with.
  // seatAveraging: see scoreSubPosition.
  function* scanGridCandidates(options){
    const {
      room, otherSources, freqList, listenerPositions, physicsCtx,
      offLimitZones, allowedZones, preferredZones, gridStepFt, subHeightFt, excludePoints, minSeparationFt, mode, precomputedModes,
      candidateTemplate, timeAlignTo, seatAveraging
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
    // Only other subs count toward nullAvoidance's spread penalty; a point
    // with its own keepOut is a main speaker (see sourceExclusionPoints).
    const spreadPoints = (excludePoints || []).filter(p => !p.keepOut);
    // The listeners' averaging clouds are the same for every candidate.
    const averaging = seatAveraging && Object.assign({}, seatAveraging, { sampleShapes: centerSampleShapes(listenerPositions, modes, seatAveraging) });

    for(let x = step/2; x < room.w; x += step){
      for(let y = step/2; y < room.d; y += step){
        if(!isCandidateValid(x, y, room, offLimitZones, allowedZones, excludePoints, minSeparationFt)){
          yield null;
          continue;
        }
        let candidate = Object.assign({}, candidateTemplate, { x, y, z });
        let others = otherSources;
        if(timeAlignTo){
          others = timeAlignedSources(otherSources.concat([candidate]), timeAlignTo, room);
          candidate = others.pop();
        }
        const eval_ = scoreSubPosition(candidate, others, room, freqList, listenerPositions, physicsCtx, mode, spreadPoints, modes, averaging);
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
  // it can never drift from the actual candidate count. With `onFloorOnly`,
  // only the cells on the floor (inside the walls of an L, T or U room, not
  // in its bounding box's cut-outs) are counted.
  function countGridCells(room, gridStepFt, onFloorOnly){
    const step = gridStepFt || 0.5;
    let n = 0;
    for(let x = step/2; x < room.w; x += step){
      for(let y = step/2; y < room.d; y += step){
        if(!onFloorOnly || isCandidateValid(x, y, room)) n++;
      }
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
  //   onYield: () => Promise: awaited every yieldEvery scanned cells, or
  //     without yieldEvery about every YIELD_INTERVAL_MS of scanning, since
  //     how long a cell takes varies widely with the seats, the frequencies
  //     and seatAveraging. Timed with performance.now(), which never runs
  //     backwards as the system clock can.
  //   onProgress: (fraction) => void -- called with 0 before scanning starts, then
  //                                      scanned/totalGridCells at each yield point
  //   yieldEvery: number: chunk size in cells
  const YIELD_INTERVAL_MS = 50;
  async function optimizeSubPlacementAsync(options){
    const { onYield, onProgress, yieldEvery } = options;
    const totalGridCells = countGridCells(options.room, options.gridStepFt);
    if(onProgress) onProgress(0);
    if(onYield) await onYield();

    const results = [];
    let best = null;
    let scanned = 0, lastYield = performance.now();
    for(const entry of scanGridCandidates(options)){
      scanned++;
      if(entry !== null){
        results.push(entry);
        if(best === null || entry.score > best.score) best = entry;
      }
      if(yieldEvery ? scanned % yieldEvery === 0 : performance.now() - lastYield >= YIELD_INTERVAL_MS){
        if(onProgress) onProgress(scanned / totalGridCells);
        if(onYield) await onYield();
        lastYield = performance.now();
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
      offLimitZones, allowedZones, preferredZones, gridStepFt, subHeightFt, minSeparationFt, mode, timeAlignTo, seatAveraging
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
    // existing source's exact position, since isCandidateValid only ever
    // excludes points already in this list. An existing sub keeps the full
    // separation; a main speaker only its keepOut rectangle (see
    // sourceExclusionPoints).
    const placedPositions = sourceExclusionPoints(otherSources, room);
    const roundResults = []; // one optimizeSubPlacement result per sub placed, for diagnostics/visualization
    let currentOtherSources = otherSources.slice();

    for(let i = 0; i < numSubs; i++){
      const roundResult = optimizeSubPlacement({
        room, otherSources: currentOtherSources, freqList, listenerPositions,
        physicsCtx, offLimitZones, allowedZones, preferredZones, gridStepFt, subHeightFt,
        excludePoints: placedPositions, minSeparationFt: separation, mode,
        candidateTemplate: NEW_SUB_DEFAULTS, timeAlignTo, seatAveraging
      });
      roundResults.push(roundResult);
      if(roundResult.best === null){
        // No valid candidate left (e.g. zones fully exhausted, or every remaining
        // spot is too close to an already-placed sub) — stop rather than erroring;
        // return what was successfully placed so far.
        break;
      }
      const placedSub = Object.assign(
        { name: `Sub ${i+1}` }, NEW_SUB_DEFAULTS,
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
      offLimitZones, allowedZones, preferredZones, gridStepFt, subHeightFt, minSeparationFt: separation, mode, timeAlignTo, seatAveraging
    });

    return { placedSubs: polish.placedSubs, roundResults, polishResults: polish.polishResults };
  }

  // Two subs are interchangeable when everything the physics reads apart from
  // their position matches, so trading places leaves the room sounding
  // exactly the same. Delay only counts when time alignment will not
  // re-derive it.
  function subSwapKey(s, timeAligned){
    return JSON.stringify([s.levelDb ?? 0, s.freqLow, s.freqHigh, s.rolloffDbPerOct ?? 24, s.z ?? 3, timeAligned ? 0 : (s.delayMs ?? 0)]);
  }

  // Given subs at their current positions (`subs`) and the positions a search
  // picked for them (`placed`, same order), hands the picked positions out
  // among interchangeable subs (see subSwapKey) so the total distance moved
  // is as small as possible: a search that refines one sub at a time can
  // send a far sub to the spot right next to another. The layout the room
  // hears is unchanged, and a sub that differs from the rest keeps the spot
  // picked for it. Tries every order within a group, which is fine for the
  // handful of subs a room holds. Returns copies of `placed`.
  function assignNearestSpots(subs, placed, timeAligned){
    const result = placed.map(p => Object.assign({}, p));
    const groups = new Map();
    subs.forEach((s, i) => {
      const key = subSwapKey(s, timeAligned);
      if(!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    });
    const orders = (items) => items.length <= 1 ? [items]
      : items.flatMap((item, i) => orders(items.slice(0, i).concat(items.slice(i + 1))).map(rest => [item].concat(rest)));
    for(const group of groups.values()){
      if(group.length < 2) continue;
      let bestOrder = group, bestDist = Infinity;
      for(const order of orders(group)){
        const dist = group.reduce((sum, i, j) => sum + Math.hypot(placed[order[j]].x - subs[i].x, placed[order[j]].y - subs[i].y), 0);
        if(dist < bestDist - 1e-9){ bestDist = dist; bestOrder = order; }
      }
      group.forEach((i, j) => { result[i].x = placed[bestOrder[j]].x; result[i].y = placed[bestOrder[j]].y; });
    }
    return result;
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
  // subs[i]'s position actually changed. The final positions are handed out
  // with assignNearestSpots, so each sub travels to the nearest of the
  // picked spots it could equally take.
  function polishSubPlacements(options){
    const {
      room, otherSources, subs, freqList, listenerPositions, physicsCtx,
      offLimitZones, allowedZones, preferredZones, gridStepFt, subHeightFt, minSeparationFt, mode, timeAlignTo, seatAveraging
    } = options;
    const separation = Math.max(3, minSeparationFt ?? Math.max(4, Math.min(room.w, room.d) * 0.25));
    const placedSubs = subs.map(s => Object.assign({}, s));
    const polishResults = [];
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
          const excludePoints = sourceExclusionPoints(others, room);
          // Scored as this sub itself (its own level and passband), so a
          // refined position is judged for the sub that will stand there.
          const roundResult = optimizeSubPlacement({
            room, otherSources: others, freqList, listenerPositions,
            physicsCtx, offLimitZones, allowedZones, preferredZones, gridStepFt,
            subHeightFt: subHeightFt ?? placedSubs[k].z,
            excludePoints, minSeparationFt: separation, mode,
            candidateTemplate: placedSubs[k], timeAlignTo, seatAveraging
          });
          polishResults.push(roundResult);
          if(roundResult.best === null) continue; // no valid candidate; leave this sub where it is
          if(roundResult.best.x !== placedSubs[k].x || roundResult.best.y !== placedSubs[k].y){
            anyMoved = true;
          }
          placedSubs[k].x = roundResult.best.x;
          placedSubs[k].y = roundResult.best.y;
          placedSubs[k].z = roundResult.best.z;
        }
        if(!anyMoved) break; // converged; every later pass would be identical
      }
    }
    return finishPolish(subs, placedSubs, polishResults, timeAlignTo);
  }

  function finishPolish(subs, placedSubs, polishResults, timeAlignTo){
    const assigned = assignNearestSpots(subs, placedSubs, !!timeAlignTo);
    const moved = assigned.map((p, i) => p.x !== subs[i].x || p.y !== subs[i].y);
    return { placedSubs: assigned, polishResults, moved };
  }

  // Async/chunked twin of polishSubPlacements, for the same reason
  // optimizeSubPlacementAsync exists. onProgress is called as
  // (fraction, k, 'polish') -- k is the index into `subs` currently being
  // re-optimized, matching the polish-phase signal optimizeMultipleSubsAsync
  // already uses internally.
  async function polishSubPlacementsAsync(options){
    const {
      room, otherSources, subs, freqList, listenerPositions, physicsCtx,
      offLimitZones, allowedZones, preferredZones, gridStepFt, subHeightFt, minSeparationFt, mode, timeAlignTo, seatAveraging,
      onYield, onProgress, yieldEvery, precomputedModes
    } = options;
    const separation = Math.max(3, minSeparationFt ?? Math.max(4, Math.min(room.w, room.d) * 0.25));
    const modes = precomputedModes || enumerateModes(physicsCtx);
    const placedSubs = subs.map(s => Object.assign({}, s));
    const polishResults = [];
    if(placedSubs.length >= 2){
      for(let pass = 0; pass < POLISH_PASSES; pass++){
        let anyMoved = false;
        for(let k = 0; k < placedSubs.length; k++){
          const others = otherSources.concat(placedSubs.filter((_, idx) => idx !== k));
          const excludePoints = sourceExclusionPoints(others, room);
          const roundResult = await optimizeSubPlacementAsync({
            room, otherSources: others, freqList, listenerPositions,
            physicsCtx, offLimitZones, allowedZones, preferredZones, gridStepFt,
            subHeightFt: subHeightFt ?? placedSubs[k].z,
            excludePoints, minSeparationFt: separation, mode,
            candidateTemplate: placedSubs[k], timeAlignTo, seatAveraging,
            precomputedModes: modes, onYield, yieldEvery,
            onProgress: onProgress ? (fraction) => onProgress(fraction, k, 'polish') : undefined
          });
          polishResults.push(roundResult);
          if(roundResult.best === null) continue;
          if(roundResult.best.x !== placedSubs[k].x || roundResult.best.y !== placedSubs[k].y){
            anyMoved = true;
          }
          placedSubs[k].x = roundResult.best.x;
          placedSubs[k].y = roundResult.best.y;
          placedSubs[k].z = roundResult.best.z;
        }
        if(!anyMoved) break;
      }
    }
    return finishPolish(subs, placedSubs, polishResults, timeAlignTo);
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
      offLimitZones, allowedZones, preferredZones, gridStepFt, subHeightFt, minSeparationFt, mode, timeAlignTo, seatAveraging,
      onYield, onProgress, yieldEvery
    } = options;
    const separation = Math.max(3, minSeparationFt ?? Math.max(4, Math.min(room.w, room.d) * 0.25));
    const modes = enumerateModes(physicsCtx);

    const placedSubs = [];
    const placedPositions = sourceExclusionPoints(otherSources, room);
    const roundResults = [];
    let currentOtherSources = otherSources.slice();

    for(let i = 0; i < numSubs; i++){
      const roundResult = await optimizeSubPlacementAsync({
        room, otherSources: currentOtherSources, freqList, listenerPositions,
        physicsCtx, offLimitZones, allowedZones, preferredZones, gridStepFt, subHeightFt,
        excludePoints: placedPositions, minSeparationFt: separation, mode,
        candidateTemplate: NEW_SUB_DEFAULTS, timeAlignTo, seatAveraging,
        precomputedModes: modes, onYield, yieldEvery,
        onProgress: onProgress ? (fraction) => onProgress(fraction, i) : undefined
      });
      roundResults.push(roundResult);
      if(roundResult.best === null) break;
      const placedSub = Object.assign(
        { name: `Sub ${i+1}` }, NEW_SUB_DEFAULTS,
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
      offLimitZones, allowedZones, preferredZones, gridStepFt, subHeightFt, minSeparationFt: separation, mode, timeAlignTo, seatAveraging,
      precomputedModes: modes, onYield, yieldEvery, onProgress
    });

    return { placedSubs: polish.placedSubs, roundResults, polishResults: polish.polishResults };
  }

  return {
    FT_TO_M, C,
    sourceGainAtFreq,
    wallMaterialAbsorptionAtFreq,
    polygonArea,
    isPointInPolygon,
    rectanglePolygon,
    floorPlanWalls,
    floorPlanClearance,
    clampToFloorPlan,
    FLOOR_PLAN_MIN_WALL_FT,
    resizeFloorPlan,
    FLOOR_PLAN_CELL_M,
    solveFloorPlan,
    floorPlanModeFrequencies,
    floorPlanStencil,
    floorPlanBracket: centerBracket,
    floorPlanCellField,
    isValidFloorPlan,
    moveFloorPlanWall,
    moveFloorPlanCorner,
    setFloorPlanWallLength,
    isConvexCorner,
    cutFloorPlanCorner,
    fillFloorPlanCorner,
    FLOOR_PLAN_TEMPLATES,
    floorPlanTemplate,
    floorPlanFromTemplate,
    floorPlanTemplateKind,
    mirrorFloorPlan,
    floorPlanFrontArea,
    FLOOR_PLAN_PREVIEW_CELL_M,
    floorPlanKey,
    floorPlanWorkerReply,
    createFloorPlanSolver,
    WALL_MATERIALS,
    BASS_TRAPS,
    bassTrapAbsorptionM2,
    bassTrapCorner,
    bassTrapFootprint,
    BASS_TRAP_UNIT_HEIGHT_FT,
    MODE_CUTOFF_HZ,
    enumerateModes,
    precomputeModalField,
    computeFieldAtPoint,
    modeShapesAtPoint,
    fieldFromModeShapes,
    fieldRowSums,
    fieldDbAtPoint,
    pressureToDb,
    sampleFieldDbRange,
    logSpacedFreqs,
    seatPositions,
    maxSchroederFrequency,
    SEAT_AVERAGING,
    measureAtSeats,
    gradePlacement,
    sphereSamplePoints,
    spatiallyAveragedResponse,
    spatiallyAveragedResponseMulti,
    centerSampleShapes,
    axialModes,
    estimatedT60,
    schroederFrequency,
    TIME_ALIGN_STEP_MS,
    timeAlignDelays,
    floorPlanPathLength,
    soundPathFt,
    timeAlignedSources,
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
    PLACEMENT_GAIN_DB,
    checkSubMoves,
    wallsAround,
    nearestWallDistances,
    rowFootprintRect,
    isPointInRect,
    freeFloorFraction,
    clipRectToRoom,
    isCandidateValid,
    isSubSource,
    SPEAKER_CLEARANCE_FT,
    speakerKeepOut,
    sourceExclusionPoints,
    assignNearestSpots,
    NEW_SUB_DEFAULTS,
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
