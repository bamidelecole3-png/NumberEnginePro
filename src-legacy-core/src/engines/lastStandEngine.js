/**
 * True Last Stand Engine.
 */
function evaluateLastStand(historicalDraws, currentLeader, seasonAge) {
  const recent10 = historicalDraws.slice(0, 10);
  const leaderHits = recent10.filter(d => d.fourBallColor === currentLeader).length;
  const dominanceDecay = seasonAge > 10 ? (seasonAge - 10) * 8 : 0;
  const challengerPressure = (10 - leaderHits) * 7;
  const lastStandScore = Math.min(95, dominanceDecay + challengerPressure);
  const isLastStand = lastStandScore >= 60;

  return {
    isLastStand,
    terminalBurstColor: currentLeader,
    confidence: lastStandScore,
    reasoning: isLastStand
      ? `Leader ${currentLeader} firing terminal last-stand burst before dominance surrender (score ${lastStandScore}%)`
      : `Leader ${currentLeader} dominance stable`
  };
}

module.exports = {
  evaluateLastStand
};
