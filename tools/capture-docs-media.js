// Regenerates docs/*.png and docs/{sweep,optimizer}-demo.gif from the live
// app. Run this after any UI change that could affect their appearance
// (layout, colors, wording) -- it's cheaper to re-run than to hand-verify
// screenshots are still accurate.
//
//   cd tools && npm install && npm run capture-docs-media
//
// Uses Microsoft Edge (channel: 'msedge') since that's the Chromium build
// available on the primary dev machine; swap to plain chromium.launch() if
// you don't have Edge installed.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const OUT_DIR = path.join(__dirname, '..', 'docs');
const APP_URL = 'file:///' + path.join(__dirname, '..', 'src', 'modal.html').replace(/\\/g, '/');
const ROOM = { w: 18, d: 13.5, h: 8 };

// Reads the canvas's *actual* current resolution from the page instead of
// assuming a fixed square size -- the canvas resolution tracks the room's
// own w:d aspect ratio (e.g. 1400x1050 for this 18x13.5 room), not a
// hardcoded square, so the room<->screen mapping has to be read live.
async function makeRoomToScreen(page){
  const dims = await page.evaluate(() => {
    const cv = document.getElementById('cv');
    return { sizeW: cv.width, sizeH: cv.height };
  });
  const box = await page.locator('#cv').boundingBox();
  const margin = 40;
  const plotW = dims.sizeW - margin * 2;
  const plotH = dims.sizeH - margin * 2;
  const scale = Math.min(plotW / ROOM.w, plotH / ROOM.d);
  const offX = margin + (plotW - ROOM.w * scale) / 2;
  const offY = margin + (plotH - ROOM.d * scale) / 2;
  return (fx, fy) => ({
    x: box.x + (offX + fx * scale) * (box.width / dims.sizeW),
    y: box.y + (offY + fy * scale) * (box.height / dims.sizeH)
  });
}

function encodeGif(frames, outPath, scale){
  let gifW, gifH;
  const rgbaFrames = frames.map((buf) => {
    const png = PNG.sync.read(buf);
    gifW = Math.round(png.width * scale);
    gifH = Math.round(png.height * scale);
    const out = Buffer.alloc(gifW * gifH * 4);
    for (let y = 0; y < gifH; y++) {
      const sy = Math.min(png.height - 1, Math.floor(y / scale));
      for (let x = 0; x < gifW; x++) {
        const sx = Math.min(png.width - 1, Math.floor(x / scale));
        const si = (sy * png.width + sx) * 4;
        const di = (y * gifW + x) * 4;
        out[di] = png.data[si]; out[di+1] = png.data[si+1]; out[di+2] = png.data[si+2]; out[di+3] = png.data[si+3];
      }
    }
    return out;
  });
  const gif = GIFEncoder();
  for (const data of rgbaFrames) {
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, gifW, gifH, { palette, delay: 90 });
  }
  gif.finish();
  const buf = Buffer.from(gif.bytes());
  fs.writeFileSync(outPath, buf);
  console.log(`Saved ${outPath}: ${(buf.length/1024).toFixed(0)}KB, ${gifW}x${gifH}, ${frames.length} frames`);
}

async function setFreq(page, hz){
  await page.evaluate((v) => {
    const s = document.getElementById('freq');
    s.value = String(Math.round(v));
    s.dispatchEvent(new Event('input', { bubbles: true }));
  }, hz);
}

async function expandSection(page, sectionId){
  await page.evaluate((id) => {
    const el = document.getElementById(id);
    if(el && el.classList.contains('collapsed')) el.querySelector('.chevron').click();
  }, sectionId);
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', err => consoleErrors.push('pageerror: ' + err.message));

  await page.goto(APP_URL);
  await page.waitForTimeout(500);

  // ============================================================
  // Screenshots
  // ============================================================
  await page.click('#addSrcBtn');
  await setFreq(page, 45);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, 'overview.png') });
  console.log('Saved overview.png');

  const findBtn = await page.$('#runOptimizerBtn');
  await findBtn.scrollIntoViewIfNeeded();
  await findBtn.click();
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.getElementById('optimizerSection').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT_DIR, 'optimizer.png') });
  console.log('Saved optimizer.png');

  // Walls is collapsed by default -- expand it before shooting materials.png
  await expandSection(page, 'wallsSection');
  await page.waitForTimeout(150);
  await page.evaluate(() => document.getElementById('wallsSection').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT_DIR, 'materials.png') });
  console.log('Saved materials.png');

  // ============================================================
  // Reset to a clean scene, add 2 subs placed SYMMETRICALLY
  // ============================================================
  await page.evaluate(() => document.getElementById('freqResponseSection').scrollIntoView({ block: 'start' }));
  await page.click('#resetBtn');
  await page.waitForTimeout(300);

  await page.click('#addSrcBtn'); await page.waitForTimeout(150);
  await page.click('#addSrcBtn'); await page.waitForTimeout(150);

  let toScreen = await makeRoomToScreen(page);

  async function dragSourceFromTo(fromFt, toFt, steps){
    const from = toScreen(fromFt.x, fromFt.y);
    const to = toScreen(toFt.x, toFt.y);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: steps || 12 });
    await page.mouse.up();
    await page.waitForTimeout(200);
  }

  // Default spawn formula: x = min(room.w-1, 2 + n*1.5), y = room.d - 1.5, where
  // n = sources.length AT THE TIME of the click (2 mains already present).
  await dragSourceFromTo({ x: 5,   y: 12 }, { x: 4.5,  y: 12 }); // sub 1 -> symmetric left
  await dragSourceFromTo({ x: 6.5, y: 12 }, { x: 13.5, y: 12 }); // sub 2 -> symmetric right (mirror of sub1 about x=9)
  await page.waitForTimeout(400);

  // ============================================================
  // Empirically locate the null frequency for this symmetric setup
  // (scan the ear-dB readout, which updates live with the freq slider)
  // ============================================================
  let worst = { freq: 20, db: Infinity };
  for (let f = 20; f <= 120; f += 2) {
    await setFreq(page, f);
    await page.waitForTimeout(15);
    const text = await page.textContent('#earDiffInfo');
    const m = text.match(/Left ear:\s*(-?[\d.]+)\s*dB/);
    if (m) {
      const db = parseFloat(m[1]);
      if (db < worst.db) worst = { freq: f, db };
    }
  }
  console.log('Found null at', worst.freq, 'Hz,', worst.db, 'dB');

  // ============================================================
  // GIF A: frequency sweep across the symmetric-null scene
  // ============================================================
  await setFreq(page, 20);
  await page.waitForTimeout(200);
  const canvasWrap = page.locator('#canvasWrap');

  const sweepLo = Math.max(20, worst.freq - 50);
  const sweepHi = Math.min(200, worst.freq + 80);
  const NA = 30;
  const framesA = [];
  for (let i = 0; i < NA; i++) {
    const f = sweepLo + (sweepHi - sweepLo) * (i / (NA - 1));
    await setFreq(page, f);
    await page.waitForTimeout(60);
    framesA.push(await canvasWrap.screenshot());
    process.stdout.write('.');
  }
  console.log('\nCaptured', framesA.length, 'frames for GIF A');
  encodeGif(framesA, path.join(OUT_DIR, 'sweep-demo.gif'), 0.9);

  // ============================================================
  // GIF B: run the sub optimizer, animate the subs moving to the
  // suggested spot, show heatmap + frequency response improving together
  // ============================================================
  await setFreq(page, worst.freq);
  await page.waitForTimeout(300);

  // Shrink the viewport so a screenshot naturally frames both the
  // frequency-response panel and the full room canvas together.
  await page.setViewportSize({ width: 1440, height: 760 });
  await page.evaluate(() => document.getElementById('freqResponseSection').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(300);

  const framesB = [];
  async function captureB(){
    framesB.push(await page.screenshot());
  }

  for (let i = 0; i < 5; i++) await captureB(); // hold on the "before" (bad null) state

  // Disable the 2 symmetric subs before running the optimizer -- otherwise
  // the optimizer scores new positions as *complementary to those two still
  // playing*, not as a from-scratch best-2-subs answer, which tends to land
  // suspiciously close to the original symmetric spots (the "new" subs just
  // balance out the old ones rather than replacing them). Disabling first
  // gives a true best-2-subs-given-only-the-mains result, which is also the
  // fair comparison for a before/after demo.
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#srcList .src-block')].slice(-2);
    for (const row of rows) {
      const cb = row.querySelector('input[data-field="enabled"]');
      if (cb.checked) cb.click();
    }
  });
  await page.waitForTimeout(200);

  // Set optimizer to 2 subs, run it
  await page.evaluate(() => {
    const el = document.getElementById('optNumSubs');
    el.value = '2';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.click('#runOptimizerBtn');
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.getElementById('freqResponseSection').scrollIntoView({ block: 'start' })); // clicking runOptimizerBtn can auto-scroll it into view; restore the chart to view

  const statusText = await page.textContent('#optimizerStatus');
  console.log('Optimizer status:', statusText);

  // Re-enable the 2 subs now that the fresh suggestion is captured -- they
  // get dragged to the suggested spot below, same as before.
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#srcList .src-block')].slice(-2);
    for (const row of rows) {
      const cb = row.querySelector('input[data-field="enabled"]');
      if (!cb.checked) cb.click();
    }
  });
  await page.waitForTimeout(200);
  // Parse "(F'I",F'I")" pairs -> decimal feet
  const nums = [...statusText.matchAll(/(-?\d+)'(\d+)"/g)].map(m => parseInt(m[1], 10) + parseInt(m[2], 10) / 12);
  const targets = [];
  for (let i = 0; i + 1 < nums.length; i += 2) targets.push({ x: nums[i], y: nums[i+1] });
  console.log('Parsed targets:', targets);

  // Clear the optimizer's own preview overlay so it doesn't visually clutter
  // the "after" frames (we're moving the actual sources, not accepting the
  // suggestion via the button) -- ok to leave status, just clear the heatmap overlay.
  const clearBtn = await page.$('#clearOptimizerBtn');
  if (clearBtn) await clearBtn.click();
  await page.evaluate(() => document.getElementById('freqResponseSection').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(200);
  for (let i = 0; i < 3; i++) await captureB();

  toScreen = await makeRoomToScreen(page);

  async function animateDrag(fromFt, toFt, steps){
    const from = toScreen(fromFt.x, fromFt.y);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ix = fromFt.x + (toFt.x - fromFt.x) * t;
      const iy = fromFt.y + (toFt.y - fromFt.y) * t;
      const p = toScreen(ix, iy);
      await page.mouse.move(p.x, p.y);
      await page.waitForTimeout(260); // let the debounced freq-response recompute settle
      await captureB();
    }
    await page.mouse.up();
    await page.waitForTimeout(260);
    await captureB();
  }

  // Pair each starting sub with its NEAREST target rather than just using
  // the optimizer's return order -- with 2 subs there are only 2 possible
  // pairings (straight vs. swapped), so just compare total drag distance
  // for both and keep the shorter one. Otherwise a sub can end up crossing
  // the whole room to the far target while the near one goes unclaimed,
  // which reads as arbitrary rather than "each sub found a nearby wall."
  const starts = [{ x: 4.5, y: 12 }, { x: 13.5, y: 12 }];
  if (targets.length >= 2) {
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const straight = dist(starts[0], targets[0]) + dist(starts[1], targets[1]);
    const swapped = dist(starts[0], targets[1]) + dist(starts[1], targets[0]);
    const pairs = swapped < straight ? [targets[1], targets[0]] : [targets[0], targets[1]];
    await animateDrag(starts[0], pairs[0], 7);
    await animateDrag(starts[1], pairs[1], 7);
  }

  for (let i = 0; i < 6; i++) await captureB(); // hold on the "after" (optimized) state

  console.log('Captured', framesB.length, 'frames for GIF B');
  encodeGif(framesB, path.join(OUT_DIR, 'optimizer-demo.gif'), 1.0);

  if(consoleErrors.length > 0){
    console.error('Console errors during capture:', consoleErrors);
    process.exitCode = 1;
  }
  await browser.close();
})();
