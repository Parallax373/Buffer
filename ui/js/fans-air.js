"use strict";
/* Airflow and heat in the case, for the Fans page's stage. No DOM here: it can be timed and checked in node
   (`node scripts/check-air.js`). An estimate, not CFD: it shows where air goes, where it warms up and how warm it leaves.

   The air: a velocity field on a coarse grid around the case, rebuilt a few times a second:
   - every intake is a source and every exhaust a sink (potential flow: the air crosses the case from one to the other);
   - every fan adds a jet along its axis (strong in front of it, a little suction behind), so an intake blows in, an exhaust
     pulls the air near it out, and the fans of a CPU cooler or a graphics card push air through their heatsink;
   - curl noise on top (divergence free, so it stirs without piling up), stronger where the air is faster: turbulence.
   Particles enter at the intakes (or through gaps when there are none), follow the field, bounce off the walls and leave
   through an exhaust (or a gap when the case is over-pressured). Each carries a temperature: it starts at the room's,
   rises inside a heat volume (the CPU heatsink, the graphics card) towards that part's temperature, faster the hotter it
   is, and cools slowly elsewhere. Air leaving through an exhaust sets that exhaust's outlet temperature. */

(function (root) {
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /* ───── value noise and its curl ───── */
  function hash(x, y, z) {
    let h = (x * 374761393 + y * 668265263 + z * 1274126177) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
  function vnoise(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = x - xi, yf = y - yi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
    const l = (a, b, t) => a + (b - a) * t;
    return l(
      l(l(hash(xi, yi, zi), hash(xi + 1, yi, zi), u), l(hash(xi, yi + 1, zi), hash(xi + 1, yi + 1, zi), u), v),
      l(l(hash(xi, yi, zi + 1), hash(xi + 1, yi, zi + 1), u), l(hash(xi, yi + 1, zi + 1), hash(xi + 1, yi + 1, zi + 1), u), v), w) * 2 - 1;
  }
  /** curl of a noise vector potential at p (scale: noise cells per cm, t: time) -> out */
  function curl(x, y, z, s, t, out) {
    const e = 0.35, X = x * s, Y = y * s, Z = z * s;
    const A = (dx, dy, dz) => vnoise(X + dx, Y + dy, Z + dz + t);               // potential's x component
    const B = (dx, dy, dz) => vnoise(X + dx + 31.4, Y + dy, Z + dz - t);        // y
    const C = (dx, dy, dz) => vnoise(X + dx, Y + dy + 17.2, Z + dz + 0.7 * t);  // z
    out[0] = (C(0, e, 0) - C(0, -e, 0) - (B(0, 0, e) - B(0, 0, -e))) / (2 * e);
    out[1] = (A(0, 0, e) - A(0, 0, -e) - (C(e, 0, 0) - C(-e, 0, 0))) / (2 * e);
    out[2] = (B(e, 0, 0) - B(-e, 0, 0) - (A(0, e, 0) - A(0, -e, 0))) / (2 * e);
    return out;
  }

  /**
   * A simulation. `cfg.box` = { lo:[x,y,z], hi:[x,y,z] } (the inside of the case, cm), `cfg.max` = most particles.
   * `set(scene)` gives it the fans and heat volumes; `step(dt)` moves it; read `n`, `pos`, `temp`, `trail` and `outlets`.
   */
  function create(cfg) {
    const MAX = cfg.max || 2400, TR = cfg.trail || 9;
    const pos = new Float32Array(MAX * 3), vel = new Float32Array(MAX * 3), temp = new Float32Array(MAX), age = new Float32Array(MAX);
    const exitAt = new Float32Array(MAX), inside = new Uint8Array(MAX), trail = new Float32Array(MAX * TR * 3), head = new Uint16Array(MAX), fill = new Uint8Array(MAX);
    const box = { lo: cfg.box.lo.slice(), hi: cfg.box.hi.slice() };
    const PAD = 9, G = cfg.grid || 14;     // the grid reaches PAD cm outside the case, so air on its way in or out moves too
    const glo = box.lo.map((v) => v - PAD), ghi = box.hi.map((v) => v + PAD), gsz = [0, 1, 2].map((i) => (ghi[i] - glo[i]) / (G - 1));
    const field = new Float32Array(G * G * G * 3);
    let scene = { fans: [], heat: [], ambient: 25 }, n = 0, time = 0, sinceGrid = 1, want = 0;
    const outlets = new Map();     // exhaust index -> { t: average outlet temperature, n: particles seen }
    const tmp = [0, 0, 0];

    /** the air's velocity at a point (cm/s), from the fans alone (no noise): sources, sinks and jets */
    function flowAt(x, y, z, out) {
      out[0] = out[1] = out[2] = 0;
      for (const f of scene.fans) {
        if (f.pct <= 0) continue;
        const dx = x - f.c[0], dy = y - f.c[1], dz = z - f.c[2];
        const t = dx * f.a[0] + dy * f.a[1] + dz * f.a[2];                       // along the fan's axis (positive: downstream)
        const rx = dx - t * f.a[0], ry = dy - t * f.a[1], rz = dz - t * f.a[2], rho = Math.sqrt(rx * rx + ry * ry + rz * rz);
        const U = 38 * f.pct;                                                     // about 0.4 m/s at full speed, scaled for show
        // the jet: a widening cone downstream, fading over ~4 fan radii; suction upstream over ~1 radius
        const w = f.r * (1 + Math.max(0, t) / (2.4 * f.r));
        const g = Math.exp(-(rho * rho) / (w * w));
        // a card's fans blow into its heatsink, which turns the air out sideways: the jet dies fast and spreads radially
        const reach = f.spread ? 1.3 * f.r : 5 * f.r;
        const along = t >= 0 ? Math.exp(-t / reach) * (f.r / w) * (f.r / w) : Math.exp(t / (3 * f.r));
        const j = U * along * g;
        out[0] += f.a[0] * j; out[1] += f.a[1] * j; out[2] += f.a[2] * j;
        if (rho > 0.01) {
          // upstream the air converges on the fan's disc; behind a card's fans it is thrown out to the sides
          const rad = t < 0 ? -0.35 * U * Math.exp(t / (3 * f.r)) * Math.min(1, rho / f.r) * Math.exp(-(rho * rho) / (9 * f.r * f.r))
            : f.spread ? 0.9 * U * Math.exp(-t / (2 * f.r)) * Math.min(1, rho / f.r) * Math.exp(-(rho * rho) / (6 * f.r * f.r)) : 0;
          out[0] += (rx / rho) * rad; out[1] += (ry / rho) * rad; out[2] += (rz / rho) * rad;
        }
        // the case as a whole: intakes are sources, exhausts sinks (softened, so the field stays finite at the fan)
        // (only felt inside the case, so air outside it is never pushed away from an intake)
        if (f.kind !== "int" && inBox(x, y, z, 0)) {
          const sx = dx, sy = dy, sz = dz;
          const d2 = sx * sx + sy * sy + sz * sz + f.r * f.r, q = (f.kind === "in" ? 1 : -1) * (f.q ?? 1) * U * f.r * f.r * f.r * 0.9 / (d2 * Math.sqrt(d2));
          out[0] += sx * q; out[1] += sy * q; out[2] += sz * q;
        }
      }
      return out;
    }
    function buildGrid() {
      const v = [0, 0, 0], c = [0, 0, 0];
      for (let k = 0, i = 0; k < G; k++) for (let j = 0; j < G; j++) for (let h = 0; h < G; h++, i += 3) {
        const x = glo[0] + h * gsz[0], y = glo[1] + j * gsz[1], z = glo[2] + k * gsz[2];
        flowAt(x, y, z, v);
        const sp = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        curl(x, y, z, 0.09, time * 0.35, c);
        const T = 1.4 + sp * 0.3;                                                // turbulence grows with the local speed
        field[i] = v[0] + c[0] * T; field[i + 1] = v[1] + c[1] * T; field[i + 2] = v[2] + c[2] * T;
      }
    }
    /** trilinear sample of the grid */
    function sample(x, y, z, out) {
      const fx = clamp((x - glo[0]) / gsz[0], 0, G - 1.001), fy = clamp((y - glo[1]) / gsz[1], 0, G - 1.001), fz = clamp((z - glo[2]) / gsz[2], 0, G - 1.001);
      const h = fx | 0, j = fy | 0, k = fz | 0, u = fx - h, v = fy - j, w = fz - k;
      const I = (a, b, c) => ((c * G + b) * G + a) * 3;
      for (let d = 0; d < 3; d++) {
        const c00 = field[I(h, j, k) + d] * (1 - u) + field[I(h + 1, j, k) + d] * u, c10 = field[I(h, j + 1, k) + d] * (1 - u) + field[I(h + 1, j + 1, k) + d] * u;
        const c01 = field[I(h, j, k + 1) + d] * (1 - u) + field[I(h + 1, j, k + 1) + d] * u, c11 = field[I(h, j + 1, k + 1) + d] * (1 - u) + field[I(h + 1, j + 1, k + 1) + d] * u;
        out[d] = (c00 * (1 - v) + c10 * v) * (1 - w) + (c01 * (1 - v) + c11 * v) * w;
      }
      return out;
    }

    const pick = (list) => { let r = Math.random() * list.reduce((s, f) => s + f.w, 0); for (const f of list) { r -= f.w; if (r <= 0) return f; } return list[list.length - 1]; };
    /** a random point on a fan's disc, a little upstream of it */
    function onDisc(f, back, out) {
      const a = f.a, u = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const p1 = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]], l = Math.hypot(...p1);
      const e1 = p1.map((v) => v / l), e2 = [a[1] * e1[2] - a[2] * e1[1], a[2] * e1[0] - a[0] * e1[2], a[0] * e1[1] - a[1] * e1[0]];
      const ang = Math.random() * Math.PI * 2, rr = f.r * (0.35 + 0.6 * Math.sqrt(Math.random()));
      for (let d = 0; d < 3; d++) out[d] = f.c[d] + (e1[d] * Math.cos(ang) + e2[d] * Math.sin(ang)) * rr - a[d] * back;
      return out;
    }
    /** a gap in the case's walls (air comes in or leaks out there) */
    function gap(out) {
      const d = Math.floor(Math.random() * 3), s = Math.random() < 0.5 ? 0 : 1;
      for (let i = 0; i < 3; i++) out[i] = i === d ? (s ? box.hi[i] + 1 : box.lo[i] - 1) : box.lo[i] + Math.random() * (box.hi[i] - box.lo[i]);
      return out;
    }
    function spawn(i) {
      const ins = scene.fans.filter((f) => f.kind === "in" && f.pct > 0), p = [0, 0, 0];
      if (ins.length) onDisc(pick(ins), 4 + Math.random() * 10, p);   // a little before the intake: the air is drawn in
      else if (scene.fans.some((f) => f.kind === "out" && f.pct > 0)) gap(p);
      else { for (let d = 0; d < 3; d++) p[d] = box.lo[d] + Math.random() * (box.hi[d] - box.lo[d]); }
      pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2];
      vel[i * 3] = vel[i * 3 + 1] = vel[i * 3 + 2] = 0;
      temp[i] = scene.ambient; age[i] = 0; inside[i] = 0; exitAt[i] = 0; head[i] = 0; fill[i] = 0;
    }
    const inBox = (x, y, z, m) => x > box.lo[0] - m && x < box.hi[0] + m && y > box.lo[1] - m && y < box.hi[1] + m && z > box.lo[2] - m && z < box.hi[2] + m;

    return {
      get n() { return n; }, pos, temp, trail, head, fill, TR, outlets, box, inside, age,
      /** scene: { fans: [{ c, a (unit, the way the air goes), r, pct 0..1, kind: "in"|"out"|"int" }], heat: [{ lo, hi, t }], ambient } */
      set(s) {
        scene = s;
        for (const f of scene.fans) f.w = f.pct * f.r * f.r;
        const flowIn = scene.fans.filter((f) => f.kind === "in").reduce((a, f) => a + f.w, 0), flowOut = scene.fans.filter((f) => f.kind === "out").reduce((a, f) => a + f.w, 0);
        const flowInt = scene.fans.filter((f) => f.kind === "int").reduce((a, f) => a + f.w, 0);
        // the case as a whole carries as much as both sides can: the stronger side's surplus leaks through gaps (jets still push it)
        const Q = Math.min(flowIn, flowOut);
        for (const f of scene.fans) f.q = !Q ? 1 : f.kind === "in" ? Q / flowIn : f.kind === "out" ? Q / flowOut : 1;
        want = Math.round(clamp((Math.max(flowIn, flowOut) * 26 + flowInt * 6), 0, MAX));
        sinceGrid = 1;
      },
      /** the most particles to keep (the page lowers it when frames get slow) */
      limit(m) { want = Math.min(want, m | 0); },
      get want() { return want; },
      step(dt) {
        dt = Math.min(dt, 0.05); time += dt; sinceGrid += dt;
        if (sinceGrid > 0.15) { buildGrid(); sinceGrid = 0; }
        while (n < want) spawn(n++);
        if (n > want) n = want;
        const v = tmp, H = scene.heat, amb = scene.ambient;
        const exhausts = scene.fans.filter((f) => f.kind === "out");
        const over = scene.fans.filter((f) => f.kind === "in").reduce((a, f) => a + f.w, 0) > exhausts.reduce((a, f) => a + f.w, 0) * 1.15;
        for (let i = 0; i < n; i++) {
          const o = i * 3;
          let x = pos[o], y = pos[o + 1], z = pos[o + 2];
          sample(x, y, z, v);
          // a little inertia: the particle eases into the local flow instead of snapping to it
          vel[o] += (v[0] - vel[o]) * Math.min(1, dt * 9); vel[o + 1] += (v[1] - vel[o + 1]) * Math.min(1, dt * 9); vel[o + 2] += (v[2] - vel[o + 2]) * Math.min(1, dt * 9);
          x += vel[o] * dt; y += vel[o + 1] * dt; z += vel[o + 2] * dt;
          age[i] += dt;
          const was = inside[i], now = inBox(x, y, z, 0);
          let dead = age[i] > 16;
          if (was === 2) {
            // already out through an exhaust or a gap: it drifts on a little, then is gone
            if (age[i] - exitAt[i] > 0.9 || !inBox(x, y, z, PAD)) dead = true;
          } else if (now) inside[i] = 1;
          else if (was) {
            // leaving the case: through an exhaust's disc, or through a gap when over-pressured; otherwise it bounces back
            let ex = -1;
            for (let k = 0; k < exhausts.length; k++) {
              const f = exhausts[k], dx = x - f.c[0], dy = y - f.c[1], dz = z - f.c[2], t = dx * f.a[0] + dy * f.a[1] + dz * f.a[2];
              const r2 = dx * dx + dy * dy + dz * dz - t * t;
              if (r2 < f.r * f.r * 1.3 && Math.abs(t) < 4) { ex = k; break; }
            }
            if (ex >= 0) {
              const f = exhausts[ex], idx = scene.fans.indexOf(f), m = outlets.get(idx) || { t: amb, n: 0 };
              m.t += (temp[i] - m.t) * 0.04; m.n++; outlets.set(idx, m);
              inside[i] = 2; exitAt[i] = age[i];
            } else if (over && Math.random() < 0.08) { inside[i] = 2; exitAt[i] = age[i]; }
            else {
              for (let d = 0; d < 3; d++) {
                const c = d === 0 ? x : d === 1 ? y : z;
                if (c < box.lo[d]) { vel[o + d] = Math.abs(vel[o + d]) * 0.4; if (d === 0) x = box.lo[0] + 0.1; else if (d === 1) y = box.lo[1] + 0.1; else z = box.lo[2] + 0.1; }
                if (c > box.hi[d]) { vel[o + d] = -Math.abs(vel[o + d]) * 0.4; if (d === 0) x = box.hi[0] - 0.1; else if (d === 1) y = box.hi[1] - 0.1; else z = box.hi[2] - 0.1; }
              }
            }
          } else if (!inBox(x, y, z, 18)) dead = true;   // never got in
          if (dead) { spawn(i); continue; }
          pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
          // heat: inside a heat volume the air takes up that part's warmth (faster the hotter it is); elsewhere it mixes back
          let heated = false;
          for (const hv of H) {
            if (x > hv.lo[0] && x < hv.hi[0] && y > hv.lo[1] && y < hv.hi[1] && z > hv.lo[2] && z < hv.hi[2]) {
              // the air heads for `tw` (from the part's power and the air through it) when the page knows it, else for its temperature
              const tgt = hv.tw != null ? hv.tw : hv.t - 4;
              const k = 0.9 + 1.6 * clamp((tgt - amb) / 50, 0, 1);
              temp[i] += (tgt - temp[i]) * Math.min(1, k * dt);
              heated = true;
            }
          }
          if (!heated) temp[i] += (amb - temp[i]) * Math.min(1, 0.06 * dt);
          // trail ring buffer
          const t0 = (i * TR + head[i]) * 3;
          trail[t0] = x; trail[t0 + 1] = y; trail[t0 + 2] = z;
          head[i] = (head[i] + 1) % TR; if (fill[i] < TR) fill[i]++;
        }
      },
      /** velocity of the fans' flow alone at a point (for checks) */
      flowAt: (x, y, z) => flowAt(x, y, z, [0, 0, 0]),
    };
  }

  root.FansAir = { create };
})(typeof App !== "undefined" ? App : module.exports);   // App is the page's global; node gets a module
