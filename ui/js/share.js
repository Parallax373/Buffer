"use strict";
/* Share codes: a preset or an effect as one line of text someone can paste into their own Buffer (a chat message, a
   forum post). "BUF-<KIND>1." + base64url(deflate-raw(JSON)). Nothing leaves the PC: the code is the whole thing.
   Kinds: FX (an RGB effect: its layers), EQ (an EQ preset: its bands). */

(function () {
  const PRE = (kind) => "BUF-" + kind + "1.";
  const b64u = (bytes) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const unb64u = (s) => { const t = atob(s.replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(t, (c) => c.charCodeAt(0)); };
  async function pipe(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); }

  /** the code for a value */
  async function encode(kind, value) {
    return PRE(kind) + b64u(await pipe(new TextEncoder().encode(JSON.stringify(value)), new CompressionStream("deflate-raw")));
  }
  /** the value in a code of this kind, or null (another kind, a cut-off paste, rubbish) */
  async function decode(kind, code) {
    const s = String(code || "").trim().replace(/\s+/g, "");
    if (!s.startsWith(PRE(kind))) return null;
    try { return JSON.parse(new TextDecoder().decode(await pipe(unb64u(s.slice(PRE(kind).length)), new DecompressionStream("deflate-raw")))); } catch (_) { return null; }
  }
  /** copies text; falls back to selecting it in `field` when the clipboard is refused */
  async function copy(text, field) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) { if (field) { field.value = text; field.select(); } return false; }
  }

  App.share = { encode, decode, copy };
})();
