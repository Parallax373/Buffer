"use strict";
/* Fans page: fan curves through a small LibreHardwareMonitor helper (installed only when the user enables it, see
   src-tauri/src/fans.rs; the recorder runs the control loop, crates/ml-recorder/src/fans.rs). FANS-SPEC.md has the plan.
   Simple view: list of fans | the picked fan (curve preset, manual, auto). Advanced views: fans-adv.js (Curves, Wiring, Case).
   One setup (`setup`, the same JSON the recorder keeps in fans.json), two levels. Design: DESIGN.md. */

(function () {
  const { h, S, api } = App;
  const T0 = 30, T1 = 90;
  let page = null, st = {}, setup = null, timer = 0, saveT = 0, bodyEl = null, chipEl = null, closeEl = null;
  const sel = { ctl: null, curve: null };
  const liveFns = [];
  let showHidden = false, importPaths = [];
  const clone = (o) => JSON.parse(JSON.stringify(o));

  /** which level and which Advanced view were open last (kept in the app's preferences) */
  const pref = () => (App.P.fans ||= { level: "simple", adv: "curves" });

  const toast = (e) => App.toast(App.t("fans.err", { err: e }), "err");
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);

  /* ───── setup helpers (shared with fans-adv.js) ───── */

  const sensorOf = (id) => (st.sensors || []).find((s) => s.id === id);
  const value = (id) => num(st.values && st.values[id]);
  const control = (id) => setup.controls.find((c) => c.id === id);
  const curveOf = (id) => setup.curves.find((c) => c.id === id);
  const visible = () => setup.controls.filter((c) => !c.hidden);
  const hwTag = (s) => (/^Cpu/.test(s.hw_type) ? "CPU" : /^Gpu/.test(s.hw_type) ? "GPU" : s.hw_type === "SuperIO" || s.hw_type === "Motherboard" ? App.t("fans.board") : s.hw);
  const sensorName = (id) => {
    if (id && id.startsWith("mix:")) return (setup.mixes.find((m) => "mix:" + m.id === id) || { name: id }).name;
    const s = sensorOf(id);
    return (setup.names && setup.names[id]) || (s ? `${hwTag(s)} · ${s.name}` : id || "");
  };
  const tempSensors = () => (st.sensors || []).filter((s) => s.kind === "temperature");
  /** the temperature people think of as "CPU" and "GPU": the package / core sensor */
  function primary(kind) {
    const list = tempSensors().filter((s) => (kind === "cpu" ? /^Cpu/ : /^Gpu/).test(s.hw_type));
    return (list.find((s) => /package|tctl|core \(max\)|gpu core/i.test(s.name)) || list[0] || {}).id || null;
  }

  /** a sensor's value, with custom Mix sensors worked out here (the recorder does the same for the real control) */
  function temp(id) {
    if (!id) return null;
    if (id.startsWith("mix:")) {
      const m = setup.mixes.find((x) => "mix:" + x.id === id);
      if (!m) return null;
      const v = m.inputs.map(temp);
      if (v.some((x) => x == null) || !v.length) return null;
      return m.func === "min" ? Math.min(...v) : m.func === "avg" ? v.reduce((a, b) => a + b) / v.length : m.func === "sum" ? v.reduce((a, b) => a + b) : m.func === "sub" ? v[0] - v.slice(1).reduce((a, b) => a + b, 0) : Math.max(...v);
    }
    return value(id);
  }
  const curveSrc = (c) => (c && c.src !== undefined ? c.src : null);
  const interp = (pts, t) => {
    if (!pts.length) return 0;
    if (t <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (t <= pts[i][0]) { const a = pts[i - 1], b = pts[i], sp = b[0] - a[0]; return sp <= 0 ? b[1] : a[1] + (b[1] - a[1]) * (t - a[0]) / sp; }
    }
    return pts[pts.length - 1][1];
  };
  /** the points a curve is drawn with, whatever its type */
  function pointsOf(c) {
    if (c.type === "graph") return c.points;
    if (c.type === "linear") return [[c.tmin, c.pmin], [c.tmax, c.pmax]];
    if (c.type === "flat") return [[T0, c.pct], [T1, c.pct]];
    if (c.type === "trigger") return [[T0, c.idle_pct], [c.idle_t, c.idle_pct], [c.load_t, c.load_pct], [T1, c.load_pct]];
    if (c.type === "auto") return [[c.idle_t, c.min], [c.load_t, c.max]];
    return [];
  }
  const liveTemp = (c) => (c.type === "graph" || c.type === "linear" || c.type === "trigger" || c.type === "auto" ? temp(c.src) : null);

  /** the percent a control is at now: what the recorder gave it, or what the hardware reads when Buffer does not drive it */
  function pctOf(c) {
    const o = st.outputs && st.outputs[c.id];
    const v = o != null ? o : value(c.id);
    return v == null ? 0 : Math.round(v);
  }
  const rpmOf = (c) => { const v = c.fan ? value(c.fan) : null; return v == null ? null : Math.round(v / 10) * 10; };
  const driven = (c) => c.mode !== "auto" && st.outputs && st.outputs[c.id] != null && (st.taken || []).includes(c.id);

  /** pending changes are sent 250 ms after the last one */
  function commit() {
    clearTimeout(saveT);
    saveT = setTimeout(() => api.invoke("fans_setup_set", { setup }).catch(toast), 250);
  }
  const uid = (p) => p + Math.random().toString(36).slice(2, 7);

  /* ───── small widgets ───── */

  /** a value the user sets: smooth line + playhead (DESIGN.md), 5 % per wheel notch, Shift = fine */
  function slider({ min = 0, max = 100, step = 5, value: v0 = 0, live = null, onInput }) {
    const el = h("div", { class: "fsl", tabindex: 0 }, h("i", { class: "fl" }), live ? h("i", { class: "lv", "data-lv": live }) : null, h("b", { class: "ph" }));
    let v = v0;
    const draw = () => { const p = ((v - min) / (max - min)) * 100; el.querySelector(".fl").style.width = p + "%"; el.querySelector(".ph").style.left = p + "%"; };
    const from = (x, fine) => {
      const r = el.getBoundingClientRect(), s = fine ? 1 : step;
      v = clamp(Math.round((min + ((x - r.left) / r.width) * (max - min)) / s) * s, min, max); draw(); onInput && onInput(v);
    };
    el.addEventListener("pointerdown", (e) => { el.setPointerCapture(e.pointerId); from(e.clientX, e.shiftKey); el.onpointermove = (ev) => from(ev.clientX, ev.shiftKey); });
    el.addEventListener("pointerup", () => { el.onpointermove = null; });
    el.addEventListener("wheel", (e) => { e.preventDefault(); v = clamp(v + (e.deltaY < 0 ? 5 : -5), min, max); draw(); onInput && onInput(v); }, { passive: false });
    el.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? step : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -step : 0;
      if (d) { e.preventDefault(); v = clamp(v + d, min, max); draw(); onInput && onInput(v); }
    });
    el.set = (nv) => { v = nv; draw(); };
    draw();
    return el;
  }

  /** a row of short segments: something that happens (a live level), brighter to the right */
  const scan = (kind, id, n = 14, tall = false) => h("span", { class: "fscan" + (tall ? " tall" : ""), "data-scan": kind, "data-id": id, "data-n": n }, Array.from({ length: n }, () => h("i")));

  /** label + slider + number, as one settings row */
  function numRow(label, tip, v, min, max, step, unit, on) {
    const out = h("span", { class: "fnum mono", text: v + unit });
    const s = slider({ min, max, step, value: v, onInput: (x) => { out.textContent = x + unit; on(x); } });
    return h("div", { class: "srow", title: tip }, h("span", { class: "lb", text: label }), h("div", { class: "fval" }, s, out));
  }

  /* ───── curve graph: the set curve is a line, the live temperature a playhead marker ───── */

  function graph(host, cid, { w = 520, h: hh = 300, edit = false, compact = false, onEdit } = {}) {
    const c = curveOf(cid);
    if (!c) { host.replaceChildren(); return; }
    const L = compact ? 28 : 36, R = 12, Tp = 10, B = compact ? 20 : 26;
    const X = (t) => L + ((t - T0) / (T1 - T0)) * (w - L - R), Y = (p) => Tp + ((100 - p) / 100) * (hh - Tp - B);
    const pts = pointsOf(c), editable = edit && (c.type === "graph" || c.type === "flat" || c.type === "linear");
    const line = pts.map(([t, p], i) => (i ? "L" : "M") + X(t).toFixed(1) + " " + Y(p).toFixed(1)).join(" ");
    let s = `<svg class="gsvg" viewBox="0 0 ${w} ${hh}" role="img" aria-label="${App.t("fans.type." + c.type)}"><defs><linearGradient id="gg-${host.id || "g"}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" class="s0"/><stop offset="1" class="s1"/></linearGradient></defs>`;
    for (let t = T0; t <= T1; t += 10) s += `<line class="gl" x1="${X(t)}" x2="${X(t)}" y1="${Tp}" y2="${hh - B}"/><text x="${X(t)}" y="${hh - 6}" text-anchor="middle">${t}°</text>`;
    for (let p = 0; p <= 100; p += 25) s += `<line class="gl" x1="${L}" x2="${w - R}" y1="${Y(p)}" y2="${Y(p)}"/><text x="${L - 6}" y="${Y(p) + 3}" text-anchor="end">${p}</text>`;
    if (pts.length) {
      s += `<path class="ga" d="${line} L${X(pts[pts.length - 1][0])} ${Y(0)} L${X(pts[0][0])} ${Y(0)}Z" fill="url(#gg-${host.id || "g"})"/><path class="gc" d="${line}"/>`;
      if (c.type !== "trigger" && c.type !== "auto") pts.forEach(([t, p], i) => { s += `<g class="pt" data-i="${i}"><circle class="hit" cx="${X(t)}" cy="${Y(p)}" r="16"/><circle class="dot" cx="${X(t)}" cy="${Y(p)}" r="${editable ? 5 : 3.2}"/></g>`; });
    }
    s += `<g class="live"><line y1="${Tp}" y2="${hh - B}"/><circle r="4.5"/><text class="lt" y="${Tp + 10}"></text></g></svg>`;
    host.innerHTML = s;
    const svg = host.querySelector("svg"), g = svg.querySelector(".live");
    const upd = () => {
      const t = liveTemp(c);
      g.style.display = t == null ? "none" : "";
      if (t == null) return;
      const x = X(clamp(t, T0, T1)), p = interp(pointsOf(c), t), tx = g.querySelector(".lt");
      g.querySelector("line").setAttribute("x1", x); g.querySelector("line").setAttribute("x2", x);
      g.querySelector("circle").setAttribute("cx", x); g.querySelector("circle").setAttribute("cy", Y(p));
      tx.textContent = `${t.toFixed(0)}° → ${Math.round(p)}%`; tx.setAttribute("x", x > w - 90 ? x - 6 : x + 6); tx.setAttribute("text-anchor", x > w - 90 ? "end" : "start");
    };
    upd.host = host;
    for (let i = liveFns.length - 1; i >= 0; i--) if (liveFns[i].host === host || !liveFns[i].host.isConnected) liveFns.splice(i, 1);
    liveFns.push(upd); upd();
    if (!editable) return;
    const toTP = (e) => { const r = svg.getBoundingClientRect(); return [((e.clientX - r.left) * w) / r.width, ((e.clientY - r.top) * hh) / r.height]; };
    const redraw = () => { graph(host, cid, { w, h: hh, edit, compact, onEdit }); onEdit && onEdit(); commit(); };
    svg.querySelectorAll(".pt").forEach((el) => el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const i = +el.dataset.i;
      const move = (ev) => {
        const r = host.querySelector("svg").getBoundingClientRect();
        const mx = ((ev.clientX - r.left) * w) / r.width, my = ((ev.clientY - r.top) * hh) / r.height, step = ev.shiftKey ? 1 : 5;
        const t = Math.round((T0 + ((mx - L) / (w - L - R)) * (T1 - T0)) / step) * step, p = Math.round((100 - ((my - Tp) / (hh - Tp - B)) * 100) / step) * step;
        if (c.type === "graph") {
          const lo = i ? c.points[i - 1][0] + 1 : T0, hi = i < c.points.length - 1 ? c.points[i + 1][0] - 1 : T1;
          c.points[i] = [clamp(t, lo, hi), clamp(p, 0, 100)];
        } else if (c.type === "flat") c.pct = clamp(p, 0, 100);
        else if (c.type === "linear") {
          if (i === 0) { c.tmin = clamp(t, T0, c.tmax - 1); c.pmin = clamp(p, 0, 100); } else { c.tmax = clamp(t, c.tmin + 1, T1); c.pmax = clamp(p, 0, 100); }
        }
        redraw();
      };
      const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
      addEventListener("pointermove", move); addEventListener("pointerup", up);
    }));
    if (c.type === "graph") svg.addEventListener("dblclick", (e) => {
      const hit = e.target.closest(".pt"), [mx] = toTP(e);
      if (hit) { if (c.points.length > 2) c.points.splice(+hit.dataset.i, 1); } else {
        const t = Math.round((T0 + ((mx - L) / (w - L - R)) * (T1 - T0)) / 5) * 5;
        if (t > c.points[0][0] && t < c.points[c.points.length - 1][0] && !c.points.some((q) => q[0] === t)) { c.points.push([t, Math.round(interp(c.points, t))]); c.points.sort((a, b) => a[0] - b[0]); }
      }
      redraw();
    });
  }

  /* ───── presets: a curve of the control's own, on the temperature that matters for it ───── */

  const PRESETS = { silent: [[40, 20], [55, 30], [70, 50], [85, 80]], balanced: [[40, 30], [55, 45], [70, 70], [85, 100]], performance: [[40, 45], [55, 65], [70, 90], [80, 100]] };

  function defaultSource(c) {
    const s = sensorOf(c.id) || sensorOf(c.fan);
    const cpu = primary("cpu"), gpu = primary("gpu");
    if (/^Gpu/.test((s && s.hw_type) || "")) return gpu || cpu;
    if (/cpu/i.test(c.name)) return cpu || gpu;
    if (cpu && gpu) {
      if (!setup.mixes.some((m) => m.id === "auto")) setup.mixes.push({ id: "auto", name: App.t("fans.mixAuto"), func: "max", inputs: [cpu, gpu] });
      return "mix:auto";
    }
    return cpu || gpu;
  }

  function applyPreset(c, key) {
    const id = "p:" + c.id;
    let cv = curveOf(id);
    const pts = PRESETS[key].map((p) => p.slice());
    if (cv) { cv.type = "graph"; cv.points = pts; } else {
      cv = { id, name: `${c.name} · ${App.t("fans.preset." + key)}`, type: "graph", src: defaultSource(c), points: pts, hyst: 2, resp: 2, skip_edges: true };
      setup.curves.push(cv);
    }
    cv.name = `${c.name} · ${App.t("fans.preset." + key)}`;
    c.curve = id; c.mode = "curve";
    commit();
    return cv;
  }
  const presetOf = (c) => {
    const cv = c.curve && curveOf(c.curve);
    if (!cv || cv.type !== "graph" || c.curve !== "p:" + c.id) return null;
    return Object.keys(PRESETS).find((k) => PRESETS[k].every((p, i) => cv.points[i] && cv.points[i][0] === p[0] && cv.points[i][1] === p[1])) || "custom";
  };

  /* ───── live updates (once a second, in place) ───── */

  function tick() {
    $$("[data-temp]").forEach((e) => { const v = temp(e.dataset.temp); e.textContent = v == null ? "–" : v.toFixed(0); });
    $$("[data-scan]").forEach((e) => {
      const n = +e.dataset.n, k = e.dataset.scan, id = e.dataset.id;
      let p = 0;
      if (k === "temp") { const v = temp(id); p = v == null ? 0 : (v - T0) / (T1 - T0); } else { const c = control(id); p = c ? pctOf(c) / 100 : 0; }
      const lit = Math.round(clamp(p, 0, 1) * n);
      [...e.children].forEach((c, i) => { c.style.opacity = i < lit ? (0.38 + (0.62 * i) / Math.max(1, n - 1)).toFixed(2) : ""; });
    });
    setup.controls.forEach((c) => {
      const p = pctOf(c), r = rpmOf(c), gpu = /^Gpu/.test((sensorOf(c.id) || {}).hw_type || "");
      // a header with a fan that reads 0 rpm shows no signal (a card legitimately sits at 0 rpm in its zero-rpm mode)
      $$(`.frow[data-c="${CSS.escape(c.id)}"]`).forEach((e) => e.classList.toggle("nosig", !gpu && !!c.fan && r === 0));
      $$(`[data-pct="${CSS.escape(c.id)}"]`).forEach((e) => { e.textContent = p; });
      $$(`[data-rpm="${CSS.escape(c.id)}"]`).forEach((e) => { e.textContent = r == null ? "–" : r; });
      $$(`[data-lv="${CSS.escape(c.id)}"]`).forEach((e) => { e.style.width = p + "%"; });
      $$(`[data-dot="${CSS.escape(c.id)}"]`).forEach((e) => { e.className = "dot " + (c.mode === "auto" ? "off" : c.mode === "manual" ? "own" : driven(c) ? "" : "idle"); });
    });
    liveFns.forEach((f) => f());
    if (App.FansAdv && App.FansAdv.tick) App.FansAdv.tick();
    chip();
  }
  const $$ = (s) => page.querySelectorAll(s);

  /** engine state next to the title: ready, or paused because another fan program is running */
  function chip() {
    if (!chipEl) return;
    const cf = st.conflicts || [], all = cf.find((x) => !x.gpu_only), gpu = cf.find((x) => x.gpu_only);
    chipEl.className = "chip " + (all ? "warn" : "on");
    chipEl.textContent = all ? App.t("fans.paused", { name: all.name }) : gpu ? App.t("fans.pausedGpu", { name: gpu.name }) : st.failed ? App.t("fans.failsafe") : App.t("fans.ready");
    chipEl.title = all || gpu ? App.t("fans.pausedTip") : App.t("fans.tip");
    // only FanControl can be closed from here (its hidden service is what keeps the conflict alive)
    if (closeEl) closeEl.hidden = !(all && all.name === "FanControl");
  }

  async function closeConflict() {
    closeEl.disabled = true;
    try { await api.invoke("fans_close_conflict", { name: "FanControl" }); App.toast(App.t("fans.closedOther", { name: "FanControl" })); }
    catch (e) { toast(e); }
    finally { closeEl.disabled = false; }
  }

  async function poll() {
    if (S.view !== "fans") return stop();
    try {
      const n = await api.invoke("fans_status");
      if (S.view !== "fans") return;
      st = n;
      if (!st.enabled || !st.installed) { render(); return; }
      tick();
    } catch (_) { /* the recorder may be restarting: try again next second */ }
  }
  function start() { stop(); timer = setInterval(poll, 1000); }
  function stop() { clearInterval(timer); timer = 0; }

  /* ───── gate and page ───── */

  function gate(msg, busy, error) {
    stop();
    const unavailable = !st.installed && !st.downloadable && !st.dev_build;
    page.replaceChildren(App.emptyState(App.t("fans.gate"), error || msg || (unavailable ? App.t("fans.noBuild") : App.t("fans.gateD")), busy || unavailable ? null : App.t("fans.enable"), async () => {
      gate(App.t("fans.installing"), true);
      try {
        if (!st.installed) await api.invoke("fans_install");
        await api.invoke("fans_enable");
        await render();
      } catch (e) { gate(null, false, String(e)); }
    }));
    const b = page.querySelector(".empty button");
    if (b) b.title = App.t("fans.tip");
  }

  async function render() {
    page = App.$("#v-fans");
    try { st = await api.invoke("fans_status"); } catch (_) { st = {}; }
    if (S.view !== "fans") return;
    if (!st.installed || !st.enabled) return gate();
    // the recorder starts the helper and reads the sensors; that takes a few seconds the first time
    for (let i = 0; !st.connected && i < 20; i++) {
      gate(App.t("fans.starting"), true);
      await new Promise((r) => setTimeout(r, 1000));
      try { st = await api.invoke("fans_status"); } catch (_) { /* retry */ }
      if (S.view !== "fans") return;
    }
    if (!st.connected) return gate(null, false, st.error || App.t("fans.noHelper"));
    try { importPaths = await api.invoke("fans_import_find"); } catch (_) { importPaths = []; }
    setup = clone(st.setup);
    App.FansAdv.bind(kit);
    setup.mixes ||= []; setup.curves ||= []; setup.controls ||= []; setup.layout ||= {};
    if (!sel.ctl || !control(sel.ctl) || (control(sel.ctl).hidden && visible().length)) sel.ctl = (visible()[0] || setup.controls[0] || {}).id || null;
    if (!sel.curve || !curveOf(sel.curve)) sel.curve = (control(sel.ctl) || {}).curve || (setup.curves[0] || {}).id || null;
    draw();
    start();
  }

  function head() {
    chipEl = h("span", { class: "chip on", text: App.t("fans.ready") });
    closeEl = h("button", { class: "chip warn", text: App.t("fans.closeOther", { name: "FanControl" }),
      title: App.t("fans.closeOtherTip"), hidden: true, onClick: closeConflict });
    return h("div", { class: "eqhead" }, h("h1", { text: App.t("nav.fans") }), chipEl, closeEl,
      App.ui.segc([["simple", App.t("rgb.simple")], ["adv", App.t("rgb.advanced")]], pref().level, (v) => { pref().level = v; App.persist(); draw(); }),
      h("span", { class: "sp" }),
      importPaths.length ? h("button", { class: "chip", text: App.t("fans.import"), title: App.t("fans.importTip"), onClick: openImport }) : null,
      h("button", { class: "chip", text: App.t("fans.detect"), title: App.t("fans.detectTip"), onClick: openDetect }),
      h("button", { class: "chip", text: App.t("fans.off"), title: App.t("fans.offTip"), onClick: turnOff }));
  }

  /** Detect: new controls first (the recorder's quick scan), then each board fan is spun up in turn and paired with the speed
      sensor that answers; the case schematic shows which fan is being tried. It is audible, so it starts only on a click. */
  async function openDetect() {
    clearTimeout(saveT);
    try { await api.invoke("fans_setup_set", { setup }); } catch (e) { return toast(e); }
    const busy = (st.conflicts || []).some((c) => !c.gpu_only);
    let tm = 0;
    const close = () => { clearInterval(tm); stage.destroy(); ov.remove(); render(); };
    const caseEl = h("div", { class: "fcase2" }), rows = h("div", { class: "fpairs" }), prog = scan("none", "", 24, true);
    const title = h("div", { class: "ftitle sm", text: App.t(busy ? "fans.det.busy" : "fans.det.intro") });
    const startBtn = h("button", { class: "btn acc", text: App.t("fans.det.start"), disabled: busy, onClick: go });
    const closeBtn = h("button", { class: "btn ghost", text: App.t("common.cancel"), onClick: close });
    // the RGB page's case, as on the Case view: the fan being tried spins and glows
    const stage = App.FansStage.mount(caseEl, kit, { compact: true });
    const fresh = () => stage.relayout();
    const nameOf = (id) => (control(id) || { name: id }).name;
    function update(p) {
      stage.setLit(p.current);
      const lit = p.total ? Math.round((p.index / p.total) * 24) : 0;
      [...prog.children].forEach((c, i) => { c.style.opacity = i < lit ? (0.38 + (0.62 * i) / 23).toFixed(2) : ""; });
      if (p.running) title.textContent = App.t("fans.det.step", { n: p.index + 1, total: p.total });
      for (let i = rows.children.length; i < p.results.length; i++) {
        const [cid, fan, rise] = p.results[i];
        rows.append(h("div", { class: "fpair" }, h("span", { text: nameOf(cid) }), fan ? h("b", { text: `${sensorName(fan)} · +${Math.round(rise)} rpm` }) : h("span", { class: "muted", text: App.t("fans.det.none") })));
      }
    }
    async function go() {
      startBtn.hidden = true; closeBtn.textContent = App.t("common.close"); title.textContent = App.t("fans.starting");
      try {
        await api.invoke("fans_detect");
        st = await api.invoke("fans_status");
        st.setup.controls.forEach((c) => { const m = control(c.id); if (!m) setup.controls.push(c); });
        fresh();
        await api.invoke("fans_probe");
      } catch (e) { toast(e); title.textContent = String(e); return; }
      tm = setInterval(async () => {
        let s; try { s = await api.invoke("fans_status"); } catch (_) { return; }
        const p = s.probe || { results: [] };
        update(p);
        if (p.done) {
          clearInterval(tm); startBtn.remove();
          title.textContent = p.error ? App.t("fans.det.err", { err: p.error }) : App.t("fans.det.done", { n: p.results.filter((r) => r[1]).length });
        }
      }, 700);
    }
    const ov = h("div", { class: "fov" }, h("div", { class: "card2 fpad fdlg wide", role: "dialog", "aria-label": App.t("fans.detect") },
      h("div", { class: "fdetl" }, caseEl), h("div", { class: "fstack" }, App.ui.cap(App.t("fans.detect")), title, prog, rows, h("div", { class: "rowflex" }, startBtn, closeBtn))));
    page.querySelector(".fans").append(ov);
  }

  async function turnOff() {
    try { await api.invoke("fans_disable"); App.toast(App.t("fans.offDone"), "ok"); } catch (e) { toast(e); }
    render();
  }

  function draw() {
    liveFns.length = 0;
    bodyEl = h("div", { class: "fbody" });
    page.replaceChildren(h("div", { class: "fans" }, head(), profileBar(), bodyEl));
    if (pref().level === "adv") App.FansAdv.render(bodyEl, kit); else simple();
    tick();
  }

  /* ───── profiles and share codes ───── */

  /** saved copies of the whole setup; a share code carries only the curves and Mix sensors (the rest is this PC's hardware) */
  function profileBar() {
    const names = st.profiles || [], active = st.profile;
    const flush = () => { clearTimeout(saveT); return api.invoke("fans_setup_set", { setup }); };
    const run = async (action, name) => { try { await flush(); await api.invoke("fans_profile", { action, name }); await render(); } catch (e) { toast(e); } };
    const bar = h("div", { class: "rowflex fprof" }, App.ui.cap(App.t("fans.profiles")));
    names.forEach((n) => bar.append(h("button", { class: "chip" + (n === active ? " on" : ""), text: n, onClick: () => n !== active && run("load", n) })));
    const add = h("button", { class: "chip", text: "+", title: App.t("fans.profileNew"), "aria-label": App.t("fans.profileNew") });
    add.onclick = () => {
      const inp = h("input", { class: "field fpname", placeholder: App.t("fans.profileName"), maxlength: 40, spellcheck: false });
      inp.onkeydown = (e) => {
        const name = inp.value.trim();
        if (e.key === "Enter" && name) run("save", name).then(() => App.toast(App.t("fans.profileSaved", { name }), "ok"));
        if (e.key === "Escape") draw();
      };
      inp.onblur = () => { if (!inp.value.trim()) draw(); };
      add.replaceWith(inp); inp.focus();
    };
    bar.append(add);
    if (active) bar.append(h("button", { class: "chip", text: "×", title: App.t("fans.profileDel"), "aria-label": App.t("fans.profileDel"), onClick: () => run("delete", active) }));
    bar.append(h("span", { class: "sp" }),
      h("button", { class: "chip", text: App.t("fans.copyCode"), title: App.t("fans.codeTip"), onClick: async () => {
        const code = await App.share.encode("FAN", { curves: setup.curves, mixes: setup.mixes });
        await App.share.copy(code);
        App.toast(App.t("fans.codeCopied"), "ok");
      } }),
      h("button", { class: "chip", text: App.t("fans.pasteCode"), onClick: (e) => {
        const inp = h("input", { class: "field fpname", placeholder: "BUF-FAN1.…", spellcheck: false });
        const go = async () => { const n = await addFromCode(inp.value); if (n) draw(); };
        inp.onpaste = () => setTimeout(go, 0);
        inp.onkeydown = (ev) => { if (ev.key === "Enter") go(); if (ev.key === "Escape") draw(); };
        inp.onblur = () => { if (!inp.value.trim()) draw(); };
        e.currentTarget.replaceWith(inp); inp.focus();
      } }));
    return bar;
  }

  /** A pasted code is untrusted text: only known curve types, numbers clamped to their ranges, sensors that exist here. */
  async function addFromCode(text) {
    const v = await App.share.decode("FAN", text);
    if (!v || !Array.isArray(v.curves)) { toast(App.t("fans.codeBad")); return 0; }
    const num = (x, a, b, d) => (typeof x === "number" && isFinite(x) ? clamp(x, a, b) : d);
    const known = new Set([...tempSensors().map((s) => s.id)]);
    const fallback = primary("cpu") || primary("gpu") || "";
    const ids = new Map(), mixes = [];
    for (const m of (v.mixes || []).slice(0, 8)) {
      const inputs = (Array.isArray(m.inputs) ? m.inputs : []).filter((i) => known.has(i));
      if (!inputs.length || typeof m.id !== "string") continue;
      const id = uid("s");
      ids.set("mix:" + m.id, "mix:" + id);
      mixes.push({ id, name: String(m.name || "Mix").slice(0, 40), func: ["max", "min", "avg", "sum", "sub"].includes(m.func) ? m.func : "max", inputs });
    }
    const src = (s) => (known.has(s) ? s : ids.get(s) || fallback);
    const curves = [];
    for (const c of v.curves.slice(0, 24)) {
      const base = { id: uid("s"), name: String(c.name || "").slice(0, 40) || App.t("fans.newCurveName", { n: setup.curves.length + curves.length + 1 }), hyst: num(c.hyst, 0, 10, 0), resp: num(c.resp, 0, 20, 0), skip_edges: c.skip_edges !== false };
      let kind = null;
      if (c.type === "graph" && Array.isArray(c.points)) {
        const pts = c.points.slice(0, 12).filter((p) => Array.isArray(p)).map((p) => [num(p[0], 20, 100, 50), num(p[1], 0, 100, 50)]).sort((a, b) => a[0] - b[0]);
        if (pts.length >= 2) kind = { type: "graph", src: src(c.src), points: pts };
      } else if (c.type === "linear") kind = { type: "linear", src: src(c.src), tmin: num(c.tmin, 20, 90, 40), tmax: num(c.tmax, 30, 100, 80), pmin: num(c.pmin, 0, 100, 30), pmax: num(c.pmax, 0, 100, 100) };
      else if (c.type === "flat") kind = { type: "flat", pct: num(c.pct, 0, 100, 40) };
      else if (c.type === "trigger") kind = { type: "trigger", src: src(c.src), idle_t: num(c.idle_t, 20, 90, 40), load_t: num(c.load_t, 30, 100, 70), idle_pct: num(c.idle_pct, 0, 100, 30), load_pct: num(c.load_pct, 0, 100, 80) };
      else if (c.type === "auto") kind = { type: "auto", src: src(c.src), idle_t: num(c.idle_t, 20, 90, 40), load_t: num(c.load_t, 30, 100, 70), min: num(c.min, 0, 100, 20), max: num(c.max, 0, 100, 100), step: num(c.step, 1, 20, 5), deadband: num(c.deadband, 1, 20, 6) };
      if (!kind) continue;
      if (c.id) ids.set(c.id, base.id);
      curves.push({ ...base, ...kind });
    }
    if (!curves.length) { toast(App.t("fans.codeBad")); return 0; }
    setup.mixes.push(...mixes); setup.curves.push(...curves);
    sel.curve = curves[0].id; commit();
    App.toast(App.t("fans.codeAdded", { n: curves.length }), "ok");
    return curves.length;
  }

  /* ───── import from FanControl ───── */

  async function openImport() {
    let r;
    try { r = await api.invoke("fans_import", { path: importPaths[0] }); } catch (e) { return toast(e); }
    const close = () => ov.remove();
    const chips = [["controls", r.controls], ["curves", r.curves], ["mixes", r.mixes], ["hidden", r.hidden]].filter(([, n]) => n);
    const ov = h("div", { class: "fov", onClick: (e) => e.target === ov && close() }, h("div", { class: "card2 fpad fdlg", role: "dialog", "aria-label": App.t("fans.imp.title") },
      App.ui.cap(App.t("fans.imp.title")),
      h("div", { class: "rowflex" }, chips.map(([k, n]) => h("span", { class: "chip on", text: App.t("fans.imp." + k, { n }) }))),
      h("div", { class: "muted fhint", text: App.t("fans.imp.note") }),
      r.notes.length ? h("div", { class: "fnotes mono" }, r.notes.map((n) => h("div", { text: n }))) : null,
      h("div", { class: "rowflex" }, h("button", { class: "btn acc", text: App.t("fans.imp.do"), onClick: () => {
        const prev = clone(setup);
        setup = r.setup; setup.mixes ||= []; setup.curves ||= []; setup.controls ||= []; setup.layout ||= {};
        sel.ctl = (visible()[0] || setup.controls[0] || {}).id || null; sel.curve = (control(sel.ctl) || {}).curve || (setup.curves[0] || {}).id || null;
        commit(); close(); draw();
        App.toast(App.t("fans.imp.done"), "ok", { label: App.t("ra.undo"), run: () => { setup = prev; commit(); draw(); } });
      } }), h("button", { class: "btn ghost", text: App.t("common.cancel"), onClick: close }))));
    page.querySelector(".fans").append(ov);
  }

  /* ───── Simple view: list of fans | the picked fan ───── */

  function simple() {
    const list = h("div", { class: "flist" + (showHidden ? " showhid" : "") });
    const detail = h("div", { class: "fdetail" });
    const row = (c) => {
      const el = h("button", { class: "frow" + (c.id === sel.ctl ? " sel" : "") + (c.hidden ? " hid" : ""), "data-c": c.id,
        onClick: () => { sel.ctl = c.id; list.querySelectorAll(".frow").forEach((x) => x.classList.toggle("sel", x === el)); sel.curve = c.curve || sel.curve; fill(); } },
        h("span", { "data-dot": c.id, class: "dot" }), h("span", { class: "nm", text: c.name }),
        h("span", { class: "r" }, h("span", { "data-pct": c.id, text: "0" }), "%"),
        h("span", { class: "sub" }, scan("ctl", c.id, 16), h("span", { class: "sp" }), h("span", { class: "mono" }, h("span", { "data-rpm": c.id, text: "–" }), " rpm")));
      return el;
    };
    const hiddenN = setup.controls.filter((c) => c.hidden).length;
    list.append(...[App.ui.cap(App.t("fans.fans")), ...setup.controls.map(row),
      hiddenN ? h("button", { class: "fhidbtn", text: App.t("fans.hiddenN", { n: hiddenN }), onClick: () => { showHidden = !showHidden; list.classList.toggle("showhid", showHidden); } }) : null,
      App.ui.cap(App.t("fans.temps")), h("div", { class: "frow2" }, [["cpu", "CPU"], ["gpu", "GPU"]].map(([k, n]) => primary(k) && h("span", { class: "chip" }, n + " ", h("b", { class: "mono", "data-temp": primary(k), text: "–" }), "°")))].filter(Boolean));
    const fill = () => {
      const c = control(sel.ctl);
      detail.replaceChildren(c ? detailOf(c, list) : h("div", { class: "muted", text: App.t("fans.none") }));
      tick();
    };
    bodyEl.append(h("div", { class: "fsimple" }, h("div", { class: "fleft" }, list), detail));
    fill();
  }

  function detailOf(c, list) {
    const body = h("div", { class: "fmode" });
    const title = h("div", { class: "ftitle", text: c.name, title: App.t("fans.rename"), onClick: () => {
      const inp = h("input", { class: "field", value: c.name, maxlength: 40, "aria-label": App.t("fans.rename") });
      const done = (ok) => { if (ok && inp.value.trim()) { c.name = inp.value.trim(); commit(); const r = list.querySelector(`[data-c="${CSS.escape(c.id)}"] .nm`); if (r) r.textContent = c.name; } title.textContent = c.name; };
      title.replaceChildren(inp); inp.focus(); inp.select();
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); });
      inp.addEventListener("blur", () => done(true));
    } });
    const hideBtn = h("button", { class: "chip", text: App.t(c.hidden ? "fans.show" : "fans.hide"), onClick: (e) => {
      c.hidden = !c.hidden; commit(); e.target.textContent = App.t(c.hidden ? "fans.show" : "fans.hide");
      list.querySelector(`[data-c="${CSS.escape(c.id)}"]`)?.classList.toggle("hid", c.hidden);
    } });
    const modes = App.ui.segc([["curve", App.t("fans.mode.curve")], ["manual", App.t("fans.mode.manual")], ["auto", App.t("fans.mode.auto")]], c.mode, (m) => {
      if (m === "curve" && !c.curve) applyPreset(c, "balanced");
      c.mode = m; commit();
      modes.querySelectorAll("button").forEach((b, i) => b.classList.toggle("on", ["curve", "manual", "auto"][i] === m));
      mode(); tick();
    });
    const mode = () => {
      if (c.mode === "manual") {
        body.replaceChildren(h("div", { class: "card2 fpad" }, h("div", { class: "srow" }, h("span", { class: "lb", text: App.t("fans.speed") }),
          h("div", { class: "fval" }, slider({ value: Math.round(c.manual), live: c.id, onInput: (v) => { c.manual = v; num_.textContent = v + "%"; commit(); } }), ((num_ = h("span", { class: "fnum mono", text: Math.round(c.manual) + "%" })))))));
      } else if (c.mode === "auto") {
        body.replaceChildren(h("div", { class: "card2 fpad muted", text: App.t("fans.autoD") }));
      } else {
        const cv = curveOf(c.curve), pr = presetOf(c);
        const mini = h("div", { id: "fmini" });
        const curveSel = h("select", { class: "field", "aria-label": App.t("fans.curve"), onChange: (e) => { c.curve = e.target.value; commit(); mode(); tick(); } },
          setup.curves.map((x) => h("option", { value: x.id, text: x.name, selected: x.id === c.curve })));
        body.replaceChildren(h("div", { class: "card2 fpad" },
          h("div", { class: "rowflex" }, h("span", { class: "cap", text: App.t("fans.curve") }), curveSel, h("span", { class: "chip", text: cv ? sensorName(curveSrc(cv)) || App.t("fans.noSource") : "" })),
          h("div", { class: "rowflex fpre" }, [...Object.keys(PRESETS), "custom"].map((k) => h("button", { class: "chip" + (pr === k ? " on" : ""), text: App.t("fans.preset." + k),
            onClick: () => { if (k === "custom") { sel.curve = c.curve; pref().level = "adv"; pref().adv = "curves"; App.persist(); draw(); return; } applyPreset(c, k); mode(); tick(); } }))),
          mini, h("div", { class: "rowflex" }, h("button", { class: "btn", text: App.t("fans.editCurve"), onClick: () => { sel.curve = c.curve; pref().level = "adv"; pref().adv = "curves"; App.persist(); draw(); } }))));
        if (cv) graph(mini, cv.id, { w: 420, h: 190, compact: true });
      }
    };
    let num_ = null;
    mode();
    return h("div", { class: "fstack" },
      h("div", { class: "rowflex" }, h("div", { style: { flex: 1, minWidth: 0 } }, App.ui.cap(App.t("fans.fan")), title), hideBtn),
      h("div", { class: "card2 fpad" }, h("div", { class: "rowflex fbig" }, h("span", { class: "mono big" }, h("span", { "data-pct": c.id, text: "0" }), h("small", { text: "%" })),
        h("span", { class: "mono muted" }, h("span", { "data-rpm": c.id, text: "–" }), " rpm"), h("span", { class: "sp" }), scan("ctl", c.id, 20, true))),
      modes, body);
  }

  /** what fans-adv.js needs */
  const kit = {
    h, slider, scan, graph, numRow, row: (l, v, t) => h("div", { class: "srow", title: t || "" }, h("span", { class: "lb", text: l }), h("div", { class: "fval" }, v)),
    get st() { return st; }, get setup() { return setup; }, sel, pref, commit, control, curveOf, sensorName, tempSensors, temp, pctOf, rpmOf, driven, value,
    primary, uid, toast, tick, redraw: () => draw(), pointsOf, interp, hwTag, curveSrc,
  };

  App.Fans = {
    kit,
    render,
    leave() { stop(); clearTimeout(saveT); if (setup) api.invoke("fans_setup_set", { setup }).catch(() => {}); },
  };
})();
