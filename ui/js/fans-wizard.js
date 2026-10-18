"use strict";
/* Fans: "Assign fans", the setup wizard of the Advanced panel. The case comes from the RGB page (one case for lights and
   fans; it is changed there). Then, for every visible control, the user can stop its fan for 30 s (`fans_boost` at 0 %: the recorder ends
   it by itself after a few seconds unless the wizard renews it, so closing the window mid-step leaves nothing stopped) and
   clicks the places in the case where a fan stopped: one control can drive several fans (a splitter or a hub).
   Nothing is saved until the last step. A control without a speed sensor is found by eye; a fan program that is running
   (FanControl and co) blocks the spinning, so the wizard says so first. */

(function () {
  const { h, api } = App;
  const t = (k, v) => App.t(k, v);

  /** `bg` = the page's own picture behind the dialog: it stands still (and says so) while the wizard is open */
  function open(K, onDone, bg) {
    // the page may load a fresh copy of the setup while this is open: always write into the current one (K.setup)
    const FS = App.FansStage;
    const list = K.setup.controls.filter((c) => !c.hidden);
    let i = -1, stage = null, errEl = null, saved = false;
    const orig = JSON.parse(JSON.stringify({ layout: K.setup.layout || {}, flow: K.setup.flow || {} }));   // put back when the wizard is cancelled
    const picks = new Map();          // control id -> Set of place ids
    const host = h("div", { class: "fcase2" }), body = h("div", { class: "fstack fwiz-body" });
    const ov = h("div", { class: "fov" }, h("div", { class: "card2 fpad fdlg fwiz", role: "dialog", "aria-label": t("fans.wiz.title") }, h("div", { class: "fwiz-stage" }, host), body));

    const stop = () => { clearInterval(holdT); holdT = 0; api.invoke("fans_boost", { id: null }).catch(() => {}); };
    const close = () => {
      stop();
      if (bg) bg.setHold(false);
      if (!saved) { K.setup.layout = orig.layout; K.setup.flow = orig.flow; if (stage) stage.relayout(); }
      if (stage) stage.destroy();
      ov.remove();
    };
    /** the choices made so far show in the case at once (earlier controls stay visible), but only the last step saves them */
    const pushLayout = () => { for (const [id, set] of picks) K.setup.layout[id] = [...set].join(","); if (stage) stage.relayout(); };
    const cur = () => list[i];
    let holdT = 0, ui = null;
    const HOLD_S = 30;
    /** the fan runs on its own curve again (the wizard never raises it) */
    function normal() {
      clearInterval(holdT); holdT = 0;
      api.invoke("fans_boost", { id: null }).catch(() => {});
      if (ui) { ui.bar.style.transition = "none"; ui.bar.style.width = "0"; ui.label.textContent = t("fans.wiz.hold"); ui.state.textContent = t("fans.wiz.spinning"); }
    }
    /** Other fans turn too, so this one stands still for HOLD_S seconds and the user sees which it is. The helper only accepts 15 s at a time,
     *  so it is renewed every 5 s; closing the window therefore ends the stop within seconds. The button fills as the time runs out. */
    function hold(c) {
      if (holdT) { normal(); return; }
      let left = HOLD_S;
      const zero = () => api.invoke("fans_boost", { id: c.id, pct: 0, secs: 8 }).then(() => { if (errEl) errEl.textContent = ""; }, (e) => { if (errEl) errEl.textContent = t("fans.wiz.cannot", { err: String(e) }); });
      const show = () => { ui.label.textContent = t("fans.wiz.holdLeft", { n: left }); };
      zero(); show(); ui.state.textContent = t("fans.wiz.stopped");
      ui.bar.style.transition = "none"; ui.bar.style.width = "0"; void ui.bar.offsetWidth;
      ui.bar.style.transition = "width " + HOLD_S + "s linear"; ui.bar.style.width = "100%";
      holdT = setInterval(() => { if (--left <= 0) normal(); else { if (left % 5 === 0) zero(); show(); } }, 1000);
    }
    /** a place belongs to one control: picking it here takes it from another */
    function toggle(slot) {
      const c = cur(); if (!c) return;
      for (const [id, set] of picks) if (id !== c.id) set.delete(slot);
      const set = picks.get(c.id) || new Set(); picks.set(c.id, set);
      if (set.has(slot)) set.delete(slot); else set.add(slot);
      stage.setAssign({ slots: [...set], boost: null }); pushLayout(); stepList();
    }
    let chips = null, dirs = null;
    function stepList() {
      stage.setMark(null);   // the rows below are rebuilt, so a hover ring would never be taken back
      const set = picks.get(cur().id) || new Set();
      // which way the air goes at each chosen place: the fan may be mounted the other way round than the case assumes
      dirs.replaceChildren(...[...set].map((sid) => stage.slots.find((x) => x.id === sid)).filter((s) => s && s.id !== "pump" && !s.gpuFan).map((s) =>
        h("div", { class: "rowflex", onMouseenter: () => stage.setMark(s.id), onMouseleave: () => stage.setMark(null) }, h("span", { class: "muted", text: FS.slotLabel(s) }), h("span", { class: "sp" }),
          App.ui.segc([["in", t("fans.flowIn")], ["out", t("fans.flowOut")]], stage.flowOf(s), (v) => { (K.setup.flow ||= {})[s.id] = v; stage.relayout(); stepList(); }))));
      chips.replaceChildren(...(set.size ? [...set].map((sid) => { const s = stage.slots.find((x) => x.id === sid); return h("button", { class: "chip on", text: (s ? FS.slotLabel(s) : sid) + "  ✕", onClick: () => toggle(sid), onMouseenter: () => stage.setMark(sid), onMouseleave: () => stage.setMark(null) }); }) : [h("span", { class: "muted", text: t("fans.wiz.none") })]));
    }

    function intro() {
      i = -1; stop(); ui = null; if (stage) stage.setAssign(null);
      const st = K.st, all = (st.conflicts || []).find((c) => !c.gpu_only), gpu = (st.conflicts || []).find((c) => c.gpu_only);
      body.replaceChildren(...[App.ui.cap(t("fans.wiz.title")), h("div", { class: "ftitle sm", text: t("fans.wiz.intro") }),
        h("div", { class: "muted fhint", text: t("fans.wiz.how") }),
        !st.connected ? h("div", { class: "fwarn", text: t("fans.wiz.noHelper") }) : null,
        all ? h("div", { class: "fwarn", text: t("fans.wiz.blocked", { name: all.name }) }) : gpu ? h("div", { class: "fwarn", text: t("fans.wiz.blockedGpu", { name: gpu.name }) }) : null,
        h("div", { class: "rowflex" }, h("span", { class: "muted", text: t("fans.wiz.case") }), h("button", { class: "btn", text: t("fans.caseInRgb"), onClick: () => { close(); App.RGBAdv.openCase(); App.go("rgb"); setTimeout(() => App.RGB && App.RGB.view("advanced"), 0); } })),
        h("div", { class: "rowflex" }, h("span", { class: "sp" }), h("button", { class: "btn ghost", text: t("common.cancel"), onClick: close }),
          h("button", { class: "btn acc", text: t("fans.wiz.start", { n: list.length }), disabled: !list.length || !!all || !st.connected, onClick: () => step(0) }))].filter(Boolean));
    }
    function step(n) {
      i = n;
      if (i >= list.length) return summary();
      const c = cur();
      if (!picks.has(c.id)) picks.set(c.id, new Set());
      stage.setAssign({ slots: [...picks.get(c.id)], boost: null });
      errEl = h("div", { class: "fwarn" });
      chips = h("div", { class: "rowflex" });
      dirs = h("div", { class: "fstack" });
      const state = h("span", { text: t("fans.wiz.spinning") }), bar = h("i"), label = h("span", { text: t("fans.wiz.hold") });
      const holdBtn = h("button", { class: "btn holdbtn", onClick: () => hold(c) }, bar, label);
      ui = { bar, label, state };
      body.replaceChildren(App.ui.cap(t("fans.wiz.step", { n: i + 1, total: list.length })),
        h("div", { class: "ftitle" }, c.name),
        h("div", { class: "rowflex mono" }, h("span", { class: "fwiz-spin" }), state, h("span", { class: "sp" }), c.fan ? h("span", null, h("span", { "data-rpm": c.id, text: "–" }), " rpm") : h("span", { class: "muted", text: t("fans.wiz.noRpm") })),
        h("div", { class: "muted fhint", text: t("fans.wiz.click") }),
        holdBtn,
        chips, dirs, errEl,
        h("div", { class: "rowflex" }, h("button", { class: "btn ghost", text: t("fans.wiz.back"), onClick: () => (i ? step(i - 1) : intro()) }), h("span", { class: "sp" }),
          h("button", { class: "btn", text: t("fans.wiz.skip"), onClick: () => { picks.delete(c.id); pushLayout(); step(i + 1); } }),
          h("button", { class: "btn acc", text: t(i + 1 < list.length ? "fans.wiz.next" : "fans.wiz.finish"), onClick: () => step(i + 1) })));
      stepList(); normal(); K.tick();
    }
    function summary() {
      stop(); ui = null; stage.setAssign(null);
      const rows = list.map((c) => { const set = picks.get(c.id); return h("div", { class: "srow" }, h("span", { class: "lb", text: c.name }), h("span", { class: "mono muted", text: set ? (set.size ? [...set].map((sid) => { const s = stage.slots.find((x) => x.id === sid); return s ? FS.slotLabel(s) : sid; }).join(", ") : t("fans.unplaced")) : t("fans.wiz.kept") })); });
      body.replaceChildren(App.ui.cap(t("fans.wiz.doneCap")), h("div", { class: "ftitle sm", text: t("fans.wiz.done") }), ...rows,
        h("div", { class: "rowflex" }, h("button", { class: "btn ghost", text: t("fans.wiz.back"), onClick: () => step(list.length - 1) }), h("span", { class: "sp" }),
          h("button", { class: "btn acc", text: t("fans.wiz.save"), onClick: () => {
            for (const [id, set] of picks) K.setup.layout[id] = [...set].join(",");
            saved = true; K.commit(); close(); App.toast(t("fans.wiz.saved"), "ok"); if (onDone) onDone();
          } })));
    }

    stage = FS.mount(host, K, {
      compact: true, editing: true,
      onSlot: (slot) => { if (i >= 0) toggle(slot); },
      onReady: () => { const lay = stage.layout; for (const c of list) if (lay[c.id]) picks.set(c.id, new Set(lay[c.id])); },
    });
    if (bg) bg.setHold(true);   // the picture behind stands still while fans are being found; it says so in the middle
    (document.querySelector("#v-fans .fans") || document.body).append(ov);
    intro();
  }

  App.FansWizard = { open };
})();
