"use strict";
/* RGB colour calibration: devices that show the same colour differently (a fan whose white is greenish because of its
   LEDs or its wiring) get a per-channel percentage. It belongs to the hardware, so the recorder keeps it (rgb.json:
   calib, by device key) and applies it to every colour it sends to that device, in Simple, Advanced and every profile.
   While this panel is open every shown device lights the same test colour (rgb-test), so they can be compared side by
   side; closing it (or leaving the page) gives the lights back to the scene. Opened from the RGB pages.
   Everything updates in place: a click never rebuilds the list (no flash, no scroll jump). */

(function () {
  const { h, api } = App;
  /** test colours: white first (the usual problem), the three primaries, a warm white (dimmer: the level slider) */
  const TESTS = [["white", [255, 255, 255]], ["red", [255, 0, 0]], ["green", [0, 255, 0]], ["blue", [0, 0, 255]], ["warm", [255, 196, 140]]];
  let el = null, devs = [], test = TESTS[0][1], level = 100;
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

  /** The two simple dials and the three channels are one thing: [r,g,b] in percent. Warmth: right lowers blue (more yellow),
      left lowers red and green (more blue); tint: right lowers green (more pink), left lowers red and blue (more green). */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function fromDials(w, t) {
    let r = 100, g = 100, b = 100;
    if (w > 0) b -= w * 0.6; else { r += w * 0.6; g += w * 0.6; }
    if (t > 0) g -= t * 0.6; else { r += t * 0.5; b += t * 0.5; }
    return [r, g, b].map((v) => Math.round(clamp(v, 0, 100)));
  }
  /** the dials that come closest to a calibration made by hand (the brightness part is left out) */
  function toDials(cal) {
    const m = Math.max(...cal, 1), n = cal.map((v) => v / m * 100);
    let best = [0, 0], err = Infinity;
    for (let w = -100; w <= 100; w += 2) for (let t = -100; t <= 100; t += 2) {
      const c = fromDials(w, t), e = (c[0] - n[0]) ** 2 + (c[1] - n[1]) ** 2 + (c[2] - n[2]) ** 2;
      if (e < err) { err = e; best = [w, t]; }
    }
    return best;
  }
  /** a -100..100 dial with its two ends named; double-click puts it in the middle */
  function dial(label, left, right, val, cls, onInput) {
    const inp = h("input", { class: "rline dial " + cls, type: "range", min: -100, max: 100, value: val, "aria-label": label, title: App.t("ra.resetTip") });
    inp.oninput = () => onInput(+inp.value);
    inp.ondblclick = () => { inp.value = 0; inp.oninput(); };
    return { inp, row: h("div", { class: "rcal-dl" }, h("span", { class: "cap", text: label }), h("div", { class: "rcal-dw" }, inp, h("div", { class: "rcal-de" }, h("span", { text: left }), h("span", { text: right })))) };
  }

  /** one device: its name, what it shows now, and its four lines (all channels together, then red, green, blue) */
  function card(d) {
    const sw = h("span", { class: "rcal-sw", title: App.t("rcal.swTip") });
    const paintSw = () => sw.style.setProperty("--c", css(scaled(shown(), d.cal)));
    swatches.push(paintSw);
    const lines = [];
    let wd, td;
    const syncDials = () => { const [w, t] = toDials(d.cal); wd.inp.value = w; td.inp.value = t; };
    const syncLines = () => { all.inp.value = Math.max(...d.cal); all.paint(); lines.forEach((l, i) => { l.inp.value = d.cal[i]; l.paint(); }); };
    const all = line(App.t("rcal.all"), Math.max(...d.cal), (v) => {
      const m = Math.max(...d.cal) || 1;
      d.cal = d.cal.map((c) => Math.min(100, v ? Math.max(1, Math.round(c * v / m)) : 0));
      lines.forEach((l, i) => { l.inp.value = d.cal[i]; l.paint(); }); syncDials(); paintSw(); sendCal(d);
    }, "all");
    ["red", "green", "blue"].forEach((c, i) => lines.push(line(App.t("ra." + c), d.cal[i], (v) => {
      d.cal[i] = v; all.inp.value = Math.max(...d.cal); all.paint(); syncDials(); paintSw(); sendCal(d);
    }, c)));
    const [w0, t0] = toDials(d.cal);
    const setDials = () => { d.cal = fromDials(+wd.inp.value, +td.inp.value); syncLines(); paintSw(); sendCal(d); };
    wd = dial(App.t("rcal.warmth"), App.t("rcal.cooler"), App.t("rcal.warmer"), w0, "warm", setDials);
    td = dial(App.t("rcal.tint"), App.t("rcal.greener"), App.t("rcal.pinker"), t0, "tint", setDials);
    const box = h("section", { class: "card2 pad rcal-d" },
      // the number of same-named devices (four RAM sticks) stays visible even when the name is cut
      h("div", { class: "rcal-h" }, App.RGB.icon(d.kind), h("b", { text: d.label || d.name, title: d.name }), d.many && !d.label ? h("small", { text: "#" + (d.nth + 1) }) : null),
      h("div", { class: "rcal-acts" }, sw, h("span", { class: "sp" }),
        h("button", { class: "chip", text: App.t("rcal.reset"), title: App.t("rcal.resetTip"), onClick: () => {
          d.cal = [100, 100, 100]; syncLines(); syncDials(); paintSw(); sendCal(d);
        } })),
      h("div", { class: "rcal-ls" }, wd.row, td.row),
      h("details", { class: "rcal-adv" }, h("summary", { text: App.t("rcal.channels") }), h("div", { class: "rcal-ls" }, all.row, ...lines.map((l) => l.row))));
    box.dataset.k = keyOf(d);
    paintSw();
    return box;
  }
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
