"use strict";
/* Fans: "Assign fans", the setup wizard of the Advanced panel. The case comes from the RGB page (one case for lights and
   fans; it is changed there). Then every visible control in turn is spun up for a moment (`fans_boost`: the recorder ends
   it by itself after a few seconds unless the wizard renews it, so closing the window mid-step leaves nothing loud) and
   the user clicks the places in the case where a fan is turning: one control can drive several fans (a splitter or a hub).
   Nothing is saved until the last step. A control without a speed sensor is found by eye; a fan program that is running
   (FanControl and co) blocks the spinning, so the wizard says so first. */

(function () {
  const { h, api } = App;
  const t = (k, v) => App.t(k, v);

  function open(K, onDone) {
    // the page may load a fresh copy of the setup while this is open: always write into the current one (K.setup)
    const FS = App.FansStage;
    const list = K.setup.controls.filter((c) => !c.hidden);
    let i = -1, boostT = 0, stage = null, errEl = null;
    const picks = new Map();          // control id -> Set of place ids
    const host = h("div", { class: "fcase2" }), body = h("div", { class: "fstack fwiz-body" });
    const ov = h("div", { class: "fov" }, h("div", { class: "card2 fpad fdlg fwiz", role: "dialog", "aria-label": t("fans.wiz.title") }, h("div", { class: "fwiz-stage" }, host), body));

    const stop = () => { clearInterval(boostT); boostT = 0; api.invoke("fans_boost", { id: null }).catch(() => {}); };
    const close = () => { stop(); if (stage) stage.destroy(); ov.remove(); };
    const cur = () => list[i];
    function boost(c) {
      clearInterval(boostT);
      const go = () => api.invoke("fans_boost", { id: c.id, pct: 100, secs: 6 }).then(() => { if (errEl) errEl.textContent = ""; }, (e) => { if (errEl) errEl.textContent = t("fans.wiz.cannot", { err: String(e) }); });
      go(); boostT = setInterval(go, 4000);
    }
    /** a place belongs to one control: picking it here takes it from another */
    function toggle(slot) {
      const c = cur(); if (!c) return;
      for (const [id, set] of picks) if (id !== c.id) set.delete(slot);
      const set = picks.get(c.id) || new Set(); picks.set(c.id, set);
      if (set.has(slot)) set.delete(slot); else set.add(slot);
      stage.setAssign({ slots: [...set], boost: c.id }); stepList();
    }
    let chips = null;
    function stepList() {
      const set = picks.get(cur().id) || new Set();
      chips.replaceChildren(...(set.size ? [...set].map((sid) => { const s = stage.slots.find((x) => x.id === sid); return h("button", { class: "chip on", text: (s ? FS.slotLabel(s) : sid) + "  ✕", onClick: () => toggle(sid) }); }) : [h("span", { class: "muted", text: t("fans.wiz.none") })]));
    }

    function intro() {
      i = -1; stop(); if (stage) stage.setAssign(null);
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
      stage.setAssign({ slots: [...picks.get(c.id)], boost: c.id });
      errEl = h("div", { class: "fwarn" });
      chips = h("div", { class: "rowflex" });
      body.replaceChildren(App.ui.cap(t("fans.wiz.step", { n: i + 1, total: list.length })),
        h("div", { class: "ftitle" }, c.name),
        h("div", { class: "rowflex mono" }, h("span", { class: "fwiz-spin" }), t("fans.wiz.spinning"), h("span", { class: "sp" }), c.fan ? h("span", null, h("span", { "data-rpm": c.id, text: "–" }), " rpm") : h("span", { class: "muted", text: t("fans.wiz.noRpm") })),
        h("div", { class: "muted fhint", text: t("fans.wiz.click") }),
        chips, errEl,
        h("div", { class: "rowflex" }, h("button", { class: "btn ghost", text: t("fans.wiz.back"), onClick: () => (i ? step(i - 1) : intro()) }), h("span", { class: "sp" }),
          h("button", { class: "btn", text: t("fans.wiz.skip"), onClick: () => { picks.delete(c.id); step(i + 1); } }),
          h("button", { class: "btn acc", text: t(i + 1 < list.length ? "fans.wiz.next" : "fans.wiz.finish"), onClick: () => step(i + 1) })));
      stepList(); boost(c); K.tick();
    }
    function summary() {
      stop(); stage.setAssign(null);
      const rows = list.map((c) => { const set = picks.get(c.id); return h("div", { class: "srow" }, h("span", { class: "lb", text: c.name }), h("span", { class: "mono muted", text: set ? (set.size ? [...set].map((sid) => { const s = stage.slots.find((x) => x.id === sid); return s ? FS.slotLabel(s) : sid; }).join(", ") : t("fans.unplaced")) : t("fans.wiz.kept") })); });
      body.replaceChildren(App.ui.cap(t("fans.wiz.doneCap")), h("div", { class: "ftitle sm", text: t("fans.wiz.done") }), ...rows,
        h("div", { class: "rowflex" }, h("button", { class: "btn ghost", text: t("fans.wiz.back"), onClick: () => step(list.length - 1) }), h("span", { class: "sp" }),
          h("button", { class: "btn acc", text: t("fans.wiz.save"), onClick: () => {
            for (const [id, set] of picks) K.setup.layout[id] = [...set].join(",");
            K.commit(); close(); App.toast(t("fans.wiz.saved"), "ok"); if (onDone) onDone();
          } })));
    }

    stage = FS.mount(host, K, {
      compact: true, editing: true,
      onSlot: (slot) => { if (i >= 0) toggle(slot); },
      onReady: () => { const lay = stage.layout; for (const c of list) if (lay[c.id]) picks.set(c.id, new Set(lay[c.id])); },
    });
    (document.querySelector("#v-fans .fans") || document.body).append(ov);
    intro();
  }

  App.FansWizard = { open };
})();
