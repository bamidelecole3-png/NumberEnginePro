/**
 * Unified Prediction Engine — Blueprint Phase 11.
 *
 * The blueprint's own composition formula:
 *
 *   Gap Score + Runway Score + Progression Score + Pressure Score +
 *   Suppression Score + Similarity Score + Cluster Score + Season Score +
 *   Session Score  ->  Confidence
 *
 * Every one of these nine components is read from a Phase 1-10 engine
 * that ALREADY computes it -- this module derives no new statistics of
 * its own. That's deliberate: Phase 11 is the composition/explanation
 * layer, not a tenth source of truth. Where a phase's engine doesn't
 * expose a single ready-made 0-100 scalar for its concept, this module
 * builds one from that engine's own already-computed named fields (each
 * derivation is called out below with which fields it uses and why),
 * rather than inventing a new measurement.
 *
 * Weighting: all nine components are weighted equally (1/9 each) in the
 * blend. The blueprint doesn't specify differential weights, and
 * unequal weights chosen without evidence would be exactly the kind of
 * fabricated-looking number this codebase's other engines have
 * deliberately avoided (see knowledgeConfidenceEngine.js's header
 * comment). Equal weighting is the honest default until real outcome
 * data justifies calibrating specific weights -- store.engineWeights
 * already exists for exactly that purpose and could be wired in later
 * without changing this module's shape.
 *
 * A component that has no real signal yet for a given color (e.g. gap
 * distribution with zero historical gaps, or rival pressure when no
 * color currently holds dominance) contributes a neutral 50 rather than
 * 0 or 100 -- "no evidence" is not the same claim as "strong negative
 * evidence" or "strong positive evidence," and scoring it as an extreme
 * would silently bias the blend. Each component's neutral-fallback count
 * is reported in the explanation so a 50 from "no data" is visibly
 * different from a genuine mid-range 50 reading.
 */
'use strict';

const { HIERARCHY } = require('../core/colorMath');
const { sessionForHour } = require('./temporalIntelligenceEngine');

const NEUTRAL_SCORE = 50;

function safeScore(value, fallbackUsed) {
  if (typeof value !== 'number' || isNaN(value)) {
    fallbackUsed.count++;
    return NEUTRAL_SCORE;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

// --- Gap Score --------------------------------------------------------
// Directly gapDistribution[color].forecast.gapRiskScore (Phase 5) -- how
// unusual the color's current open gap is relative to its own history.
function gapScore(gapDistribution, color, fallbackUsed) {
  const entry = gapDistribution && gapDistribution[color];
  const val = entry && entry.forecast ? entry.forecast.gapRiskScore : null;
  return safeScore(val, fallbackUsed);
}

// --- Runway Score -------------------------------------------------------
// runwayFeatureEngine (Phase 3) produces ~22 named dimensions but no
// single scalar of its own -- this composite blends the four dimensions
// that most directly answer "is this color's runway building toward an
// event right now": momentum direction (rescaled from its raw slope
// units to 0-100), how recent that activity is (compressionScore),
// overall activity rate (rollingDensity), and ladder climbing
// (tierLadderScore). Equal quarter-weights for the same reason as the
// top-level blend: no evidence yet to justify unequal sub-weights.
function runwayScore(runwayVectorsByColor, color, fallbackUsed) {
  const vec = runwayVectorsByColor && runwayVectorsByColor[color];
  if (!vec || !vec.features) { fallbackUsed.count++; return NEUTRAL_SCORE; }
  const f = vec.features;
  // momentumSlope is a small per-draw slope (typically roughly -1..1
  // range in practice, not already 0-100 like its siblings) -- rescale
  // it onto the same 0-100 axis before blending, clamping extreme slopes
  // rather than letting them dominate the average.
  const momentum0to100 = Math.max(0, Math.min(100, Math.round(50 + f.momentumSlope * 50)));
  const parts = [momentum0to100, f.compressionScore, f.rollingDensity, f.tierLadderScore]
    .filter(v => typeof v === 'number' && !isNaN(v));
  if (parts.length === 0) { fallbackUsed.count++; return NEUTRAL_SCORE; }
  return safeScore(parts.reduce((a, b) => a + b, 0) / parts.length, fallbackUsed);
}

// --- Progression Score --------------------------------------------------
// Directly crossTierProgression.perColor[color].ladderScore (Phase 6).
function progressionScore(crossTierProgression, color, fallbackUsed) {
  const entry = crossTierProgression && crossTierProgression.perColor ? crossTierProgression.perColor[color] : null;
  const val = entry ? entry.ladderScore : null;
  return safeScore(val, fallbackUsed);
}

// --- Suppression Score ---------------------------------------------------
// suppressionIntelligenceEngine (Phase 7) exposes a classification label
// plus component metrics, not a single scalar -- derive one from
// recoveryVelocity and momentumAcceleration the same way
// the parliament's own suppressionPick() already does for its
// vote, for consistency across this codebase rather than inventing a
// second, different formula for the same underlying concept.
const SUPPRESSION_CLASS_BASE = { EXPLOSIVE: 80, CHARGING: 65, RECOVERING: 50, SUPPRESSED: 30, DORMANT: 15 };
function suppressionScore(suppressionIntelligence, color, fallbackUsed) {
  const entry = suppressionIntelligence && suppressionIntelligence[color];
  if (!entry || !entry.classification) { fallbackUsed.count++; return NEUTRAL_SCORE; }
  const base = SUPPRESSION_CLASS_BASE[entry.classification] != null ? SUPPRESSION_CLASS_BASE[entry.classification] : NEUTRAL_SCORE;
  const val = base + (entry.recoveryVelocity || 0) * 0.3 + (entry.momentumAcceleration || 0) * 5;
  return safeScore(val, fallbackUsed);
}

// --- Similarity Score -----------------------------------------------------
// Directly signatureMatch.perColor[color].predictionConfidence (Phase 4,
// via signatureVectorEngine.matchSignatures) -- the genuine historical-
// analogue + cluster-agreement blend, not the older binary comparison.
function similarityScoreFor(signatureMatch, color, fallbackUsed) {
  const entry = signatureMatch && signatureMatch.perColor ? signatureMatch.perColor[color] : null;
  const val = entry ? entry.predictionConfidence : null;
  // predictionConfidence is legitimately 0 both when there's no library
  // yet AND when there IS a library but this color matched poorly --
  // only treat it as "no signal" when we can see the library itself is
  // insufficient (an explicit, checkable condition) rather than
  // guessing from the score alone.
  if (signatureMatch && signatureMatch.insufficientLibrary) { fallbackUsed.count++; return NEUTRAL_SCORE; }
  return safeScore(val, fallbackUsed);
}

// --- Cluster Score --------------------------------------------------------
// Directly eventClusters.perColor[color].primaryScore (Phase 10).
function clusterScore(eventClusters, color, fallbackUsed) {
  const entry = eventClusters && eventClusters.perColor ? eventClusters.perColor[color] : null;
  const val = entry ? entry.primaryScore : null;
  return safeScore(val, fallbackUsed);
}

// --- Pressure Score --------------------------------------------------------
// Directly rivalPressure.rivalOutlook[color].releaseProbability (Phase
// 8) when this color is a suppressed rival under an active dominance
// stretch. Null for the currently-dominant color itself (the concept
// doesn't apply to it) and whenever no dominance is currently active --
// both are genuine "not applicable" states, not missing data, so they
// fall back to neutral the same as any other absent signal.
function pressureScore(rivalPressure, color, fallbackUsed) {
  if (!rivalPressure || !rivalPressure.isDominanceActive) { fallbackUsed.count++; return NEUTRAL_SCORE; }
  if (rivalPressure.currentDominant === color) { fallbackUsed.count++; return NEUTRAL_SCORE; }
  const outlook = rivalPressure.rivalOutlook ? rivalPressure.rivalOutlook[color] : null;
  const val = outlook ? outlook.releaseProbability : null;
  return safeScore(val, fallbackUsed);
}

// --- Season Score ----------------------------------------------------------
// 4-ball season "heat" (fourBallParliament.js's seasonIntelligence,
// itself Phase-roadmap seasonIntelligenceEngine.js) genuinely only
// describes ONE color at a time -- whichever color currently holds the
// active 4-ball season. It's a real, meaningful signal for that color
// and simply doesn't apply to the other two, so they correctly get the
// neutral fallback rather than a fabricated cross-color equivalent.
function seasonScoreFor(fourBallParliament, color, fallbackUsed) {
  if (!fourBallParliament || !fourBallParliament.active || !fourBallParliament.seasonIntelligence) {
    fallbackUsed.count++;
    return NEUTRAL_SCORE;
  }
  if (fourBallParliament.winningColor !== color) { fallbackUsed.count++; return NEUTRAL_SCORE; }
  return safeScore(fourBallParliament.seasonIntelligence.heat, fallbackUsed);
}

// --- Session Score -----------------------------------------------------
// temporalIntelligenceEngine (Phase 9) reports each color's peak session
// as a z-score against uniform expectation, not a 0-100 scalar -- this
// derives one by checking whether the CURRENT session (from the live
// clock, via the same sessionForHour() the engine itself uses) matches
// this color's own historically observed peak session, scaled by how
// strong that historical skew actually is (the peak session's z-score).
// A color with no clear session skew (insufficient sample, or a skew
// too weak to be the reported peak) correctly falls back to neutral.
function sessionScoreFor(temporalIntelligence, color, now, fallbackUsed) {
  const entry = temporalIntelligence && temporalIntelligence.perColor ? temporalIntelligence.perColor[color] : null;
  const clustering = entry ? entry.clustering : null;
  if (!clustering || !clustering.sufficientSample || !clustering.peakSession) {
    fallbackUsed.count++;
    return NEUTRAL_SCORE;
  }
  const currentSession = sessionForHour(now.getHours());
  const z = clustering.peakSession.zScore || 0;
  if (currentSession === clustering.peakSession.name && z > 0) {
    // In this color's own peak session, scaled by how strong that skew is.
    return safeScore(50 + Math.min(50, z * 15), fallbackUsed);
  }
  if (z > 0) {
    // Has a real peak session, but we're not in it right now -- below
    // neutral, scaled by how strong the (inapplicable-right-now) skew is.
    return safeScore(50 - Math.min(35, z * 10), fallbackUsed);
  }
  fallbackUsed.count++;
  return NEUTRAL_SCORE;
}

const COMPONENT_LABELS = {
  gap: 'Gap Score', runway: 'Runway Score', progression: 'Progression Score',
  pressure: 'Pressure Score', suppression: 'Suppression Score',
  similarity: 'Similarity Score', cluster: 'Cluster Score',
  season: 'Season Score', session: 'Session Score'
};

function buildReasoning(color, components, fallbackCounts, confidence, topAnalogue) {
  const parts = [];
  if (topAnalogue && topAnalogue.similarity != null) {
    parts.push(`${topAnalogue.similarity}% similarity to Draw ${topAnalogue.drawId} (${topAnalogue.wasQueryColorTheWinner ? `${color} fired` : `${topAnalogue.outcomeColor} fired`})`);
  }
  if (components.suppression >= 65) parts.push(`suppression/recovery signal is strong (${components.suppression}%)`);
  if (components.pressure >= 65) parts.push(`elevated release probability under current dominance pressure (${components.pressure}%)`);
  if (components.progression >= 65) parts.push(`strong ladder progression (${components.progression}%)`);
  if (components.cluster >= 65) parts.push(`matches a known pattern archetype (${components.cluster}%)`);
  if (components.gap >= 65) parts.push(`gap window elevated (${components.gap}%)`);
  if (parts.length === 0) {
    parts.push(`blended composite of all nine signal components (no single component dominant)`);
  }
  const fallbackNote = fallbackCounts > 0
    ? ` ${fallbackCounts}/9 component${fallbackCounts === 1 ? '' : 's'} used a neutral fallback (insufficient history for that signal yet).`
    : '';
  return `${color} ${confidence}% — ${parts.join('; ')}.${fallbackNote}`;
}

/**
 * Computes the unified Phase 11 prediction for every color, given the
 * already-fresh engine outputs (plus the
 * current runway vectors, the signature match, and the fourBall
 * parliament result, all of which are computed elsewhere in the same
 * update cycle and passed in explicitly -- matching how every other
 * Phase 1-10 engine receives its inputs, rather than reaching into a
 * side-channel). Pure function -- no mutation, no I/O; the caller
 * decides where to store the result.
 */
function computeUnifiedPrediction(lab, runwayVectorsByColor, signatureMatch, fourBallParliament, now) {
  const clockNow = now instanceof Date && !isNaN(now.getTime()) ? now : new Date();

  const perColor = {};
  HIERARCHY.forEach(color => {
    const fallbackUsed = { count: 0 };

    const components = {
      gap: gapScore(lab.gapDistribution, color, fallbackUsed),
      runway: runwayScore(runwayVectorsByColor, color, fallbackUsed),
      progression: progressionScore(lab.crossTierProgression, color, fallbackUsed),
      pressure: pressureScore(lab.rivalPressure, color, fallbackUsed),
      suppression: suppressionScore(lab.suppressionIntelligence, color, fallbackUsed),
      similarity: similarityScoreFor(signatureMatch, color, fallbackUsed),
      cluster: clusterScore(lab.eventClusters, color, fallbackUsed),
      season: seasonScoreFor(fourBallParliament, color, fallbackUsed),
      session: sessionScoreFor(lab.temporalIntelligence, color, clockNow, fallbackUsed)
    };

    const keys = Object.keys(components);
    const confidence = Math.round(keys.reduce((sum, k) => sum + components[k], 0) / keys.length);

    const sigEntry = signatureMatch && signatureMatch.perColor ? signatureMatch.perColor[color] : null;
    const topAnalogue = sigEntry && sigEntry.topMatches && sigEntry.topMatches.length > 0
      ? { drawId: sigEntry.topMatches[0].drawId, similarity: sigEntry.topMatches[0].similarity, outcomeColor: sigEntry.topMatches[0].outcomeColor, wasQueryColorTheWinner: sigEntry.topMatches[0].wasQueryColorTheWinner }
      : null;

    perColor[color] = {
      color,
      confidence,
      components,
      componentLabels: COMPONENT_LABELS,
      neutralFallbackCount: fallbackUsed.count,
      topAnalogue,
      reasoning: buildReasoning(color, components, fallbackUsed.count, confidence, topAnalogue)
    };
  });

  let topPick = HIERARCHY[0];
  HIERARCHY.forEach(color => {
    if (perColor[color].confidence > perColor[topPick].confidence) topPick = color;
  });

  return {
    generatedAt: clockNow.toISOString(),
    topPick,
    topPickConfidence: perColor[topPick].confidence,
    perColor
  };
}

module.exports = {
  computeUnifiedPrediction
};
