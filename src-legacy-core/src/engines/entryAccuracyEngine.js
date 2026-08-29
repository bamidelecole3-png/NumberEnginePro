/**
 * Entry Accuracy Engine.
 *
 * The third piece of the Entry Accuracy System, built on top of:
 *   - entryConditionScorecard.js  (grades each 4SIL condition's real
 *     hit-rate against outcomes)
 *   - entryTimingIntervalEngine.js (entry tier/streak for the live pick --
 *     now a pure, ungated recompute; see that file's header)
 *   - exitIntelligenceEngine.js   (live exit-probability read, already
 *     computed once per cycle inside fourBallParliament.js)
 *
 * 4SIL's evaluateEnterNow() gate is strictly binary (ENTER or silent) and
 * NEVER re-evaluated once a position is live -- there is currently no
 * signal telling the operator "conditions have deteriorated, retreat
 * before the drought/exit-risk gets worse," only the eventual EXIT_NOW
 * tier from entryIntelligenceEngine.js's season-age classification. This
 * engine adds both missing pieces without touching 4SIL's own gate logic
 * (per the existing system boundary: 4SIL "must never predict,
 * recommend, rank, or override color selection" -- this engine follows
 * the same rule and never overrides fourBallP's color pick either; it
 * only classifies WHEN to act on it).
 *
 * 1. TIERED ENTRY CLASSIFICATION
 *    Replaces the implicit binary (gate open -> act, gate closed -> wait)
 *    with four tiers, driven by how many of the CURRENTLY-CONFIRMED
 *    conditions the scorecard has graded STRONG vs. WEAK:
 *      STRIKE     - gate open AND the confirmed conditions are
 *                   overwhelmingly STRONG/evidenced -- highest-confidence
 *                   entries.
 *      ENTER      - gate open, mix of STRONG/MODERATE confirmed
 *                   conditions -- current default behavior.
 *      WATCH      - gate CLOSED but a meaningful share of conditions are
 *                   already confirmed (building toward a signal) -- early
 *                   warning, not an entry.
 *      STAND_DOWN - gate open but the confirmed conditions are mostly
 *                   WEAK/unproven, OR exit risk is already elevated at
 *                   signal time -- flags a signal worth distrusting even
 *                   though 4SIL fired it.
 *    Falls back to a data-light mode (mirrors 4SIL's own gate boolean)
 *    when the scorecard doesn't have enough samples yet to grade
 *    anything -- this system never blocks trading on its own opinion
 *    until it has evidence to back that opinion.
 *
 * 2. LIVE RETREAT MONITOR
 *    Once ENTER/STRIKE fires and a position is conceptually "live" (i.e.
 *    the current draw is inside an active ENTER streak per
 *    entryTimingIntervalEngine's entryStreak), this tracks the live
 *    exitProbability read draw-by-draw and raises a RETREAT signal,
 *    distinct from 4SIL's own EXIT_NOW tier, the moment exit pressure
 *    crosses a threshold BEFORE the predicted hit has landed -- i.e. "get
 *    out early" rather than waiting for the season to fully die.
 */

const RETREAT_EXIT_RISK_THRESHOLD = 50; // exitProbability (0-100) that triggers early retreat while a position is live
const STRIKE_STRONG_SHARE = 0.6;        // >= this share of confirmed conditions must be STRONG to earn STRIKE
const STAND_DOWN_WEAK_SHARE = 0.5;      // >= this share of confirmed conditions being WEAK triggers STAND_DOWN despite gate=open

function classifyEntryTier(gateOpen, confirmedConditionIds, scorecard) {
  const scoreById = {};
  (scorecard.conditions || []).forEach(c => { scoreById[c.conditionId] = c; });

  const confirmedScored = confirmedConditionIds
    .map(id => scoreById[id])
    .filter(c => c && c.verdict !== 'INSUFFICIENT_DATA' && c.verdict !== 'BUILDING_EVIDENCE');

  const dataLight = confirmedScored.length === 0;

  if (dataLight) {
    // No graded evidence yet on any currently-confirmed condition --
    // defer entirely to 4SIL's own gate rather than invent an opinion.
    return {
      tier: gateOpen ? 'ENTER' : 'STANDBY',
      dataLight: true,
      strongShare: null,
      weakShare: null,
      basis: gateOpen
        ? 'Gate open, but no confirmed condition has enough graded history yet -- deferring to 4SIL\'s own gate at face value.'
        : 'Gate closed and no confirmed condition has graded history -- standing by.'
    };
  }

  const strongCount = confirmedScored.filter(c => c.verdict === 'STRONG').length;
  const weakCount = confirmedScored.filter(c => c.verdict === 'WEAK').length;
  const strongShare = Math.round((strongCount / confirmedScored.length) * 100) / 100;
  const weakShare = Math.round((weakCount / confirmedScored.length) * 100) / 100;

  if (!gateOpen) {
    // Gate closed, but are enough conditions already confirmed (even if
    // not yet enough for 4SIL's own threshold) to flag an early WATCH?
    const anyBuilding = confirmedConditionIds.length >= 2;
    return {
      tier: anyBuilding ? 'WATCH' : 'STANDBY',
      dataLight: false,
      strongShare,
      weakShare,
      basis: anyBuilding
        ? `Gate closed, but ${confirmedConditionIds.length} condition(s) already confirmed -- building toward a signal.`
        : 'Gate closed, minimal condition activity -- standing by.'
    };
  }

  if (weakShare >= STAND_DOWN_WEAK_SHARE) {
    return {
      tier: 'STAND_DOWN',
      dataLight: false,
      strongShare,
      weakShare,
      basis: `Gate is open, but ${Math.round(weakShare * 100)}% of the currently-confirmed conditions are graded WEAK by their real hit-rate history -- distrust this signal despite 4SIL firing it.`
    };
  }

  if (strongShare >= STRIKE_STRONG_SHARE) {
    return {
      tier: 'STRIKE',
      dataLight: false,
      strongShare,
      weakShare,
      basis: `Gate open with ${Math.round(strongShare * 100)}% of confirmed conditions graded STRONG -- highest-confidence entry.`
    };
  }

  return {
    tier: 'ENTER',
    dataLight: false,
    strongShare,
    weakShare,
    basis: `Gate open with a moderate mix of confirmed-condition strength (${Math.round(strongShare * 100)}% STRONG, ${Math.round(weakShare * 100)}% WEAK).`
  };
}

/**
 * Live retreat check -- only meaningful while a position is conceptually
 * open (currentStreak > 0 inside an active ENTER window). Returns
 * retreat: false when there's no live position to protect.
 */
function evaluateRetreatSignal(gateOpen, currentStreak, liveExitRisk) {
  const positionLive = gateOpen && currentStreak > 0;
  if (!positionLive) {
    return { retreat: false, positionLive: false, exitRisk: liveExitRisk != null ? liveExitRisk : null, basis: 'No live position to protect.' };
  }
  const retreat = liveExitRisk != null && liveExitRisk >= RETREAT_EXIT_RISK_THRESHOLD;
  return {
    retreat,
    positionLive: true,
    exitRisk: liveExitRisk,
    threshold: RETREAT_EXIT_RISK_THRESHOLD,
    basis: retreat
      ? `Position live (streak ${currentStreak}) and exit risk has climbed to ${liveExitRisk}% -- at/above the ${RETREAT_EXIT_RISK_THRESHOLD}% early-retreat threshold. Recommend exiting before the predicted hit rather than waiting for 4SIL's own EXIT_NOW.`
      : `Position live (streak ${currentStreak}), exit risk ${liveExitRisk != null ? liveExitRisk + '%' : 'unknown'} -- below the ${RETREAT_EXIT_RISK_THRESHOLD}% retreat threshold, holding.`
  };
}

/**
 * Main entry point. Pulls together the scorecard, 4SIL's live gate
 * conditions, the entry timing engine's current streak, and the live
 * exitIntelligence read -- all already computed elsewhere this cycle --
 * into one tiered decision plus a retreat signal.
 */
function evaluateEntryAccuracy(fourSIL, fourBallP, entryTiming, scorecard) {
  const gateOpen = Boolean(fourSIL && fourSIL.badge && fourSIL.badge.enterNow);
  const liveConditions = fourSIL && fourSIL.enterNow && Array.isArray(fourSIL.enterNow.conditions)
    ? fourSIL.enterNow.conditions : [];
  const confirmedConditionIds = liveConditions.filter(c => c.met).map(c => c.id);

  const tierResult = classifyEntryTier(gateOpen, confirmedConditionIds, scorecard);

  const currentStreak = entryTiming && entryTiming.firstColor ? entryTiming.firstColor.entryStreak || 0 : 0;
  const liveExitRisk = fourBallP && fourBallP.exitIntelligence ? fourBallP.exitIntelligence.exitProbability : null;
  const retreatResult = evaluateRetreatSignal(gateOpen, currentStreak, liveExitRisk);

  // A STAND_DOWN tier and an active retreat signal both override a raw
  // gate=open reading for the single top-line action the UI should show.
  let recommendedAction = tierResult.tier;
  if (retreatResult.retreat) recommendedAction = 'RETREAT';

  return {
    engine: 'EntryAccuracyEngine',
    gateOpen,
    tier: tierResult.tier,
    recommendedAction,
    dataLight: tierResult.dataLight,
    strongConditionShare: tierResult.strongShare,
    weakConditionShare: tierResult.weakShare,
    confirmedConditionIds,
    tierBasis: tierResult.basis,
    retreat: retreatResult,
    scorecardSampleSize: scorecard ? scorecard.totalObservationsWithConditionData : 0
  };
}

module.exports = {
  RETREAT_EXIT_RISK_THRESHOLD,
  STRIKE_STRONG_SHARE,
  STAND_DOWN_WEAK_SHARE,
  classifyEntryTier,
  evaluateRetreatSignal,
  evaluateEntryAccuracy
};
