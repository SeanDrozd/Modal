// Field rendering: turns a precomputed modal-field coefficient list into
// pixels, on either the CPU (canvas2d) or GPU (WebGL) path. No DOM lookups of
// its own — every canvas/context/callback this module touches is passed in
// explicitly by the caller via createRenderer(), so it has no knowledge of
// the app's UI/element IDs and could be reused (or tested) outside this
// specific page.
//
// The GLSL fragment shader mirrors computeFieldAtPoint from room-physics.js
// (see the shader's own comments) — mode enumeration, per-mode complex
// coefficients (enumerateModes/precomputeModalField) and the per-row partial
// sums (fieldRowSums) stay in that one JS implementation; this module's GPU
// path only does the final per-pixel sum over the few distinct x
// frequencies, which is the part that actually benefits from GPU parallelism.
// A room that is not a rectangle (a solved floor plan, see
// RoomPhysics.solveFloorPlan) has no separable modes, so its field is summed
// on the CPU at every cell of the plan's grid (floorPlanCellField) and its
// shader blends the four cell values around each pixel, the same blend
// computeFieldAtPoint uses (FLOOR_PLAN_FRAGMENT_SRC).

(function(root, factory){
  const mod = factory();
  if(typeof module !== 'undefined' && module.exports){
    module.exports = mod; // Node / CommonJS (test harness)
  } else {
    root.FieldRenderer = mod; // browser global
  }
})(typeof self !== 'undefined' ? self : this, function(){

  // The shader sums one term per distinct kx (the mode's x spatial
  // frequency) instead of one per mode: room-physics.js's fieldRowSums
  // pre-sums every mode sharing a kx for each map row on the CPU (all the
  // y and z cosines), and that per-row table rides on a float texture, one
  // texel per (row, kx) holding (re, im, kx). A 20 x 15 x 8 ft room's 261
  // modes become 11 terms per pixel, and the 30 x 30 x 15 ft maximum's 1,265
  // become 16. MAX_COLS is the shader's loop bound and texture width: a
  // generous ceiling (the largest room the app allows needs 16), kept small
  // because a long loop bound is what made the old per-mode loop slow under
  // ANGLE on Windows.
  const MAX_COLS = 64;

  const VERTEX_SRC = `
    attribute vec2 aPos;
    void main(){
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `;

  // What both fragment shaders share: the room rect's placement, the color
  // range and colormaps, and shade(), which turns a complex pressure into
  // the pixel's color (or, in debug mode, its encoded dB).
  const SHADER_COMMON = `
    precision highp float;
    uniform vec2 uCanvasSize;   // pixels
    uniform vec2 uFieldOrigin;  // pixels, top-left of the room's rendered rect
    uniform vec2 uFieldSize;    // pixels, w*scale x d*scale
    uniform vec2 uRoomSize;     // feet, room.w x room.d
    uniform float uDbMin;
    uniform float uDbMax;
    uniform bool uDebugMode;    // true: encode raw dB into RGBA instead of colormap (for CPU/GPU verification)
    uniform int uColormapId;    // 0=thermal, 1=full spectrum, 2=viridis (colorblind-safe), 3=cool to warm (default)

    const float FT_TO_M = 0.3048;

    // 8 stops -- the original 5 (black/blue/teal/yellow/orange-red) plus a
    // cyan and a green detour inserted in the middle, each deliberately off
    // the straight RGB line a plain 4-segment version would have drawn
    // through that gap, plus a true red past orange-red at the very top.
    vec3 colormapThermal(float t){
      vec3 c0 = vec3(11.0,14.0,18.0)/255.0;
      vec3 c1 = vec3(24.0,64.0,110.0)/255.0;
      vec3 c2 = vec3(20.0,130.0,160.0)/255.0;
      vec3 c3 = vec3(40.0,150.0,150.0)/255.0;
      vec3 c4 = vec3(70.0,190.0,70.0)/255.0;
      vec3 c5 = vec3(230.0,200.0,60.0)/255.0;
      vec3 c6 = vec3(230.0,80.0,50.0)/255.0;
      vec3 c7 = vec3(200.0,30.0,30.0)/255.0;
      if(t < 0.25) return mix(c0, c1, t/0.25);
      if(t < 0.375) return mix(c1, c2, (t-0.25)/0.125);
      if(t < 0.50) return mix(c2, c3, (t-0.375)/0.125);
      if(t < 0.625) return mix(c3, c4, (t-0.50)/0.125);
      if(t < 0.75) return mix(c4, c5, (t-0.625)/0.125);
      if(t < 0.875) return mix(c5, c6, (t-0.75)/0.125);
      return mix(c6, c7, (t-0.875)/0.125);
    }

    vec3 hsv2rgb(vec3 c){
      vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
      vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
      return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
    }

    // Full-spectrum: continuous hue sweep from violet (low) through blue,
    // cyan, green, yellow, orange to red (high) -- the classic rainbow ramp,
    // via HSV rather than fixed stops since a hue rotation IS the spectrum.
    vec3 colormapSpectrum(float t){
      float hue = (1.0 - t) * 0.75; // 0.75*360=270deg (violet) down to 0deg (red)
      return hsv2rgb(vec3(hue, 1.0, 0.95));
    }

    // Viridis: perceptually-uniform, monotonic in lightness, distinguishable
    // under deuteranopia/protanopia/tritanopia -- the standard colorblind-safe
    // scientific colormap (matplotlib default since 2015).
    vec3 colormapViridis(float t){
      vec3 c0 = vec3(68.0,1.0,84.0)/255.0;
      vec3 c1 = vec3(59.0,82.0,139.0)/255.0;
      vec3 c2 = vec3(33.0,145.0,140.0)/255.0;
      vec3 c3 = vec3(94.0,201.0,98.0)/255.0;
      vec3 c4 = vec3(253.0,231.0,37.0)/255.0;
      if(t < 0.25) return mix(c0, c1, t/0.25);
      if(t < 0.50) return mix(c1, c2, (t-0.25)/0.25);
      if(t < 0.75) return mix(c2, c3, (t-0.50)/0.25);
      return mix(c3, c4, (t-0.75)/0.25);
    }

    // Cool to warm: Moreland's smooth diverging map (blue through a muted
    // grey to red), sampled at 9 evenly spaced stops from his published
    // table. Reads as "quiet to loud" without the banding of a rainbow.
    vec3 colormapCoolwarm(float t){
      vec3 c0 = vec3(59.0,76.0,192.0)/255.0;
      vec3 c1 = vec3(98.0,130.0,234.0)/255.0;
      vec3 c2 = vec3(141.0,176.0,254.0)/255.0;
      vec3 c3 = vec3(184.0,208.0,249.0)/255.0;
      vec3 c4 = vec3(221.0,221.0,221.0)/255.0;
      vec3 c5 = vec3(245.0,196.0,173.0)/255.0;
      vec3 c6 = vec3(244.0,154.0,123.0)/255.0;
      vec3 c7 = vec3(222.0,96.0,77.0)/255.0;
      vec3 c8 = vec3(180.0,4.0,38.0)/255.0;
      if(t < 0.125) return mix(c0, c1, t/0.125);
      if(t < 0.25) return mix(c1, c2, (t-0.125)/0.125);
      if(t < 0.375) return mix(c2, c3, (t-0.25)/0.125);
      if(t < 0.50) return mix(c3, c4, (t-0.375)/0.125);
      if(t < 0.625) return mix(c4, c5, (t-0.50)/0.125);
      if(t < 0.75) return mix(c5, c6, (t-0.625)/0.125);
      if(t < 0.875) return mix(c6, c7, (t-0.75)/0.125);
      return mix(c7, c8, (t-0.875)/0.125);
    }

    vec3 colormap(float t){
      t = clamp(t, 0.0, 1.0);
      if(uColormapId == 1) return colormapSpectrum(t);
      if(uColormapId == 2) return colormapViridis(t);
      if(uColormapId == 3) return colormapCoolwarm(t);
      return colormapThermal(t);
    }

    // Encodes a value in [0,1] into RGBA at 8 bits/channel (~32 bits total),
    // decodable on the JS side after gl.readPixels. Used only in debug mode,
    // to extract the shader's raw dB output for comparison against the CPU path
    // without going through the lossy colormap.
    vec4 encodeFloat(float v){
      v = clamp(v, 0.0, 1.0);
      const float bias = 1.0 / 512.0;
      vec4 enc = vec4(1.0, 255.0, 65025.0, 16581375.0) * v;
      enc = fract(enc);
      enc -= enc.yzww * vec4(1.0/255.0, 1.0/255.0, 1.0/255.0, 0.0);
      return enc + bias;
    }

    vec4 shade(float re, float im){
      float mag = sqrt(re*re + im*im);
      float db = 20.0 * log(max(mag, 1e-6)) / log(10.0);

      if(uDebugMode){
        // Encode db (clamped to a wide, known range) as a normalized [0,1] value
        // so it survives 8-bit RGBA readback, then decoded back to dB in JS.
        // Range widened vs. the old image-source method's -100..40 -- the
        // modal method's overall amplitude normalization (A_n ~ c^2/V) sits on
        // a different, room-dependent absolute scale, typically tens of dB
        // higher (see room-physics.js's enumerateModes doc comment).
        const float DEBUG_DB_MIN = -60.0;
        const float DEBUG_DB_MAX = 200.0;
        float norm = (db - DEBUG_DB_MIN) / (DEBUG_DB_MAX - DEBUG_DB_MIN);
        return encodeFloat(norm);
      }

      float t = (db - uDbMin) / (uDbMax - uDbMin);
      return vec4(colormap(t), 1.0);
    }

    // This pixel in canvas2d coordinates (y down), or discard when it is
    // outside the room rect, letting cv's background show through.
    vec2 fieldPixel(){
      vec2 fragPx = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y);
      vec2 local = fragPx - uFieldOrigin;
      if(local.x < 0.0 || local.y < 0.0 || local.x > uFieldSize.x || local.y > uFieldSize.y) discard;
      return fragPx;
    }
  `;

  // A rectangle: fieldRowSums output (see MAX_COLS in JS), texel (column c,
  // row r) = (re, im, kx) for canvas pixel row uRowStart + r, counted from
  // the top.
  const FRAGMENT_SRC = SHADER_COMMON + `
    uniform int uCount;         // number of kx columns in uRowTex
    uniform sampler2D uRowTex;
    uniform vec2 uRowTexSize; // (MAX_COLS, allocated rows)
    uniform float uRowStart;

    void main(){
      vec2 fragPx = fieldPixel();
      float pxM = ((fragPx.x - uFieldOrigin.x) / uFieldSize.x) * uRoomSize.x * FT_TO_M;
      float v = (floor(fragPx.y) - uRowStart + 0.5) / uRowTexSize.y;

      float re = 0.0;
      float im = 0.0;
      for(int i = 0; i < ${MAX_COLS}; i++){
        if(i >= uCount) break;
        vec3 t = texture2D(uRowTex, vec2((float(i) + 0.5) / uRowTexSize.x, v)).rgb;
        float c = cos(t.z * pxM);
        re += t.x * c;
        im += t.y * c;
      }
      gl_FragColor = shade(re, im);
    }
  `;

  // Any other floor plan: uCellTex holds the field at each cell center of
  // the plan's grid, texel (i, j) = (re, im, 1) for the cell in column i
  // and row j, or (0, 0, 0) where that cell is outside the room. uColTex
  // and uRowTex hold, for each canvas pixel column and row inside the room
  // rect, (lower, t, cell): the two cell centers around the pixel and how
  // far toward the second it is (RoomPhysics.floorPlanBracket), and the
  // cell it is in. The pixel blends the four centers around it, leaving
  // out any outside the room and reweighting the rest, exactly as
  // RoomPhysics.floorPlanStencil does, and is discarded when its own cell
  // is outside the room.
  const FLOOR_PLAN_FRAGMENT_SRC = SHADER_COMMON + `
    uniform sampler2D uCellTex;
    uniform vec2 uCellTexSize; // (nx, ny)
    uniform sampler2D uColTex;
    uniform sampler2D uRowTex;
    uniform vec2 uColRange;    // (first canvas column, count)
    uniform vec2 uRowRange;    // (first canvas row, count)

    vec4 cellAt(float i, float j){
      return texture2D(uCellTex, vec2((i + 0.5) / uCellTexSize.x, (j + 0.5) / uCellTexSize.y));
    }

    void main(){
      vec2 fragPx = fieldPixel();
      vec3 col = texture2D(uColTex, vec2((floor(fragPx.x) - uColRange.x + 0.5) / uColRange.y, 0.5)).rgb;
      vec3 row = texture2D(uRowTex, vec2((floor(fragPx.y) - uRowRange.x + 0.5) / uRowRange.y, 0.5)).rgb;
      if(cellAt(col.z, row.z).b < 0.5) discard; // outside the floor
      float re = 0.0, im = 0.0, total = 0.0;
      for(int q = 0; q < 4; q++){
        float dx = mod(float(q), 2.0), dy = floor(float(q) / 2.0);
        float w = (dx > 0.5 ? col.y : 1.0 - col.y) * (dy > 0.5 ? row.y : 1.0 - row.y);
        if(w <= 0.0) continue;
        vec4 v = cellAt(col.x + dx, row.x + dy);
        if(v.b < 0.5) continue;
        re += w * v.r;
        im += w * v.g;
        total += w;
      }
      gl_FragColor = shade(re / total, im / total);
    }
  `;

  // JS-side mirror of the shader's colormap() above, used by the CPU render
  // path and the sidebar's gradient legend swatch -- kept in sync by hand
  // (same reasoning as the GLSL/JS physics split: this is a small, stable
  // function, and duplicating just the color ramp is far cheaper to keep in
  // sync than duplicating the whole field computation).
  const COLORMAP_STOPS = {
    thermal: [[0.00,[11,14,18]],[0.25,[24,64,110]],[0.375,[20,130,160]],[0.50,[40,150,150]],[0.625,[70,190,70]],[0.75,[230,200,60]],[0.875,[230,80,50]],[1.00,[200,30,30]]],
    viridis: [[0.00,[68,1,84]],[0.25,[59,82,139]],[0.50,[33,145,140]],[0.75,[94,201,98]],[1.00,[253,231,37]]],
    coolwarm: [[0.00,[59,76,192]],[0.125,[98,130,234]],[0.25,[141,176,254]],[0.375,[184,208,249]],[0.50,[221,221,221]],[0.625,[245,196,173]],[0.75,[244,154,123]],[0.875,[222,96,77]],[1.00,[180,4,38]]]
  };

  // Metadata for building a colormap picker UI -- id matches what colormap()
  // accepts and what the GLSL uColormapId int maps to (see COLORMAP_ID_TO_INT).
  // Listed in picker order, the app's default first.
  const COLORMAPS = [
    { id: 'coolwarm', label: 'Cool to warm (default)' },
    { id: 'thermal', label: 'Thermal' },
    { id: 'spectrum', label: 'Full spectrum' },
    { id: 'viridis', label: 'Colorblind-safe (Viridis)' }
  ];

  function colormapFromStops(t, stops){
    for(let i=0;i<stops.length-1;i++){
      const [t0,c0]=stops[i], [t1,c1]=stops[i+1];
      if(t>=t0 && t<=t1){
        const f=(t-t0)/(t1-t0);
        return [Math.round(c0[0]+(c1[0]-c0[0])*f), Math.round(c0[1]+(c1[1]-c0[1])*f), Math.round(c0[2]+(c1[2]-c0[2])*f)];
      }
    }
    return stops[stops.length-1][1];
  }

  function hsvToRgb(h, s, v){
    const i = Math.floor(h*6);
    const f = h*6 - i;
    const p = v*(1-s), q = v*(1-f*s), tt = v*(1-(1-f)*s);
    let r,g,b;
    switch(i%6){
      case 0: r=v; g=tt; b=p; break;
      case 1: r=q; g=v; b=p; break;
      case 2: r=p; g=v; b=tt; break;
      case 3: r=p; g=q; b=v; break;
      case 4: r=tt; g=p; b=v; break;
      default: r=v; g=p; b=q; break;
    }
    return [Math.round(r*255), Math.round(g*255), Math.round(b*255)];
  }

  // Mirrors the shader's colormapSpectrum: continuous hue sweep, violet to red.
  function colormapSpectrum(t){
    const hue = (1 - t) * 0.75;
    return hsvToRgb(hue, 1.0, 0.95);
  }

  function colormap(t, id){
    t = Math.max(0, Math.min(1, t));
    if(id === 'spectrum') return colormapSpectrum(t);
    if(id === 'viridis') return colormapFromStops(t, COLORMAP_STOPS.viridis);
    if(id === 'coolwarm') return colormapFromStops(t, COLORMAP_STOPS.coolwarm);
    return colormapFromStops(t, COLORMAP_STOPS.thermal);
  }

  const COLORMAP_ID_TO_INT = { thermal: 0, spectrum: 1, viridis: 2, coolwarm: 3 };

  // Inverse of the shader's encodeFloat: reconstruct the normalized [0,1] value
  // from 8-bit RGBA channels (dividing by 255 since readPixels gives 0-255 ints).
  function decodeFloatFromRGBA(r, g, b, a){
    return (r/255.0) + (g/255.0)/255.0 + (b/255.0)/65025.0 + (a/255.0)/16581375.0;
  }

  // Packs RoomPhysics.fieldRowSums for the given map rows into the RGBA
  // texels the shader samples (see uRowTex in FRAGMENT_SRC): (re, im, kx)
  // per (row, column), nCols wide. Columns past MAX_COLS are dropped, and
  // totalCols reports the true count so the caller can warn.
  function packRowTexture(precomputed, pz, rowYsFt){
    const { kx, nCols: totalCols, nRows, sums } = RoomPhysics.fieldRowSums(precomputed, pz, rowYsFt);
    const nCols = Math.min(totalCols, MAX_COLS);
    const buf = new Float32Array(nCols * nRows * 4);
    for(let r = 0; r < nRows; r++){
      for(let c = 0; c < nCols; c++){
        const o = (r*nCols + c)*4, i = (r*totalCols + c)*2;
        buf[o] = sums[i];
        buf[o+1] = sums[i+1];
        buf[o+2] = kx[c];
      }
    }
    return { buf, nCols, nRows, totalCols };
  }

  // The three textures FLOOR_PLAN_FRAGMENT_SRC samples, for a
  // precomputeModalField result that carries a floor plan, at height pz,
  // for the canvas pixel columns and rows at room x = colXsFt[c] and
  // y = rowYsFt[r]: cells (nx * ny texels), cols and rows (one texel each),
  // RGBA floats.
  function packFloorPlanTextures(precomputed, pz, colXsFt, rowYsFt){
    const plan = precomputed.floorPlan;
    const field = RoomPhysics.floorPlanCellField(precomputed, pz);
    const { nx, ny, xs, ys, cellId } = plan;
    const cells = new Float32Array(nx * ny * 4);
    for(let k = 0; k < nx * ny; k++){
      const id = cellId[k];
      if(id < 0) continue;
      cells[k*4] = field[id*2];
      cells[k*4+1] = field[id*2+1];
      cells[k*4+2] = 1;
    }
    const axis = (lines, n, valuesFt) => {
      const buf = new Float32Array(valuesFt.length * 4);
      valuesFt.forEach((v, i) => {
        const b = RoomPhysics.floorPlanBracket(lines, n, v * RoomPhysics.FT_TO_M);
        buf[i*4] = b.lower; buf[i*4+1] = b.t; buf[i*4+2] = b.cell;
      });
      return buf;
    };
    return { nx, ny, cells, cols: axis(xs, nx, colXsFt), rows: axis(ys, ny, rowYsFt) };
  }

  function compileShader(gl, type, src){
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if(!gl.getShaderParameter(sh, gl.COMPILE_STATUS)){
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('Shader compile error: ' + log);
    }
    return sh;
  }

  // Builds a renderer bound to a specific 2D canvas context and (optionally)
  // a WebGL context -- neither is looked up internally, so this module never
  // touches document/DOM directly. `onTruncationWarning(message|null)` is
  // called with a warning string when the GPU path had to drop kx columns
  // past MAX_COLS, or with null to clear a previous warning; the caller decides
  // how (or whether) to surface that in its own UI.
  function createRenderer({ ctx2d, gl, canvasGL, onTruncationWarning }){
    let gpuProgram = null;
    let gpuUniforms = null;
    let planProgram = null; // FLOOR_PLAN_FRAGMENT_SRC's program and uniforms
    let planUniforms = null;
    let planTextures = null; // cells, cols, rows
    let gpuInitFailed = false;
    // Double-buffered: writing into a texture the GPU may still be reading
    // from the previous frame's draw call forces the driver to stall the CPU
    // until that read finishes (a classic single-buffered-streaming-texture
    // antipattern) -- alternating between two textures each frame lets the
    // CPU write into the "other" one while the GPU finishes with the one it
    // just sampled, avoiding the stall entirely.
    let rowTextures = null;
    let texBufferIndex = 0;

    // Each texture is MAX_COLS wide and grows (never shrinks) to the tallest
    // row count asked for, so most frames only texSubImage2D the rows in use.
    function makeRowTexture(){
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return { tex, rows: 0 };
    }

    function initGPUProgram(){
      if(gpuProgram || gpuInitFailed || !gl) return;
      try {
        // Per-mode data rides on float textures (see FRAGMENT_SRC); this
        // extension is what makes gl.FLOAT a legal texImage2D type in WebGL1.
        // It's been supported on essentially all desktop and most mobile GPUs
        // for years, but isn't core WebGL1, so we still check and fall back.
        if(!gl.getExtension('OES_texture_float')){
          throw new Error('OES_texture_float extension unavailable');
        }

        const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
        // Both programs draw the same quad, with aPos bound to location 0.
        const link = (fragSrc) => {
          const prog = gl.createProgram();
          gl.attachShader(prog, vs);
          gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, fragSrc));
          gl.bindAttribLocation(prog, 0, 'aPos');
          gl.linkProgram(prog);
          if(!gl.getProgramParameter(prog, gl.LINK_STATUS)){
            throw new Error('Program link error: ' + gl.getProgramInfoLog(prog));
          }
          return prog;
        };
        const prog = link(FRAGMENT_SRC);
        const plan = link(FLOOR_PLAN_FRAGMENT_SRC);
        gpuProgram = prog;
        planProgram = plan;

        // full-screen quad (two triangles), in clip space
        const quad = new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

        rowTextures = [makeRowTexture(), makeRowTexture()];
        planTextures = [makeRowTexture().tex, makeRowTexture().tex, makeRowTexture().tex];
        const uniforms = (p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, n)]));
        planUniforms = uniforms(plan, ['uCanvasSize', 'uFieldOrigin', 'uFieldSize', 'uRoomSize', 'uDbMin', 'uDbMax', 'uDebugMode', 'uColormapId',
          'uCellTex', 'uCellTexSize', 'uColTex', 'uRowTex', 'uColRange', 'uRowRange']);

        gpuUniforms = {
          uCanvasSize: gl.getUniformLocation(prog, 'uCanvasSize'),
          uFieldOrigin: gl.getUniformLocation(prog, 'uFieldOrigin'),
          uFieldSize: gl.getUniformLocation(prog, 'uFieldSize'),
          uRoomSize: gl.getUniformLocation(prog, 'uRoomSize'),
          uDbMin: gl.getUniformLocation(prog, 'uDbMin'),
          uDbMax: gl.getUniformLocation(prog, 'uDbMax'),
          uCount: gl.getUniformLocation(prog, 'uCount'),
          uDebugMode: gl.getUniformLocation(prog, 'uDebugMode'),
          uColormapId: gl.getUniformLocation(prog, 'uColormapId'),
          uRowTex: gl.getUniformLocation(prog, 'uRowTex'),
          uRowTexSize: gl.getUniformLocation(prog, 'uRowTexSize'),
          uRowStart: gl.getUniformLocation(prog, 'uRowStart')
        };
      } catch(e){
        console.error('GPU shader init failed, falling back to CPU:', e);
        gpuInitFailed = true;
      }
    }

    // params: { RES, w, d, precomputed, pz, offX, offY, scale, sizeW, sizeH, dbMin, dbMax, colormapId }
    // (frequency is already baked into `precomputed`'s per-mode coefficients
    // by room-physics.js's precomputeModalField, so no separate `k` is needed here)
    function renderFieldCPU(params){
      const { RES, w, d, precomputed, pz, offX, offY, scale, sizeW, sizeH } = params;
      const DB_MIN = params.dbMin ?? -24, DB_MAX = params.dbMax ?? 12;
      const colormapId = params.colormapId;
      const field = new Float32Array(RES*RES);
      const refAmp = 1.0;
      for(let j=0;j<RES;j++){
        const py = (j/(RES-1)) * d;
        for(let i=0;i<RES;i++){
          const px = (i/(RES-1)) * w;
          const { re, im } = RoomPhysics.computeFieldAtPoint(px, py, pz, precomputed);
          const mag = Math.sqrt(re*re+im*im);
          field[j*RES+i] = 20 * Math.log10(Math.max(mag, 1e-6) / refAmp);
        }
      }

      const imgData = ctx2d.createImageData(RES, RES);
      for(let idx=0; idx<RES*RES; idx++){
        const t = Math.max(0, Math.min(1, (field[idx] - DB_MIN) / (DB_MAX - DB_MIN)));
        const c = colormap(t, colormapId);
        imgData.data[idx*4] = c[0]; imgData.data[idx*4+1] = c[1]; imgData.data[idx*4+2] = c[2]; imgData.data[idx*4+3] = 255;
      }
      const off = document.createElement('canvas');
      off.width = RES; off.height = RES;
      off.getContext('2d').putImageData(imgData, 0, 0);

      // CPU path owns the field canvas: clear it (transparent, so the page's
      // themed background shows through the margin around the room, the same
      // as in GPU mode), then draw the field.
      ctx2d.clearRect(0,0,sizeW,sizeH);
      ctx2d.imageSmoothingEnabled = true;
      ctx2d.drawImage(off, 0, 0, RES, RES, offX, offY, w*scale, d*scale);
    }

    // Real GPU field render: uploads the flattened per-mode coefficient list
    // as textures and draws a full-screen quad, letting the fragment shader
    // evaluate each mode's shape and sum per-pixel in parallel. Falls back to
    // CPU if shader init fails for any reason.
    function renderFieldGPU(params, debugMode){
      if(!gl){ renderFieldCPU(params); return; }
      initGPUProgram();
      if(gpuInitFailed || !gpuProgram){ renderFieldCPU(params); return; }

      try {
        const { w, d, precomputed, pz, offX, offY, scale, sizeW, sizeH } = params;

        if(canvasGL.width !== sizeW || canvasGL.height !== sizeH){
          canvasGL.width = sizeW;
          canvasGL.height = sizeH;
        }
        gl.viewport(0, 0, canvasGL.width, canvasGL.height);
        if(precomputed.floorPlan){
          drawFloorPlan(params, debugMode);
        } else {
          gl.useProgram(gpuProgram);

          // One table row per canvas pixel row inside the room rect, at the
          // same room y the shader derives for that row's pixel centers.
          const fieldH = d*scale;
          const rowStart = Math.max(0, Math.ceil(offY - 0.5));
          const rowEnd = Math.min(sizeH - 1, Math.floor(offY + fieldH - 0.5));
          const rowYs = [];
          for(let t = rowStart; t <= rowEnd; t++) rowYs.push(((t + 0.5 - offY) / fieldH) * d);
          const { buf, nCols, nRows, totalCols } = packRowTexture(precomputed, pz, rowYs);
          if(onTruncationWarning){
            if(totalCols > MAX_COLS){
              const msg = `GPU rendering is truncating modes: the room needs ${totalCols} mode columns but only ${MAX_COLS} fit. Some modes' contributions are being dropped from the field. Try switching to CPU rendering.`;
              console.warn(msg);
              onTruncationWarning(msg);
            } else {
              onTruncationWarning(null);
            }
          }

          gl.uniform2f(gpuUniforms.uCanvasSize, sizeW, sizeH);
          gl.uniform2f(gpuUniforms.uFieldOrigin, offX, offY);
          gl.uniform2f(gpuUniforms.uFieldSize, w*scale, d*scale);
          gl.uniform2f(gpuUniforms.uRoomSize, w, d);
          gl.uniform1f(gpuUniforms.uDbMin, params.dbMin ?? -24);
          gl.uniform1f(gpuUniforms.uDbMax, params.dbMax ?? 12);
          gl.uniform1i(gpuUniforms.uCount, nCols);
          gl.uniform1i(gpuUniforms.uDebugMode, debugMode ? 1 : 0);
          gl.uniform1i(gpuUniforms.uColormapId, COLORMAP_ID_TO_INT[params.colormapId] ?? 0);
          gl.uniform1f(gpuUniforms.uRowStart, rowStart);

          // Alternates between the two buffered textures (see the
          // double-buffering comment above) to avoid a CPU-GPU sync stall.
          texBufferIndex = 1 - texBufferIndex;
          const rowTexture = rowTextures[texBufferIndex];
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, rowTexture.tex);
          if(nRows > rowTexture.rows){
            rowTexture.rows = nRows;
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, MAX_COLS, nRows, 0, gl.RGBA, gl.FLOAT, null);
          }
          if(nRows > 0 && nCols > 0) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, nCols, nRows, gl.RGBA, gl.FLOAT, buf);
          gl.uniform1i(gpuUniforms.uRowTex, 0);
          gl.uniform2f(gpuUniforms.uRowTexSize, MAX_COLS, Math.max(1, rowTexture.rows));
        }

        const glErrBeforeDraw = gl.getError();
        if(glErrBeforeDraw !== gl.NO_ERROR){
          console.error('GPU path: WebGL error before draw:', glErrBeforeDraw);
        }

        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        const glErrAfterDraw = gl.getError();
        if(glErrAfterDraw !== gl.NO_ERROR){
          console.error('GPU path: WebGL error after draw:', glErrAfterDraw);
        }

        if(!debugMode){
          // The 2D canvas still owns overlays; clear it to fully transparent so cvGL shows through.
          ctx2d.clearRect(0, 0, sizeW, sizeH);
        }
      } catch(e){
        console.error('GPU render failed, falling back to CPU for this frame:', e);
        gpuInitFailed = true; // stop retrying every frame; caller can switch back to CPU manually
        renderFieldCPU(params);
      }
    }

    // renderFieldGPU's uniforms and textures for a floor plan's program, one
    // texel per canvas pixel column and row inside the room rect, at the
    // same room x and y the shader derives for those pixel centers.
    function drawFloorPlan(params, debugMode){
      const { w, d, precomputed, pz, offX, offY, scale, sizeW, sizeH } = params;
      if(onTruncationWarning) onTruncationWarning(null);
      const pixels = (off, size, room, canvasSize) => {
        const first = Math.max(0, Math.ceil(off - 0.5)), last = Math.min(canvasSize - 1, Math.floor(off + size - 0.5));
        const at = [];
        for(let t = first; t <= last; t++) at.push(((t + 0.5 - off) / size) * room);
        return { first, at };
      };
      const cols = pixels(offX, w*scale, w, sizeW), rows = pixels(offY, d*scale, d, sizeH);
      const packed = packFloorPlanTextures(precomputed, pz, cols.at, rows.at);
      gl.useProgram(planProgram);
      const u = planUniforms;
      gl.uniform2f(u.uCanvasSize, sizeW, sizeH);
      gl.uniform2f(u.uFieldOrigin, offX, offY);
      gl.uniform2f(u.uFieldSize, w*scale, d*scale);
      gl.uniform2f(u.uRoomSize, w, d);
      gl.uniform1f(u.uDbMin, params.dbMin ?? -24);
      gl.uniform1f(u.uDbMax, params.dbMax ?? 12);
      gl.uniform1i(u.uDebugMode, debugMode ? 1 : 0);
      gl.uniform1i(u.uColormapId, COLORMAP_ID_TO_INT[params.colormapId] ?? 0);
      const upload = (unit, tex, width, height, data, sampler) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, Math.max(1, width), height, 0, gl.RGBA, gl.FLOAT, width > 0 ? data : new Float32Array(4 * height));
        gl.uniform1i(sampler, unit);
      };
      upload(0, planTextures[0], packed.nx, packed.ny, packed.cells, u.uCellTex);
      upload(1, planTextures[1], cols.at.length, 1, packed.cols, u.uColTex);
      upload(2, planTextures[2], rows.at.length, 1, packed.rows, u.uRowTex);
      gl.uniform2f(u.uCellTexSize, packed.nx, packed.ny);
      gl.uniform2f(u.uColRange, cols.first, Math.max(1, cols.at.length));
      gl.uniform2f(u.uRowRange, rows.first, Math.max(1, rows.at.length));
      gl.activeTexture(gl.TEXTURE0);
    }

    return {
      renderFieldCPU,
      renderFieldGPU,
      initGPUProgram,
      get gpuInitFailed(){ return gpuInitFailed; },
      get gpuProgram(){ return gpuProgram; }
    };
  }

  return {
    MAX_COLS,
    VERTEX_SRC,
    FRAGMENT_SRC,
    FLOOR_PLAN_FRAGMENT_SRC,
    colormap,
    COLORMAPS,
    decodeFloatFromRGBA,
    packRowTexture,
    packFloorPlanTextures,
    compileShader,
    createRenderer
  };
});
