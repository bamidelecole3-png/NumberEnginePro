'use strict';

// ── OPPORTUNITY WINDOW ENGINE — v19 ─────────────────────────────────────
//
// Not every draw deserves equal confidence. This engine synthesizes
// signals already computed elsewhere (Pattern Climate strength, CAME's
// Effective Independence, the group intelligence layer's own confidence,
// and the composite overallConfidence) into one of four opportunity
// levels. It never blocks a prediction from being generated — the
// existing prediction pipeline is preserved untouched — it just tells
// the caller (and the dashboard) how much weight that prediction
// currently deserves.

const cameEngine = require('./cameEngine');

const WEIGHTS = {
  patternStrength: 0.35,
  effectiveIndependence: 0.20, // 0-N scale (N = CAME layer count), normalized to 0-100 below
  overallConfidence: 0.30,
  groupConfidence: 0.15
};

const GROUP_CONFIDENCE_SCORE = { HIGH: 90, MEDIUM: 55, LOW: 20 };

function computeOpportunity({ climate, came, overallConfidence, groupIntel }) {
  const patternStrength = climate && typeof climate.patternStrength === 'number' ? climate.patternStrength : 0;
  const maxIndependence = cameEngine.MAX_EFFECTIVE_INDEPENDENCE || 6;
  const effectiveIndependenceRaw = came && typeof came.effectiveIndependence === 'number' ? came.effectiveIndependence : maxIndependence / 2;
  const effectiveIndependenceScore = Math.max(0, Math.min(100, Math.round((effectiveIndependenceRaw / maxIndependence) * 100)));
  const confidenceScore = typeof overallConfidence === 'number' ? overallConfidence : 0;
  const groupConfidenceScore = groupIntel && groupIntel.groupConfidence
    ? (GROUP_CONFIDENCE_SCORE[groupIntel.groupConfidence] ?? 20)
    : 20;

  const score = Math.round(
    (patternStrength * WEIGHTS.patternStrength) +
    (effectiveIndependenceScore * WEIGHTS.effectiveIndependence) +
    (confidenceScore * WEIGHTS.overallConfidence) +
    (groupConfidenceScore * WEIGHTS.groupConfidence)
  );

  let level, recommendation;
  if (score >= 75) {
    level = 'HIGH';
    recommendation = 'ENTER';
  } else if (score >= 55) {
    level = 'MODERATE';
    recommendation = 'ENTER_CAUTIOUSLY';
  } else if (score >= 35) {
    level = 'LOW';
    recommendation = 'REDUCE_SIZE';
  } else {
    level = 'WAIT';
    recommendation = 'WAIT';
  }

  const reasons = [];
  reasons.push(
    patternStrength >= 60
      ? `Pattern strength is high (${patternStrength}%) — current conditions are legible.`
      : patternStrength >= 30
        ? `Pattern strength is moderate (${patternStrength}%).`
        : `Pattern strength is weak (${patternStrength}%) — the game currently looks close to noise.`
  );
  reasons.push(
    effectiveIndependenceRaw >= maxIndependence * 0.75
      ? `Ensemble layers are largely independent (${effectiveIndependenceRaw.toFixed ? effectiveIndependenceRaw.toFixed(1) : effectiveIndependenceRaw}/${maxIndependence}) — agreement is meaningful.`
      : `Ensemble layers are moderately correlated (${effectiveIndependenceRaw.toFixed ? effectiveIndependenceRaw.toFixed(1) : effectiveIndependenceRaw}/${maxIndependence}) — some agreement may be redundant.`
  );
  reasons.push(
    groupIntel && groupIntel.activeGroups && groupIntel.activeGroups.length
      ? `${groupIntel.activeGroups.length} active companion group(s) supporting the current picks.`
      : 'No strongly active companion groups right now.'
  );

  return {
    level,
    score,
    recommendation,
    reasons,
    components: {
      patternStrength,
      effectiveIndependenceScore,
      overallConfidence: confidenceScore,
      groupConfidenceScore
    }
  };
}

module.exports = {
  computeOpportunity
};
