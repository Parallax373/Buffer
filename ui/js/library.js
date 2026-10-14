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
  const probeQ = App.queue(2);
  let animBudget = 0;
  let els = {};                       // cached DOM nodes of the built view

  /* ───── data ───── */

  Lib.load = async () => {
    const dirs = App.P.libDirs.filter(Boolean);
    try {
      S.clips = await api.invoke("list_clips", { dirs, recurse: App.P.settings.sub });
      S.listError = "";
    } catch (e) {
      S.clips = [];
      S.listError = String(e);
    }
    S.byPath = new Map(S.clips.map((c) => [c.path, c]));
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

  Lib.probeMissing = () => {
    if (!App.P.settings.thumbs) return;
    for (const c of S.clips) {
      if (Lib.meta(c)) continue;
      probeQ(async () => {
        try {
          const i = await api.invoke("probe_clip", { path: c.path });
          App.P.meta[c.path] = { size: c.size, dur: i.duration, w: i.width, h: i.height, fps: i.fps, tracks: i.audio.length };
          App.persist();
          const el = cards.get(c.path);
          if (el) updateCard(el, c);
          if (S.active === c.path) Lib.renderDetails();
        } catch { /* unreadable file: leave without metadata */ }
      });
    }
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
  const recentCutoff = () => {
    const mods = S.clips.map((c) => c.modified).sort((a, b) => b - a);
    return mods.length ? mods[Math.min(19, mods.length - 1)] : 0;
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

  Lib.visible = () => {
    const cat = S.cat, q = S.q.trim().toLowerCase();
    const recentCut = recentCutoff();
    let list = S.clips.filter((c) => {
      if (q && !(App.gameOf(c) + " " + c.name).toLowerCase().includes(q)) return false;
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
      search: h("input", { class: "field search", placeholder: "Szukaj klipów…", spellcheck: false, value: S.q,
        onInput: (e) => { S.q = e.target.value; Lib.render(false); } }),
      sort: h("select", { class: "field", onChange: (e) => { S.sort = e.target.value; Lib.render(false); } },
        [["newest", "Najnowsze"], ["oldest", "Najstarsze"], ["size", "Największe"], ["dur", "Najdłuższe"]]
          .map(([v, t]) => h("option", { value: v, text: t, selected: S.sort === v }))),
      thumbSeg: h("div", { class: "seg" }),
      grid: h("div", { class: "grid", onScroll: () => layoutGrid() }),
      spacer: h("div", { class: "spacer" }),
      bulk: h("div"),
      details: h("div", { class: "details" }),
    };
    els.grid.append(els.spacer);
    const toolbar = h("div", { class: "toolbar" }, els.title, els.count, h("span", { class: "sp" }),
      els.search, els.sort, els.thumbSeg);
    const main = h("div", { class: "main" }, toolbar, els.grid, els.bulk);
    root.append(h("div", { class: "lib" }, els.side, main, els.details));
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
        extra.sq ? h("span", { class: "sq", style: { background: extra.sq } }) : null,
        extra.dot ? h("span", { class: "ci", style: { background: extra.dot } }) : null,
        h("span", { class: "nm", text: label }), h("span", { class: "n", text: count }));
    const recentCut = recentCutoff();
    const frag = [
      h("div", { class: "cap", text: "Biblioteka" }),
      item("all", "Wszystkie", S.clips.length),
      item("recent", "Ostatnie", S.clips.filter((c) => c.modified >= recentCut).length),
      item("fav", "★ Ulubione", S.clips.filter(isFav).length),
      item("exp", "Wyeksportowane", S.clips.filter((c) => isExported(c.path)).length),
      h("div", { class: "cap", text: "Gry" }),
      ...Lib.games().map(([g, n]) => item("g:" + g, g, n, { sq: `hsl(${App.hueOf(g)} 60% 55%)` })),
    ];
    els.side.replaceChildren(...frag);
  };

  function renderToolbar() {
    const titles = { all: "Wszystkie klipy", recent: "Ostatnie", fav: "Ulubione", exp: "Wyeksportowane" };
    els.title.textContent = titles[S.cat] || S.cat.slice(2);
    els.count.textContent = `${Lib.visible().length} klipów`;
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

  function layoutGrid(force = false) {
    if (!els.grid || !els.grid.isConnected || !els.grid.clientWidth) return;
    const list = Lib.visible();
    const g = geometry();
    const rows = Math.ceil(list.length / g.cols);
    els.spacer.style.height = `${Math.max(0, rows * g.rowH - GAP)}px`;

    if (!list.length) {
      els.spacer.replaceChildren(h("div", { class: "muted", style: { padding: "40px 0", textAlign: "center" },
        text: S.listError || (S.clips.length ? "Brak klipów w tym widoku." : "Nie znaleziono klipów w folderze biblioteki.") }));
      cards.clear();
      return;
    }
    if (els.spacer.firstChild && !els.spacer.firstChild.classList?.contains("card") && !cards.size) {
      els.spacer.replaceChildren();
    }

    const top = els.grid.scrollTop, vh = els.grid.clientHeight;
    const first = Math.max(0, Math.floor(top / g.rowH) - 1);
    const last = Math.min(rows - 1, Math.floor((top + vh) / g.rowH) + 1);
    const wanted = new Set();
    for (let r = first; r <= last; r++) {
      for (let c = 0; c < g.cols; c++) {
        const i = r * g.cols + c;
        if (i >= list.length) break;
        const clip = list[i];
        wanted.add(clip.path);
        let el = cards.get(clip.path);
        if (!el) {
          el = createCard(clip);
          cards.set(clip.path, el);
          els.spacer.append(el);
          requestThumb(clip, el);
        }
        el.style.left = `${c * (g.cardW + GAP)}px`;
        el.style.top = `${r * g.rowH}px`;
        el.style.width = `${g.cardW}px`;
        if (force) updateCard(el, clip);
      }
    }
    for (const [p, el] of cards) {
      if (!wanted.has(p)) { el.remove(); cards.delete(p); }
    }
  }

  function createCard(clip) {
    const el = h("div", { class: "card", onClick: () => Lib.setActive(clip.path),
      onDblclick: () => App.Ed.open(clip.path) });
    if (animBudget > 0) animBudget--; else el.style.animation = "none";
    el.append(
      h("div", { class: "th" },
        h("div", { class: "chk", onClick: (e) => { e.stopPropagation(); Lib.toggleSel(clip.path); } }),
        h("div", { class: "star", text: "☆", onClick: (e) => { e.stopPropagation(); Lib.toggleFav(clip.path); } }),
        h("div", { class: "dur" }),
        h("div", { class: "tg" })),
      h("div", { class: "info" }, h("b", { text: App.gameOf(clip) }), h("span")));
    updateCard(el, clip);
    return el;
  }

  function updateCard(el, clip) {
    const sel = S.sel.has(clip.path);
    el.classList.toggle("sel", sel);
    el.classList.toggle("act", S.active === clip.path);
    const th = el.firstChild;
    th.querySelector(".chk").textContent = sel ? "✓" : "";
    const star = th.querySelector(".star");
    star.textContent = isFav(clip) ? "★" : "☆";
    star.classList.toggle("on", isFav(clip));
    const m = Lib.meta(clip);
    th.querySelector(".dur").textContent = m ? App.fmtS(m.dur) : "";
    th.querySelector(".dur").hidden = !m;
    const tg = th.querySelector(".tg");
    tg.replaceChildren(...(isExported(clip.path) ? [h("span", { text: "✓ wyeksp." })] : []));
    el.querySelector(".info span").textContent = `${App.date(clip.modified)} · ${App.fmtMB(clip.size)}`;
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
    Lib.renderBulk();
  };

  Lib.clearSel = () => {
    const old = [...S.sel];
    S.sel.clear();
    for (const p of old) { const el = cards.get(p), c = S.byPath.get(p); if (el && c) updateCard(el, c); }
    Lib.renderBulk();
  };

  Lib.renderBulk = () => {
    if (!els.bulk) return;
    if (!S.sel.size) { els.bulk.replaceChildren(); return; }
    const t = App.P.settings.defTarget;
    els.bulk.replaceChildren(h("div", { class: "bulk" },
      h("b", { text: String(S.sel.size) }), h("span", { class: "muted", text: "zaznaczone" }), h("span", { class: "sp" }),
      h("div", { class: "chip", style: { cursor: "pointer" }, onClick: () => {
        for (const p of S.sel) App.P.favs[p] = 1;
        App.persist(); refreshCards(); Lib.renderSide(); } }, "★ Ulubione"),
      h("button", { class: "btn acc", style: { padding: "7px 14px", borderRadius: "8px" },
        onClick: () => App.Exports.batch([...S.sel]), text: `Eksportuj partię · ${t} MB` }),
      h("button", { class: "btn danger", style: { padding: "7px 11px", borderRadius: "8px" },
        onClick: () => Lib.remove([...S.sel]), text: "Usuń" }),
      h("button", { class: "btn ghost", style: { padding: "7px 9px", border: 0, background: "none" },
        onClick: Lib.clearSel, text: "✕" })));
  };

  Lib.remove = async (paths) => {
    if (!paths.length) return;
    const msg = paths.length === 1
      ? `Przenieść „${App.baseName(paths[0])}” do Kosza?`
      : `Przenieść ${paths.length} klipów do Kosza?`;
    if (!confirm(msg)) return;
    try {
      await api.invoke("delete_clips", { paths });
      for (const p of paths) {
        delete App.P.favs[p]; delete App.P.meta[p];
        S.sel.delete(p);
      }
      App.persist();
      App.toast(`Przeniesiono do Kosza: ${paths.length}`, "ok");
      await Lib.load();
    } catch (e) {
      App.toast(`Nie udało się usunąć: ${e}`, "err");
    }
  };

  /* ───── details panel ───── */

  Lib.renderDetails = () => {
    if (!els.details) return;
    const c = S.active && S.byPath.get(S.active);
    if (!c) {
      els.details.replaceChildren(h("div", { class: "empty" }, "Wybierz klip,", h("br"), "aby zobaczyć szczegóły."));
      return;
    }
    const m = Lib.meta(c);
    const pv = h("div", { class: "pv" }, h("div", { class: "go", onClick: () => App.Ed.open(c.path) }, h("span", { text: "▶" })));
    Lib.thumbUrl(c.path).then((u) => { if (u && S.active === c.path) pv.prepend(h("img", { src: u, alt: "" })); });
    els.details.replaceChildren(
      pv,
      h("div", null, h("h2", { text: App.gameOf(c) }), h("div", { class: "file", text: App.baseName(c.path) })),
      h("dl", null,
        h("dt", { text: "Data" }), h("dd", { text: App.date(c.modified) }),
        h("dt", { text: "Czas" }), h("dd", { text: m ? App.fmtS(m.dur) : "…" }),
        h("dt", { text: "Rozmiar" }), h("dd", { text: App.fmtMB(c.size) }),
        h("dt", { text: "Format" }), h("dd", { text: m ? `${m.h}p · ${Math.round(m.fps)} fps` : "…" })),
      h("div", { class: "sp" }),
      h("button", { class: "btn acc", style: { padding: "11px" }, onClick: () => App.Ed.open(c.path), text: "✂  Edytuj i przytnij" }),
      h("button", { class: "btn", onClick: () => App.Exports.quick(c.path),
        text: `Szybki eksport · ${App.P.settings.defTarget === 10 ? "Discord " : ""}${App.P.settings.defTarget} MB` }),
      h("div", { style: { display: "flex", gap: "8px" } },
        h("button", { class: "btn ghost", style: { flex: 1 }, onClick: () => api.invoke("reveal", { path: c.path }), text: "Pokaż w folderze" }),
        h("button", { class: "btn danger", onClick: () => Lib.remove([c.path]), text: "Usuń" })));
  };
})();
