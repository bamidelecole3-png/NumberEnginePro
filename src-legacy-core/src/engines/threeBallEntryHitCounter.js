/**
 * 3-Ball Entry Hit Counter.
 *
 * Direct structural port of entryHitCounter.js (4SIL's ENTER-call
 * scoring log) to the 3-ball market, driven by 3SIL
 * (threeBallSeasonIntelligenceLab.js) instead of 4SIL. Before this,
 * 3SIL's ENTER NOW calls were never scored against what actually
 * happened -- badge.enterNow fired every cycle the gate was open, but
 * nothing logged "on draw #X 3SIL called ENTER on color Y," nothing
 * later checked whether that specific call turned out right, and 3SIL
 * reported no accuracy of its own. This closes that gap exactly the way
 * entryHitCounter.js closes it for 4SIL.
 *
 * ONE KEY STRUCTURAL DIFFERENCE FROM entryHitCounter.js: 4SIL's ENTER
 * call watches TWO independent picks (fourBallP.winningColor and
 * fourBallP.secondColor), because the 4-Ball Parliament always produces
 * a 1st and 2nd pick. 3SIL's ENTER NOW call is about a single takeover
 * shape -- the challenger color in the active transition battle
 * (threeSIL.transitionBattle.challenger) -- and there is no 3SIL
 * equivalent of a "2nd pick." Introducing a fake second slot just to
 * match 4SIL's shape would log a pick 3SIL never actually made, so this
 * engine watches exactly one pick per call instead of two.
 *
 * MECHANICS (identical to entryHitCounter.js otherwise)
 * -------------------------------------------------------
 * Every cycle where 3SIL's ENTER gate is open (badge.enterNow) and there
 * is a challenger color to watch (transitionBattle.challenger), this
 * counts as one "ENTER call" (counted once per fresh call -- while a
 * call is already being watched, further cycles with the gate still
 * open are NOT re-counted, so a season-long ENTER streak doesn't inflate
 * totalEnterCalls once per cycle).
 *
 * For each call, the challenger color is watched for up to WINDOW_DRAWS
 * draws:
 *   - HIT  as soon as that draw's real threeBallColor matches the
 *          watched color.
 *   - MISS if WINDOW_DRAWS draws pass with no match.
 * Only one watch is ever open at a time -- a fresh ENTER call while a
 * watch is still pending is treated as a continuation, not a new call,
 * same rule as entryHitCounter.js's single-slot-per-pick behavior.
 *
 * WHY THIS NEEDS PERSISTENT LOGGING (not a pure recompute): same
 * reasoning as entryHitCounter.js's own header -- a draw record only
 * stores its own threeBallColor outcome, not "was 3SIL calling ENTER on
 * some earlier draw, and for which color." That calling context only
 * exists transiently in the live council cycle, so it must be logged as
 * it happens (via store.threeBallEntryHitCounter) and resolved against
 * draws as they arrive.
 */

const WINDOW_DRAWS = 8; // draws given for a HIT before a pending watch is marked a MISS -- 8, not 4SIL's 10, per operator direction

function freshPickState() {
  return { hits: 0, misses: 0, pending: null };
}

/**
 * Advances a pending watch (if any) against the latest landed draw:
 * checks for a hit, increments drawsElapsed, and closes the watch out
 * (HIT or MISS) as appropriate. No-op if nothing is pending. Identical
 * to entryHitCounter.js's resolvePendingWatch, checking threeBallColor
 * instead of fourBallColor.
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
 * Main entry point, called once per council cycle after 3SIL has run.
 * Order matters: resolve any existing pending watch against the latest
 * landed draw FIRST (dedup'd per draw via lastProcessedDrawId), then
 * open a fresh watch for this cycle's ENTER call -- so a brand-new watch
 * is never immediately graded against the very draw that created it.
 *
 * threeSIL is the full evaluateThreeBallSeasonIntelligenceLab() result:
 * badge.enterNow gates whether a call fires, transitionBattle.challenger
 * supplies the color being called.
 */
function evaluateThreeBallEntryHitCounter(historicalDraws, threeSIL, persistentCounter) {
  const counter = persistentCounter && typeof persistentCounter === 'object' ? persistentCounter : {};
  if (!counter.challengerPick) counter.challengerPick = freshPickState();
  if (typeof counter.totalEnterCalls !== 'number') counter.totalEnterCalls = 0;

  const latestDraw = historicalDraws && historicalDraws[0];
  const drawId = latestDraw && latestDraw.drawId != null ? String(latestDraw.drawId) : null;

  if (drawId != null && counter.lastProcessedDrawId !== drawId) {
    resolvePendingWatch(counter.challengerPick, latestDraw);
    counter.lastProcessedDrawId = drawId;
  }

  const gateOpen = Boolean(threeSIL && threeSIL.badge && threeSIL.badge.enterNow);
  const challengerColor = threeSIL && threeSIL.transitionBattle ? threeSIL.transitionBattle.challenger : null;
  if (gateOpen && challengerColor) {
    const opened = openWatchIfIdle(counter.challengerPick, challengerColor, latestDraw ? latestDraw.drawId : null);
    if (opened) counter.totalEnterCalls++;
  }

  counter.updatedAt = new Date().toISOString();

  const resolved = counter.challengerPick.hits + counter.challengerPick.misses;

  return {
    engine: 'ThreeBallEntryHitCounter',
    windowDraws: WINDOW_DRAWS,
    totalEnterCalls: counter.totalEnterCalls,
    challengerPick: {
      color: counter.challengerPick.pending ? counter.challengerPick.pending.color : null,
      hits: counter.challengerPick.hits,
      misses: counter.challengerPick.misses,
      hitRatePct: resolved > 0 ? Math.round((counter.challengerPick.hits / resolved) * 1000) / 10 : null,
      pending: Boolean(counter.challengerPick.pending),
      drawsElapsed: counter.challengerPick.pending ? counter.challengerPick.pending.drawsElapsed : 0
    },
    reasoning: counter.totalEnterCalls === 0
      ? 'No ENTER call has fired yet -- counter has nothing to report.'
      : `${counter.totalEnterCalls} ENTER call(s) so far. Challenger pick: ${counter.challengerPick.hits} hit / ${counter.challengerPick.misses} missed.`
  };
}

module.exports = {
  WINDOW_DRAWS,
  resolvePendingWatch,
  openWatchIfIdle,
  evaluateThreeBallEntryHitCounter
};
