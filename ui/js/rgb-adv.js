"use strict";
/* RGB "Advanced" mode: devices placed in a 3D / 2D space, one layered effect across all of them.
   Layout: device list | stage (3D or 2D, with a small 2D inset) | inspector (Effect / Device) and the scene's settings.
   The selected layer is drawn as a shape in space ("field": a wave is the planes of its peaks, radial a sphere, scan a
   slab) from the same maths as the LEDs. Case templates give the usual places of devices ("slots"); a dragged device
   snaps into one. The canvas is only a PREVIEW: `colorAt` (the effect engine below) is pure and has no DOM, so the
   backend runs the same maths (ml-rgb engine.rs), per device with its own layers, brightness, white balance and delay.
   The scene is saved through rgb_scene_get / rgb_scene_set. Mounted by rgb.js: App.RGBAdv.render(container) /
   App.RGBAdv.leave(). Design: DESIGN.md. Scene fields: RGB-SCENE.md. */

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
  /** Where a Scan's head is at layer time `tl`: it sweeps from just before the first driven device until its faded tail
      has left the last one (L.ext, see fitScan), or without devices over a fixed 160 cm around the origin; 48 cm per
      second at 1x (24 mirrored). The same maths as ml-rgb engine.rs. */
  function scanHead(L, tl) {
    const P = L.p, ex = L.ext, w = P.width;
    const lo = ex ? ex[0] - 2 : P.mirror ? 0 : -80, hi = ex ? ex[1] + w + (P.trail * 45 + 1) * 1.5 : 80;
    const span = Math.max(hi - lo, 40), v = tl * (P.mirror ? 24 : 48);
    return lo + (((v % span) + span) % span);
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
        const sg = P.speed >= 0 ? 1 : -1, head = scanHead(L, tl), back = Math.floor((head - s) * sg / 3) * 3;
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
    { name: "Rain", key: "ra.pre.rain", layers: () => [mkL("noise", { axis: 1, rot: 180, speed: 1.6, scale: 2.2, ease: 0.9 }, RAIN, "mix")] },
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
    mouse: { link: 0, pts: (n) => Array.from({ length: n }, (_, i) => (n === 1 ? [0, 2.5, 0] : [Math.cos(i / n * TAU) * 2.6, 2.5, Math.sin(i / n * TAU) * 4.8])) },
    headset: { link: 0, pts: (n) => Array.from({ length: n }, (_, i) => { const side = i < n / 2 ? -8 : 8, m = Math.ceil(n / 2), j = i % m; return [side, 3, m > 1 ? (j / (m - 1) - 0.5) * 3 : 0]; }) },
  };
  const DEFN = { header: 12, gpu: 8, ram: 8, fan: 8, strip: 16, keyboard: 120, mouse: 3, headset: 4 };
  const r2 = (v) => Math.round(v * 100) / 100;
  /** the LED layout of a type with n LEDs, rounded: this is what is saved (pts) and what the backend uses */
  const layout = (type, n) => TYPES[type].pts(n).map((p) => [r2(p[0]), r2(p[1]), r2(p[2])]);
  const ptsOf = (d) => d.pts;
  const linkKey = (l) => (l ? l.name + "#" + (l.nth | 0) : null);
  let nextId = 1;
  const mkDev = (type, name, pts, x, y, z, rot, link) => { const d = { id: nextId++, type, name, n: pts.length, x, y, z, rot: rot || 0, sc: 1, pts }; if (link) d.link = link; return d; };

  /** OpenRGB device kind (+ name) -> one of our types. 0 board, 1 RAM, 2 GPU, 3 cooler, 4 strip, 5 keyboard, 6 mouse, 8/9 headset */
  function typeOfDev(d) {
    const k = d.kind, nm = (d.name || "").toLowerCase();
    if (k === 2) return "gpu";
    if (k === 1) return "ram";
    if (k === 5) return "keyboard";
    if (k === 6) return "mouse";
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
      case "mouse": return [46 + k * 8, 0.5, 14, 0];
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
      return { key: linkKey(link), link, name: c > 1 ? d.name + " " + c : d.name, type: typeOfDev(d), n: Math.max(1, (d.led_names || []).length), stored: !!d.stored, hidden: !!d.hidden, cols: Array.isArray(d.colors) ? d.colors : [] };
    });
  }

  /* ---------------- places: case templates and the desk ----------------
     A slot is a usual place for a kind of device (front fans, DIMM slots, a vertical GPU, the back of the monitor...).
     A device dropped near a free slot that fits it (or "Arrange") takes that place and its shape, so nobody types
     coordinates. One device can sit in several places (fans daisy-chained on one header: "parts").
     Every template is built standing the same way (glass side towards the desk at x = -24, motherboard on the far side,
     front at +z); the case can then be moved on the desk (S.caseAt, cm) and turned in 90° steps (S.caseRot), and its
     slots and the devices in them go with it. */
  const X1 = -24, FAN_R = 5.5;
  const CASES = { mid: { w: 22, h: 46, d: 44 }, itx: { w: 18, h: 33, d: 36 }, dual: { w: 28, h: 46, d: 44 }, open: { w: 30, h: 44, d: 40 }, none: null };
  /** device types a slot takes; the first one is the type it is meant for (Arrange and new devices try that first) */
  const ACC = { fan: ["fan", "header", "strip"], cpu: ["fan", "header", "strip"], gpu: ["gpu", "strip"], ram: ["ram"], edge: ["strip", "header"], io: ["header", "strip"], kb: ["keyboard"], mouse: ["mouse"], head: ["headset"] };
  const TORDER = ["fan", "gpu", "ram", "header", "strip", "keyboard", "mouse", "headset"];
  /** OpenRGB device kind of our types, for the Simple page's icons */
  const TKIND = { header: 0, ram: 1, gpu: 2, fan: 3, strip: 4, keyboard: 5, mouse: 6, headset: 8 };
  const icon = (type) => (App.RGB && App.RGB.icon ? App.RGB.icon(type === "case" ? "all" : TKIND[type]).outerHTML : "");
  /** the case of a template as built (before it is moved / turned) */
  function caseBox(tpl) { const c = CASES[tpl]; return c ? { x0: X1 - c.w, x1: X1, h: c.h, z0: -c.d / 2, z1: c.d / 2, xm: X1 - c.w / 2 } : null; }
  /** where a point of the template's case is on the desk: turned about the case's middle, then moved */
  function caseXf(p) {
    const b = caseBox(S.tpl); if (!b) return p;
    const a = (S.caseRot || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), dx = (p[0] - b.xm) * (S.caseFlip ? -1 : 1), dz = p[2];   // flipped: mirrored, glass on the other side
    return [b.xm + dx * c + dz * s + S.caseAt[0], p[1], -dx * s + dz * c + S.caseAt[1]];
  }
  /** a ring's facing after the case is turned (90° and 270° swap x and z) */
  const ringAx = (ax) => (ax === "y" || (S.caseRot || 0) % 180 === 0 ? ax : ax === "x" ? "z" : "x");
  /** the 8 corners of the case where it stands now (corners() order), or null */
  function caseCorners() { const b = caseBox(S.tpl); return b ? corners([[b.x0, 0, b.z0], [b.x1, b.h, b.z1]]).map(caseXf) : null; }
  /** the slots of the template (moved and turned with the case) plus the desk's; `lab` + `n` name it (ra.s.<lab>) */
  function slotsOf(tpl) {
    const out = [], b = caseBox(tpl);
    let inCase = true;
    const ring = (id, lab, n, c, ax, r, acc) => out.push({ id, lab, n, k: "ring", c, ax, r: r || FAN_R, acc: acc || ACC.fan, inCase });
    const path = (id, lab, n, pts, acc, closed) => out.push({ id, lab, n, k: "path", pts, closed: !!closed, acc, inCase });
    const spot = (id, lab, c, acc) => out.push({ id, lab, n: 0, k: "spot", c, acc, inCase });
    if (b) {
      const { x0, x1, h, z0, z1, xm } = b;
      const box = (b) => { out[out.length - 1].box = b; };   // the outline drawn for what sits in the slot
      const dimms = (n) => { for (let i = 0; i < n; i++) { const z = 4 + i * 1.4; path("dimm" + (i + 1), "dimm", i + 1, [[x0 + 4, 27, z], [x0 + 4, 38, z]], ACC.ram); box([[x0 + 0.5, 26, z - 0.4], [x0 + 4.5, 39, z + 0.4]]); } };
      // a card standing out of the board (horizontal) or parallel to the glass (vertical), its LED edge where the LEDs are
      const gpuH = (y) => { path("gpuH", "gpuH", 0, [[x0 + 13, y, -14], [x0 + 13, y, 14]], ACC.gpu); box([[x0 + 1, y - 5.5, -15], [x0 + 13.5, y + 0.5, 15]]); };
      const gpuV = (y) => { path("gpuV", "gpuV", 0, [[x1 - 5, y, -13], [x1 - 5, y, 15]], ACC.gpu); box([[x1 - 8, y - 12.5, -14], [x1 - 3, y + 0.5, 16]]); };
      const io = (y, z0_, z1_) => { path("io", "io", 0, [[x0 + 1, y, z0_], [x0 + 1, y, z1_]], ACC.io); box([[x0 + 0.5, y - 4, z0_ - 1], [x0 + 3, y + 1, z1_ + 1]]); };
      // the CPU cooler: an air cooler's fan looks to the front of the case (in front of its heatsink); an AIO pump looks at the glass
      const cpu = (y, z) => { ring("cpu", "cpu", 0, [x0 + 9, y, z + 5], "z", FAN_R, ACC.cpu); ring("pump", "pump", 0, [x0 + 3, y, z], "x", 4, ACC.cpu); };
      const glass = () => { path("glassTop", "glassTop", 0, [[x1, h, z0], [x1, h, z1]], ACC.edge); path("glassFront", "glassFront", 0, [[x1, 0, z1], [x1, h, z1]], ACC.edge); };
      if (tpl === "mid") {
        for (let i = 0; i < 3; i++) ring("front" + (i + 1), "front", i + 1, [xm, 10 + 13 * i, z1 - 1], "z");
        for (let i = 0; i < 3; i++) ring("top" + (i + 1), "top", i + 1, [xm, h - 1, z1 - 10 - 12 * i], "y");
        ring("rear1", "rear", 1, [xm, h - 11, z0 + 1], "z");
        cpu(34, -6); gpuH(17); gpuV(26); dimms(4);
        io(41, -16, -2);
        glass();
      } else if (tpl === "itx") {
        for (let i = 0; i < 2; i++) ring("front" + (i + 1), "front", i + 1, [xm, 9 + 12 * i, z1 - 1], "z");
        for (let i = 0; i < 2; i++) ring("top" + (i + 1), "top", i + 1, [xm, h - 1, z1 - 9 - 12 * i], "y");
        ring("rear1", "rear", 1, [xm, h - 10, z0 + 1], "z");
        cpu(24, -4); gpuH(12); dimms(2); io(28, -12, 0); glass();
      } else if (tpl === "dual") {
        for (let i = 0; i < 3; i++) ring("bottom" + (i + 1), "bottom", i + 1, [xm, 1, z1 - 9 - 13 * i], "y");
        for (let i = 0; i < 3; i++) ring("top" + (i + 1), "top", i + 1, [xm, h - 1, z1 - 9 - 13 * i], "y");
        for (let i = 0; i < 3; i++) ring("rear" + (i + 1), "rear", i + 1, [xm, 10 + 13 * i, z0 + 1], "z");
        cpu(34, -6); gpuV(20); dimms(4); io(41, -16, -2);
        path("corner", "corner", 0, [[x1, h, z0], [x1, h, z1], [x1, 0, z1]], ACC.edge);
      } else if (tpl === "open") {
        for (let i = 0; i < 3; i++) ring("rad" + (i + 1), "rad", i + 1, [xm, h + 1, 12 - 12 * i], "y");
        cpu(30, 0); gpuV(14); gpuH(18); dimms(2); io(38, -14, 0);
      }
      // the case's slots stand where the case stands now
      for (const s of out) {
        if (s.box) s.boxW = corners(s.box).map(caseXf);
        if (s.k === "path") s.pts = s.pts.map(caseXf);
        else { s.c = caseXf(s.c); if (s.k === "ring") s.ax = ringAx(s.ax); }
      }
    }
    inCase = false;
    spot("kb", "kb", [22, 0.5, 14], ACC.kb);
    spot("mouse", "mouse", [46, 0.5, 14], ACC.mouse);
    spot("head", "head", [34, 0, -10], ACC.head);
    path("mon", "mon", 0, [[2, 16, -21.5], [48, 16, -21.5], [48, 42, -21.5], [2, 42, -21.5]], ACC.edge, true);
    path("desk", "desk", 0, [[-50, -1, 30], [50, -1, 30]], ACC.edge);
    for (const s of out) if (s.k === "path") { const lo = [0, 1, 2].map((i) => Math.min(...s.pts.map((p) => p[i]))), hi = [0, 1, 2].map((i) => Math.max(...s.pts.map((p) => p[i]))); s.c = lo.map((v, i) => (v + hi[i]) / 2); }
    return out;
  }
  let SL = null, SLt = "";
  const slots = () => { const k = S.tpl + "|" + S.caseAt.join(",") + "|" + (S.caseRot || 0) + "|" + !!S.caseFlip; return SLt === k ? SL : (SLt = k, SL = slotsOf(S.tpl)); };
  const slotById = (id) => slots().find((s) => s.id === id);
  const fits = (d, s) => s.acc.includes(d.type);
  /** the slot ids a device stands in (one, or several parts) */
  const placesOf = (d) => (d.parts ? d.parts.map((p) => p.slot) : d.slot ? [d.slot] : []);
  const taken = (s, d) => S.devices.some((x) => x !== d && placesOf(x).includes(s.id));
  /** a free slot for a device: one meant for its type first (a board goes to the I/O, not into a fan ring), then any that fits */
  const freeSlot = (d) => {
    let best = null;
    for (const s of slots()) { if (!fits(d, s) || taken(s, d)) continue; if (!best || s.acc.indexOf(d.type) < best.acc.indexOf(d.type)) best = s; }
    return best;
  };
  const slotName = (s) => App.t("ra.s." + s.lab, { n: s.n });
  /** n points spread evenly along a path (closed: around it) */
  function along(pts, n, closed) {
    const P = closed ? pts.concat([pts[0]]) : pts, seg = [];
    let tot = 0;
    for (let i = 1; i < P.length; i++) { const l = Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1], P[i][2] - P[i - 1][2]); seg.push(l); tot += l; }
    return Array.from({ length: n }, (_, k) => {
      let d = (n === 1 ? 0.5 : closed ? k / n : k / (n - 1)) * tot, i = 0;
      while (i < seg.length - 1 && d > seg[i]) { d -= seg[i]; i++; }
      const u = seg[i] ? d / seg[i] : 0, a = P[i], b = P[i + 1];
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
    });
  }
  /** a slot's shape with n LEDs, in world cm */
  function slotShape(s, n) {
    if (s.k === "ring") return Array.from({ length: n }, (_, i) => { const a = Math.PI / 2 - i / n * TAU, u = Math.cos(a) * s.r, v = Math.sin(a) * s.r; return s.ax === "z" ? [s.c[0] + u, s.c[1] + v, s.c[2]] : s.ax === "x" ? [s.c[0], s.c[1] + v, s.c[2] + u] : [s.c[0] + u, s.c[1], s.c[2] + v]; });
    if (s.k === "path") return along(s.pts, n, s.closed);
    return null;
  }
  /** the LED order the user set (LED 0 moved by led0, the rest reversed) applied to a shape */
  function ordered(pts, led0, rev) {
    const a = rev ? [pts[0]].concat(pts.slice(1).reverse()) : pts.slice(), n = a.length, k = ((led0 || 0) % n + n) % n;
    return a.slice(k).concat(a.slice(0, k));
  }
  /** puts a device where its place(s) say: their shapes (one part after the other), keeping its LED 0 and order */
  function placeDev(d) {
    const parts = d.parts ? d.parts.map((p) => ({ s: slotById(p.slot), n: Math.max(1, p.n | 0) })).filter((p) => p.s) : d.slot && slotById(d.slot) ? [{ s: slotById(d.slot), n: d.n }] : [];
    if (!parts.length) { delete d.slot; delete d.parts; return false; }
    const o = parts[0].s.c;
    let world = [];
    for (const p of parts) world = world.concat(slotShape(p.s, p.n) || (d.pts || []).map((q) => [o[0] + q[0], o[1] + q[1], o[2] + q[2]]));   // a spot keeps the device's own layout
    if (parts.length === 1 && parts[0].s.k === "spot") world = d.pts.map((q) => [o[0] + q[0], o[1] + q[1], o[2] + q[2]]);
    const local = world.map((p) => [r2(p[0] - o[0]), r2(p[1] - o[1]), r2(p[2] - o[2])]);
    d.pts = parts.length === 1 && parts[0].s.k === "spot" ? d.pts : ordered(local, d.led0, d.rev);
    d.n = d.pts.length; d.x = r2(o[0]); d.y = r2(o[1]); d.z = r2(o[2]); d.rot = 0; d.sc = 1;
    if (d.parts && parts.length < d.parts.length) d.parts = d.parts.filter((p) => slotById(p.slot));
    if (d.parts && d.parts.length < 2) { d.slot = d.parts[0] && d.parts[0].slot; delete d.parts; }
    else if (d.parts) d.slot = d.parts[0].slot;
    return true;
  }
  /** the shape of a place can change between versions (the CPU fan now looks to the front): devices sitting in a place
      follow it when the scene is opened. Nothing moves when nothing changed. */
  function followSlots() {
    let moved = false;
    for (const d of S.devices) {
      if (!placesOf(d).length || !placesOf(d).every((id) => slotById(id))) continue;
      const before = JSON.stringify([d.x, d.y, d.z, d.pts]);
      placeDev(d);
      if (JSON.stringify([d.x, d.y, d.z, d.pts]) !== before) moved = true;
    }
    if (moved) persist();
  }
  /** one slot for a device (its parts are dropped) */
  function placeIn(d, s) { delete d.parts; d.slot = s.id; placeDev(d); }
  /** every device without a place goes into the first free slot meant for it */
  function autoArrange(quiet) {
    const snap = snapshot();
    let n = 0, left = 0;
    for (const tp of TORDER) for (const d of S.devices) {
      if (d.type !== tp || d._hid || placesOf(d).some((id) => slotById(id))) continue;
      const s = freeSlot(d); if (s) { placeIn(d, s); n++; } else left++;
    }
    if (!quiet) undoable(App.t(left ? "ra.arrangedLeft" : "ra.arranged", { n, m: left }), snap);
    syncTree(); renderDevInsp(); persist();
    return { n, left };
  }
  /** is a world point inside the case as it stands now (its footprint, any height)? */
  function inCase(p) {
    const cc = caseCorners(); if (!cc) return false;
    const xs = cc.map((q) => q[0]), zs = cc.map((q) => q[2]);
    return p[0] >= Math.min(...xs) - 1 && p[0] <= Math.max(...xs) + 1 && p[2] >= Math.min(...zs) - 1 && p[2] <= Math.max(...zs) + 1;
  }
  /** another case: devices keep the places the new case also has; the ones that lose theirs, and loose ones that stood
      inside the old case, are arranged into the new one */
  function setTpl(v) {
    const snap = snapshot();
    const loose = S.devices.filter((d) => !d._hid && !placesOf(d).length && inCase([d.x, d.y, d.z]));   // hidden devices are left alone
    S.tpl = v;
    const lost = [];
    for (const d of S.devices) { if (!placesOf(d).length) continue; if (!placeDev(d) && !d._hid) lost.push(d); }
    for (const d of loose.concat(lost)) { const s = freeSlot(d); if (s) placeIn(d, s); }
    // what found no place stands in a row on the desk beside the case, not through its walls
    const left = loose.concat(lost).filter((d) => !placesOf(d).length), cc = caseCorners();
    const bx = cc ? Math.max(...cc.map((p) => p[0])) + 6 : -40;
    left.forEach((d, i) => {
      const lowY = Math.min(...d.pts.map((p) => p[1] * d.sc));
      d.x = r2(bx + i * 5); d.y = r2(Math.max(0, -lowY) + 0.5); d.z = 0; d.rot = 0;
    });
    const out = left.length;
    undoable(out ? App.t("ra.tplLeft", { n: out }) : App.t("ra.tplDone"), snap);
    renderTree(); renderDevInsp(); persist();
  }
  /** mirrors the case (the glass on the other side, the board too); loose devices inside are mirrored with it */
  function flipCase() {
    const b = caseBox(S.tpl); if (!b) return;
    const loose = S.devices.filter((d) => !d._hid && !placesOf(d).length && inCase([d.x, d.y, d.z]));
    const c0 = caseXf([b.xm, 0, 0]), a = (S.caseRot || 0) * Math.PI / 180, n = [Math.cos(a), 0, -Math.sin(a)];
    for (const d of loose) { const k = (d.x - c0[0]) * n[0] + (d.z - c0[2]) * n[2]; d.x = r2(d.x - 2 * k * n[0]); d.z = r2(d.z - 2 * k * n[2]); }
    S.caseFlip = !S.caseFlip;
    for (const d of S.devices) if (placesOf(d).length) placeDev(d);
    persist();
  }
  /** moves / turns the case; what stands in it (slotted or loose inside) comes along */
  function moveCase(dx, dz, drot) {
    const b = caseBox(S.tpl); if (!b) return;
    const loose = S.devices.filter((d) => !placesOf(d).length && inCase([d.x, d.y, d.z]));
    const c0 = caseXf([b.xm, 0, 0]);
    S.caseAt = [r2(clamp(S.caseAt[0] + dx, -60, 90)), r2(clamp(S.caseAt[1] + dz, -40, 40))];
    S.caseRot = (((S.caseRot || 0) + (drot || 0)) % 360 + 360) % 360;
    const c1 = caseXf([b.xm, 0, 0]), a = (drot || 0) * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
    for (const d of loose) {   // loose devices: turned about the old middle, then moved like the case
      const px = d.x - c0[0], pz = d.z - c0[2];
      d.x = r2(c1[0] + px * cs + pz * sn); d.z = r2(c1[2] - px * sn + pz * cs); d.rot = ((d.rot + (drot || 0)) % 360 + 360) % 360;
    }
    for (const d of S.devices) if (placesOf(d).length) placeDev(d);
    persist();
  }

  /* ---------------- state (kept while the app runs; the scene is reloaded on every render) ---------------- */
  const S = { view: "3d", plane: "top", snap: 2, devices: [], sel: null, layers: PRESETS[4].layers(), selLayer: 1, origin: [0, 18, 0],
    playing: true, t: 0, speed: 1, bright: 100, fxName: "Buffer now/trail", mine: [], cam: { yaw: 0.55, pitch: 0.5, dist: 150, t: [0, 18, 0] }, zoom2: 1, pan2: [0, 0], seen: [],
    tpl: "mid", caseAt: [0, 0], caseRot: 0, caseFlip: false, field: true, slots: true, tab: "fx", originDev: null, fps: 30 };
  const KEEP = ["view", "plane", "snap", "devices", "sel", "layers", "selLayer", "origin", "speed", "bright", "fxName", "mine", "cam", "zoom2", "pan2", "seen", "playing",
    "tpl", "caseAt", "caseRot", "caseFlip", "field", "slots", "tab", "originDev", "fps"];
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
    o.mode = "advanced";   // the view that is open (one scene: Simple and Advanced only show it differently)
    delete o.simple; delete o.free;   // the recorder keeps its current ones (rgb-scene-set), see refreshDrive
    o.merged = true;
    const plain = JSON.parse(JSON.stringify(o, (k, v) => (k[0] === "_" ? undefined : v)));
    raw = plain;
    return api.invoke("rgb_scene_set", { scene: plain }).catch((e) => App.toast(App.t("rgb.err", { err: e }), "err"));
  }
  const okDev = (d) => {
    if (!d || !TYPES[d.type] || !Number.isFinite(d.id)) return false;
    if (!Array.isArray(d.pts) || !d.pts.length || !d.pts.every((p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))) d.pts = layout(d.type, DEFN[d.type]);
    d.n = d.pts.length; d.x = +d.x || 0; d.y = +d.y || 0; d.z = +d.z || 0; d.rot = +d.rot || 0; d.sc = +d.sc || 1;
    if (!d.link || typeof d.link.name !== "string") delete d.link;
    if (typeof d.name !== "string") d.name = d.type;
    // own brightness, white balance (0..100) and delay (ms), as the recorder reads them
    d.trim = Number.isFinite(+d.trim) && d.trim !== null ? clamp(+d.trim, 0, 100) : 100;
    delete d.wb;   // colour balance is the hardware calibration now (recorder, per device), not part of the scene
    d.delay = Number.isFinite(+d.delay) && d.delay !== null ? clamp(+d.delay, -500, 1000) : 0;
    d.led0 = (d.led0 | 0) % d.n; d.rev = !!d.rev;
    if (typeof d.slot !== "string") delete d.slot;
    if (d.parts && !(Array.isArray(d.parts) && d.parts.length > 1 && d.parts.every((p) => p && typeof p.slot === "string" && p.n > 0))) delete d.parts;
    return true;
  };
  const okL = (a) => Array.isArray(a) && a.every((l) => l && l.p && Array.isArray(l.stops) && l.stops.length >= 2 && GENS.includes(l.gen));
  /* ---------------- one scene, two views ----------------
     A device with a look of its own (set on the Simple view, or here) shows that; a placed device without one follows
     the effect; a given-back one shows its own lighting. The recorder decides the same way (scene.rs plan). */
  let LOOKS = new Map(), FREE = new Set();
  function syncDrive() {
    LOOKS = new Map((raw.simple || []).map((l) => [l.name + "#" + (l.nth || 0), l]));
    FREE = new Set(raw.free || []);
  }
  /** "look" | "scene" | "free" (its own lighting) | "sim" (only drawn: no link) */
  function drive(d) {
    if (!d.link) return "sim";
    const k = linkKey(d.link);
    if (LOOKS.has(k)) return "look";
    if (real && (real.find((q) => q.key === k) || {}).stored) return "sim";   // the keyboard: never driven by the effect
    if (FREE.has(k) || !S.layers.some((L) => L.on)) return "free";
    return "scene";
  }
  /** after a look / follow / give-back command: read the scene's looks and given-back list again */
  async function refreshDrive() {
    try { const sc = await api.invoke("rgb_scene_get"); raw.simple = sc.simple || []; raw.free = sc.free || []; } catch (_) { /* keep */ }
    syncDrive(); mark("fx"); renderTree(); renderDevInsp(); syncWarn();   // the rows' dots change (own colour / given back)
  }
  async function setDrive(d, how, col) {
    const n = { name: d.link.name, nth: d.link.nth | 0 };
    try {
      if (how === "scene") await api.invoke("rgb_follow", n);
      else if (how === "free") await api.invoke("rgb_unlook", n);
      else {
        const old = LOOKS.get(linkKey(d.link)), c = col ? App.RGBWheel.fromHex(col) : null;
        await api.invoke("rgb_look", { look: Object.assign({ hue: 75, sat: 90, br: 100, on: true, fx: "static", speed: 1, c2: null, rev: false, native: null }, old || {}, c || {}, n) });
      }
    } catch (e) { App.toast(App.t("rgb.err", { err: e }), "err"); }
    refreshDrive();
  }
  /** a device the effect can colour: not the Dark Project keyboard (not an OpenRGB device; the effect never drives it) */
  const fxable = (d) => !(real && d.link && (real.find((q) => q.key === linkKey(d.link)) || {}).stored);
  /** When no device plays the effect (all have their own colour, or are given back), editing it changes nothing on the
      lights: say so above the effect, with one click to put them all on it. */
  function syncWarn() {
    const el = $("#fxwarn"); if (!el) return;
    const linked = S.devices.filter((d) => d.link && !d._hid && devState(d) === "ok" && drive(d) !== "sim");   // online ones: an offline device plays nothing
    const on = S.layers.some((L) => L.on), playing = linked.some((d) => drive(d) === "scene");
    const show = S.tab === "fx" && on && linked.length > 0 && !playing;
    el.hidden = !show; if (!show) { el.innerHTML = ""; return; }
    const own = linked.filter((d) => drive(d) === "look").length, free = linked.length - own;
    el.innerHTML = `<span>${t("ra.noFx", { n: own, m: free })}</span><button class="btn ra-sm acc" id="allfx">${t("ra.allToFx")}</button>`;
    $("#allfx").onclick = async () => {
      for (const d of linked) await api.invoke("rgb_follow", { name: d.link.name, nth: d.link.nth | 0 }).catch(() => {});
      refreshDrive();
    };
  }
  /* the Simple view's look, exactly as the recorder computes it (scene.rs Look::hsv / Look::at), for the preview */
  function lookHsv(hue, sat, f) {
    const c = clamp(sat / 100, 0, 1), h = (((hue % 360) + 360) % 360) / 60, x = c * (1 - Math.abs((h % 2) - 1)), m = 1 - c;
    const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.min(5, Math.floor(h))];
    const q = (v) => clamp(Math.round((v + m) * 255 * clamp(f, 0, 1)), 0, 255);
    return [q(r), q(g), q(b)];
  }
  function lookAt(l, t, u) {
    if (l.on === false) return [0, 0, 0];
    const sp = clamp(l.speed || 1, 0.1, 5), br = (l.br == null ? 100 : l.br) / 100, wave = (x) => 0.5 + 0.5 * Math.sin(x * TAU);
    const hue = l.hue == null ? 75 : l.hue, sat = l.sat == null ? 90 : l.sat;
    u = l.rev ? 1 - u : u;
    const a = lookHsv(hue, sat, 1), b = l.c2 ? lookHsv(l.c2[0], l.c2[1], 1) : a;
    const mix = (w) => a.map((v, i) => clamp(Math.round((v + (b[i] - v) * w) * br), 0, 255));
    switch (l.native ? "native" : l.fx) {
      case "breathing": return l.c2 ? mix(wave(t * 0.25 * sp - 0.25)) : lookHsv(hue, sat, br * (0.1 + 0.9 * wave(t * 0.25 * sp - 0.25)));
      case "rainbow": return lookHsv((t * 45 * sp + u * 160) % 360, Math.max(sat, 80), br);
      case "wave": return l.c2 ? mix(wave(u - t * 0.35 * sp)) : lookHsv(hue, sat, br * (0.08 + 0.92 * wave(u - t * 0.35 * sp)));
      default: return lookHsv(hue, sat, br);
    }
  }

  /** What the user arranged, before a change that takes many steps to redo (removing, Arrange, another case). */
  const UNDO_KEYS = ["devices", "layers", "tpl", "caseAt", "caseRot", "caseFlip", "origin", "originDev", "sel", "selLayer", "fxName"];
  function snapshot() { const o = {}; for (const k of UNDO_KEYS) o[k] = S[k]; return JSON.parse(JSON.stringify(o, (k, v) => (k === "_b" ? undefined : v))); }
  /** a toast that says what happened, with "Undo" putting the snapshot back */
  function undoable(msg, snap) {
    App.toast(msg, "", { label: App.t("ra.undo"), run: () => {
      Object.assign(S, JSON.parse(JSON.stringify(snap)));
      syncReal(); renderTree(); renderDevInsp(); renderFx(); mark(); persist();
    } });
  }

  /** Negative speeds are gone (the direction arrow turns an effect): a layer saved with one now runs forward, turned the
      other way. Radial and Solid have no direction, a mirrored scan would change from inwards to outwards: only the sign goes. */
  function forward(L) {
    const p = L && L.p; if (!p || !(p.speed < 0)) return;
    p.speed = -p.speed;
    if (["scan", "wave", "rainbow", "noise"].includes(L.gen) && !(L.gen === "scan" && p.mirror)) p.rot = ((p.rot || 0) + 180) % 360;
  }
  /** a layer from outside (a share code): only known generators and blends, numbers inside their ranges, real colours */
  function cleanLayer(l) {
    if (!l || typeof l !== "object" || !GENS.includes(l.gen)) return null;
    const num = (v, a, b, d) => (Number.isFinite(+v) ? clamp(+v, a, b) : d), q = l.p || {}, d = dflt();
    const p = { speed: num(q.speed, -3, 3, d.speed), scale: num(q.scale, 0.25, 4, d.scale), rot: num(q.rot, 0, 359, 0), axis: [0, 1, 2].includes(q.axis) ? q.axis : 0,
      mirror: !!q.mirror, ease: num(q.ease, 0, 1, 0), trail: num(q.trail, 0, 1, d.trail), width: num(q.width, 1, 30, d.width) };
    const stops = (Array.isArray(l.stops) ? l.stops : []).filter((s) => s && /^#[0-9a-f]{6}$/i.test(s.c)).slice(0, 16).map((s) => ({ p: num(s.p, 0, 1, 0), c: s.c.toLowerCase() })).sort((a, b) => a.p - b.p);
    if (stops.length < 2) return null;
    const out = { on: l.on !== false, gen: l.gen, p, stops, blend: BLENDS.includes(l.blend) ? l.blend : "add", opacity: num(l.opacity, 0, 1, 1) };
    forward(out);
    return out;
  }
  /** a layer's skip list: scene device ids it does not act on (kept on the layer, so it moves with it) */
  const skips = (L, id) => !!L.skip && L.skip.includes(id);
  function setSkip(L, id, off) {
    const s = new Set(L.skip || []); if (off) s.add(id); else s.delete(id);
    if (s.size) L.skip = [...s]; else delete L.skip;
  }
  function restore(o) {
    raw = o && typeof o === "object" ? o : {};
    syncDrive();
    if (Array.isArray(raw.devices)) { S.devices = raw.devices.filter(okDev); nextId = Math.max(0, ...S.devices.map((d) => d.id)) + 1; }
    if (okL(raw.layers) && raw.layers.length) { S.layers = raw.layers; S.layers.forEach(forward); }
    if (typeof raw.playing === "boolean") S.playing = raw.playing;
    if (Array.isArray(raw.mine)) { S.mine = raw.mine.filter((m) => m && okL(m.layers)); S.mine.forEach((m) => m.layers.forEach(forward)); }
    if (Array.isArray(raw.seen)) S.seen = raw.seen.filter((x) => typeof x === "string");
    for (const k of ["view", "plane", "snap", "sel", "selLayer", "origin", "speed", "bright", "fxName", "cam", "zoom2", "pan2", "tpl", "caseAt", "caseRot", "caseFlip", "field", "slots", "tab", "originDev", "fps"]) if (raw[k] != null) S[k] = raw[k];
    for (const L of S.layers) if (L.skip && !(Array.isArray(L.skip) && L.skip.every(Number.isFinite))) delete L.skip;
    if (!(S.tpl in CASES)) S.tpl = "mid";
    if (!Array.isArray(S.caseAt) || S.caseAt.length !== 2 || !S.caseAt.every(Number.isFinite)) S.caseAt = [0, 0];
    S.caseRot = [0, 90, 180, 270].includes(S.caseRot) ? S.caseRot : 0; S.caseFlip = S.caseFlip === true;
    if (!["fx", "dev"].includes(S.tab)) S.tab = "fx";
    S.field = S.field !== false; S.slots = S.slots !== false;
    S.fps = clamp(Math.round(+S.fps) || 30, 5, 60);
    if (!S.devices.some((d) => d.id === S.originDev)) S.originDev = null;
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
  /** devices placed by themselves on first sight: they start given back (their own lighting), nothing lights up by surprise */
  const NEWLY = [];
  function mergeReal() {
    if (!real) return false;
    let changed = false;
    for (const r of real) {
      // a mouse saved by an older version is a "strip" (it had no type of its own): give it the mouse model and its place
      const old = r.type === "mouse" && S.devices.find((d) => d.type === "strip" && linkKey(d.link) === r.key);
      if (old) {
        delete old.parts; delete old.slot;
        old.type = "mouse"; old.pts = layout("mouse", old.n || r.n);
        const sl = freeSlot(old);
        if (sl) placeIn(old, sl); else { const sp = defaultSpot("mouse", 0); [old.x, old.y, old.z, old.rot] = sp; }
        changed = true;
      }
      if (S.seen.includes(r.key) || r.hidden) continue;   // a hidden device is placed only once it is shown again
      S.seen.push(r.key); changed = true;
      if (S.devices.some((d) => linkKey(d.link) === r.key)) continue;
      placeReal(r); NEWLY.push(r.link);
    }
    return changed;
  }
  function placeReal(r) {
    const k = S.devices.filter((d) => d.type === r.type).length, sp = defaultSpot(r.type, k);
    const d = mkDev(r.type, r.name, layout(r.type, r.n), sp[0], sp[1], sp[2], sp[3], r.link);
    d.trim = 100; d.delay = 0;
    S.devices.push(d);
    const s = freeSlot(d); if (s) placeIn(d, s);   // a new device lands in the first free place that fits it
    return d;
  }

  /* ---------------- helpers ---------------- */
  const ICO = {
    up: '<svg viewBox="0 0 16 16"><path d="M4 10l4-4 4 4"/></svg>', down: '<svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></svg>',
    del: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>', dup: '<svg viewBox="0 0 16 16"><path d="M5.5 5.5h7v7h-7zM3.5 10.5v-7h7"/></svg>',
    play: '<svg class="fill" viewBox="0 0 16 16"><path d="M5 3l8 5-8 5z"/></svg>', pause: '<svg class="fill" viewBox="0 0 16 16"><path d="M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z"/></svg>',
    rot: '<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3"/></svg>', grip: '<svg viewBox="0 0 16 16"><path d="M5 4h6M5 8h6M5 12h6"/></svg>',
    focus: '<svg viewBox="0 0 16 16"><path d="M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3"/><circle cx="8" cy="8" r="2"/></svg>',
    hide: '<svg viewBox="0 0 16 16"><path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z"/><path d="M3 13L13 3"/></svg>',
    plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>', dice: '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><path d="M5.5 5.5h.01M10.5 10.5h.01M8 8h.01"/></svg>',
  };
  let BID = 0; const B = {};
  /** a labelled slider; `def` = the value a double-click puts back */
  function rng(label, val, min, max, step, fmt, fn, tip, id, inl, def) {
    const b = "b" + (++BID); B[b] = { fn, fmt, min, max, def };
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
      // values snap to round steps (15°, 5 %, 50 ms...: nobody sets a rotation to the degree); Shift while dragging = fine
      const fine = +inp.step || 1, suf = String(b.fmt(+inp.value)).replace(/[-\d.\s]/g, ""), coarse = r2(fine * ({ "°": 15, "%": 5, ms: 5, fps: 5, "×": 5, cm: 2 }[suf] || 1));
      inp.step = coarse;
      inp.addEventListener("pointerdown", (e) => { inp.step = e.shiftKey ? fine : coarse; });
      inp.addEventListener("keydown", (e) => { inp.step = e.shiftKey ? fine : coarse; });
      if (b.def != null) inp.addEventListener("dblclick", () => { inp.value = b.def; inp.dispatchEvent(new Event("input")); });
      if (b.def != null && !inp.title) inp.title = App.t("ra.resetTip");
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
    followSlots();
    build();
    document.addEventListener("pointerdown", onDocDown);
    window.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", wake);
    refreshReal(my);
  }
  /** asks OpenRGB which devices exist; the scene is usable (and editable) before this answers */
  let HIDDEN = new Set();
  async function refreshReal(my) {
    // rgb.js has just fetched the status for this very page open: do not ask the recorder for it again
    let s = App.RGBAuto.recent(2000);
    if (!s) try { s = await api.invoke("rgb_status"); } catch (_) { return; }
    HIDDEN = new Set(s && s.hidden || []);
    if (my !== gen || !s || !s.installed) return;
    let devs;
    try { devs = await api.invoke("rgb_start"); } catch (_) { return; }
    if (my !== gen || !Array.isArray(devs)) return;
    real = realList(devs);
    const added = mergeReal();
    syncReal();
    renderTree(); renderDevInsp(); syncWarn(); if (added) renderFx();
    if (added) { await save(); for (const l of NEWLY.splice(0)) await api.invoke("rgb_unlook", { name: l.name, nth: l.nth | 0 }).catch(() => {}); refreshDrive(); } else mark("geom");
  }
  /** stops the page; returns the pending save (if any), so whoever reads the scene next can wait for it */
  function leave() {
    gen++;
    const pending = saveT ? save() : null;
    cancelAnimationFrame(raf); raf = 0;
    closePop();
    if (ro) { ro.disconnect(); ro = null; }
    document.removeEventListener("pointerdown", onDocDown);
    window.removeEventListener("keydown", onKey);
    document.removeEventListener("visibilitychange", wake);
    cv = null; ctx = null; bgc = bgx = null; pv = px = null;
    if (mount) { mount.remove(); mount = null; }
    root = null;
    PT.clear(); drag = null; pinch = null;
    return pending;
  }

  function build() {
    const el = document.createElement("div");
    el.className = "ra";
    el.innerHTML = `
    <div class="ra-c">
      <div class="ra-left"><div class="card2 pad" id="devp"></div></div>
      <div class="ra-mid">
        <div class="card2 pad ra-stage">
          <div class="ra-tb">
            <span class="seg ra-s" id="vSeg"><button data-v="3d">3D</button><button data-v="2d">2D</button></span>
            <span class="seg ra-s" id="pSeg"></span>
            <button class="btn ra-sm" id="fit" title="${t("ra.fitTip")}">${t("ra.fit")}</button>
            <span class="sp"></span>
            <button class="ra-chip" id="fldb" title="${t("ra.fieldTip")}">${t("ra.field")}</button>
            <button class="ra-chip" id="slb" title="${t("ra.slotsTip")}">${t("ra.slots")}</button>
          </div>
          <div class="ra-cvwrap"><canvas class="ra-cv" id="cv" aria-label="${t("ra.stage")}"></canvas>
            <button class="ra-pip" id="pipb" title="${t("ra.pipTip")}"><canvas id="pip"></canvas><span class="ra-pipl" id="pipl"></span></button></div>
          <div class="ra-legend" id="lgd"></div>
          <div class="ra-tp">
            <button class="btn ra-ic" id="play" title="${t("ra.playTip")}" aria-label="${t("ra.playTip")}"></button>
            <input class="rline" id="scrub" type="range" min="0" max="300" value="0" aria-label="${t("ra.phase")}" title="${t("ra.phaseTip")}">
            <span class="ra-val" id="tv">0.0 s</span>
          </div>
        </div>
      </div>
      <div class="ra-right">
        <div class="card2 pad ra-insp2">
          <span class="seg ra-s ra-tabs" id="iSeg"><button data-tab="fx">${t("ra.tabFx")}</button><button data-tab="dev">${t("ra.tabDev")}</button></span>
          <div class="ra-warnbar" id="fxwarn" role="status" hidden></div>
          <div class="ra-fx" id="fxp"></div>
          <div class="ra-devi" id="devi"></div>
        </div>
        <div class="card2 pad ra-scene" id="scp"></div>
      </div>
    </div>`;
    root.appendChild(el); mount = el;
    cv = $("#cv"); ctx = cv.getContext("2d"); bgc = document.createElement("canvas"); bgx = bgc.getContext("2d");
    pv = $("#pip"); px = pv.getContext("2d");
    ro = new ResizeObserver(() => {
      DPR = Math.min(2, window.devicePixelRatio || 1); CW = cv.clientWidth; CH = cv.clientHeight;
      cv.width = bgc.width = Math.max(1, Math.round(CW * DPR)); cv.height = bgc.height = Math.max(1, Math.round(CH * DPR));
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0); bgx.setTransform(DPR, 0, 0, DPR, 0, 0);
      PW = pv.clientWidth; PH = pv.clientHeight; pv.width = Math.max(1, Math.round(PW * DPR)); pv.height = Math.max(1, Math.round(PH * DPR)); px.setTransform(DPR, 0, 0, DPR, 0, 0);
      mark("view");
    });
    ro.observe(cv); ro.observe(pv);
    syncTb(); syncPlay(); syncTabs(); renderTree(); renderDevInsp(); renderFx(); renderScene(); bindStage(); syncWarn();
    mark();
  }
  function syncTb() {
    [...$("#vSeg").children].forEach((b) => b.classList.toggle("on", b.dataset.v === S.view));
    const names = S.view === "3d" ? ["iso", "top", "front", "side"] : ["top", "front"];
    $("#pSeg").innerHTML = names.map((n) => `<button data-p="${n}" class="${S.view === "2d" && S.plane === n ? "on" : ""}">${t("ra." + n)}</button>`).join("");
    $("#fldb").classList.toggle("on", S.field); $("#fldb").setAttribute("aria-pressed", S.field);
    $("#slb").classList.toggle("on", S.slots); $("#slb").setAttribute("aria-pressed", S.slots);
    $("#pipl").textContent = "2D · " + App.t("ra." + pipPlane());
  }
  function syncPlay() { $("#play").innerHTML = S.playing ? ICO.pause : ICO.play; }
  /** the inspector shows the effect or the selected device / case; switching hides one, nothing is rebuilt */
  function syncTabs() {
    [...$("#iSeg").children].forEach((b) => b.classList.toggle("on", b.dataset.tab === S.tab));
    $("#fxp").hidden = S.tab !== "fx"; $("#devi").hidden = S.tab !== "dev"; syncWarn();
    // what the marks on the stage mean depends on the tab: the effect's origin and direction, or the selection's handles
    $("#lgd").innerHTML = S.tab === "fx"
      ? `<span><i class="lg-org"></i>${t("ra.lgOrigin")}</span><span><i class="lg-dir"></i>${t("ra.lgDir")}</span>${S.field ? `<span><i class="lg-fld"></i>${t("ra.lgField")}</span>` : ""}`
      : `<span><i class="lg-ax x"></i><i class="lg-ax y"></i><i class="lg-ax z"></i>${t("ra.lgMove")}</span><span><i class="lg-l0"></i>${t("ra.lgLed0")}</span><span>${t("ra.lgFocus")}</span>`;
    mark("view");
  }

  /* ----- devices: the list (left) ----- */
  const snap = (v) => (S.snap ? Math.round(v / S.snap) * S.snap : v);
  const keyed = () => new Set(S.devices.map((d) => linkKey(d.link)).filter(Boolean));
  /** what OpenRGB says about a placed device now (hidden also while OpenRGB does not see it: the recorder's list): hidden (on the Simple page too) and its real LED count */
  function syncReal() {
    for (const d of S.devices) { const r = real && d.link ? real.find((q) => q.key === linkKey(d.link)) : null; d._hid = r ? !!r.hidden : !!(d.link && HIDDEN.has(linkKey(d.link))); d._leds = r ? r.n : 0; d._cols = r ? r.cols : []; }
  }
  /** "ok": OpenRGB shows it; "off": linked but not seen now; "sim": only drawn (no link, or a device Advanced does not drive) */
  function devState(x) {
    if (!x.link) return "sim";
    if (!real) return "ok";
    const r = real.find((q) => q.key === linkKey(x.link));
    return !r ? "off" : r.stored ? "sim" : "ok";
  }
  const stateTag = (st) => (st === "off" ? `<span class="ra-tag" title="${t("ra.offlineTip")}">${t("ra.offline")}</span>` : st === "sim" ? `<span class="ra-tag sim" title="${t("ra.simTip")}">${t("ra.sim")}</span>` : "");
  const rowSmall = (x) => { const ps = placesOf(x).map(slotById).filter(Boolean); return ps.length ? esc(slotName(ps[0])) + (ps.length > 1 ? " +" + (ps.length - 1) : "") : String(x.n); };
  let showHid = false;
  /** the list groups by place: what stands in the case (in one of its slots, or loose inside it) under the case's row,
      the rest on the desk; inside a group by kind */
  function treeGroups(vis) {
    const byType = (a, b) => TORDER.indexOf(a.type) - TORDER.indexOf(b.type);
    const isIn = (d) => { const ps = placesOf(d).map(slotById).filter(Boolean); return ps.length ? ps.some((p) => p.inCase) : inCase([d.x, d.y, d.z]); };
    return [vis.filter(isIn).sort(byType), vis.filter((d) => !isIn(d)).sort(byType)];
  }
  let treeSig = "";
  const sigOf2 = (vis) => treeGroups(vis).map((g) => g.map((d) => d.id).join(",")).join("|");
  /** after a device moved: the rows stay (their place label changes in place); the list is rebuilt only when a device
      went into or out of the case */
  function syncTree() { if (sigOf2(S.devices.filter((d) => !d._hid)) !== treeSig) renderTree(); else S.devices.forEach(rowLabel); }
    /** what colours a device, as its dot (a long text tag left no room for names): lime = the effect, its own colour = its own
      look, hollow = given back (its own lighting); the row's title says it in words */
  function driveDot(x) {
    const w = drive(x);
    if (w === "look") { const l = LOOKS.get(linkKey(x.link)), c = lookHsv(l.hue == null ? 75 : l.hue, l.sat == null ? 90 : l.sat, 1); return `<i class="ra-dot own" style="--c:rgb(${c.join(",")})"></i>`; }
    return `<i class="ra-dot ${w === "free" && x.link ? "free" : ""}"></i>`;
  }
  const driveTip = (x) => { const w = drive(x); return w === "look" ? t("ra.drLookTip") : w === "free" && x.link ? t("ra.drFreeTip") : w === "scene" ? t("ra.drSceneTip") : t("ra.simTip"); };
  function devRow(x, cls) {
    const st = devState(x);
    return `<button class="ra-dr ${cls} st-${st} ${x.id === S.sel ? "on" : ""}" data-id="${x.id}" title="${esc(x.name)}: ${driveTip(x)}">${icon(x.type)}${driveDot(x)}<span class="ra-dn"><b>${esc(x.name)}</b><span class="ra-scan" data-m="${x.id}">${"<b></b>".repeat(14)}</span></span><small data-sl="${x.id}">${rowSmall(x)}</small>${st === "off" ? stateTag(st) : ""}</button>`;
  }
  /** the whole list; only when devices come, go, hide or are copied (a click only moves the selection, see selectDev) */
  function renderTree() {
    const el = $("#devp"); if (!el) return; closePop();
    const vis = S.devices.filter((d) => !d._hid), hid = S.devices.filter((d) => d._hid);
    const nl = vis.reduce((a, x) => a + x.n, 0);
    const free = real ? real.filter((r) => !keyed().has(r.key) && !r.hidden) : [];
    const [inside, outside] = treeGroups(vis);
    treeSig = sigOf2(vis);
    el.innerHTML = `<div class="ra-fxhd"><span class="cap">${t("ra.devices")}</span><span class="ra-note" title="${t("ra.ledsTip")}">${vis.length} · ${nl} LED</span><span class="sp"></span>
        <button class="btn ra-sm" id="arrb" title="${t("ra.arrangeTip")}" ${vis.length ? "" : "disabled"}>${t("ra.arrange")}</button>
        <span class="ra-pa"><button class="btn ra-sm" id="addb" title="${t("ra.addTip")}" ${free.length ? "" : "disabled"}>+ ${t("ra.add")}</button></span></div>
      <div class="ra-tree">
        <div class="ra-grp">
          <button class="ra-dr ra-case ${S.sel === "case" ? "on" : ""}" data-id="case">${icon("case")}<span class="ra-dn"><b>${t("ra.case2")}</b></span><small>${t("ra.tpl." + S.tpl)}</small></button>
          ${inside.map((x) => devRow(x, "in")).join("")}</div>
        ${outside.length ? `<div class="ra-grp"><span class="cap ra-gh">${t("ra.grp.desk")}</span>${outside.map((x) => devRow(x, "")).join("")}</div>` : ""}
        ${vis.length ? "" : `<div class="ra-note ra-empty">${t("ra.noDevices")}</div>`}
        ${hid.length ? `<div class="ra-grp"><button class="linkbtn ra-hidh" id="hidb">${t("rgb.hidden", { n: hid.length })} ${showHid ? "▴" : "▾"}</button>
          ${showHid ? hid.map((x) => `<div class="ra-dr hid">${icon(x.type)}<span class="ra-dn"><b>${esc(x.name)}</b></span><button class="chip" data-show="${x.id}">${t("rgb.unhide")}</button></div>`).join("") : ""}</div>` : ""}
      </div>`;
    el.querySelectorAll(".ra-dr[data-id]").forEach((b) => { b.onclick = () => { selectDev(b.dataset.id === "case" ? "case" : +b.dataset.id); centerSel(); }; });
    $("#arrb").onclick = () => autoArrange();
    const hb = $("#hidb"); if (hb) hb.onclick = () => { showHid = !showHid; renderTree(); };
    el.querySelectorAll("[data-show]").forEach((b) => { b.onclick = () => hideDev(S.devices.find((d) => d.id === +b.dataset.show), false); });
    $("#addb").onclick = (e) => openPop(e.currentTarget, "ra-r", (p) => {
      p.innerHTML = `<div class="ra-menu">${free.map((r, i) => `<button class="ra-mi" data-add="${i}">${ICO.plus}${esc(r.name)}<small class="ra-note">${r.n}</small></button>`).join("")}</div>`;
      p.querySelectorAll("[data-add]").forEach((b) => { b.onclick = () => addReal(free[+b.dataset.add]); });
    });
  }
  /** selects a device (or "case") in place: the list keeps its rows (no flash, no scroll jump), the inspector shows it */
  function selectDev(id) {
    S.sel = id;
    root.querySelectorAll("#devp .ra-dr[data-id]").forEach((b) => b.classList.toggle("on", (b.dataset.id === "case" ? "case" : +b.dataset.id) === id));
    if (id != null && S.tab !== "dev") { S.tab = "dev"; syncTabs(); }
    renderDevInsp(); persist();
  }
  const rowLabel = (d) => { const s = root && root.querySelector(`#devp [data-sl="${d.id}"]`); if (s) s.innerHTML = rowSmall(d); };
  /** hides a device everywhere (the same list as the Simple page): Buffer stops driving it, it leaves the list and the stage */
  async function hideDev(d, on) {
    if (!d || !d.link) return;
    try { await api.invoke("rgb_hide", { key: linkKey(d.link), on }); } catch (e) { App.toast(App.t("rgb.err", { err: e }), "err"); return; }
    const r = real && real.find((q) => q.key === linkKey(d.link)); if (r) r.hidden = on;
    syncReal(); if (on && S.sel === d.id) S.sel = null;
    renderTree(); renderDevInsp(); mark("geom");
  }

  /* ----- the inspector (right, "Device"): a device, or the case ----- */
  const ledPick = (d) => `${(d.led0 || 0) + 1} / ${d.n}`;
  let multi = false, tplAsk = null;
  function renderDevInsp() {
    const el = $("#devi"); if (!el) return; closePop();
    if (S.sel === "case") return renderCaseInsp(el);
    const x = selDev();
    if (!x || x._hid) { el.innerHTML = `<div class="ra-note ra-empty">${t("ra.pick")}</div>`; return; }
    const st = devState(x), fit = slots().filter((s) => fits(x, s)), mine = placesOf(x);
    const parts = x.parts || (x.slot ? [{ slot: x.slot, n: x.n }] : []);
    el.innerHTML = `<div class="ra-ih">${icon(x.type)}<b class="ra-title" title="${esc(x.name)}">${esc(x.name)}</b>${stateTag(st)}<span class="sp"></span>
        <button class="btn ra-ic" id="dfoc" title="${t("ra.focusTip")}" aria-label="${t("ra.focusTip")}">${ICO.focus}</button>
        ${st === "ok" ? `<button class="btn ra-sm" id="blk" title="${t("ra.blinkTip")}">${t("ra.blink")}</button>` : ""}</div>
      <span class="ra-scan" data-m="${x.id}">${"<b></b>".repeat(Math.min(x.n, 24))}</span>
      ${x.link && !(real && (real.find((q) => q.key === linkKey(x.link)) || {}).stored) ? `<div class="ra-grow"><span class="cap" title="${t("ra.driveTip")}">${t("ra.drive")}</span><span class="sp"></span>
        <span class="seg ra-s" id="drv">${[["scene", t("ra.drScene")], ["look", t("ra.drLook")], ["free", t("ra.drFree")]].map(([v, n]) => `<button data-dv="${v}" class="${drive(x) === v ? "on" : ""}">${n}</button>`).join("")}</span></div>
        ${drive(x) === "look" ? `<div class="ra-grow"><span class="rsw ra-sw">${["#c6f432", "#ff4d4d", "#ffb454", "#2ee6a8", "#38b6ff", "#8a6bff", "#ff5fd2", "#ffffff"].map((c) => `<button data-lc="${c}" style="--c:${c}" aria-label="${c}"></button>`).join("")}</span><span class="sp"></span><button class="btn ra-sm" id="toSimple" title="${t("ra.toSimpleTip")}">${t("ra.toSimple")}</button></div>` : ""}` : ""}
      ${fit.length ? `<div class="ra-grow"><span class="cap" title="${t("ra.slotTip")}">${t("ra.slot")}</span><span class="sp"></span>
          <button class="ra-chip ${multi ? "on" : ""}" id="mlt" aria-pressed="${multi}" title="${t("ra.multiTip")}">${t("ra.multi")}</button></div>
        <div class="ra-chips" id="slc">${fit.map((s) => `<button class="ra-chip ${mine.includes(s.id) ? "on" : ""}" data-slot="${s.id}" ${taken(s, x) ? `data-busy="1" title="${t("ra.slotBusy")}"` : ""}>${esc(slotName(s))}</button>`).join("")}</div>
        ${parts.length > 1 ? `<div class="ra-parts">${parts.map((p, i) => { const s = slotById(p.slot); return s ? `<label class="ra-part"><span>${esc(slotName(s))}</span><input class="ra-num" type="number" min="1" max="200" value="${p.n}" data-pn="${i}" aria-label="${t("ra.partLeds")}" title="${t("ra.partLeds")}"><small>LED</small></label>` : ""; }).join("")}</div>` : ""}
        ${parts.length > 1 && x._leds && x._leds < x.n ? `<div class="ra-note ra-warn" title="${t("ra.fewLedsTip")}">${t("ra.fewLeds", { n: x._leds })}</div>` : ""}` : ""}
      <div class="ra-sep"></div>
      ${rng("X", x.x, -60, 90, 0.5, (v) => v.toFixed(1), (v) => { x.x = v; moved(x); }, t("ra.xTip"), "i-x", 1)}
      ${rng("Y", x.y, -5, 60, 0.5, (v) => v.toFixed(1), (v) => { x.y = v; moved(x); }, t("ra.yTip"), "i-y", 1)}
      ${rng("Z", x.z, -40, 40, 0.5, (v) => v.toFixed(1), (v) => { x.z = v; moved(x); }, t("ra.zTip"), "i-z", 1)}
      ${rng(t("ra.rotate"), x.rot, 0, 359, 1, (v) => v + "°", (v) => { x.rot = S.snap ? Math.round(v / 15) * 15 % 360 : v; moved(x); }, t("ra.rotTip"), "i-rot", 1, 0)}
      ${rng(t("ra.scale"), x.sc, 0.5, 2, 0.05, (v) => v.toFixed(2) + "×", (v) => { x.sc = v; moved(x); }, t("ra.scaleTip"), "i-sc", 1, 1)}
      <div class="ra-grow"><span class="seg ra-s" id="sSeg" title="${t("ra.snapTip")}">${[["0", t("ra.free")], ["1", "1"], ["2", "2"], ["5", "5"]].map((s) => `<button data-s="${s[0]}" class="${+s[0] === S.snap ? "on" : ""}">${s[1]}</button>`).join("")}</span><span class="sp"></span>
        <button class="btn ra-ic" id="drot" title="${t("ra.rot90")}" aria-label="${t("ra.rot90")}">${ICO.rot}</button>
        <button class="btn ra-ic" id="ddup" title="${t("ra.dup")}" aria-label="${t("ra.dup")}">${ICO.dup}</button>
        ${x.link ? `<button class="btn ra-ic" id="dhid" title="${t("ra.hideTip")}" aria-label="${t("ra.hideTip")}">${ICO.hide}</button>` : ""}
        <button class="btn ra-ic" id="ddel" title="${t("ra.remove")}" aria-label="${t("ra.remove")}">${ICO.del}</button></div>
      ${x.n > 1 ? `<div class="ra-sep"></div>
      <div class="ra-grow" title="${t("ra.led0Tip")}"><span class="cap">${t("ra.led0")}</span><span class="sp"></span>
        <button class="btn ra-ic" id="l0m" aria-label="${t("ra.led0Prev")}" title="${t("ra.led0Prev")}">‹</button><span class="ra-val ra-l0" id="l0v">${ledPick(x)}</span><button class="btn ra-ic" id="l0p" aria-label="${t("ra.led0Next")}" title="${t("ra.led0Next")}">›</button></div>
      <div class="ra-grow"><span class="cap">${t("ra.ledDir")}</span><span class="sp"></span><span class="seg ra-s" id="revSeg"><button data-r="0" class="${x.rev ? "" : "on"}">${t("ra.ledFwd")}</button><button data-r="1" class="${x.rev ? "on" : ""}">${t("ra.ledRev")}</button></span></div>` : ""}
      ${S.layers.length ? `<div class="ra-sep"></div><div class="cap" title="${t("ra.onDevTip")}">${t("ra.onDev")}</div>
      <div class="ra-cks">${S.layers.map((L, i) => `<label class="ra-ck"><input type="checkbox" data-lk="${i}" ${skips(L, x.id) ? "" : "checked"}><span>${gName(L.gen)}</span><span class="ra-gp" style="background:${gradCss(L.stops)}"></span></label>`).join("")}</div>` : ""}
      <div class="ra-sep"></div>
      ${rng(t("rgb.brightness"), x.trim, 0, 100, 1, (v) => v + "%", (v) => { x.trim = v; persist(); }, t("ra.trimTip"), "d-tr", 1, 100)}
      ${rng(t("ra.delay"), x.delay, -500, 1000, 10, (v) => v + " ms", (v) => { x.delay = v; persist(); }, t("ra.delayTip"), "d-dl", 1, 0)}
      <div class="ra-grow"><button class="btn ra-sm" id="calb" title="${t("ra.calTip")}">${t("ra.cal")}</button><span class="sp"></span><button class="btn ra-sm" id="lrest" title="${t("ra.likeRestTip")}">${t("ra.likeRest")}</button></div>`;
    wire(el);
    $("#dfoc").onclick = () => focusSel();
    el.querySelectorAll("[data-dv]").forEach((b) => { b.onclick = () => { if (drive(x) !== b.dataset.dv) setDrive(x, b.dataset.dv); }; });
    el.querySelectorAll("[data-lc]").forEach((b) => { b.onclick = () => setDrive(x, "look", b.dataset.lc); });
    const ts = $("#toSimple"); if (ts) ts.onclick = () => App.RGB.view("simple");
    const blk = $("#blk");
    if (blk) blk.onclick = () => {
      blk.disabled = true; blk.textContent = App.t("ra.blinking");
      api.invoke("rgb_blink", { name: x.link.name, nth: x.link.nth | 0 }).catch((e) => App.toast(App.t("rgb.err", { err: e }), "err"));
      setTimeout(() => { if (blk.isConnected) { blk.disabled = false; blk.textContent = App.t("ra.blink"); } }, 3000);
    };
    const ml = $("#mlt"); if (ml) ml.onclick = () => { multi = !multi; renderDevInsp(); };
    el.querySelectorAll("[data-slot]").forEach((b) => { b.onclick = () => {
      const s = slotById(b.dataset.slot); if (!s) return;
      if (multi) {   // several places: the slot joins (or leaves) this device's parts; LEDs split evenly
        const cur = parts.map((p) => p.slot), on = cur.includes(s.id), next = on ? cur.filter((id) => id !== s.id) : cur.concat([s.id]);
        if (!next.length) return;
        const other = S.devices.find((o) => o !== x && placesOf(o).includes(s.id)); if (!on && other) { delete other.slot; delete other.parts; rowLabel(other); }
        const deflt = (id) => (slotById(id).k === "ring" ? 8 : 10);   // a fan ring usually has 8 LEDs, an edge 10
        const nParts = next.map((id) => ({ slot: id, n: (x.parts && (x.parts.find((p) => p.slot === id) || {}).n) || deflt(id) }));
        if (nParts.length > 1) { x.parts = nParts; x.slot = nParts[0].slot; } else { delete x.parts; x.slot = nParts[0].slot; }
        placeDev(x);
      } else {
        // a taken slot: the two devices swap places (the other one gets this one's slot, if it fits there)
        const other = S.devices.find((o) => o !== x && placesOf(o).includes(s.id)), mineS = x.slot && slotById(x.slot);
        if (other) { if (mineS && fits(other, mineS) && !x.parts) placeIn(other, mineS); else { delete other.slot; delete other.parts; } }
        placeIn(x, s);
      }
      syncTree(); renderDevInsp(); persist();
    }; });
    el.querySelectorAll("[data-pn]").forEach((inp) => { inp.onchange = () => {
      const i = +inp.dataset.pn, v = clamp(Math.round(+inp.value) || 1, 1, 200); inp.value = v;
      if (x.parts && x.parts[i]) { x.parts[i].n = v; placeDev(x); renderDevInsp(); persist(); }
    }; });
    $("#sSeg").onclick = (e) => { const v = e.target.dataset.s; if (v != null) { S.snap = +v; [...$("#sSeg").children].forEach((b) => b.classList.toggle("on", b === e.target)); persist(); } };
    $("#drot").onclick = () => rotDev(x, 90); $("#ddel").onclick = () => removeDev(x.id);
    const dh = $("#dhid"); if (dh) dh.onclick = () => hideDev(x, true);
    $("#ddup").onclick = () => {
      const n = Object.assign(cl(x), { id: nextId++, name: App.t("ra.devCopy", { name: x.name }), x: clamp(x.x + 4, -60, 90), z: clamp(x.z + 4, -40, 40) });
      delete n.link; delete n.slot; delete n.parts; delete n._b; S.devices.push(n); S.sel = n.id; renderTree(); renderDevInsp(); persist();
    };
    const step = (k) => {   // LED 0 moves one place along the device: the layout turns, the device stays
      const n = x.pts.length; k = ((k % n) + n) % n;
      x.pts = x.pts.slice(k).concat(x.pts.slice(0, k)); x.led0 = ((x.led0 || 0) + k) % n;
      $("#l0v").textContent = ledPick(x); persist();
    };
    if ($("#l0m")) { $("#l0m").onclick = () => step(-1); $("#l0p").onclick = () => step(1); }
    const rs = $("#revSeg");
    if (rs) rs.onclick = (e) => {
      const v = e.target.dataset.r; if (v == null || (v === "1") === !!x.rev) return;
      x.rev = v === "1";
      // LED 0 stays on the same LED: reversing mirrors the order, so its offset is counted from the other end
      if (placesOf(x).length) { x.led0 = (x.n - (x.led0 || 0)) % x.n; placeDev(x); $("#l0v").textContent = ledPick(x); } else { x.pts = [x.pts[0]].concat(x.pts.slice(1).reverse()); }   // LED 0 stays, the others run the other way
      [...rs.children].forEach((b) => b.classList.toggle("on", b === e.target)); persist();
    };
    el.querySelectorAll("[data-lk]").forEach((c) => { c.onchange = () => { setSkip(S.layers[+c.dataset.lk], x.id, !c.checked); syncAp(); persist(); }; });
    $("#calb").onclick = () => App.RGBCalib && App.RGBCalib.open();
    $("#lrest").onclick = () => {
      x.trim = 100; x.delay = 0; S.layers.forEach((L) => setSkip(L, x.id, false));
      renderDevInsp(); syncAp(); persist();
    };
  }
  /** the case: its template (changing it asks first), where it stands on the desk and which way it faces */
  function renderCaseInsp(el) {
    const cb = caseBox(S.tpl);
    el.innerHTML = `<div class="ra-ih">${icon("case")}<b class="ra-title">${t("ra.case2")}</b><span class="sp"></span>
        ${cb ? `<button class="btn ra-ic" id="dfoc" title="${t("ra.focusTip")}" aria-label="${t("ra.focusTip")}">${ICO.focus}</button>` : ""}</div>
      <div class="ra-grow" title="${t("ra.tplTip")}"><span class="cap">${t("ra.tplLabel")}</span><span class="sp"></span>
        <select class="ra-selx" id="tplx" aria-label="${t("ra.tplTip")}">${Object.keys(CASES).map((k) => `<option value="${k}" ${k === (tplAsk || S.tpl) ? "selected" : ""}>${t("ra.tpl." + k)}</option>`).join("")}</select></div>
      ${tplAsk ? `<div class="ra-ask" role="alertdialog"><span>${t("ra.tplAsk", { name: App.t("ra.tpl." + tplAsk) })}</span>
        <span class="ra-grow"><span class="sp"></span><button class="btn ra-sm" id="tplno">${t("ra.cancel")}</button><button class="btn ra-sm acc" id="tplok">${t("ra.tplOk")}</button></span></div>` : ""}
      ${cb ? `<div class="ra-sep"></div>
      ${rng("X", S.caseAt[0], -60, 90, 0.5, (v) => v.toFixed(1), (v) => { moveCase(v - S.caseAt[0], 0, 0); }, t("ra.caseXTip"), "c-x", 1, 0)}
      ${rng("Z", S.caseAt[1], -40, 40, 0.5, (v) => v.toFixed(1), (v) => { moveCase(0, v - S.caseAt[1], 0); }, t("ra.zTip"), "c-z", 1, 0)}
      <div class="ra-grow"><span class="cap">${t("ra.facing")}</span><span class="ra-val">${S.caseRot || 0}°</span><span class="sp"></span>
        <button class="btn ra-sm ${S.caseFlip ? "on" : ""}" id="cflip" title="${t("ra.flipTip")}" aria-pressed="${!!S.caseFlip}">${t("ra.flip")}</button>
        <button class="btn ra-sm" id="crot" title="${t("ra.caseRotTip")}">${ICO.rot} 90°</button></div>
      <div class="ra-note">${t("ra.caseNote")}</div>` : `<div class="ra-note">${t("ra.noCase")}</div>`}`;
    wire(el);
    const f = $("#dfoc"); if (f) f.onclick = () => focusSel();
    $("#tplx").onchange = (e) => { const v = e.target.value; tplAsk = v === S.tpl ? null : v; renderDevInsp(); };
    if (tplAsk) { $("#tplno").onclick = () => { tplAsk = null; renderDevInsp(); }; $("#tplok").onclick = () => { const v = tplAsk; tplAsk = null; setTpl(v); }; }
    const cr = $("#crot"); if (cr) cr.onclick = () => { moveCase(0, 0, 90); renderDevInsp(); };
    const cf = $("#cflip"); if (cf) cf.onclick = () => { flipCase(); renderDevInsp(); };
  }
  /** a device moved by hand leaves its place(s) */
  function moved(d) { if (d.slot || d.parts) { delete d.slot; delete d.parts; rowLabel(d); root.querySelectorAll("#slc .on").forEach((c) => c.classList.remove("on")); } persist(); }
  function updInsp() {
    const d = selDev(); if (d) { setRange($("#i-x"), d.x); setRange($("#i-y"), d.y); setRange($("#i-z"), d.z); setRange($("#i-rot"), d.rot); setRange($("#i-sc"), d.sc); }
    if (S.sel === "case") { setRange($("#c-x"), S.caseAt[0]); setRange($("#c-z"), S.caseAt[1]); }
  }
  function rotDev(d, a) { d.rot = (d.rot + a) % 360; updInsp(); moved(d); }
  function addReal(r) { const d = placeReal(r); save(); api.invoke("rgb_follow", { name: r.link.name, nth: r.link.nth | 0 }).then(refreshDrive, () => {});   // added on purpose: it follows the effect
    syncReal(); S.sel = d.id; S.tab = "dev"; syncTabs(); renderTree(); renderDevInsp(); persist(); }
  function removeDev(id) {
    const gone = S.devices.find((d) => d.id === id); if (!gone) return;
    const snap = snapshot();
    undoable(App.t("ra.removed", { name: gone.name }), snap);
    S.devices = S.devices.filter((d) => d.id !== id); S.layers.forEach((L) => setSkip(L, id, false));
    if (S.originDev === id) S.originDev = null;
    if (S.sel === id) S.sel = null;
    renderTree(); renderDevInsp(); renderFx(); persist();
  }

  /* ----- the scene's own settings (right, always shown) ----- */
  function renderScene() {
    const el = $("#scp"); if (!el) return;
    el.innerHTML = `<span class="cap">${t("ra.scene")}</span>`
      + rng(t("ra.speed"), S.speed, 0, 3, 0.01, (v) => Math.round(v * 100) + "%", (v) => { S.speed = v; persist(); }, t("ra.speedTip"), "spd", 1, 1)
      + rng(t("rgb.brightness"), S.bright, 0, 100, 1, (v) => v + "%", (v) => { S.bright = v; persist(); }, t("ra.brightTip"), "bri", 1, 100)
      + rng(t("ra.fps"), S.fps, 5, 60, 1, (v) => v + " fps", (v) => { S.fps = v; persist(); }, t("ra.fpsTip"), "fps", 1, 30)
      + `<div class="ra-grow"><span class="sp"></span><button class="btn ra-sm" id="calb2" title="${t("ra.calTip")}">${t("ra.cal")}</button></div>`;
    wire(el);
    $("#calb2").onclick = () => App.RGBCalib && App.RGBCalib.open();
  }

  /* ----- effect panel ----- */
  const PDEF = {
    speed: { k: "ra.speed", min: 0, max: 3, step: 0.01, f: (v) => v.toFixed(2) + "×", tip: "ra.speedFxTip" },
    scale: { k: "ra.scale", min: 0.25, max: 4, step: 0.01, f: (v) => v.toFixed(2) + "×", tip: "ra.scaleFxTip" },
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
      <div class="ra-layers" id="layers" title="${t("ra.layersTip")}"></div>
      <div class="ra-sep"></div>
      <div class="ra-grow"><span class="cap" title="${t("ra.originTip")}">${t("ra.origin")}</span><span class="sp"></span>
        <select class="ra-selx ra-pin" id="opin" aria-label="${t("ra.pinTip")}" title="${t("ra.pinTip")}"><option value="">${t("ra.originFree")}</option>${S.devices.map((d) => `<option value="${d.id}" ${S.originDev === d.id ? "selected" : ""}>${esc(d.name)}</option>`).join("")}</select></div>
      <div id="orgp" class="ra-orgp">${["x", "y", "z"].map((a, i) => rng(a.toUpperCase(), S.origin[i], [-60, 0, -40][i], [60, 60, 40][i], 0.5, (v) => v.toFixed(1), (v) => { S.origin[i] = v; unpin(); persist(); }, "cm", "o-" + a, 1, [0, 18, 0][i])).join("")}</div>`;
    wire($("#orgp"));
    $("#opin").onchange = (e) => { S.originDev = e.target.value === "" ? null : +e.target.value; mark("geom"); persist(); };
    $("#fxm").onclick = (e) => openPop(e.currentTarget, "", (p) => {
      p.innerHTML = `<div class="ra-menu"><div class="cap ra-mh">${t("ra.presets")}</div>${PRESETS.map((x, i) => `<button class="ra-mi ${S.fxName === x.name ? "on" : ""}" data-p="${i}">${t(x.key)}</button>`).join("")}
        ${S.mine.length ? `<div class="cap ra-mh">${t("ra.mine")}</div>${S.mine.map((m, i) => `<div class="ra-mrow"><button class="ra-mi ${S.fxName === m.name ? "on" : ""}" data-m="${i}">${esc(m.name)}</button><button class="btn ra-ic" data-md="${i}" title="${t("ra.del")}" aria-label="${t("ra.del")}">${ICO.del}</button></div>`).join("")}` : ""}
        <div class="ra-sep"></div><button class="ra-mi" id="fxr" title="${t("ra.randomTip")}">${ICO.dice}${t("ra.random")}</button>
        <div class="ra-save"><input type="text" id="fxn" maxlength="28" placeholder="${t("ra.name")}" aria-label="${t("ra.name")}"><button class="btn ra-sm" id="fxs" title="${t("ra.saveTip")}">${t("ra.save")}</button></div>
        <div class="ra-save" title="${t("share.fxTip")}"><input type="text" id="fxin" spellcheck="false" placeholder="${t("share.paste")}" aria-label="${t("share.paste")}"><button class="btn ra-sm" id="fxcp" title="${t("share.copyTip")}">${t("share.copy")}</button></div></div>`;
      // share codes: this effect as a line of text, or someone's effect pasted in (it joins "Mine")
      const fin = p.querySelector("#fxin");
      p.querySelector("#fxcp").onclick = async () => {
        const code = await App.share.encode("FX", { name: fxLabel(S.fxName), layers: cl(S.layers).map((l) => { delete l.skip; return l; }) });
        App.toast(App.t((await App.share.copy(code, fin)) ? "share.copied" : "share.selected"));
      };
      const take = async () => {
        const v = await App.share.decode("FX", fin.value), layers = v && Array.isArray(v.layers) ? v.layers.slice(0, 12).map(cleanLayer).filter(Boolean) : [];
        if (!layers.length) { App.toast(App.t("share.bad"), "err"); return; }
        let name = String(v.name || App.t("share.shared")).slice(0, 28) || App.t("share.shared");
        for (let i = 2, base = name; S.mine.some((m) => m.name === name) || PRESETS.some((x) => x.name === name); i++) name = base + " " + i;
        S.mine.push({ name, layers: cl(layers) }); S.layers = layers; S.fxName = name; S.selLayer = 0;
        closePop(); renderFx(); persist(); App.toast(App.t("share.added", { name }));
      };
      fin.addEventListener("keydown", (e) => { if (e.key === "Enter") take(); });
      fin.addEventListener("paste", () => setTimeout(take));
      p.querySelectorAll("[data-p]").forEach((b) => { b.onclick = () => loadPreset(+b.dataset.p); });
      p.querySelectorAll("[data-m]").forEach((b) => { b.onclick = () => { const m = S.mine[+b.dataset.m]; S.layers = cl(m.layers); S.fxName = m.name; S.selLayer = 0; renderFx(); persist(); }; });
      p.querySelectorAll("[data-md]").forEach((b) => { b.onclick = () => { S.mine.splice(+b.dataset.md, 1); renderFx(); persist(); }; });
      p.querySelector("#fxr").onclick = randomise;
      p.querySelector("#fxs").onclick = () => {
        const typed = (p.querySelector("#fxn").value || "").trim();
        const n = typed || (S.fxName === "Custom" || S.fxName === "Random" ? App.t("ra.myEffect", { n: S.mine.length + 1 }) : App.t("ra.copy", { name: fxLabel(S.fxName) }));
        // a saved effect is for any setup: which devices a layer skips belongs to this scene only
        S.mine.push({ name: n, layers: cl(S.layers).map((l) => { delete l.skip; return l; }) }); S.fxName = n; renderFx(); persist();
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
    if (p.origin === "gpu") { const g = S.devices.find((d) => d.type === "gpu"); if (g) { S.originDev = g.id; mark("geom"); } }
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
  let layFold = false;   // the selected layer's editor is folded away
  function renderLayers() {
    const box = $("#layers"); if (!box) return;
    box.innerHTML = S.layers.map((L, i) => { const on = i === S.selLayer; return `<div class="ra-lay ${on ? "sel" : ""} ${on && layFold ? "fold" : ""} ${L.on ? "" : "off"}" data-i="${i}">
      <div class="ra-lh" draggable="true" data-i="${i}"><span class="ra-grip" title="${t("ra.drag")}">${ICO.grip}</span>
        <button class="ra-pw" data-on="${i}" aria-pressed="${L.on}" aria-label="${t("ra.layerOn")}" title="${t(L.on ? "ra.disable" : "ra.enable")}"></button>
        <span class="ra-nm"><b>${gName(L.gen)}</b><small>${t("ra.b." + L.blend)} ${Math.round(L.opacity * 100)}%</small></span><span class="ra-gp" style="background:${gradCss(L.stops)}"></span>
        ${on ? `<button class="btn ra-ic" data-up="${i}" title="${t("ra.up")}" aria-label="${t("ra.up")}" ${i === S.layers.length - 1 ? "disabled" : ""}>${ICO.up}</button>
        <button class="btn ra-ic" data-dn="${i}" title="${t("ra.down")}" aria-label="${t("ra.down")}" ${i === 0 ? "disabled" : ""}>${ICO.down}</button>
        <button class="btn ra-ic" data-dup="${i}" title="${t("ra.dup")}" aria-label="${t("ra.dup")}">${ICO.dup}</button>
        <button class="btn ra-ic" data-rm="${i}" title="${t("ra.del")}" aria-label="${t("ra.del")}">${ICO.del}</button>` : ""}<span class="ra-fold" aria-hidden="true" title="${t("ra.foldTip")}">›</span></div>
      ${on ? layerEditor(L) : ""}</div>`; }).join("") || `<div class="ra-note">${t("ra.noLayers")}</div>`;
    wire(box);
    box.querySelectorAll(".ra-lh").forEach((hd) => {
      const i = +hd.dataset.i;
      hd.onclick = (e) => { if (e.target.closest("button") && !e.target.closest(".ra-nm")) return; if (i !== S.selLayer) { S.selLayer = i; layFold = false; renderLayers(); persist(); } else { layFold = !layFold; hd.parentElement.classList.toggle("fold", layFold); } };   // the open layer again: fold / unfold its editor in place
      hd.ondragstart = (e) => { dragFrom = i; e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", String(i)); } catch (x) { /* ignore */ } };
      hd.ondragover = (e) => { e.preventDefault(); hd.parentElement.classList.add("dragover"); };
      hd.ondragleave = () => hd.parentElement.classList.remove("dragover");
      hd.ondrop = (e) => { e.preventDefault(); hd.parentElement.classList.remove("dragover"); if (dragFrom >= 0) moveLayer(dragFrom, i); dragFrom = -1; };
    });
    const bind = (sel, fn) => box.querySelectorAll(sel).forEach((b) => { b.onclick = (e) => { e.stopPropagation(); fn(+b.dataset[Object.keys(b.dataset)[0]]); }; });
    bind("[data-on]", (i) => { S.layers[i].on = !S.layers[i].on; renderLayers(); persist(); syncWarn(); });
    bind("[data-up]", (i) => moveLayer(i, i + 1)); bind("[data-dn]", (i) => moveLayer(i, i - 1));
    bind("[data-dup]", (i) => { S.layers.splice(i + 1, 0, cl(S.layers[i])); S.selLayer = i + 1; S.fxName = "Custom"; renderFx(); persist(); });
    bind("[data-rm]", (i) => { undoable(App.t("ra.removed", { name: gName(S.layers[i].gen) }), snapshot()); S.layers.splice(i, 1); S.selLayer = clamp(S.selLayer, 0, Math.max(0, S.layers.length - 1)); S.fxName = "Custom"; renderFx(); persist(); });
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
      ${GP[L.gen].map((k) => { const d = PDEF[k]; return rng(t(d.k), L.p[k], d.min, d.max, d.step, d.f, (v) => { L.p[k] = v; mark1(); }, t(d.tip), "l-" + k, 1, dflt()[k]); }).join("")}
      ${S.devices.length ? `<div class="ra-grow" title="${t("ra.appliesTip")}"><span class="cap">${t("ra.appliesTo")}</span><span class="sp"></span><button class="ra-chip" data-ap="*">${t("ra.everything")}</button></div>
      <div class="ra-chips" id="apc">${TORDER.filter((tp) => S.devices.some((d) => d.type === tp && fxable(d))).map((tp) => `<button class="ra-chip" data-ap="${tp}">${t("ra.grp." + tp)}</button>`).join("")}</div>` : ""}
      <div data-grad></div>
      ${rng(t("ra.opacity"), Math.round(L.opacity * 100), 0, 100, 1, (v) => v + "%", (v) => { L.opacity = v / 100; sum(); mark1(); }, "", null, 1, 100)}
      ${L.gen === "audio" ? `<div class="ra-scan" id="lvl" title="${t("ra.audioTip")}">` + "<b></b>".repeat(24) + "</div>" : ""}
    </div>`;
  }
  function editorBind(ed, L) {
    ed.querySelector("[data-gen]").onchange = (e) => { L.gen = e.target.value; L.stops = newLayer(L.gen).stops; S.fxName = "Custom"; renderLayers(); persist(); const c = $("#fxname"); if (c) c.textContent = fxLabel("Custom"); };
    ed.querySelector("[data-blend]").onchange = (e) => { L.blend = e.target.value; L._sum(); L._mark(); };
    const ax = ed.querySelector("[data-axis]"); if (ax) ax.onclick = (e) => { const v = e.target.dataset.v; if (v == null) return; L.p.axis = +v; [...ax.children].forEach((b) => b.classList.toggle("on", b === e.target)); L._mark(); };
    const m = ed.querySelector("[data-mirror]"); if (m) m.onclick = () => { L.p.mirror = !L.p.mirror; m.classList.toggle("on", L.p.mirror); L._mark(); };
    mountGrad(ed.querySelector("[data-grad]"), L);
    // "Applies to": a group chip turns the layer off (or on again) for every device of that kind
    ed.querySelectorAll("[data-ap]").forEach((b) => { b.onclick = () => {
      const tp = b.dataset.ap, ids = S.devices.filter((d) => fxable(d) && (tp === "*" || d.type === tp)).map((d) => d.id);
      const anyOn = ids.some((id) => !skips(L, id));
      ids.forEach((id) => setSkip(L, id, tp === "*" ? false : anyOn));
      syncAp(); persist();
      if (S.tab === "dev") renderDevInsp();
    }; });
    syncAp();
  }
  /** the state of the "Applies to" chips of the open layer, updated in place */
  function syncAp() {
    const L = S.layers[S.selLayer], box = root && root.querySelector(".ra-le"); if (!L || !box) return;
    box.querySelectorAll("[data-ap]").forEach((b) => {
      const tp = b.dataset.ap, ids = S.devices.filter((d) => fxable(d) && (tp === "*" || d.type === tp)).map((d) => d.id);
      const on = ids.filter((id) => !skips(L, id)).length;
      b.classList.toggle("on", tp === "*" ? on === ids.length : on > 0);
      b.classList.toggle("part", tp !== "*" && on > 0 && on < ids.length);
      b.setAttribute("aria-pressed", tp === "*" ? on === ids.length : on > 0);
    });
  }
  /** the origin was moved by hand: it no longer follows a device */
  function unpin() { if (S.originDev != null) { S.originDev = null; const p = $("#opin"); if (p) p.value = ""; } }
  function mountGrad(el, L) {
    let cur = L.stops[0];
    const caption = L.gen === "scan" || L.gen === "radial" ? [t("ra.gradTail"), t("ra.gradHead")] : MASK[L.gen] ? [t("ra.gradLow"), t("ra.gradHigh")] : null;
    el.innerHTML = `<div class="ra-gbar" title="${t("ra.gradTip")}"></div>${caption ? `<div class="ra-gcap"><span>${caption[0]}</span><span>${caption[1]}</span></div>` : ""}
      <div class="ra-grow"><input type="color" aria-label="${t("ra.stopColour")}" title="${t("ra.stopColour")}"><span class="ra-val" data-pos></span><span class="sp"></span><button class="btn ra-sm" data-rs title="${t("ra.stopRemove")}">${t("ra.removeBtn")}</button></div>`;
    el.className = "ra-gedit";
    const bar = el.querySelector(".ra-gbar"), ci = el.querySelector("input"), pv = el.querySelector("[data-pos]"), rs = el.querySelector("[data-rs]");
    const paint = () => {
      ci.value = cur.c; pv.textContent = Math.round(cur.p * 100) + "%"; rs.disabled = L.stops.length <= 2;
      bar.querySelectorAll(".ra-gs").forEach((hd, i) => hd.classList.toggle("on", L.stops[i] === cur));
    };
    const sync = (first) => {
      // drawing the editor is not a change: only an edit turns the effect into "Custom"
      L.stops.sort((a, b) => a.p - b.p); bar.style.background = gradCss(L.stops); L._sum(); if (!first) L._mark();
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
    sync(true);
  }

  /* ---------------- stage: camera + projection ---------------- */
  const pr = [0, 0, 0, 1]; const CAM = { c: [0, 0, 0], f: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0], foc: 400 };
  const G = { yaw: 0, pitch: 0, dist: 150, t: [0, 18, 0] };   // camera goal, eased towards each frame
  function setupCam() {
    const { yaw, pitch, dist, t: tg } = S.cam, cp = Math.cos(pitch);
    const cx = tg[0] + dist * cp * Math.sin(yaw), cy = tg[1] + dist * Math.sin(pitch), cz = tg[2] + dist * cp * Math.cos(yaw);
    let fx = tg[0] - cx, fy = tg[1] - cy, fz = tg[2] - cz; const fl = Math.hypot(fx, fy, fz); fx /= fl; fy /= fl; fz /= fl;
    let rx = -fz, rz = fx; const rl = Math.hypot(rx, rz); rx /= rl; rz /= rl;      // cross(f, up): right, so up (below) points up
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
  /** 3D: where the ray under a screen pixel meets the plane "coordinate ax = val" (null if it never does in front) */
  function rayAt(mx, my, ax, val) {
    const a = (mx - CW / 2) / CAM.foc, b = -(my - CH / 2) / CAM.foc, d = [0, 1, 2].map((i) => CAM.f[i] + CAM.r[i] * a + CAM.u[i] * b);
    if (Math.abs(d[ax]) < 1e-4) return null;
    const tt = (val - CAM.c[ax]) / d[ax]; if (tt < 0) return null;
    return [CAM.c[0] + d[0] * tt, CAM.c[1] + d[1] * tt, CAM.c[2] + d[2] * tt];
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
  /** the whole lit space in view */
  function fitView() { focusBox(FB[0], FB[1]); }
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
  let NL = 0, LP = new Float32Array(3), XS = new Float32Array(1), YS = new Float32Array(1), DS = new Float32Array(1), RS = new Float32Array(1), CR = new Float32Array(1), CG = new Float32Array(1), CB = new Float32Array(1), ORD = new Uint32Array(1), HID = new Uint8Array(1);
  const DST = [];
  /** world position of a point in a device's own space */
  const W = (d, p) => { const a = d.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [d.x + (p[0] * c + p[2] * s) * d.sc, d.y + p[1] * d.sc, d.z + (-p[0] * s + p[2] * c) * d.sc]; };
  /** the corners (world space) of the outline drawModel draws for a device, so that a click on a card's body picks the
      card and not only a click on its single LED */
  function modelCorners(d) {
    if (!d.pts || !d.pts.length) return [];
    for (const id of placesOf(d)) { const s = slotById(id); if (s && s.boxW && ["gpu", "ram", "header", "strip"].includes(d.type)) return s.boxW; }
    const lo = [0, 1, 2].map((k) => Math.min(...d.pts.map((p) => p[k]))), hi = [0, 1, 2].map((k) => Math.max(...d.pts.map((p) => p[k])));
    const box = (a, z) => corners([a, z]).map((p) => W(d, p)), cx = (lo[0] + hi[0]) / 2, cz = (lo[2] + hi[2]) / 2;
    switch (d.type) {
      case "gpu": { const L = Math.max(28, hi[0] - lo[0] + 4); return box([cx - L / 2, hi[1] - 11, cz - 2.5], [cx + L / 2, hi[1] + 0.5, cz + 2.5]); }
      case "keyboard": return box([lo[0] - 1, lo[1] - 1.2, lo[2] - 1], [hi[0] + 1, lo[1] + 0.2, hi[2] + 1]);
      case "ram": return box([lo[0] - 0.5, lo[1] - 1, lo[2] - 0.5], [hi[0] + 0.5, hi[1] + 1, hi[2] + 0.5]);
      case "mouse": return box([cx - 3.4, lo[1] - 2.5, cz - 6.2], [cx + 3.4, lo[1] + 1.1, cz + 6.2]);
      default: return [];
    }
  }
  function rebuildGeom() {
    let n = 0; for (const d of S.devices) n += d.n;
    if (n !== NL) { NL = n; const m = Math.max(1, n); LP = new Float32Array(m * 3); XS = new Float32Array(m); YS = new Float32Array(m); DS = new Float32Array(m); RS = new Float32Array(m); CR = new Float32Array(m); CG = new Float32Array(m); CB = new Float32Array(m); ORD = new Uint32Array(m); HID = new Uint8Array(m); }
    DST.length = 0; let o = 0;
    for (const d of S.devices) {
      DST.push(o); const pts = ptsOf(d), a = d.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      for (let i = 0; i < pts.length; i++, o++) {
        const p = pts[i];
        LP[o * 3] = d.x + (p[0] * c + p[2] * s) * d.sc; LP[o * 3 + 1] = d.y + p[1] * d.sc; LP[o * 3 + 2] = d.z + (-p[0] * s + p[2] * c) * d.sc;
        HID[o] = d._hid ? 1 : 0;
      }
    }
    DST.push(o);
    // the space the field is drawn in: around the shown LEDs, not the whole room
    const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (let i = 0; i < NL; i++) { if (HID[i]) continue; for (let k = 0; k < 3; k++) { const v = LP[i * 3 + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; } }
    FB = lo[0] < 1e9 ? [lo.map((v) => v - 4), hi.map((v) => v + 4)] : [[-46, 0, -22], [50, 46, 22]];
    // an origin pinned to a device sits in the middle of its LEDs and follows it
    const di = S.originDev == null ? -1 : S.devices.findIndex((d) => d.id === S.originDev);
    if (di >= 0 && DST[di + 1] > DST[di]) {
      const a = DST[di], b = DST[di + 1], m = [0, 0, 0];
      for (let i = a; i < b; i++) for (let k = 0; k < 3; k++) m[k] += LP[i * 3 + k] / (b - a);
      for (let k = 0; k < 3; k++) { S.origin[k] = r2(m[k]); setRange($("#o-" + "xyz"[k]), S.origin[k]); }
    }
  }
  let FB = [[-46, 0, -22], [50, 46, 22]];
  function projectAll() {
    S.devices.forEach((d, di) => {
      const b = d._b || (d._b = [0, 0, 0, 0]); let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (let i = DST[di]; i < DST[di + 1]; i++) {
        if (!d._hid && proj(LP[i * 3], LP[i * 3 + 1], LP[i * 3 + 2])) {
          XS[i] = pr[0]; YS[i] = pr[1]; DS[i] = pr[2]; RS[i] = Math.max(1.8, pr[3] * 0.6);
          if (pr[0] < x0) x0 = pr[0]; if (pr[0] > x1) x1 = pr[0]; if (pr[1] < y0) y0 = pr[1]; if (pr[1] > y1) y1 = pr[1];
        } else XS[i] = NaN;   // hidden devices are not drawn and cannot be clicked
      }
      d._bd = x0 <= x1 ? [x0, y0, x1, y1] : null;   // around the LED dots only: where a dragged device is, for snapping into a place
      d._bm = null;   // the box of its model (a card's body, a keyboard plate...), when it has one
      if (x0 <= x1) for (const q of modelCorners(d)) if (proj(q[0], q[1], q[2])) {
        d._bm = d._bm || [1e9, 1e9, -1e9, -1e9];
        if (pr[0] < d._bm[0]) d._bm[0] = pr[0]; if (pr[0] > d._bm[2]) d._bm[2] = pr[0]; if (pr[1] < d._bm[1]) d._bm[1] = pr[1]; if (pr[1] > d._bm[3]) d._bm[3] = pr[1]; if (pr[0] < x0) x0 = pr[0]; if (pr[0] > x1) x1 = pr[0]; if (pr[1] < y0) y0 = pr[1]; if (pr[1] > y1) y1 = pr[1]; }
      if (x0 > x1) { b[0] = b[1] = b[2] = b[3] = NaN; return; }
      b[0] = x0 - 8; b[1] = y0 - 8; b[2] = x1 + 8; b[3] = y1 + 8;
    });
    for (let i = 0; i < NL; i++) ORD[i] = i;
    if (S.view === "3d") ORD.subarray(0, NL).sort((a, b) => DS[b] - DS[a]);
  }
  const wp = [0, 0, 0], OUT = [0, 0, 0], ENV = { origin: S.origin, level: 0, bright: 1 };
  const lvAt = (tm) => clamp(0.42 + 0.22 * Math.sin(tm * 3.1) + 0.14 * Math.sin(tm * 7.3 + 1) + 0.3 * Math.exp(-fract(tm * 2) * 4), 0, 1);
  /** every LED's colour, per device like the recorder does it (ml-rgb scene.rs plan): only the layers that act on the
      device, its delay, then its brightness. A device with fewer real LEDs than drawn points (a board that OpenRGB sees
      as one LED, spread over three fans) shows each real LED's colour, taken at the middle of its group of points, on
      every point of the group: what the hardware can actually show (the same rule as Device::world in scene.rs). */
  /** Where the devices that follow the effect lie along each Scan layer's direction, relative to the origin: the sweep covers
      exactly that (the recorder does the same, ml-rgb Scene::fit). What counts is what the hardware shows: a device with
      fewer real LEDs than drawn points counts with the middle of each group. Kept on the layer as a hidden property, so
      it is never saved. */
  function fitScan() {
    const o = S.origin;
    for (const L of S.layers) {
      if (L.gen !== "scan") continue;
      const u = dirOf(L); let lo = 1e9, hi = -1e9;
      const at = (x, y, z) => { const s0 = (x - o[0]) * u[0] + (y - o[1]) * u[1] + (z - o[2]) * u[2], v = L.p.mirror ? Math.abs(s0) : s0; if (v < lo) lo = v; if (v > hi) hi = v; };
      S.devices.forEach((d, di) => {
        if (d._hid || drive(d) !== "scene") return;
        const a = DST[di], P = DST[di + 1] - a, n = d._leds > 0 && d._leds < P ? d._leds : P;
        for (let k = 0; k < n; k++) {
          const i0 = a + Math.floor(k * P / n), i1 = a + Math.floor((k + 1) * P / n); let x = 0, y = 0, z = 0;
          for (let i = i0; i < i1; i++) { x += LP[i * 3] / (i1 - i0); y += LP[i * 3 + 1] / (i1 - i0); z += LP[i * 3 + 2] / (i1 - i0); }
          at(x, y, z);
        }
      });
      Object.defineProperty(L, "ext", { value: lo <= hi ? [lo, hi] : null, writable: true, enumerable: false, configurable: true });
    }
  }
  function colorPass() {
    fitScan();
    ENV.origin = S.origin; ENV.level = lvAt(S.t); ENV.bright = S.bright / 100;
    const tLook = performance.now() / 1000;
    S.devices.forEach((d, di) => {
      const how = drive(d), a0 = DST[di], P0 = DST[di + 1] - a0;
      if (how === "look") {   // its own colour (the recorder shows it the same, with its own clock)
        const l = LOOKS.get(linkKey(d.link)), n = d._leds > 0 ? d._leds : P0;
        for (let i = 0; i < P0; i++) { const k = Math.floor(i * n / P0), c = lookAt(l, tLook, n > 1 ? k / (n - 1) : 0); CR[a0 + i] = c[0]; CG[a0 + i] = c[1]; CB[a0 + i] = c[2]; }
        return;
      }
      if (how === "free") {   // its own lighting: what OpenRGB last read from it, or dark
        const rc = d._cols || [];
        for (let i = 0; i < P0; i++) { const c = rc.length ? rc[Math.floor(i * rc.length / P0)] : [26, 28, 22]; CR[a0 + i] = c[0]; CG[a0 + i] = c[1]; CB[a0 + i] = c[2]; }
        return;
      }
      const ls = S.layers.some((L) => skips(L, d.id)) ? S.layers.filter((L) => !skips(L, d.id)) : S.layers;
      const tm = S.t - (d.delay || 0) / 1000, g = clamp(d.trim == null ? 100 : d.trim, 0, 100) / 100;
      const a = DST[di], P = DST[di + 1] - a, L = d._leds > 0 && d._leds < P ? d._leds : P;
      for (let k = 0; k < L; k++) {
        const i0 = a + Math.floor(k * P / L), i1 = a + Math.floor((k + 1) * P / L);
        wp[0] = wp[1] = wp[2] = 0;
        for (let i = i0; i < i1; i++) { wp[0] += LP[i * 3] / (i1 - i0); wp[1] += LP[i * 3 + 1] / (i1 - i0); wp[2] += LP[i * 3 + 2] / (i1 - i0); }
        colorAt(ls, wp, tm, ENV, OUT);
        for (let i = i0; i < i1; i++) { CR[i] = OUT[0] * g; CG[i] = OUT[1] * g; CB[i] = OUT[2] * g; }
      }
    });
  }

  /* ---------------- stage: drawing ---------------- */
  const BG = "#090a08", GRID = "#1b1e16", EDGE = "#3a4030", MODEL = "#343a2b", MONO = '10px "JetBrains Mono",Consolas,monospace';
  /** axis colours of the move handles (Blender's: X red, Y green, Z blue) */
  const AXC = ["#ff6b6b", "#8fdc6a", "#5aa9ff"];
  function lnTo(ax, ay, az, bx, by, bz) {
    if (!proj(ax, ay, az)) return; const x0 = pr[0], y0 = pr[1];
    if (!proj(bx, by, bz)) return; ctx.moveTo(x0, y0); ctx.lineTo(pr[0], pr[1]);
  }
  const edges = (c) => { for (const [i, j] of EDGES) lnTo(c[i][0], c[i][1], c[i][2], c[j][0], c[j][1], c[j][2]); };
  /** a simple outline of a device, so it reads as a thing and not just dots: a fan frame, a keyboard plate, a card, a
      stick, a headset's band and cups (strips and boards are their LEDs) */
  function drawModel(d) {
    if (d._hid || !d.pts || !d.pts.length) return;
    // a card, a stick, the I/O: the outline of the slot it sits in
    let drawn = false;
    for (const id of placesOf(d)) { const s = slotById(id); if (s && s.boxW && ["gpu", "ram", "header", "strip"].includes(d.type)) { edges(s.boxW); drawn = true; } }
    // fans in ring slots: a square frame around each ring
    for (const id of placesOf(d)) {
      const s = slotById(id); if (!s || s.k !== "ring" || !["fan", "header", "strip"].includes(d.type)) continue;
      const r = s.r + 1.3, t = 1.2, [x, y, z] = s.c;
      const b = s.ax === "z" ? [[x - r, y - r, z - t], [x + r, y + r, z + t]] : s.ax === "x" ? [[x - t, y - r, z - r], [x + t, y + r, z + r]] : [[x - r, y - t, z - r], [x + r, y + t, z + r]];
      edges(corners(b));
    }
    if (drawn || placesOf(d).some((id) => { const s = slotById(id); return s && s.k === "ring"; })) return;
    const lo = [0, 1, 2].map((k) => Math.min(...d.pts.map((p) => p[k]))), hi = [0, 1, 2].map((k) => Math.max(...d.pts.map((p) => p[k])));
    const pad = (p) => [lo.map((v, k) => v - p[k]), hi.map((v, k) => v + p[k])];
    const boxL = (b) => edges(corners(b).map((p) => W(d, p)));
    if (d.type === "fan") boxL(pad(lo.map((v, k) => (hi[k] - v < 1 ? 1.2 : 1.5))));
    else if (d.type === "keyboard") { const b = pad([1, 0, 1]); b[0][1] = lo[1] - 1.2; b[1][1] = lo[1] + 0.2; boxL(b); }
    else if (d.type === "gpu") {   // a card about 28 x 11 x 5 cm, its LED edge on top (a card with one LED is still a card)
      const cx = (lo[0] + hi[0]) / 2, cz = (lo[2] + hi[2]) / 2, L = Math.max(28, hi[0] - lo[0] + 4);
      boxL([[cx - L / 2, hi[1] - 11, cz - 2.5], [cx + L / 2, hi[1] + 0.5, cz + 2.5]]);
    }
    else if (d.type === "ram") boxL(pad([0.5, 1, 0.5]));
    else if (d.type === "mouse") {   // a body about 6.8 x 12.5 cm: footprint, a lower top, four posts, the wheel
      const cx = (lo[0] + hi[0]) / 2, cz = (lo[2] + hi[2]) / 2, y0 = lo[1] - 2.5;
      const ring = (rx, rz, y) => { let pen = false; for (let i = 0; i <= 28; i++) { const a = i / 28 * TAU, p = W(d, [cx + Math.cos(a) * rx, y, cz + Math.sin(a) * rz]); if (!proj(p[0], p[1], p[2])) { pen = false; continue; } if (pen) ctx.lineTo(pr[0], pr[1]); else ctx.moveTo(pr[0], pr[1]); pen = true; } };
      ring(3.4, 6.2, y0); ring(3, 5.4, y0 + 3.6);
      for (const a of [0, 1, 2, 3]) { const c = Math.cos(a * TAU / 4), s = Math.sin(a * TAU / 4); const p = W(d, [cx + c * 3.4, y0, cz + s * 6.2]), q = W(d, [cx + c * 3, y0 + 3.6, cz + s * 5.4]); if (proj(p[0], p[1], p[2])) { const x0 = pr[0], y1 = pr[1]; if (proj(q[0], q[1], q[2])) { ctx.moveTo(x0, y1); ctx.lineTo(pr[0], pr[1]); } } }
      const w1 = W(d, [cx, y0 + 3.6, cz - 2.6]), w2 = W(d, [cx, y0 + 3.6, cz - 0.6]);
      if (proj(w1[0], w1[1], w1[2])) { const x0 = pr[0], y1 = pr[1]; if (proj(w2[0], w2[1], w2[2])) { ctx.moveTo(x0, y1); ctx.lineTo(pr[0], pr[1]); } }
    }
    else if (d.type === "headset") {
      // two cups (the two halves of its LEDs) joined by a band over the top
      const h = Math.ceil(d.pts.length / 2), mid = (a) => [0, 1, 2].map((k) => a.reduce((s, p) => s + p[k], 0) / a.length);
      const c1 = mid(d.pts.slice(0, h)), c2 = mid(d.pts.slice(h).length ? d.pts.slice(h) : d.pts.slice(0, h));
      for (const c of [c1, c2]) { let pen = false; for (let i = 0; i <= 20; i++) { const a = i / 20 * TAU, p = W(d, [c[0], c[1] + Math.sin(a) * 3.2, c[2] + Math.cos(a) * 3.2]); if (!proj(p[0], p[1], p[2])) { pen = false; continue; } if (pen) ctx.lineTo(pr[0], pr[1]); else ctx.moveTo(pr[0], pr[1]); pen = true; } }
      const top = Math.max(c1[1], c2[1]) + 3.2; let pen = false;
      for (let i = 0; i <= 16; i++) { const u = i / 16, p = W(d, [c1[0] + (c2[0] - c1[0]) * u, top + Math.sin(Math.PI * u) * Math.max(5, Math.abs(c2[0] - c1[0]) * 0.45), c1[2] + (c2[2] - c1[2]) * u]); if (!proj(p[0], p[1], p[2])) { pen = false; continue; } if (pen) ctx.lineTo(pr[0], pr[1]); else ctx.moveTo(pr[0], pr[1]); pen = true; }
    }
  }
  function drawStatic() {      // case, desk, grid, models, slots, device links, axis gizmo: only when the view or the geometry changes
    const main = ctx; ctx = bgx;
    ctx.fillStyle = BG; ctx.fillRect(0, 0, CW, CH); ctx.lineWidth = 1; ctx.strokeStyle = GRID; ctx.beginPath();
    if (S.view === "2d" && S.plane === "front") { for (let x = -60; x <= 90; x += 10) lnTo(x, 0, 0, x, 50, 0); for (let y = 0; y <= 50; y += 10) lnTo(-60, y, 0, 90, y, 0); }
    else { for (let x = -60; x <= 50; x += 10) lnTo(x, 0, -30, x, 0, 30); for (let z = -30; z <= 30; z += 10) lnTo(-60, 0, z, 50, 0, z); }
    ctx.stroke();
    const cc = caseCorners(), cb = caseBox(S.tpl);
    if (cc) {   // the case of the chosen template where it stands (an open frame: thicker posts), the motherboard plate inside
      ctx.strokeStyle = S.sel === "case" && S.tab === "dev" ? "#c6f43299" : EDGE; ctx.lineWidth = S.tpl === "open" ? 2 : 1; ctx.beginPath(); edges(cc); ctx.stroke(); ctx.lineWidth = 1;
      ctx.strokeStyle = "#2a2f22"; ctx.beginPath(); const mx = cb.x0 + 0.5, q = [[mx, 6, cb.z0 + 2], [mx, 6, cb.z1 - 6], [mx, cb.h - 2, cb.z1 - 6], [mx, cb.h - 2, cb.z0 + 2]].map(caseXf);
      for (let i = 0; i < 4; i++) lnTo(...q[i], ...q[(i + 1) % 4]); ctx.stroke();
    }
    ctx.strokeStyle = "#262a20"; ctx.beginPath(); edges(corners([[2, 14, -23], [48, 44, -21.5]])); edges(corners([[23, 0, -22.6], [27, 14, -21.9]])); ctx.stroke();   // a monitor on the desk
    ctx.strokeStyle = MODEL; ctx.beginPath(); S.devices.forEach(drawModel); ctx.stroke();
    ctx.fillStyle = "#6f7566"; ctx.font = MONO;
    if (cc) { const f = caseXf([cb.xm, 0, cb.z1]); if (proj(f[0], f[1], f[2])) ctx.fillText(App.t("ra.case"), pr[0] - 12, pr[1] + 13); }
    if (proj(34, 0, 22) && !(S.view === "2d" && S.plane === "front")) ctx.fillText(App.t("ra.desk"), pr[0] - 12, pr[1] + 14);
    // slots: while a device is edited or dragged; the free ones that fit the selected device are brighter and named
    const dragging = drag && drag.k === "gz" && drag.d, who = dragging ? drag.d : selDev();
    if (S.slots && (S.tab === "dev" || dragging)) {
      for (const s of slots()) {
        const fit = who && fits(who, s), busy = taken(s, who);
        ctx.strokeStyle = fit && !busy ? "rgba(198,244,50,.6)" : "rgba(198,244,50,.16)"; ctx.setLineDash([4, 4]); ctx.lineWidth = 1.2;
        slotPath(s); ctx.stroke(); ctx.setLineDash([]);
        if (fit && !busy && dragging && proj(s.c[0], s.c[1], s.c[2])) { ctx.fillStyle = "rgba(198,244,50,.75)"; ctx.fillText(slotName(s), pr[0] + 9, pr[1] - 9); }
      }
    }
    ctx.strokeStyle = "#2f3527"; ctx.beginPath();      // links between neighbouring LEDs
    S.devices.forEach((d, di) => {
      const T = TYPES[d.type]; if (!T.link || d.parts) return; const a = DST[di], b = DST[di + 1];
      let pen = false;
      for (let i = a; i < b; i++) { if (isNaN(XS[i])) { pen = false; continue; } if (pen) ctx.lineTo(XS[i], YS[i]); else ctx.moveTo(XS[i], YS[i]); pen = true; }
      if (T.link === 2 && !isNaN(XS[a]) && pen) ctx.lineTo(XS[a], YS[a]);
    });
    ctx.stroke();
    // axis gizmo, bottom left (the same colours as the move handles)
    const ox = 34, oy = CH - 30, ax = [[1, 0, 0, "X"], [0, 1, 0, "Y"], [0, 0, 1, "Z"]]; ctx.font = MONO; ctx.lineWidth = 1.5;
    ax.forEach(([a, b, c, n], k) => {
      let sx, sy;
      if (S.view === "3d") { sx = a * CAM.r[0] + b * CAM.r[1] + c * CAM.r[2]; sy = -(a * CAM.u[0] + b * CAM.u[1] + c * CAM.u[2]); }
      else if (S.plane === "top") { if (b) return; sx = a; sy = c; } else { if (c) return; sx = a; sy = -b; }
      ctx.strokeStyle = AXC[k]; ctx.fillStyle = AXC[k]; ctx.globalAlpha = 0.7; ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox + sx * 20, oy + sy * 20); ctx.stroke(); ctx.fillText(n, ox + sx * 27 - 3, oy + sy * 27 + 3); ctx.globalAlpha = 1;
    });
    ctx = main;
  }
  /** a slot's shape as a path on the current context (a fan ring, an edge, a spot on the desk) */
  function slotPath(s) {
    ctx.beginPath();
    if (s.k === "ring") {
      let pen = false;
      for (let i = 0; i <= 28; i++) {
        const a = i / 28 * TAU, u = Math.cos(a) * s.r, v = Math.sin(a) * s.r, p = s.ax === "z" ? [u, v, 0] : s.ax === "x" ? [0, v, u] : [u, 0, v];
        if (!proj(s.c[0] + p[0], s.c[1] + p[1], s.c[2] + p[2])) { pen = false; continue; }
        if (pen) ctx.lineTo(pr[0], pr[1]); else ctx.moveTo(pr[0], pr[1]); pen = true;
      }
    } else if (s.k === "path") {
      const P = s.closed ? s.pts.concat([s.pts[0]]) : s.pts;
      for (let i = 1; i < P.length; i++) lnTo(P[i - 1][0], P[i - 1][1], P[i - 1][2], P[i][0], P[i][1], P[i][2]);
    } else {
      const [x, y, z] = s.c; lnTo(x - 4, y, z - 4, x + 4, y, z - 4); lnTo(x + 4, y, z - 4, x + 4, y, z + 4); lnTo(x + 4, y, z + 4, x - 4, y, z + 4); lnTo(x - 4, y, z + 4, x - 4, y, z - 4);
    }
  }

  /* ---------------- stage: the effect as a shape in space ----------------
     Each generator is drawn where genValue puts its features: a wave's peaks are the planes s = λ (j + 0.25 + 0.5 t),
     a scan's head a slab with its trail behind, radial a sphere of radius (22 t mod 90/scale)... clipped to the box
     around the LEDs. P(x, y, z) -> [sx, sy, pixels per cm] or null, so the same code draws the stage and the 2D inset. */
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const corners = (b) => { const o = []; for (const x of [b[0][0], b[1][0]]) for (const y of [b[0][1], b[1][1]]) for (const z of [b[0][2], b[1][2]]) o.push([x, y, z]); return o; };
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  /** the layer's direction of travel, exactly as genValue builds it */
  function dirOf(L) { const an = L.p.rot * Math.PI / 180, ca = Math.cos(an), sa = Math.sin(an); return L.p.axis === 0 ? [ca, 0, sa] : L.p.axis === 1 ? [sa, ca, 0] : [sa, 0, ca]; }
  /** the polygon where the plane n·p = d cuts the box, ordered around its centre (null if it misses) */
  function clipPlane(n, d, bx) {
    const c = corners(bx), hit = [];
    for (const [i, j] of EDGES) {
      const fa = dot3(n, c[i]) - d, fb = dot3(n, c[j]) - d;
      if ((fa <= 0 && fb > 0) || (fa > 0 && fb <= 0)) { const u = fa / (fa - fb); hit.push([c[i][0] + (c[j][0] - c[i][0]) * u, c[i][1] + (c[j][1] - c[i][1]) * u, c[i][2] + (c[j][2] - c[i][2]) * u]); }
    }
    if (hit.length < 3) return null;
    const m = [0, 1, 2].map((k) => hit.reduce((a, p) => a + p[k], 0) / hit.length);
    const e1 = Math.abs(n[1]) < 0.9 ? [n[2], 0, -n[0]] : [0, -n[2], n[1]], e2 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
    return hit.map((p) => { const q = [p[0] - m[0], p[1] - m[1], p[2] - m[2]]; return { p, a: Math.atan2(dot3(q, e2), dot3(q, e1)) }; }).sort((a, b) => a.a - b.a).map((q) => q.p);
  }
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a.toFixed(3)})`;
  function drawField(c, P, small) {
    const L = S.layers[S.selLayer]; if (!L || !L.on) return;
    const o = S.origin, u = dirOf(L), q = L.p, tl = S.t * q.speed, sc = q.scale, bx = FB;
    const top = gradAt(L.stops, 1, [0, 0, 0]).slice();
    const cs = corners(bx).map((p) => (p[0] - o[0]) * u[0] + (p[1] - o[1]) * u[1] + (p[2] - o[2]) * u[2]);
    const smin = Math.min(...cs), smax = Math.max(...cs), base = dot3(u, o);
    const lo = q.mirror ? 0 : smin, hi = q.mirror ? Math.max(-smin, smax) : smax;
    const poly = (pts, fill, stroke, w, dash) => {
      const s = []; for (const p of pts) { const v = P(p[0], p[1], p[2]); if (!v) return; s.push(v); }
      c.beginPath(); s.forEach((v, i) => (i ? c.lineTo(v[0], v[1]) : c.moveTo(v[0], v[1]))); c.closePath();
      if (fill) { c.fillStyle = fill; c.fill(); }
      if (stroke) { c.strokeStyle = stroke; c.lineWidth = w || 1; c.setLineDash(dash || []); c.stroke(); c.setLineDash([]); }
    };
    const plane = (s, col, a, w) => { const pg = clipPlane(u, base + s, bx); if (pg) poly(pg, rgba(col, a * 0.13), rgba(col, Math.min(1, a * 0.85)), w || 1.1); };
    const both = (s, col, a, w) => { if (!q.mirror) plane(s, col, a, w); else if (s >= 0) { plane(s, col, a, w); if (s > 0.01) plane(-s, col, a, w); } };
    switch (L.gen) {
      case "wave": { const lam = 30 / sc, ph = 0.25 + 0.5 * tl; for (let j = Math.ceil(lo / lam - ph), n = 0; j <= Math.floor(hi / lam - ph) && n < 18; j++, n++) both(lam * (j + ph), top, 0.6); break; }
      case "rainbow": {
        const lam = 80 / sc;
        for (const f of [0, 0.25, 0.5, 0.75]) { const off = f + 0.2 * tl, col = gradAt(L.stops, f, [0, 0, 0]).slice(); for (let j = Math.ceil(lo / lam - off), n = 0; j <= Math.floor(hi / lam - off) && n < 8; j++, n++) both(lam * (j + off), col, 0.55); }
        break;
      }
      case "scan": {
        const sg = q.speed >= 0 ? 1 : -1, head = scanHead(L, tl);
        both(head, top, 0.95, 1.8); both(head - sg * (q.width + 3), top, 0.5);
        for (let j = 1; j <= 4; j++) { const back = q.width + 3 + j * 9; both(head - sg * back, top, 0.45 * Math.exp(-(back - q.width) / (q.trail * 45 + 1)), 0.8); }
        break;
      }
      case "radial": {
        const R = 90 / sc, rr = (((tl * 22) % R) + R) % R, ov = P(o[0], o[1], o[2]); if (!ov) break;
        c.beginPath(); c.arc(ov[0], ov[1], Math.max(1, rr * ov[2]), 0, TAU); c.fillStyle = rgba(top, 0.05); c.fill(); c.strokeStyle = rgba(top, 0.7); c.lineWidth = 1.3; c.stroke();
        if (!small) for (const ax of [0, 1, 2]) poly(Array.from({ length: 40 }, (_, i) => { const a = i / 40 * TAU, x = Math.cos(a) * rr, y = Math.sin(a) * rr; return ax === 0 ? [o[0] + x, o[1], o[2] + y] : ax === 1 ? [o[0] + x, o[1] + y, o[2]] : [o[0], o[1] + y, o[2] + x]; }), null, rgba(top, 0.3), 1, [3, 4]);
        break;
      }
      case "noise": {
        const st = small ? 9 : 6, tmp = [0, 0, 0], env = { origin: o, level: 0.5, bright: 1 };
        for (let x = bx[0][0]; x <= bx[1][0]; x += st) for (let y = bx[0][1]; y <= bx[1][1]; y += st) for (let z = bx[0][2]; z <= bx[1][2]; z += st) {
          const v = clamp(genValue(L, [x, y, z], S.t, env), 0, 1); if (v < 0.1) continue;
          const s = P(x, y, z); if (!s) continue; gradAt(L.stops, v, tmp); c.fillStyle = rgba(tmp, v * 0.45); c.fillRect(s[0] - 1.2, s[1] - 1.2, 2.4, 2.4);
        }
        break;
      }
      case "solid": {
        const col = gradAt(L.stops, 1 - Math.abs(2 * fract(tl * 0.15) - 1), [0, 0, 0]).slice(), b = corners(bx);
        for (const [i, j] of EDGES) poly([b[i], b[j]], null, rgba(col, 0.22), 1, [3, 5]);   // everywhere: a faint dashed box, not a wall
        break;
      }
      case "sparkle": {
        const cs2 = 2 / sc, env = { origin: o, level: 0.5, bright: 1 };
        for (let i = 0; i < NL; i++) {
          const p = [LP[i * 3], LP[i * 3 + 1], LP[i * 3 + 2]], v = genValue(L, p, S.t, env); if (v < 0.25) continue;
          const s = P(p[0], p[1], p[2]); if (!s) continue; const h = Math.max(2, cs2 * s[2]);
          c.strokeStyle = rgba(top, v * 0.7); c.lineWidth = 1; c.strokeRect(s[0] - h, s[1] - h, h * 2, h * 2);
        }
        break;
      }
      case "audio": {
        const lv = lvAt(S.t), sl = q.mirror ? lv * 80 : lv * 160 - 80;
        both(sl, top, 0.9, 1.6);
        break;
      }
    }
  }
  /** the 2D inset shows the plane the stage does not: top, or front when the stage itself is the top view */
  const pipPlane = () => (S.view === "2d" && S.plane === "top" ? "front" : "top");
  let pv = null, px = null, PW = 0, PH = 0;
  function drawPip() {
    if (!px || PW < 40) return;
    const pl = pipPlane(), cc = caseCorners(), xa = Math.min(-50, ...(cc || []).map((p) => p[0])) - 4, xb = Math.max(54, ...(cc || []).map((p) => p[0] + 4));
    const [ya, yb] = pl === "top" ? [-33, 33] : [-3, 50], k = Math.min(PW / (xb - xa), PH / (yb - ya));
    const cx = PW / 2 - (xa + xb) / 2 * k, cy = PH / 2 + (pl === "top" ? -(ya + yb) / 2 : (ya + yb) / 2) * k;
    const P = (x, y, z) => [cx + x * k, pl === "top" ? cy + z * k : cy - y * k, k];
    px.fillStyle = BG; px.fillRect(0, 0, PW, PH);
    px.lineWidth = 1;
    const outline = (c, col) => { px.strokeStyle = col; px.beginPath(); for (const [i, j] of EDGES) { const a = P(...c[i]), b = P(...c[j]); px.moveTo(a[0], a[1]); px.lineTo(b[0], b[1]); } px.stroke(); };
    if (pl === "top") outline(corners([[-60, 0, -30], [50, 0, 30]]), "#2a2f22");
    if (cc) outline(cc, EDGE);
    outline(corners([[2, 14, -23], [48, 44, -21.5]]), "#2a2f22");
    if (S.field && S.tab === "fx") drawField(px, P, true);
    for (let i = 0; i < NL; i++) {
      if (HID[i]) continue;
      const s = P(LP[i * 3], LP[i * 3 + 1], LP[i * 3 + 2]), lum = Math.max(CR[i], CG[i], CB[i]) / 255, kk = 1 - lum;
      px.fillStyle = fs((CR[i] + 38 * kk) | 0, (CG[i] + 42 * kk) | 0, (CB[i] + 30 * kk) | 0); px.fillRect(s[0] - 1.3, s[1] - 1.3, 2.6, 2.6);
    }
    const so = P(S.origin[0], S.origin[1], S.origin[2]); px.strokeStyle = "#c6f432"; px.beginPath(); px.arc(so[0], so[1], 3, 0, TAU); px.stroke();
  }
  /** the screen tip of the direction arrow (for dragging it) */
  const sDir = [-99, -99];
  function drawDir() {
    sDir[0] = sDir[1] = -99;
    const L = S.layers[S.selLayer]; if (S.tab !== "fx" || !S.field || !L || !L.on || ["solid", "sparkle", "radial"].includes(L.gen)) return;
    const o = S.origin, u = dirOf(L);
    if (!proj(o[0], o[1], o[2])) return; const ax = pr[0], ay = pr[1];
    const arrow = (sg, keep) => {
      if (!proj(o[0] + u[0] * 18 * sg, o[1] + u[1] * 18 * sg, o[2] + u[2] * 18 * sg)) return;
      const bx = pr[0], by = pr[1], an = Math.atan2(by - ay, bx - ax); if (Math.hypot(bx - ax, by - ay) < 6) return;
      ctx.strokeStyle = "#c6f432"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.fillStyle = "#c6f432"; ctx.beginPath(); ctx.moveTo(bx + 5 * Math.cos(an), by + 5 * Math.sin(an)); ctx.lineTo(bx - 8 * Math.cos(an - 0.45), by - 8 * Math.sin(an - 0.45)); ctx.lineTo(bx - 8 * Math.cos(an + 0.45), by - 8 * Math.sin(an + 0.45)); ctx.closePath(); ctx.fill();
      if (keep) {   // the handle, and what it is: the direction the effect travels in
        sDir[0] = bx; sDir[1] = by; ctx.strokeStyle = "rgba(198,244,50,.35)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(bx, by, 10, 0, TAU); ctx.stroke();
        ctx.font = MONO; ctx.fillStyle = "rgba(198,244,50,.85)"; ctx.fillText(App.t("ra.dirLabel", { name: App.t("ra.g." + L.gen) }), bx + 13 * (Math.cos(an) >= 0 ? 1 : -1) - (Math.cos(an) >= 0 ? 0 : 90), by + 4);
      }
    };
    arrow(1, true); if (L.p.mirror) arrow(-1, false);
  }
  /** LED 0 of the selected device: a white ring, and a lime arrow towards LED 1 (the order the LEDs run in) */
  function drawLed0(d, di) {
    const a = DST[di], n = DST[di + 1] - a; if (n < 2 || XS[a] !== XS[a]) return;
    const b = a + Math.min(2, n - 1);
    ctx.strokeStyle = "#eef0e6"; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(XS[a], YS[a], RS[a] + 5, 0, TAU); ctx.stroke();
    ctx.fillStyle = "#eef0e6"; ctx.font = MONO; ctx.fillText("0", XS[a] - 3, YS[a] - RS[a] - 8);
    if (XS[b] === XS[b]) {
      const an = Math.atan2(YS[b] - YS[a], XS[b] - XS[a]);
      ctx.strokeStyle = "#c6f432"; ctx.beginPath(); ctx.moveTo(XS[a], YS[a]); ctx.lineTo(XS[b], YS[b]); ctx.stroke();
      ctx.fillStyle = "#c6f432"; ctx.beginPath(); ctx.moveTo(XS[b], YS[b]); ctx.lineTo(XS[b] - 7 * Math.cos(an - 0.5), YS[b] - 7 * Math.sin(an - 0.5)); ctx.lineTo(XS[b] - 7 * Math.cos(an + 0.5), YS[b] - 7 * Math.sin(an + 0.5)); ctx.closePath(); ctx.fill();
    }
  }

  /* ---------------- move handles ("gizmo"), as in Blender ----------------
     Three arrows on the selection (X red, Y green, Z blue; the case only moves on the desk: X and Z) and a ring in the
     middle for moving freely on the desk plane. Dragging an arrow moves along that axis only: the mouse travel along
     the arrow's on-screen direction becomes cm, so it behaves the same at any camera angle. */
  let GZ = null;   // { c: [x,y,z] centre, arms: [{ k, a: [sx,sy], b: [sx,sy], ppc }], ring: [sx, sy] }
  /** the world box of the selection (a device's LEDs, or the case), or null */
  function selBox() {
    if (S.sel === "case") { const cc = caseCorners(); return cc ? [[0, 1, 2].map((k) => Math.min(...cc.map((p) => p[k]))), [0, 1, 2].map((k) => Math.max(...cc.map((p) => p[k])))] : null; }
    const di = S.devices.findIndex((d) => d.id === S.sel); if (di < 0 || S.devices[di]._hid || DST[di + 1] <= DST[di]) return null;
    const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (let i = DST[di]; i < DST[di + 1]; i++) for (let k = 0; k < 3; k++) { const v = LP[i * 3 + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
    return [lo, hi];
  }
  function drawGizmo() {
    GZ = null;
    if (S.tab !== "dev") return;
    const bx = selBox(); if (!bx) return;
    const isCase = S.sel === "case", c = isCase ? [(bx[0][0] + bx[1][0]) / 2, bx[1][1] + 2, (bx[0][2] + bx[1][2]) / 2] : bx[0].map((v, k) => (v + bx[1][k]) / 2);
    if (!proj(c[0], c[1], c[2])) return;
    const o = [pr[0], pr[1]], arms = [];
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]].forEach((u, k) => {
      if (isCase && k === 1) return;
      if (!proj(c[0] + u[0] * 10, c[1] + u[1] * 10, c[2] + u[2] * 10)) return;
      let vx = pr[0] - o[0], vy = pr[1] - o[1]; const len = Math.hypot(vx, vy); if (len < 6) return;   // pointing at the viewer: not usable here
      const L = clamp(len, 42, 80), ux = vx / len, uy = vy / len;
      arms.push({ k, a: [o[0] + ux * 9, o[1] + uy * 9], b: [o[0] + ux * L, o[1] + uy * L], u: [ux, uy], ppc: len / 10 });
    });
    for (const m of arms) {
      const hot = drag && drag.k === "gz" && drag.axis === m.k;
      ctx.strokeStyle = ctx.fillStyle = AXC[m.k]; ctx.lineWidth = hot ? 3 : 2;
      ctx.beginPath(); ctx.moveTo(m.a[0], m.a[1]); ctx.lineTo(m.b[0], m.b[1]); ctx.stroke();
      const an = Math.atan2(m.u[1], m.u[0]), [bx2, by2] = m.b;
      ctx.beginPath(); ctx.moveTo(bx2 + 7 * Math.cos(an), by2 + 7 * Math.sin(an)); ctx.lineTo(bx2 - 5 * Math.cos(an - 0.6), by2 - 5 * Math.sin(an - 0.6)); ctx.lineTo(bx2 - 5 * Math.cos(an + 0.6), by2 - 5 * Math.sin(an + 0.6)); ctx.closePath(); ctx.fill();
      ctx.font = MONO; ctx.fillText("XYZ"[m.k], bx2 + 10 * Math.cos(an) - 3, by2 + 10 * Math.sin(an) + 4);
    }
    ctx.strokeStyle = "#eef0e6"; ctx.lineWidth = drag && drag.k === "gz" && drag.axis === "free" ? 2.4 : 1.5; ctx.beginPath(); ctx.arc(o[0], o[1], 7, 0, TAU); ctx.stroke();
    GZ = { c, arms, ring: o };
  }
  function gzHit(mx, my) {
    if (!GZ) return null;
    if (Math.hypot(mx - GZ.ring[0], my - GZ.ring[1]) < 10) return "free";
    for (const m of GZ.arms) {   // near the arrow's shaft or head
      const vx = m.b[0] - m.a[0], vy = m.b[1] - m.a[1], l2 = vx * vx + vy * vy, u = clamp(((mx - m.a[0]) * vx + (my - m.a[1]) * vy) / l2, 0, 1.15);
      if (Math.hypot(mx - (m.a[0] + vx * u), my - (m.a[1] + vy * u)) < 8) return m.k;
    }
    return null;
  }
  /** centres the view on a box (3D: the camera looks at it from a distance that fits it; 2D: pan and zoom) */
  function focusBox(lo, hi) {
    const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2), dg = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    if (S.view === "3d") camGoal({ t: c, dist: clamp(dg * 1.7 + 30, 40, 320) });
    else { S.pan2 = S.plane === "top" ? [c[0], c[2]] : [c[0], c[1] - 25]; S.zoom2 = clamp(95 / (dg + 12), 0.5, 6); mark("view"); }
    persist();
  }
  /** F, double-click, the inspector's button: the selection, or everything when nothing is selected */
  function focusSel() { const b = selBox(); if (b) focusBox(b[0], b[1]); else fitView(); }
  /** a pick in the device list: the camera moves to the device and keeps its distance (3D); the 2D view pans to it */
  function centerSel() {
    const b = selBox(); if (!b) return;
    const c = [0, 1, 2].map((k) => (b[0][k] + b[1][k]) / 2);
    if (S.view === "3d") camGoal({ t: c });
    else { S.pan2 = S.plane === "top" ? [c[0], c[2]] : [c[0], c[1] - 25]; mark("view"); }
    persist();
  }

  const FS = [];
  const fs = (r, g, b) => { const k = (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3); return FS[k] || (FS[k] = "rgb(" + (r & 248 | 4) + "," + (g & 248 | 4) + "," + (b & 248 | 4) + ")"); };
  let sOrg = [-99, -99];
  function paint() {
    ctx.drawImage(bgc, 0, 0, CW, CH);
    const is3 = S.view === "3d";
    // the effect's shape only while the effect is edited (the Device tab shows the handles instead)
    if (S.field && S.tab === "fx") drawField(ctx, (x, y, z) => (proj(x, y, z) ? [pr[0], pr[1], pr[3]] : null), false);
    for (let q = 0; q < NL; q++) {            // all LEDs in one pass, far to near
      const i = is3 ? ORD[q] : q; if (XS[i] !== XS[i]) continue;
      const lum = Math.max(CR[i], CG[i], CB[i]) / 255, k = 1 - lum;
      ctx.fillStyle = fs((CR[i] + 38 * k) | 0, (CG[i] + 42 * k) | 0, (CB[i] + 30 * k) | 0);
      if (lum > 0.1) { ctx.globalAlpha = lum * 0.22; ctx.beginPath(); ctx.arc(XS[i], YS[i], RS[i] * 2.6, 0, TAU); ctx.fill(); ctx.globalAlpha = 1; }
      ctx.beginPath(); ctx.arc(XS[i], YS[i], RS[i], 0, TAU); ctx.fill();
    }
    const d = selDev();
    if (d && d._b && isFinite(d._b[0])) {
      const b = d._b;
      ctx.fillStyle = "rgba(198,244,50,.06)"; ctx.fillRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
      ctx.strokeStyle = "#c6f43299"; ctx.lineWidth = 1.5; ctx.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
      ctx.fillStyle = "#c6f432"; ctx.font = MONO; ctx.fillText(d.name.length > 32 ? d.name.slice(0, 31) + "…" : d.name, b[0], Math.max(10, b[1] - 6));
      if (S.tab === "dev") drawLed0(d, S.devices.indexOf(d));
    }
    // the slot a dragged device will snap into
    if (drag && drag.k === "gz" && drag.cand) { ctx.strokeStyle = "#c6f432"; ctx.lineWidth = 2.4; slotPath(drag.cand); ctx.stroke(); ctx.lineWidth = 1; }
    sOrg[0] = sOrg[1] = -99;
    if (S.tab === "fx" && proj(S.origin[0], S.origin[1], S.origin[2])) {   // the effect's origin: only while the effect is edited
      const x = pr[0], y = pr[1]; sOrg[0] = x; sOrg[1] = y;
      ctx.strokeStyle = "#c6f432"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 8, 0, TAU); ctx.moveTo(x - 14, y); ctx.lineTo(x - 4, y); ctx.moveTo(x + 4, y); ctx.lineTo(x + 14, y); ctx.moveTo(x, y - 14); ctx.lineTo(x, y - 4); ctx.moveTo(x, y + 4); ctx.lineTo(x, y + 14); ctx.stroke();
      ctx.fillStyle = "#c6f432"; ctx.beginPath(); ctx.arc(x, y, 2, 0, TAU); ctx.fill();
    }
    drawDir();
    drawGizmo();
    drawPip();
  }

  /* ---------------- stage: interaction ----------------
     Click: select a device (the stage never moves it by accident). Drag on empty space or on a device: orbit (3D) /
     pan (2D). Move with the handles. Double-click a device or press F: centre on it. */
  const PT = new Map(); let drag = null, pinch = null;
  function mpos(e) { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  function hit(mx, my) {
    const g = gzHit(mx, my); if (g != null) return { gz: g };
    if (Math.hypot(mx - sDir[0], my - sDir[1]) < 13) return { dir: true };
    if (Math.hypot(mx - sOrg[0], my - sOrg[1]) < 14) return { org: true };
    // A click picks a device when it is on one of its LED dots or inside what is drawn for it (a card's body, a keyboard's
    // plate, a stick); where several qualify the one that takes the least room wins, so a board spread over the whole case
    // (dots everywhere, little to see) never swallows the card or the stick in front of it.
    let best = null, ba = 1e12;
    S.devices.forEach((d, di) => {
      if (!d._b || !isFinite(d._b[0])) return;
      const m = d._bm, inModel = !!m && mx >= m[0] && mx <= m[2] && my >= m[1] && my <= m[3];
      let onDot = false;
      if (!inModel) for (let i = DST[di]; i < DST[di + 1]; i++) { if (XS[i] === XS[i] && Math.hypot(mx - XS[i], my - YS[i]) < Math.max(7, RS[i] + 3)) { onDot = true; break; } }
      if (!inModel && !onDot) return;
      const b = m || d._b, a = (b[2] - b[0]) * (b[3] - b[1]);
      if (a < ba) { ba = a; best = d; }
    });
    if (best) return { dev: best };
    // nothing on a dot or a model: the box around all of a device's dots (a board's area), the smallest
    for (const d of S.devices) { const b = d._b; if (!b || !isFinite(b[0])) continue; if (mx >= b[0] && mx <= b[2] && my >= b[1] && my <= b[3]) { const a = (b[2] - b[0]) * (b[3] - b[1]); if (a < ba) { ba = a; best = d; } } }
    if (best) return { dev: best };
    return null;
  }
  const clampPos = (v) => [clamp(snap(v[0]), -60, 90), clamp(snap(v[1]), -5, 60), clamp(snap(v[2]), -40, 40)];
  const tipOf = (hh) => (!hh ? App.t("ra.stageTip") : hh.gz != null ? App.t("ra.gzTip") : hh.dir ? App.t("ra.dirTip") : hh.org ? App.t("ra.originTip") : hh.dev.id === S.sel && S.tab === "dev" ? hh.dev.name + ": " + App.t("ra.dragDevTip") : hh.dev.name);
  function bindStage() {
    cv.addEventListener("contextmenu", (e) => e.preventDefault());
    // the middle button is a camera control: no browser auto-scroll, no click
    cv.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
    cv.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
    cv.addEventListener("pointerdown", (e) => {
      cv.setPointerCapture(e.pointerId); const m = mpos(e); PT.set(e.pointerId, m);
      if (S.view === "3d") setupCam();
      if (PT.size === 2) { drag = null; const p = [...PT.values()]; pinch = { d: Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]), cx: (p[0][0] + p[1][0]) / 2, cy: (p[0][1] + p[1][1]) / 2 }; return; }
      if (PT.size > 2) return;
      const mouse = e.pointerType === "mouse";
      // the middle button only moves the camera, like in Blender: it turns it (Shift: pans), picks nothing, moves nothing
      if (mouse && e.button === 1) {
        e.preventDefault();
        drag = { k: S.view === "3d" && !e.shiftKey ? "orbit" : "pan", lx: m[0], ly: m[1], moved: 0, onDev: true };
        cv.style.cursor = "grabbing"; return;
      }
      let hh = hit(m[0], m[1]);
      // dragging the selected device itself moves it on the desk (like the ring); an unselected one is only picked
      if (hh && hh.dev && hh.dev.id === S.sel && S.tab === "dev" && GZ && e.button === 0 && !e.shiftKey) hh = { gz: "free" };
      if (e.button === 2 || (e.shiftKey && !hh)) drag = { k: "pan", lx: m[0], ly: m[1] };
      else if (hh && hh.gz != null) {
        // a move handle: remember where the selection started, every move is measured from there
        const isCase = S.sel === "case", d = isCase ? null : selDev();
        drag = { k: "gz", axis: hh.gz, d, isCase, m0: m, lx: m[0], ly: m[1], moved: 0, cand: null, arm: GZ.arms.find((a) => a.k === hh.gz),
          // the places it sits in now (moving a device takes it out of them); a card does not jump into another kind of place
          fromSlots: d ? placesOf(d).map(slotById).filter(Boolean) : [],
          back: d && d.slot && !d.parts ? d.slot : null,   // a click that hardly moves it leaves it where it was
          p0: d ? [d.x, d.y, d.z] : [S.caseAt[0], 0, S.caseAt[1]], c0: GZ.c.slice(), done: [0, 0] };
        drag.arms = GZ.arms;
        if (hh.gz === "free") { const p = planePt(m[0], m[1], GZ.c); drag.off = [GZ.c[0] - p[0], GZ.c[2] - p[2]]; }
        mark("view");   // the slots show while dragging
      }
      else if (hh && hh.dir) drag = { k: "dir", lx: m[0], ly: m[1] };
      else if (hh && hh.org) { const p = planePt(m[0], m[1], S.origin); drag = { k: "org", off: [S.origin[0] - p[0], S.origin[1] - p[1], S.origin[2] - p[2]], lx: m[0], ly: m[1] }; }
      else {
        if (hh && S.sel !== hh.dev.id) selectDev(hh.dev.id);
        // the left button picks and moves; it does not turn the camera (a finger has no other button: it still does)
        drag = { k: mouse ? "none" : S.view === "3d" ? "orbit" : "pan", lx: m[0], ly: m[1], moved: 0, onDev: !!hh };
      }
      cv.style.cursor = drag && drag.k === "none" ? "default" : "grabbing";
    });
    cv.addEventListener("pointermove", (e) => {
      const m = mpos(e); if (PT.has(e.pointerId)) PT.set(e.pointerId, m);
      if (PT.size === 2 && pinch) {
        const p = [...PT.values()], nd = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]), cx = (p[0][0] + p[1][0]) / 2, cy = (p[0][1] + p[1][1]) / 2;
        if (S.view === "3d") setupCam(); if (nd > 4 && pinch.d > 4) zoomAt(cx, cy, pinch.d / nd); panBy(cx - pinch.cx, cy - pinch.cy); pinch.d = nd; pinch.cx = cx; pinch.cy = cy; return;
      }
      if (!drag) {
        if (e.pointerType === "mouse") { const hh = hit(m[0], m[1]); cv.style.cursor = hh ? (hh.dev && !(hh.dev.id === S.sel && S.tab === "dev") ? "pointer" : "move") : "default"; const tt = tipOf(hh); if (cv.title !== tt) cv.title = tt; }
        return;
      }
      const dx = m[0] - drag.lx, dy = m[1] - drag.ly;
      if (drag.k === "none") drag.moved += Math.abs(dx) + Math.abs(dy);
      else if (drag.k === "orbit") { drag.moved += Math.abs(dx) + Math.abs(dy); S.cam.yaw -= dx * 0.008; S.cam.pitch = clamp(S.cam.pitch + dy * 0.008, -0.1, 1.5); syncGoal(); mark("view"); }
      else if (drag.k === "pan") { drag.moved = (drag.moved || 0) + Math.abs(dx) + Math.abs(dy); panBy(dx, dy); }
      else if (drag.k === "org") {
        const p = planePt(m[0], m[1], S.origin), nv = clampPos([p[0] + drag.off[0], p[1] + drag.off[1], p[2] + drag.off[2]]);
        unpin(); S.origin[0] = nv[0]; S.origin[1] = nv[1]; S.origin[2] = nv[2]; ["x", "y", "z"].forEach((a, i) => setRange($("#o-" + a), nv[i])); persist();
      } else if (drag.k === "dir") {
        // the arrow turns the layer: horizontal directions on the plane through the origin, vertical ones (Y) on its front plane
        const L = S.layers[S.selLayer], o = S.origin, ax = L.p.axis;
        const p = S.view === "3d" ? rayAt(m[0], m[1], ax === 1 ? 2 : 1, ax === 1 ? o[2] : o[1]) : planePt(m[0], m[1], o);
        if (p && (S.view === "3d" || (S.plane === "top") === (ax !== 1))) {
          const v = [p[0] - o[0], p[1] - o[1], p[2] - o[2]], a = ax === 0 ? Math.atan2(v[2], v[0]) : ax === 2 ? Math.atan2(v[0], v[2]) : Math.atan2(v[0], v[1]);
          L.p.rot = Math.round(((a * 180 / Math.PI) % 360 + 360) % 360) % 360;
          setRange($("#l-rot"), L.p.rot); if (L._mark) L._mark(); else persist();
        }
      } else if (drag.k === "gz") {
        drag.moved += Math.abs(dx) + Math.abs(dy);
        // how far, in cm, from where the drag started
        let dv = [0, 0, 0];
        if (drag.axis === "free") {
          // on the desk plane: the mouse travel is split over the X and Z arrows as they look on screen (like the arrows
          // themselves), so it does not run off when the camera looks along the desk
          const ax = drag.arms.find((a) => a.k === 0), az = drag.arms.find((a) => a.k === 2);
          const ex = ax && [ax.u[0] * ax.ppc, ax.u[1] * ax.ppc], ez = az && [az.u[0] * az.ppc, az.u[1] * az.ppc];
          const det = ex && ez ? ex[0] * ez[1] - ex[1] * ez[0] : 0, D = [m[0] - drag.m0[0], m[1] - drag.m0[1]];
          if (Math.abs(det) > 0.5) dv = [(D[0] * ez[1] - D[1] * ez[0]) / det, 0, (ex[0] * D[1] - ex[1] * D[0]) / det];
          else if (ax || az) { const a = ax || az, s = (D[0] * a.u[0] + D[1] * a.u[1]) / a.ppc; dv = ax ? [s, 0, 0] : [0, 0, s]; }   // the other axis points at the viewer
          else { const p = planePt(m[0], m[1], drag.c0); dv = [p[0] + drag.off[0] - drag.c0[0], 0, p[2] + drag.off[1] - drag.c0[2]]; }
        }
        else if (drag.arm) { const s = ((m[0] - drag.m0[0]) * drag.arm.u[0] + (m[1] - drag.m0[1]) * drag.arm.u[1]) / drag.arm.ppc; dv[drag.axis] = s; }
        if (drag.isCase) {
          const tx = snap(dv[0]), tz = snap(dv[2]);
          moveCase(tx - drag.done[0], tz - drag.done[1], 0); drag.done = [tx, tz]; updInsp();
        } else if (drag.d) {
          // only the axes being moved snap to the grid; the others stay exactly where they were
          const o = drag.d, lim = [[-60, 90], [-5, 60], [-40, 40]];
          const nv = drag.p0.map((v, k) => (dv[k] ? clamp(snap(v + dv[k]), lim[k][0], lim[k][1]) : v));
          o.x = nv[0]; o.y = nv[1]; o.z = nv[2]; updInsp(); moved(o);
          // the nearest free slot that fits, if the device is close to it on screen
          let best = null, bd = 34;
          if (S.slots && o._bd && isFinite(o._bd[0])) {
            const cx = (o._bd[0] + o._bd[2]) / 2, cy = (o._bd[1] + o._bd[3]) / 2;
            const hold = (drag.fromSlots || []).filter((s) => s.box).map((s) => s.lab);   // a card, a stick, the I/O: same kind of place only
            for (const s of slots()) { if (!fits(o, s) || taken(s, o) || (hold.length && !hold.includes(s.lab)) || !proj(s.c[0], s.c[1], s.c[2])) continue; const dd = Math.hypot(pr[0] - cx, pr[1] - cy); if (dd < bd) { bd = dd; best = s; } }
          }
          drag.cand = best;
        }
      }
      drag.lx = m[0]; drag.ly = m[1];
    });
    const up = (e) => {
      PT.delete(e.pointerId);
      if (PT.size < 2) pinch = null;
      if (PT.size === 0) {
        // a click of the left button on empty space lets go of the selection; the other buttons only move the camera
        if (drag && (drag.k === "orbit" || drag.k === "pan" || drag.k === "none") && drag.moved < 4 && !drag.onDev && e.button === 0 && S.sel != null) selectDev(null);
        const dropped = drag && drag.k === "gz" ? drag : null;
        drag = null; cv.style.cursor = "default";
        if (dropped && dropped.d && dropped.cand && dropped.moved > 3) { placeIn(dropped.d, dropped.cand); renderDevInsp(); }
        else if (dropped && dropped.d && dropped.back && !dropped.d.slot && !dropped.d.parts) {   // barely moved: back into its place
          const s = slotById(dropped.back);
          if (s && !taken(s, dropped.d)) { placeIn(dropped.d, s); renderDevInsp(); }
        }
        if (dropped) syncTree();
        if (dropped) mark("view");
        persist();
      } else if (PT.size === 1) drag = null;
    };
    cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
    cv.addEventListener("wheel", (e) => { e.preventDefault(); const m = mpos(e); zoomAt(m[0], m[1], Math.exp(e.deltaY * 0.0012)); persist(); }, { passive: false });
    cv.addEventListener("dblclick", (e) => {
      const m = mpos(e), hh = hit(m[0], m[1]);
      if (hh && hh.dev) { selectDev(hh.dev.id); focusSel(); } else if (!hh) resetView();
    });
    $("#vSeg").onclick = (e) => { const v = e.target.dataset.v; if (v) { S.view = v; if (v === "3d") setupCam(); syncTb(); persist(); } };
    $("#pSeg").onclick = (e) => { const v = e.target.dataset.p; if (!v) return; if (S.view === "3d") { camGoal(PRESET_CAMS[v]); } else { S.plane = v; S.pan2 = [0, 0]; syncTb(); } persist(); };
    $("#fit").onclick = fitView;
    $("#play").onclick = () => { S.playing = !S.playing; syncPlay(); wake(); };
    $("#fldb").onclick = () => { S.field = !S.field; syncTb(); syncTabs(); persist(); };
    $("#slb").onclick = () => { S.slots = !S.slots; syncTb(); persist(); };
    $("#pipb").onclick = () => { S.plane = pipPlane(); S.view = "2d"; S.pan2 = [0, 0]; syncTb(); persist(); };
    $("#iSeg").onclick = (e) => { const v = e.target.dataset.tab; if (!v || v === S.tab) return; S.tab = v; if (v === "dev") renderDevInsp(); syncTabs(); persist(); };
    const sc = $("#scrub"); sc.oninput = () => { const v = +sc.value / 10; S.t = Math.floor(S.t / 30) * 30 + v; sc.style.setProperty("--p", (+sc.value / 3) + "%"); mark("fx"); };
    cv.title = App.t("ra.stageTip");
  }
  function onKey(e) {
    if (!root || root.closest("[hidden]") || (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) && e.target.type !== "range")) return;
    const d = selDev();
    if (e.key === " " && e.target.tagName !== "BUTTON") { e.preventDefault(); S.playing = !S.playing; syncPlay(); wake(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && d) removeDev(d.id);
    else if ((e.key === "r" || e.key === "R") && d && !e.ctrlKey && !e.metaKey) rotDev(d, S.snap ? 15 : 5);
    else if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey) focusSel();
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
    if (S.playing ? uiT > 0.1 : true) {   // the readouts: 10 times a second while playing, after every change when paused
      uiT = 0;
      const ph = ((S.t % 30) + 30) % 30, sc = $("#scrub");
      if (sc && document.activeElement !== sc) { sc.value = ph * 10; sc.style.setProperty("--p", (ph / 30 * 100) + "%"); }
      $("#tv").textContent = ph.toFixed(1) + " s";
      const lvl = $("#lvl");
      if (lvl) { const lv = lvAt(S.t), bs = lvl.children; for (let i = 0; i < bs.length; i++) { bs[i].classList.toggle("lit", (i + 1) / bs.length <= lv); bs[i].style.setProperty("--o", (0.4 + 0.6 * i / (bs.length - 1)).toFixed(2)); } }
      // each device's strip in the list and in the inspector: what its LEDs show now
      root.querySelectorAll(".ra-scan[data-m]").forEach((sn) => {
        const di = S.devices.findIndex((x) => x.id === +sn.dataset.m); if (di < 0) return;
        const a = DST[di], n = DST[di + 1] - a, m = sn.children.length; if (n <= 0) return;
        for (let j = 0; j < m; j++) { const i = a + Math.round(j * (n - 1) / Math.max(1, m - 1)), b = sn.children[j], lum = Math.max(CR[i], CG[i], CB[i]) / 255;
          b.style.background = "rgb(" + (CR[i] | 0) + "," + (CG[i] | 0) + "," + (CB[i] | 0) + ")"; b.style.opacity = (0.12 + 0.88 * lum).toFixed(2); }
      });
    }
    raf = requestAnimationFrame(frame);
  }

  App.RGBAdv = { render, leave };
})();
