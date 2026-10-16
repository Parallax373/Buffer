"use strict";
/* Live EQ page (Sonar-like, laid out after FL Studio's Parametric EQ 2). Equalizer APO does the sound; the recorder
   owns the state (`eq-*` control commands) and this page only edits it. One canvas: zone strip, live spectrum, the
   summed response and seven numbered dots; on the right seven gain faders with FREQ / BW knobs. */

(function () {
  const { h, S, api } = App;
  const U = App.ui;

  const BANDS = 7;
  const COLORS = ["#9b7bff", "#e45ad8", "#f0664b", "#e8d23c", "#86dd5a", "#3fd0b0", "#4a90e8"];
  const KINDS = ["peak", "low_shelf", "high_shelf", "low_cut", "high_cut", "notch", "band_pass"];
  const HAS_GAIN = new Set(["peak", "low_shelf", "high_shelf"]);
  const PRESETS = ["flat", "gaming", "voice", "music"];
  const MIC_PRESETS = ["flat", "voice"];
  // like FL: seven bells, all on, all with a gain (same as crates/ml-eq/src/presets.rs FLAT)
  const FLAT = [50, 130, 330, 800, 2000, 5000, 12000].map((f) => ({ kind: "peak", f, gain: 0, q: 1, on: true }));
  const ZONES = [["SUB", 20, 60], ["BASS", 60, 250], ["LOW MID", 250, 500], ["MID", 500, 2000], ["HIGH MID", 2000, 4000], ["PRS", 4000, 6000], ["TREBLE", 6000, 20000]];
  const DB = 18, FMIN = 20, FMAX = 20000, FS = 48000;
  const DOT = 12;                // dot radius, px (FL's are about 24 px across)

  let st = null;                 // EqState from the recorder
  let apo = null;                // Equalizer APO status
  let devs = { render: [], capture: [], default: {} };
  let tab = "sys";               // "sys" | "mic"
  let device = "";               // endpoint id being edited on the System tab
  let sel = 0;                   // selected band
  let listen = false;
  let page = null, canvas = null, side = null, spectrum = null, specChan = null, specFor = "";
  let hover = -1, drag = null, raf = 0;
  // from eq-get: the game in front, exe -> display names, and (while a game preset plays) where and which bands
  let games = { stem: null, names: {}, on: null, bands: null };
  let viewOwn = false;           // while a game preset plays: show and edit my own EQ instead of what is heard
  const takeGames = (r) => {
    games = { stem: r.game_stem || null, names: r.game_names || {}, on: r.game_on || null, bands: r.game_bands || null };
    if (!gameActive()) viewOwn = false;
  };
  /** A game preset is playing on the device shown on the System tab. */
  const gameActive = () => !isMic() && !!games.on && games.on === device && Array.isArray(games.bands);
  /** The page shows (and locks) what the game preset plays, not my own EQ. */
  const viewingGame = () => gameActive() && !viewOwn;
  const shownBands = () => (viewingGame() ? games.bands : channel().bands);
  const gameTitle = (stem) => (games.names[stem] || (st.seen_games || {})[stem] || stem).replace(/-/g, " ");

  /** "Słuchawki (Arctis 5 Game)" -> "Arctis 5": the model inside the endpoint name, for a ready AutoEQ search. */
  function guessModel(name) {
    const m = name.match(/\(([^)]+)\)/);
    const s = (m ? m[1] : name)
      .replace(/\b(game|chat|headset|headphones?|speakers?|stereo|hands-?free|audio|high definition|nvidia|realtek|amd|intel|usb|wireless|output)\b/gi, " ")
      .replace(/\s+/g, " ").trim();
    return s.length >= 3 ? s : "";
  }

  /* ───── maths (same RBJ biquads as crates/ml-eq/src/curve.rs) ───── */

  function coeffs(b) {
    const w0 = (2 * Math.PI * Math.min(Math.max(b.f, 10), FS * 0.49)) / FS;
    const sin = Math.sin(w0), cos = Math.cos(w0), q = Math.max(b.q, 0.05), alpha = sin / (2 * q);
    const A = Math.pow(10, b.gain / 40);
    let c;
    switch (b.kind) {
      case "peak": c = [1 + alpha * A, -2 * cos, 1 - alpha * A, 1 + alpha / A, -2 * cos, 1 - alpha / A]; break;
      case "low_shelf": { const s = 2 * Math.sqrt(A) * alpha;
        c = [A * (A + 1 - (A - 1) * cos + s), 2 * A * (A - 1 - (A + 1) * cos), A * (A + 1 - (A - 1) * cos - s),
          A + 1 + (A - 1) * cos + s, -2 * (A - 1 + (A + 1) * cos), A + 1 + (A - 1) * cos - s]; break; }
      case "high_shelf": { const s = 2 * Math.sqrt(A) * alpha;
        c = [A * (A + 1 + (A - 1) * cos + s), -2 * A * (A - 1 + (A + 1) * cos), A * (A + 1 + (A - 1) * cos - s),
          A + 1 - (A - 1) * cos + s, 2 * (A - 1 - (A + 1) * cos), A + 1 - (A - 1) * cos - s]; break; }
      case "low_cut": c = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha]; break;
      case "high_cut": c = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha]; break;
      case "notch": c = [1, -2 * cos, 1, 1 + alpha, -2 * cos, 1 - alpha]; break;
      default: c = [alpha, 0, -alpha, 1 + alpha, -2 * cos, 1 - alpha];
    }
    return [c[0] / c[3], c[1] / c[3], c[2] / c[3], c[4] / c[3], c[5] / c[3]];
  }
  function bandDb(b, f, cf = coeffs(b)) {
    const [b0, b1, b2, a1, a2] = cf, w = (2 * Math.PI * f) / FS;
    const c1 = Math.cos(w), s1 = -Math.sin(w), c2 = Math.cos(2 * w), s2 = -Math.sin(2 * w);
    const num = Math.hypot(b0 + b1 * c1 + b2 * c2, b1 * s1 + b2 * s2);
    const den = Math.hypot(1 + a1 * c1 + a2 * c2, a1 * s1 + a2 * s2);
    return 20 * Math.log10(Math.max(num / den, 1e-9));
  }

  /* ───── state helpers ───── */

  const isMic = () => tab === "mic";
  const curDevice = () => (isMic() ? st.mic_device : device);
  function channel() {
    if (isMic()) return st.mic;
    if (!st.outputs[device]) st.outputs[device] = { enabled: true, preset: "flat", bands: structuredClone(FLAT), autoeq: null };
    return st.outputs[device];
  }
  const customPresets = () => st.user_presets.filter((p) => !PRESETS.includes(p.name));
  const presetLabel = (id) => (PRESETS.includes(id) ? App.t("eq.p." + id) : id || App.t("eq.custom"));
  const presetBands = (id) => {
    const u = st.user_presets.find((p) => p.name === id);
    return u ? structuredClone(u.bands) : null;
  };
  const fmtF = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)} kHz` : `${Math.round(f)} Hz`);
  const fmtG = (g) => `${g > 0 ? "+" : ""}${g.toFixed(1)} dB`;

  let pushTimer = 0, flushP = null, dirty = false, abHeld = false;   // abHeld: the A/B button is being held
  const busy = () => !!pushTimer || !!flushP || abHeld;
  /** Sends the whole state to the recorder (it writes eq.json + APO's file). During a drag it goes out at most every
   *  60 ms and never two at once, the newest state always wins. (A debounce would hold everything back until the mouse
   *  stops, so the sound would only change on release.) The promise resolves once nothing is left to send. */
  function push(now = false) {
    dirty = true;
    if (now) {
      clearTimeout(pushTimer); pushTimer = 0;
      return flush();
    }
    if (!pushTimer) pushTimer = setTimeout(() => { pushTimer = 0; flush(); }, 60);
    return Promise.resolve();
  }
  function flush() {
    if (flushP) return flushP;
    flushP = (async () => {
      while (dirty) {
        dirty = false;
        const r = await api.invoke("recorder_cmd", { cmd: "eq-set " + JSON.stringify(st) }).catch((e) => ({ ok: false, error: e }));
        if (r && r.ok === false) App.toast(App.t("eq.err", { err: r.error }), "err");
      }
    })().finally(() => { flushP = null; });
    return flushP;
  }
  /** Any edit means "I want to hear this": a first change switches the EQ on instead of doing nothing. */
  function ensureOn() {
    if (st.enabled) return;
    st.enabled = true;
    App.toast(App.t("eq.autoOn"), "ok");
  }

  /** The tray can change the state behind the page's back: take the recorder's copy whenever the page is idle,
   *  so an edit here never writes an old snapshot over it. */
  let lastSeen = "", lastGame = "";
  async function sync() {
    if (!st || drag || busy() || S.view !== "eq" || document.hidden) return;
    const r = await api.invoke("recorder_cmd", { cmd: "eq-get" }).catch(() => null);
    if (!r || !r.ok || drag || busy()) return;
    const raw = JSON.stringify(r.state);
    const gameRaw = JSON.stringify([r.game_stem, r.game_on, r.game_bands]);
    const gameChanged = gameRaw !== lastGame;
    lastGame = gameRaw;
    takeGames(r);
    if (raw !== lastSeen && raw !== JSON.stringify(st)) { st = r.state; paintAll(); }
    else if (gameChanged) paintAll();
    lastSeen = raw;
  }
  setInterval(sync, 2000);
  window.addEventListener("focus", sync);
  /** Editing while a preset is selected edits that preset: its bands are saved as you go (an edited built-in becomes an
   *  override under the same id, see "restore"), and every other device on the same preset follows. With no preset
   *  selected it is just my own EQ. */
  function touchPreset() {
    const ch = channel(), id = ch.preset;
    if (!id) return;
    // "Flat" is what every device starts on, not a preset anyone means to change: editing from it is just my own EQ.
    // (Otherwise the first edit on one device would rewrite "Flat" for the mic and every other output.)
    if (id === "flat") { ch.preset = ""; return; }
    const bands = structuredClone(ch.bands);
    const own = st.user_presets.find((p) => p.name === id);
    if (own) own.bands = bands; else st.user_presets.push({ name: id, bands });
    // devices on the same preset follow it, but outputs and the microphone stay apart
    for (const c of isMic() ? [] : Object.values(st.outputs)) if (c !== ch && c.preset === id) c.bands = structuredClone(bands);
  }
  const edited = () => { ensureOn(); touchPreset(); push(); paintAll(); };
  /** An edit made while dragging: everything is updated in place. Rebuilding the faders and knobs would destroy the
   *  element being dragged and end the drag. */
  function liveEdit() {
    const first = !st.enabled;                              // what the header and the "now" bar show changes once
    ensureOn(); touchPreset(); push();
    if (first) { paintHeader(); paintNow(); }
    syncSide(); redraw();
  }

  /* ───── canvas ───── */

  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const geo = () => {
    const r = canvas.getBoundingClientRect();
    return { w: r.width, h: r.height, top: 22, bottom: r.height - 18, left: 0, right: r.width - 30 };
  };
  const xOf = (g, f) => g.left + ((Math.log10(f) - Math.log10(FMIN)) / (Math.log10(FMAX) - Math.log10(FMIN))) * (g.right - g.left);
  const fOf = (g, x) => Math.pow(10, Math.log10(FMIN) + ((x - g.left) / (g.right - g.left)) * (Math.log10(FMAX) - Math.log10(FMIN)));
  const yOf = (g, db) => g.top + ((DB - db) / (2 * DB)) * (g.bottom - g.top);
  const dbOf = (g, y) => DB - ((y - g.top) / (g.bottom - g.top)) * 2 * DB;
  const dotY = (g, b) => yOf(g, HAS_GAIN.has(b.kind) ? b.gain : 0);

  function draw() {
    raf = 0;
    if (!canvas || !canvas.isConnected || !st) return;
    const dpr = window.devicePixelRatio || 1, g = geo();
    if (canvas.width !== Math.round(g.w * dpr) || canvas.height !== Math.round(g.h * dpr)) {
      canvas.width = Math.round(g.w * dpr); canvas.height = Math.round(g.h * dpr);
    }
    const c = canvas.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, g.w, g.h);
    const line = css("--line"), muted = css("--subtle"), acc = css("--acc");
    // zone strip
    c.font = "600 9.5px Instrument Sans, sans-serif";
    c.textAlign = "center";
    for (const [name, a, b] of ZONES) {
      const x0 = xOf(g, a), x1 = xOf(g, b);
      c.fillStyle = "#ffffff08"; c.fillRect(x0 + 1, 2, x1 - x0 - 2, 15);
      c.fillStyle = muted; c.fillText(name, (x0 + x1) / 2, 13);
    }
    // grid
    c.strokeStyle = line; c.lineWidth = 1; c.fillStyle = muted; c.textAlign = "left";
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = Math.round(xOf(g, f)) + 0.5;
      c.beginPath(); c.moveTo(x, g.top); c.lineTo(x, g.bottom); c.stroke();
      c.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 3, g.h - 5);
    }
    for (let d = -DB + 6; d < DB; d += 6) {
      const y = Math.round(yOf(g, d)) + 0.5;
      c.globalAlpha = d === 0 ? 1 : 0.55;
      c.beginPath(); c.moveTo(g.left, y); c.lineTo(g.right, y); c.stroke();
      c.globalAlpha = 1;
      c.fillText((d > 0 ? "+" : "") + d, g.right + 4, y + 3);
    }
    // live spectrum
    if (spectrum) {
      const n = spectrum.length;
      c.beginPath(); c.moveTo(g.left, g.bottom);
      for (let i = 0; i < n; i++) {
        const x = g.left + ((i + 0.5) / n) * (g.right - g.left);
        const y = g.bottom - (spectrum[i] / 255) * (g.bottom - g.top);
        c.lineTo(x, y);
      }
      c.lineTo(g.right, g.bottom); c.closePath();
      c.fillStyle = "#ffffff12"; c.fill();
      c.strokeStyle = "#ffffff30"; c.stroke();
    }
    const ch = channel();
    const on = st.enabled && ch.enabled;
    const locked = viewingGame();
    const bands = shownBands(), cfs = bands.map((b) => coeffs(b));
    // headphone correction (AutoEQ): its own dashed curve, and it is part of the white total below
    const af = ch.autoeq ? ch.autoeq.filters.filter((b) => b.on).map((b) => [b, coeffs(b)]) : [];
    if (af.length) {
      c.setLineDash([4, 4]); c.strokeStyle = "#ffffff40"; c.beginPath();
      for (let x = g.left; x <= g.right; x += 2) {
        const f = fOf(g, x); let d = 0;
        for (const [b, cf] of af) d += bandDb(b, f, cf);
        x === g.left ? c.moveTo(x, yOf(g, d)) : c.lineTo(x, yOf(g, d));
      }
      c.stroke(); c.setLineDash([]);
    }
    // while a game preset plays, my own EQ is the faint dashed line: not heard right now, but not lost
    if (locked) {
      const own = ch.bands.map((b) => [b, coeffs(b)]);
      c.setLineDash([2, 5]); c.strokeStyle = "#ffffff55"; c.beginPath();
      for (let x = g.left; x <= g.right; x += 2) {
        const f = fOf(g, x); let d = 0;
        for (const [b, cf] of af) d += bandDb(b, f, cf);
        for (const [b, cf] of own) if (b.on) d += bandDb(b, f, cf);
        const y = yOf(g, Math.max(-DB - 6, Math.min(DB + 6, d)));
        x === g.left ? c.moveTo(x, y) : c.lineTo(x, y);
      }
      c.stroke(); c.setLineDash([]);
    }
    // selected band's own shape
    const sb = locked ? null : bands[sel];
    if (sb && sb.on) {
      c.beginPath();
      for (let x = g.left; x <= g.right; x += 2) {
        const y = yOf(g, bandDb(sb, fOf(g, x), cfs[sel]));
        x === g.left ? c.moveTo(x, y) : c.lineTo(x, y);
      }
      c.lineTo(g.right, yOf(g, 0)); c.lineTo(g.left, yOf(g, 0)); c.closePath();
      c.fillStyle = COLORS[sel] + "22"; c.fill();
    }
    // summed response: what is actually played (headphone correction + the seven bands)
    c.beginPath();
    for (let x = g.left; x <= g.right; x += 1.5) {
      const f = fOf(g, x); let d = 0;
      for (const [b, cf] of af) d += bandDb(b, f, cf);
      for (let i = 0; i < BANDS; i++) if (bands[i].on) d += bandDb(bands[i], f, cfs[i]);
      const y = yOf(g, Math.max(-DB - 6, Math.min(DB + 6, d)));
      x === g.left ? c.moveTo(x, y) : c.lineTo(x, y);
    }
    c.lineWidth = 2.2; c.strokeStyle = on ? "#f2f4f7" : muted; c.stroke(); c.lineWidth = 1;
    // dots, sized and drawn like FL's: translucent band colour, a ring in the band colour, a white number
    c.font = "700 12.5px Instrument Sans, sans-serif"; c.textAlign = "center"; c.textBaseline = "middle";
    bands.forEach((b, i) => {
      const x = xOf(g, b.f), y = dotY(g, b), r = !locked && i === sel ? DOT + 1.5 : DOT;
      const hot = !locked && (i === sel || i === hover);
      c.globalAlpha = locked ? 0.6 : 1;
      c.beginPath(); c.arc(x, y, r, 0, 2 * Math.PI);
      // a band that is off stays in its own colour (hollow), so it reads as "off, touch to switch on", not as locked
      c.fillStyle = b.on ? COLORS[i] + (hot && i === sel ? "cc" : "88") : COLORS[i] + "26"; c.fill();
      c.lineWidth = hot && i === sel ? 2.5 : 2; c.strokeStyle = hot ? "#ffffff" : b.on ? COLORS[i] : COLORS[i] + "99"; c.stroke();
      c.lineWidth = 3; c.strokeStyle = "#0008"; c.strokeText(String(i + 1), x, y + 0.5);
      c.fillStyle = b.on ? "#ffffff" : COLORS[i]; c.fillText(String(i + 1), x, y + 0.5);
      c.lineWidth = 1; c.globalAlpha = 1;
    });
    c.textBaseline = "alphabetic";
    // readout of the dot under the pointer / being dragged
    const ri = locked ? -1 : drag ? drag.i : hover;
    if (ri >= 0) {
      const b = bands[ri], x = xOf(g, b.f), y = dotY(g, b);
      const txt = `${fmtF(b.f)}${HAS_GAIN.has(b.kind) ? " · " + fmtG(b.gain) : ""} · Q ${b.q.toFixed(2)}${drag && drag.solo ? " · SOLO" : ""}`;
      c.font = "500 11px JetBrains Mono, monospace";
      const w = c.measureText(txt).width + 14, bx = Math.min(Math.max(x - w / 2, 4), g.right - w), by = y > 60 ? y - 38 : y + 18;
      c.fillStyle = css("--raised"); c.strokeStyle = drag && drag.solo ? acc : line;
      c.beginPath(); c.roundRect(bx, by, w, 20, 6); c.fill(); c.stroke();
      c.fillStyle = css("--text"); c.textAlign = "left"; c.fillText(txt, bx + 7, by + 14);
    }
  }
  const redraw = () => { if (!raf) raf = requestAnimationFrame(draw); };

  function hit(e) {
    const g = geo(), r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = -1, bd = (DOT + 5) * (DOT + 5);
    channel().bands.forEach((b, i) => {
      const d = (xOf(g, b.f) - x) ** 2 + (dotY(g, b) - y) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    return { i: best, x, y, g };
  }

  let soloTimer = 0, blurBound = false, endDrag = () => {};
  function solo(on, b) {
    const cmd = on ? `eq-solo ${curDevice()} ${b.f.toFixed(1)} ${Math.max(b.q, 0.7).toFixed(3)}` : "eq-solo off";
    api.invoke("recorder_cmd", { cmd }).catch(() => {});
    clearInterval(soloTimer);
    // a held, motionless band sends nothing: the recorder would take that for a lost page and drop the solo (~2.5 s)
    if (on) soloTimer = setInterval(() => { const cur = drag && channel().bands[drag.i]; if (cur) solo(true, cur); else clearInterval(soloTimer); }, 800);
  }

  function bindCanvas() {
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || viewingGame()) return;
      const { i, g } = hit(e);
      if (i < 0) return;
      const b = channel().bands[i];
      sel = i;
      if (!b.on) { b.on = true; edited(); }
      drag = { i, g, solo: e.altKey, fine: e.shiftKey, x0: e.clientX, y0: e.clientY, f0: b.f, g0: b.gain, q0: b.q };
      canvas.setPointerCapture(e.pointerId);
      if (drag.solo) solo(true, b);
      paintSide(); redraw();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (viewingGame()) return;
      if (!drag) {
        const { i } = hit(e);
        if (i !== hover) { hover = i; canvas.style.cursor = i >= 0 ? "grab" : ""; redraw(); }
        return;
      }
      const b = channel().bands[drag.i], k = e.shiftKey ? 0.2 : 1, g = drag.g;
      const x = xOf(g, drag.f0) + (e.clientX - drag.x0) * k;
      b.f = Math.round(Math.min(Math.max(fOf(g, x), FMIN), FMAX));
      if (HAS_GAIN.has(b.kind)) {
        const y = yOf(g, drag.g0) + (e.clientY - drag.y0) * k;
        b.gain = Math.round(Math.min(Math.max(dbOf(g, y), -DB), DB) * 10) / 10;
      } else {
        // cuts, notch and band pass have no gain: dragging up/down changes the width (Q) instead, so the dot is not stuck
        const dy = (drag.y0 - e.clientY) * k;
        b.q = Math.round(Math.min(Math.max(drag.q0 * Math.pow(2, dy / 60), 0.1), 18) * 1000) / 1000;
      }
      if (drag.solo) solo(true, b);
      liveEdit();
    });
    const end = endDrag = () => { if (drag && drag.solo) solo(false); drag = null; redraw(); };
    if (!blurBound) { blurBound = true; window.addEventListener("blur", () => { if (drag) endDrag(); }); }   // Alt+Tab mid-drag must not leave the solo on
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("pointerleave", () => { if (!drag && hover >= 0) { hover = -1; redraw(); } });
    canvas.addEventListener("wheel", (e) => {
      if (viewingGame()) return;
      const { i } = hit(e);
      const idx = i >= 0 ? i : sel;
      const b = channel().bands[idx];
      e.preventDefault();
      b.q = Math.round(Math.min(Math.max(b.q * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.1), 18) * 1000) / 1000;
      sel = idx; liveEdit();
    }, { passive: false });
    canvas.addEventListener("dblclick", (e) => {
      if (viewingGame()) return;
      const { i } = hit(e);
      if (i < 0) return;
      channel().bands[i] = structuredClone(FLAT[i]);
      channel().bands[i].on = true;
      edited();
    });
    canvas.addEventListener("contextmenu", (e) => {
      if (viewingGame()) return;
      const { i } = hit(e);
      e.preventDefault();
      if (i < 0) return;
      sel = i;
      shapeMenu(e.clientX, e.clientY, i);
      paintAll();
    });
  }

  function resetBand(i) { channel().bands[i] = structuredClone(FLAT[i]); edited(); }

  function shapeMenu(x, y, i) {
    const b = channel().bands[i];
    const close = () => { menu.remove(); document.removeEventListener("pointerdown", away, true); };
    const away = (e) => { if (!menu.contains(e.target)) close(); };
    const menu = h("div", { class: "eqmenu", style: { left: `${x}px`, top: `${y}px` } },
      KINDS.map((k) => h("button", { class: b.kind === k ? "on" : "", onClick: () => {
        b.kind = k;
        if (!HAS_GAIN.has(k)) b.gain = 0;
        if (k === "low_cut" || k === "high_cut") b.q = 0.707;
        b.on = true; close(); edited();
      } }, h("i", { class: "shape s-" + k }), App.t("eq.k." + k))),
      h("hr"),
      h("button", { onClick: () => { b.on = !b.on; close(); edited(); } }, App.t(b.on ? "eq.bandOff" : "eq.bandOn")),
      h("button", { onClick: () => { close(); resetBand(i); } }, App.t("eq.resetBand")));
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    if (r.right > innerWidth - 8) menu.style.left = `${innerWidth - r.width - 8}px`;
    if (r.bottom > innerHeight - 8) menu.style.top = `${innerHeight - r.height - 8}px`;
    setTimeout(() => document.addEventListener("pointerdown", away, true));
  }

  /* ───── right column: faders + FREQ / BW knobs ───── */

  /** Vertical drag on a knob; `get`/`set` work in 0..1. */
  function knob(color, value, set, tip) {
    const el = h("div", { class: "knob", title: tip });
    const paint = (v) => { el.style.setProperty("--v", String(v)); el.style.setProperty("--c", color); };
    paint(value);
    el.paint = (v) => { value = v; paint(v); };                // also moves the value a later drag starts from
    el.addEventListener("pointerdown", (e) => {
      const y0 = e.clientY, v0 = value;
      el.setPointerCapture(e.pointerId);
      const mv = (ev) => { value = Math.min(1, Math.max(0, v0 + (y0 - ev.clientY) / (ev.shiftKey ? 600 : 150))); paint(value); set(value); };
      const up = () => { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); };
      el.addEventListener("pointermove", mv);
      el.addEventListener("pointerup", up);
    });
    return el;
  }
  const fTo01 = (f) => (Math.log10(f) - Math.log10(FMIN)) / (Math.log10(FMAX) - Math.log10(FMIN));
  const f01 = (v) => Math.round(Math.pow(10, Math.log10(FMIN) + v * (Math.log10(FMAX) - Math.log10(FMIN))));
  const qTo01 = (q) => Math.log(q / 0.1) / Math.log(180);
  const q01 = (v) => Math.round(0.1 * Math.pow(180, v) * 1000) / 1000;

  let strips = [];
  function paintSide() {
    if (!side) return;
    const bands = shownBands();
    side.classList.toggle("locked", viewingGame());
    strips = [];
    side.replaceChildren(...bands.map((b, i) => {
      const fader = h("input", { type: "range", class: "fader", min: -DB, max: DB, step: 0.1, value: b.gain, disabled: !HAS_GAIN.has(b.kind),
        title: App.t("eq.gainTip"),
        onInput: (e) => { b.gain = +e.target.value; b.on = true; sel = i; liveEdit(); },
        onDblclick: () => { b.gain = 0; edited(); } });
      fader.style.setProperty("--c", COLORS[i]);           // custom properties don't go through Object.assign
      const kf = knob(COLORS[i], fTo01(b.f), (v) => { b.f = f01(v); sel = i; liveEdit(); }, App.t("eq.freq"));
      const kq = knob(COLORS[i], qTo01(b.q), (v) => { b.q = q01(v); sel = i; liveEdit(); }, App.t("eq.bw"));
      const strip = h("div", { class: "strip" + (i === sel ? " on" : "") + (b.on ? "" : " off"), onPointerdown: () => selectStrip(i) },
        h("button", { class: "num", style: { background: COLORS[i] }, text: String(i + 1), title: App.t("eq.k." + b.kind),
          onClick: (e) => shapeMenu(e.clientX, e.clientY, i) }),
        h("div", { class: "fwrap" }, fader), kf, kq);
      strips.push({ strip, fader, kf, kq });
      return strip;
    }),
    h("div", { class: "legend" }, h("span", { text: "FREQ" }), h("span", { text: "BW" })));
    sizeFaders();
  }
  /** Brings the faders and knobs in line with the bands without rebuilding them (used while something is dragged). */
  function syncSide() {
    const bands = shownBands();
    strips.forEach(({ strip, fader, kf, kq }, i) => {
      const b = bands[i];
      if (!b) return;
      if (+fader.value !== b.gain) fader.value = b.gain;
      fader.disabled = !HAS_GAIN.has(b.kind);
      kf.paint(fTo01(b.f)); kq.paint(qTo01(b.q));
      strip.classList.toggle("on", i === sel);
      strip.classList.toggle("off", !b.on);
    });
  }
  function selectStrip(i) { if (sel !== i) { sel = i; syncSide(); redraw(); } }
  /** The faders are rotated range inputs: their length follows the column height. */
  const sizeFaders = () => requestAnimationFrame(() => {
    if (!side) return;
    side.querySelectorAll(".fwrap").forEach((f) => f.firstChild.style.setProperty("--len", `${Math.max(80, f.clientHeight)}px`));
    // the folded panel animates its width from/to this (a plain "auto" can't be animated)
    if (side.parentNode) side.parentNode.style.setProperty("--sw", `${side.scrollWidth}px`);
  });

  /* ───── header, presets, AutoEQ, game presets ───── */

  const header = h("div", { class: "eqhead" });
  const below = h("div", { class: "eqbelow" });

  /** Presets are the one-click path, so they sit in plain sight (no dropdown). */
  function presetChips() {
    const ch = channel();
    // "Footsteps" and "Music" shape game and music sound: the microphone only gets the ones that make sense for a voice
    const builtin = isMic() ? PRESETS.filter((id) => MIC_PRESETS.includes(id)) : PRESETS;
    const all = [...builtin.map((id) => [id, presetLabel(id)]), ...customPresets().map((p) => [p.name, p.name])];
    const pick = async (id) => {
      ensureOn();
      if (PRESETS.includes(id)) {
        await push(true);
        await api.invoke("recorder_cmd", { cmd: `eq-preset ${curDevice()} ${id}` }).catch(() => {});
        reload();
      } else {
        ch.bands = presetBands(id); ch.preset = id; push(true); paintAll();
      }
    };
    const seg = U.segc(all, ch.preset, pick);
    seg.title = App.t("eq.presetTip");
    seg.classList.add("eqpresets");
    return seg;
  }

  /** A/B: held = this device without the EQ, released = back. A toggle could be forgotten in the "off" side. */
  function compareButton(ch) {
    const b = h("button", { class: "btn sm cmp" + (ch.enabled ? "" : " on"), text: "A/B", title: App.t("eq.compareTip") });
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || abHeld) return;
      // The channel is looked up again on release, by device: while the button is held the page may take a fresh
      // copy of the state (and redraw the header), and a captured object or element would then be a stale one.
      const key = { mic: isMic(), dev: curDevice() };
      const target = () => (key.mic ? st.mic : st.outputs[key.dev]);
      const apply = (on) => {
        const c = target();
        if (c) c.enabled = on;
        document.querySelector(".cmp")?.classList.toggle("on", !on);
        push(true); paintNow(); redraw();
      };
      abHeld = true;
      apply(false);
      const release = () => {
        window.removeEventListener("pointerup", release, true);
        window.removeEventListener("pointercancel", release, true);
        window.removeEventListener("blur", release);
        abHeld = false;
        apply(true);
      };
      window.addEventListener("pointerup", release, true);
      window.addEventListener("pointercancel", release, true);
      window.addEventListener("blur", release);
    });
    return b;
  }

  function savePreset() {
    const input = h("input", { class: "field", placeholder: App.t("eq.presetName"), maxLength: 32 });
    let finished = false;
    const done = (ok) => {
      if (finished) return;                      // Enter, Escape and blur can all arrive for one input
      finished = true;
      const name = input.value.trim();
      if (ok && name && !PRESETS.includes(name)) {
        st.user_presets = st.user_presets.filter((p) => p.name !== name);
        st.user_presets.push({ name, bands: structuredClone(channel().bands) });
        channel().preset = name;
        push(true);
      }
      paintHeader();
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); });
    input.addEventListener("blur", () => done(true));
    return input;
  }

  function paintHeader() {
    const ch = channel();
    const list = isMic() ? devs.capture : devs.render;
    const dev = curDevice();
    const attached = apo && apo.devices && dev && apo.devices.includes((dev.split("}.").pop() || "").toLowerCase());
    const userPreset = customPresets().some((p) => p.name === ch.preset);
    const edited_ = PRESETS.includes(ch.preset) && st.user_presets.some((p) => p.name === ch.preset);
    const presetBox = h("div", { class: "pathrow" }, presetChips(),
      h("button", { class: "btn ghost sm", text: "+", title: App.t("eq.savePreset"), onClick: (e) => e.currentTarget.parentNode.replaceChildren(savePreset()) }),
      userPreset ? h("button", { class: "btn ghost sm", text: "✕", title: App.t("eq.delPreset"), onClick: () => {
        st.user_presets = st.user_presets.filter((p) => p.name !== ch.preset); ch.preset = ""; push(true); paintAll();
      } }) : null,
      edited_ ? h("button", { class: "btn ghost sm", text: "↺", title: App.t("eq.presetRestore"), onClick: async () => {
        await push(true);
        await api.invoke("recorder_cmd", { cmd: "eq-preset-reset " + ch.preset }).catch(() => {});
        reload();
      } }) : null);
    // while a game preset plays the presets here would change my own EQ, which is not heard: locked with the dots
    if (viewingGame()) presetBox.classList.add("locked");
    setTimeout(() => presetBox.querySelector("input")?.focus());
    // DOM replaceChildren/append turn null into the text "null": wrap in a fragment built by App.h
    header.replaceChildren(...h("div", null,
      h("h1", { text: App.t("nav.eq") }),
      U.segc([["sys", App.t("eq.system")], ["mic", App.t("eq.mic")]], tab, (v) => { tab = v; sel = 0; paintAll(); startSpectrum(); }),
      h("select", { class: "field dev", title: App.t(isMic() ? "eq.micTip" : "eq.deviceTip"), onChange: (e) => {
        if (isMic()) { st.mic_device = e.target.value; push(true); refreshListen(); } else device = e.target.value;
        paintAll(); startSpectrum();
      } },
      isMic() && !st.mic_device ? h("option", { value: "", text: "—", selected: true }) : null,
      list.map((d) => h("option", { value: d.id, text: d.name + (d.id === (isMic() ? devs.default.capture : devs.default.render) ? " ★" : ""), selected: d.id === dev }))),
      dev && apo && !attached ? h("button", { class: "chip warn", text: App.t("eq.notAttached"), title: App.t("eq.notAttachedTip"),
        onClick: () => api.invoke("eq_open_device_selector").catch((e) => App.toast(String(e), "err")) }) : null,
      apo && apo.restart_pending ? h("span", { class: "chip warn", text: App.t("eq.restartChip"), title: App.t("eq.restart") }) : null,
      h("span", { class: "sp" }),
      presetBox,
      compareButton(ch),
      h("label", { class: "eqmaster", title: App.t("eq.masterTip") }, h("span", { text: App.t("eq.on") }),
        h("span", { class: "toggle" + (st.enabled ? " on" : ""), onClick: () => { st.enabled = !st.enabled; push(true); paintAll(); } }))).childNodes);
  }

  function autoeqBox() {
    const ch = channel();
    const box = h("div", { class: "card2 eqcard" });
    box.append(h("div", { class: "cap", text: App.t("eq.headphones"), title: App.t("eq.headphonesTip") }),
      ch.autoeq
        ? h("div", { class: "pathrow" }, h("span", { class: "chip on", text: ch.autoeq.name }),
          h("button", { class: "linkbtn", text: "✕", title: App.t("eq.hpRemove"), onClick: () => { ch.autoeq = null; push(true); paintAll(); } }))
        : hpSearch((p) => { ensureOn(); ch.autoeq = p; push(true); paintAll(); },
          guessModel((devs.render.find((d) => d.id === device) || {}).name || "")));
    return box;
  }

  /** The games card: a row for every game that has a preset, the one in front and the last five Buffer saw, each with a
   *  single choice (my own EQ or a preset). A game that was never in front is added by picking its .exe. */
  function gamesBox() {
    const box = h("div", { class: "card2 eqcard" });
    const recent = (st.recent_games || []).length ? st.recent_games : Object.keys(st.seen_games || {}).sort();
    const stems = [...new Set([...Object.keys(st.game_presets), ...(games.stem ? [games.stem] : []), ...recent.slice(0, 5)])];
    stems.sort((a, b) => (b === games.stem) - (a === games.stem) || gameTitle(a).localeCompare(gameTitle(b)));
    const choices = [...PRESETS.map((id) => [id, presetLabel(id)]), ...customPresets().map((p) => [p.name, p.name])];
    const opts = (cur) => [h("option", { value: "", text: App.t("eq.ownEq"), selected: !cur }),
      ...choices.map(([v, t]) => h("option", { value: v, text: t, selected: v === cur }))];
    const rows = stems.map((stem) => h("div", { class: "grow2" + (stem === games.stem ? " live" : "") },
      h("span", { text: gameTitle(stem), title: stem }),
      h("select", { class: "field", onChange: (e) => {
        if (e.target.value) st.game_presets[stem] = e.target.value; else delete st.game_presets[stem];
        ensureOn(); push(true); paintAll();
      } }, opts(st.game_presets[stem])),
      h("button", { class: "linkbtn", text: "✕", title: App.t("eq.gameForget"), onClick: async () => {
        await api.invoke("recorder_cmd", { cmd: "eq-game-forget " + stem }).catch(() => {});
        delete st.game_presets[stem]; delete (st.seen_games || {})[stem]; reload();
      } })));
    // the card is not a full list: say so right in the title
    box.append(h("div", { class: "cap", title: App.t("eq.gamesTip") }, App.t("eq.games"), h("span", { class: "capnote", text: " · " + App.t("eq.gamesLast") })), ...rows);
    if (!rows.length) box.append(h("div", { class: "faint", text: App.t("eq.gamesEmpty") }));
    box.append(h("button", { class: "btn sm addgame", text: App.t("eq.gameAddBtn"), title: App.t("eq.gameAddTip"), onClick: async () => {
      const file = await api.pickFile("Game", ["exe"]).catch(() => null);
      if (!file) return;
      const stem = App.baseName(file).replace(/\.exe$/i, "").toLowerCase();
      if (stem) { await api.invoke("recorder_cmd", { cmd: "eq-game-add " + stem }).catch(() => {}); reload(); }
    } }));
    return box;
  }
  let listenTarget = "";         // output the mic is played on while "hear my mic" is on ("" = Windows default)
  const takeListen = (r) => { listen = !!(r && r.on); listenTarget = (r && r.target) || ""; };

  async function refreshListen() {
    listen = false; listenTarget = "";
    if (!st.mic_device) return;
    takeListen(await api.invoke("recorder_cmd", { cmd: "eq-listen " + st.mic_device }).catch(() => null));
    if (isMic()) paintBelow();
  }

  async function setListen(on, target = "") {
    const r = await api.invoke("recorder_cmd", { cmd: `eq-listen ${st.mic_device} ${on ? "on" : "off"}${on && target ? " " + target : ""}` })
      .catch((e) => ({ ok: false, error: e }));
    if (r.ok === false) App.toast(App.t("eq.err", { err: r.error }), "err");
    takeListen(r); paintBelow();
  }

  function micBox() {
    const box = h("div", { class: "card2 eqcard tgl", title: App.t("eq.clipNote") }, U.trow(App.t("eq.listen"), "", listen, (v) => setListen(v)));
    // where it plays matters: Windows' own default would be the monitor for someone on a monitor plus headset
    if (listen) {
      box.append(U.srow(App.t("eq.listenOn"), h("select", { class: "field", onChange: (e) => setListen(true, e.target.value) },
        listenTarget ? null : h("option", { value: "", text: App.t("dev.default"), selected: true }),
        devs.render.map((d) => h("option", { value: d.id, text: d.name, selected: d.id === listenTarget })))));
    }
    return box;
  }

  function paintBelow() {
    below.replaceChildren(...(isMic() ? [micBox()] : [autoeqBox(), gamesBox()]));
  }

  /** One line that says what is heard right now and why: device, game preset or my EQ, headphone correction. */
  const nowBar = h("div", { class: "eqnow" });
  function paintNow() {
    const ch = channel();
    const list = isMic() ? devs.capture : devs.render;
    const devName = (list.find((d) => d.id === curDevice()) || {}).name || "";
    const bits = [h("b", { text: devName })];
    if (!st.enabled || !ch.enabled) bits.push(h("span", { class: "chip warn", text: App.t("eq.nowOff") }));
    else if (gameActive() && !viewOwn) {
      bits.push(h("span", { class: "chip on", text: App.t("eq.nowGame", { game: gameTitle(games.stem), preset: presetLabel(st.game_presets[games.stem] || "") }) }));
    } else if (gameActive()) {
      bits.push(h("span", { class: "chip warn", text: App.t("eq.ownNotPlaying") }));
    } else {
      bits.push(h("span", { class: "chip", text: ch.preset ? presetLabel(ch.preset) : App.t("eq.ownEq") }));
    }
    if (ch.autoeq && !isMic()) bits.push(h("span", { class: "chip", text: "+ " + ch.autoeq.name, title: App.t("eq.headphonesTip") }));
    bits.push(h("span", { class: "sp" }));
    if (gameActive()) {
      bits.push(h("button", { class: "btn sm", text: App.t(viewOwn ? "eq.backToGame" : "eq.editOwn"),
        onClick: () => { viewOwn = !viewOwn; paintAll(); } }));
    }
    nowBar.replaceChildren(...h("div", null, ...bits).childNodes);
  }

  function paintAll() { paintHeader(); paintNow(); paintSide(); paintBelow(); redraw(); }

  /* ───── spectrum ───── */

  function startSpectrum() {
    const dev = curDevice();
    if (!dev || S.view !== "eq") return stopSpectrum();
    if (specFor === dev) return;
    stopSpectrum();
    specFor = dev;
    const chan = new window.__TAURI__.core.Channel();
    specChan = chan;
    chan.onmessage = (buf) => {
      if (specChan !== chan) return;
      const v = new Uint8Array(buf instanceof ArrayBuffer ? buf : new Uint8Array(buf).buffer);
      if (!spectrum || spectrum.length !== v.length) spectrum = new Float32Array(v.length);
      // fast attack, slow release: the fill breathes instead of flickering
      for (let i = 0; i < v.length; i++) spectrum[i] = v[i] > spectrum[i] ? v[i] : spectrum[i] * 0.86 + v[i] * 0.14;
      if (!drag) redraw();
    };
    api.invoke("eq_spectrum_start", { device: dev, frames: chan }).catch(() => {});
  }
  function stopSpectrum() {
    if (specChan) api.invoke("eq_spectrum_stop").catch(() => {});
    specChan = null; specFor = ""; spectrum = null;
  }
  // a reload would leave the capture thread sending into a channel nobody listens to
  window.addEventListener("beforeunload", stopSpectrum);
  api.invoke("eq_spectrum_stop").catch(() => {});

  /* ───── page ───── */

  async function reload() {
    const r = await api.invoke("recorder_cmd", { cmd: "eq-get" }).catch(() => null);
    if (r && r.ok) { st = r.state; takeGames(r); }
    paintAll();
  }

  function installState(box) {
    let busy = false;
    const draw = (msg) => box.replaceChildren(App.emptyState(App.t("eq.noApo"), msg || App.t("eq.noApoD"),
      busy ? null : App.t("eq.install"), async () => {
        busy = true; draw(App.t("eq.installing"));
        try {
          apo = await api.invoke("eq_install_apo");
          busy = false;
          if (apo.installed) App.EQ.render(); else draw(App.t("eq.restart"));
        } catch (e) { busy = false; draw(String(e)); }
      }));
    draw();
  }

  /** Headphone search used by the EQ page and the wizard; `pick(profile)` gets the parsed AutoEQ profile.
   *  With a `guess` (the model in the device name) the search runs by itself, so usually it is one click. */
  function hpSearch(pick, guess = "") {
    const results = h("div", { class: "eqhits" });
    const input = h("input", { class: "field", placeholder: App.t("eq.hpSearch"), spellcheck: false, value: guess });
    let t = 0;
    if (guess) setTimeout(() => input.dispatchEvent(new Event("input")));
    input.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const q = input.value.trim();
        if (q.length < 2) { results.replaceChildren(); return; }
        results.replaceChildren(h("div", { class: "muted", text: App.t("eq.searching") }));
        try {
          const hits = await api.invoke("eq_autoeq_search", { query: q });
          results.replaceChildren(...(hits.length ? hits.map((hit) => h("button", { class: "hit", onClick: async () => {
            results.replaceChildren(h("div", { class: "muted", text: App.t("eq.loading") }));
            try { pick(await api.invoke("eq_autoeq_fetch", { name: hit.name, path: hit.path })); }
            catch (e) { App.toast(App.t("eq.err", { err: e }), "err"); results.replaceChildren(); }
          } }, h("b", { text: hit.name }), h("span", { class: "muted", text: hit.source }))) : [h("div", { class: "muted", text: App.t("eq.noHits") })]));
        } catch (e) { results.replaceChildren(h("div", { class: "muted", text: String(e) })); }
      }, 250);
    });
    return h("div", null, input, results);
  }

  App.EQ = {
    hpSearch,
    guessModel,
    flat: () => structuredClone(FLAT),
    async render() {
      page = App.$("#v-eq");
      const [status, d, r] = await Promise.all([
        api.invoke("eq_apo_status").catch(() => null),
        api.invoke("recorder_devices").catch(() => null),
        api.invoke("recorder_cmd", { cmd: "eq-get" }).catch(() => null),
      ]);
      apo = status;
      if (d) devs = d;
      if (S.view !== "eq") return;
      if (!apo || !apo.installed) { stopSpectrum(); installState(page); page.firstChild.classList.add("eqempty"); return; }
      if (!r || !r.ok) {
        page.replaceChildren(App.emptyState(App.t("eq.noRec"), App.t("eq.noRecD"), App.t("eq.startRec"), async () => {
          await api.invoke("recorder_launch").catch(() => {});
          setTimeout(() => App.EQ.render(), 1500);
        }));
        return;
      }
      st = r.state;
      takeGames(r);
      st.user_presets ||= []; st.game_presets ||= {}; st.outputs ||= {};
      if (!device || !devs.render.some((x) => x.id === device)) device = devs.default.render || (devs.render[0] || {}).id || "";
      if (!st.mic_device && devs.default.capture) { st.mic_device = devs.default.capture; push(true); }
      canvas = h("canvas", { class: "eqgraph" });
      side = h("div", { class: "eqside" });
      const grip = h("button", { class: "eqgrip" });
      // order: graph, the fold button, then the faders (the button sits on the left edge of the panel it folds)
      const main = h("div", { class: "eqmain card2" }, h("div", { class: "gwrap" }, canvas), grip, side);
      // faders and knobs are the detailed way to edit; the dots do the same, so the panel starts folded
      const paintGrip = () => {
        const open = App.P.settings.eqSliders === true;
        main.classList.toggle("fold", !open);
        grip.textContent = open ? "›" : "‹";
        grip.title = grip.ariaLabel = App.t(open ? "eq.slidersHide" : "eq.slidersShow");
        if (open) sizeFaders();
        redraw();
      };
      grip.addEventListener("click", () => { App.P.settings.eqSliders = App.P.settings.eqSliders !== true; App.persist(); paintGrip(); });
      paintGrip();
      page.replaceChildren(h("div", { class: "eq" }, header, nowBar, main, below));
      bindCanvas();
      new ResizeObserver(() => { redraw(); sizeFaders(); }).observe(canvas);
      paintAll();
      startSpectrum();
      refreshListen();
    },
    leave() { stopSpectrum(); if (drag && drag.solo) solo(false); drag = null; },
  };
})();
