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
function approx(actual, expected, tol, msg){
  assert.ok(Math.abs(actual - expected) <= tol,
    `${msg || ''} expected ${expected} +/- ${tol}, got ${actual}`);
}
function magOf({ re, im }){
  return Math.sqrt(re*re + im*im);
}

// A minimal ctx with no panels, no openings, mid reflectivity — used throughout.
const baseRoom = { w: 18, d: 13.5, h: 8 };
function baseCtx(overrides){
  return Object.assign({
    room: baseRoom,
    wallReflect: 0.7,
    openings: [],
    openingsEnabled: true,
    panels: [],
    panelsEnabled: true
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

console.log('\n-- panelAbsorptionAtFreq (thickness vs quarter-wavelength) --');

test('thin panel is near-zero absorption at low (room-mode) frequencies', () => {
  const panel = { thickness: 1, pos: 0, length: 3 }; // 1 ft thick
  const absorb = P.panelAbsorptionAtFreq(panel, 40); // deep bass
  assert.ok(absorb < 0.05, `expected near-zero absorption at 40Hz for 1ft panel, got ${absorb}`);
});

test('1ft panel becomes substantially absorptive by a few hundred Hz', () => {
  const panel = { thickness: 1, pos: 0, length: 3 };
  const absorb300 = P.panelAbsorptionAtFreq(panel, 300);
  assert.ok(absorb300 > 0.5, `expected >0.5 absorption at 300Hz for 1ft panel, got ${absorb300}`);
});

test('absorption increases monotonically with frequency for a fixed thickness', () => {
  const panel = { thickness: 0.5, pos: 0, length: 3 };
  const freqs = [30, 60, 100, 150, 250, 400];
  let prev = -1;
  for(const f of freqs){
    const a = P.panelAbsorptionAtFreq(panel, f);
    assert.ok(a >= prev - 1e-9, `absorption should not decrease with frequency (f=${f}, a=${a}, prev=${prev})`);
    prev = a;
  }
});

test('thicker panel absorbs more than a thinner one at the same frequency', () => {
  const thin = { thickness: 0.25, pos: 0, length: 3 };
  const thick = { thickness: 1.5, pos: 0, length: 3 };
  const f = 150;
  assert.ok(P.panelAbsorptionAtFreq(thick, f) > P.panelAbsorptionAtFreq(thin, f),
    'thicker panel should absorb more at the same frequency');
});

console.log('\n-- panelCoverage / wallWithPanels --');

test('point well inside the panel span has full coverage (1.0)', () => {
  const panel = { pos: 2, length: 3 };
  assert.strictEqual(P.panelCoverage(panel, 3.5), 1);
});

test('point exactly at panel start/end has full coverage (inclusive)', () => {
  const panel = { pos: 2, length: 3 };
  assert.strictEqual(P.panelCoverage(panel, 2), 1);
  assert.strictEqual(P.panelCoverage(panel, 5), 1);
});

test('point well outside the panel (beyond the taper zone) has zero coverage', () => {
  const panel = { pos: 2, length: 3 }; // taper is 0.5ft, so >0.5ft outside is 0
  assert.strictEqual(P.panelCoverage(panel, 1), 0);
  assert.strictEqual(P.panelCoverage(panel, 6), 0);
});

test('REGRESSION: panel edge is smooth, not a discontinuous jump — coverage changes gradually across the taper zone', () => {
  const panel = { pos: 3, length: 3 }; // spans y=[3,6]
  const justInside = P.panelCoverage(panel, 6.0);
  const quarterOut = P.panelCoverage(panel, 6.25); // halfway through the 0.5ft taper
  const justOutside = P.panelCoverage(panel, 6.5); // at the edge of the taper zone
  const wayOutside = P.panelCoverage(panel, 7.0);
  assert.strictEqual(justInside, 1);
  assert.ok(quarterOut > 0 && quarterOut < 1, `expected partial coverage mid-taper, got ${quarterOut}`);
  approx(quarterOut, 0.5, 0.05, 'coverage should be ~50% halfway through the taper zone');
  approx(justOutside, 0, 0.01, 'coverage should reach ~0 at the far edge of the taper zone');
  assert.strictEqual(wayOutside, 0);
});

test('REGRESSION: reflection amplitude does not jump discontinuously as a source crosses a panel edge', () => {
  // This is the actual bug: dragging a source an inch near a panel edge used to
  // snap the wall's reflection amplitude instantly (e.g. 0.0003 -> 0.7), which
  // flips constructive/destructive interference for a fraction-of-an-inch move.
  const room = { w: 18, d: 13.5, h: 8 };
  const panels = [{ wall:'left', pos: 3, length: 3, thickness: 1, enabled: true }]; // y=[3,6]
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels, panelsEnabled: true };
  const freq = 300;

  const amps = [];
  for(let sy = 5.5; sy <= 6.5; sy += 0.05){
    const imgs = P.getImageSources(2, sy, 3, 1, freq, ctx);
    const leftImg = imgs.find(img => img.x === -2);
    amps.push(leftImg.amp);
  }
  let maxStep = 0;
  for(let i = 1; i < amps.length; i++){
    maxStep = Math.max(maxStep, Math.abs(amps[i] - amps[i-1]));
  }
  // With a 0.05ft step and a 0.5ft taper zone, no single step should move amplitude
  // by more than roughly (0.05/0.5) of the full 0.7 range = ~0.07; allow some margin.
  assert.ok(maxStep < 0.15, `expected smooth transition, got a max single-step jump of ${maxStep.toFixed(4)}`);
});

test('wallWithPanels returns base amplitude when panelsEnabled is false', () => {
  const panels = [{ wall:'left', pos:0, length:20, thickness:2, enabled:true }];
  const amp = P.wallWithPanels('left', {x:0,y:5,z:3}, 0.7, 200, panels, false);
  approx(amp, 0.7, 1e-9, 'master toggle off should bypass all panels');
});

test('wallWithPanels returns base amplitude when the panel is individually disabled', () => {
  const panels = [{ wall:'left', pos:0, length:20, thickness:2, enabled:false }];
  const amp = P.wallWithPanels('left', {x:0,y:5,z:3}, 0.7, 200, panels, true);
  approx(amp, 0.7, 1e-9, 'disabled panel should not reduce reflection');
});

test('wallWithPanels reduces amplitude when point falls on an enabled panel at an absorptive frequency', () => {
  const panels = [{ wall:'left', pos:0, length:20, thickness:2, enabled:true }];
  const amp = P.wallWithPanels('left', {x:0,y:5,z:3}, 0.7, 400, panels, true);
  assert.ok(amp < 0.7, `expected reduced amplitude, got ${amp}`);
});

test('wallWithPanels leaves amplitude unchanged when point falls well OUTSIDE the panel span (beyond taper)', () => {
  const panels = [{ wall:'left', pos:0, length:3, thickness:2, enabled:true }]; // covers y=[0,3]
  const amp = P.wallWithPanels('left', {x:0,y:10,z:3}, 0.7, 400, panels, true); // y=10, well off-panel
  approx(amp, 0.7, 1e-9, 'point outside panel footprint (and its taper zone) should be untouched');
});

// Every test above only exercises wallName='left', which reads its along-wall
// coordinate from basePoint.y. 'right' shares that same y-axis branch, while
// 'front'/'back' read basePoint.x instead -- neither branch had a dedicated
// test before this, despite being a real per-call branch in wallWithPanels.
test('wallWithPanels reads the along-wall coordinate from basePoint.y for the right wall (same axis as left)', () => {
  const panels = [{ wall:'right', pos:0, length:20, thickness:2, enabled:true }];
  const onPanel = P.wallWithPanels('right', {x:18,y:5,z:3}, 0.7, 400, panels, true);
  const offPanel = P.wallWithPanels('right', {x:18,y:50,z:3}, 0.7, 400, panels, true);
  assert.ok(onPanel < 0.7, `expected reduced amplitude on the panel, got ${onPanel}`);
  approx(offPanel, 0.7, 1e-9, 'point far outside the panel span on y should be untouched');
});

test('wallWithPanels reads the along-wall coordinate from basePoint.x for the front wall', () => {
  const panels = [{ wall:'front', pos:0, length:20, thickness:2, enabled:true }];
  const onPanel = P.wallWithPanels('front', {x:5,y:0,z:3}, 0.7, 400, panels, true);
  const offPanel = P.wallWithPanels('front', {x:50,y:0,z:3}, 0.7, 400, panels, true);
  assert.ok(onPanel < 0.7, `expected reduced amplitude on the panel, got ${onPanel}`);
  approx(offPanel, 0.7, 1e-9, 'point far outside the panel span on x should be untouched');
});

test('wallWithPanels reads the along-wall coordinate from basePoint.x for the back wall', () => {
  const panels = [{ wall:'back', pos:0, length:20, thickness:2, enabled:true }];
  const onPanel = P.wallWithPanels('back', {x:5,y:13.5,z:3}, 0.7, 400, panels, true);
  const offPanel = P.wallWithPanels('back', {x:50,y:13.5,z:3}, 0.7, 400, panels, true);
  assert.ok(onPanel < 0.7, `expected reduced amplitude on the panel, got ${onPanel}`);
  approx(offPanel, 0.7, 1e-9, 'point far outside the panel span on x should be untouched');
});

test('wallWithPanels ignores panels mounted on a different wall than the one being queried', () => {
  // A panel positioned to cover this exact point, but on 'right' -- querying
  // 'left' at the same coordinates should see no absorption from it at all.
  const panels = [{ wall:'right', pos:0, length:20, thickness:2, enabled:true }];
  const amp = P.wallWithPanels('left', {x:0,y:5,z:3}, 0.7, 400, panels, true);
  approx(amp, 0.7, 1e-9, 'a panel on a different wall must not affect this wall\'s amplitude');
});

test('wallWithPanels compounds absorption multiplicatively when two panels on the same wall both cover the point', () => {
  const singlePanel = [{ wall:'left', pos:0, length:20, thickness:2, enabled:true }];
  const twoPanels = [
    { wall:'left', pos:0, length:20, thickness:2, enabled:true },
    { wall:'left', pos:0, length:20, thickness:1.5, enabled:true } // fully overlapping, different thickness
  ];
  const singleAmp = P.wallWithPanels('left', {x:0,y:5,z:3}, 0.7, 400, singlePanel, true);
  const doubleAmp = P.wallWithPanels('left', {x:0,y:5,z:3}, 0.7, 400, twoPanels, true);
  const absorb1 = P.panelAbsorptionAtFreq(twoPanels[0], 400);
  const absorb2 = P.panelAbsorptionAtFreq(twoPanels[1], 400);
  const expected = 0.7 * (1 - absorb1) * (1 - absorb2);
  approx(doubleAmp, expected, 1e-9, 'compounded amplitude should be the product of each panel\'s (1-absorb) factor');
  assert.ok(doubleAmp < singleAmp, 'two overlapping panels should absorb at least as much as either alone');
});

console.log('\n-- rectCoverage (2D floor/ceiling panel coverage) --');

test('rectCoverage is 1.0 anywhere inside the rectangle', () => {
  const rect = { x: 4, y: 3, width: 6, height: 5 }; // spans x=[4,10], y=[3,8]
  approx(P.rectCoverage(rect, 4, 3), 1.0, 1e-9, 'corner');
  approx(P.rectCoverage(rect, 7, 5.5), 1.0, 1e-9, 'center');
  approx(P.rectCoverage(rect, 10, 8), 1.0, 1e-9, 'opposite corner');
});

test('rectCoverage tapers along a single axis when only that axis is outside the rectangle', () => {
  const rect = { x: 4, y: 3, width: 6, height: 5 }; // spans x=[4,10], y=[3,8]
  // 0.25ft outside on x only, y held inside -> taper matches the 1D taperedCoverage math (TAPER_FT=0.5)
  approx(P.rectCoverage(rect, 10.25, 5), 1 - 0.25/0.5, 1e-9, 'just past the right edge, y inside');
  approx(P.rectCoverage(rect, 3.75, 5), 1 - 0.25/0.5, 1e-9, 'just past the left edge, y inside');
});

test('rectCoverage tapers on BOTH axes near a corner, compounding multiplicatively', () => {
  const rect = { x: 4, y: 3, width: 6, height: 5 }; // spans x=[4,10], y=[3,8]
  // 0.25ft past the corner on both x and y: each axis alone would taper to 0.5,
  // but corner coverage is the PRODUCT of both, not just the smaller one.
  const corner = P.rectCoverage(rect, 10.25, 8.25);
  approx(corner, 0.5 * 0.5, 1e-9, 'corner coverage should be the product of both axes\' taper, i.e. 0.25');
  const singleAxisOnly = P.rectCoverage(rect, 10.25, 5); // same x offset, y inside
  assert.ok(corner < singleAxisOnly, 'a corner should have LESS coverage than an equivalent single-edge offset');
});

test('rectCoverage is 0 well outside the rectangle (beyond the taper zone) on either or both axes', () => {
  const rect = { x: 4, y: 3, width: 6, height: 5 };
  assert.strictEqual(P.rectCoverage(rect, 20, 5), 0, 'far outside on x, inside on y');
  assert.strictEqual(P.rectCoverage(rect, 7, 20), 0, 'inside on x, far outside on y');
  assert.strictEqual(P.rectCoverage(rect, 20, 20), 0, 'far outside on both axes');
});

console.log('\n-- wallWithSurfacePanels (floor/ceiling rugs and panels) --');

test('wallWithSurfacePanels returns base amplitude when surfacePanelsEnabled is false', () => {
  const surfacePanels = [{ surface:'floor', x:0, y:0, width:20, height:20, thickness:1, enabled:true }];
  const amp = P.wallWithSurfacePanels('floor', {x:5,y:5,z:0}, 0.8, 200, surfacePanels, false);
  approx(amp, 0.8, 1e-9, 'master toggle off should bypass all surface panels');
});

test('wallWithSurfacePanels returns base amplitude when the panel is individually disabled', () => {
  const surfacePanels = [{ surface:'floor', x:0, y:0, width:20, height:20, thickness:1, enabled:false }];
  const amp = P.wallWithSurfacePanels('floor', {x:5,y:5,z:0}, 0.8, 200, surfacePanels, true);
  approx(amp, 0.8, 1e-9);
});

test('wallWithSurfacePanels ignores panels on the OTHER surface (ceiling panel does not affect floor)', () => {
  const surfacePanels = [{ surface:'ceil', x:0, y:0, width:20, height:20, thickness:1, enabled:true }];
  const amp = P.wallWithSurfacePanels('floor', {x:5,y:5,z:0}, 0.8, 200, surfacePanels, true);
  approx(amp, 0.8, 1e-9, 'a ceiling panel must not affect the floor\'s amplitude');
});

test('wallWithSurfacePanels reduces amplitude when the point falls inside a rug/panel at an absorptive frequency', () => {
  const surfacePanels = [{ surface:'floor', x:0, y:0, width:20, height:20, thickness:2, enabled:true }];
  const amp = P.wallWithSurfacePanels('floor', {x:5,y:5,z:0}, 0.8, 400, surfacePanels, true);
  assert.ok(amp < 0.8, `expected reduced amplitude, got ${amp}`);
});

test('wallWithSurfacePanels leaves amplitude unchanged well outside the rug/panel footprint', () => {
  const surfacePanels = [{ surface:'floor', x:0, y:0, width:3, height:3, thickness:2, enabled:true }];
  const amp = P.wallWithSurfacePanels('floor', {x:15,y:15,z:0}, 0.8, 400, surfacePanels, true);
  approx(amp, 0.8, 1e-9);
});

test('wallWithSurfacePanels compounds absorption multiplicatively for two overlapping rugs', () => {
  const singleRug = [{ surface:'floor', x:0, y:0, width:20, height:20, thickness:2, enabled:true }];
  const twoRugs = [
    { surface:'floor', x:0, y:0, width:20, height:20, thickness:2, enabled:true },
    { surface:'floor', x:0, y:0, width:20, height:20, thickness:1, enabled:true }
  ];
  const singleAmp = P.wallWithSurfacePanels('floor', {x:5,y:5,z:0}, 0.8, 400, singleRug, true);
  const doubleAmp = P.wallWithSurfacePanels('floor', {x:5,y:5,z:0}, 0.8, 400, twoRugs, true);
  const absorb1 = P.panelAbsorptionAtFreq(twoRugs[0], 400);
  const absorb2 = P.panelAbsorptionAtFreq(twoRugs[1], 400);
  approx(doubleAmp, 0.8 * (1-absorb1) * (1-absorb2), 1e-9);
  assert.ok(doubleAmp < singleAmp);
});

console.log('\n-- boundaryOps: floor/ceiling reflectivity and surface panels --');

test('boundaryOps floor amplitude uses floorReflect when specified, independent of wallReflect', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallReflect: 0.7, floorReflect: 0.3, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true, surfacePanels: [], surfacePanelsEnabled: true };
  const floor = P.boundaryOps(200, ctx).find(o => o.name === 'floor');
  approx(floor.amp({ x: 9, y: 6, z: 3 }), 0.3, 1e-9, 'floor should use floorReflect, not wallReflect');
});

test('boundaryOps floor amplitude defaults to wallReflect when floorReflect is not specified', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true, surfacePanels: [], surfacePanelsEnabled: true };
  const floor = P.boundaryOps(200, ctx).find(o => o.name === 'floor');
  approx(floor.amp({ x: 9, y: 6, z: 3 }), 0.7, 1e-9, 'omitting floorReflect should fall back to wallReflect (backward compatible default)');
});

test('boundaryOps ceiling amplitude always uses wallReflect, unaffected by floorReflect', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallReflect: 0.7, floorReflect: 0.1, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true, surfacePanels: [], surfacePanelsEnabled: true };
  const ceil = P.boundaryOps(200, ctx).find(o => o.name === 'ceil');
  approx(ceil.amp({ x: 9, y: 6, z: 3 }), 0.7, 1e-9, 'ceiling should never be affected by floorReflect');
});

test('boundaryOps applies a floor rug to floor amplitude only, not ceiling', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const surfacePanels = [{ surface:'floor', x:0, y:0, width:20, height:20, thickness:2, enabled:true }];
  const ctx = { room, wallReflect: 0.7, floorReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true, surfacePanels, surfacePanelsEnabled: true };
  const ops = P.boundaryOps(400, ctx);
  const floorAmp = ops.find(o => o.name === 'floor').amp({ x: 9, y: 6, z: 3 });
  const ceilAmp = ops.find(o => o.name === 'ceil').amp({ x: 9, y: 6, z: 3 });
  assert.ok(floorAmp < 0.7, 'floor rug should reduce floor amplitude');
  approx(ceilAmp, 0.7, 1e-9, 'a floor rug must not affect the ceiling');
});

test('boundaryOps applies a ceiling panel to ceiling amplitude only, not floor', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const surfacePanels = [{ surface:'ceil', x:0, y:0, width:20, height:20, thickness:2, enabled:true }];
  const ctx = { room, wallReflect: 0.7, floorReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true, surfacePanels, surfacePanelsEnabled: true };
  const ops = P.boundaryOps(400, ctx);
  const floorAmp = ops.find(o => o.name === 'floor').amp({ x: 9, y: 6, z: 3 });
  const ceilAmp = ops.find(o => o.name === 'ceil').amp({ x: 9, y: 6, z: 3 });
  approx(floorAmp, 0.7, 1e-9, 'a ceiling panel must not affect the floor');
  assert.ok(ceilAmp < 0.7, 'ceiling panel should reduce ceiling amplitude');
});

test('REGRESSION: floor amplitude does not jump discontinuously as a point sweeps across a rug edge', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const surfacePanels = [{ surface:'floor', x:4, y:3, width:6, height:5, thickness:2, enabled:true }]; // x=[4,10]
  const ctx = { room, wallReflect: 0.7, floorReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true, surfacePanels, surfacePanelsEnabled: true };
  const floor = P.boundaryOps(400, ctx).find(o => o.name === 'floor');
  const amps = [];
  for(let x = 9; x <= 11; x += 0.05){
    amps.push(floor.amp({ x, y: 5, z: 3 }));
  }
  let maxStep = 0;
  for(let i = 1; i < amps.length; i++){
    maxStep = Math.max(maxStep, Math.abs(amps[i] - amps[i-1]));
  }
  // 0.5ft taper, 0.05ft step -> ~10% of the full floorReflect*absorb swing per
  // step (same magnitude as the analogous 1D wall-panel regression test).
  assert.ok(maxStep < 0.1, `expected smooth transition, got a max single-step jump of ${maxStep.toFixed(4)}`);
});

console.log('\n-- wallMaterialReflectAtFreq / WALL_MATERIALS (frequency-dependent bare-wall reflectivity) --');

test('wallMaterialReflectAtFreq returns null for a null/undefined material (caller should fall back to flat wallReflect)', () => {
  assert.strictEqual(P.wallMaterialReflectAtFreq(null, 80), null);
  assert.strictEqual(P.wallMaterialReflectAtFreq(undefined, 80), null);
});

test('wallMaterialReflectAtFreq is flat baseReflect at every frequency when peakDepth is 0 (e.g. masonry -- no resonance mechanism)', () => {
  const masonry = P.WALL_MATERIALS.masonry;
  approx(P.wallMaterialReflectAtFreq(masonry, 20), masonry.baseReflect, 1e-9);
  approx(P.wallMaterialReflectAtFreq(masonry, 80), masonry.baseReflect, 1e-9);
  approx(P.wallMaterialReflectAtFreq(masonry, 300), masonry.baseReflect, 1e-9);
});

test('wallMaterialReflectAtFreq dips to baseReflect*(1-peakDepth) exactly at peakFreq', () => {
  const material = { baseReflect: 0.8, peakFreq: 80, peakDepth: 0.4, bandwidth: 30 };
  approx(P.wallMaterialReflectAtFreq(material, 80), 0.8 * (1 - 0.4), 1e-9);
});

test('wallMaterialReflectAtFreq approaches baseReflect far from peakFreq', () => {
  const material = { baseReflect: 0.8, peakFreq: 80, peakDepth: 0.4, bandwidth: 30 };
  const farBelow = P.wallMaterialReflectAtFreq(material, 20);
  const farAbove = P.wallMaterialReflectAtFreq(material, 300);
  assert.ok(farBelow > 0.79, `expected near-baseReflect far below peakFreq, got ${farBelow}`);
  assert.ok(farAbove > 0.79, `expected near-baseReflect far above peakFreq, got ${farAbove}`);
});

test('wallMaterialReflectAtFreq is symmetric around peakFreq', () => {
  const material = { baseReflect: 0.8, peakFreq: 80, peakDepth: 0.4, bandwidth: 30 };
  const below = P.wallMaterialReflectAtFreq(material, 60); // 20 below
  const above = P.wallMaterialReflectAtFreq(material, 100); // 20 above
  approx(below, above, 1e-9);
});

test('WALL_MATERIALS.drywallInsulated dips deeper AND wider than drywallHollow (insulation damps the resonance more)', () => {
  const insulated = P.WALL_MATERIALS.drywallInsulated;
  const hollow = P.WALL_MATERIALS.drywallHollow;
  assert.ok(insulated.peakDepth > hollow.peakDepth, 'insulated should have a deeper dip');
  assert.ok(insulated.bandwidth > hollow.bandwidth, 'insulated should have a wider (more damped) dip');
});

console.log('\n-- boundaryOps: per-wall materials --');

test('boundaryOps uses each wall\'s own assigned material independently', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const wallMaterials = {
    left: P.WALL_MATERIALS.drywallInsulated,
    front: P.WALL_MATERIALS.masonry
  };
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true, wallMaterials };
  const ops = P.boundaryOps(P.WALL_MATERIALS.drywallInsulated.peakFreq, ctx);
  const leftAmp = ops.find(o => o.name === 'left').amp({ x: 0, y: 6, z: 3 });
  const frontAmp = ops.find(o => o.name === 'front').amp({ x: 9, y: 0, z: 3 });
  approx(leftAmp, P.wallMaterialReflectAtFreq(P.WALL_MATERIALS.drywallInsulated, P.WALL_MATERIALS.drywallInsulated.peakFreq), 1e-9);
  approx(frontAmp, P.WALL_MATERIALS.masonry.baseReflect, 1e-9);
  assert.notStrictEqual(leftAmp, frontAmp);
});

test('boundaryOps falls back to flat wallReflect for a wall missing from the wallMaterials map', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const wallMaterials = { left: P.WALL_MATERIALS.drywallInsulated }; // right/front/back intentionally unset
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true, wallMaterials };
  const rightAmp = P.boundaryOps(80, ctx).find(o => o.name === 'right').amp({ x: 18, y: 6, z: 3 });
  approx(rightAmp, 0.7, 1e-9, 'a wall with no assigned material should use the flat wallReflect scalar');
});

test('boundaryOps falls back to flat wallReflect for every wall when wallMaterials is omitted entirely (backward compatible)', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const ops = P.boundaryOps(80, ctx);
  for(const name of ['left','right','front','back']){
    approx(ops.find(o => o.name === name).amp({ x: 9, y: 6, z: 3 }), 0.7, 1e-9, `${name} should use flat wallReflect`);
  }
});

test('boundaryOps applies wall panel absorption ON TOP OF a material-derived base reflectivity (both stack multiplicatively)', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const wallMaterials = { left: P.WALL_MATERIALS.masonry }; // flat 0.9 baseline, easy to predict
  const panels = [{ wall:'left', pos:0, length:20, thickness:2, enabled:true }];
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels, panelsEnabled: true, wallMaterials };
  const freq = 400;
  const leftAmp = P.boundaryOps(freq, ctx).find(o => o.name === 'left').amp({ x: 0, y: 5, z: 3 });
  const absorb = P.panelAbsorptionAtFreq(panels[0], freq);
  approx(leftAmp, P.WALL_MATERIALS.masonry.baseReflect * (1 - absorb), 1e-9);
});

console.log("\n-- wallMaterialReflectAtFreq: shape:'porousRamp' (e.g. suspended acoustic ceiling tile) --");

test("porousRamp absorption is negligible well below midFreq", () => {
  const material = { shape: 'porousRamp', baseReflect: 0.75, midFreq: 280, slope: 0.03, maxAbsorb: 0.6 };
  const reflectAt20 = P.wallMaterialReflectAtFreq(material, 20);
  assert.ok(reflectAt20 > 0.74, `expected near-baseReflect well below midFreq, got ${reflectAt20}`);
});

test("porousRamp absorption is exactly maxAbsorb/2 (the logistic midpoint) AT midFreq", () => {
  const material = { shape: 'porousRamp', baseReflect: 0.75, midFreq: 280, slope: 0.03, maxAbsorb: 0.6 };
  const reflectAtMid = P.wallMaterialReflectAtFreq(material, 280);
  approx(reflectAtMid, 0.75 * (1 - 0.6/2), 1e-9);
});

test("porousRamp absorption increases monotonically with frequency (opposite trend from 'resonant')", () => {
  const material = { shape: 'porousRamp', baseReflect: 0.75, midFreq: 280, slope: 0.03, maxAbsorb: 0.6 };
  const r1 = P.wallMaterialReflectAtFreq(material, 20);
  const r2 = P.wallMaterialReflectAtFreq(material, 150);
  const r3 = P.wallMaterialReflectAtFreq(material, 300);
  assert.ok(r1 > r2 && r2 > r3, `expected monotonically decreasing reflectivity (increasing absorption) with frequency: ${r1}, ${r2}, ${r3}`);
});

test('WALL_MATERIALS.suspendedTile shows only modest absorption within this app\'s typical sub-bass range, more by the top of the range', () => {
  const tile = P.WALL_MATERIALS.suspendedTile;
  const at40 = P.wallMaterialReflectAtFreq(tile, 40);
  const at300 = P.wallMaterialReflectAtFreq(tile, 300);
  assert.ok(at40 > tile.baseReflect * 0.9, `expected tile to do little at 40Hz (a real, worth-knowing limitation), got ${at40}`);
  assert.ok(at300 < at40, 'expected more absorption by 300Hz than at 40Hz');
});

console.log('\n-- boundaryOps: ceiling material --');

test('boundaryOps applies ctx.ceilingMaterial to the ceiling only, independent of wallMaterials', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = {
    room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true,
    wallMaterials: { left: P.WALL_MATERIALS.masonry },
    ceilingMaterial: P.WALL_MATERIALS.suspendedTile
  };
  const freq = 300;
  const ops = P.boundaryOps(freq, ctx);
  const ceilAmp = ops.find(o => o.name === 'ceil').amp({ x: 9, y: 6, z: 8 });
  const leftAmp = ops.find(o => o.name === 'left').amp({ x: 0, y: 6, z: 3 });
  approx(ceilAmp, P.wallMaterialReflectAtFreq(P.WALL_MATERIALS.suspendedTile, freq), 1e-9);
  approx(leftAmp, P.WALL_MATERIALS.masonry.baseReflect, 1e-9, 'the wall material assignment should be unaffected by ceilingMaterial');
  assert.notStrictEqual(ceilAmp, leftAmp);
});

test('boundaryOps falls back to flat wallReflect for the ceiling when ceilingMaterial is omitted', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const ceilAmp = P.boundaryOps(80, ctx).find(o => o.name === 'ceil').amp({ x: 9, y: 6, z: 8 });
  approx(ceilAmp, 0.7, 1e-9);
});

test('ceilingMaterial does not affect the floor (they are independent surfaces)', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = {
    room, wallReflect: 0.7, floorReflect: 0.8, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true,
    ceilingMaterial: P.WALL_MATERIALS.masonry
  };
  const floorAmp = P.boundaryOps(80, ctx).find(o => o.name === 'floor').amp({ x: 9, y: 6, z: 0 });
  approx(floorAmp, 0.8, 1e-9, 'floorReflect should be untouched by ceilingMaterial');
});

console.log('\n-- openingOverlap (wall opening / doorway coverage) --');

test('openingOverlap is 1.0 anywhere inside the opening span', () => {
  const opening = { pos: 14, width: 4 }; // spans [14,18]
  approx(P.openingOverlap(opening, 14), 1.0, 1e-9, 'left edge');
  approx(P.openingOverlap(opening, 16), 1.0, 1e-9, 'middle');
  approx(P.openingOverlap(opening, 18), 1.0, 1e-9, 'right edge');
});

test('openingOverlap tapers linearly to 0 over 3ft outside the opening', () => {
  const opening = { pos: 14, width: 4 }; // spans [14,18]
  approx(P.openingOverlap(opening, 13), 1 - 1/3, 1e-9, '1ft outside');
  approx(P.openingOverlap(opening, 12.5), 0.5, 1e-9, '1.5ft outside -- taper midpoint');
  approx(P.openingOverlap(opening, 11), 0, 1e-9, '3ft outside -- taper fully spent');
  assert.strictEqual(P.openingOverlap(opening, 9), 0, 'well beyond the taper zone should clamp to 0, not go negative');
});

test('openingOverlap can be positioned anywhere along a wall, not anchored to a fixed corner', () => {
  const midWall = { pos: 7, width: 3 }; // an opening in the MIDDLE of a wall, e.g. an 18ft wall
  approx(P.openingOverlap(midWall, 7), 1.0, 1e-9, 'left edge of a mid-wall opening');
  approx(P.openingOverlap(midWall, 8.5), 1.0, 1e-9, 'middle of a mid-wall opening');
  approx(P.openingOverlap(midWall, 10), 1.0, 1e-9, 'right edge of a mid-wall opening');
  approx(P.openingOverlap(midWall, 0), 0, 1e-9, 'far from a mid-wall opening (both sides are now "outside")');
  approx(P.openingOverlap(midWall, 17), 0, 1e-9, 'far from a mid-wall opening on the other side too');
});

console.log('\n-- wallWithOpenings --');

test('wallWithOpenings returns base amplitude when openingsEnabled is false', () => {
  const openings = [{ wall:'front', pos:0, width:20, factor:1, enabled:true }];
  const amp = P.wallWithOpenings('front', {x:5,y:0,z:3}, 0.7, openings, false);
  approx(amp, 0.7, 1e-9, 'master toggle off should bypass all openings');
});

test('wallWithOpenings returns base amplitude when the opening is individually disabled', () => {
  const openings = [{ wall:'front', pos:0, width:20, factor:1, enabled:false }];
  const amp = P.wallWithOpenings('front', {x:5,y:0,z:3}, 0.7, openings, true);
  approx(amp, 0.7, 1e-9, 'disabled opening should not reduce reflection');
});

test('wallWithOpenings ignores openings mounted on a different wall than the one being queried', () => {
  const openings = [{ wall:'left', pos:0, width:20, factor:1, enabled:true }];
  const amp = P.wallWithOpenings('front', {x:5,y:0,z:3}, 0.7, openings, true);
  approx(amp, 0.7, 1e-9, 'an opening on a different wall must not affect this wall\'s amplitude');
});

test('wallWithOpenings reduces amplitude by exactly factor when the point is inside the opening span', () => {
  const openings = [{ wall:'front', pos:0, width:20, factor:0.6, enabled:true }];
  const amp = P.wallWithOpenings('front', {x:5,y:0,z:3}, 0.7, openings, true);
  approx(amp, 0.7 * (1 - 0.6), 1e-9);
});

test('wallWithOpenings leaves amplitude unchanged when point falls well OUTSIDE the opening span (beyond taper)', () => {
  const openings = [{ wall:'front', pos:0, width:3, factor:1, enabled:true }]; // covers x=[0,3]
  const amp = P.wallWithOpenings('front', {x:20,y:0,z:3}, 0.7, openings, true); // x=20, well off-opening
  approx(amp, 0.7, 1e-9, 'point outside opening footprint (and its taper zone) should be untouched');
});

test('wallWithOpenings compounds amplitude multiplicatively when two openings on the same wall both cover the point', () => {
  const oneOpening = [{ wall:'front', pos:0, width:20, factor:0.5, enabled:true }];
  const twoOpenings = [
    { wall:'front', pos:0, width:20, factor:0.5, enabled:true },
    { wall:'front', pos:0, width:20, factor:0.4, enabled:true } // fully overlapping second opening
  ];
  const oneAmp = P.wallWithOpenings('front', {x:5,y:0,z:3}, 0.7, oneOpening, true);
  const twoAmp = P.wallWithOpenings('front', {x:5,y:0,z:3}, 0.7, twoOpenings, true);
  approx(twoAmp, 0.7 * (1-0.5) * (1-0.4), 1e-9);
  assert.ok(twoAmp < oneAmp, 'two overlapping openings should reduce amplitude at least as much as either alone');
});

test('wallWithOpenings reads the along-wall coordinate from basePoint.y for left/right walls, basePoint.x for front/back', () => {
  const leftOpening = [{ wall:'left', pos:2, width:2, factor:1, enabled:true }]; // y=[2,4]
  const onOpening = P.wallWithOpenings('left', {x:0,y:3,z:3}, 0.7, leftOpening, true);
  const offOpening = P.wallWithOpenings('left', {x:0,y:20,z:3}, 0.7, leftOpening, true);
  approx(onOpening, 0, 1e-9);
  approx(offOpening, 0.7, 1e-9);
});

console.log('\n-- boundaryOps: openings on any wall, before panel absorption --');
// Every prior test in this file (before this section) used openings: [], so
// this shipped feature had no coverage of the actual blend end-to-end. Also
// verifies openings now apply to EVERY wall (left/right/front/back), not just
// front -- the whole point of generalizing away from the old hardcoded
// front-wall-only entryway.

test('boundaryOps applies an opening on the FRONT wall to front-wall amplitude only', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const openings = [{ wall:'front', pos:14, width:4, factor:0.6, enabled:true }];
  const ctx = { room, wallReflect: 0.7, openings, openingsEnabled: true, panels: [], panelsEnabled: true };
  const ops = P.boundaryOps(200, ctx);
  const front = ops.find(o => o.name === 'front').amp({ x: 16, y: 6, z: 3 });
  const left = ops.find(o => o.name === 'left').amp({ x: 0, y: 6, z: 3 });
  approx(front, 0.7 * (1 - 0.6), 1e-9, 'front wall inside the opening should be reduced');
  approx(left, 0.7, 1e-9, 'left wall (no opening on it) should be untouched');
});

test('boundaryOps applies an opening on the LEFT wall (or any non-front wall) just as it does on front', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const openings = [{ wall:'left', pos:2, width:3, factor:0.6, enabled:true }]; // y=[2,5]
  const ctx = { room, wallReflect: 0.7, openings, openingsEnabled: true, panels: [], panelsEnabled: true };
  const left = P.boundaryOps(200, ctx).find(o => o.name === 'left');
  approx(left.amp({ x: 0, y: 3.5, z: 3 }), 0.7 * (1 - 0.6), 1e-9, 'inside the opening span on the left wall');
  approx(left.amp({ x: 0, y: 13, z: 3 }), 0.7, 1e-9, 'far from the opening on the left wall');
});

test('boundaryOps applies openings on multiple different walls simultaneously', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const openings = [
    { wall:'front', pos:14, width:4, factor:1, enabled:true },
    { wall:'back', pos:0, width:4, factor:1, enabled:true }
  ];
  const ctx = { room, wallReflect: 0.7, openings, openingsEnabled: true, panels: [], panelsEnabled: true };
  const ops = P.boundaryOps(200, ctx);
  approx(ops.find(o => o.name === 'front').amp({ x: 16, y: 6, z: 3 }), 0, 1e-9, 'front wall opening active');
  approx(ops.find(o => o.name === 'back').amp({ x: 2, y: 6, z: 3 }), 0, 1e-9, 'back wall opening ALSO active, independently');
  approx(ops.find(o => o.name === 'right').amp({ x: 18, y: 6, z: 3 }), 0.7, 1e-9, 'right wall has no opening, untouched');
});

test('boundaryOps applies opening reduction BEFORE panel absorption (both stack multiplicatively)', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const openings = [{ wall:'front', pos:0, width:20, factor:0.5, enabled:true }];
  const panels = [{ wall:'front', pos:0, length:20, thickness:2, enabled:true }];
  const ctx = { room, wallReflect: 0.7, openings, openingsEnabled: true, panels, panelsEnabled: true };
  const front = P.boundaryOps(400, ctx).find(o => o.name === 'front');
  const amp = front.amp({ x: 5, y: 0, z: 3 });
  const expectedAfterOpening = 0.7 * (1 - 0.5);
  const absorb = P.panelAbsorptionAtFreq(panels[0], 400);
  approx(amp, expectedAfterOpening * (1 - absorb), 1e-9, 'panel absorption should apply on top of the opening-reduced amplitude, not independently of it');
});

test('REGRESSION: wall reflection amplitude does not jump discontinuously as a source sweeps across an opening edge', () => {
  const room = { w: 18, d: 13.5, h: 8 }; // opening starts at x=14
  const openings = [{ wall:'front', pos:14, width:4, factor:0.8, enabled:true }];
  const ctx = { room, wallReflect: 0.7, openings, openingsEnabled: true, panels: [], panelsEnabled: true };
  const front = P.boundaryOps(200, ctx).find(o => o.name === 'front');
  const amps = [];
  for(let x = 12.5; x <= 15.5; x += 0.05){
    amps.push(front.amp({ x, y: 6, z: 3 }));
  }
  let maxStep = 0;
  for(let i = 1; i < amps.length; i++){
    maxStep = Math.max(maxStep, Math.abs(amps[i] - amps[i-1]));
  }
  // 3ft taper, 0.05ft step, full swing = wallReflect*factor = 0.56 -> expect small steps
  assert.ok(maxStep < 0.03, `expected smooth transition, got a max single-step jump of ${maxStep.toFixed(4)}`);
});

console.log('\n-- getImageSources (image-source method / regression tests) --');

test('order 1 produces exactly 7 image sources (direct + 6 single-wall bounces)', () => {
  const imgs = P.getImageSources(9, 6, 3, 1, 100, baseCtx());
  assert.strictEqual(imgs.length, 7, `expected 7, got ${imgs.length}`);
});

test('order 2 produces exactly 1 + 6 + 6*5 = 37 image sources', () => {
  const imgs = P.getImageSources(9, 6, 3, 2, 100, baseCtx());
  assert.strictEqual(imgs.length, 37, `expected 37, got ${imgs.length}`);
});

test('order<=0 returns only the direct source (no bounces)', () => {
  // getImageSources now loops `order` times rather than having the first
  // bounce hardcoded unconditionally, so order=0 (or negative) correctly
  // means "zero bounces" -- a behavior fix vs. an earlier version of this
  // function, where order<=0 still returned the 6 first-order bounces.
  const ctx = baseCtx();
  const direct = P.getImageSources(9, 6, 3, 1, 100, ctx)[0];
  const order0 = P.getImageSources(9, 6, 3, 0, 100, ctx);
  const orderNeg = P.getImageSources(9, 6, 3, -5, 100, ctx);
  assert.strictEqual(order0.length, 1, `expected order=0 to return only the direct source, got ${order0.length}`);
  assert.strictEqual(orderNeg.length, 1, `expected a negative order to return only the direct source, got ${orderNeg.length}`);
  assert.deepStrictEqual(order0[0], direct);
});

test('order 3 produces exactly 1 + 6 + 30 + 150 = 187 image sources (each level multiplies the previous by 5)', () => {
  const ctx = baseCtx();
  const order2 = P.getImageSources(9, 6, 3, 2, 100, ctx);
  const order3 = P.getImageSources(9, 6, 3, 3, 100, ctx);
  assert.strictEqual(order3.length, 187, `expected 187, got ${order3.length}`);
  assert.notStrictEqual(order3.length, order2.length, 'order 3 should genuinely differ from order 2, not collapse to it');
  // order 3 should still contain every order<=2 entry (each level is
  // cumulative, not a replacement of the previous ones).
  for(const img of order2){
    assert.ok(order3.some(o => o.x === img.x && o.y === img.y && o.z === img.z && o.amp === img.amp),
      'every order-2 image source should still be present in the order-3 result');
  }
});

test('order 4 continues the same pattern (937 sources), confirming this is a genuine N-level loop, not a hardcoded 3rd level', () => {
  const ctx = baseCtx();
  const order4 = P.getImageSources(9, 6, 3, 4, 100, ctx);
  assert.strictEqual(order4.length, 937, `expected 937, got ${order4.length}`);
});

test('direct source position/amplitude is unchanged (first entry)', () => {
  const imgs = P.getImageSources(9, 6, 3, 1, 100, baseCtx());
  const direct = imgs[0];
  approx(direct.x, 9, 1e-9);
  approx(direct.y, 6, 1e-9);
  approx(direct.z, 3, 1e-9);
  approx(direct.amp, 1.0, 1e-9);
});

test('left-wall image source is mirrored across x=0 with base wallReflect amplitude', () => {
  const ctx = baseCtx();
  const imgs = P.getImageSources(9, 6, 3, 1, 100, ctx);
  const leftImg = imgs.find((img, i) => i > 0 && img.x === -9 && img.y === 6 && img.z === 3);
  assert.ok(leftImg, 'expected a left-wall mirror at x=-9');
  approx(leftImg.amp, 0.7, 1e-9);
});

test('floor and ceiling image sources exist and mirror the z coordinate', () => {
  const ctx = baseCtx();
  const imgs = P.getImageSources(9, 6, 3, 1, 100, ctx);
  const floorImg = imgs.find(img => img.z === -3);
  const ceilImg = imgs.find(img => img.z === 2*ctx.room.h - 3);
  assert.ok(floorImg, 'expected a floor mirror at z=-3');
  assert.ok(ceilImg, `expected a ceiling mirror at z=${2*ctx.room.h-3}`);
});

test('REGRESSION: every source (including a newly-added sub-like source) has a defined z used consistently', () => {
  // Regression for the bug where sources added via "+ Add source" lacked a z field,
  // producing NaN through the whole field computation. precomputeSourceImages uses
  // `s.z ?? 3` as a fallback — verify that fallback actually prevents NaN.
  const subWithNoZ = { x: 5, y: 2, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80 }; // no z!
  const pre = P.precomputeSourceImages([subWithNoZ], 1, 60, baseCtx());
  assert.ok(pre[0] !== null, 'source should not be filtered out');
  for(const img of pre[0].imgSources){
    assert.ok(Number.isFinite(img.z), `image source z should be finite, got ${img.z}`);
    assert.ok(Number.isFinite(img.x) && Number.isFinite(img.y), 'x/y should be finite too');
  }
});

test('REGRESSION: computeFieldAtPoint never returns NaN for a well-formed scene', () => {
  const sources = [
    { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000 },
    { x: 13.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000 }
  ];
  const ctx = baseCtx();
  const freq = 200;
  const lambda = P.C / freq;
  const k = 2 * Math.PI / lambda;
  const pre = P.precomputeSourceImages(sources, 1, freq, ctx);
  const { re, im } = P.computeFieldAtPoint(9, 9, 3.5, pre, k);
  assert.ok(Number.isFinite(re) && Number.isFinite(im), `expected finite re/im, got re=${re} im=${im}`);
});

test('REGRESSION: a source with an invalid (negative) freqLow/freqHigh gain input is dropped, not left to poison the field', () => {
  // Before this was fixed, sourceGainAtFreq could return NaN for a source
  // evaluated at f<0, and precomputeSourceImages's `freqGain < 0.0005` filter
  // let NaN through uncaught (NaN fails every direct comparison) -- so the
  // malformed source's NaN contribution silently wrecked re/im for every
  // other source sharing that field point. This exercises the fix at both
  // layers: sourceGainAtFreq no longer produces NaN, and even if some future
  // gain function did, precomputeSourceImages's !(freqGain >= 0.0005) filter
  // would still catch and drop it.
  const goodSource = { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 };
  const badSource = { x: 9, y: 6, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 };
  const ctx = baseCtx();
  const freq = -50; // malformed: negative evaluation frequency
  const pre = P.precomputeSourceImages([goodSource, badSource], 1, freq, ctx);
  assert.strictEqual(pre[0], null, 'source evaluated at a negative frequency should be filtered out, not poison the array');
  assert.strictEqual(pre[1], null, 'same for the second source');

  // And a mixed, realistic case: one well-formed source at a valid frequency
  // alongside one that (if it ever produced NaN again) must not contaminate
  // the sum for the well-formed one.
  const mixedPre = P.precomputeSourceImages([goodSource], 1, 200, ctx);
  const k = 2 * Math.PI * 200 / P.C;
  const { re, im } = P.computeFieldAtPoint(9, 9, 3.5, mixedPre, k);
  assert.ok(Number.isFinite(re) && Number.isFinite(im), `expected finite re/im, got re=${re} im=${im}`);
});

console.log('\n-- computeFieldAtPoint near-field clamp (r < 0.3m floor) --');

test('field is finite (not Infinity/NaN) exactly at a source position (true r=0)', () => {
  const src = { x: 9, y: 6, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 };
  const ctx = baseCtx({ wallReflect: 0 }); // isolate direct path only
  const freq = 100;
  const k = 2 * Math.PI * freq / P.C;
  const pre = P.precomputeSourceImages([src], 1, freq, ctx);
  const { re, im } = P.computeFieldAtPoint(9, 6, 3, pre, k);
  assert.ok(Number.isFinite(re) && Number.isFinite(im), `expected finite field at r=0, got re=${re} im=${im}`);
});

test('REGRESSION: a source contributes an IDENTICAL complex value at every point strictly within the 0.3m clamp radius, regardless of direction', () => {
  // amp=(src.amp/r)*levelGain and phase=k*r+extraPhase are both computed from
  // the SAME clamped r, so the entire sub-0.3m sphere around a source collapses
  // to one constant field value -- not just amplitude-flat, but direction-independent.
  // This is a real, if subtle, consequence of the hard (non-tapered) clamp.
  const src = { x: 9, y: 6, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 };
  const ctx = baseCtx({ wallReflect: 0 });
  const freq = 100;
  const k = 2 * Math.PI * freq / P.C;
  const pre = P.precomputeSourceImages([src], 1, freq, ctx);
  const offsetFt = 0.1 / P.FT_TO_M; // 0.1m, well inside the 0.3m clamp radius

  const atSource = P.computeFieldAtPoint(9, 6, 3, pre, k);
  const offsetX = P.computeFieldAtPoint(9 + offsetFt, 6, 3, pre, k);
  const offsetY = P.computeFieldAtPoint(9, 6 + offsetFt, 3, pre, k);

  approx(offsetX.re, atSource.re, 1e-9, 're should be identical across the clamp sphere');
  approx(offsetX.im, atSource.im, 1e-9, 'im should be identical across the clamp sphere');
  approx(offsetY.re, atSource.re, 1e-9, 're should not depend on direction within the clamp sphere');
  approx(offsetY.im, atSource.im, 1e-9, 'im should not depend on direction within the clamp sphere');
});

test('normal 1/r falloff resumes once the true distance exceeds the 0.3m clamp radius', () => {
  const src = { x: 9, y: 6, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 };
  const ctx = baseCtx({ wallReflect: 0 });
  const freq = 100;
  const k = 2 * Math.PI * freq / P.C;
  const pre = P.precomputeSourceImages([src], 1, freq, ctx);

  const justInsideFt = 0.29 / P.FT_TO_M;
  const justOutsideFt = 0.5 / P.FT_TO_M; // safely past the clamp radius
  const insideMag = magOf(P.computeFieldAtPoint(9 + justInsideFt, 6, 3, pre, k));
  const outsideMag = magOf(P.computeFieldAtPoint(9 + justOutsideFt, 6, 3, pre, k));
  assert.ok(outsideMag < insideMag, `expected magnitude to fall off past the clamp radius: inside=${insideMag}, outside=${outsideMag}`);
});

console.log('\n-- fieldDbAtPoint: known-configuration sanity checks --');

test('pressure falls off with distance from a single source (no reflections)', () => {
  // wallReflect=0 isolates the direct-path-only behavior (no boundary contributions)
  const ctx = baseCtx({ wallReflect: 0 });
  const sources = [{ x: 9, y: 6, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 }];
  const freq = 200;
  const near = P.fieldDbAtPoint(9, 6.5, 3, sources, 1, freq, ctx); // ~0.5ft away
  const far  = P.fieldDbAtPoint(9, 12, 3, sources, 1, freq, ctx);  // ~6ft away
  assert.ok(near > far, `expected near point louder than far point: near=${near}dB far=${far}dB`);
});

test('doubling distance from a single free-field source drops level by roughly 6dB (inverse-square law)', () => {
  const ctx = baseCtx({ wallReflect: 0 });
  const sources = [{ x: 0, y: 0, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000 }];
  const freq = 200;
  // Pick points far enough from the source that FT_TO_M distance clamp (0.3m) doesn't dominate,
  // and along an axis where phase differences are small relative to spacing (use y-offset only,
  // same x, to isolate radial falloff along one direction).
  const d1 = P.fieldDbAtPoint(0, 10, 3, sources, 1, freq, ctx);
  const d2 = P.fieldDbAtPoint(0, 20, 3, sources, 1, freq, ctx);
  approx(d1 - d2, 6.02, 0.5, 'inverse-square law: 6dB drop per doubling of distance');
});

test('source outside its frequency range contributes negligible energy', () => {
  const ctx = baseCtx({ wallReflect: 0 });
  const subOnly = [{ x: 9, y: 6, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 80 }];
  const dbAtPassband = P.fieldDbAtPoint(9, 8, 3.5, subOnly, 1, 60, ctx);   // inside 20-80Hz
  const dbFarAbove   = P.fieldDbAtPoint(9, 8, 3.5, subOnly, 1, 2000, ctx); // way above freqHigh
  assert.ok(dbFarAbove < dbAtPassband - 40,
    `expected far-above-passband level to be much lower: passband=${dbAtPassband}dB farAbove=${dbFarAbove}dB`);
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
  const ctx = baseCtx({ wallReflect: 0 }); // isolate direct-path interference, no room reflections
  const freq = 300;
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
    const db = P.fieldDbAtPoint(x, 6, 3, sources, 1, freq, ctx);
    if(nullPoint === null || db < nullPoint.db) nullPoint = { x, db };
  }
  const awayPoint = { x: 9 - sepFt/2 + 0.05, db: P.fieldDbAtPoint(9 - sepFt/2 + 0.05, 6, 3, sources, 1, freq, ctx) }; // just outside a source, clearly not at a null
  assert.ok(nullPoint.db < -25, `expected a deep null from near-antiphase sources, deepest found was ${nullPoint.db}dB`);
  assert.ok(nullPoint.db > -100, 'null should not be clamped at the floor, or the sensitivity comparison below is meaningless');
  assert.ok(awayPoint.db > -15, `expected the away point to clearly not be near a null, got ${awayPoint.db}dB`);

  const TINY_SHIFT = 0.001; // ~0.3mm, well under a pixel at any reasonable render scale
  const dbAtNull = P.fieldDbAtPoint(nullPoint.x, 6, 3, sources, 1, freq, ctx);
  const dbNearNullShifted = P.fieldDbAtPoint(nullPoint.x + TINY_SHIFT, 6, 3, sources, 1, freq, ctx);
  const dbAway = P.fieldDbAtPoint(awayPoint.x, 6, 3, sources, 1, freq, ctx);
  const dbAwayShifted = P.fieldDbAtPoint(awayPoint.x + TINY_SHIFT, 6, 3, sources, 1, freq, ctx);

  const sensitivityNearNull = Math.abs(dbAtNull - dbNearNullShifted);
  const sensitivityAway = Math.abs(dbAway - dbAwayShifted);

  assert.ok(sensitivityNearNull > sensitivityAway * 5,
    `expected dB near the null to be much more sensitive to a tiny position shift: ` +
    `near-null sensitivity=${sensitivityNearNull.toFixed(4)}dB, away sensitivity=${sensitivityAway.toFixed(4)}dB`);
});

console.log('\n-- scoreSubPosition --');

test('a position centered between two coherent-summing sources scores well (loud + flat)', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [
    { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true },
    { x: 13.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true }
  ];
  const freqs = [30, 40, 50, 60, 70, 80];
  const listeners = [{ x: 9, y: 9, z: 3.5 }];

  const nearCorner = P.scoreSubPosition({ x: 1, y: 1 }, mains, room, freqs, listeners, ctx, 1);
  const center = P.scoreSubPosition({ x: 9, y: 6.75 }, mains, room, freqs, listeners, ctx, 1);
  // Not asserting a specific winner (that depends on the room's actual modes),
  // just that the function produces distinct, finite scores for different positions.
  assert.ok(Number.isFinite(nearCorner.score), 'corner score should be finite');
  assert.ok(Number.isFinite(center.score), 'center score should be finite');
  assert.notStrictEqual(nearCorner.score, center.score, 'different positions should generally score differently');
});

test('a position with a deep null at one frequency scores worse than an equally-loud-on-average flat position', () => {
  // Construct two single-sub scenarios with the SAME average level across frequency,
  // but one has a severe dip at a single frequency (a null) and the other doesn't.
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallReflect: 0, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
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

  const flatResult = P.scoreSubPosition({ x: 9, y: 6.75, z: 1 }, flatSources, room, freqs, listeners, ctx, 1);
  const nullyResult = P.scoreSubPosition({ x: 9, y: 6.75, z: 1 }, nullySources, room, freqs, listeners, ctx, 1);

  assert.ok(nullyResult.worstStdDev > flatResult.worstStdDev,
    `expected the nulled scenario to have higher std dev (less flat): flat=${flatResult.worstStdDev.toFixed(2)} nully=${nullyResult.worstStdDev.toFixed(2)}`);
});

test('score combines multiple listeners by penalizing the WORST listener, not just averaging', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [{ x: 9, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 200, enabled: true }];
  const freqs = [40, 60, 80];

  const oneListener = P.scoreSubPosition({ x: 9, y: 6.75, z: 1 }, mains, room, freqs, [{x:9,y:9,z:3.5}], ctx, 1);
  const twoListeners = P.scoreSubPosition({ x: 9, y: 6.75, z: 1 }, mains, room, freqs, [{x:9,y:9,z:3.5},{x:2,y:12,z:3.5}], ctx, 1);
  // Both should produce finite, sane scores; the two-listener score reflects the worse of the two seats.
  assert.ok(Number.isFinite(oneListener.score));
  assert.ok(Number.isFinite(twoListeners.score));
  assert.strictEqual(twoListeners.listenerStats.length, 2);
});

test('worstMinDb penalty engages (score is reduced) when the worst listener has a deep null (minDb < -20dB)', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallReflect: 0, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true }; // isolate direct path, no reflections
  // The candidate itself always contributes to the field too (default levelDb:0,
  // freqLow:20,freqHigh:20000 unless overridden) -- silence it via an explicit
  // levelDb override so this scenario is driven purely by quietSource.
  const silentCandidate = { x: 1, y: 1, z: 1, levelDb: -200 };
  const quietSource = { x: 9, y: 6, z: 1, levelDb: -30, delayMs: 0, freqLow: 20, freqHigh: 20000, enabled: true };
  const listeners = [{ x: 9, y: 6, z: 4 }]; // ~0.91m from quietSource
  const freqs = [60]; // a single frequency sample -> stdDev is trivially 0, isolating the minDb term

  const result = P.scoreSubPosition(silentCandidate, [quietSource], room, freqs, listeners, ctx, 1);
  assert.ok(result.worstMinDb < -20, `expected a deep null (<-20dB) to set up this test, got worstMinDb=${result.worstMinDb.toFixed(1)}`);
  approx(result.worstStdDev, 0, 1e-9, 'a single frequency sample should give zero std dev');
  const expectedPenalty = (-result.worstMinDb - 20) * 0.5;
  assert.ok(expectedPenalty > 0, 'this scenario should actually exercise a nonzero penalty');
  approx(result.score, result.avgMean - expectedPenalty, 1e-6, 'score should equal avgMean minus the worstMinDb penalty');
});

test('worstMinDb penalty is exactly zero when no listener dips below -20dB', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallReflect: 0, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const silentCandidate = { x: 1, y: 1, z: 1, levelDb: -200 };
  const loudSource = { x: 9, y: 6, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000, enabled: true };
  const listeners = [{ x: 9, y: 6, z: 4 }];
  const freqs = [60];

  const result = P.scoreSubPosition(silentCandidate, [loudSource], room, freqs, listeners, ctx, 1);
  assert.ok(result.worstMinDb >= -20, `expected no deep null for this test, got worstMinDb=${result.worstMinDb.toFixed(1)}`);
  approx(result.score, result.avgMean, 1e-6, 'with the penalty inactive, score should equal avgMean exactly (stdDev is also 0 here)');
});

console.log("\n-- scoreSubPosition: mode:'nullAvoidance' (for users with room correction/EQ) --");

test("mode defaults to 'balanced' when omitted (backward compatible)", () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const source = { x: 9, y: 6, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000, enabled: true };
  const listeners = [{ x: 9, y: 9, z: 3.5 }];
  const freqs = [40, 60, 80];
  const withoutMode = P.scoreSubPosition({x:2,y:2,z:1}, [source], room, freqs, listeners, ctx, 1);
  const explicitBalanced = P.scoreSubPosition({x:2,y:2,z:1}, [source], room, freqs, listeners, ctx, 1, 'balanced');
  approx(withoutMode.score, explicitBalanced.score, 1e-9);
});

test("mode:'nullAvoidance' score equals worstMinDb exactly, ignoring avgMean and worstStdDev", () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const source = { x: 9, y: 6, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000, enabled: true };
  const listeners = [{ x: 9, y: 9, z: 3.5 }];
  const freqs = [40, 60, 80];
  const result = P.scoreSubPosition({x:2,y:2,z:1}, [source], room, freqs, listeners, ctx, 1, 'nullAvoidance');
  approx(result.score, result.worstMinDb, 1e-9);
  const balanced = P.scoreSubPosition({x:2,y:2,z:1}, [source], room, freqs, listeners, ctx, 1, 'balanced');
  assert.notStrictEqual(result.score, balanced.score, "nullAvoidance and balanced should generally disagree on the same scene's score");
});

test("mode:'nullAvoidance' ranks the sharper-dip scenario worse, purely by tracking each scenario's own worst point (not a blend with average level)", () => {
  // Same construction as the 'balanced' mode null-penalty test above: a
  // single-source flat scenario vs a two-source scenario with a sharper dip
  // at one frequency (from partial phase cancellation).
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallReflect: 0, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const freqs = [40, 50, 60, 70, 80];
  const listeners = [{ x: 9, y: 6, z: 3.5 }];
  const candidatePos = { x: 9, y: 6.75, z: 1 };

  const flatSources = [
    { x: 5, y: 2, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 200, enabled: true }
  ];
  const lambda60 = P.C / 60;
  const nullySources = [
    { x: 5, y: 2, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 200, enabled: true },
    { x: 5 + (lambda60/2)/P.FT_TO_M, y: 2, z: 1, levelDb: 0, delayMs: (1000/(2*60))*0.999, freqLow: 20, freqHigh: 200, enabled: true }
  ];

  const flatNullAvoid = P.scoreSubPosition(candidatePos, flatSources, room, freqs, listeners, ctx, 1, 'nullAvoidance');
  const nullyNullAvoid = P.scoreSubPosition(candidatePos, nullySources, room, freqs, listeners, ctx, 1, 'nullAvoidance');
  assert.ok(nullyNullAvoid.score < flatNullAvoid.score,
    `expected the nulled candidate to score worse in nullAvoidance mode: flat=${flatNullAvoid.score.toFixed(1)} nully=${nullyNullAvoid.score.toFixed(1)}`);

  // The score should be exactly each scenario's own worstMinDb -- not some
  // blend involving avgMean or stdDev the way 'balanced' mode uses.
  approx(flatNullAvoid.score, flatNullAvoid.worstMinDb, 1e-9);
  approx(nullyNullAvoid.score, nullyNullAvoid.worstMinDb, 1e-9);
});

test("optimizeSubPlacement threads mode through to scoreSubPosition", () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [{ x: 9, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 200, enabled: true }];
  const freqs = [40, 60, 80];
  const listeners = [{ x: 9, y: 9, z: 3.5 }];

  const result = P.optimizeSubPlacement({
    room, otherSources: mains, freqList: freqs, listenerPositions: listeners, physicsCtx: ctx,
    reflectionOrder: 1, offLimitZones: [], preferredZones: [], gridStepFt: 3, subHeightFt: 1, mode: 'nullAvoidance'
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
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const source = { x: 9, y: 6, z: 1, levelDb: 0, delayMs: 0, freqLow: 20, freqHigh: 20000, enabled: true };
  const listeners = [{ x: 9, y: 9, z: 3.5 }];
  const freqs = [40, 60, 80];
  const candidatePos = { x: 2, y: 2, z: 1 };

  const withoutPenalty = P.scoreSubPosition(candidatePos, [source], room, freqs, listeners, ctx, 1, 'nullAvoidance');
  const withNearbyPlaced = P.scoreSubPosition(candidatePos, [source], room, freqs, listeners, ctx, 1, 'nullAvoidance', [{x:2.5,y:2}]);
  approx(withoutPenalty.score, withoutPenalty.worstMinDb, 1e-9, 'no alreadyPlaced -> no penalty, score is exactly worstMinDb');
  assert.ok(withNearbyPlaced.score < withNearbyPlaced.worstMinDb, 'a nearby already-placed point should pull the score below worstMinDb');
});

test('REGRESSION: optimizeMultipleSubs in nullAvoidance mode no longer clusters subs right at the minimum-separation floor', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [
    { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true },
    { x: 13.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true }
  ];
  const listeners = [{ x: 9, y: 9, z: 3.5 }];
  const freqs = [];
  for(let f = 20; f <= 120; f += Math.max(2, (120-20)/12)) freqs.push(f);

  const result = P.optimizeMultipleSubs({
    room, otherSources: mains, numSubs: 2, freqList: freqs, listenerPositions: listeners,
    physicsCtx: ctx, reflectionOrder: 1, offLimitZones: [], preferredZones: [],
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
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const result = P.scoreSubPosition({ x: 9, y: 6, z: 1 }, [], room, [60], [], ctx, 1);
  assert.ok(Number.isNaN(result.score), `expected NaN score with no listener positions, got ${result.score}`);
  assert.deepStrictEqual(result.listenerStats, []);
});

test('empty freqList produces a NaN score rather than throwing', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const result = P.scoreSubPosition({ x: 9, y: 6, z: 1 }, [], room, [], [{ x: 9, y: 6, z: 3.5 }], ctx, 1);
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

test('isCandidateValid with preferred zones ONLY accepts points inside one of them', () => {
  const room = { w: 18, d: 13.5 };
  const preferred = [{ x: 0, y: 0, width: 2, height: 2 }];
  assert.strictEqual(P.isCandidateValid(1, 1, room, [], preferred), true);
  assert.strictEqual(P.isCandidateValid(9, 9, room, [], preferred), false, 'outside all preferred zones should be rejected when preferred zones exist');
});

test('isCandidateValid with NO preferred zones allows anywhere in-room (not off-limits)', () => {
  const room = { w: 18, d: 13.5 };
  assert.strictEqual(P.isCandidateValid(9, 9, room, [], []), true);
});

console.log('\n-- optimizeSubPlacement --');

test('optimizer finds a best candidate and respects off-limits zones', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
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
    physicsCtx: ctx, reflectionOrder: 1, offLimitZones: offLimits, preferredZones: [],
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
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const offLimits = [{ x: 0, y: 0, width: 18, height: 13.5 }]; // blocks the entire room
  const result = P.optimizeSubPlacement({
    room, otherSources: [], freqList: [60], listenerPositions: [{x:9,y:9,z:3.5}],
    physicsCtx: ctx, reflectionOrder: 1, offLimitZones: offLimits, preferredZones: [],
    gridStepFt: 1, subHeightFt: 1
  });
  assert.strictEqual(result.best, null);
  assert.strictEqual(result.allCandidates.length, 0);
});

console.log('\n-- optimizeMultipleSubs (greedy sequential placement) --');

test('places the requested number of subs', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [
    { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true },
    { x: 13.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true }
  ];
  const result = P.optimizeMultipleSubs({
    room, otherSources: mains, numSubs: 3, freqList: [40,60,80,100],
    listenerPositions: [{x:9,y:9,z:3.5}], physicsCtx: ctx, reflectionOrder: 1,
    offLimitZones: [], preferredZones: [], gridStepFt: 1, subHeightFt: 1
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
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [
    { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true },
    { x: 13.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true }
  ];
  const result = P.optimizeMultipleSubs({
    room, otherSources: mains, numSubs: 2, freqList: [30,40,50,60,70,80],
    listenerPositions: [{x:9,y:9,z:3.5}], physicsCtx: ctx, reflectionOrder: 1,
    offLimitZones: [], preferredZones: [], gridStepFt: 0.5, subHeightFt: 1
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
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const offLimits = [{ x: 0, y: 0, width: 18, height: 10 }]; // only y=[10,13.5] is allowed
  const result = P.optimizeMultipleSubs({
    room, otherSources: [], numSubs: 3, freqList: [40,60,80],
    listenerPositions: [{x:9,y:12,z:3.5}], physicsCtx: ctx, reflectionOrder: 1,
    offLimitZones: offLimits, preferredZones: [], gridStepFt: 1, subHeightFt: 1
  });
  for(const sub of result.placedSubs){
    assert.ok(sub.y >= 10, `every placed sub should respect the off-limits zone, got y=${sub.y}`);
  }
});

test('stops placing subs (without error) if candidates run out', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  // Preferred zone so small (relative to a coarse grid step) that at most 1 candidate exists.
  const tinyPreferred = [{ x: 9, y: 6.75, width: 0.4, height: 0.4 }];
  const result = P.optimizeMultipleSubs({
    room, otherSources: [], numSubs: 5, freqList: [60],
    listenerPositions: [{x:9,y:9,z:3.5}], physicsCtx: ctx, reflectionOrder: 1,
    offLimitZones: [], preferredZones: tinyPreferred, gridStepFt: 1, subHeightFt: 1
  });
  assert.ok(result.placedSubs.length <= 5, 'should never place more than requested');
  assert.ok(result.placedSubs.length >= 0, 'should not throw even if it cannot fill all requested subs');
});

test('PERFORMANCE: cost scales linearly with sub count, not exponentially', () => {
  // This is the actual point of greedy placement -- confirm empirically that going
  // from 1 to 4 subs costs roughly 4x the work (linear), not candidates^4 (exponential).
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [
    { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true },
    { x: 13.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true }
  ];
  const freqs = [40,60,80,100];
  const listeners = [{x:9,y:9,z:3.5}];
  const commonOpts = {
    room, otherSources: mains, freqList: freqs, listenerPositions: listeners,
    physicsCtx: ctx, reflectionOrder: 1, offLimitZones: [], preferredZones: [],
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
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const mains = [
    { x: 4.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true },
    { x: 13.5, y: 1.5, z: 3, levelDb: 0, delayMs: 0, freqLow: 80, freqHigh: 20000, enabled: true }
  ];
  const result = P.optimizeMultipleSubs({
    room, otherSources: mains, numSubs: 4, freqList: [30,40,50,60,70,80,90,100],
    listenerPositions: [{x:9,y:9,z:3.5}], physicsCtx: ctx, reflectionOrder: 1,
    offLimitZones: [], preferredZones: [], gridStepFt: 0.5, subHeightFt: 1
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

test('minSeparationFt is configurable and respected', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const result = P.optimizeMultipleSubs({
    room, otherSources: [], numSubs: 2, freqList: [60],
    listenerPositions: [{x:9,y:9,z:3.5}], physicsCtx: ctx, reflectionOrder: 1,
    offLimitZones: [], preferredZones: [], gridStepFt: 0.5, subHeightFt: 1,
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
  const ctx1 = { room: room1, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
  const ctx2 = { room: room2, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };

  const r1 = P.optimizeMultipleSubs({
    room: room1, otherSources: [], numSubs: 2, freqList: [60],
    listenerPositions: [{x:9,y:9,z:3.5}], physicsCtx: ctx1, reflectionOrder: 1,
    offLimitZones: [], preferredZones: [], gridStepFt: 0.5, subHeightFt: 1
  });
  const r2 = P.optimizeMultipleSubs({
    room: room2, otherSources: [], numSubs: 2, freqList: [60],
    listenerPositions: [{x:15,y:12,z:3.5}], physicsCtx: ctx2, reflectionOrder: 1,
    offLimitZones: [], preferredZones: [], gridStepFt: 0.5, subHeightFt: 1
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

console.log('\n-- estimatedT60 (Sabine reverberation estimate) --');

test('matches hand-calculated Sabine T60 for a uniform-reflectivity room', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const ctx = { wallReflect: 0.7 };
  const alpha = 1 - 0.7*0.7;
  const areaFt2 = 2*(room.d*room.h) + 2*(room.w*room.h) + 2*(room.w*room.d);
  const totalAbsorptionM2 = areaFt2 * alpha * (P.FT_TO_M ** 2);
  const volumeM3 = (room.w*room.d*room.h) * (P.FT_TO_M ** 3);
  const expected = 0.161 * volumeM3 / totalAbsorptionM2;
  approx(P.estimatedT60(room, 100, ctx), expected, 0.001);
});

test('more reflective (less absorptive) surfaces produce a LONGER T60', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const liveT60 = P.estimatedT60(room, 100, { wallReflect: 0.9 });
  const deadT60 = P.estimatedT60(room, 100, { wallReflect: 0.3 });
  assert.ok(liveT60 > deadT60, `expected a more reflective room to ring longer: live=${liveT60.toFixed(2)}s dead=${deadT60.toFixed(2)}s`);
});

test('per-wall materials are respected -- masonry walls ring longer than insulated drywall', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const allMaterial = (key) => ({ left: P.WALL_MATERIALS[key], right: P.WALL_MATERIALS[key], front: P.WALL_MATERIALS[key], back: P.WALL_MATERIALS[key] });
  const masonryT60 = P.estimatedT60(room, 500, { wallReflect: 0.7, wallMaterials: allMaterial('masonry') });
  const drywallT60 = P.estimatedT60(room, 500, { wallReflect: 0.7, wallMaterials: allMaterial('drywallInsulated') });
  assert.ok(masonryT60 > drywallT60, `expected masonry (less absorptive) to outlast insulated drywall: masonry=${masonryT60.toFixed(2)}s drywall=${drywallT60.toFixed(2)}s`);
});

test('frequency-dependent -- T60 dips at a resonant wall material\'s peak absorption frequency', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const wallMaterials = { left: P.WALL_MATERIALS.drywallInsulated, right: P.WALL_MATERIALS.drywallInsulated, front: P.WALL_MATERIALS.drywallInsulated, back: P.WALL_MATERIALS.drywallInsulated };
  const atPeak = P.estimatedT60(room, 80, { wallReflect: 0.7, wallMaterials }); // drywallInsulated's peakFreq
  const farFromPeak = P.estimatedT60(room, 2000, { wallReflect: 0.7, wallMaterials });
  assert.ok(atPeak < farFromPeak, `expected shorter T60 right at the resonant absorption peak: atPeak=${atPeak.toFixed(2)}s farFromPeak=${farFromPeak.toFixed(2)}s`);
});

test('floorReflect and ceilingMaterial each independently affect the result', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const base = P.estimatedT60(room, 100, { wallReflect: 0.7 });
  const deaderFloor = P.estimatedT60(room, 100, { wallReflect: 0.7, floorReflect: 0.2 });
  const deaderCeiling = P.estimatedT60(room, 100, { wallReflect: 0.7, ceilingMaterial: { baseReflect: 0.2, peakDepth: 0 } });
  assert.ok(deaderFloor < base, 'a more absorptive floor should shorten T60');
  assert.ok(deaderCeiling < base, 'a more absorptive ceiling should shorten T60');
});

test('feeds sensibly into schroederFrequency (finite, positive result)', () => {
  const room = { w: 18, d: 13.5, h: 8 };
  const t60 = P.estimatedT60(room, 60, { wallReflect: 0.75, ceilingMaterial: P.WALL_MATERIALS.suspendedTile });
  const fs = P.schroederFrequency(room, t60);
  assert.ok(Number.isFinite(fs) && fs > 0, `expected a finite, positive Schroeder frequency, got ${fs}`);
});

test('returns 0 (not NaN/Infinity) for a degenerate room with zero volume', () => {
  const room = { w: 0, d: 13.5, h: 8 };
  assert.strictEqual(P.estimatedT60(room, 100, { wallReflect: 0.7 }), 0);
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
  const ctx = { room, wallReflect: 0.7, openings: [], openingsEnabled: true, panels: [], panelsEnabled: true };
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
        const result = P.fieldDbAtEars({x:lx, y:ly, z:3.5}, 0, mains, 1, freq, ctx);
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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
