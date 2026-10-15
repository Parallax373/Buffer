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
      target: App.P.settings.defTarget, wide: !!App.P.settings.cropDef, pan: App.P.settings.cropPan ?? 50, norm: App.P.settings.normDef,
      speed: 1, codec: App.P.settings.codecDef || "auto", res: App.P.settings.resDef || "orig", done: null, adv: false, v0: 0, v1: 0,
    };
    App.markSeen(path);
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
      const kept = (App.P.trims || {})[path];
      if (kept && kept.size === clip.size && kept.s >= 0 && kept.e <= info.duration + 0.05 && kept.e - kept.s >= MIN_SEL) {
        E.start = kept.s;
        E.end = Math.min(kept.e, info.duration);
      }
      E.v0 = 0;
      E.v1 = info.duration;
      video.src = api.src(path);
      video.load();
      // the playhead waits at the start of the kept selection, not at 0:00
      if (E.start > 0) {
        video.addEventListener("loadedmetadata", () => {
          if (token === loadToken && E) seek(E.start);
        }, { once: true });
      }
      if (!ctx) ctx = new AudioContext();
      E.tracks = info.audio.map((t, i) => makeTrack(t.name, files[i], i));
      renderAll();
      for (const t of E.tracks) {
        api.invoke("waveform", { path, index: t.index }).then((w) => {
          if (token !== loadToken) return;
          t.wave = w;
          // a silent track (nothing on it) gets no lane; the file keeps it, so exports are unchanged
          const empty = !w.some((v) => v > 1);
          if (empty !== !!t.empty) { t.empty = empty; renderLanes(); } else { drawLanes(); }
        }).catch(() => {});
      }
    } catch (e) {
      App.toast(App.t("ed.openFail", { err: e }), "err");
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
    const gain = App.clipGain(E.clip.path, name) / 100;
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
    if (zoomed()) {
      const t = video.currentTime, span = E.v1 - E.v0;
      if (t > E.v1 || t < E.v0) setView(t - span * 0.1, t - span * 0.1 + span);
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
      head: h("div", { class: "edhead" }),
      stage: h("div", { class: "stage" }),
      crop: h("div", { class: "crop", hidden: true }),
      big: h("div", { class: "big", onClick: toggle }),
      transport: h("div", { class: "transport" }),
      lanesWrap: h("div", { class: "tl" }),
      panel: h("div", { class: "expanel" }),
      kb: h("div", { class: "kbpop", hidden: true }, [
        [App.t("kb.play"), App.t("kb.space")], [App.t("kb.inout"), "I / O"], [App.t("kb.zoom"), App.t("kb.wheel")],
        [App.t("kb.step"), "← → / Shift"], [App.t("kb.frame"), ", / ."],
        [App.t("kb.clip"), "PgUp / PgDn"], [App.t("kb.export"), "Ctrl E"], [App.t("kb.search"), "Ctrl K"],
      ].map(([l, k]) => h("div", null, h("span", { text: l }), h("kbd", { text: k })))),
    };
    const box = h("div", { class: "box" }, video, ui.crop);
    ui.stage.append(box, ui.big);
    root.append(h("div", { class: "ed" },
      h("div", { class: "edmain" }, ui.head, ui.stage, ui.transport, ui.lanesWrap),
      ui.panel, ui.kb));
  }

  function renderAll() {
    renderHead(); renderTransport(); renderLanes(); renderPanel(); paintCrop();
  }

  const toggle = () => (video.paused ? play() : stop());


  function renderHead() {
    const list = App.Lib.visible();
    const i = list.findIndex((c) => c.path === E.clip.path);
    const step = (d) => { if (list.length) Ed.open(list[(i + d + list.length) % list.length].path); };
    Ed.step = step;
    const rename = (ev) => App.editTitle(ev.currentTarget.closest(".edhead").querySelector(".ttl"), E.clip.path, () => renderHead());
    ui.head.replaceChildren(
      h("div", { class: "hbox" },
        h("button", { class: "nv", onClick: () => step(-1), title: App.t("ed.prev"), text: "‹" }),
        h("button", { class: "nv", onClick: () => step(1), title: App.t("ed.next"), text: "›" })),
      h("span", { class: "gamechip", title: App.t("det.game") }, App.Lib.gameIcon(App.gameOf(E.clip)), App.gameOf(E.clip)),
      h("b", { class: "ttl" + (App.customTitle(E.clip) ? "" : " ph"), style: { fontSize: "16px" }, title: App.t("det.rename"),
        text: App.customTitle(E.clip) || App.whenOf(E.clip),
        onClick: (ev) => App.editTitle(ev.currentTarget, E.clip.path, () => renderHead()) }),
      h("button", { class: "ren hit", title: App.t("ed.renameBtn"), text: "✎", onClick: rename }),
      h("span", { class: "mono muted", style: { fontSize: "12px" }, text: App.baseName(E.clip.path) }),
      h("span", { class: "sp" }),
      h("button", { class: "revbtn", text: App.t("det.reveal"), onClick: () => api.invoke("reveal", { path: E.clip.path }) }),
      h("div", { class: "hbox" },
        h("button", { class: "qm", title: App.t("ed.shortcuts"), text: "?", onClick: () => ui.kb.hidden = !ui.kb.hidden }),
        h("button", { class: "fav" + (App.P.favs[E.clip.path] ? " on" : ""), id: "edFav",
          onClick: () => App.Lib.toggleFav(E.clip.path), text: App.P.favs[E.clip.path] ? "★" : "☆" })));
  }
  Ed.refreshFav = () => { if (E) renderHead(); };

  function renderTransport() {
    if (!E) return;
    ui.big.replaceChildren(E.playing ? "" : h("span", { text: "▶" }));
    ui.area?.classList.toggle("playing", E.playing);
    const dur = E.info ? E.info.duration : 0;
    ui.transport.replaceChildren(
      h("span", { class: "time", id: "edTime", text: `${App.fmt(video.currentTime)} / ${App.fmt(dur)}` }),
      h("div", { class: "tbox" },
        h("button", { title: App.t("ed.back1s"), text: "−1s", onClick: () => stepSec(-1) }),
        h("button", { title: App.t("ed.backFrame"), text: "◂", onClick: () => stepFrame(-1) }),
        h("button", { class: "play", onClick: toggle, text: E.playing ? "❚❚" : "▶" }),
        h("button", { title: App.t("ed.fwdFrame"), text: "▸", onClick: () => stepFrame(1) }),
        h("button", { title: App.t("ed.fwd1s"), text: "+1s", onClick: () => stepSec(1) })),
      h("div", { class: "tright" },
        h("button", { class: "mk", onClick: setIn }, App.t("ed.in") + " ", h("b", { text: "I" })),
        h("button", { class: "mk", onClick: setOut }, App.t("ed.out") + " ", h("b", { text: "O" })),
        h("span", { class: "sel", id: "edSel", text: App.t("ed.selected", { t: App.fmtS(E.end - E.start) }) }),
        h("span", { class: "zoomctl" },
          h("button", { title: App.t("ed.zoomOut"), text: "−", onClick: () => zoomAt(1 / 1.6, video.currentTime) }),
          h("button", { title: App.t("ed.zoomIn"), text: "+", onClick: () => zoomAt(1.6, video.currentTime) }),
          h("button", { title: App.t("ed.fit"), text: "↔", onClick: fitView }))));
  }

  /** One frame back/forward from the exact current frame (pauses playback). */
  function stepFrame(dir) {
    if (!E?.info) return;
    stop();
    const fps = E.info.fps > 0 ? E.info.fps : 30;
    seek((Math.round(video.currentTime * fps) + dir) / fps);
  }
  function stepSec(dir) { seek(video.currentTime + dir); }

  function setIn() { if (E?.info) { E.start = Math.min(video.currentTime, E.end - MIN_SEL); layoutSel(); } }
  function setOut() { if (E?.info) { E.end = Math.max(video.currentTime, E.start + MIN_SEL); layoutSel(); } }

  /* ───── timeline lanes ───── */

  function renderLanes() {
    const dur = E.info ? E.info.duration : 0;
    const shown = E.tracks.filter((t) => !t.empty);
    const names = E.tracks.length ? (shown.length ? shown : E.tracks) : ["Game", "Chat", "Mic"].map((n) => ({ name: n, gain: App.clipGain(E.clip.path, n) / 100 }));
    const labels = h("div", { class: "labels" }, h("div", { style: { height: "20px" } }),
      h("div", { class: "lane-l", style: { color: "var(--muted)", justifyContent: "center", flexDirection: "row", alignItems: "center" } }, App.t("ed.lane")));
    const area = h("div", { class: "area" });
    ui.area = area;
    const ruler = h("div", { class: "ruler" });
    ui.ticks = h("div", { class: "ticks" });
    ruler.append(ui.ticks);
    area.append(ruler, h("div", { class: "lane" }));
    ui.canvases = [];
    for (const t of names) {
      const hex = TRACK_COLORS[t.name] || "var(--muted)";
      const val = h("span", { text: `${Math.round(t.gain * 100)}%` });
      const slider = h("input", { type: "range", min: 0, max: 200, step: 5, value: Math.round(t.gain * 100),
        style: { accentColor: hex },
        onInput: (e) => {
          t.gain = e.target.value / 100;
          if (t.node) t.node.gain.value = t.gain;
          App.setClipGain(E.clip.path, t.name, +e.target.value);
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
    ui.pan = h("div", { class: "panbar", hidden: true }, h("i"));
    ui.frames = h("div", { class: "fgrid", hidden: true });
    area.append(ui.frames, ui.pan, ui.dimL, ui.dimR, ui.selbox, ui.hIn, ui.hOut, ui.head_);
    bindTimeline(area);
    renderTicks();
    requestAnimationFrame(paintFrames);
    ui.lanesWrap.replaceChildren(labels, area);
    layoutSel();
    requestAnimationFrame(drawLanes);
  }

  /* The timeline shows the window [v0, v1] of the clip; everything is positioned relative to it. */
  const MIN_SPAN = 0.5;
  const pct = (t) => (E?.info ? ((t - E.v0) / (E.v1 - E.v0)) * 100 : 0);
  const clampPct = (p) => Math.max(0, Math.min(100, p));
  const zoomed = () => E?.info && E.v1 - E.v0 < E.info.duration - 0.01;

  function applyView() {
    layoutSel();
    renderTicks();
    paintPan();
    paintFrames();
  }

  /** With the frame grid on screen, positions snap to whole frames. */
  function gridOn() { return !!ui.frames && !ui.frames.hidden; }
  function snapFrame(t) {
    if (!gridOn()) return t;
    const fps = E.info.fps > 0 ? E.info.fps : 30;
    return Math.round(t * fps) / fps;
  }

  /** Close to the maximum zoom every frame gets a hairline (a stronger one on each whole second). */
  function paintFrames() {
    if (!ui.frames || !ui.area || !E?.info) return;
    const fps = E.info.fps > 0 ? E.info.fps : 30;
    const span = E.v1 - E.v0, w = ui.area.clientWidth;
    const px = span > 0 ? w / (span * fps) : 0;
    ui.frames.hidden = !(px >= 6);
    if (ui.frames.hidden) return;
    const off = -((E.v0 * fps) % 1) * px;
    const sec = px * fps, offSec = -((E.v0 % 1) * sec);
    ui.frames.style.backgroundSize = `${px}px 100%, ${sec}px 100%`;
    ui.frames.style.backgroundPosition = `${off}px 0, ${offSec}px 0`;
  }

  function setView(v0, v1) {
    const dur = E.info.duration;
    let span = Math.min(Math.max(v1 - v0, Math.min(MIN_SPAN, dur)), dur);
    v0 = Math.min(Math.max(v0, 0), dur - span);
    E.v0 = v0;
    E.v1 = v0 + span;
    applyView();
  }

  function zoomAt(factor, anchor) {
    if (!E?.info) return;
    const span = E.v1 - E.v0;
    const next = Math.min(Math.max(span / factor, Math.min(MIN_SPAN, E.info.duration)), E.info.duration);
    const frac = span > 0 ? (anchor - E.v0) / span : 0.5;
    const a = Math.min(Math.max(frac, 0), 1);
    setView(anchor - a * next, anchor - a * next + next);
  }

  function fitView() { if (E?.info) setView(0, E.info.duration); }

  function renderTicks() {
    if (!ui.ticks || !E?.info) return;
    const span = E.v1 - E.v0;
    const fmt = span < 20 ? App.fmt : App.fmtS;
    ui.ticks.replaceChildren(...Array.from({ length: 7 }, (_, i) => h("span", { text: fmt(E.v0 + (span * i) / 6),
      style: { left: `${(i / 6) * 100}%`, transform: i === 0 ? "none" : i === 6 ? "translateX(-100%)" : "translateX(-50%)" } })));
  }

  function paintPan() {
    if (!ui.pan || !E?.info) return;
    ui.pan.hidden = !zoomed();
    const dur = E.info.duration;
    const th = ui.pan.firstChild;
    th.style.left = `${(E.v0 / dur) * 100}%`;
    th.style.width = `${((E.v1 - E.v0) / dur) * 100}%`;
  }

  /** Keeps this clip's start/end across closing and reopening it (cleared again when the full clip is selected). */
  function rememberTrim() {
    if (!E || !E.info) return;
    const trims = (App.P.trims ||= {});
    const full = E.start < 0.01 && E.end > E.info.duration - 0.01;
    const was = trims[E.clip.path];
    if (full) {
      if (was) { delete trims[E.clip.path]; App.persist(); }
      return;
    }
    const s = +E.start.toFixed(2), e = +E.end.toFixed(2);
    if (!was || was.s !== s || was.e !== e) {
      trims[E.clip.path] = { s, e, size: E.clip.size };
      App.persist();
    }
  }

  function layoutSel() {
    if (!E || !ui.selbox) return;
    rememberTrim();
    const p0 = pct(E.start), p1 = pct(E.end);
    const c0 = clampPct(p0), c1 = clampPct(p1);
    ui.dimL.style.width = `${c0}%`;
    ui.dimR.style.width = `${100 - c1}%`;
    ui.selbox.style.left = `${c0}%`;
    ui.selbox.style.width = `${Math.max(0, c1 - c0)}%`;
    ui.hIn.style.left = `${p0}%`;
    ui.hOut.style.left = `${p1}%`;
    ui.hIn.hidden = p0 < -0.3 || p0 > 100.3;
    ui.hOut.hidden = p1 < -0.3 || p1 > 100.3;
    const sel = App.$("#edSel");
    if (sel) sel.textContent = App.t("ed.selected", { t: App.fmtS(E.end - E.start) });
    updateEstimate();
    drawLanes();
    paintHead();
  }

  function paintHead() {
    if (!E?.info || !ui.head_) return;
    const p = pct(video.currentTime);
    ui.head_.style.left = `${p}%`;
    ui.head_.hidden = p < 0 || p > 100;
    const t = App.$("#edTime");
    if (t) t.textContent = `${App.fmt(video.currentTime)} / ${App.fmt(E.info.duration)}`;
  }

  function drawLanes() {
    if (!E || !ui.canvases || !E.info) return;
    const dur = E.info.duration;
    const BPS = 50;                                   // bars per second in the waveform data
    const span = E.v1 - E.v0;
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
      g.fillStyle = TRACK_HEX[track.name] || "#8b919c";
      const scale = track.gain > 1 ? 1 : 0.4 + track.gain / 1.7;
      const col = 3;                                  // 2 px bar + 1 px gap
      for (let x = 0; x < w; x += col) {
        const t0 = E.v0 + (x / w) * span, t1 = E.v0 + ((x + col) / w) * span;
        if (t1 <= 0 || t0 >= dur) continue;
        const i0 = Math.max(0, Math.floor(t0 * BPS));
        const i1 = Math.min(bars.length - 1, Math.max(i0, Math.ceil(t1 * BPS) - 1));
        let m = 0;
        for (let i = i0; i <= i1; i++) if (bars[i] > m) m = bars[i];
        g.globalAlpha = t1 >= E.start && t0 <= E.end ? 0.95 : 0.35;
        const bh = Math.max(1.5, (m / 100) * (hgt - 8) * scale);
        g.fillRect(x + 0.5, (hgt - bh) / 2, col - 1, bh);
      }
    }
    if (ui.canvases[0]) ui.canvases[0].cv.dataset.ready = "1";
  }
  window.addEventListener("resize", () => { if (App.S.view === "ed") { drawLanes(); paintFrames(); } });

  function bindTimeline(area) {
    const timeAt = (ev) => {
      const r = area.getBoundingClientRect();
      const f = Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1);
      return E.v0 + f * (E.v1 - E.v0);
    };
    // press and drag scrubs the playhead; the pointer is captured so the drag may leave the lanes
    area.addEventListener("pointerdown", (ev) => {
      if (!E?.info || ev.button !== 0) return;
      ev.preventDefault();
      seek(snapFrame(timeAt(ev)));
      area.setPointerCapture(ev.pointerId);
      const move = (e) => seek(snapFrame(timeAt(e)));
      const up = () => {
        area.removeEventListener("pointermove", move);
        area.removeEventListener("pointerup", up);
        area.removeEventListener("pointercancel", up);
      };
      area.addEventListener("pointermove", move);
      area.addEventListener("pointerup", up);
      area.addEventListener("pointercancel", up);
    });
    // wheel zooms around the cursor; Shift/Alt (or a sideways wheel) pans
    area.addEventListener("wheel", (ev) => {
      if (!E?.info) return;
      ev.preventDefault();
      const span = E.v1 - E.v0;
      if (ev.shiftKey || ev.altKey || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
        const d = (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY) / 600;
        setView(E.v0 + d * span, E.v1 + d * span);
      } else {
        zoomAt(ev.deltaY < 0 ? 1.3 : 1 / 1.3, timeAt(ev));
      }
    }, { passive: false });
    // the thin bar under the lanes pans the zoomed view
    ui.pan.addEventListener("pointerdown", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      const r = ui.pan.getBoundingClientRect();
      const dur = E.info.duration, span = E.v1 - E.v0;
      const grab = ((ev.clientX - r.left) / r.width) * dur;
      const offset = grab >= E.v0 && grab <= E.v1 ? grab - E.v0 : span / 2;
      const move = (e) => {
        const t = ((e.clientX - r.left) / r.width) * dur;
        setView(t - offset, t - offset + span);
      };
      move(ev);
      const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    const drag = (node, apply) => {
      node.addEventListener("pointerdown", (ev) => {
        if (!E?.info) return;
        ev.stopPropagation();
        node.setPointerCapture(ev.pointerId);
        // within ~10 px of the playhead or either end of the clip the handle snaps (hold Alt to place it freely)
        const snap = (t, e) => {
          if (e.altKey) return t;
          const tol = (10 / area.getBoundingClientRect().width) * (E.v1 - E.v0);
          for (const m of [video.currentTime, 0, E.info.duration]) if (Math.abs(t - m) <= tol) return m;
          return snapFrame(t);
        };
        const move = (e) => { apply(snap(timeAt(e), e)); layoutSel(); };
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
    const presets = App.presets();
    const seg = (items, cur, on) => h("div", { class: "seg" }, items.map(([label, v]) =>
      h("button", { class: String(cur) === String(v) ? "on" : "", text: label, onClick: () => on(v) })));
    const tog = (label, key, extra) => h("div", { class: "opt", style: { cursor: "pointer" },
      onClick: () => {
        E[key] = !E[key];
        // normalize and the 16:9 crop are saved as the defaults for every clip
        const s = App.P.settings;
        if (key === "norm") s.normDef = E.norm;
        if (key === "wide") s.cropDef = E.wide;
        App.persist();
        renderPanel(); paintCrop(); updateEstimate();
      } },
      h("span", { text: label }), h("span", { class: "toggle" + (E[key] ? " on" : "") }));

    const sum = h("div", { class: "sumcard", title: App.t("ed.qualityTip") },
      h("div", { class: "r1" }, h("span", { class: "big", id: "sumLen" }), h("span", { class: "mono muted", id: "sumTarget", style: { fontSize: "12px" } })),
      h("div", { class: "meter" }, h("div", { id: "sumMeter" })),
      h("div", { class: "r3" }, h("span", { id: "sumQ" }), h("span", { id: "sumKbps" })));

    const exporting = S.exporting && S.exporting.source === E.clip.path;
    const items = [
      h("div", { class: "cap", text: App.t("exp.cap") }),
      h("div", { class: "presets" }, presets.map((mb) =>
        h("button", { class: E.target === mb ? "on" : "", onClick: () => { E.target = mb; renderPanel(); updateEstimate(); } },
          App.presetName(mb) || `${mb} MB`, App.presetName(mb) ? h("br") : null, App.presetName(mb) ? h("small", { text: `${mb} MB` }) : null))),
      sum,
      h("div", { class: "opts" },
        h("div", { class: "opt", style: { cursor: "pointer" }, onClick: () => { E.custom = !E.custom; renderPanel(); } },
          h("span", { text: App.t("ed.custom") }), h("span", { class: "muted", text: E.custom ? "\u25B4" : "\u25BE" })),
        E.custom ? customSize() : null,
        tog(App.t("ed.crop"), "wide"),
        E.wide ? h("div", { class: "opt" }, h("span", { text: App.t("ed.cropPos") }),
          h("input", { type: "range", min: 0, max: 100, value: E.pan, style: { width: "130px" },
            onInput: (ev) => { E.pan = +ev.target.value; paintCrop(); },
            onChange: () => { App.P.settings.cropPan = E.pan; App.persist(); } })) : null,
        tog(App.t("ed.norm"), "norm"),
        h("div", { class: "opt", style: { cursor: "pointer" }, onClick: () => { E.adv = !E.adv; renderPanel(); } },
          h("span", { text: App.t("adv.cap") }), h("span", { class: "muted", text: E.adv ? "▴" : "▾" })),
        ...(E.adv ? [
          h("div", { class: "opt" }, h("span", { text: App.t("ed.res") }),
            h("select", { class: "field", onChange: (ev) => { E.res = ev.target.value; App.P.settings.resDef = E.res; App.persist(); updateEstimate(); } },
              [["orig", App.t("ed.resOrig")], ["1080", "1080p"], ["720", "720p"], ["540", "540p"]]
                .map(([v, t]) => h("option", { value: v, text: t, selected: E.res === v })))),
          h("div", { class: "opt" }, h("span", { text: App.t("ed.codec") }),
            h("select", { class: "field", onChange: (ev) => { E.codec = ev.target.value; App.P.settings.codecDef = E.codec; App.persist(); } },
              [["auto", App.t("ed.codecAuto")], ["hevc-nvenc", "HEVC NVENC"], ["x264", "H.264 CPU"]]
                .map(([v, t]) => h("option", { value: v, text: t, selected: E.codec === v })))),
          h("div", { class: "opt" }, h("span", { text: App.t("ed.speed") }),
            seg([["0.5×", 0.5], ["1×", 1], ["1.5×", 1.5], ["2×", 2]], E.speed, (v) => {
              E.speed = v; video.playbackRate = v;
              for (const t of E.tracks) t.el.playbackRate = v;
              renderPanel(); updateEstimate();
            })),
        ] : [])),
      h("div", { class: "sp" }),

      E.error ? h("div", { class: "errmsg", text: E.error }) : null,
      h("button", { class: "btn acc", style: { padding: "12px", opacity: exporting ? 0.5 : 1 }, disabled: !!S.exporting || !E.info,
        onClick: doExport, text: exporting ? App.t("ed.exporting") : E.done ? App.t("ed.again") : App.t("ed.export") })];
    P.replaceChildren(...items.filter(Boolean));   // append(null) would render the text "null"
    updateEstimate();
  }


  /** One-off export size: a log-scale slider (1 to 2000 MB) and a number field, kept in sync. */
  function customSize() {
    const LOG = Math.log(2000);
    const toPos = (mb) => Math.round((Math.log(Math.max(1, mb)) / LOG) * 1000);
    const fromPos = (p) => Math.max(1, Math.round(Math.exp((p / 1000) * LOG)));
    const num = h("input", { class: "field monoin", type: "number", min: 1, max: 2000, step: 1, value: E.target,
      onChange: (ev) => {
        E.target = Math.min(2000, Math.max(1, Math.round(+ev.target.value) || E.target));
        renderPanel(); updateEstimate();
      } });
    const slider = h("input", { type: "range", min: 0, max: 1000, value: toPos(E.target), style: { flex: 1, minWidth: "60px" },
      onInput: (ev) => { E.target = fromPos(+ev.target.value); num.value = E.target; updateEstimate(); },
      onChange: () => renderPanel() });
    return h("div", { class: "opt customsz" }, slider, num, h("span", { class: "muted", text: "MB" }));
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
      case ",": stepFrame(-1); return true;
      case ".": stepFrame(1); return true;
      case "+": case "=": zoomAt(1.6, video.currentTime); return true;
      case "-": case "_": zoomAt(1 / 1.6, video.currentTime); return true;
      case "0": fitView(); return true;
      case "PageDown": Ed.step?.(1); return true;
      case "PageUp": Ed.step?.(-1); return true;
      case "e": case "E": if (ev.ctrlKey) { doExport(); return true; } return false;
      default: return false;
    }
  };

  Ed.leave = () => stop();
  Ed.current = () => E;
})();
