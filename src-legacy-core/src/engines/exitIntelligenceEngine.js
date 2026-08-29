/**
 * 4-Ball Exit Intelligence Engine.
 *
 * Blueprint "4-Ball Engine Roadmap -> Exit Intelligence": replaces the flat
 * "seasonAge > 12 -> high exit risk" threshold with a real probability
 * model blending several independent signals:
 *
 *   - Drought: how long since the leader's last hit, relative to a
 *     15-draw horizon.
 *   - Declining density: how thin the leader's recent hit rate has become
 *     (reads directly off seasonIntelligenceEngine's densityShort).
 *   - Rising diversity: whether the OTHER colors have been claiming a
 *     growing share of 4-ball hits recently vs. their longer-run baseline
 *     (a Shannon-entropy read over the recent vs. baseline window).
 *   - Loss of momentum: seasonIntelligenceEngine's velocity, when negative.
 *   - Historical exit similarity: how close the season's current profile
 *     (density, decay, normalized age) sits to a canonical "typical exit"
 *     reference profile, via normalized Euclidean distance.
 *
 * Requires seasonIntelligenceEngine's output as an input so the two engines
 * share one consistent read on density/velocity/decay rather than
 * recomputing it differently.
 */

const { HIERARCHY } = require('../core/colorMath');

const RECENT_DIVERSITY_WINDOW = 10;
const BASELINE_DIVERSITY_WINDOW = 25;
const DROUGHT_HORIZON = 15;

// Normalized (0-1) Shannon entropy of 4-ball hit distribution across all
// three colors within a window -- 0 means one color took every hit
// (maximally concentrated), 1 means hits split perfectly evenly across
// RED/BLUE/GREEN (maximally diverse).
function computeColorDiversity(historicalDraws, windowSize) {
  const window = historicalDraws.slice(0, windowSize).filter(d => d.fourBallColor);
  if (window.length === 0) return 0;

  const counts = { RED: 0, BLUE: 0, GREEN: 0 };
  window.forEach(d => { counts[d.fourBallColor] += 1; });
  const total = window.length;

  let entropy = 0;
  HIERARCHY.forEach(c => {
    const p = counts[c] / total;
    if (p > 0) entropy += -p * Math.log2(p);
  });
  return Math.round((entropy / Math.log2(HIERARCHY.length)) * 100) / 100;
}

function evaluateExitIntelligence(historicalDraws, dominantColor, seasonAge, seasonIntel) {
  const diversityRecent = computeColorDiversity(historicalDraws, RECENT_DIVERSITY_WINDOW);
  const diversityBaseline = computeColorDiversity(historicalDraws, BASELINE_DIVERSITY_WINDOW);
  const risingDiversity = diversityRecent - diversityBaseline; // positive = rivals gaining ground recently

  // Uses seasonIntel.drawsSinceLastHit (the DOMINANT color's own drought,
  // computed once in seasonIntelligenceEngine.js) rather than a separately
  // passed generic "any color" gap, so both engines always agree on how
  // long the leader has actually been quiet.
  const droughtFactor = Math.min(1, seasonIntel.drawsSinceLastHit / DROUGHT_HORIZON);
  const densityFactor = Math.max(0, 1 - seasonIntel.densityShort * 2);
  const diversityFactor = Math.max(0, Math.min(1, risingDiversity * 2 + 0.3));
  const momentumFactor = seasonIntel.velocity < 0 ? Math.min(1, Math.abs(seasonIntel.velocity) * 2) : 0;
  const ageFactor = Math.min(1, Math.max(0, (seasonAge - 10) / 15));

  // Historical exit similarity: distance from a canonical "typical exit"
  // reference profile (near-zero recent density, heavily decayed, late
  // season age), expressed as a similarity percentage rather than a raw
  // distance so it reads the same direction as the other factors (higher =
  // more exit-like).
  const referenceProfile = { densityShort: 0.05, decay: 0.75, ageNormalized: 0.9 };
  const ageNormalized = Math.min(1, seasonAge / 25);
  const dist = Math.sqrt(
    Math.pow(seasonIntel.densityShort - referenceProfile.densityShort, 2) +
    Math.pow((seasonIntel.decay / 100) - referenceProfile.decay, 2) +
    Math.pow(ageNormalized - referenceProfile.ageNormalized, 2)
  );
  const maxDist = Math.sqrt(3); // theoretical max distance across 3 unit-normalized dimensions
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
    reasoning: `Exit probability ${exitProbability}% for ${dominantColor} (drought ${factors.droughtFactor}%, density-decline ${factors.densityFactor}%, rising rival diversity ${factors.diversityFactor}%, momentum-loss ${factors.momentumFactor}%, age ${factors.ageFactor}%) — ${historicalExitSimilarityPct}% similar to a typical historical exit profile`
  };
}

module.exports = {
  RECENT_DIVERSITY_WINDOW,
  BASELINE_DIVERSITY_WINDOW,
  DROUGHT_HORIZON,
  computeColorDiversity,
  evaluateExitIntelligence
};
