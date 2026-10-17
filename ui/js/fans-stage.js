"use strict";
/* Fans page: the RGB page's case as a live stage. Same case templates and places (App.RGBAdv.geom), same 3D / 2D views;
   the fan controls stand in the places (one control can drive several fans: a group), their blades turn with the live
   speed, RGB devices standing in the same places show as rings in their colour, and the airflow simulation
   (fans-air.js) runs through the case: air comes in at the intakes, warms at the CPU cooler and the graphics card and
   leaves through the exhausts, whose outlet temperature is shown. The RGB scene is only READ (rgb_scene_get): the case
   itself is set up on the RGB page ("Change the case" opens it there). */

(function () {
  const { h, api } = App;
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const t = (k, v) => App.t(k, v);
  const MONO = '10px "JetBrains Mono",Consolas,monospace', BG = "#090a08", EDGE = "#3a4030", GRID = "#1b1e16";
  const DEFAULT_CASE = { tpl: "mid", caseAt: [100, 0], caseRot: 0, caseFlip: true, caseLow: false };
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
  const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const axisVec = (ax) => (ax === "x" ? [1, 0, 0] : ax === "y" ? [0, 1, 0] : [0, 0, 1]);

  /* ───── the case: read from the RGB scene ───── */
  let saved = null, savedAt = 0;
  /** { cs: case state, gpu: the slot of the graphics card, rgb: [{ slots, color }] RGB devices standing in places } */
  async function loadCase() {
    if (saved && Date.now() - savedAt < 4000) return saved;
    let sc = null;
    try { sc = await api.invoke("rgb_scene_get"); if (sc && typeof sc === "object" && "ok" in sc && "scene" in sc) sc = sc.scene; } catch (_) { /* RGB not set up: the default case */ }
    const cs = Object.assign({}, DEFAULT_CASE);
    let gpu = "gpuH";
    const rgb = [];
    if (sc) {
      if (typeof sc.tpl === "string") cs.tpl = sc.tpl;
      if (Array.isArray(sc.caseAt) && sc.caseAt.length === 2 && sc.caseAt.every(Number.isFinite)) cs.caseAt = sc.caseAt;
      if (Number.isFinite(sc.caseRot)) cs.caseRot = sc.caseRot;
      if (sc.caseFlip != null) cs.caseFlip = sc.caseFlip === true;
      cs.caseLow = sc.caseLow === true;
      const devs = Array.isArray(sc.devices) ? sc.devices : [];
      const g = devs.find((d) => d.type === "gpu" && (d.slot === "gpuV" || d.slot === "gpuH"));
      if (g) gpu = g.slot;
      // RGB devices in fan places, with the colour of their own look (Simple page) when they have one
      const looks = new Map((sc.simple || []).map((l) => [l.name + "#" + (l.nth || 0), l]));
      for (const d of devs) {
        const places = Array.isArray(d.parts) ? d.parts.map((p) => p.slot) : d.slot ? [d.slot] : [];
        if (!places.length || !d.link) continue;
        const l = looks.get(d.link.name + "#" + (d.link.nth || 0));
        rgb.push({ slots: places, name: d.name || d.link.name, color: l && l.on !== false ? hsv(l.hue, l.sat) : "#c6f43255" });
      }
    }
    const G = App.RGBAdv.geom;
    if (!G.caseBox(cs.tpl) && cs.tpl !== "none") cs.tpl = "mid";
    saved = { cs, gpu, rgb }; savedAt = Date.now();
    return saved;
  }
  function hsv(hue, sat) {
    const s = clamp((sat ?? 100) / 100, 0, 1), hh = ((((hue ?? 0) % 360) + 360) % 360) / 60, c = s, x = c * (1 - Math.abs((hh % 2) - 1)), m = 1 - c;
    const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
    return `rgb(${Math.round((r + m) * 255)},${Math.round((g + m) * 255)},${Math.round((b + m) * 255)})`;
  }

  /**
   * The places a fan can stand in, worked out in the template's own space (`tp`, before the case is moved and turned)
   * and where they stand now (`c`): the template's fan rings and pump, a second fan behind the CPU heatsink (push-pull),
   * and three on the graphics card. Also the case box, the heat volumes and each place's way of blowing.
   */
  function buildSlots({ cs, gpu }) {
    const G = App.RGBAdv.geom, cs0 = { tpl: cs.tpl, caseAt: [0, 0], caseRot: 0, caseFlip: false, caseLow: false };
    const X = (p) => G.caseXf(p, cs), dirW = (p, d) => norm3(add(X(add(p, d)), X(p), -1));
    const axW = (ax) => (ax === "y" || (cs.caseRot || 0) % 180 === 0 ? ax : ax === "x" ? "z" : "x");
    const T = G.slotsOf(cs.tpl, cs0), cb = G.caseBox(cs.tpl);
    const out = [];
    const ring = (id, lab, n, tp, ax, r, extra) => out.push(Object.assign({ id, lab, n, k: "ring", tp, c: X(tp), axT: ax, ax: axW(ax), r }, extra || {}));
    for (const s of T) if (s.k === "ring" && s.inCase) ring(s.id, s.lab, s.n, s.c, s.ax, s.r);
    const cpu = T.find((s) => s.id === "cpu");
    if (cpu) ring("cpu2", "cpu2", 0, [cpu.c[0], cpu.c[1], cpu.c[2] - 12], cpu.ax, cpu.r);
    // places many cases have but the template does not draw (shown while placing): fans in the floor, a second rear fan,
    // fans in the side panel. Different builds put fans in different places, so these are offered everywhere.
    if (cb) {
      const has = (id) => out.some((s) => s.id === id);
      for (let i = 0; i < 3; i++) if (!has("bottom" + (i + 1))) ring("bottom" + (i + 1), "bottom", i + 1, [cb.xm, 1, cb.z1 - 9 - 12.5 * i], "y", 5.5, { extra: true });
      if (!has("rear2")) ring("rear2", "rear", 2, [cb.xm, Math.max(8, cb.h - 24), cb.z0 + 1], "z", 5.5, { extra: true });
      for (let i = 0; i < 2; i++) ring("side" + (i + 1), "side", i + 1, [cb.x1 - 1, cb.h * (0.62 - 0.3 * i), cb.z1 - 10], "x", 5.5, { extra: true });
    }
    const card = T.find((s) => s.id === gpu && s.box) || T.find((s) => (s.id === "gpuH" || s.id === "gpuV") && s.box);
    if (card) {
      const [lo, hi] = card.box, down = card.id === "gpuH";   // a card standing out of the board: fans face down; one next to the glass: fans face it
      for (let i = 0; i < 3; i++) {
        const z = lo[2] + (hi[2] - lo[2]) * (0.2 + 0.3 * i);
        ring("gpuf" + (i + 1), "gpuf", i + 1, down ? [(lo[0] + hi[0]) / 2, lo[1], z] : [hi[0], (lo[1] + hi[1]) / 2, z], down ? "y" : "x", 4.4, { gpuFan: true });
      }
    }
    // the case box where it stands (axis aligned: the case turns in 90° steps) and its middle, in the template's space too
    const midT = cb ? [cb.xm, cb.h / 2, 0] : [0, 20, 0];
    let lo = [-30, 0, -22], hi = [0, 46, 22];
    if (cb) {
      const cc = G.corners([[cb.x0, 0, cb.z0], [cb.x1, cb.h, cb.z1]]).map(X);
      lo = [0, 1, 2].map((i) => Math.min(...cc.map((p) => p[i]))); hi = [0, 1, 2].map((i) => Math.max(...cc.map((p) => p[i])));
    }
    // which way the air goes at each place (template space), as a direction where it stands now
    for (const s of out) {
      const a = axisVec(s.axT), into = Math.sign((midT[0] - s.tp[0]) * a[0] + (midT[1] - s.tp[1]) * a[1] + (midT[2] - s.tp[2]) * a[2]) || 1;
      s.aIn = dirW(s.tp, a.map((v) => v * into));
      if (s.id === "cpu" || s.id === "cpu2") s.aInt = dirW(s.tp, [0, 0, -1]);   // an air cooler blows through its heatsink to the rear
      else if (s.gpuFan && card) { const cm = card.box[0].map((v, i) => (v + card.box[1][i]) / 2), sg = Math.sign((cm[0] - s.tp[0]) * a[0] + (cm[1] - s.tp[1]) * a[1] + (cm[2] - s.tp[2]) * a[2]) || 1; s.aInt = dirW(s.tp, a.map((v) => v * sg)); }
    }
    // heat volumes: the CPU heatsink (between the cooler's two fans) and the graphics card
    const aabb = (b) => { const cc = G.corners(b).map(X); return { lo: [0, 1, 2].map((i) => Math.min(...cc.map((p) => p[i]))), hi: [0, 1, 2].map((i) => Math.max(...cc.map((p) => p[i]))) }; };
    out.heat = {};
    if (cpu) out.heat.cpu = aabb([[cpu.c[0] - 7, cpu.c[1] - 6.5, cpu.c[2] - 11], [cpu.c[0] + 6, cpu.c[1] + 6.5, cpu.c[2] - 1]]);
    if (card) out.heat.gpu = aabb(card.box);
    out.card = card ? { boxW: G.corners(card.box).map(X) } : null;
    out.box = { lo, hi };
    out.mid = X(midT);
    out.sideT = cb ? { z0: cb.z0, z1: cb.z1, h: cb.h } : { z0: -22, z1: 22, h: 46 };
    return out;
  }
  const slotLabel = (s) => (s.gpuFan ? t("fans.slot.gpu" + s.n) : s.id === "cpu2" ? t("fans.slot.cpu2") : s.id === "cpu" ? t("fans.slot.cpu1") : s.lab === "side" ? t("fans.slot.side", { n: s.n }) : t("ra.s." + s.lab, { n: s.n }));
  /** older layouts used other names for the same places */
  const OLD = { rear: "rear1", gpu1: "gpuf1", gpu2: "gpuf2" };
  const norm = (v) => OLD[v] || v;
  /** a control's places as saved: "front1,front2" -> ["front1", "front2"] */
  const parse = (v) => (typeof v === "string" ? v.split(",").map((x) => norm(x.trim())).filter(Boolean) : []);

  /** where each visible control's fans stand: the user's choice, else a guess (graphics card controls on the card, the
      rest one place each along the case); control id -> [place ids] */
  function layoutOf(K, slots) {
    const S = K.setup, ids = new Set(slots.map((s) => s.id)), out = {}, used = new Set();
    S.controls.forEach((c) => {
      const v = parse(S.layout[c.id]).filter((x) => ids.has(x) && !used.has(x));
      if (v.length) { out[c.id] = v; v.forEach((x) => used.add(x)); }
    });
    const pref = ["front1", "front2", "front3", "rear1", "top1", "top2", "cpu"];
    const rest = slots.filter((s) => !s.gpuFan && s.id !== "pump" && s.id !== "cpu2" && !pref.includes(s.id)).map((s) => s.id);
    const order = pref.filter((id) => ids.has(id)).concat(rest);
    const gpuFree = ["gpuf1", "gpuf2", "gpuf3"].filter((id) => ids.has(id) && !used.has(id));
    S.controls.filter((c) => !c.hidden && !(c.id in out) && !(c.id in S.layout)).forEach((c) => {
      const isGpu = /^Gpu/.test(((K.st.sensors || []).find((s) => s.id === c.id) || {}).hw_type || "") || c.id.startsWith("/gpu");
      const free = isGpu ? gpuFree : order.filter((id) => !used.has(id));
      const id = free.shift();
      if (id) { out[c.id] = [id]; used.add(id); }
    });
    return out;
  }

  /** what a place does to the air: in (intake), out (exhaust), int (moves air inside: CPU cooler, graphics card) or none (pump) */
  function flowOf(K, s) {
    if (s.id === "pump") return "none";
    if (s.id === "cpu" || s.id === "cpu2" || s.gpuFan) return "int";
    const o = (K.setup.flow || {})[s.id];
    if (o === "in" || o === "out") return o;
    if (/^(rear|top|rad)/.test(s.id)) return "out";
    return "in";
  }
  /** the room's temperature: the coolest board sensor, else 25 °C (then it is marked as assumed) */
  function ambientOf(K) {
    const v = (K.st.sensors || []).filter((s) => s.kind === "temperature" && /SuperIO|Motherboard/.test(s.hw_type || "")).map((s) => K.temp(s.id)).filter((x) => x != null && x > 12 && x < 45);
    return v.length ? { t: Math.min(...v), assumed: false } : { t: 25, assumed: true };
  }

  /* ───── the stage ───── */
  function mount(host, K, opts) {
    opts = opts || {};
    const P = (K.pref().stage ||= { view: "3d", plane: "top", cam: null, zoom2: 1, pan2: null });
    const pref = K.pref();
    if (pref.air == null) pref.air = true;
    const compact = !!opts.compact;
    let editing = !!opts.editing;
    let slots = [], layout = {}, sel = null, lit = null, hover = null, assign = null, cs = DEFAULT_CASE, rgb = [];
    let cv = null, ctx = null, CW = 600, CH = 340, DPR = 1, raf = 0, dead = false, lastT = 0, lastDraw = 0, full = false;
    const CAM = { c: [0, 0, 0], f: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0], foc: 400 }, pr = [0, 0, 0, 1];
    const ang = {}, hits = [];
    const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.anim === "off";
    let ext = { c: [0, 20, 0], s: [30, 46, 44] }, sim = null, simKey = "", budget = 2400, slow = 0, amb = { t: 25, assumed: true };

    const wrap = h("div", { class: "fstage" });
    const vSeg = h("span", { class: "seg ra-s" }, ["3d", "2d"].map((v) => h("button", { text: v.toUpperCase(), onClick: () => { P.view = v; if (v === "3d") fit(); App.persist(); sync(); } })));
    const pSeg = h("span", { class: "seg ra-s" });
    const airB = h("button", { class: "ra-chip", text: t("fans.air"), title: t("fans.airTip"), onClick: () => { pref.air = !pref.air; App.persist(); sync(); } });
    const balB = h("span", { class: "ra-chip fbal", hidden: true });
    const ambB = h("span", { class: "ra-chip fbal", hidden: true });
    const fsB = h("button", { class: "ra-fsb", title: t("ra.fullTip"), "aria-label": t("ra.full"), onClick: () => setFull(!full) });
    fsB.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
    const legend = h("div", { class: "fleg" },
      h("span", null, h("i", { class: "c-cool" }), t("fans.legCool")), h("span", null, h("i", { class: "c-warm" }), t("fans.legWarm")), h("span", null, h("i", { class: "c-hot" }), t("fans.legHot")),
      h("span", null, h("i", { class: "c-slot" }), h("span", { class: "fleg-slot", text: t(opts.editing ? "fans.legSlotEdit" : "fans.legSlot") })));
    cv = h("canvas", { class: "ra-cv", "aria-label": t("fans.caseCap") });
    wrap.append(h("div", { class: "ra-tb" }, vSeg, pSeg, h("button", { class: "btn ra-sm", text: t("ra.fit"), title: t("ra.fitTip"), onClick: () => { fit(); App.persist(); } }), h("span", { class: "sp" }), ...(compact ? [] : [ambB, balB, airB])),
      h("div", { class: "ra-cvwrap" }, cv, ...(compact ? [] : [fsB])), ...(compact ? [] : [legend]));
    host.replaceChildren(wrap);
    ctx = cv.getContext("2d");

    function setFull(on) {
      full = on; wrap.style.top = on ? (document.getElementById("topbar")?.getBoundingClientRect().bottom || 0) + "px" : "";
      wrap.classList.toggle("full", on); fsB.classList.toggle("on", on); fsB.title = t(on ? "ra.fullExit" : "ra.fullTip");
    }
    const onKey = (e) => { if (!wrap.isConnected) { window.removeEventListener("keydown", onKey); return; } if (e.key === "Escape" && full) setFull(false); };
    window.addEventListener("keydown", onKey);

    /* camera */
    function camSetup() {
      const { yaw, pitch, dist, t: tg } = P.cam, cp = Math.cos(pitch);
      const cx = tg[0] + dist * cp * Math.sin(yaw), cy = tg[1] + dist * Math.sin(pitch), cz = tg[2] + dist * cp * Math.cos(yaw);
      let fx = tg[0] - cx, fy = tg[1] - cy, fz = tg[2] - cz; const fl = Math.hypot(fx, fy, fz); fx /= fl; fy /= fl; fz /= fl;
      let rx = -fz, rz = fx; const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
      CAM.c = [cx, cy, cz]; CAM.f = [fx, fy, fz]; CAM.r = [rx, 0, rz]; CAM.u = [-rz * fy, rz * fx - rx * fz, rx * fy]; CAM.foc = Math.min(CW * 1.15, CH * 1.4);
    }
    const PRESETS = { iso: { yaw: 0.55, pitch: 0.5 }, top: { yaw: 0, pitch: 1.45 }, front: { yaw: 0, pitch: 0.04 }, side: { yaw: Math.PI / 2, pitch: 0.04 } };
    function fit() { P.cam = { yaw: 0.55, pitch: 0.42, dist: clamp(Math.max(...ext.s) * 2.05, 50, 320), t: ext.c.slice() }; P.zoom2 = 1; P.pan2 = null; }
    const k2 = () => (P.plane === "top" ? Math.min(CW / (ext.s[0] + 18), CH / (ext.s[2] + 18)) : Math.min(CW / (ext.s[0] + 18), CH / (ext.s[1] + 18))) * (P.zoom2 || 1);
    function proj(x, y, z) {
      if (P.view === "3d") {
        const vx = x - CAM.c[0], vy = y - CAM.c[1], vz = z - CAM.c[2], zc = vx * CAM.f[0] + vy * CAM.f[1] + vz * CAM.f[2];
        if (zc < 1) return false;
        pr[0] = CW / 2 + (vx * CAM.r[0] + vy * CAM.r[1] + vz * CAM.r[2]) / zc * CAM.foc; pr[1] = CH / 2 - (vx * CAM.u[0] + vy * CAM.u[1] + vz * CAM.u[2]) / zc * CAM.foc; pr[2] = zc; pr[3] = CAM.foc / zc;
        return true;
      }
      const pan = P.pan2 || (P.plane === "top" ? [ext.c[0], ext.c[2]] : [ext.c[0], ext.c[1]]), k = k2();
      pr[0] = CW / 2 + (x - pan[0]) * k;
      pr[1] = P.plane === "top" ? CH / 2 + (z - pan[1]) * k : CH / 2 - (y - pan[1]) * k;
      pr[2] = 0; pr[3] = k;
      return true;
    }
    function lnTo(ax, ay, az, bx, by, bz) { if (!proj(ax, ay, az)) return; const x0 = pr[0], y0 = pr[1]; if (!proj(bx, by, bz)) return; ctx.moveTo(x0, y0); ctx.lineTo(pr[0], pr[1]); }
    const edges = (c) => { for (const [i, j] of EDGES) lnTo(c[i][0], c[i][1], c[i][2], c[j][0], c[j][1], c[j][2]); };
    const onRing = (s, r, a) => { const u = Math.cos(a) * r, v = Math.sin(a) * r; return s.ax === "z" ? [s.c[0] + u, s.c[1] + v, s.c[2]] : s.ax === "x" ? [s.c[0], s.c[1] + v, s.c[2] + u] : [s.c[0] + u, s.c[1], s.c[2] + v]; };
    function ring(s, r) {
      let pen = false;
      for (let i = 0; i <= 32; i++) { const p = onRing(s, r, i / 32 * TAU); if (!proj(p[0], p[1], p[2])) { pen = false; continue; } if (pen) ctx.lineTo(pr[0], pr[1]); else ctx.moveTo(pr[0], pr[1]); pen = true; }
    }

    /* what stands where */
    let fans = [];      // [{ c: control, s: place }], one per fan
    function relayout() {
      layout = layoutOf(K, slots);
      const byId = new Map(slots.map((s) => [s.id, s]));
      fans = [];
      for (const c of K.setup.controls) if (!c.hidden) for (const id of layout[c.id] || []) if (byId.has(id)) fans.push({ c, s: byId.get(id) });
      simKey = "";
    }
    async function load() {
      const sv = await loadCase();
      if (dead) return;
      cs = sv.cs; rgb = sv.rgb; slots = buildSlots(sv);
      ext = { c: slots.box.lo.map((v, i) => (v + slots.box.hi[i]) / 2), s: slots.box.hi.map((v, i) => v - slots.box.lo[i]) };
      if (!P.cam) fit();
      sim = App.FansAir.create({ box: slots.box, max: 2400 });
      relayout(); sync();
      if (opts.onReady) opts.onReady();
    }

    function sync() {
      [...vSeg.children].forEach((b) => b.classList.toggle("on", b.textContent.toLowerCase() === P.view));
      const names = P.view === "3d" ? ["iso", "top", "front", "side"] : ["top", "front"];
      pSeg.replaceChildren(...names.map((n) => h("button", { class: P.view === "2d" && P.plane === n ? "on" : "", text: t("ra." + n), onClick: () => {
        if (P.view === "3d") P.cam = Object.assign({}, P.cam, PRESETS[n]); else { P.plane = n; P.pan2 = null; }
        App.persist(); sync();
      } })));
      airB.classList.toggle("on", !!pref.air);
    }

    /* the simulation's scene: fans with their real speed, heat volumes with their part's temperature */
    const speedOf = (f) => (assign && assign.boost === f.c.id ? 1 : K.pctOf(f.c) / 100);
    function feed() {
      if (!sim) return;
      const list = fans.map((f) => ({ f, kind: flowOf(K, f.s), pct: speedOf(f) })).filter((x) => x.kind !== "none");
      const cpuT = K.temp(K.primary("cpu")), gpuT = K.temp(K.primary("gpu"));
      amb = ambientOf(K);
      const key = list.map((x) => x.f.s.id + x.kind + Math.round(x.pct * 20)).join("|") + "|" + Math.round((cpuT || 0) / 2) + "|" + Math.round((gpuT || 0) / 2) + "|" + Math.round(amb.t) + "|" + budget;
      if (key === simKey) return;
      simKey = key;
      const heat = [];
      if (slots.heat.cpu && cpuT != null) heat.push({ ...slots.heat.cpu, t: cpuT, id: "cpu" });
      if (slots.heat.gpu && gpuT != null) heat.push({ ...slots.heat.gpu, t: gpuT, id: "gpu" });
      sim.set({
        ambient: amb.t, heat,
        fans: list.map(({ f, kind, pct }) => ({ c: f.s.c, r: f.s.r, pct, kind, slot: f.s.id, a: kind === "in" ? f.s.aIn : kind === "out" ? f.s.aIn.map((v) => -v) : (f.s.aInt || f.s.aIn) })),
      });
      sim.limit(budget);
      sim.scene = list;
    }

    /* colours: room air lime, warm amber, hot orange-red; 12 buckets so all trails of one colour are one stroke */
    const NB = 12, BUCKET = Array.from({ length: NB }, (_, i) => {
      const u = i / (NB - 1), lerp = (a, b, k) => Math.round(a + (b - a) * k);
      const [r, g, b] = u < 0.5 ? [lerp(198, 255, u * 2), lerp(244, 180, u * 2), lerp(50, 84, u * 2)] : [255, lerp(180, 90, (u - 0.5) * 2), lerp(84, 60, (u - 0.5) * 2)];
      return `${r},${g},${b}`;
    });
    const bucketOf = (T) => clamp(Math.round(((T - amb.t) / 32) * (NB - 1)), 0, NB - 1);
    function drawAir() {
      if (!sim || !sim.n) return;
      const { n, trail, head, fill, TR, temp, inside, age } = sim;
      const paths = Array.from({ length: NB * 3 }, () => new Path2D());
      for (let i = 0; i < n; i++) {
        const f = fill[i]; if (f < 2) continue;
        // air still on its way in is drawn only for a moment, faintly: the case is where the story is
        const outside = !inside[i];
        if (outside && age[i] > 0.6) continue;
        const b = bucketOf(temp[i]);
        let px = 0, py = 0, have = false;
        for (let k = 0; k < f; k++) {
          const slot = ((head[i] - f + k) % TR + TR) % TR, o = (i * TR + slot) * 3;
          if (!proj(trail[o], trail[o + 1], trail[o + 2])) { have = false; continue; }
          if (have) { const layer = outside ? 0 : k < f / 3 ? 0 : k < (2 * f) / 3 ? 1 : 2, p = paths[b * 3 + layer]; p.moveTo(px, py); p.lineTo(pr[0], pr[1]); }
          px = pr[0]; py = pr[1]; have = true;
        }
      }
      ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.lineCap = "round";
      for (let b = 0; b < NB; b++) for (let l = 0; l < 3; l++) {
        ctx.strokeStyle = `rgba(${BUCKET[b]},${[0.12, 0.3, 0.62][l]})`; ctx.lineWidth = [1.1, 1.5, 1.9][l];
        ctx.stroke(paths[b * 3 + l]);
      }
      ctx.restore();
    }
    /** a heat source's glow, stronger the hotter its part is */
    function drawHeat() {
      const parts = [["cpu", K.temp(K.primary("cpu"))], ["gpu", K.temp(K.primary("gpu"))]];
      for (const [id, T] of parts) {
        const hv = slots.heat[id]; if (!hv || T == null) continue;
        const c = hv.lo.map((v, i) => (v + hv.hi[i]) / 2); if (!proj(c[0], c[1], c[2])) continue;
        const x = pr[0], y = pr[1], R = Math.max(18, Math.max(...hv.hi.map((v, i) => v - hv.lo[i])) * 0.75 * pr[3]), w = clamp((T - 35) / 50, 0.08, 1);
        const g = ctx.createRadialGradient(x, y, 0, x, y, R);
        g.addColorStop(0, `rgba(255,150,70,${(0.45 * w).toFixed(3)})`); g.addColorStop(1, "rgba(255,150,70,0)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.fill();
        ctx.font = MONO; ctx.fillStyle = `rgba(255,180,84,${(0.55 + 0.45 * w).toFixed(2)})`; ctx.fillText(`${id.toUpperCase()} ${Math.round(T)}°`, x - 18, y - R * 0.55);
      }
    }
    function draw(dt) {
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.fillStyle = BG; ctx.fillRect(0, 0, CW, CH);
      if (P.view === "3d") camSetup();
      ctx.lineWidth = 1; ctx.strokeStyle = GRID; ctx.beginPath();
      if (!(P.view === "2d" && P.plane === "front")) { const [cx, , cz] = ext.c, y0 = slots.box.lo[1]; for (let x = -4; x <= 4; x++) lnTo(cx + x * 12, y0, cz - 48, cx + x * 12, y0, cz + 48); for (let z = -4; z <= 4; z++) lnTo(cx - 48, y0, cz + z * 12, cx + 48, y0, cz + z * 12); }
      ctx.stroke();
      const G = App.RGBAdv.geom, cb = G.caseBox(cs.tpl);
      if (cb) {
        const cc = G.corners([[cb.x0, 0, cb.z0], [cb.x1, cb.h, cb.z1]]).map((p) => G.caseXf(p, cs));
        ctx.strokeStyle = EDGE; ctx.lineWidth = cs.tpl === "open" ? 2 : 1; ctx.beginPath(); edges(cc); ctx.stroke(); ctx.lineWidth = 1;
        ctx.strokeStyle = "#2a2f22"; ctx.beginPath(); const mx = cb.x0 + 0.5, q = [[mx, 6, cb.z0 + 2], [mx, 6, cb.z1 - 6], [mx, cb.h - 2, cb.z1 - 6], [mx, cb.h - 2, cb.z0 + 2]].map((p) => G.caseXf(p, cs));
        for (let i = 0; i < 4; i++) lnTo(...q[i], ...q[(i + 1) % 4]);
        if (slots.card) edges(slots.card.boxW);
        if (slots.heat.cpu) { const hv = slots.heat.cpu; edges(G.corners([hv.lo, hv.hi])); }
        ctx.stroke();
      }
      drawHeat();
      if (pref.air && !compact && !reduced()) drawAir();
      // RGB devices in the same places: a ring in their colour around the place
      for (const d of rgb) for (const id of d.slots) {
        const s = slots.find((x) => x.id === id); if (!s) continue;
        ctx.strokeStyle = d.color; ctx.globalAlpha = 0.75; ctx.lineWidth = 2.5; ctx.beginPath(); ring(s, s.r + 1.6); ctx.stroke(); ctx.globalAlpha = 1; ctx.lineWidth = 1;
      }
      // places and fans
      hits.length = 0;
      const placed = new Map(fans.map((f) => [f.s.id, f]));
      const outT = new Map();
      if (sim && sim.scene) for (const [k, m] of sim.outlets) { const x = sim.scene[k]; if (x && m.n > 6) outT.set(x.f.s.id, m.t); }
      for (const s of slots) {
        const f = placed.get(s.id), inSet = !!(assign && assign.slots.has(s.id));
        if (!f && !inSet) {
          if ((s.id === "pump" || s.extra) && !editing && !assign) continue;
          ctx.strokeStyle = s.id === hover ? "rgba(198,244,50,.7)" : "rgba(198,244,50,.2)"; ctx.setLineDash([4, 4]); ctx.beginPath(); ring(s, s.r); ctx.stroke(); ctx.setLineDash([]);
          if (opts.onSlot && (editing || assign) && proj(s.c[0], s.c[1], s.c[2])) {
            hits.push({ slot: s.id, x: pr[0], y: pr[1], r: Math.max(s.r * pr[3], 10) });
            if (s.id === hover) { ctx.font = MONO; ctx.textAlign = "center"; ctx.fillStyle = "#c6f432"; ctx.fillText("+ " + slotLabel(s), pr[0], pr[1] - s.r * pr[3] - 6); ctx.textAlign = "start"; }
          }
          continue;
        }
        const ctl = assign ? (inSet ? null : f.c) : f.c;
        const isLit = (ctl && ctl.id === lit) || inSet, on = isLit || (ctl && ctl.id === sel);
        const p = inSet ? (assign.boost ? 100 : 60) : ctl ? K.pctOf(ctl) : 0, r = ctl ? K.rpmOf(ctl) : null;
        ang[s.id] = ((ang[s.id] || 0) + (reduced() ? 0 : dt * (p / 100) * TAU * 3)) % TAU;
        if (isLit) { ctx.shadowColor = "#c6f432"; ctx.shadowBlur = 14; }
        ctx.strokeStyle = on ? "#c6f432" : assign ? "#3a4030" : "#5b6450"; ctx.lineWidth = on ? 2 : 1.4; ctx.beginPath(); ring(s, s.r + 0.6); ctx.stroke(); ctx.lineWidth = 1; ctx.shadowBlur = 0;
        ctx.fillStyle = on ? "rgba(198,244,50,.62)" : assign ? "rgba(198,244,50,.12)" : "rgba(198,244,50,.28)";
        for (let i = 0; i < 7; i++) {
          const a = ang[s.id] + i * TAU / 7, pts = [onRing(s, s.r * 0.2, a), onRing(s, s.r * 0.95, a - 0.12), onRing(s, s.r * 0.95, a + 0.5), onRing(s, s.r * 0.2, a + 0.4)];
          let ok = true; const xy = [];
          for (const q of pts) { if (!proj(q[0], q[1], q[2])) { ok = false; break; } xy.push(pr[0], pr[1]); }
          if (!ok) continue;
          ctx.beginPath(); ctx.moveTo(xy[0], xy[1]); for (let k = 2; k < 8; k += 2) ctx.lineTo(xy[k], xy[k + 1]); ctx.closePath(); ctx.fill();
        }
        if (proj(s.c[0], s.c[1], s.c[2])) {
          const px = pr[0], py = pr[1], rr = s.r * pr[3];
          hits.push(ctl ? { id: ctl.id, slot: s.id, x: px, y: py, r: Math.max(rr, 12) } : { slot: s.id, x: px, y: py, r: Math.max(rr, 12) });
          ctx.fillStyle = "#14160f"; ctx.strokeStyle = on ? "#c6f432" : "#5b6450"; ctx.beginPath(); ctx.arc(px, py, Math.max(2, rr * 0.18), 0, TAU); ctx.fill(); ctx.stroke();
          ctx.font = MONO; ctx.textAlign = "center";
          if (ctl && rr > 9 && (P.view === "2d" || on || ctl.id === hover)) { ctx.fillStyle = on ? "#c6f432" : "#8b919c"; ctx.fillText(`${ctl.name} · ${p}% · ${r == null ? "–" : r}`, px, py + rr + 12); }
          const ot = outT.get(s.id);
          if (ot != null && rr > 6 && !assign) { const w = clamp((ot - amb.t) / 25, 0, 1); ctx.fillStyle = `rgb(${Math.round(198 + 57 * w)},${Math.round(244 - 90 * w)},${Math.round(50 + 20 * w)})`; ctx.fillText(`${Math.round(ot)}°`, px, py - rr - 6); }
          ctx.textAlign = "start";
        }
      }
    }
    function balance() {
      if (compact) return;
      if (!sim || !sim.scene) { balB.hidden = true; return; }
      const W = (k) => sim.scene.filter((x) => x.kind === k).reduce((s, x) => s + x.pct * x.f.s.r * x.f.s.r, 0), I = W("in"), O = W("out");
      if (!I && !O) { balB.hidden = true; } else {
        const d = (I - O) / (I + O), k = d > 0.15 ? "pos" : d < -0.15 ? "neg" : "bal";
        balB.hidden = false; balB.textContent = t("fans.bal." + k); balB.title = t("fans.balTip"); balB.dataset.k = k;
      }
      ambB.hidden = false; ambB.textContent = t(amb.assumed ? "fans.ambAssumed" : "fans.amb", { t: Math.round(amb.t) }); ambB.title = t("fans.ambTip");
    }
    function frame(now) {
      if (dead) return;
      if (!wrap.isConnected) { dead = true; return; }
      if (cv.offsetParent === null || document.hidden || !slots.length) { lastT = now; raf = setTimeout(() => (raf = requestAnimationFrame(frame)), 400); return; }
      raf = requestAnimationFrame(frame);
      if (now - lastDraw < 31) return;          // about 30 frames a second: this runs next to games
      const dt = Math.min(0.1, (now - lastT) / 1000 || 0.033); lastT = now; lastDraw = now;
      const w = cv.clientWidth, hgt = cv.clientHeight;
      if (w && (w !== CW || hgt !== CH || DPR !== Math.min(2, devicePixelRatio || 1))) { DPR = Math.min(2, devicePixelRatio || 1); CW = w; CH = hgt; cv.width = Math.round(CW * DPR); cv.height = Math.round(CH * DPR); }
      const t0 = performance.now();
      feed();
      if (sim && pref.air && !compact && !reduced()) sim.step(dt);
      draw(dt); balance();
      // the frame budget: a slow machine gets fewer particles (and more back when it keeps up)
      const ms = performance.now() - t0;
      slow = slow * 0.9 + ms * 0.1;
      if (slow > 9 && budget > 300) budget = Math.round(budget * 0.8);
      else if (slow < 4 && budget < 2400) budget = Math.min(2400, budget + 40);
    }

    /* mouse: click a fan to pick its control (or, while placing, a place to add or take away); drag turns (3D) or pans (2D) */
    const mpos = (e) => { const b = cv.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    const hitAt = (m) => { let best = null, bd = 1e9; for (const x of hits) { const d = Math.hypot(m[0] - x.x, m[1] - x.y); if (d <= x.r + 6 && d < bd) { best = x; bd = d; } } return best; };
    let drag = null;
    cv.addEventListener("pointerdown", (e) => { cv.setPointerCapture(e.pointerId); drag = { l: mpos(e), moved: 0, pan: e.shiftKey || e.button === 1 || e.button === 2 }; });
    cv.addEventListener("pointermove", (e) => {
      const m = mpos(e);
      if (!drag) { const x = hitAt(m); hover = x ? x.id || x.slot : null; cv.style.cursor = x ? "pointer" : "grab"; return; }
      const dx = m[0] - drag.l[0], dy = m[1] - drag.l[1]; drag.l = m; drag.moved += Math.abs(dx) + Math.abs(dy);
      if (P.view === "3d" && !drag.pan) { P.cam.yaw -= dx * 0.008; P.cam.pitch = clamp(P.cam.pitch + dy * 0.008, -1.45, 1.5); }
      else if (P.view === "3d") { camSetup(); const sc = P.cam.dist / CAM.foc; for (let i = 0; i < 3; i++) P.cam.t[i] += -CAM.r[i] * dx * sc + CAM.u[i] * dy * sc; }
      else { const k = k2(), pan = P.pan2 || (P.plane === "top" ? [ext.c[0], ext.c[2]] : [ext.c[0], ext.c[1]]); P.pan2 = [pan[0] - dx / k, P.plane === "top" ? pan[1] - dy / k : pan[1] + dy / k]; }
    });
    const up = (e) => {
      if (!drag) return; const was = drag; drag = null;
      if (was.moved >= 5) { App.persist(); return; }
      const x = hitAt(mpos(e)); if (!x) return;
      if (opts.onSlot && x.slot) opts.onSlot(x.slot, x.id || null);
      else if (x.id && opts.onPick) opts.onPick(x.id);
    };
    cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", () => { drag = null; });
    cv.addEventListener("wheel", (e) => { e.preventDefault(); const f = Math.exp(e.deltaY * 0.0012); if (P.view === "3d") P.cam.dist = clamp(P.cam.dist * f, 40, 360); else P.zoom2 = clamp((P.zoom2 || 1) / f, 0.4, 6); }, { passive: false });
    cv.addEventListener("dblclick", () => { fit(); App.persist(); });
    cv.title = t(opts.onSlot ? "fans.stageEditTip" : "fans.stageTip");

    sync();
    load();
    raf = requestAnimationFrame(frame);
    return {
      select(id) { sel = id; },
      setLit(id) { lit = id || null; },
      /** placing mode: the places in `slots` are drawn as chosen; `boost` = the control spun up meanwhile */
      /** placing on the Placement tab: every free place shows (and names itself under the pointer) */
      setEditing(on) { editing = !!on; const l = legend.querySelector(".fleg-slot"); if (l) l.textContent = t(editing ? "fans.legSlotEdit" : "fans.legSlot"); },
      setAssign(a) { assign = a ? { slots: new Set(a.slots || []), boost: a.boost || null } : null; simKey = ""; },
      relayout() { relayout(); },
      get slots() { return slots; },
      get layout() { return layout; },
      flowOf: (s) => flowOf(K, s),
      destroy() { dead = true; cancelAnimationFrame(raf); clearTimeout(raf); window.removeEventListener("keydown", onKey); },
    };
  }

  App.FansStage = { mount, loadCase, buildSlots, layoutOf, slotLabel, norm, parse, flowOf };
})();
