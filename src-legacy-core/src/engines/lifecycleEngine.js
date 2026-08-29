/**
 * Lifecycle Engine module.
 * NOTE: a PHASES string-array was previously exported here but was never
 * imported by any other module -- removed as dead code.
 */

function computeLifecycle(seasonAgeInDraws, hitFrequency, consecutiveMisses) {
  if (seasonAgeInDraws <= 2) {
    return { phase: 'DETECTION', phaseIndex: 1, confidence: 0.6, remainingLifeEstimate: 18 };
  }
  if (seasonAgeInDraws <= 5) {
    return { phase: 'BIRTH', phaseIndex: 2, confidence: 0.75, remainingLifeEstimate: 15 };
  }
  if (seasonAgeInDraws <= 9) {
    return { phase: 'EXPANSION', phaseIndex: 3, confidence: 0.85, remainingLifeEstimate: 11 };
  }
  if (seasonAgeInDraws <= 14 && consecutiveMisses < 3) {
    return { phase: 'PRIME', phaseIndex: 4, confidence: 0.90, remainingLifeEstimate: 8 };
  }
  if (seasonAgeInDraws <= 18 && consecutiveMisses < 5) {
    return { phase: 'STABILIZATION', phaseIndex: 5, confidence: 0.80, remainingLifeEstimate: 5 };
  }
  if (consecutiveMisses >= 5 || seasonAgeInDraws <= 22) {
    return { phase: 'FATIGUE', phaseIndex: 6, confidence: 0.70, remainingLifeEstimate: 2 };
  }
  return { phase: 'COLLAPSE', phaseIndex: 7, confidence: 0.95, remainingLifeEstimate: 0 };
}

module.exports = {
  computeLifecycle
};
