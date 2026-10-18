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
  let importPaths = [];
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

  /** the power draw in watts of the CPU or the graphics card (its package sensor), or null when the helper does not report it */
  function power(kind) {
    const s = (st.sensors || []).find((x) => x.kind === "power" && (kind === "cpu" ? /^Cpu/ : /^Gpu/).test(x.hw_type) && /package/i.test(x.name));
    return s ? value(s.id) : null;
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

  /** set by the gate's "take over from FanControl": once the page is up, the import dialog opens by itself */
  let importAfter = false;
  function gate(msg, busy, error) {
    stop();
    const unavailable = !st.installed && !st.downloadable && !st.dev_build;
    const enable = async (andImport) => {
      importAfter = andImport;
      gate(App.t("fans.installing"), true);
      try {
        if (!st.installed) await api.invoke("fans_install");
        await api.invoke("fans_enable");
        await render();
      } catch (e) { importAfter = false; gate(null, false, App.installError(e) || null); }   // a declined UAC prompt: back to the gate, no error
    };
    page.replaceChildren(App.emptyState(App.t("fans.gate"), error || msg || (unavailable ? App.t("fans.noBuild") : App.t("fans.gateD")), busy || unavailable ? null : App.t("fans.enable"), () => enable(false)));
    const empty = page.querySelector(".empty");
    const b = empty && empty.querySelector("button");
    if (b) b.title = App.t("fans.tip");
    if (busy || unavailable || !empty) return;
    // FanControl on this PC: propose taking over from it (its curves come along) instead of only warning later
    const seq = ++gateSeq;
    api.invoke("fans_import_find").catch(() => []).then((paths) => {
      if (seq !== gateSeq || !empty.isConnected || !(paths && paths.length)) return;
      importPaths = paths;
      empty.append(h("div", { class: "gateother", title: App.t("fans.takeTip") },
        h("span", { class: "muted", text: App.t("fans.foundOther", { name: "FanControl" }) }),
        h("button", { class: "btn acc", text: App.t("fans.import"), onClick: () => enable(true) })));
    });
  }
  let gateSeq = 0;

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
    // Laptops steer their fans through the embedded controller, which LibreHardwareMonitor cannot write: temperatures
    // are listed but there is nothing to control. Say so instead of showing an empty list.
    if (!setup.controls.length && !(st.sensors || []).some((x) => x.control)) {
      stop();
      importAfter = false;
      // "Turn off" leaves the elevated helper and its task installed; "Remove" takes them away too (same as Settings)
      const remove = App.ui.sure(App.t("fans.removeHelper"), App.t("fans.removeTip"), async (b) => {
        try { await api.invoke("fans_uninstall"); App.toast(App.t("fans.removed"), "ok"); } catch (err) { App.toast(App.t("fans.err", { err }), "err"); b.disabled = false; return; }
        render();
      });
      page.replaceChildren(App.emptyState(App.t("fans.noControl"), App.t("fans.noControlD"), App.t("fans.off"), turnOff, [remove]));
      return;
    }
    draw();
    start();
    if (importAfter) { importAfter = false; if (importPaths.length) openImport(); }
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
      } }),
      // FanControl still running would keep Buffer paused: offer to close it right here
      (st.conflicts || []).some((c) => c.name === "FanControl")
        ? h("button", { class: "btn", text: App.t("fans.closeOther", { name: "FanControl" }), title: App.t("fans.closeOtherTip"),
          onClick: async (e) => { e.currentTarget.disabled = true; await closeConflict(); } })
        : null,
      h("button", { class: "btn ghost", text: App.t("common.cancel"), onClick: close }))));
    page.querySelector(".fans").append(ov);
  }

  /* ───── Simple view: the fans in groups any PC has (processor, graphics card, case), one dial each ─────
     For someone who wants it to just work: no curves, no numbers to set. A group is Auto (the board or the card decides)
     or follows a dial from quiet to cool; the dial writes a Buffer-owned curve per group ("simple:<group>") on the
     temperature that matters for it (the CPU, the card, the warmer of the two for the case). A group whose fans were set
     up on the Advanced view keeps that and says so, with "Simplify" to go back to the dial. */

  const SIMPLE = {
    // [quietest, coolest] curves (temperature °C, speed %); the dial's 5 steps lie between them
    cpu: [[[40, 20], [60, 30], [75, 60], [85, 100]], [[30, 40], [45, 55], [60, 80], [70, 100]]],
    gpu: [[[40, 30], [65, 40], [78, 70], [87, 100]], [[30, 40], [50, 60], [65, 85], [75, 100]]],
    case: [[[35, 25], [60, 35], [75, 60], [85, 100]], [[30, 40], [45, 55], [60, 80], [70, 100]]],
  };
  const LEVELS = 5;
  const simplePts = (g, lv) => SIMPLE[g][0].map((p, i) => [0, 1].map((k) => Math.round(p[k] + (SIMPLE[g][1][i][k] - p[k]) * (lv / (LEVELS - 1)))));
  /** which group a control belongs to: by its places (Advanced), else by its kind and name (the temperature a curve follows says
      nothing: case fans often follow the CPU) */
  function groupOf(c) {
    if (c.id.startsWith("/gpu") || /^Gpu/.test((sensorOf(c.id) || {}).hw_type || "")) return "gpu";
    const places = App.FansStage ? App.FansStage.parse(setup.layout && setup.layout[c.id]) : [];
    if (places.some((p) => p === "cpu" || p === "cpu2" || p === "pump")) return "cpu";
    if (places.length) return "case";
    if (/cpu|pump|aio|pompa/i.test(c.name)) return "cpu";
    return "case";
  }
  function simpleSrc(g) {
    const cpu = primary("cpu"), gpu = primary("gpu");
    if (g === "cpu") return cpu || gpu;
    if (g === "gpu") return gpu || cpu;
    if (cpu && gpu) {
      if (!setup.mixes.some((m) => m.id === "auto")) setup.mixes.push({ id: "auto", name: App.t("fans.mixAuto"), func: "max", inputs: [cpu, gpu] });
      return "mix:auto";
    }
    return cpu || gpu;
  }
  /** "auto" | 0..4 (the dial) | "custom" (set up on the Advanced view) */
  function levelOf(g, members) {
    if (members.every((c) => c.mode === "auto")) return "auto";
    const id = "simple:" + g, cv = curveOf(id);
    if (!cv || !members.every((c) => c.mode === "curve" && c.curve === id)) return "custom";
    for (let lv = 0; lv < LEVELS; lv++) { const p = simplePts(g, lv); if (cv.points && cv.points.length === p.length && cv.points.every((q, i) => q[0] === p[i][0] && q[1] === p[i][1])) return lv; }
    return "custom";
  }
  function setLevel(g, members, lv) {
    if (lv === "auto") { members.forEach((c) => { c.mode = "auto"; }); commit(); return; }
    const id = "simple:" + g;
    let cv = curveOf(id);
    if (!cv) { cv = { id, name: App.t("fans.g." + g), type: "graph", src: simpleSrc(g), points: [], hyst: 2, resp: 3, skip_edges: true }; setup.curves.push(cv); }
    cv.type = "graph"; cv.points = simplePts(g, lv); cv.name = App.t("fans.g." + g);
    if (!cv.src) cv.src = simpleSrc(g);
    members.forEach((c) => { c.curve = id; c.mode = "curve"; });
    commit();
  }

  /** the last few minutes for the Simple view's strip (kept while the app runs): CPU and card temperature, average fan speed */
  const hist5 = { cpu: [], gpu: [], fan: [], at: 0 };
  const FAN_SVG = '<svg viewBox="-12 -12 24 24" aria-hidden="true"><circle r="11" class="ring"/><g class="bl">' + [0, 1, 2, 3, 4, 5, 6].map((i) => `<path transform="rotate(${(i * 360) / 7})" d="M0 -2 L-2.4 -9 Q0.4 -10.4 3.2 -8.4 L1.1 -1.7 Z"/>`).join("") + '</g><circle r="2.2" class="hub"/></svg>';

  /** a board header's own name ("NCT6797D · Fan #2") said the way a person would ("Fan 2"); names the user gave stay */
  const niceName = (c) => { const m = /^(?:\S+ · )?Fan #(\d+)$/.exec(c.name); return m ? App.t("fans.fanN", { n: m[1] }) : c.name; };
  /** since when each fan has read 0 rpm: only a long run of zeros (not one reading) marks a header without a fan */
  const zeroSince = new Map();

  /** the strip on top of the Simple view: one word for how warm the PC is, and the last minutes as a calm chart */
  function simpleHero(members) {
    const word = h("b", { class: "fh-word" }), sub = h("span", { class: "muted fh-sub" }), hint = h("div", { class: "fh-hint", text: App.t("fans.h.auto") });
    const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 600 100"); svg.setAttribute("preserveAspectRatio", "none"); svg.classList.add("fh-chart"); svg.setAttribute("aria-hidden", "true");
    const mk = (tag, cls) => { const e = document.createElementNS(NS, tag); e.setAttribute("class", cls); svg.appendChild(e); return e; };
    const fanArea = mk("path", "fh-fan"), fanLine = mk("polyline", "fh-fanl"), gpuL = mk("polyline", "fh-gpu"), cpuL = mk("polyline", "fh-cpu");
    const hero = h("section", { class: "card2 fhero" },
      h("div", { class: "fh-state" }, h("i", { class: "fh-dot" }), h("div", { class: "fh-txt" }, word, sub)),
      h("div", { class: "fh-graph" }, svg, h("div", { class: "fh-axis mono" }, h("span", { text: App.t("fans.h.ago") }), h("span", { class: "sp" }),
        h("span", { class: "fh-k cpu", text: "CPU" }), h("span", { class: "fh-k gpu", text: "GPU" }), h("span", { class: "fh-k fan", text: App.t("fans.h.fans") }), h("span", { class: "sp" }), h("span", { text: App.t("fans.now") }))),
      hint);
    const upd = () => {
      const cpu = temp(primary("cpu")), gpu = temp(primary("gpu"));
      const fan = members.length ? members.reduce((a, c) => a + pctOf(c), 0) / members.length : 0;
      if (Date.now() - hist5.at > 900) {
        hist5.at = Date.now();
        for (const [k, v] of [["cpu", cpu], ["gpu", gpu], ["fan", fan]]) { if (v != null) hist5[k].push(v); if (hist5[k].length > 300) hist5[k].shift(); }
      }
      const hot = Math.max(cpu ?? 0, gpu ?? 0), w = clamp((hot - 40) / 45, 0, 1);
      hero.style.setProperty("--w", w.toFixed(2));
      word.textContent = App.t(hot >= 78 ? "fans.h.hot" : hot >= 60 ? "fans.h.warm" : "fans.h.cool");
      sub.textContent = [cpu != null && App.t("fans.h.cpu", { t: Math.round(cpu) }), gpu != null && App.t("fans.h.gpu", { t: Math.round(gpu) }), App.t("fans.h.fanAvg", { p: Math.round(fan) })].filter(Boolean).join(" · ");
      // temperatures 20..90 °C and fan speed 0..100 % across the strip; the newest sample sits on the right edge
      // a short history is stretched over the strip (at least a minute wide), so it is never a sliver at the right edge
      const X = (i, n) => 600 - (n - 1 - i) * (600 / Math.max(59, n - 1)), Yt = (v) => 96 - ((clamp(v, 20, 90) - 20) / 70) * 90, Yp = (v) => 96 - (clamp(v, 0, 100) / 100) * 60;
      const pts = (a, Y) => a.map((v, i) => X(i, a.length).toFixed(1) + "," + Y(v).toFixed(1)).join(" ");
      cpuL.setAttribute("points", pts(hist5.cpu, Yt)); gpuL.setAttribute("points", pts(hist5.gpu, Yt));
      const fp = pts(hist5.fan, Yp); fanLine.setAttribute("points", fp);
      fanArea.setAttribute("d", hist5.fan.length > 1 ? `M${X(0, hist5.fan.length)} 100 L${fp.split(" ").join(" L")} L600 100 Z` : "");
      // nothing set yet: the board and the card are in charge, and one line says what the dials are for
      hint.hidden = !members.every((c) => c.mode === "auto");
      // a board header that has read 0 rpm for 15 s has no fan on it: its row fades and says so (a card may sit at 0 rpm on purpose)
      const now = Date.now();
      for (const c of members) {
        const r = rpmOf(c), board = !c.id.startsWith("/gpu");
        if (board && c.fan && r === 0) { if (!zeroSince.has(c.id)) zeroSince.set(c.id, now); } else zeroSince.delete(c.id);
        const empty = zeroSince.has(c.id) && now - zeroSince.get(c.id) > 15000;
        $$(`.fsg-row[data-row="${CSS.escape(c.id)}"]`).forEach((row) => { row.classList.toggle("empty", empty); const rp = row.querySelector("[data-rpm]"); if (!rp) return; if (empty) rp.textContent = App.t("fans.noSpin"); const unit = rp.nextSibling; if (unit && unit.nodeType === 3) unit.nodeValue = empty ? "" : " rpm"; });
      }
      // the little fans turn at their group's speed
      $$(".fsg [data-spin]").forEach((e) => { const g = e.dataset.spin, m = members.filter((c) => groupOf(c) === g), p = m.length ? m.reduce((a, c) => a + pctOf(c), 0) / m.length : 0; e.style.animationDuration = p > 1 ? (4.5 - 3.9 * (p / 100)).toFixed(2) + "s" : "0s"; e.classList.toggle("still", p <= 1); });
    };
    upd.host = hero; liveFns.push(upd); upd();
    return hero;
  }

  function simple() {
    const groups = { cpu: [], gpu: [], case: [] };
    visible().forEach((c) => groups[groupOf(c)].push(c));
    const cards = Object.entries(groups).filter(([, m]) => m.length).map(([g, members]) => {
      const src = simpleSrc(g);
      const word = h("b", { class: "fsg-word" });
      const autoB = h("button", { class: "chip", text: App.t("fans.mode.auto"), title: App.t("fans.autoD") });
      const custom = h("div", { class: "fsg-custom" }, h("span", { class: "muted", text: App.t("fans.customSet") }),
        h("button", { class: "chip", text: App.t("fans.simplify"), title: App.t("fans.simplifyTip"), onClick: () => { setLevel(g, members, 2); paint(); tick(); } }));
      const dial = slider({ min: 0, max: LEVELS - 1, step: 1, value: 2, onInput: (v) => { setLevel(g, members, v); paint(); } });
      const dialRow = h("div", { class: "fsg-dial" }, h("span", { class: "muted", text: App.t("fans.lvQuiet") }), dial, h("span", { class: "muted", text: App.t("fans.lvCool") }));
      autoB.onclick = () => { setLevel(g, members, levelOf(g, members) === "auto" ? 2 : "auto"); paint(); tick(); };
      /** shows the group's state without rebuilding the card */
      function paint() {
        const lv = levelOf(g, members);
        autoB.classList.toggle("on", lv === "auto");
        custom.hidden = lv !== "custom";
        dialRow.hidden = lv === "custom";
        dialRow.classList.toggle("off", lv === "auto");
        word.textContent = lv === "auto" ? App.t("fans.autoShort") : lv === "custom" ? App.t("fans.customShort") : App.t("fans.lv." + lv);
        if (typeof lv === "number") dial.set(lv);
      }
      const rows = members.map((c) => h("div", { class: "fsg-row", "data-row": c.id }, h("span", { "data-dot": c.id, class: "dot" }), h("span", { class: "nm", text: niceName(c), title: c.name }), scan("ctl", c.id, 12), h("span", { class: "mono muted" }, h("span", { "data-rpm": c.id, text: "–" }), " rpm")));
      const card = h("section", { class: "card2 fsg" },
        h("div", { class: "fsg-top" }, (() => { const f = h("span", { class: "fsg-fan", "data-spin": g }); f.innerHTML = FAN_SVG; return f; })(), h("div", { class: "fsg-nm" }, h("b", { text: App.t("fans.g." + g) }), h("span", { class: "muted", text: App.t("fans.gCount", { n: members.length }) })),
          h("span", { class: "sp" }), src ? h("span", { class: "fheat", "data-heat": src, title: sensorName(src) }, h("i", { class: "hd" }), h("b", { class: "mono" }, h("span", { "data-temp": src, text: "–" }), "°")) : null),
        h("div", { class: "fsg-mode" }, word, h("span", { class: "sp" }), autoB),
        dialRow, custom, h("div", { class: "fsg-rows" }, ...rows));
      paint();
      return card;
    });
    bodyEl.append(h("div", { class: "fsimple2" }, simpleHero(visible()), h("div", { class: "fsgrid" }, ...(cards.length ? cards : [h("div", { class: "muted", text: App.t("fans.none") })]))));
    tick();
  }

  /** what fans-adv.js needs */
  const kit = {
    h, slider, scan, graph, numRow, row: (l, v, t) => h("div", { class: "srow", title: t || "" }, h("span", { class: "lb", text: l }), h("div", { class: "fval" }, v)),
    get st() { return st; }, get setup() { return setup; }, power, sel, pref, commit, control, curveOf, sensorName, tempSensors, temp, pctOf, rpmOf, driven, value,
    primary, uid, toast, tick, redraw: () => draw(), pointsOf, interp, hwTag, curveSrc,
  };

  App.Fans = {
    kit,
    render,
    leave() { stop(); clearTimeout(saveT); if (setup) api.invoke("fans_setup_set", { setup }).catch(() => {}); },
  };
})();
