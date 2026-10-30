'use strict';

// ── COMBINATION CONFIDENCE ENGINE — blueprint §16 ───────────────────────
//
// numberEngine.js's existing `overallConfidence` is a flat average of the
// selected numbers' individual confidences — it says nothing about
// whether the numbers work well TOGETHER. The blueprint is explicit that
// combination confidence must separately weigh:
//   - individual strength      (already have: each number's own score)
//   - relationship strength    (already have: SCIE conflicts + group membership)
//   - historical support       (already have: SCIE reliability / group observations)
//   - current regime           (already have: Pattern Climate state)
//   - prediction stability     (already have: health monitor's consistency score)
//   - disagreement between scoring layers (already have: CAME effective independence)
//
// This engine is pure synthesis over data every other engine already
// computes — it adds no new raw-history computation, and (like
// explainabilityEngine and numberDnaEngine) it's read-only: it describes
// the combination the pipeline already selected, it cannot change which
// numbers get picked.

const cameEngine = require('./cameEngine');

const WEIGHTS = {
  individualStrength: 0.30,
  relationshipStrength: 0.25,
  historicalSupport: 0.20,
  regimeFit: 0.10,
  stability: 0.15
};

// Average of the selected numbers' own individual confidences (0-100).
function individualStrengthScore(topN) {
  if (!topN.length) return 0;
  return Math.round(topN.reduce((a, c) => a + c.individualConfidence, 0) / topN.length);
}

// How well the selected numbers relate to EACH OTHER, not just how good
// each one is alone — checks pairwise SCIE active-signal links and shared
// group membership among the picked set specifically (Candidate A/B
// distinction from the blueprint: same individual scores can still yield
// very different relationship strength).
function relationshipStrengthScore(topN, scieResult, groupIntel) {
  const nums = topN.map(c => c.num);
  if (nums.length < 2) return 50; // a single-number "combination" has no relationship to score

  let possiblePairs = 0;
  let linkedPairs = 0;
  const scieLinks = new Set();
  (scieResult?.activeSignals || []).forEach(s => {
    scieLinks.add(`${s.trigger}-${s.target}`);
    scieLinks.add(`${s.target}-${s.trigger}`);
  });

  const groupMembership = new Map(); // num -> Set of group keys it belongs to
  for (const num of nums) groupMembership.set(num, new Set());
  for (const g of (groupIntel?.activeGroups || [])) {
    const key = g.members.join('-');
    for (const num of nums) {
      if (g.members.includes(num)) groupMembership.get(num).add(key);
    }
  }

  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) {
      possiblePairs++;
      const a = nums[i], b = nums[j];
      const scieLinked = scieLinks.has(`${a}-${b}`);
      const sharedGroup = [...groupMembership.get(a)].some(k => groupMembership.get(b).has(k));
      if (scieLinked || sharedGroup) linkedPairs++;
    }
  }

  if (possiblePairs === 0) return 50;
  return Math.round((linkedPairs / possiblePairs) * 100);
}

// How much historical observation actually backs the relationships found
// above — a link based on 40 observed occurrences is more trustworthy
// than one based on the SCIE minimum of 5.
function historicalSupportScore(topN, scieResult, groupIntel) {
  const nums = new Set(topN.map(c => c.num));
  const relevantSignals = (scieResult?.activeSignals || []).filter(s => nums.has(s.trigger) || nums.has(s.target));
  const relevantGroups = (groupIntel?.activeGroups || []).filter(g => g.members.some(m => nums.has(m)));

  if (relevantSignals.length === 0 && relevantGroups.length === 0) return 30; // no historical backing found for this specific set

  const avgObserved = [
    ...relevantSignals.map(s => s.observed || 0),
    ...relevantGroups.map(g => g.totalObserved || 0)
  ];
  if (avgObserved.length === 0) return 30;

  const mean = avgObserved.reduce((a, b) => a + b, 0) / avgObserved.length;
  // 5 observations -> ~30, 20 -> ~70, 40+ -> caps near 95. Matches SCIE's
  // own observed>=12 / hitRate>=70 "reliable" bar as a rough midpoint.
  return Math.round(Math.max(20, Math.min(95, 20 + mean * 2)));
}

// Current regime's legibility — a STABLE, high-pattern-strength climate
// supports more confidence in ANY combination than a CHAOTIC one, since
// the underlying signals feeding every layer are themselves more trustworthy.
function regimeFitScore(climate) {
  if (!climate || climate.state === 'INSUFFICIENT_DATA') return 50;
  const base = climate.state === 'STABLE' ? 65 : 35;
  const strengthBonus = Math.round(((climate.patternStrength || 0) - 50) * 0.3);
  return Math.max(0, Math.min(100, base + strengthBonus));
}

// Reuses the health monitor's own prediction-consistency score when
// available (batch-to-batch overlap of picks) as a proxy for how settled
// vs. thrashing the engine's recent output has been. Falls back to CAME's
// effective independence (are layers agreeing for genuinely independent
// reasons, or just correlated) when consistency data isn't available yet.
function stabilityScore(cameState, consistency) {
  if (consistency && typeof consistency.consistencyScore === 'number') {
    return consistency.consistencyScore;
  }
  const maxIndependence = cameEngine.MAX_EFFECTIVE_INDEPENDENCE || 7;
  const ei = cameEngine.computeEffectiveIndependence(cameState);
  return Math.round(Math.max(0, Math.min(100, (ei / maxIndependence) * 100)));
}

function computeCombinationConfidence({ topN, scieResult, groupIntel, climate, cameState, consistency }) {
  const individualStrength = individualStrengthScore(topN);
  const relationshipStrength = relationshipStrengthScore(topN, scieResult, groupIntel);
  const historicalSupport = historicalSupportScore(topN, scieResult, groupIntel);
  const regimeFit = regimeFitScore(climate);
  const stability = stabilityScore(cameState, consistency);

  const score = Math.round(
    (individualStrength * WEIGHTS.individualStrength) +
    (relationshipStrength * WEIGHTS.relationshipStrength) +
    (historicalSupport * WEIGHTS.historicalSupport) +
    (regimeFit * WEIGHTS.regimeFit) +
    (stability * WEIGHTS.stability)
  );

  let verdict;
  if (relationshipStrength < 35 && individualStrength >= 70) {
    // The blueprint's Candidate B case: individually strong, weak together.
    verdict = 'REVIEW';
  } else if (score >= 70) {
    verdict = 'ACCEPT';
  } else if (score >= 45) {
    verdict = 'ACCEPTABLE';
  } else {
    verdict = 'REVIEW';
  }

  return {
    combinationConfidence: Math.max(0, Math.min(100, score)),
    verdict,
    components: {
      individualStrength,
      relationshipStrength,
      historicalSupport,
      regimeFit,
      stability
    }
  };
}

module.exports = {
  computeCombinationConfidence
};
