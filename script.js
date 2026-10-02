(function () {
  'use strict';

  /* ------------------------------------------------------------------
     Media rules
     ------------------------------------------------------------------ */
  var MB = 1024 * 1024;
  var KINDS = {
    image: {
      max: 20 * MB, names: 'JPG, PNG, WebP',
      exts: ['jpg', 'jpeg', 'png', 'webp'],
      mimes: ['image/jpeg', 'image/png', 'image/webp']
    },
    video: {
      max: 100 * MB, names: 'MP4, MOV, WebM',
      exts: ['mp4', 'mov', 'webm'],
      mimes: ['video/mp4', 'video/quicktime', 'video/webm']
    }
  };
  var TYPE_LABELS = {
    jpg: 'JPEG image', jpeg: 'JPEG image', png: 'PNG image', webp: 'WebP image',
    mp4: 'MP4 video', mov: 'QuickTime video', webm: 'WebM video'
  };
  var STEPS = {
    image: ['Reading file and metadata', 'Analyzing noise and compression', 'Running classifier'],
    video: ['Sampling frames', 'Checking motion and face detail', 'Running classifier']
  };

  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name);
    return m ? m[1].toLowerCase() : '';
  }
  function detectKind(file) {
    var ext = extOf(file.name);
    var keys = Object.keys(KINDS);
    for (var i = 0; i < keys.length; i++) {
      var k = KINDS[keys[i]];
      if (k.mimes.indexOf(file.type) !== -1 || k.exts.indexOf(ext) !== -1) return keys[i];
    }
    return null;
  }
  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < MB) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * MB) return (n / MB).toFixed(1) + ' MB';
    return (n / (1024 * MB)).toFixed(2) + ' GB';
  }
  function formatDuration(s) {
    if (!isFinite(s)) return 'Unavailable';
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    var pad = function (v) { return v < 10 ? '0' + v : '' + v; };
    return h ? h + ':' + pad(m) + ':' + pad(sec) : m + ':' + pad(sec);
  }
  function validate(file, allowed) {
    var kind = detectKind(file);
    if (!kind) {
      return { error: 'Unsupported file. Use ' + allowed.map(function (k) { return KINDS[k].names; }).join(' or ') + '.' };
    }
    if (allowed.indexOf(kind) === -1) {
      var other = kind.charAt(0).toUpperCase() + kind.slice(1);
      return { error: 'This page accepts ' + allowed[0] + 's only. Use ' + other + ' Verification for ' + kind + 's.' };
    }
    if (file.size === 0) return { error: 'The file is empty.' };
    if (file.size > KINDS[kind].max) {
      return { error: 'This file is ' + formatBytes(file.size) + '. The maximum for ' + kind + 's is ' + (KINDS[kind].max / MB) + ' MB.' };
    }
    return { kind: kind };
  }

  function loadMeta(kind, url) {
    return new Promise(function (resolve) {
      if (kind === 'image') {
        var im = new Image();
        im.onload = function () { resolve({ width: im.naturalWidth, height: im.naturalHeight }); };
        im.onerror = function () { resolve({}); };
        im.src = url;
      } else {
        var v = document.createElement('video');
        v.preload = 'metadata';
        v.muted = true;
        v.onloadedmetadata = function () { resolve({ width: v.videoWidth, height: v.videoHeight, duration: v.duration }); };
        v.onerror = function () { resolve({}); };
        v.src = url;
      }
      setTimeout(function () { resolve({}); }, 8000);
    });
  }

  function makeMedia(kind, url) {
    var el;
    if (kind === 'image') {
      el = new Image();
      el.alt = 'Uploaded image preview';
    } else {
      el = document.createElement('video');
      el.controls = true;
      el.preload = 'metadata';
      el.setAttribute('playsinline', '');
    }
    el.addEventListener('error', function () {
      var p = document.createElement('p');
      p.className = 'na';
      p.textContent = 'Preview is not available for this file in your browser. Verification still works.';
      if (el.parentNode) el.replaceWith(p);
    });
    el.src = url;
    return el;
  }

  async function sha256(file) {
    try {
      var buf = await file.arrayBuffer();
      var digest = await crypto.subtle.digest('SHA-256', buf);
      return Array.prototype.map.call(new Uint8Array(digest), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------------
     Detection layer
     This is the only part that needs to change to use a real model.

     Set Detector.endpoint to a URL (for example '/api/verify'). The page
     then POSTs multipart form data with fields:
       file  the uploaded image or video
       type  'image' or 'video'
     and expects a JSON response:
       {
         "verdict": "authentic" | "ai",
         "confidence": 0-100,            // confidence in the verdict
         "summary": "short explanation",
         "signals": [ { "label": "...", "status": "pass" | "flag", "note": "..." } ]
       }
     Until then, simulate() returns repeatable sample results.
     ------------------------------------------------------------------ */
  var Detector = {
    endpoint: null,

    analyze: async function (job) {
      var raw = this.endpoint ? await this.remote(job) : await this.simulate(job);
      return normalize(raw);
    },

    remote: async function (job) {
      var body = new FormData();
      body.append('file', job.file);
      body.append('type', job.kind);
      job.onProgress(0.25);
      var res = await fetch(this.endpoint, { method: 'POST', body: body });
      if (!res.ok) throw new Error('The detection service returned an error (' + res.status + ').');
      job.onProgress(1);
      return res.json();
    },

    simulate: function (job) {
      var total = job.kind === 'video' ? 4200 : 2600;
      var t0 = performance.now();
      return new Promise(function (resolve) {
        (function tick() {
          var f = Math.min(1, (performance.now() - t0) / total);
          job.onProgress(f);
          if (f < 1) setTimeout(tick, 80); else resolve(sampleResult(job.file, job.kind));
        })();
      });
    }
  };

  function normalize(raw) {
    var c = Math.round(Number(raw && raw.confidence));
    return {
      verdict: raw && raw.verdict === 'ai' ? 'ai' : 'authentic',
      confidence: Math.max(0, Math.min(100, isNaN(c) ? 0 : c)),
      summary: String((raw && raw.summary) || ''),
      signals: raw && Array.isArray(raw.signals) ? raw.signals : []
    };
  }

  var SIGNALS = {
    image: [
      { label: 'Noise pattern', pass: 'Sensor-style noise is consistent across the frame.', flag: 'Texture is unusually smooth in several regions.' },
      { label: 'Compression history', pass: 'Compression matches a single capture and save.', flag: 'Mixed compression levels found within the image.' },
      { label: 'Lighting and shadows', pass: 'Light direction and shadows agree.', flag: 'Shadows do not match a single light source.' }
    ],
    video: [
      { label: 'Frame consistency', pass: 'Detail holds steady between frames.', flag: 'Fine detail shifts between neighboring frames.' },
      { label: 'Motion continuity', pass: 'Movement follows natural timing.', flag: 'Motion shows unnatural smoothing or jumps.' },
      { label: 'Face and edge detail', pass: 'No blending artifacts around faces or edges.', flag: 'Blending artifacts found around faces and edges.' }
    ]
  };
  var SUMMARY = {
    image: {
      authentic: 'No strong signs of synthetic generation were found. Noise, compression and lighting are consistent with a camera capture.',
      ai: 'Several patterns typical of generated images were found, including overly smooth texture and inconsistent lighting.'
    },
    video: {
      authentic: 'Frames and motion are consistent with recorded footage. No signs of synthetic generation or face manipulation were found.',
      ai: 'Frame-to-frame inconsistencies and unnatural detail around faces and edges suggest synthetic or manipulated footage.'
    }
  };

  function hash32(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // Repeatable sample output: the same file always gets the same result.
  function sampleResult(file, kind) {
    var r = mulberry32(hash32(file.name + '|' + file.size + '|' + file.lastModified));
    var ai = r() < 0.42;
    var conf = 74 + Math.floor(r() * 23);
    if (r() < 0.12) conf = 55 + Math.floor(r() * 11);
    var flagCount = ai ? (r() < 0.4 ? 3 : 2) : 0;
    var order = [0, 1, 2];
    for (var i = 2; i > 0; i--) {
      var j = Math.floor(r() * (i + 1));
      var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
    }
    var flagged = order.slice(0, flagCount);
    return {
      verdict: ai ? 'ai' : 'authentic',
      confidence: conf,
      summary: SUMMARY[kind][ai ? 'ai' : 'authentic'],
      signals: SIGNALS[kind].map(function (d, idx) {
        var f = flagged.indexOf(idx) !== -1;
        return { label: d.label, status: f ? 'flag' : 'pass', note: f ? d.flag : d.pass };
      })
    };
  }

  /* ------------------------------------------------------------------
     Verifier component
     ------------------------------------------------------------------ */
  function mount(host, key, allowed) {
    host.appendChild(document.getElementById('verifier-tpl').content.cloneNode(true));
    var $ = function (role) { return host.querySelector('[data-role="' + role + '"]'); };
    var stage = function (name) { return host.querySelector('[data-stage="' + name + '"]'); };

    var el = {
      status: $('status'), drop: $('drop'), dropTitle: $('dropTitle'), input: $('input'),
      preview: $('preview'), media: $('media'), name: $('name'), remove: $('remove'),
      formats: $('formats'), error: $('error'), verify: $('verify'),
      busyTitle: $('busyTitle'), progress: $('progress'), progressWrap: $('progressWrap'), steps: $('steps'),
      rMedia: $('rMedia'), rName: $('rName'), info: $('info'), verdictPanel: $('verdictPanel'),
      verdict: $('verdict'), conf: $('conf'), meter: $('meter'), meterWrap: $('meterWrap'),
      summary: $('summary'), note: $('note'), signals: $('signals'), again: $('again')
    };

    // Copy that depends on which kinds this page accepts
    el.input.id = key + '-file';
    el.input.setAttribute('aria-label', 'Choose a file to verify');
    el.input.accept = allowed.reduce(function (acc, k) {
      return acc.concat(KINDS[k].mimes, KINDS[k].exts.map(function (e) { return '.' + e; }));
    }, []).join(',');
    if (allowed.length === 2) {
      el.dropTitle.textContent = 'Drop an image or video here';
      el.formats.textContent = 'Images: ' + KINDS.image.names + ', up to ' + (KINDS.image.max / MB) + ' MB. Videos: ' + KINDS.video.names + ', up to ' + (KINDS.video.max / MB) + ' MB.';
    } else {
      var k = KINDS[allowed[0]];
      el.dropTitle.textContent = 'Drop ' + (allowed[0] === 'image' ? 'an image' : 'a video') + ' here';
      el.formats.textContent = 'Supported formats: ' + k.names + '. Maximum file size: ' + (k.max / MB) + ' MB.';
    }
    el.drop.setAttribute('aria-label', el.dropTitle.textContent + ' or press Enter to browse files');

    var file = null, kind = null, url = null, metaPromise = null, runId = 0;

    function setStatus(text, tone) {
      el.status.textContent = text;
      if (tone) el.status.setAttribute('data-tone', tone); else el.status.removeAttribute('data-tone');
    }
    function showStage(name) {
      ['input', 'busy', 'result'].forEach(function (n) { stage(n).hidden = n !== name; });
    }
    function showError(msg) {
      el.error.textContent = msg || '';
      el.error.hidden = !msg;
    }
    function releaseUrl() {
      if (url) { URL.revokeObjectURL(url); url = null; }
    }

    function reset() {
      runId++;
      releaseUrl();
      file = null; kind = null; metaPromise = null;
      el.media.textContent = '';
      el.rMedia.textContent = '';
      el.preview.hidden = true;
      el.drop.hidden = false;
      el.verify.disabled = true;
      showError('');
      showStage('input');
      setStatus('No file selected');
    }

    function accept(f) {
      var v = validate(f, allowed);
      if (v.error) { showError(v.error); return; }
      showError('');
      releaseUrl();
      file = f; kind = v.kind;
      url = URL.createObjectURL(f);
      metaPromise = loadMeta(kind, url);
      el.media.textContent = '';
      el.media.appendChild(makeMedia(kind, url));
      el.name.textContent = f.name + '  ·  ' + formatBytes(f.size);
      el.name.title = f.name;
      el.drop.hidden = true;
      el.preview.hidden = false;
      el.verify.disabled = false;
      setStatus('Ready to verify', 'accent');
    }

    // Choosing and dropping files
    el.drop.addEventListener('click', function () { el.input.click(); });
    el.drop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.input.click(); }
    });
    el.input.addEventListener('change', function () {
      if (el.input.files && el.input.files[0]) accept(el.input.files[0]);
      el.input.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (t) {
      el.drop.addEventListener(t, function (e) { e.preventDefault(); el.drop.setAttribute('data-drag', ''); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      el.drop.addEventListener(t, function (e) { e.preventDefault(); el.drop.removeAttribute('data-drag'); });
    });
    el.drop.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) accept(f);
    });
    el.remove.addEventListener('click', reset);
    el.again.addEventListener('click', reset);

    // Analysis
    function updateProgress(f) {
      el.progress.style.width = Math.round(f * 100) + '%';
      el.progressWrap.setAttribute('aria-valuenow', Math.round(f * 100));
      var n = STEPS[kind].length;
      var current = Math.min(n - 1, Math.floor(f * n));
      Array.prototype.forEach.call(el.steps.children, function (li, i) {
        var s = f >= 1 || i < current ? 'done' : i === current ? 'run' : 'wait';
        li.setAttribute('data-s', s);
        li.lastChild.textContent = s === 'done' ? 'Done' : s === 'run' ? 'Running' : 'Queued';
      });
    }

    async function run() {
      if (!file) return;
      var id = ++runId;
      var media = el.media.querySelector('video');
      if (media) media.pause();
      showError('');
      el.busyTitle.textContent = 'Analyzing ' + file.name;
      el.steps.textContent = '';
      STEPS[kind].forEach(function (label) {
        var li = document.createElement('li');
        var a = document.createElement('span'); a.textContent = label;
        var b = document.createElement('span'); b.textContent = 'Queued';
        li.appendChild(a); li.appendChild(b);
        el.steps.appendChild(li);
      });
      updateProgress(0);
      showStage('busy');
      setStatus('Analyzing', 'accent');

      try {
        var out = await Promise.all([
          metaPromise,
          sha256(file),
          Detector.analyze({ file: file, kind: kind, onProgress: function (f) { if (id === runId) updateProgress(f); } })
        ]);
        if (id !== runId) return;
        renderResult(out[2], out[0] || {}, out[1]);
      } catch (err) {
        if (id !== runId) return;
        showStage('input');
        setStatus('Ready to verify', 'accent');
        showError((err && err.message) || 'Analysis failed. Try again.');
      }
    }
    el.verify.addEventListener('click', run);

    function row(label, value, title) {
      var dt = document.createElement('dt'); dt.textContent = label;
      var dd = document.createElement('dd'); dd.textContent = value;
      if (title) dd.title = title;
      el.info.appendChild(dt); el.info.appendChild(dd);
    }

    function renderResult(res, meta, hash) {
      el.rMedia.textContent = '';
      el.rMedia.appendChild(makeMedia(kind, url));
      el.rName.textContent = file.name;
      el.rName.title = file.name;

      el.info.textContent = '';
      row('File name', file.name);
      row('Type', TYPE_LABELS[extOf(file.name)] || file.type || 'Unknown');
      row('Size', formatBytes(file.size));
      row('Resolution', meta.width && meta.height ? meta.width + ' × ' + meta.height + ' px' : 'Unavailable');
      if (kind === 'video') row('Duration', formatDuration(meta.duration));
      row('SHA-256', hash || 'Unavailable');
      row('Analyzed', new Date().toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }));

      var ai = res.verdict === 'ai';
      el.verdictPanel.setAttribute('data-verdict', res.verdict);
      el.verdict.textContent = ai ? 'Likely AI Generated' : 'Likely Authentic';
      el.conf.textContent = res.confidence + '%';
      el.meterWrap.setAttribute('aria-label', 'Confidence ' + res.confidence + ' percent');
      el.meter.style.width = '0';
      requestAnimationFrame(function () { requestAnimationFrame(function () { el.meter.style.width = res.confidence + '%'; }); });
      el.summary.textContent = res.summary;
      el.note.hidden = res.confidence >= 65;
      el.note.textContent = 'Confidence is low. Treat this result as inconclusive and check the original source.';

      el.signals.textContent = '';
      res.signals.forEach(function (s) {
        var li = document.createElement('li');
        var text = document.createElement('div');
        var t = document.createElement('p'); t.className = 'sig-t'; t.textContent = s.label;
        var n = document.createElement('p'); n.className = 'sig-n'; n.textContent = s.note || '';
        text.appendChild(t); text.appendChild(n);
        var pill = document.createElement('span');
        pill.className = 'pill';
        var flagged = s.status === 'flag';
        pill.setAttribute('data-tone', flagged ? 'warn' : 'ok');
        pill.textContent = flagged ? 'Flagged' : 'Normal';
        li.appendChild(text); li.appendChild(pill);
        el.signals.appendChild(li);
      });

      setStatus('Complete');
      showStage('result');
    }

    reset();
  }

  mount(document.querySelector('[data-mount="home"]'), 'home', ['image', 'video']);
  mount(document.querySelector('[data-mount="image"]'), 'image', ['image']);
  mount(document.querySelector('[data-mount="video"]'), 'video', ['video']);

  // A file dropped outside a drop area must not navigate away from the page
  ['dragover', 'drop'].forEach(function (t) {
    window.addEventListener(t, function (e) { e.preventDefault(); });
  });

  /* ------------------------------------------------------------------
     Navigation
     ------------------------------------------------------------------ */
  var VIEWS = ['home', 'image', 'video', 'about'];
  function show(view) {
    if (VIEWS.indexOf(view) === -1) view = 'home';
    document.querySelectorAll('[data-view]').forEach(function (s) { s.hidden = s.getAttribute('data-view') !== view; });
    document.querySelectorAll('.nav a').forEach(function (a) {
      if (a.getAttribute('data-nav') === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.querySelectorAll('video').forEach(function (v) { v.pause(); });
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('[data-nav]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      var v = a.getAttribute('data-nav');
      show(v);
      try { history.replaceState(null, '', '#' + v); } catch (err) { /* hash update is optional */ }
    });
  });
  window.addEventListener('hashchange', function () { show(location.hash.slice(1)); });
  show(location.hash.slice(1));
})();
