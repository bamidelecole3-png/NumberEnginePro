/**
 * Direct Outcome Evaluation & EMA Weight Evolution Engine module.
 * Evaluates every engine's vote DIRECTLY against the actual draw outcome and tracks per-regime stats.
 */
const { store } = require('../core/store');

function evaluateAndLearn(latestDraw) {
  if (!store.cachedSystemState) return;

  // Tier Engine forecast scoring (Recommendation #1 -- closing the
  // feedback loop). Must run BEFORE the vote-scoring loop below reads
  // anything from cachedSystemState, but logically it's independent of
  // it: this grades what the Tier Engine predicted for latestDraw against
  // what latestDraw actually was, using the forecast log entry that
  // runSupremeCouncil() wrote after the PREVIOUS draw. See
  // store.scoreTierForecast()'s header for the full mechanics.
  store.scoreTierForecast(latestDraw);

  // Tie Precursor Pattern Engine forecast scoring -- same closed-loop
  // treatment, independent log, independent engine. See
  // store.scoreTiePrecursorForecast()'s header.
  store.scoreTiePrecursorForecast(latestDraw);

  const actualColors = latestDraw.colors || [];
  const actual3B = latestDraw.threeBallColor;
  const actual4B = latestDraw.fourBallColor;

  const parliaments = store.cachedSystemState.parliaments || {};
  const activeRegime = (store.cachedSystemState.metaIntelligence && store.cachedSystemState.metaIntelligence.activeRegime)
    ? store.cachedSystemState.metaIntelligence.activeRegime
    : 'ORDERED';

  // Evaluate every engine directly against the actual draw result and register regime.
  //
  // A draw belongs to exactly one tier for a given color (3-ball or 4-ball --
  // see validator.js's tier classification). A 3B_/4B_ engine's
  // vote can therefore only be meaningfully judged when its OWN tier actually
  // occurred on this draw. Previously, when e.g. a draw was a 4-ball event
  // (actual3B === null), a 3B_ engine's hit/miss silently fell back to the
  // generic `actualColors.includes(v.color)` check -- scoring it against
  // whichever tier's outcome happened to include that color, rather than
  // skipping evaluation for a tier that didn't fire. That polluted
  // engineStats/regimeEngineStats with cross-tier noise. Now: no tier match,
  // no evaluation for that engine on this draw.
  for (const pKey of Object.keys(parliaments)) {
    const votes = parliaments[pKey].votes || [];
    for (const v of votes) {
      if (!v.color || !v.name) continue;

      let isHit;
      if (v.name.startsWith('3B_')) {
        if (!actual3B) continue; // this draw wasn't a 3-ball event -- not eligible for scoring
        isHit = (v.color === actual3B);
      } else if (v.name.startsWith('4B_')) {
        if (!actual4B) continue;
        isHit = (v.color === actual4B);
      } else {
        isHit = actualColors.includes(v.color);
      }

      store.updateEnginePerformanceDirect(v.name, isHit, v.confidence, activeRegime);
    }
  }

  const decision = store.cachedSystemState.supremeDecision || {};
  const predictedColor = decision.recommendedColor || 'RED';

  // BUGFIX: `wasCorrect` previously used `actualColors.includes(predictedColor)`.
  // Since `actualColors` is the full 6-ball draw list (e.g. [RED, RED, BLUE,
  // BLUE, GREEN, RED]) that almost always contains every color, this was
  // nearly always `true` regardless of whether the Supreme Council's
  // prediction actually matched the 3-ball or 4-ball tier outcome — turning
  // recommendation accuracy tracking into noise.
  // Fix: match against the tier that was actually active this draw.
  // If a 4-ball event fired, judge against that; else the 3-ball winner
  // if one fired; else fall back to the raw colors list (no specific tier
  // fired, so the broad check is the honest one rather than defaulting to
  // always-wrong or always-right).
  const wasCorrect = actual4B
    ? (actual4B === predictedColor)
    : actual3B
      ? (actual3B === predictedColor)
      : actualColors.includes(predictedColor);

  // BUGFIX: `actualWinner` recorded `actualColors[0]` (the first raw ball
  // color, always present, not the prediction target). Changed to the
  // tier-specific winner so the history table shows the correct market
  // outcome for each draw rather than a near-meaningless raw ball color.
  const actualWinner = actual4B || actual3B || actualColors[0] || 'NONE';

  store.recommendationLog.unshift({
    drawId: latestDraw.drawId,
    action: decision.action || 'WAIT',
    recommendedColor: predictedColor,
    actualWinner,
    wasCorrect,
    marketRegime: activeRegime,
    evaluated: true,
    timestamp: new Date().toISOString()
  });

  if (store.recommendationLog.length > 100) {
    store.recommendationLog.pop();
  }
}

module.exports = {
  evaluateAndLearn
};
