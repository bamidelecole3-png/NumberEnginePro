/**
 * Meta-Intelligence Orchestration Layer.
 * Evaluates:
 * 1. Active Market Regime (Shannon Entropy).
 * 2. Regime-Aware Engine Track Records.
 * 3. Coalition Precision & Disagreement Analysis.
 * 4. Rare Anomaly Overrides (4B First Appearance / Last Stand breakthroughs).
 * 5. Meta Decision Synthesis.
 */
const { calculateShannonEntropy } = require('../engines/shannonEntropy');
const { argMaxColorBy } = require('../core/colorMath');
const { store } = require('../core/store');

function evaluateMetaIntelligence(generalP, fourBallP, historicalDraws, arbitrationResult) {
  // Step 1: Detect Active Market Regime based on recent 20 draws
  const recent20 = historicalDraws.slice(0, 20);
  const colorCounts20 = { RED: 0, BLUE: 0, GREEN: 0 };
  recent20.forEach(d => {
    if (d.threeBallColor && colorCounts20[d.threeBallColor] !== undefined) {
      colorCounts20[d.threeBallColor]++;
    }
  });

  const entropyData = calculateShannonEntropy(colorCounts20);
  const activeRegime = entropyData.marketRegime; // 'ORDERED' | 'TRANSITION' | 'CHAOTIC'

  // Step 2: Compute Regime-Weighted Score per Color based on Engine Track Record in current Regime
  const regimeWeightedScores = { RED: 0, BLUE: 0, GREEN: 0 };
  const allVotes = arbitrationResult.votes || [];

  const regimeStats = store.regimeEngineStats[activeRegime] || {};

  allVotes.forEach(vote => {
    if (!vote.eligible || !vote.color) return;

    const baseWeight = store.engineWeights[vote.name] || 1.0;
    const engineRegimeStat = regimeStats[vote.name] || { precision: 0.80 };
    const regimePrecision = engineRegimeStat.precision || 0.80;

    // Weight formula: base Weight * regime Precision * (vote Confidence / 100)
    const weightedImpact = baseWeight * (0.5 + regimePrecision) * (vote.confidence / 100);
    if (regimeWeightedScores[vote.color] !== undefined) {
      regimeWeightedScores[vote.color] += weightedImpact;
    }
  });

  const metaRegimeColor = argMaxColorBy(regimeWeightedScores);

  // Step 3: Rare Anomaly & Override Scanner
  let anomalyOverride = false;
  let overrideColor = null;
  let overrideReason = null;

  // Anomaly Check B: 4Ball First Appearance or Last Stand Breakthrough
  if (!anomalyOverride && fourBallP.active) {
    const firstAppVote = (fourBallP.votes || []).find(v => v.name === '4B_FirstAppearance');
    const lastStandVote = (fourBallP.votes || []).find(v => v.name === '4B_LastStand');

    if (firstAppVote && firstAppVote.eligible && firstAppVote.confidence >= 82) {
      anomalyOverride = true;
      overrideColor = firstAppVote.color;
      overrideReason = `4Ball First Appearance Dormant Breakout (${firstAppVote.color}) triggered with ${firstAppVote.confidence}% confidence.`;
    } else if (lastStandVote && lastStandVote.eligible && lastStandVote.confidence >= 85) {
      anomalyOverride = true;
      overrideColor = lastStandVote.color;
      overrideReason = `4Ball Last Stand Terminal Burst (${lastStandVote.color}) triggered with ${lastStandVote.confidence}% confidence.`;
    }
  }

  // Step 4: Meta Action & Final Color Synthesis
  let finalRecommendedColor = anomalyOverride ? overrideColor : metaRegimeColor;

  // Step 5: Evaluate Coalition Strength -- computed against the FINAL
  // recommended color, not metaRegimeColor. Without this, an anomaly
  // override could recommend one color while coalitionStrength /
  // leadingCoalitionEngines kept describing the coalition behind the
  // pre-override regime consensus color instead.
  const leadingCoalitionEngines = arbitrationResult.coalitions[finalRecommendedColor] || [];
  const coalitionStrength = leadingCoalitionEngines.length;

  let metaAction = 'WAIT';
  let metaConfidence = 50;
  let rationale = [];

  const topColorScore = regimeWeightedScores[finalRecommendedColor] || 0;
  const totalScores = Object.values(regimeWeightedScores).reduce((a, b) => a + b, 0) || 1;
  const scoreShare = topColorScore / totalScores;

  if (anomalyOverride) {
    metaAction = 'ENTER';
    metaConfidence = 88;
    rationale.push(overrideReason);
  } else if (activeRegime === 'CHAOTIC' && arbitrationResult.disagreementIndex > 0.85) {
    metaAction = 'DO_NOT_TRADE';
    metaConfidence = 35;
    rationale.push(`Market Regime is CHAOTIC (Entropy: ${entropyData.normalizedEntropy}) with critical disagreement (${arbitrationResult.disagreementIndex}). Trade vetoed.`);
  } else if (fourBallP.active && fourBallP.winningColor === finalRecommendedColor) {
    metaAction = 'ENTER';
    metaConfidence = Math.min(95, Math.round(60 + scoreShare * 40));
    rationale.push(`4Ball Active Season alignment with ${finalRecommendedColor} supported by ${activeRegime} regime stats.`);
  } else if (scoreShare >= 0.45 && coalitionStrength >= 4) {
    metaAction = 'ENTER';
    metaConfidence = Math.min(92, Math.round(55 + scoreShare * 45));
    rationale.push(`Regime-weighted coalition consensus (${coalitionStrength} engines) favors ${finalRecommendedColor} in ${activeRegime} regime.`);
  } else {
    metaAction = 'HOLD';
    metaConfidence = Math.max(45, Math.round(scoreShare * 100));
    rationale.push(`Sub-threshold coalition strength in ${activeRegime} market regime.`);
  }

  return {
    metaAction,
    recommendedColor: finalRecommendedColor,
    metaConfidence,
    activeRegime,
    entropy: entropyData.normalizedEntropy,
    regimeWeightedScores,
    anomalyOverride,
    overrideReason,
    coalitionStrength,
    leadingCoalitionEngines,
    reasoning: rationale.join(' ')
  };
}

module.exports = {
  evaluateMetaIntelligence
};
