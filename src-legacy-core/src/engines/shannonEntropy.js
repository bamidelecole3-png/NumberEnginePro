/**
 * Shannon Entropy Calculator.
 */
function calculateShannonEntropy(colorCounts) {
  if (!colorCounts || typeof colorCounts !== 'object') {
    return { entropy: 1.58, normalizedEntropy: 1.0, marketRegime: 'CHAOTIC' };
  }
  const total = Object.values(colorCounts).reduce((a, b) => a + b, 0);
  if (total === 0) return { entropy: 1.58, normalizedEntropy: 1.0, marketRegime: 'CHAOTIC' };

  let entropy = 0;
  for (const count of Object.values(colorCounts)) {
    if (count > 0) {
      const p = count / total;
      entropy -= p * Math.log2(p);
    }
  }
  const normalizedEntropy = Math.round((entropy / 1.585) * 100) / 100;
  return {
    entropy: Math.round(entropy * 100) / 100,
    normalizedEntropy,
    marketRegime: normalizedEntropy > 0.85 ? 'CHAOTIC' : normalizedEntropy > 0.60 ? 'TRANSITION' : 'ORDERED'
  };
}

module.exports = {
  calculateShannonEntropy
};
