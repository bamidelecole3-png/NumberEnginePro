/**
 * Signature Vector Engine — Blueprint Phase 4.
 *
 * Replaces the old exact-match comparison ("did preceding3BallCount equal
 * the stored value exactly") with real vector similarity:
 *
 *   Current Runway Vector
 *        -> Normalize
 *        -> Cosine similarity against every stored historical vector
 *        -> Rank
 *        -> Top-K matches
 *        -> Historical outcomes of those matches
 *
 * Output is three distinct, named confidence figures instead of one
 * opaque score, matching the blueprint's explicit ask:
 *   - historicalAnalogueConfidence: how closely the single best historical
 *     match resembles the current moment (similarity of the #1 match).
 *   - clusterConfidence: how much AGREEMENT there is among the top-K
 *     matches' actual outcomes (do they mostly agree on which color fired
 *     next, or are they scattered).
 *   - predictionConfidence: a blend of the two above, which is what a
 *     caller should actually use as "how much should I trust this."
 *
 * HONESTY NOTE: cosine similarity is a real, well-defined piece of math,
 * and everything below computes it correctly against real historical
 * data -- there's no hardcoded number here. But "this moment resembles
 * a past moment" is a description of pattern resemblance in engineered
 * features, not a proven causal or predictive relationship. Two moments
 * can score 95% similar on these ~20 dimensions and still be followed by
 * different colors, especially with a small signature library. Treat
 * historicalAnalogueConfidence as "how unusual/familiar this configuration
 * is," not as a calibrated win probability.
 */

'use strict';

const { HIERARCHY } = require('../core/colorMath');
const { cosineSimilarity } = require('../core/statMath');
const { buildAllRunwayVectors, FEATURE_KEYS } = require('./runwayFeatureEngine');

const TOP_K = 10;
const MIN_LIBRARY_SIZE_FOR_MATCHING = 3; // below this, "matching" is just noise

// Normalizes a raw feature vector to a comparable 0-1-ish scale per
// dimension using fixed, documented divisors -- NOT min/max scaling
// against the library (which would make every comparison's meaning
// drift as the library grows). Each divisor is chosen to be a
// reasonable "typical max" for that dimension given RUNWAY_WINDOW=20,
// so two vectors built from the same-sized window are always on the
// same footing regardless of when either was captured.
const NORMALIZATION_DIVISORS = {
  threeBallFrequency: 10, fourBallFrequency: 6,
  averageTier: 5, maximumTier: 5, tierTrend: 2,
  momentumSlope: 0.5, compressionScore: 100,
  gapSince3Ball: 20, gapSince4Ball: 20,
  dominanceScore: 100, suppressionScore: 100,
  entropy: 2, tierVolatility: 3,
  consecutiveAppearances: 10, tierEscalationSpeed: 20,
  rollingDensity: 100, windowAcceleration: 100,
  rivalPressure: 100, colorBalance: 100, tierLadderScore: 100
};

function normalizeVector(features) {
  const normalized = {};
  for (const key of FEATURE_KEYS) {
    const raw = features[key] != null ? features[key] : 0;
    const divisor = NORMALIZATION_DIVISORS[key] || 1;
    // tierEscalationSpeed uses -1 as a "not observed" sentinel (see
    // runwayFeatureEngine.js) -- treat it as 0 (neutral) rather than a
    // large negative number that would distort the vector's direction.
    const value = key === 'tierEscalationSpeed' && raw < 0 ? 0 : raw;
    normalized[key] = value / divisor;
  }
  return normalized;
}

// Captures a signature entry for the color that just had a 5-ball event,
// using the FULL runway vector computed from the window immediately
// preceding that event (not including the event draw itself), plus the
// event's own identity/outcome for later lookup.
//
// `precedingDraws` must already be the slice of history strictly BEFORE
// the event draw (oldest-to-newest order doesn't matter here since
// buildAllRunwayVectors re-slices internally) -- callers pass
// historicalDraws.slice(idx + 1) from the event's index.
function captureSignatureVector(precedingDraws, eventDrawId, eventColor, eventTimestamp) {
  const vectors = buildAllRunwayVectors(precedingDraws);
  return {
    drawId: eventDrawId,
    color: eventColor,
    timestamp: eventTimestamp || null,
    // Store every color's vector as of this moment, not just the color
    // that fired -- a future query needs to compare its own current
    // per-color vectors against what EVERY color looked like right
    // before this historical event, since the question "does RED right
    // now resemble how GREEN looked right before GREEN's event" is a
    // legitimate cross-color comparison the blueprint's clustering phase
    // will want later.
    vectorsByColor: {
      RED: normalizeVector(vectors.RED.features),
      BLUE: normalizeVector(vectors.BLUE.features),
      GREEN: normalizeVector(vectors.GREEN.features)
    }
  };
}

// Compares the CURRENT vector for `queryColor` against every stored
// signature's vector for that SAME color (i.e. "how does RED look right
// now compared to how RED looked right before RED's past events") --
// this is the primary, most directly interpretable comparison. Returns
// the ranked top-K matches with each match's outcome (which color
// actually fired at that historical signature).
//
// GOTCHA THIS GUARDS AGAINST: when a color has been completely inactive
// in the current window, its runway vector is all zeros (or the fixed
// "absent" sentinels for gap fields). Two all-zero vectors are trivially
// 100% cosine-similar to each other regardless of what actually happened
// around them -- so a currently-dormant color would spuriously "match"
// every OTHER historical signature where that same color also happened
// to be dormant, which is meaningless (every dormant color's dormant
// vector looks alike; that tells you nothing about what's coming). We
// only attempt matching when the current vector carries a minimum
// amount of real signal (rollingDensity > 0, i.e. it appeared at least
// once in-window); otherwise matching is skipped for that color and
// scoreMatchSet naturally falls back to zeroed-out confidence.
const MIN_ACTIVITY_FOR_MATCHING = 0.001; // rollingDensity normalized (>0 means "appeared at least once")

function rankMatches(currentVectorsByColor, signatureLibrary, queryColor) {
  const currentVec = currentVectorsByColor[queryColor];
  if (!currentVec || (currentVec.rollingDensity || 0) < MIN_ACTIVITY_FOR_MATCHING) {
    return []; // no real signal to match against -- avoid the dormant-vs-dormant false-match trap
  }

  const matches = [];

  for (const sig of signatureLibrary) {
    const sigVec = sig.vectorsByColor && sig.vectorsByColor[queryColor];
    if (!sigVec) continue; // legacy/malformed entry -- skip rather than crash
    if ((sigVec.rollingDensity || 0) < MIN_ACTIVITY_FOR_MATCHING) continue; // same guard, historical side
    const similarity = cosineSimilarity(currentVec, sigVec);
    matches.push({
      drawId: sig.drawId,
      similarity,
      outcomeColor: sig.color, // the color that ACTUALLY fired at this historical signature
      wasQueryColorTheWinner: sig.color === queryColor
    });
  }

  matches.sort((a, b) => b.similarity - a.similarity);
  return matches.slice(0, TOP_K);
}

// Given the top-K matches for one queried color, computes:
//   - historicalAnalogueConfidence: the #1 match's similarity score.
//   - clusterConfidence: what fraction of the top-K matches' actual
//     outcomes agree with the majority outcome among them (measures
//     AGREEMENT, not similarity -- a set of 90%-similar matches that
//     disagree wildly on what fired next is a weak signal despite high
//     individual similarity).
//   - predictionConfidence: blend of the two, this queried color's
//     overall standing.
function scoreMatchSet(matches) {
  if (matches.length === 0) {
    return { historicalAnalogueConfidence: 0, clusterConfidence: 0, predictionConfidence: 0, topMatches: [] };
  }

  const historicalAnalogueConfidence = matches[0].similarity;

  const outcomeCounts = {};
  matches.forEach(m => {
    outcomeCounts[m.outcomeColor] = (outcomeCounts[m.outcomeColor] || 0) + 1;
  });
  const majorityOutcome = Object.entries(outcomeCounts).sort((a, b) => b[1] - a[1])[0];
  const clusterConfidence = Math.round((majorityOutcome[1] / matches.length) * 100);

  const predictionConfidence = Math.round(historicalAnalogueConfidence * 0.6 + clusterConfidence * 0.4);

  return {
    historicalAnalogueConfidence,
    clusterConfidence,
    clusterMajorityOutcome: majorityOutcome[0],
    predictionConfidence,
    topMatches: matches
  };
}

// Main entry point: for every color, ranks its current runway vector
// against the signature library (matching that SAME color's historical
// pre-event vectors), and returns the full per-color breakdown plus an
// overall best pick across all three colors -- mirroring the output
// shape the old captureAndMatchSignatures produced (matchedColor,
// similarityScore) for drop-in compatibility, plus everything new.
function matchSignatures(historicalDraws, signatureLibrary = []) {
  const currentVectors = buildAllRunwayVectors(historicalDraws);
  const currentVectorsByColor = {
    RED: normalizeVector(currentVectors.RED.features),
    BLUE: normalizeVector(currentVectors.BLUE.features),
    GREEN: normalizeVector(currentVectors.GREEN.features)
  };

  const insufficientLibrary = signatureLibrary.length < MIN_LIBRARY_SIZE_FOR_MATCHING;

  const perColor = {};
  HIERARCHY.forEach(color => {
    if (insufficientLibrary) {
      perColor[color] = {
        historicalAnalogueConfidence: 0, clusterConfidence: 0,
        predictionConfidence: 0, topMatches: []
      };
      return;
    }
    const matches = rankMatches(currentVectorsByColor, signatureLibrary, color);
    perColor[color] = scoreMatchSet(matches);
  });

  // Overall best pick: the color with the highest predictionConfidence
  // across the three per-color analyses.
  let matchedColor = 'RED';
  let bestScore = -1;
  HIERARCHY.forEach(color => {
    if (perColor[color].predictionConfidence > bestScore) {
      bestScore = perColor[color].predictionConfidence;
      matchedColor = color;
    }
  });

  return {
    matchedColor,
    similarityScore: bestScore >= 0 ? bestScore : 50, // drop-in compatible field name/fallback
    insufficientLibrary,
    librarySize: signatureLibrary.length,
    perColor
  };
}

module.exports = {
  captureSignatureVector,
  matchSignatures,
  normalizeVector,
  rankMatches,
  scoreMatchSet,
  TOP_K,
  MIN_LIBRARY_SIZE_FOR_MATCHING
};
