/**
 * Tier Engine Overdue/Precursor Hit Counter.
 *
 * Direct structural port of threeBallEntryHitCounter.js (3SIL's own
 * ENTER-call scoring log) to the Tier Engine (tieEngine.js +
 * tiePrecursorPatternEngine.js). Before this, the Tier Engine's own
 * calls -- flagging a tie as OVERDUE (drawsUntilNextTie === 0) or
 * flagging a live PRECURSOR pattern (tiePrecursorPatterns.prediction.
 * unifiedSignal.active) -- were never scored against what actually
 * happened. Both fired every cycle their own gate was open, but nothing
 * logged "on draw #X the Tier Engine called OVERDUE/PRECURSOR," and
 * nothing later checked whether a tie actually landed. This closes that
 * gap exactly the way threeBallEntryHitCounter.js closes it for 3SIL.
 *
 * ONE KEY STRUCTURAL DIFFERENCE FROM threeBallEntryHitCounter.js: 3SIL's
 * ENTER call watches a specific CHALLENGER COLOR (a match/no-match
 * check). The Tier Engine's calls have no color to watch -- OVERDUE and
 * PRECURSOR are both just "a tie is imminent" calls, so the hit
 * condition is simply "did any of the next WINDOW_DRAWS draws land a
 * 3-ball tie" (isThreeBallTie(draw), tieEngine.js's own definition:
 * !draw.threeBallColor && !draw.fourBallColor). Otherwise this is a
 * single-slot watch exactly like 3SIL's challengerPick -- one call
 * counted at a time, not two independent ones for OVERDUE vs PRECURSOR
 * -- because both calls are the same underlying claim ("expect a tie
 * soon") and firing both in the same cycle should not double-count or
 * open two overlapping watches for what is, from the market's
 * perspective, a single outstanding claim. When both fire in the same
 * cycle, the call is logged as a combined 'OVERDUE+PRECURSOR' call.
 *
 * MECHANICS (identical to threeBallEntryHitCounter.js otherwise)
 * -------------------------------------------------------
 * Every cycle where the OVERDUE gate (tieP.drawsUntilNextTie === 0)
 * and/or the PRECURSOR gate (tiePrecursor.prediction.unifiedSignal.
 * active) is open, this counts as one "Tier call" (counted once per
 * fresh call -- while a call is already being watched, further cycles
 * with a gate still open are NOT re-counted, so a multi-draw OVERDUE
 * streak doesn't inflate totalCalls once per cycle).
 *
 * For each call, the next draws are watched for up to WINDOW_DRAWS
 * draws:
 *   - HIT  as soon as a draw lands a 3-ball tie (isThreeBallTie).
 *   - MISS if WINDOW_DRAWS draws pass with no tie.
 * Only one watch is ever open at a time -- a fresh call while a watch is
 * still pending is treated as a continuation, not a new call, same rule
 * as threeBallEntryHitCounter.js's single-slot-per-pick behavior.
 *
 * WHY THIS NEEDS PERSISTENT LOGGING (not a pure recompute): same
 * reasoning as threeBallEntryHitCounter.js's own header -- a draw record
 * only stores its own tie outcome, not "was the Tier Engine calling
 * OVERDUE/PRECURSOR on some earlier draw." That calling context only
 * exists transiently in the live council cycle, so it must be logged as
 * it happens (via store.tierOverduePrecursorHitCounter) and resolved
 * against draws as they arrive.
 */
const { isThreeBallTie } = require('./tieEngine');

const WINDOW_DRAWS = 8; // draws given for a HIT before a pending watch is marked a MISS -- matches 3SIL's own 8-draw window, per operator direction

function freshPickState() {
  return { hits: 0, misses: 0, pending: null };
}

/**
 * Advances a pending watch (if any) against the latest landed draw:
 * checks for a hit, increments drawsElapsed, and closes the watch out
 * (HIT or MISS) as appropriate. No-op if nothing is pending. Identical
 * to threeBallEntryHitCounter.js's resolvePendingWatch, checking for a
 * landed 3-ball tie instead of a color match.
 */
function resolvePendingWatch(pick, latestDraw) {
  if (!pick.pending || !latestDraw) return;

  pick.pending.drawsElapsed++;

  if (isThreeBallTie(latestDraw)) {
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
 * No-op if a watch is already pending (that call is treated as a
 * continuation of the one already being tracked).
 */
function openWatchIfIdle(pick, callType, openedAfterDrawId) {
  if (pick.pending || !callType) return false;
  pick.pending = { callType, openedAfterDrawId, drawsElapsed: 0 };
  return true;
}

/**
 * Main entry point, called once per council cycle after tieP (analyzeTies)
 * and tiePrecursor (evaluateTiePrecursorPatterns) have both run. Order
 * matters: resolve any existing pending watch against the latest landed
 * draw FIRST (dedup'd per draw via lastProcessedDrawId), then open a
 * fresh watch for this cycle's call -- so a brand-new watch is never
 * immediately graded against the very draw that created it.
 *
 * tieP is the full analyzeTies() result: drawsUntilNextTie === 0 is the
 * OVERDUE gate. tiePrecursor is the full evaluateTiePrecursorPatterns()
 * result: prediction.unifiedSignal.active is the PRECURSOR gate.
 */
function evaluateTierOverduePrecursorHitCounter(historicalDraws, tieP, tiePrecursor, persistentCounter) {
  const counter = persistentCounter && typeof persistentCounter === 'object' ? persistentCounter : {};
  if (!counter.tierCall) counter.tierCall = freshPickState();
  if (typeof counter.totalCalls !== 'number') counter.totalCalls = 0;

  const latestDraw = historicalDraws && historicalDraws[0];
  const drawId = latestDraw && latestDraw.drawId != null ? String(latestDraw.drawId) : null;

  if (drawId != null && counter.lastProcessedDrawId !== drawId) {
    resolvePendingWatch(counter.tierCall, latestDraw);
    counter.lastProcessedDrawId = drawId;
  }

  const overdueOpen = Boolean(tieP && tieP.drawsUntilNextTie === 0);
  const precursorOpen = Boolean(tiePrecursor && tiePrecursor.prediction && tiePrecursor.prediction.unifiedSignal && tiePrecursor.prediction.unifiedSignal.active);

  const activeTypes = [];
  if (overdueOpen) activeTypes.push('OVERDUE');
  if (precursorOpen) activeTypes.push('PRECURSOR');
  const callType = activeTypes.length > 0 ? activeTypes.join('+') : null;

  if (callType) {
    const opened = openWatchIfIdle(counter.tierCall, callType, latestDraw ? latestDraw.drawId : null);
    if (opened) counter.totalCalls++;
  }

  counter.updatedAt = new Date().toISOString();

  const resolved = counter.tierCall.hits + counter.tierCall.misses;

  return {
    engine: 'TierOverduePrecursorHitCounter',
    windowDraws: WINDOW_DRAWS,
    totalCalls: counter.totalCalls,
    tierCall: {
      callType: counter.tierCall.pending ? counter.tierCall.pending.callType : null,
      hits: counter.tierCall.hits,
      misses: counter.tierCall.misses,
      hitRatePct: resolved > 0 ? Math.round((counter.tierCall.hits / resolved) * 1000) / 10 : null,
      pending: Boolean(counter.tierCall.pending),
      drawsElapsed: counter.tierCall.pending ? counter.tierCall.pending.drawsElapsed : 0
    },
    reasoning: counter.totalCalls === 0
      ? 'No OVERDUE or PRECURSOR call has fired yet -- counter has nothing to report.'
      : `${counter.totalCalls} Tier call(s) so far (OVERDUE and/or PRECURSOR). ${counter.tierCall.hits} hit / ${counter.tierCall.misses} missed.`
  };
}

module.exports = {
  WINDOW_DRAWS,
  resolvePendingWatch,
  openWatchIfIdle,
  evaluateTierOverduePrecursorHitCounter
};
