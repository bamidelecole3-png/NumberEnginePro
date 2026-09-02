/**
 * 3BALL SEASON INTELLIGENCE LAB (3SIL) -- Institutional Market Intelligence
 * Engine, mirroring 4SIL's architecture for the 3-ball market.
 *
 * PURPOSE: 3SIL studies, understands, and times the 3-Ball market. It is
 * NOT a prediction engine and never picks, ranks, or recommends a color --
 * that remains generalParliament.js's job exclusively. 3SIL answers
 * "WHEN is it safe to enter"; the Parliament answers "WHICH color."
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CRITICAL RULE (per the 3SIL blueprint): generalParliament.js and every
 * existing 3-ball engine it depends on are UNTOUCHED by this file. 3SIL
 * only ever READS their already-computed output (or recomputes read-only
 * context of its own) -- it never writes to store.engineWeights, never
 * appears in generalParliament.js's votes[], and never influences
 * winningColor/confidence/secondColor. See council.js for how this
 * boundary is enforced at the call site.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ARCHITECTURE -- fusion, not duplication, exactly like 4SIL. Every
 * section below either reuses an existing engine directly, or -- ONLY
 * where that engine is hardcoded to fourBallColor -- computes a small,
 * faithfully-adapted 3-ball-native equivalent inline in this file (never
 * by editing the 4-ball engine itself, per the blueprint's rule #14).
 *
 *   REUSED DIRECTLY (genuinely color/tier-agnostic already):
 *     Lifecycle phase classification         -> lifecycleEngine.js
 *                                                (pure numbers in/out, no
 *                                                tier field at all)
 *     Per-color drought/activity/entropy read -> suppressionIntelligenceEngine.js
 *                                                (uses tierValue(d,c)>=3,
 *                                                which already IS the
 *                                                3-ball win condition)
 *     Rival pressure / dominance-stretch /
 *       suppression matrix                    -> rivalPressureEngine.js
 *                                                (same tierValue>=3 basis;
 *                                                only its releaseProbability
 *                                                field means "escalated to
 *                                                4-ball", used here as
 *                                                cross-tier context only,
 *                                                NOT 3SIL's own recovery
 *                                                timing -- see
 *                                                buildFirstAppearance3B)
 *     Season activation / reconstructed age   -> tacticalEngine.js's
 *                                                .threeBall (already
 *                                                exists, already used by
 *                                                generalParliament.js)
 *     Battle status / leader / challenger /
 *       momentum velocity / fatigue           -> threeBallLastStandCP.js
 *                                                via colorParliamentLastStand
 *                                                .js's toThreeBallCPDraws
 *                                                shape adapter (already
 *                                                wired up and tested
 *                                                elsewhere in this codebase)
 *     3-Ball market regime (order/chaos)      -> shannonEntropy.js
 *     3-Ball tie volatility (cross-market)    -> tieEngine.js (via council.js)
 *     Confirmed-event log (cross-engine)      -> eventIntelligenceEngineCP.js
 *                                                (via council.js)
 *
 *   BUILT NATIVELY HERE (the 4-ball version is hardcoded to
 *   fourBallColor -- dynamicDominanceEngine.js, exitIntelligenceEngine.js,
 *   firstAppearanceEngine.js, colorParliamentSeasonAdapter.js's season
 *   archive, seasonIntelligenceEngine.js's density/velocity/decay --
 *   faithfully adapted math, same formulas, keyed to threeBallColor):
 *     Season density/velocity/decay/recovery  -> computeThreeBallSeasonMetrics
 *     Dynamic rolling-window dominance         -> computeThreeBallDynamicDominance
 *     Exit / structural-control-loss probability -> computeThreeBallExitIntelligence
 *     First appearance / return timing         -> buildFirstAppearance3B
 *     Season stage classification              -> classifySeasonStage3B
 *
 * WHY NOT REUSE firstAppearanceEngine.js DIRECTLY (343 lines of gap-
 * quantile/conditional-residual forecasting math): that engine's
 * dormancy-timing model is tuned for how RARE 4-ball events are (60-draw
 * lookback, MIN_GAP_SAMPLES=3 over a genuinely sparse signal). Rather than
 * either (a) editing it to accept a tier parameter, which the blueprint's
 * rule #14 forbids for existing engines outside 3SIL's own file, or (b)
 * blindly copy-pasting all 343 lines as a parallel 3-ball-keyed clone,
 * this reuses evaluateSuppressionIntelligence's ALREADY-CORRECT
 * colorDrought/classification/recoveryVelocity read (that engine's
 * generic >=3 basis already IS the right 3-ball signal, confirmed above)
 * as 3SIL's dormancy/recovery detector, and builds only the "approximately
 * N draws" return-timing estimate natively from the drought distribution
 * already available -- smaller, honest, and consistent with the
 * blueprint's own "READ ITS RESULT -- DO NOT REBUILD THE FUNCTION" rule
 * for the parts that already exist correctly, while acknowledging the one
 * part that genuinely doesn't (a 3-ball-specific timing forecast).
 *
 * HONESTY NOTE: "market readiness" / "institutional confidence" describe
 * how many independent, real statistical signals currently agree that a
 * genuine transition is underway in the 3-ball market's OWN historical
 * behavior -- not a validated edge on an independent random draw. If 3-ball
 * outcomes are truly independent, no amount of agreement among these
 * signals changes the odds of the next draw. This module is built to be
 * internally correct and honest about what it measures; it is not a claim
 * that the 3-ball market is predictable.
 *
 * historicalDraws is newest-first (index 0 = most recent), matching every
 * other engine's convention.
 */
'use strict';

const { HIERARCHY, argMaxColorBy } = require('../core/colorMath');
const { mean, median, mode } = require('../core/statMath');
const { calculateShannonEntropy } = require('./shannonEntropy');
const { evaluateTacticalActivation } = require('./tacticalEngine');
const { computeLifecycle } = require('./lifecycleEngine');
const { evaluateRivalPressure } = require('./rivalPressureEngine');
const { evaluateSuppressionIntelligence } = require('./suppressionIntelligenceEngine');
const { tierValue } = require('./runwayFeatureEngine');
const threeBallLastStandCP = require('./threeBallLastStandCP');

// ENTER NOW requires at least this many independent confirmation
// conditions to be true (mirrors 4SIL's ENTER_NOW_MIN_CONFIRMATIONS /
// ENTER_NOW_MIN_CONFIDENCE exactly -- same bar, no threshold-feedback
// loop wired in for 3SIL per the blueprint, which scopes 3SIL to a
// simpler, fully independent parallel layer).
const ENTER_NOW_MIN_CONFIRMATIONS = 4;
const ENTER_NOW_MIN_CONFIDENCE = 70;

const TRANSITION_ROLLING_WINDOW = 10;
const TRANSITION_SEASON_WINDOW_MAX = 20;
const TRANSITION_SEASON_MIN_EVENTS = 2;
const ENTER_NOW_EVENT_WINDOW = 10;
const ENTER_NOW_EVENT_MINIMUM = 2;

// -----------------------------------------------------------------------
// TRANSITION HISTORY INTELLIGENCE -- mirrors 4SIL's buildTransitionHistory
// exactly (same field names/vocabulary, same tieEngine-style interval/
// cycle/probability machinery), applied to "the rolling-window 3-ball
// leader changed" instead of "the rolling-window 4-ball leader changed."
// 3SIL maintains its own, fully independent transition history -- this
// function never reads or writes 4SIL's transitionHistory/store state.
// -----------------------------------------------------------------------
function rollingLeaderAt(draws, idx) {
  const window = draws.slice(idx, idx + TRANSITION_ROLLING_WINDOW);
  if (window.length < Math.min(TRANSITION_ROLLING_WINDOW, 5)) return null;
  const counts = { RED: 0, BLUE: 0, GREEN: 0 };
  window.forEach(d => { if (d.threeBallColor && counts[d.threeBallColor] !== undefined) counts[d.threeBallColor]++; });
  if (counts.RED + counts.BLUE + counts.GREEN === 0) return null;
  return argMaxColorBy(counts);
}

function buildTransitionHistory3B(draws) {
  const events = [];
  let prevLeader = null;
  for (let idx = draws.length - 1; idx >= 0; idx--) {
    const leader = rollingLeaderAt(draws, idx);
    if (leader === null) continue;
    if (prevLeader !== null && leader !== prevLeader) {
      events.push({ drawId: draws[idx].drawId, fromColor: prevLeader, toColor: leader, drawsAgo: idx });
    }
    prevLeader = leader;
  }

  const totalTransitions = events.length;
  const lastTransition = totalTransitions > 0 ? events[events.length - 1] : null;

  const intervals = [];
  for (let i = 1; i < events.length; i++) {
    intervals.push(events[i - 1].drawsAgo - events[i].drawsAgo);
  }
  const avgIntervalDraws = intervals.length > 0 ? Math.round(mean(intervals) * 10) / 10 : null;
  const medianIntervalDraws = intervals.length > 0 ? median(intervals) : null;
  const longestGapDraws = intervals.length > 0 ? Math.max(...intervals) : null;
  const shortestGapDraws = intervals.length > 0 ? Math.min(...intervals) : null;
  const mostCommonInterval = intervals.length > 0 ? mode(intervals) : null;

  const detectedCycle = mostCommonInterval && intervals.filter(iv => iv === mostCommonInterval).length >= 2
    ? `Transition approximately every ${mostCommonInterval} draw(s)`
    : null;

  const currentBattleAge = lastTransition ? lastTransition.drawsAgo : draws.length;

  const drawsUntilNextTransition = mostCommonInterval != null
    ? Math.max(0, mostCommonInterval - currentBattleAge)
    : null;

  let pNextDraw = 0.08;
  if (mostCommonInterval) {
    pNextDraw = currentBattleAge >= mostCommonInterval
      ? Math.min(0.5, 0.15 + (currentBattleAge - mostCommonInterval) * 0.05)
      : Math.max(0.05, 0.15 - (mostCommonInterval - currentBattleAge) * 0.02);
  }
  const within = n => Math.round((1 - Math.pow(1 - pNextDraw, n)) * 1000) / 10;
  const transitionProbability = {
    nextDrawPct: Math.round(pNextDraw * 1000) / 10,
    within3DrawsPct: within(3),
    within5DrawsPct: within(5)
  };

  const recentEvents = events.filter(e => e.drawsAgo <= TRANSITION_SEASON_WINDOW_MAX);
  const activeCluster = recentEvents.length >= TRANSITION_SEASON_MIN_EVENTS
    ? { eventCount: recentEvents.length, spanDraws: TRANSITION_SEASON_WINDOW_MAX, mostRecentDrawsAgo: recentEvents[recentEvents.length - 1].drawsAgo }
    : null;

  let warningLevel = 'LOW';
  let warningScore = 0;
  if (activeCluster) warningScore += 30 + Math.min(20, activeCluster.eventCount * 8);
  if (drawsUntilNextTransition !== null && drawsUntilNextTransition <= 2) warningScore += 30;
  if (mostCommonInterval && currentBattleAge >= mostCommonInterval) warningScore += 20;
  warningScore = Math.min(95, Math.round(warningScore));
  if (warningScore >= 60) warningLevel = 'HIGH';
  else if (warningScore >= 30) warningLevel = 'ELEVATED';

  const reasoning = activeCluster
    ? `Active transition cluster: ${activeCluster.eventCount} leadership changes across the last ${activeCluster.spanDraws} draws, most recent ${activeCluster.mostRecentDrawsAgo} draw(s) ago. ${detectedCycle || ''}`.trim()
    : (totalTransitions === 0
      ? 'No leadership transitions observed yet in the tracked window.'
      : `No active cluster. Current leader has held for ${currentBattleAge} draw(s) (last transition ${lastTransition.drawsAgo} draw(s) ago, ${lastTransition.fromColor} -> ${lastTransition.toColor}). ${detectedCycle || `Baseline: ${totalTransitions} transitions in ${draws.length} tracked draws.`}`);

  return {
    totalTransitions,
    lastTransition,
    intervalStats: { count: intervals.length, avgIntervalDraws, medianIntervalDraws, longestGapDraws, shortestGapDraws, mostCommonInterval },
    detectedCycle,
    currentBattleAge,
    drawsUntilNextTransition,
    transitionProbability,
    activeCluster,
    transitionWarning: { level: warningLevel, score: warningScore, reasoning },
    recentEvents: recentEvents.slice(-10)
  };
}

// -----------------------------------------------------------------------
// SEASON METRICS (native 3-ball adaptation of seasonIntelligenceEngine.js)
// -- density/velocity/decay/recovery for the dominant 3-ball color, same
// formulas, keyed to threeBallColor instead of fourBallColor.
// -----------------------------------------------------------------------
const SM_SHORT_WINDOW = 5;
const SM_MID_WINDOW = 10;
const SM_LONG_WINDOW = 20;

function windowDensity3B(historicalDraws, color, windowSize, offset = 0) {
  const window = historicalDraws.slice(offset, offset + windowSize);
  if (window.length === 0) return 0;
  const hits = window.filter(d => d.threeBallColor === color).length;
  return hits / window.length;
}

function computeRecoveryScore3B(historicalDraws, color) {
  const window = historicalDraws.slice(0, SM_LONG_WINDOW);
  if (window.length < SM_SHORT_WINDOW + 3) return 0;
  const slices = [];
  for (let offset = 0; offset + SM_SHORT_WINDOW <= window.length; offset += SM_SHORT_WINDOW) {
    slices.push(windowDensity3B(historicalDraws, color, SM_SHORT_WINDOW, offset));
  }
  if (slices.length < 2) return 0;
  const currentDensity = slices[0];
  const trough = Math.min(...slices.slice(1));
  return Math.max(0, Math.round((currentDensity - trough) * 100));
}

function computeThreeBallSeasonMetrics(historicalDraws, dominantColor) {
  const densityShort = windowDensity3B(historicalDraws, dominantColor, SM_SHORT_WINDOW);
  const densityMid = windowDensity3B(historicalDraws, dominantColor, SM_MID_WINDOW);
  const densityLong = windowDensity3B(historicalDraws, dominantColor, SM_LONG_WINDOW);

  // Velocity: change in density between the short and mid window --
  // positive means the color is hitting MORE often recently than its
  // own mid-window baseline.
  const velocity = Math.round((densityShort - densityMid) * 100) / 100;

  let drawsSinceLastHit = 0;
  for (const d of historicalDraws) {
    if (d.threeBallColor === dominantColor) break;
    drawsSinceLastHit++;
    if (drawsSinceLastHit >= 500) break; // safety cap, mirrors suppressionIntelligenceEngine's DROUGHT_SCAN_CAP convention
  }
  // Decay: normalized drought relative to a 15-draw horizon, 0-100.
  const decay = Math.min(100, Math.round((drawsSinceLastHit / 15) * 100));

  const recovery = computeRecoveryScore3B(historicalDraws, dominantColor);

  // Heat: single 0-100 composite blending density, positive velocity,
  // inverse decay, and recovery -- same weighting shape
  // seasonIntelligenceEngine.js uses for its own heat score.
  const heat = Math.max(0, Math.min(100, Math.round(
    (densityShort * 100 * 0.4) +
    (Math.max(0, velocity) * 100 * 0.2) +
    ((100 - decay) * 0.25) +
    (recovery * 0.15)
  )));

  let classification = 'COLD';
  if (heat >= 75) classification = 'PEAK';
  else if (heat >= 55) classification = 'GROWING';
  else if (heat >= 35) classification = 'DECLINING';
  else if (heat >= 15) classification = 'ENDING';

  return {
    densityShort, densityMid, densityLong,
    velocity, decay, recovery, heat, classification,
    drawsSinceLastHit
  };
}

// -----------------------------------------------------------------------
// DYNAMIC DOMINANCE (native 3-ball adaptation of dynamicDominanceEngine.js)
// -- rolling/weighted/momentum/projected dominance, same formulas, keyed
// to threeBallColor.
// -----------------------------------------------------------------------
const DD_SHORT_WINDOW = 10;
const DD_MID_WINDOW = 20;
const DD_LONG_WINDOW = 30;
const DD_HALF_LIFE = 5;

function ddEmptyCounts() { return { RED: 0, BLUE: 0, GREEN: 0 }; }

function ddWeightedCounts3B(historicalDraws, windowSize) {
  const window = historicalDraws.slice(0, windowSize);
  const counts = ddEmptyCounts();
  window.forEach((d, i) => {
    if (!d.threeBallColor || counts[d.threeBallColor] === undefined) return;
    const weight = Math.pow(0.5, i / DD_HALF_LIFE);
    counts[d.threeBallColor] += weight;
  });
  return counts;
}

function ddTotalOf(counts) {
  return HIERARCHY.reduce((sum, c) => sum + (counts[c] || 0), 0) || 1;
}

function ddClosestRivalGap(counts, leader) {
  const rivals = HIERARCHY.filter(c => c !== leader);
  const topRival = rivals.reduce((best, c) => (counts[c] > counts[best] ? c : best), rivals[0]);
  return (counts[leader] || 0) - (counts[topRival] || 0);
}

function computeThreeBallDynamicDominance(historicalDraws, staticDominantColor) {
  const shortCounts = ddWeightedCounts3B(historicalDraws, DD_SHORT_WINDOW);
  const longCounts = ddWeightedCounts3B(historicalDraws, DD_LONG_WINDOW);

  const rollingLeaderShort = argMaxColorBy(shortCounts);
  const rollingLeaderLong = argMaxColorBy(longCounts);

  const totalShort = ddTotalOf(shortCounts);
  const totalLong = ddTotalOf(longCounts);
  const weightedDominanceShortPct = Math.round((shortCounts[rollingLeaderShort] / totalShort) * 100);
  const weightedDominanceLongPct = Math.round((longCounts[rollingLeaderLong] / totalLong) * 100);

  const gapShort = ddClosestRivalGap(shortCounts, rollingLeaderShort) / totalShort;
  const gapLong = ddClosestRivalGap(longCounts, rollingLeaderLong) / totalLong;
  const momentumDominance = Math.round((gapShort - gapLong) * 100);

  const midCounts = ddWeightedCounts3B(historicalDraws, DD_MID_WINDOW);
  const totalMid = ddTotalOf(midCounts);

  const projectedShares = {};
  HIERARCHY.forEach(c => {
    const shareShort = shortCounts[c] / totalShort;
    const shareMid = midCounts[c] / totalMid;
    const shareLong = longCounts[c] / totalLong;
    const slope = ((shareShort - shareMid) + (shareMid - shareLong)) / 2;
    projectedShares[c] = Math.max(0, Math.min(1, shareShort + slope));
  });
  const projectedLeader = argMaxColorBy(projectedShares);

  const leaderTransition = rollingLeaderShort !== rollingLeaderLong;
  const challengerTakeover = leaderTransition && rollingLeaderShort !== staticDominantColor;
  const powerShift = leaderTransition || momentumDominance < -5;

  return {
    rollingLeaderShort,
    rollingLeaderLong,
    weightedDominanceShortPct,
    weightedDominanceLongPct,
    momentumDominance,
    projectedLeader,
    projectedShares: {
      RED: Math.round(projectedShares.RED * 100),
      BLUE: Math.round(projectedShares.BLUE * 100),
      GREEN: Math.round(projectedShares.GREEN * 100)
    },
    leaderTransition,
    challengerTakeover,
    powerShift,
    challenger: leaderTransition ? rollingLeaderShort : null
  };
}

// -----------------------------------------------------------------------
// EXIT INTELLIGENCE (native 3-ball adaptation of exitIntelligenceEngine.js)
// -- same 5-factor blend (drought/density-decline/rising rival diversity/
// momentum-loss/age) and historical-exit-similarity distance, keyed to
// threeBallColor and fed by computeThreeBallSeasonMetrics above instead of
// seasonIntelligenceEngine.js's 4-ball read.
// -----------------------------------------------------------------------
const EI_RECENT_DIVERSITY_WINDOW = 10;
const EI_BASELINE_DIVERSITY_WINDOW = 25;
const EI_DROUGHT_HORIZON = 15;

function computeColorDiversity3B(historicalDraws, windowSize) {
  const window = historicalDraws.slice(0, windowSize).filter(d => d.threeBallColor);
  if (window.length === 0) return 0;
  const counts = { RED: 0, BLUE: 0, GREEN: 0 };
  window.forEach(d => { counts[d.threeBallColor] += 1; });
  const total = window.length;
  let entropy = 0;
  HIERARCHY.forEach(c => {
    const p = counts[c] / total;
    if (p > 0) entropy += -p * Math.log2(p);
  });
  return Math.round((entropy / Math.log2(HIERARCHY.length)) * 100) / 100;
}

function computeThreeBallExitIntelligence(historicalDraws, dominantColor, seasonAge, seasonMetrics) {
  const diversityRecent = computeColorDiversity3B(historicalDraws, EI_RECENT_DIVERSITY_WINDOW);
  const diversityBaseline = computeColorDiversity3B(historicalDraws, EI_BASELINE_DIVERSITY_WINDOW);
  const risingDiversity = diversityRecent - diversityBaseline;

  const droughtFactor = Math.min(1, seasonMetrics.drawsSinceLastHit / EI_DROUGHT_HORIZON);
  const densityFactor = Math.max(0, 1 - seasonMetrics.densityShort * 2);
  const diversityFactor = Math.max(0, Math.min(1, risingDiversity * 2 + 0.3));
  const momentumFactor = seasonMetrics.velocity < 0 ? Math.min(1, Math.abs(seasonMetrics.velocity) * 2) : 0;
  const ageFactor = Math.min(1, Math.max(0, (seasonAge - 10) / 15));

  const referenceProfile = { densityShort: 0.05, decay: 0.75, ageNormalized: 0.9 };
  const ageNormalized = Math.min(1, seasonAge / 25);
  const dist = Math.sqrt(
    Math.pow(seasonMetrics.densityShort - referenceProfile.densityShort, 2) +
    Math.pow((seasonMetrics.decay / 100) - referenceProfile.decay, 2) +
    Math.pow(ageNormalized - referenceProfile.ageNormalized, 2)
  );
  const maxDist = Math.sqrt(3);
  const historicalExitSimilarityPct = Math.round((1 - Math.min(1, dist / maxDist)) * 100);

  const exitProbability = Math.round(Math.min(100, Math.max(0,
    (droughtFactor * 30) +
    (densityFactor * 25) +
    (diversityFactor * 15) +
    (momentumFactor * 15) +
    (ageFactor * 15)
  )));

  let classification = 'STABLE';
  if (exitProbability >= 75) classification = 'IMMINENT_EXIT';
  else if (exitProbability >= 50) classification = 'HIGH_EXIT_RISK';
  else if (exitProbability >= 30) classification = 'ELEVATED_EXIT_RISK';

  const factors = {
    droughtFactor: Math.round(droughtFactor * 100),
    densityFactor: Math.round(densityFactor * 100),
    diversityFactor: Math.round(diversityFactor * 100),
    momentumFactor: Math.round(momentumFactor * 100),
    ageFactor: Math.round(ageFactor * 100)
  };

  return {
    exitProbability,
    classification,
    historicalExitSimilarityPct,
    factors,
    reasoning: `3-Ball exit probability ${exitProbability}% for ${dominantColor} (drought ${factors.droughtFactor}%, density-decline ${factors.densityFactor}%, rising rival diversity ${factors.diversityFactor}%, momentum-loss ${factors.momentumFactor}%, age ${factors.ageFactor}%) -- ${historicalExitSimilarityPct}% similar to a typical historical exit profile`
  };
}

// -----------------------------------------------------------------------
// FIRST APPEARANCE / RETURN TIMING -- see the module header's "WHY NOT
// REUSE firstAppearanceEngine.js DIRECTLY" note. Uses
// evaluateSuppressionIntelligence's already-correct colorDrought/
// classification/recoveryVelocity (genuinely 3-ball-valid, confirmed in
// the header) to pick the strongest dormant/recovering candidate, then
// derives a simple empirical "approximately N draws" estimate from that
// SAME color's own historical gap-between-3-ball-hits distribution.
// -----------------------------------------------------------------------

// Per-color "distance to next hit" read -- factored out of
// buildFirstAppearance3B (below) so the exact same drought/recovery-
// velocity/gap-distribution math can be run once per color for the Next
// Event Leaderboard (see buildNextEventLeaderboard3B) instead of only
// ever being computed for whichever single color currently ranks first.
// No new math: this is buildFirstAppearance3B's own per-candidate body,
// unchanged, just callable for one color at a time.
function computeColorReturnEstimate3B(historicalDraws, color, supp) {
  const chronological = historicalDraws.slice().reverse();
  const hitIndexes = [];
  chronological.forEach((d, i) => { if (d.threeBallColor === color) hitIndexes.push(i); });
  const gaps = [];
  for (let i = 1; i < hitIndexes.length; i++) gaps.push(hitIndexes[i] - hitIndexes[i - 1]);

  const sampleSize = gaps.length;
  const avgGap = sampleSize > 0 ? Math.round(mean(gaps)) : null;
  const currentDrought = (supp && supp.colorDrought) || 0;

  let approximatelyDraws = null;
  // BUGFIX: this used to default to 40 unconditionally, so a caller that
  // reads .confidence without checking .approximatelyDraws first (e.g.
  // buildFirstAppearance3B's `confidence: est.confidence`, which does
  // exactly this) could report "40% confidence" on a color with NO
  // timing estimate at all -- directly contradicting that same
  // function's own `detail` string, which correctly says "Insufficient
  // historical gap sample for a timing estimate" in that case. 0 is the
  // honest default: there's no estimate, so there's nothing to be
  // confident about. Real confidence is only ever assigned below, once
  // approximatelyDraws is actually computed.
  let confidence = 0;
  if (avgGap != null && sampleSize >= 3) {
    // Residual estimate: how much of the average gap remains, given how
    // long the drought has already run -- floored at 1 draw (never "0 or
    // negative draws remaining", which would misleadingly claim certainty).
    approximatelyDraws = Math.max(1, Math.round(avgGap - currentDrought));
    if (approximatelyDraws === 1 && currentDrought >= avgGap) {
      // Drought has already run past this color's own historical average
      // gap -- still report a small positive window rather than 0, but
      // raise confidence since this is a genuinely overdue read.
      confidence = Math.min(85, 55 + Math.round(((currentDrought - avgGap) / Math.max(1, avgGap)) * 30));
    } else {
      confidence = Math.min(80, 45 + sampleSize * 3);
    }
  }

  return { color, sampleSize, avgGap, currentDrought, approximatelyDraws, confidence };
}

function buildFirstAppearance3B(historicalDraws, suppression) {
  const candidates = HIERARCHY
    .map(c => ({ color: c, supp: suppression[c] }))
    .filter(x => x.supp && (x.supp.classification === 'SUPPRESSED' || x.supp.classification === 'RECOVERING' || x.supp.classification === 'DORMANT'))
    .sort((a, b) => {
      // Prefer RECOVERING (already showing a positive recoveryVelocity)
      // over SUPPRESSED/DORMANT, then by longest colorDrought within tier.
      const rank = s => (s === 'RECOVERING' ? 0 : s === 'SUPPRESSED' ? 1 : 2);
      const rankDiff = rank(a.supp.classification) - rank(b.supp.classification);
      if (rankDiff !== 0) return rankDiff;
      return (b.supp.colorDrought || 0) - (a.supp.colorDrought || 0);
    });

  if (candidates.length === 0) {
    return { active: false, breakoutColor: null, confidence: 0, nextAppearance: null, detail: 'No color currently classified as suppressed, dormant, or recovering.' };
  }

  const top = candidates[0];
  const color = top.color;
  const est = computeColorReturnEstimate3B(historicalDraws, color, top.supp);

  const active = top.supp.classification === 'RECOVERING' || (top.supp.classification === 'SUPPRESSED' && est.currentDrought >= (est.avgGap || 8));

  return {
    active,
    breakoutColor: color,
    classification: top.supp.classification,
    confidence: est.confidence,
    currentDrought: est.currentDrought,
    nextAppearance: { approximatelyDraws: est.approximatelyDraws, sampleSize: est.sampleSize, avgHistoricalGap: est.avgGap },
    detail: `${color} classified ${top.supp.classification} (colorDrought ${est.currentDrought} draws, recoveryVelocity ${top.supp.recoveryVelocity}).` +
      (est.approximatelyDraws != null ? ` Historical average gap between ${color} 3-ball hits is ~${est.avgGap} draws (n=${est.sampleSize}) -- approximately ~${est.approximatelyDraws} draw(s) estimated to next appearance.` : ' Insufficient historical gap sample for a timing estimate.')
  };
}

// -----------------------------------------------------------------------
// NEXT EVENT LEADERBOARD -- replaces the binary ENTER/silent gate
// (evaluateEnterNow3B, still computed above and left in this file as
// dead-but-intact code per this codebase's "don't delete working math"
// convention, just no longer read by badge/operatorAction below) as the
// primary 3SIL badge output.
//
// WHY: 3-ball hits are common (this file's own header already notes the
// tacticalEngine season boundary "almost never closes" for exactly this
// reason). A binary gate that requires >=4 independent confirmations at
// >=70% confidence before saying anything is fighting that reality --
// it sits silent for hours switching between MONITOR and PREPARE because
// the bar for ENTER is calibrated for a genuinely rare event, not a
// common one. A continuous ranking is a better fit for a market that
// transitions often: it has something to say every cycle instead of
// nothing until a rare threshold clears.
//
// HOW: ranks all three colors (not just the single top candidate
// buildFirstAppearance3B picks) by the same "distance to next hit"
// signals already computed above -- computeColorReturnEstimate3B's
// avgGap/currentDrought/approximatelyDraws (drought + gap-distribution),
// suppression[c].recoveryVelocity, and suppression[c].classification.
// No new math: this is the identical per-color read
// buildFirstAppearance3B already does for its single winner, just run
// for all three colors and sorted instead of filtered down to one.
//
// RANKING: primary sort is approximatelyDraws ascending (soonest
// estimated return first); colors with no timing estimate yet
// (insufficient gap sample) sort after every color that has one, then
// among those by classification (RECOVERING > SUPPRESSED > DORMANT >
// ACTIVE, the same rank() ordering buildFirstAppearance3B already uses)
// and colorDrought descending -- identical tie-break precedence to
// buildFirstAppearance3B's own candidate sort, just applied without the
// "must be SUPPRESSED/RECOVERING/DORMANT" filter so ACTIVE colors (a
// color currently in-season, drought near 0) still get ranked rather
// than dropped from the board entirely.
function buildNextEventLeaderboard3B(historicalDraws, suppression) {
  const classRank = s => (s === 'RECOVERING' ? 0 : s === 'SUPPRESSED' ? 1 : s === 'DORMANT' ? 2 : 3);

  const ranked = HIERARCHY.map(color => {
    const supp = suppression[color] || {};
    const est = computeColorReturnEstimate3B(historicalDraws, color, supp);
    return {
      color,
      classification: supp.classification || 'ACTIVE',
      recoveryVelocity: supp.recoveryVelocity != null ? supp.recoveryVelocity : null,
      colorDrought: est.currentDrought,
      estimatedDrawsUntilNext: est.approximatelyDraws,
      avgHistoricalGap: est.avgGap,
      sampleSize: est.sampleSize,
      // No longer needs a ternary here -- computeColorReturnEstimate3B
      // itself now returns confidence:0 whenever approximatelyDraws is
      // null (see that function's own comment), so est.confidence is
      // already correct in both cases.
      confidence: est.confidence
    };
  }).sort((a, b) => {
    // Colors with a concrete timing estimate always outrank colors
    // without one, regardless of classification.
    const aHas = a.estimatedDrawsUntilNext != null;
    const bHas = b.estimatedDrawsUntilNext != null;
    if (aHas && bHas && a.estimatedDrawsUntilNext !== b.estimatedDrawsUntilNext) {
      return a.estimatedDrawsUntilNext - b.estimatedDrawsUntilNext;
    }
    if (aHas !== bHas) return aHas ? -1 : 1;
    // Neither (or both, tied) has a usable estimate -- fall back to the
    // same classification-then-drought precedence buildFirstAppearance3B
    // already uses for its own candidate ordering.
    const rankDiff = classRank(a.classification) - classRank(b.classification);
    if (rankDiff !== 0) return rankDiff;
    return (b.colorDrought || 0) - (a.colorDrought || 0);
  });

  const summary = ranked.map(r => {
    const eta = r.estimatedDrawsUntilNext != null ? `est. ${r.estimatedDrawsUntilNext} draw(s)` : 'no estimate yet';
    return `${r.color} (${eta})`;
  }).join(' -> then ');

  return {
    ranked,
    topColor: ranked[0].color,
    summary: `Next likely: ${summary}`,
    detail: ranked.map(r =>
      `${r.color}: ${r.classification}, drought ${r.colorDrought} draw(s)` +
      (r.avgHistoricalGap != null ? `, avg historical gap ~${r.avgHistoricalGap} draws (n=${r.sampleSize})` : ', insufficient gap sample') +
      (r.estimatedDrawsUntilNext != null ? `, estimated ~${r.estimatedDrawsUntilNext} draw(s) to next hit (${r.confidence}% confidence)` : '')
    ).join(' | ')
  };
}


// -----------------------------------------------------------------------
// SEASON STAGE -- 3-ball-native equivalent of 4SIL's classifySeasonStage.
// The 3-ball stream has no discrete season archive of its own (per
// threeBallLastStandCP.js's own header: "no season concept" -- it's a
// continuous stream, unlike 4-ball's discrete ACTIVE/INACTIVE seasons), so
// this reads purely off computeThreeBallSeasonMetrics + lifecycleEngine's
// phase rather than replaying a season archive that doesn't apply here.
// -----------------------------------------------------------------------
function classifySeasonStage3B(lifecycle, seasonMetrics) {
  if (lifecycle.phase === 'DETECTION' || lifecycle.phase === 'BIRTH') {
    if (seasonMetrics.recovery >= 30) {
      return { stage: 'RECOVERY', detail: `Recovery score ${seasonMetrics.recovery} indicates re-establishing dominance after a recent dip.` };
    }
  }
  if (lifecycle.phase === 'COLLAPSE' || lifecycle.phase === 'FATIGUE') {
    return { stage: seasonMetrics.decay >= 90 ? 'COLLAPSED' : 'FATIGUED', detail: `Lifecycle phase ${lifecycle.phase}, decay ${seasonMetrics.decay}%.` };
  }
  const stageMap = {
    DETECTION: 'FORMING', BIRTH: 'FORMING', EXPANSION: 'APPROACHING',
    PRIME: 'ACTIVE', STABILIZATION: 'MATURE'
  };
  return { stage: stageMap[lifecycle.phase] || 'INACTIVE', detail: `Lifecycle phase ${lifecycle.phase} (confidence ${Math.round(lifecycle.confidence * 100)}%).` };
}

// -----------------------------------------------------------------------
// THIRD COLOR INTELLIGENCE -- mirrors 4SIL's evaluateThirdColorIntelligence
// exactly, reusing rivalPressureEngine.js's per-pair historical release
// data (already 3-ball-valid via tierValue>=3, per the header) and
// suppressionIntelligenceEngine.js's per-color read.
// -----------------------------------------------------------------------
// -----------------------------------------------------------------------
// BUGFIX (confirmed via 200-trial synthetic backtest -- see conversation
// history): evaluateThirdColorIntelligence3B and evaluateEnterNow3B's
// HISTORICAL_PATTERN_MATCH condition previously read rivalPressure
// .rivalOutlook[color].releaseProbability from rivalPressureEngine.js.
// That field is HARDCODED to mean "probability the rival lands a REAL
// 4-BALL+ hit (tierValue >= 4) within 10 draws of a dominance stretch" --
// see rivalPressureEngine.js line ~90. For the 3-ball market that
// threshold is a rare, largely unrelated event, so this field fired 0/200
// times in backtesting no matter how obvious the actual 3-ball takeover
// pattern was. rivalPressureEngine.js is shared with 4SIL and other
// engines and is NOT edited here (per the blueprint's rule against
// touching existing engines outside this file). Instead, this is a
// faithfully-adapted native 3-ball version of the exact same
// dominance-stretch / release-lookahead model, with the one line that
// needs to differ for 3-ball (the "release" bar) changed from
// tierValue>=4 to tierValue>=3 -- the actual 3-ball win condition.
// -----------------------------------------------------------------------
const TB_DOMINANCE_WINDOW = 15;      // mirrors rivalPressureEngine's DOMINANCE_WINDOW
const TB_RELEASE_LOOKAHEAD = 10;     // mirrors rivalPressureEngine's RELEASE_LOOKAHEAD
const TB_DOMINANCE_SHARE_THRESHOLD = 0.5;
const TB_MIN_RELEASE_SAMPLE = 3;
const TB_PRESSURE_STRIDE = 2;

function threeBallActivityShares(windowDraws) {
  const counts = { RED: 0, BLUE: 0, GREEN: 0 };
  windowDraws.forEach(d => HIERARCHY.forEach(c => { if (tierValue(d, c) >= 3) counts[c]++; }));
  const total = counts.RED + counts.BLUE + counts.GREEN;
  const shares = { RED: 0, BLUE: 0, GREEN: 0 };
  if (total > 0) HIERARCHY.forEach(c => { shares[c] = counts[c] / total; });
  return { counts, shares, total };
}

function computeThreeBallReleaseMatrix(historicalDraws) {
  const raw = {};
  HIERARCHY.forEach(a => {
    raw[a] = {};
    HIERARCHY.forEach(b => {
      if (a !== b) raw[a][b] = { releaseSuccesses: 0, releaseSample: 0 };
    });
  });

  const lastStart = historicalDraws.length - TB_DOMINANCE_WINDOW;
  for (let i = 0; i <= lastStart; i += TB_PRESSURE_STRIDE) {
    const windowSlice = historicalDraws.slice(i, i + TB_DOMINANCE_WINDOW);
    const { shares, total } = threeBallActivityShares(windowSlice);
    if (total === 0) continue;

    const dominant = argMaxColorBy(shares);
    if (shares[dominant] < TB_DOMINANCE_SHARE_THRESHOLD) continue;

    HIERARCHY.forEach(rival => {
      if (rival === dominant) return;
      if (i - TB_RELEASE_LOOKAHEAD >= 0) {
        raw[dominant][rival].releaseSample++;
        const afterSlice = historicalDraws.slice(i - TB_RELEASE_LOOKAHEAD, i);
        // The one intentional difference from rivalPressureEngine.js: the
        // 3-ball "release" bar is tierValue>=3 (a 3-ball hit), not >=4.
        const rivalReleased = afterSlice.some(d => tierValue(d, rival) >= 3);
        if (rivalReleased) raw[dominant][rival].releaseSuccesses++;
      }
    });
  }

  const summary = {};
  HIERARCHY.forEach(a => {
    summary[a] = {};
    HIERARCHY.forEach(b => {
      if (a === b) return;
      const cell = raw[a][b];
      summary[a][b] = cell.releaseSample >= TB_MIN_RELEASE_SAMPLE
        ? Math.round((cell.releaseSuccesses / cell.releaseSample) * 100)
        : null;
    });
  });
  return summary;
}

// Returns { [color]: releaseProbability|null } for every non-dominant color
// relative to whichever color currently holds the 3-ball dominance window --
// the 3-ball-native, tier-correct replacement for rivalPressure.rivalOutlook
// [color].releaseProbability.
function computeThreeBallRivalRelease(historicalDraws) {
  const matrix = computeThreeBallReleaseMatrix(historicalDraws);
  const currentWindow = historicalDraws.slice(0, TB_DOMINANCE_WINDOW);
  const current = threeBallActivityShares(currentWindow);
  const currentDominant = current.total > 0 ? argMaxColorBy(current.shares) : null;
  const isDominanceActive = currentDominant !== null && current.shares[currentDominant] >= TB_DOMINANCE_SHARE_THRESHOLD;

  const outlook = {};
  HIERARCHY.forEach(c => {
    if (!isDominanceActive || c === currentDominant) { outlook[c] = null; return; }
    outlook[c] = matrix[currentDominant][c] != null ? matrix[currentDominant][c] : null;
  });
  return { currentDominant, isDominanceActive, releaseProbability: outlook };
}

function evaluateThirdColorIntelligence3B(battle, rivalPressure, suppression, threeBallRelease) {
  if (!battle.active || !battle.challenger) {
    return { applicable: false, thirdColor: null, behavior: null, detail: 'No active two-color battle to evaluate a third color against.' };
  }
  const thirdColor = HIERARCHY.find(c => c !== battle.leader && c !== battle.challenger);
  if (!thirdColor) {
    return { applicable: false, thirdColor: null, behavior: null, detail: 'Could not isolate a distinct third color.' };
  }

  const outlook = rivalPressure.rivalOutlook ? rivalPressure.rivalOutlook[thirdColor] : null;
  const nativeRelease = threeBallRelease && threeBallRelease.releaseProbability
    ? threeBallRelease.releaseProbability[thirdColor]
    : null;
  const supp = suppression[thirdColor];

  let behavior;
  if (supp && supp.rollingActivity <= 15 && supp.colorDrought >= 15) {
    behavior = 'RETREATING';
  } else if (nativeRelease != null && nativeRelease >= 55) {
    behavior = 'EMERGING_NEXT_LEADER';
  } else if (supp && supp.momentumAcceleration > 0 && supp.rollingActivity >= 20) {
    behavior = 'ACCUMULATING';
  } else if (supp && supp.tierEntropy >= 1.3) {
    behavior = 'DISRUPTOR';
  } else {
    behavior = 'DORMANT';
  }

  const detail = outlook
    ? `${thirdColor} sitting out the ${battle.leader}/${battle.challenger} battle -- classified ${behavior}. 3-ball reclaim probability after similar dominant stretches: ${nativeRelease != null ? nativeRelease + '%' : 'insufficient sample'}. Cross-tier (4-ball) escalation probability: ${outlook.releaseProbability != null ? outlook.releaseProbability + '%' : 'insufficient sample'}. Suppression index: ${outlook.suppressionIndex != null ? outlook.suppressionIndex : 'n/a'}.`
    : `${thirdColor} sitting out the ${battle.leader}/${battle.challenger} battle -- classified ${behavior}. 3-ball reclaim probability: ${nativeRelease != null ? nativeRelease + '%' : 'insufficient sample'}.`;

  return { applicable: true, thirdColor, behavior, detail, rivalOutlook: outlook || null, threeBallReclaimProbability: nativeRelease };
}

// -----------------------------------------------------------------------
// ENTER NOW DECISION ENGINE -- mirrors 4SIL's evaluateEnterNow structure
// and weighting exactly (same condition families A-F; conditions G/H/I/J
// from 4SIL are 4-ball-hit-count-specific "NEW RULE" additions layered on
// top of the base 4SIL blueprint and are NOT part of the base institutional
// gate this mirrors -- 3SIL implements the core multi-confirmation gate
// the blueprint asks for, without the 4-ball-only auto-burst rule, which
// has no stated 3-ball equivalent in the blueprint).
// -----------------------------------------------------------------------
function evaluateEnterNow3B({ battle, dynamicDom, firstApp, exitIntel, thirdColorIntel, rivalPressure, transitionHistory, threeBallRelease }) {
  const conditions = [];

  const transitionBattleActive = !!(battle && battle.active);

  const battleAtMaxIntensity = transitionBattleActive && battle.battleStatus === 'LEADER_COLLAPSING';
  conditions.push({
    id: 'BATTLE_MAX_INTENSITY',
    met: battleAtMaxIntensity,
    weight: 30,
    detail: battleAtMaxIntensity
      ? `Battle status LEADER_COLLAPSING: ${battle.challenger} (${battle.challengerStrength}%) has overtaken ${battle.leader} (${battle.leaderStrength}%).`
      : `Battle status is ${transitionBattleActive ? battle.battleStatus : 'INACTIVE'} -- not yet at maximum transition intensity.`
  });

  const independentTakeover = !!dynamicDom.challengerTakeover &&
    (!battle.challenger || dynamicDom.challenger === battle.challenger || dynamicDom.rollingLeaderShort === battle.challenger);
  conditions.push({
    id: 'INDEPENDENT_TAKEOVER_CONFIRMED',
    met: independentTakeover,
    weight: 25,
    detail: independentTakeover
      ? `Dynamic Dominance confirms a challenger takeover (${dynamicDom.rollingLeaderShort} 10-draw leader vs ${dynamicDom.rollingLeaderLong} 30-draw leader).`
      : 'Dynamic Dominance does not yet corroborate a challenger takeover.'
  });

  const firstAppearanceConfirmed = firstApp.active &&
    (!battle.challenger || firstApp.breakoutColor === battle.challenger || firstApp.breakoutColor === dynamicDom.rollingLeaderShort);
  conditions.push({
    id: 'NEW_COLOR_FIRST_APPEARANCE',
    met: firstAppearanceConfirmed,
    weight: 20,
    detail: firstAppearanceConfirmed
      ? `First Appearance confirms ${firstApp.breakoutColor} breaking out (confidence ${firstApp.confidence}%).` +
        (firstApp.nextAppearance && firstApp.nextAppearance.approximatelyDraws != null
          ? ` Expected approximately ~${firstApp.nextAppearance.approximatelyDraws} draw(s) to appearance.`
          : '')
      : 'No confirmed first-appearance breakout aligned with the current challenger.'
  });

  const leaderLosingControl = exitIntel.exitProbability >= 65;
  conditions.push({
    id: 'LEADER_LOSING_CONTROL',
    met: leaderLosingControl,
    weight: 15,
    detail: `Exit Intelligence puts ${exitIntel.exitProbability}% probability on the incumbent leader losing control.`
  });

  // BUGFIX (see comment above computeThreeBallRivalRelease): this used to
  // read rivalPressure.rivalOutlook[...].releaseProbability, which measures
  // 4-ball escalation and fired 0/200 times in backtesting for the 3-ball
  // market. Now reads the native 3-ball-tier reclaim probability instead.
  const challengerRelease = battle.challenger && threeBallRelease && threeBallRelease.releaseProbability
    ? threeBallRelease.releaseProbability[battle.challenger]
    : null;
  const historicalMatch = thirdColorIntel.applicable && battle.challenger
    ? (challengerRelease != null ? challengerRelease >= 50 : false)
    : false;
  conditions.push({
    id: 'HISTORICAL_PATTERN_MATCH',
    met: historicalMatch,
    weight: 10,
    detail: historicalMatch
      ? `Historical precedent supports this takeover shape (${battle.challenger} 3-ball reclaim probability ${challengerRelease}% >= 50%).`
      : 'Insufficient or unfavorable historical precedent for this exact takeover shape.'
  });

  const cycleDue = transitionHistory && transitionHistory.detectedCycle
    ? transitionHistory.currentBattleAge >= (transitionHistory.intervalStats.mostCommonInterval - 1)
    : false;
  conditions.push({
    id: 'TRANSITION_CYCLE_DUE',
    met: cycleDue,
    weight: 15,
    detail: transitionHistory && transitionHistory.detectedCycle
      ? `${transitionHistory.detectedCycle}. Current leader has held for ${transitionHistory.currentBattleAge} draws -- ${cycleDue ? 'at or past' : 'short of'} that cycle length.`
      : 'Not enough transition history yet to detect a reliable cycle.'
  });

  const confirmedCount = conditions.filter(c => c.met).length;
  const institutionalConfidence = Math.min(97, conditions.reduce((sum, c) => sum + (c.met ? c.weight : 0), 0));

  const enterNow = confirmedCount >= ENTER_NOW_MIN_CONFIRMATIONS &&
    institutionalConfidence >= ENTER_NOW_MIN_CONFIDENCE;

  let marketReadiness;
  if (confirmedCount <= 1) marketReadiness = 'LOW';
  else if (confirmedCount === 2) marketReadiness = 'MODERATE';
  else if (confirmedCount === 3) marketReadiness = 'HIGH';
  else marketReadiness = 'OPTIMAL';

  const reasoning = enterNow
    ? `ENTER NOW: ${confirmedCount}/${conditions.length} independent conditions confirmed at ${institutionalConfidence}% institutional confidence. ${conditions.filter(c => c.met).map(c => c.detail).join(' ')}`
    : `Silent (no signal): only ${confirmedCount}/${conditions.length} conditions confirmed (requires >= ${ENTER_NOW_MIN_CONFIRMATIONS} at >= ${ENTER_NOW_MIN_CONFIDENCE}% confidence). Missing: ${conditions.filter(c => !c.met).map(c => c.id).join(', ') || 'none -- confidence threshold not met'}.`;

  return {
    enterNow,
    marketReadiness,
    institutionalConfidence,
    confirmedCount,
    conditions,
    effectiveMinConfirmations: ENTER_NOW_MIN_CONFIRMATIONS,
    effectiveMinConfidence: ENTER_NOW_MIN_CONFIDENCE,
    reasoning
  };
}

// -----------------------------------------------------------------------
// KNOWLEDGE BANK -- mirrors 4SIL's buildKnowledgeBank, but since the
// 3-ball stream has no discrete season archive (see classifySeasonStage3B
// above), this reports behavioral-library data from
// suppressionIntelligenceEngine.js plus a simple hit-count summary rather
// than season-span statistics that don't apply to a continuous market.
// -----------------------------------------------------------------------
function buildKnowledgeBank3B(historicalDraws, suppression) {
  const counts = { RED: 0, BLUE: 0, GREEN: 0 };
  historicalDraws.forEach(d => { if (d.threeBallColor && counts[d.threeBallColor] !== undefined) counts[d.threeBallColor]++; });
  const totalHits = HIERARCHY.reduce((s, c) => s + counts[c], 0);
  const mostFrequentColor = totalHits > 0 ? argMaxColorBy(counts) : null;

  const behaviourLibrary = {};
  HIERARCHY.forEach(c => {
    const sup = suppression[c] || {};
    behaviourLibrary[c] = {
      totalHits: counts[c] ?? null,
      rollingActivityPct: sup.rollingActivity ?? null,
      tierEntropy: sup.tierEntropy ?? null,
      colorDrought: sup.colorDrought ?? null,
      suppressionClassification: sup.classification ?? null
    };
  });

  return {
    totalThreeBallHits: totalHits,
    mostFrequentColor,
    colorTally: counts,
    behaviourLibrary,
    sampleWindowDraws: historicalDraws.length
  };
}

// -----------------------------------------------------------------------
// PERSISTENT INSTITUTIONAL MEMORY -- mirrors 4SIL's
// persistFourSILObservation exactly (same append-only/dedupe-by-key
// design), writing to its OWN memory object (context.persistentState,
// backed by store.threeBallSILMemory) so 3SIL never touches 4SIL's
// transitionArchive/observations/etc, satisfying the blueprint's
// "must not overwrite or alter 4SIL transition history" rule by
// construction (they are simply different objects).
// -----------------------------------------------------------------------
const THREE_SIL_MAX_OBSERVATIONS = 5000;
const THREE_SIL_MAX_TRANSITIONS = 5000;
const THREE_SIL_MAX_KNOWLEDGE_SNAPSHOTS = 500;

function persistThreeSILObservation(memory, draws, result) {
  if (!memory || typeof memory !== 'object' || !result) {
    return { persisted: false, reason: 'Persistent 3SIL memory was not supplied by the orchestrator.' };
  }

  if (!Array.isArray(memory.observations)) memory.observations = [];
  if (!Array.isArray(memory.transitionArchive)) memory.transitionArchive = [];
  if (!Array.isArray(memory.knowledgeSnapshots)) memory.knowledgeSnapshots = [];

  const latest = draws && draws[0];
  if (!latest || latest.drawId == null) {
    return { persisted: false, reason: 'No draw available to anchor the 3SIL observation.' };
  }

  const drawId = String(latest.drawId);
  const alreadyProcessed = memory.lastProcessedDrawId != null && String(memory.lastProcessedDrawId) === drawId;
  if (alreadyProcessed) {
    return { persisted: true, recorded: false, reason: 'Latest draw already incorporated; no duplicate archive entry created.' };
  }

  const now = new Date().toISOString();
  const observation = {
    drawId: latest.drawId,
    timestamp: now,
    active: Boolean(result.active),
    seasonStage: result.seasonStage ? result.seasonStage.stage : 'INACTIVE',
    dominantColor: result.dominantColor || null,
    seasonAge: result.seasonAge || 0,
    transitionBattleStatus: result.transitionBattle ? (result.transitionBattle.battleStatus || 'INACTIVE') : 'INACTIVE',
    enterNow: Boolean(result.enterNow && result.enterNow.enterNow),
    institutionalConfidence: result.enterNow ? result.enterNow.institutionalConfidence : 0,
    marketReadiness: result.enterNow ? result.enterNow.marketReadiness : 'LOW'
  };

  memory.observations.unshift(observation);
  if (memory.observations.length > THREE_SIL_MAX_OBSERVATIONS) memory.observations.length = THREE_SIL_MAX_OBSERVATIONS;

  const existingTransitions = new Set(memory.transitionArchive.map(e => `${String(e.drawId)}|${e.fromColor}|${e.toColor}`));
  const recentEvents = result.transitionHistory && Array.isArray(result.transitionHistory.recentEvents) ? result.transitionHistory.recentEvents : [];
  recentEvents.forEach(event => {
    const key = `${String(event.drawId)}|${event.fromColor}|${event.toColor}`;
    if (existingTransitions.has(key)) return;
    existingTransitions.add(key);
    memory.transitionArchive.unshift({ drawId: event.drawId, fromColor: event.fromColor, toColor: event.toColor, drawsAgoAtDetection: event.drawsAgo, recordedAt: now });
  });
  if (memory.transitionArchive.length > THREE_SIL_MAX_TRANSITIONS) memory.transitionArchive.length = THREE_SIL_MAX_TRANSITIONS;

  if (result.knowledgeBank) {
    memory.knowledgeSnapshots.unshift({
      drawId: latest.drawId,
      timestamp: now,
      totalThreeBallHits: result.knowledgeBank.totalThreeBallHits,
      mostFrequentColor: result.knowledgeBank.mostFrequentColor,
      colorTally: result.knowledgeBank.colorTally,
      behaviourLibrary: result.knowledgeBank.behaviourLibrary
    });
    if (memory.knowledgeSnapshots.length > THREE_SIL_MAX_KNOWLEDGE_SNAPSHOTS) memory.knowledgeSnapshots.length = THREE_SIL_MAX_KNOWLEDGE_SNAPSHOTS;
  }

  memory.lastProcessedDrawId = latest.drawId;
  memory.updatedAt = now;
  memory.schemaVersion = 1;

  return {
    persisted: true,
    recorded: true,
    observationCount: memory.observations.length,
    transitionArchiveCount: memory.transitionArchive.length,
    knowledgeSnapshotCount: memory.knowledgeSnapshots.length,
    lastProcessedDrawId: memory.lastProcessedDrawId
  };
}

/**
 * Main 3SIL entry point.
 *
 * @param {Array} historicalDraws newest-first draw history
 * @param {Object} generalP the already-computed generalParliament.js result
 *   for this cycle (used ONLY for context -- 3SIL never reads or reacts to
 *   winningColor/confidence/secondColor from it, per the blueprint's
 *   system boundary; see the module header's CRITICAL RULE).
 * @param {Object} [context] optional cross-engine context from council.js:
 *   { tieIntelligence, eventIntelligence, persistentState }
 */
function evaluateThreeBallSeasonIntelligenceLab(historicalDraws, generalP, context = {}) {
  const draws = historicalDraws || [];
  const activation = evaluateTacticalActivation(draws);
  const threeBallActivation = activation.threeBall;

  if (!threeBallActivation.active) {
    // Even with no active season, suppression/drought/gap data still
    // exists per color (evaluateSuppressionIntelligence below doesn't
    // depend on season activation) -- so the leaderboard, unlike the old
    // binary ENTER gate, still has something to report here instead of
    // going silent. This is exactly the behavior the leaderboard was
    // built to have: it never goes silent, active season or not.
    const inactiveSuppression = evaluateSuppressionIntelligence(draws);
    const inactiveLeaderboard = buildNextEventLeaderboard3B(draws, inactiveSuppression);
    const inactiveResult = {
      engine: '3SIL',
      active: false,
      seasonStage: { stage: 'INACTIVE', detail: 'No active 3-ball season detected.' },
      dominantColor: null,
      seasonAge: 0,
      dominanceIntelligence: null,
      transitionBattle: { active: false, battleStatus: 'INACTIVE' },
      thirdColorIntelligence: { applicable: false, thirdColor: null, behavior: null, detail: 'No active season.' },
      transitionHistory: buildTransitionHistory3B(draws),
      timing: { estimatedDrawsUntilTransition: null, confidence: 0 },
      enterNow: { enterNow: false, marketReadiness: 'LOW', institutionalConfidence: 0, confirmedCount: 0, conditions: [], reasoning: 'No active 3-ball season -- 3SIL remains silent.' },
      nextEventLeaderboard: inactiveLeaderboard,
      regime: { current: 'ORDERED', detail: 'No active season to classify.' },
      knowledgeBank: buildKnowledgeBank3B(draws, inactiveSuppression),
      crossEngineContext: buildCrossEngineContext3B(context),
      badge: {
        seasonStatus: 'INACTIVE', dominantColor: null, seasonAge: 0, dominanceDuration: 0, dominanceStrength: 0,
        transitionBattleStatus: 'INACTIVE', estimatedDrawsUntilTransition: null,
        transitionWarning: { level: 'LOW', score: 0, reasoning: 'No active season.' },
        riskLevel: 'LOW', transitionProbabilityPct: 0, drawsUntilNextTransition: null, currentBattleAge: 0,
        lastTransition: null, detectedCycle: null,
        intervalStats: { count: 0, avgIntervalDraws: null, medianIntervalDraws: null, longestGapDraws: null, shortestGapDraws: null, mostCommonInterval: null },
        activeCluster: null,
        nextEventLeaderboard: inactiveLeaderboard.ranked,
        topColor: inactiveLeaderboard.topColor,
        nextEventSummary: inactiveLeaderboard.summary,
        reasoning: inactiveLeaderboard.detail
      }
    };
    const persistence = persistThreeSILObservation(context.persistentState, draws, inactiveResult);
    inactiveResult.persistentMemory = {
      ...persistence,
      totalObservations: context.persistentState && Array.isArray(context.persistentState.observations) ? context.persistentState.observations.length : 0,
      totalTransitions: context.persistentState && Array.isArray(context.persistentState.transitionArchive) ? context.persistentState.transitionArchive.length : 0,
      updatedAt: context.persistentState ? context.persistentState.updatedAt : null
    };
    return inactiveResult;
  }

  const seasonAge = threeBallActivation.reconstructedSeasonAge;

  // BUGFIX #3 (confirmed via 200-trial synthetic backtest): dominantColor
  // used to be computed from the ENTIRE unbounded draws array. Because
  // 3-ball hits are common (unlike the rare 4-ball events this
  // architecture was originally built around), the tacticalEngine.js
  // season boundary this array is scoped to almost never closes -- a
  // 10-draw gap with zero 3-ball hits practically never happens -- so
  // "dominantColor" stayed pinned to whichever color happened to lead
  // across the whole history and essentially never updated to reflect a
  // real, already-settled takeover. That in turn made dynamicDom
  // .challengerTakeover (INDEPENDENT_TAKEOVER_CONFIRMED) fire in only
  // ~1% of trials, since it requires the CURRENT rolling leader to also
  // differ from this stale baseline.
  // FIX: bound dominantColor to a rolling SEASON_DOMINANT_WINDOW-draw
  // read instead of the full unbounded history. This is a NATIVE,
  // 3SIL-only change (does not touch the shared tacticalEngine.js file
  // or its reconstructedSeasonAge, which other engines still depend on
  // as-is) -- it only changes which draws feed 3SIL's own dominantColor.
  // Chosen window: wider than the DD_LONG_WINDOW (30) used elsewhere in
  // this file for "long-window" rolling dominance, so this remains a
  // genuinely independent signal (a longer-run "current era" baseline)
  // rather than a duplicate of rollingLeaderLong -- while still being
  // bounded, so it actually updates once a takeover has held for a
  // while. Revisit this constant if real draw data suggests a different
  // window fits the actual 3-ball cadence better.
  const SEASON_DOMINANT_WINDOW = 40;
  const dominantColorWindow = draws.slice(0, SEASON_DOMINANT_WINDOW);
  const counts = { RED: 0, BLUE: 0, GREEN: 0 };
  dominantColorWindow.forEach(d => { if (d.threeBallColor && counts[d.threeBallColor] !== undefined) counts[d.threeBallColor]++; });
  const dominantColor = argMaxColorBy(counts);

  const seasonMetrics = computeThreeBallSeasonMetrics(draws, dominantColor);
  const lifecycle = computeLifecycle(seasonAge, seasonMetrics.densityShort, threeBallActivation.consecutiveNoHitCount);
  const seasonStage = classifySeasonStage3B(lifecycle, seasonMetrics);

  const threeBallCPDraws = draws.slice().reverse().map(d => ({ drawId: d.drawId, color: d.threeBallColor || null, timestamp: d.timestamp || null }));
  const battle = threeBallLastStandCP.computeThreeBallLastStand(threeBallCPDraws);

  const rivalPressure = evaluateRivalPressure(draws);
  const suppression = evaluateSuppressionIntelligence(draws);
  const dynamicDom = computeThreeBallDynamicDominance(draws, dominantColor);
  const exitIntel = computeThreeBallExitIntelligence(draws, dominantColor, seasonAge, seasonMetrics);
  const firstApp = buildFirstAppearance3B(draws, suppression);
  // BUGFIX #1: native 3-ball-tier release probability -- see the comment
  // above computeThreeBallRivalRelease for why rivalPressure's own
  // releaseProbability field cannot be reused here.
  const threeBallRelease = computeThreeBallRivalRelease(draws);

  const thirdColorIntel = evaluateThirdColorIntelligence3B(battle, rivalPressure, suppression, threeBallRelease);
  const transitionHistory = buildTransitionHistory3B(draws);

  const recent20 = draws.slice(0, 20);
  const threeBallCounts20 = { RED: 0, BLUE: 0, GREEN: 0 };
  recent20.forEach(d => { if (d.threeBallColor && threeBallCounts20[d.threeBallColor] !== undefined) threeBallCounts20[d.threeBallColor]++; });
  const entropyData = calculateShannonEntropy(threeBallCounts20);
  const regime = {
    current: entropyData.marketRegime,
    normalizedEntropy: entropyData.normalizedEntropy,
    detail: `3-Ball activity distribution over the last ${recent20.length} draws classifies as ${entropyData.marketRegime} (normalized entropy ${entropyData.normalizedEntropy}).`
  };

  let estimatedDrawsUntilTransition = null;
  let timingConfidence = 0;
  if (transitionHistory.drawsUntilNextTransition != null) {
    estimatedDrawsUntilTransition = transitionHistory.drawsUntilNextTransition;
    timingConfidence = transitionHistory.transitionWarning.score;
  } else if (battle.active) {
    estimatedDrawsUntilTransition = Math.max(1, Math.round(10 * (1 - (battle.leaderStrength || 0) / 100)));
    timingConfidence = battle.lastStandProbability || 0;
  } else {
    estimatedDrawsUntilTransition = Math.max(1, Math.round(15 * (1 - exitIntel.exitProbability / 100)));
    timingConfidence = exitIntel.exitProbability;
  }

  const enterNowResult = evaluateEnterNow3B({
    battle,
    dynamicDom,
    firstApp,
    exitIntel,
    thirdColorIntel,
    rivalPressure,
    transitionHistory,
    threeBallRelease
  });

  const knowledgeBank = buildKnowledgeBank3B(draws, suppression);
  const crossEngineContext = buildCrossEngineContext3B(context);

  const dominanceIntelligence = {
    duration: seasonAge,
    strength: seasonMetrics.heat,
    momentum: seasonMetrics.velocity,
    stability: battle.active ? battle.leaderStrength : null,
    fatigueProgression: seasonMetrics.decay,
    recoveryCapability: seasonMetrics.recovery,
    classification: seasonMetrics.classification,
    terminalBurstDetected: battle.lastStandActive,
    terminalBurstConfidence: battle.lastStandProbability
  };

  // Next Event Leaderboard -- see buildNextEventLeaderboard3B's header
  // above for the full reasoning. Replaces the binary ENTER/PREPARE/
  // MONITOR operatorAction as the badge's primary output: a continuous
  // per-color ranking instead of a gate that goes silent between rare
  // ENTER firings.
  const nextEventLeaderboard = buildNextEventLeaderboard3B(draws, suppression);

  const badge = {
    seasonStatus: seasonStage.stage,
    dominantColor,
    seasonAge,
    dominanceDuration: seasonAge,
    dominanceStrength: dominanceIntelligence.strength,
    transitionBattleStatus: battle.active ? battle.battleStatus : 'INACTIVE',
    estimatedDrawsUntilTransition,
    transitionWarning: transitionHistory.transitionWarning,
    riskLevel: transitionHistory.transitionWarning.level === 'HIGH' ? 'VERY HIGH'
      : transitionHistory.transitionWarning.level === 'ELEVATED' ? 'HIGH' : 'MODERATE',
    transitionProbabilityPct: transitionHistory.transitionProbability.nextDrawPct,
    drawsUntilNextTransition: transitionHistory.drawsUntilNextTransition,
    currentBattleAge: transitionHistory.currentBattleAge,
    lastTransition: transitionHistory.lastTransition,
    detectedCycle: transitionHistory.detectedCycle,
    intervalStats: transitionHistory.intervalStats,
    activeCluster: transitionHistory.activeCluster,
    // Continuous ranking badge -- see buildNextEventLeaderboard3B. Never
    // silent: always has a full 3-color ranking, even when no color is
    // currently a strong candidate.
    nextEventLeaderboard: nextEventLeaderboard.ranked,
    topColor: nextEventLeaderboard.topColor,
    nextEventSummary: nextEventLeaderboard.summary,
    reasoning: nextEventLeaderboard.detail
  };

  const result = {
    engine: '3SIL',
    active: true,
    seasonStage,
    dominantColor,
    seasonAge,
    dominanceIntelligence,
    transitionBattle: battle,
    transitionHistory,
    thirdColorIntelligence: thirdColorIntel,
    firstAppearance: firstApp,
    exitIntelligence: exitIntel,
    dynamicDominance: dynamicDom,
    timing: { estimatedDrawsUntilTransition, confidence: timingConfidence },
    enterNow: enterNowResult,
    nextEventLeaderboard,
    regime,
    knowledgeBank,
    crossEngineContext,
    badge
  };

  const persistence = persistThreeSILObservation(context.persistentState, draws, result);
  result.persistentMemory = {
    ...persistence,
    totalObservations: context.persistentState && Array.isArray(context.persistentState.observations) ? context.persistentState.observations.length : 0,
    totalTransitions: context.persistentState && Array.isArray(context.persistentState.transitionArchive) ? context.persistentState.transitionArchive.length : 0,
    totalKnowledgeSnapshots: context.persistentState && Array.isArray(context.persistentState.knowledgeSnapshots) ? context.persistentState.knowledgeSnapshots.length : 0,
    lastProcessedDrawId: context.persistentState ? context.persistentState.lastProcessedDrawId : null,
    updatedAt: context.persistentState ? context.persistentState.updatedAt : null
  };

  return result;
}

// Cross-Engine Intelligence Fusion -- mirrors 4SIL's buildCrossEngineContext
// exactly: lightweight, read-only synthesis of Tie Engine + Unified Event
// Voice, already computed by council.js this cycle.
function buildCrossEngineContext3B(context) {
  const tie = context.tieIntelligence || null;
  const events = context.eventIntelligence || null;
  return {
    tieMarketVolatility: tie ? (tie.tieWarning ? tie.tieWarning.level : null) : null,
    tieNote: tie
      ? `3-Ball Tie Engine reports ${tie.tieWarning ? tie.tieWarning.level : 'LOW'} tie risk -- elevated tie activity signals broader color-competition volatility across the 3-ball market itself.`
      : 'Tie Engine data unavailable this cycle.',
    recentEventCount: events && Array.isArray(events.recentEvents) ? events.recentEvents.length : (events && events.eventLog ? events.eventLog.length : null),
    eventNote: events ? 'Unified Event Voice intelligence available for cross-reference.' : 'Event Intelligence data unavailable this cycle.'
  };
}

module.exports = {
  ENTER_NOW_MIN_CONFIRMATIONS,
  ENTER_NOW_MIN_CONFIDENCE,
  classifySeasonStage3B,
  evaluateThirdColorIntelligence3B,
  buildTransitionHistory3B,
  evaluateEnterNow3B,
  buildKnowledgeBank3B,
  computeThreeBallSeasonMetrics,
  computeThreeBallDynamicDominance,
  computeThreeBallExitIntelligence,
  buildFirstAppearance3B,
  computeColorReturnEstimate3B,
  buildNextEventLeaderboard3B,
  persistThreeSILObservation,
  evaluateThreeBallSeasonIntelligenceLab
};
