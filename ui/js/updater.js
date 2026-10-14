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
      if (App.S.view === "set" && App.Settings.tab === "app") App.Settings.render();
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
        paint();
      });
      // on Windows the installer takes over from here: it closes this window and starts the new version
    } catch (e) {
      busy = null;
      App.toast(App.t("upd.fail", { err: e }), "err");
      paint();
    }
  }

  function paint() {
    chip.hidden = !pending;
    if (pending) chip.replaceChildren(h("span", { text: "⬆" }), ` ${pending.version}`);
    chip.title = pending ? App.t("upd.tip") : "";
    const host = App.$("#updpop");
    if (!host) return;
    if (!pending || !open) { host.replaceChildren(); return; }
    const pct = busy && busy.total ? Math.min(100, Math.round((busy.done / busy.total) * 100)) : null;
    const notes = String(pending.body || "").trim();
    host.replaceChildren(h("div", { class: "popover updpopover" },
      h("div", { class: "pr1" }, h("b", { text: `Buffer ${pending.version}` }),
        h("span", { class: "mono muted", text: pending.date ? String(pending.date).slice(0, 10) : "" })),
      notes ? h("div", { class: "muted notes", text: notes.length > 400 ? notes.slice(0, 400) + "…" : notes }) : null,
      busy
        ? h("div", { class: "prog" },
          h("div", { class: "r" }, h("span", { text: pct == null ? App.t("upd.dl") : App.t("upd.dlInstall") }), h("span", { text: pct == null ? "" : `${pct}%` })),
          h("div", { class: "b" }, h("div", { style: { width: `${pct ?? 5}%` } })))
        : h("div", { class: "updactions" },
          h("button", { class: "btn acc", text: App.t("upd.now"),
            title: App.t("upd.nowTip"), onClick: install }),
          h("button", { class: "btn ghost", text: App.t("upd.later"), onClick: () => { open = false; paint(); } }))));
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
