"use strict";
/* SoundSwitcher page: Buffer's EarTrumpet. Left, every playback device as a compact card (default first, then the
   chat device, then devices with apps on them) with its volume; right, the apps of the device picked on the left.
   The default device and the switch-output shortcut's cycle are set here. Volume is a smooth lime line that the
   user moves; the scan under it only shows what plays (DESIGN.md). The recorder owns the audio (`mix-*` control
   commands, the same mixer as its tray flyout); this page polls it only while it is open and visible. */

(function () {
  const { h, S, api } = App;
  const U = App.ui;
  const POLL_MS = 100;

  let page = null, list = null, detail = null, opts = null, trayBox = null;
  let timer = 0, busy = false, shapeList = "", shapeDetail = "";
  let devs = [];
  let sel = "";                     // device shown on the right
  const icons = new Map();          // icon source -> data URL ("" = none, null = loading)
  const waiting = new Map();        // icon source -> fill functions of the boxes waiting for it
  const rows = new Map();           // "dev" / "dev|app" key -> row (see volRow)
  let dragging = null;              // row key whose line is held: the poll leaves its value alone
  let sending = null, queued = null;

  const cmd = (c) => api.invoke("recorder_cmd", { cmd: c });
  const cycle = () => (App.RecUI.cfg() || {}).output_cycle || [];

  /** Volume changes go out one at a time, the latest one wins (a dragged line fires far faster than COM needs). */
  function send(patch) {
    queued = patch;
    if (sending) return;
    const next = () => {
      if (!queued) { sending = null; return; }
      const p = queued; queued = null;
      sending = cmd("mix-set " + JSON.stringify(p)).catch(() => {}).then(next);
    };
    next();
  }

  /** The tray icon's scan-line speaker; waves above the volume fade like the logo's tails. */
  const SPEAKER = (vol, muted) => {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 32 32");
    svg.setAttribute("aria-hidden", "true");
    const waves = vol <= 0 ? 0 : vol < 0.34 ? 1 : vol < 0.67 ? 2 : 3;
    const rect = (x, y, w, cls) => {
      const r = document.createElementNS(ns, "rect");
      Object.entries({ x, y, width: w, height: 3, rx: 0.6 }).forEach(([k, v]) => r.setAttribute(k, v));
      if (cls) r.setAttribute("class", cls);
      svg.append(r);
    };
    [[12, 4], [9, 7], [3, 13], [3, 13], [3, 13], [9, 7], [12, 4]].forEach(([x, w], i) => {
      rect(x, 2 + i * 4, w);
      if (!muted) [[19, 2], [23.5, 1], [28, 0]].forEach(([wx, from], n) => {
        if (i >= from && i <= 6 - from) rect(wx, 2 + i * 4, 2.5, n < waves ? "" : "tail");
      });
    });
    if (muted) {
      const p = document.createElementNS(ns, "path");
      p.setAttribute("d", "M20 10.5l10 11M30 10.5l-10 11");
      p.setAttribute("class", "x");
      svg.append(p);
    }
    return svg;
  };

  function iconOf(src, name) {
    const box = h("span", { class: "sappico" });
    const fill = () => {
      const url = icons.get(src);
      if (url) box.replaceChildren(h("img", { src: url, alt: "" }));
      else box.replaceChildren(h("b", { text: (name || "?").slice(0, 1).toUpperCase() }));
    };
    // the same app on several devices asks once; every box waiting for it is filled when it arrives
    if (src && !icons.has(src)) {
      icons.set(src, null);
      const done = (url) => { icons.set(src, url); (waiting.get(src) || []).forEach((f) => f()); waiting.delete(src); };
      cmd("mix-icon " + src).then((r) => done(r && r.ok ? "data:image/png;base64," + r.png : "")).catch(() => done(""));
    }
    if (src && icons.get(src) === null) waiting.set(src, [...(waiting.get(src) || []), fill]);
    fill();
    return box;
  }

  /** One volume row: mute button (speaker or app icon), optional name, the line with its scan, the number. */
  function volRow(key, target, opt) {
    const segs = Array.from({ length: opt.segs }, () => h("i"));
    const fillEl = h("i", { class: "f" });
    const head = h("b");
    const line = h("div", { class: "sline", role: "slider", tabindex: 0, "aria-label": opt.name, "aria-valuemin": 0, "aria-valuemax": 100 },
      h("i", { class: "t" }), fillEl, h("div", { class: "m" }, ...segs), head);
    const num = h("span", { class: "snum mono" });
    const r = { key, segs, fillEl, head, line, num, v: 0, muted: false, peak: 0, isDev: !target.app, shown: "" };
    const lead = target.app ? iconOf(opt.icon, opt.name) : h("span", { class: "spk" });
    r.lead = lead;
    const mute = h("button", { class: "smute", title: App.t("snd.mute"), "aria-label": App.t("snd.mute") + ": " + opt.name, onClick: (e) => {
      e.stopPropagation();
      send({ ...target, muted: !r.muted });
      r.muted = !r.muted; paintRow(r, r.v, r.muted, 0);
    } }, lead);
    const setV = (v) => { send({ ...target, volume: v }); r.v = v; paintRow(r, v, r.muted, r.peak); };
    const fromEvent = (e) => {
      const box = line.getBoundingClientRect();
      setV(Math.round(Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)) * 100) / 100);
    };
    line.addEventListener("pointerdown", (e) => { e.stopPropagation(); dragging = key; line.setPointerCapture(e.pointerId); line.classList.add("drag"); fromEvent(e); });
    line.addEventListener("pointermove", (e) => { if (dragging === key) fromEvent(e); });
    const release = () => { if (dragging === key) dragging = null; line.classList.remove("drag"); };
    line.addEventListener("pointerup", release);
    line.addEventListener("pointercancel", release);
    line.addEventListener("click", (e) => e.stopPropagation());
    // 5 % per wheel notch, snapped to the grid (as the tray icon)
    line.addEventListener("wheel", (e) => {
      e.preventDefault();
      setV(Math.min(1, Math.max(0, (Math.round(r.v * 20) + (e.deltaY < 0 ? 1 : -1)) * 0.05)));
    }, { passive: false });
    line.addEventListener("keydown", (e) => {
      const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (!d) return;
      e.preventDefault();
      setV(Math.min(1, Math.max(0, (Math.round(r.v * 20) + d) * 0.05)));
    });
    r.wrap = h("div", { class: "svrow" + (opt.named ? " named" : "") }, mute, opt.named ? h("span", { class: "sname", text: opt.name, title: opt.name }) : null, line, num);
    rows.set(key, r);
    return r;
  }

  function paintRow(r, v, muted, peak) {
    const pct = `${(v * 100).toFixed(2)}%`;
    r.fillEl.style.width = pct;
    r.head.style.left = pct;
    const level = muted ? 0 : v * peak;
    const n = r.segs.length;
    r.segs.forEach((el, i) => {
      const f = (i + 0.5) / n;
      el.style.opacity = f <= level ? (0.45 + 0.55 * f).toFixed(2) : "0.08";
    });
    r.line.setAttribute("aria-valuenow", Math.round(v * 100));
    r.num.textContent = String(Math.round(v * 100));
    r.wrap.classList.toggle("muted", muted);
    const look = `${muted}|${v <= 0 ? 0 : v < 0.34 ? 1 : v < 0.67 ? 2 : 3}`;
    if (r.isDev && r.shown !== look) {
      r.shown = look;
      r.lead.replaceChildren(SPEAKER(v, muted));
    }
  }

  async function setDefault(id) {
    await cmd("mix-default " + id).catch(() => {});
    shapeList = "";
    poll();
  }

  async function toggleCycle(id) {
    await App.RecUI.ensureLoaded();
    const cur = cycle();
    await App.RecUI.save({ output_cycle: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
    shapeList = "";
    poll();
  }

  /** "Firefox, SignalRGB +2": what plays on a device, for its card. */
  const appsText = (d) => {
    const names = d.apps.filter((a) => a.key !== "#system").map((a) => a.name);
    if (!names.length) return d.apps.length ? d.apps[0].name : App.t("snd.noApps");
    return names.slice(0, 2).join(", ") + (names.length > 2 ? ` +${names.length - 2}` : "");
  };

  /** The device cards on the left (rebuilt when a device, the default, the chat device or the cycle changes). */
  function buildList() {
    const cyc = cycle();
    const hid = hiddenIds();
    for (const k of [...rows.keys()]) if (!k.includes("|")) rows.delete(k);
    // a hidden device (never the default) is folded away under the visible ones
    const shown = devs.filter((d) => d.default || !hid.includes(d.id));
    const folded = devs.filter((d) => !d.default && hid.includes(d.id));
    const cards = shown.map((d) => {
      const master = volRow(d.id, { dev: d.id }, { segs: 24, name: d.name });
      const card = h("div", { class: "card2 scard" + (d.id === sel ? " sel" : "") + (d.default ? " def" : ""), tabindex: 0,
        onClick: () => { if (sel !== d.id) { sel = d.id; shapeDetail = ""; buildList(); buildDetail(); } },
        onKeydown: (e) => { if (e.key === "Enter" && e.target === e.currentTarget) e.currentTarget.click(); } },
        h("div", { class: "shead" },
          h("b", { text: d.name, title: d.name }),
          d.comms ? h("span", { class: "chip", text: App.t("snd.chat") }) : null,
          d.default ? h("span", { class: "chip on", text: App.t("snd.default") }) : null),
        master.wrap,
        h("div", { class: "sfoot" },
          h("span", { class: "sapps", text: appsText(d) }),
          d.default ? null : h("button", { class: "chip click", text: App.t("snd.hide"), title: App.t("snd.hideTip"),
            onClick: (e) => { e.stopPropagation(); setHidden(d.id, true); } }),
          h("button", { class: "chip click" + (cyc.includes(d.id) ? " on" : ""), text: App.t("snd.cycle"), title: App.t("key.cycleTip"),
            onClick: (e) => { e.stopPropagation(); toggleCycle(d.id); } })));
      return card;
    });
    const fold = folded.length ? h("div", { class: "sfold" + (showHidden ? " open" : "") },
      h("button", { class: "sfoldbtn", onClick: () => { showHidden = !showHidden; buildList(); } },
        h("span", { class: "cap", text: App.t("snd.hidden", { n: folded.length }) }), h("span", { class: "chev", text: showHidden ? "▾" : "▸" })),
      showHidden ? folded.map((d) => h("div", { class: "shid" },
        h("span", { text: d.name, title: d.name }),
        h("button", { class: "chip click", text: App.t("snd.show"), onClick: () => setHidden(d.id, false) }))) : null) : null;
    list.replaceChildren(...cards, ...(fold ? [fold] : []));
    paintValues();
  }

  const hiddenIds = () => (App.RecUI.cfg() || {}).hidden_outputs || [];
  let showHidden = false;

  async function setHidden(id, hide) {
    await App.RecUI.ensureLoaded();
    const cur = hiddenIds();
    await App.RecUI.save({ hidden_outputs: hide ? [...new Set([...cur, id])] : cur.filter((x) => x !== id) });
    if (hide && sel === id) sel = "";
    shapeList = shapeDetail = "";
    poll();
  }

  /** The apps of the selected device on the right. */
  function buildDetail() {
    const d = devs.find((x) => x.id === sel);
    for (const k of [...rows.keys()]) if (k.includes("|")) rows.delete(k);
    if (!d) { detail.replaceChildren(); return; }
    const apps = d.apps.map((a) => volRow(d.id + "|" + a.key, { dev: d.id, app: a.key }, { segs: 40, name: a.name, icon: a.icon, named: true }).wrap);
    detail.replaceChildren(
      h("div", { class: "sdhead" },
        h("h2", { text: d.name, title: d.name }),
        d.default ? h("span", { class: "chip on", text: App.t("snd.default") })
          : h("button", { class: "btn sm", text: App.t("snd.makeDefault"), onClick: () => setDefault(d.id) }),
        h("span", { class: "sp" }),
        h("span", { class: "cap", text: App.t("snd.apps", { n: d.apps.length }) })),
      apps.length ? h("div", { class: "sdapps" }, ...apps) : h("div", { class: "muted sempty", text: App.t("snd.noApps") }));
    paintValues();
  }

  function paintValues() {
    for (const d of devs) {
      const m = rows.get(d.id);
      if (m) { if (dragging !== m.key) m.v = d.volume; m.muted = d.muted; m.peak = d.peak; paintRow(m, m.v, d.muted, d.peak); }
      for (const a of d.apps) {
        const r = rows.get(d.id + "|" + a.key);
        if (r) { if (dragging !== r.key) r.v = a.volume; r.muted = a.muted; r.peak = a.peak; paintRow(r, r.v, a.muted, a.peak); }
      }
    }
  }

  async function poll() {
    // a minimised or covered window shows nothing: don't make the recorder enumerate devices for it
    if (busy || S.view !== "snd" || document.hidden) return;
    busy = true;
    try {
      const r = await cmd("mix-get").catch(() => null);
      if (S.view !== "snd") return;
      if (!r || !r.ok) { noRecorder(); return; }
      devs = r.devices;
      const hid = hiddenIds();
      if (!devs.some((d) => d.id === sel && (d.default || !hid.includes(d.id)))) sel = (devs.find((d) => d.default) || devs[0] || {}).id || "";
      const sl = JSON.stringify([sel, cycle(), hid, showHidden, devs.map((d) => [d.id, d.name, d.default, d.comms, appsText(d)])]);
      const sd = JSON.stringify([sel, (devs.find((d) => d.id === sel) || { apps: [] }).apps.map((a) => a.key), devs.find((d) => d.id === sel)?.default]);
      const newList = sl !== shapeList, newDetail = sd !== shapeDetail;
      if (newList) { shapeList = sl; buildList(); }
      if (newDetail) { shapeDetail = sd; buildDetail(); }
      if (!newList && !newDetail) paintValues();
    } finally { busy = false; }
  }

  function noRecorder() {
    stop();
    page.replaceChildren(App.emptyState(App.t("eq.noRec"), App.t("eq.noRecD"), App.t("eq.startRec"), async () => {
      await api.invoke("recorder_launch").catch(() => {});
      setTimeout(() => App.Sound.render(), 1500);
    }));
  }

  /** The tray icon's switch sits where the EQ page has its on/off switch; the shortcut card closes the list. */
  async function drawOpts() {
    await App.RecUI.ensureLoaded();
    const cfg = App.RecUI.cfg();
    trayBox.replaceChildren(h("label", { class: "eqmaster", title: App.t("beh.audioTrayD") }, h("span", { text: App.t("beh.audioTray") }),
      h("span", { class: "toggle" + (cfg.audio_tray !== false ? " on" : ""), onClick: async () => {
        await App.RecUI.save({ audio_tray: cfg.audio_tray === false }); drawOpts();
      } })));
    const keyRow = (label, tip, field) => {
      const f = App.RecUI.hotkeyField(cfg[field] || "", async (c) => { await App.RecUI.save({ [field]: c }); drawOpts(); });
      const row = U.srow(App.t(label), h("div", { class: "pathrow" }, f));
      row.title = App.t(tip);
      return row;
    };
    const toggle = (label, desc, field, def) => U.trow(App.t(label), App.t(desc), cfg[field] ?? def,
      async (v) => { await App.RecUI.save({ [field]: v }); drawOpts(); });
    opts.replaceChildren(
      keyRow("key.output", "key.outputTip", "output_hotkey"),
      keyRow("key.mic", "key.micTip", "mic_hotkey"),
      h("div", { class: "tgl" },
        toggle("snd.notify", "snd.notifyD", "output_popup", true),
        toggle("snd.keepVol", "snd.keepVolD", "keep_volume", false)));
  }

  document.addEventListener("visibilitychange", () => { if (!document.hidden && timer) poll(); });

  function stop() { clearInterval(timer); timer = 0; dragging = null; }

  App.Sound = {
    async render() {
      page = App.$("#v-snd");
      stop();
      shapeList = shapeDetail = "";
      list = h("div", { class: "slist" });
      opts = h("div", { class: "card2 sopts" });
      detail = h("section", { class: "card2 sdetail" });
      trayBox = h("div", { class: "strayopt" });
      page.replaceChildren(h("div", { class: "snd" },
        h("div", { class: "eqhead" }, h("h1", { text: "SoundSwitcher" }), h("span", { class: "sp" }), trayBox),
        h("div", { class: "sbody" }, h("div", { class: "sleft" }, list, opts), detail)));
      await App.RecUI.ensureLoaded().catch(() => {});
      drawOpts();
      await poll();
      if (S.view === "snd" && !timer && list.isConnected) timer = setInterval(poll, POLL_MS);
    },
    leave: stop,
  };
})();
