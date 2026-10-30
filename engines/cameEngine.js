'use strict';

// ── CORRELATION-AWARE META ENGINE (CAME) — v20 ─────────────────────────
//
// Replaces the old VOTE_THRESHOLD / flat-win-rate weight learning
// (previously `updateLayerPerformance` + `recalculateLayerWeights` in
// numberEngine.js) with two connected upgrades, per the v18 spec:
//
//   1. Per-layer Brier calibration — every layer is graded against all 49
//      numbers every batch (not just the 4 it "voted" on), giving a 49x
//      denser learning signal per batch.
//   2. Pairwise correlation discounting — layers that move together
//      (e.g. Momentum is 60% EMA / 40% Markov-derived) have their combined
//      contribution discounted so agreement isn't double-counted as
//      independent confirmation.
//
// CAME does not touch any layer's own scoring logic (Markov, SCIE,
// Momentum, Survivor, Freq, Combination all compute their per-number
// scores exactly as before). It only changes how those scores are graded
// and combined into layerWeights. Nothing downstream of layerWeights
// (the composite-score formula in numberEngine.js, the dashboard, or
// /api/analytics /api/intelligence/report) needs to change its
// consumption pattern — it's a smarter scoring function over the same
// weights shape.

// v19: 'group' added as a 7th layer — Group Intelligence Engine's
// per-number confidence, supplied into the exact same Brier calibration +
// correlation discounting pipeline as the original 6 layers, per the
// blueprint's explicit "supply group confidence to the CAME decision
// system" requirement. Nothing else about CAME's math changes — it's
// still the same two-step calibrate-then-discount process, just over 7
// inputs instead of 6.
//
// v20 — CAME Intelligence Upgrade. Four additive refinements to the v18/19
// math, none of which change LAYER_NAMES, the public function signatures,
// or the shape of what getDiagnostics() returns to existing callers
// (numberEngine.js, healthMonitorEngine.js, combinationConfidenceEngine.js,
// opportunityWindowEngine.js all keep working unmodified):
//
//   1. Recency-weighted Brier floor — runningBrier no longer blends with a
//      strictly-decaying 1/(n+1) weight forever (batch 200 barely nudges
//      it). A floored EMA (RECENCY_WEIGHT_FLOOR) keeps CAME sensitive to
//      genuine regime drift in a layer's accuracy indefinitely, not just
//      during early learning.
//   2. Max-correlation discount — a layer's discount is now driven by its
//      SINGLE strongest correlation with a higher-ranked layer, not the
//      average across all higher-ranked layers. Averaging let one serious
//      redundancy (e.g. perfectly mirroring the top layer) get diluted by
//      several unrelated weak correlations; the max is the actual
//      double-counting risk.
//   3. Sample-size shrinkage — a layer's effective Brier (used for ranking
//      and weighting, not display) is shrunk toward the neutral 0.25 prior
//      proportional to how few batches it's been graded on, via
//      SHRINKAGE_FULL_TRUST_BATCHES. Stops a newly-added layer (like
//      'group' at migration) from swinging weights on a handful of
//      early batches before it has a real track record.
//   4. Consensus-conditioned Brier — beyond the existing unconditional
//      per-layer Brier, CAME now separately tracks how accurate the
//      COMPOSITE (weighted-blend) prediction is when layers agree
//      (high consensus) vs. when they're split (low consensus), so
//      "did the engines agree" becomes a signal CAME actually learns
//      from and can use to temper confidence, not just a display-only
//      diagnostic. See scoreConsensusBrier / updateConsensusState below.
const LAYER_NAMES = ['markov', 'scie', 'momentum', 'survivor', 'freq', 'combination', 'group'];
const MIN_WEIGHT = 0.05; // floor so a weak layer never gets fully zeroed out
const EPSILON = 0.02; // avoids divide-by-zero for a perfectly calibrated layer
const CORRELATION_BLEND_RATE = 0.35; // same rolling-update cadence as weight learning
const REDUNDANCY_THRESHOLD = 0.75;
const REDUNDANCY_STREAK_MIN = 5;
const DISCOUNT_MULTIPLIER = 0.5; // conservative: reduce double-counting, don't punish real signal

// v20 #1 — recency weighting. Running Brier blend weight is
// max(RECENCY_WEIGHT_FLOOR, 1/(n+1)): fast-moving while young, same as
// before, but never decays below the floor, so a layer whose real-world
// accuracy shifts after batch 200 is still felt within a bounded number of
// batches instead of taking hundreds to move a heavily-averaged figure.
const RECENCY_WEIGHT_FLOOR = 0.05; // never blend slower than a ~20-batch half-life

// v20 #3 — sample-size shrinkage. A layer's effective (ranking/weighting)
// Brier is a blend of its runningBrier and the neutral 0.25 prior,
// weighted by shrinkTowardPrior = batchesScored / SHRINKAGE_FULL_TRUST_BATCHES
// (capped at 1). Below this many graded batches, CAME deliberately doesn't
// fully trust a layer's own track record yet.
const SHRINKAGE_FULL_TRUST_BATCHES = 20;

// v20 #4 — consensus-conditioned Brier. A "high consensus" batch is one
// where at least CONSENSUS_AGREEMENT_MIN of the graded layers independently
// scored the SAME number >= CONSENSUS_VOTE_THRESHOLD. Mirrors the
// VOTE_THRESHOLD convention numberEngine.js already uses for
// updateLayerPerformance, so "agreement" means the same thing here as it
// does on the existing per-layer win-rate diagnostic.
const CONSENSUS_VOTE_THRESHOLD = 60;
const CONSENSUS_AGREEMENT_MIN = 4; // out of 7 layers
// Consensus buckets blend with the same floored-recency EMA as v20 #1
// (see RECENCY_WEIGHT_FLOOR) rather than a separate constant — consensus
// batches are rarer per bucket, so the fast-early/floored-late shape is
// exactly as appropriate here as it is for per-layer Brier.

// ── State shape ──────────────────────────────────────────────────────────
// {
//   layerBrier: { <layer>: { runningBrier, batchesScored } },
//   correlations: { "layerA|layerB": { value, streakAboveThreshold } },
//   redundancyWarnings: [ { layers, correlation, batchesObserved, suggestion, firstSeenBatchId } ],
//   lastDiscounts: { <layer>: number },
//   lastEffectiveIndependence: number,
//   consensus: {                                    -- v20 #4
//     highConsensus: { runningBrier, batchesScored },
//     lowConsensus:  { runningBrier, batchesScored }
//   },
//   lastConsensusInfo: { isHighConsensus, agreementCount, compositeBrier } | null
// }

function createInitialState() {
  const layerBrier = {};
  for (const name of LAYER_NAMES) {
    layerBrier[name] = { runningBrier: 0.25, batchesScored: 0 }; // 0.25 = flat-50% prior
  }
  return {
    layerBrier,
    correlations: {},
    redundancyWarnings: [],
    lastDiscounts: {},
    lastEffectiveIndependence: null,
    // v20 #4
    consensus: {
      highConsensus: { runningBrier: 0.25, batchesScored: 0 },
      lowConsensus: { runningBrier: 0.25, batchesScored: 0 }
    },
    lastConsensusInfo: null
  };
}

function pairKey(a, b) {
  return [a, b].sort().join('|');
}

function allPairs() {
  const pairs = [];
  for (let i = 0; i < LAYER_NAMES.length; i++) {
    for (let j = i + 1; j < LAYER_NAMES.length; j++) {
      pairs.push([LAYER_NAMES[i], LAYER_NAMES[j]]);
    }
  }
  return pairs;
}

// ── Step 1: Per-number Brier scoring ─────────────────────────────────────
// Grades every layer against all 49 numbers in the just-completed batch,
// not just the 4 it was asked to predict. `layerScoreVectors` is
// { layer: { num: 0-100 score } } captured at prediction time for the
// batch being evaluated; `evaluatedNumbers` is the Set of numbers that
// actually hit within the evaluation window.
function scoreBatchBrier(layerScoreVectors, evaluatedNumbers) {
  const batchBrier = {};
  for (const layer of LAYER_NAMES) {
    const vector = layerScoreVectors[layer];
    let sumSq = 0;
    let count = 0;
    for (let n = 1; n <= 49; n++) {
      const prob = Math.max(0, Math.min(100, vector[n] || 0)) / 100;
      const outcome = evaluatedNumbers.has(n) ? 1 : 0;
      const err = prob - outcome;
      sumSq += err * err;
      count++;
    }
    batchBrier[layer] = count > 0 ? sumSq / count : 0.25;
  }
  return batchBrier;
}

// ── Step 2: Pairwise correlation tracking ────────────────────────────────
// Pearson correlation between two layers' 49-number score vectors for the
// batch that just completed.
function pearson(vectorA, vectorB) {
  const xs = [];
  const ys = [];
  for (let n = 1; n <= 49; n++) {
    xs.push(vectorA[n] || 0);
    ys.push(vectorB[n] || 0);
  }
  const len = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / len;
  const meanY = ys.reduce((a, b) => a + b, 0) / len;

  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < len; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  if (varX === 0 || varY === 0) return 0; // a constant vector has no defined correlation; treat as independent
  return cov / Math.sqrt(varX * varY);
}

function scoreBatchCorrelations(layerScoreVectors) {
  const batchCorr = {};
  for (const [a, b] of allPairs()) {
    batchCorr[pairKey(a, b)] = pearson(layerScoreVectors[a], layerScoreVectors[b]);
  }
  return batchCorr;
}

// ── v20 #4: Consensus-conditioned Brier ──────────────────────────────────
// "Agreement" for a given number = how many of the 7 layers independently
// scored it >= CONSENSUS_VOTE_THRESHOLD. A batch is "high consensus" if
// ANY number reached CONSENSUS_AGREEMENT_MIN-or-more layers agreeing on it
// (mirrors how a real prediction gets made: the top picks are exactly the
// numbers with the broadest layer support). This is deliberately the same
// vote-counting convention numberEngine.js already uses in
// updateLayerPerformance, so "consensus" here means the same thing a human
// reading the dashboard would already expect it to mean.
function maxAgreementCount(layerScoreVectors) {
  let maxAgreement = 0;
  for (let n = 1; n <= 49; n++) {
    let agree = 0;
    for (const layer of LAYER_NAMES) {
      const v = layerScoreVectors[layer] ? layerScoreVectors[layer][n] : 0;
      if ((v || 0) >= CONSENSUS_VOTE_THRESHOLD) agree++;
    }
    if (agree > maxAgreement) maxAgreement = agree;
  }
  return maxAgreement;
}

// Builds the same weighted composite score (Σ weight × layerScore) the
// live prediction pipeline uses, over all 49 numbers, so consensus Brier
// grades the thing actually shown to the operator — not a hypothetical
// unweighted average.
function buildCompositeVector(layerScoreVectors, weights) {
  const composite = {};
  for (let n = 1; n <= 49; n++) {
    let sum = 0;
    for (const layer of LAYER_NAMES) {
      const v = layerScoreVectors[layer] ? (layerScoreVectors[layer][n] || 0) : 0;
      sum += v * (weights[layer] != null ? weights[layer] : 0);
    }
    composite[n] = sum;
  }
  return composite;
}

function brierOfVector(vector, evaluatedNumbers) {
  let sumSq = 0;
  for (let n = 1; n <= 49; n++) {
    const prob = Math.max(0, Math.min(100, vector[n] || 0)) / 100;
    const outcome = evaluatedNumbers.has(n) ? 1 : 0;
    const err = prob - outcome;
    sumSq += err * err;
  }
  return sumSq / 49;
}

// Grades the composite prediction's Brier score for this batch, tags it
// high/low consensus based on peak layer agreement, and returns enough
// detail for both the state-update step and diagnostics to use.
function scoreConsensusBrier(layerScoreVectors, evaluatedNumbers, weights) {
  const agreementCount = maxAgreementCount(layerScoreVectors);
  const isHighConsensus = agreementCount >= CONSENSUS_AGREEMENT_MIN;
  const composite = buildCompositeVector(layerScoreVectors, weights);
  const compositeBrier = brierOfVector(composite, evaluatedNumbers);
  return { isHighConsensus, agreementCount, compositeBrier };
}

// ── State update (called once per completed batch) ───────────────────────
function updateCameState(state, layerScoreVectors, evaluatedNumbers, batchId) {
  if (!state) state = createInitialState();
  if (!state.layerBrier) state.layerBrier = createInitialState().layerBrier;
  if (!state.correlations) state.correlations = {};
  if (!state.redundancyWarnings) state.redundancyWarnings = [];
  // v20 #4 migration: older save files won't have consensus state yet.
  // Same surgical-edit convention as the v18/v19 migrations in
  // numberEngine.js's loadTracker() — add what's missing, touch nothing
  // else already present.
  if (!state.consensus) state.consensus = createInitialState().consensus;

  // v20 #4: grade the composite prediction's consensus Brier using the
  // weights that were ACTUALLY in effect when this batch's prediction was
  // made (i.e. state as of right now, before this batch's Brier/
  // correlation updates below move it) — computeWeights is pure/read-only
  // over state, so calling it here doesn't disturb anything.
  const weightsAtPredictionTime = computeWeights(state).weights;
  const consensusInfo = scoreConsensusBrier(layerScoreVectors, evaluatedNumbers, weightsAtPredictionTime);
  const bucket = consensusInfo.isHighConsensus ? 'highConsensus' : 'lowConsensus';
  const cRec = state.consensus[bucket];
  const cn = cRec.batchesScored;
  const cWeight = cn === 0 ? 1 : Math.max(RECENCY_WEIGHT_FLOOR, 1 / (cn + 1));
  cRec.runningBrier = (cRec.runningBrier * (1 - cWeight)) + (consensusInfo.compositeBrier * cWeight);
  cRec.batchesScored = cn + 1;
  state.consensus[bucket] = cRec;
  state.lastConsensusInfo = consensusInfo;

  // Step 1: Brier
  const batchBrier = scoreBatchBrier(layerScoreVectors, evaluatedNumbers);
  for (const layer of LAYER_NAMES) {
    const rec = state.layerBrier[layer] || { runningBrier: 0.25, batchesScored: 0 };
    // v20 #1: same blend-with-prior approach as before (fast-moving while
    // young), but the blend weight is now floored at RECENCY_WEIGHT_FLOOR
    // instead of decaying toward zero forever. Pre-v20, batch 200's weight
    // was 1/201 (~0.5%) — a real accuracy shift after that point would take
    // an enormous number of batches to show up in runningBrier. Flooring
    // the weight caps how "stale" the running average can become, so CAME
    // stays responsive to regime change (a layer that degrades once the
    // draw pattern shifts) at any sample size, not just early on.
    const n = rec.batchesScored;
    const weight = n === 0 ? 1 : Math.max(RECENCY_WEIGHT_FLOOR, 1 / (n + 1));
    rec.runningBrier = (rec.runningBrier * (1 - weight)) + (batchBrier[layer] * weight);
    rec.batchesScored = n + 1;
    state.layerBrier[layer] = rec;
  }

  // Step 2: correlations
  const batchCorr = scoreBatchCorrelations(layerScoreVectors);
  for (const [a, b] of allPairs()) {
    const key = pairKey(a, b);
    const prior = state.correlations[key] || { value: 0, streakAboveThreshold: 0 };
    const blended = (prior.value * (1 - CORRELATION_BLEND_RATE)) + (batchCorr[key] * CORRELATION_BLEND_RATE);
    const streak = blended >= REDUNDANCY_THRESHOLD ? (prior.streakAboveThreshold + 1) : 0;
    state.correlations[key] = { value: Math.round(blended * 1000) / 1000, streakAboveThreshold: streak };
  }

  // Step 5: redundancy warnings — surfaced as diagnostics, not silently
  // auto-merged. Human reviews and decides, same principle as SCIE Step 9.
  for (const [a, b] of allPairs()) {
    const key = pairKey(a, b);
    const corr = state.correlations[key];
    if (corr.streakAboveThreshold >= REDUNDANCY_STREAK_MIN) {
      const already = state.redundancyWarnings.find(w => w.layers.includes(a) && w.layers.includes(b));
      if (!already) {
        state.redundancyWarnings.unshift({
          layers: [a, b],
          correlation: corr.value,
          batchesObserved: corr.streakAboveThreshold,
          suggestion: buildRedundancySuggestion(a, b),
          firstSeenBatchId: batchId
        });
        state.redundancyWarnings = state.redundancyWarnings.slice(0, 10);
      } else {
        already.correlation = corr.value;
        already.batchesObserved = corr.streakAboveThreshold;
      }
    }
  }

  // v19: stash this batch's raw per-layer Brier scores (before blending
  // into the running average above) so the Enhanced Engine Health Monitor
  // can compute a reliability TREND per layer, not just the current
  // running average. Purely additive — does not change what
  // updateCameState returns or how calibration/weighting works.
  state.lastBatchBrier = batchBrier;

  return state;
}

function buildRedundancySuggestion(a, b) {
  const known = {
    'markov|momentum': 'Momentum is 40% Markov-derived by construction. Consider re-deriving Momentum from a Markov-independent signal (e.g. pure EMA slope) to restore its diagnostic value.',
    'markov|scie': "SCIE's pairScore diagnostic blends SCIE with Markov directly. Consider decoupling that diagnostic from SCIE's own composite input."
  };
  const key = pairKey(a, b);
  return known[key] || `${a} and ${b} are moving together this closely — consider auditing whether one can be re-derived from a more independent signal.`;
}

// v20 #3 — sample-size shrinkage. Blends a layer's runningBrier toward the
// neutral 0.25 prior proportional to how few batches it's actually been
// graded on, capped once it reaches SHRINKAGE_FULL_TRUST_BATCHES. This is
// the Brier figure used for RANKING and WEIGHTING only — the raw,
// unshrunk runningBrier is still what getDiagnostics() reports for display,
// so the dashboard's "batchBrier" column keeps showing the layer's real
// track record, not a shrunk stand-in.
//
// Rationale: pre-v20, a layer with e.g. 2 batches scored and a lucky 0.05
// Brier would immediately outrank a layer with 150 batches at a genuinely
// solid 0.15 — inv-Brier weighting has no notion of "how much do we trust
// this number yet." Shrinkage means a brand-new layer starts close to
// neutral (same standing as everyone else) and only earns its ranking
// position as its sample size grows — exactly the caution the v19 'group'
// migration comment already flagged as a risk but didn't yet solve.
function shrunkBrier(rec) {
  const trust = Math.min(1, rec.batchesScored / SHRINKAGE_FULL_TRUST_BATCHES);
  return (rec.runningBrier * trust) + (0.25 * (1 - trust));
}

// ── Step 3 & 4: correlation discount + combined weight formula ──────────
// discount(layer) = 1 - (0.5 * maxCorrelationWithHigherWeightedLayers(layer))
// rawWeight(layer) = (1 / (shrunkBrier(layer) + epsilon)) * discount(layer)
// then normalize across all 7 layers to sum to 1.0, preserving the existing
// composite-score formula shape (Σ weight × layerScore).
function computeWeights(state) {
  // First pass: provisional ranking by inverse-shrunk-Brier, to determine
  // "higher-weighted" for the discount step. This mirrors the spec's
  // two-stage description (accuracy first establishes rank, then
  // correlation-with-higher-ranked layers discounts) — v20 #3 only changes
  // which Brier figure establishes that rank, not the two-stage shape.
  const invBrier = {};
  for (const layer of LAYER_NAMES) {
    const brier = shrunkBrier(state.layerBrier[layer]);
    invBrier[layer] = 1 / (brier + EPSILON);
  }
  const rankedByAccuracy = LAYER_NAMES.slice().sort((a, b) => invBrier[b] - invBrier[a]);

  const discounts = {};
  for (const layer of LAYER_NAMES) {
    const myRank = rankedByAccuracy.indexOf(layer);
    const higherWeighted = rankedByAccuracy.slice(0, myRank); // layers more accurate than this one
    if (higherWeighted.length === 0) {
      discounts[layer] = 1; // top-ranked layer is never discounted against itself
      continue;
    }
    // v20 #2: discount driven by the SINGLE strongest correlation with a
    // higher-ranked layer, not the average across all of them. Averaging
    // let one serious redundancy (e.g. correlation 0.95 with the #1 layer)
    // get diluted by several weak/unrelated correlations with other
    // higher-ranked layers, understating real double-counting risk. The
    // max is the actual exposure: if this layer is nearly a copy of ANY
    // higher-ranked layer, its marginal contribution is that overlap,
    // regardless of how independent it happens to be from the others.
    let maxCorr = 0;
    for (const other of higherWeighted) {
      const key = pairKey(layer, other);
      const v = state.correlations[key] ? Math.max(0, state.correlations[key].value) : 0;
      if (v > maxCorr) maxCorr = v;
    }
    discounts[layer] = Math.max(0, 1 - (DISCOUNT_MULTIPLIER * maxCorr));
  }

  const rawWeights = {};
  let sum = 0;
  for (const layer of LAYER_NAMES) {
    const w = Math.max(MIN_WEIGHT, invBrier[layer] * discounts[layer]);
    rawWeights[layer] = w;
    sum += w;
  }

  const weights = {};
  for (const layer of LAYER_NAMES) {
    weights[layer] = Math.round((rawWeights[layer] / sum) * 1000) / 1000;
  }

  return { weights, discounts };
}

// Sum of (1 - avg pairwise correlation) across layers, normalized to
// 0-LAYER_NAMES.length (was hardcoded to a 6-layer scale pre-v19; now
// derived from LAYER_NAMES.length so adding the 'group' layer doesn't
// silently break this scale).
function computeEffectiveIndependence(state) {
  let total = 0;
  for (const layer of LAYER_NAMES) {
    const others = LAYER_NAMES.filter(l => l !== layer);
    let corrSum = 0;
    for (const other of others) {
      const key = pairKey(layer, other);
      corrSum += state.correlations[key] ? Math.max(0, state.correlations[key].value) : 0;
    }
    const avgCorr = corrSum / others.length;
    total += (1 - avgCorr);
  }
  return Math.round(total * 10) / 10; // 0 to LAYER_NAMES.length
}

// ── v20 #4 (continued) — wiring consensusEdge into actual scoring ────────
// getDiagnostics().consensusCalibration.consensusEdge was, until now,
// diagnostic-only: computed and returned, but nothing ever read it back
// into overallConfidence. That means a system where agreement has
// genuinely NOT been predictive (consensusEdge meaningfully negative)
// still got full confidence whenever layers happened to agree — the exact
// blind spot the v20 #4 changelog entry above describes CAME needing to
// close. applyConsensusCalibration is the read side of that: given the
// state (for the learned edge) and this live batch's layerScoreVectors
// (to classify whether THIS prediction is itself high- or low-consensus),
// it returns a tempered confidence plus the reasoning behind any change.
//
// Deliberately asymmetric — only ever discounts, never boosts:
//   - A negative edge (high-consensus batches have historically been LESS
//     accurate here) is new, corrective information the raw confidence
//     doesn't otherwise reflect, so it's applied as a temper.
//   - A positive edge (agreement really has been reliable) is NOT applied
//     as a bonus, because that reliability is already earned organically:
//     layers that agree AND are individually accurate already carry more
//     weight in the composite through their own Brier-based weighting.
//     Adding a second boost on top would double-count the same signal
//     bumping computeWeights already applied.
// Requires MIN_CONSENSUS_SAMPLE_FOR_TEMPER batches in the relevant bucket
// before tempering activates, matching getDiagnostics()'s own
// `bothSampled` bar for surfacing consensusEdge at all — an untempered,
// thin-sample edge is noise, not signal.
const MIN_CONSENSUS_SAMPLE_FOR_TEMPER = 3;
// A meaningfully negative edge, not just floating-point noise around 0 —
// matches the >0.01 threshold getDiagnostics() already uses to decide
// whether to report an edge as meaningful in its `interpretation` text.
const CONSENSUS_EDGE_MEANINGFUL = 0.01;
// Brier-points-to-confidence-points conversion, capped so one bad-history
// bucket can't swing confidence more than this many points in one batch —
// this is a temper, not a veto; the caller's other signals still matter.
const CONSENSUS_TEMPER_SCALE = 200; // 0.05 Brier edge -> 10-point temper
const MAX_CONSENSUS_TEMPER = 15;

function applyConsensusCalibration(state, layerScoreVectors, rawConfidence) {
  const s = state || createInitialState();
  const consensus = s.consensus || createInitialState().consensus;
  const agreementCount = maxAgreementCount(layerScoreVectors || {});
  const isHighConsensus = agreementCount >= CONSENSUS_AGREEMENT_MIN;
  const bucket = isHighConsensus ? consensus.highConsensus : consensus.lowConsensus;
  const otherBucket = isHighConsensus ? consensus.lowConsensus : consensus.highConsensus;

  const bothSampled = bucket.batchesScored >= MIN_CONSENSUS_SAMPLE_FOR_TEMPER
    && otherBucket.batchesScored >= MIN_CONSENSUS_SAMPLE_FOR_TEMPER;

  if (!bothSampled) {
    return {
      calibratedConfidence: rawConfidence,
      applied: false,
      isHighConsensus,
      agreementCount,
      reason: 'Insufficient consensus sample to calibrate yet.'
    };
  }

  // Positive = this bucket (the one THIS prediction falls in) has
  // historically been more accurate than the other bucket. Negative =
  // this bucket has been less accurate — i.e. being in this consensus
  // state is itself evidence to trust the prediction LESS than its raw
  // score suggests.
  const edgeForThisBucket = otherBucket.runningBrier - bucket.runningBrier;

  if (edgeForThisBucket >= -CONSENSUS_EDGE_MEANINGFUL) {
    // Zero, or a positive edge (this bucket has been reliable) — no
    // discount applied, per the asymmetric design above.
    return {
      calibratedConfidence: rawConfidence,
      applied: false,
      isHighConsensus,
      agreementCount,
      reason: edgeForThisBucket > CONSENSUS_EDGE_MEANINGFUL
        ? `${isHighConsensus ? 'High' : 'Low'}-consensus batches have been reliable here — no temper applied.`
        : 'No meaningful consensus edge observed yet.'
    };
  }

  const temperPoints = Math.min(
    MAX_CONSENSUS_TEMPER,
    Math.round(Math.abs(edgeForThisBucket) * CONSENSUS_TEMPER_SCALE)
  );
  const calibratedConfidence = Math.max(0, rawConfidence - temperPoints);

  return {
    calibratedConfidence,
    applied: temperPoints > 0,
    isHighConsensus,
    agreementCount,
    temperPoints,
    reason: temperPoints > 0
      ? `${isHighConsensus ? 'High' : 'Low'}-consensus batches have NOT been reliable for this system (edge ${Math.round(edgeForThisBucket * 1000) / 1000}) — confidence tempered by ${temperPoints} point(s).`
      : 'Consensus edge negative but below the point where it changes rounded confidence.'
  };
}

function getDiagnostics(state, weights, discounts) {
  const layerCalibration = LAYER_NAMES.map(layer => {
    const rec = state.layerBrier[layer];
    return {
      layer,
      // Unshrunk, real running Brier — still what the dashboard shows as
      // the layer's track record. v20 #3's shrinkage only affects ranking/
      // weighting internally (see shrunkBrier), never this display figure.
      batchBrier: Math.round(rec.runningBrier * 1000) / 1000,
      weight: weights[layer],
      discount: Math.round((discounts[layer] != null ? discounts[layer] : 1) * 1000) / 1000,
      sampleSize: rec.batchesScored,
      // v20 #3: how much of this layer's weighting is still shrunk toward
      // the neutral prior vs. earned from its own track record (0 = fully
      // neutral/untrusted, 1 = fully trusted on its own Brier history).
      sampleTrust: Math.round(Math.min(1, rec.batchesScored / SHRINKAGE_FULL_TRUST_BATCHES) * 100) / 100
    };
  }).sort((a, b) => b.weight - a.weight);

  const correlationMatrix = {};
  for (const [a, b] of allPairs()) {
    correlationMatrix[pairKey(a, b)] = state.correlations[pairKey(a, b)]
      ? state.correlations[pairKey(a, b)].value
      : 0;
  }

  // v20 #4: consensus-conditioned calibration — is the composite
  // prediction actually more reliable when layers agree? This is the
  // learned signal, not just a raw agreement count.
  const consensusState = state.consensus || createInitialState().consensus;
  const highC = consensusState.highConsensus;
  const lowC = consensusState.lowConsensus;
  const bothSampled = highC.batchesScored >= 3 && lowC.batchesScored >= 3;
  const consensusCalibration = {
    highConsensus: {
      brier: Math.round(highC.runningBrier * 1000) / 1000,
      sampleSize: highC.batchesScored
    },
    lowConsensus: {
      brier: Math.round(lowC.runningBrier * 1000) / 1000,
      sampleSize: lowC.batchesScored
    },
    // Positive = consensus batches really are more accurate (lower Brier
    // = better), confirming that agreement is meaningful signal here.
    // Negative = agreement has NOT been predictive of accuracy for this
    // system so far, i.e. consensus should not be trusted to boost
    // confidence. null until both buckets have enough sample to compare.
    consensusEdge: bothSampled ? Math.round((lowC.runningBrier - highC.runningBrier) * 1000) / 1000 : null,
    interpretation: !bothSampled
      ? 'Insufficient sample in one or both consensus buckets to compare yet.'
      : (lowC.runningBrier - highC.runningBrier) > 0.01
        ? 'High-consensus batches have been meaningfully more accurate — agreement is a trustworthy confidence signal for this system.'
        : (lowC.runningBrier - highC.runningBrier) < -0.01
          ? 'High-consensus batches have NOT been more accurate than split ones — treat engine agreement with caution here.'
          : 'No meaningful accuracy difference observed between high- and low-consensus batches so far.',
    lastBatch: state.lastConsensusInfo
  };

  return {
    status: 'ACTIVE',
    layerCalibration,
    correlationMatrix,
    redundancyWarnings: state.redundancyWarnings,
    effectiveIndependence: computeEffectiveIndependence(state),
    // v19: exposed so the dashboard never has to hardcode a "/ 6" (now 7
    // with the 'group' layer) — always derives the scale from here.
    maxEffectiveIndependence: LAYER_NAMES.length,
    // v20 #4
    consensusCalibration
  };
}

module.exports = {
  LAYER_NAMES,
  MAX_EFFECTIVE_INDEPENDENCE: LAYER_NAMES.length,
  createInitialState,
  updateCameState,
  computeWeights,
  getDiagnostics,
  computeEffectiveIndependence,
  applyConsensusCalibration
};
