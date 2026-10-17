"use strict";
/* RGB colour calibration: devices that show the same colour differently (a fan whose white is greenish because of its
   LEDs or its wiring) get a per-channel percentage. It belongs to the hardware, so the recorder keeps it (rgb.json:
   calib, by device key) and applies it to every colour it sends to that device, in Simple, Advanced and every profile.
   While this panel is open every shown device lights the same test colour (rgb-test), so they can be compared side by
   side; closing it (or leaving the page) gives the lights back to the scene. Opened from the RGB pages.
   Everything updates in place: a click never rebuilds the list (no flash, no scroll jump). */

(function () {
  const { h, api } = App;
  /** test colours: white first (the usual problem), a dim grey (brightness), the three primaries, a warm white */
  const TESTS = [["white", [255, 255, 255]], ["grey", [90, 90, 90]], ["red", [255, 0, 0]], ["green", [0, 255, 0]], ["blue", [0, 0, 255]], ["warm", [255, 196, 140]]];
  let el = null, devs = [], test = TESTS[0][1], level = 100, ref = null;
  const timers = new Map(), swatches = [];
  const toast = (e) => App.toast(App.t("rgb.err", { err: e }), "err");
  const keyOf = (d) => d.name + "#" + d.nth;
  const scaled = (c, k) => c.map((v, i) => Math.round(v * (k ? k[i] : 100) / 100));
  const css = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  const shown = () => scaled(test, [level, level, level]);

  function sendTest() { api.invoke("rgb_test", { color: shown() }).catch(toast); swatches.forEach((f) => f()); }
  /** a device's calibration goes out at most every 60 ms while a slider is dragged */
  function sendCal(d) {
    clearTimeout(timers.get(keyOf(d)));
    timers.set(keyOf(d), setTimeout(() => api.invoke("rgb_calib", { key: keyOf(d), value: d.cal.every((v) => v >= 100) ? null : d.cal }).catch(toast), 60));
  }

  /** a 0..100 % line; double-click puts it back to 100 */
  function line(label, val, onInput, cls) {
    const out = h("span", { class: "mono rval", text: Math.round(val) + "%" });
    const inp = h("input", { class: "rline " + (cls || ""), type: "range", min: 0, max: 100, value: Math.round(val), "aria-label": label, title: App.t("ra.resetTip") });
    const paint = () => { inp.style.setProperty("--p", inp.value + "%"); out.textContent = inp.value + "%"; };
    inp.oninput = () => { paint(); onInput(+inp.value); };
    inp.ondblclick = () => { inp.value = 100; inp.oninput(); };
    paint();
    return { row: h("div", { class: "rcal-l" }, h("span", { class: "cap", text: label }), inp, out), inp, paint };
  }

  /** one device: its name, what it shows now, and its four lines (all channels together, then red, green, blue) */
  function card(d) {
    const sw = h("span", { class: "rcal-sw", title: App.t("rcal.swTip") });
    const paintSw = () => sw.style.setProperty("--c", css(scaled(shown(), d.cal)));
    swatches.push(paintSw);
    const lines = [];
    const all = line(App.t("rcal.all"), Math.max(...d.cal), (v) => {
      const m = Math.max(...d.cal) || 1;
      d.cal = d.cal.map((c) => Math.min(100, v ? Math.max(1, Math.round(c * v / m)) : 0));
      lines.forEach((l, i) => { l.inp.value = d.cal[i]; l.paint(); }); paintSw(); sendCal(d);
    }, "all");
    ["red", "green", "blue"].forEach((c, i) => lines.push(line(App.t("ra." + c), d.cal[i], (v) => {
      d.cal[i] = v; all.inp.value = Math.max(...d.cal); all.paint(); paintSw(); sendCal(d);
    }, c)));
    const refB = h("button", { class: "chip", text: App.t("rcal.ref"), title: App.t("rcal.refTip") });
    const box = h("section", { class: "card2 pad rcal-d" },
      // the number of same-named devices (four RAM sticks) stays visible even when the name is cut
      h("div", { class: "rcal-h" }, App.RGB.icon(d.kind), h("b", { text: d.label || d.name, title: d.name }), d.many && !d.label ? h("small", { text: "#" + (d.nth + 1) }) : null),
      h("div", { class: "rcal-acts" }, sw, h("span", { class: "sp" }), refB,
        h("button", { class: "chip", text: App.t("rcal.reset"), title: App.t("rcal.resetTip"), onClick: () => {
          d.cal = [100, 100, 100]; all.inp.value = 100; all.paint(); lines.forEach((l) => { l.inp.value = 100; l.paint(); }); paintSw(); sendCal(d);
        } })),
      h("div", { class: "ra-note rcal-refn", text: App.t("rcal.refNote") }),
      h("div", { class: "rcal-ls" }, all.row, ...lines.map((l) => l.row)));
    refB.onclick = () => { ref = ref === keyOf(d) ? null : keyOf(d); syncRef(); };
    box.dataset.k = keyOf(d);
    paintSw();
    return box;
  }
  /** the reference device is the one the others are matched to: its lines fold away */
  function syncRef() { el.querySelectorAll(".rcal-d").forEach((b) => { const on = b.dataset.k === ref; b.classList.toggle("ref", on); b.querySelector(".rcal-acts .chip").classList.toggle("on", on); }); }

  function draw() {
    swatches.length = 0;
    const lv = line(App.t("rcal.level"), level, (v) => { level = v; sendTest(); });
    const tests = h("div", { class: "rcal-tests" }, TESTS.map(([k, c]) => {
      const b = h("button", { class: "chip" + (c === test ? " on" : "") }, h("i", { class: "rcal-dot" }), App.t("rcal.t." + k));
      b.querySelector(".rcal-dot").style.setProperty("--c", css(c));
      b.onclick = () => { test = c; tests.querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === b)); sendTest(); };
      return b;
    }));
    el.replaceChildren(
      h("div", { class: "eqhead" }, h("h1", { text: App.t("rcal.title") }), h("span", { class: "sp" }),
        h("button", { class: "btn acc", text: App.t("rcal.done"), title: App.t("rcal.doneTip"), onClick: close })),
      h("p", { class: "rcal-lead", text: App.t("rcal.lead") }),
      h("div", { class: "rcal-top" }, tests, lv.row),
      h("div", { class: "rcal-list" }, devs.length ? devs.map(card) : h("div", { class: "ra-note", text: App.t("rcal.none") })),
      h("p", { class: "ra-note rcal-foot", text: App.t("rcal.foot") }));
    syncRef();
  }

  async function open() {
    if (el && el.isConnected) return;
    el = null;   // a page redraw may have dropped an open panel
    el = h("div", { class: "rcal" });
    App.$("#v-rgb").appendChild(el);
    el.replaceChildren(h("div", { class: "ra-note", text: App.t("rgb.starting") }));
    try {
      const list = await api.invoke("rgb_start");
      const seen = {};
      devs = list.filter((d) => !d.hidden && !d.stored && (d.led_names || []).length).map((d) => {
        const nth = (seen[d.name] = (seen[d.name] || 0) + 1) - 1;
        return { name: d.name, nth, kind: d.kind, label: d.label, cal: Array.isArray(d.calib) ? d.calib.map(Math.round) : [100, 100, 100] };
      });
      devs.forEach((d) => { d.many = devs.filter((x) => x.name === d.name).length > 1; });
      if (!el) return;
      draw();
      sendTest();
    } catch (e) { toast(e); close(); }
  }
  /** ends the test pattern: the lights go back to the scene */
  function close() {
    if (!el) return;   // (a dropped panel still ends its test pattern below)
    el.remove(); el = null;
    api.invoke("rgb_test", { color: null }).catch(() => {});
  }

  App.RGBCalib = { open, close, isOpen: () => !!el };
})();
