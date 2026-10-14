"use strict";
/* Recorder settings (Ustawienia → Nagrywanie) and the first-run setup wizard. */

App.RecUI = (function () {
  const { h, S, api } = App;
  const SRC = [["game", "Game", "Gra", "render"], ["chat", "Chat", "Czat", "render"], ["mic", "Mic", "Mikrofon", "capture"]];
  const ROLE = { primary: "główne", secondary: "zapasowe", auto: "automatycznie", waiting: "czeka na urządzenie" };
  const BASE = {
    output_dir: "", per_game_folders: false, buffer_seconds: 120, fps: 30, width: 1920, video_kbps: 14000, monitor: 0,
    encoder: "auto", audio_offset_ms: 0, hotkey: "Alt+Q", popup: true, extra_games: [], ignore_apps: [],
    game: { primary: null, secondary: null }, chat: { primary: null, secondary: null }, mic: { primary: null, secondary: null },
  };

  let cfg = { ...BASE };
  let devices = { render: [], capture: [] };
  let monitors = [];
  let autostart = false;

  const cap = (t) => h("div", { class: "cap", text: t });

  async function load() {
    const [c, d, m, a, dir] = await Promise.all([
      api.invoke("recorder_config").catch(() => ({})),
      api.invoke("recorder_devices").catch(() => ({ render: [], capture: [] })),
      api.invoke("recorder_monitors").catch(() => []),
      api.invoke("recorder_autostart", { enable: null }).catch(() => false),
      api.invoke("default_clips_dir").catch(() => ""),
    ]);
    cfg = { ...BASE, output_dir: dir, ...c };
    for (const [k] of SRC) cfg[k] = { primary: null, secondary: null, ...(c[k] || {}) };
    devices = d; monitors = m; autostart = a;
  }

  async function save(patch, hint = "") {
    cfg = { ...cfg, ...patch };
    await api.invoke("set_recorder_config", { config: cfg });
    if (S.recorder) {
      await api.invoke("recorder_cmd", { cmd: "reload" }).catch(() => {});
      if (hint) App.toast(hint);
    }
    App.Rec.refresh();
  }

  const refOf = (list, id) => {
    const d = list.find((x) => x.id === id);
    return d ? { id: d.id, name: d.name } : null;
  };

  /** <select> of endpoints. A configured device that is currently unplugged stays visible and selected. */
  function deviceSelect(list, cur, onPick, noneLabel) {
    const present = cur && list.some((d) => d.id === cur.id || d.name.toLowerCase() === cur.name.toLowerCase());
    const match = cur && list.find((d) => d.id === cur.id || d.name.toLowerCase() === cur.name.toLowerCase());
    const opts = [h("option", { value: "", text: noneLabel, selected: !cur })];
    if (cur && !present) opts.push(h("option", { value: cur.id, text: `${cur.name} (odłączone)`, selected: true }));
    for (const d of list) opts.push(h("option", { value: d.id, text: d.name, selected: !!match && match.id === d.id }));
    return h("select", { class: "field", onChange: (e) => onPick(e.target.value ? (refOf(list, e.target.value) || cur) : null) }, opts);
  }

  function sourcesBox(onChange) {
    return h("div", { class: "stack", id: "recSources" }, SRC.map(([key, name, label, kind]) => {
      const list = kind === "render" ? devices.render : devices.capture;
      return h("div", { class: "src", "data-src": name },
        h("div", { class: "nm", text: label }),
        h("div", { class: "meter" }, h("div")),
        h("div", { class: "st", text: "—" }),
        h("div", { class: "pair" },
          h("label", null, h("span", { class: "muted", text: "Główne" }),
            deviceSelect(list, cfg[key].primary, (v) => { cfg[key] = { ...cfg[key], primary: v }; onChange(key); }, "— nie ustawiono —")),
          h("label", null, h("span", { class: "muted", text: "Zapasowe (gdy główne odłączone)" }),
            deviceSelect(list, cfg[key].secondary, (v) => { cfg[key] = { ...cfg[key], secondary: v }; onChange(key); }, "— brak —"))),
        h("div", { class: "hint2 muted", text: "Po odłączeniu głównego nagrywanie przechodzi na zapasowe; gdy główne wróci, wraca na nie. Ustawienia nigdy nie są zmieniane automatycznie." }));
    }));
  }

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

  const pick = (cur, list, on) => h("select", { class: "field", onChange: (e) => on(e.target.value) },
    list.map(([v, t]) => h("option", { value: v, text: t, selected: String(cur) === String(v) })));

  const monitorList = () => monitors.length
    ? monitors.map((m) => [m.index, `${m.index + 1}: ${m.width}×${m.height}${m.primary ? " (główny)" : ""}`])
    : [[0, "Główny"]];

  const clipSize = () => {
    const mb = (cfg.video_kbps * cfg.buffer_seconds) / 8000;
    return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
  };

  /* ───── settings tab ───── */

  async function renderTab(body) {
    await load();
    const toggle = (title, desc, on, set) => h("div", { class: "line", onClick: () => set(!on) },
      h("div", null, h("div", { class: "tt", text: title }), h("div", { class: "ds", text: desc })),
      h("span", { class: "toggle lg" + (on ? " on" : "") }));
    const rerender = () => App.Settings.render();

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
      h("div", { class: "sec" }, cap("Źródła dźwięku"), sourcesBox(async () => { await save({ game: cfg.game, chat: cfg.chat, mic: cfg.mic }); })),
      h("div", { class: "sec" }, cap("Jakość nagrywania"), h("div", { class: "twocol" },
        h("div", null, cap("Długość klipu"), pick(cfg.buffer_seconds, [[30, "30 s"], [60, "1 min"], [120, "2 min"], [180, "3 min"], [300, "5 min"]],
          (v) => save({ buffer_seconds: +v }).then(rerender))),
        h("div", null, cap("Klatki na sekundę"), pick(cfg.fps, [[24, "24 fps"], [30, "30 fps"], [60, "60 fps"], [120, "120 fps"]], (v) => save({ fps: +v }))),
        h("div", null, cap("Rozdzielczość (szerokość)"), pick(cfg.width, [[0, "natywna"], [3840, "3840 px (4K)"], [2560, "2560 px (1440p)"], [1920, "1920 px (1080p)"], [1280, "1280 px (720p)"]],
          (v) => save({ width: +v }))),
        h("div", null, cap("Bitrate wideo"), pick(cfg.video_kbps, [[8000, "8 Mb/s"], [14000, "14 Mb/s"], [20000, "20 Mb/s"], [30000, "30 Mb/s"], [45000, "45 Mb/s"], [60000, "60 Mb/s"]],
          (v) => save({ video_kbps: +v }).then(rerender))),
        h("div", null, cap("Monitor"), pick(cfg.monitor, monitorList(), (v) => save({ monitor: +v }))),
        h("div", null, cap("Przesunięcie dźwięku (ms)"),
          h("input", { class: "field", type: "number", min: -500, max: 500, step: 10, value: cfg.audio_offset_ms, style: { width: "100%" },
            title: "Dodatnie opóźnia dźwięk względem obrazu. Dostrój, jeśli głos nie pasuje do ust.",
            onChange: (e) => save({ audio_offset_ms: Math.max(-500, Math.min(500, +e.target.value || 0)) }) }))),
      h("div", { class: "muted", style: { marginTop: "10px" }, text: `Jeden klip ≈ ${clipSize()}. Koder: ${S.recorder?.encoder || "automatyczny"}${S.recorder?.capture === "gdigrab" ? " · przechwytywanie awaryjne (GDI)" : ""}.` })),
      h("div", { class: "sec" }, cap("Skrót zapisu klipu"), hotkeyInput(cfg.hotkey, (c) => save({ hotkey: c }, "Skrót zadziała po ponownym uruchomieniu nagrywania"))),
      h("div", { class: "sec" }, cap("Folder zapisu"), h("div", { class: "pathrow" },
        h("input", { class: "field", value: cfg.output_dir, readOnly: true }),
        h("button", { class: "btn", text: "Zmień", onClick: async () => {
          const d = await api.pickFolder();
          if (d) { await save({ output_dir: d }); rerender(); }
        } }))),
      toggle("Osobny folder dla każdej gry", "Klipy trafiają do podfolderu o nazwie gry wewnątrz folderu zapisu", cfg.per_game_folders,
        async (v) => { await save({ per_game_folders: v }); rerender(); }),
      toggle("Okienko „Buffer aktywny”", "Pokazuje powiadomienie po uruchomieniu gry i po zapisaniu klipu", cfg.popup,
        async (v) => { await save({ popup: v }); rerender(); }),
      h("div", { class: "sec" }, cap("Dodatkowe gry (nazwy procesów, po przecinku)"),
        h("input", { class: "field", style: { width: "100%" }, placeholder: "np. leagueclient, valorant",
          value: (cfg.extra_games || []).join(", "),
          title: "Gry uruchamiane w oknie wykrywamy tylko po nazwie procesu. Pełnoekranowe wykrywane są automatycznie.",
          onChange: (e) => save({ extra_games: e.target.value.split(",").map((x) => x.trim().toLowerCase().replace(/\.exe$/, "")).filter(Boolean) }) })),
      toggle("Uruchamiaj nagrywanie z systemem", "Nagrywanie startuje po zalogowaniu, niezależnie od edytora", autostart, async (v) => {
        autostart = await api.invoke("recorder_autostart", { enable: v }).catch(() => autostart);
        rerender();
      }));
    paint();
  }

  /** Updates the live parts (state line, meters, active device per source) without rebuilding the tab. */
  function paint() {
    const r = S.recorder;
    const st = App.$("#recState");
    if (!st) return;
    const down = r ? r.sources.filter((s) => !s.live).map((s) => s.name) : [];
    const color = !r || !r.recording ? "var(--err)" : down.length ? "var(--warn)" : "var(--ok)";
    const text = !r ? "● Nagrywanie nie działa"
      : !r.recording ? `● Zatrzymane${r.last_error ? ": " + r.last_error : ""}`
        : down.length ? `● Nagrywa, ale nie działa: ${down.join(", ")}`
          : `● Nagrywa · bufor ${r.buffer_s} / ${r.buffer_target_s} s`;
    st.replaceChildren(h("span", { style: { color }, text }),
      h("span", { class: "mono muted", text: r ? `skrót ${r.hotkey} · restarty ${r.restarts}` : "" }));
    const tgl = App.$("#recToggle");
    if (tgl) tgl.textContent = r ? "Zatrzymaj nagrywanie" : "Uruchom nagrywanie";
    const sv = App.$("#recSave");
    if (sv) sv.disabled = !r || !r.recording;
    for (const row of document.querySelectorAll("#recSources .src, .wiz .src")) {
      const src = r && r.sources.find((s) => s.name === row.dataset.src);
      row.querySelector(".meter div").style.width = `${Math.min(100, (src ? src.level : 0) * 140)}%`;
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
    const tools = await api.invoke("tools_status").catch(() => null);
    // Sensible first guesses; nothing is saved until the end.
    const guess = (list, hint) => list.find((d) => d.name.toLowerCase().includes(hint)) || null;
    const active = (name) => S.recorder?.sources.find((s) => s.name === name);
    const first = (list, name, hint) => {
      if (cfg[name].primary) return cfg[name].primary;
      const a = active(name);
      const byActive = a && a.device && list.find((d) => d.name === a.device);
      const g = byActive || (hint && guess(list, hint)) || list[0];
      return g ? { id: g.id, name: g.name } : null;
    };
    const w = {
      step: 0,
      dir: App.P.libDirs[0] && !App.fresh ? App.P.libDirs[0] : cfg.output_dir,
      cfg: JSON.parse(JSON.stringify(cfg)),
      autostart: true,
    };
    w.cfg.game.primary = first(devices.render, "game", "game");
    w.cfg.chat.primary = first(devices.render, "chat", "chat");
    w.cfg.mic.primary = first(devices.capture, "mic", "");

    const overlay = h("div", { class: "wiz" });
    document.body.append(overlay);
    const close = () => overlay.remove();

    const render = () => {
      const c = w.cfg;
      let body;
      switch (w.step) {
        case 0:
          body = [
            h("div", { style: { display: "flex", alignItems: "center", gap: "14px" } }, App.logo(64),
              h("h2", { text: "Witaj w Buffer" })),
            h("p", { class: "muted", text: "Kilka szybkich pytań i nagrywanie działa samo w tle — nagrywa ostatnie minuty, a Ty zapisujesz klip jednym skrótem." }),
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
            h("div", { class: "pathrow" }, h("input", { class: "field", value: w.dir, readOnly: true }),
              h("button", { class: "btn", text: "Zmień", onClick: async () => { const d = await api.pickFolder(); if (d) { w.dir = d; render(); } } })),
            h("div", { class: "line", onClick: () => { c.per_game_folders = !c.per_game_folders; render(); } },
              h("div", null, h("div", { class: "tt", text: "Osobny folder dla każdej gry" }),
                h("div", { class: "ds", text: "np. …\\Counter-Strike-2\\klip.mp4 — porządek bez wysiłku" })),
              h("span", { class: "toggle lg" + (c.per_game_folders ? " on" : "") })),
          ];
          break;
        case 2:
          body = [
            h("h2", { text: "Źródła dźwięku" }),
            h("p", { class: "muted", text: "Każde źródło trafia do osobnej ścieżki klipu, więc w edytorze ustawisz głośność gry, czatu i mikrofonu osobno. Zapasowe urządzenie włączy się samo, gdy główne zostanie odłączone." }),
            h("div", { class: "stack", id: "wizSources" }, SRC.map(([key, name, label, kind]) => {
              const list = kind === "render" ? devices.render : devices.capture;
              return h("div", { class: "src", "data-src": name },
                h("div", { class: "nm", text: label }),
                h("div", { class: "meter" }, h("div")),
                h("div", { class: "st", text: "—" }),
                h("div", { class: "pair" },
                  h("label", null, h("span", { class: "muted", text: "Główne" }),
                    deviceSelect(list, c[key].primary, (v) => { c[key].primary = v; }, "— nie ustawiono —")),
                  h("label", null, h("span", { class: "muted", text: "Zapasowe" }),
                    deviceSelect(list, c[key].secondary, (v) => { c[key].secondary = v; }, "— brak —"))));
            })),
            h("p", { class: "muted", text: S.recorder ? "Paski pokazują poziom na żywo z aktualnie nagrywanych urządzeń." : "Nic nie jest nagrywane, dopóki nie zakończysz kreatora. Poziomy na żywo zobaczysz potem w Ustawieniach → Nagrywanie." }),
          ];
          break;
        case 3:
          body = [
            h("h2", { text: "Jakość obrazu" }),
            h("div", { class: "twocol" },
              h("div", null, cap("Klatki na sekundę"), pick(c.fps, [[30, "30 fps (zalecane)"], [60, "60 fps"]], (v) => { c.fps = +v; })),
              h("div", null, cap("Rozdzielczość"), pick(c.width, [[0, "natywna"], [2560, "1440p"], [1920, "1080p (zalecane)"], [1280, "720p"]], (v) => { c.width = +v; })),
              h("div", null, cap("Bitrate"), pick(c.video_kbps, [[8000, "8 Mb/s (małe pliki)"], [14000, "14 Mb/s (zalecane)"], [30000, "30 Mb/s (najlepsza jakość)"]], (v) => { c.video_kbps = +v; })),
              h("div", null, cap("Długość klipu"), pick(c.buffer_seconds, [[30, "30 s"], [60, "1 min"], [120, "2 min"], [300, "5 min"]], (v) => { c.buffer_seconds = +v; })),
              h("div", null, cap("Monitor"), pick(c.monitor, monitorList(), (v) => { c.monitor = +v; }))),
          ];
          break;
        case 4:
          body = [
            h("h2", { text: "Skrót i zachowanie" }),
            cap("Skrót zapisu klipu"),
            hotkeyInput(c.hotkey, (k) => { c.hotkey = k; }),
            h("div", { class: "line", onClick: () => { c.popup = !c.popup; render(); } },
              h("div", null, h("div", { class: "tt", text: "Okienko „Buffer aktywny”" }),
                h("div", { class: "ds", text: "Przypomina o skrócie po uruchomieniu gry i ostrzega, gdy mikrofon nie działa" })),
              h("span", { class: "toggle lg" + (c.popup ? " on" : "") })),
            h("div", { class: "line", onClick: () => { w.autostart = !w.autostart; render(); } },
              h("div", null, h("div", { class: "tt", text: "Uruchamiaj z Windows" }),
                h("div", { class: "ds", text: "Nagrywanie startuje po zalogowaniu — nie musisz o niczym pamiętać" })),
              h("span", { class: "toggle lg" + (w.autostart ? " on" : "") })),
          ];
          break;
        default:
          body = [
            h("h2", { text: "Wszystko gotowe" }),
            h("div", { class: "stack" },
              h("div", { class: "statusbox" }, h("span", { text: "Folder" }), h("span", { class: "mono", text: w.dir })),
              h("div", { class: "statusbox" }, h("span", { text: "Skrót zapisu" }), h("span", { class: "mono", text: c.hotkey })),
              h("div", { class: "statusbox" }, h("span", { text: "Jakość" }),
                h("span", { class: "mono", text: `${c.width || "natywna"}${c.width ? " px" : ""} · ${c.fps} fps · ${c.video_kbps / 1000} Mb/s · ${c.buffer_seconds} s` })),
              h("div", { class: "statusbox" }, h("span", { text: "Dźwięk" }),
                h("span", { class: "mono", text: SRC.map(([k, n]) => `${n}: ${c[k].primary ? "ok" : "brak"}`).join(" · ") }))),
            h("p", { class: "muted", text: "Wszystko zmienisz później w Ustawieniach." }),
          ];
      }

      const last = w.step === STEPS.length - 1;
      overlay.replaceChildren(h("div", { class: "wizcard" },
        h("div", { class: "wizsteps" }, STEPS.map((t, i) => h("span", { class: "s" + (i === w.step ? " on" : i < w.step ? " ok" : "") }, t))),
        h("div", { class: "wizbody" }, body),
        h("div", { class: "wizfoot" },
          h("button", { class: "btn ghost", text: "Użyj ustawień domyślnych", title: "Automatycznie wybrane urządzenia, folder Wideo/Buffer, skrót Alt+Q", onClick: async () => { await finish(); } }),
          h("span", { style: { flex: 1 } }),
          w.step > 0 ? h("button", { class: "btn", text: "Wstecz", onClick: () => { w.step--; render(); } }) : null,
          h("button", { class: "btn acc", text: last ? "Zakończ i włącz nagrywanie" : "Dalej", onClick: async () => {
            if (!last) { w.step++; render(); return; }
            await finish();
          } }))));
      paint();
    };

    async function finish() {
      const c = w.cfg;
      c.output_dir = w.dir;
      cfg = { ...cfg, ...c };
      await api.invoke("set_recorder_config", { config: cfg });
      App.P.libDirs = [w.dir];
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
