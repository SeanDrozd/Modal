// Field rendering: turns a precomputed modal-field coefficient list into
// pixels, on either the CPU (canvas2d) or GPU (WebGL) path. No DOM lookups of
// its own — every canvas/context/callback this module touches is passed in
// explicitly by the caller via createRenderer(), so it has no knowledge of
// the app's UI/element IDs and could be reused (or tested) outside this
// specific page.
//
// The GLSL fragment shader mirrors computeFieldAtPoint from room-physics.js
// (see the shader's own comments) — mode enumeration and per-mode complex
// coefficients (enumerateModes/precomputeModalField) stay in that one JS
// implementation; this module's GPU path only does the final per-pixel sum
// over an already-computed mode list (a real-valued mode-shape evaluation
// times a precomputed complex coefficient), which is the part that actually
// benefits from GPU parallelism.

(function(root, factory){
  const mod = factory();
  if(typeof module !== 'undefined' && module.exports){
    module.exports = mod; // Node / CommonJS (test harness)
  } else {
    root.FieldRenderer = mod; // browser global
  }
})(typeof self !== 'undefined' ? self : this, function(){

  // Mode coefficient data is uploaded to the GPU as two floating-point
  // textures (see MODE_TEX_W/H below) rather than uniform arrays -- a
  // several-hundred-entry uniform array blows WebGL1's
  // MAX_FRAGMENT_UNIFORM_VECTORS budget (spec guarantees only 1024 total,
  // and each array entry here costs multiple vectors), which fails to link
  // on real hardware, not just weak/theoretical devices. A texture's size
  // budget (MAX_TEXTURE_SIZE) is a completely different, far larger limit.
  // The modal method has no "order" to truncate the way the old image-source
  // method did -- every mode below the room's fixed frequency cutoff is
  // included exactly (see room-physics.js's enumerateModes/MODE_CUTOFF_HZ),
  // so mode counts stay modest (~150-800 for typical room sizes) and this
  // cap exists only as a generous sane ceiling, not a real constraint. See
  // flattenModes for what happens if this is ever exceeded.
  //
  // 64x64 (4096) turned out not generous enough -- a large-but-real room
  // (e.g. 50x70x16ft) needs ~5000 modes below the 300Hz cutoff, since mode
  // count grows with volume (roughly cubically with the cutoff frequency,
  // per the standard 3D mode-density asymptotic). 128x128 (16384) gives
  // ~3x headroom over that case at negligible extra cost (a few hundred KB
  // of float-texture memory, still far under any real MAX_TEXTURE_SIZE, and
  // the shader's per-pixel loop already breaks at uCount, the actual mode
  // count -- see the fragment shader below -- so this costs nothing extra
  // for the common small-room case).
  const MODE_TEX_W = 128;
  const MODE_TEX_H = 128;
  const MAX_MODES = MODE_TEX_W * MODE_TEX_H; // 4096

  const VERTEX_SRC = `
    attribute vec2 aPos;
    void main(){
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `;

  const FRAGMENT_SRC = `
    precision highp float;
    uniform vec2 uCanvasSize;   // pixels
    uniform vec2 uFieldOrigin;  // pixels, top-left of the room's rendered rect
    uniform vec2 uFieldSize;    // pixels, w*scale x d*scale
    uniform vec2 uRoomSize;     // feet, room.w x room.d
    uniform float uListenerZ;   // feet
    uniform float uDbMin;
    uniform float uDbMax;
    uniform int uCount;         // number of valid entries in the textures below
    uniform bool uDebugMode;    // true: encode raw dB into RGBA instead of colormap (for CPU/GPU verification)
    uniform int uColormapId;    // 0=thermal (default), 1=full spectrum, 2=viridis (colorblind-safe)

    // Per-mode data, packed into two float textures instead of uniform arrays
    // (see MODE_TEX_W/H in JS -- this sidesteps WebGL1's small uniform-vector
    // budget entirely). uModeGeomTex.rgb = nx*pi/Lx, ny*pi/Ly, nz*pi/Lz (the
    // mode's per-axis angular spatial frequency, precomputed on the CPU so
    // the shader only needs a multiply, not an nx*pi/Lx per pixel); .a unused.
    // uModeCoefTex.rg = coefRe, coefIm -- the mode's already-divided complex
    // coefficient (source coupling and the 1/(k_n^2-k^2-jk*delta_n) division
    // both happen ONCE per mode on the CPU in precomputeModalField, not per
    // pixel -- so this shader's inner loop only needs a real-valued mode-shape
    // evaluation (three cosines) and one complex multiply-by-real-scalar).
    uniform sampler2D uModeGeomTex;
    uniform sampler2D uModeCoefTex;
    uniform vec2 uModeTexSize; // (MODE_TEX_W, MODE_TEX_H)

    vec2 modeTexelUV(int i){
      float w = uModeTexSize.x;
      float fi = float(i);
      float col = mod(fi, w);
      float row = floor(fi / w);
      return vec2((col + 0.5) / uModeTexSize.x, (row + 0.5) / uModeTexSize.y);
    }

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

    vec3 colormap(float t){
      t = clamp(t, 0.0, 1.0);
      if(uColormapId == 1) return colormapSpectrum(t);
      if(uColormapId == 2) return colormapViridis(t);
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

    void main(){
      vec2 fragPx = vec2(gl_FragCoord.x, uCanvasSize.y - gl_FragCoord.y); // flip Y to match canvas2d coords
      vec2 local = fragPx - uFieldOrigin;
      if(local.x < 0.0 || local.y < 0.0 || local.x > uFieldSize.x || local.y > uFieldSize.y){
        discard; // outside the room rect -- let cv's background show through
      }
      float px = (local.x / uFieldSize.x) * uRoomSize.x;
      float py = (local.y / uFieldSize.y) * uRoomSize.y;
      float pxM = px * FT_TO_M, pyM = py * FT_TO_M, pzM = uListenerZ * FT_TO_M;

      float re = 0.0;
      float im = 0.0;
      for(int i = 0; i < ${MAX_MODES}; i++){
        if(i >= uCount) break;
        vec2 uv = modeTexelUV(i);
        vec3 geom = texture2D(uModeGeomTex, uv).rgb; // nx*pi/Lx, ny*pi/Ly, nz*pi/Lz
        vec2 coef = texture2D(uModeCoefTex, uv).rg;  // coefRe, coefIm
        float psi = cos(geom.x * pxM) * cos(geom.y * pyM) * cos(geom.z * pzM);
        re += coef.x * psi;
        im += coef.y * psi;
      }
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
        gl_FragColor = encodeFloat(norm);
        return;
      }

      float t = (db - uDbMin) / (uDbMax - uDbMin);
      gl_FragColor = vec4(colormap(t), 1.0);
    }
  `;

  // JS-side mirror of the shader's colormap() above, used by the CPU render
  // path and the sidebar's gradient legend swatch -- kept in sync by hand
  // (same reasoning as the GLSL/JS physics split: this is a small, stable
  // function, and duplicating just the color ramp is far cheaper to keep in
  // sync than duplicating the whole field computation).
  const COLORMAP_STOPS = {
    thermal: [[0.00,[11,14,18]],[0.25,[24,64,110]],[0.375,[20,130,160]],[0.50,[40,150,150]],[0.625,[70,190,70]],[0.75,[230,200,60]],[0.875,[230,80,50]],[1.00,[200,30,30]]],
    viridis: [[0.00,[68,1,84]],[0.25,[59,82,139]],[0.50,[33,145,140]],[0.75,[94,201,98]],[1.00,[253,231,37]]]
  };

  // Metadata for building a colormap picker UI -- id matches what colormap()
  // accepts and what the GLSL uColormapId int maps to (0/1/2, same order).
  const COLORMAPS = [
    { id: 'thermal', label: 'Thermal (default)' },
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
    return colormapFromStops(t, COLORMAP_STOPS.thermal);
  }

  const COLORMAP_ID_TO_INT = { thermal: 0, spectrum: 1, viridis: 2 };

  // Inverse of the shader's encodeFloat: reconstruct the normalized [0,1] value
  // from 8-bit RGBA channels (dividing by 255 since readPixels gives 0-255 ints).
  function decodeFloatFromRGBA(r, g, b, a){
    return (r/255.0) + (g/255.0)/255.0 + (b/255.0)/65025.0 + (a/255.0)/16581375.0;
  }

  // Flattens a CPU-computed precomputeModalField result (room-physics.js) --
  // one entry per mode, each already carrying its final complex coefficient
  // (source coupling and the 1/(k_n^2-k^2-jk*delta_n) division both already
  // done, see precomputeModalField's doc comment) -- into flat typed arrays
  // for shader upload. This is the ONLY bridge between the two paths:
  // everything upstream of this (mode enumeration, per-mode coefficients) is
  // shared, single-implementation logic; everything downstream (the per-pixel
  // mode-shape evaluation and sum) is GPU-parallel.
  function flattenModes(precomputed){
    const geom = new Float32Array(MAX_MODES * 3);
    const coef = new Float32Array(MAX_MODES * 2);
    let count = 0;
    const totalWanted = precomputed.length; // true total, even past the cap -- lets callers detect truncation
    for(const mode of precomputed){
      if(count >= MAX_MODES) break; // keep totalWanted accurate above, but stop writing
      geom[count*3] = mode.invLx;
      geom[count*3+1] = mode.invLy;
      geom[count*3+2] = mode.invLz;
      coef[count*2] = mode.coefRe;
      coef[count*2+1] = mode.coefIm;
      count++;
    }
    return { geom, coef, count, totalWanted };
  }

  // Repacks flattenModes' flat arrays into the two RGBA texel buffers the
  // shader samples (see the uModeGeomTex/uModeCoefTex comment in
  // FRAGMENT_SRC). Only allocates/fills as many full rows as `count` actually
  // needs (not the full MODE_TEX_W*MODE_TEX_H capacity) -- the caller uploads
  // just those rows via texSubImage2D, so a typical frame (a couple hundred
  // modes) touches a handful of rows instead of re-uploading all 4096 texels.
  function packModeTextures(flattened){
    const { geom, coef, count } = flattened;
    const rows = count === 0 ? 0 : Math.min(MODE_TEX_H, Math.ceil(count / MODE_TEX_W));
    const geomBuf = new Float32Array(MODE_TEX_W * rows * 4);
    const coefBuf = new Float32Array(MODE_TEX_W * rows * 4);
    for(let i=0; i<count; i++){
      geomBuf[i*4] = geom[i*3];
      geomBuf[i*4+1] = geom[i*3+1];
      geomBuf[i*4+2] = geom[i*3+2];
      coefBuf[i*4] = coef[i*2];
      coefBuf[i*4+1] = coef[i*2+1];
    }
    return { geomBuf, coefBuf, rows };
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
  // called with a warning string when the GPU path had to drop modes past
  // MAX_MODES, or with null to clear a previous warning; the caller decides
  // how (or whether) to surface that in its own UI.
  function createRenderer({ ctx2d, gl, canvasGL, onTruncationWarning }){
    let gpuProgram = null;
    let gpuUniforms = null;
    let gpuInitFailed = false;
    // Double-buffered: writing into a texture the GPU may still be reading
    // from the previous frame's draw call forces the driver to stall the CPU
    // until that read finishes (a classic single-buffered-streaming-texture
    // antipattern) -- alternating between two textures per channel each frame
    // lets the CPU write into the "other" one while the GPU finishes with the
    // one it just sampled, avoiding the stall entirely.
    let geomTextures = null;
    let coefTextures = null;
    let texBufferIndex = 0;

    // Allocates the texture's full MODE_TEX_W x MODE_TEX_H storage ONCE (a
    // no-op-sized initial upload) so later frames can use texSubImage2D to
    // update only the rows actually in use, instead of re-uploading all 4096
    // texels every frame regardless of how many modes are active.
    function makeModeTexture(){
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, MODE_TEX_W, MODE_TEX_H, 0, gl.RGBA, gl.FLOAT, null);
      return tex;
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
        const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if(!gl.getProgramParameter(prog, gl.LINK_STATUS)){
          throw new Error('Program link error: ' + gl.getProgramInfoLog(prog));
        }
        gpuProgram = prog;

        // full-screen quad (two triangles), in clip space
        const quad = new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
        const aPos = gl.getAttribLocation(prog, 'aPos');
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

        geomTextures = [makeModeTexture(), makeModeTexture()];
        coefTextures = [makeModeTexture(), makeModeTexture()];

        gpuUniforms = {
          uCanvasSize: gl.getUniformLocation(prog, 'uCanvasSize'),
          uFieldOrigin: gl.getUniformLocation(prog, 'uFieldOrigin'),
          uFieldSize: gl.getUniformLocation(prog, 'uFieldSize'),
          uRoomSize: gl.getUniformLocation(prog, 'uRoomSize'),
          uListenerZ: gl.getUniformLocation(prog, 'uListenerZ'),
          uDbMin: gl.getUniformLocation(prog, 'uDbMin'),
          uDbMax: gl.getUniformLocation(prog, 'uDbMax'),
          uCount: gl.getUniformLocation(prog, 'uCount'),
          uDebugMode: gl.getUniformLocation(prog, 'uDebugMode'),
          uColormapId: gl.getUniformLocation(prog, 'uColormapId'),
          uModeGeomTex: gl.getUniformLocation(prog, 'uModeGeomTex'),
          uModeCoefTex: gl.getUniformLocation(prog, 'uModeCoefTex'),
          uModeTexSize: gl.getUniformLocation(prog, 'uModeTexSize')
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
        gl.useProgram(gpuProgram);

        const { geom, coef, count, totalWanted } = flattenModes(precomputed);
        if(onTruncationWarning){
          if(totalWanted > MAX_MODES){
            const msg = `GPU rendering is truncating modes: ${totalWanted} modes needed but only ${MAX_MODES} fit. Some modes' contributions are being dropped from the field. Try switching to CPU rendering.`;
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
        gl.uniform1f(gpuUniforms.uListenerZ, pz);
        gl.uniform1f(gpuUniforms.uDbMin, params.dbMin ?? -24);
        gl.uniform1f(gpuUniforms.uDbMax, params.dbMax ?? 12);
        gl.uniform1i(gpuUniforms.uCount, count);
        gl.uniform1i(gpuUniforms.uDebugMode, debugMode ? 1 : 0);
        gl.uniform1i(gpuUniforms.uColormapId, COLORMAP_ID_TO_INT[params.colormapId] ?? 0);
        gl.uniform2f(gpuUniforms.uModeTexSize, MODE_TEX_W, MODE_TEX_H);

        const { geomBuf, coefBuf, rows } = packModeTextures({ geom, coef, count });

        // texSubImage2D, not texImage2D: only re-uploads the rows actually
        // holding mode data (typically a handful of rows for a couple hundred
        // modes) instead of the full MODE_TEX_W*MODE_TEX_H=4096 texels every
        // frame -- storage was already allocated once in makeModeTexture.
        // Alternates between the two buffered textures per channel (see the
        // double-buffering comment above) to avoid a CPU-GPU sync stall.
        texBufferIndex = 1 - texBufferIndex;
        const geomTexture = geomTextures[texBufferIndex];
        const coefTexture = coefTextures[texBufferIndex];

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, geomTexture);
        if(rows > 0) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MODE_TEX_W, rows, gl.RGBA, gl.FLOAT, geomBuf);
        gl.uniform1i(gpuUniforms.uModeGeomTex, 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, coefTexture);
        if(rows > 0) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MODE_TEX_W, rows, gl.RGBA, gl.FLOAT, coefBuf);
        gl.uniform1i(gpuUniforms.uModeCoefTex, 1);

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

    return {
      renderFieldCPU,
      renderFieldGPU,
      initGPUProgram,
      get gpuInitFailed(){ return gpuInitFailed; },
      get gpuProgram(){ return gpuProgram; }
    };
  }

  return {
    MAX_MODES,
    MODE_TEX_W,
    MODE_TEX_H,
    VERTEX_SRC,
    FRAGMENT_SRC,
    colormap,
    COLORMAPS,
    decodeFloatFromRGBA,
    flattenModes,
    packModeTextures,
    compileShader,
    createRenderer
  };
});
