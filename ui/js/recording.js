"use strict";
/* Recorder settings (Ustawienia → Nagrywanie) and the first-run setup wizard. */

App.RecUI = (function () {
  const { h, S, api } = App;
  const FOLLOW = "@default";            // "whatever Windows currently uses" (speakers, headset…)
  const SRC = [
    ["game", "Game", "Dźwięk gry", "render", "Skąd nagrywać dźwięk z komputera (gry, muzyka, filmy)."],
    ["chat", "Chat", "Czat głosowy", "render", "Rozmówcy z Discorda, Teamspeaka itp. — osobna ścieżka, żeby dało się ją wyciszyć."],
    ["mic", "Mic", "Mikrofon", "capture", "Twój głos. Dostaje własną ścieżkę z osobną głośnością."],
  ];
  const ROLE = { primary: "główne", secondary: "zapasowe", auto: "automatycznie", waiting: "czeka na urządzenie", default: "domyślne Windows",
    app: "tylko ta aplikacja", appx: "wszystko poza czatem" };
  const CHAT_APPS = [["", "— nie rozdzielaj —"], ["discord", "Discord"], ["teamspeak", "TeamSpeak"], ["ts3client_win64", "TeamSpeak 3"],
    ["teams", "Microsoft Teams"], ["zoom", "Zoom"], ["telegram", "Telegram"], ["skype", "Skype"]];
  const BASE = {
    output_dir: "", per_game_folders: true, post_roll_seconds: 30, game_only: false, follow_game_monitor: true, chat_app: "",
    buffer_seconds: 120, fps: 30, width: 1920, video_kbps: 14000, monitor: 0,
    encoder: "auto", audio_offset_ms: 0, hotkey: "Alt+Q", marker_hotkey: "Alt+M", popup: true, extra_games: [], ignore_apps: [],
    game: { primary: null, secondary: null }, chat: { primary: null, secondary: null }, mic: { primary: null, secondary: null },
  };

  let cfg = { ...BASE };
  let devices = { render: [], capture: [], default: {} };
  let monitors = [];
  let autostart = false;
  let tools = null;
  let meterTimer = 0;

  const cap = (t) => h("div", { class: "cap", text: t });
  const nameOf = (list, id) => (list.find((d) => d.id === id) || {}).name || "";

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

  /* ───── audio sources ───── */

  const defaultFor = (kind, key) =>
    kind === "capture" ? devices.default.capture : key === "chat" ? devices.default.communications : devices.default.render;

  /** Select of devices; `allowNone` adds an empty choice (used for the optional backup device). */
  function deviceSelect(key, kind, cur, onPick, allowNone) {
    const list = kind === "render" ? devices.render : devices.capture;
    const defName = nameOf(list, defaultFor(kind, key));
    const real = cur && cur.id && cur.id !== FOLLOW;
    const match = real && list.find((d) => d.id === cur.id || d.name.toLowerCase() === (cur.name || "").toLowerCase());
    const opts = [];
    if (allowNone) opts.push(h("option", { value: "", text: "— wybierz urządzenie —", selected: !cur || !cur.id }));
    opts.push(h("option", { value: FOLLOW, selected: !!cur && cur.id === FOLLOW,
      text: `Domyślne urządzenie Windows${defName ? ` (teraz: ${defName})` : ""} — podąża za zmianą` }));
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
  function sharedOutput() {
    const idOf = (key) => {
      const p = cfg[key].primary;
      if (!p || !p.id) return "";
      if (p.id !== FOLLOW) return p.id;
      return key === "chat" ? devices.default.communications : devices.default.render;
    };
    const g = idOf("game"), c = idOf("chat");
    return !!g && g === c;
  }

  /** One card per audio source: main device, live level, optional (hidden by default) backup device. */
  function sourceCards(onChange) {
    const wrap = h("div", { class: "stack", id: "recSources" });
    const draw = () => {
      const shared = sharedOutput();
      const callout = (shared || cfg.chat_app) ? h("div", { class: "callout",
        title: "Gra i czat dzielą jedno wyjście. Wskaż aplikację czatu, a jej dźwięk trafi tylko na ścieżkę Czat, a ścieżka Gra dostanie całą resztę." },
        h("span", { text: "Wspólne wyjście · aplikacja czatu" }),
        h("select", { class: "field", onChange: (e) => { cfg.chat_app = e.target.value; onChange("chat_app"); draw(); } },
          CHAT_APPS.map(([v, t]) => h("option", { value: v, text: t, selected: (cfg.chat_app || "") === v })))) : null;
      wrap.replaceChildren(...SRC.flatMap(([key, name, label, kind, desc]) => {
        const c = cfg[key];
        const showBackup = !!c.secondary;
        const card = h("div", { class: "src", "data-src": name, title: desc },
          h("div", { class: "nm", text: label }),
          h("div", { class: "meter" }, h("div")),
          h("div", { class: "st", text: "—" }),
          h("div", { class: "pick" },
            deviceSelect(key, kind, c.primary, (v) => { cfg[key] = { ...cfg[key], primary: v }; onChange(key); draw(); }, false)),
          showBackup
            ? h("div", { class: "pick pathrow", title: "Zapasowe: włączy się, gdy główne urządzenie zostanie odłączone" },
              deviceSelect(key, kind, c.secondary, (v) => { cfg[key] = { ...cfg[key], secondary: v }; onChange(key); draw(); }, true),
              h("button", { class: "btn ghost", text: "✕", title: "Usuń urządzenie zapasowe", onClick: () => { cfg[key] = { ...cfg[key], secondary: null }; onChange(key); draw(); } }))
            : h("button", { class: "linkbtn", text: "+ zapasowe", title: "Urządzenie, które włączy się, gdy główne zostanie odłączone", onClick: () => {
              cfg[key] = { ...cfg[key], secondary: { id: "", name: "" } };   // placeholder until a device is picked
              draw();
            } }));
        return key === "chat" && callout ? [card, callout] : [card];
      }));
      pollMeters();
    };
    draw();
    return wrap;
  }

  /** Live level of each configured source (works with or without the recorder running). */
  function pollMeters() {
    clearInterval(meterTimer);
    const tick = async () => {
      const rows = [...document.querySelectorAll("#recSources .src")];
      if (!rows.length) { clearInterval(meterTimer); return; }
      const ids = SRC.map(([key, , , kind]) => {
        if (cfg.chat_app && key === "chat") return "@app:" + cfg.chat_app;
        if (cfg.chat_app && key === "game") return "@appx:" + cfg.chat_app;
        const p = cfg[key].primary;
        if (!p || !p.id) return "";
        if (p.id !== FOLLOW) return p.id;
        return kind === "capture" ? "@default:capture" : key === "chat" ? "@default:comm" : "@default:render";
      });
      const levels = await api.invoke("recorder_levels", { ids: ids.filter(Boolean) }).catch(() => ({}));
      for (const row of rows) {
        const i = SRC.findIndex((s) => s[1] === row.dataset.src);
        const lv = levels[ids[i]] ?? 0;
        const bar = row.querySelector(".meter div");
        if (bar) bar.style.width = `${Math.min(100, lv * 140)}%`;
      }
    };
    meterTimer = setInterval(tick, 700);
    tick();
  }

  /* ───── video quality with live estimates ───── */

  const RES = [[1280, "720p"], [1920, "1080p"], [2560, "1440p"], [0, "Natywna"]];
  const QUAL = [[8000, "Oszczędna"], [14000, "Standard"], [30000, "Wysoka"]];
  const LEN = [[30, "30 s"], [60, "1 min"], [120, "2 min"], [300, "5 min"]];
  const POST_ROLL = [[0, "Od razu"], [10, "10 s"], [30, "30 s"], [60, "60 s"]];

  const seg = (items, cur, on) => h("div", { class: "seg wrap" }, items.map(([v, t]) =>
    h("button", { class: String(cur) === String(v) ? "on" : "", text: t, onClick: () => on(v) })));

  function outputSize(c) {
    const mon = monitors.find((m) => m.index === c.monitor) || monitors[0] || { width: 1920, height: 1080 };
    const w = c.width > 0 ? Math.min(c.width, mon.width) : mon.width;
    return [w, Math.round((mon.height * w) / mon.width / 2) * 2];
  }

  function estimates(c) {
    const [w, hgt] = outputSize(c);
    const audioKbps = 3 * 192;
    const clipMb = ((c.video_kbps + audioKbps) * c.buffer_seconds) / 8000;
    const diskMb = clipMb * (1 + 8 / c.buffer_seconds);                  // plus the segments being written
    const ramMb = 200 + 170 * ((w * hgt * c.fps) / (1920 * 804 * 30));   // calibrated on one measurement (367 MB @ 1080p30)
    return { w, hgt, clipMb, diskMb, ramMb };
  }

  const fmtMb = (mb) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`);

  function meterBar(label, value, scaleMax, ticks, val, text, quiet) {
    return h("div", { class: "est", title: quiet ? text : "" },
      h("div", { class: "top" }, h("span", { text: label }), h("b", { text: value })),
      h("div", { class: "bar" }, h("i", { style: { width: `${Math.min(100, (val / scaleMax) * 100)}%` } }),
        ...ticks.map(([at, t]) => h("u", { style: { left: `${(at / scaleMax) * 100}%` }, title: t }))),
      quiet ? null : h("div", { class: "note muted", text }));
  }

  /** Controls on the left, what they will cost on the right. `onChange(patch)` persists. */
  function qualityBlock(c, onChange) {
    const root = h("div", { class: "qual" });
    const draw = () => {
      const e = estimates(c);
      const fits = e.clipMb <= 10 ? "mieści się w Discordzie (10 MB)"
        : e.clipMb <= 50 ? "mieści się w Discordzie z boostem (50 MB)"
          : e.clipMb <= 500 ? "mieści się w Discordzie z Nitro (500 MB)"
            : "większy niż limity Discorda — przy eksporcie zostanie zmniejszony";
      const hw = tools && tools.encoder && tools.encoder !== "libx264";
      const set = (patch) => { Object.assign(c, patch); onChange(patch); draw(); };
      const customQ = !QUAL.some(([v]) => v === c.video_kbps);
      root.replaceChildren(
        h("div", { class: "controls" },
          h("div", null, cap("Rozdzielczość"), seg(RES, c.width, (v) => set({ width: +v }))),
          h("div", null, cap("Klatki na sekundę"), seg([[30, "30 fps"], [60, "60 fps"]], c.fps, (v) => set({ fps: +v }))),
          h("div", null, cap("Jakość obrazu"),
            seg([...QUAL, ...(customQ ? [[c.video_kbps, `${c.video_kbps / 1000} Mb/s`]] : [])], c.video_kbps, (v) => set({ video_kbps: +v }))),
          h("div", null, cap("Długość zapisywanego klipu"), seg(LEN, c.buffer_seconds, (v) => set({ buffer_seconds: +v }))),
          monitors.length > 1
            ? h("div", null, cap("Który ekran nagrywać"),
              seg(monitors.map((m) => [m.index, `${m.index + 1}: ${m.width}×${m.height}${m.primary ? " ★" : ""}`]), c.monitor, (v) => set({ monitor: +v })))
            : null),
        h("div", { class: "estimates" },
          h("div", { class: "cap", text: "Co to zajmie" }),
          meterBar("Jeden klip", fmtMb(e.clipMb), 500, [[10, "Discord 10 MB"], [50, "Discord 50 MB"]], e.clipMb, fits),
          meterBar("Bufor na dysku", fmtMb(e.diskMb), 1000, [], e.diskMb, "tymczasowy, nadpisywany"),
          meterBar("Pamięć RAM", `≈ ${fmtMb(e.ramMb)}`, 2000, [], e.ramMb, "szacunek"),
          h("div", { class: "est" },
            h("div", { class: "top" }, h("span", { text: "Obciążenie" }), h("b", { text: hw ? "GPU" : "CPU" })),
            h("div", { class: "note muted", text: hw ? "nie obciąża gry" : "może obniżyć FPS" })),
          h("div", { class: "note muted", text: `Obraz zapisywany w ${e.w}×${e.hgt} px, ${c.fps} fps. 10 klipów ≈ ${fmtMb(e.clipMb * 10)}.` })));
    };
    draw();
    return root;
  }

  /* ───── hotkey field ───── */

  const hotkeyInput = (value, onSet) => h("input", { class: "field", value, readOnly: true,
    placeholder: "Kliknij i naciśnij skrót",
    onKeydown: (e) => {
      e.preventDefault();
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Win"].filter(Boolean);
      if (!mods.length) { App.toast("Skrót musi zawierać Ctrl, Alt, Shift lub Win", "err"); return; }
      const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      if (!/^([A-Z0-9]|F([1-9]|1\d|2[0-4]))$/.test(k)) { App.toast("Dozwolone: litery, cyfry i F1–F24", "err"); return; }
      const combo = [...mods, k].join("+");
      e.target.value = combo;
      onSet(combo);
    } });

  /* ───── settings tab ───── */

  async function renderTab(body) {
    await load();
    const toggle = (title, desc, on, set) => h("div", { class: "line", onClick: () => set(!on) },
      h("div", null, h("div", { class: "tt", text: title }), h("div", { class: "ds", text: desc })),
      h("span", { class: "toggle lg" + (on ? " on" : "") }));
    const rerender = () => App.Settings.render();
    const persistSources = () => save({ game: cfg.game, chat: cfg.chat, mic: cfg.mic, chat_app: cfg.chat_app });

    body.append(
      h("div", { class: "sec" }, cap("Stan"),
        h("div", { class: "statusbox", id: "recState" }),
        h("div", { style: { display: "flex", gap: "8px", marginTop: "10px", flexWrap: "wrap" } },
          h("button", { class: "btn acc", id: "recSave", text: "Zapisz klip teraz", onClick: async () => {
            try {
              const r = await api.invoke("recorder_cmd", { cmd: "save" });
              if (r.ok) { App.toast(`Zapisano: ${App.baseName(r.path)}`, "ok"); setTimeout(() => App.Lib.load(), 800); }
              else App.toast(`Nie zapisano: ${r.error}`, "err");
            } catch (e) { App.toast(`Nagrywanie nie działa: ${e}`, "err"); }
          } }),
          h("button", { class: "btn", id: "recToggle", onClick: async () => {
            if (S.recorder) await api.invoke("recorder_cmd", { cmd: "quit" }).catch(() => {});
            else await api.invoke("recorder_launch").catch((e) => App.toast(String(e), "err"));
            setTimeout(App.Rec.refresh, 1500);
          } }),
          h("button", { class: "btn ghost", text: "Uruchom kreator ustawień", onClick: () => wizard() }))),
      h("div", { class: "sec" }, cap("Źródła dźwięku"), sourceCards(persistSources)),
      h("div", { class: "sec" }, cap("Jakość nagrywania"),
        qualityBlock(cfg, (patch) => save(patch)),
        h("div", { style: { marginTop: "14px", maxWidth: "260px" } }, cap("Przesunięcie dźwięku (ms)"),
          h("input", { class: "field", type: "number", min: -500, max: 500, step: 10, value: cfg.audio_offset_ms, style: { width: "100%" },
            title: "Dodatnie opóźnia dźwięk względem obrazu. Dostrój, jeśli głos nie pasuje do ust.",
            onChange: (e) => save({ audio_offset_ms: Math.max(-500, Math.min(500, +e.target.value || 0)) }) }))),
      h("div", { class: "sec" }, cap("Skrót zapisu klipu"),
        hotkeyInput(cfg.hotkey, (c) => save({ hotkey: c }, "Skrót zadziała po ponownym uruchomieniu nagrywania")),
        h("div", { style: { marginTop: "14px" }, title: "Pojawia się jako ◆ na osi czasu w edytorze." }, cap("Znacznik w trakcie gry"),
          hotkeyInput(cfg.marker_hotkey || "Alt+M", (c) => save({ marker_hotkey: c }, "Skrót zadziała po ponownym uruchomieniu nagrywania"))),
        h("div", { style: { marginTop: "14px" }, title: "Po skrócie nagrywanie trwa jeszcze tyle sekund i dopiero wtedy zapisuje klip, więc w klipie są też chwile tuż po. Drugie naciśnięcie zapisuje od razu." }, cap("Dogrywaj po naciśnięciu skrótu"),
          seg(POST_ROLL, cfg.post_roll_seconds, (v) => save({ post_roll_seconds: +v }).then(rerender)),
          null)),
      toggle("Nagrywaj tylko gry", "Bufor i dźwięk tylko podczas gry", cfg.game_only,
        async (v) => { await save({ game_only: v }); rerender(); }),
      toggle("Nagrywaj monitor, na którym jest gra", "Przełącza się na ekran z grą", cfg.follow_game_monitor,
        async (v) => { await save({ follow_game_monitor: v }); rerender(); }),
      h("div", { class: "sec" }, cap("Folder zapisu"), h("div", { class: "pathrow" },
        h("input", { class: "field", value: cfg.output_dir, readOnly: true }),
        h("button", { class: "btn", text: "Zmień", onClick: async () => {
          const d = await api.pickFolder();
          if (d) { await save({ output_dir: d }); rerender(); }
        } }))),
      toggle("Osobny folder dla każdej gry", "Podfolder z nazwą gry", cfg.per_game_folders,
        async (v) => { await save({ per_game_folders: v }); rerender(); }),
      toggle("Okienko „Buffer aktywny”", "Przy starcie gry i zapisie klipu", cfg.popup,
        async (v) => { await save({ popup: v }); rerender(); }),
      h("div", { class: "sec" }, cap("Dodatkowe gry (nazwy procesów, po przecinku)"),
        h("input", { class: "field", style: { width: "100%" }, placeholder: "np. leagueclient, valorant",
          value: (cfg.extra_games || []).join(", "),
          title: "Gry uruchamiane w oknie wykrywamy tylko po nazwie procesu. Pełnoekranowe wykrywane są automatycznie.",
          onChange: (e) => save({ extra_games: e.target.value.split(",").map((x) => x.trim().toLowerCase().replace(/\.exe$/, "")).filter(Boolean) }) })),
      toggle("Uruchamiaj nagrywanie z systemem", "Startuje po zalogowaniu", autostart, async (v) => {
        autostart = await api.invoke("recorder_autostart", { enable: v }).catch(() => autostart);
        rerender();
      }));
    paint();
  }

  /** Updates the live parts (state line, active device per source) without rebuilding the tab. */
  function paint() {
    const r = S.recorder;
    const st = App.$("#recState");
    if (!st) return;
    const down = r ? r.sources.filter((s) => !s.live).map((s) => s.name) : [];
    const color = r && r.idle ? "var(--muted)" : !r || !r.recording ? "var(--err)" : down.length ? "var(--warn)" : "var(--ok)";
    const text = !r ? "● Nagrywanie nie działa"
      : r.idle ? "● Czeka na grę — nagrywa tylko, gdy gra jest uruchomiona"
      : !r.recording ? `● Zatrzymane${r.last_error ? ": " + r.last_error : ""}`
        : down.length ? `● Nagrywa, ale nie działa: ${down.join(", ")}`
          : `● Nagrywa · bufor ${r.buffer_s} / ${r.buffer_target_s} s`;
    st.replaceChildren(h("span", { style: { color }, text }),
      h("span", { class: "mono muted", text: r ? `skrót ${r.hotkey} · restarty ${r.restarts}` : "" }));
    const tgl = App.$("#recToggle");
    if (tgl) tgl.textContent = r ? "Zatrzymaj nagrywanie" : "Uruchom nagrywanie";
    const sv = App.$("#recSave");
    if (sv) sv.disabled = !r || (!r.recording && !r.idle);
    for (const row of document.querySelectorAll("#recSources .src")) {
      const src = r && r.sources.find((s) => s.name === row.dataset.src);
      const stEl = row.querySelector(".st");
      stEl.textContent = !src ? "—"
        : src.live ? `działa · ${ROLE[src.role] || src.role}`
          : src.status.replace(/^down: /, "brak: ");
      stEl.classList.toggle("bad", !!src && !src.live);
      stEl.title = src ? src.device : "";
    }
  }

  /* ───── first-run wizard ───── */

  const STEPS = ["Witaj", "Folder", "Dźwięk", "Obraz", "Skróty", "Gotowe"];

  async function wizard() {
    await load();
    const found = await api.invoke("detect_clip_folders").catch(() => []);
    const w = {
      step: 0,
      dir: App.P.libDirs[0] && !App.fresh ? App.P.libDirs[0] : cfg.output_dir,
      cfg: JSON.parse(JSON.stringify(cfg)),
      autostart: true,
      libs: new Set(found.map((f) => f.path)),
    };
    // First choices: follow the Windows default output (speakers OR headset, whichever is in use),
    // a dedicated "chat" endpoint if the hardware has one, and the default microphone.
    const hasChat = devices.render.find((d) => /chat|czat|communic/i.test(d.name));
    const follow = { id: FOLLOW, name: "Domyślne urządzenie Windows" };
    if (!w.cfg.game.primary) w.cfg.game.primary = follow;
    if (!w.cfg.chat.primary) w.cfg.chat.primary = hasChat ? { id: hasChat.id, name: hasChat.name } : follow;
    if (!w.cfg.mic.primary) w.cfg.mic.primary = follow;
    // One shared output is the common case: split the chat app out of the game track by default.
    cfg = { ...cfg, game: w.cfg.game, chat: w.cfg.chat, mic: w.cfg.mic, chat_app: w.cfg.chat_app };
    if (sharedOutput() && !w.cfg.chat_app) w.cfg.chat_app = "discord";

    const overlay = h("div", { class: "wiz" });
    document.body.append(overlay);
    const close = () => { clearInterval(meterTimer); overlay.remove(); };

    const render = () => {
      const c = w.cfg;
      clearInterval(meterTimer);
      let body;
      switch (w.step) {
        case 0:
          body = [
            h("div", { style: { display: "flex", alignItems: "center", gap: "14px" } }, App.logo(64),
              h("h2", { text: "Witaj w Buffer" })),
            h("p", { class: "muted", text: "Buffer nagrywa w tle ostatnie minuty. Jeden skrót zapisuje klip." }),
            h("div", { class: "stack" },
              h("div", { class: "statusbox" }, h("span", { text: "Nagrywanie i eksport (ffmpeg)" }),
                h("span", { style: { color: tools?.ffmpeg_found ? "var(--ok)" : "var(--err)" },
                  text: tools?.ffmpeg_found ? "● gotowe — wbudowane w aplikację" : "● brak ffmpeg — zainstaluj ponownie aplikację" })),
              h("div", { class: "statusbox" }, h("span", { text: "Kodowanie wideo" }),
                h("span", { style: { color: "var(--ok)" },
                  text: ({ h264_nvenc: "● karta NVIDIA (NVENC)", h264_amf: "● karta AMD (AMF)", h264_qsv: "● Intel (QuickSync)", libx264: "● procesor (CPU)" })[tools?.encoder] || "● wykrywanie…" }))),
          ];
          break;
        case 1:
          body = [
            h("h2", { text: "Gdzie zapisywać klipy?" }),
            ...(found.length ? [
              cap("Znalezione foldery z klipami — dodać do biblioteki?"),
              ...found.map((f) => h("div", { class: "found" + (w.libs.has(f.path) ? " on" : ""),
                onClick: () => { w.libs.has(f.path) ? w.libs.delete(f.path) : w.libs.add(f.path); render(); } },
                h("span", { class: "chk", text: w.libs.has(f.path) ? "✓" : "" }),
                h("div", null, h("div", { class: "mono", text: f.path }), h("div", { class: "muted", text: f.source })),
                h("span", { class: "mono muted", text: `${f.clips} klipów` }))),
            ] : []),
            cap("Nowe klipy zapisuj w"),
            h("div", { class: "pathrow" }, h("input", { class: "field", value: w.dir, readOnly: true }),
              h("button", { class: "btn", text: "Zmień", onClick: async () => { const d = await api.pickFolder(); if (d) { w.dir = d; render(); } } })),
            h("div", { class: "line", onClick: () => { c.per_game_folders = !c.per_game_folders; render(); } },
              h("div", null, h("div", { class: "tt", text: "Osobny folder dla każdej gry" }),
                h("div", { class: "ds", text: "Podfolder z nazwą gry" })),
              h("span", { class: "toggle lg" + (c.per_game_folders ? " on" : "") })),
          ];
          break;
        case 2:
          cfg = { ...cfg, game: c.game, chat: c.chat, mic: c.mic, chat_app: c.chat_app };   // the shared meter code reads `cfg`
          body = [
            h("h2", { text: "Skąd nagrywać dźwięk?" }),
            h("p", { class: "muted", text: "Domyślnie to, czego używasz w Windows. Każde źródło ma osobną ścieżkę." }),
            sourceCards(() => { c.game = cfg.game; c.chat = cfg.chat; c.mic = cfg.mic; c.chat_app = cfg.chat_app; }),
          ];
          break;
        case 3:
          body = [h("h2", { text: "Jakość obrazu" }), qualityBlock(c, () => {})];
          break;
        case 4:
          body = [
            h("h2", { text: "Skrót i zachowanie" }),
            cap("Skrót zapisu klipu"),
            hotkeyInput(c.hotkey, (k) => { c.hotkey = k; }),
            cap("Dogrywaj po naciśnięciu skrótu"),
            seg(POST_ROLL, c.post_roll_seconds, (v) => { c.post_roll_seconds = +v; render(); }),
            h("div", { class: "line", onClick: () => { c.game_only = !c.game_only; render(); } },
              h("div", null, h("div", { class: "tt", text: "Nagrywaj tylko gry" }),
                h("div", { class: "ds", text: "Bufor i dźwięk tylko podczas gry" })),
              h("span", { class: "toggle lg" + (c.game_only ? " on" : "") })),
            h("div", { class: "line", onClick: () => { c.popup = !c.popup; render(); } },
              h("div", null, h("div", { class: "tt", text: "Okienko „Buffer aktywny”" }),
                h("div", { class: "ds", text: "Skrót i ostrzeżenia o dźwięku" })),
              h("span", { class: "toggle lg" + (c.popup ? " on" : "") })),
            h("div", { class: "line", onClick: () => { w.autostart = !w.autostart; render(); } },
              h("div", null, h("div", { class: "tt", text: "Uruchamiaj z Windows" }),
                h("div", { class: "ds", text: "Startuje po zalogowaniu" })),
              h("span", { class: "toggle lg" + (w.autostart ? " on" : "") })),
          ];
          break;
        default: {
          const e = estimates(c);
          body = [
            h("h2", { text: "Wszystko gotowe" }),
            h("div", { class: "stack" },
              h("div", { class: "statusbox" }, h("span", { text: "Folder" }), h("span", { class: "mono", text: w.dir })),
              h("div", { class: "statusbox" }, h("span", { text: "Skrót zapisu" }), h("span", { class: "mono", text: c.hotkey })),
              h("div", { class: "statusbox" }, h("span", { text: "Obraz" }),
                h("span", { class: "mono", text: `${e.w}×${e.hgt} · ${c.fps} fps · klip ${c.buffer_seconds} s ≈ ${fmtMb(e.clipMb)}` })),
              h("div", { class: "statusbox" }, h("span", { text: "Dźwięk" }),
                h("span", { class: "mono", text: SRC.map(([k, n]) => `${n}: ${c[k].primary ? (c[k].primary.id === FOLLOW ? "domyślne" : "ok") : "brak"}`).join(" · ") }))),
            h("p", { class: "muted", text: "Wszystko zmienisz później w Ustawieniach." }),
          ];
        }
      }

      const last = w.step === STEPS.length - 1;
      overlay.replaceChildren(h("div", { class: "wizcard" },
        h("div", { class: "wizsteps" }, STEPS.map((t, i) => h("span", { class: "s" + (i === w.step ? " on" : i < w.step ? " ok" : "") }, t))),
        h("div", { class: "wizbody" }, body),
        h("div", { class: "wizfoot" },
          h("button", { class: "btn ghost", text: "Użyj ustawień domyślnych",
            title: "Domyślne urządzenia Windows, folder Wideo/Buffer, skrót Alt+Q", onClick: async () => { await finish(); } }),
          h("span", { style: { flex: 1 } }),
          w.step > 0 ? h("button", { class: "btn", text: "Wstecz", onClick: () => { w.step--; render(); } }) : null,
          h("button", { class: "btn acc", text: last ? "Zakończ i włącz nagrywanie" : "Dalej", onClick: async () => {
            if (!last) { w.step++; render(); return; }
            await finish();
          } }))));
    };

    async function finish() {
      const c = w.cfg;
      c.output_dir = w.dir;
      for (const [k] of SRC) if (c[k].secondary && !c[k].secondary.id) c[k].secondary = null;
      cfg = { ...cfg, ...c };
      await api.invoke("set_recorder_config", { config: cfg });
      App.P.libDirs = [w.dir, ...found.filter((f) => w.libs.has(f.path)).map((f) => f.path)]
        .filter((p, i, a) => p && a.indexOf(p) === i);
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

    render();
  }

  return { renderTab, paint, wizard };
})();
