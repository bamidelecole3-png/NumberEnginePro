/**
 * Market Research Engine module for RED, BLUE, GREEN.
 */
const { HIERARCHY } = require('../core/colorMath');

function buildMarketResearchReport(store) {
  const historicalDraws = store.historicalDraws;
  const counts = { RED: 0, BLUE: 0, GREEN: 0 };
  const lastIndexMap = { RED: null, BLUE: null, GREEN: null };

  for (let i = historicalDraws.length - 1; i >= 0; i--) {
    const d = historicalDraws[i];
    if (d.fourBallColor && counts[d.fourBallColor] !== undefined) {
      counts[d.fourBallColor] = (counts[d.fourBallColor] || 0) + 1;
      lastIndexMap[d.fourBallColor] = i;
    }
  }

  const sortedColors = HIERARCHY.map(col => ({
    color: col,
    totalEvents: counts[col] || 0,
    lastDrawsAgo: lastIndexMap[col] !== null ? lastIndexMap[col] : 'Never'
  })).sort((a, b) => b.totalEvents - a.totalEvents);

  return {
    lifetimeLeader: sortedColors[0] ? sortedColors[0].color : 'RED',
    secondPosition: sortedColors[1] ? sortedColors[1].color : 'BLUE',
    thirdPosition: sortedColors[2] ? sortedColors[2].color : 'GREEN',
    trailingColor: sortedColors[sortedColors.length - 1] ? sortedColors[sortedColors.length - 1].color : 'GREEN',
    leadershipTable: sortedColors
  };
}

module.exports = {
  buildMarketResearchReport
};
