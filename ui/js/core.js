"use strict";
/* Shared state, backend bridge and small helpers. Everything hangs off the global `App`. */

const App = {};
(function () {
  const T = window.__TAURI__;
  const invoke = T.core.invoke;

  App.api = {
    invoke,
    src: (p) => T.core.convertFileSrc(p),
    listen: (n, f) => T.event.listen(n, f),
    pickFolder: async () => {
      const r = await T.dialog.open({ directory: true, multiple: false });
      return typeof r === "string" ? r : null;
    },
    startDrag: (path) => invoke("plugin:drag|start_drag", {
      item: [path], image: App.dragIcon(), onEvent: new T.core.Channel(),
    }),
  };

  /* ───── tiny DOM helper ───── */
  App.h = function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
        else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === "text") el.textContent = v;
        else if (k === "value") el.value = v;
        else if (k in el && k !== "list") el[k] = v;
        else el.setAttribute(k, v === true ? "" : v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  };
  const h = App.h;
  App.$ = (s, r = document) => r.querySelector(s);

  /** Rejects when `p` takes longer than `ms`: a hung background process must never make a screen wait for it. */
  App.timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

  /** Per-clip track volumes (percent), 100 when the clip has none saved. */
  App.clipGain = (path, name) => ((App.P.clipGains || {})[path] || {})[name] ?? 100;
  App.setClipGain = (path, name, pct) => {
    const all = (App.P.clipGains ||= {});
    const mine = (all[path] ||= {});
    if (pct === 100) delete mine[name]; else mine[name] = pct;
    if (!Object.keys(mine).length) delete all[path];
    App.persist();
  };

  /* ───── formatting ───── */
  App.fmt = (s) => { s = Math.max(0, s || 0); const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`; };
  App.fmtS = (s) => { s = Math.round(s || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  App.fmtMB = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB`);
  App.date = (ts) => new Date(ts * 1000).toLocaleDateString(App.tag());
  App.baseName = (p) => p.slice(Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/")) + 1);

  /** `Risk-of-Rain-2__2025-04-22__14-41-40` -> "Risk of Rain 2" */
  App.gameOf = (clip) => {
    const raw = clip.name.split("__")[0] || clip.name;
    return raw.replace(/-+/g, " ").replace(/\s+/g, " ").trim() || App.t("clip.unknown");
  };
  /** What the user sees as the clip's name: their own title, else the game derived from the file name. */
  App.titleOf = (clip) => App.P.titles[clip.path] || App.gameOf(clip);
  /** The clip's own name (empty until the user sets one). The game is shown separately, never edited here. */
  App.customTitle = (clip) => App.P.titles[clip.path] || "";
  App.whenOf = (clip) => new Date(clip.modified * 1000).toLocaleString(App.tag(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  /** Turns `el` into a text field to rename the clip; Enter/blur saves, Esc cancels, empty resets. */
  App.editTitle = (el, path, done) => {
    const clip = App.S.byPath.get(path);
    if (!clip) return;
    const input = h("input", { class: "field titlein", value: App.customTitle(clip), placeholder: App.t("clip.namePh"), maxLength: 80, spellcheck: false });
    let finished = false;
    const finish = (save) => {
      if (finished) return;
      finished = true;
      if (save) {
        const v = input.value.trim();
        if (v) App.P.titles[path] = v; else delete App.P.titles[path];
        App.persist();
      }
      done();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    el.replaceWith(input);
    input.focus();
    input.select();
  };

  App.hueOf = (s) => { let x = 0; for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x % 360; };

  /* ───── persisted state (debounced) ───── */
  const DEFAULTS = {
    settings: {
      theme: "ink", anim: true, lite: false, thumb: "M",
      sub: true, auto: true, thumbs: true, cache: true, hw: true,
      normDef: false, drag: true, defTarget: 10, outDir: "", onboarded: false, lang: "en", langHint: false, presets: [10, 50, 500], autoCleanDays: 7,
    },
    libDirs: ["E:\\Nagrania"],
    favs: {}, titles: {}, trims: {}, clipGains: {}, newSet: [], libSeenAt: 0, exports: [], meta: {}, gains: { Game: 100, Chat: 100, Mic: 100 },
  };
  App.P = structuredClone(DEFAULTS);

  let saveTimer = 0;
  App.persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => invoke("save_state", { state: App.P }).catch(() => {}), 400);
  };
  App.loadPersisted = async () => {
    try {
      const s = await invoke("load_state");
      App.fresh = Object.keys(s).length === 0;
      // v2 of the look: the brand lime replaces the old orange default (only if it was never changed).
      if (s.settings && s.settings.brand !== 2) {
        if (s.settings.accent === "#ff6a1f") s.settings.accent = "#c6f432";
        s.settings.brand = 2;
      }
      App.P = { ...DEFAULTS, ...s, settings: { ...DEFAULTS.settings, ...(s.settings || {}) },
        gains: { ...DEFAULTS.gains, ...(s.gains || {}) } };
    } catch { /* first run */ }
  };

  /* ───── runtime state ───── */
  App.S = {
    view: "lib", clips: [], byPath: new Map(), cat: "all", q: "", sort: "newest",
    sel: new Set(), active: null, listError: "",
    exporting: null,           // { name, pct }
    recorder: null,            // last status from the recorder, or null if it is not running
  };

  /* ───── theme ───── */
  App.applyTheme = () => {
    const s = App.P.settings, r = document.documentElement;
    // Two themes only (Ink, OLED); the brand lime is fixed. Older saved themes fall back to Ink.
    r.dataset.theme = s.theme === "oled" ? "oled" : "";
    r.dataset.anim = s.anim ? "on" : "off";
  };

  /* ───── "NOWE" clips: added since the library was last opened, until opened themselves ───── */
  App.isNew = (path) => App.P.newSet.includes(path);
  App.markSeen = (path) => {
    const i = App.P.newSet.indexOf(path);
    if (i >= 0) { App.P.newSet.splice(i, 1); App.persist(); }
  };
  App.computeNew = (clips) => {
    if (App.newComputed) return;
    App.newComputed = true;
    const known = new Set(clips.map((c) => c.path));
    const keep = App.P.newSet.filter((p) => known.has(p));
    const since = App.P.libSeenAt;
    if (since) for (const c of clips) if (c.modified > since && !keep.includes(c.path)) keep.push(c.path);
    App.P.newSet = keep.slice(-200);
    App.P.libSeenAt = Math.floor(Date.now() / 1000);
    App.persist();
  };

  /** Animated logo trail + message, used for empty and loading states. */
  App.emptyState = (title, sub, actionLabel, onAction) => {
    const tails = [30, 10, 38, 18, 26, 6, 34, 14, 40];
    const rows = tails.map((t, i) => {
      const w = 12 + (4 - Math.abs(i - 4)) * 14;
      return h("div", { class: "l" },
        h("div", { class: "t" }, h("i", { style: { width: `${t}px`, animationDelay: `${i * 0.07}s` } })),
        h("div", { class: "w" }, h("i", { style: { width: `${w}px` } })));
    });
    return h("div", { class: "empty" }, h("div", { class: "lines" }, rows),
      h("b", { text: title }), sub ? h("div", { class: "muted", text: sub }) : null,
      actionLabel ? h("button", { class: "btn", text: actionLabel, onClick: onAction }) : null);
  };

  /* ───── settings building blocks (used by views.js and recording.js) ───── */
  App.ui = {
    cap: (t) => h("div", { class: "cap", text: t }),
    card: (...kids) => h("div", { class: "card2" }, ...kids),
    srow: (label, ctrl) => h("div", { class: "srow" }, h("span", { class: "lb", text: label }), ctrl),
    segc: (items, cur, on) => h("div", { class: "seg" }, items.map(([v, t]) =>
      h("button", { class: String(cur) === String(v) ? "on" : "", text: t, onClick: () => on(v) }))),
    trow: (title, desc, on, set) => h("div", { class: "trow", onClick: () => set(!on) },
      h("div", null, h("div", { class: "tt", text: title }), desc ? h("div", { class: "ds", text: desc }) : null),
      h("span", { class: "toggle lg" + (on ? " on" : "") })),
  };

  /* ───── toast ───── */
  App.toast = (msg, kind = "") => {
    const box = App.$("#toast");
    const t = App.h("div", { class: `t ${kind}`, text: msg });
    box.append(t);
    setTimeout(() => t.remove(), kind === "err" ? 7000 : 3500);
  };

  /* ───── helpers shared by several views ───── */
  App.dragIcon = (() => {
    let url = "";
    return () => {
      if (url) return url;
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      const g = c.getContext("2d");
      g.fillStyle = "#c6f432";
      g.beginPath(); g.roundRect(4, 4, 56, 56, 12); g.fill();
      g.fillStyle = "#111";
      g.beginPath(); g.moveTo(25, 18); g.lineTo(25, 46); g.lineTo(47, 32); g.closePath(); g.fill();
      return (url = c.toDataURL("image/png"));
    };
  })();

  /** Logo 5a "buffer": a play triangle made of scan-lines, each trailing a faded tail. */
  App.logo = (size = 36, color = "#c6f432") => {
    const tails = [30, 10, 38, 18, 26, 6, 34, 14, 40, 22, 8, 32, 16];
    const NS = "http://www.w3.org/2000/svg";
    const W = 44 + 84, H = 13 * 6 + 12 * 3;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", size);
    svg.setAttribute("height", Math.round((size * H) / W));
    svg.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 13; i++) {
      const w = 12 + (6 - Math.abs(i - 6)) * 12, y = i * 9;
      const tail = document.createElementNS(NS, "rect");
      tail.setAttribute("x", 44 - tails[i]); tail.setAttribute("y", y);
      tail.setAttribute("width", tails[i]); tail.setAttribute("height", 6); tail.setAttribute("rx", 3);
      tail.setAttribute("fill", color); tail.setAttribute("opacity", ".3");
      const bar = document.createElementNS(NS, "rect");
      bar.setAttribute("x", 44); bar.setAttribute("y", y);
      bar.setAttribute("width", w); bar.setAttribute("height", 6); bar.setAttribute("rx", 3);
      bar.setAttribute("fill", color);
      svg.append(tail, bar);
    }
    return svg;
  };

  /** Run async jobs with a concurrency cap; later calls can be cancelled while still queued. */
  App.queue = (limit) => {
    const waiting = [];
    let running = 0;
    const pump = () => {
      while (running < limit && waiting.length) {
        const job = waiting.shift();
        running++;
        job().finally(() => { running--; pump(); });
      }
    };
    return (fn) => new Promise((res, rej) => {
      waiting.push(() => fn().then(res, rej));
      pump();
    });
  };

  App.exportDirFor = () => {
    const s = App.P.settings;
    if (s.outDir) return s.outDir.replace(/[\\/]+$/, "");
    const base = (App.P.libDirs[0] || "E:\\Nagrania").replace(/[\\/]+$/, "");
    return `${base}\\Exported Clips`;
  };

  /** The three export size presets (MB). Saved values are validated so a bad state file can't break the panel. */
  App.presets = () => {
    const p = App.P.settings.presets;
    return Array.isArray(p) && p.length === 3 && p.every((n) => Number.isFinite(n) && n >= 1 && n <= 2000) ? p.map(Math.round) : [10, 50, 500];
  };
  /** Well-known destinations get their name; any other size is just shown in MB. */
  App.presetName = (mb) => ({ 10: "Discord", 50: "Boost", 500: "Nitro" })[mb] || "";

  /** Bitrate maths shared by editor panel and batch export; mirrors ml-core's budget. */
  App.kbps = (targetMb, seconds, speed = 1) =>
    Math.max(0, Math.floor((targetMb * 1048576 * 8 * 0.96) / (seconds / speed) / 1000) - 128);
  App.quality = (kbps) =>
    kbps < 150 ? [App.t("q.bad"), "var(--err)"] : kbps < 800 ? [App.t("q.low"), "var(--warn)"]
      : kbps < 3000 ? [App.t("q.good"), "var(--ok)"] : [App.t("q.great"), "var(--ok)"];
})();

