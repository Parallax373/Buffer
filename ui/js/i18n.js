"use strict";
/* Translations. Text lives in js/locales/<code>.js (en is the master and the fallback for missing keys).
   Always call App.t() when a label is drawn: the language is only known after the saved state has loaded,
   so labels must never be translated once at script load. */

App.locales = {};
App.i18n = (function () {
  const ORDER = ["en", "pl", "de", "es", "fr", "uk", "tr", "ja", "zh"];
  let lang = "en";
  const rules = {};
  const rule = (code) => (rules[code] ||= new Intl.PluralRules(App.locales[code].tag));

  function format(code, key, vars) {
    let src = code, v = App.locales[code]?.t[key];
    if (v === undefined) { src = "en"; v = App.locales.en.t[key]; }
    if (v === undefined) return key;
    if (typeof v === "object") v = v[rule(src).select(vars?.n ?? 0)] ?? v.other;
    return vars ? v.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : v;
  }

  App.t = (key, vars) => format(lang, key, vars);
  /** A string in a specific language (used to word the "switch language" suggestion in that language). */
  App.tIn = (code, key, vars) => format(code, key, vars);
  /** BCP 47 tag of the UI language, for Intl and date formatting. */
  App.tag = () => App.locales[lang].tag;

  /* Bundled fonts cover Latin only; Cyrillic and CJK fall back to Windows' own UI fonts under the same family names. */
  const SYSTEM = {
    cyr: ["Segoe UI"],
    ja: ["Yu Gothic UI", "Meiryo UI", "Microsoft YaHei UI"],
    zh: ["Microsoft YaHei UI", "Microsoft YaHei", "SimSun"],
  };
  function installFonts(code) {
    const faces = [];
    const add = (names, range) => {
      const src = names.map((n) => `local("${n}")`).join(", ");
      for (const fam of ["Instrument Sans", "JetBrains Mono"]) {
        faces.push(`@font-face { font-family: "${fam}"; font-weight: 100 900; src: ${src}; unicode-range: ${range}; }`);
      }
    };
    add(SYSTEM.cyr, "U+0400-052F, U+2DE0-2DFF, U+A640-A69F");
    if (code === "ja" || code === "zh") add(SYSTEM[code], "U+2E80-A4CF, U+AC00-D7AF, U+F900-FAFF, U+FE30-FE4F, U+FF00-FFEF, U+3000-303F");
    let st = document.getElementById("i18n-fonts");
    if (!st) { st = document.createElement("style"); st.id = "i18n-fonts"; document.head.append(st); }
    st.textContent = faces.join("\n");
  }

  /** Picks the UI language (call once after the saved state is loaded). */
  function init() {
    const want = App.P.settings.lang;
    lang = App.locales[want] ? want : "en";
    document.documentElement.lang = App.locales[lang].tag;   // also makes CSS uppercase right for Turkish
    installFonts(lang);
  }

  /** The OS language, when it is one we ship and not English; null otherwise. Only ever a suggestion. */
  function detect() {
    for (const raw of navigator.languages || [navigator.language]) {
      const tag = String(raw).toLowerCase();
      const base = tag.split("-")[0];
      if (base === "en") return null;
      if (base === "zh" && /tw|hk|mo|hant/.test(tag)) continue;   // we only have Simplified Chinese
      if (App.locales[base]) return base;
    }
    return null;
  }

  /** The language to suggest, or null (already handled, already using it, or nothing to suggest). */
  const suggestion = () => {
    if (App.P.settings.langHint) return null;
    const d = detect();
    return d && d !== lang ? d : null;
  };

  const dismissHint = () => { App.P.settings.langHint = true; App.persist(); };

  /** Switching reloads the window so every label is rebuilt in the new language; state is saved first. */
  async function setLang(code) {
    App.P.settings.lang = code;
    App.P.settings.langHint = true;
    await App.api.invoke("save_state", { state: App.P }).catch(() => {});
    // the recorder (tray menu, popups) follows the app language; best effort, it may not be installed
    if (App.P.settings.onboarded) {
      try { await App.api.invoke("set_recorder_config", { config: { ...(await App.api.invoke("recorder_config")), lang: code } }); await App.api.invoke("recorder_cmd", { cmd: "reload" }); } catch { /* recorder not available */ }
    }
    location.reload();
  }

  /** One-line "switch to <language>" link worded in that language, for the first-run wizard. */
  function hintLink(onDone) {
    const code = suggestion();
    if (!code) return null;
    const h = App.h;
    return h("div", { class: "langhint inline" },
      h("button", { class: "linkbtn lime", text: App.tIn(code, "lang.switchTo"), onClick: () => setLang(code) }),
      App.locales[code].ai ? h("span", { class: "muted", title: App.tIn(code, "lang.aiTip"), text: App.tIn(code, "lang.ai") }) : null,
      h("button", { class: "linkbtn", text: "✕", onClick: (e) => { dismissHint(); e.currentTarget.parentElement.remove(); onDone?.(); } }));
  }

  /** For returning users: a dismissible bar, shown once. */
  function showBanner() {
    const el = hintLink();
    if (!el) return;
    el.classList.remove("inline");
    el.classList.add("bar");
    document.body.append(el);
  }

  return { ORDER, init, detect, suggestion, setLang, hintLink, showBanner, current: () => lang };
})();
