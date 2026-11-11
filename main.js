// Video Inpainting — project page interactions
(function () {
  "use strict";

  /* ===============================================================
   * MEDIA CONFIG — single source of truth.
   *
   * The hero is one inpainted video, media/<id>.mp4, with a poster at
   * media/posters/<id>.jpg (scripts/prepare_media.sh). `out` is its
   * frame size and `box` the masked region, as [x, y, w, h] fractions
   * of the frame. Everything outside the box passes through the
   * inpainter untouched, so covering the box with the generating
   * overlay shows exactly what the model was given: the "Input" view.
   *
   * Examples are packed videos, [source | output | mask] side by side,
   * with a packed poster (scripts/prepare_example.sh); `out` is the size
   * of one panel. `placeholder: true` stands in until media lands.
   * =============================================================== */
  var CLIPS = {
    vivaldi: { title: "Concert hall", out: [1920, 1080], box: [0.041667, 0.333333, 0.916667, 0.388889] },
    // TODO: replace placeholders with packed examples
    ph_remove_person: { title: "Remove a passerby", out: [1920, 1080], placeholder: true, note: "Placeholder: a person walking through the back of the shot, removed." },
    ph_remove_mic:    { title: "Remove a mic",      out: [1080, 1920], placeholder: true, note: "Placeholder: a handheld mic removed from a vertical interview." },
    ph_remove_logo:   { title: "Remove a logo",     out: [1920, 1080], placeholder: true, note: "Placeholder: a logo on a shirt, tracked and removed." },
    ph_remove_object: { title: "Clear the desk",    out: [1920, 1080], placeholder: true, note: "Placeholder: clutter cleared from a desk behind the speaker." }
  };

  var MEDIA = {
    hero: "vivaldi",
    examples: ["ph_remove_person", "ph_remove_mic", "ph_remove_logo", "ph_remove_object"]
  };

  // Videos come from the GCS bucket once deployed; locally, from media/.
  var MEDIA_BASE = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? ""
    : "https://storage.googleapis.com/lyrebird-research-web-demos/video-inpainting/";
  function videoUrl(id) { return MEDIA_BASE ? MEDIA_BASE + id + ".mp4" : "media/" + id + ".mp4"; }
  function posterUrl(id) { return "media/posters/" + id + ".jpg"; }

  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var PLAY_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
  var ICON_VOL_ON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4.03v8.05A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z"/></svg>';
  var ICON_VOL_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm18.29-.71L19.88 6.88 17 9.76l-2.88-2.88-1.41 1.41L15.59 11l-2.88 2.88 1.41 1.41L17 12.41l2.88 2.88 1.41-1.41L18.41 11l2.88-2.71z"/></svg>';
  var ICON_FS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';

  /* ---------------------------------------------------------------
   * "Input" overlay: the editor's generating look, ported from
   * OutpaintShaderOverlay and turned inside out. The masked region is
   * flickering grain tinted by the footage just past its edges, with
   * particles drifting inward from them. Switching to "Inpainted"
   * dissolves it from the edges inward.
   * ------------------------------------------------------------- */
  var COLOR_SAMPLE_SIZE = 96;
  var COLOR_SAMPLE_MS = 100;
  /** Time constant the displayed colors ease toward each new sample with, so playback doesn't jump. */
  var COLOR_SMOOTH_MS = 250;
  var COLOR_FADE_MS = 180;
  var FALLBACK_COLOR = 100;
  var MAX_PARTICLES = 1400;
  var MIN_PARTICLES = 60;
  var PARTICLE_STRIDE = 7;
  var IDLE_FRAME_MS = 1000 / 30 - 2;
  var REVEAL_MS = 900;
  var HIDE_MS = 450;
  var INTRO_DELAY_MS = 1100;
  /** How long an autoplaying clip's reveal waits for playback before going ahead anyway. */
  var AUTOPLAY_WAIT_MS = 3000;

  var QUAD_VS = [
    "attribute vec2 a_position;",
    "varying vec2 v_uv;",
    "void main() {",
    "  v_uv = vec2(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);",
    "  gl_Position = vec4(a_position, 0.0, 1.0);",
    "}"
  ].join("\n");

  var NOISE_FS = [
    "precision highp float;",
    "varying vec2 v_uv;",
    "uniform vec2 u_size;",
    "uniform float u_scale;",
    "uniform vec4 u_box;",
    "uniform float u_time;",
    "uniform sampler2D u_colors;",
    "uniform float u_colorMix;",
    "uniform float u_reveal;",
    "uniform vec4 u_sides;",
    "float hash(vec3 p) {",
    "  p = fract(p * vec3(0.1031, 0.1030, 0.0973));",
    "  p += dot(p, p.yxz + 33.33);",
    "  return fract((p.x + p.y) * p.z);",
    "}",
    "float field(vec2 px, float seed, float rate) {",
    "  float phase = hash(vec3(px, seed + 101.0));",
    "  float epoch = floor(u_time * rate + phase);",
    "  return hash(vec3(px, seed + epoch * 7.13));",
    "}",
    "void main() {",
    "  vec2 p = v_uv * u_size;",
    "  vec2 b0 = u_box.xy * u_size;",
    "  vec2 b1 = (u_box.xy + u_box.zw) * u_size;",
    "  if (any(lessThan(p, b0)) || any(greaterThan(p, b1))) discard;",
    "  vec2 px = floor(p * u_scale);",
    // distance to the nearest mask edge that borders real footage, and the footage just past it
    "  vec2 d0 = p - b0;",
    "  vec2 d1 = b1 - p;",
    "  float dist = 1e6;",
    "  vec2 edge = p;",
    "  if (u_sides.x > 0.5 && d0.x < dist) { dist = d0.x; edge = vec2(b0.x - 12.0, p.y); }",
    "  if (u_sides.y > 0.5 && d1.x < dist) { dist = d1.x; edge = vec2(b1.x + 12.0, p.y); }",
    "  if (u_sides.z > 0.5 && d0.y < dist) { dist = d0.y; edge = vec2(p.x, b0.y - 12.0); }",
    "  if (u_sides.w > 0.5 && d1.y < dist) { dist = d1.y; edge = vec2(p.x, b1.y + 12.0); }",
    "  float extent = 0.5 * min(b1.x - b0.x, b1.y - b0.y);",
    // dissolve order: mostly random, biased so pixels nearest the footage resolve first
    "  float order = 0.6 * hash(vec3(px, 7.0)) + 0.4 * clamp(dist / max(extent, 1.0), 0.0, 1.0);",
    "  if (order < u_reveal) discard;",
    "  float random = field(px, 1.0, 3.0);",
    "  float tintRandom = field(px, 2.0, 1.2);",
    "  float grain = field(px, 3.0, 0.24);",
    "  if (random > 0.5 + 0.36 * exp(-dist / 90.0)) {",
    "    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);",
    "    return;",
    "  }",
    "  vec3 color;",
    "  if (tintRandom < exp(-dist / 72.0)) {",
    "    vec3 sampled = texture2D(u_colors, clamp(edge / u_size, 0.0, 1.0)).rgb;",
    "    sampled = mix(vec3(" + (FALLBACK_COLOR / 255).toFixed(4) + "), sampled, u_colorMix);",
    "    color = sampled * (0.7 + grain * 0.55);",
    "  } else {",
    "    float grey = grain < 0.82 ? random * 48.0 : 165.0 + random * 60.0;",
    "    color = vec3(grey / 255.0);",
    "  }",
    "  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);",
    "}"
  ].join("\n");

  var PARTICLE_VS = [
    "attribute vec2 a_position;",
    "attribute vec4 a_color;",
    "attribute float a_size;",
    "uniform vec2 u_size;",
    "uniform float u_dpr;",
    "varying vec4 v_color;",
    "varying vec2 v_uv;",
    "void main() {",
    "  v_uv = a_position / u_size;",
    "  gl_Position = vec4(v_uv.x * 2.0 - 1.0, 1.0 - v_uv.y * 2.0, 0.0, 1.0);",
    "  gl_PointSize = max(1.0, a_size * u_dpr);",
    "  v_color = a_color;",
    "}"
  ].join("\n");

  var PARTICLE_FS = [
    "precision mediump float;",
    "varying vec4 v_color;",
    "varying vec2 v_uv;",
    "uniform vec4 u_box;",
    "uniform float u_colorMix;",
    "uniform float u_reveal;",
    "void main() {",
    "  vec2 media = (v_uv - u_box.xy) / u_box.zw;",
    "  if (any(lessThan(media, vec2(0.0))) || any(greaterThan(media, vec2(1.0)))) discard;",
    "  vec3 color = mix(vec3(" + (FALLBACK_COLOR / 255).toFixed(4) + "), v_color.rgb, u_colorMix);",
    "  float a = v_color.a * (1.0 - u_reveal);",
    "  gl_FragColor = vec4(color * a, a);",
    "}"
  ].join("\n");

  function compileProgram(gl, vs, fs) {
    function shader(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    var p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  function createNoiseOverlay(tile, video, before) {
    var canvas = document.createElement("canvas");
    canvas.className = "op-noise";
    canvas.setAttribute("aria-hidden", "true");
    tile.insertBefore(canvas, before);
    var attrs = { alpha: true, premultipliedAlpha: true, antialias: false };
    var gl = canvas.getContext("webgl", attrs);
    if (!gl) return null;
    var noiseProgram, particleProgram;
    try {
      noiseProgram = compileProgram(gl, QUAD_VS, NOISE_FS);
      particleProgram = compileProgram(gl, PARTICLE_VS, PARTICLE_FS);
    } catch (e) {
      return null;
    }
    function locations(program, names) {
      var out = {};
      names.forEach(function (n) {
        out[n] = n.charAt(0) === "a" ? gl.getAttribLocation(program, n) : gl.getUniformLocation(program, n);
      });
      return out;
    }
    var nl = locations(noiseProgram, ["a_position", "u_size", "u_scale", "u_box", "u_time", "u_colors", "u_colorMix", "u_reveal", "u_sides"]);
    var pl = locations(particleProgram, ["a_position", "a_color", "a_size", "u_size", "u_dpr", "u_box", "u_colorMix", "u_reveal"]);

    var quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var particleBuffer = gl.createBuffer();
    var particleData = new Float32Array(MAX_PARTICLES * PARTICLE_STRIDE);

    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([FALLBACK_COLOR, FALLBACK_COLOR, FALLBACK_COLOR, 255]));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    var sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = sampleCanvas.height = COLOR_SAMPLE_SIZE;
    var sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
    var posterImg = new Image();

    var box = [0, 0, 1, 1];
    var colorCount = COLOR_SAMPLE_SIZE * COLOR_SAMPLE_SIZE * 4;
    var target = null, smooth = new Float32Array(colorCount), colors = null;
    var colorFadeStart = 0, lastSample = -Infinity, lastSmooth = 0;
    var reveal = 1, revealFrom = 1, revealTo = 1, revealStart = 0, revealDur = 1;
    var particles = [], lastTime = 0, lastDraw = 0;
    var frameId = 0, visible = true;
    var cssW = 1, cssH = 1, dpr = 1, scale = 1;

    function resize() {
      var r = tile.getBoundingClientRect();
      cssW = Math.max(1, r.width);
      cssH = Math.max(1, r.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      scale = Math.min(dpr, Math.sqrt(650000 / (cssW * cssH)));
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      particles.length = 0;
    }

    // The whole frame is sampled, but only texels just outside the mask are ever read: footage, not the fill.
    function sampleColors(now) {
      if (now - lastSample < COLOR_SAMPLE_MS) return;
      var src = null, sw = 0, sh = 0;
      // before playback the decoded frame is often the clip's black first frame; the poster isn't
      var started = !video.paused || video.currentTime > 0;
      if (started && video.readyState >= 2 && video.videoWidth) { src = video; sw = video.videoWidth; sh = video.videoHeight; }
      else if (posterImg.complete && posterImg.naturalWidth) { src = posterImg; sw = posterImg.naturalWidth; sh = posterImg.naturalHeight; }
      if (!src) return;
      lastSample = now;
      try {
        sampleCtx.drawImage(src, 0, 0, sw, sh, 0, 0, COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE);
        target = sampleCtx.getImageData(0, 0, COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE).data;
      } catch (e) { /* cross-origin frame without CORS: keep the grey fallback */ }
    }

    // Ease the displayed colors toward the latest sample; the first sample of a clip lands as is.
    function smoothColors(now) {
      if (!target) return;
      var first = !colors;
      if (first) colors = new Uint8Array(colorCount);
      var k = first ? 1 : 1 - Math.exp(-(now - lastSmooth) / COLOR_SMOOTH_MS);
      lastSmooth = now;
      if (k <= 0) return;
      for (var i = 0; i < colorCount; i++) {
        smooth[i] += (target[i] - smooth[i]) * k;
        colors[i] = smooth[i];
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, colors);
      if (first) colorFadeStart = now;
    }

    function colorAt(u, v) {
      if (!colors) return [FALLBACK_COLOR / 255, FALLBACK_COLOR / 255, FALLBACK_COLOR / 255];
      var max = COLOR_SAMPLE_SIZE - 1;
      var i = (Math.round(Math.min(1, Math.max(0, v)) * max) * COLOR_SAMPLE_SIZE + Math.round(Math.min(1, Math.max(0, u)) * max)) * 4;
      return [colors[i] / 255, colors[i + 1] / 255, colors[i + 2] / 255];
    }

    function activeSides() {
      var s = [];
      if (box[0] > 0.001) s.push(0);
      if (box[0] + box[2] < 0.999) s.push(1);
      if (box[1] > 0.001) s.push(2);
      if (box[1] + box[3] < 0.999) s.push(3);
      return s;
    }

    // Particles drift into the mask from its edges, in the color of the footage just outside them.
    function spawn(sides) {
      var side = sides[Math.floor(Math.random() * sides.length)];
      var along = Math.random();
      var u = side === 0 ? 0 : side === 1 ? 1 : along;
      var v = side === 2 ? 0 : side === 3 ? 1 : along;
      var fx = box[0] + u * box[2];
      var fy = box[1] + v * box[3];
      var speed = 14 + Math.random() * 44;
      var duration = 1.2 + Math.random() * 2.4;
      return {
        x: fx * cssW,
        y: fy * cssH,
        vx: side === 0 ? speed : side === 1 ? -speed : 0,
        vy: side === 2 ? speed : side === 3 ? -speed : 0,
        life: duration, duration: duration,
        size: 1.2 + Math.random() * 1.8,
        color: colorAt(
          fx + (side === 0 ? -0.01 : side === 1 ? 0.01 : 0),
          fy + (side === 2 ? -0.02 : side === 3 ? 0.02 : 0)
        )
      };
    }

    function updateParticles(now) {
      var sides = activeSides();
      if (!sides.length) return 0;
      var dt = Math.min(0.05, (now - lastTime) / 1000 || 0.016);
      lastTime = now;
      var masked = cssW * cssH * box[2] * box[3];
      var count = Math.min(MAX_PARTICLES, Math.max(MIN_PARTICLES, Math.round(masked / 220)));
      particles.length = Math.min(particles.length, count);
      while (particles.length < count) {
        var fresh = spawn(sides);
        var age = Math.random() * fresh.duration;
        fresh.x += fresh.vx * age;
        fresh.y += fresh.vy * age;
        fresh.life -= age;
        particles.push(fresh);
      }
      for (var i = 0; i < particles.length; i++) {
        var pt = particles[i];
        pt.life -= dt;
        if (pt.life <= 0) pt = particles[i] = spawn(sides);
        pt.x += pt.vx * dt;
        pt.y += pt.vy * dt;
        var o = i * PARTICLE_STRIDE;
        particleData[o] = pt.x;
        particleData[o + 1] = pt.y;
        particleData[o + 2] = pt.color[0];
        particleData[o + 3] = pt.color[1];
        particleData[o + 4] = pt.color[2];
        particleData[o + 5] = Math.min(1, (pt.life / pt.duration) * 1.6) * 0.95;
        particleData[o + 6] = pt.size;
      }
      return particles.length;
    }

    function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

    function draw() {
      frameId = 0;
      var now = performance.now();
      var animating = reveal !== revealTo;
      if (animating) {
        var t = Math.min(1, (now - revealStart) / revealDur);
        reveal = revealFrom + (revealTo - revealFrom) * easeOut(t);
        if (t >= 1) reveal = revealTo;
      }
      if (reveal >= 1 && revealTo >= 1) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return;
      }
      schedule();
      var fading = colorFadeStart && now - colorFadeStart < COLOR_FADE_MS;
      if (!animating && !fading && now - lastDraw < IDLE_FRAME_MS) return;
      lastDraw = now;
      sampleColors(now);
      smoothColors(now);
      var colorMix = colorFadeStart ? Math.min(1, (now - colorFadeStart) / COLOR_FADE_MS) : 0;

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(noiseProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      if (pl.a_color >= 0) gl.disableVertexAttribArray(pl.a_color);
      if (pl.a_size >= 0) gl.disableVertexAttribArray(pl.a_size);
      gl.enableVertexAttribArray(nl.a_position);
      gl.vertexAttribPointer(nl.a_position, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(nl.u_colors, 0);
      gl.uniform2f(nl.u_size, cssW, cssH);
      gl.uniform1f(nl.u_scale, scale);
      gl.uniform4f(nl.u_box, box[0], box[1], box[2], box[3]);
      gl.uniform1f(nl.u_time, (now % 1e6) / 1000);
      gl.uniform1f(nl.u_colorMix, colorMix);
      gl.uniform1f(nl.u_reveal, reveal * 1.001);
      var sides = activeSides();
      gl.uniform4f(nl.u_sides, sides.indexOf(0) >= 0 ? 1 : 0, sides.indexOf(1) >= 0 ? 1 : 0,
        sides.indexOf(2) >= 0 ? 1 : 0, sides.indexOf(3) >= 0 ? 1 : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      var count = updateParticles(now);
      if (!count) return;
      gl.useProgram(particleProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, particleBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, particleData.subarray(0, count * PARTICLE_STRIDE), gl.DYNAMIC_DRAW);
      var stride = PARTICLE_STRIDE * 4;
      gl.enableVertexAttribArray(pl.a_position);
      gl.vertexAttribPointer(pl.a_position, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(pl.a_color);
      gl.vertexAttribPointer(pl.a_color, 4, gl.FLOAT, false, stride, 8);
      gl.enableVertexAttribArray(pl.a_size);
      gl.vertexAttribPointer(pl.a_size, 1, gl.FLOAT, false, stride, 24);
      gl.uniform2f(pl.u_size, cssW, cssH);
      gl.uniform1f(pl.u_dpr, dpr);
      gl.uniform4f(pl.u_box, box[0], box[1], box[2], box[3]);
      gl.uniform1f(pl.u_colorMix, colorMix);
      gl.uniform1f(pl.u_reveal, reveal);
      gl.drawArrays(gl.POINTS, 0, count);
    }

    function schedule() {
      if (!frameId && visible) frameId = requestAnimationFrame(draw);
    }

    function animateTo(target, ms) {
      revealFrom = reveal;
      revealTo = target;
      revealStart = performance.now();
      revealDur = reduceMotion ? 1 : ms;
      schedule();
    }

    resize();
    if ("ResizeObserver" in window) new ResizeObserver(function () { resize(); schedule(); }).observe(tile);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible) schedule();
      }).observe(tile);
    }

    return {
      setClip: function (newBox, poster) {
        box = newBox;
        target = null;
        colors = null;
        colorFadeStart = 0;
        lastSample = -Infinity;
        particles.length = 0;
        posterImg.src = poster;
        schedule();
      },
      showNoise: function (instant) {
        if (instant) { reveal = revealFrom = revealTo = 0; schedule(); return; }
        animateTo(0, HIDE_MS);
      },
      reveal: function () { animateTo(1, REVEAL_MS); }
    };
  }

  /* ---------------------------------------------------------------
   * Player: one inpainted video, the "Input" overlay, play/scrub,
   * mute, fullscreen, and the Input / Inpainted toggle.
   * Returns { load(id) } so a gallery can swap clips into it.
   * ------------------------------------------------------------- */
  function buildPlayer(fig, opts) {
    opts = opts || {};
    var tile = document.createElement("div");
    tile.className = "video-tile op-canvas has-video";
    tile.innerHTML =
      '<video class="op-video" playsinline preload="metadata" crossorigin="anonymous"></video>' +
      '<button class="video-tile__play" type="button" aria-label="Play">' + PLAY_ICON + "</button>" +
      '<div class="scrubber"><div class="scrubber__track"><div class="scrubber__progress"></div></div></div>';
    fig.insertBefore(tile, fig.firstChild);

    var video = tile.querySelector("video");
    var progress = tile.querySelector(".scrubber__progress");
    var noise = createNoiseOverlay(tile, video, tile.querySelector(".video-tile__play"));
    var autoplay = !!opts.autoplay && !reduceMotion;
    if (opts.autoplay) {
      // Safari only autoplays when muted/playsinline are present as attributes, not just properties
      video.muted = true;
      video.setAttribute("muted", "");
      video.loop = true;
      video.autoplay = autoplay;
    }

    var bar = document.createElement("div");
    bar.className = "op-figure__bar";
    bar.innerHTML =
      '<div class="op-toggle" role="group" aria-label="Framing">' +
        '<button type="button" data-mode="original">Input</button>' +
        '<button type="button" data-mode="inpaint" class="is-active">Inpainted</button>' +
      "</div>";
    var caption = fig.querySelector(".op-figure__caption");
    fig.insertBefore(bar, caption ? caption.nextSibling : tile.nextSibling);
    if (!noise) bar.hidden = true;

    function setMode(original, instant) {
      if (!noise) return;
      if (original === tile.classList.contains("is-original") && !instant) return;
      bar.querySelectorAll("button").forEach(function (x) {
        x.classList.toggle("is-active", (x.getAttribute("data-mode") === "original") === original);
      });
      tile.classList.toggle("is-original", original);
      if (original) { noise.showNoise(instant); } else { noise.reveal(); }
    }
    bar.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        cancelIntro();
        setMode(b.getAttribute("data-mode") === "original");
      });
    });

    // Each clip opens in the generating state and reveals the outpaint once it's been on screen
    // for a beat; an autoplaying clip also waits until it's actually playing, unless autoplay is
    // blocked. Choosing a mode by hand cancels the pending reveal.
    var introPending = false, introTimer = 0, onScreen = false;
    var awaitingPlayback = false, playbackFallback = 0;
    function cancelIntro() {
      introPending = false;
      clearTimeout(introTimer);
    }
    function armIntro() {
      clearTimeout(introTimer);
      if (introPending && onScreen && !awaitingPlayback) {
        introTimer = setTimeout(function () { introPending = false; setMode(false); }, INTRO_DELAY_MS);
      }
    }
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        onScreen = entries[0].isIntersecting;
        if (onScreen) { armIntro(); } else { clearTimeout(introTimer); }
      }, { threshold: 0.6 }).observe(tile);
    } else {
      onScreen = true;
    }

    video.addEventListener("timeupdate", function () {
      if (video.duration) progress.style.left = (video.currentTime / video.duration) * 100 + "%";
    });
    video.addEventListener("play", function () {
      tile.classList.add("is-playing");
      document.querySelectorAll("video").forEach(function (v) { if (v !== video && !v.paused) v.pause(); });
    });
    video.addEventListener("playing", function () {
      if (!awaitingPlayback) return;
      awaitingPlayback = false;
      clearTimeout(playbackFallback);
      armIntro();
    });
    // autoplay can lose a race with the first data arriving; retry once there's something to play
    video.addEventListener("loadeddata", function () {
      if (autoplay && video.paused) video.play().catch(function () {});
    });
    video.addEventListener("pause", function () { tile.classList.remove("is-playing"); });
    video.addEventListener("ended", function () { tile.classList.remove("is-playing"); });
    tile.querySelector(".video-tile__play").addEventListener("click", function () {
      if (video.paused) { video.play().catch(function () {}); } else { video.pause(); }
    });
    tile.querySelector(".scrubber__track").addEventListener("click", function (e) {
      e.stopPropagation();
      if (!video.duration) return;
      var rect = e.currentTarget.getBoundingClientRect();
      video.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * video.duration;
    });
    addMuteToggle(tile, video);
    addFullscreenToggle(tile, video);

    function load(id) {
      var clip = CLIPS[id];
      var box = clip.box;
      tile.style.setProperty("--ar", clip.out[0] + "/" + clip.out[1]);
      tile.style.setProperty("--arn", String(clip.out[0] / clip.out[1]));
      progress.style.left = "0%";
      // swapping src pauses without firing "pause", so clear the playing state by hand
      tile.classList.remove("is-playing");
      video.poster = posterUrl(id);
      video.src = videoUrl(id);
      if (noise) noise.setClip(box, posterUrl(id));
      if (autoplay) video.play().catch(function () {});
      if (noise && !reduceMotion) {
        setMode(true, true);
        introPending = true;
        awaitingPlayback = autoplay;
        clearTimeout(playbackFallback);
        if (autoplay) {
          playbackFallback = setTimeout(function () { awaitingPlayback = false; armIntro(); }, AUTOPLAY_WAIT_MS);
        }
        armIntro();
      }
    }
    return { load: load };
  }

  function addMuteToggle(tile, video) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "video-tile__mute";
    tile.appendChild(btn);
    function render() {
      btn.innerHTML = video.muted ? ICON_VOL_OFF : ICON_VOL_ON;
      btn.classList.toggle("is-muted", video.muted);
      btn.setAttribute("aria-label", video.muted ? "Unmute" : "Mute");
    }
    render();
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      video.muted = !video.muted;
      render();
    });
  }

  function addFullscreenToggle(tile, video) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "video-tile__fs";
    btn.setAttribute("aria-label", "Fullscreen");
    btn.innerHTML = ICON_FS;
    tile.appendChild(btn);
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var doc = document;
      if (doc.fullscreenElement || doc.webkitFullscreenElement) {
        (doc.exitFullscreen || doc.webkitExitFullscreen || function () {}).call(doc);
      } else if (tile.requestFullscreen) { tile.requestFullscreen(); }
      else if (tile.webkitRequestFullscreen) { tile.webkitRequestFullscreen(); }
      else if (video.webkitEnterFullscreen) { video.webkitEnterFullscreen(); }
    });
  }

  /* ---------------------------------------------------------------
   * Example player: Original → Masked → Inpainted.
   *
   * Each example is one packed video, [source | output | mask] side by
   * side (scripts/prepare_example.sh), so the three stay frame-locked,
   * and its poster is a packed frame too. A WebGL pass draws the source
   * or the output and, while masked, covers the mask with the same
   * generating grain as the hero. Placeholder clips (no media yet) step
   * through the same three states with a CSS stand-in.
   * ------------------------------------------------------------- */
  var EXAMPLE_HOLD_MS = [1000, 1100];
  var UNMASK_MS = 450;
  var UNSWAP_MS = 350;

  var FRAME_FS = [
    "precision highp float;",
    "varying vec2 v_uv;",
    "uniform sampler2D u_frame;",
    "uniform sampler2D u_colors;",
    "uniform sampler2D u_maskLo;",
    "uniform vec2 u_size;",
    "uniform float u_scale;",
    "uniform float u_texel;",
    "uniform float u_time;",
    "uniform float u_srcMix;",
    "uniform float u_reveal;",
    "uniform float u_colorMix;",
    "float hash(vec3 p) {",
    "  p = fract(p * vec3(0.1031, 0.1030, 0.0973));",
    "  p += dot(p, p.yxz + 33.33);",
    "  return fract((p.x + p.y) * p.z);",
    "}",
    "float field(vec2 px, float seed, float rate) {",
    "  float phase = hash(vec3(px, seed + 101.0));",
    "  float epoch = floor(u_time * rate + phase);",
    "  return hash(vec3(px, seed + epoch * 7.13));",
    "}",
    // half-texel clamp keeps linear filtering from bleeding across panel seams
    "vec4 panel(float i, vec2 uv) {",
    "  float x = clamp(uv.x, u_texel, 1.0 - u_texel);",
    "  return texture2D(u_frame, vec2((x + i) / 3.0, uv.y));",
    "}",
    "void main() {",
    "  vec3 base = mix(panel(1.0, v_uv).rgb, panel(0.0, v_uv).rgb, u_srcMix);",
    "  if (panel(2.0, v_uv).r < 0.5) { gl_FragColor = vec4(base, 1.0); return; }",
    "  vec2 px = floor(v_uv * u_size * u_scale);",
    // depth into the mask from a blurred copy: 0 at its edge, 1 well inside
    "  float depth = clamp((texture2D(u_maskLo, v_uv).r - 0.5) * 2.0, 0.0, 1.0);",
    "  float order = 0.6 * hash(vec3(px, 7.0)) + 0.4 * depth;",
    "  if (order < u_reveal) { gl_FragColor = vec4(base, 1.0); return; }",
    "  float dist = depth * 60.0;",
    "  float random = field(px, 1.0, 3.0);",
    "  float tintRandom = field(px, 2.0, 1.2);",
    "  float grain = field(px, 3.0, 0.24);",
    "  if (random > 0.5 + 0.36 * exp(-dist / 90.0)) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }",
    "  vec3 color;",
    "  if (tintRandom < exp(-dist / 72.0)) {",
    "    vec3 sampled = mix(vec3(" + (FALLBACK_COLOR / 255).toFixed(4) + "), texture2D(u_colors, v_uv).rgb, u_colorMix);",
    "    color = sampled * (0.7 + grain * 0.55);",
    "  } else {",
    "    float grey = grain < 0.82 ? random * 48.0 : 165.0 + random * 60.0;",
    "    color = vec3(grey / 255.0);",
    "  }",
    "  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);",
    "}"
  ].join("\n");

  function createFrameRenderer(tile, video, posterImg) {
    var canvas = document.createElement("canvas");
    canvas.className = "ip-render";
    canvas.setAttribute("aria-hidden", "true");
    tile.insertBefore(canvas, tile.querySelector(".video-tile__play"));
    var gl = canvas.getContext("webgl", { alpha: false, antialias: false });
    if (!gl) return null;
    var program;
    try { program = compileProgram(gl, QUAD_VS, FRAME_FS); } catch (e) { return null; }
    var loc = {};
    ["a_position", "u_frame", "u_colors", "u_maskLo", "u_size", "u_scale", "u_texel", "u_time",
      "u_srcMix", "u_reveal", "u_colorMix"].forEach(function (n) {
      loc[n] = n.charAt(0) === "a" ? gl.getAttribLocation(program, n) : gl.getUniformLocation(program, n);
    });
    var quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    function makeTexture(unit) {
      var t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      return t;
    }
    var frameTex = makeTexture(0), colorTex = makeTexture(1), maskTex = makeTexture(2);

    // Low-res copies of the source panel (grain tint) and mask panel (depth), refreshed at 10 Hz.
    var colorCanvas = document.createElement("canvas");
    var maskCanvas = document.createElement("canvas");
    colorCanvas.width = colorCanvas.height = maskCanvas.width = maskCanvas.height = COLOR_SAMPLE_SIZE;
    var colorCtx = colorCanvas.getContext("2d", { willReadFrequently: true });
    var maskCtx = maskCanvas.getContext("2d");
    var colorCount = COLOR_SAMPLE_SIZE * COLOR_SAMPLE_SIZE * 4;
    var smooth = new Float32Array(colorCount), colors = null, target = null;
    var lastSample = -Infinity, lastSmooth = 0, colorFadeStart = 0;

    var srcMix = 1, reveal = 1, tweens = {};
    var frameId = 0, visible = true, lastDraw = 0, hasFrame = false;
    var cssW = 1, cssH = 1, scale = 1, texel = 0.001;

    function resize() {
      var r = tile.getBoundingClientRect();
      cssW = Math.max(1, r.width);
      cssH = Math.max(1, r.height);
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      scale = Math.min(dpr, Math.sqrt(650000 / (cssW * cssH)));
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }

    // Before playback the video's decoded frame is often its black first frame; the packed poster isn't.
    function frameSource() {
      var started = !video.paused || video.currentTime > 0;
      if (started && video.readyState >= 2 && video.videoWidth) return video;
      if (posterImg.complete && posterImg.naturalWidth) return posterImg;
      return null;
    }

    function sample(src, now) {
      if (now - lastSample < COLOR_SAMPLE_MS) return;
      lastSample = now;
      var w = (src.videoWidth || src.naturalWidth) / 3, h = src.videoHeight || src.naturalHeight;
      try {
        colorCtx.drawImage(src, 0, 0, w, h, 0, 0, COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE);
        target = colorCtx.getImageData(0, 0, COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE).data;
        maskCtx.filter = "blur(3px)";
        maskCtx.drawImage(src, 2 * w, 0, w, h, 0, 0, COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, maskTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
      } catch (e) { /* cross-origin frame without CORS */ }
    }

    function smoothColors(now) {
      if (!target) return;
      var first = !colors;
      if (first) colors = new Uint8Array(colorCount);
      var k = first ? 1 : 1 - Math.exp(-(now - lastSmooth) / COLOR_SMOOTH_MS);
      lastSmooth = now;
      for (var i = 0; i < colorCount; i++) {
        smooth[i] += (target[i] - smooth[i]) * k;
        colors[i] = smooth[i];
      }
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, colorTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, colors);
      if (first) colorFadeStart = now;
    }

    function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
    function stepTweens(now) {
      var any = false;
      ["srcMix", "reveal"].forEach(function (k) {
        var tw = tweens[k];
        if (!tw) return;
        var t = Math.min(1, (now - tw.start) / tw.dur);
        var v = tw.from + (tw.to - tw.from) * easeOut(t);
        if (k === "srcMix") srcMix = v; else reveal = v;
        if (t >= 1) { delete tweens[k]; if (tw.done) tw.done(); } else { any = true; }
      });
      return any;
    }

    function draw() {
      frameId = 0;
      var now = performance.now();
      var tweening = stepTweens(now);
      var src = frameSource();
      var playing = !video.paused && !video.ended;
      var noisy = reveal < 1;
      if (tweening || playing || noisy) schedule();
      if (!tweening && !playing && noisy && now - lastDraw < IDLE_FRAME_MS) return;
      lastDraw = now;
      if (!src) return;

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, frameTex);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      } catch (e) { return; }
      if (!hasFrame) { hasFrame = true; tile.classList.add("has-frame"); }
      texel = 0.5 / Math.max(1, (src.videoWidth || src.naturalWidth) / 3);
      sample(src, now);
      smoothColors(now);

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(loc.a_position);
      gl.vertexAttribPointer(loc.a_position, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1i(loc.u_frame, 0);
      gl.uniform1i(loc.u_colors, 1);
      gl.uniform1i(loc.u_maskLo, 2);
      gl.uniform2f(loc.u_size, cssW, cssH);
      gl.uniform1f(loc.u_scale, scale);
      gl.uniform1f(loc.u_texel, texel);
      gl.uniform1f(loc.u_time, (now % 1e6) / 1000);
      gl.uniform1f(loc.u_srcMix, srcMix);
      gl.uniform1f(loc.u_reveal, reveal * 1.001);
      gl.uniform1f(loc.u_colorMix, colorFadeStart ? Math.min(1, (now - colorFadeStart) / COLOR_FADE_MS) : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    function schedule() {
      if (!frameId && visible) frameId = requestAnimationFrame(draw);
    }

    function tween(key, to, ms, done) {
      var from = key === "srcMix" ? srcMix : reveal;
      if (reduceMotion || ms <= 0) {
        if (key === "srcMix") srcMix = to; else reveal = to;
        delete tweens[key];
        if (done) done();
      } else {
        tweens[key] = { from: from, to: to, start: performance.now(), dur: ms, done: done };
      }
      schedule();
    }

    resize();
    if ("ResizeObserver" in window) new ResizeObserver(function () { resize(); schedule(); }).observe(tile);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        if (visible) schedule();
      }).observe(tile);
    }
    ["play", "seeked", "loadeddata"].forEach(function (ev) { video.addEventListener(ev, schedule); });
    posterImg.addEventListener("load", schedule);

    return {
      reset: function () {
        tweens = {};
        srcMix = 1;
        reveal = 1;
        target = colors = null;
        colorFadeStart = 0;
        lastSample = -Infinity;
        hasFrame = false;
        tile.classList.remove("has-frame");
        schedule();
      },
      tween: tween
    };
  }

  function buildExamplePlayer(fig) {
    var tile = document.createElement("div");
    tile.className = "video-tile op-canvas has-video ip-canvas";
    tile.innerHTML =
      '<video class="ip-video" playsinline preload="metadata" crossorigin="anonymous"></video>' +
      '<div class="ip-ph" aria-hidden="true">' +
        '<span class="ip-ph__subject"><span class="ph-face"><span class="ph-face__head"></span><span class="ph-face__mouth"></span></span></span>' +
        '<span class="ip-ph__object"></span>' +
        '<span class="ip-ph__mask"></span>' +
        '<span class="ip-ph__label">Placeholder · media pending</span>' +
      "</div>" +
      '<button class="video-tile__play" type="button" aria-label="Play">' + PLAY_ICON + "</button>" +
      '<div class="scrubber"><div class="scrubber__track"><div class="scrubber__progress"></div></div></div>';
    fig.insertBefore(tile, fig.firstChild);

    var video = tile.querySelector("video");
    var progress = tile.querySelector(".scrubber__progress");
    var posterImg = new Image();
    var renderer = createFrameRenderer(tile, video, posterImg);
    if (!renderer) tile.classList.add("no-webgl");

    var MODES = ["original", "masked", "inpainted"];
    var bar = document.createElement("div");
    bar.className = "op-figure__bar";
    bar.innerHTML =
      '<div class="op-toggle" role="group" aria-label="View">' +
        '<button type="button" data-mode="original" class="is-active">Original</button>' +
        '<button type="button" data-mode="masked">Masked</button>' +
        '<button type="button" data-mode="inpainted">Inpainted</button>' +
      "</div>";
    fig.insertBefore(bar, tile.nextSibling);
    var note = document.createElement("p");
    note.className = "op-figure__note";
    fig.insertBefore(note, bar.nextSibling);

    var mode = "original", placeholder = false, steps = [];
    function clearSteps() { steps.forEach(clearTimeout); steps = []; }
    function later(fn, ms) { steps.push(setTimeout(fn, ms)); }

    function render(m) {
      mode = m;
      bar.querySelectorAll("button").forEach(function (b) {
        b.classList.toggle("is-active", b.getAttribute("data-mode") === m);
      });
      MODES.forEach(function (x) { tile.classList.toggle("ip-mode-" + x, x === m); });
    }

    // Transitions always pass through Masked, so the mask never just cuts between source and output.
    // Under full grain the two are identical outside the mask, so swapping them there is invisible.
    function setMode(m, instant) {
      if (m === mode && !instant) return;
      clearSteps();
      var from = mode;
      if (placeholder && m === "inpainted" && from === "original" && !instant) {
        render("masked");
        later(function () { render("inpainted"); }, HIDE_MS);
        return;
      }
      render(m);
      if (placeholder || !renderer) return;
      if (instant) {
        renderer.tween("srcMix", m === "inpainted" ? 0 : 1, 0);
        renderer.tween("reveal", m === "masked" ? 0 : 1, 0);
        return;
      }
      if (m === "masked") {
        renderer.tween("reveal", 0, HIDE_MS, function () { renderer.tween("srcMix", 1, 0); });
      } else if (m === "inpainted") {
        renderer.tween("reveal", 0, from === "masked" ? 0 : HIDE_MS, function () {
          renderer.tween("srcMix", 0, 0);
          renderer.tween("reveal", 1, REVEAL_MS);
        });
      } else if (from === "masked") {
        renderer.tween("reveal", 1, UNMASK_MS);
      } else {
        renderer.tween("srcMix", 1, UNSWAP_MS);
      }
    }

    bar.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        cancelIntro();
        setMode(b.getAttribute("data-mode"));
      });
    });

    // Each clip plays Original → Masked → Inpainted once it's been on screen for a beat.
    var introPending = false, onScreen = false;
    function cancelIntro() { introPending = false; clearSteps(); }
    function armIntro() {
      if (!introPending || !onScreen || reduceMotion) return;
      introPending = false;
      later(function () {
        setMode("masked");
        later(function () { setMode("inpainted"); }, HIDE_MS + EXAMPLE_HOLD_MS[1]);
      }, EXAMPLE_HOLD_MS[0]);
    }
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        onScreen = entries[0].isIntersecting;
        if (onScreen) armIntro();
      }, { threshold: 0.6 }).observe(tile);
    } else {
      onScreen = true;
    }

    video.addEventListener("timeupdate", function () {
      if (video.duration) progress.style.left = (video.currentTime / video.duration) * 100 + "%";
    });
    video.addEventListener("play", function () {
      tile.classList.add("is-playing");
      document.querySelectorAll("video").forEach(function (v) { if (v !== video && !v.paused) v.pause(); });
    });
    video.addEventListener("pause", function () { tile.classList.remove("is-playing"); });
    video.addEventListener("ended", function () { tile.classList.remove("is-playing"); });
    tile.querySelector(".video-tile__play").addEventListener("click", function () {
      if (placeholder) return;
      if (video.paused) { video.play().catch(function () {}); } else { video.pause(); }
    });
    tile.querySelector(".scrubber__track").addEventListener("click", function (e) {
      e.stopPropagation();
      if (!video.duration) return;
      var rect = e.currentTarget.getBoundingClientRect();
      video.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * video.duration;
    });
    addMuteToggle(tile, video);
    addFullscreenToggle(tile, video);

    function load(id) {
      var clip = CLIPS[id];
      clearSteps();
      placeholder = !!clip.placeholder;
      tile.classList.toggle("is-placeholder", placeholder);
      tile.classList.remove("is-playing");
      tile.style.setProperty("--ar", clip.out[0] + "/" + clip.out[1]);
      tile.style.setProperty("--arn", String(clip.out[0] / clip.out[1]));
      progress.style.left = "0%";
      note.textContent = clip.note || "";
      if (placeholder) {
        video.removeAttribute("src");
        video.load();
      } else {
        tile.style.setProperty("--poster", "url('" + posterUrl(id) + "')");
        posterImg.src = posterUrl(id);
        video.src = videoUrl(id);
        if (renderer) renderer.reset();
      }
      render("original");
      setMode("original", true);
      introPending = true;
      armIntro();
    }
    return { load: load };
  }

  /* ---------------------------------------------------------------
   * Gallery: a thumbnail strip feeding one example player. Thumbnails
   * show the inpainted panel of each clip's packed poster.
   * ------------------------------------------------------------- */
  function buildGallery() {
    var fig = document.querySelector('[data-op="gallery"]');
    var thumbsEl = document.getElementById("op-thumbs");
    if (!fig || !thumbsEl || !MEDIA.examples.length) return;
    document.getElementById("examples").hidden = false;
    var player = buildExamplePlayer(fig);
    var current = null;

    function select(id) {
      current = id;
      player.load(id);
      thumbsEl.querySelectorAll(".op-thumb").forEach(function (t) {
        t.classList.toggle("is-active", t.getAttribute("data-id") === id);
      });
    }

    MEDIA.examples.forEach(function (id) {
      var clip = CLIPS[id];
      var b = document.createElement("button");
      b.type = "button";
      b.className = "op-thumb ip-thumb" + (clip.placeholder ? " ip-thumb--placeholder" : "");
      b.setAttribute("data-id", id);
      b.title = clip.title;
      b.setAttribute("aria-label", clip.title);
      b.style.setProperty("--arn", String(clip.out[0] / clip.out[1]));
      if (clip.placeholder) {
        b.innerHTML = '<span class="ip-thumb__label">' + clip.title + "</span>";
      } else {
        b.style.backgroundImage = "url('" + posterUrl(id) + "')";
      }
      b.addEventListener("click", function () { if (id !== current) select(id); });
      thumbsEl.appendChild(b);
    });
    select(MEDIA.examples[0]);
  }

  /* ---------------------------------------------------------------
   * ATS vs autoregressive: one tick = one round of GPU calls.
   * 49 frames; root anchors every 12, guidance every 4, leaves fill.
   * ------------------------------------------------------------- */
  function treeDemo() {
    var atsRow = document.getElementById("tree-ats-row");
    var arRow = document.getElementById("tree-ar-row");
    if (!atsRow || !arRow) return;
    var atsBr = document.getElementById("tree-ats-brackets");
    var arBr = document.getElementById("tree-ar-brackets");
    var atsStep = document.getElementById("tree-ats-step");
    var arStep = document.getElementById("tree-ar-step");
    var btn = document.getElementById("tree-run");

    var N = 49, ROOT = 12, GUIDE = 4, AR_CHUNK = 4;
    var AR_ROUNDS = Math.ceil((N - 1) / AR_CHUNK);

    function cells(row) {
      row.style.gridTemplateColumns = "repeat(" + N + ", minmax(0, 1fr))";
      row.innerHTML = "";
      var out = [];
      for (var i = 0; i < N; i++) {
        var c = document.createElement("span");
        c.className = "tcell";
        row.appendChild(c);
        out.push(c);
      }
      return out;
    }
    function bracket(host, a, b) {
      var el = document.createElement("span");
      el.className = "tree__bracket";
      el.style.left = (a / N * 100) + "%";
      el.style.width = ((b - a + 1) / N * 100) + "%";
      host.appendChild(el);
    }
    function mark(cell, cls) { cell.className = "tcell " + cls + " is-new"; }
    function mix(a, b, t) {
      var pa = [1, 3, 5].map(function (i) { return parseInt(a.slice(i, i + 2), 16); });
      var pb = [1, 3, 5].map(function (i) { return parseInt(b.slice(i, i + 2), 16); });
      return "rgb(" + pa.map(function (v, i) { return Math.round(v + (pb[i] - v) * t); }).join(",") + ")";
    }

    // ATS levels as lists of calls, each a bracket [a, b] and the cells it writes.
    var root = { name: "root", cls: "is-root", calls: [{ a: 0, b: N - 1, cells: [] }] };
    for (var r = 0; r < N; r += ROOT) root.calls[0].cells.push(r);
    var guide = { name: "guidance", cls: "is-guide", calls: [] };
    for (var a = 0; a + ROOT < N; a += ROOT) {
      var g = { a: a, b: a + ROOT, cells: [] };
      for (var x = a + GUIDE; x < a + ROOT; x += GUIDE) g.cells.push(x);
      guide.calls.push(g);
    }
    var leaf = { name: "leaves", cls: "is-leaf", calls: [] };
    for (var s = 0; s + GUIDE < N; s += GUIDE) {
      var l = { a: s, b: s + GUIDE, cells: [] };
      for (var y = s + 1; y < s + GUIDE; y++) l.cells.push(y);
      leaf.calls.push(l);
    }
    var levels = [root, guide, leaf];

    var atsCells, arCells, timer = null, tick = 0;

    function reset() {
      if (timer) { clearInterval(timer); timer = null; }
      tick = 0;
      atsCells = cells(atsRow);
      arCells = cells(arRow);
      atsBr.innerHTML = "";
      arBr.innerHTML = "";
      atsStep.textContent = "";
      arStep.textContent = "";
    }

    function step() {
      tick += 1;
      atsBr.innerHTML = "";
      arBr.innerHTML = "";
      if (tick <= levels.length) {
        var lvl = levels[tick - 1];
        lvl.calls.forEach(function (call) {
          bracket(atsBr, call.a, call.b);
          call.cells.forEach(function (i) { mark(atsCells[i], lvl.cls); });
        });
        var n = lvl.calls.length;
        atsStep.textContent = "round " + tick + " · " + lvl.name + " · " + n + (n === 1 ? " call" : " parallel calls");
      } else {
        atsStep.textContent = "done in " + levels.length + " rounds";
      }
      var start = (tick - 1) * AR_CHUNK + (tick === 1 ? 0 : 1);
      var end = Math.min(N - 1, tick * AR_CHUNK);
      bracket(arBr, Math.max(0, start - 1), end);
      var drift = (tick - 1) / (AR_ROUNDS - 1);
      for (var i = start; i <= end; i++) {
        mark(arCells[i], "is-ar");
        arCells[i].style.backgroundColor = mix("#FF8969", "#9FB08A", Math.min(1, drift + (Math.random() - 0.5) * 0.12));
      }
      arStep.textContent = tick < AR_ROUNDS ? "round " + tick + " / " + AR_ROUNDS : "done in " + AR_ROUNDS + " rounds";
      if (tick >= AR_ROUNDS) {
        clearInterval(timer);
        timer = null;
        arBr.innerHTML = "";
        atsBr.innerHTML = "";
      }
    }

    function run() {
      reset();
      if (reduceMotion) { while (tick < AR_ROUNDS) step(); return; }
      step();
      timer = setInterval(step, 850);
    }

    reset();
    if (btn) btn.addEventListener("click", run);
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting) { run(); io.disconnect(); } });
      }, { threshold: 0.5 });
      io.observe(atsRow);
    } else {
      run();
    }
  }

  /* ---------------------------------------------------------------
   * Citation copy.
   * ------------------------------------------------------------- */
  function setupCite(btn) {
    var pre = btn.parentNode.querySelector("pre");
    btn.addEventListener("click", function () {
      var done = function () {
        btn.classList.add("copied");
        btn.textContent = "Copied ✓";
        setTimeout(function () { btn.classList.remove("copied"); btn.textContent = "Copy"; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(pre.textContent).then(done, done);
      } else {
        var ta = document.createElement("textarea");
        ta.value = pre.textContent; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); } catch (e) {}
        document.body.removeChild(ta); done();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var hero = document.querySelector('[data-op="hero"]');
    if (hero) buildPlayer(hero, { autoplay: true }).load(MEDIA.hero);
    buildGallery();
    treeDemo();
    document.querySelectorAll(".cite-copy").forEach(setupCite);
  });
})();
