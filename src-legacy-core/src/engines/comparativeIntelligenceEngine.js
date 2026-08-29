/**
 * Comparative Intelligence Engine module for RED, BLUE, GREEN.
 */
const { HIERARCHY } = require('../core/colorMath');

function runComparativeIntelligence(historicalDraws) {
  const recent30 = historicalDraws.slice(0, 30);
  const fourBallCounts = { RED: 0, BLUE: 0, GREEN: 0 };

  recent30.forEach(d => {
    if (d.fourBallColor && fourBallCounts[d.fourBallColor] !== undefined) {
      fourBallCounts[d.fourBallColor]++;
    }
  });

  let transferabilityScore = 65;
  let momentumTransfers = false;

  for (const c of HIERARCHY) {
    if (fourBallCounts[c] >= 2) {
      momentumTransfers = true;
      transferabilityScore += 10;
    }
  }

  transferabilityScore = Math.min(95, transferabilityScore);

  return {
    transferabilityScore,
    momentumTransfers,
    indicators: {
      momentumTransfer: momentumTransfers ? 'STRONG' : 'MODERATE',
      firstAppearanceTransfer: 'HIGH',
      lastStandTransfer: 'MODERATE'
    },
    reasoning: `4B to 5B indicator transferability evaluated at ${transferabilityScore}% confidence.`
  };
}

module.exports = {
  runComparativeIntelligence
};
