/**
 * TIMING ENGINE — new layer, blueprint Phase 7/8/9.
 *
 * IMPORTANT SEPARATION (blueprint §41/§42): this file NEVER recomputes
 * gates, season math, or confidence. Everything it reads comes straight
 * off the ported 4SIL result (fourBallSeasonIntelligenceLab.js, required
 * unmodified from src-legacy-core). This module's only job is to turn
 * that already-final evidence into the trading vocabulary the blueprint
 * asks for: ENTER / PREPARE / MONITOR / PAUSE / TAKE PROFIT /
 * WINDOW CLOSED, plus a Trade Penetration Point and an 11-draw
 * core/safety window.
 *
 * 4SIL remains the final authority (blueprint §42, non-negotiable #25):
 * this engine cannot flip enterNow, cannot invent evidence, and cannot
 * force an ENTER that 4SIL itself did not confirm (non-negotiable #26).
 * The only extra state this module owns is "is there currently an OPEN
 * call" (see callHistory.js), which is bookkeeping, not intelligence.
 */
'use strict';

const CLOSING_RISK_DRAWS = 7; // non-negotiable #13

function clampWindow([lo, hi]) {
  const l = Math.max(1, Math.round(lo));
  const h = Math.max(l, Math.round(hi));
  return [l, h];
}

function decayLabel(fatigueProgression) {
  if (fatigueProgression == null) return 'LOW';
  if (fatigueProgression >= 66) return 'HIGH';
  if (fatigueProgression >= 33) return 'MODERATE';
  return 'LOW';
}

function healthFromIntelligence(fourSIL) {
  const di = fourSIL.dominanceIntelligence;
  if (!di) return 50;
  // Blend strength (heat) with an inverse of fatigue -- a season that is
  // strong but exhausted is not "healthy" in the sense a trader cares
  // about (about to close), so both terms matter.
  const strength = Number.isFinite(di.strength) ? di.strength : 50;
  const fatigue = Number.isFinite(di.fatigueProgression) ? di.fatigueProgression : 30;
  return Math.max(0, Math.min(100, Math.round(strength * 0.6 + (100 - fatigue) * 0.4)));
}

function remainingLifeFromTiming(fourSIL) {
  const est = fourSIL.timing && Number.isFinite(fourSIL.timing.estimatedDrawsUntilTransition)
    ? fourSIL.timing.estimatedDrawsUntilTransition
    : null;
  if (est == null) return [7, 11];
  return clampWindow([Math.max(1, est - 3), est + 3]);
}

function closingRiskFromRemainingLife(remainingLife, fourSIL) {
  const [lo] = remainingLife;
  const warningLevel = fourSIL.badge && fourSIL.badge.transitionWarning
    ? fourSIL.badge.transitionWarning.level
    : 'LOW';
  if (lo <= CLOSING_RISK_DRAWS || warningLevel === 'HIGH') return 'HIGH';
  if (lo <= CLOSING_RISK_DRAWS + 3 || warningLevel === 'ELEVATED') return 'MODERATE';
  return 'LOW';
}

/**
 * Builds the Hero Data Object (blueprint §40) for the current cycle,
 * given: the ported 4SIL result, and the current call-history state
 * (whether a call is already OPEN, and if so what its recorded
 * tp/windows were when it opened -- so the Hero Card doesn't recompute
 * a new TP mid-trade every cycle).
 */
function selectTpWindow(fourSIL) {
  const timing = (fourSIL && fourSIL.timing) || {};
  const warning = fourSIL && fourSIL.badge && fourSIL.badge.transitionWarning;
  const estimate = Number.isFinite(timing.estimatedDrawsUntilTransition)
    ? timing.estimatedDrawsUntilTransition
    : null;

  // TP1 is deliberately expressed as a window, not a single magic draw.
  // A short runway uses 1–3; a more open runway uses 1–5.  The decision is
  // based only on 4SIL's existing timing/transition evidence.
  const shortRunway = warning && warning.level === 'HIGH' || (estimate != null && estimate <= 5);
  const end = shortRunway ? 3 : 5;
  return [1, end];
}

function operatorState(fourSIL) {
  const badge = (fourSIL && fourSIL.badge) || {};
  if (fourSIL && fourSIL.enterNow && fourSIL.enterNow.enterNow) return 'ENTER';
  if (badge.operatorAction === 'PREPARE') return 'PREPARE';
  return 'MONITOR';
}

/**
 * Hero Data Object. 4SIL is the operator authority; Trade Penetration is
 * the execution layer bonded to that authority. A live call therefore does
 * never becomes a legacy exit-warning state merely because season-life risk rises. Instead:
 *   ENTER   = 4SIL says ENTER and the 11-draw trade window is live.
 *   PAUSE   = 4SIL temporarily says PREPARE/MONITOR; keep the original
 *             call/window frozen and wait for 4SIL to release it again.
 *   TAKE PROFIT = a real 4-ball event has landed inside the live call.
 *   WINDOW CLOSED = the 11-draw validity window has elapsed.
 */
function buildHeroData(fourSIL, openCall) {
  const active = !!(fourSIL && fourSIL.active);
  const enterNow = (fourSIL && fourSIL.enterNow) || {};
  const op = operatorState(fourSIL);
  const seasonHealth = active ? healthFromIntelligence(fourSIL) : 0;
  const timingStrength = Number.isFinite(enterNow.institutionalConfidence) ? enterNow.institutionalConfidence : 0;
  const gateRequired = Number.isFinite(enterNow.effectiveMinConfirmations) ? enterNow.effectiveMinConfirmations : 4;
  const confidenceRequired = Number.isFinite(enterNow.effectiveMinConfidence) ? enterNow.effectiveMinConfidence : 70;
  const gateConfirmations = Number.isFinite(enterNow.confirmedCount) ? enterNow.confirmedCount : 0;
  const remainingLife = active ? remainingLifeFromTiming(fourSIL) : null;
  const closingRisk = active ? closingRiskFromRemainingLife(remainingLife, fourSIL) : 'LOW';
  const decay = decayLabel(fourSIL && fourSIL.dominanceIntelligence && fourSIL.dominanceIntelligence.fatigueProgression);
  const tpWindow = active ? selectTpWindow(fourSIL) : null;

  if (!active) {
    return {
      state: 'MONITOR',
      operatorState: 'MONITOR',
      tp: null,
      tpWindow: null,
      tradeWindow: [1, 11],
      coreWindow: null,
      safetyWindow: null,
      confidence: 0,
      seasonHealth: 0,
      timingStrength: 0,
      seasonAge: 0,
      currentGap: null,
      remainingLife: null,
      closingRisk: 'LOW',
      decay: 'LOW',
      gateConfirmations: 0,
      gateRequired,
      confidenceRequired,
      tradeWindowPosition: null,
      entryDrawId: null,
      action: 'WAIT FOR 4SIL ENTER',
      reasoning: (fourSIL && fourSIL.badge && fourSIL.badge.reasoning) || 'No active 4-ball season. 4SIL is monitoring for the next valid ENTER condition.'
    };
  }

  // Trade Penetration Point remains an estimate, but the executable TP1 is
  // always a bounded 1–3 or 1–5 window. The full ENTER validity window is
  // fixed at 11 draws.
  const rawTp = Number.isFinite(fourSIL.timing && fourSIL.timing.estimatedDrawsUntilTransition)
    ? fourSIL.timing.estimatedDrawsUntilTransition
    : tpWindow[1];
  const tp = Math.max(1, Math.min(tpWindow[1], Math.round(rawTp)));

  if (openCall && openCall.status === 'PENDING') {
    const drawsSinceOpen = Math.max(0, Number(openCall.drawsSinceOpen) || 0);
    const position = Math.min(11, drawsSinceOpen + 1);

    if (openCall.eventConfirmedThisCycle) {
      return {
        state: 'TAKE PROFIT',
        operatorState: op,
        tp: openCall.tp,
        tpWindow: openCall.tpWindow || tpWindow,
        tradeWindow: openCall.tradeWindow || [1, 11],
        coreWindow: openCall.coreWindow,
        safetyWindow: openCall.safetyWindow || [1, 11],
        confidence: timingStrength,
        seasonHealth,
        timingStrength,
        seasonAge: fourSIL.seasonAge,
        currentGap: drawsSinceOpen,
        remainingLife,
        closingRisk,
        decay,
        gateConfirmations,
        gateRequired,
        confidenceRequired,
        tradeWindowPosition: position,
        entryDrawId: openCall.openedDrawId,
        action: 'TAKE PROFIT',
        reasoning: '4SIL trade target achieved. Trade Penetration is closing this call; do not re-enter until a fresh ENTER is issued.'
      };
    }

    if (drawsSinceOpen > 11) {
      return {
        state: 'WINDOW CLOSED',
        operatorState: op,
        tp: openCall.tp,
        tpWindow: openCall.tpWindow || tpWindow,
        tradeWindow: openCall.tradeWindow || [1, 11],
        coreWindow: openCall.coreWindow,
        safetyWindow: openCall.safetyWindow || [1, 11],
        confidence: timingStrength,
        seasonHealth,
        timingStrength,
        seasonAge: fourSIL.seasonAge,
        currentGap: drawsSinceOpen,
        remainingLife,
        closingRisk,
        decay,
        gateConfirmations,
        gateRequired,
        confidenceRequired,
        tradeWindowPosition: 11,
        entryDrawId: openCall.openedDrawId,
        action: 'WAIT FOR FRESH ENTER',
        reasoning: 'The 11-draw ENTER validity window has closed without a confirmed event.'
      };
    }

    // Crucially, season closing risk is telemetry only and can never override the operator.
    // 4SIL PREPARE/MONITOR pauses penetration; it does not manufacture an exit state.
    const paused = op !== 'ENTER';
    return {
      state: paused ? 'PAUSE' : 'ENTER',
      operatorState: op,
      tp: openCall.tp,
      tpWindow: openCall.tpWindow || tpWindow,
      tradeWindow: openCall.tradeWindow || [1, 11],
      coreWindow: openCall.coreWindow,
      safetyWindow: openCall.safetyWindow || [1, 11],
      confidence: timingStrength,
      seasonHealth,
      timingStrength,
      seasonAge: fourSIL.seasonAge,
      currentGap: drawsSinceOpen,
      remainingLife,
      closingRisk,
      decay,
      gateConfirmations,
      gateRequired,
      confidenceRequired,
      tradeWindowPosition: position,
      entryDrawId: openCall.openedDrawId,
      action: paused ? `PAUSE — 4SIL ${op}` : 'ENTER / CONTINUE',
      reasoning: paused
        ? `Trade Penetration paused because 4SIL is ${op}. The original ENTER call and 11-draw window remain frozen; resume only when 4SIL returns to ENTER.`
        : (enterNow.reasoning || '4SIL ENTER remains active; Trade Penetration is live.')
    };
  }

  return {
    state: op,
    operatorState: op,
    tp,
    tpWindow,
    tradeWindow: [1, 11],
    coreWindow: tpWindow,
    safetyWindow: [1, 11],
    confidence: timingStrength,
    seasonHealth,
    timingStrength,
    seasonAge: fourSIL.seasonAge,
    currentGap: fourSIL.badge ? fourSIL.badge.currentBattleAge : null,
    remainingLife,
    closingRisk,
    decay,
    gateConfirmations,
    gateRequired,
    confidenceRequired,
    tradeWindowPosition: 1,
    entryDrawId: null,
    action: op === 'ENTER' ? 'ENTER' : (op === 'PREPARE' ? 'PREPARE FOR ENTER' : 'MONITOR'),
    reasoning: enterNow.reasoning || (fourSIL.badge && fourSIL.badge.reasoning) || ''
  };
}

/**
 * Season telemetry strip (blueprint §19/§21) -- descriptive readout,
 * again sourced only from already-computed 4SIL fields.
 */
function buildSeasonTelemetry(fourSIL) {
  if (!fourSIL || !fourSIL.active) {
    return { seasonAge: 0, events: 0, currentGap: null, avgGap: null, health: 0, decay: 'LOW', runway: null };
  }
  const th = fourSIL.transitionHistory || {};
  const stats = th.intervalStats || {};
  return {
    seasonAge: fourSIL.seasonAge,
    events: stats.count || 0,
    currentGap: th.currentBattleAge != null ? th.currentBattleAge : null,
    avgGap: stats.avgIntervalDraws != null ? Math.round(stats.avgIntervalDraws * 10) / 10 : null,
    health: healthFromIntelligence(fourSIL),
    decay: decayLabel(fourSIL.dominanceIntelligence && fourSIL.dominanceIntelligence.fatigueProgression),
    runway: remainingLifeFromTiming(fourSIL)
  };
}

/**
 * Season runway table (blueprint §26): compares this season against the
 * historical average -- again reading transitionHistory's own recorded
 * cycle statistics rather than recomputing anything.
 */
function buildSeasonRunway(fourSIL) {
  if (!fourSIL || !fourSIL.active) return null;
  const th = fourSIL.transitionHistory || {};
  const stats = th.intervalStats || {};
  return {
    seasonAge: { current: fourSIL.seasonAge, historicalAvg: stats.avgIntervalDraws != null ? Math.round(stats.avgIntervalDraws * 10) / 10 : null },
    events: { current: stats.count || 0, historicalAvg: stats.count || 0 },
    currentGap: { current: th.currentBattleAge != null ? th.currentBattleAge : null, historicalAvg: stats.avgIntervalDraws != null ? Math.round(stats.avgIntervalDraws * 10) / 10 : null },
    remaining: remainingLifeFromTiming(fourSIL),
    closingRisk: closingRiskFromRemainingLife(remainingLifeFromTiming(fourSIL), fourSIL)
  };
}

/**
 * Gate/Evidence Matrix (blueprint §25) -- a direct, unmodified read of
 * 4SIL's own `enterNow.conditions` array (the exact gates/weights ported
 * from fourBallSeasonIntelligenceLab.js's evaluateEnterNow). This is a
 * presentation mapping only: no weight, threshold, or condition is
 * altered (non-negotiable #27).
 */
function buildGateMatrix(fourSIL) {
  const enterNow = (fourSIL && fourSIL.enterNow) || {};
  const conditions = enterNow.conditions || [];
  return {
    gates: conditions.map(c => ({ id: c.id, status: c.met ? 'CONFIRMED' : 'PENDING', weight: c.weight, detail: c.detail })),
    confirmed: enterNow.confirmedCount || 0,
    required: enterNow.effectiveMinConfirmations || 4,
    confidence: enterNow.institutionalConfidence || 0,
    confidenceRequired: enterNow.effectiveMinConfidence || 70,
    verdict: enterNow.enterNow ? 'ENTER' : 'NO SIGNAL'
  };
}

/**
 * Legacy 4SIL Badge + its dual color-pick (blueprint §3/§9: the three
 * colors remain important as behavioral intelligence, never as the final
 * trade target). This is a pure passthrough of two already-computed,
 * already-final fields on the snapshot:
 *
 *   - fourSIL.badge            -- 4SIL's own live status badge
 *     (operatorAction/enterNow/transitionBattleStatus/institutional
 *     confidence/etc.), assembled unmodified inside
 *     fourBallSeasonIntelligenceLab.js. Deliberately carries NO color
 *     prediction of its own -- see council.js's own comment on
 *     officialPredictions.fourBallMarketTiming.
 *   - dualPick                 -- the paired 1st/2nd color pick
 *     (officialPredictions.next4Ball on the snapshot), i.e. the 4-Ball
 *     Parliament's own winningColor/secondColor + confidences. This is
 *     the "dual" the badge is paired with on the dashboard: which two
 *     colors the underlying market intelligence currently favors, shown
 *     as supporting evidence for the ENTER/HOLD/EXIT call above it --
 *     never as an instruction to trade a specific color (non-negotiable
 *     #6/#7: the final trade target stays "a 4-ball event of ANY
 *     color").
 *
 * This function computes nothing new and cannot influence hero.state or
 * hero.action -- it only reshapes two existing read-only fields for
 * display (non-negotiable #24/#25/#26).
 */
function buildLegacyBadge(fourSIL, dualPick) {
  const badge = (fourSIL && fourSIL.badge) || null;
  if (!badge) return null;
  return {
    operatorAction: badge.operatorAction || 'MONITOR',
    enterNow: Boolean(badge.enterNow),
    transitionBattleStatus: badge.transitionBattleStatus || 'INACTIVE',
    institutionalConfidence: badge.institutionalConfidence != null ? badge.institutionalConfidence : null,
    marketReadiness: badge.marketReadiness || null,
    seasonStatus: badge.seasonStatus || null,
    topColor: badge.topColor || null,
    nextEventSummary: badge.nextEventSummary || null,
    reasoning: badge.reasoning || null,
    dualPick: dualPick
      ? {
          color: dualPick.color || null,
          confidence: dualPick.confidence != null ? dualPick.confidence : null,
          secondColor: dualPick.secondColor || null,
          secondConfidence: dualPick.secondConfidence != null ? dualPick.secondConfidence : null
        }
      : null
  };
}

module.exports = {
  buildHeroData,
  buildSeasonTelemetry,
  buildSeasonRunway,
  buildGateMatrix,
  buildLegacyBadge
};
