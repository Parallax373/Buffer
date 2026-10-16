"use strict";
/* Colour wheel for the RGB page: hue around the circle, saturation from the centre (white) outwards, full value.
   App.RGBWheel(hue, sat, onInput) -> element; `el.set(hue, sat)` moves the marker without calling onInput. */

(function () {
  const SIZE = 132;

  /** HSV (hue 0-360, sat 0-100, value 1) -> [r, g, b] 0-255 */
  function hsv(hue, sat) {
    const c = sat / 100, h = (((hue % 360) + 360) % 360) / 60, x = c * (1 - Math.abs((h % 2) - 1)), m = 1 - c;
    const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h) % 6];
    return [r + m, g + m, b + m].map((v) => Math.round(v * 255));
  }
  const toHex = (hue, sat) => "#" + hsv(hue, sat).map((v) => v.toString(16).padStart(2, "0")).join("");
  /** "#rrggbb" -> { hue, sat } (the brightness of the colour is dropped: brightness has its own slider) */
  function fromHex(s) {
    const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    const hue = d ? ((mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360 : 0;
    return { hue: Math.round(hue), sat: mx ? Math.round((d / mx) * 100) : 0 };
  }

  let disk = null;   // the painted wheel, shared by every instance
  function paint(dpr) {
    if (disk && disk.dpr === dpr) return disk.canvas;
    const n = Math.round(SIZE * dpr), c = document.createElement("canvas");
    c.width = c.height = n;
    const ctx = c.getContext("2d"), img = ctx.createImageData(n, n), R = n / 2;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = x + 0.5 - R, dy = y + 0.5 - R, r = Math.hypot(dx, dy), i = (y * n + x) * 4;
        if (r > R) continue;
        const [pr, pg, pb] = hsv((Math.atan2(dy, dx) * 180) / Math.PI, Math.min(100, (r / (R - 1)) * 100));
        img.data[i] = pr; img.data[i + 1] = pg; img.data[i + 2] = pb;
        img.data[i + 3] = r > R - 1 ? Math.round(255 * (R - r)) : 255;   // soft edge
      }
    }
    ctx.putImageData(img, 0, 0);
    disk = { dpr, canvas: c };
    return c;
  }

  App.RGBWheel = (hue, sat, onInput) => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const el = App.h("div", { class: "rwheel", tabindex: 0, role: "slider", "aria-label": App.t("rgb.colour") });
    const cv = paint(dpr), view = document.createElement("canvas");
    view.width = view.height = cv.width; view.style.width = view.style.height = SIZE + "px";
    view.getContext("2d").drawImage(cv, 0, 0);
    const dot = App.h("i", { class: "rdot" });
    el.append(view, dot);
    let cur = { hue, sat };
    const place = () => {
      const a = (cur.hue * Math.PI) / 180, r = (cur.sat / 100) * (SIZE / 2 - 1);
      dot.style.left = SIZE / 2 + Math.cos(a) * r + "px"; dot.style.top = SIZE / 2 + Math.sin(a) * r + "px";
      dot.style.background = toHex(cur.hue, cur.sat);
    };
    const pick = (e) => {
      const b = el.getBoundingClientRect(), dx = e.clientX - b.left - SIZE / 2, dy = e.clientY - b.top - SIZE / 2;
      cur = { hue: Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360), sat: Math.round(Math.min(100, (Math.hypot(dx, dy) / (SIZE / 2 - 1)) * 100)) };
      place(); onInput(cur.hue, cur.sat);
    };
    el.addEventListener("pointerdown", (e) => { el.setPointerCapture(e.pointerId); pick(e); });
    el.addEventListener("pointermove", (e) => { if (el.hasPointerCapture(e.pointerId)) pick(e); });
    el.addEventListener("keydown", (e) => {
      const k = { ArrowLeft: [-4, 0], ArrowRight: [4, 0], ArrowUp: [0, 4], ArrowDown: [0, -4] }[e.key];
      if (!k) return;
      e.preventDefault();
      cur = { hue: (cur.hue + k[0] + 360) % 360, sat: Math.max(0, Math.min(100, cur.sat + k[1])) };
      place(); onInput(cur.hue, cur.sat);
    });
    el.set = (h, s) => { cur = { hue: h, sat: s }; place(); };
    place();
    return el;
  };
  App.RGBWheel.toHex = toHex;
  App.RGBWheel.fromHex = fromHex;
})();
