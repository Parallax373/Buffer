"use strict";
/* RGB page: lights of the PC's devices through OpenRGB (downloaded only when the user enables it, see rgb.rs).
   Simple view: "All devices" first, then one card per device (same-named devices, like four RAM sticks, are one card);
   colour, brightness and effect of the picked card on the right. Design: DESIGN.md. */

(function () {
  const { h, S, api } = App;
  const SWATCHES = ["#c6f432", "#ff4d4d", "#ffb454", "#2ee6a8", "#38b6ff", "#8a6bff", "#ff5fd2", "#ffffff"];
  const FX = ["static", "breathing", "rainbow", "wave"];
  const ALL = "*";

  let page = null, st = { devs: [], sel: ALL }, mode = "simple";
  const sendTimers = new Map();
  /** per device (name#nth): { hue, sat, br, on, fx, speed }, loaded from the scene the recorder keeps and saved on every change */
  const look = new Map();
  const lkey = (d) => d.name + "#" + d.nth;
  /** keys of devices Buffer drives; the others still show their own lighting, so their cards stay dim */
  const driven = new Set();
  const fresh = () => ({ hue: 75, sat: 90, br: 100, on: true, fx: "static", speed: 1 });
  const lookOf = (d) => {
    if (!look.has(lkey(d))) look.set(lkey(d), fresh());
    return look.get(lkey(d));
  };

  /** el with CSS custom properties (Object.assign(style) cannot set those) */
  const vars = (el, o) => { for (const [k, v] of Object.entries(o)) el.style.setProperty(k, v); return el; };
  const css = (l) => `hsl(${l.hue} ${l.sat}% 55%)`;

  /** The list: "All devices", then devices grouped by name. An item is { key, name, members, n }. */
  function items() {
    const by = new Map();
    for (const d of st.devs) {
      if (!by.has(d.name)) by.set(d.name, { key: d.name, name: d.name, vendor: d.vendor, members: [], n: 0, stored: !!d.stored });
      const g = by.get(d.name);
      g.members.push(d); g.n += Math.max(1, d.led_names.length);
    }
    const out = [{ key: ALL, name: App.t("rgb.all"), members: st.devs, n: st.devs.length, all: true }];
    for (const g of by.values()) {
      out.push(g);
      // a group can be opened to control its devices one by one
      if (g.members.length > 1 && open.has(g.key)) {
        for (const m of g.members) out.push({ key: lkey(m), name: `${g.name} ${m.nth + 1}`, vendor: g.vendor, members: [m], n: Math.max(1, m.led_names.length), child: true, stored: g.stored });
      }
    }
    return out;
  }
  /** names of the groups that are opened */
  const open = new Set();
  const current = () => items().find((i) => i.key === st.sel) || items()[0];
  /** what an item shows: its first driven member's look (or a fresh one); for "All" the first member's */
  const itemLook = (it) => lookOf(it.members.find((m) => driven.has(lkey(m))) || it.members[0]);
  const itemDriven = (it) => it.members.some((m) => driven.has(lkey(m)));
  const itemOn = (it) => !itemDriven(it) || itemLook(it).on;

  /** Sends a device's look at most every 40 ms (a drag fires far more often), one timer per device. */
  function push(d) {
    driven.add(lkey(d));
    clearTimeout(sendTimers.get(d.index));
    sendTimers.set(d.index, setTimeout(() => {
      api.invoke("rgb_look", { look: { name: d.name, nth: d.nth, ...lookOf(d) } })
        .catch((e) => App.toast(App.t("rgb.err", { err: e }), "err"));
    }, 40));
  }

  /** Changes the look of every device of an item at once. */
  function apply(it, patch) {
    const base = itemLook(it);
    for (const m of it.members) {
      // a device that was not driven yet starts from what the item shows, so one change is not a jump for the others
      if (!driven.has(lkey(m))) Object.assign(lookOf(m), { ...base });
      Object.assign(lookOf(m), patch);
      push(m);
    }
  }

  /** Gives devices back: their own lighting returns. */
  async function giveBack(it) {
    for (const m of it.members) {
      if (!driven.has(lkey(m))) continue;
      driven.delete(lkey(m)); look.delete(lkey(m));
      await api.invoke("rgb_unlook", { name: m.name, nth: m.nth }).catch((e) => App.toast(App.t("rgb.err", { err: e }), "err"));
    }
    draw();
  }

  function leds(n) {
    return h("span", { class: "rleds" }, Array.from({ length: n }, (_, i) =>
      vars(h("i"), { "--o": (0.45 + 0.55 * (n > 1 ? i / (n - 1) : 1)).toFixed(2) })));
  }
  const nLeds = (it) => Math.min(24, Math.max(2, it.all ? 12 : it.n));

  /** how a driven device differs from the rest: the look signature, and the one most devices share */
  const sigOf = (m) => { const l = lookOf(m); return `${l.hue}|${l.sat}|${l.br}|${l.on}|${l.fx}|${l.speed}`; };
  function reference() {
    const n = new Map();
    for (const d of st.devs) if (driven.has(lkey(d))) n.set(sigOf(d), (n.get(sigOf(d)) || 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  }
  /** "mixed": the devices inside differ from each other; "custom": set differently from the rest; "" otherwise */
  function mark(it, ref) {
    const sigs = new Set(it.members.filter((m) => driven.has(lkey(m))).map(sigOf));
    if (sigs.size > 1) return "mixed";
    if (!it.all && sigs.size === 1 && !sigs.has(ref)) return "custom";
    return "";
  }

  function paintCard(card, it, ref = reference()) {
    const l = itemLook(it), on = itemOn(it), dr = itemDriven(it);
    const mk = mark(it, ref);
    card.classList.toggle("diff", mk === "custom");
    const tag = card.querySelector(".rtag");
    if (tag) { tag.hidden = !mk; tag.textContent = mk ? App.t("rgb." + mk) : ""; tag.title = App.t(mk === "custom" ? "rgb.customTip" : "rgb.mixedTip"); tag.classList.toggle("mix", mk === "mixed"); }
    card.style.setProperty("--c", css(l));
    card.style.setProperty("--br", on ? l.br / 100 : 0.08);
    card.classList.toggle("off", dr && !l.on);
    card.classList.toggle("idle", !dr);
    card.querySelector(".toggle")?.classList.toggle("on", on);
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
      const seen = new Map();
      for (const d of st.devs) { d.nth = seen.get(d.name) || 0; seen.set(d.name, d.nth + 1); }
      const sc = await api.invoke("rgb_scene_get");
      mode = sc.mode === "advanced" || sc.mode === "adv" ? "advanced" : "simple";
      driven.clear(); look.clear();
      for (const l of sc.simple || []) {
        look.set(l.name + "#" + l.nth, { hue: l.hue, sat: l.sat, br: l.br, on: l.on, fx: l.fx || "static", speed: l.speed || 1 });
        driven.add(l.name + "#" + l.nth);
      }
    } catch (e) { gate(String(e), false); return; }
    if (S.view !== "rgb") return;
    draw();
  }

  /** Title row shared by both views: name, backend chip, Simple | Advanced switch. */
  function head(...extra) {
    return h("div", { class: "eqhead" }, h("h1", { text: "RGB" }), h("span", { class: "chip on", text: "OpenRGB" }),
      App.ui.segc([["simple", App.t("rgb.simple")], ["advanced", App.t("rgb.advanced")]], mode, setMode),
      h("span", { class: "sp" }), ...extra);
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
    const all = items(), it = all.find((i) => i.key === st.sel) || all[0];
    st.sel = it.key;

    const cards = new Map();
    const list = h("div", { class: "rlist" }, all.map((x, idx) => {
      const sw = h("span", { class: "toggle", role: "switch", title: App.t("rgb.power"), onClick: (e) => {
        e.stopPropagation();
        apply(x, { on: !itemOn(x) });
        paintAll();
        if (x.key === st.sel) draw();
      } });
      const group = !x.all && !x.child && x.members.length > 1;
      const chev = group ? h("span", { class: "rchev" + (open.has(x.key) ? " open" : ""), role: "button", title: App.t("rgb.ungroup"), text: "›", onClick: (e) => {
        e.stopPropagation();
        if (open.has(x.key)) { open.delete(x.key); if (st.sel.startsWith(x.key + "#")) st.sel = x.key; } else open.add(x.key);
        draw();
      } }) : null;
      const card = h("button", { class: "rdev" + (x.key === it.key ? " on" : "") + (x.all ? " all" : "") + (x.child ? " child" : ""), onClick: () => { st.sel = x.key; draw(); },
        title: x.stored ? App.t("rgb.keyboardTip") : null },
        h("span", { class: "rt" }, h("b", { text: x.name }), group ? h("small", { class: "mono rn", text: "×" + x.members.length }) : null,
          !x.all && !x.child ? h("small", { class: "mono", text: x.vendor }) : null, h("span", { class: "rtag", hidden: true }), chev, sw),
        leds(nLeds(x)));
      cards.set(x.key, card);
      paintCard(card, x);
      return idx === 0 ? [card, h("div", { class: "rsep" })] : [card];
    }).flat());
    const paintAll = () => { const ref = reference(); all.forEach((x) => paintCard(cards.get(x.key), x, ref)); };

    const l = itemLook(it);
    const hue = h("input", { class: "rhue", type: "range", min: 0, max: 359, value: l.hue, "aria-label": App.t("rgb.colour") });
    const br = h("input", { class: "rline", type: "range", min: 0, max: 100, value: l.br, "aria-label": App.t("rgb.brightness") });
    const spd = h("input", { class: "rline", type: "range", min: 20, max: 300, value: Math.round(l.speed * 100), "aria-label": App.t("rgb.speed") });
    const hv = h("span", { class: "mono rval", text: l.hue + "°" }), bv = h("span", { class: "mono rval", text: l.br + "%" });
    const n = nLeds(it);
    const prev = h("div", { class: "rbig" }, Array.from({ length: n }, (_, i) =>
      vars(h("i"), { "--o": (0.45 + 0.55 * (i / (n - 1))).toFixed(2), "--i": i })));
    const power = h("button", { class: "chip" + (itemOn(it) ? " on" : ""), text: App.t(itemOn(it) ? "rgb.on" : "rgb.off"), onClick: () => { apply(it, { on: !itemOn(it) }); draw(); } });
    const fxBox = h("div", { class: "rrow" }, h("div", { class: "rl" }, h("span", { class: "cap", text: App.t("rgb.effect") })),
      App.ui.segc(FX.map((f) => [f, App.t("rgb.fx." + f)]), l.fx || "static", (v) => { apply(it, { fx: v }); draw(); }));
    const spdBox = h("div", { class: "rrow" }, h("div", { class: "rl" }, h("span", { class: "cap", text: App.t("rgb.speed") }),
      h("span", { class: "mono rval", id: "rspd", text: l.speed.toFixed(1) + "×" })), spd);
    const upd = () => {
      br.style.setProperty("--p", l.br + "%");
      spd.style.setProperty("--p", ((l.speed * 100 - 20) / 280 * 100) + "%");
      prev.className = "rbig fx-" + (l.fx || "static");
      prev.style.setProperty("--c", css(l)); prev.style.setProperty("--br", itemOn(it) ? l.br / 100 : 0.08);
      prev.style.setProperty("--sp", (1 / l.speed).toFixed(2));
      hv.textContent = l.hue + "°"; bv.textContent = l.br + "%";
      paintAll();
    };
    hue.oninput = () => { apply(it, { hue: +hue.value, sat: 90 }); upd(); };
    br.oninput = () => { apply(it, { br: +br.value }); upd(); };
    spd.oninput = () => { apply(it, { speed: +spd.value / 100 }); $speed(); upd(); };
    const $speed = () => { const e = spdBox.querySelector("#rspd"); if (e) e.textContent = itemLook(it).speed.toFixed(1) + "×"; };
    const swatches = h("div", { class: "rsw" }, SWATCHES.map((c) => vars(h("button", { "aria-label": c, onClick: () => {
      const v = parseInt(c.slice(1), 16), r = (v >> 16) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), df = mx - mn;
      const hh = df ? Math.round((((mx === r ? ((g - b) / df) % 6 : mx === g ? (b - r) / df + 2 : (r - g) / df + 4) * 60) + 360) % 360) : 0;
      hue.value = hh;
      apply(it, { hue: hh, sat: df ? 90 : 0 }); upd();
    } }), { "--c": c })));
    const detail = h("section", { class: "card2 pad rdetail" },
      h("div", { class: "rhd" }, h("h2", { text: it.name }),
        itemDriven(it) ? h("button", { class: "chip", text: App.t("rgb.release"), title: App.t("rgb.releaseTip"), onClick: () => giveBack(it) }) : null, power),
      prev,
      h("div", { class: "rrow" }, h("div", { class: "rl" }, h("span", { class: "cap", text: App.t("rgb.colour") }), hv), swatches, hue),
      h("div", { class: "rrow" }, h("div", { class: "rl" }, h("span", { class: "cap", text: App.t("rgb.brightness") }), bv), br),
      fxBox,
      l.fx && l.fx !== "static" ? spdBox : null);
    upd();
    page.replaceChildren(h("div", { class: "rgb" }, head(), h("div", { class: "rbody" }, list, detail)));
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
