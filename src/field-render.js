// Field rendering: turns a precomputed image-source list into pixels, on
// either the CPU (canvas2d) or GPU (WebGL) path. No DOM lookups of its own —
// every canvas/context/callback this module touches is passed in explicitly
// by the caller via createRenderer(), so it has no knowledge of the app's
// UI/element IDs and could be reused (or tested) outside this specific page.
//
// The GLSL fragment shader mirrors computeFieldAtPoint from room-physics.js
// (see the shader's own comments) — image-source *generation* stays in that
// one JS implementation; this module's GPU path only does the final per-pixel
// summation over an already-computed source list, which is the part that
// actually benefits from GPU parallelism.

(function(root, factory){
  const mod = factory();
  if(typeof module !== 'undefined' && module.exports){
    module.exports = mod; // Node / CommonJS (test harness)
  } else {
    root.FieldRenderer = mod; // browser global
  }
})(typeof self !== 'undefined' ? self : this, function(){

  const MAX_IMAGE_SOURCES = 320; // headroom for up to 8 sources @ order 2 (8*37=296); see flattenImageSources for what happens if this is ever exceeded

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
    uniform float uK;           // wavenumber 2*pi/lambda
    uniform float uDbMin;
    uniform float uDbMax;
    uniform int uCount;         // number of valid entries in the arrays below
    uniform bool uDebugMode;    // true: encode raw dB into RGBA instead of colormap (for CPU/GPU verification)

    uniform vec3 uImgPos[${MAX_IMAGE_SOURCES}];  // x,y,z in feet
    uniform float uImgAmp[${MAX_IMAGE_SOURCES}]; // amp/r scale already includes src.amp * levelGain
    uniform float uImgPhase[${MAX_IMAGE_SOURCES}]; // extraPhase (per-source delay term)

    const float FT_TO_M = 0.3048;

    vec3 colormap(float t){
      t = clamp(t, 0.0, 1.0);
      vec3 c0 = vec3(11.0,14.0,18.0)/255.0;
      vec3 c1 = vec3(24.0,64.0,110.0)/255.0;
      vec3 c2 = vec3(40.0,150.0,150.0)/255.0;
      vec3 c3 = vec3(230.0,200.0,60.0)/255.0;
      vec3 c4 = vec3(230.0,80.0,50.0)/255.0;
      if(t < 0.25) return mix(c0, c1, t/0.25);
      if(t < 0.50) return mix(c1, c2, (t-0.25)/0.25);
      if(t < 0.75) return mix(c2, c3, (t-0.50)/0.25);
      return mix(c3, c4, (t-0.75)/0.25);
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

      float re = 0.0;
      float im = 0.0;
      for(int i = 0; i < ${MAX_IMAGE_SOURCES}; i++){
        if(i >= uCount) break;
        vec3 src = uImgPos[i];
        float dx = (px - src.x) * FT_TO_M;
        float dy = (py - src.y) * FT_TO_M;
        float dz = (uListenerZ - src.z) * FT_TO_M;
        float r = sqrt(dx*dx + dy*dy + dz*dz);
        r = max(r, 0.3);
        float amp = uImgAmp[i] / r;
        float phase = uK * r + uImgPhase[i];
        re += amp * cos(phase);
        im += amp * sin(phase);
      }
      float mag = sqrt(re*re + im*im);
      float db = 20.0 * log(max(mag, 1e-6)) / log(10.0);

      if(uDebugMode){
        // Encode db (clamped to a wide, known range) as a normalized [0,1] value
        // so it survives 8-bit RGBA readback, then decoded back to dB in JS.
        const float DEBUG_DB_MIN = -100.0;
        const float DEBUG_DB_MAX = 40.0;
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
  function colormap(t){
    const stops = [[0.00,[11,14,18]],[0.25,[24,64,110]],[0.50,[40,150,150]],[0.75,[230,200,60]],[1.00,[230,80,50]]];
    for(let i=0;i<stops.length-1;i++){
      const [t0,c0]=stops[i], [t1,c1]=stops[i+1];
      if(t>=t0 && t<=t1){
        const f=(t-t0)/(t1-t0);
        return [Math.round(c0[0]+(c1[0]-c0[0])*f), Math.round(c0[1]+(c1[1]-c0[1])*f), Math.round(c0[2]+(c1[2]-c0[2])*f)];
      }
    }
    return [230,80,50];
  }

  // Inverse of the shader's encodeFloat: reconstruct the normalized [0,1] value
  // from 8-bit RGBA channels (dividing by 255 since readPixels gives 0-255 ints).
  function decodeFloatFromRGBA(r, g, b, a){
    return (r/255.0) + (g/255.0)/255.0 + (b/255.0)/65025.0 + (a/255.0)/16581375.0;
  }

  // Flattens a CPU-computed image-source list (already accounting for
  // panels/opening/reflectivity/order -- see room-physics.js's
  // precomputeSourceImages) into flat typed arrays for shader upload. This is
  // the ONLY bridge between the two paths: everything upstream of this
  // (image-source generation) is shared, single-implementation logic;
  // everything downstream (the per-pixel sum) is GPU-parallel.
  function flattenImageSources(precomputed){
    const positions = new Float32Array(MAX_IMAGE_SOURCES * 3);
    const amps = new Float32Array(MAX_IMAGE_SOURCES);
    const phases = new Float32Array(MAX_IMAGE_SOURCES);
    let count = 0;
    let totalWanted = 0; // true total across all sources, even past the cap -- lets callers detect truncation
    for(const pre of precomputed){
      if(!pre) continue;
      for(const src of pre.imgSources){
        totalWanted++;
        if(count >= MAX_IMAGE_SOURCES) continue; // keep counting totalWanted, but stop writing
        positions[count*3] = src.x;
        positions[count*3+1] = src.y;
        positions[count*3+2] = src.z;
        amps[count] = src.amp * pre.levelGain;
        phases[count] = pre.extraPhase;
        count++;
      }
    }
    return { positions, amps, phases, count, totalWanted };
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
  // called with a warning string when the GPU path had to drop image sources
  // past MAX_IMAGE_SOURCES, or with null to clear a previous warning; the
  // caller decides how (or whether) to surface that in its own UI.
  function createRenderer({ ctx2d, gl, canvasGL, onTruncationWarning }){
    let gpuProgram = null;
    let gpuUniforms = null;
    let gpuInitFailed = false;

    function initGPUProgram(){
      if(gpuProgram || gpuInitFailed || !gl) return;
      try {
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

        gpuUniforms = {
          uCanvasSize: gl.getUniformLocation(prog, 'uCanvasSize'),
          uFieldOrigin: gl.getUniformLocation(prog, 'uFieldOrigin'),
          uFieldSize: gl.getUniformLocation(prog, 'uFieldSize'),
          uRoomSize: gl.getUniformLocation(prog, 'uRoomSize'),
          uListenerZ: gl.getUniformLocation(prog, 'uListenerZ'),
          uK: gl.getUniformLocation(prog, 'uK'),
          uDbMin: gl.getUniformLocation(prog, 'uDbMin'),
          uDbMax: gl.getUniformLocation(prog, 'uDbMax'),
          uCount: gl.getUniformLocation(prog, 'uCount'),
          uDebugMode: gl.getUniformLocation(prog, 'uDebugMode'),
          uImgPos: gl.getUniformLocation(prog, 'uImgPos'),
          uImgAmp: gl.getUniformLocation(prog, 'uImgAmp'),
          uImgPhase: gl.getUniformLocation(prog, 'uImgPhase')
        };
      } catch(e){
        console.error('GPU shader init failed, falling back to CPU:', e);
        gpuInitFailed = true;
      }
    }

    // params: { RES, w, d, k, precomputed, pz, offX, offY, scale, size, dbMin, dbMax }
    function renderFieldCPU(params){
      const { RES, w, d, k, precomputed, pz, offX, offY, scale, size } = params;
      const DB_MIN = params.dbMin ?? -24, DB_MAX = params.dbMax ?? 12;
      const field = new Float32Array(RES*RES);
      const refAmp = 1.0;
      for(let j=0;j<RES;j++){
        const py = (j/(RES-1)) * d;
        for(let i=0;i<RES;i++){
          const px = (i/(RES-1)) * w;
          const { re, im } = RoomPhysics.computeFieldAtPoint(px, py, pz, precomputed, k);
          const mag = Math.sqrt(re*re+im*im);
          field[j*RES+i] = 20 * Math.log10(Math.max(mag, 1e-6) / refAmp);
        }
      }

      const imgData = ctx2d.createImageData(RES, RES);
      for(let idx=0; idx<RES*RES; idx++){
        const t = Math.max(0, Math.min(1, (field[idx] - DB_MIN) / (DB_MAX - DB_MIN)));
        const c = colormap(t);
        imgData.data[idx*4] = c[0]; imgData.data[idx*4+1] = c[1]; imgData.data[idx*4+2] = c[2]; imgData.data[idx*4+3] = 255;
      }
      const off = document.createElement('canvas');
      off.width = RES; off.height = RES;
      off.getContext('2d').putImageData(imgData, 0, 0);

      // CPU path owns the field canvas: opaque background fill, then the field.
      ctx2d.fillStyle = '#0b0e12';
      ctx2d.fillRect(0,0,size,size);
      ctx2d.imageSmoothingEnabled = true;
      ctx2d.drawImage(off, 0, 0, RES, RES, offX, offY, w*scale, d*scale);
    }

    // Real GPU field render: uploads the flattened image-source list as uniforms
    // and draws a full-screen quad, letting the fragment shader compute pressure
    // per-pixel in parallel. Falls back to CPU if shader init fails for any reason.
    function renderFieldGPU(params, debugMode){
      if(!gl){ renderFieldCPU(params); return; }
      initGPUProgram();
      if(gpuInitFailed || !gpuProgram){ renderFieldCPU(params); return; }

      try {
        const { w, d, k, precomputed, pz, offX, offY, scale, size } = params;

        if(canvasGL.width !== size || canvasGL.height !== size){
          canvasGL.width = size;
          canvasGL.height = size;
        }
        gl.viewport(0, 0, canvasGL.width, canvasGL.height);
        gl.useProgram(gpuProgram);

        const { positions, amps, phases, count, totalWanted } = flattenImageSources(precomputed);
        if(onTruncationWarning){
          if(totalWanted > MAX_IMAGE_SOURCES){
            const msg = `GPU rendering is truncating reflections: ${totalWanted} image sources needed but only ${MAX_IMAGE_SOURCES} fit. Some sources' contributions are being dropped from the field. Try reducing reflection order, source count, or switch to CPU rendering.`;
            console.warn(msg);
            onTruncationWarning(msg);
          } else {
            onTruncationWarning(null);
          }
        }

        gl.uniform2f(gpuUniforms.uCanvasSize, size, size);
        gl.uniform2f(gpuUniforms.uFieldOrigin, offX, offY);
        gl.uniform2f(gpuUniforms.uFieldSize, w*scale, d*scale);
        gl.uniform2f(gpuUniforms.uRoomSize, w, d);
        gl.uniform1f(gpuUniforms.uListenerZ, pz);
        gl.uniform1f(gpuUniforms.uK, k);
        gl.uniform1f(gpuUniforms.uDbMin, params.dbMin ?? -24);
        gl.uniform1f(gpuUniforms.uDbMax, params.dbMax ?? 12);
        gl.uniform1i(gpuUniforms.uCount, count);
        gl.uniform1i(gpuUniforms.uDebugMode, debugMode ? 1 : 0);
        gl.uniform3fv(gpuUniforms.uImgPos, positions);
        gl.uniform1fv(gpuUniforms.uImgAmp, amps);
        gl.uniform1fv(gpuUniforms.uImgPhase, phases);

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
          ctx2d.clearRect(0, 0, size, size);
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
    MAX_IMAGE_SOURCES,
    VERTEX_SRC,
    FRAGMENT_SRC,
    colormap,
    decodeFloatFromRGBA,
    flattenImageSources,
    compileShader,
    createRenderer
  };
});
