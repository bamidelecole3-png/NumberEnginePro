/**
 * Behavioral Fingerprint Engine module for RED, BLUE, GREEN.
 */
const { HIERARCHY } = require('../core/colorMath');

function buildBehaviorFingerprints(historicalDraws) {
  const fingerprints = {};

  HIERARCHY.forEach(col => {
    let hits = 0;
    let clusters = 0;
    let repeats = 0;
    let maxDrought = 0;
    let currentDrought = 0;
    const gaps = [];
    let prevHitIndex = -1;

    for (let i = historicalDraws.length - 1; i >= 0; i--) {
      const draw = historicalDraws[i];
      const isHit = draw.fourBallColor === col;
      if (isHit) {
        hits++;
        if (prevHitIndex !== -1) {
          const gap = prevHitIndex - i;
          gaps.push(gap);
          if (gap === 1) repeats++;
          if (gap <= 3) clusters++;
        }
        prevHitIndex = i;
        currentDrought = 0;
      } else {
        currentDrought++;
        if (currentDrought > maxDrought) maxDrought = currentDrought;
      }
    }

    const avgGap = gaps.length > 0 ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null;
    const clusterTendency = hits > 1 ? Math.round((clusters / hits) * 100) : 0;
    const repeatTendency = hits > 1 ? Math.round((repeats / hits) * 100) : 0;
    const recoverySpeed = avgGap ? (avgGap <= 5 ? 'FAST' : avgGap <= 12 ? 'MODERATE' : 'SLOW') : 'UNKNOWN';

    fingerprints[col] = {
      color: col,
      totalHits: hits,
      avgGap,
      maxDrought,
      clusterTendencyScore: clusterTendency,
      repeatTendencyScore: repeatTendency,
      recoverySpeed,
      personalitySummary: `${col} exhibits ${recoverySpeed.toLowerCase()} recovery with ${clusterTendency}% cluster tendency.`
    };
  });

  return fingerprints;
}

module.exports = {
  buildBehaviorFingerprints
};
