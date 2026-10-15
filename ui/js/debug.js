"use strict";
/* Ctrl+Shift+D: live "what is being rebuilt" panel. Counts DOM mutations per element over the last 5 seconds and
   lists the busiest ones, so a flicker can be pinned on a concrete element instead of guessed at. Off by default,
   costs nothing until switched on. Plain text, so the list can be copied into a bug report. */
(function () {
  let panel = null, observer = null, timer = 0, counts = new Map(), window5 = [];

  const name = (el) => {
    const parts = [];
    for (let n = el, i = 0; n && n.nodeType === 1 && n !== document.body && i < 4; n = n.parentElement, i++) {
      let s = n.tagName.toLowerCase();
      if (n.id) s += "#" + n.id;
      else if (n.classList.length) s += "." + [...n.classList].slice(0, 2).join(".");
      parts.unshift(s);
    }
    return parts.join(" > ");
  };

  function start() {
    panel = document.createElement("pre");
    panel.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:99999;max-width:60vw;max-height:45vh;overflow:auto;"
      + "margin:0;padding:8px 10px;background:#000c;color:#c6f432;font:11px/1.35 'JetBrains Mono',monospace;"
      + "border:1px solid #c6f43266;border-radius:8px;pointer-events:none;white-space:pre-wrap";
    document.body.append(panel);
    observer = new MutationObserver((list) => {
      const now = performance.now();
      for (const m of list) {
        if (panel.contains(m.target)) continue;
        const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        if (el) window5.push([now, name(el), m.type === "childList" ? "children" : m.type]);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    timer = setInterval(draw, 1000);
    draw();
  }

  function draw() {
    const cut = performance.now() - 5000;
    window5 = window5.filter((e) => e[0] >= cut);
    counts = new Map();
    for (const [, n, kind] of window5) {
      const k = `${n} [${kind}]`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const rows = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 14)
      .map(([k, c]) => `${String(Math.round(c / 5 * 10) / 10).padStart(5)}/s  ${k}`);
    panel.textContent = `DOM changes, last 5 s (Ctrl+Shift+D closes)\n` + (rows.join("\n") || "quiet");
  }

  function stop() {
    observer && observer.disconnect();
    clearInterval(timer);
    panel && panel.remove();
    panel = observer = null;
    window5 = [];
  }

  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
      e.preventDefault();
      panel ? stop() : start();
    }
  });
})();
