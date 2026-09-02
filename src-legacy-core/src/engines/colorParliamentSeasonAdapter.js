/**
 * Color Parliament Season/Archive Adapter.
 *
 * fourBallLastStandCP.js (a byte-for-byte port of Color Parliament's
 * fourBallLastStand.js) needs an `archiveState` built by
 * strategicEngineCP.js's wake()/recordHit()/closeSeason() -- a persistent
 * season leaderboard that Sniper V4's own architecture doesn't otherwise
 * maintain (Sniper V4 recomputes its 4-ball season view fresh on every
 * call via tacticalEngine.js's `reconstructedSeasonAge`, a different and
 * NOT equivalent model -- see the port notes in README.md).
 *
 * To keep fourBallLastStandCP.js's actual logic and output byte-for-byte
 * faithful to the original Color Parliament project, this module does NOT
 * try to adapt that engine to Sniper V4's season model. Instead it
 * replays Sniper V4's own draw history through Color Parliament's EXACT
 * original season activation/termination rules (ported unmodified below
 * from tacticalEngine.js) and EXACT original archive logic
 * (strategicEngineCP.js, byte-for-byte, unmodified), incrementally,
 * draw-by-draw -- exactly the sequence Color Parliament's own engine.js
 * runs on every real-time ingest. The result is an archiveState that
 * behaves identically to what the original project would have produced
 * had it processed this same draw sequence.
 *
 * This is intentionally recomputed from scratch on every call (Sniper V4
 * has no other hook to run this incrementally on ingest without touching
 * its core pipeline, which was out of scope for this port). For very long
 * draw histories this is O(n) per call, same order of cost as the rest of
 * this codebase's own "recompute fresh every call" engines (see
 * rareEventLabEngine.js's own header comment for the same tradeoff
 * elsewhere in this project).
 */
'use strict';

const strategic = require('./strategicEngineCP');

// ─── Ported unmodified from Color Parliament's tacticalEngine.js ──────────
// "HARDCODED, do not modify" per that file's own header comment -- kept
// verbatim here for the same reason, since these two constants and
// functions are what the archive's wake/close timing must match exactly.
const SEASON_ACTIVATION_WINDOW = 10;
const SEASON_TERMINATION_STREAK = 15;

function evaluateActivation(draws) {
  if (!draws || draws.length === 0) {
    return { active: false, triggerDrawId: null, triggerIndex: null };
  }
  const windowStart = Math.max(0, draws.length - SEASON_ACTIVATION_WINDOW);
  const window = draws.slice(windowStart);
  for (let i = window.length - 1; i >= 0; i--) {
    if (window[i].color) {
      return {
        active: true,
        triggerDrawId: window[i].drawId,
        triggerIndex: windowStart + i
      };
    }
  }
  return { active: false, triggerDrawId: null, triggerIndex: null };
}

function evaluateTermination(draws) {
  let count = 0;
  for (let i = draws.length - 1; i >= 0; i--) {
    if (draws[i].color) break;
    count += 1;
  }
  return {
    shouldTerminate: count >= SEASON_TERMINATION_STREAK,
    consecutiveNoHitCount: count
  };
}

/**
 * Converts one Sniper V4 historicalDraws entry into the {drawId, color,
 * timestamp, matchCount} shape Color Parliament's engines expect.
 * `color` = the 4-ball color for this draw, or null if none.
 * `matchCount` = the real same-color ball count (4/5/6), feeding
 * strategicEngineCP.js's hitWeight() exactly as it does in the original
 * project -- Sniper V4's validator.js already computes this in
 * `colorCounts`, so this is a real value, not a fabricated default.
 */
function toColorParliamentDraw(sniperDraw) {
  const color = sniperDraw.fourBallColor || null;
  const matchCount = (color && sniperDraw.colorCounts) ? (sniperDraw.colorCounts[color] || null) : null;
  return {
    drawId: sniperDraw.drawId,
    color,
    timestamp: sniperDraw.timestamp || null,
    matchCount
  };
}

/**
 * Replays the full draw history through Color Parliament's exact season
 * activation/termination/archive rules and returns the resulting
 * archiveState, ready to pass into fourBallLastStandCP.computeFourBallLastStand().
 *
 * @param {Array} historicalDraws - store.historicalDraws (Sniper V4's own
 *   shape, NEWEST-FIRST -- see core/store.js's addDraw(), which unshifts).
 * @returns {{ archiveState: Object, seasonStatus: 'ACTIVE'|'INACTIVE', cpDraws: Array }}
 *   cpDraws is the oldest-first, Color-Parliament-shaped draw list, handed
 *   back so the caller can pass the SAME array into
 *   fourBallLastStandCP.computeFourBallLastStand(draws, archiveState) --
 *   that engine also expects oldest-first, matching the original project.
 */
function replaySeasonAndArchive(historicalDraws) {
  // Sniper V4 stores newest-first; every Color Parliament engine ported
  // here (including this adapter's own activation/termination rules,
  // copied verbatim above) assumes oldest-first, exactly like the
  // original project's own state.draws. Reverse once, up front.
  const cpDraws = (historicalDraws || []).slice().reverse().map(toColorParliamentDraw);

  const season = {
    status: 'INACTIVE',
    activatedAtDrawId: null,
    consecutiveNoHitCount: 0
  };
  const archiveState = {
    awake: false,
    seasonId: null,
    leaderboard: {},
    dominantColor: null,
    history: [],
    _hitSeq: 0
  };

  // Incrementally replay draw-by-draw, mirroring engine.js's
  // processSeasonRules() exactly: activation check (if inactive) or
  // termination check (if active) using the draws SEEN SO FAR, then
  // wake/recordHit on this draw if a season is active and it has a color.
  for (let i = 0; i < cpDraws.length; i++) {
    const drawsSoFar = cpDraws.slice(0, i + 1);
    const draw = cpDraws[i];

    if (season.status === 'INACTIVE') {
      const activation = evaluateActivation(drawsSoFar);
      if (activation.active) {
        season.status = 'ACTIVE';
        season.activatedAtDrawId = activation.triggerDrawId;
        season.consecutiveNoHitCount = 0;
      }
    } else {
      const termination = evaluateTermination(drawsSoFar);
      season.consecutiveNoHitCount = termination.consecutiveNoHitCount;
      if (termination.shouldTerminate) {
        strategic.closeSeason(archiveState, draw.drawId);
        season.status = 'INACTIVE';
        season.activatedAtDrawId = null;
        season.consecutiveNoHitCount = 0;
        // Same draw cannot also (re)activate the season in this same
        // iteration -- matches engine.js's processSeasonRules(), which
        // `return`s immediately after closing a season rather than
        // falling through to the wake/recordHit check below.
        continue;
      }
    }

    if (season.status === 'ACTIVE' && draw.color) {
      if (!archiveState.awake) {
        strategic.wake(archiveState, season.activatedAtDrawId, draw);
      } else {
        strategic.recordHit(archiveState, draw);
      }
    }
  }

  return { archiveState, seasonStatus: season.status, cpDraws };
}

module.exports = {
  replaySeasonAndArchive,
  // exported for direct reuse/testing -- these are the exact same
  // activation/termination rules threeBallLastStandCP.js's season-less
  // 3-ball counterpart doesn't need, but are exposed here in case a
  // future caller wants Color Parliament's raw season status without the
  // full archive replay.
  evaluateActivation,
  evaluateTermination
};
