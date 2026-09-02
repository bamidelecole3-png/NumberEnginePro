/**
 * 4-BALL TIE CLUSTER ENGINE
 *
 * Implements the "REPEATED TIE CLUSTER" directive: fourBallSeasonIntelligenceLab.js's
 * condition L (REPEATED_TIE_CLUSTER) fires when a genuine Tie -- using the
 * EXACT SAME tie rule as the 3-Ball Tie Engine (tieEngine.js's
 * isThreeBallTie: no color reached a real win, 3-ball OR 4-ball, that
 * draw) -- has landed twice within a short rolling window (which, at a
 * window of 5 draws, necessarily also catches two ties landing back-to-
 * back/consecutively, since that's just the tightest possible case of
 * "within the window").
 *
 * REVISION HISTORY / WHY THIS CHANGED: an earlier version of this file
 * required each qualifying tie to independently score >= 70 on
 * fourBallTieBirthEngine.js's composite tieBirthScore ("Strong Tie") before
 * it would count toward the cluster. That was diagnosed as too strict in
 * practice -- a real repeated-tie event that should have gated the
 * dashboard didn't, because the composite score (which factors in
 * freshness, tie TYPE, historical hit rate, and 4SIL's armed state) can
 * sit below 70 even for a perfectly genuine, no-clear-winner tie. Operator
 * direction: use the 3-Ball Tie Engine's own tie rule instead of a scored
 * threshold -- so this file no longer asks "how strong was this tie,"
 * only "was this draw a genuine tie at all" (tieEngine.js's own
 * isThreeBallTie, the same rule already trusted everywhere else in this
 * codebase for what a Tie IS). A draw with a clear 3-ball winner (e.g.
 * RED at exactly 3 with BLUE/GREEN both lower) is NOT a tie under this
 * rule and does not count -- but a draw where NO color reached a real win
 * (all counts below 3, or two colors tied at 3 with neither a clear
 * winner) DOES, matching tieEngine.js's own detectTie()/isThreeBallTie()
 * exactly. This is deliberately narrower than
 * fourBallTieBirthEngine.js's OWN tie definition (that engine's tie is
 * simply "no color reached 4," which is far more common and was never
 * meant to gate anything by itself -- see that file's header) and
 * narrower than the old score-gated "Strong Tie" concept -- it is exactly
 * tieEngine.js's tie rule, no more, no less.
 *
 * WHY THIS MUST BE STATEFUL (unlike a pure recompute): confirming "two
 * ties within a 5-draw window" requires remembering the draw ID of the
 * most recent qualifying tie across cycles, and a vote's 3-draw lifetime
 * requires remembering when the cluster confirmed. Follows this
 * codebase's own established pattern for exactly this kind of state --
 * see entryHitCounter.js's header and its lastProcessedDrawId dedup
 * convention, reused verbatim below to guarantee the dashboard's periodic
 * auto-refresh can never manufacture a second qualifying tie from the
 * same draw.
 *
 * SCOPE DISCIPLINE (unchanged from the prior version):
 *   - Does NOT touch Cascade/Response logic in any way (a separate file,
 *     fourBallResponseCascadeEngine.js, untouched).
 *   - Does NOT touch Transition Battle / Takeover / Last Stand / First
 *     Appearance / the standard gate / auto takeover burst / hard vetoes
 *     / cooldown / entry consumption (all untouched in
 *     fourBallSeasonIntelligenceLab.js).
 *   - Does NOT make Tie an independent ENTER route. The cluster's ONLY
 *     effect is supplying a `met` value for the EXISTING
 *     REPEATED_TIE_CLUSTER condition inside evaluateEnterNow()'s existing
 *     conditions[] array -- same weight, same slot, same downstream gate
 *     math as before. Any number of qualifying ties in the window still
 *     only ever contributes ONE condition's worth of weight (confirmation,
 *     not vote inflation).
 *
 * FIELD NAMES: kept as strongTieLog/strongTieCount/isStrongTieNow/etc.
 * throughout this file and its output, even though "strong" no longer
 * means "scored >= threshold" -- it now just means "a real,
 * tieEngine.js-qualifying tie." This is a deliberate compatibility
 * choice: council.js, fourSilUnifiedAuditLog.js, and the dashboard
 * (index.html) all read these exact field names, and renaming them here
 * would require touching three more files for a purely cosmetic gain.
 * strongTieThreshold is now always null (no score threshold exists
 * anymore) -- the dashboard already renders a null threshold as "--".
 *
 * historicalDraws is newest-first (index 0 = most recent), matching every
 * other engine's convention.
 */
'use strict';

const { isThreeBallTie, tieShape } = require('./tieEngine');

const TIE_CONFIRMATION_WINDOW = 5; // rolling window (in draws) two qualifying ties must both fall within -- also the window that makes back-to-back ("consecutive") ties trivially qualify, since a gap of 1 draw is well inside a window of 5
const TIE_VOTE_LIFETIME = 3; // draws a confirmed cluster's vote stays ACTIVE after confirmation
const TIE_CONFIDENCE_BASE = 75; // tieConfidence when exactly 2 qualifying ties confirm the cluster
const TIE_CONFIDENCE_BOOSTED = 85; // tieConfidence when a 3rd qualifying tie lands inside the same window

function freshClusterMemory() {
  return {
    schemaVersion: 1,
    lastProcessedDrawId: null,
    // Every qualifying tie observed, most-recent-first, capped below --
    // this IS the de-duplicated "unique draw IDs" ledger.
    strongTieLog: [],
    // The currently active (or most recently active) confirmed cluster,
    // or null. Tracks its own expiry independently of strongTieLog so an
    // expired vote can be reported honestly even after the log has moved
    // on.
    activeCluster: null,
    updatedAt: null
  };
}

const MAX_LOG_ENTRIES = 500;
function pushCapped(log, entry) {
  log.unshift(entry);
  if (log.length > MAX_LOG_ENTRIES) log.length = MAX_LOG_ENTRIES;
}

function ensureMemoryShape(persistentMemory) {
  const m = persistentMemory && typeof persistentMemory === 'object' ? persistentMemory : {};
  if (!Array.isArray(m.strongTieLog)) m.strongTieLog = [];
  if (typeof m.lastProcessedDrawId === 'undefined') m.lastProcessedDrawId = null;
  if (typeof m.activeCluster === 'undefined') m.activeCluster = null;
  if (typeof m.schemaVersion === 'undefined') m.schemaVersion = 1;
  return m;
}

/**
 * isStrongTie: the single source of truth for what counts as a
 * qualifying tie. Deliberately just tieEngine.js's own isThreeBallTie
 * rule applied to the actual draw record -- no score threshold, no
 * dependency on fourBallTieBirthEngine.js's (broader) tie definition or
 * its composite score. Kept as the SAME EXPORTED NAME as before
 * (isStrongTie) for compatibility -- see the file header's FIELD NAMES
 * note.
 */
function isStrongTie(draw) {
  return isThreeBallTie(draw);
}

/**
 * Records this cycle's qualifying-tie observation (if the most recent
 * draw IS one) into the persistent log, deduplicated by drawId so the
 * dashboard's periodic auto-refresh polling this same cycle's data
 * repeatedly can never log the same tie twice. tieBirthReading is
 * optional context ONLY (captures fourBallTieBirthEngine.js's
 * tieBirthScore/tieType for the log entry's own informational value) --
 * it plays no role in deciding whether this draw qualifies.
 */
function recordStrongTieIfNew(memory, latestDraw, tieBirthReading) {
  const drawId = latestDraw && latestDraw.drawId != null ? String(latestDraw.drawId) : null;
  if (drawId == null) return; // no draw identity to dedup against -- refuse to log
  if (memory.lastProcessedDrawId === drawId) return; // already processed this exact draw -- a refresh, not a new draw

  memory.lastProcessedDrawId = drawId;

  if (isStrongTie(latestDraw)) {
    pushCapped(memory.strongTieLog, {
      drawId,
      tieType: tieShape(latestDraw), // tieEngine.js's own descriptive shape text -- the true source of truth for what this tie looked like
      tieScore: tieBirthReading ? tieBirthReading.tieBirthScore : null, // informational only, not a qualification gate
      recordedAt: new Date().toISOString()
    });
  }
}

/**
 * Qualifying ties still inside the confirmation window, mapped by looking
 * up each logged tie's drawId against its position in the CURRENT
 * historicalDraws array (0 = most recent). Only entries within the first
 * `windowDraws` positions count.
 */
function strongTiesInWindow(memory, historicalDraws, windowDraws = TIE_CONFIRMATION_WINDOW) {
  const drawIndexById = new Map();
  historicalDraws.slice(0, windowDraws).forEach((d, idx) => {
    if (d && d.drawId != null) drawIndexById.set(String(d.drawId), idx);
  });

  const inWindow = [];
  for (const entry of memory.strongTieLog) {
    const idx = drawIndexById.get(entry.drawId);
    if (idx != null) {
      inWindow.push({ ...entry, drawsAgo: idx });
    }
  }
  return inWindow.sort((a, b) => a.drawsAgo - b.drawsAgo); // most recent first
}

/**
 * Main entry point, called once per council cycle -- BEFORE 4SIL's own
 * evaluateEnterNow(), so its output can feed condition L. `tieBirthReading`
 * is fourBallTieBirthEngine.js's result for THIS cycle -- passed through
 * only for informational log context now (see recordStrongTieIfNew); the
 * actual tie/no-tie determination for THIS draw uses tieEngine.js's rule
 * directly via isStrongTie(latestDraw).
 */
function evaluateFourBallTieCluster(historicalDraws, tieBirthReading, persistentMemory) {
  const memory = ensureMemoryShape(persistentMemory);
  const draws = historicalDraws || [];
  const latestDraw = draws[0] || null;

  recordStrongTieIfNew(memory, latestDraw, tieBirthReading);

  const inWindow = strongTiesInWindow(memory, draws, TIE_CONFIRMATION_WINDOW);
  const strongTieCount = inWindow.length;
  const clusterConfirmedNow = strongTieCount >= 2;

  // The vote must EXPIRE after TIE_VOTE_LIFETIME draws, requiring a fresh
  // pair to reactivate -- tracked independently via
  // memory.activeCluster.confirmedAtDrawId, not simply re-derived from
  // "are 2+ still in window" every cycle (which would let an old
  // confirmation silently persist for the full 5-draw window instead of
  // its own shorter 3-draw vote lifetime).
  if (clusterConfirmedNow) {
    const alreadyTrackingThisPair = memory.activeCluster &&
      memory.activeCluster.confirmingDrawIds &&
      memory.activeCluster.confirmingDrawIds[0] === inWindow[0].drawId &&
      memory.activeCluster.confirmingDrawIds[1] === inWindow[1].drawId;
    if (!alreadyTrackingThisPair) {
      // A NEW confirming pair (the most recent qualifying tie is one we
      // haven't already confirmed a cluster around) -- open a fresh vote.
      memory.activeCluster = {
        confirmedAtDrawId: latestDraw ? String(latestDraw.drawId) : null,
        confirmingDrawIds: [inWindow[0].drawId, inWindow[1].drawId],
        strongTieCountAtConfirmation: strongTieCount
      };
    } else {
      // Same pair still standing (e.g. a 3rd qualifying tie landed, or
      // simply re-evaluated this cycle without a new qualifying tie) --
      // refresh the count for the confidence boost below without
      // resetting the vote's age/expiry.
      memory.activeCluster.strongTieCountAtConfirmation = strongTieCount;
    }
  }

  // Vote age/expiry, measured in draws since confirmedAtDrawId.
  let voteAgeDraws = null;
  let voteActive = false;
  let voteExpired = false;
  if (memory.activeCluster && memory.activeCluster.confirmedAtDrawId != null && latestDraw) {
    const confirmIdx = draws.findIndex(d => d && String(d.drawId) === memory.activeCluster.confirmedAtDrawId);
    voteAgeDraws = confirmIdx >= 0 ? confirmIdx : null;
    if (voteAgeDraws != null) {
      voteActive = voteAgeDraws < TIE_VOTE_LIFETIME;
      voteExpired = !voteActive;
    }
  }

  // Confidence boost for a 3rd qualifying tie inside the SAME window,
  // without turning it into a second vote.
  const tieConfidence = !voteActive
    ? 0
    : (strongTieCount >= 3 ? TIE_CONFIDENCE_BOOSTED : TIE_CONFIDENCE_BASE);

  // State machine label.
  let tieClusterState = 'NO_TIE';
  if (voteActive) {
    tieClusterState = 'TIE_VOTE_ACTIVE';
  } else if (memory.activeCluster && voteExpired) {
    tieClusterState = 'TIE_VOTE_EXPIRED';
  } else if (strongTieCount === 1) {
    tieClusterState = 'TIE_WATCH';
  } else if (isStrongTie(latestDraw)) {
    tieClusterState = 'STRONG_TIE';
  }

  memory.updatedAt = new Date().toISOString();

  const lastStrongTieDraw = inWindow[0] ? inWindow[0].drawId : null;
  const previousStrongTieDraw = inWindow[1] ? inWindow[1].drawId : null;

  const reasoning = voteActive
    ? `TIE VOTE ACTIVE: ${strongTieCount} qualifying tie(s) (3-Ball Tie Engine rule) confirmed within the ${TIE_CONFIRMATION_WINDOW}-draw window (draws ${memory.activeCluster.confirmingDrawIds.join(', ')}), vote age ${voteAgeDraws} draw(s), expires after ${TIE_VOTE_LIFETIME} draws, confidence ${tieConfidence}.`
    : (voteExpired
      ? `Tie vote EXPIRED (was confirmed ${voteAgeDraws} draws ago, lifetime is ${TIE_VOTE_LIFETIME} draws) -- a fresh pair of qualifying ties is required to reactivate.`
      : (strongTieCount === 1
        ? `Only 1 qualifying tie in the last ${TIE_CONFIRMATION_WINDOW} draws (draw ${lastStrongTieDraw}, shape "${inWindow[0].tieType}") -- watching for a second within the window.`
        : 'No qualifying-tie evidence currently active.'));

  return {
    engine: '4-Ball Tie Cluster Engine',
    strongTieThreshold: null, // no score threshold anymore -- qualification is tieEngine.js's isThreeBallTie rule, not a scored cutoff
    confirmationWindowDraws: TIE_CONFIRMATION_WINDOW,
    voteLifetimeDraws: TIE_VOTE_LIFETIME,
    isStrongTieNow: isStrongTie(latestDraw),
    strongTieCount,
    strongTiesInWindow: inWindow,
    lastStrongTieDraw,
    previousStrongTieDraw,
    tieClusterState,
    tieClusterConfirmed: clusterConfirmedNow,
    tieVoteActive: voteActive,
    tieVoteExpired: voteExpired,
    tieVoteAgeDraws: voteAgeDraws,
    tieVoteExpiryInDraws: voteActive ? Math.max(0, TIE_VOTE_LIFETIME - voteAgeDraws) : null,
    tieConfidence,
    reasoning
  };
}

module.exports = {
  TIE_CONFIRMATION_WINDOW,
  TIE_VOTE_LIFETIME,
  TIE_CONFIDENCE_BASE,
  TIE_CONFIDENCE_BOOSTED,
  freshClusterMemory,
  ensureMemoryShape,
  isStrongTie,
  evaluateFourBallTieCluster
};
