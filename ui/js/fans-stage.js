"use strict";
/* Fans page: the RGB page's case as a live stage. Same case templates and places (App.RGBAdv.geom), same 3D / 2D views;
   the fan controls stand in the places, their blades turn with the live speed, and an airflow estimate runs through the
   case. The RGB scene is only READ (rgb_scene_get): the case is set up on the RGB page, nothing is ever written there.
   The airflow is an estimate (every fan blows along its axis, in or out, air goes from the intakes to the exhausts),
   not a simulation of air: it shows balance (positive / negative pressure) and where the air passes the hot parts. */

(function () {
  const { h, api } = App;
  const TAU = Math.PI * 2, FAN_R = 5.5;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const t = (k, v) => App.t(k, v);
  const MONO = '10px "JetBrains Mono",Consolas,monospace', BG = "#090a08", EDGE = "#3a4030", GRID = "#1b1e16";
  const DEFAULT_CASE = { tpl: "mid", caseAt: [100, 0], caseRot: 0, caseFlip: true, caseLow: false };
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

  /* ───── the case: read once from the RGB scene, kept for the session ───── */
  let saved = null, savedAt = 0;
  /** { cs: case state, gpu: the slot the RGB scene put the graphics card in } */
  async function loadCase() {
    if (saved && Date.now() - savedAt < 5000) return saved;
    let sc = null;
    try { sc = await api.invoke("rgb_scene_get"); } catch (_) { /* RGB not set up: the default case */ }
    const cs = Object.assign({}, DEFAULT_CASE);
    let gpu = "gpuH";
    if (sc) {
      if (typeof sc.tpl === "string") cs.tpl = sc.tpl;
      if (Array.isArray(sc.caseAt) && sc.caseAt.length === 2 && sc.caseAt.every(Number.isFinite)) cs.caseAt = sc.caseAt;
      if (Number.isFinite(sc.caseRot)) cs.caseRot = sc.caseRot;
      if (sc.caseFlip != null) cs.caseFlip = sc.caseFlip === true;
      cs.caseLow = sc.caseLow === true;
      const g = (sc.devices || []).find((d) => d.type === "gpu" && (d.slot === "gpuV" || d.slot === "gpuH"));
      if (g) gpu = g.slot;
    }
    const G = App.RGBAdv.geom;
    if (!G.caseBox(cs.tpl) && cs.tpl !== "none") cs.tpl = "mid";
    saved = { cs, gpu }; savedAt = Date.now();
    return saved;
  }

  /** the places a fan can stand in: the template's fan rings (and the pump), plus two on the graphics card */
  function buildSlots({ cs, gpu }) {
    const G = App.RGBAdv.geom, all = G.slotsOf(cs.tpl, cs), out = all.filter((s) => s.k === "ring" && s.inCase);
    const card = all.find((s) => s.id === gpu) || all.find((s) => s.id === "gpuH" || s.id === "gpuV");
    if (card && card.box) {
      const [lo, hi] = card.box, up = card.id === "gpuH";   // a card standing out of the board: fans face down; one next to the glass: fans face it
      const at = up ? (z) => [(lo[0] + hi[0]) / 2, lo[1], z] : (z) => [hi[0], (lo[1] + hi[1]) / 2, z];
      const zs = [lo[2] + (hi[2] - lo[2]) * 0.28, lo[2] + (hi[2] - lo[2]) * 0.72];
      zs.forEach((z, i) => out.push({ id: "gpuf" + (i + 1), lab: "gpuf", n: i + 1, k: "ring", c: G.caseXf(at(z), cs), ax: up ? "y" : (cs.caseRot % 180 === 0 ? "x" : "z"), r: 5, inCase: true, gpuFan: true, card: true }));
    }
    const cb = G.caseBox(cs.tpl);
    out.mid = cb ? G.caseXf([cb.xm, cb.h / 2, 0], cs) : [0, 20, 0];
    out.card = card;
    out.cases = all;
    return out;
  }
  const slotLabel = (s) => (s.gpuFan ? t("fans.slot.gpu" + s.n) : t("ra.s." + s.lab, { n: s.n }));
  /** older layouts used other names for the same places */
  const OLD = { rear: "rear1", gpu1: "gpuf1", gpu2: "gpuf2" };
  const norm = (v) => OLD[v] || v;

  /** where each visible control stands: the user's choice, else a guess (cards on the card, the rest along the case) */
  function layoutOf(K, slots) {
    const S = K.setup, ids = new Set(slots.map((s) => s.id)), out = {}, used = new Set();
    S.controls.forEach((c) => { const v = norm(S.layout[c.id]); if (v && ids.has(v) && !used.has(v)) { out[c.id] = v; used.add(v); } });
    const pref = ["front1", "front2", "front3", "rear1", "top1", "top2", "cpu"];
    const rest = slots.filter((s) => !s.gpuFan && s.id !== "pump" && !pref.includes(s.id)).map((s) => s.id);
    const order = pref.filter((id) => ids.has(id)).concat(rest);
    const gpuFree = ["gpuf1", "gpuf2"].filter((id) => ids.has(id) && !used.has(id));
    S.controls.filter((c) => !c.hidden && !(c.id in out) && !(c.id in S.layout)).forEach((c) => {
      const isGpu = /^Gpu/.test(((K.st.sensors || []).find((s) => s.id === c.id) || {}).hw_type || "");
      const free = isGpu ? gpuFree : order.filter((id) => !used.has(id));
      const id = free.shift();
      if (id) { out[c.id] = id; used.add(id); }
    });
    return out;
  }

  /** what a place does to the air: in (intake), out (exhaust) or int (moves air inside the case) */
  function flowOf(K, s, id) {
    const o = ((K.pref().flow || {})[id]);
    if (o === "in" || o === "out") return o;
    if (s.gpuFan || s.id === "cpu") return "int";
    if (/^(front|bottom)/.test(s.id)) return "in";
    if (/^(rear|top|rad)/.test(s.id)) return "out";
    return "int";
  }
  const axisVec = (ax) => (ax === "x" ? [1, 0, 0] : ax === "y" ? [0, 1, 0] : [0, 0, 1]);

  /* ───── the stage ───── */
  function mount(host, K, opts) {
    const P = (K.pref().stage ||= { view: "3d", plane: "top", cam: null, zoom2: 1, pan2: null });
    const pref = K.pref();
    if (pref.air == null) pref.air = true;
    let slots = [], layout = {}, sel = null, cs = DEFAULT_CASE;
    let cv = null, ctx = null, CW = 600, CH = 340, DPR = 1, raf = 0, dead = false, lastT = 0, full = false;
    const CAM = { c: [0, 0, 0], f: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0], foc: 400 }, pr = [0, 0, 0, 1];
    let hover = null, lit = null;
    const ang = {}, hits = [], parts = [], reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.anim === "off";
    let ext = { c: [0, 20, 0], s: [30, 46, 44] };   // the case where it stands: centre and size, for fitting the view

    const wrap = h("div", { class: "fstage" });
    const vSeg = h("span", { class: "seg ra-s" }, ["3d", "2d"].map((v) => h("button", { text: v.toUpperCase(), onClick: () => { P.view = v; if (v === "3d") fit(); App.persist(); sync(); } })));
    const pSeg = h("span", { class: "seg ra-s" });
    const airB = h("button", { class: "ra-chip", text: t("fans.air"), title: t("fans.airTip"), onClick: () => { pref.air = !pref.air; App.persist(); parts.length = 0; sync(); } });
    const balB = h("span", { class: "ra-chip fbal", hidden: true });
    const fsB = h("button", { class: "ra-fsb", title: t("ra.fullTip"), "aria-label": t("ra.full"), onClick: () => setFull(!full) });
    fsB.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
    cv = h("canvas", { class: "ra-cv", "aria-label": t("fans.caseCap") });
    const compact = !!(opts && opts.compact);   // the Detect dialog: just the case, no airflow or fullscreen
    wrap.append(h("div", { class: "ra-tb" }, vSeg, pSeg, h("button", { class: "btn ra-sm", text: t("ra.fit"), title: t("ra.fitTip"), onClick: () => { fit(); App.persist(); } }), h("span", { class: "sp" }), ...(compact ? [] : [balB, airB])),
      h("div", { class: "ra-cvwrap" }, cv, ...(compact ? [] : [fsB])));
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
    function fit() {
      const m = Math.max(...ext.s);
      P.cam = { yaw: 0.55, pitch: 0.5, dist: clamp(m * 2.05, 50, 320), t: ext.c.slice() };
      P.zoom2 = 1; P.pan2 = null;
    }
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
    const corners = (b) => { const o = []; for (const x of [b[0][0], b[1][0]]) for (const y of [b[0][1], b[1][1]]) for (const z of [b[0][2], b[1][2]]) o.push([x, y, z]); return o; };
    const edges = (c) => { for (const [i, j] of EDGES) lnTo(c[i][0], c[i][1], c[i][2], c[j][0], c[j][1], c[j][2]); };
    /** a point on a ring: centre c, axis ax, radius r, angle a */
    const onRing = (s, r, a) => { const u = Math.cos(a) * r, v = Math.sin(a) * r; return s.ax === "z" ? [s.c[0] + u, s.c[1] + v, s.c[2]] : s.ax === "x" ? [s.c[0], s.c[1] + v, s.c[2] + u] : [s.c[0] + u, s.c[1], s.c[2] + v]; };

    /* what stands where */
    function relayout() {
      layout = layoutOf(K, slots);
      const byId = new Map(slots.map((s) => [s.id, s]));
      fans = K.setup.controls.filter((c) => !c.hidden && layout[c.id] && byId.has(layout[c.id])).map((c) => ({ c, s: byId.get(layout[c.id]) }));
      parts.length = 0;
    }
    let fans = [];
    async function load() {
      const sv = await loadCase();
      if (dead) return;
      cs = sv.cs; slots = buildSlots(sv);
      const G = App.RGBAdv.geom, cb = G.caseBox(cs.tpl);
      if (cb) {
        const cc = G.corners([[cb.x0, 0, cb.z0], [cb.x1, cb.h, cb.z1]]).map((p) => G.caseXf(p, cs));
        const lo = [0, 1, 2].map((i) => Math.min(...cc.map((p) => p[i]))), hi = [0, 1, 2].map((i) => Math.max(...cc.map((p) => p[i])));
        ext = { c: lo.map((v, i) => (v + hi[i]) / 2), s: hi.map((v, i) => v - lo[i]) };
      } else ext = { c: [0, 20, 0], s: [30, 46, 44] };
      if (!P.cam) fit();
      relayout(); sync();
      if (opts && opts.onReady) opts.onReady();
    }

    function sync() {
      [...vSeg.children].forEach((b) => b.classList.toggle("on", b.textContent.toLowerCase() === P.view));
      const names = P.view === "3d" ? ["iso", "top", "front", "side"] : ["top", "front"];
      pSeg.replaceChildren(...names.map((n) => h("button", { class: P.view === "2d" && P.plane === n ? "on" : "", text: t("ra." + n), onClick: () => {
        if (P.view === "3d") { P.cam = Object.assign({}, P.cam, PRESETS[n]); } else { P.plane = n; P.pan2 = null; }
        App.persist(); sync();
      } })));
      airB.classList.toggle("on", !!pref.air);
    }

    /* airflow: one particle goes along a curve from an intake (or a gap) to an exhaust (or a gap) */
    const ends = () => {
      const ins = [], outs = [];
      for (const f of fans) {
        const p = K.pctOf(f.c) / 100, fl = flowOf(K, f.s, f.c.id);
        if (fl === "int" || p <= 0) continue;
        const ax = axisVec(f.s.ax), mid = slots.mid, sg = Math.sign((mid[0] - f.s.c[0]) * ax[0] + (mid[1] - f.s.c[1]) * ax[1] + (mid[2] - f.s.c[2]) * ax[2]) || 1;
        const into = ax.map((v) => v * sg), w = p * f.s.r * f.s.r;
        (fl === "in" ? ins : outs).push({ c: f.s.c, d: fl === "in" ? into : into.map((v) => -v), w, p });
      }
      return { ins, outs };
    };
    const pickW = (a) => { let r = Math.random() * a.reduce((s, x) => s + x.w, 0); for (const x of a) { r -= x.w; if (r <= 0) return x; } return a[a.length - 1]; };
    /** a spot on the case's walls (a gap the air comes in or leaks out through) */
    function gap() {
      const [sx, sy, sz] = ext.s, c = ext.c, face = Math.floor(Math.random() * 6), a = (Math.random() - 0.5), b = (Math.random() - 0.5);
      const p = face < 2 ? [(face ? 0.5 : -0.5) * sx, a * sy, b * sz] : face < 4 ? [a * sx, (face === 3 ? 0.5 : -0.5) * sy, b * sz] : [a * sx, b * sy, (face === 5 ? 0.5 : -0.5) * sz];
      const d = [face < 2 ? (face ? 1 : -1) : 0, face >= 2 && face < 4 ? (face === 3 ? 1 : -1) : 0, face >= 4 ? (face === 5 ? 1 : -1) : 0];
      return { c: [c[0] + p[0], c[1] + p[1], c[2] + p[2]], d, gap: true };
    }
    const bez = (p0, p1, p2, p3, u) => { const v = 1 - u, a = v * v * v, b = 3 * v * v * u, c = 3 * v * u * u, d = u * u * u; return [0, 1, 2].map((i) => a * p0[i] + b * p1[i] + c * p2[i] + d * p3[i]); };
    function spawn(E) {
      const A = E.ins.length ? pickW(E.ins) : gap(), B = E.outs.length ? pickW(E.outs) : gap();
      const mid = slots.mid, j = [0, 0, 0].map(() => (Math.random() - 0.5) * 9), jr = [0, 0, 0].map(() => (Math.random() - 0.5) * FAN_R * 1.2);
      const out = (c, d, s) => [c[0] + d[0] * s, c[1] + d[1] * s, c[2] + d[2] * s];
      const a0 = A.c.map((v, i) => v + jr[i] * (1 - Math.abs(A.d[i]))), b0 = B.c.map((v, i) => v + jr[(i + 1) % 3] * (1 - Math.abs(B.d[i])));
      const sp = (A.p != null ? A.p : 0.25) * 0.6 + (B.p != null ? B.p : 0.25) * 0.4;
      return { P: [out(a0, A.d, -7), out(a0, A.d, 14), out(b0, B.d, -14), out(b0, B.d, 8)], via: mid.map((v, i) => v + j[i]), u: Math.random() * 0.2, v: 0.16 + 0.5 * sp, hist: [] };
    }
    const HOT = () => {
      const hot = [], cpuT = K.temp(K.primary("cpu")), gpuT = K.temp(K.primary("gpu"));
      const cpu = slots.find((s) => s.id === "cpu"), card = slots.card;
      if (cpu && cpuT != null) hot.push({ c: cpu.c, w: clamp((cpuT - 55) / 35, 0, 1) });
      if (card && gpuT != null) { const cc = card.boxW ? [0, 1, 2].map((i) => card.boxW.reduce((s, p) => s + p[i], 0) / 8) : card.c; hot.push({ c: cc, w: clamp((gpuT - 55) / 35, 0, 1) }); }
      return hot;
    };
    function stepAir(dt, E) {
      const air = pref.air && !(opts && opts.compact) && !reduced() && (E.ins.length || E.outs.length), want = air ? Math.round(clamp(Math.max(E.ins.reduce((s, x) => s + x.p, 0), E.outs.reduce((s, x) => s + x.p, 0)) * 70, 24, 320)) : 0;
      while (parts.length < want) { const q = spawn(E); q.u = Math.random(); parts.push(q); }
      if (parts.length > want) parts.length = want;
      for (let i = 0; i < parts.length; i++) {
        const q = parts[i];
        q.u += dt * q.v;
        if (q.u >= 1) { parts[i] = spawn(E); continue; }
        const p = bez(q.P[0], q.P[1], q.P[2], q.P[3], q.u), k = Math.sin(Math.PI * q.u) * 0.55;   // pulled towards a point inside the case, so the air crosses it
        q.pos = [p[0] + (q.via[0] - p[0]) * k, p[1] + (q.via[1] - p[1]) * k, p[2] + (q.via[2] - p[2]) * k];
        q.hist.push(q.pos); if (q.hist.length > 7) q.hist.shift();
      }
    }

    /* drawing */
    function ring(s, r, ctxs) {
      let pen = false;
      for (let i = 0; i <= 28; i++) { const p = onRing(s, r, i / 28 * TAU); if (!proj(p[0], p[1], p[2])) { pen = false; continue; } if (pen) ctx.lineTo(pr[0], pr[1]); else ctx.moveTo(pr[0], pr[1]); pen = true; }
    }
    function draw(dt, E) {
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.fillStyle = BG; ctx.fillRect(0, 0, CW, CH);
      if (P.view === "3d") camSetup();
      ctx.lineWidth = 1; ctx.strokeStyle = GRID; ctx.beginPath();
      if (!(P.view === "2d" && P.plane === "front")) { const [cx, , cz] = ext.c; for (let x = -4; x <= 4; x++) lnTo(cx + x * 12, 0, cz - 48, cx + x * 12, 0, cz + 48); for (let z = -4; z <= 4; z++) lnTo(cx - 48, 0, cz + z * 12, cx + 48, 0, cz + z * 12); }
      ctx.stroke();
      const G = App.RGBAdv.geom, cb = G.caseBox(cs.tpl);
      if (cb) {
        const cc = G.corners([[cb.x0, 0, cb.z0], [cb.x1, cb.h, cb.z1]]).map((p) => G.caseXf(p, cs));
        ctx.strokeStyle = EDGE; ctx.lineWidth = cs.tpl === "open" ? 2 : 1; ctx.beginPath(); edges(cc); ctx.stroke(); ctx.lineWidth = 1;
        ctx.strokeStyle = "#2a2f22"; ctx.beginPath(); const mx = cb.x0 + 0.5, q = [[mx, 6, cb.z0 + 2], [mx, 6, cb.z1 - 6], [mx, cb.h - 2, cb.z1 - 6], [mx, cb.h - 2, cb.z0 + 2]].map((p) => G.caseXf(p, cs));
        for (let i = 0; i < 4; i++) lnTo(...q[i], ...q[(i + 1) % 4]);
        if (slots.card && slots.card.boxW) edges(slots.card.boxW);
        ctx.stroke();
      }
      // air first (under the fans)
      if (parts.length) {
        const hot = HOT();
        for (const q of parts) {
          if (!q.pos) continue;
          let w = 0; for (const hs of hot) { const d = Math.hypot(q.pos[0] - hs.c[0], q.pos[1] - hs.c[1], q.pos[2] - hs.c[2]); w = Math.max(w, hs.w * clamp(1 - d / 11, 0, 1)); }
          const fade = Math.sin(Math.PI * q.u), col = w > 0.05 ? `255,${Math.round(190 - 110 * w)},${Math.round(60 - 20 * w)}` : "198,244,50";
          for (let i = 1; i < q.hist.length; i++) {
            const a = q.hist[i - 1], b = q.hist[i];
            if (!proj(a[0], a[1], a[2])) continue; const x0 = pr[0], y0 = pr[1];
            if (!proj(b[0], b[1], b[2])) continue;
            ctx.strokeStyle = `rgba(${col},${(0.12 + 0.7 * fade * (i / q.hist.length)).toFixed(3)})`; ctx.lineWidth = 1.8;
            ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(pr[0], pr[1]); ctx.stroke();
          }
        }
        ctx.lineWidth = 1;
      }
      // places and fans
      hits.length = 0;
      const placed = new Map(fans.map((f) => [f.s.id, f]));
      for (const s of slots) {
        const f = placed.get(s.id);
        if (!f) { if (s.id === "pump") continue; ctx.strokeStyle = "rgba(198,244,50,.18)"; ctx.setLineDash([4, 4]); ctx.beginPath(); ring(s, s.r); ctx.stroke(); ctx.setLineDash([]); continue; }
        const isLit = f.c.id === lit, on = f.c.id === sel || isLit, p = isLit ? 100 : K.pctOf(f.c), r = K.rpmOf(f.c);
        ang[f.c.id] = ((ang[f.c.id] || 0) + (reduced() ? 0 : dt * (p / 100) * TAU * 3)) % TAU;
        if (isLit) { ctx.shadowColor = "#c6f432"; ctx.shadowBlur = 14; }
        ctx.strokeStyle = on ? "#c6f432" : "#5b6450"; ctx.lineWidth = on ? 2 : 1.4; ctx.beginPath(); ring(s, s.r + 0.6); ctx.stroke(); ctx.lineWidth = 1; ctx.shadowBlur = 0;
        ctx.fillStyle = on ? "rgba(198,244,50,.62)" : "rgba(198,244,50,.28)";
        for (let i = 0; i < 7; i++) {
          const a = ang[f.c.id] + i * TAU / 7, pts = [onRing(s, s.r * 0.2, a), onRing(s, s.r * 0.95, a - 0.12), onRing(s, s.r * 0.95, a + 0.5), onRing(s, s.r * 0.2, a + 0.4)];
          let ok = true; const xy = [];
          for (const q of pts) { if (!proj(q[0], q[1], q[2])) { ok = false; break; } xy.push(pr[0], pr[1]); }
          if (!ok) continue;
          ctx.beginPath(); ctx.moveTo(xy[0], xy[1]); for (let k = 2; k < 8; k += 2) ctx.lineTo(xy[k], xy[k + 1]); ctx.closePath(); ctx.fill();
        }
        if (proj(s.c[0], s.c[1], s.c[2])) {
          const px = pr[0], py = pr[1], rr = s.r * pr[3];
          hits.push({ id: f.c.id, x: px, y: py, r: Math.max(rr, 12) });
          ctx.fillStyle = "#14160f"; ctx.strokeStyle = on ? "#c6f432" : "#5b6450"; ctx.beginPath(); ctx.arc(px, py, Math.max(2, rr * 0.18), 0, TAU); ctx.fill(); ctx.stroke();
          if (rr > 9 && (P.view === "2d" || on || f.c.id === hover)) { ctx.font = MONO; ctx.fillStyle = on ? "#c6f432" : "#8b919c"; ctx.textAlign = "center"; ctx.fillText(`${p}% · ${r == null ? "–" : r}`, px, py + rr + 12); ctx.textAlign = "start"; }
        }
      }
    }
    function balance(E) {
      const I = E.ins.reduce((s, x) => s + x.w, 0), O = E.outs.reduce((s, x) => s + x.w, 0);
      if (!I && !O) { balB.hidden = true; return; }
      const d = (I - O) / (I + O), k = d > 0.15 ? "pos" : d < -0.15 ? "neg" : "bal";
      balB.hidden = false; balB.textContent = t("fans.bal." + k); balB.title = t("fans.balTip"); balB.dataset.k = k;
    }
    function frame(now) {
      if (dead) return;
      if (!wrap.isConnected) { dead = true; return; }
      const dt = Math.min(0.1, (now - lastT) / 1000 || 0.016); lastT = now;
      if (cv.offsetParent === null || document.hidden || !slots.length) { raf = setTimeout(() => (raf = requestAnimationFrame(frame)), 400); return; }
      const w = cv.clientWidth, hgt = cv.clientHeight;
      if (w && (w !== CW || hgt !== CH || DPR !== Math.min(2, devicePixelRatio || 1))) { DPR = Math.min(2, devicePixelRatio || 1); CW = w; CH = hgt; cv.width = Math.round(CW * DPR); cv.height = Math.round(CH * DPR); }
      const E = ends();
      stepAir(dt, E); balance(E); draw(dt, E);
      raf = requestAnimationFrame(frame);
    }

    /* mouse: click a fan to pick it; drag turns (3D) or pans (2D); wheel zooms */
    const mpos = (e) => { const b = cv.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
    const hitAt = (m) => { let best = null, bd = 1e9; for (const x of hits) { const d = Math.hypot(m[0] - x.x, m[1] - x.y); if (d <= x.r + 6 && d < bd) { best = x; bd = d; } } return best; };
    let drag = null;
    cv.addEventListener("pointerdown", (e) => { cv.setPointerCapture(e.pointerId); drag = { m: mpos(e), l: mpos(e), moved: 0, pan: e.shiftKey || e.button === 1 || e.button === 2 }; });
    cv.addEventListener("pointermove", (e) => {
      const m = mpos(e);
      if (!drag) { const x = hitAt(m); hover = x ? x.id : null; cv.style.cursor = x ? "pointer" : "grab"; return; }
      const dx = m[0] - drag.l[0], dy = m[1] - drag.l[1]; drag.l = m; drag.moved += Math.abs(dx) + Math.abs(dy);
      if (P.view === "3d" && !drag.pan) { P.cam.yaw -= dx * 0.008; P.cam.pitch = clamp(P.cam.pitch + dy * 0.008, -1.45, 1.5); }
      else if (P.view === "3d") { camSetup(); const sc = P.cam.dist / CAM.foc; for (let i = 0; i < 3; i++) P.cam.t[i] += -CAM.r[i] * dx * sc + CAM.u[i] * dy * sc; }
      else { const k = k2(), pan = P.pan2 || (P.plane === "top" ? [ext.c[0], ext.c[2]] : [ext.c[0], ext.c[1]]); P.pan2 = [pan[0] - dx / k, P.plane === "top" ? pan[1] - dy / k : pan[1] + dy / k]; }
    });
    const up = (e) => { if (!drag) return; const was = drag; drag = null; if (was.moved < 5) { const x = hitAt(mpos(e)); if (x && opts && opts.onPick) opts.onPick(x.id); } else App.persist(); };
    cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", () => { drag = null; });
    cv.addEventListener("wheel", (e) => { e.preventDefault(); const f = Math.exp(e.deltaY * 0.0012); if (P.view === "3d") P.cam.dist = clamp(P.cam.dist * f, 40, 360); else P.zoom2 = clamp((P.zoom2 || 1) / f, 0.4, 6); }, { passive: false });
    cv.addEventListener("dblclick", () => { fit(); App.persist(); });
    cv.title = t("fans.stageTip");

    sync();
    load();
    raf = requestAnimationFrame(frame);
    return {
      select(id) { sel = id; },
      setLit(id) { lit = id || null; },
      relayout() { relayout(); },
      get slots() { return slots; },
      get layout() { return layout; },
      flow: (id) => { const f = fans.find((x) => x.c.id === id); return f ? flowOf(K, f.s, id) : "int"; },
      destroy() { dead = true; cancelAnimationFrame(raf); clearTimeout(raf); window.removeEventListener("keydown", onKey); },
    };
  }

  App.FansStage = { mount, loadCase, buildSlots, layoutOf, slotLabel, norm };
})();
