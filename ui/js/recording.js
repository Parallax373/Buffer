"use strict";
/* Settings → Nagrywanie and the first-run setup wizard (design: "Settings regroup + Setup wizard"). */

App.RecUI = (function () {
  const { h, S, api } = App;
  const U = App.ui;
  const FOLLOW = "@default";            // "whatever Windows currently uses" (speakers, headset…)
  const SRC = [
    ["game", "Game", "src.game", "render", "#1fb89a", "src.gameTip"],
    ["chat", "Chat", "src.chat", "render", "#4a9ae0", "src.chatTip"],
    ["mic", "Mic", "src.mic", "capture", "#e0a23a", "src.micTip"],
  ];
  const CHAT_APPS = () => [["", App.t("chat.none")], ["discord", "Discord"], ["teamspeak", "TeamSpeak"], ["ts3client_win64", "TeamSpeak 3"],
    ["teams", "Microsoft Teams"], ["zoom", "Zoom"], ["telegram", "Telegram"], ["skype", "Skype"]];
  const BASE = {
    output_dir: "", per_game_folders: true, post_roll_seconds: 15, game_only: false, follow_game_monitor: true, chat_app: "",
    buffer_seconds: 120, fps: 30, width: 1920, video_kbps: 14000, quality: "std", monitor: 0,
    encoder: "auto", audio_offset_ms: 0, hotkey: "Alt+Q", marker_hotkey: "Alt+M", record_hotkey: "Alt+R", popup: true, extra_games: [], ignore_apps: [],
    game: { primary: null, secondary: null }, chat: { primary: null, secondary: null }, mic: { primary: null, secondary: null },
  };
  const RES = () => [[1280, "720p"], [1920, "1080p"], [2560, "1440p"], [0, App.t("res.native")]];
  const FPS = [[30, "30 fps"], [60, "60 fps"]];
  const QUAL = () => [["low", App.t("qual.low")], ["std", App.t("qual.std")], ["high", App.t("qual.high")]];
  const QUAL_FACTOR = { low: 0.55, std: 1, high: 1.4 };
  // Old configs stored an absolute bitrate; map the three known values to a level, keep anything else as "custom".
  const LEGACY_QUAL = { 8000: "low", 14000: "std", 30000: "high" };
  const LEN = () => [[30, App.t("unit.s", { n: 30 })], [60, App.t("unit.min", { n: 1 })], [120, App.t("unit.min", { n: 2 })], [300, App.t("unit.min", { n: 5 })]];
  const POST_ROLL = () => [[0, App.t("roll.now")], ...[15, 30, 60].map((n) => [n, App.t("unit.s", { n })])];
  const PRESETS = [
    ["eco", "pre.eco", "pre.ecoD", { width: 1920, fps: 30, quality: "std" }, "1080p · 30 fps"],
    ["bal", "pre.bal", "pre.balD", { width: 2560, fps: 30, quality: "high" }, "1440p · 30 fps"],
    ["max", "pre.max", "pre.maxD", { width: 0, fps: 60, quality: "high" }, null],
  ];

  let cfg = { ...BASE };
  let devices = { render: [], capture: [], default: {} };
  let monitors = [];
  let autostart = false;
  let tools = null;
  let meterTimer = 0;
  let openKey = null;               // which audio row is expanded
  let advOpen = false;

  const nameOf = (list, id) => (list.find((d) => d.id === id) || {}).name || "";
  const fmtBuf = (s) => `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;
  const fmtMb = (mb) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** replaceChildren that skips null/false (a bare null would be printed as the text "null"). */
  const put = (el, ...kids) => el.replaceChildren(...kids.filter((k) => k != null && k !== false));

  async function load() {
    const [c, d, m, a, dir, t] = await Promise.all([
      api.invoke("recorder_config").catch(() => ({})),
      api.invoke("recorder_devices").catch(() => ({ render: [], capture: [], default: {} })),
      api.invoke("recorder_monitors").catch(() => []),
      api.invoke("recorder_autostart", { enable: null }).catch(() => false),
      api.invoke("default_clips_dir").catch(() => ""),
      api.invoke("tools_status").catch(() => null),
    ]);
    cfg = { ...BASE, output_dir: dir, ...c };
    if (c.quality === undefined) cfg.quality = LEGACY_QUAL[cfg.video_kbps] || "";
    for (const [k] of SRC) cfg[k] = { primary: null, secondary: null, ...(c[k] || {}) };
    devices = { render: [], capture: [], default: {}, ...d };
    monitors = m; autostart = a; tools = t;
  }

  async function save(patch, hint = "") {
    cfg = { ...cfg, ...patch };
    // an empty "backup" placeholder (shown but never filled in) must not be persisted
    const clean = JSON.parse(JSON.stringify(cfg));
    for (const [k] of SRC) if (clean[k].secondary && !clean[k].secondary.id) clean[k].secondary = null;
    await api.invoke("set_recorder_config", { config: clean });
    if (S.recorder) {
      await api.invoke("recorder_cmd", { cmd: "reload" }).catch(() => {});
      if (hint) App.toast(hint);
    }
    App.Rec.refresh();
  }

  /* ───────────── shared pieces ───────────── */

  const defaultFor = (kind, key) =>
    kind === "capture" ? devices.default.capture : key === "chat" ? devices.default.communications : devices.default.render;

  /* A binding is a comma-separated list with at most one entry per kind: keyboard ("Alt+Q"),
     mouse ("Mouse4", "Ctrl+Mouse5") and gamepad chord ("Pad:View+RB"). Rust (input.rs) reads the same text. */
  const PAD_NAMES = ["A", "B", "X", "Y", "LB", "RB", "LT", "RT", "View", "Menu", "L3", "R3", "Up", "Down", "Left", "Right"];
  const kindOf = (t) => (t.startsWith("Pad:") ? "pad" : /Mouse\d/.test(t) ? "mouse" : "key");
  const bindParts = (v) => String(v || "").split(",").map((x) => x.trim()).filter(Boolean);
  const bindText = (v) => bindParts(v).map((t) => t.replace(/^Pad:/, "🎮 ").replaceAll("+", " + ")).join("   ·   ");

  /** Field that records the next keyboard shortcut, mouse button or gamepad chord. A new input replaces
      the entry of its own kind; Delete clears it (a required binding falls back to `fallback`).
      `onSet(binding, keyboardChanged)`: keyboard combos need a recorder restart, mouse and pad apply at once. */
  const hotkeyField = (value, onSet, fallback) => {
    let cur = String(value || "");
    const set = (kind, token) => {
      cur = [...bindParts(cur).filter((t) => kindOf(t) !== kind), ...(token ? [token] : [])].join(", ");
      input.value = bindText(cur);
      onSet(cur, kind === "key");
    };
    let padTimer = 0;
    const stopPad = () => { clearInterval(padTimer); padTimer = 0; };
    const modsOf = (e) => [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Win"].filter(Boolean);
    const input = h("input", { class: "field keyfield", value: bindText(cur), readOnly: true,
      placeholder: App.t("hk.ph"), title: App.t("hk.tip"),
      onBlur: stopPad,
      onFocus: () => {
        stopPad();
        let peak = 0, seen = 0;
        const bits = (x) => x.toString(2).replaceAll("0", "").length;
        padTimer = setInterval(() => {
          const pad = [...(navigator.getGamepads?.() || [])].find((g) => g && g.connected);
          const mask = pad ? pad.buttons.slice(0, 16).reduce((m, b, i) => (b.pressed ? m | (1 << i) : m), 0) : 0;
          if (bits(mask) > bits(peak)) peak = mask;
          if (mask) { seen = Date.now(); return; }
          if (peak && Date.now() - seen > 80) {
            if (bits(peak) >= 2) set("pad", "Pad:" + PAD_NAMES.filter((_, i) => peak & (1 << i)).join("+"));
            else App.toast(App.t("hk.pad2"), "err");
            peak = 0;
          }
        }, 40);
      },
      onKeydown: (e) => {
        e.preventDefault();
        if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
        if (e.key === "Delete" || e.key === "Backspace") {
          cur = "";
          input.value = bindText(cur);
          onSet(cur, true);
          return;
        }
        const mods = modsOf(e);
        if (!mods.length) { App.toast(App.t("hk.needMod"), "err"); return; }
        const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
        if (!/^([A-Z0-9]|F([1-9]|1\d|2[0-4]))$/.test(k)) { App.toast(App.t("hk.allowed"), "err"); return; }
        set("key", [...mods, k].join("+"));
      },
      onMousedown: (e) => {
        if (e.button === 0 || e.button === 2) return;         // left / right click only focus the field
        e.preventDefault();
        const mods = modsOf(e);
        if (e.button === 1 && !mods.length) { App.toast(App.t("hk.midMod"), "err"); return; }
        set("mouse", [...mods, "Mouse" + ({ 1: 3, 3: 4, 4: 5 })[e.button]].join("+"));
      },
      // the browser would also navigate back / forward on the side buttons
      onMouseup: (e) => { if (e.button >= 1) e.preventDefault(); },
      onAuxclick: (e) => e.preventDefault() });
    return input;
  };

  /** Select of devices; `allowNone` adds an empty choice (used for the optional backup device). */
  function deviceSelect(key, kind, cur, onPick, allowNone) {
    const list = kind === "render" ? devices.render : devices.capture;
    const defName = nameOf(list, defaultFor(kind, key));
    const real = cur && cur.id && cur.id !== FOLLOW;
    const match = real && list.find((d) => d.id === cur.id || d.name.toLowerCase() === (cur.name || "").toLowerCase());
    const opts = [];
    if (allowNone) opts.push(h("option", { value: "", text: App.t("dev.pick"), selected: !cur || !cur.id }));
    opts.push(h("option", { value: FOLLOW, selected: !!cur && cur.id === FOLLOW,
      text: App.t("dev.default") + (defName ? " " + App.t("dev.now", { name: defName }) : "") }));
    if (real && !match) opts.push(h("option", { value: cur.id, text: App.t("dev.gone", { name: cur.name }), selected: true }));
    for (const d of list) opts.push(h("option", { value: d.id, text: d.name, selected: !!match && match.id === d.id }));
    return h("select", { class: "field", onChange: (e) => {
      const v = e.target.value;
      if (!v) return onPick(null);
      if (v === FOLLOW) return onPick({ id: FOLLOW, name: App.t("dev.default") });
      const d = list.find((x) => x.id === v);
      onPick(d ? { id: d.id, name: d.name } : cur);
    } }, opts);
  }

  /** Do the game and chat tracks currently resolve to the same playback device? */
  function sharedOutput(c = cfg) {
    const idOf = (key) => {
      const p = c[key].primary;
      if (!p || !p.id) return "";
      if (p.id !== FOLLOW) return p.id;
      return key === "chat" ? devices.default.communications : devices.default.render;
    };
    const g = idOf("game"), ch = idOf("chat");
    return !!g && g === ch;
  }

  /** Name of the device a source will use, plus a short note when something needs attention. */
  function deviceLabel(c, key, kind) {
    const list = kind === "render" ? devices.render : devices.capture;
    if (key === "chat" && c.chat_app) return { text: App.t("dev.sep", { app: c.chat_app }), note: "" };
    const p = c[key].primary;
    let text = App.t("dev.unset");
    if (p && p.id === FOLLOW) text = nameOf(list, defaultFor(kind, key)) || App.t("dev.winDef");
    else if (p && p.name) text = p.name;
    let note = "";
    if (key === "game" && c.chat_app) note = App.t("dev.noChat");
    if (key === "chat" && !c.chat_app && sharedOutput(c)) note = App.t("dev.shared");
    return { text, note };
  }

  /** 10-bar live level meter; `big` = wizard size. */
  const meterEl = (color, big) => h("span", { class: "mtr" + (big ? " big" : "") },
    Array.from({ length: 10 }, (_, j) => h("i", { style: { height: `${35 + ((j + 1) / 10) * 65}%`, background: color } })));
  const paintMeter = (el, level) => {
    const lv = Math.min(1, level * 1.4);
    [...el.children].forEach((b, j) => { b.style.opacity = lv * 0.9 + 0.1 > (j + 1) / 10 ? 0.95 : 0.15; });
  };

  /** Tokens for the level meter of each source (works with or without the recorder running). */
  function meterTokens(c) {
    return SRC.map(([key, , , kind]) => {
      if (c.chat_app && key === "chat") return "@app:" + c.chat_app;
      if (c.chat_app && key === "game") return "@appx:" + c.chat_app;
      const p = c[key].primary;
      if (!p || !p.id) return "";
      if (p.id !== FOLLOW) return p.id;
      return kind === "capture" ? "@default:capture" : key === "chat" ? "@default:comm" : "@default:render";
    });
  }

  /** Polls levels and paints `[data-src] .mtr` under `rootSel`; `ms` = measuring window, `gap` = pause between rounds. */
  function pollMeters(getCfg, rootSel, ms, gap) {
    clearTimeout(meterTimer);
    let alive = true;
    const run = async () => {
      const rows = [...document.querySelectorAll(`${rootSel} [data-src]`)];
      if (!alive || !rows.length) return;
      const ids = meterTokens(getCfg());
      const levels = await api.invoke("recorder_levels", { ids: ids.filter(Boolean), ms }).catch(() => ({}));
      if (!alive) return;
      for (const row of rows) {
        const i = SRC.findIndex((s) => s[1] === row.dataset.src);
        const m = row.querySelector(".mtr");
        if (m) paintMeter(m, levels[ids[i]] ?? 0);
      }
      meterTimer = setTimeout(run, gap);
    };
    run();
    return () => { alive = false; clearTimeout(meterTimer); };
  }

  /* ───────────── video: rows, sizes ───────────── */

  function outputSize(c) {
    const mon = monitors.find((m) => m.index === c.monitor) || monitors[0] || { width: 1920, height: 1080 };
    const w = c.width > 0 ? Math.min(c.width, mon.width) : mon.width;
    return [w, Math.round((mon.height * w) / mon.width / 2) * 2];
  }

  /** Same formula as ml-core::bitrate::recording_kbps (a Rust test pins its values). */
  function videoKbps(c, w, hgt) {
    if (!QUAL_FACTOR[c.quality]) return c.video_kbps;     // custom absolute value
    const k = 14000 * Math.pow((w * hgt) / (1920 * 804), 0.75) * Math.pow(c.fps / 30, 0.77) * QUAL_FACTOR[c.quality];
    return Math.min(120000, Math.max(2000, Math.round(k)));
  }

  function estimates(c) {
    const [w, hgt] = outputSize(c);
    const kbps = videoKbps(c, w, hgt);
    const clipMb = ((kbps + 3 * 192) * c.buffer_seconds) / 8000;
    const diskMb = clipMb * (1 + 8 / c.buffer_seconds);                  // plus the segments being written
    const ramMb = 200 + 170 * ((w * hgt * c.fps) / (1920 * 804 * 30));   // calibrated on one measurement (367 MB @ 1080p30)
    return { w, hgt, kbps, clipMb, diskMb, ramMb };
  }

  /** "1: PHL 34M2C8600 · 3440×1440 ★ · po lewej" — the name and the side tell identical screens apart. */
  function monitorLabel(m) {
    const prim = monitors.find((x) => x.primary) || monitors[0];
    let side = "";
    if (prim && m.index !== prim.index) {
      const dx = m.left - prim.left, dy = m.top - prim.top;
      side = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? App.t("mon.left") : App.t("mon.right")) : (dy < 0 ? App.t("mon.above") : App.t("mon.below"));
    }
    const generic = !m.name || /generic|pnp|default monitor/i.test(m.name);
    return [`${m.index + 1}`, generic ? App.t("mon.generic") : m.name.replace(/\s*\(.*\)\s*$/, "")].join(": ") + ` · ${m.width}×${m.height}${m.primary ? " ★" : ""}${side ? " · " + side : ""}`;
  }

  const ENCODERS = () => [["auto", App.t("enc.auto")], ["h264_nvenc", "NVIDIA"], ["h264_amf", "AMD"], ["h264_qsv", "Intel"], ["libx264", App.t("enc.cpu")]];
  /** Will the video be encoded on the GPU? Honors the encoder picked in Settings, else the detected one. */
  const hw = () => {
    const e = cfg.encoder && cfg.encoder !== "auto" ? cfg.encoder : tools && tools.encoder;
    return !!(e && e !== "libx264");
  };

  /** The five video rows; `set(patch)` applies a change. Used by Settings and by the wizard's "Dostosuj". */
  function videoRows(c, set) {
    const customQ = !QUAL_FACTOR[c.quality];
    const rows = [
      U.srow(App.t("v.res"), U.segc(RES(), c.width, (v) => set({ width: +v }))),
      U.srow(App.t("v.fps"), U.segc(FPS, c.fps, (v) => set({ fps: +v }))),
      U.srow(App.t("v.quality"), U.segc([...QUAL(), ...(customQ ? [["", App.t("v.custom", { n: c.video_kbps / 1000 })]] : [])], c.quality || "", (v) => { if (v) set({ quality: v }); })),
      U.srow(App.t("v.len"), U.segc(LEN(), c.buffer_seconds, (v) => set({ buffer_seconds: +v }))),
    ];
    if (monitors.length) {
      rows.push(U.srow(App.t("v.screen"), h("div", { class: "screenrow" },
        U.segc(monitors.map((m) => [m.index, monitorLabel(m)]), c.monitor, (v) => set({ monitor: +v })),
        monitors.length > 1 ? h("button", { class: "linkbtn", text: App.t("v.identify"), title: App.t("v.identifyTip"),
          onClick: () => api.invoke("identify_monitors").catch(() => {}) }) : null)));
    }
    return rows;
  }

  const bars20 = (v, max) => {
    const n = Math.round(Math.min(1, v / max) * 20);
    return Array.from({ length: 20 }, (_, i) => (i < n ? 0.35 + (i / 20) * 0.65 : 0.12));
  };

  /** Sticky "Co to zajmie" card; call update(c) after any video change. */
  let sumLoadEl = null;          // the "Load" value of the summary card; paint() fills it with live numbers
  function summaryCard() {
    const defs = [[App.t("sum.clip"), 500], [App.t("sum.disk"), 700], [App.t("sum.ram"), 1400]];
    const refs = defs.map(([label]) => ({
      val: h("span", { class: "sv" }),
      bars: Array.from({ length: 20 }, () => h("i")),
      note: h("div", { class: "sn" }),
      label,
    }));
    const loadEl = h("span", { class: "mono lime", style: { fontWeight: 600 } });
    const capEl = h("div", { class: "sc" });
    const el = h("div", { class: "sumside" }, U.cap(App.t("sum.cap")),
      ...refs.map((r) => h("div", null,
        h("div", { class: "sh" }, h("b", { text: r.label }), r.val),
        h("div", { class: "sb" }, r.bars), r.note)),
      h("div", { class: "sl", title: App.t("sum.loadTip") }, h("b", { text: App.t("sum.load") }), loadEl), capEl);
    sumLoadEl = loadEl;
    const update = (c) => {
      const e = estimates(c);
      const vals = [e.clipMb, e.diskMb, e.ramMb];
      const notes = [
        e.clipMb <= 10 ? App.t("sum.d10") : e.clipMb <= 50 ? App.t("sum.d50")
          : e.clipMb <= 500 ? App.t("sum.d500") : App.t("sum.big"),
        App.t("sum.temp"), App.t("sum.est")];
      refs.forEach((r, i) => {
        r.val.textContent = (i === 2 ? "≈ " : "") + fmtMb(vals[i]);
        bars20(vals[i], defs[i][1]).forEach((o, j) => { r.bars[j].style.opacity = o; });
        r.note.textContent = notes[i];
      });
      loadEl.textContent = hw() ? "GPU" : "CPU";
      capEl.textContent = App.t("sum.caption", { w: e.w, h: e.hgt, fps: c.fps, size: fmtMb(e.clipMb * 10) });
    };
    update(cfg);
    return { el, update };
  }

  /* ───────────── Settings → Nagrywanie ───────────── */

  async function renderTab(pane) {
    await load();
    const sum = summaryCard();

    // sticky status bar
    const dot = h("span", { class: "sdot" });
    const title = h("b", { text: "…" });
    const line = h("div", { class: "mono muted", style: { fontSize: "11.5px" } });
    const saveBtn = h("button", { class: "btn acc", text: App.t("rec.save"), onClick: async () => {
      try {
        const r = await api.invoke("recorder_cmd", { cmd: "save" });
        if (r.ok) { App.toast(App.t("rec.savedToast", { name: App.baseName(r.path) }), "ok"); setTimeout(() => App.Lib.load(), 800); }
        else App.toast(App.t("rec.notSaved", { err: r.error }), "err");
      } catch (e) { App.toast(App.t("rec.notRunning", { err: e }), "err"); }
    } });
    const toggleBtn = h("button", { class: "btn", onClick: async () => {
      if (S.recorder) await api.invoke("recorder_cmd", { cmd: "quit" }).catch(() => {});
      else await api.invoke("recorder_launch").catch((e) => App.toast(String(e), "err"));
      setTimeout(App.Rec.refresh, 1500);
    } });
    const longBtn = h("button", { class: "btn", title: App.t("long.tip"),
      onClick: async () => {
        const on = !!(S.recorder && S.recorder.long && S.recorder.long.active);
        await api.invoke("recorder_cmd", { cmd: on ? "record-stop" : "record-start" }).catch((e) => App.toast(App.t("rec.notRunning", { err: e }), "err"));
        setTimeout(App.Rec.refresh, 300);
      } });
    const bar = h("div", { class: "statusbar", id: "recState" }, dot, h("div", null, title, line), h("span", { class: "sp" }), longBtn, saveBtn, toggleBtn);
    bar._refs = { dot, title, line, saveBtn, toggleBtn, longBtn };

    // WIDEO
    const videoBox = h("div", { class: "card2" });
    const drawVideo = () => {
      videoBox.replaceChildren(...videoRows(cfg, (patch) => { save(patch); drawVideo(); sum.update(cfg); }));
    };
    drawVideo();

    // DŹWIĘK
    const audioBox = h("div", { class: "card2 audio", id: "recSources" });
    const persistSources = () => save({ game: cfg.game, chat: cfg.chat, mic: cfg.mic, chat_app: cfg.chat_app });
    const drawAudio = () => {
      audioBox.replaceChildren(...SRC.map(([key, name, label, kind, color, tip]) => {
        const open = openKey === key;
        const dev = deviceLabel(cfg, key, kind);
        const head = h("div", { class: "arow", onClick: () => { openKey = open ? null : key; drawAudio(); } },
          h("span", { class: "sq", style: { background: color } }),
          h("b", { text: App.t(label), title: App.t(tip) }),
          h("span", { class: "dev" }, dev.text, dev.note ? h("em", { text: dev.note }) : null),
          meterEl(color, false),
          h("span", { class: "arr", text: open ? "▴" : "▾" }));
        let body = null;
        if (open) {
          const c = cfg[key];
          body = h("div", { class: "abody" },
            deviceSelect(key, kind, c.primary, (v) => { cfg[key] = { ...cfg[key], primary: v }; persistSources(); drawAudio(); }, false),
            c.secondary
              ? h("div", { class: "pathrow", title: App.t("aud.backupTip") },
                deviceSelect(key, kind, c.secondary, (v) => { cfg[key] = { ...cfg[key], secondary: v }; persistSources(); drawAudio(); }, true),
                h("button", { class: "btn ghost", text: "✕", title: App.t("aud.backupRemove"), onClick: () => { cfg[key] = { ...cfg[key], secondary: null }; persistSources(); drawAudio(); } }))
              : h("button", { class: "linkbtn", text: App.t("aud.backup"), title: App.t("aud.backupTip"),
                onClick: () => { cfg[key] = { ...cfg[key], secondary: { id: "", name: "" } }; drawAudio(); } }),
            key === "chat" && (sharedOutput() || cfg.chat_app)
              ? h("div", { class: "srow", title: App.t("aud.chatAppTip") },
                h("span", { class: "lb", text: App.t("aud.chatApp") }),
                h("select", { class: "field", onChange: (e) => { cfg.chat_app = e.target.value; persistSources(); drawAudio(); } },
                  CHAT_APPS().map(([v, t]) => h("option", { value: v, text: t, selected: (cfg.chat_app || "") === v }))))
              : null);
        }
        return h("div", { class: "aitem", "data-src": name }, head, body);
      }));
      pollMeters(() => cfg, "#recSources", 350, 350);
    };
    drawAudio();

    // SKRÓTY
    const keysBox = h("div", { class: "card2" });
    /** One shortcut row: the capture field plus a clear button once something is set ("no shortcut" is allowed). */
    const keyRow = (label, key, value) => {
      const field = hotkeyField(value, (c, kb) => { save({ [key]: c }, kb ? App.t("key.restart") : ""); drawKeys(); });
      const clear = value ? h("button", { class: "linkbtn", text: "\u2715", title: App.t("hk.clear"),
        onClick: () => { save({ [key]: "" }); drawKeys(); } }) : null;
      return U.srow(label, h("div", { class: "pathrow" }, field, clear));
    };
    const drawKeys = () => {
      const roll = U.srow(App.t("key.roll"), U.segc(POST_ROLL(), cfg.post_roll_seconds, (v) => { save({ post_roll_seconds: +v }); drawKeys(); }));
      roll.title = App.t("key.rollTip");
      keysBox.replaceChildren(
        keyRow(App.t("key.save"), "hotkey", cfg.hotkey),
        keyRow(App.t("key.marker"), "marker_hotkey", cfg.marker_hotkey ?? "Alt+M"),
        keyRow(App.t("key.record"), "record_hotkey", cfg.record_hotkey),
        roll);
    };
    drawKeys();

    // ZACHOWANIE
    const behBox = h("div", { class: "card2 tgl" });
    const drawBeh = () => {
      behBox.replaceChildren(
        U.trow(App.t("beh.gameOnly"), App.t("beh.gameOnlyD"), cfg.game_only, async (v) => { await save({ game_only: v }); drawBeh(); }),
        U.trow(App.t("beh.follow"), App.t("beh.followD"), cfg.follow_game_monitor, async (v) => { await save({ follow_game_monitor: v }); drawBeh(); }),
        U.trow(App.t("beh.popup"), App.t("beh.popupD"), cfg.popup, async (v) => { await save({ popup: v }); drawBeh(); }),
        U.trow(App.t("beh.autostart"), App.t("beh.autostartD"), autostart, async (v) => {
          autostart = await api.invoke("recorder_autostart", { enable: v }).catch(() => autostart);
          drawBeh();
        }));
    };
    drawBeh();

    // ZAAWANSOWANE
    const advBox = h("div");
    const drawAdv = () => {
      put(advBox,
        h("button", { class: "advhead", onClick: () => { advOpen = !advOpen; drawAdv(); } }, h("span", { text: App.t("adv.cap") }), h("span", { text: advOpen ? "▴" : "▾" })),
        advOpen ? h("div", { class: "card2 rise" },
          U.srow(App.t("adv.offset"), h("input", { class: "field monoin", type: "number", min: -500, max: 500, step: 10, value: cfg.audio_offset_ms,
            title: App.t("adv.offsetTip"),
            onChange: (e) => save({ audio_offset_ms: Math.max(-500, Math.min(500, +e.target.value || 0)) }) })),
          U.srow(App.t("adv.encoder"), h("select", { class: "field", title: App.t("adv.encoderTip"), onChange: (e) => { save({ encoder: e.target.value }); sum.update(cfg); } },
            ENCODERS().map(([v, t]) => h("option", { value: v, text: t, selected: (cfg.encoder || "auto") === v })))),
          U.srow(App.t("adv.games"), h("input", { class: "field", placeholder: App.t("adv.gamesPh"),
            title: App.t("adv.gamesTip"),
            value: (cfg.extra_games || []).join(", "),
            onChange: (e) => save({ extra_games: e.target.value.split(",").map((x) => x.trim().toLowerCase().replace(/\.exe$/, "")).filter(Boolean) }) })),
          U.srow(App.t("adv.diag"), h("span", { class: "mono muted", id: "recDiag", style: { fontSize: "12px" } }))) : null);
      paint();
    };
    drawAdv();

    pane.append(bar, h("div", { class: "setgrid" },
      h("div", { class: "setmain" },
        h("div", null, U.cap(App.t("cap.video")), videoBox),
        h("div", null, U.cap(App.t("cap.audio")), audioBox),
        h("div", null, U.cap(App.t("cap.keys")), keysBox),
        h("div", null, U.cap(App.t("cap.behavior")), behBox),
        advBox),
      sum.el));
    paint();
  }

  /** Updates the live parts (status bar, device names, diagnostics) without rebuilding the tab. */
  function paint() {
    const bar = App.$("#recState");
    if (!bar || !bar._refs) return;
    const { dot, title, line, saveBtn, toggleBtn, longBtn } = bar._refs;
    const r = S.recorder;
    const lg = r && r.long && r.long.active ? r.long : null;
    const clock = (sec) => `${sec >= 3600 ? Math.floor(sec / 3600) + ":" : ""}${String(Math.floor(sec / 60) % 60).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
    if (paint.wasLong && !lg) setTimeout(() => App.Lib.load(), 6000);   // the finished MP4 appears after the remux
    paint.wasLong = !!lg;
    const down = r ? r.sources.filter((s) => !s.live).map((s) => s.name) : [];
    let state = "on", t = App.t("st.on"), l = "";
    if (!r) { state = "off"; t = App.t("st.off"); l = App.t("st.offL"); }
    else if (r.idle) { state = "idle"; t = App.t("st.idle"); l = App.t("st.idleL"); }
    else if (!r.recording) { state = "off"; t = App.t("st.stopped"); l = r.last_error || ""; }
    else if (down.length) { state = "warn"; t = App.t("st.warn"); l = App.t("st.down", { list: down.join(", ") }); }
    if (lg) { state = "on"; t = App.t("long.on"); l = `${clock(lg.elapsed_s || 0)} · ${lg.mb} MB`; }
    else if (r && r.long && r.long.finalizing) t = App.t("long.fin");
    if (r && !l) l = r.hotkey ? App.t("st.buffer", { cur: fmtBuf(r.buffer_s), target: fmtBuf(r.buffer_target_s), hk: String(r.hotkey).replaceAll("+", " + ") })
      : App.t("st.bufferNoKey", { cur: fmtBuf(r.buffer_s), target: fmtBuf(r.buffer_target_s) });
    dot.className = `sdot ${state}`;
    title.textContent = t;
    line.textContent = l;
    saveBtn.disabled = !r || (!r.recording && !r.idle);
    longBtn.disabled = !r || (!r.recording && !r.idle && !lg);
    longBtn.textContent = lg ? App.t("long.stop") : App.t("long.start");
    toggleBtn.textContent = r ? App.t("st.stop") : App.t("st.start");
    if (sumLoadEl && sumLoadEl.isConnected) {
      // measured while recording; before that, the estimate from the encoder in use
      if (r && r.cpu_pct != null && r.recording) {
        sumLoadEl.textContent = `CPU ${Math.round(r.cpu_pct)}%` + (r.gpu_pct != null ? ` · GPU ${Math.round(r.gpu_pct)}%` : "");
      } else sumLoadEl.textContent = hw() ? "GPU" : "CPU";
    }
    const diag = App.$("#recDiag");
    if (diag) diag.textContent = r ? App.t("adv.diagFmt", { n: r.restarts, enc: r.encoder || "?", cap: r.capture || "?", rate: r.kbps ? (r.kbps / 1000).toFixed(1) + " Mb/s" : "?" }) : "—";
    for (const row of document.querySelectorAll("#recSources .aitem")) {
      const src = r && r.sources.find((s) => s.name === row.dataset.src);
      const dev = row.querySelector(".dev");
      if (!src || !dev) continue;
      const base = dev.firstChild ? dev.firstChild.textContent : "";
      const note = !src.live ? src.status.replace(/^down: /, App.t("src.missing")) : (src.role === "secondary" ? App.t("src.backup") : "");
      dev.replaceChildren(...[src.device || base, note ? h("em", { class: src.live ? "" : "bad", text: note }) : null].filter(Boolean));   // replaceChildren(null) would print "null"
    }
  }

  /* ───────────── first-run wizard ───────────── */

  const STEPS = ["start", "audio", "picture", "done"];

  async function wizard() {
    await load();
    const found = await api.invoke("detect_clip_folders").catch(() => []);
    const fresh = !App.P.settings.onboarded;
    const w = {
      step: 0, dir: cfg.output_dir, cfg: JSON.parse(JSON.stringify(cfg)), autostart: true, adv: false,
      checks: [], checksDone: false, running: false, hits0: null, tested: false, editKey: false,
    };
    // First choices: follow the Windows default output, a dedicated "chat" endpoint if there is one, the default mic.
    const hasChat = devices.render.find((d) => /chat|czat|communic/i.test(d.name));
    const follow = { id: FOLLOW, name: App.t("dev.default") };
    if (!w.cfg.game.primary) w.cfg.game.primary = follow;
    if (!w.cfg.chat.primary) w.cfg.chat.primary = hasChat ? { id: hasChat.id, name: hasChat.name } : follow;
    if (!w.cfg.mic.primary) w.cfg.mic.primary = follow;
    if (fresh) Object.assign(w.cfg, PRESETS[1][3]);
    // One shared output is the common case: split a chat app out of the game track by default.
    if (sharedOutput(w.cfg) && !w.cfg.chat_app) w.cfg.chat_app = "discord";

    const overlay = h("div", { class: "wz" });
    document.body.append(overlay);
    let stopMeters = () => {};
    let statusTimer = 0;
    const close = () => { stopMeters(); clearInterval(statusTimer); overlay.remove(); };
    const presetOf = () => PRESETS.find((p) => p[3].width === w.cfg.width && p[3].fps === w.cfg.fps && p[3].quality === w.cfg.quality);

    /* ----- pieces ----- */
    const rail = () => h("div", { class: "wzrail" }, STEPS.map((step, i) => h("div", { class: "wzstep" },
      h("div", { class: "bars" }, Array.from({ length: 6 }, (_, j) => h("i", { style: {
        opacity: i < w.step ? 0.5 : i === w.step ? 1 : 0.12, transitionDelay: `${j * 0.04}s` } }))),
      h("span", { text: App.t("wz.step." + step), style: { color: i === w.step ? "#c6f432" : i < w.step ? "#8e9484" : "#4a5040" } }))));

    const bigLogo = () => {
      const tails = [30, 10, 38, 18, 26, 6, 34, 14, 40, 22, 8, 32, 16];
      return h("div", { class: "biglogo" }, tails.map((t, i) => {
        const d = Math.abs(i - 6), wd = 10 + (6 - d) * 11, dl = `${i * 0.045}s`;
        return h("div", { class: "l" },
          h("div", { class: "t" }, h("i", { style: { width: `${t * 0.8}px`, animationDelay: dl } })),
          h("i", { class: "w", style: { width: `${wd}px`, animationDelay: dl } }));
      }));
    };

    const stepStart = () => {
      const rows = [
        ["ffmpeg", () => tools?.ffmpeg_found ? ["ok", tools.ffmpeg_bundled ? App.t("wz.bundled") : App.t("wz.system")] : ["warn", App.t("wz.noFfmpeg")]],
        [App.t("enc.label"), () => {
          const e = tools?.encoder;
          return e && e !== "libx264"
            ? ["ok", `✓ ${({ h264_nvenc: "NVIDIA NVENC", h264_amf: "AMD AMF", h264_qsv: "Intel QuickSync" })[e] || e}`]
            : ["warn", App.t("wz.useCpu")];
        }],
        [App.t("wz.devices"), () => {
          const n = (devices.render.length ? 2 : 0) + (devices.capture.length ? 1 : 0);
          return n >= 3 ? ["ok", App.t("wz.sources3")] : n ? ["warn", App.t("wz.nOf3", { n })] : ["warn", App.t("wz.noneDet")];
        }],
      ];
      const els = rows.map(([label]) => {
        const dot = h("span", { class: "cdot" }), val = h("span", { class: "mono cval" });
        return { dot, val, row: h("div", { class: "crow wait" }, dot, h("span", { text: label }), val) };
      });
      const paintRow = (i) => {
        const st = w.checks[i] || { state: "wait", val: "" };
        const e = els[i];
        e.row.className = `crow ${st.state}`;
        e.dot.textContent = st.state === "ok" ? "✓" : st.state === "warn" ? "!" : "";
        e.val.textContent = st.state === "active" ? App.t("wz.checking") : st.val || "";
      };
      const run = async () => {
        if (w.checksDone || w.running) return;
        w.running = true;
        for (let i = 0; i < rows.length; i++) {
          w.checks[i] = { state: "active", val: "" };
          paintRow(i);
          const started = Date.now();
          const [st, val] = rows[i][1]();
          await sleep(Math.max(0, 700 - (Date.now() - started)));
          if (!overlay.isConnected) return;
          w.checks[i] = { state: st, val };
          paintRow(i);
        }
        w.checksDone = true;
        w.running = false;
        if (w.step === 0) renderFooter();
      };
      els.forEach((_, i) => paintRow(i));
      if (!w.checksDone) setTimeout(run, 900);          // let the logo build first
      return h("div", { class: "stack16" },
        h("div", { class: "wzhero" }, bigLogo(),
          h("div", { class: "wzhello" }, h("div", { class: "big", text: App.t("wz.hello") }),
            h("div", { class: "muted", text: App.t("wz.helloD") }))),
        h("div", { class: "stack8" }, els.map((e) => e.row)),
        App.i18n.hintLink());
    };

    const stepAudio = () => {
      const rows = SRC.map(([key, name, label, kind, color, tip], i) => {
        const dev = deviceLabel(w.cfg, key, kind);
        return h("div", { class: "wzaudio", "data-src": name, title: App.t(tip), style: { animationDelay: `${0.1 + i * 0.1}s` } },
          h("span", { class: "sq", style: { background: color } }), h("b", { text: App.t(label) }),
          h("span", { class: "dev" }, dev.text, dev.note ? h("em", { text: dev.note }) : null), meterEl(color, true));
      });
      setTimeout(() => { if (w.step === 1) stopMeters = pollMeters(() => w.cfg, ".wzbody", 140, 40); }, 400);
      return h("div", { class: "stack12" },
        h("div", null, h("div", { class: "big", text: App.t("wz.audioQ") }),
          h("div", { class: "muted", text: App.t("wz.audioD") })),
        ...rows,
        h("div", { class: "faint", text: App.t("wz.audioHint") }));
    };

    const stepPicture = () => {
      const sumBars = Array.from({ length: 20 }, () => h("i"));
      const valEl = h("b", { class: "mono" }), noteEl = h("div", { class: "muted", style: { fontSize: "12px", marginTop: "6px" } });
      const lenEl = h("span");
      const cardsBox = h("div", { class: "presets3" });
      const advBox = h("div");
      const refresh = () => {
        const e = estimates(w.cfg);
        valEl.textContent = fmtMb(e.clipMb);
        lenEl.textContent = App.t("wz.oneClip", { t: fmtBuf(w.cfg.buffer_seconds) });
        bars20(e.clipMb, 500).forEach((o, j) => { sumBars[j].style.opacity = o; });
        noteEl.textContent = `${e.clipMb <= 10 ? App.t("wz.fitsD") : e.clipMb <= 50 ? App.t("wz.fitsB") : e.clipMb <= 500 ? App.t("wz.fitsN") : App.t("wz.over")} · ${hw() ? App.t("wz.gpu") : App.t("wz.cpu")}`;
        const cur = presetOf();
        [...cardsBox.children].forEach((c, i) => c.classList.toggle("on", cur === PRESETS[i]));
      };
      PRESETS.forEach((p, i) => {
        cardsBox.append(h("div", { class: "pcard", style: { animationDelay: `${0.05 + i * 0.07}s` }, onClick: () => { Object.assign(w.cfg, p[3]); refresh(); drawAdv(); } },
          h("b", { text: App.t(p[1]) + (p[0] === "bal" ? " ★" : "") }), h("div", { class: "muted", text: App.t(p[2]) }), h("div", { class: "mono spec", text: p[4] || `${App.t("res.native").toLocaleLowerCase(App.tag())} · ${p[3].fps} fps` })));
      });
      const drawAdv = () => {
        put(advBox,
          h("button", { class: "advlink", text: `${App.t("wz.customize")} ${w.adv ? "▴" : "▾"}`, onClick: () => { w.adv = !w.adv; drawAdv(); } }),
          w.adv ? h("div", { class: "card2 rise compact" }, ...videoRows(w.cfg, (patch) => { Object.assign(w.cfg, patch); refresh(); drawAdv(); })) : null);
      };
      refresh(); drawAdv();
      return h("div", { class: "stack12" },
        h("div", null, h("div", { class: "big", text: App.t("wz.picQ") }), h("div", { class: "muted", text: App.t("wz.picD") })),
        cardsBox,
        h("div", { class: "card2 pad" }, h("div", { class: "between" }, lenEl, valEl), h("div", { class: "sb" }, sumBars), noteEl),
        advBox);
    };

    const stepDone = () => {
      const e = estimates(w.cfg);
      const hotVal = h("span", { class: "mono" }), strip = h("div", { class: "keystrip" });
      const drawKey = () => {
        hotVal.replaceChildren(...(w.editKey
          ? [hotkeyField(w.cfg.hotkey, (c) => { w.cfg.hotkey = c; w.editKey = false; w.tested = false; applyKey().then(drawKey); drawKey(); })]
          : [String(w.cfg.hotkey).replaceAll("+", " + ")]));
        strip.className = `keystrip${w.tested ? " ok" : ""}`;
        strip.textContent = w.tested ? App.t("wz.keyOk") : App.t("wz.keyTest", { hk: String(w.cfg.hotkey).replaceAll("+", " + ") });
      };
      const rows = [
        [App.t("wz.folder"), h("span", { class: "mono", text: w.dir }), h("button", { class: "linkbtn", text: App.t("common.change"), onClick: async () => {
          const d = await api.pickFolder(); if (d) { w.dir = d; renderStep(); } } })],
        [App.t("wz.saveKey"), hotVal, h("button", { class: "linkbtn", text: App.t("common.change"), onClick: () => { w.editKey = true; drawKey(); } })],
        [App.t("wz.picture"), h("span", { class: "mono", text: App.t("wz.imgRow", { w: e.w, h: e.hgt, fps: w.cfg.fps, len: fmtBuf(w.cfg.buffer_seconds), size: fmtMb(e.clipMb) }) }),
          h("button", { class: "linkbtn", text: App.t("common.change"), onClick: () => { w.step = 2; renderAll(); } })],
        [App.t("wz.audio"), h("span", { class: "mono", text: "Game · Chat · Mic ✓" }), h("span")],
      ];
      drawKey();
      return h("div", { class: "stack12" },
        h("div", { class: "donehead" }, h("span", { class: "tickc", text: "✓" }), h("div", { class: "big", text: App.t("wz.ready") })),
        ...rows.map(([label, val, act], i) => h("div", { class: "sumrow", style: { animationDelay: `${0.15 + i * 0.07}s` } },
          h("span", { class: "muted", text: label }), val, act)),
        strip,
        h("div", { class: "faint", text: App.t("wz.doneHint") }));
    };

    /* ----- shell ----- */
    const body = h("div", { class: "wzbody" });
    const foot = h("div", { class: "wzfoot" });
    const railBox = h("div");
    overlay.append(h("div", { class: "wzcard" }, h("div", { class: "wzsweep" }, h("div")), railBox, body, foot));

    const nextReady = () => w.step !== 0 || w.checksDone;
    function renderFooter() {
      const last = w.step === STEPS.length - 1;
      const ready = nextReady();
      put(foot,
        h("button", { class: "btn ghost", text: App.t("wz.useDefaults"), onClick: () => finish() }),
        h("span", { class: "sp" }),
        w.step > 0 ? h("button", { class: "btn", text: App.t("wz.back"), onClick: () => { w.step--; renderAll(); } }) : null,
        h("button", { class: "btn nextbtn" + (ready ? " acc" : " off"), disabled: !ready, text: last ? App.t("wz.finish") : App.t("wz.next"),
          onClick: () => { if (!ready) return; if (last) finish(); else { w.step++; renderAll(); } } }));
    }

    function renderStep() {
      stopMeters();
      clearInterval(statusTimer);
      const el = h("div", { class: "stepbox stepin" }, [stepStart, stepAudio, stepPicture, stepDone][w.step]());
      body.replaceChildren(el);                // a new node each time restarts the animation
      if (w.step === 3) armRecorder();
    }

    function renderAll() { railBox.replaceChildren(rail()); renderFooter(); renderStep(); }

    /* The last step arms the recorder with the chosen settings so the shortcut can really be tested. */
    async function persist() {
      const c = JSON.parse(JSON.stringify(w.cfg));
      c.output_dir = w.dir;
      c.lang = App.i18n.current();
      for (const [k] of SRC) if (c[k].secondary && !c[k].secondary.id) c[k].secondary = null;
      cfg = { ...cfg, ...c };
      await api.invoke("set_recorder_config", { config: c });
    }
    async function applyKey() {
      await persist();
      if (S.recorder) { await api.invoke("recorder_cmd", { cmd: "quit" }).catch(() => {}); await sleep(1200); }
      await api.invoke("recorder_launch").catch(() => {});
      await sleep(1500);
      await App.Rec.refresh();
      w.hits0 = S.recorder ? S.recorder.hotkey_hits : null;
    }
    async function armRecorder() {
      await persist();
      if (S.recorder) await api.invoke("recorder_cmd", { cmd: "reload" }).catch(() => {});
      else { await api.invoke("recorder_launch").catch((e) => App.toast(String(e), "err")); await sleep(1500); }
      await App.Rec.refresh();
      if (w.hits0 == null) w.hits0 = S.recorder ? S.recorder.hotkey_hits : 0;
      clearInterval(statusTimer);
      statusTimer = setInterval(async () => {
        await App.Rec.refresh();
        if (S.recorder && w.hits0 != null && S.recorder.hotkey_hits > w.hits0 && !w.tested) {
          w.tested = true;
          const s = body.querySelector(".keystrip");
          if (s) { s.className = "keystrip ok"; s.textContent = App.t("wz.keyOk"); }
        }
      }, 400);
    }

    async function finish() {
      w.cfg.output_dir = w.dir;
      await persist();
      App.P.libDirs = [...new Set([w.dir, ...found.map((f) => f.path), ...App.P.libDirs.filter((d) => !fresh || d === w.dir)])].filter(Boolean);
      App.P.settings.onboarded = true;
      App.persist();
      await api.invoke("recorder_autostart", { enable: w.autostart }).catch(() => {});
      if (S.recorder) await api.invoke("recorder_cmd", { cmd: "reload" }).catch(() => {});
      else await api.invoke("recorder_launch").catch((e) => App.toast(String(e), "err"));
      setTimeout(App.Rec.refresh, 1500);
      close();
      App.toast(App.t("wz.toastDone"), "ok");
      await App.Lib.load();
      if (S.view === "set") App.Settings.render();
    }

    renderAll();
  }

  /** Tells the recorder which language to use for its tray menu and popups (no-op when already in sync). */
  async function syncLang() {
    await load();
    const lang = App.i18n.current();
    if (cfg.lang !== lang) await save({ lang });
  }

  return {
    renderTab, paint, wizard, syncLang,
    ensureLoaded: load,
    cfg: () => cfg,
    save,
    toolsInfo: () => tools,
  };
})();

