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

  let page = null, st = { devs: [], sel: ALL }, mode = "simple", autoEl = null, hidEl = null, showHidden = false;
  const sendTimers = new Map();
  /** per device (name#nth): { hue, sat, br, on, fx, speed, c2, rev, native }, loaded from the scene the recorder keeps and saved on every change */
  const look = new Map();
  const lkey = (d) => d.name + "#" + d.nth;
  /** keys of devices Buffer drives with a look of their own; the others still show their own lighting (dim cards) */
  const driven = new Set();
  /** One scene, two views: devices placed in the Advanced view (`placed`) follow its effect (`onScene`) unless they have a
      look of their own or were given back. `sceneCol` is the effect's main colour, for their cards. */
  const placed = new Set(), onScene = new Set();
  let sceneCol = "#c6f432";
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
      if (!by.has(d.name)) by.set(d.name, { key: d.name, name: d.name, vendor: d.vendor, kind: d.kind, members: [], n: 0, stored: !!d.stored, hid: !!d.hidden, label: d.label || d.name });
      const g = by.get(d.name);
      g.members.push(d); g.n += Math.max(1, d.led_names.length);
    }
    const shown = st.devs.filter((x) => !x.hidden);
    const out = [{ key: ALL, name: App.t("rgb.all"), label: App.t("rgb.all"), members: shown, n: shown.length, all: true, kind: "all" }];
    for (const g of by.values()) {
      out.push(g);
      // a group can be opened to control its devices one by one
      if (g.members.length > 1 && open.has(g.key)) {
        for (const m of g.members) out.push({ key: lkey(m), name: `${g.name} ${m.nth + 1}`, label: m.label && m.label !== g.label ? m.label : `${g.label} ${m.nth + 1}`, vendor: g.vendor, kind: g.kind, members: [m], n: Math.max(1, m.led_names.length), child: true, stored: g.stored, hid: !!m.hidden });
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
  /** every device of the item takes its colour from the scene's effect */
  /** the members the effect can colour (the Dark Project keyboard never: it is not an OpenRGB device) */
  const fxMembers = (it) => it.members.filter((m) => !m.stored);
  /** every device of the item ("All devices": every one the effect can colour) takes its colour from the scene's effect */
  const itemScene = (it) => !it.stored && fxMembers(it).length > 0 && fxMembers(it).every((m) => onScene.has(lkey(m)));
  /** the item can follow the effect: its devices are placed on the Advanced view (for "All": at least one is) */
  const itemPlaced = (it) => (it.all ? fxMembers(it).some((m) => placed.has(lkey(m))) : !it.stored && it.members.length > 0 && it.members.every((m) => placed.has(lkey(m))));
  const itemOn = (it) => !itemDriven(it) || itemLook(it).on;

  /** Sends a device's look at most every 40 ms (a drag fires far more often), one timer per device. */
  function push(d) {
    driven.add(lkey(d)); onScene.delete(lkey(d));   // a look of its own wins over the effect
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
      if (!driven.has(lkey(m)) && !onScene.has(lkey(m))) continue;
      driven.delete(lkey(m)); look.delete(lkey(m)); onScene.delete(lkey(m));   // no look, and not the effect either
      await api.invoke("rgb_unlook", { name: m.name, nth: m.nth }).catch(toast);
    }
  }
  async function giveBack(it) { await giveBackQuiet(it); draw(); }
  /** The devices of an item follow the scene's effect again (set in the Advanced view): their own look goes. */
  async function followScene(it) {
    for (const m of fxMembers(it).filter((x) => placed.has(lkey(x)))) {
      driven.delete(lkey(m)); look.delete(lkey(m)); onScene.add(lkey(m));
      await api.invoke("rgb_follow", { name: m.name, nth: m.nth }).catch(toast);
    }
    draw();
  }

  /** Hides a device (or shows it again): it leaves the list and Buffer stops driving it. */
  async function hide(it, on) {
    if (on) await giveBackQuiet(it);
    for (const m of it.members) {
      try { await api.invoke("rgb_hide", { key: lkey(m), on }); m.hidden = on; } catch (e) { toast(e); }
    }
    if (on) st.sel = ALL;
    draw();
  }

  /** Renames a device (a group: every device in it; "" takes the original name back). The key stays the identity. */
  async function rename(it, name) {
    for (const m of it.members) {
      try { await api.invoke("rgb_rename", { key: lkey(m), name }); m.label = name || null; } catch (e) { toast(e); }
    }
    draw();
  }
  /** The title of the detail panel; a pencil turns it into a field. */
  function titleBox(it) {
    const box = h("span", { class: "rtitle" + (it.all ? "" : " tedit"), title: it.all ? null : App.t("rgb.rename") });
    const show = () => {
      box.replaceChildren(...[h("h2", { text: it.label || it.name }), it.all ? null : App.pencil()].filter(Boolean));   // replaceChildren turns null into the text "null"
      box.onclick = it.all ? null : edit;
    };
    const edit = () => {
      const inp = h("input", { class: "field rname", value: it.label || it.name, maxlength: 40, spellcheck: false, "aria-label": App.t("rgb.rename") });
      let done = false;
      const commit = (save) => { if (done) return; done = true; if (save) rename(it, inp.value.trim() === it.name ? "" : inp.value.trim()); else show(); };
      inp.onkeydown = (e) => { if (e.key === "Enter") commit(true); if (e.key === "Escape") commit(false); };
      inp.onblur = () => commit(true);
      box.onclick = null;
      box.replaceChildren(inp); inp.focus(); inp.select();
    };
    show();
    return box;
  }

  function leds(n) {
    return h("span", { class: "rleds" }, Array.from({ length: n }, (_, i) =>
      vars(h("i"), { "--o": (0.45 + 0.55 * (n > 1 ? i / (n - 1) : 1)).toFixed(2) })));
  }
  /** The strips are a drawing of the colour, not a count of the real LEDs: every device gets the same number of segments. */
  const nLeds = () => 24;

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
    const l = itemLook(it), on = itemOn(it), dr = itemDriven(it), sc = itemScene(it);
    const mk = sc ? "scene" : mark(it, ref);
    card.classList.toggle("diff", mk === "custom");
    const tag = card.querySelector(".rtag");
    if (tag) { tag.hidden = !mk; tag.textContent = mk ? App.t(mk === "scene" ? "rgb.sceneTag" : "rgb." + mk) : ""; tag.title = App.t(mk === "scene" ? "rgb.sceneTip" : mk === "custom" ? "rgb.customTip" : "rgb.mixedTip"); tag.classList.toggle("mix", mk === "mixed"); }
    card.style.setProperty("--c", sc ? sceneCol : css(l));
    card.style.setProperty("--br", sc ? 1 : on ? l.br / 100 : 0.08);
    card.classList.toggle("off", dr && !l.on);
    card.classList.toggle("idle", !dr && !sc);
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
    driven.clear(); look.clear(); placed.clear(); onScene.clear();
    for (const l of sc.simple || []) {
      look.set(l.name + "#" + (l.nth || 0), { hue: l.hue, sat: l.sat, br: l.br, on: l.on, fx: l.fx || "static", speed: l.speed || 1, c2: l.c2 || null, rev: !!l.rev, native: l.native || null });
      driven.add(l.name + "#" + (l.nth || 0));
    }
    const free = new Set(sc.free || []), layers = (sc.layers || []).filter((x) => x.on !== false);
    for (const d of sc.devices || []) if (d.link) placed.add(d.link.name + "#" + (d.link.nth || 0));
    if (layers.length) for (const k of placed) if (!free.has(k) && !driven.has(k)) onScene.add(k);
    const top = layers[layers.length - 1], st = top && top.stops;
    sceneCol = st && st.length ? st[st.length - 1].c : "#c6f432";
  }

  /** `rescan`: start OpenRGB again so it looks for hardware from scratch (a device it missed is only found that way).
   *  `again`: the user asked for that rescan from the "no devices" page; if it finds nothing too, RGB turns itself off. */
  async function start(rescan = false, again = false) {
    gate(App.t("rgb.starting"), true);
    try {
      adoptDevices(await api.invoke(rescan ? "rgb_rescan" : "rgb_start"));
      // nothing found on the first look: look once more from scratch, before the page says there is nothing
      if (!rescan && !st.devs.length) adoptDevices(await api.invoke("rgb_rescan"));
      if (again && !st.devs.length) {
        await api.invoke("rgb_stop").catch(() => {});
        if (S.view === "rgb") gate(App.t("rgb.autoOff"));
        return;
      }
      // the scene and the status do not depend on each other: ask for both at once
      const [sc, status] = await Promise.all([api.invoke("rgb_scene_get"), api.invoke("rgb_status").catch(() => null)]);
      adoptScene(sc);
      if (status) App.RGBAuto.adopt(status);
    } catch (e) { gate(String(e), false); return; }
    if (S.view !== "rgb") return;
    draw(true);
  }

  /** The scene or the profile changed outside this page (a profile was loaded): read it again and draw from scratch. */
  async function reload() {
    try {
      const [sc, status] = await Promise.all([api.invoke("rgb_scene_get"), api.invoke("rgb_status").catch(() => null)]);
      adoptScene(sc);
      if (status) App.RGBAuto.adopt(status);
    } catch (e) { toast(e); }
    draw(true);
  }

  /** Title row shared by both views: name, backend chip, Simple | Advanced switch, what needs attention. */
  function head(...extra) {
    return h("div", { class: "eqhead" }, h("h1", { text: "RGB" }), h("span", { class: "chip on", text: "OpenRGB" }),
      App.ui.segc([["simple", App.t("rgb.simple")], ["advanced", App.t("rgb.advanced")]], mode, setMode),
      h("span", { class: "sp" }), App.RGBAuto.awayChip(), App.RGBAuto.conflictChip(reload),
      h("button", { class: "chip", text: App.t("rcal.title"), title: App.t("ra.calTip"), onClick: () => App.RGBCalib.open() }), ...extra);
  }

  /** Switching also tells the recorder which view the saved scene belongs to (rgb-scene-set replaces the whole scene). */
  async function setMode(m) {
    if (m === mode) return;
    // the Advanced page's last save lands first; then the scene is read again: both views show the same one
    if (mode === "advanced") await App.RGBAdv.leave();
    mode = m;
    try {
      const sc = await api.invoke("rgb_scene_get");
      if (sc.mode !== m) await api.invoke("rgb_scene_set", { scene: { ...sc, mode: m } });
      adoptScene({ ...sc, mode: m });
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
      if (force || !autoEl) autoEl = App.RGBAuto.bar(reload, st.devs);
      page.replaceChildren(h("div", { class: "rgb" }, head(), App.RGBAuto.profileBar(reload), box, autoEl));
      App.RGBAdv.render(box);
      return;
    }
    if (!st.devs.length) {
      // a way out right here: RGB left on would start OpenRGB at every login for nothing
      const off = h("button", { class: "btn", text: App.t("rgb.turnOffRgb"), title: App.t("rgb.turnOffTip"), onClick: async (e) => {
        e.currentTarget.disabled = true;
        await api.invoke("rgb_stop").catch(() => {});
        App.toast(App.t("rgb.stopped"), "ok");
        if (S.view === "rgb") gate();
      } });
      const remove = App.ui.sure(App.t("rgb.removeApp"), App.t("rgb.removeTip"), async (b) => {
        try { await api.invoke("rgb_uninstall"); App.toast(App.t("rgb.removed"), "ok"); } catch (err) { App.toast(App.t("rgb.err", { err }), "err"); b.disabled = false; return; }
        if (S.view === "rgb") gate();
      });
      page.replaceChildren(App.emptyState(App.t("rgb.none"), App.t("rgb.noneD"), App.t("rgb.rescan"), () => start(true, true), [off, remove]));
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
        title: x.stored ? App.t("rgb.keyboardTip") : x.vendor || null },
        h("span", { class: "rt" }, icon(x.kind), h("b", { text: x.label || x.name }), group ? h("small", { class: "mono rn", text: "×" + x.members.length }) : null,
          h("span", { class: "rtag", hidden: true }), chev,
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
    // round steps (5 %, 0.1×); Shift while dragging = 1 % steps
    const br = h("input", { class: "rline", type: "range", min: 0, max: 100, step: 5, value: l.br, "aria-label": App.t("rgb.brightness") });
    const spd = h("input", { class: "rline", type: "range", min: 20, max: 300, step: 10, value: Math.round(l.speed * 100), "aria-label": App.t("rgb.speed") });
    for (const [inp, st] of [[br, 5], [spd, 10]]) {
      inp.addEventListener("pointerdown", (e) => { inp.step = e.shiftKey ? 1 : st; });
      inp.addEventListener("keydown", (e) => { inp.step = e.shiftKey ? 1 : st; });
    }
    const bv = h("span", { class: "mono rval", text: l.br + "%" });
    const sv = h("span", { class: "mono rval", text: l.speed.toFixed(1) + "×" });
    const n = 48;   // the big preview: a fixed number of thin segments, whatever the device has
    const prev = h("div", { class: "rbig" }, Array.from({ length: n }, (_, i) =>
      vars(h("i"), { "--o": (0.4 + 0.6 * (i / (n - 1))).toFixed(2), "--i": i })));
    const mk = mark(it, reference());
    const rel = h("button", { class: "chip", text: App.t("rgb.release"), title: App.t("rgb.releaseTip"), disabled: !itemDriven(it) && !itemScene(it), onClick: () => giveBack(it) });
    const power = h("button", { class: "chip" + (itemOn(it) ? " on" : ""), text: App.t(itemOn(it) ? "rgb.on" : "rgb.off"), onClick: () => { apply(it, { on: !itemOn(it) }); draw(); } });
    const cap = (k, tip) => h("div", { class: "cap", text: App.t(k), title: tip ? App.t(tip) : null });
    // addressable zones whose LED count can be set (an ARGB header: the strip or fans on it may have any length)
    const zs = it.all || it.stored ? [] : (dev0.zones || []).map((z, zi) => ({ z, zi })).filter(({ z }) => z.leds_min !== z.leds_max);
    const upd = () => {
      br.style.setProperty("--p", l.br + "%");
      spd.style.setProperty("--p", ((l.speed * 100 - 20) / 280 * 100) + "%");
      prev.className = "rbig fx-" + (l.fx === "native" ? "static" : l.fx || "static");
      prev.style.setProperty("--c", css(l)); prev.style.setProperty("--br", itemOn(it) ? l.br / 100 : 0.08);
      prev.style.setProperty("--sp", (1 / l.speed).toFixed(2));
      bv.textContent = l.br + "%"; sv.textContent = itemLook(it).speed.toFixed(1) + "×";
      rel.disabled = !itemDriven(it) && !itemScene(it);
      paintAll();
    };
    br.oninput = () => { apply(it, { br: +br.value }); upd(); };
    spd.oninput = () => { apply(it, { speed: +spd.value / 100 }); upd(); };
    // double-click puts a slider back to its default
    br.ondblclick = () => { br.value = 100; br.oninput(); };
    spd.ondblclick = () => { spd.value = 100; spd.oninput(); };
    br.title = spd.title = App.t("ra.resetTip");
    const swatches = h("div", { class: "rsw" }, SWATCHES.map((c) => vars(h("button", { "aria-label": c, onClick: () => {
      const v = App.RGBWheel.fromHex(c);
      wheel.set(v.hue, v.sat); hex.value = App.RGBWheel.toHex(v.hue, v.sat);
      apply(it, v); upd();
    } }), { "--c": c })));

    // header: icon, name (click to rename) + what differs, then every action in sight
    const tag = h("span", { class: "rtag", hidden: !mk, text: mk ? App.t("rgb." + mk) : "", title: App.t(mk === "custom" ? "rgb.customTip" : "rgb.mixedTip") });
    if (mk === "mixed") tag.classList.add("mix");
    const hd = h("div", { class: "rhd" }, icon(it.kind), titleBox(it), tag, h("span", { class: "sp" }),
      it.stored ? h("button", { class: "chip", text: App.t("rgb.configurator") + " ↗", title: App.t("rgb.configuratorTip"), onClick: () => api.invoke("open_issue_page", { url: "https://software.darkproject.eu/" }).catch(toast) }) : null,
      mk === "mixed" ? h("button", { class: "chip", text: App.t("rgb.unify"), title: App.t("rgb.unifyTip"), onClick: () => { apply(it, { ...itemLook(it) }); draw(); } }) : null,
      mk === "custom" ? h("button", { class: "chip", text: App.t("rgb.likeRest"), title: App.t("rgb.likeRestTip"), onClick: () => { apply(it, { ...lookOf(majorityMember()) }); draw(); } }) : null,
      !it.all && !it.stored ? h("button", { class: "chip", text: App.t("rgb.hide"), title: App.t("rgb.hideTip"), onClick: () => hide(it, true) }) : null,
      rel, power);

    // card "Kolor": the wheel with swatches and hex, and the second colour under it when the effect uses one
    const colourCard = wants.colour ? h("section", { class: "card2 pad rcard" }, cap("rgb.colour"),
      h("div", { class: "rcol" }, wheel, h("div", { class: "rcolr" }, swatches, hex)),
      wants.colour2 ? h("div", { class: "rcol2row" }, h("span", { class: "cap", text: App.t("rgb.colour2") }),
        l.c2 ? colour2(it, l) : h("button", { class: "chip rplus", text: "+", title: App.t("rgb.colour2"), "aria-label": App.t("rgb.colour2"), onClick: () => { apply(it, { c2: [(l.hue + 180) % 360, 90] }); draw(); } })) : null) : null;
    // card "Efekt": the plain effects, and the device's own ones as a wrapped row of chips (the active one again = plain colour)
    const scene = itemScene(it), canScene = itemPlaced(it);
    const fxSeg = App.ui.segc(FX.map((f) => [f, App.t("rgb.fx." + f)]).concat(it.stored ? [] : [["scene", App.t("rgb.fx.scene")]]),
      scene ? "scene" : l.fx === "native" ? "" : l.fx || "static", (v) => { if (v === "scene") { if (canScene) followScene(it); return; } apply(it, { fx: v, native: null }); draw(); });
    const sb = fxSeg.querySelector('[data-v="scene"], button:last-child');
    if (sb && !it.stored) { sb.title = App.t(canScene ? "rgb.sceneTip" : "rgb.sceneNoPlace"); if (!canScene) sb.disabled = true; }
    const effectCard = h("section", { class: "card2 pad rcard" }, cap("rgb.effect"),
      fxSeg,
      nat.length ? cap("rgb.native", "rgb.nativeTip") : null,
      nat.length ? h("div", { class: "rnats" }, nat.map((m) => h("button", { class: "chip" + (natMode && natMode.name === m.name ? " on" : ""),
        text: m.name + (m.flags & F.AUTOSAVE ? " ◆" : ""),
        onClick: () => { apply(it, natMode && natMode.name === m.name ? { fx: "static", native: null } : { fx: "native", native: m.name }); draw(); } }))) : null);
    // card "Ustawienia": brightness, speed, direction, LED count; only what the chosen effect understands
    const dirSeg = App.ui.segc([[false, "→"], [true, "←"]], !!l.rev, (v) => { apply(it, { rev: v }); draw(); });
    const setCard = h("section", { class: "card2 pad rset" }, cap("rgb.settings"),
      h("div", { class: "rsetg" },
        wants.bright ? h("div", { class: "rsi" }, h("div", { class: "rl" }, cap("rgb.brightness"), bv), br) : null,
        wants.speed ? h("div", { class: "rsi" }, h("div", { class: "rl" }, cap("rgb.speed"), sv), spd) : null,
        wants.dir ? h("div", { class: "rsi" }, cap("rgb.dir"), dirSeg) : null,
        ...zs.map(({ z, zi }) => h("div", { class: "rsi" }, h("div", { class: "cap", text: App.t("rgb.zones") + " · " + z.name, title: App.t("rgb.zonesTip") }),
          h("input", { class: "field rnum", type: "number", min: z.leds_min, max: z.leds_max, value: z.leds, "aria-label": z.name, onChange: async (e) => {
            const v = Math.max(z.leds_min, Math.min(z.leds_max, Math.round(+e.target.value) || z.leds));
            e.target.value = v;
            try {
              let list = null;
              for (const m of it.members) list = await api.invoke("rgb_zone", { index: m.index, zone: zi, leds: v });
              adoptDevices(list); draw();
            } catch (err) { toast(err); }
          } })))));
    // a device on the scene's effect: its colour comes from the Advanced view
    const sceneCard = scene ? h("section", { class: "card2 pad rcard" }, cap("rgb.fx.scene"), h("p", { class: "rnote", text: App.t("rgb.sceneNote") }),
      h("button", { class: "btn", text: App.t("rgb.openAdv"), onClick: () => setMode("advanced") })) : null;
    const detail = h("section", { class: "rdetail" }, hd, prev,
      scene ? h("div", { class: "rgrid2" }, sceneCard, effectCard) : h("div", { class: "rgrid2" + (colourCard ? "" : " one") }, colourCard, effectCard), scene ? null : setCard);
    upd();

    // the automation bar sits under the panel and is kept between redraws (an open pop-up must not close when a card is clicked)
    if (force || !autoEl) autoEl = App.RGBAuto.bar(reload, st.devs);
    // hidden devices live only here, under their own heading: one compact row each, with a way back
    const hiddenDevs = st.devs.filter((x) => x.hidden);
    // the hidden section is kept between redraws (rebuilt only when what it shows changes), so a click elsewhere does not touch it
    const hidSig = JSON.stringify([hiddenDevs.map((d) => [d.name, d.nth, d.label]), showHidden]);
    if (force || !hidEl || hidEl.sig !== hidSig) {
      hidEl = { sig: hidSig, el: !hiddenDevs.length ? null : h("div", { class: "rhid" },
        h("button", { class: "linkbtn rmiss", text: App.t("rgb.hidden", { n: hiddenDevs.length }) + (showHidden ? " ▴" : " ▾"), onClick: () => { showHidden = !showHidden; draw(); } }),
        showHidden ? hiddenDevs.map((d) => h("div", { class: "rdev hid" },
          h("span", { class: "rt" }, icon(d.kind), h("b", { text: (d.label || d.name) + (!d.label && hiddenDevs.filter((x) => x.name === d.name).length > 1 ? " " + (d.nth + 1) : "") }),
            h("span", { class: "chip rshow", role: "button", text: App.t("rgb.unhide"), onClick: () => hide({ members: [d] }, false) })))) : null) };
    }
    const left = h("div", { class: "rleft" }, list, hidEl.el);
    // redrawing in place (a click on the list must not replay the cards' entrance or lose the scroll position)
    const body = force ? null : page.querySelector(".rgb > .rbody");
    if (body) {
      const sl = body.querySelector(".rleft")?.scrollTop || 0, sd = body.querySelector(".rdetail")?.scrollTop || 0;
      list.classList.add("still");
      body.replaceChildren(left, detail);
      left.scrollTop = sl; detail.scrollTop = sd;
    } else page.replaceChildren(h("div", { class: "rgb" }, head(), App.RGBAuto.profileBar(reload), h("div", { class: "rbody" }, left, detail), autoEl));
  }

  App.RGB = {
    /** the line icon of an OpenRGB device kind (the Advanced page uses the same ones) */
    icon,
    /** switches the view ("simple" | "advanced"): one scene, two views */
    view: (m) => setMode(m),
    async render() {
      page = App.$("#v-rgb");
      let s = null;
      try { s = await api.invoke("rgb_status"); } catch (_) { /* no backend: treated as not installed */ }
      if (S.view !== "rgb") return;
      if (!s || !s.installed) gate();
      else if (!s.enabled) gate();
      else if (s.running && st.devs.length) { App.RGBAuto.adopt(s); try { adoptScene(await api.invoke("rgb_scene_get")); } catch (_) { /* keep */ } draw(true); }   // the scene may have changed elsewhere
      else start();
    },
    leave() { App.RGBCalib.close(); if (mode === "advanced") App.RGBAdv.leave(); },
  };
})();
