/**
 * Tactical Engine module with Exact Historical Season Age Reconstruction.
 */
function evaluateTacticalActivation(historicalDraws) {
  const recent10 = historicalDraws.slice(0, 10);

  const fourBallHits = recent10.filter(d => Boolean(d.fourBallColor));
  const fourBallActive = fourBallHits.length >= 1;

  let consecutiveNo4Ball = 0;
  let reconstructedSeasonAge = 0;
  let inActiveRun = false;

  for (let i = 0; i < historicalDraws.length; i++) {
    const d = historicalDraws[i];
    if (d.fourBallColor) {
      inActiveRun = true;
      reconstructedSeasonAge++;
    } else if (inActiveRun) {
      reconstructedSeasonAge++;
      if (i > 15 && !historicalDraws.slice(i, i + 10).some(x => x.fourBallColor)) {
        break;
      }
    } else {
      consecutiveNo4Ball++;
    }
  }

  // Mirror of the 4-ball reconstruction block above, keyed to
  // threeBallColor instead of fourBallColor -- added for the 3-Ball Entry
  // Intelligence Engine (threeBallEntryIntelligenceEngine.js), which needs
  // the same "how long has a 3-ball season been running" concept the
  // 4-ball Entry Intelligence Engine already gets from `fourBall` below.
  // threeBallColor is just as sparse an event as fourBallColor (validator.js
  // only sets it when exactly one color hits count === 3 in a draw), so
  // the identical gap-tolerant run-length reconstruction applies unchanged.
  const threeBallHits = recent10.filter(d => Boolean(d.threeBallColor));
  const threeBallActive = threeBallHits.length >= 1;

  let consecutiveNo3Ball = 0;
  let reconstructedThreeBallSeasonAge = 0;
  let inActiveRun3B = false;

  for (let i = 0; i < historicalDraws.length; i++) {
    const d = historicalDraws[i];
    if (d.threeBallColor) {
      inActiveRun3B = true;
      reconstructedThreeBallSeasonAge++;
    } else if (inActiveRun3B) {
      reconstructedThreeBallSeasonAge++;
      if (i > 15 && !historicalDraws.slice(i, i + 10).some(x => x.threeBallColor)) {
        break;
      }
    } else {
      consecutiveNo3Ball++;
    }
  }

  // BUGFIX (original): return statement was missing — function returned
  // undefined, causing fourBallParliament.js to throw on `tactical.fourBall`.
  // BUGFIX (this pass): two wrong key names in the returned object caused
  // silent `undefined` reads in fourBallParliament.js:
  //   `seasonAge` was returned but parliament read `reconstructedSeasonAge`
  //     → seasonAge was undefined throughout the entire 4-ball parliament,
  //       silently breaking entry quality, exit intelligence, last stand,
  //       lifecycle, season intelligence, and transition risk (all receive
  //       NaN / 0 / undefined instead of the real age).
  //   `consecutiveNo4Ball` was returned but parliament read
  //     `consecutiveNoHitCount` → lifecycle phase always computed with
  //       consecutiveMisses === undefined (coerces to 0), so the phase
  //       could never advance past PRIME regardless of real miss count.
  // Both renamed here to match the parliament's own expectations (the
  // parliament's names are more descriptive and match the store's
  // convention for this concept).
  return {
    fourBall: {
      active: fourBallActive,
      reconstructedSeasonAge,
      consecutiveNoHitCount: consecutiveNo4Ball
    },
    // Additive -- new consumer is generalParliament.js's 3-Ball Entry
    // Intelligence wiring. Does not change fourBall's shape or values.
    threeBall: {
      active: threeBallActive,
      reconstructedSeasonAge: reconstructedThreeBallSeasonAge,
      consecutiveNoHitCount: consecutiveNo3Ball
    }
  };
}

module.exports = {
  evaluateTacticalActivation
};
