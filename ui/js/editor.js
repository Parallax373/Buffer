"use strict";
/* Editor view: multi-track preview (picture + one <audio> per track), trim, lanes with waveforms,
   16:9 crop, speed, loudness, and the export panel. */

(function () {
  const { h, S, api } = App;
  const Ed = (App.Ed = {});
  const MIN_SEL = 0.5;
  const TRACK_COLORS = { Game: "var(--t-game)", Chat: "var(--t-chat)", Mic: "var(--t-mic)" };
  const TRACK_HEX = { Game: "#1fb89a", Chat: "#4a9ae0", Mic: "#e0a23a" };

  /** Editor session; null while no clip is open. */
  let E = null;
  let ctx = null;                 // shared AudioContext
  let raf = 0;
  let loadToken = 0;
  let ui = {};                    // cached DOM nodes of the built editor

  const video = h("video", { muted: true, playsInline: true, preload: "auto" });

  /* ───── open / close ───── */

  Ed.open = async (path) => {
    const clip = S.byPath.get(path);
    if (!clip) return;
    const token = ++loadToken;
    stop();
    teardownTracks();
    E = {
      clip, info: null, start: 0, end: 0, tracks: [], playing: false,
      target: App.P.settings.defTarget, wide: false, pan: 50, norm: App.P.settings.normDef,
      speed: 1, codec: "auto", res: "orig", done: null,
    };
    S.active = path;
    App.go("ed");          // needs E to be set: go() falls back to the library when no clip is open
    build();
    renderAll();

    try {
      const [info, files] = await Promise.all([
        api.invoke("probe_clip", { path }),
        api.invoke("prepare_audio", { path }),
      ]);
      if (token !== loadToken) return;
      E.info = info;
      E.start = 0;
      E.end = info.duration;
      video.src = api.src(path);
      video.load();
      if (!ctx) ctx = new AudioContext();
      E.tracks = info.audio.map((t, i) => makeTrack(t.name, files[i], i));
      renderAll();
      for (const t of E.tracks) {
        api.invoke("waveform", { path, index: t.index }).then((w) => {
          if (token === loadToken) { t.wave = w; drawLanes(); }
        }).catch(() => {});
      }
    } catch (e) {
      App.toast(`Nie można otworzyć klipu: ${e}`, "err");
      E.error = String(e);
      renderAll();
    }
  };

  function makeTrack(name, file, index) {
    const el = new Audio();
    // Without CORS mode WebAudio mutes cross-origin media: the preview would be silent.
    el.crossOrigin = "anonymous";
    el.preload = "auto";
    el.src = api.src(file);
    const node = ctx.createGain();
    ctx.createMediaElementSource(el).connect(node).connect(ctx.destination);
    const gain = (App.P.gains[name] ?? 100) / 100;
    node.gain.value = gain;
    return { name, index, el, node, gain, wave: null };
  }

  function teardownTracks() {
    if (!E) return;
    for (const t of E.tracks) {
      t.el.pause();
      t.el.removeAttribute("src");
      t.el.load();
      try { t.node.disconnect(); } catch { /* already gone */ }
    }
    E.tracks = [];
  }

  /* ───── playback ───── */

  function play() {
    if (!E || !E.info) return;
    ctx?.resume();
    if (video.currentTime < E.start || video.currentTime >= E.end - 0.05) video.currentTime = E.start;
    for (const t of E.tracks) {
      t.el.currentTime = video.currentTime;
      t.el.playbackRate = video.playbackRate;
      t.el.play().catch(() => {});
    }
    video.play().catch(() => {});
  }

  function stop() {
    video.pause();
    if (E) for (const t of E.tracks) t.el.pause();
  }

  function seek(t) {
    if (!E || !E.info) return;
    t = Math.min(Math.max(t, 0), E.info.duration);
    video.currentTime = t;
    for (const tr of E.tracks) tr.el.currentTime = t;
    paintHead();
  }

  /* The animation loop only runs while playing. */
  function tick() {
    if (!E || video.paused) { raf = 0; return; }
    if (video.currentTime >= E.end) {
      seek(E.start);
      for (const t of E.tracks) if (t.el.paused) t.el.play().catch(() => {});
    } else {
      for (const t of E.tracks) {
        if (Math.abs(t.el.currentTime - video.currentTime) > 0.08) t.el.currentTime = video.currentTime;
      }
    }
    paintHead();
    raf = requestAnimationFrame(tick);
  }

  video.addEventListener("play", () => {
    if (E) E.playing = true;
    if (!raf) raf = requestAnimationFrame(tick);
    renderTransport();
  });
  video.addEventListener("pause", () => { if (E) E.playing = false; renderTransport(); });
  video.addEventListener("waiting", () => { if (E) for (const t of E.tracks) t.el.pause(); });
  video.addEventListener("playing", () => {
    if (!E) return;
    for (const t of E.tracks) { t.el.currentTime = video.currentTime; t.el.play().catch(() => {}); }
  });
  video.addEventListener("loadedmetadata", () => paintCrop());
  video.addEventListener("seeked", paintHead);
  window.addEventListener("resize", () => { if (App.S.view === "ed") paintCrop(); });

  /* ───── layout ───── */

  function build() {
    const root = App.$("#v-ed");
    root.replaceChildren();
    ui = {
      rail: h("div", { class: "rail" }),
      head: h("div", { class: "edhead" }),
      stage: h("div", { class: "stage" }),
      crop: h("div", { class: "crop", hidden: true }),
      big: h("div", { class: "big", onClick: toggle }),
      transport: h("div", { class: "transport" }),
      lanesWrap: h("div", { class: "tl" }),
      panel: h("div", { class: "expanel" }),
    };
    const box = h("div", { class: "box" }, video, ui.crop);
    ui.stage.append(box, ui.big);
    root.append(h("div", { class: "ed" }, ui.rail,
      h("div", { class: "edmain" }, ui.head, ui.stage, ui.transport, ui.lanesWrap,
        h("div", { class: "hint", text: "Spacja – odtwarzaj · I / O – początek / koniec · przeciągnij uchwyty, aby przyciąć · klik w oś – przewiń" })),
      ui.panel));
  }

  function renderAll() {
    renderRail(); renderHead(); renderTransport(); renderLanes(); renderPanel(); paintCrop();
  }

  const toggle = () => (video.paused ? play() : stop());

  /** The rail lists every clip of the current library view; thumbnails load lazily while scrolling. */
  let railObserver = null;
  function renderRail() {
    const list = App.Lib.visible().slice(0, 400);
    railObserver?.disconnect();
    const items = list.map((c) => {
      const tn = h("div", { class: "tn" + (c.path === E.clip.path ? " on" : ""), title: App.gameOf(c),
        onClick: () => Ed.open(c.path) });
      tn.dataset.path = c.path;
      return tn;
    });
    ui.rail.replaceChildren(
      h("button", { class: "back", title: "Biblioteka", onClick: () => App.go("lib"), text: "▦" }),
      h("div", { class: "tns" }, items));
    railObserver = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const tn = en.target;
        railObserver.unobserve(tn);
        App.Lib.thumbUrl(tn.dataset.path).then((u) => { if (u) tn.style.backgroundImage = `url("${u}")`; });
      }
    }, { root: ui.rail.querySelector(".tns"), rootMargin: "120px" });
    items.forEach((tn) => railObserver.observe(tn));
    ui.rail.querySelector(".tn.on")?.scrollIntoView({ block: "center" });
  }

  function renderHead() {
    const list = App.Lib.visible();
    const i = list.findIndex((c) => c.path === E.clip.path);
    const step = (d) => { if (list.length) Ed.open(list[(i + d + list.length) % list.length].path); };
    Ed.step = step;
    ui.head.replaceChildren(
      h("button", { class: "nv", onClick: () => step(-1), title: "Poprzedni [K]", text: "‹" }),
      h("button", { class: "nv", onClick: () => step(1), title: "Następny [J]", text: "›" }),
      h("b", { style: { fontSize: "14px" }, text: App.gameOf(E.clip) }),
      h("span", { class: "mono muted", style: { fontSize: "12px" }, text: App.baseName(E.clip.path) }),
      h("span", { class: "sp" }),
      h("button", { class: "fav" + (App.P.favs[E.clip.path] ? " on" : ""), id: "edFav",
        onClick: () => App.Lib.toggleFav(E.clip.path), text: App.P.favs[E.clip.path] ? "★" : "☆" }));
  }
  Ed.refreshFav = () => { if (E) renderHead(); };

  function renderTransport() {
    if (!E) return;
    ui.big.replaceChildren(E.playing ? "" : h("span", { text: "▶" }));
    const dur = E.info ? E.info.duration : 0;
    ui.transport.replaceChildren(
      h("button", { class: "play", onClick: toggle, text: E.playing ? "❚❚" : "▶" }),
      h("span", { class: "time", id: "edTime", text: `${App.fmt(video.currentTime)} / ${App.fmt(dur)}` }),
      h("span", { class: "sp" }),
      h("button", { class: "mk", onClick: setIn }, "Początek ", h("b", { text: "I" })),
      h("button", { class: "mk", onClick: setOut }, "Koniec ", h("b", { text: "O" })),
      h("span", { class: "sel", id: "edSel", text: `wybrano ${App.fmtS(E.end - E.start)}` }));
  }

  function setIn() { if (E?.info) { E.start = Math.min(video.currentTime, E.end - MIN_SEL); layoutSel(); } }
  function setOut() { if (E?.info) { E.end = Math.max(video.currentTime, E.start + MIN_SEL); layoutSel(); } }

  /* ───── timeline lanes ───── */

  function renderLanes() {
    const dur = E.info ? E.info.duration : 0;
    const names = E.tracks.length ? E.tracks : ["Game", "Chat", "Mic"].map((n) => ({ name: n, gain: (App.P.gains[n] ?? 100) / 100 }));
    const labels = h("div", { class: "labels" }, h("div", { style: { height: "20px" } }),
      h("div", { class: "lane-l", style: { color: "var(--muted)", justifyContent: "center", flexDirection: "row", alignItems: "center" } }, "Klip"));
    const area = h("div", { class: "area" });
    ui.area = area;
    const ruler = h("div", { class: "ruler" });
    for (let i = 0; i < 7; i++) {
      const sp = h("span", { text: App.fmtS((dur * i) / 6), style: { left: `${(i / 6) * 100}%`,
        transform: i === 0 ? "none" : i === 6 ? "translateX(-100%)" : "translateX(-50%)" } });
      ruler.append(sp);
    }
    area.append(ruler, h("div", { class: "lane" }));
    ui.canvases = [];
    for (const t of names) {
      const hex = TRACK_COLORS[t.name] || "var(--muted)";
      const val = h("span", { text: `${Math.round(t.gain * 100)}%` });
      const slider = h("input", { type: "range", min: 0, max: 200, value: Math.round(t.gain * 100),
        style: { accentColor: hex },
        onInput: (e) => {
          t.gain = e.target.value / 100;
          if (t.node) t.node.gain.value = t.gain;
          App.P.gains[t.name] = +e.target.value;
          App.persist();
          val.textContent = `${e.target.value}%`;
          drawLanes(); updateEstimate();
        } });
      labels.append(h("div", { class: "lane-l" },
        h("div", { class: "hd" }, h("b", { style: { color: hex }, text: t.name }), val), slider));
      const cv = h("canvas");
      cv.dataset.name = t.name;
      ui.canvases.push({ cv, track: t });
      area.append(h("div", { class: "lane" }, cv));
    }
    ui.dimL = h("div", { class: "dim", style: { left: 0, borderRadius: "8px 0 0 8px" } });
    ui.dimR = h("div", { class: "dim", style: { right: 0, borderRadius: "0 8px 8px 0" } });
    ui.selbox = h("div", { class: "selbox" });
    ui.hIn = h("div", { class: "hnd" });
    ui.hOut = h("div", { class: "hnd" });
    ui.head_ = h("div", { class: "head" });
    area.append(ui.dimL, ui.dimR, ui.selbox, ui.hIn, ui.hOut, ui.head_);
    bindTimeline(area);
    ui.lanesWrap.replaceChildren(labels, area);
    layoutSel();
    requestAnimationFrame(drawLanes);
  }

  const pct = (t) => (E?.info ? (t / E.info.duration) * 100 : 0);

  function layoutSel() {
    if (!E || !ui.selbox) return;
    ui.dimL.style.width = `${pct(E.start)}%`;
    ui.dimR.style.width = `${100 - pct(E.end)}%`;
    ui.selbox.style.left = `${pct(E.start)}%`;
    ui.selbox.style.width = `${pct(E.end) - pct(E.start)}%`;
    ui.hIn.style.left = `${pct(E.start)}%`;
    ui.hOut.style.left = `${pct(E.end)}%`;
    const sel = App.$("#edSel");
    if (sel) sel.textContent = `wybrano ${App.fmtS(E.end - E.start)}`;
    updateEstimate();
    drawLanes();
    paintHead();
  }

  function paintHead() {
    if (!E?.info || !ui.head_) return;
    ui.head_.style.left = `${pct(video.currentTime)}%`;
    const t = App.$("#edTime");
    if (t) t.textContent = `${App.fmt(video.currentTime)} / ${App.fmt(E.info.duration)}`;
  }

  function drawLanes() {
    if (!E || !ui.canvases) return;
    const dur = E.info ? E.info.duration : 0;
    for (const { cv, track } of ui.canvases) {
      const w = cv.clientWidth, hgt = cv.clientHeight;
      if (!w) continue;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hgt * dpr); }
      const g = cv.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, hgt);
      const bars = track.wave;
      if (!bars) continue;
      const hex = TRACK_HEX[track.name] || "#8b919c";
      const scale = track.gain > 1 ? 1 : 0.4 + track.gain / 1.7;
      const n = bars.length, bw = w / n;
      for (let i = 0; i < n; i++) {
        const t = (i / n) * dur;
        g.globalAlpha = t >= E.start && t <= E.end ? 0.95 : 0.35;
        g.fillStyle = hex;
        const bh = Math.max(1.5, (bars[i] / 100) * (hgt - 8) * scale);
        g.fillRect(i * bw + 0.5, (hgt - bh) / 2, Math.max(1, bw - 1), bh);
      }
    }
    if (ui.canvases[0]) ui.canvases[0].cv.dataset.ready = "1";
  }
  window.addEventListener("resize", () => { if (App.S.view === "ed") drawLanes(); });

  function bindTimeline(area) {
    const timeAt = (ev) => {
      const r = area.getBoundingClientRect();
      return Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1) * (E?.info?.duration ?? 0);
    };
    area.addEventListener("pointerdown", (ev) => { if (E?.info) seek(timeAt(ev)); });
    const drag = (node, apply) => {
      node.addEventListener("pointerdown", (ev) => {
        if (!E?.info) return;
        ev.stopPropagation();
        node.setPointerCapture(ev.pointerId);
        const move = (e) => { apply(timeAt(e)); layoutSel(); };
        const up = () => { node.removeEventListener("pointermove", move); node.removeEventListener("pointerup", up); };
        node.addEventListener("pointermove", move);
        node.addEventListener("pointerup", up);
      });
    };
    drag(ui.hIn, (t) => { E.start = Math.min(t, E.end - MIN_SEL); });
    drag(ui.hOut, (t) => { E.end = Math.max(t, E.start + MIN_SEL); });
  }

  /* ───── crop overlay ───── */

  function paintCrop() {
    if (!E || !ui.crop) return;
    ui.crop.hidden = !E.wide;
    if (!E.wide) return;
    const w = video.clientWidth, hgt = video.clientHeight;
    if (!w || !hgt) return;
    let cw = w, ch = hgt;
    if (w / hgt > 16 / 9) cw = (hgt * 16) / 9; else ch = (w * 9) / 16;   // same rule as the exporter
    Object.assign(ui.crop.style, { width: `${cw}px`, height: `${ch}px`,
      left: `${(w - cw) * (E.pan / 100)}px`, top: `${(hgt - ch) / 2}px` });
  }

  /* ───── export panel ───── */

  function renderPanel() {
    const P = ui.panel;
    const presets = [["Discord", 10], ["Boost", 50], ["Nitro", 500]];
    const seg = (items, cur, on) => h("div", { class: "seg" }, items.map(([label, v]) =>
      h("button", { class: String(cur) === String(v) ? "on" : "", text: label, onClick: () => on(v) })));
    const tog = (label, key, extra) => h("div", { class: "opt", style: { cursor: "pointer" },
      onClick: () => { E[key] = !E[key]; renderPanel(); paintCrop(); updateEstimate(); } },
      h("span", { text: label }), h("span", { class: "toggle" + (E[key] ? " on" : "") }));

    const sum = h("div", { class: "sumcard" },
      h("div", { class: "r1" }, h("span", { class: "big", id: "sumLen" }), h("span", { class: "mono muted", id: "sumTarget", style: { fontSize: "12px" } })),
      h("div", { class: "meter" }, h("div", { id: "sumMeter" })),
      h("div", { class: "r3" }, h("span", { id: "sumQ" }), h("span", { id: "sumKbps" })));

    const exporting = S.exporting && S.exporting.source === E.clip.path;
    const items = [
      h("div", { class: "cap", text: "Eksport" }),
      h("div", { class: "presets" }, presets.map(([n, mb]) =>
        h("button", { class: E.target === mb ? "on" : "", onClick: () => { E.target = mb; renderPanel(); updateEstimate(); } },
          n, h("br"), h("small", { text: `${mb} MB` })))),
      sum,
      h("div", { class: "opts" },
        h("div", { class: "opt" }, h("span", { text: "Rozdzielczość" }),
          h("select", { class: "field", onChange: (e) => { E.res = e.target.value; updateEstimate(); } },
            [["orig", "oryginał"], ["1080", "1080p"], ["720", "720p"], ["540", "540p"]]
              .map(([v, t]) => h("option", { value: v, text: t, selected: E.res === v })))),
        h("div", { class: "opt" }, h("span", { text: "Kodek" }),
          h("select", { class: "field", onChange: (e) => { E.codec = e.target.value; } },
            [["auto", "Automatyczny (GPU)"], ["hevc-nvenc", "HEVC NVENC"], ["x264", "H.264 CPU"]]
              .map(([v, t]) => h("option", { value: v, text: t, selected: E.codec === v })))),
        h("div", { class: "opt" }, h("span", { text: "Prędkość" }),
          seg([["0.5×", 0.5], ["1×", 1], ["1.5×", 1.5], ["2×", 2]], E.speed, (v) => {
            E.speed = v; video.playbackRate = v;
            for (const t of E.tracks) t.el.playbackRate = v;
            renderPanel(); updateEstimate();
          })),
        tog("Kadr 16:9", "wide"),
        E.wide ? h("div", { class: "opt" }, h("span", { text: "Pozycja kadru" }),
          h("input", { type: "range", min: 0, max: 100, value: E.pan, style: { width: "130px" },
            onInput: (e) => { E.pan = +e.target.value; paintCrop(); } })) : null,
        tog("Normalizuj (−16 LUFS)", "norm")),
      h("div", { class: "sp" }),
      E.done && !exporting ? doneChip() : null,
      exporting ? h("div", { class: "prog" },
        h("div", { class: "r" }, h("span", { text: "Eksportowanie…" }), h("span", { id: "edPct", text: `${Math.round(S.exporting.pct)}%` })),
        h("div", { class: "b" }, h("div", { id: "edBar", style: { width: `${S.exporting.pct}%` } }))) : null,
      E.error ? h("div", { class: "errmsg", text: E.error }) : null,
      h("button", { class: "btn acc", style: { padding: "12px", opacity: exporting ? 0.5 : 1 }, disabled: !!S.exporting || !E.info,
        onClick: doExport, text: exporting ? "Eksportowanie…" : E.done ? "Eksportuj ponownie" : "Eksportuj" })];
    P.replaceChildren(...items.filter(Boolean));   // append(null) would render the text "null"
    updateEstimate();
  }

  function doneChip() {
    const d = E.done;
    const chip = h("div", { class: "done", title: "Przeciągnij plik do Discorda lub innego okna" },
      h("span", { class: "ic", text: "⇪" }),
      h("div", { style: { minWidth: 0 } }, h("div", { class: "nm", text: d.name }),
        h("div", { class: "sz", text: `${d.size} MiB · przeciągnij do Discorda` })));
    chip.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      App.api.startDrag(d.path).catch((e) => App.toast(`Nie udało się przeciągnąć pliku: ${e}`, "err"));
    });
    return chip;
  }

  function updateEstimate() {
    if (!E || !E.info) return;
    const sec = E.end - E.start;
    const kbps = App.kbps(E.target, sec, E.speed);
    const [label, color] = App.quality(kbps);
    const set = (id, v) => { const n = App.$("#" + id); if (n) n.textContent = v; };
    set("sumLen", App.fmtS(sec / E.speed));
    set("sumTarget", `→ ${E.target} MiB`);
    set("sumQ", label); set("sumKbps", `${kbps} kbps · ${E.res === "orig" ? E.info.height : E.res}p`);
    const q = App.$("#sumQ"); if (q) q.style.color = color;
    const m = App.$("#sumMeter");
    if (m) { m.style.width = `${Math.min(100, (kbps / 9000) * 100)}%`; m.style.background = color; }
  }

  async function doExport() {
    if (!E?.info || S.exporting) return;
    stop();
    const res = await App.Exports.run({
      path: E.clip.path, start: E.start, end: E.end >= E.info.duration - 0.01 ? null : E.end,
      target: E.target, maxHeight: E.res === "orig" ? null : parseInt(E.res, 10), codec: E.codec,
      speed: E.speed, wide: E.wide ? E.pan / 100 : null, normalize: E.norm,
      volumes: E.tracks.map((t) => [t.name, t.gain]),
    });
    if (res && E) { E.done = res; E.error = ""; }
    if (E) renderPanel();
  }
  Ed.doExport = doExport;
  Ed.onProgress = (pct) => {
    const bar = App.$("#edBar"), t = App.$("#edPct");
    if (bar) bar.style.width = `${pct}%`;
    if (t) t.textContent = `${Math.round(pct)}%`;
  };
  Ed.onExportState = () => { if (E && S.view === "ed") renderPanel(); };

  /* ───── keyboard ───── */

  Ed.key = (ev) => {
    if (!E) return false;
    const step = ev.shiftKey ? 5 : 1;
    switch (ev.key) {
      case " ": toggle(); return true;
      case "i": case "I": setIn(); return true;
      case "o": case "O": setOut(); return true;
      case "ArrowLeft": seek(video.currentTime - step); return true;
      case "ArrowRight": seek(video.currentTime + step); return true;
      case "j": case "J": Ed.step?.(1); return true;
      case "k": case "K": Ed.step?.(-1); return true;
      case "e": case "E": if (ev.ctrlKey) { doExport(); return true; } return false;
      default: return false;
    }
  };

  Ed.leave = () => stop();
  Ed.current = () => E;
})();
