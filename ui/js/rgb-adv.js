"use strict";
/* RGB "Advanced" mode: devices placed in a 3D / 2D space, one layered effect across all of them.
   The canvas here is only a PREVIEW: `colorAt` (the effect engine below) is pure and has no DOM, so the
   backend can run the same maths. The scene (devices, layers, view) is saved through rgb_scene_get / rgb_scene_set.
   Mounted by rgb.js: App.RGBAdv.render(container) / App.RGBAdv.leave(). Design: DESIGN.md. */

(function () {
  const { api } = App;
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fract = (x) => x - Math.floor(x);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  /** App.t, escaped for innerHTML text and attributes */
  const t = (k, v) => esc(App.t(k, v));

  /* ===================================================================
     EFFECT ENGINE. One pure function: colorAt(layers, position, t, env, out).
     No DOM, no globals, no randomness: it ports to Rust one to one
     (layers = Vec<Layer>, pos = [f32;3], returns [f32;3]). Up to "end of effect engine".
     =================================================================== */
  const GENS = ["wave", "radial", "rainbow", "noise", "scan", "solid", "sparkle", "audio"];
  const MASK = { radial: 1, scan: 1, sparkle: 1, audio: 1 };   // these use their value as coverage too
  const BLENDS = ["add", "mix", "multiply", "max"];
  const _hx = {};
  function rgbOf(h) { return _hx[h] || (_hx[h] = [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]); }
  function gradAt(st, v, o) {   // writes into o, no allocation
    const n = st.length;
    if (v <= st[0].p) { const c = rgbOf(st[0].c); o[0] = c[0]; o[1] = c[1]; o[2] = c[2]; return o; }
    if (v >= st[n - 1].p) { const c = rgbOf(st[n - 1].c); o[0] = c[0]; o[1] = c[1]; o[2] = c[2]; return o; }
    for (let i = 1; i < n; i++) if (v <= st[i].p) {
      const a = st[i - 1], b = st[i], u = (v - a.p) / Math.max(1e-6, b.p - a.p), ca = rgbOf(a.c), cb = rgbOf(b.c);
      o[0] = ca[0] + (cb[0] - ca[0]) * u; o[1] = ca[1] + (cb[1] - ca[1]) * u; o[2] = ca[2] + (cb[2] - ca[2]) * u; return o;
    }
    return o;
  }
  function h3(x, y, z) {
    let h = Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791);
    h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y, z) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    let fx = x - ix, fy = y - iy, fz = z - iz;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
    const L = (a, b, u) => a + (b - a) * u;
    return L(L(L(h3(ix, iy, iz), h3(ix + 1, iy, iz), fx), L(h3(ix, iy + 1, iz), h3(ix + 1, iy + 1, iz), fx), fy),
             L(L(h3(ix, iy, iz + 1), h3(ix + 1, iy, iz + 1), fx), L(h3(ix, iy + 1, iz + 1), h3(ix + 1, iy + 1, iz + 1), fx), fy), fz);
  }
  // one layer's generator: position (cm) + time (s) -> 0..1
  function genValue(L, pos, tm, env) {
    const P = L.p, o = env.origin, tl = tm * P.speed, sc = P.scale;
    const dx = pos[0] - o[0], dy = pos[1] - o[1], dz = pos[2] - o[2];
    const an = P.rot * Math.PI / 180, ca = Math.cos(an), sa = Math.sin(an);
    let ux, uy, uz;
    if (P.axis === 0) { ux = ca; uy = 0; uz = sa; } else if (P.axis === 1) { ux = sa; uy = ca; uz = 0; } else { ux = sa; uy = 0; uz = ca; }
    const s0 = dx * ux + dy * uy + dz * uz, s = P.mirror ? Math.abs(s0) : s0;
    let v = 0;
    switch (L.gen) {
      case "wave": v = 0.5 + 0.5 * Math.sin(TAU * (s / (30 / sc) - tl * 0.5)); break;
      case "rainbow": v = fract(s / (80 / sc) - tl * 0.2); break;
      case "solid": v = 1 - Math.abs(2 * fract(tl * 0.15) - 1); break;
      case "radial": {
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz), R = 90 / sc;
        const x = d - (((tl * 22) % R) + R) % R;
        v = x >= 0 ? Math.exp(-(x * x) / Math.pow(P.width * 0.5 + 0.5, 2)) : Math.exp(x / (P.trail * 40 + 0.5));
        break;
      }
      case "noise": {
        const lam = 24 / sc, al = s0 / lam, k = -0.6 * al - tl * 1.5;
        const n = vnoise(dx / lam + ux * k, dy / lam + uy * k, dz / lam + uz * k);
        v = clamp((n - 0.25) * 1.8, 0, 1); break;
      }
      case "scan": {   // quantised into 3 cm bars: head + faded trail behind it, like the logo
        const sg = P.speed >= 0 ? 1 : -1, span = P.mirror ? 80 : 160, lo = P.mirror ? 0 : -80;
        const head = lo + span * fract(tl * 0.3), back = Math.floor((head - s) * sg / 3) * 3;
        v = back < 0 ? 0 : back <= P.width ? 1 : Math.exp(-(back - P.width) / (P.trail * 45 + 1)) * 0.85; break;
      }
      case "sparkle": {
        const cs = 2 / sc, a = h3(Math.floor(pos[0] / cs), Math.floor(pos[1] / cs), Math.floor(pos[2] / cs));
        const b = h3(Math.floor(pos[2] / cs) + 91, Math.floor(pos[0] / cs) + 17, Math.floor(pos[1] / cs) + 5);
        const ph = fract(tl * 0.6 + a);
        v = b > P.width / 10 ? 0 : ph < 0.1 ? ph / 0.1 : Math.exp(-(ph - 0.1) / (0.04 + P.trail * 0.4)); break;
      }
      case "audio": {   // bars along the axis up to the input level
        const u = P.mirror ? s / 80 : (s + 80) / 160, uq = Math.floor(clamp(u, 0, 1) * 24) / 24, lv = env.level;
        v = uq < lv ? 0.35 + 0.65 * uq / Math.max(lv, 0.05) : 0; break;
      }
    }
    if (P.ease > 0) v = Math.pow(clamp(v, 0, 1), 1 + P.ease * 3);
    return v;
  }
  // env = { origin:[x,y,z], level:0..1, bright:0..1 }; writes [r,g,b] 0..255 into out (no allocation in the hot loop)
  const GC = [0, 0, 0];
  function colorAt(layers, pos, tm, env, out) {
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i]; if (!L.on) continue;
      const v = clamp(genValue(L, pos, tm, env), 0, 1), c = gradAt(L.stops, v, GC), a = (MASK[L.gen] ? v : 1) * L.opacity;
      switch (L.blend) {
        case "add": r += c[0] * a; g += c[1] * a; b += c[2] * a; break;
        case "mix": r = r * (1 - a) + c[0] * a; g = g * (1 - a) + c[1] * a; b = b * (1 - a) + c[2] * a; break;
        case "multiply": r = r * (1 - a) + r * c[0] / 255 * a; g = g * (1 - a) + g * c[1] / 255 * a; b = b * (1 - a) + b * c[2] / 255 * a; break;
        case "max": r = Math.max(r, c[0] * a); g = Math.max(g, c[1] * a); b = Math.max(b, c[2] * a); break;
      }
    }
    const k = env.bright;
    out[0] = Math.min(255, r * k); out[1] = Math.min(255, g * k); out[2] = Math.min(255, b * k);
    return out;
  }
  /* ===================== end of effect engine ===================== */

  /* ---------------- data ---------------- */
  const SW = ["#c6f432", "#ff4d4d", "#ffb454", "#2ee6a8", "#38b6ff", "#8a6bff", "#ff5fd2", "#ffffff"];
  const dflt = () => ({ speed: 1, scale: 1, rot: 0, axis: 0, mirror: false, ease: 0, trail: 0.5, width: 6 });
  function mkL(gen, patch, stops, blend, opacity) {
    return { on: true, gen, p: Object.assign(dflt(), patch || {}), stops: stops.map((s) => ({ p: s[0], c: s[1] })), blend: blend || "add", opacity: opacity == null ? 1 : opacity };
  }
  const RAIN = [[0, "#000000"], [0.5, "#38b6ff"], [1, "#ffffff"]];
  /** name = the English name kept in the saved scene; shown through App.t(key) */
  const PRESETS = [
    { name: "Scan", key: "ra.pre.scan", layers: () => [mkL("scan", { speed: 1, width: 4, trail: 0.55 }, [[0, "#38b6ff"], [1, "#e8f6ff"]])] },
    { name: "Pulse from GPU", key: "ra.pre.pulse", origin: "gpu", layers: () => [
      mkL("solid", { speed: 0 }, [[0, "#120a1e"], [1, "#120a1e"]], "add", 0.8),
      mkL("radial", { speed: 1, width: 8, trail: 0.6, scale: 0.9 }, [[0, "#8a6bff"], [1, "#ff5fd2"]])] },
    { name: "Aurora", key: "ra.pre.aurora", layers: () => [
      mkL("wave", { axis: 1, rot: 25, speed: 0.5, scale: 0.7 }, [[0, "#06241c"], [0.5, "#2ee6a8"], [1, "#38b6ff"]], "mix"),
      mkL("noise", { axis: 1, speed: 0.4, scale: 0.8, ease: 0.6 }, [[0, "#000000"], [1, "#8a6bff"]], "add", 0.6)] },
    { name: "Rain", key: "ra.pre.rain", layers: () => [mkL("noise", { axis: 1, speed: -1.6, scale: 2.2, ease: 0.9 }, RAIN, "mix")] },
    { name: "Buffer now/trail", key: "ra.pre.buffer", layers: () => [
      mkL("solid", { speed: 0 }, [[0, "#c6f432"], [1, "#c6f432"]], "add", 0.05),
      mkL("scan", { speed: 0.8, width: 3, trail: 0.8 }, [[0, "#c6f432"], [1, "#c6f432"]])] },
  ];
  const FXKEY = { Custom: "ra.custom", Random: "ra.randomName" };
  for (const p of PRESETS) FXKEY[p.name] = p.key;
  const fxLabel = (n) => (FXKEY[n] ? App.t(FXKEY[n]) : n);
  const cl = (o) => JSON.parse(JSON.stringify(o));

  /* device types: local LED positions (cm), x right, y up, z towards the front. n = the device's real LED count */
  const lineP = (n, len, ax) => Array.from({ length: n }, (_, i) => { const u = n > 1 ? (i / (n - 1) - 0.5) * len : 0; return ax === "y" ? [0, u, 0] : [u, 0, 0]; });
  const TYPES = {
    header: { link: 1, pts: (n) => lineP(n, Math.min(40, 3 + n * 1.2)) },
    gpu: { link: 1, pts: (n) => lineP(n, Math.min(34, 6 + n * 2.8)) },
    ram: { link: 1, pts: (n) => lineP(n, Math.min(20, 3 + n * 1.4), "y") },
    fan: { link: 2, pts: (n) => Array.from({ length: n }, (_, i) => [Math.cos(i / n * TAU) * 5.5, Math.sin(i / n * TAU) * 5.5, 0]) },
    strip: { link: 1, pts: (n) => lineP(n, Math.min(60, 2 + n * 1.5)) },
    keyboard: { link: 0, pts: (n) => { const c = Math.min(20, n), r = Math.ceil(n / c); return Array.from({ length: n }, (_, k) => [(k % c - (c - 1) / 2) * 1.8, 0, (Math.floor(k / c) - (r - 1) / 2) * 1.8]); } },
    headset: { link: 0, pts: (n) => Array.from({ length: n }, (_, i) => { const side = i < n / 2 ? -8 : 8, m = Math.ceil(n / 2), j = i % m; return [side, 3, m > 1 ? (j / (m - 1) - 0.5) * 3 : 0]; }) },
  };
  const DEFN = { header: 12, gpu: 8, ram: 8, fan: 8, strip: 16, keyboard: 120, headset: 4 };
  const r2 = (v) => Math.round(v * 100) / 100;
  /** the LED layout of a type with n LEDs, rounded: this is what is saved (pts) and what the backend uses */
  const layout = (type, n) => TYPES[type].pts(n).map((p) => [r2(p[0]), r2(p[1]), r2(p[2])]);
  const ptsOf = (d) => d.pts;
  const linkKey = (l) => (l ? l.name + "#" + (l.nth | 0) : null);
  let nextId = 1;
  const mkDev = (type, name, pts, x, y, z, rot, link) => { const d = { id: nextId++, type, name, n: pts.length, x, y, z, rot: rot || 0, sc: 1, pts }; if (link) d.link = link; return d; };

  /** OpenRGB device kind (+ name) -> one of our types. 0 board, 1 RAM, 2 GPU, 3 cooler, 4 strip, 5 keyboard, 8/9 headset */
  function typeOfDev(d) {
    const k = d.kind, nm = (d.name || "").toLowerCase();
    if (k === 2) return "gpu";
    if (k === 1) return "ram";
    if (k === 5) return "keyboard";
    if (k === 8 || k === 9) return "headset";
    if (k === 0) return "header";
    if (k === 3 || /\bfan\b/.test(nm)) return "fan";
    return "strip";
  }
  /** a sensible first place for a device of this type (cm); `k` = how many of the type are already placed */
  function defaultSpot(type, k) {
    switch (type) {
      case "header": return [-44, 40, -2 + k * 4, 90];
      case "gpu": return [-30, 16 - k * 3, 0, 90];
      case "fan": return [-35, 9 + 14 * (k % 3), 21 - 42 * Math.floor(k / 3), 0];
      case "ram": return [-40 + k * 3, 38, 6, 0];
      case "keyboard": return [22, 0.5, 14 + k * 8, 0];
      case "headset": return [34 + k * 6, 0, -10, 0];
      default: return [-8 + k * 8, 12, -25, 0];
    }
  }
  /** OpenRGB devices -> list with a link {name, nth} (nth = n-th device with that name) and a key for matching */
  function realList(devs) {
    const seen = {};
    return devs.map((d) => {
      const c = (seen[d.name] = (seen[d.name] || 0) + 1);
      const link = { name: d.name, nth: c - 1 };
      return { key: linkKey(link), link, name: c > 1 ? d.name + " " + c : d.name, type: typeOfDev(d), n: Math.max(1, (d.led_names || []).length) };
    });
  }

  /* ---------------- state (kept while the app runs; the scene is reloaded on every render) ---------------- */
  const S = { view: "3d", plane: "top", snap: 2, devices: [], sel: null, layers: PRESETS[4].layers(), selLayer: 1, origin: [0, 18, 0],
    playing: true, t: 0, speed: 1, bright: 100, fxName: "Buffer now/trail", mine: [], cam: { yaw: 0.55, pitch: 0.5, dist: 150, t: [0, 18, 0] }, zoom2: 1, pan2: [0, 0], seen: [] };
  const KEEP = ["view", "plane", "snap", "devices", "sel", "layers", "selLayer", "origin", "speed", "bright", "fxName", "mine", "cam", "zoom2", "pan2", "seen", "playing"];
  let raw = {};          // the whole saved object: keys that are not ours (e.g. the Simple/Advanced switch) are written back untouched
  let real = null;       // devices OpenRGB reports right now (null = unknown)
  let root = null, mount = null, cv = null, ctx = null, bgc = null, bgx = null, ro = null;
  let CW = 600, CH = 400, DPR = 1;
  let saveT = 0, raf = 0, last = 0, uiT = 0, gen = 0;
  const D = { view: true, geom: true, fx: true };   // what needs recomputing; nothing dirty + paused = no drawing
  const $ = (s) => root && root.querySelector(s);
  const selDev = () => S.devices.find((d) => d.id === S.sel);

  function mark(k) { if (k) D[k] = true; else D.view = D.geom = D.fx = true; wake(); }
  function persist() {
    mark();
    clearTimeout(saveT); saveT = setTimeout(save, 300);
  }
  function save() {
    clearTimeout(saveT); saveT = 0;
    const o = Object.assign({}, raw);
    KEEP.forEach((k) => { o[k] = S[k]; });
    o.mode = "advanced";   // this page only runs in Advanced; the recorder then drives the linked devices
    const plain = JSON.parse(JSON.stringify(o, (k, v) => (k[0] === "_" ? undefined : v)));
    raw = plain;
    api.invoke("rgb_scene_set", { scene: plain }).catch((e) => App.toast(App.t("rgb.err", { err: e }), "err"));
  }
  const okDev = (d) => {
    if (!d || !TYPES[d.type] || !Number.isFinite(d.id)) return false;
    if (!Array.isArray(d.pts) || !d.pts.length || !d.pts.every((p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))) d.pts = layout(d.type, DEFN[d.type]);
    d.n = d.pts.length; d.x = +d.x || 0; d.y = +d.y || 0; d.z = +d.z || 0; d.rot = +d.rot || 0; d.sc = +d.sc || 1;
    if (!d.link || typeof d.link.name !== "string") delete d.link;
    if (typeof d.name !== "string") d.name = d.type;
    return true;
  };
  const okL = (a) => Array.isArray(a) && a.every((l) => l && l.p && Array.isArray(l.stops) && l.stops.length >= 2 && GENS.includes(l.gen));
  function restore(o) {
    raw = o && typeof o === "object" ? o : {};
    if (Array.isArray(raw.devices)) { S.devices = raw.devices.filter(okDev); nextId = Math.max(0, ...S.devices.map((d) => d.id)) + 1; }
    if (okL(raw.layers) && raw.layers.length) S.layers = raw.layers;
    if (typeof raw.playing === "boolean") S.playing = raw.playing;
    if (Array.isArray(raw.mine)) S.mine = raw.mine.filter((m) => m && okL(m.layers));
    if (Array.isArray(raw.seen)) S.seen = raw.seen.filter((x) => typeof x === "string");
    for (const k of ["view", "plane", "snap", "sel", "selLayer", "origin", "speed", "bright", "fxName", "cam", "zoom2", "pan2"]) if (raw[k] != null) S[k] = raw[k];
    if (!["3d", "2d"].includes(S.view)) S.view = "3d";
    if (!["top", "front"].includes(S.plane)) S.plane = "top";
    if (!Array.isArray(S.origin) || S.origin.length !== 3) S.origin = [0, 18, 0];
    if (!S.devices.find((d) => d.id === S.sel)) S.sel = null;
    S.selLayer = clamp(S.selLayer | 0, 0, Math.max(0, S.layers.length - 1));
    S.cam = Object.assign({ yaw: 0.55, pitch: 0.5, dist: 150 }, S.cam);
    if (!Array.isArray(S.cam.t) || S.cam.t.length !== 3) S.cam.t = [0, 18, 0];
    if (!Array.isArray(S.pan2) || S.pan2.length !== 2) S.pan2 = [0, 0];
    S.zoom2 = S.zoom2 || 1;
    syncGoal();
  }
  /** puts devices OpenRGB reports for the first time into the scene (never again after the user removed one) */
  function mergeReal() {
    if (!real) return false;
    let changed = false;
    for (const r of real) {
      if (S.seen.includes(r.key)) continue;
      S.seen.push(r.key); changed = true;
      if (S.devices.some((d) => linkKey(d.link) === r.key)) continue;
      placeReal(r);
    }
    return changed;
  }
  function placeReal(r) {
    const k = S.devices.filter((d) => d.type === r.type).length, sp = defaultSpot(r.type, k);
    const d = mkDev(r.type, r.name, layout(r.type, r.n), sp[0], sp[1], sp[2], sp[3], r.link);
    S.devices.push(d); return d;
  }

  /* ---------------- helpers ---------------- */
  const ICO = {
    up: '<svg viewBox="0 0 16 16"><path d="M4 10l4-4 4 4"/></svg>', down: '<svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></svg>',
    del: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>', dup: '<svg viewBox="0 0 16 16"><path d="M5.5 5.5h7v7h-7zM3.5 10.5v-7h7"/></svg>',
    play: '<svg class="fill" viewBox="0 0 16 16"><path d="M5 3l8 5-8 5z"/></svg>', pause: '<svg class="fill" viewBox="0 0 16 16"><path d="M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z"/></svg>',
    rot: '<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3"/></svg>', grip: '<svg viewBox="0 0 16 16"><path d="M5 4h6M5 8h6M5 12h6"/></svg>',
    plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>', dice: '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><path d="M5.5 5.5h.01M10.5 10.5h.01M8 8h.01"/></svg>',
  };
  let BID = 0; const B = {};
  function rng(label, val, min, max, step, fmt, fn, tip, id, inl) {
    const b = "b" + (++BID); B[b] = { fn, fmt, min, max };
    const inp = `<input class="rline" type="range" data-b="${b}" ${id ? `id="${id}"` : ""} min="${min}" max="${max}" step="${step}" value="${val}" style="--p:${(val - min) / (max - min) * 100}%" aria-label="${label}">`;
    return inl ? `<div class="ra-row inl" title="${tip || ""}"><span class="cap">${label}</span>${inp}<span class="ra-val">${fmt(val)}</span></div>`
      : `<div class="ra-row" title="${tip || ""}"><div class="ra-l"><span class="cap">${label}</span><span class="ra-val">${fmt(val)}</span></div>${inp}</div>`;
  }
  function wire(el) {
    el.querySelectorAll("input[data-b]").forEach((inp) => {
      const b = B[inp.dataset.b];
      inp.addEventListener("input", () => {
        const v = +inp.value; inp.style.setProperty("--p", ((v - b.min) / (b.max - b.min) * 100) + "%");
        const vl = inp.parentElement.querySelector(".ra-val"); if (vl) vl.textContent = b.fmt(v);
        b.fn(v);
      });
      // DESIGN.md: wheel on a set value = 5 % per notch
      inp.addEventListener("wheel", (e) => {
        e.preventDefault();
        const st = (b.max - b.min) * 0.05, v = clamp(Math.round((+inp.value - Math.sign(e.deltaY) * st) / (+inp.step || 1)) * (+inp.step || 1), b.min, b.max);
        inp.value = v; inp.dispatchEvent(new Event("input"));
      }, { passive: false });
    });
  }
  function setRange(el, v) { if (!el) return; const b = B[el.dataset.b]; el.value = v; el.style.setProperty("--p", ((v - b.min) / (b.max - b.min) * 100) + "%"); el.parentElement.querySelector(".ra-val").textContent = b.fmt(+el.value); }
  const gradCss = (st) => `linear-gradient(90deg,${st.map((s) => `${s.c} ${(s.p * 100).toFixed(1)}%`).join(",")})`;

  /* popovers: one at a time, anchored in a .ra-pa wrapper */
  let POP = null;
  function closePop() { if (POP) { POP.el.remove(); POP = null; } }
  function openPop(anchor, cls, fill) {
    if (POP && POP.a === anchor) { closePop(); return; }
    closePop();
    const el = document.createElement("div"); el.className = "ra-pop " + (cls || "");
    anchor.parentElement.appendChild(el); POP = { a: anchor, el }; fill(el); wire(el);
  }
  const onDocDown = (e) => { if (POP && !POP.el.contains(e.target) && !POP.a.contains(e.target)) closePop(); };

  /* ---------------- mount ---------------- */
  async function render(container) {
    leave();
    const my = ++gen;
    root = container;
    let sc = null;
    try { sc = await api.invoke("rgb_scene_get"); if (typeof sc === "string") sc = JSON.parse(sc); if (sc && typeof sc === "object" && "ok" in sc && "scene" in sc) sc = sc.scene; } catch (_) { /* no saved scene yet */ }
    if (my !== gen) return;
    restore(sc);
    build();
    document.addEventListener("pointerdown", onDocDown);
    window.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", wake);
    refreshReal(my);
  }
  /** asks OpenRGB which devices exist; the scene is usable (and editable) before this answers */
  async function refreshReal(my) {
    let s = null;
    try { s = await api.invoke("rgb_status"); } catch (_) { return; }
    if (my !== gen || !s || !s.installed) return;
    let devs;
    try { devs = await api.invoke("rgb_start"); } catch (_) { return; }
    if (my !== gen || !Array.isArray(devs)) return;
    real = realList(devs);
    const added = mergeReal();
    renderDevices();
    if (added) persist(); else mark("geom");
  }
  function leave() {
    gen++;
    if (saveT) save();
    cancelAnimationFrame(raf); raf = 0;
    closePop();
    if (ro) { ro.disconnect(); ro = null; }
    document.removeEventListener("pointerdown", onDocDown);
    window.removeEventListener("keydown", onKey);
    document.removeEventListener("visibilitychange", wake);
    cv = null; ctx = null; bgc = bgx = null;
    if (mount) { mount.remove(); mount = null; }
    root = null;
    PT.clear(); drag = null; pinch = null;
  }

  function build() {
    const el = document.createElement("div");
    el.className = "ra";
    el.innerHTML = `
    <div class="ra-adv">
      <div class="ra-col">
        <div class="card2 pad ra-stage">
          <div class="ra-tb">
            <span class="seg ra-s" id="vSeg"><button data-v="3d">3D</button><button data-v="2d">2D</button></span>
            <span class="seg ra-s" id="pSeg"></span>
            <button class="btn ra-sm" id="fit" title="${t("ra.fitTip")}">${t("ra.fit")}</button>
            <span class="sp"></span>
            <span class="ra-pa"><button class="btn ra-sm" id="orgb" title="${t("ra.originTip")}">${t("ra.origin")}</button></span>
          </div>
          <div class="ra-cvwrap"><canvas class="ra-cv" id="cv" aria-label="${t("ra.stage")}" title="${t("ra.stageTip")}"></canvas></div>
          <div class="ra-tp">
            <button class="btn ra-ic" id="play" title="${t("ra.playTip")}" aria-label="${t("ra.playTip")}"></button>
            <input class="rline" id="scrub" type="range" min="0" max="300" value="0" aria-label="${t("ra.phase")}" title="${t("ra.phaseTip")}">
            <span class="ra-val" id="tv">0.0 s</span>
            <span class="ra-pa"><button class="btn ra-sm" id="tune" title="${t("ra.tuneTip")}">${t("ra.tune")}</button></span>
          </div>
        </div>
        <div class="card2 pad" id="devp"></div>
      </div>
      <div class="ra-col"><div class="card2 pad ra-pick ra-fx" id="fxp"></div></div>
    </div>`;
    root.appendChild(el); mount = el;
    cv = $("#cv"); ctx = cv.getContext("2d"); bgc = document.createElement("canvas"); bgx = bgc.getContext("2d");
    ro = new ResizeObserver(() => {
      DPR = Math.min(2, window.devicePixelRatio || 1); CW = cv.clientWidth; CH = cv.clientHeight;
      cv.width = bgc.width = Math.max(1, Math.round(CW * DPR)); cv.height = bgc.height = Math.max(1, Math.round(CH * DPR));
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0); bgx.setTransform(DPR, 0, 0, DPR, 0, 0); mark("view");
    });
    ro.observe(cv);
    syncTb(); syncPlay(); renderDevices(); renderFx(); bindStage();
    mark();
  }
  function syncTb() {
    [...$("#vSeg").children].forEach((b) => b.classList.toggle("on", b.dataset.v === S.view));
    const names = S.view === "3d" ? ["iso", "top", "front", "side"] : ["top", "front"];
    $("#pSeg").innerHTML = names.map((n) => `<button data-p="${n}" class="${S.view === "2d" && S.plane === n ? "on" : ""}">${t("ra." + n)}</button>`).join("");
  }
  function syncPlay() { $("#play").innerHTML = S.playing ? ICO.pause : ICO.play; }

  /* ----- devices ----- */
  const snap = (v) => (S.snap ? Math.round(v / S.snap) * S.snap : v);
  const keyed = () => new Set(S.devices.map((d) => linkKey(d.link)).filter(Boolean));
  function renderDevices() {
    const el = $("#devp"); if (!el) return; closePop();
    const nl = S.devices.reduce((a, x) => a + x.n, 0);
    const free = real ? real.filter((r) => !keyed().has(r.key)) : [];
    el.innerHTML = `<div class="ra-fxhd"><span class="cap">${t("ra.devices")}</span><span class="ra-note" title="${t("ra.ledsTip")}">${S.devices.length} · ${nl} LED</span><span class="sp"></span><span class="ra-pa"><button class="btn ra-sm" id="addb" title="${t("ra.addTip")}" ${free.length ? "" : "disabled"}>+ ${t("ra.add")}</button></span></div>
      <div class="ra-devl">${S.devices.map((x) => { const on = x.id === S.sel, off = real && x.link && !real.some((r) => r.key === linkKey(x.link));
        return `<button class="ra-dr ${on ? "on" : ""}" data-id="${x.id}"><b>${esc(x.name)}</b>${off ? `<span class="ra-tag" title="${t("ra.offlineTip")}">${t("ra.offline")}</span>` : ""}<small>${x.n}</small></button>` + (on ? `
        <div class="ra-insp"><span class="ra-scan" data-m="${x.id}">${"<b></b>".repeat(Math.min(x.n, 24))}</span>
          ${rng("X", x.x, -60, 60, 0.5, (v) => v.toFixed(1), (v) => { x.x = v; persist(); }, t("ra.xTip"), "i-x", 1)}
          ${rng("Y", x.y, 0, 60, 0.5, (v) => v.toFixed(1), (v) => { x.y = v; persist(); }, t("ra.yTip"), "i-y", 1)}
          ${rng("Z", x.z, -40, 40, 0.5, (v) => v.toFixed(1), (v) => { x.z = v; persist(); }, t("ra.zTip"), "i-z", 1)}
          ${rng(t("ra.rotate"), x.rot, 0, 359, 1, (v) => v + "°", (v) => { x.rot = S.snap ? Math.round(v / 15) * 15 % 360 : v; persist(); }, t("ra.rotTip"), "i-rot", 1)}
          ${rng(t("ra.scale"), x.sc, 0.5, 2, 0.05, (v) => v.toFixed(2) + "×", (v) => { x.sc = v; persist(); }, t("ra.scaleTip"), "i-sc", 1)}
          <div class="ra-grow"><span class="seg ra-s" id="sSeg" title="${t("ra.snapTip")}">${[["0", t("ra.free")], ["1", "1"], ["2", "2"], ["5", "5"]].map((s) => `<button data-s="${s[0]}" class="${+s[0] === S.snap ? "on" : ""}">${s[1]}</button>`).join("")}</span><span class="sp"></span>
            <button class="btn ra-ic" id="drot" title="${t("ra.rot90")}" aria-label="${t("ra.rot90")}">${ICO.rot}</button>
            <button class="btn ra-ic" id="ddup" title="${t("ra.dup")}" aria-label="${t("ra.dup")}">${ICO.dup}</button>
            <button class="btn ra-ic" id="ddel" title="${t("ra.remove")}" aria-label="${t("ra.remove")}">${ICO.del}</button></div></div>` : ""); }).join("")}</div>`;
    wire(el);
    el.querySelectorAll(".ra-dr").forEach((b) => { b.onclick = () => { S.sel = +b.dataset.id; renderDevices(); persist(); }; });
    $("#addb").onclick = (e) => openPop(e.currentTarget, "ra-r", (p) => {
      p.innerHTML = `<div class="ra-menu">${free.map((r, i) => `<button class="ra-mi" data-add="${i}">${ICO.plus}${esc(r.name)}<small class="ra-note">${r.n}</small></button>`).join("")}</div>`;
      p.querySelectorAll("[data-add]").forEach((b) => { b.onclick = () => addReal(free[+b.dataset.add]); });
    });
    const d = selDev();
    if (d) {
      $("#sSeg").onclick = (e) => { const v = e.target.dataset.s; if (v != null) { S.snap = +v; [...$("#sSeg").children].forEach((b) => b.classList.toggle("on", b === e.target)); persist(); } };
      $("#drot").onclick = () => rotDev(d, 90); $("#ddel").onclick = () => removeDev(d.id);
      $("#ddup").onclick = () => {
        const n = Object.assign({}, d, { id: nextId++, name: App.t("ra.devCopy", { name: d.name }), link: undefined, x: clamp(d.x + 4, -60, 60), z: clamp(d.z + 4, -40, 40) });
        delete n._b; S.devices.push(n); S.sel = n.id; renderDevices(); persist();
      };
    }
  }
  function updInsp() { const d = selDev(); if (!d) return; setRange($("#i-x"), d.x); setRange($("#i-y"), d.y); setRange($("#i-z"), d.z); setRange($("#i-rot"), d.rot); setRange($("#i-sc"), d.sc); }
  function rotDev(d, a) { d.rot = (d.rot + a) % 360; updInsp(); persist(); }
  function addReal(r) { const d = placeReal(r); S.sel = d.id; renderDevices(); persist(); }
  function removeDev(id) { S.devices = S.devices.filter((d) => d.id !== id); if (S.sel === id) S.sel = null; renderDevices(); persist(); }

  /* ----- effect panel ----- */
  const PDEF = {
    speed: { k: "ra.speed", min: -3, max: 3, step: 0.05, f: (v) => v.toFixed(2) + "×", tip: "ra.speedFxTip" },
    scale: { k: "ra.scale", min: 0.25, max: 4, step: 0.05, f: (v) => v.toFixed(2) + "×", tip: "ra.scaleFxTip" },
    rot: { k: "ra.rotate", min: 0, max: 359, step: 1, f: (v) => v + "°", tip: "ra.rotFxTip" },
    ease: { k: "ra.ease", min: 0, max: 1, step: 0.01, f: (v) => Math.round(v * 100) + "%", tip: "ra.easeTip" },
    trail: { k: "ra.trail", min: 0, max: 1, step: 0.01, f: (v) => Math.round(v * 100) + "%", tip: "ra.trailTip" },
    width: { k: "ra.width", min: 1, max: 30, step: 0.5, f: (v) => v + " cm", tip: "ra.widthTip" },
  };
  const GP = { wave: ["speed", "scale", "rot", "ease"], radial: ["speed", "scale", "width", "trail", "ease"], rainbow: ["speed", "scale", "rot", "ease"], noise: ["speed", "scale", "rot", "ease"],
    scan: ["speed", "width", "trail", "rot", "ease"], solid: ["speed", "ease"], sparkle: ["speed", "scale", "width", "trail"], audio: ["rot", "ease"] };
  const HASDIR = { wave: 1, rainbow: 1, noise: 1, scan: 1, audio: 1 };
  const gName = (g) => t("ra.g." + g);

  function renderFx() {
    const el = $("#fxp"); if (!el) return; closePop();
    el.innerHTML = `<div class="ra-fxhd"><span class="ra-pa"><button class="btn" id="fxm" title="${t("ra.fxTip")}"><span id="fxname">${esc(fxLabel(S.fxName))}</span>${ICO.down}</button></span><span class="sp"></span>
      <span class="ra-pa"><button class="btn ra-sm" id="addl" title="${t("ra.addLayerTip")}">+ ${t("ra.layer")}</button></span></div>
      <div class="ra-layers" id="layers" title="${t("ra.layersTip")}"></div>`;
    $("#fxm").onclick = (e) => openPop(e.currentTarget, "", (p) => {
      p.innerHTML = `<div class="ra-menu"><div class="cap ra-mh">${t("ra.presets")}</div>${PRESETS.map((x, i) => `<button class="ra-mi ${S.fxName === x.name ? "on" : ""}" data-p="${i}">${t(x.key)}</button>`).join("")}
        ${S.mine.length ? `<div class="cap ra-mh">${t("ra.mine")}</div>${S.mine.map((m, i) => `<div class="ra-mrow"><button class="ra-mi ${S.fxName === m.name ? "on" : ""}" data-m="${i}">${esc(m.name)}</button><button class="btn ra-ic" data-md="${i}" title="${t("ra.del")}" aria-label="${t("ra.del")}">${ICO.del}</button></div>`).join("")}` : ""}
        <div class="ra-sep"></div><button class="ra-mi" id="fxr" title="${t("ra.randomTip")}">${ICO.dice}${t("ra.random")}</button>
        <div class="ra-save"><input type="text" id="fxn" maxlength="28" placeholder="${t("ra.name")}" aria-label="${t("ra.name")}"><button class="btn ra-sm" id="fxs" title="${t("ra.saveTip")}">${t("ra.save")}</button></div></div>`;
      p.querySelectorAll("[data-p]").forEach((b) => { b.onclick = () => loadPreset(+b.dataset.p); });
      p.querySelectorAll("[data-m]").forEach((b) => { b.onclick = () => { const m = S.mine[+b.dataset.m]; S.layers = cl(m.layers); S.fxName = m.name; S.selLayer = 0; renderFx(); persist(); }; });
      p.querySelectorAll("[data-md]").forEach((b) => { b.onclick = () => { S.mine.splice(+b.dataset.md, 1); renderFx(); persist(); }; });
      p.querySelector("#fxr").onclick = randomise;
      p.querySelector("#fxs").onclick = () => {
        const typed = (p.querySelector("#fxn").value || "").trim();
        const n = typed || (S.fxName === "Custom" || S.fxName === "Random" ? App.t("ra.myEffect", { n: S.mine.length + 1 }) : App.t("ra.copy", { name: fxLabel(S.fxName) }));
        S.mine.push({ name: n, layers: cl(S.layers) }); S.fxName = n; renderFx(); persist();
      };
    });
    $("#addl").onclick = (e) => openPop(e.currentTarget, "ra-r", (p) => {
      p.innerHTML = `<div class="ra-menu">${GENS.map((g) => `<button class="ra-mi" data-g="${g}">${ICO.plus}${gName(g)}</button>`).join("")}</div>`;
      p.querySelectorAll("[data-g]").forEach((b) => { b.onclick = () => { S.layers.push(newLayer(b.dataset.g)); S.selLayer = S.layers.length - 1; S.fxName = "Custom"; renderFx(); persist(); }; });
    });
    renderLayers();
  }
  function newLayer(g) {
    const st = { wave: [[0, "#0b0c0a"], [1, "#c6f432"]], radial: [[0, "#38b6ff"], [1, "#ffffff"]], rainbow: [[0, "#ff4d4d"], [0.17, "#ffb454"], [0.34, "#c6f432"], [0.5, "#2ee6a8"], [0.67, "#38b6ff"], [0.84, "#ff5fd2"], [1, "#ff4d4d"]],
      noise: [[0, "#000000"], [1, "#2ee6a8"]], scan: [[0, "#c6f432"], [1, "#c6f432"]], solid: [[0, "#38b6ff"], [1, "#8a6bff"]], sparkle: [[0, "#ffffff"], [1, "#ffffff"]], audio: [[0, "#2ee6a8"], [1, "#ff4d4d"]] }[g];
    return mkL(g, g === "sparkle" ? { width: 3, speed: 1.2 } : {}, st, S.layers.length ? (MASK[g] ? "add" : "mix") : "add", MASK[g] || !S.layers.length ? 1 : 0.6);
  }
  function loadPreset(i) {
    const p = PRESETS[i]; S.layers = p.layers(); S.fxName = p.name; S.selLayer = S.layers.length - 1;
    if (p.origin === "gpu") { const g = S.devices.find((d) => d.type === "gpu"); if (g) S.origin = [g.x, g.y, g.z]; }
    renderFx(); persist();
  }
  function randomise() {
    const pick = (a) => a[Math.floor(Math.random() * a.length)], rr = (a, b) => a + Math.random() * (b - a);
    const n = 1 + Math.floor(Math.random() * 3), L = [];
    for (let i = 0; i < n; i++) {
      const g = pick(GENS.filter((x) => x !== "audio" || Math.random() < 0.15)), k = 2 + Math.floor(Math.random() * 3);
      const cols = Array.from({ length: k }, () => pick(SW));
      if (!MASK[g] && Math.random() < 0.7) cols[0] = "#0b0c0a";
      L.push(mkL(g, { speed: +(rr(0.4, 2) * (Math.random() < 0.2 ? -1 : 1)).toFixed(2), scale: +rr(0.5, 2.5).toFixed(2), rot: Math.floor(rr(0, 360)), axis: Math.floor(rr(0, 3)), mirror: Math.random() < 0.25,
        ease: +(Math.random() < 0.5 ? rr(0, 0.8) : 0).toFixed(2), trail: +rr(0.2, 0.9).toFixed(2), width: Math.round(rr(2, 12)) }, cols.map((c, j) => [+(j / (k - 1)).toFixed(2), c]), i === 0 ? (MASK[g] ? "add" : "mix") : pick(["add", "add", "max", "mix"]), i === 0 ? 1 : +rr(0.5, 1).toFixed(2)));
    }
    S.layers = L; S.fxName = "Random"; S.selLayer = 0; renderFx(); persist();
  }
  let dragFrom = -1;
  function moveLayer(a, b) { if (b < 0 || b >= S.layers.length || a === b) return; const [l] = S.layers.splice(a, 1); S.layers.splice(b, 0, l); S.selLayer = b; S.fxName = "Custom"; renderFx(); persist(); }
  function renderLayers() {
    const box = $("#layers"); if (!box) return;
    box.innerHTML = S.layers.map((L, i) => { const on = i === S.selLayer; return `<div class="ra-lay ${on ? "sel" : ""} ${L.on ? "" : "off"}" data-i="${i}">
      <div class="ra-lh" draggable="true" data-i="${i}"><span class="ra-grip" title="${t("ra.drag")}">${ICO.grip}</span>
        <button class="ra-pw" data-on="${i}" aria-pressed="${L.on}" aria-label="${t("ra.layerOn")}" title="${t(L.on ? "ra.disable" : "ra.enable")}"></button>
        <span class="ra-nm"><b>${gName(L.gen)}</b><small>${t("ra.b." + L.blend)} ${Math.round(L.opacity * 100)}%</small></span><span class="ra-gp" style="background:${gradCss(L.stops)}"></span>
        ${on ? `<button class="btn ra-ic" data-up="${i}" title="${t("ra.up")}" aria-label="${t("ra.up")}" ${i === S.layers.length - 1 ? "disabled" : ""}>${ICO.up}</button>
        <button class="btn ra-ic" data-dn="${i}" title="${t("ra.down")}" aria-label="${t("ra.down")}" ${i === 0 ? "disabled" : ""}>${ICO.down}</button>
        <button class="btn ra-ic" data-dup="${i}" title="${t("ra.dup")}" aria-label="${t("ra.dup")}">${ICO.dup}</button>
        <button class="btn ra-ic" data-rm="${i}" title="${t("ra.del")}" aria-label="${t("ra.del")}">${ICO.del}</button>` : ""}</div>
      ${on ? layerEditor(L) : ""}</div>`; }).join("") || `<div class="ra-note">${t("ra.noLayers")}</div>`;
    wire(box);
    box.querySelectorAll(".ra-lh").forEach((hd) => {
      const i = +hd.dataset.i;
      hd.onclick = (e) => { if (e.target.closest("button") && !e.target.closest(".ra-nm")) return; if (i !== S.selLayer) { S.selLayer = i; renderLayers(); persist(); } };
      hd.ondragstart = (e) => { dragFrom = i; e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", String(i)); } catch (x) { /* ignore */ } };
      hd.ondragover = (e) => { e.preventDefault(); hd.parentElement.classList.add("dragover"); };
      hd.ondragleave = () => hd.parentElement.classList.remove("dragover");
      hd.ondrop = (e) => { e.preventDefault(); hd.parentElement.classList.remove("dragover"); if (dragFrom >= 0) moveLayer(dragFrom, i); dragFrom = -1; };
    });
    const bind = (sel, fn) => box.querySelectorAll(sel).forEach((b) => { b.onclick = (e) => { e.stopPropagation(); fn(+b.dataset[Object.keys(b.dataset)[0]]); }; });
    bind("[data-on]", (i) => { S.layers[i].on = !S.layers[i].on; renderLayers(); persist(); });
    bind("[data-up]", (i) => moveLayer(i, i + 1)); bind("[data-dn]", (i) => moveLayer(i, i - 1));
    bind("[data-dup]", (i) => { S.layers.splice(i + 1, 0, cl(S.layers[i])); S.selLayer = i + 1; S.fxName = "Custom"; renderFx(); persist(); });
    bind("[data-rm]", (i) => { S.layers.splice(i, 1); S.selLayer = clamp(S.selLayer, 0, Math.max(0, S.layers.length - 1)); S.fxName = "Custom"; renderFx(); persist(); });
    const ed = box.querySelector(".ra-le"); if (ed) editorBind(ed, S.layers[S.selLayer]);
  }
  function layerEditor(L) {
    const mark1 = () => { S.fxName = "Custom"; const c = $("#fxname"); if (c) c.textContent = fxLabel("Custom"); persist(); };
    const sum = () => { const lh = $(".ra-lay.sel .ra-lh"); if (lh) { lh.querySelector("small").textContent = `${App.t("ra.b." + L.blend)} ${Math.round(L.opacity * 100)}%`; lh.querySelector(".ra-gp").style.background = gradCss(L.stops); } };
    L._sum = sum; L._mark = mark1;
    return `<div class="ra-le">
      <div class="ra-grow"><select class="ra-selx" data-gen aria-label="${t("ra.gen")}" title="${t("ra.gen")}">${GENS.map((g) => `<option value="${g}" ${g === L.gen ? "selected" : ""}>${gName(g)}</option>`).join("")}</select>
        <select class="ra-selx" data-blend aria-label="${t("ra.blend")}" title="${t("ra.blend")}">${BLENDS.map((b) => `<option value="${b}" ${b === L.blend ? "selected" : ""}>${t("ra.b." + b)}</option>`).join("")}</select>
        ${HASDIR[L.gen] ? `<span class="seg ra-s" data-axis title="${t("ra.dir")}">${["X", "Y", "Z"].map((a, i) => `<button data-v="${i}" class="${i === L.p.axis ? "on" : ""}">${a}</button>`).join("")}</span>
        <button class="ra-chip ${L.p.mirror ? "on" : ""}" data-mirror aria-pressed="${L.p.mirror}" title="${t("ra.mirrorTip")}">${t("ra.mirror")}</button>` : ""}</div>
      ${GP[L.gen].map((k) => { const d = PDEF[k]; return rng(t(d.k), L.p[k], d.min, d.max, d.step, d.f, (v) => { L.p[k] = v; mark1(); }, t(d.tip), null, 1); }).join("")}
      <div data-grad></div>
      ${rng(t("ra.opacity"), Math.round(L.opacity * 100), 0, 100, 1, (v) => v + "%", (v) => { L.opacity = v / 100; sum(); mark1(); }, "", null, 1)}
      ${L.gen === "audio" ? `<div class="ra-scan" id="lvl" title="${t("ra.audioTip")}">` + "<b></b>".repeat(24) + "</div>" : ""}
    </div>`;
  }
  function editorBind(ed, L) {
    ed.querySelector("[data-gen]").onchange = (e) => { L.gen = e.target.value; L.stops = newLayer(L.gen).stops; S.fxName = "Custom"; renderLayers(); persist(); const c = $("#fxname"); if (c) c.textContent = fxLabel("Custom"); };
    ed.querySelector("[data-blend]").onchange = (e) => { L.blend = e.target.value; L._sum(); L._mark(); };
    const ax = ed.querySelector("[data-axis]"); if (ax) ax.onclick = (e) => { const v = e.target.dataset.v; if (v == null) return; L.p.axis = +v; [...ax.children].forEach((b) => b.classList.toggle("on", b === e.target)); L._mark(); };
    const m = ed.querySelector("[data-mirror]"); if (m) m.onclick = () => { L.p.mirror = !L.p.mirror; m.classList.toggle("on", L.p.mirror); L._mark(); };
    mountGrad(ed.querySelector("[data-grad]"), L);
  }
  function mountGrad(el, L) {
    let cur = L.stops[0];
    el.innerHTML = `<div class="ra-gbar" title="${t("ra.gradTip")}"></div>
      <div class="ra-grow"><input type="color" aria-label="${t("ra.stopColour")}" title="${t("ra.stopColour")}"><span class="ra-val" data-pos></span><span class="sp"></span><button class="btn ra-sm" data-rs title="${t("ra.stopRemove")}">${t("ra.removeBtn")}</button></div>`;
    el.className = "ra-gedit";
    const bar = el.querySelector(".ra-gbar"), ci = el.querySelector("input"), pv = el.querySelector("[data-pos]"), rs = el.querySelector("[data-rs]");
    const paint = () => {
      ci.value = cur.c; pv.textContent = Math.round(cur.p * 100) + "%"; rs.disabled = L.stops.length <= 2;
      bar.querySelectorAll(".ra-gs").forEach((hd, i) => hd.classList.toggle("on", L.stops[i] === cur));
    };
    const sync = () => {
      L.stops.sort((a, b) => a.p - b.p); bar.style.background = gradCss(L.stops); L._sum(); L._mark();
      bar.querySelectorAll(".ra-gs").forEach((x) => x.remove());
      L.stops.forEach((s) => {
        const hd = document.createElement("div"); hd.className = "ra-gs"; hd.style.left = s.p * 100 + "%"; hd.style.background = s.c; hd.setAttribute("aria-label", App.t("ra.stopColour"));
        hd.addEventListener("pointerdown", (e) => { e.stopPropagation(); e.preventDefault(); cur = s; hd.setPointerCapture(e.pointerId); hd.dataset.drag = 1; paint(); });
        hd.addEventListener("pointermove", (e) => {
          if (!hd.dataset.drag) return;
          const r = bar.getBoundingClientRect(); s.p = clamp((e.clientX - r.left) / r.width, 0, 1); hd.style.left = s.p * 100 + "%";
          L.stops.sort((a, b) => a.p - b.p); bar.style.background = gradCss(L.stops); pv.textContent = Math.round(s.p * 100) + "%"; L._sum(); L._mark();
        });
        hd.addEventListener("pointerup", () => { delete hd.dataset.drag; sync(); });
        bar.appendChild(hd);
      });
      paint();
    };
    bar.addEventListener("pointerdown", (e) => {
      if (e.target !== bar) return;
      const r = bar.getBoundingClientRect(), p = clamp((e.clientX - r.left) / r.width, 0, 1), c = gradAt(L.stops, p, [0, 0, 0]);
      cur = { p, c: "#" + c.map((x) => Math.round(x).toString(16).padStart(2, "0")).join("") }; L.stops.push(cur); sync();
    });
    ci.oninput = () => { cur.c = ci.value; sync(); };
    rs.onclick = () => { if (L.stops.length > 2) { L.stops.splice(L.stops.indexOf(cur), 1); cur = L.stops[0]; sync(); } };
    sync();
  }

  /* ---------------- stage: camera + projection ---------------- */
  const pr = [0, 0, 0, 1]; const CAM = { c: [0, 0, 0], f: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0], foc: 400 };
  const G = { yaw: 0, pitch: 0, dist: 150, t: [0, 18, 0] };   // camera goal, eased towards each frame
  function setupCam() {
    const { yaw, pitch, dist, t: tg } = S.cam, cp = Math.cos(pitch);
    const cx = tg[0] + dist * cp * Math.sin(yaw), cy = tg[1] + dist * Math.sin(pitch), cz = tg[2] + dist * cp * Math.cos(yaw);
    let fx = tg[0] - cx, fy = tg[1] - cy, fz = tg[2] - cz; const fl = Math.hypot(fx, fy, fz); fx /= fl; fy /= fl; fz /= fl;
    let rx = fz, rz = -fx; const rl = Math.hypot(rx, rz); rx /= rl; rz /= rl;      // cross(f, up)
    const ux = 0 * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - 0 * fx;
    CAM.c[0] = cx; CAM.c[1] = cy; CAM.c[2] = cz; CAM.f[0] = fx; CAM.f[1] = fy; CAM.f[2] = fz; CAM.r[0] = rx; CAM.r[1] = 0; CAM.r[2] = rz; CAM.u[0] = ux; CAM.u[1] = uy; CAM.u[2] = uz;
    CAM.foc = Math.min(CW * 1.15, CH * 1.4);
  }
  const PRESET_CAMS = { iso: { yaw: 0.55, pitch: 0.5 }, top: { yaw: 0, pitch: 1.45 }, front: { yaw: 0, pitch: 0.04 }, side: { yaw: Math.PI / 2, pitch: 0.04 } };
  function k2() { return (S.plane === "top" ? Math.min(CW / 112, CH / 72) : Math.min(CW / 112, CH / 62)) * S.zoom2; }
  function proj(x, y, z) {
    if (S.view === "3d") {
      const vx = x - CAM.c[0], vy = y - CAM.c[1], vz = z - CAM.c[2], zc = vx * CAM.f[0] + vy * CAM.f[1] + vz * CAM.f[2];
      if (zc < 1) return false;
      pr[0] = CW / 2 + (vx * CAM.r[0] + vy * CAM.r[1] + vz * CAM.r[2]) / zc * CAM.foc; pr[1] = CH / 2 - (vx * CAM.u[0] + vy * CAM.u[1] + vz * CAM.u[2]) / zc * CAM.foc; pr[2] = zc; pr[3] = CAM.foc / zc;
    } else if (S.plane === "top") { const k = k2(); pr[0] = CW / 2 + (x - S.pan2[0]) * k; pr[1] = CH / 2 + (z - S.pan2[1]) * k; pr[2] = 0; pr[3] = k; }
    else { const k = k2(); pr[0] = CW / 2 + (x - S.pan2[0]) * k; pr[1] = CH / 2 - (y - 25 - S.pan2[1]) * k; pr[2] = 0; pr[3] = k; }
    return true;
  }
  function planePt(mx, my, ref) {      // screen pixel -> world point on the plane through ref
    if (S.view === "3d") {
      const a = (mx - CW / 2) / CAM.foc, b = -(my - CH / 2) / CAM.foc;
      const dx = CAM.f[0] + CAM.r[0] * a + CAM.u[0] * b, dy = CAM.f[1] + CAM.r[1] * a + CAM.u[1] * b, dz = CAM.f[2] + CAM.r[2] * a + CAM.u[2] * b;
      if (Math.abs(dy) < 1e-4) return ref.slice(); const tt = (ref[1] - CAM.c[1]) / dy; if (tt < 0) return ref.slice();
      return [CAM.c[0] + dx * tt, ref[1], CAM.c[2] + dz * tt];
    }
    const k = k2();
    return S.plane === "top" ? [(mx - CW / 2) / k + S.pan2[0], ref[1], (my - CH / 2) / k + S.pan2[1]] : [(mx - CW / 2) / k + S.pan2[0], 25 + S.pan2[1] - (my - CH / 2) / k, ref[2]];
  }
  function stepCam() {
    const c = S.cam;
    for (const k of ["yaw", "pitch", "dist"]) { const d = G[k] - c[k]; if (Math.abs(d) > 1e-3) { c[k] += d * 0.22; D.view = true; } else c[k] = G[k]; }
    for (let i = 0; i < 3; i++) { const d = G.t[i] - c.t[i]; if (Math.abs(d) > 1e-2) { c.t[i] += d * 0.22; D.view = true; } else c.t[i] = G.t[i]; }
  }
  function camGoal(p) {   // p: partial { yaw, pitch, dist, t }
    if (p.yaw != null) { let d = p.yaw - S.cam.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); G.yaw = S.cam.yaw + d; }
    if (p.pitch != null) G.pitch = p.pitch; if (p.dist != null) G.dist = p.dist; if (p.t) G.t = p.t.slice();
    wake();
  }
  function fitView() { if (S.view === "3d") camGoal({ dist: 150, t: [0, 18, 0] }); else { S.zoom2 = 1; S.pan2 = [0, 0]; mark("view"); } persist(); }
  function resetView() { if (S.view === "3d") camGoal({ yaw: 0.55, pitch: 0.5, dist: 150, t: [0, 18, 0] }); else { S.zoom2 = 1; S.pan2 = [0, 0]; mark("view"); } persist(); }
  function syncGoal() { G.yaw = S.cam.yaw; G.pitch = S.cam.pitch; G.dist = S.cam.dist; G.t = S.cam.t.slice(); }
  function zoomAt(mx, my, f) {
    if (S.view === "3d") {
      setupCam(); const ref = [0, S.cam.t[1], 0], p0 = planePt(mx, my, ref);
      S.cam.dist = clamp(S.cam.dist * f, 40, 320); setupCam(); const p1 = planePt(mx, my, ref);
      S.cam.t[0] += p0[0] - p1[0]; S.cam.t[2] += p0[2] - p1[2]; syncGoal();
    } else {
      const ref = [0, 0, 0], p0 = planePt(mx, my, ref); S.zoom2 = clamp(S.zoom2 / f, 0.5, 6); const p1 = planePt(mx, my, ref);
      S.pan2[0] += p0[0] - p1[0]; if (S.plane === "top") S.pan2[1] += p0[2] - p1[2]; else S.pan2[1] += p0[1] - p1[1];
    }
    mark("view");
  }
  function panBy(dx, dy) {
    if (S.view === "3d") { const sc = S.cam.dist / CAM.foc; for (let i = 0; i < 3; i++) S.cam.t[i] += -CAM.r[i] * dx * sc + CAM.u[i] * dy * sc; syncGoal(); }
    else { const k = k2(); S.pan2[0] -= dx / k; S.pan2[1] += (S.plane === "top" ? -dy : dy) / k; }
    mark("view");
  }

  /* ---------------- stage: LED buffers (preallocated, rebuilt only on change) ---------------- */
  let NL = 0, LP = new Float32Array(3), XS = new Float32Array(1), YS = new Float32Array(1), DS = new Float32Array(1), RS = new Float32Array(1), CR = new Float32Array(1), CG = new Float32Array(1), CB = new Float32Array(1), ORD = new Uint32Array(1);
  const DST = [];
  function rebuildGeom() {
    let n = 0; for (const d of S.devices) n += d.n;
    if (n !== NL) { NL = n; const m = Math.max(1, n); LP = new Float32Array(m * 3); XS = new Float32Array(m); YS = new Float32Array(m); DS = new Float32Array(m); RS = new Float32Array(m); CR = new Float32Array(m); CG = new Float32Array(m); CB = new Float32Array(m); ORD = new Uint32Array(m); }
    DST.length = 0; let o = 0;
    for (const d of S.devices) {
      DST.push(o); const pts = ptsOf(d), a = d.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      for (let i = 0; i < pts.length; i++, o++) {
        const p = pts[i];
        LP[o * 3] = d.x + (p[0] * c + p[2] * s) * d.sc; LP[o * 3 + 1] = d.y + p[1] * d.sc; LP[o * 3 + 2] = d.z + (-p[0] * s + p[2] * c) * d.sc;
      }
    }
    DST.push(o);
  }
  function projectAll() {
    S.devices.forEach((d, di) => {
      const b = d._b || (d._b = [0, 0, 0, 0]); let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (let i = DST[di]; i < DST[di + 1]; i++) {
        if (proj(LP[i * 3], LP[i * 3 + 1], LP[i * 3 + 2])) {
          XS[i] = pr[0]; YS[i] = pr[1]; DS[i] = pr[2]; RS[i] = Math.max(1.8, pr[3] * 0.6);
          if (pr[0] < x0) x0 = pr[0]; if (pr[0] > x1) x1 = pr[0]; if (pr[1] < y0) y0 = pr[1]; if (pr[1] > y1) y1 = pr[1];
        } else XS[i] = NaN;
      }
      b[0] = x0 - 8; b[1] = y0 - 8; b[2] = x1 + 8; b[3] = y1 + 8;
    });
    for (let i = 0; i < NL; i++) ORD[i] = i;
    if (S.view === "3d") ORD.subarray(0, NL).sort((a, b) => DS[b] - DS[a]);
  }
  const wp = [0, 0, 0], OUT = [0, 0, 0], ENV = { origin: S.origin, level: 0, bright: 1 };
  const lvAt = (tm) => clamp(0.42 + 0.22 * Math.sin(tm * 3.1) + 0.14 * Math.sin(tm * 7.3 + 1) + 0.3 * Math.exp(-fract(tm * 2) * 4), 0, 1);
  function colorPass() {
    ENV.origin = S.origin; ENV.level = lvAt(S.t); ENV.bright = S.bright / 100;
    for (let i = 0; i < NL; i++) { wp[0] = LP[i * 3]; wp[1] = LP[i * 3 + 1]; wp[2] = LP[i * 3 + 2]; colorAt(S.layers, wp, S.t, ENV, OUT); CR[i] = OUT[0]; CG[i] = OUT[1]; CB[i] = OUT[2]; }
  }

  /* ---------------- stage: drawing ---------------- */
  const BG = "#090a08", GRID = "#1b1e16", EDGE = "#3a4030", MONO = '10px "JetBrains Mono",Consolas,monospace';
  function lnTo(ax, ay, az, bx, by, bz) {
    if (!proj(ax, ay, az)) return; const x0 = pr[0], y0 = pr[1];
    if (!proj(bx, by, bz)) return; ctx.moveTo(x0, y0); ctx.lineTo(pr[0], pr[1]);
  }
  function drawStatic() {      // case, desk, grid, device links, axis gizmo: only when the view or the geometry changes
    const main = ctx; ctx = bgx;
    ctx.fillStyle = BG; ctx.fillRect(0, 0, CW, CH); ctx.lineWidth = 1; ctx.strokeStyle = GRID; ctx.beginPath();
    if (S.view === "2d" && S.plane === "front") { for (let x = -50; x <= 50; x += 10) lnTo(x, 0, 0, x, 50, 0); for (let y = 0; y <= 50; y += 10) lnTo(-50, y, 0, 50, y, 0); }
    else { for (let x = -50; x <= 50; x += 10) lnTo(x, 0, -30, x, 0, 30); for (let z = -30; z <= 30; z += 10) lnTo(-50, 0, z, 50, 0, z); }
    ctx.stroke();
    ctx.strokeStyle = EDGE; ctx.beginPath();
    const x0 = -46, x1 = -24, z0 = -22, z1 = 22, y1 = 46;   // PC case, 22 x 44 x 46 cm
    lnTo(x0, 0, z0, x1, 0, z0); lnTo(x1, 0, z0, x1, 0, z1); lnTo(x1, 0, z1, x0, 0, z1); lnTo(x0, 0, z1, x0, 0, z0);
    lnTo(x0, y1, z0, x1, y1, z0); lnTo(x1, y1, z0, x1, y1, z1); lnTo(x1, y1, z1, x0, y1, z1); lnTo(x0, y1, z1, x0, y1, z0);
    lnTo(x0, 0, z0, x0, y1, z0); lnTo(x1, 0, z0, x1, y1, z0); lnTo(x1, 0, z1, x1, y1, z1); lnTo(x0, 0, z1, x0, y1, z1);
    ctx.stroke();
    ctx.strokeStyle = "#2a2f22"; ctx.beginPath(); const mx = -45.5;   // motherboard plate on the left panel
    lnTo(mx, 6, -20, mx, 6, 16); lnTo(mx, 6, 16, mx, 44, 16); lnTo(mx, 44, 16, mx, 44, -20); lnTo(mx, 44, -20, mx, 6, -20); ctx.stroke();
    ctx.fillStyle = "#6f7566"; ctx.font = MONO;
    if (proj(-35, 0, 22)) ctx.fillText(App.t("ra.case"), pr[0] - 12, pr[1] + 13);
    if (proj(34, 0, 22) && !(S.view === "2d" && S.plane === "front")) ctx.fillText(App.t("ra.desk"), pr[0] - 12, pr[1] + 14);
    ctx.strokeStyle = "#2f3527"; ctx.beginPath();      // links between neighbouring LEDs
    S.devices.forEach((d, di) => {
      const T = TYPES[d.type]; if (!T.link) return; const a = DST[di], b = DST[di + 1];
      for (let i = a; i < b; i++) { if (isNaN(XS[i])) continue; i === a ? ctx.moveTo(XS[i], YS[i]) : ctx.lineTo(XS[i], YS[i]); }
      if (T.link === 2 && !isNaN(XS[a])) ctx.lineTo(XS[a], YS[a]);
    });
    ctx.stroke();
    // axis gizmo, bottom left
    const ox = 34, oy = CH - 30, ax = [[1, 0, 0, "X"], [0, 1, 0, "Y"], [0, 0, 1, "Z"]]; ctx.font = MONO; ctx.lineWidth = 1.5;
    for (const [a, b, c, n] of ax) {
      let sx, sy;
      if (S.view === "3d") { sx = a * CAM.r[0] + b * CAM.r[1] + c * CAM.r[2]; sy = -(a * CAM.u[0] + b * CAM.u[1] + c * CAM.u[2]); }
      else if (S.plane === "top") { if (b) continue; sx = a; sy = c; } else { if (c) continue; sx = a; sy = -b; }
      ctx.strokeStyle = "#6f7566"; ctx.fillStyle = "#8e9484"; ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox + sx * 20, oy + sy * 20); ctx.stroke(); ctx.fillText(n, ox + sx * 27 - 3, oy + sy * 27 + 3);
    }
    ctx = main;
  }
  const FS = [];
  const fs = (r, g, b) => { const k = (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3); return FS[k] || (FS[k] = "rgb(" + (r & 248 | 4) + "," + (g & 248 | 4) + "," + (b & 248 | 4) + ")"); };
  let sOrg = [-99, -99]; const LIFT = [-99, -99];
  function paint() {
    ctx.drawImage(bgc, 0, 0, CW, CH);
    const is3 = S.view === "3d";
    for (let q = 0; q < NL; q++) {            // all LEDs in one pass, far to near
      const i = is3 ? ORD[q] : q; if (XS[i] !== XS[i]) continue;
      const lum = Math.max(CR[i], CG[i], CB[i]) / 255, k = 1 - lum;
      ctx.fillStyle = fs((CR[i] + 38 * k) | 0, (CG[i] + 42 * k) | 0, (CB[i] + 30 * k) | 0);
      if (lum > 0.1) { ctx.globalAlpha = lum * 0.22; ctx.beginPath(); ctx.arc(XS[i], YS[i], RS[i] * 2.6, 0, TAU); ctx.fill(); ctx.globalAlpha = 1; }
      ctx.beginPath(); ctx.arc(XS[i], YS[i], RS[i], 0, TAU); ctx.fill();
    }
    const d = selDev(); LIFT[0] = LIFT[1] = -99;
    if (d && d._b && isFinite(d._b[0])) {
      const b = d._b;
      ctx.fillStyle = "rgba(198,244,50,.07)"; ctx.fillRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
      ctx.strokeStyle = "#c6f432"; ctx.lineWidth = 2; ctx.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
      ctx.fillStyle = "#c6f432"; ctx.font = MONO; ctx.fillText(d.name.length > 32 ? d.name.slice(0, 31) + "…" : d.name, b[0], Math.max(10, b[1] - 6));
      if (is3) {
        const lx = (b[0] + b[2]) / 2, ly = Math.max(14, b[1] - 20); LIFT[0] = lx; LIFT[1] = ly;
        ctx.beginPath(); ctx.moveTo(lx, ly + 6); ctx.lineTo(lx, b[1]); ctx.lineWidth = 1; ctx.stroke();
        ctx.beginPath(); ctx.arc(lx, ly, 8, 0, TAU); ctx.fill(); ctx.strokeStyle = "#111"; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(lx, ly + 3.5); ctx.lineTo(lx, ly - 3.5); ctx.moveTo(lx - 3, ly - 0.5); ctx.lineTo(lx, ly - 3.5); ctx.lineTo(lx + 3, ly - 0.5); ctx.stroke();
      }
    }
    if (proj(S.origin[0], S.origin[1], S.origin[2])) {
      const x = pr[0], y = pr[1]; sOrg[0] = x; sOrg[1] = y;
      ctx.strokeStyle = "#c6f432"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 8, 0, TAU); ctx.moveTo(x - 14, y); ctx.lineTo(x - 4, y); ctx.moveTo(x + 4, y); ctx.lineTo(x + 14, y); ctx.moveTo(x, y - 14); ctx.lineTo(x, y - 4); ctx.moveTo(x, y + 4); ctx.lineTo(x, y + 14); ctx.stroke();
      ctx.fillStyle = "#c6f432"; ctx.beginPath(); ctx.arc(x, y, 2, 0, TAU); ctx.fill();
    } else { sOrg[0] = sOrg[1] = -99; }
  }

  /* ---------------- stage: interaction ---------------- */
  const PT = new Map(); let drag = null, pinch = null;
  function mpos(e) { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  function hit(mx, my) {
    if (Math.hypot(mx - LIFT[0], my - LIFT[1]) < 13) return { lift: true };
    if (Math.hypot(mx - sOrg[0], my - sOrg[1]) < 14) return { org: true };
    let best = null, ba = 1e12;
    for (const d of S.devices) { const b = d._b; if (!b || !isFinite(b[0])) continue; if (mx >= b[0] && mx <= b[2] && my >= b[1] && my <= b[3]) { const a = (b[2] - b[0]) * (b[3] - b[1]); if (a < ba) { ba = a; best = d; } } }
    return best ? { dev: best } : null;
  }
  function clampPos(v) { return [clamp(snap(v[0]), -60, 60), clamp(snap(v[1]), 0, 60), clamp(snap(v[2]), -40, 40)]; }
  function bindStage() {
    cv.addEventListener("contextmenu", (e) => e.preventDefault());
    cv.addEventListener("pointerdown", (e) => {
      cv.setPointerCapture(e.pointerId); const m = mpos(e); PT.set(e.pointerId, m);
      if (S.view === "3d") setupCam();
      if (PT.size === 2) { drag = null; const p = [...PT.values()]; pinch = { d: Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]), cx: (p[0][0] + p[1][0]) / 2, cy: (p[0][1] + p[1][1]) / 2 }; return; }
      if (PT.size > 2) return;
      const hh = hit(m[0], m[1]);
      if (e.button === 2 || (e.shiftKey && !hh)) drag = { k: "pan", lx: m[0], ly: m[1] };
      else if (hh && hh.lift) { drag = { k: "vert", d: selDev(), lx: m[0], ly: m[1] }; }
      else if (hh && hh.org) { const p = planePt(m[0], m[1], S.origin); drag = { k: "org", off: [S.origin[0] - p[0], S.origin[1] - p[1], S.origin[2] - p[2]], lx: m[0], ly: m[1] }; if (e.altKey || e.shiftKey) drag.k = "overt"; }
      else if (hh) {
        const d = hh.dev;
        if (S.sel !== d.id) { S.sel = d.id; renderDevices(); persist(); }
        const p0 = planePt(m[0], m[1], [d.x, d.y, d.z]); drag = { k: "dev", d, off: [d.x - p0[0], d.y - p0[1], d.z - p0[2]], lx: m[0], ly: m[1] };
        if ((e.altKey || e.shiftKey) && S.view === "3d") drag.k = "vert";
      } else drag = { k: S.view === "3d" ? "orbit" : "pan", lx: m[0], ly: m[1], moved: 0 };
      cv.style.cursor = "grabbing";
    });
    cv.addEventListener("pointermove", (e) => {
      const m = mpos(e); if (PT.has(e.pointerId)) PT.set(e.pointerId, m);
      if (PT.size === 2 && pinch) {
        const p = [...PT.values()], nd = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]), cx = (p[0][0] + p[1][0]) / 2, cy = (p[0][1] + p[1][1]) / 2;
        if (S.view === "3d") setupCam(); if (nd > 4 && pinch.d > 4) zoomAt(cx, cy, pinch.d / nd); panBy(cx - pinch.cx, cy - pinch.cy); pinch.d = nd; pinch.cx = cx; pinch.cy = cy; return;
      }
      if (!drag) { if (e.pointerType === "mouse") { const hh = hit(m[0], m[1]); cv.style.cursor = hh ? (hh.lift ? "ns-resize" : "move") : "grab"; } return; }
      const dx = m[0] - drag.lx, dy = m[1] - drag.ly;
      if (drag.k === "orbit") { drag.moved += Math.abs(dx) + Math.abs(dy); S.cam.yaw -= dx * 0.008; S.cam.pitch = clamp(S.cam.pitch + dy * 0.008, -0.1, 1.5); syncGoal(); mark("view"); }
      else if (drag.k === "pan") { drag.moved = (drag.moved || 0) + Math.abs(dx) + Math.abs(dy); panBy(dx, dy); }
      else if (drag.k === "vert" || drag.k === "overt") {
        const o = drag.k === "vert" ? drag.d : null, y = o ? o.y : S.origin[1]; const x = o ? o.x : S.origin[0], z = o ? o.z : S.origin[2];
        proj(x, y, z); const ny = clamp(snap(y - dy / pr[3]), 0, 60);
        if (o) { o.y = ny; updInsp(); } else { S.origin[1] = ny; setRange($("#o-y"), ny); }
        persist();
      } else if (drag.k === "org") {
        const p = planePt(m[0], m[1], S.origin), nv = clampPos([p[0] + drag.off[0], p[1] + drag.off[1], p[2] + drag.off[2]]);
        S.origin[0] = nv[0]; S.origin[1] = nv[1]; S.origin[2] = nv[2]; ["x", "y", "z"].forEach((a, i) => setRange($("#o-" + a), nv[i])); persist();
      } else if (drag.k === "dev") {
        const o = drag.d, p = planePt(m[0], m[1], [o.x, o.y, o.z]), nv = clampPos([p[0] + drag.off[0], p[1] + drag.off[1], p[2] + drag.off[2]]);
        o.x = nv[0]; o.y = nv[1]; o.z = nv[2]; updInsp(); persist();
      }
      drag.lx = m[0]; drag.ly = m[1];
    });
    const up = (e) => {
      PT.delete(e.pointerId);
      if (PT.size < 2) pinch = null;
      if (PT.size === 0) {
        if (drag && (drag.k === "orbit" || drag.k === "pan") && drag.moved < 4 && S.sel != null) { S.sel = null; renderDevices(); }
        drag = null; cv.style.cursor = "grab"; persist();
      } else if (PT.size === 1) drag = null;
    };
    cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
    cv.addEventListener("wheel", (e) => { e.preventDefault(); const m = mpos(e); zoomAt(m[0], m[1], Math.exp(e.deltaY * 0.0012)); persist(); }, { passive: false });
    cv.addEventListener("dblclick", (e) => { const m = mpos(e); if (!hit(m[0], m[1])) resetView(); });
    $("#vSeg").onclick = (e) => { const v = e.target.dataset.v; if (v) { S.view = v; if (v === "3d") setupCam(); syncTb(); persist(); } };
    $("#pSeg").onclick = (e) => { const v = e.target.dataset.p; if (!v) return; if (S.view === "3d") { camGoal(PRESET_CAMS[v]); } else { S.plane = v; S.pan2 = [0, 0]; syncTb(); } persist(); };
    $("#fit").onclick = fitView;
    $("#play").onclick = () => { S.playing = !S.playing; syncPlay(); wake(); };
    $("#orgb").onclick = (e) => openPop(e.currentTarget, "ra-r ra-w", (p) => {
      p.innerHTML = ["x", "y", "z"].map((a, i) => rng(a.toUpperCase(), S.origin[i], [-60, 0, -40][i], [60, 60, 40][i], 0.5, (v) => v.toFixed(1), (v) => { S.origin[i] = v; persist(); }, "cm", "o-" + a, 1)).join("");
    });
    $("#tune").onclick = (e) => openPop(e.currentTarget, "ra-r ra-w", (p) => {
      p.innerHTML = rng(t("ra.speed"), S.speed, 0, 3, 0.05, (v) => Math.round(v * 100) + "%", (v) => { S.speed = v; persist(); }, t("ra.speedTip"), "spd", 1)
        + rng(t("rgb.brightness"), S.bright, 0, 100, 1, (v) => v + "%", (v) => { S.bright = v; persist(); }, t("ra.brightTip"), "bri", 1);
    });
    const sc = $("#scrub"); sc.oninput = () => { const v = +sc.value / 10; S.t = Math.floor(S.t / 30) * 30 + v; sc.style.setProperty("--p", (+sc.value / 3) + "%"); mark("fx"); };
  }
  function onKey(e) {
    if (!root || root.closest("[hidden]") || (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) && e.target.type !== "range")) return;
    const d = selDev();
    if (e.key === " " && e.target.tagName !== "BUTTON") { e.preventDefault(); S.playing = !S.playing; syncPlay(); wake(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && d) removeDev(d.id);
    else if ((e.key === "r" || e.key === "R") && d && !e.ctrlKey && !e.metaKey) rotDev(d, S.snap ? 15 : 5);
    else if (e.key === "Escape") closePop();
  }

  /* ---------------- loop: one rAF, capped at 60 fps; it stops by itself when paused and nothing changed ---------------- */
  function wake() {
    if (raf || !cv || !cv.isConnected || document.hidden) return;
    last = performance.now(); raf = requestAnimationFrame(frame);
  }
  function frame(now) {
    raf = 0;
    if (!cv || !cv.isConnected || document.hidden) return;
    if (!cv.offsetParent) { setTimeout(wake, 400); return; }   // page hidden (another view on top): poll slowly
    const dt = (now - last) / 1000;
    if (dt < 0.0155) { raf = requestAnimationFrame(frame); return; }
    last = now;
    stepCam();
    if (S.playing) S.t += Math.min(0.1, dt) * S.speed;
    if (!(S.playing || D.view || D.geom || D.fx)) return;   // idle: no more frames until wake()
    if (D.geom) { rebuildGeom(); D.view = true; }
    if (D.view) { if (S.view === "3d") setupCam(); projectAll(); drawStatic(); }
    colorPass(); paint();
    D.view = D.geom = D.fx = false;
    uiT += dt;
    if (S.playing && uiT > 0.1) {
      uiT = 0;
      const ph = ((S.t % 30) + 30) % 30, sc = $("#scrub");
      if (sc && document.activeElement !== sc) { sc.value = ph * 10; sc.style.setProperty("--p", (ph / 30 * 100) + "%"); }
      $("#tv").textContent = ph.toFixed(1) + " s";
      const lvl = $("#lvl");
      if (lvl) { const lv = lvAt(S.t), bs = lvl.children; for (let i = 0; i < bs.length; i++) { bs[i].classList.toggle("lit", (i + 1) / bs.length <= lv); bs[i].style.setProperty("--o", (0.4 + 0.6 * i / (bs.length - 1)).toFixed(2)); } }
      const sn = $(".ra-scan[data-m]");
      if (sn) {
        const di = S.devices.findIndex((x) => x.id === +sn.dataset.m);
        if (di >= 0) {
          const a = DST[di], n = DST[di + 1] - a, m = sn.children.length;
          for (let j = 0; j < m; j++) { const i = a + Math.round(j * (n - 1) / Math.max(1, m - 1)), b = sn.children[j], lum = Math.max(CR[i], CG[i], CB[i]) / 255;
            b.style.background = "rgb(" + (CR[i] | 0) + "," + (CG[i] | 0) + "," + (CB[i] | 0) + ")"; b.style.opacity = (0.12 + 0.88 * lum).toFixed(2); }
        }
      }
    }
    raf = requestAnimationFrame(frame);
  }

  App.RGBAdv = { render, leave };
})();
