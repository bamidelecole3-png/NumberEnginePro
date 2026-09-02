# Hero Card Trim + 3SIL Flat-Color Changelog

Single file changed: `public/index.html`.

## What changed

**1. Hero card — removed "Supreme Council" text and "TARGET" label,
trimmed to fit.**

- Removed the `TARGET` caption above the predicted-color bulb
  (`.hero-call-label` div) — the bulb's own color + label already
  communicate the call without a redundant caption above it.
- Removed the `<p id="predReasoning">` line entirely ("Supreme Council
  arbitrated decision favoring RED based on regime-weighted coalition
  consensus.") along with the JS call that populated it
  (`setColorizedText('predReasoning', ...)` in `updateUI()`).
- Removed the two now-dead CSS classes (`.hero-call-label`,
  `.hero-call-reasoning`) and simplified `.hero-call-zone`/
  `.hero-call-bulb-slot` so the remaining row (bulb, action tag, type
  tag, based-on-draw tag, confidence gauge) sits centered and tight
  instead of leaving the vertical space the label/reasoning used to
  occupy.
- `colorizeColorWords()`/`setColorizedText()` are left in place
  (unused, since their only caller was the removed reasoning line) —
  genuinely reusable if generated prose needs this treatment elsewhere
  later, per this codebase's own convention of not deleting working
  logic just because its current caller went away.

**2. 3SIL Next Event band — only the #1-ranked color keeps the bulb
effect; everything else in the band is flat colored text.**

- Added a new `.sil3-color-flat` CSS class: bold, tinted to the
  color's own `--color-red`/`--color-blue`/`--color-green` variable,
  deliberately with **no** background, border, glow, or shadow —
  distinct from both `.inline-color-word` (which adds a text-shadow
  glow) and the `.badge.bg-COLOR` pills (boxed) used elsewhere.
- `renderThreeSIL()`: the leaderboard list (`#tb3SILLeaderboardList`,
  all 3 ranked colors) now renders each color with `.sil3-color-flat`
  instead of the old `.badge bg-${color}` pill. `#tb3SILDominantColor`
  now also gets `.sil3-color-flat` (previously plain, uncolored text).
- `#tb3SILTopColor` (the leaderboard's #1 pick, shown as the headline
  element of the band) is **unchanged** — still renders via the shared
  `.color-bulb bulb-${color}` component, the same glow/bulb treatment
  used by the hero card's predicted color and the 4-Ball dual-pick.
  This is the one element in the band that keeps the effect, per
  instruction.

## What did NOT change

- The 4-Ball dual-pick (`fourBallFirstPill`/`fourBallSecondPill` in the
  hero card's detail zone) already renders both colors as bold glowing
  bulbs via the existing `setPill()` function — this already satisfied
  "both colors shown boldly, not flat, in their own color" before this
  change, so nothing needed fixing there.
- No backend/engine files were touched. This is a pure `public/index.html`
  presentation change — the underlying data
  (`threeBallSeasonIntelligenceLab.js`, `council.js`, etc.) is untouched.

## Verification performed

- Full-file sweep confirmed zero remaining visible "Supreme Council"
  text, zero remaining `TARGET` label markup, zero remaining
  `.hero-call-label`/`.hero-call-reasoning` CSS references, and zero
  remaining `.badge bg-COLOR` pill usage inside the 3SIL leaderboard
  render path.
- `<div>`/`</div>` balance confirmed unchanged relative to the
  original file's own pre-existing baseline (both off by the same
  one, consistent with removing exactly one balanced div pair — no
  new imbalance introduced).
- `<script>` tag balance confirmed intact (1 open, 1 close).
- Full server boot test: started the real server, fetched the served
  `index.html`, confirmed the new markers (`tb3SILTopColor`,
  `sil3-color-flat`, `hero-call-bulb-slot`) are present and the removed
  ones (`hero-call-label`, literal `TARGET` text) are fully absent.
- Hit the live `/api/snapshot` endpoint and confirmed the response
  shape (`badge.topColor`, `badge.dominantColor`,
  `badge.nextEventLeaderboard`) matches exactly what the updated
  `renderThreeSIL()` expects, so the new rendering logic has real data
  to consume, not just markup that looks right in isolation.

---

## Follow-up correction (round 2)

The first pass left two things not matching the actual request:

1. **4-Ball dual-pick colors were still bulbs, not colored text.** The
   `.color-bulb` component is dominated by a large glowing emoji, with
   the color word itself as a small secondary caption underneath — not
   "RED written in red text." Fixed: `fourBallFirstPill`/
   `fourBallSecondPill` now render as large, bold, flat colored text
   (`.color-flat-text.large`, new CSS) via a new `setFlatColorText()`
   helper — RED in red, BLUE in blue, GREEN in green, no bulb/emoji/box.
   `setPill()` is kept, now used only by the hero card's own headline
   predicted-color bulb (`predColorBulb`), which was never in scope for
   this change.

2. **3SIL's non-top entries were flat but still colored.** Round 1 made
   them flat text but kept the per-color tint. The actual request was
   flat AND uncolored — small, muted, plain text. Fixed: the leaderboard
   list (`#tb3SILLeaderboardList`) and Dominant Color
   (`#tb3SILDominantColor`) now use a new `.color-flat-muted` class
   (small, `var(--text-dim)`, no color-specific tint at all) instead of
   the colored `.sil3-color-flat` class from round 1, which was removed.
   `#tb3SILTopColor` is unchanged — still the one element in this band
   carrying the bulb effect.

Verified via a full server boot test: fetched the served HTML, confirmed
`color-flat-text`/`color-flat-muted` are present in the markup/CSS and
zero `color-bulb` markup remains on the dual-pick elements; confirmed
the live `/api/snapshot` response shape (`officialPredictions.next4Ball
.color`/`.secondColor`) matches exactly what the new
`setFlatColorText()` call sites expect.

---

## Follow-up correction (round 3) — bulb removed entirely

Per operator direction ("if the bulb is posing a problem, remove it"),
the `.color-bulb` component is now fully retired from every live
prediction display, not just the 4-Ball dual-pick:

- **Hero card headline call** (`predColorBulb`): now renders via
  `.color-flat-text.xlarge` (large bold flat colored text) instead of
  the glowing bulb. This is the single most prominent call on the page,
  so it gets the largest size (`xlarge`, 30px) of any flat-text element.
- **3SIL top color** (`tb3SILTopColor`): now renders via
  `.color-flat-text.large` instead of the bulb. Still the one element
  in the 3SIL Next Event band that reads as bold/prominent — everything
  else in that band (leaderboard ranks #2/#3, Dominant Color) stays on
  `.color-flat-muted` (small, uncolored) from round 2, unchanged.
- `setPill()` (the bulb-rendering helper) is removed entirely — it had
  zero remaining callers once both its use sites moved to
  `setFlatColorText()`. `setFlatColorText()` now takes an optional
  `sizeClass` parameter (`'large'` default, `'xlarge'` for the hero
  headline) so one function serves all three prediction displays.
- The `.color-bulb` CSS block itself is left in the stylesheet, fully
  unused by any live markup or JS, rather than deleted — consistent
  with this codebase's convention of keeping retired-but-working code
  in place. Its header comment was rewritten to say plainly that it's
  retired and why, so a future reader doesn't mistake it for something
  still driving the page.

Verified via a full server boot test: fetched the served HTML and
confirmed `predColorBulb` renders as `<span ... class="color-flat-text
xlarge color-RED">RED</span>` and `tb3SILTopColor` as `<span ...
class="color-flat-text large">--</span>` (no color class at cold start,
correctly falling back), confirmed zero live `class="color-bulb"` usage
anywhere in the served markup (the only match left is inside an HTML
comment documenting the retired component, not live code), and
confirmed `<span>`/`<div>`/`<script>` tag balance is intact.
