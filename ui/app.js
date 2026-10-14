"use strict";

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const video = $("video");

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

const state = {
  root: "",
  clips: [],
  clip: null,        // selected ClipEntry
  info: null,        // MediaInfo
  start: 0,
  end: 0,
  tracks: [],        // { name, gain, el, node }
  ctx: null,
  exporting: false,
  loadToken: 0,
};

const fmt = (s) => {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};
const fmtSize = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${(b / 1048576).toFixed(0)} MB`);

/* ───────── library ───────── */

async function loadLibrary() {
  state.root = $("dir").value.trim();
  store.set("dir", state.root);
  $("libStatus").textContent = "Wczytywanie…";
  try {
    state.clips = await invoke("list_clips", { dir: state.root });
    $("libStatus").textContent = `${state.clips.length} klipów`;
  } catch (e) {
    state.clips = [];
    $("libStatus").textContent = String(e);
  }
  renderLibrary();
}

function renderLibrary() {
  const q = $("filter").value.trim().toLowerCase();
  const ul = $("clips");
  ul.textContent = "";
  const frag = document.createDocumentFragment();
  for (const c of state.clips) {
    if (q && !`${c.name} ${c.group}`.toLowerCase().includes(q)) continue;
    const li = document.createElement("li");
    li.dataset.path = c.path;
    if (state.clip && state.clip.path === c.path) li.className = "active";
    const date = new Date(c.modified * 1000).toLocaleDateString("pl-PL");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = c.name;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${date} · ${fmtSize(c.size)}${c.group ? " · " + c.group : ""}`;
    li.append(name, meta);
    li.addEventListener("click", () => openClip(c));
    frag.append(li);
  }
  ul.append(frag);
}

/* ───────── open clip ───────── */

async function openClip(clip) {
  const token = ++state.loadToken;
  stopPlayback();
  teardownTracks();
  state.clip = clip;
  renderLibrary();
  $("empty").hidden = true;
  $("videoWrap").hidden = false;
  setStatus("");

  let info, audio;
  try {
    [info, audio] = await Promise.all([
      invoke("probe_clip", { path: clip.path }),
      invoke("prepare_audio", { path: clip.path }),
    ]);
  } catch (e) {
    setStatus(`Nie można otworzyć klipu: ${e}`, "err");
    return;
  }
  if (token !== state.loadToken) return; // user already picked another clip

  state.info = info;
  state.start = 0;
  state.end = info.duration;
  video.src = convertFileSrc(clip.path);
  video.load();
  buildTracks(info, audio);
  $("setIn").disabled = $("setOut").disabled = false;
  layoutTimeline();
  updateEstimate();
  updateCropBox();
}

function buildTracks(info, files) {
  const box = $("tracks");
  box.textContent = "";
  if (!state.ctx) state.ctx = new AudioContext();
  state.tracks = info.audio.map((t, i) => {
    const el = new Audio(convertFileSrc(files[i]));
    el.preload = "auto";
    const node = state.ctx.createGain();
    state.ctx.createMediaElementSource(el).connect(node).connect(state.ctx.destination);
    const saved = parseFloat(store.get(`gain:${t.name}`, "1"));
    const track = { name: t.name, gain: Number.isFinite(saved) ? saved : 1, el, node };
    node.gain.value = track.gain;

    const wrap = document.createElement("div");
    wrap.className = "track";
    const head = document.createElement("div");
    head.className = "head";
    const label = document.createElement("span");
    label.textContent = t.name;
    const val = document.createElement("span");
    val.className = "gain";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "200";
    slider.value = String(Math.round(track.gain * 100));
    const show = () => { val.textContent = track.gain === 0 ? "wyciszona" : `${Math.round(track.gain * 100)}%`; };
    slider.addEventListener("input", () => {
      track.gain = slider.value / 100;
      node.gain.value = track.gain;
      store.set(`gain:${track.name}`, String(track.gain));
      show();
      updateEstimate();
    });
    show();
    head.append(label, val);
    wrap.append(head, slider);
    box.append(wrap);
    return track;
  });
}

function teardownTracks() {
  for (const t of state.tracks) {
    t.el.pause();
    t.el.removeAttribute("src");
    t.el.load();
    try { t.node.disconnect(); } catch { /* already disconnected */ }
  }
  state.tracks = [];
  $("tracks").textContent = "";
}

/* ───────── playback & sync ───────── */

function startPlayback() {
  if (!state.info) return;
  state.ctx?.resume();
  if (video.currentTime < state.start || video.currentTime >= state.end - 0.05) video.currentTime = state.start;
  for (const t of state.tracks) {
    t.el.currentTime = video.currentTime;
    t.el.playbackRate = video.playbackRate;
    t.el.play().catch(() => {});
  }
  video.play().catch(() => {});
}

function stopPlayback() {
  video.pause();
  for (const t of state.tracks) t.el.pause();
}

function seek(t) {
  t = Math.min(Math.max(t, 0), state.info ? state.info.duration : 0);
  video.currentTime = t;
  for (const tr of state.tracks) tr.el.currentTime = t;
  paintPlayhead();
}

function tick() {
  if (state.info) {
    if (!video.paused) {
      if (video.currentTime >= state.end) {
        seek(state.start);
        for (const t of state.tracks) if (t.el.paused) t.el.play().catch(() => {});
      } else {
        // keep audio within 80 ms of the picture
        for (const t of state.tracks) {
          if (Math.abs(t.el.currentTime - video.currentTime) > 0.08) t.el.currentTime = video.currentTime;
        }
      }
    }
    paintPlayhead();
  }
  requestAnimationFrame(tick);
}

video.addEventListener("play", () => { $("play").textContent = "❚❚"; });
video.addEventListener("pause", () => { $("play").textContent = "▶"; });
video.addEventListener("waiting", () => { for (const t of state.tracks) t.el.pause(); });
video.addEventListener("playing", () => {
  for (const t of state.tracks) {
    t.el.currentTime = video.currentTime;
    t.el.play().catch(() => {});
  }
});
video.addEventListener("loadedmetadata", updateCropBox);
window.addEventListener("resize", updateCropBox);

/* ───────── timeline ───────── */

const tl = $("timeline");
const pct = (t) => (state.info ? (t / state.info.duration) * 100 : 0);

function layoutTimeline() {
  $("selection").style.left = `${pct(state.start)}%`;
  $("selection").style.width = `${pct(state.end) - pct(state.start)}%`;
  $("handleIn").style.left = `${pct(state.start)}%`;
  $("handleOut").style.left = `${pct(state.end)}%`;
  $("selLen").textContent = state.info ? `wybrano ${fmt(state.end - state.start)}` : "";
  paintPlayhead();
  updateEstimate();
}

function paintPlayhead() {
  if (!state.info) return;
  $("playhead").style.left = `${pct(video.currentTime)}%`;
  $("time").textContent = `${fmt(video.currentTime)} / ${fmt(state.info.duration)}`;
}

function timeAt(ev) {
  const r = tl.getBoundingClientRect();
  return Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1) * (state.info?.duration ?? 0);
}

function drag(handle, apply) {
  handle.addEventListener("pointerdown", (ev) => {
    if (!state.info) return;
    ev.stopPropagation();
    handle.setPointerCapture(ev.pointerId);
    const move = (e) => { apply(timeAt(e)); layoutTimeline(); };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}
const MIN_SEL = 0.5;
drag($("handleIn"), (t) => { state.start = Math.min(t, state.end - MIN_SEL); });
drag($("handleOut"), (t) => { state.end = Math.max(t, state.start + MIN_SEL); });
tl.addEventListener("pointerdown", (ev) => { if (state.info) seek(timeAt(ev)); });

$("setIn").addEventListener("click", () => { state.start = Math.min(video.currentTime, state.end - MIN_SEL); layoutTimeline(); });
$("setOut").addEventListener("click", () => { state.end = Math.max(video.currentTime, state.start + MIN_SEL); layoutTimeline(); });
$("play").addEventListener("click", () => (video.paused ? startPlayback() : stopPlayback()));

document.addEventListener("keydown", (ev) => {
  if (ev.target instanceof HTMLInputElement && ev.target.type !== "range" && ev.target.type !== "checkbox") return;
  if (ev.target instanceof HTMLSelectElement) return;
  const step = ev.shiftKey ? 5 : 1;
  switch (ev.key) {
    case " ": ev.preventDefault(); video.paused ? startPlayback() : stopPlayback(); break;
    case "i": case "I": $("setIn").click(); break;
    case "o": case "O": $("setOut").click(); break;
    case "ArrowLeft": ev.preventDefault(); seek(video.currentTime - step); break;
    case "ArrowRight": ev.preventDefault(); seek(video.currentTime + step); break;
  }
});

/* ───────── crop, speed, estimate ───────── */

function updateCropBox() {
  const box = $("cropBox");
  const on = $("wide").checked && state.info;
  box.hidden = !on;
  $("panRow").hidden = !$("wide").checked;
  if (!on) return;
  const w = video.clientWidth;
  const h = video.clientHeight;
  // Same rule as the exporter: ultrawide sources lose the sides, narrow ones the top/bottom.
  let cw = w;
  let ch = h;
  if (w / h > 16 / 9) cw = (h * 16) / 9;
  else ch = (w * 9) / 16;
  box.style.width = `${cw}px`;
  box.style.height = `${ch}px`;
  box.style.left = `${(w - cw) * ($("pan").value / 100)}px`;
  box.style.top = `${(h - ch) / 2}px`;
}
$("wide").addEventListener("change", updateCropBox);
$("pan").addEventListener("input", updateCropBox);

$("speed").addEventListener("change", () => {
  video.playbackRate = parseFloat($("speed").value);
  for (const t of state.tracks) t.el.playbackRate = video.playbackRate;
  updateEstimate();
});

function targetBytes() {
  return Math.max(1, parseFloat($("targetMb").value) || 10) * 1048576;
}

function updateEstimate() {
  const el = $("estimate");
  el.className = "muted";
  if (!state.info) { el.textContent = ""; return; }
  const speed = parseFloat($("speed").value);
  const dur = (state.end - state.start) / speed;
  const audioKbps = state.tracks.some((t) => t.gain > 0) ? 128 : 0;
  const kbps = Math.floor((targetBytes() * 8 * 0.96) / dur / 1000) - audioKbps;
  const res = $("maxHeight").value || state.info.height;
  el.textContent = `Wideo ≈ ${Math.max(kbps, 0)} kbps · ${fmt(dur)} · ${res}p`;
  if (kbps < 800) {
    el.className = "warn";
    el.textContent += kbps < 150 ? " — za mało, skróć lub zwiększ cel" : " — niska jakość, rozważ 720p lub krótszy fragment";
  }
  document.querySelectorAll("#presets button").forEach((b) => {
    b.classList.toggle("active", parseFloat(b.dataset.mb) === parseFloat($("targetMb").value));
  });
}

document.querySelectorAll("#presets button").forEach((b) => {
  b.addEventListener("click", () => { $("targetMb").value = b.dataset.mb; updateEstimate(); });
});
for (const id of ["targetMb", "maxHeight", "codec"]) $(id).addEventListener("input", updateEstimate);

/* ───────── export ───────── */

function setStatus(html, cls = "") {
  const el = $("exportStatus");
  el.className = cls;
  el.textContent = "";
  if (html instanceof Node) el.append(html);
  else el.textContent = html;
}

listen("export-progress", (e) => {
  $("bar").style.width = `${(e.payload * 100).toFixed(1)}%`;
});

$("export").addEventListener("click", async () => {
  if (!state.info || state.exporting) return;
  stopPlayback();
  const mb = Math.round(targetBytes() / 1048576);
  const wide = $("wide").checked;
  const base = state.clip.name + (wide ? "_16x9" : "") + `_${mb}MB`;
  const output = `${state.root.replace(/[\\/]+$/, "")}\\Exported Clips\\${base}.mp4`;
  const opts = {
    input: state.clip.path,
    output,
    start: state.start,
    end: state.end >= state.info.duration - 0.01 ? null : state.end,
    target_bytes: Math.round(targetBytes()),
    max_height: $("maxHeight").value ? parseInt($("maxHeight").value, 10) : null,
    codec: $("codec").value,
    audio_kbps: 128,
    volumes: state.tracks.map((t) => [t.name, t.gain]),
    crop_wide: wide ? $("pan").value / 100 : null,
    speed: parseFloat($("speed").value),
    normalize: $("normalize").checked,
  };

  state.exporting = true;
  $("export").disabled = true;
  $("export").textContent = "Eksportowanie…";
  $("progress").hidden = false;
  $("bar").style.width = "0";
  setStatus("");
  $("dragChip").hidden = true;
  state.lastOutput = null;
  try {
    const r = await invoke("export_clip", { opts });
    state.lastOutput = output;
    $("dragName").textContent = output.slice(output.lastIndexOf("\\") + 1);
    $("dragChip").hidden = false;
    const a = document.createElement("a");
    a.textContent = "Pokaż w folderze";
    a.addEventListener("click", () => invoke("reveal", { path: output }));
    const span = document.createElement("span");
    span.append(`Gotowe: ${(r.size / 1048576).toFixed(2)} MiB (cel ${mb}), ${r.video_kbps} kbps · `, a);
    setStatus(span, "ok");
  } catch (e) {
    setStatus(String(e), "err");
  } finally {
    state.exporting = false;
    $("export").disabled = false;
    $("export").textContent = "Eksportuj";
    $("progress").hidden = true;
  }
});

/* ───────── drag the exported file into Discord / Explorer ───────── */

function dragIcon() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "#ff6a1f";
  g.beginPath();
  g.roundRect(4, 4, 56, 56, 12);
  g.fill();
  g.fillStyle = "#fff";
  g.beginPath(); // play triangle
  g.moveTo(25, 18);
  g.lineTo(25, 46);
  g.lineTo(47, 32);
  g.closePath();
  g.fill();
  return c.toDataURL("image/png");
}

$("dragChip").addEventListener("pointerdown", async (ev) => {
  if (!state.lastOutput || ev.button !== 0) return;
  ev.preventDefault();
  try {
    await invoke("plugin:drag|start_drag", {
      item: [state.lastOutput],
      image: dragIcon(),
      onEvent: new window.__TAURI__.core.Channel(),
    });
  } catch (e) {
    setStatus(`Nie udało się przeciągnąć pliku: ${e}`, "err");
  }
});

/* ───────── init ───────── */

$("dir").value = store.get("dir", "E:\\Nagrania");
$("reload").addEventListener("click", loadLibrary);
$("dir").addEventListener("keydown", (e) => { if (e.key === "Enter") loadLibrary(); });
$("filter").addEventListener("input", renderLibrary);
$("setIn").disabled = $("setOut").disabled = true;
loadLibrary();
requestAnimationFrame(tick);
