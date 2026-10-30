'use strict';

// ── EXPLAINABILITY ENGINE — v19 ─────────────────────────────────────────
//
// Pure, read-only summarizer. Takes the already-computed prediction
// result (candidates, weights, climate, opportunity, group intel, SCIE
// result) and produces a plain-language explanation — it does not
// influence scoring in any way, so it's safe to compute last and can
// never change what gets predicted.

const LAYER_LABELS = {
  markov: 'Markov transition',
  scie: 'SCIE cluster signal',
  momentum: 'Momentum',
  survivor: 'Survivor gap',
  freq: 'Frequency',
  combination: 'Combination',
  group: 'Group Intelligence'
};

function topContributors(candidate, weights, limit = 3) {
  const contributions = Object.entries(candidate.layerScores).map(([layer, score]) => ({
    layer,
    label: LAYER_LABELS[layer] || layer,
    score,
    weightPct: Math.round((weights[layer] || 0) * 100),
    contribution: Math.round(score * (weights[layer] || 0))
  }));
  return contributions.sort((a, b) => b.contribution - a.contribution).slice(0, limit);
}

function strongestSupportingSignals(candidate, scieResult, groupIntel) {
  const signals = [];

  const scieSignal = (scieResult?.activeSignals || []).find(s => s.target === candidate.num);
  if (scieSignal) {
    signals.push(`SCIE: ${scieSignal.trigger} → ${candidate.num} (${scieSignal.reliability}% historical reliability)`);
  }

  const group = (groupIntel?.activeGroups || []).find(g => g.members.includes(candidate.num));
  if (group) {
    signals.push(`Group [${group.members.join(', ')}] co-occurring ${group.strengthRatio}× baseline rate`);
  }

  if (candidate.layerScores.markov >= 75) {
    signals.push(`Strong Markov transition signal (${candidate.layerScores.markov}%)`);
  }
  if (candidate.layerScores.momentum >= 75) {
    signals.push(`Strong upward momentum (${candidate.layerScores.momentum}%)`);
  }

  return signals.slice(0, 3);
}

function buildPerNumberExplanation(candidate, weights, climate, scieResult, groupIntel) {
  const contributors = topContributors(candidate, weights);
  const signals = strongestSupportingSignals(candidate, scieResult, groupIntel);
  const dominantPattern = climate && climate.state !== 'INSUFFICIENT_DATA' ? climate.state : 'UNKNOWN';

  const leadLabel = contributors[0] ? contributors[0].label : 'ensemble';
  const decisionSummary = `Selected primarily on ${leadLabel} (${contributors[0] ? contributors[0].score : '—'}%)` +
    (signals.length ? `, reinforced by ${signals.length} supporting signal(s).` : '.');

  return {
    num: candidate.num,
    confidence: candidate.individualConfidence,
    dominantPattern,
    contributingLayers: contributors,
    strongestSupportingSignals: signals,
    decisionSummary
  };
}

function buildOverallSummary({ topN, climate, opportunity, weights }) {
  if (!topN || !topN.length) return 'No prediction available yet.';

  const numbers = topN.map(c => c.num).join(', ');
  const topLayer = Object.entries(weights || {}).sort((a, b) => b[1] - a[1])[0];
  const climatePart = climate && climate.state !== 'INSUFFICIENT_DATA'
    ? `Current pattern climate is ${climate.state.toLowerCase()} (strength ${climate.patternStrength}%, ${climate.transitionPhase.toLowerCase()} phase).`
    : 'Not enough draw history yet to characterize the current pattern climate.';
  const opportunityPart = opportunity
    ? `Opportunity window: ${opportunity.level} (${opportunity.recommendation.replace(/_/g, ' ').toLowerCase()}).`
    : '';
  const layerPart = topLayer ? `Most-weighted layer right now: ${LAYER_LABELS[topLayer[0]] || topLayer[0]} (${Math.round(topLayer[1] * 100)}%).` : '';

  return [`Top picks: ${numbers}.`, climatePart, opportunityPart, layerPart].filter(Boolean).join(' ');
}

function buildExplanation({ topN, weights, climate, opportunity, scieResult, groupIntel }) {
  return {
    overallSummary: buildOverallSummary({ topN, climate, opportunity, weights }),
    perNumber: (topN || []).map(c => buildPerNumberExplanation(c, weights, climate, scieResult, groupIntel))
  };
}

module.exports = {
  buildExplanation
};
