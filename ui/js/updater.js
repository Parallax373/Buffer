"use strict";
/* Auto-update: checks the release feed in the background, shows a chip in the top bar when a newer version
   exists, and installs it on the user's click (the recorder stops for a few seconds while the installer runs). */

App.Update = (function () {
  const { h, S } = App;
  const CHECK_EVERY = 6 * 3600 * 1000;       // while the app stays open
  const MIN_GAP = 20 * 3600 * 1000;          // and at most about once a day across launches

  let pending = null;                         // the Update object returned by the plugin
  let checking = false;
  let busy = null;                            // { done, total } while downloading
  let open = false;
  let version = "";
  let live = null;                            // the nodes that change during the download (patched, never rebuilt)
  let chipFor = "";                           // version the chip currently shows

  const BARS = 30;                            // segments of the download bar, like the export popover
  const plugin = () => window.__TAURI__ && window.__TAURI__.updater;
  const chip = h("button", { class: "updchip", hidden: true, onClick: () => { open = !open; paint(); } });

  async function currentVersion() {
    if (version) return version;
    try { version = await window.__TAURI__.app.getVersion(); } catch { version = ""; }
    return version;
  }

  /** Looks for a newer version. `manual` = the user asked, so say what happened. */
  async function check(manual = false) {
    if (!plugin()) {
      if (manual) App.toast(App.t("upd.noInstall"), "err");
      return null;
    }
    if (checking) return pending;
    checking = true;
    try {
      const u = await plugin().check();
      App.P.settings.lastUpdateCheck = Date.now();
      App.persist();
      pending = u || null;
      if (manual) App.toast(u ? App.t("upd.available", { v: u.version }) : App.t("upd.latest"), u ? "ok" : "");
      return pending;
    } catch (e) {
      if (manual) App.toast(App.t("upd.checkFail", { err: e }), "err");
      return null;
    } finally {
      checking = false;
      paint();
      // the button in Settings > App follows the result; rebuilding the whole panel for one label made it flash
      const btn = App.$("#updBtn");
      if (btn) btn.textContent = App.t(pending ? "ver.install" : "ver.check");
    }
  }

  async function install() {
    if (!pending || busy) return;
    busy = { done: 0, total: 0 };
    paint();
    try {
      await pending.downloadAndInstall((ev) => {
        if (ev.event === "Started") busy.total = ev.data.contentLength || 0;
        else if (ev.event === "Progress") busy.done += ev.data.chunkLength;
        patchProgress();
      });
      // on Windows the installer takes over from here: it closes this window and starts the new version
    } catch (e) {
      busy = null;
      App.toast(App.t("upd.fail", { err: e }), "err");
      paint();
    }
  }

  /** Download progress tick: only numbers and the bar width change. Rebuilding the popover on every tick restarted
   *  its entrance animation, which is what made it blink. */
  let lastPatch = 0;
  function patchProgress() {
    if (!live || !live.num.isConnected || !busy) return;
    const now = performance.now();
    if (now - lastPatch < 80 && busy.done < busy.total) return;
    lastPatch = now;
    const pct = busy.total ? Math.min(100, (busy.done / busy.total) * 100) : null;
    // the same segmented bar as the export popover; without a known size the first segments are lit
    const p = pct ?? 6;
    live.bars.forEach((b, i) => { b.style.opacity = 0.12 + (0.35 + 0.65 * (i / BARS) - 0.12) * Math.max(0, Math.min(1, (p / 100) * BARS - i)); });
    live.num.textContent = pct == null ? "" : `${Math.round(pct)}%`;
    const label = pct == null ? App.t("upd.dl") : App.t("upd.dlInstall");
    if (live.label.textContent !== label) live.label.textContent = label;
  }

  function paint() {
    chip.hidden = !pending;
    const want = pending ? pending.version : "";
    if (chipFor !== want) {
      chipFor = want;
      if (pending) chip.replaceChildren(h("span", { text: "⬆" }), ` ${pending.version}`);
    }
    chip.title = pending ? App.t("upd.tip") : "";
    live = null;
    const host = App.$("#updpop");
    if (!host) return;
    if (!pending || !open) { host.replaceChildren(); return; }
    const notes = String(pending.body || "").trim();
    const wasOpen = !!host.firstChild;          // a rebuild of an open popover must not replay the entrance animation
    host.replaceChildren(h("div", { class: "popover updpopover", style: wasOpen ? { animation: "none" } : null },
      h("div", { class: "pr1" }, h("b", { text: `Buffer ${pending.version}` }),
        h("span", { class: "mono muted", text: pending.date ? String(pending.date).slice(0, 10) : "" })),
      notes ? h("div", { class: "muted notes", text: notes.length > 400 ? notes.slice(0, 400) + "…" : notes }) : null,
      busy
        ? progressBlock()
        : h("div", { class: "updactions" },
          h("button", { class: "btn acc", text: App.t("upd.now"),
            title: App.t("upd.nowTip"), onClick: install }),
          h("button", { class: "btn ghost", text: App.t("upd.later"), onClick: () => { open = false; paint(); } }))));
  }

  function progressBlock() {
    live = { label: h("span"), num: h("span", { class: "mono lime" }), bars: Array.from({ length: BARS }, () => h("i")) };
    const block = h("div", null,
      h("div", { class: "pr1" }, live.label, live.num),
      h("div", { class: "scan" }, live.bars));
    lastPatch = 0;
    patchProgress();
    return block;
  }

  /** Background checks: shortly after start, then every few hours; respects the setting. */
  function start() {
    const maybe = () => {
      if (App.P.settings.autoUpdate === false) return;
      if (Date.now() - (App.P.settings.lastUpdateCheck || 0) < MIN_GAP && !pending) return;
      check(false);
    };
    setTimeout(maybe, 20000);
    setInterval(() => { if (App.P.settings.autoUpdate !== false) check(false); }, CHECK_EVERY);
  }

  return { chip, check, install, start, version: currentVersion, hasUpdate: () => !!pending };
})();
