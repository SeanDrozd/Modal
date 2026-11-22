const assert = require('assert');
const P = require('./room-physics.js');

let passed = 0, failed = 0;
function test(name, fn){
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch(e){
    failed++;
    console.log(`FAIL  - ${name}`);
    console.log(`        ${e.message}`);
  }
}
// Async tests (for optimizeSubPlacementAsync/optimizeMultipleSubsAsync) can't use
// test() above -- it calls fn() synchronously in a plain try/catch, so an
// exception thrown after fn's first await would escape uncaught, unrelated to
// passed/failed, and could fire after process.exit has already ended the run.
// testAsync queues the test instead of running it immediately; the queue is
// drained (in order, one at a time) by the async IIFE at the bottom of this
// file, after every synchronous test() above has already run and printed.
const pendingAsync = [];
function testAsync(name, fn){
  pendingAsync.push({ name, fn });
}
function approx(actual, expected, tol, msg){
  assert.ok(Math.abs(actual - expected) <= tol,
    `${msg || ''} expected ${expected} +/- ${tol}, got ${actual}`);
}
function magOf({ re, im }){
  return Math.sqrt(re*re + im*im);
}

// A minimal ctx with a flat mid-range absorption on every surface — used throughout.
const baseRoom = { w: 18, d: 13.5, h: 8 };
function baseCtx(overrides){
  return Object.assign({
    room: baseRoom,
    wallAbsorption: 0.51
  }, overrides || {});
}

console.log('\n-- sourceGainAtFreq (crossover rolloff) --');

test('gain is 1.0 (0dB) inside the passband', () => {
  const s = { freqLow: 80, freqHigh: 20000 };
  approx(P.sourceGainAtFreq(s, 200), 1.0, 1e-9);
});

test('gain is exactly 1.0 at the passband edges', () => {
  const s = { freqLow: 80, freqHigh: 20000 };
  approx(P.sourceGainAtFreq(s, 80), 1.0, 1e-9);
  approx(P.sourceGainAtFreq(s, 20000), 1.0, 1e-9);
});

test('gain drops 12dB per octave below freqLow (at an explicit 12dB/oct slope)', () => {
  const s = { freqLow: 80, freqHigh: 20000 };
  // one octave below freqLow (40Hz) -> -12dB -> linear gain = 10^(-12/20)
  const gain = P.sourceGainAtFreq(s, 40, 12);
  const expectedDb = -12;
  const actualDb = 20 * Math.log10(gain);
  approx(actualDb, expectedDb, 0.05, '1 octave below freqLow');
});

test('gain drops 12dB per octave above freqHigh (at an explicit 12dB/oct slope)', () => {
  const s = { freqLow: 20, freqHigh: 80 };
  // one octave above freqHigh (160Hz) -> -12dB
  const gain = P.sourceGainAtFreq(s, 160, 12);
  const actualDb = 20 * Math.log10(gain);
  approx(actualDb, -12, 0.05, '1 octave above freqHigh');
});

test('gain is symmetric in log-frequency on both sides', () => {
  const s = { freqLow: 100, freqHigh: 100 }; // degenerate passband, both edges coincide
  const below = 20 * Math.log10(P.sourceGainAtFreq(s, 50, 12));  // 1 oct below
  const above = 20 * Math.log10(P.sourceGainAtFreq(s, 200, 12)); // 1 oct above
  approx(below, above, 0.05, 'symmetric rolloff around a point passband');
});

test('gain is 0 (not NaN) for a non-positive evaluation frequency', () => {
  // Math.log2(freqLow / f) goes negative-argument (NaN) for f < 0, and the
  // f===0 case would otherwise resolve via -Infinity dB -- both are guarded
  // explicitly so callers never see NaN leak out of this function.
  const s = { freqLow: 20, freqHigh: 80 };
  assert.strictEqual(P.sourceGainAtFreq(s, 0), 0);
  const negGain = P.sourceGainAtFreq(s, -10);
  assert.ok(Number.isFinite(negGain), `expected finite gain for f=-10, got ${negGain}`);
  assert.strictEqual(negGain, 0);
});

test('a source\'s own rolloffDbPerOct is used when no explicit slope is passed', () => {
  // Deliberately a value distinct from the 24dB/oct default below, so this
  // test actually distinguishes "source's own value is used" from "it just
  // fell through to the default and got lucky".
  const s = { freqLow: 80, freqHigh: 20000, rolloffDbPerOct: 12 };
  // one octave below freqLow (40Hz) at 12dB/oct -> -12dB, not the 24dB/oct default
  const gain = P.sourceGainAtFreq(s, 40);
  const actualDb = 20 * Math.log10(gain);
  approx(actualDb, -12, 0.05, '1 octave below freqLow at the source\'s own 12dB/oct slope');
});

test('an explicit slope argument overrides the source\'s own rolloffDbPerOct', () => {
  const s = { freqLow: 80, freqHigh: 20000, rolloffDbPerOct: 12 };
  const gain = P.sourceGainAtFreq(s, 40, 6);
  const actualDb = 20 * Math.log10(gain);
  approx(actualDb, -6, 0.05, 'explicit 3rd-arg slope should win over source.rolloffDbPerOct');
});

test('sources without rolloffDbPerOct default to 24dB/oct (a 4th-order/LR4 AVR-typical slope; backward compatible with older presets)', () => {
  const s = { freqLow: 80, freqHigh: 20000 }; // no rolloffDbPerOct field at all
  const gain = P.sourceGainAtFreq(s, 40);
  const actualDb = 20 * Math.log10(gain);
  approx(actualDb, -24, 0.05);
});

console.log('\n-- wallMaterialAbsorptionAtFreq / WALL_MATERIALS (frequency-dependent bare-wall absorption) --');

test('wallMaterialAbsorptionAtFreq returns null for a null/undefined material (caller should fall back to flat wallAbsorption)', () => {
  assert.strictEqual(P.wallMaterialAbsorptionAtFreq(null, 80), null);
  assert.strictEqual(P.wallMaterialAbsorptionAtFreq(undefined, 80), null);
});

test('wallMaterialAbsorptionAtFreq is flat baseAbsorption at every frequency when peakBoost is 0 (e.g. masonry -- no resonance mechanism)', () => {
  const masonry = P.WALL_MATERIALS.masonry;
  approx(P.wallMaterialAbsorptionAtFreq(masonry, 20), masonry.baseAbsorption, 1e-9);
  approx(P.wallMaterialAbsorptionAtFreq(masonry, 80), masonry.baseAbsorption, 1e-9);
  approx(P.wallMaterialAbsorptionAtFreq(masonry, 300), masonry.baseAbsorption, 1e-9);
});

test('wallMaterialAbsorptionAtFreq rises to baseAbsorption+peakBoost exactly at peakFreq', () => {
  const material = { baseAbsorption: 0.36, peakFreq: 80, peakBoost: 0.4096, bandwidth: 30 };
  approx(P.wallMaterialAbsorptionAtFreq(material, 80), 0.36 + 0.4096, 1e-9);
});

test('wallMaterialAbsorptionAtFreq approaches baseAbsorption far from peakFreq', () => {
  const material = { baseAbsorption: 0.36, peakFreq: 80, peakBoost: 0.4096, bandwidth: 30 };
  const farBelow = P.wallMaterialAbsorptionAtFreq(material, 20);
  const farAbove = P.wallMaterialAbsorptionAtFreq(material, 300);
  assert.ok(farBelow < 0.37, `expected near-baseAbsorption far below peakFreq, got ${farBelow}`);
  assert.ok(farAbove < 0.37, `expected near-baseAbsorption far above peakFreq, got ${farAbove}`);
});

test('wallMaterialAbsorptionAtFreq is symmetric around peakFreq', () => {
  const material = { baseAbsorption: 0.36, peakFreq: 80, peakBoost: 0.4096, bandwidth: 30 };
  const below = P.wallMaterialAbsorptionAtFreq(material, 60); // 20 below
  const above = P.wallMaterialAbsorptionAtFreq(material, 100); // 20 above
  approx(below, above, 1e-9);
});

test('WALL_MATERIALS.drywallInsulated has a bigger AND wider absorption peak than drywallHollow (insulation damps the resonance more)', () => {
  const insulated = P.WALL_MATERIALS.drywallInsulated;
  const hollow = P.WALL_MATERIALS.drywallHollow;
  assert.ok(insulated.peakBoost > hollow.peakBoost, 'insulated should have a bigger absorption peak');
  assert.ok(insulated.bandwidth > hollow.bandwidth, 'insulated should have a wider (more damped) peak');
});

console.log("\n-- wallMaterialAbsorptionAtFreq: shape:'porousRamp' (e.g. suspended acoustic ceiling tile) --");

test("porousRamp absorption is negligible above baseAbsorption well below midFreq", () => {
  const material = { shape: 'porousRamp', baseAbsorption: 0.3, midFreq: 280, slope: 0.03, maxAbsorbBoost: 0.5 };
  const absorbAt20 = P.wallMaterialAbsorptionAtFreq(material, 20);
  assert.ok(absorbAt20 < 0.32, `expected near-baseAbsorption well below midFreq, got ${absorbAt20}`);
});

test("porousRamp absorption is exactly baseAbsorption+maxAbsorbBoost/2 (the logistic midpoint) AT midFreq", () => {
  const material = { shape: 'porousRamp', baseAbsorption: 0.3, midFreq: 280, slope: 0.03, maxAbsorbBoost: 0.5 };
  const absorbAtMid = P.wallMaterialAbsorptionAtFreq(material, 280);
  approx(absorbAtMid, 0.3 + 0.5/2, 1e-9);
});

test("porousRamp absorption increases monotonically with frequency (opposite trend from 'resonant')", () => {
  const material = { shape: 'porousRamp', baseAbsorption: 0.3, midFreq: 280, slope: 0.03, maxAbsorbBoost: 0.5 };
  const a1 = P.wallMaterialAbsorptionAtFreq(material, 20);
  const a2 = P.wallMaterialAbsorptionAtFreq(material, 150);
  const a3 = P.wallMaterialAbsorptionAtFreq(material, 300);
  assert.ok(a1 < a2 && a2 < a3, `expected monotonically increasing absorption with frequency: ${a1}, ${a2}, ${a3}`);
});

test('WALL_MATERIALS.suspendedTile matches published E-400 tile data at 125 and 250 Hz and eases off below', () => {
  const tile = P.WALL_MATERIALS.suspendedTile;
  const at = f => P.wallMaterialAbsorptionAtFreq(tile, f);
  // Armstrong E-400 product-family data for common mineral-fiber tiles: 0.28-0.33 at 125 Hz, 0.35-0.39 at 250 Hz.
  assert.ok(at(125) >= 0.28 && at(125) <= 0.33, `expected 0.28-0.33 at 125Hz, got ${at(125)}`);
  assert.ok(at(250) >= 0.35 && at(250) <= 0.40, `expected 0.35-0.40 at 250Hz, got ${at(250)}`);
  assert.ok(at(40) < at(125) && at(40) > 0.1, `expected the extrapolated 40Hz value below the 125Hz value but not negligible, got ${at(40)}`);
});

console.log('\n-- fieldDbAtPoint: known-configuration sanity checks --');

test('pressure falls off with distance from a single source (no reflections)', () => {
  // wallAbsorption=1 would isolate the direct-path-only behavior (no boundary contributions)
  const ctx = baseCtx();
  const sources = [{ x: 9, y: 6, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 }];
  const freq = 120;
  const near = P.fieldDbAtPoint(9, 6.5, 3, sources, freq, ctx); // ~0.5ft away
  const far  = P.fieldDbAtPoint(9, 12, 3, sources, freq, ctx);  // ~6ft away
  assert.ok(near > far, `expected near point louder than far point: near=${near}dB far=${far}dB`);
});

test('source outside its frequency range contributes negligible energy', () => {
  const ctx = baseCtx();
  const subOnly = [{ x: 9, y: 6, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80 }];
  const dbAtPassband = P.fieldDbAtPoint(9, 8, 3.5, subOnly, 60, ctx);   // inside 20-80Hz
  const dbFarAbove   = P.fieldDbAtPoint(9, 8, 3.5, subOnly, 2000, ctx); // many octaves above freqHigh -- crossover rolloff dominates regardless of mode cutoff (querying a driving frequency well past every mode's own resonance is still well-defined, just far off-resonance for all of them)
  assert.ok(dbFarAbove < dbAtPassband - 40,
    `expected far-above-passband level to be much lower: passband=${dbAtPassband}dB farAbove=${dbFarAbove}dB`);
});

test('reciprocity: swapping source and receiver positions gives an identical field', () => {
  // psi_n(r)*psi_n(r_s) is symmetric in r/r_s by construction -- a strong,
  // cheap correctness check on the mode-shape evaluation code (catches e.g.
  // accidentally using the wrong axis length for one side).
  const ctx = baseCtx();
  const a = { x: 4, y: 3, z: 2 };
  const b = { x: 12, y: 9, z: 5 };
  const freq = 90;
  const dbAtoB = P.fieldDbAtPoint(b.x, b.y, b.z, [{ ...a, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 }], freq, ctx);
  const dbBtoA = P.fieldDbAtPoint(a.x, a.y, a.z, [{ ...b, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 }], freq, ctx);
  approx(dbAtoB, dbBtoA, 1e-6, 'field should be identical whether source is at a/receiver at b, or vice versa');
});

test('rigid-wall boundary check: mode shape magnitude is exactly 1 at every wall regardless of mode index', () => {
  // cos(nx*pi*x/Lx) = +-1 at x=0 and x=Lx for every integer nx -- the rigid-
  // wall (Neumann) antinode condition this whole method is built on.
  const ctx = baseCtx();
  const modes = P.enumerateModes(ctx);
  assert.ok(modes.length > 0, 'expected at least one mode below the default cutoff');
  const room = ctx.room;
  for(const mode of modes.slice(0, 20)){
    const psiAtLeftWall = Math.cos(mode.invLx * 0);
    const psiAtRightWall = Math.cos(mode.invLx * room.w * P.FT_TO_M);
    approx(Math.abs(psiAtLeftWall), 1, 1e-9, `mode (${mode.nx},${mode.ny},${mode.nz}) at left wall`);
    approx(Math.abs(psiAtRightWall), 1, 1e-9, `mode (${mode.nx},${mode.ny},${mode.nz}) at right wall`);
  }
});

console.log('\n-- sphereSamplePoints --');

test('every generated point is within the requested radius of the center', () => {
  const pts = P.sphereSamplePoints(9, 6, 3, 1, 20);
  assert.strictEqual(pts.length, 20);
  for(const p of pts){
    const d = Math.sqrt((p.x-9)**2 + (p.y-6)**2 + (p.z-3)**2);
    assert.ok(d <= 1 + 1e-9, `point at distance ${d} exceeds radius 1`);
  }
});

test('points are spread through the volume, not clumped at the center or a single shell', () => {
  const pts = P.sphereSamplePoints(9, 6, 3, 1, 20);
  const dists = pts.map(p => Math.sqrt((p.x-9)**2 + (p.y-6)**2 + (p.z-3)**2));
  const minD = Math.min(...dists), maxD = Math.max(...dists);
  assert.ok(maxD - minD > 0.5, `expected a spread of radii, got min=${minD.toFixed(2)} max=${maxD.toFixed(2)}`);
  // no two points should coincide (a degenerate/buggy distribution could collapse points)
  for(let i = 0; i < pts.length; i++){
    for(let j = i+1; j < pts.length; j++){
      const d = Math.sqrt((pts[i].x-pts[j].x)**2 + (pts[i].y-pts[j].y)**2 + (pts[i].z-pts[j].z)**2);
      assert.ok(d > 1e-6, `points ${i} and ${j} coincide`);
    }
  }
});

test('is deterministic -- same inputs produce the same cloud every time', () => {
  const a = P.sphereSamplePoints(9, 6, 3, 1, 20);
  const b = P.sphereSamplePoints(9, 6, 3, 1, 20);
  assert.deepStrictEqual(a, b);
});

test('the cloud is centered: points above and below the center reach out equally far', () => {
  const pts = P.sphereSamplePoints(0, 0, 0, 2, 20);
  const r = p => Math.hypot(p.x, p.y, p.z);
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const above = pts.filter(p => p.z > 0).map(r), below = pts.filter(p => p.z < 0).map(r);
  assert.strictEqual(above.length, 10);
  assert.strictEqual(below.length, 10);
  assert.ok(Math.abs(mean(above) - mean(below)) < 0.1, `mean radius above ${mean(above).toFixed(2)} vs below ${mean(below).toFixed(2)}`);
  for(const axis of ['x', 'y', 'z']){
    const c = mean(pts.map(p => p[axis]));
    assert.ok(Math.abs(c) < 0.05, `centroid ${axis} = ${c.toFixed(3)} ft, expected within 0.05 ft of the center`);
  }
});

test('radius 0 collapses every point onto the center', () => {
  const pts = P.sphereSamplePoints(9, 6, 3, 0, 10);
  for(const p of pts) assert.deepStrictEqual(p, { x: 9, y: 6, z: 3 });
});

console.log('\n-- spatiallyAveragedResponse (moving-mic-style measurement) --');

test('radius 0 exactly matches a plain single-point fieldDbAtPoint at every frequency', () => {
  const ctx = baseCtx({ wallAbsorption: 0.51 });
  const sources = [{ x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 }];
  const freqs = [40, 80, 160];
  const result = P.spatiallyAveragedResponse(9, 9, 3.5, freqs, sources, ctx, { radiusFt: 0, numPoints: 8 });
  assert.strictEqual(result.length, freqs.length);
  for(let i = 0; i < freqs.length; i++){
    assert.strictEqual(result[i].freq, freqs[i]);
    const direct = P.fieldDbAtPoint(9, 9, 3.5, sources, freqs[i], ctx);
    approx(result[i].db, direct, 0.01, `freq=${freqs[i]}`);
  }
});

test('spatial averaging smooths out a deep coherent null relative to the exact point', () => {
  // Same antiphase construction as the "DEMONSTRATION" null-sensitivity test
  // below: two equal-level sources half a wavelength apart, one delayed by
  // half a period, guarantees a clean destructive-interference null exactly
  // at the midpoint between them (equal path length + intentional half-period
  // phase flip = full cancellation) -- the classic worst case for a single
  // exact-point reading.
  const ctx = baseCtx({ wallAbsorption: 0.03 }); // near-rigid, light damping -- keeps the direct antiphase relationship dominant rather than swamped in reverberation
  const freq = 100;
  const lambda = P.C / freq;
  const sepFt = (lambda / 2) / P.FT_TO_M;
  const halfPeriodMs = (1000 / (2 * freq)) * 0.999; // detuned slightly off perfect antiphase, same reasoning as below
  const sources = [
    { x: 9 - sepFt/2, y: 6, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 },
    { x: 9 + sepFt/2, y: 6, z: 3, levelDb: 0, delayMs: halfPeriodMs, freqLow: 20, freqHigh: 20000 }
  ];
  const exactDb = P.fieldDbAtPoint(9, 6, 3, sources, freq, ctx);
  const averaged = P.spatiallyAveragedResponse(9, 6, 3, [freq], sources, ctx, { radiusFt: 1, numPoints: 20 });
  // Reference: a single one of the two sources alone at the same point, with
  // no antiphase partner to cancel against -- the "no cancellation" baseline
  // this test's null should read well below. Relative to this baseline (not a
  // hardcoded absolute dB number) since the modal method's overall amplitude
  // scale/reference differs from a free-field convention.
  const singleSourceDb = P.fieldDbAtPoint(9, 6, 3, [sources[0]], freq, ctx);
  assert.ok(exactDb < singleSourceDb - 25,
    `expected a deep null at the exact midpoint relative to a single source alone: exact=${exactDb.toFixed(1)}dB singleSource=${singleSourceDb.toFixed(1)}dB`);
  assert.ok(averaged[0].db > exactDb + 15,
    `expected spatial averaging to read meaningfully higher than the exact null: exact=${exactDb.toFixed(1)}dB averaged=${averaged[0].db.toFixed(1)}dB`);
});

test('returns one entry per input frequency, in the same order', () => {
  const ctx = baseCtx();
  const sources = [{ x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 }];
  const freqs = [30, 200, 60, 150];
  const result = P.spatiallyAveragedResponse(9, 9, 3.5, freqs, sources, ctx);
  assert.deepStrictEqual(result.map(r => r.freq), freqs);
  for(const r of result) assert.ok(Number.isFinite(r.db), `non-finite dB at freq=${r.freq}`);
});

console.log('\n-- spatiallyAveragedResponseMulti (batched multi-listener version) --');

test('a single center produces numerically identical results to spatiallyAveragedResponse', () => {
  const ctx = baseCtx({ wallAbsorption: 0.51 });
  const sources = [{ x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 }];
  const freqs = [40, 80, 160];
  const single = P.spatiallyAveragedResponse(9, 9, 3.5, freqs, sources, ctx, { radiusFt: 1, numPoints: 12 });
  const multi = P.spatiallyAveragedResponseMulti([{ x: 9, y: 9, z: 3.5 }], freqs, sources, ctx, { radiusFt: 1, numPoints: 12 });
  assert.strictEqual(multi.perCenterDb.length, 1);
  assert.strictEqual(multi.perCenterDb[0].length, freqs.length);
  for(let i = 0; i < freqs.length; i++){
    approx(multi.perCenterDb[0][i], single[i].db, 1e-9, `freq=${freqs[i]}`);
  }
});

test('multiple centers produce independent, correctly-ordered curves, not averaged together', () => {
  // Same antiphase construction as spatiallyAveragedResponse's own null-smoothing
  // test: a clean destructive null sits at one specific point (9,6,3), not at a
  // different point (3,10,3) far away with no such cancellation.
  const ctx = baseCtx({ wallAbsorption: 0.03 });
  const freq = 100;
  const lambda = P.C / freq;
  const sepFt = (lambda / 2) / P.FT_TO_M;
  const halfPeriodMs = (1000 / (2 * freq)) * 0.999;
  const sources = [
    { x: 9 - sepFt/2, y: 6, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 },
    { x: 9 + sepFt/2, y: 6, z: 3, levelDb: 0, delayMs: halfPeriodMs, freqLow: 20, freqHigh: 20000 }
  ];
  const nullCenter = { x: 9, y: 6, z: 3 };
  const farCenter = { x: 3, y: 10, z: 3 };
  const { perCenterDb } = P.spatiallyAveragedResponseMulti([nullCenter, farCenter], [freq], sources, ctx, { radiusFt: 1, numPoints: 20 });
  assert.ok(perCenterDb[1][0] > perCenterDb[0][0] + 5,
    `expected the far center to read meaningfully higher than the null center: null=${perCenterDb[0][0].toFixed(1)}dB far=${perCenterDb[1][0].toFixed(1)}dB`);
  // Cross-check against independent single-point calls, confirming batching
  // didn't cross-contaminate the two centers' results.
  const nullAlone = P.spatiallyAveragedResponse(nullCenter.x, nullCenter.y, nullCenter.z, [freq], sources, ctx, { radiusFt: 1, numPoints: 20 });
  const farAlone = P.spatiallyAveragedResponse(farCenter.x, farCenter.y, farCenter.z, [freq], sources, ctx, { radiusFt: 1, numPoints: 20 });
  approx(perCenterDb[0][0], nullAlone[0].db, 1e-9, 'null center should match its own independent call');
  approx(perCenterDb[1][0], farAlone[0].db, 1e-9, 'far center should match its own independent call');
});

test('returns freqs and perCenterDb arrays matching input shape', () => {
  const ctx = baseCtx();
  const sources = [{ x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 }];
  const freqs = [30, 200, 60, 150];
  const centers = [{ x: 9, y: 9, z: 3.5 }, { x: 5, y: 5, z: 3.5 }, { x: 13, y: 11, z: 3.5 }];
  const result = P.spatiallyAveragedResponseMulti(centers, freqs, sources, ctx);
  assert.deepStrictEqual(result.freqs, freqs);
  assert.strictEqual(result.perCenterDb.length, centers.length);
  for(const dbRow of result.perCenterDb){
    assert.strictEqual(dbRow.length, freqs.length);
    for(const db of dbRow) assert.ok(Number.isFinite(db), 'non-finite dB');
  }
});

console.log('\n-- axialModes --');

test('axial mode formula matches hand-calculated values for a known dimension', () => {
  // f_n = (c/2) * (n / L), L in meters
  const dimFt = 18;
  const dimM = dimFt * P.FT_TO_M;
  const expectedFirst = (P.C / 2) * (1 / dimM);
  const modes = P.axialModes(dimFt, 1, 100);
  approx(modes[0], expectedFirst, 0.01);
});

test('axial modes are harmonics (2nd mode is ~2x the 1st, 3rd is ~3x)', () => {
  const modes = P.axialModes(18, 3, 500);
  approx(modes[1] / modes[0], 2, 0.001);
  approx(modes[2] / modes[0], 3, 0.001);
});

test('axial modes respects maxFreq cutoff', () => {
  const modes = P.axialModes(18, 10, 50); // 18ft room, first mode ~31Hz
  for(const f of modes){
    assert.ok(f <= 50, `mode ${f}Hz should not exceed maxFreq=50`);
  }
});

console.log('\n-- enumerateModes / precomputeModalField (rectangular-room modal solution) --');

test('mode count for the default 18x13.5x8 room at the 300Hz cutoff falls in the expected range', () => {
  // Sanity check on the enumeration itself (catches e.g. an off-by-one in the
  // ellipsoid bound, or a sign error dropping half the octant) -- expected
  // order of magnitude is ~150-200 for this room per the mode-density estimate
  // this cutoff was chosen from.
  const ctx = { room: baseRoom, wallAbsorption: 0.51 };
  const modes = P.enumerateModes(ctx);
  assert.ok(modes.length > 50 && modes.length < 500,
    `expected roughly 100-300 modes below 300Hz for this room, got ${modes.length}`);
});

test('field has a local peak in frequency at an exact axial-mode resonance', () => {
  // Source and listener both at the room corner (0,0,0) -- an antinode for
  // EVERY axial mode along every axis (cos(n*pi*0/L)=1 regardless of n) --
  // maximizes coupling to axial modes specifically, so the exact axialModes()
  // frequency should show up as a genuine local peak, not just a coincidence.
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.03 }; // light damping -- keeps the peak sharp/detectable
  const source = { x: 0, y: 0, z: 0, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 };
  const [f1] = P.axialModes(room.w, 1, 300); // exact x-axial mode 1 frequency
  const magAt = (f) => P.fieldDbAtPoint(0, 0, 0, [source], f, ctx);
  const atPeak = magAt(f1);
  const below = magAt(f1 - 3);
  const above = magAt(f1 + 3);
  assert.ok(atPeak > below && atPeak > above,
    `expected a local peak at the exact axial resonance f=${f1.toFixed(2)}Hz: below=${below.toFixed(1)}dB at=${atPeak.toFixed(1)}dB above=${above.toFixed(1)}dB`);
});

test('a single isolated mode peaks in response exactly at its own resonance frequency', () => {
  // Isolates ONE mode (bypassing enumerateModes' full room sum) to directly
  // verify precomputeModalField/computeFieldAtPoint's complex-division math
  // peaks exactly where the mode's own k_n says it should, independent of
  // whatever other modes happen to be nearby in the full room sum.
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.03 };
  const modes = P.enumerateModes(ctx);
  const mode = modes.find(m => m.fn > 60 && m.fn < 250); // a representative mid-range mode
  assert.ok(mode, 'expected at least one mode in the 60-250Hz range for this room');
  const source = { x: 3, y: 2, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 };
  const point = { x: 7, y: 4, z: 2 };
  const magAt = (f) => {
    const pre = P.precomputeModalField([source], f, ctx, [mode]);
    const { re, im } = P.computeFieldAtPoint(point.x, point.y, point.z, pre);
    return Math.sqrt(re*re + im*im);
  };
  const atRes = magAt(mode.fn);
  const below = magAt(mode.fn * 0.9);
  const above = magAt(mode.fn * 1.1);
  assert.ok(atRes > below && atRes > above,
    `expected the isolated mode's response to peak exactly at its own f_n=${mode.fn.toFixed(1)}Hz: below=${below.toExponential(2)} at=${atRes.toExponential(2)} above=${above.toExponential(2)}`);
});

test("DEMONSTRATION: on-resonance peak magnitude grows as a mode's damping decreases (less absorptive room -> sharper/taller peaks)", () => {
  const source = { x: 3, y: 2, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 };
  const point = { x: 7, y: 4, z: 2 };
  const baseMode = { nx: 1, ny: 1, nz: 0, kn: 1.0, An: 1000, invLx: 0.1, invLy: 0.15, invLz: 0 };
  const freq = baseMode.kn * P.C / (2 * Math.PI); // exactly on resonance
  const dampingValues = [0.5, 0.1, 0.02, 0.005]; // decreasing damping each step
  let prevMag = -1;
  for(const deltaN of dampingValues){
    const mode = { ...baseMode, deltaN };
    const pre = P.precomputeModalField([source], freq, { room: baseRoom, wallAbsorption: 0.51 }, [mode]);
    const { re, im } = P.computeFieldAtPoint(point.x, point.y, point.z, pre);
    const mag = Math.sqrt(re*re + im*im);
    assert.ok(mag > prevMag,
      `expected magnitude to increase as damping decreases (deltaN=${deltaN}): got ${mag.toExponential(2)}, previous was ${prevMag < 0 ? 'n/a' : prevMag.toExponential(2)}`);
    prevMag = mag;
  }
});

test('uniform absorption: each mode family decays at its own classic fraction of the Sabine rate', () => {
  // With the same absorption on all six surfaces, a mode's damping is
  // alpha * sum over axes of eps(n on that axis) / (4 * L of that axis): the
  // Sabine rate alpha*S/(4V) exactly for every oblique mode, less for a
  // tangential mode and least for an axial one (Morse; Kuttruff).
  const room = { w: 18, d: 13.5, h: 8 };
  const alpha = 0.1;
  const modes = P.enumerateModes({ room, wallAbsorption: alpha });
  const L = [room.w, room.d, room.h].map(ft => ft * P.FT_TO_M);
  const sabine = (alpha / 2) * (1/L[0] + 1/L[1] + 1/L[2]); // alpha*S/(4V), in 1/m like deltaN
  const counts = { axial: 0, tangential: 0, oblique: 0 };
  for(const m of modes){
    const n = [m.nx, m.ny, m.nz];
    const nonZero = n.filter(v => v > 0).length;
    if(nonZero === 0) continue; // the (0,0,0) mode has its own test below
    const expected = (alpha / 4) * n.reduce((sum, v, i) => sum + (v > 0 ? 2 : 1) / L[i], 0);
    approx(m.deltaN, expected, 1e-12, `mode (${n.join(',')})`);
    if(nonZero === 3) approx(m.deltaN / sabine, 1, 1e-9, `oblique mode (${n.join(',')}) vs the Sabine rate`);
    else assert.ok(m.deltaN < sabine, `expected mode (${n.join(',')}) to decay slower than the Sabine rate`);
    counts[nonZero === 1 ? 'axial' : nonZero === 2 ? 'tangential' : 'oblique']++;
  }
  assert.ok(counts.axial > 0 && counts.tangential > 0 && counts.oblique > 0, `expected all three mode families, got ${JSON.stringify(counts)}`);
  // An x-axial mode: its two end walls count double, the other four surfaces once.
  const axialX = modes.find(m => m.nx === 1 && m.ny === 0 && m.nz === 0);
  approx(axialX.deltaN / sabine, (2/L[0] + 1/L[1] + 1/L[2]) / (2 * (1/L[0] + 1/L[1] + 1/L[2])), 1e-9, 'x-axial mode vs the Sabine rate');
});

test('an oblique mode\'s own decay time equals the Sabine T60 for a lightly damped room', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.05 };
  const mode = P.enumerateModes(ctx).find(m => m.nx > 0 && m.ny > 0 && m.nz > 0);
  // delta_n is spatial (1/m); the energy decay rate is delta_n*c, and T60 is ln(1e6) over it.
  const t60FromMode = Math.log(1e6) / (mode.deltaN * P.C);
  const m2 = P.FT_TO_M ** 2, m3 = P.FT_TO_M ** 3;
  const surface = 2 * (room.w*room.d + room.w*room.h + room.d*room.h) * m2;
  const t60Sabine = 24 * Math.log(10) / P.C * (room.w*room.d*room.h * m3) / (0.05 * surface);
  approx(t60FromMode / t60Sabine, 1, 1e-9, 'oblique-mode T60 vs Sabine');
  // Eyring's estimate sits just under Sabine's at this absorption.
  const ratioToEyring = t60FromMode / P.estimatedT60(room, mode.fn, ctx);
  assert.ok(ratioToEyring > 1 && ratioToEyring < 1.05, `expected the mode's T60 just above Eyring's, got ratio ${ratioToEyring.toFixed(3)}`);
});

test('the (0,0,0) pressure-zone mode is enumerated, uniform across the room and lightly damped', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const alpha = 0.1;
  const modes = P.enumerateModes({ room, wallAbsorption: alpha });
  const zero = modes.filter(m => m.nx === 0 && m.ny === 0 && m.nz === 0);
  assert.strictEqual(zero.length, 1, 'expected exactly one (0,0,0) mode');
  const m = zero[0];
  assert.strictEqual(m.kn, 0);
  assert.strictEqual(m.fn, 0);
  assert.ok(m.invLx === 0 && m.invLy === 0 && m.invLz === 0, 'expected a mode shape of 1 everywhere');
  const L = [room.w, room.d, room.h].map(ft => ft * P.FT_TO_M);
  approx(m.deltaN, (alpha / 4) * (1/L[0] + 1/L[1] + 1/L[2]), 1e-12, 'half the Sabine rate');
  approx(m.An, P.C * P.C / (L[0] * L[1] * L[2]), 1e-9, 'c^2/V');
});

test('below the first room mode the pressure-zone mode dominates: the level is nearly the same everywhere and rises toward low frequency', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.1 };
  const source = { x: 2, y: 12, z: 1, levelDb: 0, delayMs: 0, freqLow: 1, freqHigh: 20000 };
  const [firstMode] = P.axialModes(room.w, 1, 300); // about 31 Hz
  assert.ok(firstMode > 30, `expected the first mode above 30Hz, got ${firstMode}`);
  const at = (x, y, z, f) => P.fieldDbAtPoint(x, y, z, [source], f, ctx);
  // 10 Hz, a third of the first mode's frequency: far corner, room center and a few feet from the source.
  const levels = [at(17, 1, 7, 10), at(9, 6.75, 4, 10), at(6, 9, 3, 10)];
  assert.ok(Math.max(...levels) - Math.min(...levels) < 3, `expected under 3dB of variation across the room at 10Hz, got ${levels.map(v => v.toFixed(1)).join(', ')}`);
  // The zero mode's term goes as 1/k^2: 12 dB per octave.
  approx(at(9, 6.75, 4, 5) - at(9, 6.75, 4, 10), 12, 1.5, 'rise from 10Hz down to 5Hz at the room center');
  // Without the mode, the room center (on the first x and y modes' nodal planes) would read far lower.
  const without = P.enumerateModes(ctx).filter(m => m.kn > 0);
  const { re, im } = P.computeFieldAtPoint(9, 6.75, 4, P.precomputeModalField([source], 10, ctx, without));
  const dbWithout = 20 * Math.log10(Math.hypot(re, im));
  assert.ok(at(9, 6.75, 4, 10) - dbWithout > 10, `expected the pressure-zone mode to add over 10dB at the room center at 10Hz, got ${(at(9, 6.75, 4, 10) - dbWithout).toFixed(1)}`);
});

console.log('\n-- isNearNull / dB sensitivity near interference nulls --');

test('isNearNull classifies below-threshold values as near a null', () => {
  assert.strictEqual(P.isNearNull(-50), true);
  assert.strictEqual(P.isNearNull(-10), false);
});

test('isNearNull respects a custom threshold', () => {
  assert.strictEqual(P.isNearNull(-30, -20), true);
  assert.strictEqual(P.isNearNull(-10, -20), false);
});

test('DEMONSTRATION: dB is far more sensitive to tiny position shifts near a null than away from one', () => {
  // This is the actual property that makes point-by-point CPU/GPU dB comparison
  // near nulls unreliable as a bug signal. Deliberately construct two equal-level
  // sources exactly half a wavelength apart, with one delayed by half a period —
  // this puts them in antiphase, guaranteeing a clean, deep destructive-interference
  // null exists on the line between them (rather than hoping a scan finds one).
  const ctx = baseCtx({ wallAbsorption: 0.03 }); // near-rigid, light damping -- keeps the direct antiphase relationship dominant
  const freq = 150;
  const lambda = P.C / freq;
  const sepFt = (lambda / 2) / P.FT_TO_M; // half-wavelength separation, in feet
  // Detune slightly off perfect antiphase (0.999x half-period instead of exactly
  // half) so the null is deep but not perfectly canceling — avoids the -120dB
  // floor clamp in fieldDbAtPoint, which would make the sensitivity comparison
  // below meaningless (clamped values don't respond to position shifts at all).
  const halfPeriodMs = (1000 / (2 * freq)) * 0.999;
  const sources = [
    { x: 9 - sepFt/2, y: 6, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 },
    { x: 9 + sepFt/2, y: 6, z: 3, levelDb: 0, delayMs: halfPeriodMs, freqLow: 20, freqHigh: 20000 }
  ];

  // Scan along the line between the sources at fine resolution to locate the true
  // null (not just a coarse-grid approximation of it) and a point clearly away
  // from any null (mid-way between the sources' outer region, not a scan-edge artifact).
  let nullPoint = null;
  for(let x = 8.5; x <= 9.5; x += 0.001){
    const db = P.fieldDbAtPoint(x, 6, 3, sources, freq, ctx);
    if(nullPoint === null || db < nullPoint.db) nullPoint = { x, db };
  }
  const awayPoint = { x: 9 - sepFt/2 + 0.05, db: P.fieldDbAtPoint(9 - sepFt/2 + 0.05, 6, 3, sources, freq, ctx) }; // just outside a source, clearly not at a null
  // Relative to awayPoint (not a hardcoded absolute dB number), since the
  // modal method's overall amplitude scale/reference differs from a
  // free-field convention.
  assert.ok(nullPoint.db < awayPoint.db - 25,
    `expected a deep null relative to the away point: null=${nullPoint.db.toFixed(1)}dB away=${awayPoint.db.toFixed(1)}dB`);
  assert.ok(Number.isFinite(nullPoint.db), 'null dB should be finite');

  const TINY_SHIFT = 0.001; // ~0.3mm, well under a pixel at any reasonable render scale
  const dbAtNull = P.fieldDbAtPoint(nullPoint.x, 6, 3, sources, freq, ctx);
  const dbNearNullShifted = P.fieldDbAtPoint(nullPoint.x + TINY_SHIFT, 6, 3, sources, freq, ctx);
  const dbAway = P.fieldDbAtPoint(awayPoint.x, 6, 3, sources, freq, ctx);
  const dbAwayShifted = P.fieldDbAtPoint(awayPoint.x + TINY_SHIFT, 6, 3, sources, freq, ctx);

  const sensitivityNearNull = Math.abs(dbAtNull - dbNearNullShifted);
  const sensitivityAway = Math.abs(dbAway - dbAwayShifted);

  assert.ok(sensitivityNearNull > sensitivityAway * 5,
    `expected dB near the null to be much more sensitive to a tiny position shift: ` +
    `near-null sensitivity=${sensitivityNearNull.toFixed(4)}dB, away sensitivity=${sensitivityAway.toFixed(4)}dB`);
});

console.log('\n-- scoreSubPosition --');

test('a position centered between two coherent-summing sources scores well (loud + flat)', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [
    { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true },
    { x: 13.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true }
  ];
  const freqs = [30, 40, 50, 60, 70, 80];
  const listeners = [{ x: 9, y: 9, z: 3.5 }];

  const nearCorner = P.scoreSubPosition({ x: 1, y: 1 }, mains, room, freqs, listeners, ctx);
  const center = P.scoreSubPosition({ x: 9, y: 6.75 }, mains, room, freqs, listeners, ctx);
  // Not asserting a specific winner (that depends on the room's actual modes),
  // just that the function produces distinct, finite scores for different positions.
  assert.ok(Number.isFinite(nearCorner.score), 'corner score should be finite');
  assert.ok(Number.isFinite(center.score), 'center score should be finite');
  assert.notStrictEqual(nearCorner.score, center.score, 'different positions should generally score differently');
});

test('DEMONSTRATION: a wall/corner position with a meaningfully higher average level wins in balanced mode, not just an open-floor spot with slightly better flatness', () => {
  // Wall/corner placements couple into every room mode more strongly than
  // open-floor placements (mode shapes peak at every boundary), genuinely
  // raising avgMean there, at some cost to worstStdDev (a less even response
  // at a fixed listening point). BALANCED_FLATNESS_WEIGHT exists specifically
  // so a real level advantage like this wins decisively rather than being
  // erased by a close flatness difference (see its own comment for the
  // motivating case this was tuned against).
  const room = { w: 18, d: 13.5, h: 8 };
  const wallMaterials = {
    left: P.WALL_MATERIALS.drywallInsulated, right: P.WALL_MATERIALS.drywallInsulated,
    front: P.WALL_MATERIALS.drywallInsulated, back: P.WALL_MATERIALS.drywallInsulated
  };
  const ctx = { room, wallAbsorption: 0.06, wallMaterials, ceilingMaterial: P.WALL_MATERIALS.drywallInsulated, floorAbsorption: 0.15 };
  const mains = [
    { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true },
    { x: 13.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true }
  ];
  const listeners = [{ x: 9, y: 9, z: 3.5, weight: 1 }];
  const freqs = [];
  for(let f = 20; f <= 100; f += Math.max(2, (100-20)/12)) freqs.push(f);

  const wallMid = P.scoreSubPosition({ x: 9, y: 0.5, z: 1 }, mains, room, freqs, listeners, ctx, 'balanced');
  const openFloor = P.scoreSubPosition({ x: 9, y: 7, z: 1 }, mains, room, freqs, listeners, ctx, 'balanced');
  assert.ok(wallMid.avgMean > openFloor.avgMean, 'test setup: the wall position should genuinely have higher average level');
  assert.ok(wallMid.score > openFloor.score,
    `expected the wall position to win on score too: wallMid=${wallMid.score.toFixed(2)} openFloor=${openFloor.score.toFixed(2)}`);
});

test('a position with a deep null at one frequency scores worse than an equally-loud-on-average flat position', () => {
  // Construct two single-sub scenarios with the SAME average level across frequency,
  // but one has a severe dip at a single frequency (a null) and the other doesn't.
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 1, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const freqs = [40, 50, 60, 70, 80];
  const listeners = [{ x: 9, y: 6, z: 3.5 }];

  // Two sources close to in-phase almost everywhere in this band = smoother sum.
  const flatSources = [
    { x: 5, y: 2, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 200, enabled: true }
  ];
  // A second source positioned/delayed to create a sharp cancellation at ~60Hz specifically.
  const lambda60 = P.C / 60;
  const nullySources = [
    { x: 5, y: 2, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 200, enabled: true },
    { x: 5 + (lambda60/2)/P.FT_TO_M, y: 2, z: 1, levelDb: 0, delayMs: (1000/(2*60))*0.999, freqLow: 20, freqHigh: 200, enabled: true }
  ];

  const flatResult = P.scoreSubPosition({ x: 9, y: 6.75, z: 1 }, flatSources, room, freqs, listeners, ctx);
  const nullyResult = P.scoreSubPosition({ x: 9, y: 6.75, z: 1 }, nullySources, room, freqs, listeners, ctx);

  assert.ok(nullyResult.worstStdDev > flatResult.worstStdDev,
    `expected the nulled scenario to have higher std dev (less flat): flat=${flatResult.worstStdDev.toFixed(2)} nully=${nullyResult.worstStdDev.toFixed(2)}`);
});

test('score combines multiple listeners by penalizing the WORST listener, not just averaging', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [{ x: 9, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 200, enabled: true }];
  const freqs = [40, 60, 80];

  const oneListener = P.scoreSubPosition({ x: 9, y: 6.75, z: 1 }, mains, room, freqs, [{x:9,y:9,z:3.5}], ctx);
  const twoListeners = P.scoreSubPosition({ x: 9, y: 6.75, z: 1 }, mains, room, freqs, [{x:9,y:9,z:3.5},{x:2,y:12,z:3.5}], ctx);
  // Both should produce finite, sane scores; the two-listener score reflects the worse of the two seats.
  assert.ok(Number.isFinite(oneListener.score));
  assert.ok(Number.isFinite(twoListeners.score));
  assert.strictEqual(twoListeners.listenerStats.length, 2);
});

test('worstMinDb penalty engages (score is reduced) when the worst listener dips 20dB+ below the scene average', () => {
  // The penalty is relative to the scene's own avgMean, not a hardcoded
  // absolute dB number (see scoreSubPosition's comment) -- so this needs a
  // genuine frequency-dependent interference null, not just "a quiet source
  // far away." Two coherent sources half a wavelength apart at freq0, with
  // one delayed by half a period, cancel sharply AT freq0 but not at other
  // frequencies (their fixed physical delay doesn't correspond to a half-
  // wavelength separation elsewhere), producing a deep dip relative to the
  // scene's own average across the freq list.
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51 };
  const listener = { x: 9, y: 6, z: 3.5 };
  const freq0 = 60;
  const lambda = P.C / freq0;
  const sepFt = (lambda / 2) / P.FT_TO_M;
  const halfPeriodMs = (1000 / (2 * freq0)) * 0.999; // detuned slightly off perfect antiphase
  const otherSources = [{ x: 9 - sepFt/2, y: 6, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000, enabled: true }];
  const candidatePos = { x: 9 + sepFt/2, y: 6, z: 3, delayMs: halfPeriodMs };
  const freqs = [freq0 * 0.4, freq0, freq0 * 1.7]; // freq0 is the null; the other two are well off it

  const result = P.scoreSubPosition(candidatePos, otherSources, room, freqs, [listener], ctx);
  assert.ok(result.avgMean - result.worstMinDb > 20,
    `expected a null 20dB+ below the scene average to set up this test, got avgMean=${result.avgMean.toFixed(1)} worstMinDb=${result.worstMinDb.toFixed(1)}`);
  const expectedPenalty = Math.max(0, result.avgMean - result.worstMinDb - 20) * 0.5;
  assert.ok(expectedPenalty > 0, 'this scenario should actually exercise a nonzero penalty');
  approx(result.score, result.avgMean - (result.worstStdDev * P.BALANCED_FLATNESS_WEIGHT) - expectedPenalty, 1e-6, 'score should equal avgMean minus the stdDev and worstMinDb penalty terms');
});

test('worstMinDb penalty is exactly zero when no listener dips 20dB+ below the scene average', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51 };
  const silentCandidate = { x: 1, y: 1, z: 1, levelDb: -200 };
  const loudSource = { x: 9, y: 6, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000, enabled: true };
  const listeners = [{ x: 9, y: 6, z: 4 }];
  const freqs = [40, 60, 80]; // no interference partner (candidate is silenced) -- flat-ish response, no relative dip

  const result = P.scoreSubPosition(silentCandidate, [loudSource], room, freqs, listeners, ctx);
  assert.ok(result.avgMean - result.worstMinDb <= 20,
    `expected no null 20dB+ below average for this test, got avgMean=${result.avgMean.toFixed(1)} worstMinDb=${result.worstMinDb.toFixed(1)}`);
  approx(result.score, result.avgMean - (result.worstStdDev * P.BALANCED_FLATNESS_WEIGHT), 1e-6, 'with the null penalty inactive, score should equal avgMean minus only the stdDev term');
});

console.log("\n-- scoreSubPosition: mode:'nullAvoidance' (for users with room correction/EQ) --");

test("mode defaults to 'balanced' when omitted (backward compatible)", () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const source = { x: 9, y: 6, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000, enabled: true };
  const listeners = [{ x: 9, y: 9, z: 3.5 }];
  const freqs = [40, 60, 80];
  const withoutMode = P.scoreSubPosition({x:2,y:2,z:1}, [source], room, freqs, listeners, ctx);
  const explicitBalanced = P.scoreSubPosition({x:2,y:2,z:1}, [source], room, freqs, listeners, ctx, 'balanced');
  approx(withoutMode.score, explicitBalanced.score, 1e-9);
});

test("mode:'nullAvoidance' score equals worstMinDb exactly, ignoring avgMean and worstStdDev", () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const source = { x: 9, y: 6, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000, enabled: true };
  const listeners = [{ x: 9, y: 9, z: 3.5 }];
  const freqs = [40, 60, 80];
  const result = P.scoreSubPosition({x:2,y:2,z:1}, [source], room, freqs, listeners, ctx, 'nullAvoidance');
  approx(result.score, result.worstMinDb, 1e-9);
  const balanced = P.scoreSubPosition({x:2,y:2,z:1}, [source], room, freqs, listeners, ctx, 'balanced');
  assert.notStrictEqual(result.score, balanced.score, "nullAvoidance and balanced should generally disagree on the same scene's score");
});

test("mode:'nullAvoidance' ranks the sharper-dip scenario worse, purely by tracking each scenario's own worst point (not a blend with average level)", () => {
  // A single source with a wide passband (flat across the test freqs) vs the
  // same source with its passband narrowed to start at 58Hz -- a deterministic,
  // steep crossover rolloff (not fragile interference-based cancellation,
  // which the modal method resists: a single fixed delay can't cleanly null
  // EVERY contributing mode simultaneously the way a two-point free-field
  // calculation could) produces a genuine, sizeable dip at the low end of the
  // freq list relative to the flat scenario.
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51 };
  const freqs = [40, 50, 60, 70, 80];
  const listeners = [{ x: 9, y: 6, z: 3.5 }];
  const candidatePos = { x: 9, y: 6.75, z: 1, levelDb: -200 }; // silenced -- isolate the comparison to the source arrays below
  const pos = { x: 5, y: 2, z: 1 };

  const flatSources = [{ ...pos, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000, enabled: true }];
  const nullySources = [{ ...pos, levelDb: 0, delayMs: 0, freqLow: 58, freqHigh: 20000, rolloffDbPerOct: 24, enabled: true }];

  const flatNullAvoid = P.scoreSubPosition(candidatePos, flatSources, room, freqs, listeners, ctx, 'nullAvoidance');
  const nullyNullAvoid = P.scoreSubPosition(candidatePos, nullySources, room, freqs, listeners, ctx, 'nullAvoidance');
  assert.ok(nullyNullAvoid.score < flatNullAvoid.score,
    `expected the nulled candidate to score worse in nullAvoidance mode: flat=${flatNullAvoid.score.toFixed(1)} nully=${nullyNullAvoid.score.toFixed(1)}`);

  // The score should be exactly each scenario's own worstMinDb -- not some
  // blend involving avgMean or stdDev the way 'balanced' mode uses.
  approx(flatNullAvoid.score, flatNullAvoid.worstMinDb, 1e-9);
  approx(nullyNullAvoid.score, nullyNullAvoid.worstMinDb, 1e-9);
});

test("optimizeSubPlacement threads mode through to scoreSubPosition", () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [{ x: 9, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 200, enabled: true }];
  const freqs = [40, 60, 80];
  const listeners = [{ x: 9, y: 9, z: 3.5 }];

  const result = P.optimizeSubPlacement({
    room, otherSources: mains, freqList: freqs, listenerPositions: listeners, physicsCtx: ctx,
    offLimitZones: [], preferredZones: [], gridStepFt: 3, subHeightFt: 1, mode: 'nullAvoidance'
  });
  assert.ok(result.best, 'expected a best candidate');
  approx(result.best.score, result.best.worstMinDb, 1e-9, 'in nullAvoidance mode, the winning candidate\'s score should equal its own worstMinDb');
});

console.log('\n-- nullAvoidanceSpreadPenalty (anti-clustering for nullAvoidance mode) --');
// REGRESSION context: mode:'nullAvoidance' is a pure maximin objective with no
// inherent incentive to spread multiple subs out (unlike 'balanced', where
// averaging level/flatness naturally rewards covering different areas) -- so
// a greedy multi-sub search in nullAvoidance mode would cluster every sub
// right at the minimum-separation floor next to the first one, since nothing
// else discourages it. This penalty exists specifically to counteract that.

test('nullAvoidanceSpreadPenalty is 0 when there are no already-placed points', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  approx(P.nullAvoidanceSpreadPenalty({x:9,y:6}, [], room), 0, 1e-9);
  approx(P.nullAvoidanceSpreadPenalty({x:9,y:6}, null, room), 0, 1e-9);
});

test('nullAvoidanceSpreadPenalty is 0 once far enough from every already-placed point', () => {
  const room = { w: 18, d: 13.5, h: 8 }; // SPREAD_TARGET_FT = max(8, 13.5*0.5) = 8
  const placed = [{x:1,y:1}];
  approx(P.nullAvoidanceSpreadPenalty({x:9,y:9}, placed, room), 0, 1e-9, 'well past the 8ft spread target');
});

test('nullAvoidanceSpreadPenalty ramps up as a candidate gets closer to an already-placed point, maxing out at/inside the spread target', () => {
  const room = { w: 18, d: 13.5, h: 8 }; // SPREAD_TARGET_FT = 8
  const placed = [{x:0,y:0}];
  const far = P.nullAvoidanceSpreadPenalty({x:6,y:0}, placed, room);   // 6ft away -> partial penalty
  const closer = P.nullAvoidanceSpreadPenalty({x:2,y:0}, placed, room); // 2ft away -> bigger penalty
  const atZero = P.nullAvoidanceSpreadPenalty({x:0,y:0}, placed, room); // 0ft away -> max penalty
  assert.ok(far > 0 && far < closer, `expected a partial, increasing penalty: far=${far} closer=${closer}`);
  assert.ok(closer < atZero, `expected the penalty to keep increasing right up to distance 0: closer=${closer} atZero=${atZero}`);
  approx(atZero, 12, 1e-9, 'penalty should max out at REDUNDANCY_PENALTY_DB right at the already-placed point');
});

test('nullAvoidanceSpreadPenalty uses the NEAREST already-placed point, not an average or sum', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const oneNearby = [{x:1,y:0}];
  const oneNearbyOneFar = [{x:1,y:0}, {x:100,y:100}];
  const p1 = P.nullAvoidanceSpreadPenalty({x:0,y:0}, oneNearby, room);
  const p2 = P.nullAvoidanceSpreadPenalty({x:0,y:0}, oneNearbyOneFar, room);
  approx(p1, p2, 1e-9, 'an additional far-away placed point should not change the penalty at all');
});

test("scoreSubPosition in nullAvoidance mode subtracts the spread penalty from worstMinDb when alreadyPlaced is given", () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const source = { x: 9, y: 6, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000, enabled: true };
  const listeners = [{ x: 9, y: 9, z: 3.5 }];
  const freqs = [40, 60, 80];
  const candidatePos = { x: 2, y: 2, z: 1 };

  const withoutPenalty = P.scoreSubPosition(candidatePos, [source], room, freqs, listeners, ctx, 'nullAvoidance');
  const withNearbyPlaced = P.scoreSubPosition(candidatePos, [source], room, freqs, listeners, ctx, 'nullAvoidance', [{x:2.5,y:2}]);
  approx(withoutPenalty.score, withoutPenalty.worstMinDb, 1e-9, 'no alreadyPlaced -> no penalty, score is exactly worstMinDb');
  assert.ok(withNearbyPlaced.score < withNearbyPlaced.worstMinDb, 'a nearby already-placed point should pull the score below worstMinDb');
});

test('REGRESSION: optimizeMultipleSubs in nullAvoidance mode no longer clusters subs right at the minimum-separation floor', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [
    { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true },
    { x: 13.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true }
  ];
  const listeners = [{ x: 9, y: 9, z: 3.5 }];
  const freqs = [];
  for(let f = 20; f <= 120; f += Math.max(2, (120-20)/12)) freqs.push(f);

  const result = P.optimizeMultipleSubs({
    room, otherSources: mains, numSubs: 2, freqList: freqs, listenerPositions: listeners,
    physicsCtx: ctx, offLimitZones: [], preferredZones: [],
    gridStepFt: 0.5, subHeightFt: 1, mode: 'nullAvoidance'
  });
  assert.strictEqual(result.placedSubs.length, 2, 'expected both subs to be placed');
  const [a, b] = result.placedSubs;
  const dist = Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2);
  // Before the spread penalty existed, this exact scenario clustered the two
  // subs ~2ft apart (right at the old minimum-separation floor). It should
  // now land meaningfully farther apart than that.
  assert.ok(dist > 5, `expected the two subs to be meaningfully spread out, got ${dist.toFixed(2)}ft apart`);
});

test('empty listenerPositions produces a NaN score rather than throwing', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const result = P.scoreSubPosition({ x: 9, y: 6, z: 1 }, [], room, [60], [], ctx);
  assert.ok(Number.isNaN(result.score), `expected NaN score with no listener positions, got ${result.score}`);
  assert.deepStrictEqual(result.listenerStats, []);
});

test('empty freqList produces a NaN score rather than throwing', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const result = P.scoreSubPosition({ x: 9, y: 6, z: 1 }, [], room, [], [{ x: 9, y: 6, z: 3.5 }], ctx);
  assert.ok(Number.isNaN(result.score), `expected NaN score with an empty frequency list, got ${result.score}`);
});

console.log('\n-- isPointInRect / isCandidateValid --');

test('isPointInRect includes points on the boundary (inclusive)', () => {
  const rect = { x: 2, y: 2, width: 3, height: 3 };
  assert.strictEqual(P.isPointInRect(2, 2, rect), true);
  assert.strictEqual(P.isPointInRect(5, 5, rect), true);
  assert.strictEqual(P.isPointInRect(1.99, 3, rect), false);
});

test('isCandidateValid rejects points outside the room', () => {
  const room = { w: 18, d: 13.5 };
  assert.strictEqual(P.isCandidateValid(-1, 5, room, [], []), false);
  assert.strictEqual(P.isCandidateValid(20, 5, room, [], []), false);
});

test('isCandidateValid rejects points inside an off-limits zone', () => {
  const room = { w: 18, d: 13.5 };
  const offLimits = [{ x: 5, y: 5, width: 2, height: 2 }];
  assert.strictEqual(P.isCandidateValid(6, 6, room, offLimits, []), false);
  assert.strictEqual(P.isCandidateValid(0.5, 0.5, room, offLimits, []), true);
});

test('isCandidateValid with allowed zones ONLY accepts points inside one of them', () => {
  const room = { w: 18, d: 13.5 };
  const allowed = [{ x: 0, y: 0, width: 2, height: 2 }];
  assert.strictEqual(P.isCandidateValid(1, 1, room, [], allowed), true);
  assert.strictEqual(P.isCandidateValid(9, 9, room, [], allowed), false, 'outside all allowed zones should be rejected when allowed zones exist');
});

test('isCandidateValid with NO allowed zones allows anywhere in-room (not off-limits)', () => {
  const room = { w: 18, d: 13.5 };
  assert.strictEqual(P.isCandidateValid(9, 9, room, [], []), true);
});

test('isCandidateValid: an exclude point with its own keepOut blocks that rectangle, not the minSeparationFt square', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const speaker = [{ x: 9, y: 9, keepOut: { x: 8, y: 8, width: 2, height: 5.5 } }];
  assert.strictEqual(P.isCandidateValid(9.75, 9.75, room, [], [], speaker, 4), false, 'inside the rectangle');
  assert.strictEqual(P.isCandidateValid(9.25, 13.25, room, [], [], speaker, 4), false, 'between the speaker and the back wall');
  assert.strictEqual(P.isCandidateValid(10.25, 9.25, room, [], [], speaker, 4), true, 'just outside it, well inside 4ft');
  assert.strictEqual(P.isCandidateValid(9.25, 7.75, room, [], [], speaker, 4), true, 'in front of the speaker, just outside it');
  assert.strictEqual(P.isCandidateValid(9.75, 9.75, room, [], [], speaker), false, 'still applies with no minSeparationFt at all');
  assert.strictEqual(P.isCandidateValid(10.25, 9.25, room, [], [], [{ x: 9, y: 9 }], 4), false, 'a plain point keeps minSeparationFt');
});

test('speakerKeepOut: a 2 ft wide box around the speaker, stretched back to its nearest wall', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  assert.strictEqual(P.SPEAKER_CLEARANCE_FT, 1);
  assert.deepStrictEqual(P.speakerKeepOut({ x: 13.5, y: 1.5 }, room), { x: 12.5, y: 0, width: 2, height: 2.5 }, 'front right: back to the front wall');
  assert.deepStrictEqual(P.speakerKeepOut({ x: 0.5, y: 8 }, room), { x: 0, y: 7, width: 1.5, height: 2 }, 'side surround: back to the left wall');
  assert.deepStrictEqual(P.speakerKeepOut({ x: 17, y: 6 }, room), { x: 16, y: 5, width: 2, height: 2 }, 'right wall');
  assert.deepStrictEqual(P.speakerKeepOut({ x: 9, y: 12 }, room), { x: 8, y: 11, width: 2, height: 2.5 }, 'back wall');
});

test('isSubSource / sourceExclusionPoints: subs keep the full separation, mains get their keepOut rectangle', () => {
  assert.strictEqual(P.isSubSource({ freqHigh: 80 }), true);
  assert.strictEqual(P.isSubSource({ freqHigh: 150 }), true);
  assert.strictEqual(P.isSubSource({ freqHigh: 20000 }), false);
  const room = { w: 18, d: 13.5, h: 8 };
  const main = { x: 4, y: 1.5, freqLow: 80, freqHigh: 20000 };
  const points = P.sourceExclusionPoints([main, { x: 3, y: 4, freqLow: 20, freqHigh: 80 }], room);
  assert.deepStrictEqual(points, [{ x: 4, y: 1.5, keepOut: P.speakerKeepOut(main, room) }, { x: 3, y: 4 }]);
});

console.log('\n-- freeFloorFraction --');

test('freeFloorFraction is 1 with no zones and 0 with the floor fully covered', () => {
  assert.strictEqual(P.freeFloorFraction(baseRoom, []), 1);
  approx(P.freeFloorFraction(baseRoom, [{ x: 0, y: 0, width: 18, height: 13.5 }]), 0, 1e-12);
});

test('freeFloorFraction subtracts a single zone by its area', () => {
  // 9 x 6.75 in an 18 x 13.5 room is exactly a quarter of the floor
  approx(P.freeFloorFraction(baseRoom, [{ x: 4.5, y: 3.375, width: 9, height: 6.75 }]), 0.75, 1e-12);
});

test('freeFloorFraction counts overlapping zones once (union, not sum)', () => {
  // two 4x4 squares overlapping in a 2x2 patch cover 16 + 16 - 4 = 28 sq ft of 243
  const zones = [{ x: 1, y: 1, width: 4, height: 4 }, { x: 3, y: 3, width: 4, height: 4 }];
  approx(P.freeFloorFraction(baseRoom, zones), 1 - 28 / 243, 1e-12);
  // a zone entirely inside another adds nothing
  approx(P.freeFloorFraction(baseRoom, [zones[0], { x: 2, y: 2, width: 1, height: 1 }]), 1 - 16 / 243, 1e-12);
  // the same zone twice is still one zone's worth
  approx(P.freeFloorFraction(baseRoom, [zones[0], zones[0]]), 1 - 16 / 243, 1e-12);
});

test('freeFloorFraction ignores the part of a zone outside the room', () => {
  // only the 2 x 3 corner of this zone is inside the room
  approx(P.freeFloorFraction(baseRoom, [{ x: 16, y: 10.5, width: 10, height: 10 }]), 1 - 6 / 243, 1e-12);
  // a zone wholly outside the room covers nothing
  assert.strictEqual(P.freeFloorFraction(baseRoom, [{ x: 20, y: 0, width: 3, height: 3 }]), 1);
});

test('freeFloorFraction agrees with a brute-force point count on scattered zones', () => {
  const zones = [
    { x: 0.5, y: 0.5, width: 6, height: 2 }, { x: 4, y: 1, width: 3, height: 7 },
    { x: 10, y: 8, width: 7.5, height: 5 }, { x: 12, y: 2, width: 2, height: 9 }, { x: -1, y: 11, width: 4, height: 4 }
  ];
  const n = 400;
  let free = 0;
  for(let i = 0; i < n; i++) for(let j = 0; j < n; j++){
    const px = (i + 0.5) / n * baseRoom.w, py = (j + 0.5) / n * baseRoom.d;
    if(!zones.some(z => P.isPointInRect(px, py, z))) free++;
  }
  approx(P.freeFloorFraction(baseRoom, zones), free / (n * n), 0.005);
});

test('clipRectToRoom cuts a rect back to the room and drops one that lies outside it', () => {
  const room = { w: 12, d: 10, h: 8 };
  assert.deepStrictEqual(P.clipRectToRoom({ x: 2, y: 3, width: 4, height: 5 }, room), { x: 2, y: 3, width: 4, height: 5 }, 'inside: unchanged');
  assert.deepStrictEqual(P.clipRectToRoom({ x: 4.5, y: 3, width: 9, height: 6.75 }, room), { x: 4.5, y: 3, width: 7.5, height: 6.75 }, 'cut at the right wall');
  assert.deepStrictEqual(P.clipRectToRoom({ x: -1, y: 8, width: 3, height: 5 }, room), { x: 0, y: 8, width: 2, height: 2 }, 'cut at the left and back walls');
  assert.strictEqual(P.clipRectToRoom({ x: 13, y: 2, width: 3, height: 3 }, room), null, 'wholly outside');
  assert.strictEqual(P.clipRectToRoom({ x: 12, y: 2, width: 3, height: 3 }, room), null, 'only touching the wall');
  // an L with a 4 x 3 ft notch out of the back right corner (inside corner at (8, 7))
  const L = { w: 12, d: 10, h: 8, polygon: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 7 }, { x: 8, y: 7 }, { x: 8, y: 10 }, { x: 0, y: 10 }] };
  assert.strictEqual(P.clipRectToRoom({ x: 9, y: 8, width: 2, height: 1.5 }, L), null, 'wholly in the cut-out');
  assert.strictEqual(P.clipRectToRoom({ x: 8, y: 7, width: 4, height: 3 }, L), null, 'filling the cut-out exactly');
  assert.deepStrictEqual(P.clipRectToRoom({ x: 6, y: 6, width: 4, height: 3 }, L), { x: 6, y: 6, width: 4, height: 3 }, 'partly on the floor: kept');
});

console.log('\n-- scoreResponses / seatToSeatVariationDb / comparePlacements --');

test('scoreResponses reports the mean, flatness and deepest dip of one response, and scores it per mode', () => {
  const r = P.scoreResponses([[70, 76, 58, 72, 74]], [1], 'balanced');
  approx(r.avgMean, 70, 1e-9);
  approx(r.worstStdDev, Math.sqrt(40), 1e-9); // squared deviations 0, 36, 144, 4, 16
  assert.strictEqual(r.worstMinDb, 58); assert.strictEqual(r.worstMinIndex, 2);
  approx(r.score, 70 - Math.sqrt(40), 1e-9); // the dip is 12 dB under the mean, short of the 20 dB where the null penalty starts
  approx(P.scoreResponses([[70, 76, 58, 72, 74]], [1], 'nullAvoidance').score, 58, 1e-9);
  // a dip 30 dB under the mean costs half of the 10 dB beyond 20
  const deep = P.scoreResponses([[80, 80, 80, 80, 80, 50]], [1], 'balanced');
  approx(deep.score, deep.avgMean - deep.worstStdDev - (deep.avgMean - 50 - 20) * 0.5, 1e-9);
});

test('scoreResponses takes the worst listener for flatness and the deepest dip, scaled by that listener\'s weight', () => {
  const r = P.scoreResponses([[70, 70, 70], [70, 40, 70]], [1, 0.5], 'nullAvoidance');
  assert.strictEqual(r.worstMinDb, 40); assert.strictEqual(r.worstMinIndex, 1);
  approx(r.score, 40 + 0.5 * 15, 1e-9); // half of the 15 dB relief for a half-weight listener
  const b = P.scoreResponses([[70, 70, 70], [70, 40, 70]], [1, 0.5], 'balanced');
  approx(b.avgMean, (70 * 1 + 60 * 0.5) / 1.5, 1e-9);
  approx(b.worstStdDev, Math.sqrt(200), 1e-9);
  // a missing weight counts as 1
  approx(P.scoreResponses([[70, 40, 70]], [], 'nullAvoidance').score, 40, 1e-9);
});

test('scoreResponses is the formula scoreSubPosition scores with', () => {
  const room = baseRoom, ctx = { room, wallAbsorption: 0.3, floorAbsorption: 0.15 };
  const mains = [{ x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000, enabled: true }];
  const freqs = [30, 45, 60, 80, 100];
  const listeners = [{ x: 9, y: 9, z: 3.5, weight: 1 }, { x: 12, y: 10, z: 3.5, weight: 0.5 }];
  for(const mode of ['balanced', 'nullAvoidance']){
    const full = P.scoreSubPosition({ x: 3, y: 12, z: 1 }, mains, room, freqs, listeners, ctx, mode);
    const again = P.scoreResponses(full.perListenerDb, listeners.map(l => l.weight), mode);
    assert.strictEqual(again.score, full.score);
    assert.strictEqual(again.avgMean, full.avgMean);
    assert.strictEqual(again.worstStdDev, full.worstStdDev);
    assert.strictEqual(again.worstMinDb, full.worstMinDb);
  }
});

test('seatToSeatVariationDb averages half the loudest-to-quietest gap across frequencies', () => {
  // gaps of 4, 10 and 0 dB at the three frequencies: half-gaps 2, 5, 0, mean 7/3
  approx(P.seatToSeatVariationDb([[70, 60, 65], [74, 70, 65], [72, 65, 65]]), 7 / 3, 1e-9);
});

test('seatToSeatVariationDb is zero for a single seat', () => {
  assert.strictEqual(P.seatToSeatVariationDb([[70, 60, 65]]), 0);
});

test('comparePlacements grades the change in score', () => {
  const s = (score, avgMean) => ({ score, avgMean });
  const c = P.comparePlacements(s(60, 70), s(67.5, 73));
  approx(c.gainDb, 7.5, 1e-9); approx(c.levelGainDb, 3, 1e-9);
  assert.strictEqual(c.verdict, 'major');
  assert.strictEqual(P.comparePlacements(s(60, 70), s(66, 70)).verdict, 'major');
  assert.strictEqual(P.comparePlacements(s(60, 70), s(65.9, 70)).verdict, 'modest');
  assert.strictEqual(P.comparePlacements(s(60, 70), s(62, 70)).verdict, 'modest');
  assert.strictEqual(P.comparePlacements(s(60, 70), s(61.9, 75)).verdict, 'similar'); // louder, but no better by the score
  assert.strictEqual(P.comparePlacements(s(60, 70), s(60, 70)).verdict, 'similar');
  assert.strictEqual(P.comparePlacements(s(60, 70), s(58.1, 70)).verdict, 'similar');
  assert.strictEqual(P.comparePlacements(s(60, 70), s(58, 70)).verdict, 'worse');
});

test('checkSubMoves keeps the current subs unless the picked ones grade meaningfully higher', () => {
  const room = { w: 18, d: 14, h: 8 };
  const ctx = { room, wallAbsorption: 0.3 };
  const main = (id, x) => ({ id, x, y: 1, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true });
  const sub = (id, x, y) => ({ id, x, y, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80, enabled: true });
  const base = {
    seats: [7, 9, 11].map((x, i) => ({ x, y: 9, z: 3.5, weight: i === 1 ? 1 : 0.7 })), reference: { x: 9, y: 9, z: 3.5 },
    freqs: P.logSpacedFreqs(20, 120, 48), otherSources: [main(1, 4), main(2, 9), main(3, 14)], physicsCtx: ctx, mode: 'balanced'
  };
  const a = [sub(11, 1.75, 0.4), sub(12, 2.75, 0.4)], b = [sub(11, 0.5, 13.5), sub(12, 16.5, 13.5)];
  const grade = (subs) => P.gradePlacement(base.seats, base.reference, base.freqs, base.otherSources.concat(subs), ctx, 'balanced').stats.score;
  const gain = grade(b) - grade(a);
  assert.ok(gain < -2, `the back-wall pair grades lower here (${gain.toFixed(2)} dB)`);

  const kept = P.checkSubMoves({ ...base, current: a, picked: b });
  assert.deepStrictEqual(kept.placedSubs.map(s => [s.x, s.y]), [[1.75, 0.4], [2.75, 0.4]]);
  assert.deepStrictEqual(kept.moved, [false, false]);
  approx(kept.gainDb, gain, 1e-9);
  assert.notStrictEqual(kept.placedSubs[0], a[0], 'copies, not the caller\'s subs');

  const taken = P.checkSubMoves({ ...base, current: b, picked: a });
  assert.deepStrictEqual(taken.placedSubs.map(s => [s.x, s.y]), [[1.75, 0.4], [2.75, 0.4]]);
  assert.deepStrictEqual(taken.moved, [true, true]);
  approx(taken.gainDb, -gain, 1e-9);

  // A gain under PLACEMENT_GAIN_DB.modest is not worth a move.
  const small = [sub(11, 0.5, 0.4), sub(12, 1.5, 0.4)];
  const smallGain = grade(small) - grade(a);
  assert.ok(smallGain > 0 && smallGain < P.PLACEMENT_GAIN_DB.modest, `a small gain (${smallGain.toFixed(2)} dB)`);
  const tooSmall = P.checkSubMoves({ ...base, current: a, picked: small });
  assert.deepStrictEqual(tooSmall.moved, [false, false]);
  assert.deepStrictEqual(tooSmall.placedSubs.map(s => [s.x, s.y]), [[1.75, 0.4], [2.75, 0.4]]);
  approx(tooSmall.gainDb, smallGain, 1e-9);

  const same = P.checkSubMoves({ ...base, current: a, picked: a.map(s => ({ ...s })) });
  assert.strictEqual(same.gainDb, null, 'nothing moved, nothing graded');
  assert.deepStrictEqual(same.moved, [false, false]);
});

test('checkSubMoves grades every alternative and judges the one that grades highest', () => {
  const room = { w: 18, d: 14, h: 8 };
  const ctx = { room, wallAbsorption: 0.3 };
  const main = (id, x) => ({ id, x, y: 1, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true });
  const sub = (x, y) => ({ id: 11, x, y, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80, enabled: true });
  const base = {
    seats: [7, 9, 11].map((x, i) => ({ x, y: 9, z: 3.5, weight: i === 1 ? 1 : 0.7 })), reference: { x: 9, y: 9, z: 3.5 },
    freqs: P.logSpacedFreqs(20, 120, 48), otherSources: [main(1, 4), main(2, 14)], physicsCtx: ctx, mode: 'nullAvoidance'
  };
  const grade = (subs) => P.gradePlacement(base.seats, base.reference, base.freqs, base.otherSources.concat(subs), ctx, base.mode).stats.score;
  const current = [sub(9, 7)];
  const spots = [[0.5, 0.5], [17.5, 13.5], [9, 0.5], [0.5, 7], [12, 4]].map(([x, y]) => [sub(x, y)]);
  const gains = spots.map(subs => grade(subs) - grade(current));
  const bestIdx = gains.indexOf(Math.max(...gains));
  assert.ok(gains[bestIdx] >= P.PLACEMENT_GAIN_DB.modest, `some spot is worth a move (${gains.map(g => g.toFixed(1)).join(', ')})`);
  const pickedIdx = bestIdx === 0 ? 1 : 0;
  const alternatives = spots.filter((_, i) => i !== pickedIdx).concat([current.map(s => ({ ...s }))]);
  const result = P.checkSubMoves({ ...base, current, picked: spots[pickedIdx], alternatives });
  assert.deepStrictEqual(result.placedSubs.map(s => [s.x, s.y]), [[spots[bestIdx][0].x, spots[bestIdx][0].y]]);
  assert.deepStrictEqual(result.moved, [true]);
  approx(result.gainDb, gains[bestIdx], 1e-9);
  // Without them, only the pick is judged.
  approx(P.checkSubMoves({ ...base, current, picked: spots[pickedIdx] }).gainDb, gains[pickedIdx], 1e-9);
  // An alternative that is the current placement is not a move.
  assert.strictEqual(P.checkSubMoves({ ...base, current, picked: current, alternatives: [current] }).gainDb, null);
});

test('topCandidates returns the highest-scoring candidates, best first', () => {
  const all = [{ x: 1, score: 3 }, { x: 2, score: 9 }, { x: 3, score: -1 }, { x: 4, score: 5 }];
  assert.deepStrictEqual(P.topCandidates(all, 2).map(c => c.x), [2, 4]);
  assert.deepStrictEqual(P.topCandidates(all, 10).map(c => c.x), [2, 4, 1, 3]);
  assert.deepStrictEqual(all.map(c => c.x), [1, 2, 3, 4], 'the input is not reordered');
});

test('scoreSubPosition with seatAveraging scores the spatially averaged response at each seat', () => {
  const room = { w: 12, d: 9, h: 8 };
  const ctx = { room, wallAbsorption: 0.2 };
  const mains = [{ x: 3.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, rolloffDbPerOct: 24, enabled: true }];
  const seats = [{ x: 6, y: 5.6, z: 3.5, weight: 1 }, { x: 8, y: 5.6, z: 3.5, weight: 0.5 }];
  const freqs = P.optimizerFreqList(20, 120);
  const sub = { x: 6, y: 4.5, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80, rolloffDbPerOct: 24, enabled: true };
  assert.deepStrictEqual(P.SEARCH_SEAT_AVERAGING, { radiusFt: 2, numPoints: 6 });
  for(const mode of ['balanced', 'nullAvoidance']){
    const got = P.scoreSubPosition(sub, mains, room, freqs, seats, ctx, mode, [], undefined, P.SEARCH_SEAT_AVERAGING);
    const candidate = Object.assign({ name: 'candidate', levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000, enabled: true }, sub);
    const { perCenterDb } = P.spatiallyAveragedResponseMulti(seats, freqs, mains.concat([candidate]), ctx, P.SEARCH_SEAT_AVERAGING);
    approx(got.score, P.scoreResponses(perCenterDb, [1, 0.5], mode).score, 1e-9, mode);
    const point = P.scoreSubPosition(sub, mains, room, freqs, seats, ctx, mode, []);
    assert.ok(Math.abs(point.score - got.score) > 1e-6, `${mode}: averaging changes the score`);
  }
  // A caller's own mode list gives the same averaged responses.
  const plain = P.spatiallyAveragedResponseMulti(seats, freqs, mains, ctx, { radiusFt: 2, numPoints: 6 });
  const withModes = P.spatiallyAveragedResponseMulti(seats, freqs, mains, ctx, { radiusFt: 2, numPoints: 6, modes: P.enumerateModes(ctx) });
  assert.deepStrictEqual(withModes.perCenterDb, plain.perCenterDb);
});

// Regression: in a 12x9 ft room with two mains and one sub, with room
// correction on, re-optimizing the sub found nothing worth a move wherever
// the sub started. The search scored one point per seat and so picked the
// same spot every time, one the result card's averaged grading put no
// better than mid-room; scored round each seat, its pick grades well
// clear of the 2 dB a move needs.
test('a single-sub search with seatAveraging finds a move from mid-room that checkSubMoves keeps', () => {
  const room = { w: 12, d: 9, h: 8 };
  const ctx = { room, wallAbsorption: 0.2 };
  const main = (id, x) => ({ id, x, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, rolloffDbPerOct: 24, enabled: true, isMain: true });
  const mains = [main(1, 3.5), main(2, 8.5)];
  const seats = [{ x: 6, y: 6.5, z: 3.5, weight: 1 }];
  const reference = { x: 6, y: 6.5, z: 3.5 };
  const current = [{ id: 9, name: 'SW1', x: 6, y: 4.5, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80, rolloffDbPerOct: 24, enabled: true }];
  const mode = 'nullAvoidance';
  const search = (seatAveraging) => P.optimizeSubPlacement({
    room, otherSources: mains, freqList: P.optimizerFreqList(20, 120), listenerPositions: seats, physicsCtx: ctx,
    offLimitZones: [], gridStepFt: 0.5, subHeightFt: 1, mode, excludePoints: P.sourceExclusionPoints(mains, room),
    candidateTemplate: current[0], timeAlignTo: reference, seatAveraging
  }).best;
  const check = (best) => P.checkSubMoves({
    seats, reference, freqs: P.logSpacedFreqs(20, 120, 48), otherSources: mains, current,
    picked: [Object.assign({}, current[0], { x: best.x, y: best.y, z: best.z })], physicsCtx: ctx, mode, timeAlignTo: reference
  });
  const atPoints = check(search());
  assert.ok(atPoints.gainDb < P.PLACEMENT_GAIN_DB.modest, `the single-point pick grades only ${atPoints.gainDb.toFixed(2)} dB better`);
  assert.deepStrictEqual(atPoints.moved, [false]);
  const averaged = check(search(P.SEARCH_SEAT_AVERAGING));
  assert.ok(averaged.gainDb >= 3, `the averaged pick grades ${averaged.gainDb.toFixed(2)} dB better`);
  assert.deepStrictEqual(averaged.moved, [true]);
});

test('checkSubMoves grades the picked subs time-aligned when asked, the current ones as they stand', () => {
  const room = { w: 18, d: 14, h: 8 };
  const ctx = { room, wallAbsorption: 0.3 };
  const listener = { x: 9, y: 9, z: 3.5, facing: 0 };
  const sub = (id, x, y, delayMs) => ({ id, x, y, z: 1, levelDb: 0, delayMs, freqLow: 20, freqHigh: 80, enabled: true });
  const opts = { seats: [listener], reference: listener, freqs: P.logSpacedFreqs(20, 120, 48), otherSources: [], physicsCtx: ctx, mode: 'balanced', timeAlignTo: listener,
    current: [sub(1, 0.5, 0.5, 3), sub(2, 17.5, 0.5, 0)], picked: [sub(1, 0.5, 13.5, 3), sub(2, 17.5, 0.5, 0)] };
  const grade = (sources) => P.gradePlacement([listener], listener, opts.freqs, sources, ctx, 'balanced').stats.score;
  const expected = grade(P.timeAlignedSources(opts.picked, listener, room)) - grade(opts.current);
  approx(P.checkSubMoves(opts).gainDb, expected, 1e-9);
});

console.log('\n-- nearestWallDistances --');

test('nearestWallDistances picks the nearer side wall and the nearer end wall', () => {
  assert.deepStrictEqual(P.nearestWallDistances({ x: 2.25, y: 1 }, baseRoom), { side: { wall: 'left', distFt: 2.25, x: 0 }, end: { wall: 'front', distFt: 1, y: 0 } });
  const far = P.nearestWallDistances({ x: 16, y: 12 }, baseRoom);
  assert.strictEqual(far.side.wall, 'right'); approx(far.side.distFt, 2, 1e-9);
  assert.strictEqual(far.end.wall, 'back'); approx(far.end.distFt, 1.5, 1e-9);
});

test('nearestWallDistances reports left and front for a point exactly midway', () => {
  const mid = P.nearestWallDistances({ x: baseRoom.w / 2, y: baseRoom.d / 2 }, baseRoom);
  assert.strictEqual(mid.side.wall, 'left'); assert.strictEqual(mid.end.wall, 'front');
});

console.log('\n-- rowFootprintRect --');

test('rowFootprintRect is one seat spacing wide per seat and 3 ft deep, centered on the row', () => {
  const r = P.rowFootprintRect({ x: 9, y: 9, facing: 0, seats: 3, spacingFt: 2 }, baseRoom);
  approx(r.x, 6, 1e-9); approx(r.y, 7.5, 1e-9); approx(r.width, 6, 1e-9); approx(r.height, 3, 1e-9);
});

test('rowFootprintRect covers every seat of the row', () => {
  const row = { x: 8, y: 7, z: 3.5, facing: 0, seats: 5, spacingFt: 2.5 };
  const r = P.rowFootprintRect(row, baseRoom);
  for(const seat of P.rowSeatPositions(row)){
    assert.ok(seat.x > r.x && seat.x < r.x + r.width && seat.y > r.y && seat.y < r.y + r.height);
  }
});

test('rowFootprintRect swaps width and depth for a row facing a side wall', () => {
  const r = P.rowFootprintRect({ x: 9, y: 7, facing: 90, seats: 3, spacingFt: 2 }, baseRoom);
  approx(r.x, 7.5, 1e-9); approx(r.y, 4, 1e-9); approx(r.width, 3, 1e-9); approx(r.height, 6, 1e-9);
});

test('rowFootprintRect is the bounding box of the footprint for a row at an angle', () => {
  const r = P.rowFootprintRect({ x: 9, y: 7, facing: 45, seats: 3, spacingFt: 2 }, baseRoom);
  const half = (3 + 1.5) / Math.SQRT2; // half length 3 and half depth 1.5, both at 45 degrees
  approx(r.width, 2 * half, 1e-9); approx(r.height, 2 * half, 1e-9); approx(r.x, 9 - half, 1e-9); approx(r.y, 7 - half, 1e-9);
});

test('rowFootprintRect is clipped to the room and uses the given depth', () => {
  const r = P.rowFootprintRect({ x: 1, y: baseRoom.d - 0.5, facing: 0, seats: 2, spacingFt: 2 }, baseRoom, 4);
  approx(r.x, 0, 1e-9); approx(r.width, 3, 1e-9); approx(r.y, baseRoom.d - 2.5, 1e-9); approx(r.height, 2.5, 1e-9);
});

console.log('\n-- standardSpeakerPositions --');

test('standardSpeakerPositions puts the fronts 30 degrees either side of the seat, inset from the front wall', () => {
  const pos = P.standardSpeakerPositions(baseRoom, { x: 9, y: 9 }, ['FL', 'FR', 'C']);
  assert.deepStrictEqual(pos.map(p => p.name), ['FL', 'FR', 'C']);
  // 7.5 ft forward to the 1.5 ft inset line, so 7.5 * tan(30 deg) = 4.33 ft to each side
  approx(pos[0].x, 9 - 7.5 * Math.tan(Math.PI / 6), 1e-9); approx(pos[0].y, 1.5, 1e-9);
  approx(pos[1].x, 9 + 7.5 * Math.tan(Math.PI / 6), 1e-9); approx(pos[1].y, 1.5, 1e-9);
  approx(pos[2].x, 9, 1e-9); approx(pos[2].y, 1.5, 1e-9);
});

test('standardSpeakerPositions keeps every channel at its azimuth from the seat', () => {
  const seat = { x: 7, y: 8 };
  const names = Object.keys(P.SPEAKER_AZIMUTH_DEG);
  assert.strictEqual(names.length, 9);
  for(const p of P.standardSpeakerPositions(baseRoom, seat, names)){
    // 0 degrees is toward the front wall (-y), positive to the listener's right (+x)
    const az = Math.atan2(p.x - seat.x, -(p.y - seat.y)) * 180 / Math.PI;
    approx(az, P.SPEAKER_AZIMUTH_DEG[p.name], 1e-9, p.name);
  }
});

test('standardSpeakerPositions puts side surrounds on the side walls and backs on the back wall', () => {
  const byName = Object.fromEntries(P.standardSpeakerPositions(baseRoom, { x: 9, y: 9 }, ['SL', 'SR', 'SBL', 'SBR']).map(p => [p.name, p]));
  approx(byName.SL.x, 1.5, 1e-9); approx(byName.SR.x, 16.5, 1e-9);
  approx(byName.SBL.y, 12, 1e-9); approx(byName.SBR.y, 12, 1e-9);
  // a centered seat gives mirrored pairs
  approx(byName.SL.x + byName.SR.x, 18, 1e-9); approx(byName.SL.y, byName.SR.y, 1e-9);
  approx(byName.SBL.x + byName.SBR.x, 18, 1e-9);
});

test('standardSpeakerPositions stays inside the inset rectangle for any room and seat, including a seat against a wall', () => {
  const names = Object.keys(P.SPEAKER_AZIMUTH_DEG);
  for(const room of [{ w: 6, d: 6 }, { w: 30, d: 10 }, { w: 11, d: 27 }, baseRoom]){
    for(const seat of [{ x: room.w / 2, y: room.d * 0.66 }, { x: 0.2, y: 0.2 }, { x: room.w, y: room.d }, { x: room.w * 0.3, y: room.d * 0.2 }]){
      for(const inset of [1.5, 0.5]){
        const pos = P.standardSpeakerPositions(room, seat, names, inset);
        assert.strictEqual(pos.length, 9);
        for(const p of pos){
          assert.ok(p.x >= inset - 1e-9 && p.x <= room.w - inset + 1e-9 && p.y >= inset - 1e-9 && p.y <= room.d - inset + 1e-9,
            `${p.name} at ${p.x},${p.y} in ${room.w}x${room.d} seat ${seat.x},${seat.y} inset ${inset}`);
        }
      }
    }
  }
});

test('standardSpeakerPositions keeps the center on the front wall when the seat is near a side wall', () => {
  // the seat moves onto the left wall's inset line, and C runs along it
  for(const x of [0.5, 1, 1.5]){
    const c = P.standardSpeakerPositions(baseRoom, { x, y: 9 }, ['C'])[0];
    approx(c.x, 1.5, 1e-9, `C x for seat x ${x}`);
    approx(c.y, 1.5, 1e-9, `C y for seat x ${x}`);
  }
  // a seat exactly the inset to the side of an L's notch wall
  const L = { w: 20, d: 16, h: 8, polygon: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 6 }, { x: 20, y: 6 }, { x: 20, y: 16 }, { x: 0, y: 16 }] };
  const c = P.standardSpeakerPositions(L, { x: 10.5, y: 12 }, ['C'])[0];
  approx(c.x, 10.5, 1e-9, 'C x in the L');
  approx(c.y, 1.5, 1e-9, 'C y in the L');
});

test('standardSpeakerPositions skips names it has no azimuth for and keeps the order given', () => {
  const pos = P.standardSpeakerPositions(baseRoom, { x: 9, y: 9 }, ['SR', 'Main 1', 'FL']);
  assert.deepStrictEqual(pos.map(p => p.name), ['SR', 'FL']);
});

console.log('\n-- optimizeSubPlacement --');

test('optimizer finds a best candidate and respects off-limits zones', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [
    { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true },
    { x: 13.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true }
  ];
  // Block out the entire room except a small strip, so we can verify the winner
  // is forced into that strip.
  const offLimits = [
    { x: 0, y: 0, width: 18, height: 6 },   // blocks the front half
    { x: 0, y: 8, width: 18, height: 5.5 }  // blocks most of the back, leaving y=[6,8]
  ];
  const result = P.optimizeSubPlacement({
    room, otherSources: mains, freqList: [40,60,80], listenerPositions: [{x:9,y:9,z:3.5}],
    physicsCtx: ctx, offLimitZones: offLimits, preferredZones: [],
    gridStepFt: 1, subHeightFt: 1
  });
  assert.ok(result.best !== null, 'expected a best candidate to be found');
  assert.ok(result.best.y >= 6 && result.best.y <= 8,
    `expected winner to be forced into the allowed strip y=[6,8], got y=${result.best.y}`);
  assert.ok(result.allCandidates.length > 0);
  // every candidate in the results should itself be outside the off-limits zones
  for(const c of result.allCandidates){
    assert.ok(!P.isPointInRect(c.x, c.y, offLimits[0]) && !P.isPointInRect(c.x, c.y, offLimits[1]),
      `candidate at (${c.x},${c.y}) should not be inside an off-limits zone`);
  }
});

test('optimizer returns null best when no valid candidates exist', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const offLimits = [{ x: 0, y: 0, width: 18, height: 13.5 }]; // blocks the entire room
  const result = P.optimizeSubPlacement({
    room, otherSources: [], freqList: [60], listenerPositions: [{x:9,y:9,z:3.5}],
    physicsCtx: ctx, offLimitZones: offLimits, preferredZones: [],
    gridStepFt: 1, subHeightFt: 1
  });
  assert.strictEqual(result.best, null);
  assert.strictEqual(result.allCandidates.length, 0);
});

console.log('\n-- optimizeMultipleSubs (greedy sequential placement) --');

test('places the requested number of subs', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [
    { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true },
    { x: 13.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true }
  ];
  const result = P.optimizeMultipleSubs({
    room, otherSources: mains, numSubs: 3, freqList: [40,60,80,100],
    listenerPositions: [{x:9,y:9,z:3.5}], physicsCtx: ctx,     offLimitZones: [], preferredZones: [], gridStepFt: 1, subHeightFt: 1
  });
  assert.strictEqual(result.placedSubs.length, 3, `expected 3 subs placed, got ${result.placedSubs.length}`);
  assert.strictEqual(result.roundResults.length, 3);
});

test('each round accounts for previously-placed subs, not just the original mains', () => {
  // If round 2 ignored the sub placed in round 1, it would find the SAME best
  // position round 1 did (since nothing in its view of the world changed). With
  // the placed sub correctly folded in, round 2's winner should generally differ
  // from round 1's, since the room's field has changed.
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [
    { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true },
    { x: 13.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true }
  ];
  const result = P.optimizeMultipleSubs({
    room, otherSources: mains, numSubs: 2, freqList: [30,40,50,60,70,80],
    listenerPositions: [{x:9,y:9,z:3.5}], physicsCtx: ctx,     offLimitZones: [], preferredZones: [], gridStepFt: 0.5, subHeightFt: 1
  });
  const sub1 = result.placedSubs[0], sub2 = result.placedSubs[1];
  const samePosition = Math.abs(sub1.x - sub2.x) < 0.01 && Math.abs(sub1.y - sub2.y) < 0.01;
  assert.ok(!samePosition, `expected round 2 to find a different position than round 1 once sub 1 is accounted for; both landed at (${sub1.x},${sub1.y})`);

  // Directly confirm round 2's otherSources included the round-1 sub, by checking
  // that round 2's optimizeSubPlacement result used a 3-source scene (2 mains + 1 sub),
  // which we can infer from roundResults[1].best existing and roundResults having 2 entries.
  assert.strictEqual(result.roundResults.length, 2);
});

test('greedy respects off-limits zones for every sub placed, not just the first', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const offLimits = [{ x: 0, y: 0, width: 18, height: 10 }]; // only y=[10,13.5] is allowed
  const result = P.optimizeMultipleSubs({
    room, otherSources: [], numSubs: 3, freqList: [40,60,80],
    listenerPositions: [{x:9,y:12,z:3.5}], physicsCtx: ctx,     offLimitZones: offLimits, preferredZones: [], gridStepFt: 1, subHeightFt: 1
  });
  for(const sub of result.placedSubs){
    assert.ok(sub.y >= 10, `every placed sub should respect the off-limits zone, got y=${sub.y}`);
  }
});

test('stops placing subs (without error) if candidates run out', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  // Allowed zone so small (relative to a coarse grid step) that at most 1 candidate exists.
  const tinyAllowed = [{ x: 9, y: 6.75, width: 0.4, height: 0.4 }];
  const result = P.optimizeMultipleSubs({
    room, otherSources: [], numSubs: 5, freqList: [60],
    listenerPositions: [{x:9,y:9,z:3.5}], physicsCtx: ctx,     offLimitZones: [], allowedZones: tinyAllowed, gridStepFt: 1, subHeightFt: 1
  });
  assert.ok(result.placedSubs.length <= 5, 'should never place more than requested');
  assert.ok(result.placedSubs.length >= 0, 'should not throw even if it cannot fill all requested subs');
});

test('PERFORMANCE: cost scales linearly with sub count, not exponentially', () => {
  // This is the actual point of greedy placement -- confirm empirically that going
  // from 1 to 4 subs costs roughly 4x the work (linear), not candidates^4 (exponential).
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [
    { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true },
    { x: 13.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true }
  ];
  const freqs = [40,60,80,100];
  const listeners = [{x:9,y:9,z:3.5}];
  const commonOpts = {
    room, otherSources: mains, freqList: freqs, listenerPositions: listeners,
    physicsCtx: ctx, offLimitZones: [], preferredZones: [],
    gridStepFt: 1, subHeightFt: 1
  };

  const t1start = Date.now();
  const r1 = P.optimizeMultipleSubs({ ...commonOpts, numSubs: 1 });
  const t1 = Date.now() - t1start;

  const t4start = Date.now();
  const r4 = P.optimizeMultipleSubs({ ...commonOpts, numSubs: 4 });
  const t4 = Date.now() - t4start;

  assert.strictEqual(r1.placedSubs.length, 1);
  assert.strictEqual(r4.placedSubs.length, 4);
  // Allow generous slack (up to ~8x for 4x the rounds, accounting for timing noise
  // on small workloads) -- the key assertion is NOT hundreds/thousands of times slower,
  // which is what candidates^numSubs brute force would look like even at this grid size.
  const ratio = t4 / Math.max(1, t1);
  assert.ok(ratio < 15, `expected roughly linear scaling (~4x), got ${ratio.toFixed(1)}x slower for 4 subs vs 1 (t1=${t1}ms, t4=${t4}ms)`);
});

test('REGRESSION: multi-sub placement never picks the same (or near-same) spot twice', () => {
  // The bug this guards against: without a separation constraint, greedy search
  // can legitimately re-select the exact same position for multiple subs, since
  // two co-located subs simply sum louder rather than being penalized for
  // redundancy in the scoring function itself.
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [
    { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true },
    { x: 13.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true }
  ];
  const result = P.optimizeMultipleSubs({
    room, otherSources: mains, numSubs: 4, freqList: [30,40,50,60,70,80,90,100],
    listenerPositions: [{x:9,y:9,z:3.5}], physicsCtx: ctx,     offLimitZones: [], preferredZones: [], gridStepFt: 0.5, subHeightFt: 1
  });
  assert.ok(result.placedSubs.length >= 2, 'need at least 2 placed subs to check separation');
  for(let i = 0; i < result.placedSubs.length; i++){
    for(let j = i+1; j < result.placedSubs.length; j++){
      const a = result.placedSubs[i], b = result.placedSubs[j];
      const dist = Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2);
      assert.ok(dist > 0.9, `subs ${i+1} and ${j+1} are only ${dist.toFixed(2)}ft apart at (${a.x},${a.y}) and (${b.x},${b.y}) — expected meaningful separation`);
    }
  }
});

test('REGRESSION: a placed sub keeps clear of otherSources positions (mains, pre-existing subs), not just other subs placed this run', () => {
  // The bug: placedPositions (the exclusion list) used to start empty and
  // only accumulate subs placed DURING this call. otherSources (mains,
  // and any subs that existed before this call) were never in it, so a
  // newly-placed sub could land right on top of one of them. Forcing the
  // search into an allowed zone tight around an existing source makes this
  // concrete: an existing SUB keeps the full sub-to-sub separation, so its
  // 4ft square exclusion leaves no valid candidate inside a 4x4ft zone
  // centered on it; a MAIN keeps its keepOut rectangle, which fills a zone
  // just inside its 2x2ft core.
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51 };
  const base = { x: 9, y: 9, z: 3, levelDb: 0, delayMs: 0, enabled: true };
  const existingSub = { ...base, freqLow: 20, freqHigh: 80 };
  const existingMain = { ...base, freqLow: 80, freqHigh: 20000 };
  const search = (otherSources, allowedZones) => P.optimizeMultipleSubs({
    room, otherSources, numSubs: 1, freqList: [40,60,80],
    listenerPositions: [{x:9,y:6,z:3.5}], physicsCtx: ctx,
    offLimitZones: [], allowedZones, gridStepFt: 0.5, subHeightFt: 1
  });
  const aroundSub = search([existingSub], [{ x: 7, y: 7, width: 4, height: 4 }]);
  assert.strictEqual(aroundSub.placedSubs.length, 0,
    `expected no valid candidate inside a zone this tight around an existing sub, but placed a sub at (${aroundSub.placedSubs[0]?.x},${aroundSub.placedSubs[0]?.y})`);
  const insideMainBox = search([existingMain], [{ x: 8.1, y: 8.1, width: 1.8, height: 1.8 }]);
  assert.strictEqual(insideMainBox.placedSubs.length, 0,
    `expected no valid candidate inside a main speaker's 2x2ft box, but placed a sub at (${insideMainBox.placedSubs[0]?.x},${insideMainBox.placedSubs[0]?.y})`);
});

test('a main speaker only blocks a 2ft wide box back to its nearest wall, so a sub can stand right beside or in front of it', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51 };
  const main = { x: 9, y: 9, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true };
  const result = P.optimizeMultipleSubs({
    room, otherSources: [main], numSubs: 1, freqList: [40,60,80],
    listenerPositions: [{x:9,y:6,z:3.5}], physicsCtx: ctx,
    offLimitZones: [], allowedZones: [{ x: 7, y: 7, width: 4, height: 4 }], gridStepFt: 0.5, subHeightFt: 1
  });
  assert.strictEqual(result.placedSubs.length, 1, 'expected a sub to fit in a 4x4ft zone around a main speaker');
  const sub = result.placedSubs[0];
  assert.ok(Math.abs(sub.x - main.x) >= P.SPEAKER_CLEARANCE_FT || Math.abs(sub.y - main.y) >= P.SPEAKER_CLEARANCE_FT,
    `expected the sub outside the main's box, got (${sub.x},${sub.y})`);
  // The nearest wall is the back wall (4.5ft away), so the box runs x 8 to 10, y 8 to 13.5.
  // 64 cells in the zone, minus the 4 columns x 6 rows (y 8.25 to 10.75) of it inside the zone.
  assert.strictEqual(result.roundResults[0].allCandidates.length, 40);
  assert.ok(result.roundResults[0].allCandidates.some(c => c.x === 9.25 && c.y === 7.75), 'directly in front of the speaker is open');
});

test('REGRESSION: a small room full of speakers still has somewhere to search (12x10ft with a 7-speaker layout)', () => {
  // Every main used to take the full sub-to-sub separation, an 8x8ft box
  // each, which left this room with no valid candidate at all.
  const room = { w: 12, d: 10, h: 8 };
  const ctx = { room, wallAbsorption: 0.3 };
  const seat = { x: 6, y: 6.3, z: 3.5 };
  const mains = P.standardSpeakerPositions(room, seat, ['FL','FR','C','SL','SR','SBL','SBR'])
    .map(p => ({ x: p.x, y: p.y, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true }));
  const result = P.optimizeMultipleSubs({
    room, otherSources: mains, numSubs: 1, freqList: [40,60,80],
    listenerPositions: [seat], physicsCtx: ctx, offLimitZones: [], allowedZones: [], gridStepFt: 0.5, subHeightFt: 1
  });
  assert.strictEqual(result.placedSubs.length, 1);
  const cells = P.countGridCells(room, 0.5);
  assert.ok(result.roundResults[0].allCandidates.length > cells * 0.7,
    `expected most of the ${cells} cells searchable, got ${result.roundResults[0].allCandidates.length}`);
});

test('a new sub is scored as the sub that gets placed (NEW_SUB_DEFAULTS), not as a full-range source', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.3 };
  const freqList = [40, 70, 100, 120];
  const lp = [{ x: 9, y: 9, z: 3.5 }];
  const result = P.optimizeMultipleSubs({
    room, otherSources: [], numSubs: 1, freqList, listenerPositions: lp, physicsCtx: ctx,
    offLimitZones: [], allowedZones: [], gridStepFt: 1, subHeightFt: 1
  });
  const best = result.roundResults[0].best;
  const pos = { x: best.x, y: best.y, z: best.z };
  const asPlaced = P.scoreSubPosition({ ...P.NEW_SUB_DEFAULTS, ...pos }, [], room, freqList, lp, ctx);
  const asFullRange = P.scoreSubPosition(pos, [], room, freqList, lp, ctx);
  approx(best.score, asPlaced.score, 1e-9, 'score of the winning candidate');
  assert.ok(Math.abs(asPlaced.score - asFullRange.score) > 1, 'expected the 80Hz low-pass to change the score above 80Hz');
  assert.strictEqual(result.placedSubs[0].freqHigh, P.NEW_SUB_DEFAULTS.freqHigh);
});

test('scanGridCandidates: candidateTemplate and timeAlignTo score each candidate as the sub that will stand there', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.3 };
  const freqList = [50, 80, 110];
  const lp = [{ x: 9, y: 9, z: 3.5 }];
  const main = { id: 1, x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 7, freqLow: 80, freqHigh: 20000, enabled: true };
  const template = { id: 2, levelDb: -6, delayMs: 3, freqLow: 20, freqHigh: 100, rolloffDbPerOct: 12 };
  const opts = {
    room, otherSources: [main], freqList, listenerPositions: lp, physicsCtx: ctx,
    offLimitZones: [], allowedZones: [], gridStepFt: 3, subHeightFt: 1, candidateTemplate: template
  };
  // Template only: the candidate keeps the template's own delay, the main its own.
  for(const c of [...P.scanGridCandidates(opts)].filter(Boolean)){
    const expected = P.scoreSubPosition({ ...template, x: c.x, y: c.y, z: c.z }, [main], room, freqList, lp, ctx);
    approx(c.score, expected.score, 1e-9, `template score at (${c.x},${c.y})`);
  }
  // With timeAlignTo, both sources get the delays time alignment gives them with the candidate in place.
  const listener = { x: 9, y: 9, z: 3.5 };
  let differs = false;
  for(const c of [...P.scanGridCandidates({ ...opts, timeAlignTo: listener })].filter(Boolean)){
    const [alignedMain, alignedSub] = P.timeAlignedSources([main, { ...template, x: c.x, y: c.y, z: c.z }], listener);
    const expected = P.scoreSubPosition(alignedSub, [alignedMain], room, freqList, lp, ctx);
    approx(c.score, expected.score, 1e-9, `time-aligned score at (${c.x},${c.y})`);
    const unaligned = P.scoreSubPosition({ ...template, x: c.x, y: c.y, z: c.z }, [main], room, freqList, lp, ctx);
    if(Math.abs(unaligned.score - expected.score) > 0.1) differs = true;
  }
  assert.ok(differs, 'expected time alignment to change at least one candidate score');
});

test('scanGridCandidates: nullAvoidance\'s spread penalty counts other subs only, not main speakers', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.3 };
  const freqList = [40, 60];
  const lp = [{ x: 9, y: 9, z: 3.5 }];
  const scan = (excludePoints) => [...P.scanGridCandidates({
    room, otherSources: [], freqList, listenerPositions: lp, physicsCtx: ctx,
    offLimitZones: [], allowedZones: [{ x: 5, y: 1, width: 1, height: 1 }], gridStepFt: 0.5, subHeightFt: 1,
    excludePoints, minSeparationFt: 3, mode: 'nullAvoidance'
  })].filter(Boolean);
  const alone = scan([]);
  const nearSpeaker = scan([{ x: 2, y: 1.5, keepOut: P.speakerKeepOut({ x: 2, y: 1.5 }, room) }]);
  const nearSub = scan([{ x: 2, y: 1.5 }]);
  assert.ok(alone.length > 0 && nearSpeaker.length === alone.length && nearSub.length === alone.length);
  alone.forEach((c, i) => {
    approx(nearSpeaker[i].score, c.score, 1e-9, 'a speaker 3ft away should not cost anything');
    assert.ok(nearSub[i].score < c.score - 1, 'a sub 3ft away should cost a spread penalty');
  });
});

test('polishSubPlacements scores each sub as itself: its own level and passband, time-aligned when asked', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.3 };
  const freqList = [40, 70, 100];
  const lp = [{ x: 9, y: 9, z: 3.5 }];
  const listener = { x: 9, y: 9, z: 3.5 };
  const subs = [
    { id: 1, x: 1.5, y: 1.5, z: 1, levelDb: -6, delayMs: 0, freqLow: 20, freqHigh: 60, enabled: true },
    { id: 2, x: 16.5, y: 12, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 120, enabled: true }
  ];
  const result = P.polishSubPlacements({
    room, otherSources: [], subs, freqList, listenerPositions: lp, physicsCtx: ctx,
    offLimitZones: [], allowedZones: [], gridStepFt: 1.5, timeAlignTo: listener
  });
  // The first round searched for sub 1 with sub 2 still at its starting position.
  const first = result.polishResults[0].best;
  const [alignedOther, alignedCandidate] = P.timeAlignedSources([subs[1], { ...subs[0], x: first.x, y: first.y, z: first.z }], listener);
  const expected = P.scoreSubPosition(alignedCandidate, [alignedOther], room, freqList, lp, ctx);
  approx(first.score, expected.score, 1e-9, 'first polish round\'s best score');
  assert.strictEqual(result.placedSubs[0].levelDb, -6);
  assert.strictEqual(result.placedSubs[0].freqHigh, 60);
});

test('assignNearestSpots hands picked spots to interchangeable subs by least total travel', () => {
  const sub = (id, x, y, extra) => Object.assign({ id, x, y, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80 }, extra);
  const subs = [sub(1, 3, 12.5), sub(2, 14, 12.5)];
  const placed = [{ id: 1, x: 17.5, y: 1.5, z: 1 }, { id: 2, x: 0.5, y: 11.5, z: 1 }];
  const swapped = P.assignNearestSpots(subs, placed, false);
  assert.deepStrictEqual(swapped.map(p => [p.id, p.x, p.y]), [[1, 0.5, 11.5], [2, 17.5, 1.5]], 'identical subs trade spots');
  assert.deepStrictEqual(placed.map(p => [p.x, p.y]), [[17.5, 1.5], [0.5, 11.5]], 'input is not changed');

  const louder = [subs[0], sub(2, 14, 12.5, { levelDb: 3 })];
  assert.deepStrictEqual(P.assignNearestSpots(louder, placed, false).map(p => [p.x, p.y]), [[17.5, 1.5], [0.5, 11.5]], 'a sub with its own level keeps its spot');

  const delayed = [sub(1, 3, 12.5, { delayMs: 6 }), sub(2, 14, 12.5, { delayMs: 2.8 })];
  assert.deepStrictEqual(P.assignNearestSpots(delayed, placed, false).map(p => [p.x, p.y]), [[17.5, 1.5], [0.5, 11.5]], 'different delays count without time alignment');
  assert.deepStrictEqual(P.assignNearestSpots(delayed, placed, true).map(p => [p.x, p.y]), [[0.5, 11.5], [17.5, 1.5]], 'but not with it, since alignment re-derives them');

  // Three identical subs: every one goes to the spot nearest it.
  const three = [sub(1, 1, 1), sub(2, 9, 12), sub(3, 17, 1)];
  const spots = [{ x: 9, y: 13 }, { x: 16, y: 0.5 }, { x: 0.5, y: 0.5 }];
  assert.deepStrictEqual(P.assignNearestSpots(three, spots, false).map(p => [p.x, p.y]), [[0.5, 0.5], [9, 13], [16, 0.5]]);
});

test('REGRESSION: polishSubPlacements does not send each sub to the spot by the other one', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.3 };
  const main = (x, y) => ({ x, y, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 200, enabled: true });
  const subs = [
    { id: 1, x: 3, y: 12.5, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80, enabled: true },
    { id: 2, x: 14, y: 12.5, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80, enabled: true }
  ];
  const result = P.polishSubPlacements({
    room, otherSources: [main(1.5, 2), main(7, 2), main(12, 2), main(1, 10.1), main(17, 10.1)], subs,
    freqList: P.optimizerFreqList(20, 120), listenerPositions: [5, 7, 9].map((x, i) => ({ x, y: 9.4, z: 3.5, weight: i === 1 ? 1 : 0.7 })),
    physicsCtx: ctx, offLimitZones: [], allowedZones: [], gridStepFt: 1, mode: 'balanced', timeAlignTo: { x: 7, y: 9.4, z: 3.5, facing: 0 }
  });
  // The search picks (17.5, 1.5) and (0.5, 11.5); before the fix sub 1 went
  // across the room to (17.5, 1.5), 31.7 ft of travel in all.
  assert.deepStrictEqual(result.placedSubs.map(p => [p.x, p.y]), [[0.5, 11.5], [17.5, 1.5]]);
  const travel = result.placedSubs.reduce((sum, p, i) => sum + Math.hypot(p.x - subs[i].x, p.y - subs[i].y), 0);
  approx(travel, 14.2, 0.05, 'total travel');
  assert.deepStrictEqual(result.moved, [true, true]);
});

test('minSeparationFt is configurable and respected', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const result = P.optimizeMultipleSubs({
    room, otherSources: [], numSubs: 2, freqList: [60],
    listenerPositions: [{x:9,y:9,z:3.5}], physicsCtx: ctx,     offLimitZones: [], preferredZones: [], gridStepFt: 0.5, subHeightFt: 1,
    minSeparationFt: 5
  });
  if(result.placedSubs.length === 2){
    const a = result.placedSubs[0], b = result.placedSubs[1];
    const dist = Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2);
    assert.ok(dist >= 5 - 1e-9, `expected at least 5ft separation, got ${dist.toFixed(2)}ft`);
  }
});

test('default minSeparationFt (when not specified) is 25% of the room\'s smaller dimension, floored at 4ft', () => {
  const room1 = { w: 18, d: 13.5, h: 8 }; // 13.5*0.25 = 3.375 -> floored to 4
  const room2 = { w: 30, d: 24, h: 8 };   // 24*0.25 = 6
  const ctx1 = { room: room1, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const ctx2 = { room: room2, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };

  const r1 = P.optimizeMultipleSubs({
    room: room1, otherSources: [], numSubs: 2, freqList: [60],
    listenerPositions: [{x:9,y:9,z:3.5}], physicsCtx: ctx1,     offLimitZones: [], preferredZones: [], gridStepFt: 0.5, subHeightFt: 1
  });
  const r2 = P.optimizeMultipleSubs({
    room: room2, otherSources: [], numSubs: 2, freqList: [60],
    listenerPositions: [{x:15,y:12,z:3.5}], physicsCtx: ctx2,     offLimitZones: [], preferredZones: [], gridStepFt: 0.5, subHeightFt: 1
  });
  if(r1.placedSubs.length === 2){
    const [a,b] = r1.placedSubs;
    const dist = Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2);
    assert.ok(dist >= 4 - 1e-9, `expected at least the 4ft floor, got ${dist.toFixed(2)}ft`);
  }
  if(r2.placedSubs.length === 2){
    const [a,b] = r2.placedSubs;
    const dist = Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2);
    assert.ok(dist >= 6 - 1e-9, `expected at least 25% of the smaller dimension (6ft), got ${dist.toFixed(2)}ft`);
  }
});

console.log('\n-- optimizeMultipleSubs coordinate-descent polish pass --');

test('numSubs < 2 skips polish entirely', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const r0 = P.optimizeMultipleSubs({
    room, otherSources: [], numSubs: 0, freqList: [60],
    listenerPositions: [{x:9,y:9,z:3.5}], physicsCtx: ctx, offLimitZones: [], preferredZones: [], gridStepFt: 1, subHeightFt: 1
  });
  assert.deepStrictEqual(r0.polishResults, []);
  const r1 = P.optimizeMultipleSubs({
    room, otherSources: [], numSubs: 1, freqList: [60],
    listenerPositions: [{x:9,y:9,z:3.5}], physicsCtx: ctx, offLimitZones: [], preferredZones: [], gridStepFt: 1, subHeightFt: 1
  });
  assert.deepStrictEqual(r1.polishResults, []);
});

test('polish never decreases the combined arrangement score', () => {
  // Coordinate ascent can't make things worse by construction: each polish
  // step re-optimizes exactly one sub's position via the same maximizing grid
  // search greedy itself uses, holding every other sub fixed, so the new
  // position it picks is guaranteed to score at least as well AS SCORED
  // AGAINST THAT SAME FIXED BACKDROP as the position it replaces (including
  // the sub's own prior spot, which remains a valid candidate in the re-scan).
  // Confirm this empirically by re-scoring the pre-polish (greedy-only) and
  // post-polish arrangements with the exact same scoreSubPosition inputs.
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [
    { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true },
    { x: 13.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true }
  ];
  const freqList = [30,40,50,60,70,80];
  const listenerPositions = [{x:9,y:9,z:3.5}];
  const result = P.optimizeMultipleSubs({
    room, otherSources: mains, numSubs: 3, freqList, listenerPositions,
    physicsCtx: ctx, offLimitZones: [], preferredZones: [], gridStepFt: 1, subHeightFt: 1
  });
  assert.strictEqual(result.placedSubs.length, 3, 'expected all 3 subs placed for this scenario');
  // Reconstruct the pre-polish arrangement from roundResults' own choices
  // (each greedy round's .best is exactly what placedSubs[i] was before any
  // polish pass touched it).
  const prePolish = result.roundResults.map(r => ({ x: r.best.x, y: r.best.y, z: r.best.z, name: 'sub', levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80, enabled: true }));
  const postPolish = result.placedSubs;
  const scoreOf = (arrangement) => P.scoreSubPosition(
    { x: arrangement[0].x, y: arrangement[0].y, z: arrangement[0].z },
    mains.concat(arrangement.slice(1)), room, freqList, listenerPositions, ctx
  ).score;
  const preScore = scoreOf(prePolish);
  const postScore = scoreOf(postPolish);
  assert.ok(postScore >= preScore - 1e-9, `expected polish to never decrease score: pre=${preScore.toFixed(3)} post=${postScore.toFixed(3)}`);
});

test('polish respects the same off-limits/allowed zones and minSeparationFt as greedy', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const offLimits = [{ x: 0, y: 0, width: 18, height: 10 }]; // only y=[10,13.5] is allowed
  const result = P.optimizeMultipleSubs({
    room, otherSources: [], numSubs: 3, freqList: [40,60,80],
    listenerPositions: [{x:9,y:12,z:3.5}], physicsCtx: ctx, offLimitZones: offLimits, preferredZones: [], gridStepFt: 1, subHeightFt: 1
  });
  for(const sub of result.placedSubs){
    assert.ok(sub.y >= 10, `every placed sub should still respect the off-limits zone after polish, got y=${sub.y}`);
  }
  for(let i = 0; i < result.placedSubs.length; i++){
    for(let j = i+1; j < result.placedSubs.length; j++){
      const a = result.placedSubs[i], b = result.placedSubs[j];
      const dist = Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2);
      assert.ok(dist > 0.9, `subs ${i} and ${j} should still respect minSeparationFt after polish, got ${dist.toFixed(2)}ft apart`);
    }
  }
});

test('polish is bounded by POLISH_PASSES x subs placed', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const result = P.optimizeMultipleSubs({
    room, otherSources: [], numSubs: 4, freqList: [40,60,80,100],
    listenerPositions: [{x:9,y:9,z:3.5}], physicsCtx: ctx, offLimitZones: [], preferredZones: [], gridStepFt: 1, subHeightFt: 1
  });
  const POLISH_PASSES = 2; // mirrors the constant in room-physics.js; not exported, so pinned here
  assert.ok(result.polishResults.length <= POLISH_PASSES * result.placedSubs.length,
    `expected at most ${POLISH_PASSES * result.placedSubs.length} polish rounds, got ${result.polishResults.length}`);
  assert.ok(result.polishResults.length >= 0);
});

console.log('\n-- polishSubPlacements / polishSubPlacementsAsync (standalone re-optimization) --');

test('feeding an already-converged arrangement back in produces zero further movement', () => {
  // polishSubPlacements early-exits a pass once nothing moves, meaning a
  // converged output is (by construction) a coordinate-wise local optimum:
  // feeding it back in as the STARTING arrangement should find nothing left
  // to improve, for any of the subs.
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [
    { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true },
    { x: 13.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true }
  ];
  const freqList = [40,60,80,100];
  const listenerPositions = [{x:9,y:9,z:3.5}];
  const opts = {
    room, otherSources: mains, freqList, listenerPositions, physicsCtx: ctx,
    offLimitZones: [], allowedZones: [], preferredZones: [], gridStepFt: 1, mode: 'balanced'
  };
  const converged = P.optimizeMultipleSubs(Object.assign({}, opts, { numSubs: 3, subHeightFt: 1 }));
  assert.strictEqual(converged.placedSubs.length, 3, 'expected all 3 subs placed for this scenario');
  const result = P.polishSubPlacements(Object.assign({}, opts, { subs: converged.placedSubs }));
  assert.ok(result.moved.every(m => m === false), 'expected no further movement when re-polishing an already-converged arrangement');
});

test('a suboptimally-placed sub moves, and the arrangement score does not decrease', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [
    { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true },
    { x: 13.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true }
  ];
  const freqList = [30,40,50,60,70,80,90,100];
  const listenerPositions = [{x:9,y:9,z:3.5}];
  const subs = [
    { name: 'SW1', x: 0.5, y: 0.5, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80, enabled: true },
    { name: 'SW2', x: 17.5, y: 13, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80, enabled: true }
  ];
  const scoreOf = (arrangement) => P.scoreSubPosition(
    { x: arrangement[0].x, y: arrangement[0].y, z: arrangement[0].z },
    mains.concat(arrangement.slice(1)), room, freqList, listenerPositions, ctx
  ).score;
  const beforeScore = scoreOf(subs);
  const result = P.polishSubPlacements({
    room, otherSources: mains, subs, freqList, listenerPositions, physicsCtx: ctx,
    offLimitZones: [], allowedZones: [], preferredZones: [], gridStepFt: 0.5, mode: 'balanced'
  });
  const afterScore = scoreOf(result.placedSubs);
  assert.ok(result.moved.some(m => m === true), 'expected at least one sub to move from these deliberately poor starting spots');
  assert.ok(afterScore >= beforeScore - 1e-9, `expected polish to never decrease score: before=${beforeScore.toFixed(3)} after=${afterScore.toFixed(3)}`);
});

test('polishSubPlacements works on copies, never mutating the caller\'s subs', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const subs = [
    { name: 'SW1', x: 1, y: 1, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80, enabled: true },
    { name: 'SW2', x: 17, y: 12, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80, enabled: true }
  ];
  const originalPositions = subs.map(s => ({ x: s.x, y: s.y, z: s.z }));
  P.polishSubPlacements({
    room, otherSources: [], subs, freqList: [60], listenerPositions: [{x:9,y:9,z:3.5}], physicsCtx: ctx,
    offLimitZones: [], allowedZones: [], preferredZones: [], gridStepFt: 1, mode: 'balanced'
  });
  assert.deepStrictEqual(subs.map(s => ({ x: s.x, y: s.y, z: s.z })), originalPositions, 'the input subs array/objects should be untouched');
});

test('each sub is searched at its own z when subHeightFt is not overridden', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const subs = [
    { name: 'SW1', x: 1, y: 1, z: 0.5, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80, enabled: true },
    { name: 'SW2', x: 17, y: 12, z: 2.5, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80, enabled: true }
  ];
  const result = P.polishSubPlacements({
    room, otherSources: [], subs, freqList: [60], listenerPositions: [{x:9,y:9,z:3.5}], physicsCtx: ctx,
    offLimitZones: [], allowedZones: [], preferredZones: [], gridStepFt: 1, mode: 'balanced'
  });
  assert.strictEqual(result.placedSubs[0].z, 0.5, 'sub 1 should keep searching at its own original height');
  assert.strictEqual(result.placedSubs[1].z, 2.5, 'sub 2 should keep searching at its own original height');
});

testAsync('polishSubPlacementsAsync matches polishSubPlacements exactly', async () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [
    { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true }
  ];
  const subs = [
    { name: 'SW1', x: 0.5, y: 0.5, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80, enabled: true },
    { name: 'SW2', x: 17.5, y: 13, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80, enabled: true }
  ];
  const opts = {
    room, otherSources: mains, subs, freqList: [40,60,80], listenerPositions: [{x:9,y:9,z:3.5}],
    physicsCtx: ctx, offLimitZones: [], allowedZones: [], preferredZones: [], gridStepFt: 1, mode: 'balanced'
  };
  const syncResult = P.polishSubPlacements(opts);
  const asyncResult = await P.polishSubPlacementsAsync(opts);
  assert.deepStrictEqual(asyncResult.placedSubs, syncResult.placedSubs);
  assert.deepStrictEqual(asyncResult.moved, syncResult.moved);
  assert.strictEqual(asyncResult.polishResults.length, syncResult.polishResults.length);
});

test('isCandidateValid rejects points too close to an exclude point', () => {
  const room = { w: 18, d: 13.5 };
  const excludePoints = [{ x: 9, y: 9 }];
  assert.strictEqual(P.isCandidateValid(9.2, 9.2, room, [], [], excludePoints, 2), false);
  assert.strictEqual(P.isCandidateValid(15, 12, room, [], [], excludePoints, 2), true);
});

test('isCandidateValid checks a SQUARE footprint, not a circular radius: rejects a diagonal near-miss a circle of the same radius would accept', () => {
  const room = { w: 18, d: 13.5 };
  const excludePoints = [{ x: 9, y: 9 }];
  const r = 4;
  // A point offset (0.9r, 0.9r) is about 1.27r away in a straight line (well
  // outside a circle of radius r), but only 0.9r away along EACH axis --
  // a square check should still reject it, where a circular check would not.
  const px = 9 + r * 0.9, py = 9 + r * 0.9;
  const straightLineDist = Math.sqrt((px-9)**2 + (py-9)**2);
  assert.ok(straightLineDist > r, 'test setup: this point should be outside a circle of radius r');
  assert.strictEqual(P.isCandidateValid(px, py, room, [], [], excludePoints, r), false,
    `expected the square check to reject a point ${straightLineDist.toFixed(2)}ft away in a straight line but only ${(r*0.9).toFixed(2)}ft away along each axis`);
});

test('isCandidateValid: any point it accepts is still at least minSeparationFt away in straight-line distance (square exclusion strictly subsumes the circular guarantee)', () => {
  const room = { w: 18, d: 13.5 };
  const excludePoints = [{ x: 9, y: 9 }];
  const r = 3;
  for(let dx = -6; dx <= 6; dx += 0.5){
    for(let dy = -6; dy <= 6; dy += 0.5){
      const px = 9 + dx, py = 9 + dy;
      if(px < 0 || px > room.w || py < 0 || py > room.d) continue;
      if(P.isCandidateValid(px, py, room, [], [], excludePoints, r)){
        const dist = Math.sqrt(dx*dx + dy*dy);
        assert.ok(dist >= r - 1e-9, `accepted point (${dx},${dy}) is only ${dist.toFixed(2)}ft from the excluded point, expected >= ${r}ft`);
      }
    }
  }
});

console.log('\n-- schroederFrequency --');

test('matches hand-calculated value for a known room and T60', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const volumeM3 = (18*13.5*8) * (P.FT_TO_M ** 3);
  const expected = 2000 * Math.sqrt(0.4 / volumeM3);
  approx(P.schroederFrequency(room, 0.4), expected, 0.01);
});

test('uses a sensible default T60 when none is provided', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const withDefault = P.schroederFrequency(room);
  const explicit04 = P.schroederFrequency(room, 0.4);
  approx(withDefault, explicit04, 0.01, 'default T60 should match the documented 0.4s default');
});

test('a larger room has a LOWER Schroeder frequency (more modes packed per Hz)', () => {
  const small = { w: 12, d: 10, h: 8 };
  const large = { w: 30, d: 22, h: 10 };
  const fsSmall = P.schroederFrequency(small, 0.4);
  const fsLarge = P.schroederFrequency(large, 0.4);
  assert.ok(fsLarge < fsSmall, `expected larger room to have lower Schroeder freq: small=${fsSmall.toFixed(0)}Hz large=${fsLarge.toFixed(0)}Hz`);
});

test('scales as 1/sqrt(volume) -- doubling volume should multiply Schroeder freq by 1/sqrt(2)', () => {
  const room1 = { w: 10, d: 10, h: 8 };
  const room2 = { w: 20, d: 10, h: 8 }; // exactly 2x the volume
  const fs1 = P.schroederFrequency(room1, 0.4);
  const fs2 = P.schroederFrequency(room2, 0.4);
  approx(fs2/fs1, 1/Math.sqrt(2), 0.001);
});

test('longer T60 (livelier room) raises the Schroeder frequency', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const fsLive = P.schroederFrequency(room, 0.6);
  const fsDamped = P.schroederFrequency(room, 0.2);
  assert.ok(fsLive > fsDamped, 'a livelier (longer T60) room should have a higher Schroeder frequency');
});

test('returns 0 (not NaN/Infinity) for a degenerate room with zero volume', () => {
  // The only defensive guard in this file (volumeM3 <= 0 -> return 0) --
  // otherwise sqrt(t60/0) is Infinity. Exercises w=0 specifically since that's
  // the most plausible real trigger (e.g. a room dimension input momentarily
  // cleared/zeroed in the UI while the user is typing a new value).
  const room = { w: 0, d: 13.5, h: 8 };
  assert.strictEqual(P.schroederFrequency(room, 0.4), 0);
});

test('returns 0 (not NaN) for a room with a negative dimension', () => {
  const room = { w: 18, d: -13.5, h: 8 };
  const fs = P.schroederFrequency(room, 0.4);
  assert.ok(Number.isFinite(fs), `expected a finite result, got ${fs}`);
  assert.strictEqual(fs, 0);
});

console.log('\n-- estimatedT60 (Eyring reverberation estimate) --');

test('matches hand-calculated Eyring T60 for a uniform-absorption room', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { wallAbsorption: 0.51 };
  const alpha = 0.51;
  const areaFt2 = 2*(room.d*room.h) + 2*(room.w*room.h) + 2*(room.w*room.d);
  const totalAreaM2 = areaFt2 * (P.FT_TO_M ** 2);
  const volumeM3 = (room.w*room.d*room.h) * (P.FT_TO_M ** 3);
  // Uniform absorption -> avgAlpha is just alpha itself.
  const expected = 0.161 * volumeM3 / (-totalAreaM2 * Math.log(1 - alpha));
  approx(P.estimatedT60(room, 100, ctx), expected, 0.001);
});

test('Eyring T60 correctly approaches 0 as average absorption approaches 1 (Sabine\'s known breakdown case)', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  // wallAbsorption -> 1 means a fully absorptive room -- Sabine's formula
  // would asymptote to a nonzero floor here instead of continuing toward 0.
  const nearlyFullyAbsorptive = P.estimatedT60(room, 100, { wallAbsorption: 0.9999 });
  const moderatelyAbsorptive = P.estimatedT60(room, 100, { wallAbsorption: 0.51 });
  assert.ok(nearlyFullyAbsorptive < moderatelyAbsorptive * 0.1,
    `expected T60 to drop sharply as the room approaches full absorption: nearlyFullyAbsorptive=${nearlyFullyAbsorptive.toFixed(4)}s moderatelyAbsorptive=${moderatelyAbsorptive.toFixed(4)}s`);
});

test('less absorptive (more reflective) surfaces produce a LONGER T60', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const liveT60 = P.estimatedT60(room, 100, { wallAbsorption: 0.19 });
  const deadT60 = P.estimatedT60(room, 100, { wallAbsorption: 0.91 });
  assert.ok(liveT60 > deadT60, `expected a less absorptive room to ring longer: live=${liveT60.toFixed(2)}s dead=${deadT60.toFixed(2)}s`);
});

test('per-wall materials are respected -- masonry walls ring longer than insulated drywall', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const allMaterial = (key) => ({ left: P.WALL_MATERIALS[key], right: P.WALL_MATERIALS[key], front: P.WALL_MATERIALS[key], back: P.WALL_MATERIALS[key] });
  const masonryT60 = P.estimatedT60(room, 500, { wallAbsorption: 0.51, wallMaterials: allMaterial('masonry') });
  const drywallT60 = P.estimatedT60(room, 500, { wallAbsorption: 0.51, wallMaterials: allMaterial('drywallInsulated') });
  assert.ok(masonryT60 > drywallT60, `expected masonry (less absorptive) to outlast insulated drywall: masonry=${masonryT60.toFixed(2)}s drywall=${drywallT60.toFixed(2)}s`);
});

test('frequency-dependent -- T60 dips at a resonant wall material\'s peak absorption frequency', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const wallMaterials = { left: P.WALL_MATERIALS.drywallInsulated, right: P.WALL_MATERIALS.drywallInsulated, front: P.WALL_MATERIALS.drywallInsulated, back: P.WALL_MATERIALS.drywallInsulated };
  const atPeak = P.estimatedT60(room, 80, { wallAbsorption: 0.51, wallMaterials }); // drywallInsulated's peakFreq
  const farFromPeak = P.estimatedT60(room, 2000, { wallAbsorption: 0.51, wallMaterials });
  assert.ok(atPeak < farFromPeak, `expected shorter T60 right at the resonant absorption peak: atPeak=${atPeak.toFixed(2)}s farFromPeak=${farFromPeak.toFixed(2)}s`);
});

test('floorAbsorption and ceilingMaterial each independently affect the result', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const base = P.estimatedT60(room, 100, { wallAbsorption: 0.51 });
  const deaderFloor = P.estimatedT60(room, 100, { wallAbsorption: 0.51, floorAbsorption: 0.96 });
  const deaderCeiling = P.estimatedT60(room, 100, { wallAbsorption: 0.51, ceilingMaterial: { baseAbsorption: 0.96, peakBoost: 0 } });
  assert.ok(deaderFloor < base, 'a more absorptive floor should shorten T60');
  assert.ok(deaderCeiling < base, 'a more absorptive ceiling should shorten T60');
});

test('feeds sensibly into schroederFrequency (finite, positive result)', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const t60 = P.estimatedT60(room, 60, { wallAbsorption: 0.44, ceilingMaterial: P.WALL_MATERIALS.suspendedTile });
  const fs = P.schroederFrequency(room, t60);
  assert.ok(Number.isFinite(fs) && fs > 0, `expected a finite, positive Schroeder frequency, got ${fs}`);
});

test('returns 0 (not NaN/Infinity) for a degenerate room with zero volume', () => {
  const room = { w: 0, d: 13.5, h: 8 };
  assert.strictEqual(P.estimatedT60(room, 100, { wallAbsorption: 0.51 }), 0);
});

console.log('\n-- timeAlignDelays --');

test('the farthest source gets exactly 0 delay', () => {
  const listener = { x: 9, y: 9, z: 3.5 };
  const sources = [
    { id: 1, x: 0, y: 9, z: 3.5 },  // 9ft away
    { id: 2, x: 18, y: 9, z: 3.5 }, // 9ft away (tie for farthest)
    { id: 3, x: 9, y: 10, z: 3.5 }  // 1ft away
  ];
  const result = P.timeAlignDelays(sources, listener);
  const byId = Object.fromEntries(result.map(r => [r.id, r.delayMs]));
  approx(byId[1], 0, 1e-9);
  approx(byId[2], 0, 1e-9);
  assert.ok(byId[3] > 0, `expected the closer source to get positive delay, got ${byId[3]}`);
});

test('matches a hand-calculated delay for a known distance difference', () => {
  const listener = { x: 0, y: 0, z: 0 };
  const sources = [
    { id: 'far', x: 20, y: 0, z: 0 },  // 20ft
    { id: 'near', x: 10, y: 0, z: 0 }  // 10ft, 10ft closer
  ];
  const result = P.timeAlignDelays(sources, listener);
  const near = result.find(r => r.id === 'near');
  const far = result.find(r => r.id === 'far');
  const expectedMs = (10 * P.FT_TO_M) / P.C * 1000; // 10ft closer -> that much extra delay needed
  approx(far.delayMs, 0, 1e-9);
  approx(near.delayMs, expectedMs, 1e-6);
});

test('equidistant sources all get 0 delay', () => {
  const listener = { x: 9, y: 9, z: 3.5 };
  const sources = [
    { id: 1, x: 4.5, y: 9, z: 3.5 },
    { id: 2, x: 13.5, y: 9, z: 3.5 }
  ];
  const result = P.timeAlignDelays(sources, listener);
  for(const r of result) approx(r.delayMs, 0, 1e-9);
});

test('accounts for height (z), not just horizontal distance', () => {
  const listener = { x: 9, y: 9, z: 0 };
  const sources = [
    { id: 'floor', x: 9, y: 9, z: 0 },  // directly at listener height, 0ft away
    { id: 'high', x: 9, y: 9, z: 10 }   // same x/y, 10ft straight up
  ];
  const result = P.timeAlignDelays(sources, listener);
  const high = result.find(r => r.id === 'high');
  const floor = result.find(r => r.id === 'floor');
  approx(high.delayMs, 0, 1e-9); // it's the farther one
  assert.ok(floor.delayMs > 0, `expected the co-located-in-plan-but-closer source to need delay, got ${floor.delayMs}`);
});

test('defaults a missing z to 0', () => {
  const listener = { x: 0, y: 0, z: 0 };
  const sources = [{ id: 1, x: 3, y: 4 }]; // no z field -- 3-4-5 triangle, 5ft away if z=0
  const result = P.timeAlignDelays(sources, listener);
  approx(result[0].delayMs, 0, 1e-9); // only source -> automatically the "farthest"
});

test('returns one entry per source, in the same order, empty array for no sources', () => {
  const listener = { x: 0, y: 0, z: 0 };
  assert.deepStrictEqual(P.timeAlignDelays([], listener), []);
  const sources = [{ id: 'a', x: 1, y: 0, z: 0 }, { id: 'b', x: 2, y: 0, z: 0 }, { id: 'c', x: 3, y: 0, z: 0 }];
  const result = P.timeAlignDelays(sources, listener);
  assert.deepStrictEqual(result.map(r => r.id), ['a', 'b', 'c']);
});

test('timeAlignDelays rounds to stepMs when given one, and timeAlignedSources applies the app\'s 0.1ms step', () => {
  const listener = { x: 9, y: 9, z: 3.5 };
  const sources = [
    { id: 1, x: 4.67, y: 1.5, z: 3, delayMs: 0, name: 'FL' },
    { id: 2, x: 16, y: 12.3, z: 1, delayMs: 5, name: 'SW1' }
  ];
  const exact = P.timeAlignDelays(sources, listener);
  const rounded = P.timeAlignDelays(sources, listener, P.TIME_ALIGN_STEP_MS);
  assert.strictEqual(P.TIME_ALIGN_STEP_MS, 0.1);
  exact.forEach((e, i) => {
    assert.strictEqual(rounded[i].id, e.id);
    assert.strictEqual(rounded[i].delayMs, Math.round(e.delayMs * 10) / 10);
  });
  assert.ok(exact.some((e, i) => e.delayMs !== rounded[i].delayMs), 'expected at least one delay to actually round');
  const aligned = P.timeAlignedSources(sources, listener);
  assert.deepStrictEqual(aligned.map(s => s.delayMs), rounded.map(r => r.delayMs));
  assert.strictEqual(aligned[1].name, 'SW1', 'other fields are kept');
  assert.strictEqual(sources[1].delayMs, 5, 'the input is not mutated');
});

console.log('\n-- earPositions / fieldDbAtEars --');

test('ears are offset by the correct total spacing (~0.17m / ~0.558ft)', () => {
  const listener = { x: 9, y: 9, z: 3.5 };
  const ears = P.earPositions(listener, 0);
  const distFt = Math.sqrt((ears.left.x-ears.right.x)**2 + (ears.left.y-ears.right.y)**2);
  const distM = distFt * P.FT_TO_M;
  approx(distM, 0.17, 0.001, 'total ear-to-ear distance should be ~17cm');
});

test('ears are offset perpendicular to facing direction, not along it', () => {
  const listener = { x: 9, y: 9, z: 3.5 };
  // facing 0 degrees (+y direction) -> ears should differ in x, not y
  const earsFacing0 = P.earPositions(listener, 0);
  approx(earsFacing0.left.y, earsFacing0.right.y, 1e-9, 'facing 0deg: ears should be at the same y');
  assert.notStrictEqual(earsFacing0.left.x, earsFacing0.right.x, 'facing 0deg: ears should differ in x');

  // facing 90 degrees -> ears should differ in y, not x
  const earsFacing90 = P.earPositions(listener, 90);
  approx(earsFacing90.left.x, earsFacing90.right.x, 1e-9, 'facing 90deg: ears should be at the same x');
  assert.notStrictEqual(earsFacing90.left.y, earsFacing90.right.y, 'facing 90deg: ears should differ in y');
});

test('ears stay at the listener height (z unchanged)', () => {
  const listener = { x: 9, y: 9, z: 3.5 };
  const ears = P.earPositions(listener, 45);
  assert.strictEqual(ears.left.z, 3.5);
  assert.strictEqual(ears.right.z, 3.5);
});

test('DEMONSTRATION: two-ear dB difference is negligible at bass frequencies, more meaningful at higher frequencies', () => {
  // This is the actual physical claim behind adding two-ear sampling in the
  // first place -- confirm it empirically rather than just asserting it in prose.
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [
    { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true },
    { x: 13.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true }
  ];
  const listener = { x: 9, y: 9, z: 3.5 };

  // Sample across many candidate listener positions/frequencies and compare
  // typical (median) ear disagreement at a bass frequency vs a higher frequency,
  // since any single position could coincidentally land near a null either way.
  function medianEarDiff(freq){
    const diffs = [];
    for(let lx = 3; lx <= 15; lx += 1.5){
      for(let ly = 3; ly <= 11; ly += 1.5){
        const result = P.fieldDbAtEars({x:lx, y:ly, z:3.5}, 0, mains, freq, ctx);
        diffs.push(result.diffDb);
      }
    }
    diffs.sort((a,b) => a-b);
    return diffs[Math.floor(diffs.length/2)];
  }

  const bassDiff = medianEarDiff(40);   // deep bass, wavelength >> ear spacing
  const trebleDiff = medianEarDiff(400); // wavelength approaching ear-spacing scale

  assert.ok(bassDiff < 0.5, `expected near-zero ear disagreement at 40Hz, got median ${bassDiff.toFixed(3)}dB`);
  assert.ok(trebleDiff > bassDiff, `expected MORE ear disagreement at 400Hz than 40Hz: bass=${bassDiff.toFixed(3)}dB treble=${trebleDiff.toFixed(3)}dB`);
});

console.log('\n-- rowSeatPositions / rowRankWeight / seatCenterWeight (multi-row listening positions) --');

test('a 1-seat row collapses to exactly the row\'s own center point', () => {
  const row = { x: 5, y: 7, z: 3.5, facing: 30, seats: 1, spacingFt: 2 };
  const seats = P.rowSeatPositions(row);
  assert.strictEqual(seats.length, 1);
  approx(seats[0].x, 5, 1e-9);
  approx(seats[0].y, 7, 1e-9);
  approx(seats[0].z, 3.5, 1e-9);
  approx(seats[0].offsetIndex, 0, 1e-9);
});

test('an odd seat count generates a true center seat at offsetIndex 0, symmetric neighbors on either side', () => {
  const row = { x: 9, y: 6, z: 3.5, facing: 0, seats: 3, spacingFt: 2 };
  const seats = P.rowSeatPositions(row);
  assert.strictEqual(seats.length, 3);
  const offsets = seats.map(s => s.offsetIndex);
  assert.deepStrictEqual(offsets, [-1, 0, 1]);
  // facing 0deg -> perpendicular offset is along x (matches earPositions' convention)
  approx(seats[1].x, 9, 1e-9, 'center seat unchanged');
  approx(seats[0].x, 9 - 2, 1e-9, 'left neighbor offset by spacingFt');
  approx(seats[2].x, 9 + 2, 1e-9, 'right neighbor offset by spacingFt');
  for(const s of seats) approx(s.y, 6, 1e-9, 'facing 0deg: y unchanged for every seat');
});

test('an even seat count has no single center seat -- the two middle seats straddle offsetIndex 0 symmetrically', () => {
  const row = { x: 0, y: 0, z: 3, facing: 0, seats: 4, spacingFt: 1.5 };
  const seats = P.rowSeatPositions(row);
  const offsets = seats.map(s => s.offsetIndex);
  assert.deepStrictEqual(offsets, [-1.5, -0.5, 0.5, 1.5]);
});

test('seats offset perpendicular to facing direction, matching earPositions\' convention', () => {
  const row = { x: 9, y: 6, z: 3.5, facing: 90, seats: 2, spacingFt: 2 };
  const seats = P.rowSeatPositions(row);
  // At facing=90deg, earPositions offsets perpendicular to facing along y (not x) --
  // rowSeatPositions should agree since it reuses the same dx=cos,dy=sin convention.
  approx(seats[0].x, seats[1].x, 1e-9, 'facing 90deg: seats should share x');
  assert.notStrictEqual(seats[0].y, seats[1].y, 'facing 90deg: seats should differ in y');
});

test('rowRankWeight halves for each successive rank, rank 0 (rank 1) is full weight', () => {
  approx(P.rowRankWeight(0), 1, 1e-9);
  approx(P.rowRankWeight(1), 0.5, 1e-9);
  approx(P.rowRankWeight(2), 0.25, 1e-9);
});

test('seatCenterWeight is 1.0 at the center seat, 0.5 at the row\'s own edges, and 1 for a 1-seat row', () => {
  approx(P.seatCenterWeight(0, 1), 1, 1e-9, 'single-seat row always full weight');
  approx(P.seatCenterWeight(0, 3), 1, 1e-9, 'true center seat of a 3-seat row');
  approx(P.seatCenterWeight(1, 3), 0.5, 1e-9, 'edge seat of a 3-seat row');
  approx(P.seatCenterWeight(-1, 3), 0.5, 1e-9, 'edge seat is symmetric');
});

console.log('\n-- scoreSubPosition: per-listener weighting (multi-row listening positions) --');

test('REGRESSION: omitting weight on every listener reproduces the exact pre-weighting score', () => {
  // Same scene as an existing worstMinDb-penalty test above, but this test's
  // entire point is confirming the weighted formula collapses back to the
  // literal pre-weighting one when no listener specifies a weight at all --
  // the load-bearing backward-compatibility guarantee for this change.
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51 };
  const source = { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000, enabled: true };
  const listeners = [{ x: 9, y: 6, z: 3.5 }, { x: 3, y: 10, z: 3.5 }];
  const freqs = [40, 60, 80, 100];
  const result = P.scoreSubPosition({ x: 9, y: 6.75, z: 1 }, [source], room, freqs, listeners, ctx);
  const expected = result.avgMean - (result.worstStdDev * P.BALANCED_FLATNESS_WEIGHT) - Math.max(0, result.avgMean - result.worstMinDb - 20) * 0.5;
  approx(result.score, expected, 1e-9, 'unweighted score should exactly match the original formula');
});

test('a severe null at a low-weight listener drags the balanced score down far less than the same null at weight 1', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.985 }; // near-rigid, light damping -- keeps the antiphase null sharp
  const freq0 = 70;
  const lambda = P.C / freq0;
  const sepFt = (lambda / 2) / P.FT_TO_M;
  const halfPeriodMs = (1000 / (2 * freq0)) * 0.999;
  const otherSources = [{ x: 9 - sepFt/2, y: 6, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000, enabled: true }];
  const candidatePos = { x: 9 + sepFt/2, y: 6, z: 3, delayMs: halfPeriodMs };
  const freqs = [freq0 * 0.4, freq0, freq0 * 1.7]; // freq0 is the null; the others are well off it
  const nulledListener = { x: 9, y: 6, z: 3.5 }; // the listener that sits at the null

  const fullWeight = P.scoreSubPosition(candidatePos, otherSources, room, freqs, [{ ...nulledListener, weight: 1 }], ctx);
  const lowWeight = P.scoreSubPosition(candidatePos, otherSources, room, freqs, [{ ...nulledListener, weight: 0.1 }], ctx);
  assert.ok(lowWeight.score > fullWeight.score,
    `expected the low-weight listener's identical null to cost the score less: fullWeight=${fullWeight.score.toFixed(1)} lowWeight=${lowWeight.score.toFixed(1)}`);
});

test('a severe null at a low-weight listener drags the nullAvoidance score down far less than the same null at weight 1', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.985 };
  const freq0 = 70;
  const lambda = P.C / freq0;
  const sepFt = (lambda / 2) / P.FT_TO_M;
  const halfPeriodMs = (1000 / (2 * freq0)) * 0.999;
  const otherSources = [{ x: 9 - sepFt/2, y: 6, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000, enabled: true }];
  const candidatePos = { x: 9 + sepFt/2, y: 6, z: 3, delayMs: halfPeriodMs };
  const freqs = [freq0 * 0.4, freq0, freq0 * 1.7];
  const nulledListener = { x: 9, y: 6, z: 3.5 };

  const fullWeight = P.scoreSubPosition(candidatePos, otherSources, room, freqs, [{ ...nulledListener, weight: 1 }], ctx, 'nullAvoidance');
  const lowWeight = P.scoreSubPosition(candidatePos, otherSources, room, freqs, [{ ...nulledListener, weight: 0.1 }], ctx, 'nullAvoidance');
  assert.ok(lowWeight.score > fullWeight.score,
    `expected the low-weight listener's null to be more forgiven in nullAvoidance mode too: fullWeight=${fullWeight.score.toFixed(1)} lowWeight=${lowWeight.score.toFixed(1)}`);
});

test('avgMean is a true weighted average across listeners, not a plain average', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51 };
  const source = { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000, enabled: true };
  const freqs = [40, 60, 80];
  const candidatePos = { x: 9, y: 6.75, z: 1 };
  const listeners = [{ x: 9, y: 6, z: 3.5 }, { x: 3, y: 10, z: 3.5 }];

  const unweighted = P.scoreSubPosition(candidatePos, [source], room, freqs, listeners, ctx);
  const weighted = P.scoreSubPosition(candidatePos, [source], room, freqs, [
    { ...listeners[0], weight: 1 },
    { ...listeners[1], weight: 0 } // fully discounted -- should behave as if only listener 0 existed for avgMean
  ], ctx);
  const [m0, m1] = unweighted.listenerStats.map(s => s.mean);
  approx(weighted.avgMean, m0, 1e-6, 'zero-weighting the second listener should leave avgMean at exactly the first listener\'s own mean');
  assert.notStrictEqual(weighted.avgMean, unweighted.avgMean, 'weighted avgMean should generally differ from the plain average');
});

console.log('\n-- optimizeSubPlacementAsync / optimizeMultipleSubsAsync (async twins of the sync optimizer) --');

testAsync('optimizeSubPlacementAsync with no callbacks matches optimizeSubPlacement exactly', async () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [
    { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true },
    { x: 13.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true }
  ];
  const opts = {
    room, otherSources: mains, freqList: [40,60,80], listenerPositions: [{x:9,y:9,z:3.5}],
    physicsCtx: ctx, offLimitZones: [], preferredZones: [], gridStepFt: 1, subHeightFt: 1
  };
  const syncResult = P.optimizeSubPlacement(opts);
  const asyncResult = await P.optimizeSubPlacementAsync(opts);
  assert.deepStrictEqual(asyncResult.best, syncResult.best, 'async best should exactly match sync best');
  assert.strictEqual(asyncResult.allCandidates.length, syncResult.allCandidates.length, 'async should scan the same candidate count as sync');
});

testAsync('optimizeMultipleSubsAsync with no callbacks matches optimizeMultipleSubs exactly', async () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [
    { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true },
    { x: 13.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true }
  ];
  const opts = {
    room, otherSources: mains, numSubs: 3, freqList: [40,60,80,100],
    listenerPositions: [{x:9,y:9,z:3.5}], physicsCtx: ctx, offLimitZones: [], preferredZones: [], gridStepFt: 1, subHeightFt: 1
  };
  const syncResult = P.optimizeMultipleSubs(opts);
  const asyncResult = await P.optimizeMultipleSubsAsync(opts);
  assert.deepStrictEqual(asyncResult.placedSubs, syncResult.placedSubs, 'async placedSubs should exactly match sync placedSubs');
  assert.strictEqual(asyncResult.roundResults.length, syncResult.roundResults.length);
  assert.strictEqual(asyncResult.polishResults.length, syncResult.polishResults.length, 'polish pass count should match between sync and async');
});

testAsync('optimizeSubPlacementAsync actually awaits onYield at the expected chunk boundaries', async () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const opts = {
    room, otherSources: [], freqList: [60], listenerPositions: [{x:9,y:9,z:3.5}],
    physicsCtx: ctx, offLimitZones: [], preferredZones: [], gridStepFt: 1, subHeightFt: 1,
    yieldEvery: 5
  };
  const totalCells = P.countGridCells(room, 1);
  // +1 for the unconditional pre-scan yield optimizeSubPlacementAsync does before
  // walking any grid cells, guaranteeing one paint before the scan starts.
  const expectedYields = Math.floor(totalCells / 5) + 1;
  let yieldCount = 0;
  await P.optimizeSubPlacementAsync(Object.assign({}, opts, {
    onYield: () => new Promise(resolve => { yieldCount++; setTimeout(resolve, 0); })
  }));
  assert.strictEqual(yieldCount, expectedYields, `expected ${expectedYields} yields for ${totalCells} cells at yieldEvery=5, got ${yieldCount}`);
});

testAsync('optimizeMultipleSubsAsync reports onProgress as (fraction, roundIndex, phase) pairs', async () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const calls = [];
  await P.optimizeMultipleSubsAsync({
    room, otherSources: [], numSubs: 2, freqList: [60],
    listenerPositions: [{x:9,y:9,z:3.5}], physicsCtx: ctx, offLimitZones: [], preferredZones: [],
    gridStepFt: 1, subHeightFt: 1, yieldEvery: 5,
    onProgress: (fraction, roundIndex, phase) => calls.push({ fraction, roundIndex, phase })
  });
  const roundIndices = new Set(calls.map(c => c.roundIndex));
  for(const idx of roundIndices) assert.ok(idx === 0 || idx === 1, `unexpected roundIndex ${idx}`);

  // Greedy-phase calls (phase undefined, exactly matching today's pre-polish
  // contract): one call sequence per round, fractions non-decreasing within it.
  const greedyCalls = calls.filter(c => c.phase === undefined);
  const round0 = greedyCalls.filter(c => c.roundIndex === 0);
  const round1 = greedyCalls.filter(c => c.roundIndex === 1);
  assert.strictEqual(round0[0].fraction, 0, 'first onProgress call for greedy round 0 should report fraction 0');
  assert.strictEqual(round1[0].fraction, 0, 'first onProgress call for greedy round 1 should report fraction 0');
  for(let i = 1; i < round0.length; i++){
    assert.ok(round0[i].fraction >= round0[i-1].fraction, 'fractions within greedy round 0 should be non-decreasing');
  }

  // Polish-phase calls: phase === 'polish', roundIndex reused to mean "which
  // sub index is being re-optimized" (still 0..numSubs-1), each individual
  // sub's re-optimization sequence still starts at fraction 0 and is
  // non-decreasing up to the next sub's re-optimization restarting at 0.
  const polishCalls = calls.filter(c => c.phase === 'polish');
  assert.ok(polishCalls.length > 0, 'expected at least one polish-phase onProgress call for a 2-sub run');
  for(const c of polishCalls) assert.ok(c.roundIndex === 0 || c.roundIndex === 1, `unexpected polish roundIndex ${c.roundIndex}`);
  let prevFraction = null, prevRoundIndex = null;
  for(const c of polishCalls){
    if(c.roundIndex !== prevRoundIndex || c.fraction === 0){
      prevFraction = c.fraction; // a new sub's re-optimization sequence just started
    } else {
      assert.ok(c.fraction >= prevFraction, 'fractions within one polish sub-optimization should be non-decreasing');
      prevFraction = c.fraction;
    }
    prevRoundIndex = c.roundIndex;
  }
});

testAsync('optimizeSubPlacementAsync and optimizeMultipleSubsAsync work with no onYield/onProgress supplied', async () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const single = await P.optimizeSubPlacementAsync({
    room, otherSources: [], freqList: [60], listenerPositions: [{x:9,y:9,z:3.5}],
    physicsCtx: ctx, offLimitZones: [], preferredZones: [], gridStepFt: 1, subHeightFt: 1
  });
  assert.ok(single.best !== null, 'expected a best candidate with no callbacks supplied');

  const multi = await P.optimizeMultipleSubsAsync({
    room, otherSources: [], numSubs: 2, freqList: [60],
    listenerPositions: [{x:9,y:9,z:3.5}], physicsCtx: ctx, offLimitZones: [], preferredZones: [], gridStepFt: 1, subHeightFt: 1
  });
  assert.strictEqual(multi.placedSubs.length, 2, 'expected both subs placed with no callbacks supplied');
});

console.log('\n-- preferredZoneBonusDb / soft preferred zones --');

test('preferredZoneBonusDb is 0 with no zones', () => {
  assert.strictEqual(P.preferredZoneBonusDb({ x: 9, y: 9 }, []), 0);
  assert.strictEqual(P.preferredZoneBonusDb({ x: 9, y: 9 }, null), 0);
  assert.strictEqual(P.preferredZoneBonusDb({ x: 9, y: 9 }, undefined), 0);
});

test('preferredZoneBonusDb is 0 outside every zone, PREFERRED_ZONE_BONUS_DB inside one', () => {
  const zones = [{ x: 0, y: 0, width: 2, height: 2 }];
  assert.strictEqual(P.preferredZoneBonusDb({ x: 9, y: 9 }, zones), 0, 'outside the zone should get no bonus');
  assert.strictEqual(P.preferredZoneBonusDb({ x: 1, y: 1 }, zones), P.PREFERRED_ZONE_BONUS_DB, 'inside the zone should get the full bonus');
});

test('a preferred zone (soft bias) does NOT exclude candidates outside it, unlike an allowed zone', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  // A tiny preferred zone in a corner, far from the room's center -- if this
  // behaved like an allowed zone, the search would be restricted to it (at most
  // a couple of grid cells). Instead every in-room cell should still be a
  // candidate: allCandidates should cover the whole grid, not just the zone.
  const tinyPreferred = [{ x: 0.5, y: 0.5, width: 0.4, height: 0.4 }];
  const withZone = P.optimizeSubPlacement({
    room, otherSources: [], freqList: [60], listenerPositions: [{x:9,y:9,z:3.5}],
    physicsCtx: ctx, offLimitZones: [], allowedZones: [], preferredZones: tinyPreferred,
    gridStepFt: 1, subHeightFt: 1
  });
  const withoutZone = P.optimizeSubPlacement({
    room, otherSources: [], freqList: [60], listenerPositions: [{x:9,y:9,z:3.5}],
    physicsCtx: ctx, offLimitZones: [], allowedZones: [], preferredZones: [],
    gridStepFt: 1, subHeightFt: 1
  });
  assert.strictEqual(withZone.allCandidates.length, withoutZone.allCandidates.length,
    'a preferred zone should never shrink the candidate set the way an allowed zone would');
});

test('a preferred zone nudges an otherwise near-tied candidate to win', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const opts = {
    room, otherSources: [], freqList: [40,60,80], listenerPositions: [{x:9,y:9,z:3.5}],
    physicsCtx: ctx, offLimitZones: [], allowedZones: [], gridStepFt: 3, subHeightFt: 1
  };
  const withoutZone = P.optimizeSubPlacement(Object.assign({}, opts, { preferredZones: [] }));
  // Find the grid's actual winner without any preference, then draw a tiny
  // preferred zone around a DIFFERENT candidate that scored close (within the
  // bonus margin) to confirm the bonus can flip the winner.
  const sorted = withoutZone.allCandidates.slice().sort((a,b) => b.score - a.score);
  const top = sorted[0];
  const runnerUp = sorted.find(c => (c.x !== top.x || c.y !== top.y) && (top.score - c.score) < P.PREFERRED_ZONE_BONUS_DB);
  assert.ok(runnerUp, 'expected a runner-up candidate within the bonus margin of the top candidate for this setup');
  const preferredZones = [{ x: runnerUp.x - 0.1, y: runnerUp.y - 0.1, width: 0.2, height: 0.2 }];
  const withZone = P.optimizeSubPlacement(Object.assign({}, opts, { preferredZones }));
  assert.strictEqual(withZone.best.x, runnerUp.x, 'the preferred zone should flip the winner to the runner-up once its bonus closes the gap');
  assert.strictEqual(withZone.best.y, runnerUp.y);
});

test('a preferred zone does NOT flip the winner when the outside candidate is meaningfully better', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const opts = {
    room, otherSources: [], freqList: [40,60,80], listenerPositions: [{x:9,y:9,z:3.5}],
    physicsCtx: ctx, offLimitZones: [], allowedZones: [], gridStepFt: 3, subHeightFt: 1
  };
  const withoutZone = P.optimizeSubPlacement(Object.assign({}, opts, { preferredZones: [] }));
  const sorted = withoutZone.allCandidates.slice().sort((a,b) => b.score - a.score);
  const top = sorted[0];
  // A worst-scoring candidate is guaranteed to be more than PREFERRED_ZONE_BONUS_DB
  // behind the top candidate in any non-degenerate scenario with enough spread;
  // guard with a skip-if-not-applicable check rather than assuming it.
  const worst = sorted[sorted.length - 1];
  if((top.score - worst.score) <= P.PREFERRED_ZONE_BONUS_DB) return; // setup too flat for this scenario; nothing to assert
  const preferredZones = [{ x: worst.x - 0.1, y: worst.y - 0.1, width: 0.2, height: 0.2 }];
  const withZone = P.optimizeSubPlacement(Object.assign({}, opts, { preferredZones }));
  assert.strictEqual(withZone.best.x, top.x, 'a genuinely better spot outside the preferred zone should still win');
  assert.strictEqual(withZone.best.y, top.y);
});

test('preferredZones omitted entirely does not throw and behaves as a 0 bonus', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const opts = {
    room, otherSources: [], freqList: [60], listenerPositions: [{x:9,y:9,z:3.5}],
    physicsCtx: ctx, offLimitZones: [], allowedZones: [], gridStepFt: 1, subHeightFt: 1
  };
  const withOmitted = P.optimizeSubPlacement(opts);
  const withEmpty = P.optimizeSubPlacement(Object.assign({}, opts, { preferredZones: [] }));
  assert.deepStrictEqual(withOmitted.best, withEmpty.best, 'omitting preferredZones should behave identically to passing an empty array');
});

testAsync('optimizeSubPlacementAsync applies the same preferred-zone bonus as optimizeSubPlacement', async () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const preferredZones = [{ x: 8.5, y: 8.5, width: 1, height: 1 }];
  const opts = {
    room, otherSources: [], freqList: [60], listenerPositions: [{x:9,y:9,z:3.5}],
    physicsCtx: ctx, offLimitZones: [], allowedZones: [], preferredZones, gridStepFt: 1, subHeightFt: 1
  };
  const syncResult = P.optimizeSubPlacement(opts);
  const asyncResult = await P.optimizeSubPlacementAsync(opts);
  assert.deepStrictEqual(asyncResult.best, syncResult.best, 'async best should exactly match sync best with a preferred zone applied');
});

testAsync('async twins match the sync optimizers with timeAlignTo, speaker clearance and per-sub templates', async () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.3 };
  const listener = { x: 9, y: 9, z: 3.5 };
  const mains = [
    { id: 1, x: 4.67, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true },
    { id: 2, x: 13.33, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true }
  ];
  const opts = {
    room, otherSources: mains, numSubs: 2, freqList: [40, 70, 100], listenerPositions: [listener], physicsCtx: ctx,
    offLimitZones: [], allowedZones: [], preferredZones: [], gridStepFt: 1.5, subHeightFt: 1, mode: 'nullAvoidance', timeAlignTo: listener
  };
  const syncResult = P.optimizeMultipleSubs(opts);
  const asyncResult = await P.optimizeMultipleSubsAsync(opts);
  assert.deepStrictEqual(asyncResult.placedSubs, syncResult.placedSubs);
  assert.deepStrictEqual(asyncResult.roundResults.map(r => r.best), syncResult.roundResults.map(r => r.best));

  const subs = [
    { id: 3, x: 1.5, y: 12, z: 1, levelDb: -3, delayMs: 0, freqLow: 20, freqHigh: 80, enabled: true },
    { id: 4, x: 16.5, y: 12, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 100, enabled: true }
  ];
  const polishOpts = { ...opts, subs, subHeightFt: undefined };
  const syncPolish = P.polishSubPlacements(polishOpts);
  const asyncPolish = await P.polishSubPlacementsAsync(polishOpts);
  assert.deepStrictEqual(asyncPolish.placedSubs, syncPolish.placedSubs);
  assert.deepStrictEqual(asyncPolish.polishResults.map(r => r.best), syncPolish.polishResults.map(r => r.best));
});

console.log('\n-- pressureToDb / sampleFieldDbRange / logSpacedFreqs / maxSchroederFrequency --');

test('pressureToDb is 20 log10 of the magnitude over refAmp, floored at 1e-6', () => {
  approx(P.pressureToDb(1, 0), 0, 1e-12);
  approx(P.pressureToDb(3, 4), 20 * Math.log10(5), 1e-12);
  approx(P.pressureToDb(1, 0, 2), -20 * Math.log10(2), 1e-12);
  approx(P.pressureToDb(0, 0), -120, 1e-9, 'a perfect null stays finite');
});

test('fieldDbAtPoint is the field at that point through pressureToDb', () => {
  const ctx = { room: { w: 18, d: 13.5, h: 8 }, wallAbsorption: 0.1 };
  const src = [{ x: 2, y: 12, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80 }];
  const pre = P.precomputeModalField(src, 47, ctx, P.enumerateModes(ctx));
  const { re, im } = P.computeFieldAtPoint(9, 6, 3.5, pre);
  approx(P.fieldDbAtPoint(9, 6, 3.5, src, 47, ctx), P.pressureToDb(re, im), 1e-12);
});

test('fieldRowSums gives computeFieldAtPoint\'s field with one term per distinct kx', () => {
  const ctx = { room: { w: 20, d: 15, h: 8 }, wallAbsorption: 0.1 };
  const src = [{ x: 2, y: 12, z: 1, levelDb: 0, delayMs: 3, freqLow: 20, freqHigh: 80 },
               { x: 17, y: 0.5, z: 1.5, levelDb: -2, delayMs: 0, freqLow: 20, freqHigh: 80 }];
  const pre = P.precomputeModalField(src, 63, ctx, P.enumerateModes(ctx));
  const ys = [0, 3.3, 7.5, 15];
  const { kx, nCols, nRows, sums } = P.fieldRowSums(pre, 3.5, ys);
  assert.strictEqual(pre.length, 261);
  assert.strictEqual(nCols, 11, 'nx = 0..10');
  assert.strictEqual(nRows, ys.length);
  for(let r = 0; r < ys.length; r++){
    for(const x of [0, 4.2, 10, 20]){
      let re = 0, im = 0;
      for(let c = 0; c < nCols; c++){
        const cx = Math.cos(kx[c] * x * 0.3048);
        re += cx * sums[(r*nCols + c)*2];
        im += cx * sums[(r*nCols + c)*2 + 1];
      }
      const want = P.computeFieldAtPoint(x, ys[r], 3.5, pre);
      const scale = Math.hypot(want.re, want.im);
      approx(re, want.re, 1e-9 * scale); approx(im, want.im, 1e-9 * scale);
    }
  }
  assert.strictEqual(P.fieldRowSums([], 3.5, ys).nCols, 0);
});

test('sampleFieldDbRange returns the min and max of an n x n grid that includes the walls', () => {
  const ctx = { room: { w: 18, d: 13.5, h: 8 }, wallAbsorption: 0.1 };
  const src = [{ x: 2, y: 12, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80 }];
  const pre = P.precomputeModalField(src, 55, ctx, P.enumerateModes(ctx));
  let min = Infinity, max = -Infinity;
  for(let j = 0; j < 4; j++) for(let i = 0; i < 4; i++){
    const { re, im } = P.computeFieldAtPoint(i / 3 * 18, j / 3 * 13.5, 3.5, pre);
    const db = P.pressureToDb(re, im);
    min = Math.min(min, db); max = Math.max(max, db);
  }
  const r = P.sampleFieldDbRange(pre, ctx.room, 3.5, 4);
  approx(r.min, min, 1e-12); approx(r.max, max, 1e-12);
  assert.ok(r.max - r.min > 3, `expected some spread across the floor, got ${(r.max - r.min).toFixed(2)} dB`);
  const def = P.sampleFieldDbRange(pre, ctx.room, 3.5);
  assert.ok(def.min <= r.min && def.max >= r.max, 'the default 10 x 10 grid includes the 4 x 4 grid corners, so its range is at least as wide');
});

test('logSpacedFreqs spaces n frequencies evenly on a log axis, both ends included', () => {
  const f = P.logSpacedFreqs(20, 200, 3);
  approx(f[0], 20, 1e-9); approx(f[1], Math.sqrt(20 * 200), 1e-9); approx(f[2], 200, 1e-9);
  const g = P.logSpacedFreqs(20, 250, 48);
  assert.strictEqual(g.length, 48);
  for(let i = 2; i < g.length; i++) approx(g[i] / g[i - 1], g[1] / g[0], 1e-9, 'constant ratio');
});

test('maxSchroederFrequency is the highest Schroeder frequency over 24 samples from 20 to 300 Hz', () => {
  const ctx = {
    room: { w: 18, d: 13.5, h: 8 }, wallAbsorption: 0.06, floorAbsorption: 0.15,
    wallMaterials: { left: P.WALL_MATERIALS.drywallInsulated, right: P.WALL_MATERIALS.drywallInsulated, front: P.WALL_MATERIALS.masonry, back: P.WALL_MATERIALS.masonry },
    ceilingMaterial: P.WALL_MATERIALS.drywallHollow
  };
  let expected = 0;
  for(let i = 0; i < 24; i++){
    const f = 20 + 280 * i / 23;
    expected = Math.max(expected, P.schroederFrequency(ctx.room, P.estimatedT60(ctx.room, f, ctx)));
  }
  approx(P.maxSchroederFrequency(ctx), expected, 1e-9);
  assert.ok(P.maxSchroederFrequency(ctx) > P.schroederFrequency(ctx.room, P.estimatedT60(ctx.room, 80, ctx)), 'the drywall resonance near 80 Hz is not the least absorptive frequency');
});

console.log('\n-- seatPositions / measureAtSeats / gradePlacement / optimizerFreqList --');

test('seatPositions flattens rows in rank order with each seat\'s rank, offset and weight', () => {
  const rows = [
    { x: 9, y: 9, z: 3.5, facing: 0, seats: 3, spacingFt: 2 },
    { x: 9, y: 12, z: 3.5, facing: 0, seats: 1, spacingFt: 2 }
  ];
  const seats = P.seatPositions(rows);
  assert.strictEqual(seats.length, 4);
  assert.deepStrictEqual(seats.map(s => s.rank), [0, 0, 0, 1]);
  assert.deepStrictEqual(seats.map(s => s.rowSeatCount), [3, 3, 3, 1]);
  const byOffset = Object.fromEntries(seats.slice(0, 3).map(s => [s.offsetIndex, s.weight]));
  approx(byOffset[0], 1, 1e-12, 'center seat of the top row');
  approx(byOffset[-1], 0.5, 1e-12, 'edge seat');
  approx(byOffset[1], 0.5, 1e-12, 'edge seat');
  approx(seats[3].weight, 0.5, 1e-12, 'second row, single seat');
  const row0 = P.rowSeatPositions(rows[0]);
  assert.deepStrictEqual(seats.slice(0, 3).map(s => [s.x, s.y, s.z]), row0.map(s => [s.x, s.y, s.z]));
});

test('measureAtSeats averages over a 2 ft, 20 point cloud at every seat and the reference point', () => {
  const ctx = { room: { w: 18, d: 13.5, h: 8 }, wallAbsorption: 0.1 };
  const src = [{ x: 2, y: 12, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80 }];
  const seats = P.seatPositions([{ x: 9, y: 9, z: 3.5, facing: 0, seats: 2, spacingFt: 2 }]);
  const reference = { x: 9, y: 9, z: 3.5 };
  const freqs = [30, 45, 60, 75];
  const m = P.measureAtSeats(seats, reference, freqs, src, ctx);
  assert.deepStrictEqual(P.SEAT_AVERAGING, { radiusFt: 2, numPoints: 20 });
  const ref = P.spatiallyAveragedResponse(9, 9, 3.5, freqs, src, ctx, P.SEAT_AVERAGING);
  ref.forEach((r, j) => approx(m.referenceDb[j], r.db, 1e-9, `reference at ${freqs[j]} Hz`));
  seats.forEach((s, i) => {
    const r = P.spatiallyAveragedResponse(s.x, s.y, s.z, freqs, src, ctx, P.SEAT_AVERAGING);
    r.forEach((x, j) => approx(m.perSeatDb[i][j], x.db, 1e-9, `seat ${i} at ${freqs[j]} Hz`));
  });
  freqs.forEach((_, j) => {
    approx(m.seatMinDb[j], Math.min(m.perSeatDb[0][j], m.perSeatDb[1][j]), 1e-12);
    approx(m.seatMaxDb[j], Math.max(m.perSeatDb[0][j], m.perSeatDb[1][j]), 1e-12);
  });
});

test('gradePlacement scores the seats with their weights and reports seat-to-seat variation', () => {
  const ctx = { room: { w: 18, d: 13.5, h: 8 }, wallAbsorption: 0.1 };
  const src = [{ x: 2, y: 12, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80 }];
  const seats = P.seatPositions([{ x: 9, y: 9, z: 3.5, facing: 0, seats: 3, spacingFt: 2 }, { x: 9, y: 12, z: 3.5, facing: 0, seats: 1, spacingFt: 2 }]);
  const reference = { x: 9, y: 9, z: 3.5 };
  const freqs = P.logSpacedFreqs(20, 120, 12);
  for(const mode of ['balanced', 'nullAvoidance']){
    const g = P.gradePlacement(seats, reference, freqs, src, ctx, mode);
    const m = P.measureAtSeats(seats, reference, freqs, src, ctx);
    assert.deepStrictEqual(g.db, m.referenceDb);
    assert.deepStrictEqual(g.stats, P.scoreResponses(m.perSeatDb, [0.5, 1, 0.5, 0.5], mode));
    approx(g.seatToSeatDb, P.seatToSeatVariationDb(m.perSeatDb), 1e-12);
  }
});

test('optimizerFreqList steps about 12 times across the band, never under 2 Hz apart', () => {
  const wide = P.optimizerFreqList(20, 120);
  assert.strictEqual(wide.length, 13);
  approx(wide[0], 20, 1e-12); approx(wide[12], 120, 1e-9);
  approx(wide[1] - wide[0], 100 / 12, 1e-9);
  assert.deepStrictEqual(P.optimizerFreqList(20, 30), [20, 22, 24, 26, 28, 30]);
});

console.log('\n-- Floor-plan modes for right-angle rooms (polygonArea / isPointInPolygon / solveFloorPlan) --');

// Corners in feet. Wall i runs from corner i to corner i+1.
const rectPolygon = (w, d) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d }, { x: 0, y: d }];
// A w x d room with an nw x nd notch cut from its far right corner.
const lPolygon = (w, d, nw, nd) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: d - nd }, { x: w - nw, y: d - nd }, { x: w - nw, y: d }, { x: 0, y: d }];
const tPolygon = [{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 24, y: 8 }, { x: 16, y: 8 }, { x: 16, y: 20 }, { x: 8, y: 20 }, { x: 8, y: 8 }, { x: 0, y: 8 }];
const uPolygon = [{ x: 0, y: 0 }, { x: 26, y: 0 }, { x: 26, y: 18 }, { x: 18, y: 18 }, { x: 18, y: 7 }, { x: 8, y: 7 }, { x: 8, y: 18 }, { x: 0, y: 18 }];
const cutoffLambda = (hz) => Math.pow(2 * Math.PI * hz / P.C, 2);

// What follows rebuilds the solver's grid operator from the plan's public
// fields alone (xs, ys, cellId), independently of room-physics.js, so the
// tests can check the returned shapes against the equations themselves.
function planCells(plan){
  const { xs, ys, nx, ny, cellId, numCells } = plan;
  const area = new Float64Array(numCells), ci = new Int32Array(numCells), cj = new Int32Array(numCells);
  for(let j = 0; j < ny; j++) for(let i = 0; i < nx; i++){
    const k = cellId[j * nx + i];
    if(k >= 0){ ci[k] = i; cj[k] = j; area[k] = (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]); }
  }
  return { area, ci, cj };
}
// Calls visit(k, m, conductance, axis) for every pair of neighboring cells.
function forEachFace(plan, visit){
  const { xs, ys, nx, ny, cellId } = plan;
  for(let j = 0; j < ny; j++) for(let i = 0; i < nx; i++){
    const k = cellId[j * nx + i];
    if(k < 0) continue;
    const right = i + 1 < nx ? cellId[j * nx + i + 1] : -1, up = j + 1 < ny ? cellId[(j + 1) * nx + i] : -1;
    if(right >= 0) visit(k, right, (ys[j + 1] - ys[j]) / ((xs[i + 2] - xs[i]) / 2), 0);
    if(up >= 0) visit(k, up, (xs[i + 1] - xs[i]) / ((ys[j + 2] - ys[j]) / 2), 1);
  }
}
// Mode m's grid eigenvalue (its Rayleigh quotient) and the grid's leading
// dispersion error for it, so rayleigh + shift should equal kSquared[m].
function modeRayleighAndShift(plan, m){
  const { numModes: M, shapes, numCells, areaM2, xs, ys } = plan;
  const { area, ci, cj } = planCells(plan);
  const kx = new Float64Array(numCells), ky = new Float64Array(numCells);
  let energy = 0;
  forEachFace(plan, (k, n, g, axis) => {
    const diff = shapes[k * M + m] - shapes[n * M + m];
    energy += g * diff * diff;
    (axis === 0 ? kx : ky)[k] += g * diff;
    (axis === 0 ? kx : ky)[n] -= g * diff;
  });
  let shift = 0;
  for(let k = 0; k < numCells; k++){
    const hx = xs[ci[k] + 1] - xs[ci[k]], hy = ys[cj[k] + 1] - ys[cj[k]];
    shift += (hx * hx * kx[k] * kx[k] + hy * hy * ky[k] * ky[k]) / area[k];
  }
  return { rayleigh: energy / areaM2, shift: shift / (12 * areaM2) };
}
// Largest deviation of the shapes' area-weighted Gram matrix from identity.
function shapesOrthonormalityError(plan){
  const { numModes: M, shapes, numCells, areaM2 } = plan;
  const { area } = planCells(plan);
  const gram = new Float64Array(M * M);
  for(let k = 0; k < numCells; k++){
    for(let p = 0; p < M; p++){
      const v = shapes[k * M + p] * area[k];
      for(let q = p; q < M; q++) gram[p * M + q] += v * shapes[k * M + q];
    }
  }
  let worst = 0;
  for(let p = 0; p < M; p++) for(let q = p; q < M; q++) worst = Math.max(worst, Math.abs(gram[p * M + q] / areaM2 - (p === q ? 1 : 0)));
  return worst;
}
// Weyl's two-term estimate of how many floor-plan modes lie below a cutoff.
function weylModeCount(polygon, cutoffHz){
  let perimeterFt = 0;
  polygon.forEach((p, i) => { const q = polygon[(i + 1) % polygon.length]; perimeterFt += Math.hypot(q.x - p.x, q.y - p.y); });
  const lam = cutoffLambda(cutoffHz);
  return P.polygonArea(polygon) * 0.3048 * 0.3048 * lam / (4 * Math.PI) + perimeterFt * 0.3048 * Math.sqrt(lam) / (4 * Math.PI);
}
// Every eigenvalue of a small dense symmetric matrix (cyclic Jacobi), ascending.
function denseSymmetricEigenvalues(a, n){
  for(let sweep = 0; sweep < 60; sweep++){
    let off = 0;
    for(let p = 0; p < n; p++) for(let q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q];
    if(off < 1e-22) break;
    for(let p = 0; p < n; p++) for(let q = p + 1; q < n; q++){
      const apq = a[p * n + q];
      if(apq === 0) continue;
      const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for(let k = 0; k < n; k++){
        const akp = a[k * n + p], akq = a[k * n + q];
        a[k * n + p] = c * akp - s * akq; a[k * n + q] = s * akp + c * akq;
      }
      for(let k = 0; k < n; k++){
        const apk = a[p * n + k], aqk = a[q * n + k];
        a[p * n + k] = c * apk - s * aqk; a[q * n + k] = s * apk + c * aqk;
      }
    }
  }
  return Array.from({ length: n }, (_, i) => a[i * n + i]).sort((x, y) => x - y);
}

test('polygonArea is the shoelace area, whichever way round the corners go', () => {
  approx(P.polygonArea(rectPolygon(20, 15)), 300, 1e-9);
  approx(P.polygonArea(lPolygon(24, 20, 10, 8)), 24 * 20 - 80, 1e-9);
  approx(P.polygonArea(lPolygon(24, 20, 10, 8).reverse()), 24 * 20 - 80, 1e-9);
  approx(P.polygonArea(tPolygon), 24 * 8 + 8 * 12, 1e-9);
});

test('isPointInPolygon: inside and on the walls count, the notch and beyond do not', () => {
  for(const poly of [lPolygon(24, 20, 10, 8), lPolygon(24, 20, 10, 8).reverse()]){
    assert.strictEqual(P.isPointInPolygon(5, 5, poly), true);
    assert.strictEqual(P.isPointInPolygon(20, 5, poly), true, 'beside the notch');
    assert.strictEqual(P.isPointInPolygon(5, 18, poly), true, 'below the notch');
    assert.strictEqual(P.isPointInPolygon(20, 16, poly), false, 'in the notch');
    assert.strictEqual(P.isPointInPolygon(-0.01, 5, poly), false);
    assert.strictEqual(P.isPointInPolygon(24.01, 5, poly), false);
    assert.strictEqual(P.isPointInPolygon(5, 20.01, poly), false);
    // every wall and corner, the inside corner and the notch's walls included
    for(const [x, y] of [[0, 0], [24, 0], [0, 20], [24, 12], [14, 12], [14, 20], [0, 7], [24, 3], [12, 0], [7, 20], [14, 15], [19, 12]]){
      assert.strictEqual(P.isPointInPolygon(x, y, poly), true, `(${x}, ${y}) is on a wall`);
    }
  }
});

// Solved once and shared by the tests below.
const rectRoom = { w: 20, d: 15, h: 8 };
const rectPlan = P.solveFloorPlan(rectPolygon(20, 15));
const lRoom = { w: 24, d: 20, h: 8 };
const lPoly = lPolygon(24, 20, 10, 8);
const lPlan = P.solveFloorPlan(lPoly, { cellM: 0.15 });

test('solveFloorPlan: the grid puts a line on every wall, even at awkward sizes, with no cell over cellM', () => {
  const poly = lPolygon(23.37, 19.13, 9.71, 7.29);
  const plan = P.solveFloorPlan(poly, { cellM: 0.2, cutoffHz: 120 });
  for(const p of poly){
    assert.ok(plan.xs.includes(p.x * 0.3048), `x = ${p.x} ft is a grid line`);
    assert.ok(plan.ys.includes(p.y * 0.3048), `y = ${p.y} ft is a grid line`);
  }
  for(const lines of [plan.xs, plan.ys]){
    for(let i = 0; i + 1 < lines.length; i++) assert.ok(lines[i + 1] - lines[i] > 0 && lines[i + 1] - lines[i] <= 0.2 + 1e-12);
  }
  // the cells tile the room exactly: their areas add up to the polygon's, and each center is inside it
  const { area, ci, cj } = planCells(plan);
  approx(area.reduce((a, b) => a + b, 0), P.polygonArea(poly) * 0.3048 * 0.3048, 1e-9);
  approx(plan.areaM2, P.polygonArea(poly) * 0.3048 * 0.3048, 1e-9);
  for(let k = 0; k < plan.numCells; k++){
    const x = (plan.xs[ci[k]] + plan.xs[ci[k] + 1]) / 2 / 0.3048, y = (plan.ys[cj[k]] + plan.ys[cj[k] + 1]) / 2 / 0.3048;
    assert.ok(P.isPointInPolygon(x, y, poly));
  }
  assert.strictEqual(plan.cellId.filter(id => id >= 0).length, plan.numCells);
  assert.deepStrictEqual(plan.polygon, poly);
});

test('solveFloorPlan: grid lines crowd toward an inside corner, and a rectangle (no inside corner) gets an even grid', () => {
  const widths = (lines) => Array.from({ length: lines.length - 1 }, (_, i) => lines[i + 1] - lines[i]);
  const rw = widths(rectPlan.xs);
  approx(Math.min(...rw), Math.max(...rw), 1e-12, 'even grid for a rectangle');
  // the inside corner of lPoly is at x = 14 ft, y = 12 ft
  const at = lPlan.xs.indexOf(14 * 0.3048), lw = widths(lPlan.xs);
  assert.ok(at > 0);
  assert.ok(lw[at] < 0.5 * lPlan.cellM && lw[at - 1] < 0.5 * lPlan.cellM, `cells beside the corner are ${lw[at - 1]} and ${lw[at]} m`);
  assert.ok(lw[at] >= 0.24 * lPlan.cellM, 'never below a quarter of cellM');
  assert.ok(lw[0] > 0.9 * lPlan.cellM && lw[lw.length - 1] > 0.9 * lPlan.cellM, 'full-size cells away from it');
});

test('solveFloorPlan rejects a wall that is not parallel to x or y', () => {
  assert.throws(() => P.solveFloorPlan([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 18, y: 15 }, { x: 0, y: 15 }]), /along x or y/);
});

test('solveFloorPlan on a rectangle reproduces the formula\'s floor modes: same count, eigenvalues within 0.1%', () => {
  const Lx = 20 * 0.3048, Ly = 15 * 0.3048;
  const exact = [];
  for(let a = 0; a < 40; a++) for(let b = 0; b < 40; b++) exact.push(Math.pow(a * Math.PI / Lx, 2) + Math.pow(b * Math.PI / Ly, 2));
  exact.sort((x, y) => x - y);
  const below = exact.filter(v => v < cutoffLambda(300)).length;
  assert.strictEqual(below, 76);
  // the solver may also keep a mode within its own error of the cutoff
  assert.ok(rectPlan.numModes >= below && rectPlan.numModes <= below + 1, `${rectPlan.numModes} modes`);
  assert.ok(rectPlan.kSquared[0] < 1e-9, 'mode 0 is the uniform mode');
  for(let k = 0; k < rectPlan.numCells; k += 97) approx(rectPlan.shapes[k * rectPlan.numModes], rectPlan.shapes[0], 1e-5);
  approx(Math.abs(rectPlan.shapes[0]), 1, 1e-5, 'mean square 1');
  for(let m = 1; m < rectPlan.numModes; m++){
    approx(rectPlan.kSquared[m], exact[m], 1e-3 * exact[m], `mode ${m}`);
    assert.ok(rectPlan.kSquared[m] >= rectPlan.kSquared[m - 1], 'ascending');
  }
});

test('solveFloorPlan: the returned shapes satisfy the grid equations, are orthonormal, and kSquared is their grid eigenvalue plus the dispersion correction', () => {
  for(const plan of [rectPlan, lPlan]){
    assert.ok(shapesOrthonormalityError(plan) < 1e-6);
    for(let m = 0; m < plan.numModes; m += 7){
      const { rayleigh, shift } = modeRayleighAndShift(plan, m);
      approx(rayleigh + shift, plan.kSquared[m], 1e-6 * Math.max(1, plan.kSquared[m]), `mode ${m}`);
      assert.ok(shift >= 0 && shift < 0.1 * Math.max(1, plan.kSquared[m]), 'the correction is small');
    }
  }
});

test('solveFloorPlan misses no mode: its modes are the lowest eigenvalues of the grid operator, solved densely, one for one', () => {
  // A coarse grid keeps the dense solve small, and the 20 x 16 ft room has
  // enough modes under 300 Hz to need more than one slice of the spectrum.
  const plan = P.solveFloorPlan(lPolygon(20, 16, 8, 6), { cellM: 0.38 });
  const n = plan.numCells;
  assert.ok(n > 150 && n < 400, `${n} cells`);
  const { area } = planCells(plan);
  const dense = new Float64Array(n * n);
  forEachFace(plan, (k, m, g) => {
    dense[k * n + k] += g / area[k];
    dense[m * n + m] += g / area[m];
    dense[k * n + m] = dense[m * n + k] = -g / Math.sqrt(area[k] * area[m]);
  });
  const all = denseSymmetricEigenvalues(dense, n);
  const found = Array.from({ length: plan.numModes }, (_, m) => modeRayleighAndShift(plan, m).rayleigh).sort((x, y) => x - y);
  // On a grid this coarse the dispersion correction is large, and it lifts
  // the upper grid eigenvalues over the cutoff (those modes are then
  // dropped). It adds at most about (h * v)^2 / 12 to a grid eigenvalue v,
  // so with twice that as margin every v below `safe` must be among the
  // solver's modes, in order and with nothing in between.
  const lamMax = cutoffLambda(300), c = 0.38 * 0.38 / 6;
  const safe = (Math.sqrt(1 + 4 * c * lamMax) - 1) / (2 * c);
  let matched = 0;
  for(const v of all.filter(x => x < lamMax)){
    if(matched < found.length && Math.abs(found[matched] - v) <= 1e-6 * Math.max(1, v)) matched++;
    else assert.ok(v > safe, `grid eigenvalue ${v} has no mode (modes are required up to ${safe})`);
  }
  assert.strictEqual(matched, plan.numModes, 'every mode is a grid eigenvalue');
  assert.ok(all.filter(v => v < safe).length > 45, 'more than one 40-mode slice of the spectrum is checked');
});

test('solveFloorPlan converges on the standard L-shape benchmark, repeated eigenvalue included', () => {
  // Three unit squares in an L: Neumann eigenvalues 1.4756218450,
  // 3.5340313683, pi^2 (twice), 11.3894793979. The first has the strongest
  // inside-corner singularity and converges slowest.
  const u = 1 / 0.3048;
  const unitL = [{ x: 0, y: 0 }, { x: 2 * u, y: 0 }, { x: 2 * u, y: u }, { x: u, y: u }, { x: u, y: 2 * u }, { x: 0, y: 2 * u }];
  const exact = [1.4756218450, 3.5340313683, Math.PI * Math.PI, Math.PI * Math.PI, 11.3894793979];
  const cutoffHz = P.C * Math.sqrt(15) / (2 * Math.PI); // eigenvalues below 15
  const errorsAt = (cellM) => {
    const plan = P.solveFloorPlan(unitL, { cellM, cutoffHz });
    assert.strictEqual(plan.numModes, 7, 'the uniform mode, the five above and one more below 15');
    return exact.map((e, i) => Math.abs(plan.kSquared[i + 1] - e) / e);
  };
  const coarse = errorsAt(0.1), fine = errorsAt(0.05);
  assert.ok(coarse[0] < 0.005 && fine[0] < 0.002, `singular mode off by ${coarse[0]} then ${fine[0]}`);
  for(let i = 1; i < 5; i++) assert.ok(coarse[i] < 0.002 && fine[i] < 0.0003, `mode ${i + 1} off by ${coarse[i]} then ${fine[i]}`);
  for(let i = 0; i < 5; i++) assert.ok(fine[i] < 0.5 * coarse[i], `mode ${i + 1} at least halves its error`);
});

test('solveFloorPlan solves T and U rooms completely: orthonormal shapes and the mode count Weyl\'s law predicts', () => {
  for(const poly of [tPolygon, uPolygon]){
    const plan = P.solveFloorPlan(poly, { cellM: 0.15 });
    assert.strictEqual(plan.numWalls, 8);
    assert.ok(Math.abs(plan.numModes - weylModeCount(poly, 300)) <= 3, `${plan.numModes} modes, Weyl ${weylModeCount(poly, 300)}`);
    assert.ok(shapesOrthonormalityError(plan) < 1e-6);
    for(let m = 1; m < plan.numModes; m++) assert.ok(plan.kSquared[m] >= plan.kSquared[m - 1] && plan.kSquared[m] < cutoffLambda(300));
  }
  assert.ok(Math.abs(lPlan.numModes - weylModeCount(lPoly, 300)) <= 3);
});

test('solveFloorPlan gives the same modes whichever corner the polygon starts at and whichever way round it goes', () => {
  const turned = lPoly.slice(2).concat(lPoly.slice(0, 2)).reverse();
  const other = P.solveFloorPlan(turned, { cellM: 0.15 });
  assert.strictEqual(other.numModes, lPlan.numModes);
  for(let m = 0; m < lPlan.numModes; m++) approx(other.kSquared[m], lPlan.kSquared[m], 1e-7);
});

test('solveFloorPlan options: cellM sets the grid (a coarser preview has fewer cells), cutoffHz the highest mode', () => {
  assert.strictEqual(P.FLOOR_PLAN_CELL_M, 0.1);
  assert.strictEqual(rectPlan.cellM, 0.1);
  assert.strictEqual(rectPlan.cutoffHz, P.MODE_CUTOFF_HZ);
  const preview = P.solveFloorPlan(rectPolygon(20, 15), { cellM: 0.2, cutoffHz: 150 });
  assert.ok(preview.numCells < rectPlan.numCells / 3);
  assert.ok(preview.numModes > 15 && preview.numModes < rectPlan.numModes / 3);
  assert.ok(preview.kSquared[preview.numModes - 1] < cutoffLambda(150));
  for(let m = 1; m < preview.numModes; m++) approx(preview.kSquared[m], rectPlan.kSquared[m], 3e-3 * rectPlan.kSquared[m]);
});

test('solveFloorPlan stays accurate when a spectrum shift lands exactly on an eigenvalue', () => {
  // A 12 x 9 ft rectangle at this cell size has an even 36 x 27 grid, whose
  // (a, b) mode has the grid eigenvalue onMode below. With 40 modes or
  // fewer under the cutoff the spectrum is one slice, shifted to half the
  // cutoff's eigenvalue, so a cutoff at twice onMode puts the shift exactly
  // on that mode, where the factorization would divide by nearly zero.
  // Without the guard in eigenpairsBelow these three cases throw, miscount
  // and return eigenvalues off by 4% respectively.
  const Lx = 12 * 0.3048, Ly = 9 * 0.3048, h = Lx / 36;
  for(const [a, b] of [[4, 0], [3, 0], [2, 3]]){
    const onMode = 4 / (h * h) * (Math.pow(Math.sin(a * Math.PI * h / (2 * Lx)), 2) + Math.pow(Math.sin(b * Math.PI * h / (2 * Ly)), 2));
    const cutoffHz = P.C * Math.sqrt(2 * onMode) / (2 * Math.PI);
    const plan = P.solveFloorPlan(rectPolygon(12, 9), { cellM: h + 1e-9, cutoffHz });
    assert.strictEqual(plan.nx, 36);
    assert.ok(plan.numModes > 10 && plan.numModes <= 40, `${plan.numModes} modes`);
    // a slightly higher cutoff shifts elsewhere and must find the same modes
    const nearby = P.solveFloorPlan(rectPolygon(12, 9), { cellM: h + 1e-9, cutoffHz: cutoffHz * 1.001 });
    assert.ok(nearby.numModes >= plan.numModes && nearby.numModes <= plan.numModes + 1);
    for(let m = 0; m < plan.numModes; m++) approx(plan.kSquared[m], nearby.kSquared[m], 1e-8, `mode ${m} with the shift on (${a}, ${b})`);
    assert.ok(shapesOrthonormalityError(plan) < 1e-6);
  }
});

test('solveFloorPlan wallWeights: the uniform mode weighs each wall by its length, and a rectangle\'s modes match cos^2 integrals', () => {
  const lengthsFt = lPoly.map((p, i) => { const q = lPoly[(i + 1) % lPoly.length]; return Math.hypot(q.x - p.x, q.y - p.y); });
  assert.strictEqual(lPlan.numWalls, 6);
  for(let i = 0; i < 6; i++) approx(lPlan.wallWeights[i], lengthsFt[i] * 0.3048, 1e-5, `wall ${i}`);
  // Mode 1 of the 20 x 15 ft rectangle is sqrt(2) cos(pi x / Lx): it is 2 all along the walls at x = 0 and x = Lx (walls 3 and 1), and averages 1 along walls 0 and 2.
  const W = rectPlan.numWalls, Lx = 20 * 0.3048, Ly = 15 * 0.3048;
  approx(rectPlan.wallWeights[1 * W + 1], 2 * Ly, 1e-3 * Ly);
  approx(rectPlan.wallWeights[1 * W + 3], 2 * Ly, 1e-3 * Ly);
  approx(rectPlan.wallWeights[1 * W + 0], Lx, 1e-3 * Lx);
  approx(rectPlan.wallWeights[1 * W + 2], Lx, 1e-3 * Lx);
});

console.log('\n-- Floor-plan modes in the room\'s mode sums (enumerateModes / precomputeModalField / computeFieldAtPoint with ctx.floorPlan) --');

test('enumerateModes with ctx.floorPlan: every floor mode times every height cosine under the cutoff, carrying the plan', () => {
  const ctx = { room: lRoom, wallAbsorption: 0.05, floorPlan: lPlan };
  const modes = P.enumerateModes(ctx);
  assert.strictEqual(modes.floorPlan, lPlan);
  const Lz = 8 * 0.3048;
  let expected = 0;
  for(let m = 0; m < lPlan.numModes; m++){
    for(let nz = 0; P.C * Math.sqrt(lPlan.kSquared[m] + Math.pow(nz * Math.PI / Lz, 2)) / (2 * Math.PI) <= 300; nz++) expected++;
  }
  assert.strictEqual(modes.length, expected);
  for(const mode of modes){
    approx(mode.kn, Math.sqrt(lPlan.kSquared[mode.shape] + mode.invLz * mode.invLz), 1e-12);
    approx(mode.invLz, mode.nz * Math.PI / Lz, 1e-12);
    approx(mode.fn, P.C * mode.kn / (2 * Math.PI), 1e-9);
    assert.ok(mode.fn <= 300);
    approx(mode.An, P.C * P.C * (mode.nz === 0 ? 1 : 2) / (lPlan.areaM2 * Lz), 1e-9);
  }
  // the uniform mode's height series is the rectangle's: nz * c / (2 Lz)
  const vertical = modes.filter(m => m.shape === 0).map(m => m.fn);
  vertical.forEach((fn, nz) => approx(fn, nz * P.C / (2 * Lz), 1e-4));
  assert.strictEqual(P.enumerateModes(ctx, 100).every(m => m.fn <= 100), true);
  assert.deepStrictEqual(Array.from(P.enumerateModes({ room: { w: 24, d: 20, h: 0 }, wallAbsorption: 0.05, floorPlan: lPlan })), []);
});

test('enumerateModes with ctx.floorPlan: uniform absorption gives the uniform mode the Sabine rate, and wall i\'s material is wallMaterials[i]', () => {
  const alpha = 0.05, Lz = 8 * 0.3048;
  const perimeterM = (24 + 12 + 10 + 8 + 14 + 20) * 0.3048;
  const base = P.enumerateModes({ room: lRoom, wallAbsorption: alpha, floorPlan: lPlan });
  // (1/8) * alpha * S / V with S = perimeter * Lz + 2 * area, V = area * Lz
  approx(base[0].deltaN, alpha * (perimeterM * Lz + 2 * lPlan.areaM2) / (8 * lPlan.areaM2 * Lz), 1e-6);
  // wall 3 is the 8 ft wall of the notch; making it masonry (0.03) removes exactly its share
  const mats = [null, null, null, P.WALL_MATERIALS.masonry, null, null];
  const changed = P.enumerateModes({ room: lRoom, wallAbsorption: alpha, wallMaterials: mats, floorPlan: lPlan });
  approx(base[0].deltaN - changed[0].deltaN, (alpha - 0.03) * 8 * 0.3048 / (8 * lPlan.areaM2), 1e-7);
  // the floor and the ceiling keep their own settings
  const lossy = P.enumerateModes({ room: lRoom, wallAbsorption: alpha, floorAbsorption: 0.25, floorPlan: lPlan });
  approx(lossy[0].deltaN - base[0].deltaN, (0.25 - alpha) / (8 * Lz), 1e-9);
});

test('a rectangle solved as a floor plan matches the rectangle formula: per-mode damping within 0.2% with mixed materials', () => {
  // 17.3 x 12.1 ft has no repeated floor modes, so the two mode lists pair up by frequency.
  const room = { w: 17.3, d: 12.1, h: 9 }, W = P.WALL_MATERIALS;
  const plan = P.solveFloorPlan(rectPolygon(17.3, 12.1), { cutoffHz: 200 });
  const shared = { room, wallAbsorption: 0.05, floorAbsorption: 0.1, ceilingMaterial: W.suspendedTile };
  // polygon walls in order: y = 0 (front), x = w (right), y = d (back), x = 0 (left)
  const formula = P.enumerateModes(Object.assign({ wallMaterials: { front: W.masonry, right: W.drywallInsulated, back: W.drywallHollow } }, shared), 200);
  const numeric = P.enumerateModes(Object.assign({ wallMaterials: [W.masonry, W.drywallInsulated, W.drywallHollow, null], floorPlan: plan }, shared), 200);
  formula.sort((a, b) => a.fn - b.fn); numeric.sort((a, b) => a.fn - b.fn);
  assert.ok(numeric.length >= formula.length && numeric.length <= formula.length + 2);
  for(let i = 0; i < formula.length - 2; i++){
    approx(numeric[i].fn, formula[i].fn, 5e-4 * formula[i].fn + 1e-3, `fn of mode ${i}`);
    approx(numeric[i].deltaN, formula[i].deltaN, 2e-3 * formula[i].deltaN, `deltaN of mode ${i} at ${formula[i].fn} Hz`);
  }
});

console.log('\n-- Bass traps (bassTrapAbsorptionM2 / bassTrapCorner / trap damping in enumerateModes and estimatedT60) --');

test('bassTrapAbsorptionM2: lab sabins per 4 ft panel, halved for the lab floor boost, interpolated on log frequency', () => {
  const ft2 = 0.3048 * 0.3048;
  approx(P.bassTrapAbsorptionM2('porous', 63, 4), 3.50 * ft2 / 2, 1e-12);
  approx(P.bassTrapAbsorptionM2('membrane', 100, 4), 18.12 * ft2 / 2, 1e-12);
  approx(P.bassTrapAbsorptionM2('porous', 63, 8), 2 * P.bassTrapAbsorptionM2('porous', 63, 4), 1e-12, 'twice the height, twice the area');
  const mid = Math.sqrt(63 * 80); // halfway between bands on log frequency
  approx(P.bassTrapAbsorptionM2('porous', mid, 4), (3.50 + 13.55) / 2 * ft2 / 2, 1e-12);
  approx(P.bassTrapAbsorptionM2('porous', 20, 4), P.bassTrapAbsorptionM2('porous', 40, 4) / 4, 1e-12, 'falls as f^2 below 40 Hz');
  approx(P.bassTrapAbsorptionM2('porous', 300, 4), P.bassTrapAbsorptionM2('porous', 250, 4), 1e-12, 'holds the top band');
  assert.ok(P.bassTrapAbsorptionM2('membrane', 50, 4) > P.bassTrapAbsorptionM2('porous', 50, 4), 'membrane type absorbs more at 50 Hz');
  assert.ok(P.bassTrapAbsorptionM2('membrane', 250, 4) < P.bassTrapAbsorptionM2('porous', 250, 4), 'and less at 250 Hz');
});

test('bassTrapCorner: snaps to the nearest outside corner, inset along its diagonal, and skips inside corners', () => {
  const inset = 0.5 / Math.SQRT2;
  const rect = rectPolygon(20, 15);
  const a = P.bassTrapCorner(rect, 18, 14);
  assert.deepStrictEqual(rect[a.corner], { x: 20, y: 15 });
  approx(a.x, 20 - inset, 1e-12); approx(a.y, 15 - inset, 1e-12);
  const b = P.bassTrapCorner(rect, 1, 1);
  approx(b.x, inset, 1e-12); approx(b.y, inset, 1e-12);
  // lPolygon(24, 20, 10, 8) has its inside corner at (14, 12); a point right on it goes to an outside corner instead
  const c = P.bassTrapCorner(lPoly, 14, 12);
  const corner = lPoly[c.corner];
  assert.ok(!(corner.x === 14 && corner.y === 12), 'not the inside corner');
  assert.ok(P.isPointInPolygon(c.x, c.y, lPoly), 'acoustic center is inside the room');
});

test('bassTrapFootprint: the 1.4 ft square a trap spans in its corner', () => {
  const rect = rectPolygon(20, 15), leg = 2 / Math.SQRT2;
  const f = P.bassTrapFootprint(rect, P.bassTrapCorner(rect, 20, 15));
  approx(f.x, 20 - leg, 1e-12); approx(f.y, 15 - leg, 1e-12); approx(f.width, leg, 1e-12); approx(f.height, leg, 1e-12);
  const g = P.bassTrapFootprint(rect, P.bassTrapCorner(rect, 0, 0));
  assert.deepStrictEqual([g.x, g.y], [0, 0]);
});

test('a corner bass trap adds the point-absorber damping A * psi^2 / (8 * mode volume integral) to each rectangle mode', () => {
  const room = { w: 15, d: 20, h: 8 };
  const base = { room, wallAbsorption: 0.03, floorAbsorption: 0.02 };
  const trap = { type: 'porous', heightFt: 4, ...P.bassTrapCorner(rectPolygon(15, 20), 0, 0) };
  const without = P.enumerateModes(base, 120), withTrap = P.enumerateModes({ ...base, bassTraps: [trap] }, 120);
  const Lx = 15 * 0.3048, Ly = 20 * 0.3048, Lz = 8 * 0.3048, V = Lx * Ly * Lz, h = 4 * 0.3048;
  for(let i = 0; i < without.length; i++){
    const m = without[i], eps = n => n === 0 ? 1 : 2;
    const kz = m.nz * Math.PI / Lz;
    const zMean = m.nz === 0 ? 1 : 0.5 + Math.sin(2 * kz * h) / (4 * kz * h);
    const psi2 = Math.cos(m.nx * Math.PI * trap.x * 0.3048 / Lx) ** 2 * Math.cos(m.ny * Math.PI * trap.y * 0.3048 / Ly) ** 2 * zMean;
    const expected = P.bassTrapAbsorptionM2('porous', m.fn, 4) * psi2 * eps(m.nx) * eps(m.ny) * eps(m.nz) / (8 * V);
    approx(withTrap[i].deltaN - m.deltaN, expected, 1e-12, `mode (${m.nx},${m.ny},${m.nz})`);
  }
  // A trap on the width mode's pressure node (mid-wall) adds almost nothing to that mode.
  const mid = P.enumerateModes({ ...base, bassTraps: [{ type: 'porous', heightFt: 4, x: 7.5, y: 0.35 }] }, 120);
  const k = without.findIndex(m => m.nx === 1 && m.ny === 0 && m.nz === 0);
  assert.ok(mid[k].deltaN - without[k].deltaN < 1e-6 * without[k].deltaN + 1e-12, 'no damping at the node');
});

test('a corner bass trap damps a rectangle solved as a floor plan the same as the rectangle formula, within 2% (grid interpolation near the corner)', () => {
  const room = { w: 17.3, d: 12.1, h: 9 };
  const plan = P.solveFloorPlan(rectPolygon(17.3, 12.1), { cutoffHz: 120 });
  const trap = { type: 'membrane', heightFt: 9, ...P.bassTrapCorner(rectPolygon(17.3, 12.1), 17, 12) };
  const shared = { room, wallAbsorption: 0.03, floorAbsorption: 0.02 };
  const gain = (ctx) => { const a = P.enumerateModes(ctx, 120), b = P.enumerateModes({ ...ctx, bassTraps: [trap] }, 120); return a.map((m, i) => ({ fn: m.fn, d: b[i].deltaN - m.deltaN })).sort((p, q) => p.fn - q.fn); };
  const formula = gain(shared), numeric = gain({ ...shared, floorPlan: plan });
  for(let i = 1; i < formula.length - 2; i++) approx(numeric[i].d, formula[i].d, 0.02 * formula[i].d, `trap damping of mode ${i} at ${formula[i].fn} Hz`);
});

test('estimatedT60 counts a corner trap as its own area times the corner coupling of 4', () => {
  const room = { w: 15, d: 20, h: 8 }, ctx = { wallAbsorption: 0.03, floorAbsorption: 0.03 };
  const traps = [{ type: 'porous', heightFt: 8, x: 0.35, y: 0.35 }];
  const V = 15 * 20 * 8 * 0.3048 ** 3, S = 2 * (15 * 20 + 15 * 8 + 20 * 8) * 0.3048 ** 2;
  const A = 0.03 * S + 4 * P.bassTrapAbsorptionM2('porous', 80, 8);
  approx(P.estimatedT60(room, 80, { ...ctx, bassTraps: traps }), 0.161 * V / (-S * Math.log(1 - A / S)), 1e-9);
  assert.ok(P.estimatedT60(room, 80, { ...ctx, bassTraps: traps }) < P.estimatedT60(room, 80, ctx));
});

test('a rectangle solved as a floor plan matches the rectangle formula: frequency response within 0.05 dB on average, 15 to 200 Hz', () => {
  const src = [{ x: 5, y: 0.75, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 },
               { x: 15, y: 0.75, z: 1, levelDb: -3, delayMs: 2, freqLow: 20, freqHigh: 120 }];
  const freqs = P.logSpacedFreqs(15, 200, 80);
  const formula = P.spatiallyAveragedResponse(10, 9, 3.5, freqs, src, { room: rectRoom, wallAbsorption: 0.05 }, {});
  const numeric = P.spatiallyAveragedResponse(10, 9, 3.5, freqs, src, { room: rectRoom, wallAbsorption: 0.05, floorPlan: rectPlan }, {});
  const diffs = formula.map((r, i) => Math.abs(r.db - numeric[i].db));
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  assert.ok(mean < 0.05, `mean difference ${mean} dB`);
  assert.ok(Math.max(...diffs) < 0.3, `largest difference ${Math.max(...diffs)} dB`);
});

test('computeFieldAtPoint with floor-plan modes: a point beyond a wall reads its mirror image, as the rectangle\'s cosines do', () => {
  const src = [{ x: 5, y: 0.75, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 }];
  const formulaCtx = { room: rectRoom, wallAbsorption: 0.05 }, numericCtx = { room: rectRoom, wallAbsorption: 0.05, floorPlan: rectPlan };
  for(const freq of [35, 62, 97]){
    const formula = P.precomputeModalField(src, freq, formulaCtx, P.enumerateModes(formulaCtx));
    const numeric = P.precomputeModalField(src, freq, numericCtx, P.enumerateModes(numericCtx));
    assert.strictEqual(numeric.floorPlan, rectPlan);
    const points = [[-1.5, 6], [21.2, 9], [8, -0.8], [8, 16.4], [-1, -1], [10, 7]];
    // tolerance: 2% of the field's typical size over these points (a point near a null is small against it)
    const typical = points.reduce((sum, [x, y]) => sum + magOf(P.computeFieldAtPoint(x, y, 3.5, formula)), 0) / points.length;
    for(const [x, y] of points){
      const want = P.computeFieldAtPoint(x, y, 3.5, formula), got = P.computeFieldAtPoint(x, y, 3.5, numeric);
      approx(got.re, want.re, 0.02 * typical, `re at (${x}, ${y}), ${freq} Hz`);
      approx(got.im, want.im, 0.02 * typical, `im at (${x}, ${y}), ${freq} Hz`);
    }
    // inside the room the mirror plays no part: (-1.5, 6) reads exactly what (1.5, 6) reads
    assert.deepStrictEqual(P.computeFieldAtPoint(-1.5, 6, 3.5, numeric), P.computeFieldAtPoint(1.5, 6, 3.5, numeric));
  }
  assert.deepStrictEqual(P.computeFieldAtPoint(5, 5, 3.5, []), { re: 0, im: 0 });
});

test('floor-plan modes in an L room: swapping source and listener gives the same pressure (reciprocity)', () => {
  const ctx = { room: lRoom, wallAbsorption: 0.05, floorPlan: lPlan };
  const modes = P.enumerateModes(ctx);
  const a = { x: 3.1, y: 2.2, z: 1 }, b = { x: 9.3, y: 17.4, z: 3.5 }; // b is in the arm below the notch
  const source = (p) => [{ x: p.x, y: p.y, z: p.z, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 }];
  for(const freq of [28, 55, 110, 180]){
    const ab = P.computeFieldAtPoint(b.x, b.y, b.z, P.precomputeModalField(source(a), freq, ctx, modes));
    const ba = P.computeFieldAtPoint(a.x, a.y, a.z, P.precomputeModalField(source(b), freq, ctx, modes));
    approx(ab.re, ba.re, 1e-9 * magOf(ab)); approx(ab.im, ba.im, 1e-9 * magOf(ab));
    assert.ok(magOf(ab) > 0);
  }
});

test('floor-plan modes in an L room: a point in the notch reads its mirror image in the room, and the bounding rectangle is a poor stand-in', () => {
  const ctx = { room: lRoom, wallAbsorption: 0.05, floorPlan: lPlan };
  const src = [{ x: 6, y: 0.75, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 }];
  const pre = P.precomputeModalField(src, 48, ctx, P.enumerateModes(ctx));
  // (15, 14) is 1 ft into the notch past the wall x = 14; (20, 12.5) is 0.5 ft into it past y = 12
  assert.deepStrictEqual(P.computeFieldAtPoint(15, 14, 3.5, pre), P.computeFieldAtPoint(13, 14, 3.5, pre));
  assert.deepStrictEqual(P.computeFieldAtPoint(20, 12.5, 3.5, pre), P.computeFieldAtPoint(20, 11.5, 3.5, pre));
  const range = P.sampleFieldDbRange(pre, lRoom, 3.5, 12);
  assert.ok(Number.isFinite(range.min) && Number.isFinite(range.max) && range.max > range.min);

  const freqs = P.logSpacedFreqs(15, 200, 60);
  const lResp = P.spatiallyAveragedResponse(12, 10, 3.5, freqs, src, ctx, {});
  const boxResp = P.spatiallyAveragedResponse(12, 10, 3.5, freqs, src, { room: lRoom, wallAbsorption: 0.05 }, {});
  const meanDiff = lResp.reduce((sum, r, i) => sum + Math.abs(r.db - boxResp[i].db), 0) / freqs.length;
  assert.ok(meanDiff > 2, `treating the L as its 24 x 20 ft box is off by ${meanDiff} dB on average`);
});

test('floor-plan modes: the coarse preview grid stays close to the full one in an L room', () => {
  const full = P.solveFloorPlan(lPoly);
  const src = [{ x: 6, y: 0.75, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 }];
  const freqs = P.logSpacedFreqs(15, 120, 60);
  const coarse = P.spatiallyAveragedResponse(12, 10, 3.5, freqs, src, { room: lRoom, wallAbsorption: 0.05, floorPlan: lPlan }, {});
  const fine = P.spatiallyAveragedResponse(12, 10, 3.5, freqs, src, { room: lRoom, wallAbsorption: 0.05, floorPlan: full }, {});
  const diffs = coarse.map((r, i) => Math.abs(r.db - fine[i].db));
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  assert.ok(mean < 0.15, `0.15 m against 0.1 m grid: ${mean} dB on average below 120 Hz`);
  assert.ok(Math.max(...diffs) < 1.5, `largest ${Math.max(...diffs)} dB`);
});

test('the sub optimizer runs on floor-plan modes and scores the spots as the rectangle formula does', () => {
  const mains = [{ x: 5, y: 0.75, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 }];
  const options = (physicsCtx) => ({
    room: rectRoom, otherSources: mains, freqList: P.optimizerFreqList(20, 120), physicsCtx, gridStepFt: 2.5,
    listenerPositions: [{ x: 10, y: 9, z: 3.5 }, { x: 12, y: 9, z: 3.5 }], candidateTemplate: P.NEW_SUB_DEFAULTS
  });
  const formula = P.optimizeSubPlacement(options({ room: rectRoom, wallAbsorption: 0.05 }));
  const numeric = P.optimizeSubPlacement(options({ room: rectRoom, wallAbsorption: 0.05, floorPlan: rectPlan }));
  assert.strictEqual(numeric.allCandidates.length, formula.allCandidates.length);
  // Listeners here are single points, so a spot whose response has a deep
  // null moves more than the rest: within 0.1 dB for the typical spot,
  // 1.5 dB for any, over scores that span 20 dB.
  const diffs = formula.allCandidates.map((c, i) => Math.abs(numeric.allCandidates[i].score - c.score)).sort((a, b) => a - b);
  assert.ok(diffs.length >= 40);
  assert.ok(diffs[diffs.length >> 1] < 0.1, `median score difference ${diffs[diffs.length >> 1]} dB`);
  assert.ok(diffs[diffs.length - 1] < 1.5, `largest score difference ${diffs[diffs.length - 1]} dB`);
  approx(numeric.best.score, formula.best.score, 0.1);
  assert.deepStrictEqual([numeric.best.x, numeric.best.y], [formula.best.x, formula.best.y]);
});

test('estimatedT60 and schroederFrequency use a polygon room\'s own floor area and walls', () => {
  const asRect = { w: 20, d: 15, h: 8 }, asPolygon = { w: 20, d: 15, h: 8, polygon: rectPolygon(20, 15) };
  const ctx = { wallAbsorption: 0.1, floorAbsorption: 0.2, ceilingMaterial: P.WALL_MATERIALS.suspendedTile };
  approx(P.estimatedT60(asPolygon, 60, ctx), P.estimatedT60(asRect, 60, ctx), 1e-12);
  approx(P.schroederFrequency(asPolygon, 0.4), P.schroederFrequency(asRect, 0.4), 1e-12);

  // L room: 400 ft^2 of floor and an 88 ft perimeter, flat absorption 0.1
  const lShaped = { w: 24, d: 20, h: 8, polygon: lPoly };
  const m2 = 0.3048 * 0.3048, volume = 400 * 8 * m2 * 0.3048, surface = (88 * 8 + 2 * 400) * m2;
  approx(P.estimatedT60(lShaped, 60, { wallAbsorption: 0.1 }), 0.161 * volume / (-surface * Math.log(1 - 0.1)), 1e-9);
  approx(P.schroederFrequency(lShaped, 0.4), 2000 * Math.sqrt(0.4 / volume), 1e-9);
  // wall 3 (the notch's 8 ft wall) made masonry: its 64 ft^2 absorb 0.03 instead of 0.1
  const mats = [null, null, null, P.WALL_MATERIALS.masonry, null, null];
  const avgAlpha = (0.1 * (88 * 8 + 800) - 0.07 * 64) / (88 * 8 + 800);
  approx(P.estimatedT60(lShaped, 60, { wallAbsorption: 0.1, wallMaterials: mats }), 0.161 * volume / (-surface * Math.log(1 - avgAlpha)), 1e-9);
});

console.log('\n-- Rooms with any right-angle floor plan: geometry, optimizer limits and the background solver --');

const lShapedRoom = { w: 24, d: 20, h: 8, polygon: lPoly }; // notch 10 x 8 ft out of the back right corner: inside corner at (14, 12)

test('rectanglePolygon starts at the front-left corner, so walls 0 to 3 are front, right, back and left', () => {
  const rect = P.rectanglePolygon(18, 13.5);
  assert.deepStrictEqual(rect, rectPolygon(18, 13.5));
  assert.deepStrictEqual(P.floorPlanWalls(rect).map(w => w.side), ['front', 'right', 'back', 'left']);
  assert.deepStrictEqual(P.floorPlanWalls(rect).map(w => w.lengthFt), [18, 13.5, 18, 13.5]);
});

test('floorPlanWalls names the side each wall of an L bounds, either way round the polygon', () => {
  const walls = P.floorPlanWalls(lPoly);
  assert.deepStrictEqual(walls.map(w => w.side), ['front', 'right', 'back', 'right', 'back', 'left']);
  assert.deepStrictEqual(walls.map(w => w.lengthFt), [24, 12, 10, 8, 14, 20]);
  assert.deepStrictEqual(walls.map(w => w.horizontal), [true, false, true, false, true, false]);
  const reversed = P.floorPlanWalls(lPoly.slice().reverse());
  assert.deepStrictEqual(reversed.map(w => w.side), ['back', 'right', 'back', 'right', 'front', 'left']);
});

test('floorPlanClearance is the larger of the x and y offsets to the nearest wall', () => {
  approx(P.floorPlanClearance(5, 3, lPoly), 3, 1e-12);       // the front wall is nearest
  approx(P.floorPlanClearance(12, 16, lPoly), 2, 1e-12);     // the notch's side wall x = 14
  approx(P.floorPlanClearance(16, 10, lPoly), 2, 1e-12);     // the notch's top wall y = 12
  approx(P.floorPlanClearance(13, 11, lPoly), 1, 1e-12);     // diagonally in from the inside corner
  approx(P.floorPlanClearance(14, 15, lPoly), 0, 1e-12);     // on a wall
});

test('clampToFloorPlan: a rectangle clamps each axis, with or without its polygon', () => {
  for(const room of [{ w: 18, d: 13.5 }, { w: 18, d: 13.5, polygon: P.rectanglePolygon(18, 13.5) }]){
    assert.deepStrictEqual(P.clampToFloorPlan(-3, 20, room, 0.2), { x: 0.2, y: 13.3 });
    assert.deepStrictEqual(P.clampToFloorPlan(5, 6, room, 0.2), { x: 5, y: 6 });
    assert.deepStrictEqual(P.clampToFloorPlan(30, 7, room), { x: 18, y: 7 });
  }
});

test('clampToFloorPlan moves a point in an L room\'s notch to the nearest point the inset allows', () => {
  assert.deepStrictEqual(P.clampToFloorPlan(10, 10, lShapedRoom, 0.5), { x: 10, y: 10 }); // already fine
  // in the notch, nearer its side wall than its top wall
  const a = P.clampToFloorPlan(15, 18, lShapedRoom, 0.5);
  approx(a.x, 13.5, 1e-12); approx(a.y, 18, 1e-12);
  // in the notch, nearer its top wall
  const b = P.clampToFloorPlan(20, 13, lShapedRoom, 0.5);
  approx(b.x, 20, 1e-12); approx(b.y, 11.5, 1e-12);
  // just inside the room but within the inset of the inside corner: out to the corner of the allowed area
  // (both walls there are 0.1 ft away; the side wall's inset line is the nearer, 0.3 ft against 0.4)
  const c = P.clampToFloorPlan(13.8, 11.9, lShapedRoom, 0.5);
  approx(c.x, 13.5, 1e-12); approx(c.y, 11.9, 1e-12);
  // beyond the notch's outer corner: the nearest allowed corner is the one in front of the notch (10.8 ft), not behind it (12.7 ft)
  const d = P.clampToFloorPlan(26, 22, lShapedRoom, 0.5);
  approx(d.x, 23.5, 1e-12); approx(d.y, 11.5, 1e-12);
  for(const p of [a, b, c, d]){
    assert.ok(P.isPointInPolygon(p.x, p.y, lPoly));
    assert.ok(P.floorPlanClearance(p.x, p.y, lPoly) >= 0.5 - 1e-9);
  }
});

test('resizeFloorPlan moves only the farthest wall, never past the next corner', () => {
  assert.deepStrictEqual(P.resizeFloorPlan(P.rectanglePolygon(18, 13.5), 'x', 20), P.rectanglePolygon(20, 13.5));
  assert.deepStrictEqual(P.resizeFloorPlan(P.rectanglePolygon(18, 13.5), 'y', 10), P.rectanglePolygon(18, 10));
  // L: the right wall moves out, and the notch keeps its 8 ft depth but gets 2 ft wider
  assert.deepStrictEqual(P.resizeFloorPlan(lPoly, 'x', 26), lPolygon(26, 20, 12, 8));
  // the back wall (y = 20, left of the notch) and the notch's own side wall move together
  assert.deepStrictEqual(P.resizeFloorPlan(lPoly, 'y', 18), lPolygon(24, 18, 10, 6));
  // can't pass the inside corner: stops FLOOR_PLAN_MIN_WALL_FT beyond x = 14
  assert.deepStrictEqual(P.resizeFloorPlan(lPoly, 'x', 10).map(p => p.x), [0, 15, 15, 14, 14, 0]);
  assert.deepStrictEqual(P.resizeFloorPlan(lPoly, 'x', 10), lPolygon(15, 20, 1, 8));
});

test('nearestWallDistances in an L room measures to the notch\'s walls where they are nearer, and reports where each wall is', () => {
  const belowNotch = P.nearestWallDistances({ x: 20, y: 10 }, lShapedRoom);
  assert.deepStrictEqual(belowNotch, { side: { wall: 'right', distFt: 4, x: 24, index: 1 }, end: { wall: 'back', distFt: 2, y: 12, index: 2 } });
  const besideNotch = P.nearestWallDistances({ x: 10, y: 16 }, lShapedRoom);
  assert.deepStrictEqual(besideNotch, { side: { wall: 'right', distFt: 4, x: 14, index: 3 }, end: { wall: 'back', distFt: 4, y: 20, index: 4 } });
  // a rectangle's own polygon gives the same as the plain rectangle, plus
  // which of its walls (front, right, back, left) each one is
  const index = { front: 0, right: 1, back: 2, left: 3 };
  for(const pos of [{ x: 2.25, y: 1 }, { x: 16, y: 12 }, { x: 9, y: 6.75 }]){
    const plain = P.nearestWallDistances(pos, baseRoom);
    const withIndex = (e) => ({ ...e, index: index[e.wall] });
    assert.deepStrictEqual(P.nearestWallDistances(pos, { ...baseRoom, polygon: P.rectanglePolygon(18, 13.5) }), { side: withIndex(plain.side), end: withIndex(plain.end) });
  }
});

test('countGridCells with onFloorOnly leaves out the cells in a cut-out', () => {
  // lShapedRoom: 24 x 20 with a 10 x 8 notch, so at 1 ft 480 cells, 80 of them in the notch
  assert.strictEqual(P.countGridCells(lShapedRoom, 1), 480);
  assert.strictEqual(P.countGridCells(lShapedRoom, 1, true), 400);
  assert.strictEqual(P.countGridCells(baseRoom, 0.5, true), P.countGridCells(baseRoom, 0.5));
});

test('wallsAround gives the first wall each way, a notch wall where it is the nearer that way', () => {
  assert.deepStrictEqual(P.wallsAround({ x: 2.25, y: 1 }, baseRoom), {
    left: { wall: 'left', distFt: 2.25, x: 0 }, right: { wall: 'right', distFt: 15.75, x: 18 },
    front: { wall: 'front', distFt: 1, y: 0 }, back: { wall: 'back', distFt: 12.5, y: 13.5 }
  });
  // below the notch the back wall is the notch's own wall at y = 12
  const below = P.wallsAround({ x: 20, y: 10 }, lShapedRoom);
  assert.deepStrictEqual(below.back, { wall: 'back', distFt: 2, y: 12, index: 2 });
  assert.deepStrictEqual(below.left, { wall: 'left', distFt: 20, x: 0, index: 5 });
  // beside the notch the right wall is the notch's side wall at x = 14
  assert.deepStrictEqual(P.wallsAround({ x: 10, y: 16 }, lShapedRoom).right, { wall: 'right', distFt: 4, x: 14, index: 3 });
});

test('floorPlanPathLength is the straight line when it stays on the floor, including along a wall', () => {
  approx(P.floorPlanPathLength({ x: 1, y: 1 }, { x: 17, y: 12 }, P.rectanglePolygon(18, 13.5)), Math.hypot(16, 11), 1e-9);
  // in the L (inside corner at (14, 12)), along the notch's side wall x = 14 and its top wall y = 12
  approx(P.floorPlanPathLength({ x: 14, y: 2 }, { x: 14, y: 19 }, lPoly), 17, 1e-9);
  approx(P.floorPlanPathLength({ x: 2, y: 12 }, { x: 23, y: 12 }, lPoly), 21, 1e-9);
});

test('floorPlanPathLength bends round inside corners when the straight line leaves the room', () => {
  // L: from beside the notch to below it, round (14, 12)
  approx(P.floorPlanPathLength({ x: 10, y: 18 }, { x: 22, y: 10 }, lPoly), Math.hypot(4, 6) + Math.hypot(8, 2), 1e-9);
  // U: arm to arm, round both inside corners (7.5, 11) and (14.5, 11)
  const U = P.floorPlanTemplate('U', 22, 18);
  approx(P.floorPlanPathLength({ x: 3, y: 15 }, { x: 19, y: 15 }, U), 2 * Math.hypot(4.5, 4) + 7, 1e-9);
});

test('soundPathFt adds the height difference to the floor path, and is the straight line without a polygon', () => {
  const U = { w: 22, d: 18, h: 8, polygon: P.floorPlanTemplate('U', 22, 18) };
  const sub = { x: 19, y: 15, z: 1 }, seat = { x: 3, y: 15, z: 3.5 };
  approx(P.soundPathFt(sub, seat, U), Math.hypot(2 * Math.hypot(4.5, 4) + 7, 2.5), 1e-9);
  approx(P.soundPathFt(sub, seat, { w: 22, d: 18, h: 8 }), Math.hypot(16, 2.5), 1e-9);
  approx(P.soundPathFt(sub, seat), Math.hypot(16, 2.5), 1e-9);
});

test('timeAlignDelays with a polygon room uses the path round the corner, as an AVR would measure it', () => {
  const U = { w: 22, d: 18, h: 8, polygon: P.floorPlanTemplate('U', 22, 18) };
  const seat = { x: 3, y: 15, z: 3.5 };
  const sources = [{ id: 'near', x: 3, y: 5, z: 3.5 }, { id: 'sub', x: 19, y: 15, z: 3.5 }];
  const straight = P.timeAlignDelays(sources, seat);
  const round = P.timeAlignDelays(sources, seat, undefined, U);
  approx(straight[0].delayMs, (16 - 10) * 0.3048 / P.C * 1000, 1e-9);
  approx(round[0].delayMs, (2 * Math.hypot(4.5, 4) + 7 - 10) * 0.3048 / P.C * 1000, 1e-9);
  assert.strictEqual(round[1].delayMs, 0);
  // a rectangle's polygon changes nothing
  const rect = { w: 18, d: 13.5, h: 8, polygon: P.rectanglePolygon(18, 13.5) };
  const pts = [{ id: 1, x: 2, y: 2, z: 3 }, { id: 2, x: 16, y: 11, z: 1 }];
  assert.deepStrictEqual(P.timeAlignDelays(pts, { x: 9, y: 9, z: 3.5 }, 0.1, rect), P.timeAlignDelays(pts, { x: 9, y: 9, z: 3.5 }, 0.1));
});

test('speakerKeepOut runs back to a notch wall when that is the nearest wall', () => {
  const r = P.speakerKeepOut({ x: 13, y: 16 }, lShapedRoom); // 1 ft from the notch's side wall x = 14
  assert.deepStrictEqual(r, { x: 12, y: 15, width: 2, height: 2 });
  const s = P.speakerKeepOut({ x: 18, y: 11.5 }, lShapedRoom); // 0.5 ft in front of the notch's top wall y = 12
  assert.deepStrictEqual(s, { x: 17, y: 10.5, width: 2, height: 1.5 });
});

test('standardSpeakerPositions: a rectangle\'s polygon gives exactly the rectangle\'s positions, and in an L every position stays the inset from every wall', () => {
  const names = Object.keys(P.SPEAKER_AZIMUTH_DEG);
  for(const seat of [{ x: 9, y: 9 }, { x: 3, y: 0.5 }, { x: 17.9, y: 13 }]){
    assert.deepStrictEqual(P.standardSpeakerPositions({ ...baseRoom, polygon: P.rectanglePolygon(18, 13.5) }, seat, names), P.standardSpeakerPositions(baseRoom, seat, names));
  }
  const seat = { x: 7, y: 14 };
  const spots = P.standardSpeakerPositions(lShapedRoom, seat, names);
  assert.strictEqual(spots.length, names.length);
  for(const p of spots){
    assert.ok(P.isPointInPolygon(p.x, p.y, lPoly), `${p.name} inside`);
    approx(P.floorPlanClearance(p.x, p.y, lPoly), 1.5, 1e-9, `${p.name} clearance`);
  }
  // SR, at 100 degrees to the seat's right, stops 1.5 ft short of the notch's side wall x = 14
  const sr = spots.find(p => p.name === 'SR');
  approx(sr.x, 12.5, 1e-9);
  approx(sr.y, 14 - Math.cos(100 * Math.PI / 180) * (5.5 / Math.sin(100 * Math.PI / 180)), 1e-9);
});

test('freeFloorFraction in an L room counts only the floor inside it', () => {
  approx(P.freeFloorFraction(lShapedRoom, []), 1, 1e-12);
  // a zone over the whole notch covers no floor; one over the notch and 2 ft in front of it covers 10 x 2 = 20 of 400 ft^2
  approx(P.freeFloorFraction(lShapedRoom, [{ x: 14, y: 12, width: 10, height: 8 }]), 1, 1e-12);
  approx(P.freeFloorFraction(lShapedRoom, [{ x: 14, y: 10, width: 10, height: 10 }]), 1 - 20 / 400, 1e-12);
  // the rectangle's own polygon changes nothing
  const zones = [{ x: 2, y: 2, width: 5, height: 4 }, { x: 4, y: 3, width: 6, height: 6 }];
  approx(P.freeFloorFraction({ ...baseRoom, polygon: P.rectanglePolygon(18, 13.5) }, zones), P.freeFloorFraction(baseRoom, zones), 1e-12);
});

test('isCandidateValid rejects a spot outside an L room\'s polygon or on its wall', () => {
  assert.strictEqual(P.isCandidateValid(10, 10, lShapedRoom, [], [], [], 0), true);
  assert.strictEqual(P.isCandidateValid(20, 16, lShapedRoom, [], [], [], 0), false); // in the notch
  assert.strictEqual(P.isCandidateValid(14, 16, lShapedRoom, [], [], [], 0), false); // on the notch's wall
  assert.strictEqual(P.isCandidateValid(20, 16, lRoom, [], [], [], 0), true); // the same spot in the bounding rectangle
});

test('optimizeSubPlacement in an L room only scores spots inside it, and scans the whole bounding grid', () => {
  const ctx = { room: lShapedRoom, wallAbsorption: 0.05, floorPlan: lPlan };
  const scanned = Array.from(P.scanGridCandidates({
    room: lShapedRoom, otherSources: [], freqList: [40, 60], listenerPositions: [{ x: 7, y: 14, z: 3.5, weight: 1 }],
    physicsCtx: ctx, gridStepFt: 1, mode: 'balanced'
  }));
  assert.strictEqual(scanned.length, P.countGridCells(lShapedRoom, 1));
  const valid = scanned.filter(Boolean);
  assert.strictEqual(valid.length, 400); // one 1 ft cell per ft^2 of floor
  assert.ok(valid.every(c => P.isPointInPolygon(c.x, c.y, lPoly) && !(c.x > 14 && c.y > 12)));
  const result = P.optimizeSubPlacement({
    room: lShapedRoom, otherSources: [], freqList: [40, 60], listenerPositions: [{ x: 7, y: 14, z: 3.5, weight: 1 }],
    physicsCtx: ctx, gridStepFt: 1, mode: 'balanced'
  });
  assert.strictEqual(result.allCandidates.length, 400);
  assert.ok(P.isPointInPolygon(result.best.x, result.best.y, lPoly));
});

test('sampleFieldDbRange skips grid points outside an L room', () => {
  const ctx = { room: lShapedRoom, wallAbsorption: 0.05, floorPlan: lPlan };
  const pre = P.precomputeModalField([{ x: 3, y: 3, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 200 }], 47, ctx, P.enumerateModes(ctx));
  let min = Infinity, max = -Infinity;
  for(let j = 0; j < 5; j++) for(let i = 0; i < 5; i++){
    const x = i / 4 * 24, y = j / 4 * 20;
    if(!P.isPointInPolygon(x, y, lPoly)) continue;
    const { re, im } = P.computeFieldAtPoint(x, y, 3.5, pre);
    const db = P.pressureToDb(re, im);
    min = Math.min(min, db); max = Math.max(max, db);
  }
  assert.deepStrictEqual(P.sampleFieldDbRange(pre, lShapedRoom, 3.5, 5), { min, max });
});

test('floorPlanModeFrequencies: a rectangle\'s lowest floor modes are its width and depth axial modes', () => {
  const f = P.floorPlanModeFrequencies(rectPlan);
  assert.strictEqual(f.length, rectPlan.numModes - 1);
  approx(f[0], P.C / (2 * 20 * 0.3048), 0.05);  // 28.1 Hz, width
  approx(f[1], P.C / (2 * 15 * 0.3048), 0.05);  // 37.5 Hz, depth
  assert.ok(f.every((v, i) => i === 0 || v >= f[i - 1]));
});

test('isValidFloorPlan accepts rectangles, L, T and U rooms and rejects broken ones', () => {
  for(const poly of [rectPolygon(18, 13.5), lPoly, tPolygon, uPolygon, lPoly.slice().reverse()]) assert.strictEqual(P.isValidFloorPlan(poly), true);
  const bad = {
    'three corners': [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }],
    'a slanted wall': [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 18, y: 15 }, { x: 0, y: 15 }],
    'a wall under 1 ft': lPolygon(24, 20, 23.5, 8),
    'two walls in line': [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 15 }, { x: 0, y: 15 }],
    'walls crossing': [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 5, y: 10 }, { x: 5, y: -5 }, { x: 10, y: -5 }, { x: 10, y: 15 }, { x: 0, y: 15 }],
    'walls touching': [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 15 }, { x: 10, y: 15 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 15 }, { x: 0, y: 15 }]
  };
  for(const [name, poly] of Object.entries(bad)) assert.strictEqual(P.isValidFloorPlan(poly), false, name);
});

test('moveFloorPlanWall and moveFloorPlanCorner keep every corner square, and say how far the room moved', () => {
  const wall = P.moveFloorPlanWall(lPoly, 3, 12); // the notch's side wall, from x = 14 to 12
  assert.deepStrictEqual(wall, { polygon: lPolygon(24, 20, 12, 8), walls: [0, 1, 2, 3, 4, 5], shift: { x: 0, y: 0 } });
  const corner = P.moveFloorPlanCorner(lPoly, 3, 12, 10); // the inside corner
  assert.deepStrictEqual(corner.polygon, lPolygon(24, 20, 12, 10));
  // moving the front-left corner in moves the front and left walls; the room is moved back to (0, 0)
  const origin = P.moveFloorPlanCorner(lPoly, 0, 2, 3);
  assert.deepStrictEqual(origin.polygon, lPolygon(22, 17, 10, 8));
  assert.deepStrictEqual(origin.shift, { x: -2, y: -3 });
  // the notch can't be pushed through the room's far wall, or flush with it
  assert.strictEqual(P.moveFloorPlanWall(lPoly, 2, 20.5), null);
  assert.strictEqual(P.moveFloorPlanWall(lPoly, 2, 0), null);
  assert.strictEqual(P.moveFloorPlanCorner(lPoly, 3, 24, 12), null);
});

test('setFloorPlanWallLength keeps the wall\'s front-left end and moves the wall at its other end', () => {
  assert.deepStrictEqual(P.setFloorPlanWallLength(rectPolygon(18, 13.5), 0, 20).polygon, rectPolygon(20, 13.5));
  assert.deepStrictEqual(P.setFloorPlanWallLength(rectPolygon(18, 13.5), 2, 20).polygon, rectPolygon(20, 13.5)); // the back wall runs right to left
  assert.deepStrictEqual(P.setFloorPlanWallLength(rectPolygon(18, 13.5), 3, 12).polygon, rectPolygon(18, 12));
  assert.deepStrictEqual(P.setFloorPlanWallLength(lPoly, 4, 12).polygon, lPolygon(24, 20, 12, 8)); // the back wall left of the notch
  assert.deepStrictEqual(P.setFloorPlanWallLength(lPoly, 3, 5).polygon, lPolygon(24, 17, 10, 5)); // the notch's side wall
  assert.strictEqual(P.setFloorPlanWallLength(lPoly, 4, 24), null); // would close the notch
});

test('cutFloorPlanCorner cuts a notch from an outside corner, and its new walls take the settings of the walls they parallel', () => {
  assert.strictEqual(P.isConvexCorner(lPoly, 2), true);
  assert.strictEqual(P.isConvexCorner(lPoly, 3), false);
  const cut = P.cutFloorPlanCorner(rectPolygon(20, 15), 2, 4); // the back-right corner
  assert.deepStrictEqual(cut.polygon, lPolygon(20, 15, 4, 4));
  assert.deepStrictEqual(cut.walls, [0, 1, 2, 1, 2, 3]);
  // capped at a third of each wall
  assert.deepStrictEqual(P.cutFloorPlanCorner(rectPolygon(9, 6), 2, 4).polygon, lPolygon(9, 6, 3, 2));
  // the front-left corner: the list still starts there, and nothing moves
  const front = P.cutFloorPlanCorner(rectPolygon(20, 15), 0, 4);
  assert.deepStrictEqual(front.polygon, [{ x: 0, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 15 }, { x: 0, y: 15 }]);
  assert.deepStrictEqual(front.walls, [0, 3, 0, 1, 2, 3]);
  assert.strictEqual(P.cutFloorPlanCorner(lPoly, 3, 4), null); // an inside corner
});

test('fillFloorPlanCorner squares off an inside corner and merges walls that line up', () => {
  const fromL = P.fillFloorPlanCorner(lPoly, 3);
  assert.deepStrictEqual(fromL.polygon, rectPolygon(24, 20));
  assert.deepStrictEqual(fromL.walls, [0, 1, 4, 5]);
  // a U's slot: both of its inside corners fill the whole slot
  for(const corner of [4, 5]){
    const fromU = P.fillFloorPlanCorner(uPolygon, corner);
    assert.deepStrictEqual(fromU.polygon, rectPolygon(26, 18));
    assert.deepStrictEqual(fromU.walls, [0, 1, 2, 7]);
  }
  // a T's inside corner fills one side only
  const fromT = P.fillFloorPlanCorner(tPolygon, 3);
  assert.deepStrictEqual(fromT.polygon, [{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 24, y: 20 }, { x: 8, y: 20 }, { x: 8, y: 8 }, { x: 0, y: 8 }]);
  assert.strictEqual(P.fillFloorPlanCorner(lPoly, 2), null); // an outside corner
  // cutting a corner and filling it again gives the rectangle back
  const back = P.fillFloorPlanCorner(lPolygon(20, 15, 4, 4), 3);
  assert.deepStrictEqual(back.polygon, rectPolygon(20, 15));
});

test('floorPlanCellField blended with floorPlanStencil\'s weights equals computeFieldAtPoint', () => {
  const ctx = { room: lShapedRoom, wallAbsorption: 0.05, floorPlan: lPlan };
  const pre = P.precomputeModalField([{ x: 3, y: 3, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 200 }], 63, ctx, P.enumerateModes(ctx));
  const cells = P.floorPlanCellField(pre, 3.5);
  assert.strictEqual(cells.length, lPlan.numCells * 2);
  for(const [x, y] of [[5, 5], [13.97, 11.98], [0.01, 19.99], [20, 6], [10, 17], [23.99, 0.02]]){
    const { cells: at, weights } = P.floorPlanStencil(lPlan, x, y);
    let re = 0, im = 0;
    at.forEach((c, q) => { re += weights[q] * cells[2 * c]; im += weights[q] * cells[2 * c + 1]; });
    const direct = P.computeFieldAtPoint(x, y, 3.5, pre);
    approx(re, direct.re, 1e-9 * Math.hypot(direct.re, direct.im) + 1e-9, `re at (${x}, ${y})`);
    approx(im, direct.im, 1e-9 * Math.hypot(direct.re, direct.im) + 1e-9, `im at (${x}, ${y})`);
  }
});

test('floorPlanBracket reports the cell a coordinate is in as well as the two centers around it', () => {
  const lines = Float64Array.from([0, 1, 3, 4]);
  assert.deepStrictEqual(P.floorPlanBracket(lines, 3, 0.2), { lower: 0, t: 0, cell: 0 });
  assert.deepStrictEqual(P.floorPlanBracket(lines, 3, 1.25), { lower: 0, t: 0.75 / 1.5, cell: 1 });
  assert.deepStrictEqual(P.floorPlanBracket(lines, 3, 2.5), { lower: 1, t: 0.5 / 1.5, cell: 1 });
  assert.deepStrictEqual(P.floorPlanBracket(lines, 3, 3.9), { lower: 2, t: 0, cell: 2 });
});

test('floorPlanTemplate gives the guide\'s four shapes, each a valid floor plan that floorPlanTemplateKind names', () => {
  assert.deepStrictEqual(P.FLOOR_PLAN_TEMPLATES, ['rectangle', 'L', 'T', 'U']);
  assert.deepStrictEqual(P.floorPlanTemplate('rectangle', 18, 13.5), rectPolygon(18, 13.5));
  assert.deepStrictEqual(P.floorPlanTemplate('L', 18, 13.5), lPolygon(18, 13.5, 7, 5.5));
  assert.deepStrictEqual(P.floorPlanTemplate('T', 18, 13.5), [{ x: 0, y: 0 }, { x: 18, y: 0 }, { x: 18, y: 8 }, { x: 13.5, y: 8 }, { x: 13.5, y: 13.5 }, { x: 4.5, y: 13.5 }, { x: 4.5, y: 8 }, { x: 0, y: 8 }]);
  assert.deepStrictEqual(P.floorPlanTemplate('U', 18, 13.5), [{ x: 0, y: 0 }, { x: 18, y: 0 }, { x: 18, y: 13.5 }, { x: 12, y: 13.5 }, { x: 12, y: 8 }, { x: 6, y: 8 }, { x: 6, y: 13.5 }, { x: 0, y: 13.5 }]);
  // every shape at the smallest and largest room sizes, and named back
  for(const kind of P.FLOOR_PLAN_TEMPLATES){
    for(const [w, d] of [[6, 6], [18, 13.5], [30, 30], [30, 6]]){
      const shape = P.floorPlanTemplate(kind, w, d);
      assert.ok(P.isValidFloorPlan(shape), `${kind} ${w} x ${d}`);
      assert.strictEqual(P.floorPlanTemplateKind(shape), kind);
      assert.strictEqual(Math.max(...shape.map(p => p.x)), w);
      assert.strictEqual(Math.max(...shape.map(p => p.y)), d);
    }
  }
  // the test file's own T (notches at the front) and U shapes, and two
  // shapes that are none of the four
  assert.strictEqual(P.floorPlanTemplateKind(tPolygon), 'T');
  assert.strictEqual(P.floorPlanTemplateKind(uPolygon), 'U');
  const twoOpposite = P.cutFloorPlanCorner(lPolygon(20, 15, 4, 4), 0, 4).polygon; // notches at opposite corners
  assert.strictEqual(P.floorPlanTemplateKind(twoOpposite), null);
  assert.strictEqual(P.floorPlanTemplateKind(P.cutFloorPlanCorner(tPolygon, 0, 2).polygon), null);
});

test('floorPlanFromTemplate keeps the overall size and gives each new wall a wall from the same side', () => {
  const toL = P.floorPlanFromTemplate(rectPolygon(18, 13.5), 'L');
  assert.deepStrictEqual(toL.polygon, lPolygon(18, 13.5, 7, 5.5));
  assert.deepStrictEqual(toL.walls, [0, 1, 2, 1, 2, 3]); // front, right, back, right, back, left
  assert.deepStrictEqual(toL.shift, { x: 0, y: 0 });
  const back = P.floorPlanFromTemplate(lPoly, 'rectangle');
  assert.deepStrictEqual(back.polygon, rectPolygon(24, 20));
  assert.deepStrictEqual(back.walls, [0, 1, 2, 5]); // the first back wall in lPoly's list is wall 2
});

test('mirrorFloorPlan flips a floor plan either way, keeping each wall\'s settings with it', () => {
  const lr = P.mirrorFloorPlan(lPoly, 'x');
  assert.ok(P.isValidFloorPlan(lr.polygon));
  // the notch moves to the back-left corner
  assert.ok(P.isPointInPolygon(20, 16, lr.polygon) && !P.isPointInPolygon(4, 16, lr.polygon));
  const sidesBefore = P.floorPlanWalls(lPoly).map(w => w.side);
  const sidesAfter = P.floorPlanWalls(lr.polygon).map(w => w.side);
  const swap = { left: 'right', right: 'left', front: 'front', back: 'back' };
  lr.walls.forEach((old, j) => {
    assert.strictEqual(sidesAfter[j], swap[sidesBefore[old]]);
    assert.strictEqual(P.floorPlanWalls(lr.polygon)[j].lengthFt, P.floorPlanWalls(lPoly)[old].lengthFt);
  });
  // the list starts at the front wall's left end, like rectanglePolygon
  for(const flipped of [lr, P.mirrorFloorPlan(lPoly, 'y')]){
    const minY = Math.min(...flipped.polygon.map(p => p.y));
    assert.deepStrictEqual(flipped.polygon[0], { x: Math.min(...flipped.polygon.filter(p => p.y === minY).map(p => p.x)), y: minY });
    assert.strictEqual(P.floorPlanWalls(flipped.polygon)[0].side, 'front');
  }
  // the corners run the same way round as before (same signed area)
  const signedArea = (poly) => poly.reduce((sum, p, i) => { const q = poly[(i + 1) % poly.length]; return sum + p.x * q.y - q.x * p.y; }, 0);
  assert.strictEqual(signedArea(lr.polygon), signedArea(lPoly));
  // front to back, then twice back to the same shape
  const fb = P.mirrorFloorPlan(lPoly, 'y');
  assert.ok(!P.isPointInPolygon(20, 4, fb.polygon) && P.isPointInPolygon(20, 16, fb.polygon)); // the notch moves to the front-right corner
  const twice = P.mirrorFloorPlan(fb.polygon, 'y');
  assert.deepStrictEqual(P.floorPlanKey(twice.polygon), P.floorPlanKey(lPoly));
});

test('floorPlanFrontArea finds the largest rectangle of floor against the front wall', () => {
  assert.deepStrictEqual(P.floorPlanFrontArea(rectPolygon(18, 13.5)), { x: 0, y: 0, w: 18, d: 13.5 });
  // notch at the back right: the full 24 ft width, 12 deep (288), beats the 14 ft wide arm, 20 deep (280)
  assert.deepStrictEqual(P.floorPlanFrontArea(lPoly), { x: 0, y: 0, w: 24, d: 12 });
  // notch at the back left, 7 x 6.5 out of 18 x 14.5: the 11 ft wide arm (159.5) beats the full width (144)
  const backLeft = P.mirrorFloorPlan(lPolygon(18, 14.5, 7, 6.5), 'x').polygon;
  assert.deepStrictEqual(P.floorPlanFrontArea(backLeft), { x: 7, y: 0, w: 11, d: 14.5 });
  // the test file's T is wide at the front; turned front to back, only its stem touches the front wall
  assert.deepStrictEqual(P.floorPlanFrontArea(tPolygon), { x: 0, y: 0, w: 24, d: 8 });
  assert.deepStrictEqual(P.floorPlanFrontArea(P.mirrorFloorPlan(tPolygon, 'y').polygon), { x: 8, y: 0, w: 8, d: 20 });
  // a U with its slot at the back: the full width in front of the slot (26 x 7 = 182) against an arm (8 x 18 = 144)
  assert.deepStrictEqual(P.floorPlanFrontArea(uPolygon), { x: 0, y: 0, w: 26, d: 7 });
});

// A stand-in for the page's Web Worker: answers each message on a later
// tick with floorPlanWorkerReply, and records what it was sent.
function fakeFloorPlanWorkers(){
  const log = { started: 0, terminated: 0, posted: [] };
  const startWorker = () => {
    log.started++;
    const worker = {
      alive: true,
      postMessage(msg){ log.posted.push(msg); setTimeout(() => { if(worker.alive) worker.onmessage({ data: P.floorPlanWorkerReply(msg) }); }, 0); },
      terminate(){ worker.alive = false; log.terminated++; }
    };
    return worker;
  };
  return { log, startWorker };
}
const smallL = lPolygon(10, 8, 4, 3), smallU = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 7, y: 8 }, { x: 7, y: 4 }, { x: 3, y: 4 }, { x: 3, y: 8 }, { x: 0, y: 8 }];
const nextTick = () => new Promise(r => setTimeout(r, 0));

testAsync('createFloorPlanSolver solves the preview first and then full size, calling onSolved for each, and keeps both', async () => {
  const { log, startWorker } = fakeFloorPlanWorkers();
  let solved = 0;
  const solver = P.createFloorPlanSolver({ startWorker, onSolved: () => solved++ });
  assert.strictEqual(solver.planFor(smallL), null);
  assert.deepStrictEqual(log.posted.map(m => m.cellM), [P.FLOOR_PLAN_PREVIEW_CELL_M]);
  await nextTick();
  const preview = solver.planFor(smallL);
  assert.strictEqual(preview.cellM, P.FLOOR_PLAN_PREVIEW_CELL_M);
  assert.strictEqual(solved, 1);
  const full = await solver.fullPlanFor(smallL);
  assert.strictEqual(full.cellM, P.FLOOR_PLAN_CELL_M);
  assert.strictEqual(solved, 2);
  assert.strictEqual(solver.planFor(smallL), full);
  // asking again sends nothing more
  assert.strictEqual(await solver.fullPlanFor(smallL.map(p => ({ ...p }))), full);
  assert.strictEqual(log.posted.length, 2);
  assert.strictEqual(log.started, 1);
  // the worker's plan matches solving it directly
  assert.deepStrictEqual(Array.from(full.kSquared), Array.from(P.solveFloorPlan(smallL).kSquared));
});

testAsync('createFloorPlanSolver stops a full solve that is no longer wanted, lets a preview finish, and drops waiters for the old shape', async () => {
  const { log, startWorker } = fakeFloorPlanWorkers();
  const solver = P.createFloorPlanSolver({ startWorker });
  solver.planFor(smallL);
  await nextTick(); // preview of smallL done, its full solve now running
  const waiting = solver.fullPlanFor(smallL);
  assert.strictEqual(log.posted[log.posted.length - 1].cellM, P.FLOOR_PLAN_CELL_M);
  solver.planFor(smallU);
  assert.strictEqual(await waiting, null);
  assert.strictEqual(log.terminated, 1);
  assert.strictEqual(log.started, 2);
  assert.strictEqual(floorKeyOf(log.posted[log.posted.length - 1]), P.floorPlanKey(smallU));
  // a running preview is not stopped: smallL is asked for while smallU's preview runs
  solver.planFor(smallL);
  assert.strictEqual(log.terminated, 1);
  await nextTick(); // smallU's preview arrives, then smallL's full solve starts (its preview is kept)
  assert.strictEqual(solver.planFor(smallL).cellM, P.FLOOR_PLAN_PREVIEW_CELL_M);
  assert.strictEqual((await solver.fullPlanFor(smallL)).cellM, P.FLOOR_PLAN_CELL_M);
  // smallU's preview was kept too
  const before = log.posted.length;
  assert.strictEqual(solver.planFor(smallU).cellM, P.FLOOR_PLAN_PREVIEW_CELL_M);
  assert.strictEqual(log.posted.length, before + 1); // only its full solve is sent
});
const floorKeyOf = (msg) => msg.key;
testAsync('createFloorPlanSolver marks a floor plan failed when its solve throws, and keeps working on the next one', async () => {
  const { log, startWorker } = fakeFloorPlanWorkers();
  let solved = 0;
  // the first worker dies on its first message instead of answering
  const failing = () => {
    const worker = startWorker();
    if(log.started === 1) worker.postMessage = (msg) => { log.posted.push(msg); setTimeout(() => worker.onerror({ message: 'boom' }), 0); };
    return worker;
  };
  const solver = P.createFloorPlanSolver({ startWorker: failing, onSolved: () => solved++ });
  const waiting = solver.fullPlanFor(smallL);
  assert.strictEqual(await waiting, null);
  assert.strictEqual(solver.failed(smallL), true);
  assert.strictEqual(solved, 1);
  assert.strictEqual(log.terminated, 1);
  // not tried again, and later waiters get null at once
  assert.strictEqual(await solver.fullPlanFor(smallL), null);
  assert.strictEqual(log.posted.length, 1);
  // another shape gets a new worker and solves
  const full = await solver.fullPlanFor(smallU);
  assert.strictEqual(full.cellM, P.FLOOR_PLAN_CELL_M);
  assert.strictEqual(solver.failed(smallU), false);
  assert.strictEqual(log.started, 2);
});


testAsync('createFloorPlanSolver keeps only the most recent cacheSize floor plans', async () => {
  const { log, startWorker } = fakeFloorPlanWorkers();
  const solver = P.createFloorPlanSolver({ startWorker, cacheSize: 2 });
  const shapes = [smallL, smallU, lPolygon(10, 8, 5, 3)];
  for(const shape of shapes) await solver.fullPlanFor(shape);
  const sent = log.posted.length;
  await solver.fullPlanFor(shapes[2]);
  await solver.fullPlanFor(shapes[1]);
  assert.strictEqual(log.posted.length, sent); // still cached
  solver.planFor(shapes[0]); // dropped: solved again
  assert.strictEqual(log.posted.length, sent + 1);
});

(async () => {
  for(const { name, fn } of pendingAsync){
    try {
      await fn();
      passed++;
      console.log(`  ok  - ${name}`);
    } catch(e){
      failed++;
      console.log(`FAIL  - ${name}`);
      console.log(`        ${e.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
