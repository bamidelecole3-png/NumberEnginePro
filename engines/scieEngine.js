'use strict';

const SEED_CLUSTERS = {
  triplets: [
    [2, 5, 8],
    [20, 23, 32],
    [30, 33, 3],
    [28, 38, 48],
    [14, 11, 17],
    [27, 37, 47],
    [15, 35, 45],
    [4, 10, 40]
  ],
  pairs: [
    [26, 29],
    [36, 39],
    [6, 9],
    [16, 19],
    [10, 40],
    [12, 21],
    [13, 31],
    [11, 22],
    [44, 47],
    [14, 41],
    [23, 32],
    [3, 33],
    [46, 49],
    [7, 17],
    [8, 18]
  ]
};

const ACTIVATION_WEIGHTS = [1.0, 0.9, 0.7, 0.5, 0.3, 0.1];

// All seed relationships that should be excluded from "discovered" status,
// including the pairwise edges implied by each seed triplet (e.g. triplet
// [2,5,8] implies seed pairs 2-5, 5-8, 2-8). Built the same way
// getActiveSignals() builds its own allPairs list, so the two stay
// consistent with each other.
function buildSeedPairSet() {
  const set = new Set();
  const add = (a, b) => set.add(a < b ? `${a}-${b}` : `${b}-${a}`);
  for (const [a, b] of SEED_CLUSTERS.pairs) add(a, b);
  for (const [a, b, c] of SEED_CLUSTERS.triplets) {
    add(a, b); add(b, c); add(a, c);
  }
  return set;
}

const SEED_PAIR_SET = buildSeedPairSet();

function analyzeHistoricalReliability(draws) {
  if (!draws || draws.length < 10) {
    return { reliabilityMap: new Map(), discoveredClusters: [] };
  }

  const chrono = draws.slice().reverse();
  const occurrences = new Map();

  function recordPair(trigger, target) {
    const key = `${trigger}->${target}`;
    if (!occurrences.has(key)) {
      occurrences.set(key, { trigger, target, observed: 0, hits: 0, delays: [] });
    }
    return occurrences.get(key);
  }

  for (let i = 0; i < chrono.length - 1; i++) {
    const currentDraw = chrono[i].numbers;
    const window = chrono.slice(i + 1, Math.min(chrono.length, i + 7));

    for (const trig of currentDraw) {
      for (let target = 1; target <= 49; target++) {
        if (trig === target) continue;

        let delay = -1;
        for (let d = 0; d < window.length; d++) {
          if (window[d].numbers.includes(target)) {
            delay = d + 1;
            break;
          }
        }

        const record = recordPair(trig, target);
        record.observed++;
        if (delay > 0) {
          record.hits++;
          record.delays.push(delay);
        }
      }
    }
  }

  const reliabilityMap = new Map();
  const discoveredClusters = [];

  for (const [key, stat] of occurrences.entries()) {
    if (stat.observed < 5) continue;
    const hitRate = (stat.hits / stat.observed) * 100;
    const avgDelay = stat.delays.length > 0
      ? stat.delays.reduce((a, b) => a + b, 0) / stat.delays.length
      : 3.0;

    reliabilityMap.set(key, {
      observed: stat.observed,
      successful: stat.hits,
      reliability: Math.round(hitRate * 10) / 10,
      avgDelay: Math.round(avgDelay * 10) / 10
    });

    if (stat.observed >= 12 && hitRate >= 70.0) {
      // BUG FIX: previously only checked SEED_CLUSTERS.pairs, so a
      // triplet-derived edge (e.g. 2-8 from triplet [2,5,8]) that was
      // already a known seed relationship could be mislabeled as newly
      // "discovered" — SEED_PAIR_SET includes both seed pairs and every
      // pairwise edge implied by a seed triplet.
      const isSeed = SEED_PAIR_SET.has(stat.trigger < stat.target ? `${stat.trigger}-${stat.target}` : `${stat.target}-${stat.trigger}`);
      if (!isSeed) {
        discoveredClusters.push({
          trigger: stat.trigger,
          target: stat.target,
          observed: stat.observed,
          reliability: Math.round(hitRate * 10) / 10,
          avgDelay: Math.round(avgDelay * 10) / 10
        });
      }
    }
  }

  return { reliabilityMap, discoveredClusters };
}

function getActiveSignals(draws, reliabilityMap) {
  if (!draws || draws.length === 0) return [];

  const activeSignals = [];
  const recentDraws = draws.slice(0, 6);

  const allPairs = [...SEED_CLUSTERS.pairs];

  for (const trip of SEED_CLUSTERS.triplets) {
    allPairs.push([trip[0], trip[1]], [trip[1], trip[2]], [trip[0], trip[2]]);
  }

  recentDraws.forEach((drawItem, drawAge) => {
    const ageWeight = ACTIVATION_WEIGHTS[drawAge] || 0;
    if (ageWeight <= 0) return;

    for (const num of drawItem.numbers) {
      for (const [a, b] of allPairs) {
        let trigger = null;
        let target = null;

        if (num === a) { trigger = a; target = b; }
        else if (num === b) { trigger = b; target = a; }

        if (trigger && target) {
          const relKey = `${trigger}->${target}`;
          const relInfo = reliabilityMap.get(relKey) || {
            observed: 20,
            successful: 16,
            reliability: 80.0,
            avgDelay: 2.5
          };

          const rawConf = ageWeight * (relInfo.reliability / 100) * 100;

          activeSignals.push({
            trigger,
            target,
            age: drawAge,
            weight: ageWeight,
            reliability: relInfo.reliability,
            observed: relInfo.observed,
            successful: relInfo.successful,
            avgDelay: relInfo.avgDelay,
            confidence: Math.round(rawConf),
            confidenceLabel: rawConf >= 75 ? 'High' : rawConf >= 50 ? 'Medium' : 'Low',
            clusterKey: `${trigger}→${target}`
          });
        }
      }
    }
  });

  const signalMap = new Map();
  for (const sig of activeSignals) {
    const key = `${sig.trigger}->${sig.target}`;
    if (!signalMap.has(key) || signalMap.get(key).confidence < sig.confidence) {
      signalMap.set(key, sig);
    }
  }

  return Array.from(signalMap.values()).sort((a, b) => b.confidence - a.confidence);
}

function detectClusterChains(activeSignals) {
  const chains = [];
  const targetMap = new Map();
  for (const sig of activeSignals) {
    targetMap.set(sig.trigger, sig);
  }

  for (const sig of activeSignals) {
    if (targetMap.has(sig.target)) {
      const nextSig = targetMap.get(sig.target);
      const chainStr = `${sig.trigger}→${sig.target}→${nextSig.target}`;
      const chainConf = Math.round((sig.confidence + nextSig.confidence) / 2 * 1.15);
      chains.push({
        chain: chainStr,
        finalTarget: nextSig.target,
        confidence: Math.min(99, chainConf),
        length: 3
      });
    }
  }

  return chains;
}

// STEP 10 — Conflict Resolution.
// The blueprint requires the Meta Engine to apply *penalties* to a cluster
// vote when another layer strongly disagrees with that target, instead of
// blindly boosting every linked number. `otherLayerScores` is a per-number
// score map (0-100) coming from each of the other engines (markov, momentum,
// survivor, freq, combination). A target is penalized when a majority of
// those layers score it very low (< 25), signalling active rejection rather
// than mere disinterest.
function applyConflictResolution(scores, activeSignals, otherLayerScores) {
  const penalized = {};
  const conflicts = [];

  if (!otherLayerScores) {
    return { scores, conflicts };
  }

  const layerNames = Object.keys(otherLayerScores);

  for (const sig of activeSignals) {
    const target = sig.target;
    if (penalized[target]) continue;

    let rejectingLayers = 0;
    for (const layer of layerNames) {
      const layerScore = otherLayerScores[layer][target];
      if (typeof layerScore === 'number' && layerScore < 25) {
        rejectingLayers++;
      }
    }

    // Majority of other layers actively reject this target: apply a penalty
    // to the accumulated score rather than letting the signal stand unopposed.
    if (rejectingLayers >= Math.ceil(layerNames.length / 2)) {
      const before = scores[target];
      scores[target] = scores[target] * 0.4;
      penalized[target] = true;
      conflicts.push({
        target,
        trigger: sig.trigger,
        rejectingLayers,
        totalLayers: layerNames.length,
        scoreBefore: Math.round(before),
        scoreAfter: Math.round(scores[target])
      });
    }
  }

  return { scores, conflicts };
}

// STEP 5 — Cluster Voting.
// Each engine casts an independent 1-5 star vote for a target number, based
// on that engine's own score for it (0-100 -> 1-5 stars). This produces the
// discrete per-engine vote breakdown the blueprint describes, separate from
// the weighted composite score computed in numberEngine.js.
function starVotesForTarget(target, otherLayerScores) {
  if (!otherLayerScores) return null;
  const toStars = (v) => Math.max(1, Math.min(5, Math.round((v || 0) / 20)));
  const votes = {};
  for (const layer of Object.keys(otherLayerScores)) {
    votes[layer] = toStars(otherLayerScores[layer][target]);
  }
  return votes;
}

function computeScieScores(draws, otherLayerScores) {
  const { reliabilityMap, discoveredClusters } = analyzeHistoricalReliability(draws);
  const activeSignals = getActiveSignals(draws, reliabilityMap);
  const clusterChains = detectClusterChains(activeSignals);

  const scores = {};
  const votes = {};
  for (let n = 1; n <= 49; n++) {
    scores[n] = 0;
    votes[n] = 0;
  }

  for (const sig of activeSignals) {
    scores[sig.target] += sig.confidence * 0.85;
    votes[sig.target] += 1;
  }

  for (const chain of clusterChains) {
    scores[chain.finalTarget] += chain.confidence * 0.35;
    votes[chain.finalTarget] += 1;
  }

  const { conflicts } = applyConflictResolution(scores, activeSignals, otherLayerScores);

  let maxScore = 0;
  for (let n = 1; n <= 49; n++) {
    if (scores[n] > maxScore) maxScore = scores[n];
  }

  const normalized = {};
  for (let n = 1; n <= 49; n++) {
    normalized[n] = maxScore > 0 ? Math.round((scores[n] / maxScore) * 100) : 10;
  }

  const topScore = activeSignals.length ? Math.max(...Object.values(normalized)) : 0;
  const clusterConfidence = topScore >= 75 ? 'HIGH' : topScore >= 50 ? 'MEDIUM' : 'LOW';

  // Attach a star-vote breakdown to the top-scoring active signals only, so
  // the dashboard can show real Step 5 voting detail without computing it
  // for all 49 numbers.
  const topTargets = activeSignals
    .slice()
    .sort((a, b) => normalized[b.target] - normalized[a.target])
    .slice(0, 5)
    .map(sig => ({
      target: sig.target,
      trigger: sig.trigger,
      starVotes: starVotesForTarget(sig.target, otherLayerScores),
      totalVotes: votes[sig.target]
    }));

  return {
    scieScores: normalized,
    activeSignals,
    clusterChains,
    discoveredClusters,
    clusterVotes: votes,
    clusterConfidence,
    discoveryMode: 'ON',
    conflicts,
    clusterVoteBreakdown: topTargets
  };
}

module.exports = {
  computeScieScores,
  analyzeHistoricalReliability,
  SEED_CLUSTERS
};
