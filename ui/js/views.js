"use strict";
/* Chrome around the views: top bar (search, REC pill, export chip), icon rail, export popover + history
   drawer, and settings. "Lime means now": playhead, selection, active item, progress. */

(function () {
  const { h, S, api } = App;
  const VIEWS = { lib: "#v-lib", ed: "#v-ed", set: "#v-set" };

  /* ───── navigation ───── */

  App.go = (view) => {
    if (view === "exp") view = "lib";                       // the standalone exports page is gone
    if (view === "ed" && !App.Ed.current()) view = "lib";
    if (S.view === "ed" && view !== "ed") App.Ed.leave();
    const changed = S.view !== view;
    const prev = S.view;
    document.querySelectorAll("#views .view.leaving").forEach((e) => e.classList.remove("leaving"));
    S.view = view;
    for (const [v, sel] of Object.entries(VIEWS)) App.$(sel).hidden = v !== view;
    if (changed && VIEWS[prev] && App.P.settings.anim !== false) keepUnderneath(prev);
    if (view === "lib") App.Lib.render(false);
    if (view === "set") Settings.render(true);
    renderRail();
  };

  /** The "back" action shared by the mouse Back button and Alt+Left. */
  let forwardTo = null;                       // the view Back just left: Forward returns to it
  App.back = () => {
    if (App.Exports.closeAny()) return;
    if (S.view !== "lib") { forwardTo = S.view; App.go("lib"); }
  };
  /** Mouse Forward / Alt+Right: back into the editor or settings that Back just closed. */
  App.forward = () => {
    if (forwardTo && S.view === "lib") App.go(forwardTo);
    forwardTo = null;
  };

  /** The view being left stays on screen under the one fading in, so a switch is a dissolve and not a dark gap
   *  (the gap made the library look like it blinked out while the editor faded in). */
  let leaveTimer = 0;
  function keepUnderneath(prev) {
    const el = App.$(VIEWS[prev]);
    el.hidden = false;
    el.classList.add("leaving");
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => {
      el.classList.remove("leaving");
      if (S.view !== prev) el.hidden = true;
    }, 400);
  }

  /** The icon rail is built once; later calls only move the "on" state (rebuilding it flashed the Library button). */
  let railItems = null;
  function renderRail() {
    const nav = App.$("#nav");
    const defs = [
      ["lib", "▦", "nav.library", S.view === "lib" || S.view === "ed"],
      ["set", "⚙", "nav.settings", S.view === "set"],
    ];
    if (!railItems || !railItems.every((el) => el.isConnected)) {
      railItems = defs.map(([view, icon]) => h("button", { class: "item", onClick: () => App.go(view) },
        h("span", { class: "ic", text: icon }), h("span", { class: "lb" })));
      nav.replaceChildren(railItems[0], h("div", { class: "grow" }), railItems[1]);
    }
    defs.forEach(([, , key, on], i) => {
      const el = railItems[i], label = App.t(key);
      el.classList.toggle("on", on);
      el.setAttribute("aria-label", label);
      const lb = el.querySelector(".lb");
      if (lb.textContent !== label) lb.textContent = label;
    });
  }

  /** Own window buttons: the native title bar is turned off. */
  function windowControls() {
    const w = window.__TAURI__?.window?.getCurrentWindow?.();
    const btn = (cls, title, fn) => h("button", { class: "wc " + cls, title, "aria-label": title, onClick: () => w && fn(w) }, h("i"));
    return h("div", { class: "winctl" },
      btn("min", App.t("win.min"), (x) => x.minimize()),
      btn("max", App.t("win.max"), (x) => x.toggleMaximize()),
      btn("cls", App.t("win.close"), (x) => x.close()));
  }

  /* ───── top bar ───── */

  const recPill = h("button", { class: "recpill off", onClick: () => onRecClick() });
  const chip = h("button", { class: "expchip", onClick: () => Exports.togglePop() });

  function buildTopbar() {
    const widths = [5, 9, 13, 17, 13, 9, 5];
    const search = h("input", { id: "topSearch", placeholder: App.t("search.ph"), spellcheck: false,
      onInput: (e) => {
        S.q = e.target.value;
        if (S.view !== "lib") App.go("lib"); else App.Lib.render(false);
      } });
    App.$("#topbar").replaceChildren(
      h("div", { class: "brand", "data-tauri-drag-region": true },
        h("div", { class: "mini" }, widths.map((w) => h("i", { style: { width: `${w}px` } }))),
        h("b", { text: "Buffer" }),
        App.isDev ? h("span", { class: "devbadge", text: "DEV", title: App.t("dev.badgeTip") }) : null),
      h("label", { class: "search" }, h("span", { text: "⌕" }), search, h("kbd", { text: "Ctrl K" })),
      h("div", { class: "right", "data-tauri-drag-region": true }, App.i18n.topbarChip(), App.Update.chip, recPill, chip, windowControls()));
    paintRec();
    paintChip();
  }
  App.focusSearch = () => App.$("#topSearch")?.focus();

  const fmtBuf = (s) => `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;

  function paintRec() {
    const r = S.recorder;
    const down = r ? r.sources.filter((s) => !s.live).map((s) => s.name) : [];
    let cls, text;
    if (!r) { cls = "off"; text = App.t("rec.pill.off"); }
    else if (r.saving) { cls = "saving"; text = App.t("rec.pill.saving"); }
    else if (r.idle) { cls = "idle"; text = App.t("rec.pill.idle"); }
    else if (!r.recording) { cls = "bad"; text = App.t("rec.pill.stopped"); }
    else if (down.length) { cls = "warn"; text = App.t("rec.pill.warn"); }
    else { cls = "on"; text = App.t("rec.pill.on", { t: fmtBuf(r.buffer_s) }); }
    // rebuilt only when it changes: a new dot element restarts its pulse animation, and this runs on every poll
    const sig = cls + "|" + text;
    recPill.title = recTooltip();
    if (recPill._sig === sig) return;
    recPill._sig = sig;
    recPill.className = `recpill ${cls}`;
    recPill.replaceChildren(h("span", { class: "dot" }), text);
  }

  function recTooltip() {
    const r = S.recorder;
    if (!r) return App.t("rec.tip.off");
    if (r.idle) return App.t("rec.tip.idle");
    if (!r.recording) return r.last_error || App.t("rec.tip.stopped");
    const down = r.sources.filter((s) => !s.live).map((s) => s.name);
    const base = down.length ? App.t("rec.tip.down", { list: down.join(", ") }) : App.t("rec.tip.on", { cur: r.buffer_s, target: r.buffer_target_s });
    return App.t("rec.tip.save", { base });
  }

  /** The pill is a status light: a click opens the recording settings (saving a clip is the hotkey or the button there). */
  function onRecClick() {
    App.Settings.tab = "rec";
    App.go("set");
  }

  function paintChip() {
    const ex = S.exporting;
    if (!ex) chip._live = null;
    chip.className = "expchip" + (ex ? " busy" : S.lastDone && Date.now() - S.lastDone.at < 7000 ? " done" : "") + (popOpen ? " open" : "");
    chip.title = popOpen ? App.t("common.close") : "";
    if (ex) {
      if (!chip._live) {
        const label = document.createTextNode("");
        const bars = h("span", { class: "bars" }, Array.from({ length: 8 }, () => h("i")));
        chip.replaceChildren(label, bars);
        chip._live = { label, bars };
      }
      const shown = ex.shown ?? ex.pct;
      chip._live.label.textContent = `⇪ ${Math.round(shown)}%`;
      [...chip._live.bars.children].forEach((b, i) => { b.style.opacity = 0.15 + 0.85 * fill(shown, 8, i); });
    } else if (S.lastDone && Date.now() - S.lastDone.at < 7000) {
      chip.replaceChildren(`✓ ${S.lastDone.size} MiB`);
    } else {
      chip.replaceChildren("⇪ " + App.t("exp.chip"));
    }
  }

  /* ───── recorder polling ───── */

  const Rec = (App.Rec = {});
  let pollTimer = 0;
  Rec.refresh = async () => {
    // a recorder that stops answering counts as not running, instead of freezing the poll loop
    try { S.recorder = await App.timeout(api.invoke("recorder_cmd", { cmd: "status" }), 4000); } catch { S.recorder = null; }
    watchdog();
    paintRec();
    // a clip the recorder just finished appears in the library without waiting for the window to regain focus
    const saved = S.recorder ? S.recorder.last_saved : "";
    if (Rec.lastSaved !== undefined && saved && saved !== Rec.lastSaved) {
      App.toast(App.t("rec.savedToast", { name: App.baseName(saved) }), "ok");
      App.Lib.load();
    }
    if (saved || Rec.lastSaved === undefined) Rec.lastSaved = saved;
    if (S.view === "set" && Settings.tab === "rec") Settings.paintRecorder();
  };
  /* A recorder that was up and then vanished (crash, killed by another tool) is relaunched, and the user is told.
     A stop the user asked for (Rec.expectDown) is left alone. */
  let wasUp = false, downPolls = 0, lastRelaunch = 0;
  Rec.expectDown = 0;
  function watchdog() {
    if (S.recorder) { wasUp = true; downPolls = 0; return; }
    if (!wasUp || ++downPolls < 3) return;
    const now = Date.now();
    if (now - Rec.expectDown < 20000 || now - lastRelaunch < 30000) return;
    lastRelaunch = now;
    wasUp = false;
    api.invoke("recorder_launch")
      .then(() => { App.toast(App.t("rec.relaunched"), "err"); setTimeout(Rec.refresh, 2500); })
      .catch((e) => App.toast(App.t("rec.relaunchFail", { err: e }), "err"));
  }
  Rec.start = () => {
    const loop = async () => {
      if (!document.hidden) await Rec.refresh();
      pollTimer = setTimeout(loop, S.view === "set" && Settings.tab === "rec" ? 700 : 1200);
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
    return m < 1 ? App.t("ago.now") : m < 60 ? App.t("ago.min", { n: m }) : m < 1440 ? App.t("ago.h", { n: Math.round(m / 60) }) : App.t("ago.d", { n: Math.round(m / 1440) });
  };

  /** Runs one export with the editor's or the quick-export defaults. Resolves with the finished file or null. */
  Exports.run = async (o) => {
    if (S.exporting) { App.toast(App.t("exp.busy"), "err"); return null; }
    const clip = S.byPath.get(o.path);
    if (!clip) return null;
    const s = App.P.settings;
    const mb = o.target ?? s.defTarget;
    const dir = App.exportDirFor();
    const suffix = (o.wide != null ? "_16x9" : "") + (o.speed && o.speed !== 1 ? `_${o.speed}x` : "");
    const output = `${dir}\\${clip.name}${suffix}_${mb}MB.mp4`;
    const volumes = o.volumes || ["Game", "Chat", "Mic"].map((n) => [n, App.clipGain(clip.path, n) / 100]);
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
      setTimeout(() => Exports.autoClean(), 0);
      return { name: entry.name, path: output, size: entry.size };
    } catch (e) {
      if (String(e).includes("cancelled")) App.toast(App.t("exp.cancelled"));
      else {
        App.toast(App.t("exp.failed", { err: e }), "err");
        if (App.Ed.current()) App.Ed.current().error = String(e);
      }
      return null;
    } finally {
      S.exporting = null;
      notifyState();
    }
  };

  Exports.cancel = () => api.invoke("cancel_export").catch(() => {});

  /* ───── optional automatic delete of old exports (moved to the Recycle Bin) ───── */
  const DAY = 86400000;
  const oldExports = (days) => App.P.exports.filter((e) => Date.now() - e.created > days * DAY);
  const bytesOf = (list) => list.reduce((a, e) => a + (e.size || 0), 0) * 1048576;
  /** Moves the files to the Recycle Bin and drops them from the history. Returns how many were handled. */
  Exports.remove = async (list) => {
    if (!list.length) return 0;
    try { await api.invoke("delete_clips", { paths: list.map((e) => e.path) }); } catch { /* already gone: forget them anyway */ }
    const gone = new Set(list.map((e) => e.id));
    App.P.exports = App.P.exports.filter((e) => !gone.has(e.id));
    App.persist();
    return list.length;
  };
  /** Runs at start and after each export; does nothing unless "Delete old exports" is set in Settings. */
  Exports.autoClean = async () => {
    const days = App.P.settings.autoCleanDays || 0;
    if (!days || S.exporting) return;
    const n = await Exports.remove(oldExports(days));
    if (n) { App.toast(App.t("clean.done", { n }), "ok"); notifyState(); }
  };

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
      App.toast(App.t("exp.batch", { n, total }));
      await Exports.run({ path: p });
    }
    App.Lib.clearSel();
  };

  /** How full bar `i` of `n` is at `pct`: 0..1, so the leading bar fills gradually instead of switching on. */
  const fill = (pct, n, i) => Math.max(0, Math.min(1, (pct / 100) * n - i));

  /* The encoder reports progress in steps; showing them directly looks jerky. Each report only moves a target and
     this loop eases what is on screen towards it (it stops by itself once it has arrived). */
  let smoothRaf = 0;
  function smoothTick() {
    smoothRaf = 0;
    const ex = S.exporting;
    if (!ex) return;
    const from = ex.shown ?? 0;
    const gap = ex.pct - from;
    ex.shown = Math.abs(gap) < 0.04 ? ex.pct : from + gap * 0.1;
    paintChip();
    updatePop();
    App.Ed.onProgress(ex.shown);
    if (ex.shown !== ex.pct) smoothRaf = requestAnimationFrame(smoothTick);
  }

  api.listen("export-progress", (e) => {
    if (!S.exporting) return;
    S.exporting.pct = e.payload * 100;
    if (!smoothRaf) smoothRaf = requestAnimationFrame(smoothTick);
  });

  Exports.togglePop = () => { popOpen ? closePop() : Exports.openPop(true); };
  Exports.openPop = (manual) => {
    popOpen = true;
    popUntil = manual ? 0 : Date.now() + 60000;   // auto-opened popovers close themselves after the result
    renderPop();
  };
  function closePop() { popOpen = false; renderPop(); }
  /** Closes the history drawer, else the popover. True when something was open. */
  Exports.closeAny = () => {
    if (drawerOpen) { drawerOpen = false; popUntil = Date.now() + 3000; renderDrawer(); return true; }
    if (popOpen) { closePop(); return true; }
    return false;
  };
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && popOpen && !drawerOpen) closePop();
  });

  setInterval(() => {
    if (popOpen && popUntil && !popHover && !S.exporting && !drawerOpen && Date.now() > popUntil) closePop();
    if (S.lastDone && Date.now() - S.lastDone.at >= 7000 && chip.classList.contains("done")) paintChip();
  }, 500);

  const dragHandle = (path, cls, text) => {
    const el = h("span", { class: cls, text, title: App.t("exp.dragTip") });
    el.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      api.startDrag(path).catch((err) => App.toast(App.t("exp.dragFail", { err }), "err"));
    });
    return el;
  };

  // one delegated listener: pressing anywhere on an export card (not on a button) starts the drag-out
  for (const id of ["#pop", "#drawer"]) {
    App.$(id).addEventListener("pointerdown", (ev) => {
      const card = ev.target.closest("[data-path]");
      if (!card || ev.button !== 0 || ev.target.closest("button, .linkbtn")) return;
      ev.preventDefault();
      api.startDrag(card.dataset.path).catch((err) => App.toast(App.t("exp.dragFail", { err }), "err"));
    });
  }

  function thumbBox(path, cls) {
    const el = h("div", { class: cls });
    App.Lib.thumbUrl(path).then((u) => { if (u) el.style.backgroundImage = `url("${u}")`; });
    return el;
  }

  let popLive = null;   // the nodes that change while an export runs
  /** Progress tick: patch numbers and bars in place (rebuilding the popover on every tick made it flash). */
  function updatePop() {
    const ex = S.exporting;
    if (!popLive || !ex || !popLive.pct.isConnected) return;
    const p = ex.shown ?? ex.pct;
    popLive.pct.textContent = `${Math.round(p)}%`;
    popLive.bars.forEach((b, i) => { b.style.opacity = 0.12 + (0.35 + 0.65 * (i / 30) - 0.12) * fill(p, 30, i); });
    const real = ex.pct;
    const elapsed = (Date.now() - ex.startedAt) / 1000;
    const eta = real > 3 ? Math.max(0, Math.round((elapsed * (100 - real)) / real)) : null;
    popLive.eta.textContent = eta == null ? App.t("exp.calc") : `≈ ${eta} s`;
  }

  function renderPop() {
    popLive = null;
    paintChip();
    const host = App.$("#pop");
    if (!popOpen) { host.replaceChildren(); renderDrawer(); return; }
    const ex = S.exporting;
    const done = !ex && S.lastDone;
    const recent = App.P.exports.filter((e) => !done || e.id !== S.lastDone.id).slice(0, 2);
    const parts = [];
    if (ex) {
      const p = ex.shown ?? ex.pct;
      const elapsed = (Date.now() - ex.startedAt) / 1000;
      const eta = p > 3 ? Math.max(0, Math.round((elapsed * (100 - p)) / p)) : null;
      const pctEl = h("span", { class: "mono lime", text: `${Math.round(p)}%` });
      const barEls = Array.from({ length: 30 }, (_, i) =>
        h("i", { style: { opacity: 0.12 + (0.35 + 0.65 * (i / 30) - 0.12) * fill(p, 30, i) } }));
      const etaEl = h("span", { text: eta == null ? App.t("exp.calc") : `≈ ${eta} s` });
      popLive = { pct: pctEl, bars: barEls, eta: etaEl };
      parts.push(h("div", null,
        h("div", { class: "pr1" }, h("b", { text: `${ex.name} · ${ex.target} MB` }), pctEl),
        h("div", { class: "scan" }, barEls),
        h("div", { class: "pr3 mono muted" }, etaEl,
          h("button", { class: "linkbtn", text: App.t("common.cancel"), onClick: Exports.cancel }))));
    }
    if (done) {
      parts.push(h("div", { class: "donecard", "data-path": done.path },
        h("div", { style: { minWidth: 0 } }, h("div", { class: "nm", text: done.name }),
          h("div", { class: "mono lime", text: App.t("exp.done", { secs: done.secs, size: done.size }) })),
        dragHandle(done.path, "big", "⇪ " + App.t("exp.dragBig"))));
    }
    for (const e of recent) {
      parts.push(h("div", { class: "prow", "data-path": e.path }, thumbBox(e.path, "tn"),
        h("div", { style: { minWidth: 0 } }, h("div", { class: "nm", text: e.name }),
          h("div", { class: "mono muted", text: `${e.size} MiB · ${ago(e.created)}` })),
        dragHandle(e.path, "lime", "⇪")));
    }
    if (!ex && !done && !recent.length) parts.push(h("div", { class: "muted", text: App.t("exp.empty") }));
    parts.push(h("button", { class: "histlink", text: App.t("exp.history", { n: App.P.exports.length }),
      onClick: () => { drawerOpen = true; renderDrawer(); } }));
    const head = h("div", { class: "phead" }, h("b", { text: App.t("exp.chip") }),
      h("button", { class: "pclose", title: App.t("common.close"), "aria-label": App.t("common.close"), text: "✕", onClick: closePop }));
    host.replaceChildren(h("div", { class: "popover",
      onMouseenter: () => { popHover = true; }, onMouseleave: () => { popHover = false; popUntil = Date.now() + 3000; } }, head, parts));
    renderDrawer();
  }

  function renderDrawer() {
    const host = App.$("#drawer");
    if (!drawerOpen) { host.replaceChildren(); return; }
    const close = () => { drawerOpen = false; popUntil = Date.now() + 3000; renderDrawer(); };
    host.replaceChildren(h("div", { class: "scrim", onClick: close },
      h("aside", { class: "drawer", onClick: (e) => e.stopPropagation() },
        h("div", { class: "dhead" }, h("b", { text: App.t("exp.historyTitle") }), h("button", { class: "linkbtn", text: "✕", onClick: close })),
        ...(App.P.exports.length ? App.P.exports.map((e) => h("div", { class: "drow", "data-path": e.path }, thumbBox(e.path, "tn"),
          h("div", { style: { minWidth: 0 } }, h("div", { class: "nm", text: e.name }),
            h("div", { class: "mono muted", text: `${e.size} MiB · ${ago(e.created)}` })),
          h("div", { class: "acts" },
            h("button", { class: "linkbtn", text: App.t("exp.show"), onClick: () => api.invoke("reveal", { path: e.path }) }),
            dragHandle(e.path, "lime", "⇪")))) : [h("div", { class: "muted", text: App.t("exp.none") })]))));
  }

  /* ───── settings: Nagrywanie · Biblioteka · Aplikacja ───── */

  const Settings = (App.Settings = { tab: "rec", adv: false });
  const U = App.ui;
  Settings.paintRecorder = () => App.RecUI.paint();   // called by the recorder poll while the tab is open
  const TABS = ["rec", "lib", "app"];
  const THEMES = [["ink", "#0b0c0a"], ["oled", "#000000"]];

  /** Settings pane; only a tab switch plays the slide-in, edits inside a tab re-render quietly. */
  Settings.render = async (animate = false) => {
    const root = App.$("#v-set");
    const pane = h("div", { class: "pane" + (animate ? " stepin" : "") });
    root.replaceChildren(h("div", { class: "set" },
      h("div", { class: "tabs" }, h("h1", { text: App.t("set.title") }),
        TABS.map((k) => h("button", { class: Settings.tab === k ? "on" : "", text: App.t("set.tab." + k),
          onClick: () => { Settings.tab = k; Settings.render(true); } })),
        h("div", { class: "grow" }),
        h("button", { class: "wizbtn", text: App.t("set.wizard"), onClick: () => App.RecUI.wizard() })),
      h("div", { class: "setscroll" }, pane)));
    if (Settings.tab === "rec") await App.RecUI.renderTab(pane);
    else if (Settings.tab === "lib") await renderLibraryTab(pane);
    else await renderAppTab(pane);
  };

  const advHead = (label, open, toggle) => h("button", { class: "advhead", onClick: toggle },
    h("span", { text: label }), h("span", { text: open ? "▴" : "▾" }));

  /* Biblioteka: one folder list (the radio marks where new recordings go), library toggles, export. */
  /** Replaces one export preset; the default target follows its slot if its old value disappeared. */
  function setPreset(i, v) {
    const s = App.P.settings, old = App.presets();
    if (!Number.isFinite(v) || v < 1 || v > 2000) { Settings.render(); return; }
    const next = old.slice();
    next[i] = Math.round(v);
    const slot = old.indexOf(s.defTarget);
    s.presets = next;
    if (!next.includes(s.defTarget)) s.defTarget = next[slot >= 0 ? slot : 0];
    App.persist();
    Settings.render();
  }

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
        h("button", { class: "radio" + (isRec ? " on" : ""), "aria-label": App.t("lib.recHere"), title: isRec ? App.t("lib.recHereOn") : App.t("lib.recHere"),
          onClick: () => { if (!isRec) setRecDir(d); } }),
        h("span", { class: "mono path" + (isRec ? "" : " dim"), text: d }),
        isRec ? h("span", { class: "tag lime", text: App.t("lib.tagNew") }) : h("span", { class: "tag", text: App.t("lib.tagOnly") }),
        isRec
          ? h("button", { class: "linkbtn", text: App.t("common.change"), onClick: async () => {
            const n = await api.pickFolder();
            if (!n) return;
            App.P.libDirs = App.P.libDirs.map((x) => (x === d ? n : x));
            await setRecDir(n);
          } })
          : h("button", { class: "linkbtn", text: "✕", title: App.t("lib.removeTip"), onClick: async () => {
            App.P.libDirs = App.P.libDirs.filter((x) => x !== d); await reload();
          } }));
    };
    pane.append(h("div", { class: "setcol" },
      h("div", null, U.cap(App.t("lib.folders")),
        h("div", { class: "card2 pad folders" }, ...dirs.map(folderRow),
          h("button", { class: "linkbtn", text: App.t("lib.add"), onClick: async () => {
            const n = await api.pickFolder();
            if (n && !App.P.libDirs.includes(n)) { App.P.libDirs.push(n); await reload(); }
          } }),
          // optional: take the icons of installed games for the games that have none yet (Steam, Epic, usual folders)
          h("button", { class: "linkbtn", text: App.t("lib.icons"), title: App.t("lib.iconsTip"), onClick: async (ev) => {
            const btn = ev.currentTarget;
            const todo = App.Lib.games().map(([g]) => g).filter((g) => !App.Lib.hasIcon(g));
            if (!todo.length) { App.toast(App.t("lib.iconsNone")); return; }
            btn.disabled = true;
            try {
              const r = await api.invoke("import_game_icons", { names: todo });
              await App.Lib.loadIcons();
              App.toast(App.t("lib.iconsDone", { n: r.found.length, m: todo.length }), r.found.length ? "ok" : "");
            } catch (e) {
              App.toast(String(e), "err");
            } finally {
              btn.disabled = false;
            }
          } }))),
      h("div", { class: "card2 tgl" },
        U.trow(App.t("lib.perGame"), App.t("lib.perGameD"), rc.per_game_folders, async (on) => { await App.RecUI.save({ per_game_folders: on }); Settings.render(); }),
        U.trow(App.t("lib.scan"), App.t("lib.scanD"), s.sub, async (on) => { s.sub = on; await reload(); }),
        U.trow(App.t("lib.auto"), App.t("lib.autoD"), s.auto, (on) => { s.auto = on; App.persist(); Settings.render(); })),
      h("div", null, U.cap(App.t("exp.cap")),
        h("div", { class: "card2" },
          U.srow(App.t("exp.defTarget"), h("div", { class: "pathrow" },
            Settings.presetsOpen
              ? h("div", { class: "pathrow" }, ...App.presets().map((mb, i) => h("input", { class: "field monoin", type: "number", min: 1, max: 2000, value: mb,
                style: { width: "74px" }, title: "MB", onChange: (e) => setPreset(i, +e.target.value) })), h("span", { class: "muted", text: "MB" }))
              : U.segc(App.presets().map((mb) => [mb, App.presetName(mb) ? `${App.presetName(mb)} · ${mb} MB` : `${mb} MB`]), s.defTarget, (mb) => { s.defTarget = mb; App.persist(); Settings.render(); }),
            h("button", { class: "linkbtn", text: Settings.presetsOpen ? "\u2713" : App.t("set.presetsEdit"),
              onClick: () => { Settings.presetsOpen = !Settings.presetsOpen; Settings.render(); } }))),
          U.srow(App.t("exp.outDir"), h("div", { class: "pathrow" },
            h("span", { class: "mono path", text: App.exportDirFor() }),
            h("button", { class: "linkbtn", text: App.t("common.change"), onClick: async () => {
              const d = await api.pickFolder();
              if (d) { s.outDir = d; App.persist(); Settings.render(); }
            } }),
            s.outDir ? h("button", { class: "linkbtn", text: App.t("common.default"), onClick: () => { s.outDir = ""; App.persist(); Settings.render(); } }) : null)),
          U.trow(App.t("exp.norm"), "−16 LUFS", s.normDef, (on) => { s.normDef = on; App.persist(); Settings.render(); }),
          U.srow(App.t("set.autoClean"), U.segc([[0, App.t("clean.never")], ...[7, 30, 90].map((n) => [n, App.t("clean.days", { n })])],
            s.autoCleanDays || 0, (d) => { s.autoCleanDays = d; App.persist(); Settings.render(); }))))));
  }

  /* Aplikacja: appearance + system. */
  async function renderAppTab(pane) {
    const s = App.P.settings;
    const [tools, size] = await Promise.all([api.invoke("tools_status").catch(() => null), api.invoke("cache_size").catch(() => 0)]);
    const encoder = ({ h264_nvenc: "NVIDIA NVENC", h264_amf: "AMD AMF", h264_qsv: "Intel QuickSync", libx264: App.t("enc.cpu") })[tools?.encoder] || App.t("enc.unknown");
    const cur = App.i18n.current();
    const langRow = U.srow(App.t("lang.label"), h("div", { class: "pathrow" },
      h("select", { class: "field", onChange: (e) => App.i18n.setLang(e.target.value) },
        App.i18n.ORDER.filter((c) => App.locales[c]).map((c) => h("option", { value: c, text: App.locales[c].name, selected: c === cur }))),
      App.locales[cur].ai ? h("span", { class: "muted", style: { fontSize: "12px", whiteSpace: "nowrap" }, title: App.t("lang.aiTip"), text: App.t("lang.ai") }) : null));
    pane.append(h("div", { class: "setcol" },
      h("div", { class: "card2" }, langRow),
      h("div", null, U.cap(App.t("theme.cap")), h("div", { class: "themes2" }, THEMES.map(([k, bg]) =>
        h("button", { class: "th2" + ((s.theme === "oled" ? "oled" : "ink") === k ? " on" : ""),
          onClick: () => { s.theme = k; App.persist(); App.applyTheme(); App.RecUI.syncLang().catch(() => {}); Settings.render(); } },
          h("div", { class: "pv2", style: { background: bg } }, h("i", { style: { width: "60%", background: "#1a1d16" } }), h("i", { style: { width: "30%", background: "#c6f432" } })),
          h("div", { class: "nm", text: App.t("theme." + k) }))))),
      h("div", { class: "card2" },
        U.srow(App.t("ver.label"), h("div", { class: "pathrow" },
          h("span", { class: "mono", id: "appVersion", text: "…" }),
          h("button", { class: "linkbtn", text: App.Update.hasUpdate() ? App.t("ver.install") : App.t("ver.check"),
            onClick: () => (App.Update.hasUpdate() ? App.Update.install() : App.Update.check(true)) }))),
        U.trow(App.t("ver.auto"), App.t("ver.autoD"), s.autoUpdate !== false, (on) => { s.autoUpdate = on; App.persist(); Settings.render(); }),
        U.srow(App.t("app.thumb"), U.segc(["S", "M", "L"].map((k) => [k, k]), s.thumb, (k) => { s.thumb = k; App.persist(); Settings.render(); })),
        U.trow(App.t("app.anim"), App.t("app.animD"), s.anim, (on) => { s.anim = on; App.persist(); App.applyTheme(); Settings.render(); })),
      h("div", null,
        advHead(App.t("adv.cap"), Settings.adv, () => { Settings.adv = !Settings.adv; Settings.render(); }),
        Settings.adv ? h("div", { class: "card2 rise pad stackrows" },
          h("div", { class: "between" }, h("span", { text: tools?.ffmpeg_found ? `ffmpeg ${tools.ffmpeg_version}` : "ffmpeg" }),
            h("span", { class: "mono " + (tools?.ffmpeg_found ? "lime" : "err"), style: { fontSize: "12px" },
              text: tools?.ffmpeg_found ? (tools.ffmpeg_bundled ? App.t("ffmpeg.bundled") : App.t("ffmpeg.system")) : App.t("ffmpeg.missing") })),
          h("div", { class: "between" }, h("span", { text: App.t("enc.label") }),
            h("span", { class: "mono " + (tools?.encoder && tools.encoder !== "libx264" ? "lime" : "warn"), style: { fontSize: "12px" },
              text: "● " + encoder + (tools?.gpu ? " · " + tools.gpu : "") })),
          h("div", { class: "between" }, h("span", { text: App.t("cache.label", { size: App.fmtMB(size) }) }),
            h("button", { class: "btn", text: App.t("cache.clear"), onClick: async () => {
              await api.invoke("clear_cache").catch(() => {});
              App.toast(App.t("cache.cleared"), "ok");
              Settings.render();
            } })),
          U.trow(App.t("hw.dec"), App.t("hw.decD"), s.hw, (on) => { s.hw = on; App.persist(); Settings.render(); }),
          U.trow(App.t("bgthumb"), App.t("bgthumbD"), s.thumbs, (on) => { s.thumbs = on; App.persist(); Settings.render(); }),
          U.trow(App.t("audiocache"), App.t("audiocacheD"), s.cache, (on) => { s.cache = on; App.persist(); Settings.render(); })) : null)));
  }

  // fill the version label once the settings page is on screen
  const showVersion = () => App.Update.version().then((ver) => { const el = App.$("#appVersion"); if (el && el.textContent !== (ver || "?")) el.textContent = ver || "?"; });   // only on change: writing the text is itself a DOM mutation, so an unconditional write loops forever
  new MutationObserver(() => { if (App.S.view === "set") showVersion(); }).observe(document.body, { childList: true, subtree: true });

  /* The recording tab and the first-run wizard live in recording.js. */
  

  App.renderNav = () => { buildTopbar(); renderRail(); };
})();
