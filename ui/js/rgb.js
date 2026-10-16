"use strict";
/* RGB page: lights of the PC's devices through OpenRGB (downloaded only when the user enables it, see rgb.rs).
   Simple view: "All devices" first, then one card per device (same-named devices, like four RAM sticks, are one card);
   colour, brightness and effect of the picked card on the right. Profiles, automation and conflicts: rgb-auto.js.
   Design: DESIGN.md. */

(function () {
  const { h, S, api } = App;
  const SWATCHES = ["#c6f432", "#ff4d4d", "#ffb454", "#2ee6a8", "#38b6ff", "#8a6bff", "#ff5fd2", "#ffffff"];
  const FX = ["static", "breathing", "rainbow", "wave"];
  const ALL = "*";
  /** OpenRGB mode flags */
  const F = { SPEED: 1, DIR: 2, BRIGHT: 16, PERLED: 32, COLORS: 64, AUTOSAVE: 512 };

  let page = null, st = { devs: [], sel: ALL }, mode = "simple", autoEl = null, showHidden = false;
  const sendTimers = new Map();
  /** per device (name#nth): { hue, sat, br, on, fx, speed, c2, rev, native }, loaded from the scene the recorder keeps and saved on every change */
  const look = new Map();
  const lkey = (d) => d.name + "#" + d.nth;
  /** keys of devices Buffer drives; the others still show their own lighting, so their cards stay dim */
  const driven = new Set();
  const fresh = () => ({ hue: 75, sat: 90, br: 100, on: true, fx: "static", speed: 1, c2: null, rev: false, native: null });
  const lookOf = (d) => {
    if (!look.has(lkey(d))) look.set(lkey(d), fresh());
    return look.get(lkey(d));
  };
  const toast = (e) => App.toast(App.t("rgb.err", { err: e }), "err");

  /** el with CSS custom properties (Object.assign(style) cannot set those) */
  const vars = (el, o) => { for (const [k, v] of Object.entries(o)) el.style.setProperty(k, v); return el; };
  /** the look's colour for CSS: full value, so no saturation is white (hsl lightness = 1 - sat / 2) */
  const css = (l) => `hsl(${l.hue} 100% ${100 - l.sat / 2}%)`;

  /** Line icons per device type (OpenRGB device types), drawn in the page's own style: thin strokes, currentColor. */
  const ICONS = {
    all: '<rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/>',
    0: '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="8" y="8" width="8" height="8" rx="1"/><path d="M12 3v5M12 16v5M3 12h5M16 12h5"/>',
    1: '<rect x="2" y="8" width="20" height="8" rx="1.5"/><rect x="5" y="10.5" width="3" height="3" rx=".5"/><rect x="10.5" y="10.5" width="3" height="3" rx=".5"/><rect x="16" y="10.5" width="3" height="3" rx=".5"/><path d="M6 16v2.5M10 16v2.5M14 16v2.5M18 16v2.5"/>',
    2: '<rect x="2" y="7" width="20" height="10" rx="2"/><circle cx="9" cy="12" r="3"/><circle cx="16.5" cy="12" r="1.8"/><path d="M4 17v2.5"/>',
    3: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.8"/><path d="M12 10.2V4M13.6 13l5.4 3M10.4 13l-5.4 3"/>',
    4: '<path d="M3 12h18"/><path d="M6 12h.01M10 12h.01M14 12h.01M18 12h.01" stroke-width="3.2"/>',
    5: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 13.5h.01M18 13.5h.01M9 14.5h6" stroke-width="1.8"/>',
    6: '<rect x="7" y="3" width="10" height="18" rx="5"/><path d="M12 3v6"/>',
    8: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
    12: '<rect x="6" y="3" width="12" height="18" rx="2"/><circle cx="12" cy="14.5" r="3.5"/><circle cx="12" cy="7.5" r="1"/>',
    14: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="16.5" cy="12" r="1.6"/><path d="M6 12h6"/>',
    x: '<path d="M12 3l9 9-9 9-9-9z"/>',
  };
  ICONS[7] = ICONS[6]; ICONS[9] = ICONS[8];
  function icon(kind) {
    const el = h("span", { class: "ric", "aria-hidden": "true" });
    el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[kind] || ICONS.x}</svg>`;
    return el;
  }

  /** The list: "All devices", then devices grouped by name. An item is { key, name, members, n }. */
  function items() {
    const by = new Map();
    for (const d of st.devs.filter((x) => !x.hidden)) {
      if (!by.has(d.name)) by.set(d.name, { key: d.name, name: d.name, vendor: d.vendor, kind: d.kind, members: [], n: 0, stored: !!d.stored, hid: !!d.hidden });
      const g = by.get(d.name);
      g.members.push(d); g.n += Math.max(1, d.led_names.length);
    }
    const shown = st.devs.filter((x) => !x.hidden);
    const out = [{ key: ALL, name: App.t("rgb.all"), members: shown, n: shown.length, all: true, kind: "all" }];
    for (const g of by.values()) {
      out.push(g);
      // a group can be opened to control its devices one by one
      if (g.members.length > 1 && open.has(g.key)) {
        for (const m of g.members) out.push({ key: lkey(m), name: `${g.name} ${m.nth + 1}`, vendor: g.vendor, kind: g.kind, members: [m], n: Math.max(1, m.led_names.length), child: true, stored: g.stored, hid: !!m.hidden });
      }
    }
    return out;
  }
  /** names of the groups that are opened */
  const open = new Set();
  /** what an item shows: its first driven member's look (or a fresh one); for "All" the one most devices share */
  const itemLook = (it) => lookOf(it.all ? majorityMember() : it.members.find((m) => driven.has(lkey(m))) || it.members[0]);
  /** the device whose look most driven devices share (what "All devices" shows) */
  function majorityMember() {
    const ref = reference();
    return st.devs.find((d) => driven.has(lkey(d)) && sigOf(d) === ref) || st.devs[0];
  }
  const itemDriven = (it) => it.members.some((m) => driven.has(lkey(m)));
  const itemOn = (it) => !itemDriven(it) || itemLook(it).on;

  /** Sends a device's look at most every 40 ms (a drag fires far more often), one timer per device. */
  function push(d) {
    driven.add(lkey(d));
    clearTimeout(sendTimers.get(d.index));
    sendTimers.set(d.index, setTimeout(() => {
      api.invoke("rgb_look", { look: { name: d.name, nth: d.nth, ...lookOf(d) } }).catch(toast);
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
  async function giveBackQuiet(it) {
    for (const m of it.members) {
      if (!driven.has(lkey(m))) continue;
      driven.delete(lkey(m)); look.delete(lkey(m));
      await api.invoke("rgb_unlook", { name: m.name, nth: m.nth }).catch(toast);
    }
  }
  async function giveBack(it) { await giveBackQuiet(it); draw(); }

  /** Hides a device (or shows it again): it leaves the list and Buffer stops driving it. */
  async function hide(it, on) {
    if (on) await giveBackQuiet(it);
    for (const m of it.members) {
      try { await api.invoke("rgb_hide", { key: lkey(m), on }); m.hidden = on; } catch (e) { toast(e); }
    }
    if (on) st.sel = ALL;
    draw();
  }

  function leds(n) {
    return h("span", { class: "rleds" }, Array.from({ length: n }, (_, i) =>
      vars(h("i"), { "--o": (0.45 + 0.55 * (n > 1 ? i / (n - 1) : 1)).toFixed(2) })));
  }
  const nLeds = (it) => Math.min(24, Math.max(2, it.all ? 12 : it.n));

  /** how a driven device differs from the rest: the look signature, and the one most devices share */
  const sigOf = (m) => { const l = lookOf(m); return [l.hue, l.sat, l.br, l.on, l.fx, l.speed, l.c2, l.rev, l.native].join("|"); };
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

  /** The device list from the recorder, with each device's number among the ones of the same name. */
  function adoptDevices(list) {
    st.devs = list;
    const seen = new Map();
    for (const d of st.devs) { d.nth = seen.get(d.name) || 0; seen.set(d.name, d.nth + 1); }
  }
  /** The saved scene: which view, and the looks the Simple page drives. */
  function adoptScene(sc) {
    mode = sc.mode === "advanced" || sc.mode === "adv" ? "advanced" : "simple";
    driven.clear(); look.clear();
    for (const l of sc.simple || []) {
      look.set(l.name + "#" + l.nth, { hue: l.hue, sat: l.sat, br: l.br, on: l.on, fx: l.fx || "static", speed: l.speed || 1, c2: l.c2 || null, rev: !!l.rev, native: l.native || null });
      driven.add(l.name + "#" + l.nth);
    }
  }

  async function start() {
    gate(App.t("rgb.starting"), true);
    try {
      adoptDevices(await api.invoke("rgb_start"));
      adoptScene(await api.invoke("rgb_scene_get"));
      await App.RGBAuto.refresh();
    } catch (e) { gate(String(e), false); return; }
    if (S.view !== "rgb") return;
    draw(true);
  }

  /** The scene or the profile changed outside this page (a profile was loaded): read it again and draw from scratch. */
  async function reload() {
    try { adoptScene(await api.invoke("rgb_scene_get")); await App.RGBAuto.refresh(); } catch (e) { toast(e); }
    draw(true);
  }

  /** Title row shared by both views: name, backend chip, Simple | Advanced switch, what needs attention. */
  function head(...extra) {
    return h("div", { class: "eqhead" }, h("h1", { text: "RGB" }), h("span", { class: "chip on", text: "OpenRGB" }),
      App.ui.segc([["simple", App.t("rgb.simple")], ["advanced", App.t("rgb.advanced")]], mode, setMode),
      h("span", { class: "sp" }), App.RGBAuto.awayChip(), App.RGBAuto.conflictChip(), ...extra);
  }

  /** Switching also tells the recorder which view the saved scene belongs to (rgb-scene-set replaces the whole scene). */
  async function setMode(m) {
    if (m === mode) return;
    if (mode === "advanced") App.RGBAdv.leave();
    mode = m;
    try {
      const sc = await api.invoke("rgb_scene_get");
      if (sc.mode !== m) await api.invoke("rgb_scene_set", { scene: { ...sc, mode: m } });
    } catch (e) { toast(e); }
    draw(true);
  }

  /** Small colour row for the second colour: swatches and a hex field. */
  function colour2(it, l) {
    const set = (v) => { apply(it, { c2: [v.hue, v.sat] }); draw(); };
    const hex = h("input", { class: "field rhex mono", value: App.RGBWheel.toHex(l.c2[0], l.c2[1]), maxlength: 7, spellcheck: false, "aria-label": "hex",
      onChange: (e) => { const c = App.RGBWheel.fromHex(e.target.value); if (c) set(c); else e.target.value = App.RGBWheel.toHex(l.c2[0], l.c2[1]); } });
    return h("div", { class: "rcol2" },
      h("div", { class: "rsw" }, SWATCHES.map((c) => vars(h("button", { "aria-label": c, onClick: () => set(App.RGBWheel.fromHex(c)) }), { "--c": c }))),
      hex, h("button", { class: "chip", text: "✕", title: App.t("rgb.colour2Del"), onClick: () => { apply(it, { c2: null }); draw(); } }));
  }

  function draw(force = false) {
    if (mode === "advanced" && st.devs.length) {
      const box = h("div", { class: "radv" });
      page.replaceChildren(h("div", { class: "rgb" }, head(), App.RGBAuto.profileBar(reload), box));
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
      const card = h("button", { class: "rdev" + (x.key === it.key ? " on" : "") + (x.all ? " all" : "") + (x.child ? " child" : "") + (x.hid ? " hid" : ""), onClick: () => { st.sel = x.key; draw(); },
        title: x.stored ? App.t("rgb.keyboardTip") : null },
        h("span", { class: "rt" }, icon(x.kind), h("b", { text: x.name }), group ? h("small", { class: "mono rn", text: "×" + x.members.length }) : null,
          !x.all && !x.child ? h("small", { class: "mono", text: x.vendor }) : null, h("span", { class: "rtag", hidden: true }), chev,
          x.hid ? h("span", { class: "chip rshow", role: "button", text: App.t("rgb.unhide"), onClick: (e) => { e.stopPropagation(); hide(x, false); } }) : sw),
        x.hid ? null : leds(nLeds(x)));   // a hidden device is one compact line
      cards.set(x.key, card);
      paintCard(card, x);
      return idx === 0 ? [card, h("div", { class: "rsep" })] : [card];
    }).flat());
    const paintAll = () => { const ref = reference(); all.forEach((x) => paintCard(cards.get(x.key), x, ref)); };

    const l = itemLook(it);
    // the device's own modes: what OpenRGB can make the hardware do by itself (one device, or a group of equal ones)
    const dev0 = it.members[0];
    const nat = it.all || it.stored ? [] : (dev0.modes || []).filter((m) => !(m.flags & F.PERLED) && m.name.toLowerCase() !== "off");
    const natMode = l.fx === "native" ? nat.find((m) => m.name === l.native) : null;
    const wants = {
      colour: !natMode || !!(natMode.flags & F.COLORS),
      colour2: !it.stored && (natMode ? !!(natMode.flags & F.COLORS) && natMode.colors_max >= 2 : l.fx === "breathing" || l.fx === "wave"),
      speed: natMode ? !!(natMode.flags & F.SPEED) : l.fx !== "static",
      dir: natMode ? !!(natMode.flags & F.DIR) : l.fx === "wave" || l.fx === "rainbow",
      bright: !natMode || !!(natMode.flags & (F.BRIGHT | F.COLORS)),
    };

    const wheel = App.RGBWheel(l.hue, l.sat, (hh, ss) => { apply(it, { hue: hh, sat: ss }); hex.value = App.RGBWheel.toHex(hh, ss); upd(); });
    const hex = h("input", { class: "field rhex mono", value: App.RGBWheel.toHex(l.hue, l.sat), maxlength: 7, spellcheck: false, "aria-label": "hex", onChange: (e) => {
      const c = App.RGBWheel.fromHex(e.target.value);
      if (!c) { e.target.value = App.RGBWheel.toHex(itemLook(it).hue, itemLook(it).sat); return; }
      wheel.set(c.hue, c.sat); apply(it, c); upd();
    } });
    const br = h("input", { class: "rline", type: "range", min: 0, max: 100, value: l.br, "aria-label": App.t("rgb.brightness") });
    const spd = h("input", { class: "rline", type: "range", min: 20, max: 300, value: Math.round(l.speed * 100), "aria-label": App.t("rgb.speed") });
    const bv = h("span", { class: "mono rval", text: l.br + "%" });
    const n = nLeds(it);
    const prev = h("div", { class: "rbig" }, Array.from({ length: n }, (_, i) =>
      vars(h("i"), { "--o": (0.45 + 0.55 * (i / (n - 1))).toFixed(2), "--i": i })));
    const mk = mark(it, reference());
    const rel = h("button", { class: "chip", text: App.t("rgb.release"), title: App.t("rgb.releaseTip"), disabled: !itemDriven(it), onClick: () => giveBack(it) });
    const power = h("button", { class: "chip" + (itemOn(it) ? " on" : ""), text: App.t(itemOn(it) ? "rgb.on" : "rgb.off"), onClick: () => { apply(it, { on: !itemOn(it) }); draw(); } });
    const fxBox = h("div", { class: "rrow" }, h("div", { class: "rl" }, h("span", { class: "cap", text: App.t("rgb.effect") })),
      App.ui.segc(FX.map((f) => [f, App.t("rgb.fx." + f)]), l.fx === "native" ? "" : l.fx || "static", (v) => { apply(it, { fx: v, native: null }); draw(); }));
    // the device's own effects: a second row, same look; clicking the active one goes back to a plain colour
    const natBox = nat.length ? h("div", { class: "rrow" }, h("div", { class: "rl" }, h("span", { class: "cap", text: App.t("rgb.native"), title: App.t("rgb.nativeTip") })),
      App.ui.segc(nat.map((m) => [m.name, m.name + (m.flags & F.AUTOSAVE ? " ◆" : "")]), natMode ? natMode.name : "",
        (v) => { apply(it, natMode && natMode.name === v ? { fx: "static", native: null } : { fx: "native", native: v }); draw(); })) : null;
    const spdBox = h("div", { class: "rrow" }, h("div", { class: "rl" }, h("span", { class: "cap", text: App.t("rgb.speed") }),
      h("span", { class: "mono rval", id: "rspd", text: l.speed.toFixed(1) + "×" })), spd);
    const dirBox = h("div", { class: "rrow" }, h("div", { class: "rl" }, h("span", { class: "cap", text: App.t("rgb.dir") })),
      App.ui.segc([[false, "→"], [true, "←"]], !!l.rev, (v) => { apply(it, { rev: v }); draw(); }));
    const c2Box = h("div", { class: "rrow" }, h("div", { class: "rl" }, h("span", { class: "cap", text: App.t("rgb.colour2") })),
      l.c2 ? colour2(it, l) : h("button", { class: "chip rplus", text: "+ " + App.t("rgb.colour2"), onClick: () => { apply(it, { c2: [(l.hue + 180) % 360, 90] }); draw(); } }));
    // addressable zones whose LED count can be set (an ARGB header: the strip or fans on it may have any length)
    const zs = it.all || it.stored ? [] : (dev0.zones || []).map((z, zi) => ({ z, zi })).filter(({ z }) => z.leds_min !== z.leds_max);
    const zBox = zs.length ? h("div", { class: "rrow" }, h("div", { class: "rl" }, h("span", { class: "cap", text: App.t("rgb.zones"), title: App.t("rgb.zonesTip") })),
      zs.map(({ z, zi }) => h("div", { class: "arow" }, h("span", { text: z.name }),
        h("input", { class: "field rnum", type: "number", min: z.leds_min, max: z.leds_max, value: z.leds, "aria-label": z.name, onChange: async (e) => {
          const v = Math.max(z.leds_min, Math.min(z.leds_max, Math.round(+e.target.value) || z.leds));
          e.target.value = v;
          try {
            let list = null;
            for (const m of it.members) list = await api.invoke("rgb_zone", { index: m.index, zone: zi, leds: v });
            adoptDevices(list.filter((d) => !d.stored || true)); draw();
          } catch (err) { toast(err); }
        } })))) : null;

    const upd = () => {
      br.style.setProperty("--p", l.br + "%");
      spd.style.setProperty("--p", ((l.speed * 100 - 20) / 280 * 100) + "%");
      prev.className = "rbig fx-" + (l.fx === "native" ? "static" : l.fx || "static");
      prev.style.setProperty("--c", css(l)); prev.style.setProperty("--br", itemOn(it) ? l.br / 100 : 0.08);
      prev.style.setProperty("--sp", (1 / l.speed).toFixed(2));
      bv.textContent = l.br + "%";
      rel.disabled = !itemDriven(it);
      paintAll();
    };
    br.oninput = () => { apply(it, { br: +br.value }); upd(); };
    spd.oninput = () => { apply(it, { speed: +spd.value / 100 }); $speed(); upd(); };
    const $speed = () => { const e = spdBox.querySelector("#rspd"); if (e) e.textContent = itemLook(it).speed.toFixed(1) + "×"; };
    const swatches = h("div", { class: "rsw" }, SWATCHES.map((c) => vars(h("button", { "aria-label": c, onClick: () => {
      const v = App.RGBWheel.fromHex(c);
      wheel.set(v.hue, v.sat); hex.value = App.RGBWheel.toHex(v.hue, v.sat);
      apply(it, v); upd();
    } }), { "--c": c })));
    const detail = h("section", { class: "card2 pad rdetail" },
      h("div", { class: "rhd" }, icon(it.kind), h("h2", { text: it.name }),
        mk === "mixed" ? h("button", { class: "chip", text: App.t("rgb.unify"), title: App.t("rgb.unifyTip"), onClick: () => { apply(it, { ...itemLook(it) }); draw(); } }) : null,
        mk === "custom" ? h("button", { class: "chip", text: App.t("rgb.likeRest"), title: App.t("rgb.likeRestTip"), onClick: () => { apply(it, { ...lookOf(majorityMember()) }); draw(); } }) : null,
        !it.all && !it.stored ? h("button", { class: "chip", text: it.hid ? App.t("rgb.unhide") : App.t("rgb.hide"), title: App.t("rgb.hideTip"), onClick: () => hide(it, !it.hid) }) : null,
        rel, power),
      prev,
      wants.colour ? h("div", { class: "rrow" }, h("div", { class: "rl" }, h("span", { class: "cap", text: App.t("rgb.colour") })),
        h("div", { class: "rcol" }, wheel, h("div", { class: "rcolr" }, swatches, hex))) : null,
      wants.colour2 ? c2Box : null,
      wants.bright ? h("div", { class: "rrow" }, h("div", { class: "rl" }, h("span", { class: "cap", text: App.t("rgb.brightness") }), bv), br) : null,
      fxBox,
      natBox,
      wants.dir ? dirBox : null,
      wants.speed ? spdBox : null,
      zBox);
    upd();

    // the left column keeps its automation card between redraws (an open card must not close when a card is clicked)
    if (force || !autoEl) autoEl = App.RGBAuto.card(reload);
    // hidden devices live only here, under their own heading: one compact row each, with a way back
    const hiddenDevs = st.devs.filter((x) => x.hidden);
    const hidBox = hiddenDevs.length ? h("div", { class: "rhid" },
      h("button", { class: "linkbtn rmiss", text: App.t("rgb.hidden", { n: hiddenDevs.length }) + (showHidden ? " ▴" : " ▾"), onClick: () => { showHidden = !showHidden; draw(); } }),
      showHidden ? hiddenDevs.map((d) => h("div", { class: "rdev hid" },
        h("span", { class: "rt" }, icon(d.kind), h("b", { text: d.name + (hiddenDevs.filter((x) => x.name === d.name).length > 1 ? " " + (d.nth + 1) : "") }),
          h("span", { class: "chip rshow", role: "button", text: App.t("rgb.unhide"), onClick: () => hide({ members: [d] }, false) })))) : null) : null;
    const left = h("div", { class: "rleft" }, list, hidBox, autoEl, App.RGBAuto.missingLink(st.devs));
    // redrawing in place (a click on the list must not replay the cards' entrance or lose the scroll position)
    const body = force ? null : page.querySelector(".rgb > .rbody");
    if (body) {
      const sl = body.querySelector(".rleft")?.scrollTop || 0, sd = body.querySelector(".rdetail")?.scrollTop || 0;
      list.classList.add("still");
      body.replaceChildren(left, detail);
      left.scrollTop = sl; detail.scrollTop = sd;
    } else page.replaceChildren(h("div", { class: "rgb" }, head(), App.RGBAuto.profileBar(reload), h("div", { class: "rbody" }, left, detail)));
  }

  App.RGB = {
    async render() {
      page = App.$("#v-rgb");
      let s = null;
      try { s = await api.invoke("rgb_status"); } catch (_) { /* no backend: treated as not installed */ }
      if (S.view !== "rgb") return;
      if (!s || !s.installed) gate();
      else if (!s.enabled) gate();
      else if (s.running && st.devs.length) { await App.RGBAuto.refresh(); draw(true); }
      else start();
    },
    leave() { if (mode === "advanced") App.RGBAdv.leave(); },
  };
})();
