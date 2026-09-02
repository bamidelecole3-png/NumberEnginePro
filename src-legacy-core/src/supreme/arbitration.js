/**
 * Cross-Engine Contradiction & Coalition Engine.
 */
const { calculateShannonEntropy } = require('../engines/shannonEntropy');

function arbitrateDecisions(generalP, fourBallP) {
  const votes = [
    ...(generalP.votes || []),
    ...(fourBallP.votes || []),
  ];

  const voteCounts = { RED: 0, BLUE: 0, GREEN: 0 };
  votes.forEach(v => {
    if (v.eligible && voteCounts[v.color] !== undefined) {
      voteCounts[v.color]++;
    }
  });

  const entropyResult = calculateShannonEntropy(voteCounts);
  const disagreementIndex = entropyResult.normalizedEntropy;

  const coalitions = {
    RED: votes.filter(v => v.eligible && v.color === 'RED').map(v => v.name),
    BLUE: votes.filter(v => v.eligible && v.color === 'BLUE').map(v => v.name),
    GREEN: votes.filter(v => v.eligible && v.color === 'GREEN').map(v => v.name)
  };

  const activePickMap = {};
  if (generalP.active && generalP.winningColor) activePickMap.general = generalP.winningColor;
  if (fourBallP.active && fourBallP.winningColor) activePickMap.fourBall = fourBallP.winningColor;
  const picks = Object.values(activePickMap);
  const uniquePicks = new Set(picks);

  let consensus = 'SPLIT';
  let isUnanimous = false;

  if (picks.length > 0 && uniquePicks.size === 1) {
    consensus = 'UNANIMOUS';
    isUnanimous = true;
  } else if (picks.length > 1 && uniquePicks.size < picks.length) {
    consensus = 'MAJORITY';
  }

  return {
    consensus,
    isUnanimous,
    disagreementIndex,
    coalitions,
    activePickMap,
    votes,
    voteCounts
  };
}

module.exports = {
  arbitrateDecisions
};
