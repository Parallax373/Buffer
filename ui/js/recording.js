"use strict";
/* Settings → Nagrywanie and the first-run setup wizard (design: "Settings regroup + Setup wizard"). */

App.RecUI = (function () {
  const { h, S, api } = App;
  const U = App.ui;
  const FOLLOW = "@default";            // "whatever Windows currently uses" (speakers, headset…)
  const SRC = [
    ["game", "Game", "Dźwięk gry", "render", "#1fb89a", "Dźwięk z komputera: gry, muzyka, filmy."],
    ["chat", "Chat", "Czat głosowy", "render", "#4a9ae0", "Rozmówcy z Discorda, Teamspeaka itp. na osobnej ścieżce, którą da się wyciszyć."],
    ["mic", "Mic", "Mikrofon", "capture", "#e0a23a", "Twój głos, z własną głośnością."],
  ];
  const CHAT_APPS = [["", "— nie rozdzielaj —"], ["discord", "Discord"], ["teamspeak", "TeamSpeak"], ["ts3client_win64", "TeamSpeak 3"],
    ["teams", "Microsoft Teams"], ["zoom", "Zoom"], ["telegram", "Telegram"], ["skype", "Skype"]];
  const BASE = {
    output_dir: "", per_game_folders: true, post_roll_seconds: 15, game_only: false, follow_game_monitor: true, chat_app: "",
    buffer_seconds: 120, fps: 30, width: 1920, video_kbps: 14000, monitor: 0,
    encoder: "auto", audio_offset_ms: 0, hotkey: "Alt+Q", marker_hotkey: "Alt+M", popup: true, extra_games: [], ignore_apps: [],
    game: { primary: null, secondary: null }, chat: { primary: null, secondary: null }, mic: { primary: null, secondary: null },
  };
  const RES = [[1280, "720p"], [1920, "1080p"], [2560, "1440p"], [0, "Natywna"]];
  const FPS = [[30, "30 fps"], [60, "60 fps"]];
  const QUAL = [[8000, "Oszczędna"], [14000, "Standard"], [30000, "Wysoka"]];
  const LEN = [[30, "30 s"], [60, "1 min"], [120, "2 min"], [300, "5 min"]];
  const POST_ROLL = [[0, "Od razu"], [15, "15 s"], [30, "30 s"], [60, "60 s"]];
  const PRESETS = [
    ["eco", "Lekki", "Mały klip, minimalne obciążenie", { width: 1920, fps: 30, video_kbps: 14000 }, "1080p · 30 fps"],
    ["bal", "Zbalansowany ★", "Ostry obraz, mieści się w Nitro", { width: 2560, fps: 30, video_kbps: 30000 }, "1440p · 30 fps"],
    ["max", "Maksymalny", "Natywna rozdzielczość, płynny ruch", { width: 0, fps: 60, video_kbps: 30000 }, "natywna · 60 fps"],
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

  const hotkeyField = (value, onSet) => h("input", { class: "field keyfield", value: String(value).replaceAll("+", " + "), readOnly: true,
    placeholder: "Naciśnij skrót",
    onKeydown: (e) => {
      e.preventDefault();
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Win"].filter(Boolean);
      if (!mods.length) { App.toast("Skrót musi zawierać Ctrl, Alt, Shift lub Win", "err"); return; }
      const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      if (!/^([A-Z0-9]|F([1-9]|1\d|2[0-4]))$/.test(k)) { App.toast("Dozwolone: litery, cyfry i F1–F24", "err"); return; }
      const combo = [...mods, k].join("+");
      e.target.value = combo.replaceAll("+", " + ");
      onSet(combo);
    } });

  /** Select of devices; `allowNone` adds an empty choice (used for the optional backup device). */
  function deviceSelect(key, kind, cur, onPick, allowNone) {
    const list = kind === "render" ? devices.render : devices.capture;
    const defName = nameOf(list, defaultFor(kind, key));
    const real = cur && cur.id && cur.id !== FOLLOW;
    const match = real && list.find((d) => d.id === cur.id || d.name.toLowerCase() === (cur.name || "").toLowerCase());
    const opts = [];
    if (allowNone) opts.push(h("option", { value: "", text: "— wybierz urządzenie —", selected: !cur || !cur.id }));
    opts.push(h("option", { value: FOLLOW, selected: !!cur && cur.id === FOLLOW,
      text: `Domyślne urządzenie Windows${defName ? ` (teraz: ${defName})` : ""}` }));
    if (real && !match) opts.push(h("option", { value: cur.id, text: `${cur.name} (odłączone)`, selected: true }));
    for (const d of list) opts.push(h("option", { value: d.id, text: d.name, selected: !!match && match.id === d.id }));
    return h("select", { class: "field", onChange: (e) => {
      const v = e.target.value;
      if (!v) return onPick(null);
      if (v === FOLLOW) return onPick({ id: FOLLOW, name: "Domyślne urządzenie Windows" });
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
    if (key === "chat" && c.chat_app) return { text: `${c.chat_app} (osobna ścieżka)`, note: "" };
    const p = c[key].primary;
    let text = "nie ustawiono";
    if (p && p.id === FOLLOW) text = nameOf(list, defaultFor(kind, key)) || "domyślne Windows";
    else if (p && p.name) text = p.name;
    let note = "";
    if (key === "game" && c.chat_app) note = "bez czatu";
    if (key === "chat" && !c.chat_app && sharedOutput(c)) note = "wspólne wyjście";
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

  function estimates(c) {
    const [w, hgt] = outputSize(c);
    const clipMb = ((c.video_kbps + 3 * 192) * c.buffer_seconds) / 8000;
    const diskMb = clipMb * (1 + 8 / c.buffer_seconds);                  // plus the segments being written
    const ramMb = 200 + 170 * ((w * hgt * c.fps) / (1920 * 804 * 30));   // calibrated on one measurement (367 MB @ 1080p30)
    return { w, hgt, clipMb, diskMb, ramMb };
  }

  const hw = () => !!(tools && tools.encoder && tools.encoder !== "libx264");

  /** The five video rows; `set(patch)` applies a change. Used by Settings and by the wizard's "Dostosuj". */
  function videoRows(c, set) {
    const customQ = !QUAL.some(([v]) => v === c.video_kbps);
    const rows = [
      U.srow("Rozdzielczość", U.segc(RES, c.width, (v) => set({ width: +v }))),
      U.srow("Klatki na sekundę", U.segc(FPS, c.fps, (v) => set({ fps: +v }))),
      U.srow("Jakość obrazu", U.segc([...QUAL, ...(customQ ? [[c.video_kbps, `${c.video_kbps / 1000} Mb/s`]] : [])], c.video_kbps, (v) => set({ video_kbps: +v }))),
      U.srow("Długość klipu", U.segc(LEN, c.buffer_seconds, (v) => set({ buffer_seconds: +v }))),
    ];
    if (monitors.length) {
      rows.push(U.srow("Ekran", U.segc(monitors.map((m) => [m.index, `${m.index + 1}: ${m.width}×${m.height}${m.primary ? " ★" : ""}`]), c.monitor, (v) => set({ monitor: +v }))));
    }
    return rows;
  }

  const bars20 = (v, max) => {
    const n = Math.round(Math.min(1, v / max) * 20);
    return Array.from({ length: 20 }, (_, i) => (i < n ? 0.35 + (i / 20) * 0.65 : 0.12));
  };

  /** Sticky "Co to zajmie" card; call update(c) after any video change. */
  function summaryCard() {
    const defs = [["Jeden klip", 500], ["Bufor na dysku", 700], ["Pamięć RAM", 1400]];
    const refs = defs.map(([label]) => ({
      val: h("span", { class: "sv" }),
      bars: Array.from({ length: 20 }, () => h("i")),
      note: h("div", { class: "sn" }),
      label,
    }));
    const loadEl = h("span", { class: "mono lime", style: { fontWeight: 600 } });
    const capEl = h("div", { class: "sc" });
    const el = h("div", { class: "sumside" }, U.cap("Co to zajmie"),
      ...refs.map((r) => h("div", null,
        h("div", { class: "sh" }, h("b", { text: r.label }), r.val),
        h("div", { class: "sb" }, r.bars), r.note)),
      h("div", { class: "sl" }, h("b", { text: "Obciążenie" }), loadEl), capEl);
    const update = (c) => {
      const e = estimates(c);
      const vals = [e.clipMb, e.diskMb, e.ramMb];
      const notes = [
        e.clipMb <= 10 ? "mieści się w Discordzie (10 MB)" : e.clipMb <= 50 ? "mieści się z Boost (50 MB)"
          : e.clipMb <= 500 ? "mieści się w Discordzie z Nitro (500 MB)" : "za duży na Discord — wyeksportuj",
        "tymczasowy, nadpisywany", "szacunek"];
      refs.forEach((r, i) => {
        r.val.textContent = (i === 2 ? "≈ " : "") + fmtMb(vals[i]);
        bars20(vals[i], defs[i][1]).forEach((o, j) => { r.bars[j].style.opacity = o; });
        r.note.textContent = notes[i];
      });
      loadEl.textContent = hw() ? "GPU" : "CPU";
      capEl.textContent = `Obraz zapisywany w ${e.w}×${e.hgt} px, ${c.fps} fps. 10 klipów ≈ ${fmtMb(e.clipMb * 10)}.`;
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
    const saveBtn = h("button", { class: "btn acc", text: "Zapisz klip teraz", onClick: async () => {
      try {
        const r = await api.invoke("recorder_cmd", { cmd: "save" });
        if (r.ok) { App.toast(`Zapisano: ${App.baseName(r.path)}`, "ok"); setTimeout(() => App.Lib.load(), 800); }
        else App.toast(`Nie zapisano: ${r.error}`, "err");
      } catch (e) { App.toast(`Nagrywanie nie działa: ${e}`, "err"); }
    } });
    const toggleBtn = h("button", { class: "btn", onClick: async () => {
      if (S.recorder) await api.invoke("recorder_cmd", { cmd: "quit" }).catch(() => {});
      else await api.invoke("recorder_launch").catch((e) => App.toast(String(e), "err"));
      setTimeout(App.Rec.refresh, 1500);
    } });
    const bar = h("div", { class: "statusbar", id: "recState" }, dot, h("div", null, title, line), h("span", { class: "sp" }), saveBtn, toggleBtn);
    bar._refs = { dot, title, line, saveBtn, toggleBtn };

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
          h("b", { text: label, title: tip }),
          h("span", { class: "dev" }, dev.text, dev.note ? h("em", { text: dev.note }) : null),
          meterEl(color, false),
          h("span", { class: "arr", text: open ? "▴" : "▾" }));
        let body = null;
        if (open) {
          const c = cfg[key];
          body = h("div", { class: "abody" },
            deviceSelect(key, kind, c.primary, (v) => { cfg[key] = { ...cfg[key], primary: v }; persistSources(); drawAudio(); }, false),
            c.secondary
              ? h("div", { class: "pathrow", title: "Zapasowe: włączy się, gdy główne urządzenie zostanie odłączone" },
                deviceSelect(key, kind, c.secondary, (v) => { cfg[key] = { ...cfg[key], secondary: v }; persistSources(); drawAudio(); }, true),
                h("button", { class: "btn ghost", text: "✕", title: "Usuń urządzenie zapasowe", onClick: () => { cfg[key] = { ...cfg[key], secondary: null }; persistSources(); drawAudio(); } }))
              : h("button", { class: "linkbtn", text: "+ urządzenie zapasowe", title: "Włączy się, gdy główne zostanie odłączone",
                onClick: () => { cfg[key] = { ...cfg[key], secondary: { id: "", name: "" } }; drawAudio(); } }),
            key === "chat" && (sharedOutput() || cfg.chat_app)
              ? h("div", { class: "srow", title: "Gra i czat dzielą jedno wyjście. Wskaż aplikację czatu: jej dźwięk trafi tylko na ścieżkę Czat, a Gra dostanie resztę." },
                h("span", { class: "lb", text: "Aplikacja czatu" }),
                h("select", { class: "field", onChange: (e) => { cfg.chat_app = e.target.value; persistSources(); drawAudio(); } },
                  CHAT_APPS.map(([v, t]) => h("option", { value: v, text: t, selected: (cfg.chat_app || "") === v }))))
              : null);
        }
        return h("div", { class: "aitem", "data-src": name }, head, body);
      }));
      pollMeters(() => cfg, "#recSources", 350, 350);
    };
    drawAudio();

    // SKRÓTY
    const keysBox = h("div", { class: "card2" });
    const drawKeys = () => {
      const roll = U.srow("Dogrywaj po skrócie", U.segc(POST_ROLL, cfg.post_roll_seconds, (v) => { save({ post_roll_seconds: +v }); drawKeys(); }));
      roll.title = "Po skrócie nagrywanie trwa jeszcze tyle sekund i dopiero wtedy zapisuje klip, więc w klipie są też chwile tuż po. Drugie naciśnięcie zapisuje od razu.";
      keysBox.replaceChildren(
        U.srow("Zapisz klip", hotkeyField(cfg.hotkey, (c) => save({ hotkey: c }, "Skrót zadziała po ponownym uruchomieniu nagrywania"))),
        U.srow("Znacznik w grze", hotkeyField(cfg.marker_hotkey || "Alt+M", (c) => save({ marker_hotkey: c }, "Skrót zadziała po ponownym uruchomieniu nagrywania"))),
        roll);
    };
    drawKeys();

    // ZACHOWANIE
    const behBox = h("div", { class: "card2 tgl" });
    const drawBeh = () => {
      behBox.replaceChildren(
        U.trow("Nagrywaj tylko gry", "Bufor i dźwięk tylko podczas gry", cfg.game_only, async (v) => { await save({ game_only: v }); drawBeh(); }),
        U.trow("Nagrywaj monitor, na którym jest gra", "Przełącza się na ekran z grą", cfg.follow_game_monitor, async (v) => { await save({ follow_game_monitor: v }); drawBeh(); }),
        U.trow("Okienko „Buffer aktywny”", "Przy starcie gry i zapisie klipu", cfg.popup, async (v) => { await save({ popup: v }); drawBeh(); }),
        U.trow("Uruchamiaj z systemem", "Startuje po zalogowaniu", autostart, async (v) => {
          autostart = await api.invoke("recorder_autostart", { enable: v }).catch(() => autostart);
          drawBeh();
        }));
    };
    drawBeh();

    // ZAAWANSOWANE
    const advBox = h("div");
    const drawAdv = () => {
      put(advBox,
        h("button", { class: "advhead", onClick: () => { advOpen = !advOpen; drawAdv(); } }, h("span", { text: "ZAAWANSOWANE" }), h("span", { text: advOpen ? "▴" : "▾" })),
        advOpen ? h("div", { class: "card2 rise" },
          U.srow("Przesunięcie dźwięku", h("input", { class: "field monoin", type: "number", min: -500, max: 500, step: 10, value: cfg.audio_offset_ms,
            title: "Dodatnie opóźnia dźwięk względem obrazu (ms). Dostrój, jeśli głos nie pasuje do ust.",
            onChange: (e) => save({ audio_offset_ms: Math.max(-500, Math.min(500, +e.target.value || 0)) }) })),
          U.srow("Dodatkowe gry", h("input", { class: "field", placeholder: "procesy po przecinku: leagueclient, valorant",
            title: "Gry w oknie wykrywamy tylko po nazwie procesu. Pełnoekranowe wykrywane są automatycznie.",
            value: (cfg.extra_games || []).join(", "),
            onChange: (e) => save({ extra_games: e.target.value.split(",").map((x) => x.trim().toLowerCase().replace(/\.exe$/, "")).filter(Boolean) }) })),
          U.srow("Diagnostyka", h("span", { class: "mono muted", id: "recDiag", style: { fontSize: "12px" } }))) : null);
      paint();
    };
    drawAdv();

    pane.append(bar, h("div", { class: "setgrid" },
      h("div", { class: "setmain" },
        h("div", null, U.cap("Wideo"), videoBox),
        h("div", null, U.cap("Dźwięk · 3 ścieżki"), audioBox),
        h("div", null, U.cap("Skróty"), keysBox),
        h("div", null, U.cap("Zachowanie"), behBox),
        advBox),
      sum.el));
    paint();
  }

  /** Updates the live parts (status bar, device names, diagnostics) without rebuilding the tab. */
  function paint() {
    const bar = App.$("#recState");
    if (!bar || !bar._refs) return;
    const { dot, title, line, saveBtn, toggleBtn } = bar._refs;
    const r = S.recorder;
    const down = r ? r.sources.filter((s) => !s.live).map((s) => s.name) : [];
    let state = "on", t = "Nagrywa", l = "";
    if (!r) { state = "off"; t = "Nagrywanie nie działa"; l = "kliknij Uruchom"; }
    else if (r.idle) { state = "idle"; t = "Czeka na grę"; l = "nagrywa tylko podczas gry"; }
    else if (!r.recording) { state = "off"; t = "Zatrzymane"; l = r.last_error || ""; }
    else if (down.length) { state = "warn"; t = "Nagrywa — uwaga"; l = `nie działa: ${down.join(", ")}`; }
    if (r && !l) l = `bufor ${fmtBuf(r.buffer_s)} / ${fmtBuf(r.buffer_target_s)} · skrót ${String(r.hotkey).replaceAll("+", " + ")}`;
    dot.className = `sdot ${state}`;
    title.textContent = t;
    line.textContent = l;
    saveBtn.disabled = !r || (!r.recording && !r.idle);
    toggleBtn.textContent = r ? "Zatrzymaj" : "Uruchom";
    const diag = App.$("#recDiag");
    if (diag) diag.textContent = r ? `restarty ${r.restarts} · koder ${r.encoder || "?"} · ${r.capture || "?"}` : "—";
    for (const row of document.querySelectorAll("#recSources .aitem")) {
      const src = r && r.sources.find((s) => s.name === row.dataset.src);
      const dev = row.querySelector(".dev");
      if (!src || !dev) continue;
      const base = dev.firstChild ? dev.firstChild.textContent : "";
      const note = !src.live ? src.status.replace(/^down: /, "brak: ") : (src.role === "secondary" ? "zapasowe" : "");
      dev.replaceChildren(...[src.device || base, note ? h("em", { class: src.live ? "" : "bad", text: note }) : null].filter(Boolean));   // replaceChildren(null) would print "null"
    }
  }

  /* ───────────── first-run wizard ───────────── */

  const STEPS = ["Start", "Dźwięk", "Obraz", "Gotowe"];

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
    const follow = { id: FOLLOW, name: "Domyślne urządzenie Windows" };
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
    const presetOf = () => PRESETS.find((p) => p[3].width === w.cfg.width && p[3].fps === w.cfg.fps && p[3].video_kbps === w.cfg.video_kbps);

    /* ----- pieces ----- */
    const rail = () => h("div", { class: "wzrail" }, STEPS.map((label, i) => h("div", { class: "wzstep" },
      h("div", { class: "bars" }, Array.from({ length: 6 }, (_, j) => h("i", { style: {
        opacity: i < w.step ? 0.5 : i === w.step ? 1 : 0.12, transitionDelay: `${j * 0.04}s` } }))),
      h("span", { text: label, style: { color: i === w.step ? "#c6f432" : i < w.step ? "#8e9484" : "#4a5040" } }))));

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
        ["ffmpeg", () => tools?.ffmpeg_found ? ["ok", tools.ffmpeg_bundled ? "✓ wbudowany" : "✓ w systemie"] : ["warn", "Brak ffmpeg — zainstaluj aplikację ponownie"]],
        ["Kodowanie wideo", () => {
          const e = tools?.encoder;
          return e && e !== "libx264"
            ? ["ok", `✓ ${({ h264_nvenc: "NVIDIA NVENC", h264_amf: "AMD AMF", h264_qsv: "Intel QuickSync" })[e] || e}`]
            : ["warn", "Użyję procesora zamiast karty"];
        }],
        ["Urządzenia audio", () => {
          const n = (devices.render.length ? 2 : 0) + (devices.capture.length ? 1 : 0);
          return n >= 3 ? ["ok", "✓ 3 źródła"] : n ? ["warn", `${n} z 3 — resztę wskażesz w Ustawieniach`] : ["warn", "Nie wykryto — wskażesz w Ustawieniach"];
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
        e.val.textContent = st.state === "active" ? "sprawdzam…" : st.val || "";
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
          h("div", { class: "wzhello" }, h("div", { class: "big", text: "Witaj w Buffer" }),
            h("div", { class: "muted", text: "Buffer nagrywa w tle ostatnie minuty. Jeden skrót zapisuje klip." }))),
        h("div", { class: "stack8" }, els.map((e) => e.row)));
    };

    const stepAudio = () => {
      const rows = SRC.map(([key, name, label, kind, color, tip], i) => {
        const dev = deviceLabel(w.cfg, key, kind);
        return h("div", { class: "wzaudio", "data-src": name, title: tip, style: { animationDelay: `${0.1 + i * 0.1}s` } },
          h("span", { class: "sq", style: { background: color } }), h("b", { text: label }),
          h("span", { class: "dev" }, dev.text, dev.note ? h("em", { text: dev.note }) : null), meterEl(color, true));
      });
      setTimeout(() => { if (w.step === 1) stopMeters = pollMeters(() => w.cfg, ".wzbody", 140, 40); }, 400);
      return h("div", { class: "stack12" },
        h("div", null, h("div", { class: "big", text: "Skąd nagrywać dźwięk?" }),
          h("div", { class: "muted", text: "Wykryliśmy urządzenia z Windows. Każde źródło ma osobną ścieżkę. Zmienisz je w Ustawieniach." })),
        ...rows,
        h("div", { class: "faint", text: "Poruszaj się w grze lub powiedz coś — paski powinny się ruszać." }));
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
        lenEl.textContent = `Jeden klip (${fmtBuf(w.cfg.buffer_seconds)})`;
        bars20(e.clipMb, 500).forEach((o, j) => { sumBars[j].style.opacity = o; });
        noteEl.textContent = `${e.clipMb <= 10 ? "mieści się w Discordzie" : e.clipMb <= 50 ? "mieści się z Boost" : e.clipMb <= 500 ? "mieści się z Nitro" : "większy niż limity Discorda"} · ${hw() ? "obciąża GPU, nie grę" : "obciąża procesor"}`;
        const cur = presetOf();
        [...cardsBox.children].forEach((c, i) => c.classList.toggle("on", cur === PRESETS[i]));
      };
      PRESETS.forEach((p, i) => {
        cardsBox.append(h("div", { class: "pcard", style: { animationDelay: `${0.05 + i * 0.07}s` }, onClick: () => { Object.assign(w.cfg, p[3]); refresh(); drawAdv(); } },
          h("b", { text: p[1] }), h("div", { class: "muted", text: p[2] }), h("div", { class: "mono spec", text: p[4] })));
      });
      const drawAdv = () => {
        put(advBox,
          h("button", { class: "advlink", text: `Dostosuj ${w.adv ? "▴" : "▾"}`, onClick: () => { w.adv = !w.adv; drawAdv(); } }),
          w.adv ? h("div", { class: "card2 rise compact" }, ...videoRows(w.cfg, (patch) => { Object.assign(w.cfg, patch); refresh(); drawAdv(); })) : null);
      };
      refresh(); drawAdv();
      return h("div", { class: "stack12" },
        h("div", null, h("div", { class: "big", text: "Jakość obrazu" }), h("div", { class: "muted", text: "Wybierz profil. Szczegóły zmienisz poniżej lub później." })),
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
        strip.textContent = w.tested ? "✓ Skrót działa" : `Naciśnij ${String(w.cfg.hotkey).replaceAll("+", " + ")}, aby przetestować`;
      };
      const rows = [
        ["Folder", h("span", { class: "mono", text: w.dir }), h("button", { class: "linkbtn", text: "Zmień", onClick: async () => {
          const d = await api.pickFolder(); if (d) { w.dir = d; renderStep(); } } })],
        ["Skrót zapisu", hotVal, h("button", { class: "linkbtn", text: "Zmień", onClick: () => { w.editKey = true; drawKey(); } })],
        ["Obraz", h("span", { class: "mono", text: `${e.w}×${e.hgt} · ${w.cfg.fps} fps · klip ${fmtBuf(w.cfg.buffer_seconds)} ≈ ${fmtMb(e.clipMb)}` }),
          h("button", { class: "linkbtn", text: "Zmień", onClick: () => { w.step = 2; renderAll(); } })],
        ["Dźwięk", h("span", { class: "mono", text: "Game · Chat · Mic ✓" }), h("span")],
      ];
      drawKey();
      return h("div", { class: "stack12" },
        h("div", { class: "donehead" }, h("span", { class: "tickc", text: "✓" }), h("div", { class: "big", text: "Wszystko gotowe" })),
        ...rows.map(([label, val, act], i) => h("div", { class: "sumrow", style: { animationDelay: `${0.15 + i * 0.07}s` } },
          h("span", { class: "muted", text: label }), val, act)),
        strip,
        h("div", { class: "faint", text: "Skróty, zachowanie i motyw zmienisz w Ustawieniach." }));
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
        h("button", { class: "btn ghost", text: "Użyj ustawień domyślnych", onClick: () => finish() }),
        h("span", { class: "sp" }),
        w.step > 0 ? h("button", { class: "btn", text: "Wstecz", onClick: () => { w.step--; renderAll(); } }) : null,
        h("button", { class: "btn nextbtn" + (ready ? " acc" : " off"), disabled: !ready, text: last ? "Zakończ i włącz nagrywanie" : "Dalej",
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
          if (s) { s.className = "keystrip ok"; s.textContent = "✓ Skrót działa"; }
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
      App.toast("Gotowe — nagrywanie działa w tle", "ok");
      await App.Lib.load();
      if (S.view === "set") App.Settings.render();
    }

    renderAll();
  }

  return {
    renderTab, paint, wizard,
    ensureLoaded: load,
    cfg: () => cfg,
    save,
    toolsInfo: () => tools,
  };
})();
