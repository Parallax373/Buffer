// node scripts/check-air.js: times the Fans page's airflow simulation (ui/js/fans-air.js) and checks that it behaves:
// air leaves mostly through the exhausts, it warms only at the heat sources, the exhausts report warmer air than the room.
const { create } = require("../ui/js/fans-air.js").FansAir;

// a mid-tower as built (cm): front at +z, top at +y, motherboard at x = 0, glass at x = 22
const box = { lo: [0, 0, -22], hi: [22, 46, 22] };
const fan = (c, a, kind, pct, r = 5.5) => ({ c, a, r, pct, kind });
const scene = {
  ambient: 26,
  fans: [
    fan([11, 10, 22], [0, 0, -1], "in", 0.6), fan([11, 23, 22], [0, 0, -1], "in", 0.6), fan([11, 36, 22], [0, 0, -1], "in", 0.6),
    fan([11, 46, 12], [0, 1, 0], "out", 0.6), fan([11, 46, 0], [0, 1, 0], "out", 0.6), fan([11, 46, -12], [0, 1, 0], "out", 0.6),
    fan([9, 34, 0], [0, 0, -1], "int", 0.45), fan([9, 34, -10], [0, 0, -1], "int", 0.45),       // tower cooler, push-pull to the rear
  ],
  heat: [{ lo: [2, 28, -9], hi: [14, 40, 1], t: 70 }, { lo: [1, 12, -15], hi: [13, 18, 15], t: 62 }],
};
const sim = create({ box, max: 2400 });
sim.set(scene);
let ms = 0, steps = 0;
for (let i = 0; i < 30 * 25; i++) {           // 25 s at 30 fps
  const t0 = process.hrtime.bigint();
  sim.step(1 / 30);
  const t1 = process.hrtime.bigint();
  if (i > 60) { ms += Number(t1 - t0) / 1e6; steps++; }
}
const n = sim.n;
let warmFar = 0, far = 0, hottest = 0;
for (let i = 0; i < n; i++) {
  const x = sim.pos[i * 3], y = sim.pos[i * 3 + 1], z = sim.pos[i * 3 + 2], t = sim.temp[i];
  hottest = Math.max(hottest, t);
  // far from both heat volumes and still near the front: fresh air should be near the room's temperature
  if (z > 14 && y < 26) { far++; if (t > scene.ambient + 8) warmFar++; }
}
const outs = [...sim.outlets.entries()].map(([k, m]) => ({ fan: k, t: +m.t.toFixed(1), n: m.n }));
const exited = outs.reduce((a, o) => a + o.n, 0);
console.log({ particles: n, msPerStep: +(ms / steps).toFixed(2), exitedThroughExhausts: exited, outlets: outs, hottest: +hottest.toFixed(1), warmNearFront: `${warmFar}/${far}` });
const bad = [];
if (ms / steps > 6) bad.push("a step takes more than 6 ms");
if (exited < 500) bad.push("too little air leaves through the exhausts");
if (!outs.some((o) => o.t > scene.ambient + 2)) bad.push("no exhaust reports warmer air than the room");
if (far && warmFar / far > 0.15) bad.push("fresh air near the front is warm");
if (hottest > 70) bad.push("air got hotter than the hottest part");
console.log(bad.length ? "FAIL: " + bad.join("; ") : "OK");
process.exit(bad.length ? 1 : 0);
