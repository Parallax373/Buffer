// Scratch check: node check-i18n.js  (run from moments-lite)
const fs = require("fs");
const path = require("path");
global.App = { locales: {} };
const dir = "ui/js/locales";
for (const f of fs.readdirSync(dir)) {
  const raw = fs.readFileSync(path.join(dir, f));
  if (raw[0] === 0xef && raw[1] === 0xbb) console.log("BOM in", f);
  if (/Ä|Ĺ|â€/.test(raw.toString("utf8"))) console.log("mojibake in", f);
  new Function("App", raw.toString("utf8"))(App);
}
const en = App.locales.en.t;
const ph = (v) => (typeof v === "object" ? Object.values(v).join(" ") : v).match(/\{\w+\}/g)?.sort().join(",") || "";
const phSet = (v) => [...new Set((typeof v === "object" ? Object.values(v).join(" ") : v).match(/\{\w+\}/g) || [])].sort().join(",");
let bad = 0;
const ruleNeeds = { pl: ["one", "few", "many", "other"], uk: ["one", "few", "many", "other"] };
for (const [code, L] of Object.entries(App.locales)) {
  const t = L.t;
  const missing = Object.keys(en).filter((k) => !(k in t));
  const extra = Object.keys(t).filter((k) => !(k in en));
  if (missing.length || extra.length) { bad++; console.log(code, "missing:", missing, "extra:", extra); }
  for (const k of Object.keys(en)) {
    if (!(k in t)) continue;
    if (phSet(en[k]) !== phSet(t[k])) { bad++; console.log(code, "placeholder mismatch", k, phSet(en[k]), "vs", phSet(t[k])); }
    if ((typeof en[k] === "object") !== (typeof t[k] === "object")) { bad++; console.log(code, "plural shape", k); }
    if (typeof t[k] === "object") {
      if (!t[k].other) { bad++; console.log(code, "no other", k); }
      for (const f of ruleNeeds[code] || []) if (!t[k][f]) { bad++; console.log(code, "missing plural form", f, k); }
    }
    if (typeof t[k] === "string" && /\n/.test(en[k]) !== /\n/.test(t[k])) { bad++; console.log(code, "newline mismatch", k); }
  }
  if (!L.name || !L.tag) console.log(code, "no name/tag");
}
// keys used in code
const used = new Set();
const dyn = [];
for (const f of fs.readdirSync("ui/js").filter((x) => x.endsWith(".js"))) {
  const s = fs.readFileSync("ui/js/" + f, "utf8");
  for (const m of s.matchAll(/App\.t\(\s*"([^"]+)"/g)) used.add(m[1]);
  for (const m of s.matchAll(/App\.t\(\s*"([^"]+)"\s*\+/g)) dyn.push(m[1]);
  // keys referenced as strings in tables
  for (const m of s.matchAll(/"((?:src|pre)\.[A-Za-z]+)"/g)) used.add(m[1]);
}
const prefixes = ["sort.", "set.tab.", "wz.step.", "theme."];
for (const k of used) if (!(k in en)) { bad++; console.log("USED BUT MISSING in en:", k); }
for (const p of prefixes) for (const k of Object.keys(en)) if (k.startsWith(p)) used.add(k);
for (const k of Object.keys(en)) if (!used.has(k)) console.log("unused key (ok if indirect):", k);
// leftover Polish in code
const pl = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]|\b(Biblioteka|Eksport\w*|Gotowe|Dalej|Wstecz|Szukaj|Uruchom|Zmień|Wyczyść|klip\w*|Ustawienia|Zamknij)\b/;
for (const f of fs.readdirSync("ui/js").filter((x) => x.endsWith(".js"))) {
  fs.readFileSync("ui/js/" + f, "utf8").split("\n").forEach((line, i) => {
    if (pl.test(line) && !/^\s*(\/\/|\/\*|\*)/.test(line)) console.log("POLISH?", f + ":" + (i + 1), line.trim().slice(0, 110));
  });
}
console.log(bad ? "PROBLEMS: " + bad : "OK", Object.keys(App.locales).join(","));
