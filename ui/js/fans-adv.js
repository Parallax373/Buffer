"use strict";
/* Fans, Advanced level: one setup, three views of it (a switch in the header, like RGB's 3D / 2D).
   Curves: list | editable curve | inspector.  Wiring: sensors → curves → fans as a graph, the picked chain lights up.
   Case: the case schematic with live history and Curve / Tuning / Placement tabs.
   fans.js owns the data and the live loop; this file only draws (`kit` = its helpers). Design: DESIGN.md. */

(function () {
  const { h } = App;
  const TYPES = ["graph", "linear", "flat", "mix", "sync", "trigger", "auto"];
  const MIXFN = ["max", "min", "avg", "sum", "sub"];
  const SRC_TYPES = ["graph", "linear", "trigger", "auto"];
  let K = null, box = null, stageCtl = null;
  const hist = { cpu: [], gpu: [], fan: [] };
  const t = (k, v) => App.t(k, v);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ───── curve type conversion: keep the shape where there is one ───── */

  function convert(c, type) {
    if (c.type === type) return;
    const old = K.pointsOf(c), src = c.src || K.primary("cpu") || K.primary("gpu"), keep = { id: c.id, name: c.name, hyst: c.hyst || 0, resp: c.resp || 0, skip_edges: c.skip_edges !== false };
    const others = K.setup.curves.filter((x) => x.id !== c.id), ctl = K.setup.controls[0];
    const f = {
      graph: () => ({ src, points: old.length >= 2 ? old.map((p) => p.slice()) : [[40, 30], [55, 45], [70, 70], [85, 100]] }),
      linear: () => ({ src, tmin: old.length ? old[0][0] : 40, tmax: old.length ? old[old.length - 1][0] : 80, pmin: old.length ? old[0][1] : 30, pmax: old.length ? old[old.length - 1][1] : 100 }),
      flat: () => ({ pct: Math.round(K.interp(old, 50) / 5) * 5 || 40 }),
      mix: () => ({ func: "max", curves: others.slice(0, 2).map((x) => x.id) }),
      sync: () => ({ control: ctl ? ctl.id : "", offset: 0, proportional: false }),
      trigger: () => ({ src, idle_t: 40, load_t: 70, idle_pct: 30, load_pct: 80 }),
      auto: () => ({ src, idle_t: 40, load_t: 70, min: 20, max: 100, step: 5, deadband: 6 }),
    }[type]();
    for (const k of Object.keys(c)) delete c[k];
    Object.assign(c, keep, { type }, f);
    K.commit();
  }

  const typeSeg = (c, on) => h("div", { class: "seg", title: t("fans.typeTip") }, TYPES.map((x) => h("button", { class: c.type === x ? "on" : "", text: t("fans.type." + x), onClick: () => { convert(c, x); on(); } })));

  /* ───── inspectors (shared by the three views) ───── */

  const sensorSelect = (c, on) => h("select", { class: "field", "aria-label": t("fans.source"), onChange: (e) => { c.src = e.target.value; K.commit(); on && on(); } },
    [...K.tempSensors().map((s) => [s.id, K.sensorName(s.id)]), ...K.setup.mixes.map((m) => ["mix:" + m.id, m.name])].map(([v, n]) => h("option", { value: v, text: n, selected: c.src === v })));

  function curveFields(c, redraw) {
    const rows = [];
    const num = (label, tip, key, min, max, step, unit) => K.numRow(label, tip, Math.round(c[key]), min, max, step, unit, (v) => { c[key] = v; K.commit(); redraw && redraw(); });
    if (SRC_TYPES.includes(c.type)) rows.push(K.row(t("fans.source"), sensorSelect(c, redraw)));
    if (c.type === "linear") rows.push(num(t("fans.tmin"), "", "tmin", 20, 90, 1, "°"), num(t("fans.tmax"), "", "tmax", 20, 100, 1, "°"), num(t("fans.pmin"), "", "pmin", 0, 100, 5, "%"), num(t("fans.pmax"), "", "pmax", 0, 100, 5, "%"));
    if (c.type === "flat") rows.push(num(t("fans.speed"), "", "pct", 0, 100, 5, "%"));
    if (c.type === "trigger") rows.push(num(t("fans.idleT"), t("fans.idleTip"), "idle_t", 20, 90, 1, "°"), num(t("fans.loadT"), t("fans.loadTip"), "load_t", 30, 100, 1, "°"), num(t("fans.idleP"), "", "idle_pct", 0, 100, 5, "%"), num(t("fans.loadP"), "", "load_pct", 0, 100, 5, "%"));
    if (c.type === "auto") rows.push(num(t("fans.idleT"), t("fans.idleTip"), "idle_t", 20, 90, 1, "°"), num(t("fans.loadT"), t("fans.autoLoadTip"), "load_t", 30, 100, 1, "°"), num(t("fans.minimum"), "", "min", 0, 100, 5, "%"), num(t("fans.pmax"), "", "max", 0, 100, 5, "%"), num(t("fans.step"), t("fans.stepTip"), "step", 1, 20, 1, "%"), num(t("fans.deadband"), t("fans.deadbandTip"), "deadband", 1, 20, 1, "°"));
    if (c.type === "mix") {
      rows.push(K.row(t("fans.function"), App.ui.segc(MIXFN.map((f) => [f, t("fans.fn." + f)]), c.func, (v) => { c.func = v; K.commit(); redraw && redraw(); })));
      rows.push(K.row(t("fans.mixOf"), h("div", { class: "rowflex" }, K.setup.curves.filter((x) => x.id !== c.id && x.type !== "mix").map((x) => h("span", { class: "chip" + (c.curves.includes(x.id) ? " on" : ""), text: x.name,
        onClick: (e) => { const i = c.curves.indexOf(x.id); if (i < 0) c.curves.push(x.id); else c.curves.splice(i, 1); e.target.classList.toggle("on", i < 0); K.commit(); } })))));
    }
    if (c.type === "sync") {
      rows.push(K.row(t("fans.follow"), h("select", { class: "field", onChange: (e) => { c.control = e.target.value; K.commit(); } }, K.setup.controls.map((x) => h("option", { value: x.id, text: x.name, selected: x.id === c.control })))));
      rows.push(K.numRow(t("fans.offset"), t("fans.syncOffsetTip"), Math.round(c.offset), -50, 50, 1, "%", (v) => { c.offset = v; K.commit(); }));
      rows.push(h("div", { class: "trow", onClick: (e) => { c.proportional = !c.proportional; e.currentTarget.querySelector(".toggle").classList.toggle("on", c.proportional); K.commit(); } },
        h("div", null, h("div", { class: "tt", text: t("fans.proportional") })), h("span", { class: "toggle lg" + (c.proportional ? " on" : "") })));
    }
    if (c.type === "graph" || c.type === "linear") {
      rows.push(K.numRow(t("fans.hyst"), t("fans.hystTip"), c.hyst || 0, 0, 10, 1, "°", (v) => { c.hyst = v; K.commit(); }));
      rows.push(K.numRow(t("fans.resp"), t("fans.respTip"), c.resp || 0, 0, 20, 1, " s", (v) => { c.resp = v; K.commit(); }));
      rows.push(h("div", { class: "trow", title: t("fans.edgesTip"), onClick: (e) => { c.skip_edges = !c.skip_edges; e.currentTarget.querySelector(".toggle").classList.toggle("on", c.skip_edges); K.commit(); } },
        h("div", null, h("div", { class: "tt", text: t("fans.edges") })), h("span", { class: "toggle lg" + (c.skip_edges ? " on" : "") })));
    }
    if (c.type === "auto") rows.push(K.numRow(t("fans.resp"), t("fans.respTip"), c.resp || 1, 1, 20, 1, " s", (v) => { c.resp = v; K.commit(); }));
    return rows;
  }

  function controlFields(c, redraw) {
    const tu = (c.tuning ||= { step_up: 100, step_down: 100, start: 0, stop: 0, minimum: 0, offset: 0, avoid: [] });
    const n = (label, tip, key, min, max, step, unit) => K.numRow(label, tip, Math.round(tu[key]), min, max, step, unit, (v) => { tu[key] = v; K.commit(); });
    const zones = h("div", { class: "fzones" });
    const drawZones = () => zones.replaceChildren(...tu.avoid.map((z, i) => h("div", { class: "rowflex" },
      ...[0, 1].map((k) => h("input", { class: "field fznum mono", type: "number", min: 0, max: 100, value: z[k], "aria-label": t("fans.avoid"), onChange: (e) => { z[k] = clamp(+e.target.value || 0, 0, 100); K.commit(); } })),
      h("span", { class: "muted", text: "%" }), h("button", { class: "fico", text: "✕", title: t("fans.remove"), onClick: () => { tu.avoid.splice(i, 1); K.commit(); drawZones(); } }))),
      h("button", { class: "chip", text: "+ " + t("fans.addZone"), onClick: () => { tu.avoid.push([40, 50]); K.commit(); drawZones(); } }));
    drawZones();
    return [
      n(t("fans.minimum"), t("fans.minimumTip"), "minimum", 0, 100, 5, "%"), n(t("fans.offset"), t("fans.offsetTip"), "offset", -20, 20, 1, "%"),
      h("details", { class: "fadvd" }, h("summary", null, App.ui.cap(t("rgb.advanced"))),
        n(t("fans.stepUp"), t("fans.stepUpTip"), "step_up", 1, 100, 1, "%"), n(t("fans.stepDown"), t("fans.stepDownTip"), "step_down", 1, 100, 1, "%"),
        n(t("fans.start"), t("fans.startTip"), "start", 0, 100, 5, "%"), n(t("fans.stop"), t("fans.stopTip"), "stop", 0, 100, 5, "%"),
        K.row(t("fans.avoid"), zones, t("fans.avoidTip"))),
    ];
  }

  const usedBy = (cid) => K.setup.controls.filter((c) => c.curve === cid);

  /** Mix sensors: a small editor under the sensors list */
  function newCurve() {
    const c = { id: K.uid("c"), name: t("fans.newCurveName", { n: K.setup.curves.length + 1 }), type: "graph", src: K.primary("cpu") || K.primary("gpu"), points: [[40, 30], [55, 45], [70, 70], [85, 100]], hyst: 2, resp: 2, skip_edges: true };
    K.setup.curves.push(c); K.sel.curve = c.id; K.commit(); return c;
  }

  /* ───── view A: curves ───── */

  function viewCurves(el) {
    const S = K.setup;
    const list = h("div", { class: "flist" });
    const mid = h("div", { class: "fstack" }), insp = h("div", { class: "fpane fright" });
    const crow = (c) => h("button", { class: "frow" + (c.id === K.sel.curve ? " sel" : ""), "data-c": c.id, onClick: () => pickCurve(c.id) },
      h("span", { class: "dot" }), h("span", { class: "nm", text: c.name }), h("span", { class: "r", text: t("fans.type." + c.type) }));
    const frow = (c) => h("button", { class: "frow" + (c.id === K.sel.ctl ? " sel" : ""), "data-f": c.id, onClick: () => { K.sel.ctl = c.id; if (c.curve) K.sel.curve = c.curve; pickCurve(K.sel.curve); } },
      h("span", { "data-dot": c.id, class: "dot" }), h("span", { class: "nm", text: c.name }), h("span", { class: "r" }, h("span", { "data-pct": c.id, text: "0" }), "%"),
      h("span", { class: "sub" }, K.scan("ctl", c.id, 14), h("span", { class: "sp" }), h("span", { text: (S.curves.find((x) => x.id === c.curve) || {}).name || t("fans.noCurve") })));
    list.append(App.ui.cap(t("fans.curves")), ...S.curves.map(crow),
      h("button", { class: "frow dim", onClick: () => { newCurve(); K.redraw(); } }, h("span"), h("span", { class: "nm", text: "+ " + t("fans.newCurve") }), h("span")),
      App.ui.cap(t("fans.fans")), ...S.controls.filter((c) => !c.hidden).map(frow),
      App.ui.cap(t("fans.sensors")), ...K.tempSensors().filter((s) => /^(Cpu|Gpu)/.test(s.hw_type) || S.curves.some((c) => c.src === s.id)).map((s) =>
        h("div", { class: "frow static" }, h("span", { class: "dot" }), h("span", { class: "nm", text: K.sensorName(s.id) }), h("span", { class: "r" }, h("b", { "data-temp": s.id, text: "–" }), "°C"))));
    const pickCurve = (cid) => {
      K.sel.curve = cid;
      list.querySelectorAll(".frow[data-c]").forEach((r) => r.classList.toggle("sel", r.dataset.c === cid));
      list.querySelectorAll(".frow[data-f]").forEach((r) => r.classList.toggle("sel", r.dataset.f === K.sel.ctl));
      center(); K.tick();
    };
    const center = () => {
      const c = K.curveOf(K.sel.curve);
      if (!c) { mid.replaceChildren(h("div", { class: "muted", text: t("fans.noCurves") })); insp.replaceChildren(); return; }
      const name = h("input", { class: "field fname", value: c.name, maxlength: 40, "aria-label": t("fans.rename"), onChange: (e) => { c.name = e.target.value.trim() || c.name; K.commit(); list.querySelector(`[data-c="${CSS.escape(c.id)}"] .nm`).textContent = c.name; } });
      const gh = h("div", { id: "fgraph" });
      const assign = h("select", { class: "field", "aria-label": t("fans.assign"), onChange: (e) => { const x = K.control(e.target.value); if (x) { x.curve = c.id; x.mode = "curve"; K.commit(); } e.target.value = ""; center(); K.tick(); } },
        h("option", { value: "", text: "+ " + t("fans.assign") }), S.controls.filter((x) => x.curve !== c.id).map((x) => h("option", { value: x.id, text: x.name })));
      const body = c.type === "mix" || c.type === "sync" ? h("div", { class: "card2 fpad" }, ...curveFields(c, center)) : h("div", { class: "card2 fgraphbox" }, gh);
      mid.replaceChildren(h("div", { class: "rowflex" }, name, h("span", { class: "sp" }), h("button", { class: "fico", text: "✕", title: t("fans.deleteCurve"), onClick: () => {
        const idx = S.curves.indexOf(c); S.curves.splice(idx, 1); S.controls.forEach((x) => { if (x.curve === c.id) { x.curve = null; x.mode = "auto"; } }); K.sel.curve = (S.curves[0] || {}).id; K.commit(); K.redraw();
      } })),
        h("div", { class: "rowflex" }, typeSeg(c, center)), body,
        h("div", { class: "rowflex" }, h("span", { class: "cap", text: t("fans.usedBy") }), ...usedBy(c.id).map((x) => h("span", { class: "chip on", text: x.name })), assign),
        ...(c.type === "graph" ? [h("div", { class: "muted fhint", text: t("fans.hint") })] : []));
      if (c.type !== "mix" && c.type !== "sync") K.graph(gh, c.id, { w: 560, h: 360, edit: true });
      const sc = K.control(K.sel.ctl);
      insp.replaceChildren(App.ui.cap(t("fans.curve")), h("div", { class: "ftitle sm", text: c.name }), ...(c.type === "mix" || c.type === "sync" ? [] : curveFields(c, null)),
        ...(sc ? [h("div", null, App.ui.cap(sc.name), ...controlFields(sc))] : []));
    };
    el.append(h("div", { class: "fa-lsi" }, h("div", { class: "fpane fleft" }, list), h("div", { class: "fpane" }, mid), insp));
    center();
  }

  /* ───── view B: wiring ───── */

  function viewWiring(el) {
    const S = K.setup, ctls = S.controls.filter((c) => !c.hidden), HH = 46, GAP = 10;
    const used = new Set(S.curves.map((c) => c.src).filter(Boolean));
    const sens = [...K.tempSensors().filter((s) => used.has(s.id) || s.id === K.primary("cpu") || s.id === K.primary("gpu")).map((s) => s.id), ...S.mixes.map((m) => "mix:" + m.id)];
    const rows = Math.max(sens.length, S.curves.length, ctls.length), tall = rows * (HH + GAP) - GAP, Y = (i) => 22 + i * (HH + GAP) + HH / 2;
    const si = Object.fromEntries(sens.map((s, i) => [s, i])), ci = Object.fromEntries(S.curves.map((c, i) => [c.id, i]));
    const e1 = S.curves.filter((c) => c.src && si[c.src] != null).map((c) => [si[c.src], ci[c.id], "s:" + c.src, "c:" + c.id]);
    const e2 = ctls.filter((c) => c.curve && ci[c.curve] != null).map((c, i) => [ci[c.curve], ctls.indexOf(c), "c:" + c.curve, "f:" + c.id]);
    const svg = (es) => {
      const ns = "http://www.w3.org/2000/svg", s = document.createElementNS(ns, "svg");
      s.setAttribute("class", "wsvg"); s.setAttribute("viewBox", `0 0 70 ${tall + 22}`); s.setAttribute("preserveAspectRatio", "none"); s.setAttribute("height", tall + 22);
      es.forEach(([a, b, na, nb]) => { const p = document.createElementNS(ns, "path"); p.setAttribute("d", `M0 ${Y(a)} C35 ${Y(a)} 35 ${Y(b)} 70 ${Y(b)}`); p.dataset.a = na; p.dataset.b = nb; s.append(p); });
      return s;
    };
    const node = (key, nameText, right, scanEl) => h("button", { class: "fnode", "data-n": key, onClick: () => pick(key) }, h("span", { class: "nm", text: nameText }), scanEl, right);
    const wire = h("div", { class: "fwire" },
      h("div", { class: "fcol" }, App.ui.cap(t("fans.sensors")), ...sens.map((id) => node("s:" + id, K.sensorName(id), h("span", { class: "r" }, h("b", { "data-temp": id, text: "–" }), "°"), null))),
      svg(e1),
      h("div", { class: "fcol" }, App.ui.cap(t("fans.curves")), ...S.curves.map((c) => node("c:" + c.id, c.name, h("span", { class: "r", text: t("fans.type." + c.type) }), null))),
      svg(e2),
      h("div", { class: "fcol" }, App.ui.cap(t("fans.fans")), ...ctls.map((c) => node("f:" + c.id, c.name, h("span", { class: "r" }, h("span", { "data-pct": c.id, text: "0" }), "%"), K.scan("ctl", c.id, 8)))));
    const drawer = h("div", { class: "fdrawer" });
    const chain = (key) => {
      const set = new Set([key]), [k, id] = [key[0], key.slice(2)];
      const addC = (cid) => { set.add("c:" + cid); const c = K.curveOf(cid); if (c && c.src) set.add("s:" + c.src); S.controls.filter((x) => x.curve === cid).forEach((x) => set.add("f:" + x.id)); };
      if (k === "s") S.curves.filter((c) => c.src === id).forEach((c) => addC(c.id)); else if (k === "c") addC(id);
      else { const c = K.control(id); if (c && c.curve) { addC(c.curve); [...set].forEach((n) => n[0] === "f" && n !== key && set.delete(n)); } }
      return set;
    };
    let cur = null;
    const pick = (key) => {
      cur = key;
      const set = chain(key);
      wire.classList.add("focus");
      wire.querySelectorAll(".fnode").forEach((n) => n.classList.toggle("hl", set.has(n.dataset.n)));
      wire.querySelectorAll(".wsvg path").forEach((p) => p.classList.toggle("hl", set.has(p.dataset.a) && set.has(p.dataset.b)));
      const k = key[0], id = key.slice(2);
      if (k === "f") { K.sel.ctl = id; const c = K.control(id); if (c && c.curve) K.sel.curve = c.curve; }
      if (k === "c") K.sel.curve = id;
      drawerFill(k, id);
      K.tick();
    };
    const drawerFill = (k, id) => {
      if (k === "c") {
        const c = K.curveOf(id), gh = h("div", { id: "fgraph" });
        drawer.replaceChildren(h("div", { class: "fstack" }, App.ui.cap(t("fans.curve")), h("div", { class: "ftitle sm", text: c.name }), typeSeg(c, () => drawerFill(k, id)), ...curveFields(c, null)),
          h("div", { class: "card2 fgraphbox" }, c.type === "mix" || c.type === "sync" ? h("div", { class: "muted", text: "" }) : gh), h("div"));
        if (c.type !== "mix" && c.type !== "sync") K.graph(gh, id, { w: 420, h: 200, edit: true, compact: true });
      } else if (k === "f") {
        const c = K.control(id);
        drawer.replaceChildren(h("div", { class: "fstack" }, App.ui.cap(t("fans.fan")), h("div", { class: "ftitle sm", text: c.name }),
          h("div", { class: "rowflex" }, h("select", { class: "field", "aria-label": t("fans.curve"), onChange: (e) => { c.curve = e.target.value || null; c.mode = c.curve ? "curve" : "auto"; K.commit(); K.redraw(); } },
            h("option", { value: "", text: t("fans.noCurve"), selected: !c.curve }), S.curves.map((x) => h("option", { value: x.id, text: x.name, selected: x.id === c.curve }))))), h("div", null, ...controlFields(c)), h("div"));
      } else {
        const m = S.mixes.find((x) => "mix:" + x.id === id), s = K.tempSensors().find((x) => x.id === id);
        drawer.replaceChildren(h("div", { class: "fstack" }, App.ui.cap(t("fans.sensor")), h("div", { class: "ftitle sm", text: K.sensorName(id) }),
          m ? h("div", null, K.row(t("fans.function"), App.ui.segc(MIXFN.map((f) => [f, t("fans.fn." + f)]), m.func, (v) => { m.func = v; K.commit(); })),
            K.row(t("fans.mixOf"), h("div", { class: "rowflex" }, K.tempSensors().map((x) => h("span", { class: "chip" + (m.inputs.includes(x.id) ? " on" : ""), text: K.sensorName(x.id),
              onClick: (e) => { const i = m.inputs.indexOf(x.id); if (i < 0) m.inputs.push(x.id); else m.inputs.splice(i, 1); e.target.classList.toggle("on", i < 0); K.commit(); } }))))) : h("div", { class: "muted", text: s ? s.hw : "" })), h("div"), h("div"));
      }
    };
    el.append(h("div", { class: "fwiring" }, h("div", { class: "fpane" }, wire), drawer));
    pick(K.sel.ctl && K.control(K.sel.ctl) ? "f:" + K.sel.ctl : S.curves.length ? "c:" + S.curves[0].id : sens.length ? "s:" + sens[0] : null);
  }

  /* ───── view C: the panel (controls first, like FanControl's cards, with the case and the curve beside them) ───── */

  /** a control's fans in words: "3 × Front" */
  function placesText(ids, slots) {
    if (!ids || !ids.length) return t("fans.unplaced");
    const s = slots.find((x) => x.id === ids[0]);
    const name = s ? App.FansStage.slotLabel(s).replace(/\s*\d+$/, "") : ids[0];
    return ids.length > 1 ? `${ids.length} × ${name}` : (s ? App.FansStage.slotLabel(s) : name);
  }
  /** a small side view of the case with this control's fans lit (the template's real places) */
  function miniCase(ids, slots) {
    const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 64 56"); svg.setAttribute("width", "64"); svg.setAttribute("height", "56"); svg.setAttribute("aria-hidden", "true"); svg.classList.add("fmini");
    const el = (tag, a) => { const e = document.createElementNS(NS, tag); for (const k in a) e.setAttribute(k, a[k]); svg.appendChild(e); return e; };
    el("rect", { x: 2, y: 2, width: 60, height: 52, rx: 4, class: "mc-case" });
    if (!slots.length) return svg;
    const sd = slots.sideT, X = (z) => 6 + ((z - sd.z0) / (sd.z1 - sd.z0)) * 52, Y = (y) => 51 - (y / sd.h) * 46;
    const on = new Set(ids || []);
    for (const s of slots) {
      if (s.id === "pump" || (s.extra && !on.has(s.id))) continue;
      el("circle", { cx: X(s.tp[2]).toFixed(1), cy: Y(s.tp[1]).toFixed(1), r: s.gpuFan ? 2.6 : 3.2, class: on.has(s.id) ? "mc-on" : "mc-off" });
    }
    return svg;
  }
  /** a curve's shape as a small line (graph and linear curves; the others show their type) */
  function miniCurve(c) {
    const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 120 40"); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("aria-hidden", "true"); svg.classList.add("fminicurve");
    const pts = (c.type === "graph" || c.type === "linear") ? K.pointsOf(c) : c.type === "flat" ? [[30, c.pct], [90, c.pct]] : null;
    if (pts && pts.length) {
      const full = [[30, pts[0][1]], ...pts, [90, pts[pts.length - 1][1]]];
      const pl = document.createElementNS(NS, "polyline");
      pl.setAttribute("points", full.map(([tt, p]) => `${(clamp(tt, 30, 90) - 30) * 2},${(38 - p * 0.36).toFixed(1)}`).join(" "));
      svg.appendChild(pl);
    }
    return svg;
  }

  function viewPanel(el) {
    const S = K.setup;
    let tabId = "curve";
    const cards = h("div", { class: "fp-cards" }), curvesEl = h("div", { class: "fp-curves" }), tab = h("div", { class: "fp-tab" });
    const stageHost = h("div", { class: "fcase2" }), title = h("div", { class: "ftitle" });
    const tabs = App.ui.segc([["curve", t("fans.curve")], ["tune", t("fans.tabTune")], ["place", t("fans.tabPlace")], ["hist", t("fans.history")]], tabId, (v) => show(K.sel.ctl, v));
    const stage = App.FansStage.mount(stageHost, K, {
      onPick: (id) => show(id),
      // a click on a place: on the Placement tab it adds that place to the picked control or takes it away; elsewhere it picks
      onSlot: (slot, owner) => { if (tabId === "place" && K.sel.ctl) toggleSlot(K.sel.ctl, slot); else if (owner) show(owner); },
      onReady: () => { refreshCards(); if (K.control(K.sel.ctl)) show(K.sel.ctl, tabId); },
    });
    stageCtl = stage;

    /* the heat strip: every temperature a curve can follow, warm ones glowing; the room; the fail-safe speed */
    const temps = [["cpu", "CPU", K.primary("cpu")], ["gpu", "GPU", K.primary("gpu")], ...S.mixes.map((m) => ["mix", m.name, "mix:" + m.id])].filter((x) => x[2]);
    const heat = h("div", { class: "fp-heat" }, temps.map(([, name, id]) => h("span", { class: "fheat", "data-heat": id, title: K.sensorName(id) },
      h("i", { class: "hd" }), h("span", { class: "cap", text: name }), h("b", { class: "mono" }, h("span", { "data-temp": id, text: "–" }), "°"), K.scan("temp", id, 10))),
      h("span", { class: "sp" }),
      h("label", { class: "fsafe", title: t("fans.failsafeTip") }, h("span", { class: "muted", text: t("fans.failsafe2") }),
        h("select", { class: "field", onChange: (e) => { S.failsafe = +e.target.value; K.commit(); } }, [100, 90, 80, 70, 60].map((v) => h("option", { value: v, text: v + " %", selected: Math.round(S.failsafe ?? 100) === v })))),
      h("button", { class: "btn", text: t("fans.caseInRgb"), title: t("fans.caseInRgbTip"), onClick: () => { App.RGBAdv.openCase(); App.go("rgb"); setTimeout(() => App.RGB && App.RGB.view("advanced"), 0); } }),
      h("button", { class: "btn acc", text: t("fans.wiz.open"), title: t("fans.wiz.tip"), onClick: () => App.FansWizard.open(K, () => K.redraw()) }));

    /* control cards: click picks (in place, no rebuild), the select picks the curve, drag reorders */
    const cardOf = (c) => {
      const sel = h("select", { class: "field", "aria-label": t("fans.curve"), onClick: (e) => e.stopPropagation(), onChange: (e) => {
        const v = e.target.value;
        if (v === "auto") { c.mode = "auto"; } else if (v === "manual") { c.mode = "manual"; } else { c.curve = v; c.mode = "curve"; }
        K.commit(); refreshCurves(); if (c.id === K.sel.ctl) show(c.id, tabId);
      } }, h("option", { value: "auto", text: t("fans.mode.auto"), selected: c.mode === "auto" }), h("option", { value: "manual", text: t("fans.mode.manual"), selected: c.mode === "manual" }),
        S.curves.map((x) => h("option", { value: x.id, text: x.name, selected: c.mode === "curve" && c.curve === x.id })));
      const card = h("div", { class: "fcard" + (c.id === K.sel.ctl ? " sel" : ""), "data-card": c.id, tabindex: 0, role: "button", "aria-label": c.name,
        onClick: () => show(c.id), onKeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); show(c.id); } } },
        h("div", { class: "fc-top" }, h("span", { class: "fc-mini" }), h("div", { class: "fc-nm" }, h("b", { text: c.name }), h("span", { class: "mono muted fc-where" })), h("span", { "data-dot": c.id, class: "dot" })),
        sel,
        h("div", { class: "fc-val" }, h("span", { class: "mono big" }, h("span", { "data-pct": c.id, text: "0" }), h("small", { text: "%" })), h("span", { class: "sp" }), h("span", { class: "mono muted" }, h("span", { "data-rpm": c.id, text: "–" }), " rpm")),
        K.scan("ctl", c.id, 18));
      // reordering by dragging (pointer events: the window's file drop handling swallows HTML drag and drop)
      card.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest("select")) return;
        const x0 = e.clientX, y0 = e.clientY;
        let moving = false;
        const move = (ev) => {
          if (!moving && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
          if (!moving) { moving = true; card.classList.add("drag"); }
          const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("[data-card]");
          if (!over || over === card || over.parentNode !== cards) return;
          const r = over.getBoundingClientRect(), after = ev.clientX > r.left + r.width / 2;
          cards.insertBefore(card, after ? over.nextSibling : over);   // moved, not redrawn
        };
        const up = () => {
          window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up);
          if (!moving) return;
          card.classList.remove("drag");
          card.addEventListener("click", (ev) => ev.stopImmediatePropagation(), { capture: true, once: true });   // the drop is not a click
          const order = [...cards.querySelectorAll("[data-card]")].map((x) => x.dataset.card);
          S.controls.sort((p, q) => { const i = order.indexOf(p.id), j = order.indexOf(q.id); return (i < 0 ? 1e9 : i) - (j < 0 ? 1e9 : j); });
          K.commit();
        };
        // on the window: moving the card in the page would drop a pointer capture
        window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
      });
      return card;
    };
    const visibleCtl = () => S.controls.filter((c) => !c.hidden);
    cards.append(...visibleCtl().map(cardOf));
    function refreshCards() {
      const lay = stage.layout, slots = stage.slots;
      cards.querySelectorAll("[data-card]").forEach((card) => {
        const id = card.dataset.card, c = K.control(id); if (!c) return;
        card.querySelector(".fc-mini").replaceChildren(miniCase(lay[id], slots));
        card.querySelector(".fc-where").textContent = placesText(lay[id], slots);
      });
    }

    /* curve cards: what they follow, how warm it is, their shape; a click opens the curve on the right */
    function refreshCurves() {
      curvesEl.replaceChildren(...S.curves.map((cv) => {
        const n = S.controls.filter((x) => x.mode === "curve" && x.curve === cv.id).length;
        return h("button", { class: "fcurve" + (cv.id === K.sel.curve ? " sel" : ""), "data-cv": cv.id, onClick: () => { K.sel.curve = cv.id; markCurve(); tabId = "curve"; showCurve(); syncTabs(); } },
          h("span", { class: "fcv-top" }, h("b", { text: cv.name }), h("span", { class: "sp" }), h("span", { class: "mono muted", text: n ? t("fans.drives", { n }) : "" })),
          cv.src ? h("span", { class: "mono fcv-src" }, K.sensorName(cv.src) + " ", h("span", { "data-temp": cv.src, text: "–" }), "°") : h("span", { class: "mono muted fcv-src", text: t("fans.type." + cv.type) }),
          miniCurve(cv));
      }), h("button", { class: "fcurve add", onClick: () => { newCurve(); K.redraw(); } }, h("span", { text: "+ " + t("fans.newCurve") })));
    }
    const markCurve = () => curvesEl.querySelectorAll("[data-cv]").forEach((b) => b.classList.toggle("sel", b.dataset.cv === K.sel.curve));
    refreshCurves();

    /* the right side: the case, then the picked control's curve / tuning / places / history */
    function syncTabs() { tabs.querySelectorAll("button").forEach((b, i) => b.classList.toggle("on", ["curve", "tune", "place", "hist"][i] === tabId)); }
    function showCurve() {
      const cv = K.curveOf(K.sel.curve), gh = h("div", { id: "fgraph" });
      if (!cv) { tab.replaceChildren(h("div", { class: "card2 fpad muted", text: t("fans.noCurve") })); return; }
      tab.replaceChildren(h("div", { class: "card2 fgraphbox" }, h("div", { class: "rowflex" }, h("span", { class: "cap", text: cv.name }), typeSeg(cv, () => { showCurve(); refreshCurves(); })), gh),
        h("div", { class: "card2 fpad" }, ...curveFields(cv, () => { showCurve(); refreshCurves(); })));
      if (cv.type !== "mix" && cv.type !== "sync") K.graph(gh, cv.id, { w: 560, h: 240, edit: true });
    }
    function placeTab(c) {
      const ids = stage.layout[c.id] || [], FS = App.FansStage;
      const rows = ids.map((sid) => {
        const s = stage.slots.find((x) => x.id === sid); if (!s) return null;
        const fl = stage.flowOf(s);
        return h("div", { class: "srow" }, h("span", { class: "lb", text: FS.slotLabel(s) }),
          fl === "in" || fl === "out"
            ? App.ui.segc([["in", t("fans.flowIn")], ["out", t("fans.flowOut")]], fl, (v) => { (S.flow ||= {})[sid] = v; K.commit(); stage.relayout(); })
            : h("span", { class: "muted", text: t(fl === "int" ? "fans.flowInt" : "fans.flowNone") }),
          h("button", { class: "chip", text: "✕", title: t("fans.placeDel"), onClick: () => toggleSlot(c.id, sid) }));
      }).filter(Boolean);
      return h("div", { class: "card2 fpad fstack" }, h("div", { class: "muted fhint", text: t("fans.placeHint") }), ...rows,
        K.row(t("fans.pair"), h("div", { class: "mono muted", text: c.fan ? K.sensorName(c.fan) : t("fans.unpaired") })));
    }
    /** adds a place to a control's fans or takes it away (a place belongs to one control: another one gives it up) */
    function toggleSlot(id, slot) {
      const FS = App.FansStage, cur = new Map(Object.entries(stage.layout));
      for (const [cid, list] of cur) if (cid !== id && list.includes(slot)) S.layout[cid] = list.filter((x) => x !== slot).join(",");
      const mine = (cur.get(id) || []).slice(), i = mine.indexOf(slot);
      if (i >= 0) mine.splice(i, 1); else mine.push(slot);
      S.layout[id] = mine.join(",");
      // controls that only had a guessed place keep it as their choice, so taking a place away does not move them about
      for (const [cid, list] of cur) if (!(cid in S.layout)) S.layout[cid] = list.join(",");
      K.commit(); stage.relayout(); refreshCards();
      if (id === K.sel.ctl && tabId === "place") tab.replaceChildren(placeTab(K.control(id)));
      void FS;
    }
    const show = (id, which = tabId) => {
      const c = K.control(id); if (!c) return;
      K.sel.ctl = id; tabId = which; if (c.curve && which !== "curve") K.sel.curve = c.curve; else if (c.curve && which === "curve" && K.sel.curve !== c.curve) K.sel.curve = c.curve;
      stage.select(id); stage.setEditing(which === "place"); markCurve(); syncTabs();
      cards.querySelectorAll("[data-card]").forEach((x) => x.classList.toggle("sel", x.dataset.card === id));
      title.textContent = c.name; hist.fan.length = 0;
      if (which === "curve") showCurve();
      else if (which === "tune") tab.replaceChildren(h("div", { class: "card2 fpad" }, ...controlFields(c)));
      else if (which === "place") tab.replaceChildren(placeTab(c));
      else { const hh = h("div", { class: "card2 fpad" }, h("div", { class: "rowflex" }, h("span", { class: "cap", text: t("fans.history") }), h("span", { class: "sp" }), h("span", { class: "chip", text: "CPU" }), h("span", { class: "chip", text: "GPU" }), h("span", { class: "chip on", text: t("fans.thisFan") })), h("div", { "data-hist": 1 })); tab.replaceChildren(hh); }
      K.tick();
    };

    el.append(h("div", { class: "fpanel" }, heat,
      h("div", { class: "fp-main" },
        h("div", { class: "fp-left" },
          h("div", { class: "rowflex" }, App.ui.cap(t("fans.controls")), h("span", { class: "sp" }), h("span", { class: "mono muted", text: t("fans.dragTip") })), cards,
          App.ui.cap(t("fans.curves")), curvesEl),
        h("div", { class: "fp-right" }, stageHost, h("div", { class: "rowflex" }, h("div", { style: { flex: 1, minWidth: 0 } }, App.ui.cap(t("fans.fan")), title), tabs), tab))));
    show(K.control(K.sel.ctl) && !K.control(K.sel.ctl).hidden ? K.sel.ctl : (visibleCtl()[0] || {}).id, "curve");
  }

  /* ───── live bits of the Case view ───── */

  function drawHist(host) {
    const w = 520, hh = 150, L = 30, B = 18, n = 60, X = (i) => L + (i / (n - 1)) * (w - L - 8), Yt = (v) => 8 + (1 - (v - 30) / 60) * (hh - B - 8), Yp = (p) => 8 + (1 - p / 100) * (hh - B - 8);
    const path = (a, Y) => a.map((v, i) => (i ? "L" : "M") + X(i + n - a.length).toFixed(1) + " " + Y(v).toFixed(1)).join(" ");
    host.innerHTML = `<svg class="hist" viewBox="0 0 ${w} ${hh}" role="img" aria-label="${t("fans.history")}">${[40, 60, 80].map((v) => `<line class="gl" x1="${L}" x2="${w - 8}" y1="${Yt(v)}" y2="${Yt(v)}"/><text x="${L - 5}" y="${Yt(v) + 3}" text-anchor="end">${v}°</text>`).join("")}
      <path class="h2" d="${path(hist.gpu, Yt)}"/><path class="h1" d="${path(hist.cpu, Yt)}"/><path class="h0" d="${path(hist.fan, Yp)}"/><text x="${L}" y="${hh - 4}">${t("fans.older")}</text><text x="${w - 8}" y="${hh - 4}" text-anchor="end">${t("fans.now")}</text></svg>`;
  }

  function tick() {
    if (!K || !box || !box.isConnected) return;
    const cpu = K.temp(K.primary("cpu")), gpu = K.temp(K.primary("gpu")), c = K.control(K.sel.ctl);
    hist.cpu.push(cpu == null ? 30 : cpu); hist.gpu.push(gpu == null ? 30 : gpu); hist.fan.push(c ? K.pctOf(c) : 0);
    Object.values(hist).forEach((a) => a.length > 60 && a.shift());
    box.querySelectorAll("[data-hist]").forEach(drawHist);
    // the heat strip glows with the temperature (35 °C cold, 85 °C fully lit)
    box.querySelectorAll(".fheat[data-heat]").forEach((e) => { const v = K.temp(e.dataset.heat); e.style.setProperty("--w", v == null ? 0 : clamp((v - 35) / 50, 0, 1).toFixed(2)); });
  }

  function render(el, kit) {
    K = kit; box = el;
    if (stageCtl) { stageCtl.destroy(); stageCtl = null; }
    let v = K.pref().adv || "panel";
    if (v === "case") v = K.pref().adv = "panel";   // the Case view became the panel
    el.append(h("div", { class: "fadvhead" }, App.ui.segc([["panel", t("fans.panel")], ["curves", t("fans.curves")], ["wiring", t("fans.wiring")]], v, (x) => { K.pref().adv = x; App.persist(); K.redraw(); })));
    ({ panel: viewPanel, curves: viewCurves, wiring: viewWiring }[v] || viewPanel)(el);
  }

  App.FansAdv = { render, tick, bind: (kit) => { K = kit; } };
})();
