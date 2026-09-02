/**
 * 4Ball Parliament — 14 Specialist Autonomous Engines (11 original +
 * Season Intelligence, Dynamic Dominance, and Challenger Engine from the
 * "4-Ball Engine Roadmap" blueprint; Exit Intelligence replaces the
 * original ExitIntel engine's logic in place rather than adding a vote).
 * Strictly 3-color (RED, BLUE, GREEN).
 */
const { store } = require('../core/store');
const { evaluateTacticalActivation } = require('../engines/tacticalEngine');
const { evaluateEntryQuality } = require('../engines/entryIntelligenceEngine');
const { evaluateCapitalProtection } = require('../engines/capitalProtectionEngine');
const { computeLifecycle } = require('../engines/lifecycleEngine');
const { evaluateFirstAppearance } = require('../engines/firstAppearanceEngine');
const { evaluateLastStand } = require('../engines/lastStandEngine');
const { evaluateDNAMatching } = require('../engines/dnaMatchingEngine');
const { evaluateSeasonIntelligence } = require('../engines/seasonIntelligenceEngine');
const { evaluateExitIntelligence } = require('../engines/exitIntelligenceEngine');
const { evaluateDynamicDominance } = require('../engines/dynamicDominanceEngine');
const { evaluateChallengerEmergence } = require('../engines/challengerEngine');
const { HIERARCHY, argMaxColorBy, topNColorsBy } = require('../core/colorMath');

function runFourBallParliament(historicalDraws) {
  const tactical = evaluateTacticalActivation(historicalDraws);
  const activation = tactical.fourBall;

  if (!activation.active) {
    return {
      parliament: '4Ball',
      active: false,
      status: 'NO ACTIVE 4BALL SEASON',
      winningColor: null,
      confidence: 0,
      secondColor: null,
      secondConfidence: 0,
      votes: []
    };
  }

  const weights = store.engineWeights;
  const colorScores = { RED: 0, BLUE: 0, GREEN: 0 };
  const votes = [];
  const counts = { RED: 0, BLUE: 0, GREEN: 0 };
  const seasonAge = activation.reconstructedSeasonAge;

  for (const d of historicalDraws) {
    if (d.fourBallColor && counts[d.fourBallColor] !== undefined) {
      counts[d.fourBallColor]++;
    }
  }
  const dominantColor = argMaxColorBy(counts);

  // Season Intelligence (blueprint "4-Ball Engine Roadmap -> Season
  // Intelligence"): a real density/velocity/acceleration/decay/recovery
  // read on the CURRENT leader, computed once here and shared by both the
  // new 4B_SeasonIntelligence vote below and the Exit Intelligence engine
  // (which needs the same density/velocity/decay reads to stay consistent
  // with each other rather than recomputing them independently).
  const seasonIntel = evaluateSeasonIntelligence(historicalDraws, dominantColor, seasonAge);

  // 1. Season Strength Engine
  colorScores[dominantColor] += 30 * (weights['4B_SeasonStrength'] || 1.8);
  votes.push({
    name: '4B_SeasonStrength', council: '4-Ball', color: dominantColor, confidence: 85, eligible: true,
    reason: `Dominant 4ball season leader with reconstructed age ${seasonAge}`
  });

  // 2. Entry Intel Engine
  // Previously called with a hardcoded confidence of 80 and no
  // dominanceScore, so the engine's confidence/dominance factors (35%+20%
  // of its weighted score) were fed placeholder values regardless of what
  // this season's data actually showed -- even though this parliament
  // already computes both: seasonIntel.heat (real strength read, used
  // as-is for the SeasonIntelligence vote's own confidence below) and the
  // dominant color's real share of counted 4-ball events.
  const totalFourBallHits = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
  const dominanceSharePct = Math.round((counts[dominantColor] / totalFourBallHits) * 100);
  // Preliminary call — transRisk and exitIntel are computed later in the
  // parliament loop, so we use conservative defaults here purely for the
  // vote score. The full Tier-Engine-depth result (with all fields) is
  // recomputed as `fullEntryIntelligence` after those values are known.
  const entryQuality = evaluateEntryQuality(seasonAge, seasonIntel.heat, dominantColor, {
    dominanceScore: dominanceSharePct
  });
  colorScores[dominantColor] += Math.round(25 * entryQuality.entryScore * (weights['4B_EntryIntel'] || 1.6));
  votes.push({
    name: '4B_EntryIntel', council: '4-Ball', color: dominantColor,
    confidence: Math.round(entryQuality.entryScore * 100), eligible: entryQuality.safeToEnter,
    reason: entryQuality.reasoning
  });

  // 3. Exit Intel Engine
  // Blueprint "4-Ball Engine Roadmap -> Exit Intelligence": was a flat
  // `seasonAge > 12 ? 75 : 20` threshold with no reference to what the
  // season is actually doing. Now a real probability blending drought,
  // declining density, rising rival diversity, momentum loss, and
  // similarity to a canonical historical exit profile -- see
  // evaluateExitIntelligence(). `exitRisk` stays the name used by every
  // downstream consumer below (Transition Risk, Capital Protection) so
  // their existing logic keeps working unchanged against a materially
  // better number.
  const exitIntel = evaluateExitIntelligence(historicalDraws, dominantColor, seasonAge, seasonIntel);
  const exitRisk = exitIntel.exitProbability;
  votes.push({
    name: '4B_ExitIntel', council: '4-Ball', color: dominantColor, confidence: 100 - exitRisk, eligible: exitRisk < 70,
    reason: exitIntel.reasoning
  });

  // 4. Autonomous First Appearance Engine
  const firstApp = evaluateFirstAppearance(historicalDraws);
  if (firstApp.active) {
    colorScores[firstApp.breakoutColor] += 22 * (weights['4B_FirstAppearance'] || 1.4);
  }
  votes.push({
    name: '4B_FirstAppearance', council: '4-Ball', color: firstApp.breakoutColor, confidence: firstApp.confidence, eligible: firstApp.active,
    reason: firstApp.nextAppearance && firstApp.nextAppearance.approximatelyDraws != null
      ? `${firstApp.reasoning} Approximate next appearance: ~${firstApp.nextAppearance.approximatelyDraws} draw(s); window ${firstApp.nextAppearance.forecastWindow.fromDraws}-${firstApp.nextAppearance.forecastWindow.toDraws}.`
      : firstApp.reasoning
  });

  // 5. Autonomous Last Stand Engine
  const lastStand = evaluateLastStand(historicalDraws, dominantColor, seasonAge);
  if (lastStand.isLastStand) {
    colorScores[lastStand.terminalBurstColor] += 20 * (weights['4B_LastStand'] || 1.5);
  }
  votes.push({
    name: '4B_LastStand', council: '4-Ball', color: lastStand.terminalBurstColor, confidence: lastStand.confidence, eligible: lastStand.isLastStand,
    reason: lastStand.reasoning
  });

  // 6. Transition Risk Engine
  const transRisk = seasonAge > 10 ? 60 : 15;
  // BUG: vote was pushed but colorScores was never updated, so the declared
  // weight '4B_TransitionRisk': 1.3 had zero effect on the final color pick.
  const transScore = Math.round((1 - transRisk / 100) * 15 * (weights['4B_TransitionRisk'] || 1.3));
  colorScores[dominantColor] += transScore;
  votes.push({
    name: '4B_TransitionRisk', council: '4-Ball', color: dominantColor, confidence: 100 - transRisk, eligible: true,
    reason: `Transition risk ${transRisk}%`
  });

  // 7. Capital Protection Engine
  // seasonState wired from Season Intelligence's classification: an
  // ENDING season now actually vetoes new trades (matching the existing
  // DEAD/EXHAUSTED veto branch in evaluateCapitalProtection) instead of
  // that branch being permanently unreachable from this call site.
  const capProtection = evaluateCapitalProtection(0, 0, exitRisk, 75, {
    seasonState: seasonIntel.classification === 'ENDING' ? 'EXHAUSTED' : 'MATURE'
  });
  if (capProtection.allowTrade) {
    colorScores[dominantColor] += 20 * (weights['4B_CapitalProtection'] || 1.9);
  }
  votes.push({
    name: '4B_CapitalProtection', council: '4-Ball', color: dominantColor, confidence: capProtection.allowTrade ? 85 : 30, eligible: capProtection.allowTrade,
    reason: capProtection.allowTrade ? `Capital protection approved` : capProtection.vetoReason
  });

  // 8. Autonomous DNA Matching Engine
  const dnaMatch = evaluateDNAMatching(historicalDraws, dominantColor);
  colorScores[dnaMatch.dnaMatchColor] += 18 * (weights['4B_DNA'] || 1.3);
  votes.push({
    name: '4B_DNA', council: '4-Ball', color: dnaMatch.dnaMatchColor, confidence: dnaMatch.confidence, eligible: true,
    reason: dnaMatch.reasoning
  });

  // 9. Lifecycle Engine
  // BUGFIX: colorScores was never updated here, so the allocated weight
  // '4B_Lifecycle': 1.4 in store.js had zero effect on the final color
  // selection — the vote was pushed but never counted in the tally.
  const lc = computeLifecycle(seasonAge, 0.5, activation.consecutiveNoHitCount);
  colorScores[dominantColor] += Math.round(15 * lc.confidence * (weights['4B_Lifecycle'] || 1.4));
  votes.push({
    name: '4B_Lifecycle', council: '4-Ball', color: dominantColor, confidence: Math.round(lc.confidence * 100), eligible: true,
    reason: `Lifecycle phase: ${lc.phase}`
  });

  // 10. Recovery Engine
  // BUG: vote was pushed but colorScores was never updated, so the declared
  // weight '4B_Recovery': 1.2 had zero effect on the final color pick.
  colorScores[dominantColor] += 12 * (weights['4B_Recovery'] || 1.2);
  votes.push({
    name: '4B_Recovery', council: '4-Ball', color: dominantColor, confidence: 70, eligible: true,
    reason: `Recovery probability stable`
  });

  // 11. Dominance Engine
  colorScores[dominantColor] += 15 * (weights['4B_Dominance'] || 1.5);
  votes.push({
    name: '4B_Dominance', council: '4-Ball', color: dominantColor, confidence: 82, eligible: true,
    reason: `Dominance score verified`
  });

  // 12. Season Intelligence Engine (blueprint: Season Intelligence)
  // Votes for the current leader, but only counts toward the final score
  // while the season is actually in a favorable phase (GROWING or PEAK) --
  // a COLD/DECLINING/ENDING read contributes reasoning without pushing the
  // score, and an ENDING read has already fed into the Capital Protection
  // veto above via seasonState.
  const seasonIntelEligible = seasonIntel.classification === 'GROWING' || seasonIntel.classification === 'PEAK';
  if (seasonIntelEligible) {
    colorScores[dominantColor] += Math.round(18 * (seasonIntel.heat / 100) * (weights['4B_SeasonIntelligence'] || 1.7));
  }
  votes.push({
    name: '4B_SeasonIntelligence', council: '4-Ball', color: dominantColor,
    confidence: seasonIntel.heat, eligible: seasonIntelEligible,
    reason: `Season heat ${seasonIntel.heat}/100, classified ${seasonIntel.classification} (density ${Math.round(seasonIntel.densityShort * 100)}%, velocity ${seasonIntel.velocity >= 0 ? '+' : ''}${seasonIntel.velocity}, decay ${seasonIntel.decay}%, recovery ${seasonIntel.recovery})`
  });

  // 13. Dynamic Dominance Engine (blueprint: Dynamic Dominance)
  // Votes for the rolling short-window leader whenever it differs from the
  // long-window leader (a challenger takeover already underway), otherwise
  // for the projected next-window leader from the weighted trend.
  const dynamicDom = evaluateDynamicDominance(historicalDraws, dominantColor);
  const dominanceVoteColor = dynamicDom.challengerTakeover ? dynamicDom.rollingLeaderShort : dynamicDom.projectedLeader;
  colorScores[dominanceVoteColor] += Math.round(16 * (weights['4B_DynamicDominance'] || 1.6));
  votes.push({
    name: '4B_DynamicDominance', council: '4-Ball', color: dominanceVoteColor,
    confidence: dynamicDom.weightedDominanceShortPct, eligible: true,
    reason: dynamicDom.powerShift
      ? `Power shift detected: rolling leader ${dynamicDom.rollingLeaderShort} (10-draw, ${dynamicDom.weightedDominanceShortPct}% weighted share) vs. established leader ${dynamicDom.rollingLeaderLong} (30-draw, ${dynamicDom.weightedDominanceLongPct}%)${dynamicDom.challengerTakeover ? ' — challenger takeover in progress' : ''}`
      : `Dominance stable: ${dynamicDom.rollingLeaderShort} leads both the 10-draw (${dynamicDom.weightedDominanceShortPct}%) and 30-draw (${dynamicDom.weightedDominanceLongPct}%) weighted windows; projected next-window leader ${dynamicDom.projectedLeader}`
  });

  // 14. Challenger Engine (blueprint: Challenger Engine)
  // Detects a non-leader color showing the suppressed -> rising-3-ball ->
  // early-4-ball pattern and votes for it with a real leadership
  // probability and expected takeover window, rather than the leader by
  // default.
  const challengerResult = evaluateChallengerEmergence(historicalDraws, dominantColor);
  if (challengerResult.active) {
    colorScores[challengerResult.challenger] += Math.round(14 * (challengerResult.leadershipProbability / 100) * (weights['4B_Challenger'] || 1.5));
  }
  votes.push({
    name: '4B_Challenger', council: '4-Ball', color: challengerResult.challenger || dominantColor,
    confidence: challengerResult.leadershipProbability, eligible: challengerResult.active,
    reason: challengerResult.reasoning
  });

  const winningColor = argMaxColorBy(colorScores);
  const rawConfidence = Math.min(95, Math.max(50, Math.round(colorScores[winningColor] / 1.2)));

  // Second-most-likely color, from the SAME aggregated colorScores every
  // engine above already voted into -- no individual engine's own logic
  // changes here. Uses this parliament's own confidence formula convention
  // (colorScores[color] / 1.2, same divisor as the winner above) rather
  // than the 3-ball parliament's totalScore-normalized version, since the
  // two parliaments' colorScores are on different scales. (No totalScore
  // is computed here for that reason -- this parliament never needed it.)
  const ranked = topNColorsBy(colorScores, 2);
  const secondColor = ranked[1] ? ranked[1].color : HIERARCHY.find(c => c !== winningColor);
  const secondScore = ranked[1] ? ranked[1].score : 0;
  const secondConfidence = Math.min(rawConfidence - 1, Math.max(30, Math.round(secondScore / 1.2)));

  // Full Tier-Engine-depth Entry Intelligence — recomputed now that
  // transRisk and exitIntel are both in scope.
  const fullEntryIntelligence = evaluateEntryQuality(seasonAge, seasonIntel.heat, dominantColor, {
    dominanceScore: dominanceSharePct,
    transitionRisk: transRisk,
    exitRisk: exitIntel ? exitIntel.exitProbability : 0,
    historicalDraws
  });

  return {
    parliament: '4Ball',
    active: true,
    status: 'ACTIVE',
    winningColor,
    confidence: rawConfidence,
    secondColor,
    secondConfidence,
    seasonAge,
    transitionRisk: transRisk,
    seasonIntelligence: seasonIntel,
    exitIntelligence: exitIntel,
    dynamicDominance: dynamicDom,
    challenger: challengerResult,
    // Exposed for 4SIL (fourBallSeasonIntelligenceLab.js) to consume
    // without recomputing -- these were already being calculated above for
    // the 4B_LastStand/4B_FirstAppearance votes, just not previously
    // returned. Purely additive: no scoring/vote logic above changed.
    lastStand,
    firstAppearance: firstApp,
    // Exposed so downstream consumers (council, UI) get the full
    // Tier-Engine-depth entry analysis without recomputing it.
    entryIntelligence: fullEntryIntelligence,
    votes
  };
}

module.exports = {
  runFourBallParliament
};
