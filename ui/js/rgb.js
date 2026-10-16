"use strict";
/* RGB page: lights of the PC's devices through OpenRGB (downloaded only when the user enables it, see rgb.rs).
   Simple view: device cards on the left, colour + brightness of the picked device on the right. Design: DESIGN.md. */

(function () {
  const { h, S, api } = App;
  const SWATCHES = ["#c6f432", "#ff4d4d", "#ffb454", "#2ee6a8", "#38b6ff", "#8a6bff", "#ff5fd2", "#ffffff"];

  let page = null, st = { devs: [], sel: 0 }, mode = "simple", kb = { found: false, on: false };
  const sendTimers = new Map();
  /** per device (name#nth): { hue, sat, br, on }, loaded from the scene the recorder keeps and saved back on every change */
  const look = new Map();
  const lkey = (d) => d.name + "#" + d.nth;
  /** keys of devices Buffer drives; the others still show their own lighting, so their cards stay dim */
  const driven = new Set();
  /** same-named devices (four RAM sticks) get a number, so the cards can be told apart */
  const label = (d) => (st.devs.filter((x) => x.name === d.name).length > 1 ? `${d.name} ${d.nth + 1}` : d.name);

  const lookOf = (d) => {
    if (!look.has(lkey(d))) look.set(lkey(d), { hue: 75, sat: 90, br: 100, on: true });
    return look.get(lkey(d));
  };
  /** [r,g,b] of a look with the brightness applied */
  function rgbOf(l) {
    const L = 0.55, a = (l.sat / 100) * Math.min(L, 1 - L);
    const ch = (n) => { const k = (n + l.hue / 30) % 12; return L - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    const f = l.on ? l.br / 100 : 0;
    return [ch(0), ch(8), ch(4)].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255 * f));
  }
  /** el with CSS custom properties (Object.assign(style) cannot set those) */
  const vars = (el, o) => { for (const [k, v] of Object.entries(o)) el.style.setProperty(k, v); return el; };
  const css = (l) => `hsl(${l.hue} ${l.sat}% 55%)`;

  /** Sends a device's colour at most every 40 ms (a drag fires far more often), one timer per device. */
  function push(d) {
    driven.add(lkey(d));
    clearTimeout(sendTimers.get(d.index));
    sendTimers.set(d.index, setTimeout(() => {
      api.invoke("rgb_look", { look: { name: d.name, nth: d.nth, ...lookOf(d) } })
        .catch((e) => App.toast(App.t("rgb.err", { err: e }), "err"));
    }, 40));
  }

  function leds(d, n) {
    return h("span", { class: "rleds" }, Array.from({ length: n }, (_, i) =>
      vars(h("i"), { "--o": (0.45 + 0.55 * (n > 1 ? i / (n - 1) : 1)).toFixed(2) })));
  }

  function paintCard(card, d) {
    const l = lookOf(d);
    card.style.setProperty("--c", css(l));
    card.style.setProperty("--br", l.on ? l.br / 100 : 0.08);
    card.classList.toggle("off", !l.on);
    card.classList.toggle("idle", !driven.has(lkey(d)));
  }

  function gate(msg, busy) {
    page.replaceChildren(App.emptyState(App.t("rgb.gate"), msg || App.t("rgb.gateD"), busy ? null : App.t("rgb.enable"), async () => {
      gate(App.t("rgb.installing"), true);
      try {
        if (!(await api.invoke("rgb_status")).installed) await api.invoke("rgb_install");
        await start();
      } catch (e) { gate(String(e), false); }
    }));
    const b = page.querySelector(".empty");
    if (b && !busy) b.querySelector("button")?.setAttribute("title", App.t("rgb.tip"));
  }

  async function start() {
    gate(App.t("rgb.starting"), true);
    try {
      st.devs = await api.invoke("rgb_start");
      const s = await api.invoke("rgb_status").catch(() => ({}));
      kb = { found: !!s.keyboard_found, on: !!s.keyboard };
      const seen = new Map();
      for (const d of st.devs) { d.nth = seen.get(d.name) || 0; seen.set(d.name, d.nth + 1); }
      const sc = await api.invoke("rgb_scene_get");
      mode = sc.mode === "advanced" || sc.mode === "adv" ? "advanced" : "simple";
      driven.clear();
      for (const l of sc.simple || []) { look.set(l.name + "#" + l.nth, { hue: l.hue, sat: l.sat, br: l.br, on: l.on }); driven.add(l.name + "#" + l.nth); }
    } catch (e) { gate(String(e), false); return; }
    if (S.view !== "rgb") return;
    st.sel = Math.min(st.sel, Math.max(0, st.devs.length - 1));
    draw();
  }

  /** Title row shared by both views: name, backend chip, Simple | Advanced switch. */
  function head(...extra) {
    return h("div", { class: "eqhead" }, h("h1", { text: "RGB" }), h("span", { class: "chip on", text: "OpenRGB" }),
      App.ui.segc([["simple", App.t("rgb.simple")], ["advanced", App.t("rgb.advanced")]], mode, setMode),
      h("span", { class: "sp" }),
      ...extra);
  }

  /** Connects the Dark Project keyboard to the Simple page (its card appears) or gives it back with its own profile. */
  async function setKeyboard(on) {
    try { await api.invoke("rgb_keyboard", { on }); kb.on = on; await start(); } catch (e) { App.toast(App.t("rgb.err", { err: e }), "err"); }
  }

  /** Switching also tells the recorder which view the saved scene belongs to (rgb-scene-set replaces the whole scene). */
  async function setMode(m) {
    if (m === mode) return;
    if (mode === "advanced") App.RGBAdv.leave();
    mode = m;
    try {
      const sc = await api.invoke("rgb_scene_get");
      if (sc.mode !== m) await api.invoke("rgb_scene_set", { scene: { ...sc, mode: m } });
    } catch (e) { App.toast(App.t("rgb.err", { err: e }), "err"); }
    draw();
  }

  function draw() {
    if (mode === "advanced" && st.devs.length) {
      const box = h("div", { class: "radv" });
      page.replaceChildren(h("div", { class: "rgb" }, head(), box));
      App.RGBAdv.render(box);
      return;
    }
    if (!st.devs.length) {
      page.replaceChildren(App.emptyState(App.t("rgb.none"), App.t("rgb.noneD"), App.t("rgb.rescan"), () => start()));
      return;
    }
    const list = h("div", { class: "rlist" }, st.devs.map((d) => {
      const card = h("button", { class: "rdev" + (d.index === st.devs[st.sel].index ? " on" : ""), onClick: () => { st.sel = st.devs.indexOf(d); draw(); } },
        h("span", { class: "rt" }, h("b", { text: label(d) }), h("small", { class: "mono", text: d.vendor })),
        leds(d, Math.min(24, Math.max(2, d.led_names.length))));
      paintCard(card, d);
      d.card = card;
      return card;
    }));
    // a keyboard that is found but not connected: a ghost card, one click connects it
    if (kb.found && !kb.on) {
      list.append(h("button", { class: "rdev ghost", title: App.t("rgb.keyboardTip"), onClick: () => setKeyboard(true) },
        h("span", { class: "rt" }, h("b", { text: "Dark Project Midnight 87" }), h("small", { class: "mono", text: App.t("rgb.connect") }))));
    }
    const d = st.devs[st.sel], l = lookOf(d);
    const hue = h("input", { class: "rhue", type: "range", min: 0, max: 359, value: l.hue, "aria-label": App.t("rgb.colour") });
    const br = h("input", { class: "rline", type: "range", min: 0, max: 100, value: l.br, "aria-label": App.t("rgb.brightness") });
    const hv = h("span", { class: "mono rval", text: l.hue + "°" }), bv = h("span", { class: "mono rval", text: l.br + "%" });
    const nLeds = Math.min(24, Math.max(2, d.led_names.length));
    const prev = h("div", { class: "rbig" }, Array.from({ length: nLeds }, (_, i) =>
      vars(h("i"), { "--o": (0.45 + 0.55 * (i / (nLeds - 1))).toFixed(2) })));
    const power = h("button", { class: "chip" + (l.on ? " on" : ""), text: App.t(l.on ? "rgb.on" : "rgb.off"), onClick: () => { l.on = !l.on; upd(); draw(); } });
    /** `send` is false for the first paint: only a change by the user may take a device over */
    const upd = (send = true) => {
      if (send) driven.add(lkey(d));
      br.style.setProperty("--p", l.br + "%");
      prev.style.setProperty("--c", css(l)); prev.style.setProperty("--br", l.on ? (driven.has(lkey(d)) ? l.br / 100 : 0.3) : 0.08);
      hv.textContent = l.hue + "°"; bv.textContent = l.br + "%";
      paintCard(d.card, d);
      if (send) push(d);
    };
    hue.oninput = () => { l.hue = +hue.value; l.sat = 90; upd(); };
    br.oninput = () => { l.br = +br.value; upd(); };
    const swatches = h("div", { class: "rsw" }, SWATCHES.map((c) => vars(h("button", { "aria-label": c, onClick: () => {
      const n = parseInt(c.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), df = mx - mn;
      l.hue = df ? Math.round((((mx === r ? ((g - b) / df) % 6 : mx === g ? (b - r) / df + 2 : (r - g) / df + 4) * 60) + 360) % 360) : 0;
      l.sat = df ? 90 : 0;
      hue.value = l.hue; upd();
    } }), { "--c": c })));
    const detail = h("section", { class: "card2 pad rdetail" },
      h("div", { class: "rhd" }, h("h2", { text: label(d) }),
        d.stored ? h("button", { class: "chip", text: App.t("rgb.release"), title: App.t("rgb.keyboardTip"), onClick: () => setKeyboard(false) }) : null, power),
      prev,
      h("div", { class: "rrow" }, h("div", { class: "rl" }, h("span", { class: "cap", text: App.t("rgb.colour") }), hv), swatches, hue),
      h("div", { class: "rrow" }, h("div", { class: "rl" }, h("span", { class: "cap", text: App.t("rgb.brightness") }), bv), br));
    upd(false);
    page.replaceChildren(h("div", { class: "rgb" },
      head(h("button", { class: "btn ghost", text: App.t("rgb.allOff"), onClick: () => { st.devs.forEach((x) => { lookOf(x).on = false; push(x); }); draw(); } })),
      h("div", { class: "rbody" }, list, detail)));
  }

  App.RGB = {
    async render() {
      page = App.$("#v-rgb");
      let s = null;
      try { s = await api.invoke("rgb_status"); } catch (_) { /* no backend: treated as not installed */ }
      if (S.view !== "rgb") return;
      if (!s || !s.installed) gate();
      else if (!s.enabled) gate();
      else if (s.running && st.devs.length) draw();
      else start();
    },
    leave() { if (mode === "advanced") App.RGBAdv.leave(); },
  };
})();
