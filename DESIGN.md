# Buffer design language

What every new screen, popup or native window has to look like. The CSS in `ui/style.css` is the source of
the values; the native parts (recorder popups `overlay.rs`, mixer flyout `flyout.rs`, tray icons `tray.rs`)
copy them by hand, so a token changed here must be changed there too.

## The idea: "now" and "trail"
- **Lime `#c6f432` means now**: the playhead, the selection, the active item, the primary action, progress,
  what is playing right now. It is the only brand colour; nothing else is lime.
- **The past is the same lime, faded** (15-35 % opacity, `--trail: #c6f43233`) and offset to the left, like
  the tails of the logo's bars.
- Errors are `--rec: #ff4d4d` (native: `#ff5d5d`), warnings amber `#ffb454`. Never a second accent colour.

## The logo and the scan-line motif
- The logo is a play triangle made of horizontal **scan-lines** (bars with rounded ends), each with a faded
  tail on its left (`App.logo` in `core.js`). The small mark is 7 bars of 2 px, widths 5/9/13/17/13/9/5.
- The logo is **animated**: the bars grow in one after another (`barIn`, 0.26 s, 45 ms apart) and then ripple
  now and then (`barRipple`, 1 → 1.3 → 1 over 4.4 s, 385 ms apart). Native copies do the same
  (`flyout.rs: logo_bar_scale`).
- Something that **happens** (progress, a live signal level) is a **scan**: a row of short segments (8 px tall
  for progress, 3 px for a level meter; 2 px gaps, 1 px radius). Export and update progress, wizard steps, the
  mixer's level meters:
  - lit segments get brighter to the right (opacity ramp ~0.35-0.45 → 1),
  - the rest faint at ~0.08-0.1.
- A value the user **sets** (volume) is never a scan: a smooth 4 px line, full lime up to the value on a
  `--line` track, with a **playhead** marker: a thin upright bar (3 px, 4 px when held), text colour, with a
  2 px ring of the surface colour. Its live level, if any, is a thin scan just under the line. (A set value
  drawn as segments at trail opacity was tried in 2026-10: it stepped while dragging and the faded lime read
  as a darker green. The user rejected it.)
- Mouse wheel on such a value: 5 % per notch, snapped to the grid.
- Icons that are ours (tray speaker) are drawn as scan-lines too: 3 px bars with 1 px gaps on a 32 px grid
  (`flyout.rs: speaker_bars`). Inactive parts fade like tails instead of disappearing.

## Surfaces and type
- Tokens (Ink, the default; OLED and Slate override them):
  `--bg #0b0c0a  --panel #121410  --raised #1a1d16  --line #262a20  --text #eef0e6  --text2 #b7bdaa
   --muted #8e9484  --subtle #6f7566`; OLED: `#000 / #0a0b08 / #14160f / #20231a`.
  Neutrals are olive-tinted on purpose; don't use plain greys.
- Cards: `--panel`, 1 px `--line` border, 12-14 px radius. A selected / default card gets a lime-tinted border.
- Section captions: small caps, 600 weight, 11 px, letter-spacing .1em, `--muted` (`.cap`).
- Text: Instrument Sans; numbers, timings and status pills: JetBrains Mono. Native windows can't load the web
  fonts: Segoe UI and Cascadia Mono (Consolas before Windows 11) stand in.
- Chips: pill, 1 px border; "on" = lime border + lime text + `--acc-dim` fill.
- Toggles, segmented buttons (`.seg`), `.btn` / `.btn.acc` as in `style.css`; reuse `App.ui` (`srow`, `trow`).

## Motion
- Views and cards fade up (`fadeUp`, `cardIn`); a view switch is one lime-edged wipe.
- Native windows animate too: the mixer flyout slides 14 px towards its place and fades in (190 ms, ease-out
  cubic), fades out in 110 ms. Popups ("2a Signal") have their own spec in `overlay.rs`.
- `data-anim="off"` turns the app's motion off; keep new animations behind the same variables (`--a`, `--w`).

## Words
- Labels stay short; explanations go into a tooltip (`title`), not on the screen.
- Every string goes through `App.t()` / the recorder's `lang.rs`, in all 9 languages; `node scripts/check-i18n.js`.

## Native rendering notes (recorder)
- Draw into a 32-bit DIB: shapes anti-aliased in software (`Canvas` in `flyout.rs`), text and icons via GDI.
- A layered window gets its alpha at the end (opaque inside, anti-aliased round corners, premultiplied) and is
  shown with `UpdateLayeredWindow`; that is also how it fades.
- ClearType text on a layered window shows colour fringes: draw with ClearType, then grey the text rectangles
  (all our text colours are neutral).
