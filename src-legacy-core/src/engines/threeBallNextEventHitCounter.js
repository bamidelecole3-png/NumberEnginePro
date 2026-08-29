/**
 * 3-Ball Next Event Hit Counter.
 *
 * Scoring log for threeBallSeasonIntelligenceLab.js's Next Event
 * Leaderboard (badge.nextEventLeaderboard / badge.topColor), replacing
 * threeBallEntryHitCounter.js as 3SIL's scoring mechanism -- see the
 * Next Event Leaderboard's header comment in
 * threeBallSeasonIntelligenceLab.js for why the binary ENTER gate it
 * used to score was replaced.
 *
 * STRUCTURAL DIFFERENCE FROM threeBallEntryHitCounter.js: the old
 * counter only opened a watch when badge.enterNow was true, which is
 * exactly the "silent for hours" problem the leaderboard was built to
 * fix -- a scoring log gated on a rarely-true condition can't measure
 * much either. The leaderboard has a topColor every single cycle, so
 * this counter watches every cycle too: it is never idle waiting for a
 * gate to open. This is what makes accuracy "measurable from day one"
 * (per the operator's own framing) instead of only after the gate has
 * fired enough times to build a sample.
 *
 * MECHANICS (same watch/resolve shape as threeBallEntryHitCounter.js,
 * continuous instead of gated):
 *   - Every cycle, if no watch is currently pending, open a fresh watch
 *     on badge.topColor for up to WINDOW_DRAWS draws.
 *   - HIT as soon as a landed draw's threeBallColor matches the watched
 *     color.
 *   - MISS if WINDOW_DRAWS draws pass with no match.
 *   - While a watch is open, later cycles do not re-open a new one even
 *     if topColor changes mid-watch -- same single-slot-per-pick
 *     discipline as threeBallEntryHitCounter.js/entryHitCounter.js, so a
 *     leaderboard that keeps re-ranking every cycle doesn't inflate
 *     totalCalls by counting every cycle as a fresh call.
 *
 * WHY THIS NEEDS PERSISTENT LOGGING (not a pure recompute): same
 * reasoning as threeBallEntryHitCounter.js's own header -- a draw record
 * only stores its own threeBallColor outcome, not "what did the
 * leaderboard say the top color was going to be N draws ago." That
 * calling context only exists transiently in the live council cycle, so
 * it must be logged as it happens (via store.threeBallNextEventHitCounter)
 * and resolved against draws as they arrive.
 *
 * FIX 1 -- FULL-RANK SCORING (not just topColor): the leaderboard makes
 * a claim about all three colors' order, not just which one is #1, but
 * the original version of this counter only ever checked whether the
 * #1 pick happened to be right. That's a weaker, less falsifiable test
 * than what the engine is actually claiming. This version snapshots the
 * FULL ranked order (all 3 colors, in rank order) when a watch opens,
 * and on resolution records which rank position the color that actually
 * hit held in that snapshot -- so it's now possible to report, e.g.,
 * "the actual next color was leaderboard rank #1 62% of the time, rank
 * #2 the rest" -- validating the ranking itself, not just its top slot.
 * topColorPick's shape and meaning are UNCHANGED (still scores #1 only,
 * exactly as before) so every existing consumer of this module keeps
 * working unmodified; rankAccuracy is purely additive.
 *
 * FIX 2 -- CHANCE BASELINE: with 3 colors (HIERARCHY.length === 3), a
 * strategy that watched a color at random would land a hit within an
 * WINDOW_DRAWS-draw window MUCH more often than intuition suggests --
 * verified by both closed-form math and a 200,000-trial Monte Carlo
 * simulation during this fix: at WINDOW_DRAWS=8 and 3 roughly-equal
 * colors, an uninformed random pick clears the window (lands at least
 * once) ~96% of the time, not "1 in 3." This is because the watch only
 * needs ONE hit anywhere in 8 tries, not a hit on a specific draw -- so
 * a raw topColorPick.hitRatePct in the 90s is close to what pure chance
 * already produces in this window size, and is NOT on its own evidence
 * the leaderboard has skill. baselineHitRatePct computes this exact
 * figure via 1 - (1 - 1/N)^WINDOW_DRAWS (N = color count), so the
 * dashboard can show the real hit rate next to what an uninformed guess
 * achieves in the same window, instead of presenting the raw number
 * alone and letting it look far more impressive than it is.
 */

const WINDOW_DRAWS = 8; // same window as threeBallEntryHitCounter.js's WINDOW_DRAWS
const COLOR_COUNT = 3; // RED/BLUE/GREEN -- see src/core/colorMath.js's HIERARCHY

// See "FIX 2" above. Rounded to 1 decimal for display consistency with
// every other *Pct field this engine reports.
const BASELINE_HIT_RATE_PCT = Math.round((1 - Math.pow(1 - 1 / COLOR_COUNT, WINDOW_DRAWS)) * 1000) / 10;

function freshPickState() {
  return { hits: 0, misses: 0, pending: null };
}

/**
 * Advances a pending watch (if any) against the latest landed draw:
 * checks for a hit, increments drawsElapsed, and closes the watch out
 * (HIT or MISS) as appropriate. No-op if nothing is pending. Identical
 * to threeBallEntryHitCounter.js's resolvePendingWatch.
 */
function resolvePendingWatch(pick, latestDraw) {
  if (!pick.pending || !latestDraw) return;

  pick.pending.drawsElapsed++;
  const actualColor = latestDraw.threeBallColor || null;

  if (actualColor != null && actualColor === pick.pending.color) {
    pick.hits++;
    pick.pending = null;
    return;
  }

  if (pick.pending.drawsElapsed >= WINDOW_DRAWS) {
    pick.misses++;
    pick.pending = null;
  }
}

/**
 * Opens a new watch for the given pick slot if none is currently open.
 * No-op if a watch is already pending (continuation of the one already
 * being tracked) or if there's no color to watch.
 */
function openWatchIfIdle(pick, color, openedAfterDrawId) {
  if (pick.pending || !color) return false;
  pick.pending = { color, openedAfterDrawId, drawsElapsed: 0 };
  return true;
}

/**
 * FIX 1 support -- advances the full-rank watch (if any) against the
 * latest landed draw. Unlike resolvePendingWatch (which only cares
 * whether ITS ONE watched color hit), this checks the actual color
 * against every rank position in the snapshot taken when the watch
 * opened, and -- as soon as ANY color in the snapshot hits -- records
 * which rank that color held and closes the watch. This lets a "the
 * leaderboard called it, just not as #1" outcome be distinguished from
 * a genuine total miss, which topColorPick alone cannot do.
 *
 * rankState.byRank is keyed by 1-based rank position (as a string, for
 * clean JSON round-tripping): { "1": {hits, misses}, "2": {...}, "3": {...} }.
 * A resolution increments hits at whichever rank the landed color held
 * in the snapshot, and increments misses at every OTHER rank in that
 * same snapshot (each rank position is its own independent claim --
 * "the 2nd-ranked color will hit within the window" is a miss for rank
 * 2 specifically if a different ranked color hits instead, exactly the
 * same hit/miss discipline topColorPick already applies to rank 1
 * alone).  If WINDOW_DRAWS elapses with no match at all, every rank in
 * the snapshot is scored a miss.
 */
function resolveRankWatch(rankState, latestDraw) {
  if (!rankState.pending || !latestDraw) return;

  rankState.pending.drawsElapsed++;
  const actualColor = latestDraw.threeBallColor || null;
  const snapshot = rankState.pending.rankedColors; // e.g. ['RED','BLUE','GREEN'], index 0 = rank 1

  const hitIndex = actualColor != null ? snapshot.indexOf(actualColor) : -1;
  const timedOut = rankState.pending.drawsElapsed >= WINDOW_DRAWS;

  if (hitIndex === -1 && !timedOut) return; // still pending, nothing to score yet

  snapshot.forEach((color, i) => {
    const rank = String(i + 1);
    if (!rankState.byRank[rank]) rankState.byRank[rank] = { hits: 0, misses: 0 };
    if (i === hitIndex) {
      rankState.byRank[rank].hits++;
    } else {
      rankState.byRank[rank].misses++;
    }
  });

  rankState.pending = null;
}

/**
 * Opens a new full-rank watch if none is currently open. No-op if a
 * watch is already pending or if there's no ranked list to snapshot.
 * rankedColors is captured once, at open time, and never re-read while
 * the watch is pending -- same "one watch, resolved against what was
 * true when it opened" discipline as openWatchIfIdle.
 */
function openRankWatchIfIdle(rankState, rankedColors, openedAfterDrawId) {
  if (rankState.pending || !Array.isArray(rankedColors) || rankedColors.length === 0) return false;
  rankState.pending = { rankedColors: rankedColors.slice(), openedAfterDrawId, drawsElapsed: 0 };
  return true;
}

/**
 * Main entry point, called once per council cycle after 3SIL has run.
 * Order matters: resolve any existing pending watch against the latest
 * landed draw FIRST (dedup'd per draw via lastProcessedDrawId), then
 * open a fresh watch for this cycle's topColor -- so a brand-new watch
 * is never immediately graded against the very draw that created it.
 *
 * threeSIL is the full evaluateThreeBallSeasonIntelligenceLab() result:
 * badge.topColor supplies the color being watched, unconditionally
 * (no gate) every cycle 3SIL has produced a badge at all.
 * badge.nextEventLeaderboard (the full ranked array) supplies the
 * snapshot for the new full-rank watch.
 */
function evaluateThreeBallNextEventHitCounter(historicalDraws, threeSIL, persistentCounter) {
  const counter = persistentCounter && typeof persistentCounter === 'object' ? persistentCounter : {};
  if (!counter.topColorPick) counter.topColorPick = freshPickState();
  // FIX 1 -- see this module's header. Backward-compatible: an older
  // persisted counter simply won't have this field yet, so it's
  // initialized fresh here exactly like topColorPick already is above.
  if (!counter.rankWatch || typeof counter.rankWatch !== 'object') {
    counter.rankWatch = { pending: null, byRank: {} };
  }
  if (typeof counter.totalCalls !== 'number') counter.totalCalls = 0;

  const latestDraw = historicalDraws && historicalDraws[0];
  const drawId = latestDraw && latestDraw.drawId != null ? String(latestDraw.drawId) : null;

  if (drawId != null && counter.lastProcessedDrawId !== drawId) {
    resolvePendingWatch(counter.topColorPick, latestDraw);
    resolveRankWatch(counter.rankWatch, latestDraw);
    counter.lastProcessedDrawId = drawId;
  }

  const badge = threeSIL && threeSIL.badge ? threeSIL.badge : null;
  const topColor = badge ? badge.topColor : null;
  const rankedColors = badge && Array.isArray(badge.nextEventLeaderboard)
    ? badge.nextEventLeaderboard.map(r => r.color)
    : null;

  if (topColor) {
    const opened = openWatchIfIdle(counter.topColorPick, topColor, latestDraw ? latestDraw.drawId : null);
    if (opened) counter.totalCalls++;
  }
  // Opened independently of topColorPick's own totalCalls counter --
  // both watches open/close on the same cadence in practice (both keyed
  // off the same badge each cycle), but keeping them structurally
  // separate means a future change to one watch's opening condition
  // can't silently desync the other's counted total.
  if (rankedColors) {
    openRankWatchIfIdle(counter.rankWatch, rankedColors, latestDraw ? latestDraw.drawId : null);
  }

  counter.updatedAt = new Date().toISOString();

  const resolved = counter.topColorPick.hits + counter.topColorPick.misses;
  const hitRatePct = resolved > 0 ? Math.round((counter.topColorPick.hits / resolved) * 1000) / 10 : null;

  // FIX 1 -- per-rank breakdown for the dashboard/API. rankAccuracy[i]
  // corresponds to rank i+1 (1-indexed to match how the leaderboard
  // itself is displayed, "#1"/"#2"/"#3").
  const rankAccuracy = [1, 2, 3].map(rank => {
    const cell = counter.rankWatch.byRank[String(rank)] || { hits: 0, misses: 0 };
    const cellResolved = cell.hits + cell.misses;
    return {
      rank,
      hits: cell.hits,
      misses: cell.misses,
      hitRatePct: cellResolved > 0 ? Math.round((cell.hits / cellResolved) * 1000) / 10 : null
    };
  });

  return {
    engine: 'ThreeBallNextEventHitCounter',
    windowDraws: WINDOW_DRAWS,
    totalCalls: counter.totalCalls,
    // FIX 2 -- chance baseline for interpreting hitRatePct against.
    // Computed once at module load (WINDOW_DRAWS/COLOR_COUNT are both
    // constants), not per-call.
    baselineHitRatePct: BASELINE_HIT_RATE_PCT,
    topColorPick: {
      color: counter.topColorPick.pending ? counter.topColorPick.pending.color : null,
      hits: counter.topColorPick.hits,
      misses: counter.topColorPick.misses,
      hitRatePct,
      pending: Boolean(counter.topColorPick.pending),
      drawsElapsed: counter.topColorPick.pending ? counter.topColorPick.pending.drawsElapsed : 0
    },
    // FIX 1 -- full-ranking accuracy, additive to topColorPick above.
    rankAccuracy,
    reasoning: counter.totalCalls === 0
      ? 'No leaderboard call has been logged yet -- counter has nothing to report.'
      : `${counter.totalCalls} leaderboard call(s) so far. Top-ranked color: ${counter.topColorPick.hits} hit / ${counter.topColorPick.misses} missed` +
        (hitRatePct != null ? ` (${hitRatePct}% vs. ~${BASELINE_HIT_RATE_PCT}% expected by chance alone in an ${WINDOW_DRAWS}-draw window).` : '.')
  };
}

module.exports = {
  WINDOW_DRAWS,
  COLOR_COUNT,
  BASELINE_HIT_RATE_PCT,
  resolvePendingWatch,
  openWatchIfIdle,
  resolveRankWatch,
  openRankWatchIfIdle,
  evaluateThreeBallNextEventHitCounter
};
