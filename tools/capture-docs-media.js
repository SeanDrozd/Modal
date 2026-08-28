// Regenerates docs/*.png and docs/{sweep,optimizer}-demo.webp from the live
// app. Run this after any UI change that could affect their appearance
// (layout, colors, wording) -- it's cheaper to re-run than to hand-verify
// screenshots are still accurate.
//
//   cd tools && npm install && npm run capture-docs-media
//
// Uses Microsoft Edge (channel: 'msedge') since that's the Chromium build
// available on the primary dev machine; swap to plain chromium.launch() if
// you don't have Edge installed.
//
// Animated output is WebP (via sharp/libvips), not GIF: GIF's 256-color
// palette bands visibly on the heatmap's smooth gradient, and there's no way
// to fix that without dithering, which in turn defeats GIF's run-length
// compression and roughly doubles-to-triples file size (measured, not
// theoretical -- an earlier version of this script tried it). WebP has no
// palette limit, so the gradient stays smooth AND file size stays small.
// GitHub's README renderer just serves the raw image file and lets the
// browser animate it, and every current browser natively animates WebP
// inside a plain <img>/markdown image tag, so this still autoplays inline --
// an actual video file would NOT work here, since GitHub strips <video> tags
// from rendered READMEs.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const sharp = require('sharp');

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

// Downsamples a screenshot PNG buffer to `scale` and returns raw RGBA pixels
// (box-average, not nearest-neighbor -- looks noticeably less aliased at
// scale<1, since every source pixel that maps into a destination pixel gets
// averaged in rather than one arbitrarily picked).
function downsampleToRaw(buf, scale){
  const png = PNG.sync.read(buf);
  const w = Math.round(png.width * scale), h = Math.round(png.height * scale);
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y / scale), sy1 = Math.min(png.height, Math.floor((y + 1) / scale));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x / scale), sx1 = Math.min(png.width, Math.floor((x + 1) / scale));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < Math.max(sy1, sy0 + 1) && sy < png.height; sy++) {
        for (let sx = sx0; sx < Math.max(sx1, sx0 + 1) && sx < png.width; sx++) {
          const si = (sy * png.width + sx) * 4;
          r += png.data[si]; g += png.data[si+1]; b += png.data[si+2]; a += png.data[si+3];
          n++;
        }
      }
      const di = (y * w + x) * 4;
      out[di] = r / n; out[di+1] = g / n; out[di+2] = b / n; out[di+3] = a / n;
    }
  }
  return { data: out, w, h };
}

// Animated WebP via sharp/libvips: stack all frames' raw RGBA into ONE
// concatenated buffer (a "toilet roll" -- same layout sharp itself uses
// internally when reading a multi-page GIF/WebP) and describe it with
// raw.pageHeight, sharp's documented way to tell the raw-pixel reader where
// each frame boundary falls. Once pageHeight is set, sharp treats the input
// as a genuine multi-page image, and .webp() writes all pages back out as
// animated frames automatically -- the same path it uses when converting an
// existing animated GIF to animated WebP.
// quality 85, lossy: the WebP codec has no fixed palette the way GIF does,
// so even lossy compression doesn't band on a smooth gradient the way GIF's
// 256-color nearest-match does -- this is what actually fixes the banding,
// not a dithering trick layered on top of a palette format.
async function encodeWebp(frames, outPath, scale, delayMs){
  delayMs = delayMs ?? 90;
  const raws = frames.map((buf) => downsampleToRaw(buf, scale));
  const { w, h } = raws[0];
  // Every frame MUST be exactly w x h -- pageHeight-based stacking assumes a
  // uniform frame size, and a single mismatched frame (e.g. a screenshot
  // taken while a scrollbar/tooltip briefly changed the page's layout
  // height) silently shifts every later frame's byte alignment, which
  // libvips resolves by floor-dividing the total buffer size by the
  // expected per-page size -- i.e. it silently DROPS frames from the end
  // rather than erroring, which is a much worse failure mode than a loud
  // crash here.
  raws.forEach((r, i) => {
    if(r.w !== w || r.h !== h){
      throw new Error(`encodeWebp: frame ${i} is ${r.w}x${r.h}, expected ${w}x${h} (all frames must match) -- outPath=${outPath}`);
    }
  });
  const stacked = Buffer.concat(raws.map(r => r.data));
  await sharp(stacked, {
    raw: { width: w, height: h * raws.length, channels: 4, pageHeight: h }
  })
    // minSize:true: prevents libwebp from using animation keyframes to
    // minimize file size. Kept on principle (we want every real frame
    // preserved, not size-optimized away), though note: Pillow's own WebP
    // reader reports fewer frames than were written here regardless of this
    // setting, lossless vs lossy, or delay-as-number vs delay-as-array (all
    // tested, all identical result) -- that's very likely a Pillow/libwebp-
    // version reading quirk specific to pageHeight-constructed animations,
    // not a real defect in the file: it plays back correctly in an actual
    // browser (verified in Edge), which is the format that actually matters
    // here (GitHub README rendering).
    .webp({ delay: delayMs, quality: 85, loop: 0, minSize: true })
    .toFile(outPath);
  const { size } = fs.statSync(outPath);
  console.log(`Saved ${outPath}: ${(size/1024).toFixed(0)}KB, ${w}x${h}, ${frames.length} frames`);
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
  await page.click('#autofitDbRangeBtn'); // fit the color range to THIS scene before capturing, not whatever range was left over
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT_DIR, 'overview.png') });
  console.log('Saved overview.png');

  const findBtn = await page.$('#runOptimizerBtn');
  await findBtn.scrollIntoViewIfNeeded();
  await findBtn.click();
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.getElementById('optimizerSection').scrollIntoView({ block: 'start' }));
  await page.click('#autofitDbRangeBtn');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT_DIR, 'optimizer.png') });
  console.log('Saved optimizer.png');

  // Walls is collapsed by default -- expand it before shooting materials.png
  await expandSection(page, 'wallsSection');
  await page.waitForTimeout(150);
  await page.evaluate(() => document.getElementById('wallsSection').scrollIntoView({ block: 'start' }));
  await page.click('#autofitDbRangeBtn');
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

  // Enlarge the default off-limits zone (50% of room, centered -- see
  // defaultOffLimitZones in modal.html) for GIF B's optimizer demo: at the
  // default size, the optimizer's suggested sub positions landed just
  // outside the zone's edge, uncomfortably close to the listening position.
  // Dragged via the zone's own nw/se resize handles (the same interaction a
  // real user has -- there's no numeric width/height field for zones), not
  // by poking internal state, since that state isn't exposed outside the
  // app's closure.
  async function dragZoneHandle(fromFt, toFt, steps){
    const from = toScreen(fromFt.x, fromFt.y);
    const to = toScreen(toFt.x, toFt.y);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: steps || 10 });
    await page.mouse.up();
    await page.waitForTimeout(200);
  }
  {
    const oldW = ROOM.w * 0.5, oldD = ROOM.d * 0.5; // must match defaultOffLimitZones' formula
    const oldNW = { x: (ROOM.w - oldW) / 2, y: (ROOM.d - oldD) / 2 };
    const oldSE = { x: oldNW.x + oldW, y: oldNW.y + oldD };
    const newW = ROOM.w * 0.7, newD = ROOM.d * 0.7; // same center, bigger footprint
    const newNW = { x: (ROOM.w - newW) / 2, y: (ROOM.d - newD) / 2 };
    const newSE = { x: newNW.x + newW, y: newNW.y + newD };
    await dragZoneHandle(oldNW, newNW);
    await dragZoneHandle(oldSE, newSE);
  }

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
  const canvasWrap = page.locator('#canvasWrap');

  const sweepLo = Math.max(20, worst.freq - 50);
  const sweepHi = Math.min(200, worst.freq + 80);
  // Autofit at the sweep's MIDPOINT frequency (not wherever the slider
  // happens to be) so the fitted color range represents the sweep as a
  // whole, not whichever end it's biased toward. One fixed range for the
  // whole animation -- re-autofitting every frame would make the color
  // scale itself visibly shift throughout, which is worse than a range
  // that's merely not perfectly optimal at both ends.
  await setFreq(page, (sweepLo + sweepHi) / 2);
  await page.waitForTimeout(200);
  await page.click('#autofitDbRangeBtn');
  await page.waitForTimeout(150);
  await setFreq(page, sweepLo);
  await page.waitForTimeout(200);
  // Match the app's real "2x" sweep speed (FREQ_SWEEP_BASE_HZ_PER_SEC in
  // modal.html, 15Hz/sec, times the 2x entry in FREQ_SWEEP_SPEED_LEVELS)
  // rather than an arbitrary fixed frame count/delay -- otherwise the GIF
  // plays faster or slower than what "Sweep" at a given speed actually looks
  // like live. Total GIF playback duration = the real time this sweep would
  // take in-app at that speed; frame count is just how finely that duration
  // is sampled (capped so the file doesn't balloon on a wide sweep span).
  const SWEEP_HZ_PER_SEC = 15 * 2;
  const realDurationMs = ((sweepHi - sweepLo) / SWEEP_HZ_PER_SEC) * 1000;
  const NA = Math.max(60, Math.min(240, Math.round(realDurationMs / 25))); // ~40fps, capped (2x the previous ~20fps/120-frame cap -- WebP's small file size leaves plenty of room for it)
  const delayMs = Math.round(realDurationMs / NA);
  const framesA = [];
  for (let i = 0; i < NA; i++) {
    const f = sweepLo + (sweepHi - sweepLo) * (i / (NA - 1));
    await setFreq(page, f);
    // The app's own redraw is requestAnimationFrame-coalesced (setFreq
    // dispatches 'input' -> scheduleDraw() -> one rAF later, draw() actually
    // runs), not synchronous -- a fixed waitForTimeout(20) sometimes wasn't
    // enough margin for that rAF (plus the paint it produces) to land before
    // the screenshot, which caught the PREVIOUS frame's content instead:
    // a duplicate frame, which reads as a periodic stutter/pause in the
    // exported animation whenever it happened. Waiting for two real rAF
    // ticks (not a guessed millisecond budget) guarantees the scheduled
    // draw() has both run AND been painted, regardless of machine speed.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    framesA.push(await canvasWrap.screenshot());
    process.stdout.write('.');
  }
  console.log(`\nCaptured ${framesA.length} frames for GIF A (${(realDurationMs/1000).toFixed(1)}s real-time sweep, ${delayMs}ms/frame)`);
  await encodeWebp(framesA, path.join(OUT_DIR, 'sweep-demo.webp'), 0.9, delayMs);

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
  await page.click('#autofitDbRangeBtn'); // fit to the "before" symmetric-null scene; stays fixed through the "after" state too, same reasoning as GIF A
  await page.waitForTimeout(150);

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

  // Moves several sources "together" across `steps` animation steps. There's
  // no real simultaneous drag available here -- Playwright only simulates one
  // mouse pointer, and the app's own drag model (`dragTarget`) only tracks
  // one dragged source at a time even on touch (see modal.html), so a true
  // multi-touch drag isn't something either side supports. Instead, at each
  // step this does a full quick grab/nudge/release for EVERY source in turn,
  // then captures a single frame once all of them have been nudged that
  // step -- so the GIF still reads as the subs moving together rather than
  // one finishing its whole journey before the next starts.
  async function animateDragMulti(moves, steps){
    const current = moves.map(m => ({ ...m.from }));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      for (let mi = 0; mi < moves.length; mi++) {
        const { from, to } = moves[mi];
        const ix = from.x + (to.x - from.x) * t;
        const iy = from.y + (to.y - from.y) * t;
        const grabAt = toScreen(current[mi].x, current[mi].y);
        const dropAt = toScreen(ix, iy);
        await page.mouse.move(grabAt.x, grabAt.y);
        await page.mouse.down();
        await page.mouse.move(dropAt.x, dropAt.y);
        await page.mouse.up();
        current[mi] = { x: ix, y: iy };
      }
      await page.waitForTimeout(260); // let the debounced freq-response recompute settle
      await captureB();
    }
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
    await animateDragMulti([{ from: starts[0], to: pairs[0] }, { from: starts[1], to: pairs[1] }], 40);
  }

  for (let i = 0; i < 6; i++) await captureB(); // hold on the "after" (optimized) state

  console.log('Captured', framesB.length, 'frames for GIF B');
  await encodeWebp(framesB, path.join(OUT_DIR, 'optimizer-demo.webp'), 1.0);

  if(consoleErrors.length > 0){
    console.error('Console errors during capture:', consoleErrors);
    process.exitCode = 1;
  }
  await browser.close();
})();
