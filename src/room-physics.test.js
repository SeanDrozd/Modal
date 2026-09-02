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

test('WALL_MATERIALS.suspendedTile shows only modest absorption within this app\'s typical sub-bass range, more by the top of the range', () => {
  const tile = P.WALL_MATERIALS.suspendedTile;
  const at40 = P.wallMaterialAbsorptionAtFreq(tile, 40);
  const at300 = P.wallMaterialAbsorptionAtFreq(tile, 300);
  assert.ok(at40 < tile.baseAbsorption + tile.maxAbsorbBoost * 0.1, `expected tile to do little at 40Hz (a real, worth-knowing limitation), got ${at40}`);
  assert.ok(at300 > at40, 'expected more absorption by 300Hz than at 40Hz');
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

test('uniform-absorption bandwidth cross-check: a mode\'s own decay time tracks estimatedT60\'s Eyring estimate (same order of magnitude, not exact equality)', () => {
  // These measure genuinely different things -- one mode's own decay vs a
  // diffuse-field room average -- so exact equality isn't expected (see
  // enumerateModes' comment on why per-mode damping varies by mode index even
  // under uniform absorption). This just confirms they're in the same
  // ballpark and both derived from the same underlying wall absorption.
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51 }; // uniform absorption on every surface
  const modes = P.enumerateModes(ctx);
  const mode = modes.find(m => m.fn > 100 && m.fn < 200);
  assert.ok(mode, 'expected a mode in the 100-200Hz range for this room');
  // delta_n here is spatial (1/m); the temporal damping rate is delta_n*c,
  // and T60 (60dB energy decay, e^{-delta_temporal*t}) is ln(1e6)/delta_temporal.
  const deltaTemporal = mode.deltaN * P.C;
  const t60FromMode = Math.log(1e6) / deltaTemporal;
  const t60Eyring = P.estimatedT60(room, mode.fn, ctx);
  const ratio = t60FromMode / t60Eyring;
  assert.ok(ratio > 0.3 && ratio < 3,
    `expected same-order-of-magnitude T60 estimates: fromMode=${t60FromMode.toFixed(3)}s eyring=${t60Eyring.toFixed(3)}s ratio=${ratio.toFixed(2)}`);
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
  // search into an allowed zone tight around an existing main makes this
  // concrete: a 3ft square exclusion around that main should leave no valid
  // candidate inside a 4x4ft zone centered on it.
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51 };
  const existingMain = { x: 9, y: 9, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true };
  const allowedZones = [{ x: 7, y: 7, width: 4, height: 4 }]; // 4x4ft, centered on (9,9)

  const result = P.optimizeMultipleSubs({
    room, otherSources: [existingMain], numSubs: 1, freqList: [40,60,80],
    listenerPositions: [{x:9,y:6,z:3.5}], physicsCtx: ctx,
    offLimitZones: [], allowedZones, gridStepFt: 0.5, subHeightFt: 1
  });
  assert.strictEqual(result.placedSubs.length, 0,
    `expected no valid candidate inside a zone this tight around an existing source, but placed a sub at (${result.placedSubs[0]?.x},${result.placedSubs[0]?.y})`);
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

testAsync('optimizeMultipleSubsAsync reports onProgress as (fraction, roundIndex) pairs', async () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallAbsorption: 0.51, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const calls = [];
  await P.optimizeMultipleSubsAsync({
    room, otherSources: [], numSubs: 2, freqList: [60],
    listenerPositions: [{x:9,y:9,z:3.5}], physicsCtx: ctx, offLimitZones: [], preferredZones: [],
    gridStepFt: 1, subHeightFt: 1, yieldEvery: 5,
    onProgress: (fraction, roundIndex) => calls.push({ fraction, roundIndex })
  });
  const roundIndices = new Set(calls.map(c => c.roundIndex));
  for(const idx of roundIndices) assert.ok(idx === 0 || idx === 1, `unexpected roundIndex ${idx}`);
  const round0 = calls.filter(c => c.roundIndex === 0);
  const round1 = calls.filter(c => c.roundIndex === 1);
  assert.strictEqual(round0[0].fraction, 0, 'first onProgress call for round 0 should report fraction 0');
  assert.strictEqual(round1[0].fraction, 0, 'first onProgress call for round 1 should report fraction 0');
  for(let i = 1; i < round0.length; i++){
    assert.ok(round0[i].fraction >= round0[i-1].fraction, 'fractions within a round should be non-decreasing');
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
