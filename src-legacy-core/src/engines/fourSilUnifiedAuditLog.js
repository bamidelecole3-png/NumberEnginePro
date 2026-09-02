/**
 * 4SIL UNIFIED PER-EVENT AUDIT LOG
 *
 * Implements the 4SIL Upgrade Blueprint's §21 unified audit log: ONE
 * record per real draw, cross-referencing every engine's reading for
 * that draw in a single place -- drawId, tieScore, cascadeState,
 * transitionState, final4SILState, and enterSignal.
 *
 * WHY THIS IS NOT strongTieLog: fourBallTieClusterEngine.js's
 * strongTieLog (see that file's header) is a narrower, purpose-built
 * ledger that exists ONLY to let the Tie Cluster Engine confirm "two
 * DISTINCT Strong Ties within a rolling window" across cycles -- it only
 * ever logs a genuine tie (tieEngine.js's isThreeBallTie rule), and
 * only carries the four fields that vote-confirmation logic needs
 * (drawId, tieType, tieScore, recordedAt). It was never meant to be a
 * general audit trail, and using it as one would mean silently losing
 * every draw that wasn't itself a Strong Tie -- exactly the gap this
 * file closes. This log records EVERY real draw's engine state, whether
 * or not a Tie happened that cycle, with full cross-engine context.
 *
 * WHY THIS MUST BE STATEFUL (unlike a pure recompute): the whole point
 * is a historical trail an operator or a later performance-audit pass
 * can walk back through -- "what did every engine say on draw X" -- so
 * it has to persist across cycles and survive restarts, same reasoning
 * as fourBallSILMemory / fourBallTieClusterMemory (see those files'
 * headers). Follows this codebase's own established persistent-log
 * pattern exactly: a capped, most-recent-first array in store.js, saved/
 * restored by persistence.js, deduplicated by drawId via a
 * lastProcessedDrawId guard so the dashboard's periodic auto-refresh can
 * never manufacture duplicate entries for the same draw (same convention
 * as entryHitCounter.js / fourBallTieClusterEngine.js).
 *
 * SCOPE DISCIPLINE: this module computes NOTHING new. It is a read-only
 * observer that reaches into this cycle's already-computed engine
 * outputs (4SIL's own result, the Tie-Birth reading, the Tie Cluster
 * reading) and records a snapshot. It never influences enterNow, never
 * writes back into any other engine's state, and never runs before
 * those engines have all produced their output for the cycle -- call it
 * LAST, after 4SIL, from council.js.
 *
 * historicalDraws is newest-first (index 0 = most recent), matching
 * every other engine's convention.
 */
'use strict';

const MAX_LOG_ENTRIES = 500;

function freshAuditLogMemory() {
  return {
    schemaVersion: 1,
    lastProcessedDrawId: null,
    entries: [],
    updatedAt: null
  };
}

function ensureMemoryShape(persistentMemory) {
  const m = persistentMemory && typeof persistentMemory === 'object' ? persistentMemory : {};
  if (!Array.isArray(m.entries)) m.entries = [];
  if (typeof m.lastProcessedDrawId === 'undefined') m.lastProcessedDrawId = null;
  if (typeof m.schemaVersion === 'undefined') m.schemaVersion = 1;
  return m;
}

/**
 * cascadeState: a single-label summary of fourSIL.responseCascade, since
 * that engine itself only exposes the two underlying booleans
 * (repeatNonTop.active / dualNonTopFire.active) without a combined label
 * -- derived here for the log entry, not a new detector. Mirrors the
 * engine's own reasoning-string logic (see fourBallResponseCascadeEngine.js)
 * so the label always agrees with the reasoning text an operator would
 * read alongside it.
 */
function deriveCascadeState(responseCascade) {
  if (!responseCascade || !responseCascade.ready) return 'NOT_READY';
  const repeat = !!(responseCascade.repeatNonTop && responseCascade.repeatNonTop.active);
  const dual = !!(responseCascade.dualNonTopFire && responseCascade.dualNonTopFire.active);
  if (repeat && dual) return 'REPEAT_AND_DUAL';
  if (repeat) return 'REPEAT_NON_TOP';
  if (dual) return 'DUAL_NON_TOP';
  return 'NONE';
}

/**
 * Records ONE unified entry for the latest real draw, if it hasn't
 * already been recorded (dedup by drawId, same convention as
 * fourBallTieClusterEngine.js's recordStrongTieIfNew). Call once per
 * council cycle, after 4SIL/Tie-Birth/Tie-Cluster have all produced
 * their output for this cycle.
 *
 * @param {object} persistentMemory - store.fourSilUnifiedAuditLog, mutated in place
 * @param {Array} historicalDraws - newest-first draw history
 * @param {object} fourSIL - this cycle's evaluateFourBallSeasonIntelligenceLab() result
 * @param {object} tieBirthReading - this cycle's evaluateFourBallTieBirth() result
 * @param {object} tieClusterResult - this cycle's evaluateFourBallTieCluster() result
 * @returns {object} { recorded: boolean, entry: object|null, reason: string }
 */
function recordUnifiedAuditEntry(persistentMemory, historicalDraws, fourSIL, tieBirthReading, tieClusterResult) {
  const memory = ensureMemoryShape(persistentMemory);
  const draws = historicalDraws || [];
  const latestDraw = draws[0] || null;

  const drawId = latestDraw && latestDraw.drawId != null ? String(latestDraw.drawId) : null;
  if (drawId == null) {
    return { recorded: false, entry: null, reason: 'No real drawId to anchor this entry to -- refusing to log.' };
  }
  if (memory.lastProcessedDrawId === drawId) {
    return { recorded: false, entry: null, reason: 'Draw already recorded this cycle (dashboard refresh, not a new draw).' };
  }
  memory.lastProcessedDrawId = drawId;

  const active = !!(fourSIL && fourSIL.active);
  const badge = (fourSIL && fourSIL.badge) || {};
  const responseCascade = (fourSIL && fourSIL.responseCascade) || null;

  const entry = {
    drawId,
    timestamp: new Date().toISOString(),
    // tieScore: fourBallTieBirthEngine.js's tieBirthScore for THIS draw
    // (0-100, or null if not a qualifying Tie / engine not ready).
    tieScore: (tieBirthReading && tieBirthReading.ready && typeof tieBirthReading.tieBirthScore === 'number')
      ? tieBirthReading.tieBirthScore
      : null,
    tieType: (tieBirthReading && tieBirthReading.ready && tieBirthReading.currentTie)
      ? tieBirthReading.currentTie.tieType
      : null,
    isStrongTie: !!(tieClusterResult && tieClusterResult.isStrongTieNow),
    // cascadeState: see deriveCascadeState() above.
    cascadeState: deriveCascadeState(responseCascade),
    // transitionState: 4SIL's own existing transition battle status label
    // (INACTIVE / TRANSITION_BATTLE / LEADER_COLLAPSING / etc.) -- reused
    // verbatim from badge.transitionBattleStatus, not recomputed.
    transitionState: active ? (badge.transitionBattleStatus || 'INACTIVE') : 'INACTIVE',
    // final4SILState: 4SIL's own existing operator-facing verb
    // (ENTER NOW / PREPARE / MONITOR), reused verbatim from
    // badge.operatorAction.
    final4SILState: active ? (badge.operatorAction || 'MONITOR') : 'INACTIVE',
    // enterSignal: the actual gate boolean this cycle, reused verbatim
    // from badge.enterNow -- the single source of truth every other
    // engine (Entry Hit Counter, Entry Accuracy, etc.) already reads.
    enterSignal: active ? !!badge.enterNow : false,
    // tieClusterState: the Tie Cluster Engine's own state-machine label
    // for this cycle (NO_TIE / TIE_WATCH / STRONG_TIE / TIE_VOTE_ACTIVE /
    // TIE_VOTE_EXPIRED), included for cross-reference since a Tie's
    // effect on enterSignal (condition L) flows entirely through that
    // engine's vote, not tieScore directly.
    tieClusterState: (tieClusterResult && tieClusterResult.tieClusterState) || 'NO_TIE'
  };

  memory.entries.unshift(entry);
  if (memory.entries.length > MAX_LOG_ENTRIES) memory.entries.length = MAX_LOG_ENTRIES;
  memory.updatedAt = entry.timestamp;

  return { recorded: true, entry, reason: 'Recorded.' };
}

module.exports = {
  MAX_LOG_ENTRIES,
  freshAuditLogMemory,
  ensureMemoryShape,
  deriveCascadeState,
  recordUnifiedAuditEntry
};
