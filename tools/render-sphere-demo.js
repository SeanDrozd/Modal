// Renders docs/sphere-sampling-demo.gif: a rotating 3D point-cloud
// visualization of RoomPhysics.sphereSamplePoints, the deterministic
// Fibonacci-lattice + cube-root-radius sampling used by
// spatiallyAveragedResponse (see the README's "Frequency response:
// moving-mic-style spatial averaging" section). Pure from-scratch software
// rendering (no browser, no WebGL, no 3D library) -- just a weak-perspective
// projection and painter's-algorithm depth sorting onto a manually
// rasterized PNG buffer per frame.
//
// Re-run this only if sphereSamplePoints' radius/point-count/algorithm
// changes; it doesn't depend on the app's UI at all.
//
//   cd tools && npm install && npm run render-sphere-demo

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');
const P = require('../src/room-physics.js');

const OUT_PATH = path.join(__dirname, '..', 'docs', 'sphere-sampling-demo.gif');

const W = 640, H = 640;
const BG = [11, 14, 18];

function makeBuffer(){
  const buf = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    buf[i*4] = BG[0]; buf[i*4+1] = BG[1]; buf[i*4+2] = BG[2]; buf[i*4+3] = 255;
  }
  return buf;
}

function blend(buf, x, y, color, alpha){
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const idx = (y * W + x) * 4;
  buf[idx]   = Math.round(buf[idx]   * (1 - alpha) + color[0] * alpha);
  buf[idx+1] = Math.round(buf[idx+1] * (1 - alpha) + color[1] * alpha);
  buf[idx+2] = Math.round(buf[idx+2] * (1 - alpha) + color[2] * alpha);
}

function drawDisc(buf, cx, cy, r, color, alpha){
  const r2 = r * r;
  for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
    for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
      const d2 = dx*dx + dy*dy;
      if (d2 <= r2) {
        // soft edge antialiasing
        const edge = Math.sqrt(d2) - (r - 1);
        const a = edge > 1 ? 0 : edge < 0 ? alpha : alpha * (1 - edge);
        blend(buf, cx + dx, cy + dy, color, a);
      }
    }
  }
}

function drawLine(buf, x0, y0, x1, y1, color, alpha){
  const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    blend(buf, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, color, alpha);
  }
}

// Rotate around the vertical (z) axis by `az`, tilt by a fixed elevation `el`,
// then a simple weak-perspective projection to screen space.
const SCALE_PX_PER_FT = 130;
const CAM_DIST = 9;
function project(p, az, el){
  const ca = Math.cos(az), sa = Math.sin(az);
  let x = p.x * ca - p.y * sa;
  let y = p.x * sa + p.y * ca;
  let z = p.z;
  const ce = Math.cos(el), se = Math.sin(el);
  const y2 = y * ce - z * se;
  const z2 = y * se + z * ce;
  y = y2; z = z2;
  const persp = CAM_DIST / (CAM_DIST - z);
  return {
    sx: W/2 + x * SCALE_PX_PER_FT * persp,
    sy: H/2 - y * SCALE_PX_PER_FT * persp, // y is screen-vertical here
    depth: z,
    persp
  };
}

function wireframeSphereLines(radius, steps){
  // A handful of great-circle rings (in local, unrotated 3D space) for
  // visual context -- purely decorative, no physics meaning.
  const lines = [];
  const rings = [
    // equator (xy plane)
    (t) => ({ x: radius*Math.cos(t), y: radius*Math.sin(t), z: 0 }),
    // two meridians
    (t) => ({ x: radius*Math.cos(t), y: 0, z: radius*Math.sin(t) }),
    (t) => ({ x: 0, y: radius*Math.cos(t), z: radius*Math.sin(t) }),
  ];
  for (const ring of rings) {
    const pts = [];
    for (let i = 0; i <= steps; i++) pts.push(ring((i/steps) * Math.PI * 2));
    lines.push(pts);
  }
  return lines;
}

function lerpColor(c0, c1, t){
  return [
    Math.round(c0[0] + (c1[0]-c0[0])*t),
    Math.round(c0[1] + (c1[1]-c0[1])*t),
    Math.round(c0[2] + (c1[2]-c0[2])*t)
  ];
}

const RADIUS_FT = 2;
const N_POINTS = 20;
const points = P.sphereSamplePoints(0, 0, 0, RADIUS_FT, N_POINTS);
const rings = wireframeSphereLines(RADIUS_FT, 48);

const INNER_COLOR = [79, 176, 232];  // app accent blue (near center, small t)
const OUTER_COLOR = [245, 213, 71];  // app accent yellow (near outer shell, large t)

const N_FRAMES = 72;
const frames = [];
for (let f = 0; f < N_FRAMES; f++) {
  const az = (f / N_FRAMES) * Math.PI * 2;
  const el = 0.45; // fixed elevation tilt, radians (~26deg)
  const buf = makeBuffer();

  // wireframe sphere (behind the points)
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const a = project(ring[i], az, el);
      const b = project(ring[i+1], az, el);
      drawLine(buf, a.sx, a.sy, b.sx, b.sy, [90, 99, 108], 0.35);
    }
  }

  // center marker (the listening position)
  const c = project({ x: 0, y: 0, z: 0 }, az, el);
  drawDisc(buf, c.sx, c.sy, 4, [245, 213, 71], 0.9);

  // sample points, painter's-algorithm sorted back-to-front by depth
  const projected = points.map((p, i) => ({ ...project(p, az, el), i }));
  projected.sort((a, b) => a.depth - b.depth);
  for (const pp of projected) {
    const t = pp.i / (N_POINTS - 1); // 0 = innermost-radius point, 1 = outermost
    const color = lerpColor(INNER_COLOR, OUTER_COLOR, t);
    const depthT = (pp.depth + RADIUS_FT) / (2 * RADIUS_FT); // 0 (far) .. 1 (near)
    const r = 5 + depthT * 4;
    const alpha = 0.55 + depthT * 0.45;
    drawDisc(buf, pp.sx, pp.sy, r, color, alpha);
  }

  const png = new PNG({ width: W, height: H });
  buf.copy(png.data);
  frames.push(PNG.sync.write(png));
  process.stdout.write('.');
}
console.log('\nRendered', frames.length, 'frames');

const rgbaFrames = frames.map(buf => {
  const png = PNG.sync.read(buf);
  return png.data;
});
const gif = GIFEncoder();
for (const data of rgbaFrames) {
  const palette = quantize(data, 256);
  const index = applyPalette(data, palette);
  gif.writeFrame(index, W, H, { palette, delay: 35 });
}
gif.finish();
const outBuf = Buffer.from(gif.bytes());
fs.writeFileSync(OUT_PATH, outBuf);
console.log('Saved', OUT_PATH, (outBuf.length/1024).toFixed(0), 'KB');
