"use strict";
/* Start-up: load persisted state, theme, library, recorder polling, global keys. */

(async function boot() {
  await App.loadPersisted();
  if (App.fresh) {
    // First launch on this machine: library = the default clips folder, not a developer-specific path.
    App.P.libDirs = [await App.api.invoke("default_clips_dir").catch(() => "")].filter(Boolean);
  }
  App.isDev = await App.api.invoke("is_dev_build").catch(() => false);
  if (App.isDev) document.title = "Buffer (dev)";
  App.i18n.init();
  App.applyTheme();
  App.renderNav();

  document.addEventListener("keydown", (ev) => {
    const t = ev.target;
    const typing = t instanceof HTMLInputElement && !["range", "checkbox"].includes(t.type);
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === "f" || ev.key === "F" || ev.key === "k" || ev.key === "K")) {
      ev.preventDefault();
      App.focusSearch();
      return;
    }
    if (typing || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
    if (App.S.view === "ed" && App.Ed.key(ev)) ev.preventDefault();
  });

  // Pick up clips the recorder saved while the window was in the background.
  window.addEventListener("focus", () => { if (App.S.view === "lib") App.Lib.load(); });

  App.Rec.start();
  App.Update.start();
  await App.Lib.load();
  App.go("lib");
  App.Exports.autoClean();            // only does anything when "Delete old exports" is set

  // First run: walk the user through the settings that matter.
  if (!App.P.settings.onboarded) setTimeout(() => App.RecUI.wizard(), 400);

  // If the user asked for recording at login but the recorder is not up (crashed, killed), start it.
  if (App.P.settings.onboarded) App.RecUI.syncLang().catch(() => {});   // existing installs: recorder follows the app language
  try {
    await App.Rec.refresh();
    if (!App.S.recorder && (await App.api.invoke("recorder_autostart", { enable: null }))) {
      await App.api.invoke("recorder_launch");
      setTimeout(App.Rec.refresh, 2000);
    }
  } catch { /* recorder binary not present (development layout) */ }
})().catch((e) => {
  console.error(e);
  document.body.prepend(Object.assign(document.createElement("pre"), { textContent: App.t("boot.failed", { err: e && e.stack || e }), style: "color:#ff6b6b;padding:20px;white-space:pre-wrap" }));
});
