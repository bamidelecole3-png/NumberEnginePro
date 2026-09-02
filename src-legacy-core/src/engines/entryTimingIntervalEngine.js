/**
 * Entry Timing Interval Engine.
 *
 * REPLACES the previous version of this engine, which gated on 4SIL's
 * badge.enterNow and required a persistent cross-cycle observation log
 * (store.entryTimingLog) to track hit/spacing history for the
 * currently-predicted color. That ENTER-gated, logged approach has been
 * scrapped entirely per operator direction.
 *
 * This version is a PURE, ungated recompute -- structurally identical to
 * threeBallEntryIntelligenceEngine.js (the 3-Ball Entry Intelligence
 * Engine), which is itself an exact mirror of entryIntelligenceEngine.js
 * (the 4-ball Entry Quality engine already used by fourBallParliament.js).
 * Rather than re-deriving that same tier/entryScore/intervalStats math a
 * third time in a third file, this engine delegates directly to
 * entryIntelligenceEngine.js's evaluateEntryQuality() -- the single
 * source of truth for 4-ball entry-timing math -- calling it once for
 * the 4-Ball Parliament's 1st-pick color (winningColor) and once for its
 * 2nd-pick mirror (secondColor), the same two-color tracking shape the
 * old engine used.
 *
 * No 4SIL dependency, no ENTER gate, no persistent log -- recomputed
 * fresh every council cycle straight from historicalDraws + fourBallP,
 * same convention as tieEngine.js / threeBallColorEngine.js.
 *
 * (The Entry Condition Scorecard's own need for a persistent, per-draw
 * log of 4SIL's gate conditions vs. real outcomes still exists -- that
 * responsibility now lives in entryConditionScorecard.js itself, decoupled
 * from this engine. See that file's header.)
 */

const { evaluateEntryQuality } = require('./entryIntelligenceEngine');

function evaluateEntryTimingIntervals(historicalDraws, fourBallP) {
  if (!fourBallP || !fourBallP.active) {
    return {
      engine: 'EntryTimingIntervalEngine',
      active: false,
      statusLabel: 'STANDBY',
      operatorAction: 'MONITOR',
      trackedFirstColor: null,
      trackedSecondColor: null,
      firstColor: null,
      secondColor: null,
      reasoning: 'No active 4-ball season -- Entry Timing Interval Engine has nothing to track.'
    };
  }

  const dominanceScore = fourBallP.entryIntelligence ? fourBallP.entryIntelligence.dominanceScore : 50;
  const transitionRisk = fourBallP.transitionRisk || 0;
  const exitRisk = fourBallP.exitIntelligence ? fourBallP.exitIntelligence.exitProbability : 0;

  // 1st pick -- fourBallParliament.js already computed this exact call
  // this cycle (as fullEntryIntelligence/entryIntelligence); reuse it
  // rather than recomputing the same math a second time.
  const firstColorStats = fourBallP.entryIntelligence
    || evaluateEntryQuality(fourBallP.seasonAge, fourBallP.confidence, fourBallP.winningColor, {
      dominanceScore, transitionRisk, exitRisk, historicalDraws
    });

  // 2nd pick -- same call, mirrored onto the parliament's second-place
  // color at its own (lower) confidence reading.
  const secondColorStats = fourBallP.secondColor
    ? evaluateEntryQuality(fourBallP.seasonAge, fourBallP.secondConfidence, fourBallP.secondColor, {
      dominanceScore, transitionRisk, exitRisk, historicalDraws
    })
    : null;

  const statusLabel = (firstColorStats.activeEntrySeason && firstColorStats.activeEntrySeason.active) || firstColorStats.entryStreak > 0
    ? 'ACTIVE'
    : (firstColorStats.safeToEnter ? 'WATCHING' : 'STANDBY');

  return {
    engine: 'EntryTimingIntervalEngine',
    active: true,
    statusLabel,
    operatorAction: firstColorStats.operatorAction,
    trackedFirstColor: fourBallP.winningColor,
    trackedSecondColor: fourBallP.secondColor || null,
    firstColor: { color: fourBallP.winningColor, ...firstColorStats },
    secondColor: secondColorStats ? { color: fourBallP.secondColor, ...secondColorStats } : null,
    reasoning: `Tracking ${fourBallP.winningColor} (1st pick, tier ${firstColorStats.tier}) and ${fourBallP.secondColor || '--'} (2nd pick, mirror) -- ${firstColorStats.marketStateLabel}.`
  };
}

module.exports = {
  evaluateEntryTimingIntervals
};
