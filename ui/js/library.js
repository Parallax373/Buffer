"use strict";
/* Library view: sidebar (categories / games), virtualised thumbnail grid, details panel. */

(function () {
  const { h, S, api } = App;
  const Lib = (App.Lib = {});
  const THUMB_W = { S: 170, M: 230, L: 320 };
  const GAP = 14;
  const INFO_H = 58;

  const cards = new Map();            // path -> element currently in the DOM
  const thumbUrls = new Map();        // path -> asset URL once generated
  const thumbQ = App.queue(3);
  const probeQ = App.queue(1);        // background: every clip without metadata
  const probeNowQ = App.queue(2);     // the cards in view
  let animBudget = 0;
  let els = {};                       // cached DOM nodes of the built view

  /* ───── data ───── */

  Lib.load = async () => {
    Lib.loadIcons();
    const dirs = App.P.libDirs.filter(Boolean);
    let clips = [], listError = "";
    try {
      clips = await api.invoke("list_clips", { dirs, recurse: App.P.settings.sub });
    } catch (e) {
      listError = String(e);
    }
    // the window gaining focus (moving it, alt-tabbing back) re-lists the folders; when nothing changed the grid is left
    // alone: no rebuild, no entrance animations, just the small tags refreshed in place
    const sig = listError + "#" + clips.map((c) => `${c.path}|${c.modified}|${c.size}`).join("\n");
    if (sig === Lib._sig) {
      if (S.view === "lib") { refreshCards(); Lib.renderSide(); }
      return;
    }
    Lib._sig = sig;
    S.clips = clips;
    S.listError = listError;
    S.byPath = new Map(S.clips.map((c) => [c.path, c]));
    App.computeNew(S.clips);
    for (const p of [...S.sel]) if (!S.byPath.has(p)) S.sel.delete(p);
    if (S.active && !S.byPath.has(S.active)) S.active = null;
    animBudget = 24;
    Lib.probeMissing();
    if (S.view === "lib") Lib.render();
  };

  Lib.meta = (c) => {
    const m = App.P.meta[c.path];
    return m && m.size === c.size ? m : null;
  };

  // path -> "queued" | "running": a card that comes into view jumps the background queue, and whichever job starts
  // first does the probe (the other one finds it running or done and returns)
  const probing = new Map();
  const probe = (c, q) => {
    const st = probing.get(c.path);
    if (Lib.meta(c) || st === "running" || st === "failed@" + c.size || (q === probeQ && st && !st.startsWith("failed"))) return;
    probing.set(c.path, "queued");
    q(async () => {
      if (Lib.meta(c) || probing.get(c.path) !== "queued") return;
      probing.set(c.path, "running");
      try {
        const i = await api.invoke("probe_clip", { path: c.path });
        App.P.meta[c.path] = { size: c.size, dur: i.duration, w: i.width, h: i.height, fps: i.fps, tracks: i.audio.length };
        App.persist();
        const el = cards.get(c.path);
        if (el) updateCard(el, c);
        if (S.active === c.path) Lib.renderDetails();
        probing.delete(c.path);
      } catch { probing.set(c.path, "failed@" + c.size); /* unreadable: no metadata, retried only once the file changes */ }
    });
  };
  /** Cards on screen get their duration first; the rest of a big folder is probed one file at a time behind them. */
  Lib.probeMissing = () => {
    if (!App.P.settings.thumbs) return;
    for (const c of S.clips) probe(c, probeQ);
  };

  const isExported = (() => {
    let cacheKey = -1, set = new Set();
    return (path) => {
      if (cacheKey !== App.P.exports.length) {
        set = new Set(App.P.exports.map((e) => e.source));
        cacheKey = App.P.exports.length;
      }
      return set.has(path);
    };
  })();

  /** Timestamp of the 20th newest clip: "recent" always shows something, however long ago you played. */
  let recentFor = null, recentAt = 0;
  const recentCutoff = () => {
    if (recentFor !== S.clips) {            // a sort of every clip: once per listing, not on every render
      const mods = S.clips.map((c) => c.modified).sort((a, b) => b - a);
      recentFor = S.clips;
      recentAt = mods.length ? mods[Math.min(19, mods.length - 1)] : 0;
    }
    return recentAt;
  };

  const isFav = (c) => !!App.P.favs[c.path];

  Lib.games = () => {
    const m = new Map();
    for (const c of S.clips) {
      const g = App.gameOf(c);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  /* Game logos: the recorder saves the game's exe icon the first time it records that game. */
  const gameKey = (s) => s.replace(/-+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  let gameIcons = new Map();          // normalised game name -> asset URL
  Lib.loadIcons = async () => {
    try {
      const list = await api.invoke("game_icons");
      const next = new Map(list.map(([name, p]) => [gameKey(name), api.src(p)]));
      const same = next.size === gameIcons.size && [...next].every(([k, v]) => gameIcons.get(k) === v);
      gameIcons = next;
      if (!same && S.view === "lib") { Lib.renderSide(); refreshCards(); Lib.renderDetails(); }
    } catch { /* older backend: swatches only */ }
  };

  /** Small logo <img> for a game, or null when the recorder has not saved one. */
  Lib.gameIcon = (game) => {
    const url = gameIcons.get(gameKey(game));
    return url ? h("img", { class: "gi", src: url, alt: "" }) : null;
  };

  /** Logo of a game in the sidebar; a colour swatch when the game has none yet. */
  function gameThumb(game) {
    const url = gameIcons.get(gameKey(game));
    if (url) return h("img", { class: "gt", src: url, alt: "" });
    return h("span", { class: "gt sw", style: { background: `hsl(${App.hueOf(game)} 60% 55%)` } });
  }

  Lib.visible = () => {
    const cat = S.cat, q = S.q.trim().toLowerCase();
    const recentCut = recentCutoff();
    let list = S.clips.filter((c) => {
      if (q && !(App.titleOf(c) + " " + App.gameOf(c) + " " + c.name).toLowerCase().includes(q)) return false;
      if (cat === "all") return true;
      if (cat === "recent") return c.modified >= recentCut;
      if (cat === "fav") return isFav(c);
      if (cat === "exp") return isExported(c.path);
      if (cat.startsWith("g:")) return App.gameOf(c) === cat.slice(2);
      return true;
    });
    const dur = (c) => (Lib.meta(c) || {}).dur || 0;
    const sorters = {
      newest: (a, b) => b.modified - a.modified, oldest: (a, b) => a.modified - b.modified,
      size: (a, b) => b.size - a.size, dur: (a, b) => dur(b) - dur(a),
    };
    list = list.slice().sort(sorters[S.sort]);
    return list;
  };

  Lib.toggleFav = (path) => {
    if (App.P.favs[path]) delete App.P.favs[path]; else App.P.favs[path] = 1;
    App.persist();
    refreshCards(); Lib.renderSide(); Lib.renderDetails();
    if (S.view === "ed" && App.Ed) App.Ed.refreshFav();
  };

  /* ───── build ───── */

  Lib.build = () => {
    const root = App.$("#v-lib");
    root.replaceChildren();
    els = {
      side: h("div", { class: "side" }),
      title: h("h1"), count: h("span", { class: "count" }),
      sort: h("select", { class: "field", onChange: (e) => { S.sort = e.target.value; Lib.render(false); } },
        ["newest", "oldest", "size", "dur"]
          .map((v) => h("option", { value: v, text: App.t("sort." + v), selected: S.sort === v }))),
      thumbSeg: h("div", { class: "seg" }),
      group: h("select", { class: "field", title: App.t("group.date"),
        onChange: (e) => { App.P.settings.groupBy = e.target.value; App.persist(); Lib.render(true); } },
      ["none", "date"].map((v) => h("option", { value: v, text: App.t("group." + v), selected: (App.P.settings.groupBy || "none") === v }))),
      grid: h("div", { class: "grid", onScroll: () => {
        // scroll fires many times per frame; only the cards in view change, so the cached layout is reused
        if (scrollFrame) return;
        scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; layoutGrid(false, true); });
      },
        // a click on the empty background clears the selection (the details panel can hide the cards under it)
        onClick: (e) => { if ((e.target === els.grid || e.target === els.spacer) && (S.sel.size || S.active)) Lib.clearSel(); } }),
      spacer: h("div", { class: "spacer" }),
      bulk: h("div"),
      details: h("div", { class: "details" }),
    };
    els.grid.append(els.spacer);
    const toolbar = h("div", { class: "toolbar" }, els.title, els.count, h("span", { class: "sp" }),
      els.group, els.sort, els.thumbSeg);
    const main = h("div", { class: "main" }, toolbar, els.grid, els.bulk);
    els.lib = h("div", { class: "lib nodetail" }, els.side, main, els.details);
    root.append(els.lib);
    new ResizeObserver(() => layoutGrid()).observe(els.grid);
  };

  Lib.render = (full = true) => {
    if (!els.grid || !els.grid.isConnected) Lib.build();
    Lib.renderSide();
    renderToolbar();
    Lib.renderBulk();
    Lib.renderDetails();
    if (full) { for (const el of cards.values()) el.remove(); cards.clear(); }
    layoutGrid(true);
  };

  /* ───── sidebar ───── */

  Lib.renderSide = () => {
    if (!els.side) return;
    const item = (key, label, count, extra = {}) =>
      h("div", { class: "row" + (S.cat === key ? " on" : ""), onClick: () => { S.cat = key; Lib.render(false); } },
        extra.game ? gameThumb(extra.game) : null,
        extra.dot ? h("span", { class: "ci", style: { background: extra.dot } }) : null,
        h("span", { class: "nm", text: label }), h("span", { class: "n", text: count }));
    const recentCut = recentCutoff();
    // the five biggest games; the "Games" caption opens the full list. An opened game outside the top five stays visible.
    const GAMES_SHOWN = 5;
    const games = Lib.games();
    let shown = S.gamesOpen ? games : games.slice(0, GAMES_SHOWN);
    if (!S.gamesOpen && S.cat.startsWith("g:") && !shown.some(([g]) => "g:" + g === S.cat)) {
      const cur = games.find(([g]) => "g:" + g === S.cat);
      if (cur) shown = [...shown.slice(0, GAMES_SHOWN - 1), cur];
    }
    const frag = [
      h("div", { class: "cap", text: App.t("cat.cap") }),
      item("all", App.t("cat.all"), S.clips.length),
      item("recent", App.t("cat.recent"), S.clips.filter((c) => c.modified >= recentCut).length),
      item("fav", "★ " + App.t("cat.fav"), S.clips.filter(isFav).length),
      item("exp", App.t("cat.exp"), S.clips.filter((c) => isExported(c.path)).length),
      h("button", { class: "cap capbtn", disabled: games.length <= GAMES_SHOWN,
        title: games.length > GAMES_SHOWN ? (S.gamesOpen ? App.t("cat.less") : App.t("cat.more", { n: games.length - GAMES_SHOWN })) : "",
        onClick: () => { S.gamesOpen = !S.gamesOpen; Lib.renderSide(); } },
        h("span", { text: App.t("cat.games") }),
        games.length > GAMES_SHOWN ? h("span", { class: "gar", text: S.gamesOpen ? "▾" : "▸" }) : null),
      ...shown.map(([g, n]) => item("g:" + g, g, n, { game: g })),
    ].filter(Boolean);
    els.side.replaceChildren(...frag);
  };

  function renderToolbar() {
    const titles = { all: App.t("cat.allClips"), recent: App.t("cat.recent"), fav: App.t("cat.fav"), exp: App.t("cat.exp") };
    els.title.textContent = titles[S.cat] || S.cat.slice(2);
    els.count.textContent = App.t("lib.count", { n: Lib.visible().length });
    els.thumbSeg.replaceChildren(...["S", "M", "L"].map((k) =>
      h("button", { class: App.P.settings.thumb === k ? "on" : "", text: k,
        onClick: () => { App.P.settings.thumb = k; App.persist(); renderToolbar(); layoutGrid(true); } })));
  }

  /* ───── virtualised grid ───── */

  function geometry() {
    const w = els.grid.clientWidth - 36;      // grid has 18px side padding
    const minW = THUMB_W[App.P.settings.thumb] || 230;
    const cols = Math.max(1, Math.floor((w + GAP) / (minW + GAP)));
    const cardW = (w - GAP * (cols - 1)) / cols;
    const cardH = Math.round((cardW * 9) / 16) + INFO_H;
    return { cols, cardW, cardH, rowH: cardH + GAP };
  }

  /* Optional grouping by date: thin headers (collapsible) between the cards. Positions are computed for the whole
     list (cheap) and only the cards near the viewport exist as DOM nodes. */
  const GROUP_H = 34;
  const heads = new Map();           // group key -> header element currently in the DOM
  S.collapsed = S.collapsed || new Set();

  function bucketOf(clip) {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    const t = clip.modified;
    if (t >= midnight) return { key: "today", order: 0, label: App.t("group.today") };
    if (t >= midnight - 86400) return { key: "yesterday", order: 1, label: App.t("group.yesterday") };
    if (t >= midnight - 6 * 86400) return { key: "week", order: 2, label: App.t("group.week") };
    const d = new Date(t * 1000);
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) {
      return { key: "month", order: 3, label: App.t("group.month") };
    }
    // the last twelve months get a group each; anything older is grouped by year so the list stays short
    if ((now.getFullYear() * 12 + now.getMonth()) - (d.getFullYear() * 12 + d.getMonth()) > 12) {
      return { key: `y:${d.getFullYear()}`, order: 5000 + (9999 - d.getFullYear()), label: String(d.getFullYear()) };
    }
    const label = d.toLocaleDateString(App.tag(), { month: "long", year: "numeric" });
    return {
      key: `m:${d.getFullYear()}-${d.getMonth() + 1}`,
      order: 10 + (9999 * 12 - (d.getFullYear() * 12 + d.getMonth())),     // newer months first
      label: label.charAt(0).toUpperCase() + label.slice(1),
    };
  }

  function layout(list, g) {
    const items = [], groups = [];
    const at = (i, y0) => ({ x: (i % g.cols) * (g.cardW + GAP), y: y0 + Math.floor(i / g.cols) * g.rowH });
    if ((App.P.settings.groupBy || "none") !== "date") {
      list.forEach((clip, i) => items.push({ clip, ...at(i, 0) }));
      return { items, groups, height: Math.max(0, Math.ceil(list.length / g.cols) * g.rowH - GAP) };
    }
    const byKey = new Map();
    for (const c of list) {
      const b = bucketOf(c);
      let e = byKey.get(b.key);
      if (!e) byKey.set(b.key, (e = { ...b, clips: [] }));
      e.clips.push(c);
    }
    let y = 0;
    for (const e of [...byKey.values()].sort((a, b) => a.order - b.order)) {
      const closed = S.collapsed.has(e.key);
      groups.push({ key: e.key, label: e.label, y, count: e.clips.length, closed, clips: e.clips });
      y += GROUP_H;
      if (closed) continue;
      e.clips.forEach((clip, i) => items.push({ clip, ...at(i, y) }));
      y += Math.ceil(e.clips.length / g.cols) * g.rowH;
    }
    return { items, groups, height: Math.max(0, y - GAP) };
  }

  let scrollFrame = 0;
  let laid = null;                   // { list, lay, cols, cardW } of the last full layout, reused while scrolling
  function layoutGrid(force = false, scrollOnly = false) {
    if (!els.grid || !els.grid.isConnected || !els.grid.clientWidth) return;
    const g = geometry();
    const reuse = scrollOnly && laid && laid.cols === g.cols && laid.cardW === g.cardW;
    const list = reuse ? laid.list : Lib.visible();

    if (!list.length) {
      els.spacer.style.height = "0px";
      const filtered = !!S.q || S.cat !== "all";
      els.spacer.replaceChildren(App.emptyState(
        S.listError ? App.t("lib.loadFail") : App.t("lib.none"),
        S.listError || (S.clips.length ? App.t("lib.noMatch") : App.t("lib.empty")),
        filtered ? App.t("lib.clearFilters") : null,
        () => { S.q = ""; S.cat = "all"; const i = App.$("#topSearch"); if (i) i.value = ""; Lib.render(false); }));
      cards.clear();
      heads.clear();
      laid = null;
      return;
    }
    els.spacer.querySelector(":scope > .empty")?.remove();

    const lay = reuse ? laid.lay : layout(list, g);
    laid = { list, lay, cols: g.cols, cardW: g.cardW };
    els.spacer.style.height = `${lay.height}px`;
    const top = els.grid.scrollTop, vh = els.grid.clientHeight;
    const lo = top - g.rowH, hi = top + vh + g.rowH;
    // items are in y order: binary-search the first one in view instead of walking all of them
    let a = 0, b = lay.items.length;
    while (a < b) { const m = (a + b) >> 1; if (lay.items[m].y + g.rowH < lo) a = m + 1; else b = m; }
    const wanted = new Set();
    for (let i = a; i < lay.items.length; i++) {
      const it = lay.items[i];
      if (it.y > hi) break;
      const clip = it.clip;
      wanted.add(clip.path);
      let el = cards.get(clip.path);
      if (!el) {
        el = createCard(clip);
        cards.set(clip.path, el);
        els.spacer.append(el);
        requestThumb(clip, el);
        if (App.P.settings.thumbs) probe(clip, probeNowQ);
      }
      el.style.left = `${it.x}px`;
      el.style.top = `${it.y}px`;
      el.style.width = `${g.cardW}px`;
      if (force) updateCard(el, clip);
    }
    for (const [p, el] of cards) {
      if (!wanted.has(p)) { el.remove(); cards.delete(p); }
    }

    const wantHeads = new Set();
    for (const gr of lay.groups) {
      wantHeads.add(gr.key);
      let el = heads.get(gr.key);
      if (!el) {
        el = h("button", { class: "ghead", onClick: () => {
          if (S.collapsed.has(gr.key)) S.collapsed.delete(gr.key); else S.collapsed.add(gr.key);
          layoutGrid(true);
        } });
        heads.set(gr.key, el);
        els.spacer.append(el);
      }
      el.style.top = `${gr.y}px`;
      el._gr = gr;
      const picked = gr.clips.reduce((n, c) => n + (S.sel.has(c.path) ? 1 : 0), 0);
      const sig = `${gr.count}|${gr.closed}|${gr.label}|${picked}`;
      if (el._sig !== sig) {
        el._sig = sig;
        // the box selects (or clears) every clip of the group
        const all = picked === gr.count;
        el.replaceChildren(
          h("span", { class: "gsel" + (picked ? " on" : ""), title: App.t("group.selectAll"),
            onClick: (ev) => { ev.stopPropagation(); Lib.selectGroup(el._gr.clips); } }, all ? "✓" : picked ? "–" : ""),
          h("span", { class: "gl", text: gr.label }), h("span", { class: "gc", text: String(gr.count) }),
          h("span", { class: "gar", text: gr.closed ? "▸" : "▾" }));
      }
    }
    for (const [k, el] of heads) {
      if (!wantHeads.has(k)) { el.remove(); heads.delete(k); }
    }
  }

  function createCard(clip) {
    const el = h("div", { class: "card", onClick: () => App.Ed.open(clip.path),
      onContextmenu: (e) => { e.preventDefault(); api.invoke("reveal", { path: clip.path }); } });
    if (animBudget > 0) animBudget--; else el.style.animation = "none";
    el.append(
      h("div", { class: "th" },
        h("div", { class: "chk", onClick: (e) => { e.stopPropagation(); Lib.toggleSel(clip.path); } }),
        h("div", { class: "star", text: "☆", onClick: (e) => { e.stopPropagation(); Lib.toggleFav(clip.path); } }),
        h("div", { class: "dur" }),
        h("div", { class: "now", text: App.t("badge.new") }),
        h("div", { class: "tg" })),
      h("div", { class: "info" }, h("div", { class: "gl" }, h("b", { text: App.gameOf(clip) })), h("span")));
    updateCard(el, clip);
    return el;
  }

  function updateCard(el, clip) {
    const sel = S.sel.has(clip.path);
    el.classList.toggle("sel", sel);
    el.classList.toggle("act", S.active === clip.path);
    const fresh = App.isNew(clip.path);
    el.classList.toggle("fresh", fresh);
    el.firstChild.querySelector(".now").hidden = !fresh;
    const th = el.firstChild;
    th.querySelector(".chk").textContent = sel ? "✓" : "";
    const star = th.querySelector(".star");
    star.textContent = isFav(clip) ? "★" : "☆";
    star.classList.toggle("on", isFav(clip));
    el.querySelector(".info b").textContent = App.titleOf(clip);
    // the game's logo next to the name (only when the recorder saved one)
    const gl = el.querySelector(".info .gl"), want = gameIcons.get(gameKey(App.gameOf(clip))) || "";
    if (gl._icon !== want) {
      gl._icon = want;
      gl.querySelector("img")?.remove();
      if (want) gl.prepend(h("img", { class: "gi", src: want, alt: "" }));
    }
    const m = Lib.meta(clip);
    th.querySelector(".dur").textContent = m ? App.fmtS(m.dur) : "";
    th.querySelector(".dur").hidden = !m;
    // a clip with its own name shows the game next to the date, so the card still says what it is
    el.querySelector(".info span").textContent = `${App.customTitle(clip) ? App.gameOf(clip) + " · " : ""}${App.date(clip.modified)} · ${App.fmtMB(clip.size)}`;
  }

  function refreshCards() {
    for (const [p, el] of cards) {
      const c = S.byPath.get(p);
      if (c) updateCard(el, c);
    }
  }

  function requestThumb(clip, el) {
    if (!App.P.settings.thumbs) return;
    const img = (url) => {
      const th = el.firstChild;
      if (th.querySelector("img")) return;
      th.prepend(h("img", { src: url, alt: "", loading: "lazy", decoding: "async" }));
    };
    if (thumbUrls.has(clip.path)) return img(thumbUrls.get(clip.path));
    thumbQ(async () => {
      if (!el.isConnected) return;           // scrolled away before its turn
      try {
        const p = await api.invoke("thumbnail", { path: clip.path });
        const url = api.src(p);
        thumbUrls.set(clip.path, url);
        if (el.isConnected) img(url);
      } catch { /* clip has no decodable frame yet */ }
    });
  }
  Lib.thumbUrl = async (path) => {
    if (thumbUrls.has(path)) return thumbUrls.get(path);
    try {
      const p = await api.invoke("thumbnail", { path });
      const url = api.src(p);
      thumbUrls.set(path, url);
      return url;
    } catch { return ""; }
  };

  /* ───── selection ───── */

  Lib.setActive = (path) => {
    const prev = S.active;
    S.active = path;
    for (const p of [prev, path]) { const el = cards.get(p), c = S.byPath.get(p); if (el && c) updateCard(el, c); }
    Lib.renderDetails();
  };

  Lib.toggleSel = (path) => {
    if (S.sel.has(path)) S.sel.delete(path); else S.sel.add(path);
    const el = cards.get(path), c = S.byPath.get(path);
    if (el && c) updateCard(el, c);
    // exactly one checked clip opens the details panel (a click on the card itself opens the editor)
    const prev = S.active;
    S.active = S.sel.size === 1 ? [...S.sel][0] : null;
    for (const p of [prev, S.active]) { const e2 = cards.get(p), c2 = S.byPath.get(p); if (e2 && c2) updateCard(e2, c2); }
    Lib.renderDetails();
    Lib.renderBulk();
    layoutGrid();
  };

  /** Checks every clip of a date group, or clears them when they are all checked already. */
  Lib.selectGroup = (clips) => {
    const all = clips.every((c) => S.sel.has(c.path));
    for (const c of clips) { if (all) S.sel.delete(c.path); else S.sel.add(c.path); }
    const prev = S.active;
    S.active = S.sel.size === 1 ? [...S.sel][0] : null;
    for (const p of new Set([prev, S.active, ...clips.map((c) => c.path)])) {
      const el = cards.get(p), c = S.byPath.get(p);
      if (el && c) updateCard(el, c);
    }
    Lib.renderDetails();
    Lib.renderBulk();
    layoutGrid();
  };

  Lib.clearSel = () => {
    const old = [...S.sel];
    S.sel.clear();
    S.active = null;
    for (const p of old) { const el = cards.get(p), c = S.byPath.get(p); if (el && c) updateCard(el, c); }
    Lib.renderDetails();
    Lib.renderBulk();
    layoutGrid();
  };

  Lib.renderBulk = () => {
    if (!els.bulk) return;
    if (!S.sel.size) { els.bulk.replaceChildren(); return; }
    const t = App.P.settings.defTarget;
    els.bulk.replaceChildren(h("div", { class: "bulk" },
      h("b", { text: String(S.sel.size) }), h("span", { class: "muted", text: App.t("bulk.selected") }), h("span", { class: "sp" }),
      h("div", { class: "chip", style: { cursor: "pointer" }, onClick: () => {
        for (const p of S.sel) App.P.favs[p] = 1;
        App.persist(); refreshCards(); Lib.renderSide(); } }, "★ Ulubione"),
      h("button", { class: "btn acc", style: { padding: "7px 14px", borderRadius: "8px" },
        onClick: () => App.Exports.batch([...S.sel]), text: App.t("bulk.export", { mb: t }) }),
      h("button", { class: "btn danger", style: { padding: "7px 11px", borderRadius: "8px" },
        onClick: () => Lib.remove([...S.sel]), text: App.t("common.delete") }),
      h("button", { class: "btn ghost", style: { padding: "7px 9px", border: 0, background: "none" },
        onClick: Lib.clearSel, text: "✕" })));
  };

  Lib.remove = async (paths) => {
    if (!paths.length) return;
    try {
      await api.invoke("delete_clips", { paths });
      for (const p of paths) {
        delete App.P.favs[p]; delete App.P.meta[p]; delete App.P.titles[p]; delete (App.P.trims || {})[p]; delete (App.P.clipGains || {})[p];
        S.sel.delete(p);
      }
      App.persist();
      App.toast(App.t("rm.done", { n: paths.length }), "ok");
      await Lib.load();
    } catch (e) {
      App.toast(App.t("rm.fail", { err: e }), "err");
    }
  };

  /* ───── details panel ───── */

  Lib.renderDetails = () => {
    if (!els.details) return;
    // the details panel takes space only while one clip is selected
    els.lib?.classList.toggle("nodetail", !(S.active && S.byPath.get(S.active)));
    const c = S.active && S.byPath.get(S.active);
    if (!c) {
      els.details.replaceChildren(h("div", { class: "empty" }, App.t("det.empty").split("\n").flatMap((l, i) => (i ? [h("br"), l] : [l]))));
      return;
    }
    const m = Lib.meta(c);
    const pv = h("div", { class: "pv" }, h("div", { class: "go", onClick: () => App.Ed.open(c.path) }, h("span", { text: "▶" })));
    Lib.thumbUrl(c.path).then((u) => { if (u && S.active === c.path) pv.prepend(h("img", { src: u, alt: "" })); });
    els.details.replaceChildren(
      h("button", { class: "dclose", title: App.t("common.close"), "aria-label": App.t("common.close"), text: "✕", onClick: Lib.clearSel }),
      pv,
      h("div", null,
        h("div", { class: "gamechip", title: App.t("det.game") }, Lib.gameIcon(App.gameOf(c)), App.gameOf(c)),
        h("h2", { class: "ttl" + (App.customTitle(c) ? "" : " ph"), title: App.t("det.rename"),
          text: App.customTitle(c) || App.whenOf(c), onClick: (ev) => {
          App.editTitle(ev.currentTarget, c.path, () => { refreshCards(); Lib.renderSide(); Lib.renderDetails(); });
        } }),
        h("div", { class: "file", text: App.baseName(c.path) })),
      h("dl", null,
        h("dt", { text: App.t("det.date") }), h("dd", { text: App.date(c.modified) }),
        h("dt", { text: App.t("det.len") }), h("dd", { text: m ? App.fmtS(m.dur) : "…" }),
        h("dt", { text: App.t("det.size") }), h("dd", { text: App.fmtMB(c.size) }),
        h("dt", { text: App.t("det.format") }), h("dd", { text: m ? `${m.h}p · ${Math.round(m.fps)} fps` : "…" })),
      h("div", { class: "sp" }),
      h("button", { class: "btn acc", style: { padding: "11px" }, onClick: () => App.Ed.open(c.path), text: App.t("det.edit") }),
      h("button", { class: "btn", onClick: () => App.Exports.quick(c.path),
        text: App.t("det.quick", { target: `${App.P.settings.defTarget === 10 ? "Discord " : ""}${App.P.settings.defTarget} MB` }) }),
      h("div", { style: { display: "flex", gap: "8px" } },
        h("button", { class: "btn ghost", style: { flex: 1 }, onClick: () => api.invoke("reveal", { path: c.path }), text: App.t("det.reveal") }),
        h("button", { class: "btn danger", onClick: () => Lib.remove([c.path]), text: App.t("common.delete") })));
  };
})();
