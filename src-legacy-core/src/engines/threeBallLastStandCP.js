'use strict';
/**
 * threeBallLastStand.js  v1.0.0 (COLOR LAB port)
 *
 * 3-Color Last Stand Engine — ported from COLOR WIZARD's threeBallLastStand.js
 * to operate on COLOR LAB's 3-ball draw format:
 *   draws = [{ drawId, color: string|null, timestamp }]  (oldest-first)
 *
 * SOURCE OF TRUTH: reuses the same momentum and ranking logic as COLOR LAB's
 * threeBallEngine.js — computing per-color strength from the continuous 3-ball
 * stream and re-labelling those numbers into the same battle-status vocabulary
 * (LEADER_DEFENDING / LEADER_WEAKENING / LAST_STAND / TRANSITION_BATTLE /
 * LEADER_COLLAPSING) so the dashboard can display a live Last Stand alert.
 *
 * DIFFERENCE FROM THE 4-BALL ENGINE: The 4-ball engine gates on a discrete
 * ACTIVE/INACTIVE season boundary. The 3-ball stream is continuous (no season
 * concept, per threeBallEngine.js), so this engine is active whenever there is
 * enough draw history to compute a ranked leader — exactly as the existing
 * 3-ball prediction already assumes.
 *
 * There is no "ballsBeforeExit" countdown here (that requires a learned
 * season-age model). Instead the live leader/challenger strength gap is
 * reported as the honest analog of urgency.
 */

const MOMENTUM_LOOKBACK = 12;
const MOMENTUM_DECAY    = 0.85;

// ─── Helpers (local copies — keeps this module self-contained) ────────────────
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Decay-weighted momentum for a single color over the last `lookback` draws.
 * In COLOR LAB's 3-ball stream a draw carries a color when any 3-ball event
 * occurred, or null otherwise.
 */
function computeColorMomentum(draws, lookback, decay) {
  const recent = draws.slice(-lookback);
  const scores = {};
  let weight = 1;
  let totalWeight = 0;

  for (let i = recent.length - 1; i >= 0; i--) {
    const d = recent[i];
    if (d && d.color) {
      scores[d.color] = (scores[d.color] || 0) + weight;
    }
    totalWeight += weight;
    weight *= decay;
  }

  const normalized = {};
  for (const color of Object.keys(scores)) {
    normalized[color] = totalWeight > 0 ? scores[color] / totalWeight : 0;
  }
  return normalized;
}

/**
 * Returns a ranked array of { color, seasonScore } for all colors observed
 * in the draw history, plus momentum-velocity and fatigue labels — these are
 * the signals the battle-status classifier needs.
 */
function computeColorRanking(draws) {
  const lookback  = MOMENTUM_LOOKBACK;
  const decay     = MOMENTUM_DECAY;

  const recentMomentum = computeColorMomentum(draws, lookback, decay);

  // Velocity: compare the most-recent 5-draw window vs the prior 5-draw window
  const recent5 = computeColorMomentum(draws, 5, decay);
  const prior5  = computeColorMomentum(draws.slice(0, Math.max(0, draws.length - 5)), 5, decay);

  const allColors = Object.keys(recentMomentum);
  if (allColors.length === 0) return [];

  return allColors.map(color => {
    const score   = Math.round(clamp((recentMomentum[color] || 0) * 100, 0, 100));
    const r5      = recent5[color]  || 0;
    const p5      = prior5[color]   || 0;
    const delta   = r5 - p5;

    let momentumVelocity;
    if      (delta >  0.08) momentumVelocity = 'Accelerating';
    else if (delta >  0.02) momentumVelocity = 'Growing';
    else if (delta < -0.08) momentumVelocity = 'Collapsing';
    else if (delta < -0.02) momentumVelocity = 'Declining';
    else                    momentumVelocity = 'Stable';

    // Simple fatigue proxy: how long since this color last appeared?
    let gapSinceLast = 0;
    for (let i = draws.length - 1; i >= 0; i--) {
      if (draws[i] && draws[i].color === color) break;
      gapSinceLast++;
    }
    const fatigueIndex = gapSinceLast >= lookback ? 'Exhausted'
                       : gapSinceLast >= Math.round(lookback * 0.6) ? 'Aging'
                       : 'Active';

    // Season-end probability analog: combination of velocity collapse + fatigue
    const sep = fatigueIndex === 'Exhausted' ? 70
              : fatigueIndex === 'Aging'     ? 40
              : momentumVelocity === 'Collapsing' ? 55
              : 15;

    return { color, seasonScore: score, momentumVelocity, fatigueIndex, seasonEndProbability: sep, recent5Score: r5 };
  }).sort((a, b) => b.seasonScore - a.seasonScore);
}

// ─── Battle-status vocabulary ─────────────────────────────────────────────────
function battleStatusFromSignals({ leaderVelocity, leaderFatigue, challengerAheadOfLeader, challengerClosing }) {
  if (challengerAheadOfLeader)                                                    return 'LEADER_COLLAPSING';
  if (challengerClosing)                                                          return 'TRANSITION_BATTLE';
  if (leaderVelocity === 'Collapsing' || leaderFatigue === 'Exhausted')          return 'LAST_STAND';
  if (leaderVelocity === 'Declining'  || leaderFatigue === 'Aging')              return 'LEADER_WEAKENING';
  return 'LEADER_DEFENDING';
}

function takeProfitWindowFromStatus(status) {
  if (status === 'LEADER_COLLAPSING')                    return 'CLOSED';
  if (status === 'LAST_STAND' || status === 'TRANSITION_BATTLE') return 'OPEN';
  return 'N/A';
}

function battleRecommendationFromStatus(status) {
  switch (status) {
    case 'LEADER_COLLAPSING':  return 'EXIT IMMEDIATELY';
    case 'LAST_STAND':         return 'ONE FINAL ENTRY';
    case 'TRANSITION_BATTLE':  return 'PREPARE EXIT';
    case 'LEADER_WEAKENING':   return 'REDUCE EXPOSURE';
    default:                   return 'CONTINUE HOLDING';
  }
}

function emptyBattle(reason) {
  return {
    active:               false,
    leader:               null,
    challenger:           null,
    leaderStrength:       0,
    challengerStrength:   0,
    battleStatus:         'NO_SIGNAL',
    lastStandProbability: 0,
    takeProfitWindow:     'N/A',
    recommendation:       'WAIT',
    reasoning:            reason,
  };
}

// ─── Core battle computation ──────────────────────────────────────────────────
/**
 * 3-Color equivalent of computeTransitionBattle (4-ball).
 * @param {Array} draws - COLOR LAB 3-ball draw archive (oldest-first)
 */
function computeThreeBallBattle(draws) {
  if (!draws || draws.length < 5) {
    return emptyBattle('Not enough 3-ball draw history yet.');
  }

  const ranked = computeColorRanking(draws);
  if (ranked.length === 0) return emptyBattle('3-Ball engine has no signal yet.');

  const leaderEntry     = ranked[0];
  const challengerEntry = ranked[1] || null;

  const leaderStrength     = Math.round(clamp(leaderEntry.seasonScore,                             0, 100));
  const challengerStrength = challengerEntry ? Math.round(clamp(challengerEntry.seasonScore, 0, 100)) : 0;

  // NOTE: ranked[] is sorted descending by seasonScore (the 12-draw window),
  // so challengerStrength can never exceed leaderStrength by construction --
  // comparing those two directly here would make this branch unreachable.
  // Instead compare the shorter 5-draw recency window (recent5Score), which
  // is NOT what ranked[] is sorted by and can legitimately show the
  // challenger pulling ahead of the leader on more recent draws even though
  // the leader still holds the longer-window lead.
  const challengerAheadOfLeader = !!(challengerEntry
    && challengerEntry.recent5Score > leaderEntry.recent5Score);

  // "Closing in": within 10 pts AND accelerating
  const challengerClosing = !!challengerEntry
    && !challengerAheadOfLeader
    && (leaderStrength - challengerStrength) <= 10
    && challengerEntry.momentumVelocity === 'Accelerating';

  const status = battleStatusFromSignals({
    leaderVelocity:        leaderEntry.momentumVelocity,
    leaderFatigue:         leaderEntry.fatigueIndex,
    challengerAheadOfLeader,
    challengerClosing,
  });

  const lastStandProbability = Math.round(clamp(
    (leaderEntry.seasonEndProbability || 0) * 0.6 + (100 - leaderStrength) * 0.4,
    0, 100
  ));

  return {
    active:               true,
    leader:               leaderEntry.color,
    challenger:           challengerEntry ? challengerEntry.color : null,
    leaderStrength,
    challengerStrength,
    battleStatus:         status,
    lastStandProbability,
    takeProfitWindow:     takeProfitWindowFromStatus(status),
    recommendation:       battleRecommendationFromStatus(status),
    reasoning:            `3-Color: ${leaderEntry.color.toUpperCase()} (${leaderStrength}%) vs ${challengerEntry ? challengerEntry.color.toUpperCase() : 'no challenger'} (${challengerStrength}%). Status: ${status.replace(/_/g, ' ')}.`,
  };
}

// ─── Alert derivation ─────────────────────────────────────────────────────────
/**
 * Produces the alert-level badge for the dashboard card.
 * Reports `leadGap` (leader vs challenger strength gap) in place of the
 * 4-ball engine's learned "ballsBeforeExit" countdown.
 */
function deriveThreeBallAlert(battle) {
  if (!battle.active) {
    return { alertLevel: 'GRAY', headline: 'ASLEEP', actionText: battle.reasoning, leadGap: 0 };
  }

  const leader     = (battle.leader     || 'Leader').toUpperCase();
  const challenger = battle.challenger  ? battle.challenger.toUpperCase() : 'the challenger';
  const gap        = Math.max(0, battle.leaderStrength - battle.challengerStrength);

  let alert;
  switch (battle.battleStatus) {
    case 'LEADER_COLLAPSING':
      alert = {
        alertLevel: 'RED',
        headline:   '🔴 EXIT IMMEDIATELY',
        actionText: `${leader} is collapsing and ${challenger} is taking over on the 3-ball stream now. EXIT — do not wait for confirmation.`,
      };
      break;
    case 'LAST_STAND':
      alert = {
        alertLevel: 'RED',
        headline:   '🔴 LAST STAND',
        actionText: `${leader} may be firing its final 3-ball shot before exit (only ${gap} pt${gap === 1 ? '' : 's'} of lead left). ENTER to take profit on this final push, then exit.`,
      };
      break;
    case 'TRANSITION_BATTLE':
      alert = {
        alertLevel: 'ORANGE',
        headline:   '🟠 TRANSITION BATTLE',
        actionText: `${challenger} is closing in on ${leader} on the 3-ball stream (~${gap} pt${gap === 1 ? '' : 's'} of lead left). Take profit on any hit now — do not open new positions.`,
      };
      break;
    case 'LEADER_WEAKENING':
      alert = {
        alertLevel: 'GOLD',
        headline:   '🟡 WEAKENING',
        actionText: `${leader} is losing momentum on the 3-ball stream. Reduce exposure.`,
      };
      break;
    default:
      alert = {
        alertLevel: 'GREEN',
        headline:   '🟢 DEFENDING',
        actionText: `${leader} is holding its lead on the 3-ball stream. Continue holding.`,
      };
  }

  return { ...alert, leadGap: gap };
}

// ─── Convenience wrapper ──────────────────────────────────────────────────────
/**
 * Full 3-Color Last Stand payload in one call.
 * Merges battle + alert into a single object mirroring the shape used by
 * COLOR WIZARD's enrichedBattle.
 * @param {Array} draws - COLOR LAB 3-ball draw archive (oldest-first)
 */
function computeThreeBallLastStand(draws) {
  const battle = computeThreeBallBattle(draws);
  const alert  = deriveThreeBallAlert(battle);
  return {
    ...battle,
    ...alert,
    lastStandActive: battle.battleStatus === 'LAST_STAND',
  };
}

module.exports = {
  computeColorRanking,
  computeThreeBallBattle,
  deriveThreeBallAlert,
  computeThreeBallLastStand,
  battleStatusFromSignals,
  takeProfitWindowFromStatus,
  battleRecommendationFromStatus,
};
