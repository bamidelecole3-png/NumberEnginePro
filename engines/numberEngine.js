'use strict';

const dataStore = require('../dataStore');
const ladderTracker = require('./ladderTracker');
const scieEngine = require('./scieEngine');
const cameEngine = require('./cameEngine');
// v19 — Intelligence Upgrade modules. Each is additive: none of them
// change how markov/scie/momentum/survivor/freq/combination compute
// their own base scores, and CAME's Brier-calibration + correlation-
// discounting math (engines/cameEngine.js) is untouched apart from
// 'group' being added as a 7th named layer it grades exactly like the
// other 6.
const patternClimateEngine = require('./patternClimateEngine');
const groupIntelligenceEngine = require('./groupIntelligenceEngine');
const opportunityWindowEngine = require('./opportunityWindowEngine');
const explainabilityEngine = require('./explainabilityEngine');
const healthMonitorEngine = require('./healthMonitorEngine');
// Blueprint-gap fixes (§4, §11, §13, §16): additive, read-only-where-possible
// modules closing the gaps flagged in the audit. overextensionEngine is the
// only one of the four that touches scoring (a bounded penalty on
// momentum/markov/combination, same "consult, don't rewrite" pattern
// patternClimateEngine already established) — frequencyWindowEngine,
// numberDnaEngine, and combinationConfidenceEngine are pure synthesis over
// already-computed data and cannot change which numbers get picked.
const overextensionEngine = require('./overextensionEngine');
const frequencyWindowEngine = require('./frequencyWindowEngine');
const numberDnaEngine = require('./numberDnaEngine');
const combinationConfidenceEngine = require('./combinationConfidenceEngine');
const fs = require('fs');
const path = require('path');

const ENGINE_FILE = path.join(__dirname, '..', 'data', 'numberEngine.json');

const DEFAULT_METRIC_WEIGHTS = {
  markov: 0.20,
  scie: 0.18,
  momentum: 0.16,
  survivor: 0.14,
  freq: 0.12,
  combination: 0.09,
  // v19: Group Intelligence's per-number confidence, added as a 7th layer
  // feeding CAME. Other defaults nudged down proportionally to make room —
  // this is only the STARTING split; CAME re-derives real weights from
  // Brier calibration after the first completed batch, same as always.
  group: 0.11
};

const LAYER_NAMES = ['markov', 'scie', 'momentum', 'survivor', 'freq', 'combination', 'group'];
const MIN_WEIGHT = 0.05; // floor so a weak layer never gets fully zeroed out
// The prediction size every dashboard route actually uses (only the
// user-facing /api/number/predict?size=N route ever varies this for
// display). tryEvaluateBatch always grades this fixed size as the batch of
// record, regardless of what `size` the in-flight predictNumbers() call
// that happened to trigger ladder completion was asked to return — see the
// BUG FIX comment at its call site below.
const CANONICAL_PREDICTION_SIZE = 4;
// NOTE: flat vote-threshold LEARNING_RATE constant removed in v18 — weight
// blending is now handled inside cameEngine.js (Brier calibration +
// correlation discounting), which has its own internal blend rates.

let tracker = {
  batches: [],
  layerWeights: { ...DEFAULT_METRIC_WEIGHTS },
  layerPerformance: {
    markov: { wins: 0, total: 0 },
    scie: { wins: 0, total: 0 },
    momentum: { wins: 0, total: 0 },
    survivor: { wins: 0, total: 0 },
    freq: { wins: 0, total: 0 },
    combination: { wins: 0, total: 0 },
    group: { wins: 0, total: 0 }
  },
  performance: {
    wins: 0,
    losses: 0,
    total: 0
  },
  // v18 CAME: Brier calibration + pairwise correlation state, replacing
  // the old flat vote-threshold learning. See engines/cameEngine.js.
  came: cameEngine.createInitialState(),
  // Full 49-number score vectors captured at prediction time for the
  // currently-in-progress (not yet evaluated) batch. CAME needs every
  // layer's score for every number, not just the top 4, so this is kept
  // separately from the lightweight `prediction` snapshot stored per
  // completed batch.
  pendingLayerScoreVectors: null
};

function loadTracker() {
  if (fs.existsSync(ENGINE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(ENGINE_FILE, 'utf8'));
      if (data && data.batches) {
        tracker = data;
        if (!tracker.layerWeights) tracker.layerWeights = { ...DEFAULT_METRIC_WEIGHTS };
        if (!tracker.layerPerformance) {
          tracker.layerPerformance = {};
          for (const name of LAYER_NAMES) tracker.layerPerformance[name] = { wins: 0, total: 0 };
        }
        // v18 migration: older save files won't have CAME state or pending
        // vectors yet. Initialize them in place rather than resetting
        // everything else, preserving the "surgical edit" convention —
        // existing batches/weights/performance history is untouched.
        if (!tracker.came) tracker.came = cameEngine.createInitialState();
        if (tracker.pendingLayerScoreVectors === undefined) tracker.pendingLayerScoreVectors = null;
        // v19 migration: older save files won't have the 'group' layer at
        // all yet. Same surgical-edit convention as the v18 migration
        // above — add what's missing, touch nothing else.
        //
        // BUG FIX: a pre-v19 tracker.layerWeights already sums to 1.0 over
        // its 6 layers (CAME's computeWeights() always normalizes). Simply
        // adding group: 0.11 on top pushed the total to 1.11 and stayed
        // there — inflating every prediction's composite score and
        // overallConfidence by ~11% — until the next completed batch
        // happened to call computeWeights() again and renormalize. A fresh
        // v19 install never hits this (DEFAULT_METRIC_WEIGHTS's 7 values
        // are already authored to sum to 1.0), so this path only fires for
        // an upgraded save file. Proportionally shrink the existing 6
        // layers so the 7-layer set still sums to 1.0 immediately, rather
        // than leaving it over-budget until the next batch happens to fix
        // it incidentally.
        if (!tracker.layerWeights.group) {
          const existingLayers = Object.keys(tracker.layerWeights);
          const existingSum = existingLayers.reduce((a, k) => a + tracker.layerWeights[k], 0);
          const groupWeight = DEFAULT_METRIC_WEIGHTS.group;
          const scale = existingSum > 0 ? (1 - groupWeight) / existingSum : 1;
          for (const k of existingLayers) {
            tracker.layerWeights[k] = Math.round(tracker.layerWeights[k] * scale * 1000) / 1000;
          }
          tracker.layerWeights.group = groupWeight;
        }
        if (!tracker.layerPerformance.group) {
          tracker.layerPerformance.group = { wins: 0, total: 0 };
        }
        if (tracker.came.layerBrier && !tracker.came.layerBrier.group) {
          tracker.came.layerBrier.group = { runningBrier: 0.25, batchesScored: 0 };
        }
      }
    } catch (e) {
      console.error('[numberEngine] Error loading tracker state:', e.message);
    }
  }
}

function saveTracker() {
  try {
    const dir = path.dirname(ENGINE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ENGINE_FILE, JSON.stringify(tracker, null, 2), 'utf8');
  } catch (e) {
    console.error('[numberEngine] Error saving tracker state:', e.message);
  }
}

loadTracker();

function calculateFrequencyMap(draws) {
  const counts = {};
  for (let i = 1; i <= 49; i++) counts[i] = 0;
  for (const d of draws) {
    for (const n of d.numbers) {
      counts[n] = (counts[n] || 0) + 1;
    }
  }
  return counts;
}

function calculateEmaScores(draws) {
  const scores = {};
  const alpha = 0.15;
  for (let i = 1; i <= 49; i++) scores[i] = 0;

  const chrono = draws.slice().reverse();
  for (const d of chrono) {
    const set = new Set(d.numbers);
    for (let n = 1; n <= 49; n++) {
      const val = set.has(n) ? 100 : 0;
      scores[n] = alpha * val + (1 - alpha) * scores[n];
    }
  }
  return scores;
}

function calculateGapScores(draws) {
  const gaps = {};
  for (let i = 1; i <= 49; i++) gaps[i] = 999;

  for (let idx = 0; idx < draws.length; idx++) {
    for (const n of draws[idx].numbers) {
      if (gaps[n] === 999) gaps[n] = idx;
    }
  }
  return gaps;
}

function calculateMarkovScores(draws) {
  const transition = {};
  for (let i = 1; i <= 49; i++) {
    transition[i] = {};
  }

  const chrono = draws.slice().reverse();
  for (let i = 0; i < chrono.length - 1; i++) {
    const curr = chrono[i].numbers;
    const next = chrono[i + 1].numbers;
    for (const c of curr) {
      for (const n of next) {
        transition[c][n] = (transition[c][n] || 0) + 1;
      }
    }
  }

  const lastDraw = draws[0] ? draws[0].numbers : [];
  const markov = {};
  for (let i = 1; i <= 49; i++) markov[i] = 0;

  for (const c of lastDraw) {
    for (let target = 1; target <= 49; target++) {
      markov[target] += transition[c][target] || 0;
    }
  }

  const max = Math.max(...Object.values(markov), 1);
  for (let i = 1; i <= 49; i++) {
    markov[i] = Math.round((markov[i] / max) * 100);
  }
  return markov;
}

// TOP 4 LIVE REALITY ENGINE — mode/drawsOverride support.
//
// `options.drawsOverride`: lets a caller supply a specific draws slice
// (newest-first, same shape as dataStore.getAllDraws()) instead of the
// live full history. The Reality Engine uses this to replay a historical
// "as of source draw N" view when multiple new draws land in a single
// ingest batch, so a reality prediction is never computed with knowledge
// of draws that happened after its own source draw (see top4RealityEngine.js
// §"no look-ahead").
//
// `options.mode === 'reality'`: reuses the exact same scoring pipeline as
// the normal user prediction (same layers, same weights, same CAME state)
// but skips the two state-mutating side effects normal predictions have —
// it does NOT overwrite tracker.pendingLayerScoreVectors and does NOT call
// tryEvaluateBatch (which can complete/grade a 5-draw batch and update CAME
// weights). This keeps Reality prediction generation a pure read against
// the existing intelligence, per the Reality Engine's "measure, don't
// retrain" contract.
function predictNumbers(size = 4, options = {}) {
  const { mode = 'live', drawsOverride = null } = options;
  const draws = drawsOverride || dataStore.getAllDraws();
  if (!draws || draws.length < 5) {
    return { error: 'Insufficient draws for analysis (minimum 5 required).' };
  }

  // Every prediction is anchored to the most recent ingested draw (draws[0],
  // since dataStore keeps state sorted newest-first). Capturing its real
  // drawId here ties the prediction to that specific Bet9ja draw, so the
  // frontend can show "based on draw <id>" and callers can tell whether a
  // prediction they're holding still matches the latest known draw.
  const sourceDraw = draws[0];

  const freqs = calculateFrequencyMap(draws);
  const emas = calculateEmaScores(draws);
  const gaps = calculateGapScores(draws);
  const markov = calculateMarkovScores(draws);

  const totalDraws = draws.length;

  // Pre-compute every non-SCIE layer's per-number score first, so SCIE's
  // Step 10 conflict resolution can see what the other engines think before
  // it finalizes its own scores.
  const preScores = { markov: {}, momentum: {}, survivor: {}, freq: {}, combination: {} };
  for (let n = 1; n <= 49; n++) {
    const globalFreqScore = Math.min(100, Math.round((freqs[n] / (totalDraws * 6 || 1)) * 450));
    const emaScore = Math.min(100, Math.round(emas[n]));
    const gapVal = gaps[n];
    const gapScore = gapVal >= 5 && gapVal <= 18 ? 85 : gapVal < 5 ? 40 : 60;
    const markovScore = markov[n];
    const survivorScore = gapVal > 2 && gapVal < 12 ? 80 : 45;
    const momentumVal = Math.round((emaScore * 0.6) + (markovScore * 0.4));
    const combinationScore = Math.round((globalFreqScore * 0.5) + (gapScore * 0.5));

    preScores.markov[n] = markovScore;
    preScores.momentum[n] = momentumVal;
    preScores.survivor[n] = survivorScore;
    preScores.freq[n] = globalFreqScore;
    preScores.combination[n] = combinationScore;
  }

  // v19 — Pattern Climate Engine: characterizes current conditions BEFORE
  // any prediction layer finalizes its recommendation, per the blueprint
  // ("every prediction layer should consult the current Pattern Climate").
  // Consultation happens via one bounded, clearly-labeled adjustment step
  // (see patternClimateEngine.applyClimateAdjustment) — every layer's base
  // scoring math above is untouched; only the resulting scores are nudged
  // by up to ±12% based on current climate conditions.
  const climate = patternClimateEngine.computeClimate(draws);
  const climateAdjusted = patternClimateEngine.applyClimateAdjustment(preScores, climate);
  preScores.markov = climateAdjusted.markov;
  preScores.momentum = climateAdjusted.momentum;
  preScores.survivor = climateAdjusted.survivor;
  preScores.freq = climateAdjusted.freq;
  preScores.combination = climateAdjusted.combination;

  // Blueprint §11 — Overextension Detector: applied after the climate
  // adjustment (so both bounded consultation steps compose rather than
  // one silently overwriting the other) and before SCIE/group scoring, so
  // a number chased purely on a recent hot streak is already discounted
  // by the time everything downstream sees its momentum/markov/combination
  // score. Only touches momentum/markov/combination (see
  // overextensionEngine.js for why freq/survivor/group are left alone).
  const overextension = overextensionEngine.computeOverextension(draws);
  const overextAdjusted = overextensionEngine.applyOverextensionPenalty(preScores, overextension);
  preScores.markov = overextAdjusted.markov;
  preScores.momentum = overextAdjusted.momentum;
  preScores.combination = overextAdjusted.combination;

  // v19 — Group Intelligence Engine: discovers/tracks/scores co-occurring
  // number groups (distinct from SCIE's directed trigger→target signals)
  // and supplies a per-number group-confidence score, consumed below as
  // a 7th CAME-graded layer.
  const groupIntel = groupIntelligenceEngine.computeGroupIntelligence(draws);

  const scieResult = scieEngine.computeScieScores(draws, preScores);

  const candidates = [];
  const weights = tracker.layerWeights;

  // v18 CAME: full 49-number score vector per layer, captured so the next
  // completed batch can grade every layer's calibration (Brier) and
  // pairwise correlation across the whole number space, not just the 4
  // numbers that ended up in the top-N prediction.
  const layerScoreVectors = { markov: {}, scie: {}, momentum: {}, survivor: {}, freq: {}, combination: {}, group: {} };

  for (let n = 1; n <= 49; n++) {
    const globalFreqScore = preScores.freq[n];
    const markovScore = preScores.markov[n];
    const survivorScore = preScores.survivor[n];
    const momentumVal = preScores.momentum[n];
    const combinationScore = preScores.combination[n];
    const scieScore = scieResult.scieScores[n] || 10;
    const groupScore = groupIntel.groupScores[n] || 10;
    const emaScore = Math.min(100, Math.round(emas[n]));
    const gapVal = gaps[n];
    const gapScore = gapVal >= 5 && gapVal <= 18 ? 85 : gapVal < 5 ? 40 : 60;

    layerScoreVectors.markov[n] = markovScore;
    layerScoreVectors.scie[n] = scieScore;
    layerScoreVectors.momentum[n] = momentumVal;
    layerScoreVectors.survivor[n] = survivorScore;
    layerScoreVectors.freq[n] = globalFreqScore;
    layerScoreVectors.combination[n] = combinationScore;
    layerScoreVectors.group[n] = groupScore;

    const composite = (
      (markovScore * weights.markov) +
      (scieScore * weights.scie) +
      (momentumVal * weights.momentum) +
      (survivorScore * weights.survivor) +
      (globalFreqScore * weights.freq) +
      (combinationScore * weights.combination) +
      (groupScore * (weights.group || 0))
    );

    const individualConfidence = Math.min(96, Math.max(30, Math.round(composite)));

    candidates.push({
      num: n,
      individualConfidence,
      momentumClass: momentumVal >= 70 ? 'Accelerating' : momentumVal >= 45 ? 'Steady' : 'Lagging',
      layerScores: {
        markov: markovScore,
        scie: scieScore,
        momentum: momentumVal,
        survivor: survivorScore,
        freq: globalFreqScore,
        combination: combinationScore,
        group: groupScore
      },
      layers: {
        globalFreq: globalFreqScore,
        ema: emaScore,
        recentWeight: Math.round(emaScore * 0.9),
        gapScore,
        streak: gapVal === 0 ? 90 : 20,
        positional: Math.round((n / 49) * 100),
        pairScore: Math.round((scieScore + markovScore) / 2),
        cycleBonus: n % 7 === 0 ? 80 : 50,
        markov: markovScore,
        entropy: 65,
        survivor: survivorScore,
        combination: combinationScore,
        momentum: momentumVal,
        scie: scieScore,
        group: groupScore
      }
    });
  }

  candidates.sort((a, b) => b.individualConfidence - a.individualConfidence);

  const topN = candidates.slice(0, size);
  const predictedNumbers = topN.map(c => c.num);

  const topRange = calculateTopRange(draws);
  const rawOverallConfidence = Math.min(95, Math.max(45, Math.round(topN.reduce((acc, c) => acc + c.individualConfidence, 0) / size)));

  // v20 #4 (scoring side) — consensusCalibration was previously
  // diagnostic-only: computed and shown on the dashboard, but nothing
  // read the learned consensusEdge back into confidence. Classify THIS
  // live batch's consensus level and temper accordingly — see
  // cameEngine.applyConsensusCalibration for the full rationale (only
  // ever tempers downward; requires a meaningfully negative, adequately
  // sampled edge before it does anything at all).
  const consensusCalibrationResult = cameEngine.applyConsensusCalibration(
    tracker.came, layerScoreVectors, rawOverallConfidence
  );
  const overallConfidence = consensusCalibrationResult.calibratedConfidence;

  // Keep the most recent full-vector snapshot as "pending" so that whenever
  // the current 5-draw ladder actually completes, CAME has the right
  // per-layer, per-number scores to grade — captured at the point this
  // batch's prediction was made, not recomputed after the fact.
  // Reality-mode calls must never touch this — they are an independent
  // audit lifecycle, not part of the normal 5-draw batch/CAME learning loop.
  if (mode !== 'reality') {
    tracker.pendingLayerScoreVectors = layerScoreVectors;
  }

  // BUG FIX: tryEvaluateBatch used to receive `topN` (sized to whatever
  // `size` this particular call was made with), and archives whatever it's
  // given as the permanent batch-of-record the moment a 5-draw ladder
  // completes. Every dashboard route hardcodes predictNumbers(4) — only
  // /api/number/predict?size=N lets a caller vary it — so a single request
  // with an unusual size, timed to land exactly when drawCount crosses a
  // multiple of 5, could permanently archive (say) a 10-number prediction
  // instead of the canonical 4-number one: easier to register a "win"
  // (isWin only needs 1 hit among more candidates) and skews lifetime/
  // recent win-rate stats and overallConfidence for that batch onward.
  // Evaluation should always grade the same canonical prediction regardless
  // of what size this particular caller asked to see, so it always passes
  // its own fixed-size slice rather than the caller-sized `topN`.
  const canonicalTopN = candidates.slice(0, CANONICAL_PREDICTION_SIZE);
  const rawCanonicalConfidence = Math.min(95, Math.max(45, Math.round(
    canonicalTopN.reduce((acc, c) => acc + c.individualConfidence, 0) / CANONICAL_PREDICTION_SIZE
  )));
  // Same live-batch consensus classification applies to the canonical
  // prediction too (it's the same layerScoreVectors) — tempering it here
  // keeps the archived confidence-of-record consistent with what was
  // actually shown, rather than archiving a pre-calibration number.
  const canonicalConfidence = Math.max(0, rawCanonicalConfidence - (rawOverallConfidence - overallConfidence));
  // Reality-mode calls must never create/complete a normal 5-draw batch —
  // that is the existing engine's own learning lifecycle, entirely separate
  // from the Reality Engine's 3-draw audit windows.
  if (mode !== 'reality') {
    tryEvaluateBatch(draws, canonicalTopN, canonicalConfidence, layerScoreVectors);
  }

  // v19 — Opportunity Window Engine: judges whether current conditions are
  // worth full confidence, using CAME's Effective Independence (computed
  // fresh here from the just-updated tracker.came state) alongside the
  // climate and group-intelligence signals already computed above.
  const effectiveIndependence = cameEngine.computeEffectiveIndependence(tracker.came);
  const opportunity = opportunityWindowEngine.computeOpportunity({
    climate,
    came: { effectiveIndependence },
    overallConfidence,
    groupIntel
  });

  // v19 — Explainability Engine: read-only summary of why these numbers
  // were selected. Computed last; cannot influence scoring.
  const explanation = explainabilityEngine.buildExplanation({
    topN,
    weights,
    climate,
    opportunity,
    scieResult,
    groupIntel
  });

  // Blueprint §4 — Multi-Window Frequency Engine: 5/10/20/50-draw +
  // long-term counts per number, plus a HOT/STABLE/COOLING/WEAK trend
  // classification. Pure read of draw history; does not feed scoring —
  // numberEngine's own `freq` layer (globalFreqScore above) is untouched.
  const freqWindows = frequencyWindowEngine.computeFrequencyWindows(draws);

  // Blueprint §13 — Number DNA Engine: behavioral profile per predicted
  // number, synthesized from signals already computed above (frequency
  // trend, gap/survivor score, group membership, momentum). Read-only,
  // computed last like explainability — cannot influence which numbers
  // were selected, only describes them after the fact.
  const dnaProfiles = numberDnaEngine.computeNumberDna(topN, freqWindows, groupIntel, overextension);

  // Blueprint §16 — Combination Confidence Engine: replaces the flat
  // average `overallConfidence` (still returned below for backward
  // compatibility) with a genuine combination-level score that separately
  // weighs individual strength, relationship strength between the picked
  // numbers specifically, historical support, current regime, and
  // prediction stability.
  const combinationConfidence = combinationConfidenceEngine.computeCombinationConfidence({
    topN,
    scieResult,
    groupIntel,
    climate,
    cameState: tracker.came,
    consistency: healthMonitorEngine.computeHealthReport({
      tracker,
      layerNames: LAYER_NAMES,
      defaultWeights: DEFAULT_METRIC_WEIGHTS,
      cameLayerCalibration: []
    }).predictionConsistency
  });

  return {
    predictedNumbers,
    numberDetails: topN,
    overallConfidence,
    // v20 #4 (scoring side): exposes whether/why overallConfidence above
    // was tempered by CAME's learned consensus edge, so a lowered number
    // is explainable on the dashboard rather than a silent adjustment.
    consensusCalibration: {
      applied: consensusCalibrationResult.applied,
      isHighConsensus: consensusCalibrationResult.isHighConsensus,
      agreementCount: consensusCalibrationResult.agreementCount,
      temperPoints: consensusCalibrationResult.temperPoints || 0,
      rawConfidence: rawOverallConfidence,
      reason: consensusCalibrationResult.reason
    },
    topRange,
    rangePct: { l: 30, m: 45, h: 25 },
    drawsUsed: totalDraws,
    sourceDrawId: sourceDraw.drawId,
    sourceDrawIdIsSynthetic: !!sourceDraw.drawIdIsSynthetic,
    sourceDrawTimestamp: sourceDraw.timestamp,
    scieSummary: {
      activeSignalsCount: scieResult.activeSignals.length,
      activeSignals: scieResult.activeSignals,
      clusterChains: scieResult.clusterChains,
      discoveredClusters: scieResult.discoveredClusters,
      clusterConfidence: scieResult.clusterConfidence,
      discoveryMode: scieResult.discoveryMode,
      conflicts: scieResult.conflicts,
      clusterVoteBreakdown: scieResult.clusterVoteBreakdown
    },
    // v19 Intelligence Upgrade fields — additive, does not change any of
    // the fields above or how they're computed.
    climate,
    groupIntelligence: groupIntel,
    opportunity,
    explanation,
    // Blueprint-gap-fix fields (§4, §11, §13, §16) — additive, same
    // convention as the v19 fields above.
    overextension: {
      overextendedNumbers: overextension.overextendedNumbers,
      insufficientData: overextension.insufficientData
    },
    frequencyWindows: freqWindows,
    numberDna: dnaProfiles,
    combinationConfidence
  };
}

function calculateTopRange(draws) {
  if (!draws.length) return 'mid';
  const recent = draws.slice(0, 10);
  let l = 0, m = 0, h = 0;
  for (const d of recent) {
    if (d.range === 'low') l++;
    else if (d.range === 'high') h++;
    else m++;
  }
  if (l >= m && l >= h) return 'low';
  if (h >= m && h >= l) return 'high';
  return 'mid';
}

// Legacy display-only tally: still used by getArchive()'s per-layer
// "winRate" column (a layer's raw hit rate on the numbers it scored >= 60
// for). This is no longer what drives layerWeights — CAME (see
// engines/cameEngine.js) derives the weights now — but the win-rate figure
// is still a useful, easy-to-read diagnostic on the dashboard, so it's
// kept and updated alongside CAME rather than removed.
function updateLayerPerformance(topNWithLayers, evaluatedNumbers) {
  const VOTE_THRESHOLD = 60;

  for (const candidate of topNWithLayers) {
    const hit = evaluatedNumbers.has(candidate.num);
    for (const layer of LAYER_NAMES) {
      const layerScore = candidate.layerScores[layer];
      const layerVotedFor = layerScore >= VOTE_THRESHOLD;
      if (!layerVotedFor) continue; // only score layers that actually backed this number

      tracker.layerPerformance[layer].total++;
      if (hit) tracker.layerPerformance[layer].wins++;
    }
  }
}

// v18: Correlation-Aware Meta Engine weight update. Replaces the old
// recalculateLayerWeights() flat-win-rate approach. Grades every layer
// against the full 49-number space (Brier score) and discounts layers
// that are highly correlated with a more-accurate layer, so agreement
// between structurally-linked layers (e.g. Momentum/Markov) isn't
// double-counted as independent confirmation. See engines/cameEngine.js
// for the full step-by-step math.
function recalculateLayerWeightsWithCame(layerScoreVectors, evaluatedNumbers, batchId) {
  tracker.came = cameEngine.updateCameState(tracker.came, layerScoreVectors, evaluatedNumbers, batchId);
  const { weights } = cameEngine.computeWeights(tracker.came);
  tracker.layerWeights = weights;
}

function tryEvaluateBatch(draws, topNWithLayers, currentConfidence, layerScoreVectors) {
  const ladder = ladderTracker.ladderProgress(draws.length, 5);
  const currentPredicted = topNWithLayers.map(c => c.num);

  if (ladder.complete && draws.length >= 5) {
    const batchId = Math.floor(draws.length / 5);
    const existing = tracker.batches.find(b => b.batchId === batchId);

    if (!existing) {
      const evaluationWindow = draws.slice(0, 5);
      const evaluatedNumbers = new Set(evaluationWindow.flatMap(d => d.numbers));

      let hits = 0;
      for (const p of currentPredicted) {
        if (evaluatedNumbers.has(p)) hits++;
      }

      const isWin = hits >= 1;

      updateLayerPerformance(topNWithLayers, evaluatedNumbers);

      // CAME needs the full 49-number vectors from the prediction cycle
      // that produced this batch's picks. Prefer the vectors captured at
      // that exact prediction time (tracker.pendingLayerScoreVectors); fall
      // back to the vectors passed in from the current call only if no
      // pending snapshot exists yet (e.g. first-ever batch, or state
      // migrated from a pre-v18 save file).
      const vectorsForGrading = tracker.pendingLayerScoreVectors || layerScoreVectors;
      recalculateLayerWeightsWithCame(vectorsForGrading, evaluatedNumbers, batchId);
      tracker.pendingLayerScoreVectors = null;

      const newBatch = {
        batchId,
        evaluatedAt: new Date().toISOString(),
        prediction: {
          predictedNumbers: currentPredicted,
          overallConfidence: currentConfidence
        },
        result: {
          numberHits: hits,
          requiredHits: 1,
          isWin
        },
        weightsAfter: { ...tracker.layerWeights },
        // v19: this batch's raw per-layer Brier scores, for the Enhanced
        // Engine Health Monitor's layer reliability TREND (as opposed to
        // weightsAfter, which only shows the running-average outcome).
        layerBrierSnapshot: tracker.came.lastBatchBrier ? { ...tracker.came.lastBatchBrier } : null
      };

      tracker.batches.unshift(newBatch);
      if (isWin) tracker.performance.wins++;
      else tracker.performance.losses++;
      tracker.performance.total++;

      saveTracker();
    }
  }
}

function getArchive() {
  const layerRanking = LAYER_NAMES.map(name => {
    const perf = tracker.layerPerformance[name];
    return {
      name,
      weight: tracker.layerWeights[name],
      winRate: perf.total > 0 ? Math.round((perf.wins / perf.total) * 100) : null,
      sample: perf.total
    };
  }).sort((a, b) => b.weight - a.weight);

  // v18: expose CAME's calibration/correlation diagnostics alongside the
  // existing weight/win-rate view, so the dashboard can show *why* the
  // weights are what they are, not just what they currently are.
  const { weights: cameWeights, discounts: cameDiscounts } = cameEngine.computeWeights(tracker.came);
  const came = cameEngine.getDiagnostics(tracker.came, cameWeights, cameDiscounts);

  return {
    batches: tracker.batches,
    performance: tracker.performance,
    layerWeights: tracker.layerWeights,
    layerPerformance: tracker.layerPerformance,
    layerRanking,
    came
  };
}

function getFiveDrawLadderPerformance() {
  const draws = dataStore.getAllDraws();
  if (draws.length < 5) return [];

  const results = [];
  const batchCount = Math.min(10, Math.floor(draws.length / 5));

  for (let b = 0; b < batchCount; b++) {
    const slice = draws.slice(b * 5, (b + 1) * 5);
    if (slice.length < 5) continue;

    const freq = {};
    for (const d of slice) {
      for (const n of d.numbers) {
        freq[n] = (freq[n] || 0) + 1;
      }
    }

    const uniqueNumbers = Object.keys(freq).map(Number).map(num => ({
      num,
      count: freq[num]
    })).sort((a, b) => b.count - a.count);

    const predictedNumbers = uniqueNumbers.slice(0, 4).map(u => u.num);
    const totalHits = uniqueNumbers.reduce((acc, curr) => acc + (curr.count > 1 ? curr.count : 0), 0);

    results.push({
      batchLabel: `Draws #${draws.length - (b * 5 + 4)}–#${draws.length - (b * 5)}`,
      predictedNumbers,
      uniqueNumbers: uniqueNumbers.slice(0, 10),
      totalHits
    });
  }

  return results;
}

// v19 — Enhanced Engine Health Monitor. Pure read of current tracker
// state; does not mutate anything. Reuses the same CAME diagnostics
// getArchive() already computes so the two stay consistent with each
// other.
function getEngineHealth() {
  const { weights: cameWeights, discounts: cameDiscounts } = cameEngine.computeWeights(tracker.came);
  const came = cameEngine.getDiagnostics(tracker.came, cameWeights, cameDiscounts);
  return healthMonitorEngine.computeHealthReport({
    tracker,
    layerNames: LAYER_NAMES,
    defaultWeights: DEFAULT_METRIC_WEIGHTS,
    cameLayerCalibration: came.layerCalibration
  });
}

// TOP 4 LIVE REALITY ENGINE — dedicated internal prediction path (spec §6).
// Thin wrapper so callers don't need to know about the options contract
// directly; always mode:'reality', always size 4 (the canonical Top 4).
function generateRealityPrediction(drawsAsOfSource) {
  return predictNumbers(CANONICAL_PREDICTION_SIZE, { mode: 'reality', drawsOverride: drawsAsOfSource });
}

module.exports = {
  predictNumbers,
  generateRealityPrediction,
  getArchive,
  getFiveDrawLadderPerformance,
  getEngineHealth
};
