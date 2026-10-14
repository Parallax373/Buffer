"use strict";
/* Navigation, export queue + list, settings (including recorder control). */

(function () {
  const { h, S, api } = App;

  /* ───── navigation ───── */

  const NAV = [["lib", "▦", "Biblioteka"], ["ed", "✂", "Edytor"], ["exp", "⇪", "Eksporty"]];
  const VIEWS = { lib: "#v-lib", ed: "#v-ed", exp: "#v-exp", set: "#v-set" };

  App.go = (view) => {
    if (view === "ed" && !App.Ed.current()) view = "lib";
    if (S.view === "ed" && view !== "ed") App.Ed.leave();
    S.view = view;
    for (const [v, sel] of Object.entries(VIEWS)) App.$(sel).hidden = v !== view;
    if (view === "lib") App.Lib.render(false);
    if (view === "exp") App.Exports.render();
    if (view === "set") Settings.render();
    renderNav();
  };

  function renderNav() {
    const nav = App.$("#nav");
    const r = S.recorder;
    const state = !r ? "bad" : !r.recording ? "bad" : r.sources.every((s) => s.live) ? "ok" : "warn";
    const label = !r ? "REC wył." : state === "ok" ? "REC" : state === "warn" ? "REC !" : "REC wył.";
    nav.replaceChildren(
      h("div", { class: "logo" }, App.logo(40)),
      ...NAV.map(([v, ic, lb]) => h("button", { class: "item" + (S.view === v ? " on" : ""), onClick: () => App.go(v) },
        h("div", { class: "ic", text: ic }), h("div", { class: "lb", text: lb }), h("div", { class: "bar" }))),
      h("div", { class: "grow" }),
      h("button", { class: `rec ${state}`, title: recTooltip(), onClick: () => { Settings.tab = "rec"; App.go("set"); } },
        h("span", { class: "dot" }), h("div", { class: "lb", text: label })),
      h("button", { class: "item" + (S.view === "set" ? " on" : ""), onClick: () => App.go("set") },
        h("div", { class: "ic", text: "⚙" }), h("div", { class: "lb", text: "Ustawienia" }), h("div", { class: "bar" })));
  }
  App.renderNav = renderNav;

  function recTooltip() {
    const r = S.recorder;
    if (!r) return "Nagrywanie nie działa — kliknij, aby uruchomić";
    if (!r.recording) return r.last_error || "Nagrywanie zatrzymane";
    const down = r.sources.filter((s) => !s.live).map((s) => s.name);
    return down.length ? `Nie działa: ${down.join(", ")}` : `Nagrywa · bufor ${r.buffer_s}/${r.buffer_target_s} s`;
  }

  /* ───── recorder polling ───── */

  const Rec = (App.Rec = {});
  let pollTimer = 0;
  Rec.refresh = async () => {
    try { S.recorder = await api.invoke("recorder_cmd", { cmd: "status" }); } catch { S.recorder = null; }
    renderNav();
    if (S.view === "set" && Settings.tab === "rec") Settings.paintRecorder();
  };
  Rec.start = () => {
    const loop = async () => {
      if (!document.hidden) await Rec.refresh();
      pollTimer = setTimeout(loop, S.view === "set" && Settings.tab === "rec" ? 700 : 4000);
    };
    clearTimeout(pollTimer);
    loop();
  };

  /* ───── exports ───── */

  const Exports = (App.Exports = {});
  const exQueue = [];

  /** Runs one export with the editor's or the quick-export defaults. Resolves with the finished file or null. */
  Exports.run = async (o) => {
    if (S.exporting) { App.toast("Eksport już trwa", "err"); return null; }
    const clip = S.byPath.get(o.path);
    if (!clip) return null;
    const s = App.P.settings;
    const mb = o.target ?? s.defTarget;
    const dir = App.exportDirFor();
    const suffix = (o.wide != null ? "_16x9" : "") + (o.speed && o.speed !== 1 ? `_${o.speed}x` : "");
    const output = `${dir}\\${clip.name}${suffix}_${mb}MB.mp4`;
    const volumes = o.volumes || ["Game", "Chat", "Mic"].map((n) => [n, (App.P.gains[n] ?? 100) / 100]);
    const opts = {
      input: clip.path, output, start: o.start ?? 0, end: o.end ?? null,
      target_bytes: Math.round(mb * 1048576), max_height: o.maxHeight ?? null,
      codec: o.codec || "auto", audio_kbps: 128, volumes,
      crop_wide: o.wide ?? null, speed: o.speed ?? 1, normalize: o.normalize ?? s.normDef, hwaccel: s.hw,
    };
    S.exporting = { name: App.gameOf(clip), pct: 0, source: clip.path };
    notifyState();
    try {
      const r = await api.invoke("export_clip", { opts });
      const entry = { id: `e${Date.now()}`, name: output.slice(output.lastIndexOf("\\") + 1), path: output,
        source: clip.path, size: +(r.size / 1048576).toFixed(2), target: mb,
        dur: ((o.end ?? (App.Lib.meta(clip) || {}).dur ?? 0) - (o.start ?? 0)) / (o.speed || 1), created: Date.now() };
      App.P.exports.unshift(entry);
      App.P.exports = App.P.exports.slice(0, 200);
      App.persist();
      App.toast(`Gotowe: ${entry.size} MiB (cel ${mb})`, "ok");
      return { name: entry.name, path: output, size: entry.size };
    } catch (e) {
      App.toast(`Eksport nie powiódł się: ${e}`, "err");
      if (App.Ed.current()) App.Ed.current().error = String(e);
      return null;
    } finally {
      S.exporting = null;
      notifyState();
    }
  };

  function notifyState() {
    App.Ed.onExportState();
    if (S.view === "exp") Exports.render();
    if (S.view === "lib") App.Lib.renderSide();
  }

  Exports.quick = async (path) => {
    const r = await Exports.run({ path });
    if (r && App.P.settings.drag) App.toast(`${r.name} — przeciągnij z zakładki Eksporty do Discorda`, "ok");
  };

  Exports.batch = async (paths) => {
    exQueue.push(...paths);
    let n = 0;
    const total = exQueue.length;
    while (exQueue.length) {
      const p = exQueue.shift();
      n++;
      App.toast(`Partia ${n}/${total}`);
      await Exports.run({ path: p });
    }
    App.Lib.clearSel();
    App.go("exp");
  };

  api.listen("export-progress", (e) => {
    if (!S.exporting) return;
    S.exporting.pct = e.payload * 100;
    App.Ed.onProgress(S.exporting.pct);
    const bar = App.$("#exBar"), t = App.$("#exPct");
    if (bar) bar.style.width = `${S.exporting.pct}%`;
    if (t) t.textContent = `${Math.round(S.exporting.pct)}%`;
  });

  Exports.render = () => {
    const root = App.$("#v-exp");
    const list = h("div", { class: "explist" }, h("h1", { text: "Eksporty" }));
    if (S.exporting) {
      list.append(h("div", { class: "exrow run" },
        h("div", { style: { display: "flex", justifyContent: "space-between" } },
          h("b", { text: S.exporting.name }), h("span", { class: "mono", id: "exPct", text: `${Math.round(S.exporting.pct)}%` })),
        h("div", { class: "prog", style: { marginTop: "10px" } }, h("div", { class: "b" },
          h("div", { id: "exBar", style: { width: `${S.exporting.pct}%` } })))));
    }
    if (!App.P.exports.length && !S.exporting) {
      list.append(h("div", { class: "muted", text: "Tu pojawią się wyeksportowane klipy." }));
    }
    for (const e of App.P.exports) {
      const th = h("div", { class: "th" });
      App.Lib.thumbUrl(e.path).then((u) => { if (u) th.style.backgroundImage = `url("${u}")`; });
      const drag = h("button", { class: "btn drag", text: "⇪ Przeciągnij", title: "Przeciągnij do Discorda" });
      drag.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        api.startDrag(e.path).catch((err) => App.toast(`Nie udało się przeciągnąć: ${err}`, "err"));
      });
      list.append(h("div", { class: "exrow" }, th,
        h("div", { style: { minWidth: 0 } }, h("div", { class: "nm", text: e.name }),
          h("div", { class: "mt", text: `${App.fmtS(e.dur)} · cel ${e.target} MB · ${new Date(e.created).toLocaleString("pl-PL")}` })),
        h("div", { class: "sz", text: `${e.size} MiB` }),
        h("div", { class: "ac" },
          h("button", { class: "btn ghost", text: "Pokaż", onClick: () => api.invoke("reveal", { path: e.path }) }), drag)));
    }
    root.replaceChildren(list);
  };

  /* ───── settings ───── */

  const Settings = (App.Settings = { tab: "look" });
  const TABS = [["rec", "Nagrywanie"], ["look", "Wygląd"], ["gen", "Ogólne"], ["exp", "Eksport"], ["keys", "Skróty"], ["adv", "Zaawansowane"]];
  const THEMES = [["graphite", "Grafit", ["#121316", "#181a1f", "#20232a", "#2a2e36"]],
    ["oled", "OLED czerń", ["#000000", "#0a0a0c", "#151619", "#222328"]],
    ["slate", "Chłodny granat", ["#0f1218", "#151a23", "#1d2430", "#2a3342"]]];
  const ACCENTS = ["#c6f432", "#ff6a1f", "#8b7bff", "#1fc7a8", "#ff5c8a"];
  let tools = null;

  const cap = (t) => h("div", { class: "cap", text: t });
  const sec = (title, ...kids) => h("div", { class: "sec" }, cap(title), ...kids);
  const line = (title, desc, key, after) => h("div", { class: "line", onClick: () => {
    App.P.settings[key] = !App.P.settings[key];
    App.persist(); App.applyTheme(); Settings.render(); after?.();
  } }, h("div", null, h("div", { class: "tt", text: title }), h("div", { class: "ds", text: desc })),
  h("span", { class: "toggle lg" + (App.P.settings[key] ? " on" : "") }));

  Settings.render = async () => {
    const root = App.$("#v-set");
    const body = h("div", { class: "body" });
    root.replaceChildren(h("div", { class: "set" },
      h("div", { class: "tabs" }, h("h1", { text: "Ustawienia" }),
        TABS.map(([k, t]) => h("button", { class: Settings.tab === k ? "on" : "", text: t,
          onClick: () => { Settings.tab = k; Settings.render(); } }))),
      body));
    const s = App.P.settings;
    switch (Settings.tab) {
      case "rec": await App.RecUI.renderTab(body); break;
      case "look":
        body.append(
          sec("Motyw", h("div", { class: "themes" }, THEMES.map(([k, name, c]) =>
            h("button", { class: "th" + (s.theme === k ? " on" : ""), onClick: () => { s.theme = k; App.persist(); App.applyTheme(); Settings.render(); } },
              h("div", { class: "pv", style: { background: c[0], borderColor: c[3] } },
                h("div", { style: { background: c[1] } }),
                h("div", null, h("i", { style: { width: "60%", background: c[2] } }),
                  h("i", { style: { width: "30%", background: "var(--acc)", marginTop: "6px" } }))),
              h("div", { class: "nm", text: name }))))),
          sec("Akcent", h("div", { class: "accents" }, ACCENTS.map((c) =>
            h("button", { class: s.accent === c ? "on" : "", style: { background: c }, "aria-label": c,
              onClick: () => { s.accent = c; App.persist(); App.applyTheme(); Settings.render(); } })))),
          sec("Rozmiar miniatur", h("div", { class: "seg big" }, ["S", "M", "L"].map((k) =>
            h("button", { class: s.thumb === k ? "on" : "", text: k, onClick: () => { s.thumb = k; App.persist(); Settings.render(); } })))),
          line("Animacje interfejsu", "Płynne przejścia i podświetlenia", "anim"),
          line("Tryb oszczędny", "Wyłącza poświatę i półprzezroczystości — mniej pracy GPU", "lite"));
        break;
      case "gen": await renderGeneral(body); break;
      case "exp":
        body.append(
          sec("Domyślny cel", h("div", { class: "seg big" }, [["Discord", 10], ["Boost", 50], ["Nitro", 500]].map(([n, mb]) =>
            h("button", { class: s.defTarget === mb ? "on" : "", text: `${n} · ${mb} MB`,
              onClick: () => { s.defTarget = mb; App.persist(); Settings.render(); } })))),
          sec("Folder wyjściowy", h("div", { class: "pathrow" },
            h("input", { class: "field", value: App.exportDirFor(), readOnly: true }),
            h("button", { class: "btn", text: "Zmień", onClick: async () => {
              const d = await api.pickFolder();
              if (d) { s.outDir = d; App.persist(); Settings.render(); }
            } }),
            s.outDir ? h("button", { class: "btn ghost", text: "Domyślny", onClick: () => { s.outDir = ""; App.persist(); Settings.render(); } }) : null)),
          line("Normalizuj głośność domyślnie", "−16 LUFS dla każdego eksportu", "normDef"),
          line("Pokaż chip przeciągania po eksporcie", "Przeciągnij gotowy plik prosto do Discorda", "drag"));
        break;
      case "keys":
        body.append(h("div", { style: { display: "flex", flexDirection: "column" } },
          [["Odtwórz / pauza", "Spacja"], ["Ustaw początek", "I"], ["Ustaw koniec", "O"], ["Krok 1 s wstecz / dalej", "← / →"],
            ["Krok 5 s", "Shift + ← / →"], ["Eksportuj", "Ctrl + E"], ["Następny / poprzedni klip", "J / K"],
            ["Szukaj w bibliotece", "Ctrl + F"]].map(([l, k]) =>
            h("div", { class: "keyrow" }, h("span", { text: l }), h("kbd", { text: k })))));
        break;
      case "adv": await renderAdvanced(body); break;
    }
  };

  async function renderGeneral(body) {
    const s = App.P.settings;
    tools = tools || (await api.invoke("tools_status").catch(() => null));
    body.append(
      sec("Foldery biblioteki", h("div", { class: "stack" },
        App.P.libDirs.map((d, i) => h("div", { class: "pathrow" },
          h("input", { class: "field", value: d, readOnly: true }),
          h("button", { class: "btn", text: "Zmień", onClick: async () => {
            const n = await api.pickFolder();
            if (n) { App.P.libDirs[i] = n; App.persist(); await App.Lib.load(); Settings.render(); }
          } }),
          App.P.libDirs.length > 1 ? h("button", { class: "btn danger", text: "Usuń", onClick: async () => {
            App.P.libDirs.splice(i, 1); App.persist(); await App.Lib.load(); Settings.render();
          } }) : null)),
        h("div", null, h("button", { class: "btn", text: "+ Dodaj folder", onClick: async () => {
          const n = await api.pickFolder();
          if (n && !App.P.libDirs.includes(n)) { App.P.libDirs.push(n); App.persist(); await App.Lib.load(); Settings.render(); }
        } })))),
      sec("Narzędzia", h("div", { class: "stack" },
        h("div", { class: "statusbox" }, h("span", { text: tools?.ffmpeg_found ? `ffmpeg ${tools.ffmpeg_version} · ffprobe` : "ffmpeg" }),
          h("span", { style: { color: tools?.ffmpeg_found ? "var(--ok)" : "var(--err)" },
            text: tools?.ffmpeg_found ? (tools.ffmpeg_bundled ? "● wbudowane w aplikację" : "● znaleziono w systemie") : "● nie znaleziono — zainstaluj aplikację ponownie" })),
        h("div", { class: "statusbox" }, h("span", { text: "Kodowanie wideo" }),
          h("span", { style: { color: tools?.encoder && tools.encoder !== "libx264" ? "var(--ok)" : "var(--warn)" },
            text: ({ h264_nvenc: "● NVIDIA NVENC", h264_amf: "● AMD AMF", h264_qsv: "● Intel QuickSync", libx264: "● procesor (CPU) — wolniej" })[tools?.encoder] + (tools?.gpu ? " · " + tools.gpu : "") })))),
      line("Skanuj podfoldery", "Pomija „Exported Clips” i „Shared Clips”", "sub", () => App.Lib.load()),
      line("Odświeżaj bibliotekę przy starcie", "Wykrywa nowe nagrania", "auto"));
  }

  async function renderAdvanced(body) {
    const size = await api.invoke("cache_size").catch(() => 0);
    body.append(
      line("Miniatury w tle", "Jedna klatka na klip, tylko dla widocznych kart", "thumbs"),
      line("Pamięć podręczna audio", "Ścieżki wyodrębnione bez rekodowania", "cache"),
      line("Dekodowanie sprzętowe (NVDEC)", "Automatyczny powrót do CPU przy błędzie", "hw"),
      h("div", { class: "line static" },
        h("div", null, h("div", { class: "tt", text: "Pamięć podręczna" }),
          h("div", { class: "ds", text: `Wyodrębnione ścieżki audio, miniatury i fale · ${App.fmtMB(size)}` })),
        h("button", { class: "btn", text: "Wyczyść", onClick: async () => {
          await api.invoke("clear_cache").catch(() => {});
          App.toast("Wyczyszczono pamięć podręczną", "ok");
          Settings.render();
        } })));
  }

  /* The recording tab and the first-run wizard live in recording.js. */
  Settings.paintRecorder = () => App.RecUI.paint();
})();
