'use strict';
/**
 * fourBallLastStand.js  v1.0.0
 *
 * 4-Color Last Stand Engine — 4-ball counterpart to threeBallLastStand.js.
 *
 * Mirrors threeBallLastStand.js EXACTLY in battle-status vocabulary
 * and computation approach, with three 4-ball-specific adaptations:
 *
 *   1. SEASON GATE: Only active when a 4-ball season is ACTIVE
 *      (archiveState.awake === true, matching tacticalEngine's rolling
 *      10-draw rule). Returns emptyBattle when the season is INACTIVE.
 *
 *   2. COLOR SCORES: The 3-ball engine derives seasonScore purely from
 *      continuous draw-stream momentum. The 4-ball engine blends that
 *      momentum with the archive leaderboard's accumulated weighted hit
 *      count (which accounts for 4-of-6 / 5-of-6 / 6-of-6 match strength),
 *      making the dominant-color read stable against single-draw flips.
 *
 *   3. ballsBeforeExit: Estimated archive hits remaining before the current
 *      leader's season ends, derived from completed-season history.
 *      Replaces the 3-ball engine's `leadGap` as the urgency signal in the
 *      alert text.
 *
 * Input:
 *   draws       — state.draws (full 4-ball stream, oldest-first).
 *                 draw.color is non-null only when a 4BALL event occurred.
 *   archiveState — state.archive (strategicEngine's persistent leaderboard).
 *
 * Output shape: identical to computeThreeBallLastStand() plus ballsBeforeExit:
 *   { active, leader, challenger, leaderStrength, challengerStrength,
 *     battleStatus, lastStandProbability, takeProfitWindow, recommendation,
 *     reasoning, alertLevel, headline, actionText, ballsBeforeExit,
 *     lastStandActive }
 */

const MOMENTUM_LOOKBACK = 12;
const MOMENTUM_DECAY    = 0.85;

// Archive vs momentum blend:
// The archive (season leaderboard) is the ground truth for 4-ball dominance.
// Momentum captures the live short-term directional shift.
// 4-ball events are sparse — a single event can swing pure momentum by more
// than it should — so the archive deserves the majority weight.
const ARCHIVE_BLEND   = 0.55;
const MOMENTUM_BLEND  = 0.45;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ─── Momentum (same decay math as threeBallLastStand) ────────────────────────

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

// ─── Color ranking: archive leaderboard blended with draw-stream momentum ────

/**
 * Returns a ranked array of { color, seasonScore, momentumVelocity,
 * fatigueIndex, seasonEndProbability, recent5Score } sorted descending by
 * seasonScore — same shape as threeBallLastStand.computeColorRanking().
 *
 * seasonScore = ARCHIVE_BLEND × normalised archive hits
 *             + MOMENTUM_BLEND × decay-weighted momentum.
 *
 * Falls back to pure momentum if archiveState is not awake.
 */
function computeColorRanking(draws, archiveState) {
  const recentMomentum = computeColorMomentum(draws, MOMENTUM_LOOKBACK, MOMENTUM_DECAY);
  const recent5 = computeColorMomentum(draws, 5, MOMENTUM_DECAY);
  const prior5  = computeColorMomentum(
    draws.slice(0, Math.max(0, draws.length - 5)), 5, MOMENTUM_DECAY
  );

  const board = (archiveState && archiveState.awake && archiveState.leaderboard)
    ? archiveState.leaderboard : {};
  const maxArchiveHits = Object.values(board).reduce(
    (m, e) => Math.max(m, e.hits || 0), 0
  );

  // Union of colors seen in either source
  const colorSet = new Set([
    ...Object.keys(recentMomentum),
    ...Object.keys(board)
  ]);
  if (colorSet.size === 0) return [];

  return Array.from(colorSet).map(color => {
    const momentumScore = recentMomentum[color] || 0;
    const archiveRaw    = board[color] ? (board[color].hits || 0) : 0;
    const archiveNorm   = maxArchiveHits > 0 ? archiveRaw / maxArchiveHits : 0;

    const blended = (archiveState && archiveState.awake)
      ? ARCHIVE_BLEND * archiveNorm + MOMENTUM_BLEND * momentumScore
      : momentumScore;
    const score = Math.round(clamp(blended * 100, 0, 100));

    // Velocity: compare the most-recent 5-draw window vs the prior 5-draw window
    const r5    = recent5[color] || 0;
    const p5    = prior5[color]  || 0;
    const delta = r5 - p5;
    let momentumVelocity;
    if      (delta >  0.08) momentumVelocity = 'Accelerating';
    else if (delta >  0.02) momentumVelocity = 'Growing';
    else if (delta < -0.08) momentumVelocity = 'Collapsing';
    else if (delta < -0.02) momentumVelocity = 'Declining';
    else                    momentumVelocity = 'Stable';

    // Fatigue: gap since this color last appeared in the 4-ball draw stream
    let gapSinceLast = 0;
    for (let i = draws.length - 1; i >= 0; i--) {
      if (draws[i] && draws[i].color === color) break;
      gapSinceLast++;
    }
    const fatigueIndex = gapSinceLast >= MOMENTUM_LOOKBACK
      ? 'Exhausted'
      : gapSinceLast >= Math.round(MOMENTUM_LOOKBACK * 0.6)
        ? 'Aging'
        : 'Active';

    const sep = fatigueIndex === 'Exhausted'       ? 70
              : fatigueIndex === 'Aging'            ? 40
              : momentumVelocity === 'Collapsing'   ? 55
              : 15;

    return {
      color,
      seasonScore: score,
      momentumVelocity,
      fatigueIndex,
      seasonEndProbability: sep,
      recent5Score: r5
    };
  }).sort((a, b) => b.seasonScore - a.seasonScore);
}

// ─── ballsBeforeExit estimate ─────────────────────────────────────────────────

/**
 * Estimate how many more archive hits the current leader is likely to get
 * before the season ends, derived from completed-season history.
 * Returns null when there is no history to learn from.
 */
function estimateBallsBeforeExit(archiveState) {
  const history = (archiveState && archiveState.history) ? archiveState.history : [];
  if (history.length === 0) return null;

  let totalWinnerHits = 0;
  let validSeasons    = 0;
  for (const season of history) {
    const dom = season.dominantColor;
    if (dom && season.finalLeaderboard && season.finalLeaderboard[dom]) {
      totalWinnerHits += season.finalLeaderboard[dom].rawHitCount || 0;
      validSeasons++;
    }
  }
  if (validSeasons === 0) return null;

  const avgWinnerHits = totalWinnerHits / validSeasons;
  const leader        = archiveState.dominantColor;
  const leaderEntry   = archiveState.leaderboard ? archiveState.leaderboard[leader] : null;
  const currentHits   = leaderEntry ? (leaderEntry.rawHitCount || 0) : 0;

  return Math.max(0, Math.round(avgWinnerHits - currentHits));
}

// ─── Battle-status vocabulary (identical to threeBallLastStand) ───────────────

function battleStatusFromSignals({
  leaderVelocity, leaderFatigue, challengerAheadOfLeader, challengerClosing
}) {
  if (challengerAheadOfLeader)                                             return 'LEADER_COLLAPSING';
  if (challengerClosing)                                                   return 'TRANSITION_BATTLE';
  if (leaderVelocity === 'Collapsing' || leaderFatigue === 'Exhausted')   return 'LAST_STAND';
  if (leaderVelocity === 'Declining'  || leaderFatigue === 'Aging')       return 'LEADER_WEAKENING';
  return 'LEADER_DEFENDING';
}

function takeProfitWindowFromStatus(status) {
  if (status === 'LEADER_COLLAPSING')                             return 'CLOSED';
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
    ballsBeforeExit:      null,
    reasoning:            reason
  };
}

// ─── Core battle computation ──────────────────────────────────────────────────

/**
 * 4-Color equivalent of threeBallLastStand.computeThreeBallBattle(),
 * gated on the 4-ball season being active.
 *
 * @param {Array}  draws        — state.draws (4-ball stream, oldest-first)
 * @param {Object} archiveState — state.archive (strategicEngine's store)
 */
function computeFourBallBattle(draws, archiveState) {
  // Season gate: archive must be awake (season ACTIVE)
  if (!archiveState || !archiveState.awake) {
    return emptyBattle('No active 4-ball season — Last Stand detector is asleep.');
  }
  if (!archiveState.dominantColor) {
    return emptyBattle('4-Ball archive has no dominant color yet — waiting for first hits.');
  }
  if (!draws || draws.length < 5) {
    return emptyBattle('Not enough 4-ball draw history yet.');
  }

  const ranked = computeColorRanking(draws, archiveState);
  if (ranked.length === 0) return emptyBattle('4-Ball engine has no signal yet.');

  // Leader is always the archive dominant color — the blended score
  // may differ from the archive in edge cases, but the DECLARED leader
  // for battle-status decisions must match the archive's own read.
  const leaderColor     = archiveState.dominantColor;
  const leaderEntry     = ranked.find(r => r.color === leaderColor) || ranked[0];
  const challengerEntry = ranked.find(r => r.color !== leaderColor) || null;

  const leaderStrength     = Math.round(clamp(leaderEntry.seasonScore, 0, 100));
  const challengerStrength = challengerEntry
    ? Math.round(clamp(challengerEntry.seasonScore, 0, 100))
    : 0;

  // NOTE: ranked[] sorted descending by blended seasonScore, NOT by archive alone —
  // so the 5-draw recency window (recent5Score) can legitimately show the
  // challenger pulling ahead of the leader even when the leader still holds
  // the longer-window archive lead. Compare recency windows, not archive scores.
  const challengerAheadOfLeader = !!(
    challengerEntry && challengerEntry.recent5Score > leaderEntry.recent5Score
  );

  const challengerClosing = !!challengerEntry
    && !challengerAheadOfLeader
    && (leaderStrength - challengerStrength) <= 10
    && challengerEntry.momentumVelocity === 'Accelerating';

  const status = battleStatusFromSignals({
    leaderVelocity:         leaderEntry.momentumVelocity,
    leaderFatigue:          leaderEntry.fatigueIndex,
    challengerAheadOfLeader,
    challengerClosing
  });

  const lastStandProbability = Math.round(clamp(
    (leaderEntry.seasonEndProbability || 0) * 0.6 + (100 - leaderStrength) * 0.4,
    0, 100
  ));

  const ballsBeforeExit = estimateBallsBeforeExit(archiveState);

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
    ballsBeforeExit,
    reasoning: `4-Color: ${leaderEntry.color.toUpperCase()} (${leaderStrength}%) vs ${
      challengerEntry ? challengerEntry.color.toUpperCase() : 'no challenger'
    } (${challengerStrength}%). Status: ${status.replace(/_/g, ' ')}.`
  };
}

// ─── Alert derivation ─────────────────────────────────────────────────────────

/**
 * Produces the alert-level badge for the dashboard card.
 * Uses `ballsBeforeExit` in place of the 3-ball engine's `leadGap` as the
 * urgency signal in the alert text.
 */
function deriveFourBallAlert(battle) {
  if (!battle.active) {
    return {
      alertLevel:     'GRAY',
      headline:       'ASLEEP',
      actionText:     battle.reasoning,
      ballsBeforeExit: null
    };
  }

  const leader     = (battle.leader    || 'Leader').toUpperCase();
  const challenger = battle.challenger ? battle.challenger.toUpperCase() : 'the challenger';
  const gap        = Math.max(0, battle.leaderStrength - battle.challengerStrength);
  const bbe        = battle.ballsBeforeExit;
  const bbeText    = bbe != null
    ? `~${bbe} hit${bbe === 1 ? '' : 's'} remaining`
    : 'remaining hits unknown';

  let alert;
  switch (battle.battleStatus) {
    case 'LEADER_COLLAPSING':
      alert = {
        alertLevel: 'RED',
        headline:   '🔴 EXIT IMMEDIATELY',
        actionText: `${leader} is collapsing — ${challenger} is taking over the 4-ball stream now. EXIT, do not wait for confirmation.`
      };
      break;

    case 'LAST_STAND':
      alert = {
        alertLevel: 'RED',
        headline:   '🔴 LAST STAND',
        actionText: `${leader} may be firing its final 4-ball shot (${bbeText}). ENTER to take profit on this final push, then exit immediately.`
      };
      break;

    case 'TRANSITION_BATTLE':
      alert = {
        alertLevel: 'ORANGE',
        headline:   '🟠 TRANSITION BATTLE',
        actionText: `${challenger} is closing in on ${leader} (~${gap} pt${gap === 1 ? '' : 's'} of lead left, ${bbeText}). Take profit on any hit now — do not open new positions.`
      };
      break;

    case 'LEADER_WEAKENING':
      alert = {
        alertLevel: 'GOLD',
        headline:   '🟡 WEAKENING',
        actionText: `${leader} is losing 4-ball momentum. Reduce exposure.`
      };
      break;

    default:
      alert = {
        alertLevel: 'GREEN',
        headline:   '🟢 DEFENDING',
        actionText: `${leader} is holding its 4-ball lead. Continue holding.`
      };
  }

  return { ...alert, ballsBeforeExit: bbe };
}

// ─── Convenience wrapper ──────────────────────────────────────────────────────

/**
 * Full 4-Color Last Stand payload in one call.
 * Merges battle + alert into a single object mirroring the shape used by
 * computeThreeBallLastStand().
 *
 * @param {Array}  draws        — state.draws (4-ball stream, oldest-first)
 * @param {Object} archiveState — state.archive (strategicEngine's store)
 */
function computeFourBallLastStand(draws, archiveState) {
  const battle = computeFourBallBattle(draws, archiveState);
  const alert  = deriveFourBallAlert(battle);
  return {
    ...battle,
    ...alert,
    lastStandActive: battle.battleStatus === 'LAST_STAND'
  };
}

module.exports = {
  computeColorRanking,
  computeFourBallBattle,
  deriveFourBallAlert,
  computeFourBallLastStand,
  estimateBallsBeforeExit,
  battleStatusFromSignals,
  takeProfitWindowFromStatus,
  battleRecommendationFromStatus
};
