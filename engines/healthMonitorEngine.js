'use strict';

// ── ENHANCED ENGINE HEALTH MONITOR — v19 ────────────────────────────────
//
// Pure, read-only diagnostic layer. Takes the existing tracker state
// (batches, layerPerformance, CAME state, layerWeights) — the same data
// getArchive() already exposes — and derives the additional views the
// blueprint asks for. Adds nothing to what's stored; only reads and
// summarizes what the engine already tracks, plus the per-batch Brier
// snapshots cameEngine.js now stashes on state.lastBatchBrier at the
// point each batch closes (see numberEngine.js's batch-close handler,
// which copies that snapshot onto each batch record before it's
// persisted).

const DEFAULT_WEIGHTS_SUM_CHECK = 1; // sanity constant, not user-facing

function accuracyByLayer(layerPerformance, cameLayerCalibration) {
  const calibByLayer = {};
  for (const l of cameLayerCalibration || []) calibByLayer[l.layer] = l;

  return Object.keys(layerPerformance).map(layer => {
    const perf = layerPerformance[layer];
    const calib = calibByLayer[layer];
    return {
      layer,
      winRate: perf.total > 0 ? Math.round((perf.wins / perf.total) * 100) : null,
      sample: perf.total,
      brier: calib ? calib.batchBrier : null,
      weight: calib ? calib.weight : null
    };
  });
}

// Compares each layer's Brier score on the most recent few evaluated
// batches against the batches before that, using the per-batch snapshots
// stored on each batch record (batch.layerBrierSnapshot). Lower Brier is
// better, so a negative delta (recent < older) means the layer is
// improving.
function layerReliabilityTrend(batches, layerNames) {
  const withSnapshot = batches.filter(b => b.layerBrierSnapshot);
  if (withSnapshot.length < 4) {
    return layerNames.map(layer => ({ layer, trend: 'INSUFFICIENT_DATA', deltaBrier: null }));
  }

  const half = Math.floor(withSnapshot.length / 2);
  const recentHalf = withSnapshot.slice(0, half);
  const olderHalf = withSnapshot.slice(half, half * 2);

  return layerNames.map(layer => {
    const recentAvg = recentHalf.reduce((a, b) => a + (b.layerBrierSnapshot[layer] ?? 0.25), 0) / recentHalf.length;
    const olderAvg = olderHalf.reduce((a, b) => a + (b.layerBrierSnapshot[layer] ?? 0.25), 0) / olderHalf.length;
    const delta = Math.round((recentAvg - olderAvg) * 1000) / 1000;
    return {
      layer,
      trend: delta <= -0.01 ? 'IMPROVING' : delta >= 0.01 ? 'DECLINING' : 'STABLE',
      deltaBrier: delta
    };
  });
}

// Overall predicted-confidence trend across recent batches (distinct from
// per-layer Brier trend above) — is the engine's own stated confidence
// drifting up or down over time.
function confidenceTrend(batches) {
  if (batches.length < 4) return { trend: 'INSUFFICIENT_DATA', recentAvg: null, olderAvg: null };
  const half = Math.floor(batches.length / 2);
  const recentAvg = batches.slice(0, half).reduce((a, b) => a + b.prediction.overallConfidence, 0) / half;
  const olderAvg = batches.slice(half, half * 2).reduce((a, b) => a + b.prediction.overallConfidence, 0) / half;
  const delta = Math.round((recentAvg - olderAvg) * 10) / 10;
  return {
    trend: delta >= 2 ? 'RISING' : delta <= -2 ? 'FALLING' : 'FLAT',
    recentAvg: Math.round(recentAvg),
    olderAvg: Math.round(olderAvg),
    deltaPct: delta
  };
}

// How much overlap the top-4 predicted set shares across the last few
// batches — high overlap = consistent picks, very low overlap = the
// engine is thrashing between different numbers batch to batch.
function predictionConsistency(batches) {
  const recent = batches.slice(0, 5);
  if (recent.length < 3) return { consistencyScore: null, label: 'INSUFFICIENT_DATA' };

  let totalOverlap = 0;
  let comparisons = 0;
  for (let i = 0; i < recent.length - 1; i++) {
    const a = new Set(recent[i].prediction.predictedNumbers);
    const b = recent[i + 1].prediction.predictedNumbers;
    const overlap = b.filter(n => a.has(n)).length;
    totalOverlap += overlap / Math.max(a.size, 1);
    comparisons++;
  }
  const consistencyScore = comparisons ? Math.round((totalOverlap / comparisons) * 100) : null;
  return {
    consistencyScore,
    label: consistencyScore >= 60 ? 'HIGH' : consistencyScore >= 30 ? 'MODERATE' : 'LOW'
  };
}

// How far layer weights have drifted from their default split, and how
// many batches CAME has actually learned from — a simple, honest measure
// of "how much has the engine actually learned so far."
function learningProgress(layerWeights, defaultWeights, batchesScored) {
  let totalDrift = 0;
  for (const layer of Object.keys(defaultWeights)) {
    totalDrift += Math.abs((layerWeights[layer] ?? defaultWeights[layer]) - defaultWeights[layer]);
  }
  const driftPct = Math.round(totalDrift * 100);
  return {
    batchesScored,
    weightDriftFromDefault: driftPct,
    stage: batchesScored === 0 ? 'UNTRAINED' : batchesScored < 10 ? 'EARLY_LEARNING' : batchesScored < 30 ? 'CALIBRATING' : 'MATURE'
  };
}

function overallHealthStatus({ batches, confTrend, consistency, reliabilityTrend }) {
  if (batches.length < 4) return 'INSUFFICIENT_DATA';
  const decliningLayers = reliabilityTrend.filter(l => l.trend === 'DECLINING').length;
  if (decliningLayers >= Math.ceil(reliabilityTrend.length / 2) || confTrend.trend === 'FALLING') {
    return 'DEGRADED';
  }
  if (consistency.label === 'LOW') return 'VOLATILE';
  if (batches.length < 15) return 'LEARNING';
  return 'HEALTHY';
}

function computeHealthReport({ tracker, layerNames, defaultWeights, cameLayerCalibration }) {
  const batches = tracker.batches || [];
  const reliabilityTrend = layerReliabilityTrend(batches, layerNames);
  const confTrend = confidenceTrend(batches);
  const consistency = predictionConsistency(batches);
  const progress = learningProgress(tracker.layerWeights, defaultWeights, batches.length);

  return {
    status: overallHealthStatus({ batches, confTrend, consistency, reliabilityTrend }),
    accuracyByLayer: accuracyByLayer(tracker.layerPerformance, cameLayerCalibration),
    layerReliabilityTrend: reliabilityTrend,
    confidenceTrend: confTrend,
    predictionConsistency: consistency,
    learningProgress: progress,
    adaptiveVotingWeights: tracker.layerWeights
  };
}

module.exports = {
  computeHealthReport
};
