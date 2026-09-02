/**
 * Gap Evolution Engine module for RED, BLUE, GREEN.
 */
const { HIERARCHY } = require('../core/colorMath');

function analyzeGapEvolution(historicalDraws) {
  const gapStats = {};

  // historicalDraws is newest-first (index 0 = most recent draw), per
  // store.js's unshift(). Walking i = 0..length therefore walks backward
  // in time, and the first match found for a color is its most recent hit.

  HIERARCHY.forEach(col => {
    const gaps = [];
    let currentGap = 0;      // draws since the most recent hit (fixed once found)
    let lastHitIndex = null; // index of the previous hit seen while walking back
    let foundFirst = false;

    for (let i = 0; i < historicalDraws.length; i++) {
      const d = historicalDraws[i];
      if (d.fourBallColor === col) {
        if (!foundFirst) {
          currentGap = i;
          foundFirst = true;
        } else {
          gaps.push(i - lastHitIndex);
        }
        lastHitIndex = i;
      }
    }

    const meanGap = gaps.length > 0 ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 15;
    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const medianGap = sortedGaps.length > 0 ? sortedGaps[Math.floor(sortedGaps.length / 2)] : meanGap;
    const minGap = sortedGaps.length > 0 ? sortedGaps[0] : 5;
    const maxGap = sortedGaps.length > 0 ? sortedGaps[sortedGaps.length - 1] : 30;

    const gapVelocity = currentGap > meanGap ? 'EXPANDING' : 'COMPRESSING';
    const overdueProb = Math.min(95, Math.round((currentGap / (meanGap || 1)) * 50));

    gapStats[col] = {
      color: col,
      currentGap,
      meanGap,
      medianGap,
      minGap,
      maxGap,
      gapVelocity,
      overdueProbability: overdueProb,
      expectedOpportunityWindow: `Draws ${Math.max(1, meanGap - 2)} - ${meanGap + 4}`
    };
  });

  return gapStats;
}

module.exports = {
  analyzeGapEvolution
};
