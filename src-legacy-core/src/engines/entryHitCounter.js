/**
 * Entry Hit Counter.
 *
 * REPLACES the Entry Accuracy Ladder (entryAccuracyLadder.js), which
 * tracked ENTER/STRIKE calls as an array of individually-timestamped
 * "rungs" with a 10-draw resolution window each. That structure proved
 * opaque in practice -- removed entirely per operator direction in favor
 * of a small set of plain running totals that are trivial to verify by
 * eye against the raw draw history.
 *
 * MECHANICS
 * ---------
 * Every cycle where 4SIL's ENTER gate is open (badge.enterNow) and the
 * 4-Ball Parliament is active, this counts as one "ENTER call" (counted
 * once per fresh call -- while a call is already being watched, further
 * cycles with the gate still open are NOT re-counted, so a season-long
 * ENTER streak doesn't inflate totalEnterCalls once per cycle).
 *
 * For each call, the 1st-pick color (fourBallP.winningColor) and 2nd-pick
 * color (fourBallP.secondColor) are watched independently for up to
 * WINDOW_DRAWS draws:
 *   - HIT  as soon as that draw's real fourBallColor matches the watched
 *          color.
 *   - MISS if WINDOW_DRAWS draws pass with no match.
 * Only one watch per pick slot is ever open at a time -- a fresh ENTER
 * call while a watch is still pending is treated as a continuation, not
 * a new call, exactly like the ladder's "one open rung per color" rule,
 * just simplified to one slot per pick instead of one slot per color.
 *
 * WHY THIS NEEDS PERSISTENT LOGGING (not a pure recompute): same
 * reasoning as entryConditionScorecard.js's own log -- a draw record only
 * stores its own fourBallColor outcome, not "was 4SIL calling ENTER on
 * some earlier draw, and for which colors." That calling context only
 * exists transiently in the live council cycle, so it must be logged as
 * it happens (via store.entryHitCounter) and resolved against draws as
 * they arrive.
 */

const WINDOW_DRAWS = 10; // draws given for a HIT before a pending watch is marked a MISS

function freshPickState() {
  return { hits: 0, misses: 0, pending: null };
}

/**
 * Advances a pending watch (if any) against the latest landed draw:
 * checks for a hit, increments drawsElapsed, and closes the watch out
 * (HIT or MISS) as appropriate. No-op if nothing is pending.
 */
function resolvePendingWatch(pick, latestDraw) {
  if (!pick.pending || !latestDraw) return;

  pick.pending.drawsElapsed++;
  const actualColor = latestDraw.fourBallColor || null;

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
 * No-op if a watch is already pending (that ENTER call is treated as a
 * continuation of the one already being tracked) or if there's no color
 * to watch.
 */
function openWatchIfIdle(pick, color, openedAfterDrawId) {
  if (pick.pending || !color) return false;
  pick.pending = { color, openedAfterDrawId, drawsElapsed: 0 };
  return true;
}

/**
 * Main entry point, called once per council cycle after 4SIL has run.
 * Order matters: resolve any existing pending watches against the latest
 * landed draw FIRST (dedup'd per draw via lastProcessedDrawId), then open
 * fresh watches for this cycle's ENTER call -- so a brand-new watch is
 * never immediately graded against the very draw that created it.
 */
function evaluateEntryHitCounter(historicalDraws, fourBallP, fourSIL, persistentCounter) {
  const counter = persistentCounter && typeof persistentCounter === 'object' ? persistentCounter : {};
  if (!counter.firstPick) counter.firstPick = freshPickState();
  if (!counter.secondPick) counter.secondPick = freshPickState();
  if (typeof counter.totalEnterCalls !== 'number') counter.totalEnterCalls = 0;

  const latestDraw = historicalDraws && historicalDraws[0];
  const drawId = latestDraw && latestDraw.drawId != null ? String(latestDraw.drawId) : null;

  if (drawId != null && counter.lastProcessedDrawId !== drawId) {
    resolvePendingWatch(counter.firstPick, latestDraw);
    resolvePendingWatch(counter.secondPick, latestDraw);
    counter.lastProcessedDrawId = drawId;
  }

  const gateOpen = Boolean(fourSIL && fourSIL.badge && fourSIL.badge.enterNow);
  if (gateOpen && fourBallP && fourBallP.active) {
    const openedFirst = openWatchIfIdle(counter.firstPick, fourBallP.winningColor, latestDraw ? latestDraw.drawId : null);
    const openedSecond = openWatchIfIdle(counter.secondPick, fourBallP.secondColor, latestDraw ? latestDraw.drawId : null);
    if (openedFirst || openedSecond) counter.totalEnterCalls++;
  }

  counter.updatedAt = new Date().toISOString();

  const firstResolved = counter.firstPick.hits + counter.firstPick.misses;
  const secondResolved = counter.secondPick.hits + counter.secondPick.misses;

  return {
    engine: 'EntryHitCounter',
    windowDraws: WINDOW_DRAWS,
    totalEnterCalls: counter.totalEnterCalls,
    firstPick: {
      color: counter.firstPick.pending ? counter.firstPick.pending.color : null,
      hits: counter.firstPick.hits,
      misses: counter.firstPick.misses,
      hitRatePct: firstResolved > 0 ? Math.round((counter.firstPick.hits / firstResolved) * 1000) / 10 : null,
      pending: Boolean(counter.firstPick.pending),
      drawsElapsed: counter.firstPick.pending ? counter.firstPick.pending.drawsElapsed : 0
    },
    secondPick: {
      color: counter.secondPick.pending ? counter.secondPick.pending.color : null,
      hits: counter.secondPick.hits,
      misses: counter.secondPick.misses,
      hitRatePct: secondResolved > 0 ? Math.round((counter.secondPick.hits / secondResolved) * 1000) / 10 : null,
      pending: Boolean(counter.secondPick.pending),
      drawsElapsed: counter.secondPick.pending ? counter.secondPick.pending.drawsElapsed : 0
    },
    reasoning: counter.totalEnterCalls === 0
      ? 'No ENTER call has fired yet -- counter has nothing to report.'
      : `${counter.totalEnterCalls} ENTER call(s) so far. 1st pick: ${counter.firstPick.hits} hit / ${counter.firstPick.misses} missed. 2nd pick: ${counter.secondPick.hits} hit / ${counter.secondPick.misses} missed.`
  };
}

module.exports = {
  WINDOW_DRAWS,
  resolvePendingWatch,
  openWatchIfIdle,
  evaluateEntryHitCounter
};
