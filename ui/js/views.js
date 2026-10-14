"use strict";
/* Chrome around the views: top bar (search, REC pill, export chip), icon rail, export popover + history
   drawer, and settings. "Lime means now": playhead, selection, active item, progress. */

(function () {
  const { h, S, api } = App;
  const VIEWS = { lib: "#v-lib", ed: "#v-ed", set: "#v-set" };
  const NAV = [["lib", "▦", "Biblioteka"]];

  /* ───── navigation ───── */

  App.go = (view) => {
    if (view === "exp") view = "lib";                       // the standalone exports page is gone
    if (view === "ed" && !App.Ed.current()) view = "lib";
    if (S.view === "ed" && view !== "ed") App.Ed.leave();
    const changed = S.view !== view;
    S.view = view;
    for (const [v, sel] of Object.entries(VIEWS)) App.$(sel).hidden = v !== view;
    if (view === "lib") App.Lib.render(false);
    if (view === "set") Settings.render(true);
    renderRail();
    if (changed) wipe(App.$(VIEWS[view]));
  };

  /** A thin lime-edged sweep left → right over the incoming view, once. */
  function wipe(section) {
    if (!section || App.P.settings.anim === false) return;
    const w = h("div", { class: "wipe" }, h("div"));
    section.append(w);
    setTimeout(() => w.remove(), 700);
  }

  function renderRail() {
    const nav = App.$("#nav");
    const item = (view, icon, label, on) => h("button", { class: "item" + (on ? " on" : ""), "aria-label": label,
      onClick: () => App.go(view) }, h("span", { class: "ic", text: icon }), h("span", { class: "lb", text: label }));
    nav.replaceChildren(item("lib", "▦", "Biblioteka", S.view === "lib" || S.view === "ed"), h("div", { class: "grow" }),
      item("set", "⚙", "Ustawienia", S.view === "set"));
  }

  /** Own window buttons: the native title bar is turned off. */
  function windowControls() {
    const w = window.__TAURI__?.window?.getCurrentWindow?.();
    const btn = (cls, title, fn) => h("button", { class: "wc " + cls, title, "aria-label": title, onClick: () => w && fn(w) }, h("i"));
    return h("div", { class: "winctl" },
      btn("min", "Zminimalizuj", (x) => x.minimize()),
      btn("max", "Maksymalizuj", (x) => x.toggleMaximize()),
      btn("cls", "Zamknij", (x) => x.close()));
  }

  /* ───── top bar ───── */

  let savedUntil = 0;
  let savedDur = 0;
  const recPill = h("button", { class: "recpill off", onClick: () => onRecClick() });
  const chip = h("button", { class: "expchip", onClick: () => Exports.togglePop() });

  function buildTopbar() {
    const widths = [5, 9, 13, 17, 13, 9, 5];
    const search = h("input", { id: "topSearch", placeholder: "Szukaj klipów…", spellcheck: false,
      onInput: (e) => {
        S.q = e.target.value;
        if (S.view !== "lib") App.go("lib"); else App.Lib.render(false);
      } });
    App.$("#topbar").replaceChildren(
      h("div", { class: "brand", "data-tauri-drag-region": true },
        h("div", { class: "mini" }, widths.map((w) => h("i", { style: { width: `${w}px` } }))),
        h("b", { text: "Buffer" })),
      h("label", { class: "search" }, h("span", { text: "⌕" }), search, h("kbd", { text: "Ctrl K" })),
      h("div", { class: "right", "data-tauri-drag-region": true }, recPill, chip, windowControls()));
    paintRec();
    paintChip();
  }
  App.focusSearch = () => App.$("#topSearch")?.focus();

  const fmtBuf = (s) => `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;

  function paintRec() {
    const r = S.recorder;
    const down = r ? r.sources.filter((s) => !s.live).map((s) => s.name) : [];
    let cls, text;
    if (savedUntil > Date.now()) { cls = "saved"; text = `✓ zapisano ${fmtBuf(savedDur)}`; }
    else if (!r) { cls = "off"; text = "REC wył."; }
    else if (r.idle) { cls = "idle"; text = "czeka na grę"; }
    else if (!r.recording) { cls = "bad"; text = "REC zatrzymane"; }
    else if (down.length) { cls = "warn"; text = "REC · uwaga"; }
    else { cls = "on"; text = `REC · bufor ${fmtBuf(r.buffer_s)}`; }
    recPill.className = `recpill ${cls}`;
    recPill.title = recTooltip();
    recPill.replaceChildren(h("span", { class: "dot" }), text);
  }

  function recTooltip() {
    const r = S.recorder;
    if (!r) return "Nagrywanie nie działa — kliknij, aby przejść do ustawień";
    if (r.idle) return "Czeka na grę — nagrywanie tylko podczas gry";
    if (!r.recording) return r.last_error || "Nagrywanie zatrzymane";
    const down = r.sources.filter((s) => !s.live).map((s) => s.name);
    const base = down.length ? `Nie działa: ${down.join(", ")}` : `Nagrywa · bufor ${r.buffer_s}/${r.buffer_target_s} s`;
    return `${base} — kliknij, aby zapisać klip teraz`;
  }

  async function onRecClick() {
    const r = S.recorder;
    if (r && r.recording) {
      try {
        const res = await api.invoke("recorder_cmd", { cmd: "save" });
        if (res.ok) {
          savedDur = r.buffer_s; savedUntil = Date.now() + 2500; paintRec();
          setTimeout(paintRec, 2600);
          setTimeout(() => App.Lib.load(), 800);
        } else App.toast(`Nie zapisano: ${res.error}`, "err");
      } catch (e) { App.toast(`Nagrywanie nie działa: ${e}`, "err"); }
    } else {
      App.Settings.tab = "rec";
      App.go("set");
    }
  }

  function paintChip() {
    const ex = S.exporting;
    chip.className = "expchip" + (ex ? " busy" : S.lastDone && Date.now() - S.lastDone.at < 7000 ? " done" : "");
    if (ex) {
      chip.replaceChildren(`⇪ ${Math.round(ex.pct)}%`, h("span", { class: "bars" },
        Array.from({ length: 8 }, (_, i) => h("i", { style: { opacity: ex.pct / 100 * 8 > i ? 1 : 0.15 } }))));
    } else if (S.lastDone && Date.now() - S.lastDone.at < 7000) {
      chip.replaceChildren(`✓ ${S.lastDone.size} MiB`);
    } else {
      chip.replaceChildren("⇪ Eksporty");
    }
  }

  /* ───── recorder polling ───── */

  const Rec = (App.Rec = {});
  let pollTimer = 0;
  Rec.refresh = async () => {
    try { S.recorder = await api.invoke("recorder_cmd", { cmd: "status" }); } catch { S.recorder = null; }
    paintRec();
    if (S.view === "set" && Settings.tab === "rec") Settings.paintRecorder();
  };
  Rec.start = () => {
    const loop = async () => {
      if (!document.hidden) await Rec.refresh();
      pollTimer = setTimeout(loop, S.view === "set" && Settings.tab === "rec" ? 700 : 3000);
    };
    clearTimeout(pollTimer);
    loop();
  };

  /* ───── exports: run, popover, drawer ───── */

  const Exports = (App.Exports = {});
  const exQueue = [];
  let popOpen = false;
  let popHover = false;
  let popUntil = 0;
  let drawerOpen = false;

  const ago = (ts) => {
    const m = Math.round((Date.now() - ts) / 60000);
    return m < 1 ? "teraz" : m < 60 ? `${m} min temu` : m < 1440 ? `${Math.round(m / 60)} h temu` : `${Math.round(m / 1440)} d temu`;
  };

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
    S.exporting = { name: App.titleOf(clip), target: mb, pct: 0, source: clip.path, startedAt: Date.now() };
    S.lastDone = null;
    Exports.openPop();
    notifyState();
    try {
      const r = await api.invoke("export_clip", { opts });
      const secs = ((Date.now() - S.exporting.startedAt) / 1000).toFixed(1);
      const entry = { id: `e${Date.now()}`, name: output.slice(output.lastIndexOf("\\") + 1), path: output,
        source: clip.path, size: +(r.size / 1048576).toFixed(2), target: mb,
        dur: ((o.end ?? (App.Lib.meta(clip) || {}).dur ?? 0) - (o.start ?? 0)) / (o.speed || 1), created: Date.now() };
      App.P.exports.unshift(entry);
      App.P.exports = App.P.exports.slice(0, 200);
      App.persist();
      S.lastDone = { ...entry, secs, at: Date.now() };
      popUntil = Date.now() + 7000;
      return { name: entry.name, path: output, size: entry.size };
    } catch (e) {
      if (String(e).includes("cancelled")) App.toast("Eksport anulowany");
      else {
        App.toast(`Eksport nie powiódł się: ${e}`, "err");
        if (App.Ed.current()) App.Ed.current().error = String(e);
      }
      return null;
    } finally {
      S.exporting = null;
      notifyState();
    }
  };

  Exports.cancel = () => api.invoke("cancel_export").catch(() => {});

  function notifyState() {
    App.Ed.onExportState();
    paintChip();
    renderPop();
    if (S.view === "lib") App.Lib.renderSide();
  }

  Exports.quick = async (path) => { await Exports.run({ path }); };

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
  };

  api.listen("export-progress", (e) => {
    if (!S.exporting) return;
    S.exporting.pct = e.payload * 100;
    App.Ed.onProgress(S.exporting.pct);
    paintChip();
    renderPop();
  });

  Exports.togglePop = () => { popOpen ? closePop() : Exports.openPop(true); };
  Exports.openPop = (manual) => {
    popOpen = true;
    popUntil = manual ? 0 : Date.now() + 60000;   // auto-opened popovers close themselves after the result
    renderPop();
  };
  function closePop() { popOpen = false; renderPop(); }

  setInterval(() => {
    if (popOpen && popUntil && !popHover && !S.exporting && !drawerOpen && Date.now() > popUntil) closePop();
    if (S.lastDone && Date.now() - S.lastDone.at >= 7000 && chip.classList.contains("done")) paintChip();
  }, 500);

  const dragHandle = (path, cls, text) => {
    const el = h("span", { class: cls, text, title: "Przeciągnij do Discorda lub innego okna" });
    el.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      api.startDrag(path).catch((err) => App.toast(`Nie udało się przeciągnąć: ${err}`, "err"));
    });
    return el;
  };

  function thumbBox(path, cls) {
    const el = h("div", { class: cls });
    App.Lib.thumbUrl(path).then((u) => { if (u) el.style.backgroundImage = `url("${u}")`; });
    return el;
  }

  function renderPop() {
    const host = App.$("#pop");
    if (!popOpen) { host.replaceChildren(); renderDrawer(); return; }
    const ex = S.exporting;
    const done = !ex && S.lastDone;
    const recent = App.P.exports.filter((e) => !done || e.id !== S.lastDone.id).slice(0, 2);
    const parts = [];
    if (ex) {
      const p = ex.pct;
      const elapsed = (Date.now() - ex.startedAt) / 1000;
      const eta = p > 3 ? Math.max(0, Math.round((elapsed * (100 - p)) / p)) : null;
      parts.push(h("div", null,
        h("div", { class: "pr1" }, h("b", { text: `${ex.name} · ${ex.target} MB` }), h("span", { class: "mono lime", text: `${Math.round(p)}%` })),
        h("div", { class: "scan" }, Array.from({ length: 30 }, (_, i) =>
          h("i", { style: { opacity: p / 100 * 30 > i ? 0.35 + 0.65 * (i / 30) : 0.12 } }))),
        h("div", { class: "pr3 mono muted" }, h("span", { text: eta == null ? "liczenie…" : `≈ ${eta} s` }),
          h("button", { class: "linkbtn", text: "Anuluj", onClick: Exports.cancel }))));
    }
    if (done) {
      parts.push(h("div", { class: "donecard" },
        h("div", { style: { minWidth: 0 } }, h("div", { class: "nm", text: done.name }),
          h("div", { class: "mono lime", text: `Gotowe w ${done.secs} s · ${done.size} MiB` })),
        dragHandle(done.path, "big", "⇪ Przeciągnij")));
    }
    for (const e of recent) {
      parts.push(h("div", { class: "prow" }, thumbBox(e.path, "tn"),
        h("div", { style: { minWidth: 0 } }, h("div", { class: "nm", text: e.name }),
          h("div", { class: "mono muted", text: `${e.size} MiB · ${ago(e.created)}` })),
        dragHandle(e.path, "lime", "⇪")));
    }
    if (!ex && !done && !recent.length) parts.push(h("div", { class: "muted", text: "Tu pojawią się wyeksportowane klipy." }));
    parts.push(h("button", { class: "histlink", text: `Historia (${App.P.exports.length}) →`,
      onClick: () => { drawerOpen = true; renderDrawer(); } }));
    host.replaceChildren(h("div", { class: "popover",
      onMouseenter: () => { popHover = true; }, onMouseleave: () => { popHover = false; popUntil = Date.now() + 3000; } }, parts));
    renderDrawer();
  }

  function renderDrawer() {
    const host = App.$("#drawer");
    if (!drawerOpen) { host.replaceChildren(); return; }
    const close = () => { drawerOpen = false; popUntil = Date.now() + 3000; renderDrawer(); };
    host.replaceChildren(h("div", { class: "scrim", onClick: close },
      h("aside", { class: "drawer", onClick: (e) => e.stopPropagation() },
        h("div", { class: "dhead" }, h("b", { text: "Historia eksportów" }), h("button", { class: "linkbtn", text: "✕", onClick: close })),
        ...(App.P.exports.length ? App.P.exports.map((e) => h("div", { class: "drow" }, thumbBox(e.path, "tn"),
          h("div", { style: { minWidth: 0 } }, h("div", { class: "nm", text: e.name }),
            h("div", { class: "mono muted", text: `${e.size} MiB · ${ago(e.created)}` })),
          h("div", { class: "acts" },
            h("button", { class: "linkbtn", text: "Pokaż", onClick: () => api.invoke("reveal", { path: e.path }) }),
            dragHandle(e.path, "lime", "⇪")))) : [h("div", { class: "muted", text: "Brak eksportów." })]))));
  }

  /* ───── settings: Nagrywanie · Biblioteka · Aplikacja ───── */

  const Settings = (App.Settings = { tab: "rec", adv: false });
  const U = App.ui;
  Settings.paintRecorder = () => App.RecUI.paint();   // called by the recorder poll while the tab is open
  const TABS = [["rec", "Nagrywanie"], ["lib", "Biblioteka"], ["app", "Aplikacja"]];
  const THEMES = [["ink", "Ink", "#0b0c0a"], ["oled", "OLED czerń", "#000000"]];

  /** Settings pane; only a tab switch plays the slide-in, edits inside a tab re-render quietly. */
  Settings.render = async (animate = false) => {
    const root = App.$("#v-set");
    const pane = h("div", { class: "pane" + (animate ? " stepin" : "") });
    root.replaceChildren(h("div", { class: "set" },
      h("div", { class: "tabs" }, h("h1", { text: "Ustawienia" }),
        TABS.map(([k, t]) => h("button", { class: Settings.tab === k ? "on" : "", text: t,
          onClick: () => { Settings.tab = k; Settings.render(true); } })),
        h("div", { class: "grow" }),
        h("button", { class: "wizbtn", text: "Uruchom kreator", onClick: () => App.RecUI.wizard() })),
      h("div", { class: "setscroll" }, pane)));
    if (Settings.tab === "rec") await App.RecUI.renderTab(pane);
    else if (Settings.tab === "lib") await renderLibraryTab(pane);
    else await renderAppTab(pane);
  };

  const advHead = (label, open, toggle) => h("button", { class: "advhead", onClick: toggle },
    h("span", { text: label }), h("span", { text: open ? "▴" : "▾" }));

  /* Biblioteka: one folder list (the radio marks where new recordings go), library toggles, export. */
  async function renderLibraryTab(pane) {
    await App.RecUI.ensureLoaded();
    const rc = App.RecUI.cfg();
    const s = App.P.settings;
    const rec = rc.output_dir;
    const dirs = [...new Set([rec, ...App.P.libDirs])].filter(Boolean);
    const reload = async () => { App.persist(); await App.Lib.load(); Settings.render(); };
    const setRecDir = async (d) => {
      await App.RecUI.save({ output_dir: d });
      if (!App.P.libDirs.includes(d)) App.P.libDirs.unshift(d);
      await reload();
    };
    const folderRow = (d) => {
      const isRec = d === rec;
      return h("div", { class: "frow" },
        h("button", { class: "radio" + (isRec ? " on" : ""), "aria-label": "Zapisuj tu nowe nagrania", title: isRec ? "Tu zapisują się nowe nagrania" : "Zapisuj tu nowe nagrania",
          onClick: () => { if (!isRec) setRecDir(d); } }),
        h("span", { class: "mono path" + (isRec ? "" : " dim"), text: d }),
        isRec ? h("span", { class: "tag lime", text: "NOWE NAGRANIA" }) : h("span", { class: "tag", text: "tylko biblioteka" }),
        isRec
          ? h("button", { class: "linkbtn", text: "Zmień", onClick: async () => {
            const n = await api.pickFolder();
            if (!n) return;
            App.P.libDirs = App.P.libDirs.map((x) => (x === d ? n : x));
            await setRecDir(n);
          } })
          : h("button", { class: "linkbtn", text: "✕", title: "Usuń z biblioteki", onClick: async () => {
            App.P.libDirs = App.P.libDirs.filter((x) => x !== d); await reload();
          } }));
    };
    pane.append(h("div", { class: "setcol" },
      h("div", null, U.cap("Foldery klipów"),
        h("div", { class: "card2 pad folders" }, ...dirs.map(folderRow),
          h("button", { class: "linkbtn", text: "+ Dodaj folder", onClick: async () => {
            const n = await api.pickFolder();
            if (n && !App.P.libDirs.includes(n)) { App.P.libDirs.push(n); await reload(); }
          } }))),
      h("div", { class: "card2 tgl" },
        U.trow("Osobny folder dla każdej gry", "Podfolder z nazwą gry", rc.per_game_folders, async (on) => { await App.RecUI.save({ per_game_folders: on }); Settings.render(); }),
        U.trow("Skanuj podfoldery", "Bez folderów eksportów", s.sub, async (on) => { s.sub = on; await reload(); }),
        U.trow("Odświeżaj bibliotekę przy starcie", "Wykrywa nowe klipy", s.auto, (on) => { s.auto = on; App.persist(); Settings.render(); })),
      h("div", null, U.cap("Eksport"),
        h("div", { class: "card2" },
          U.srow("Domyślny cel", U.segc([[10, "Discord · 10 MB"], [50, "Boost · 50 MB"], [500, "Nitro · 500 MB"]], s.defTarget, (mb) => { s.defTarget = mb; App.persist(); Settings.render(); })),
          U.srow("Folder wyjściowy", h("div", { class: "pathrow" },
            h("span", { class: "mono path", text: App.exportDirFor() }),
            h("button", { class: "linkbtn", text: "Zmień", onClick: async () => {
              const d = await api.pickFolder();
              if (d) { s.outDir = d; App.persist(); Settings.render(); }
            } }),
            s.outDir ? h("button", { class: "linkbtn", text: "Domyślny", onClick: () => { s.outDir = ""; App.persist(); Settings.render(); } }) : null)),
          U.trow("Normalizuj głośność", "−16 LUFS", s.normDef, (on) => { s.normDef = on; App.persist(); Settings.render(); })))));
  }

  /* Aplikacja: appearance + system. */
  async function renderAppTab(pane) {
    const s = App.P.settings;
    const [tools, size] = await Promise.all([api.invoke("tools_status").catch(() => null), api.invoke("cache_size").catch(() => 0)]);
    const encoder = ({ h264_nvenc: "NVIDIA NVENC", h264_amf: "AMD AMF", h264_qsv: "Intel QuickSync", libx264: "procesor (CPU)" })[tools?.encoder] || "nieznany";
    pane.append(h("div", { class: "setcol" },
      h("div", null, U.cap("Motyw"), h("div", { class: "themes2" }, THEMES.map(([k, name, bg]) =>
        h("button", { class: "th2" + ((s.theme === "oled" ? "oled" : "ink") === k ? " on" : ""),
          onClick: () => { s.theme = k; App.persist(); App.applyTheme(); Settings.render(); } },
          h("div", { class: "pv2", style: { background: bg } }, h("i", { style: { width: "60%", background: "#1a1d16" } }), h("i", { style: { width: "30%", background: "#c6f432" } })),
          h("div", { class: "nm", text: name }))))),
      h("div", { class: "card2" },
        U.srow("Miniatury", U.segc(["S", "M", "L"].map((k) => [k, k]), s.thumb, (k) => { s.thumb = k; App.persist(); Settings.render(); })),
        U.trow("Animacje interfejsu", "Przejścia i ślady", s.anim, (on) => { s.anim = on; App.persist(); App.applyTheme(); Settings.render(); })),
      h("div", null,
        advHead("ZAAWANSOWANE", Settings.adv, () => { Settings.adv = !Settings.adv; Settings.render(); }),
        Settings.adv ? h("div", { class: "card2 rise pad stackrows" },
          h("div", { class: "between" }, h("span", { text: tools?.ffmpeg_found ? `ffmpeg ${tools.ffmpeg_version}` : "ffmpeg" }),
            h("span", { class: "mono " + (tools?.ffmpeg_found ? "lime" : "err"), style: { fontSize: "12px" },
              text: tools?.ffmpeg_found ? (tools.ffmpeg_bundled ? "● wbudowany" : "● w systemie") : "● nie znaleziono" })),
          h("div", { class: "between" }, h("span", { text: "Kodowanie wideo" }),
            h("span", { class: "mono " + (tools?.encoder && tools.encoder !== "libx264" ? "lime" : "warn"), style: { fontSize: "12px" },
              text: "● " + encoder + (tools?.gpu ? " · " + tools.gpu : "") })),
          h("div", { class: "between" }, h("span", { text: `Pamięć podręczna · ${App.fmtMB(size)}` }),
            h("button", { class: "btn", text: "Wyczyść", onClick: async () => {
              await api.invoke("clear_cache").catch(() => {});
              App.toast("Wyczyszczono pamięć podręczną", "ok");
              Settings.render();
            } })),
          U.trow("Dekodowanie sprzętowe (NVDEC)", "Awaryjnie CPU", s.hw, (on) => { s.hw = on; App.persist(); Settings.render(); }),
          U.trow("Miniatury w tle", "Tylko widoczne klipy", s.thumbs, (on) => { s.thumbs = on; App.persist(); Settings.render(); }),
          U.trow("Pamięć podręczna audio", "Szybsze otwieranie klipów", s.cache, (on) => { s.cache = on; App.persist(); Settings.render(); })) : null)));
  }

  /* The recording tab and the first-run wizard live in recording.js. */
  

  App.renderNav = () => { buildTopbar(); renderRail(); };
})();
