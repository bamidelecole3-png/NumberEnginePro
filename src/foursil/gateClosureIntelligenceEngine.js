/**
 * 4SIL GATE CLOSURE INTELLIGENCE ENGINE (4SIL-GCI) — v1.0
 *
 * CONSTITUTIONAL RULE — immutable:
 *   This engine consumes ONLY the historical 4SIL-NEI.predictions ledger.
 *   It shall not independently inspect draw history, 4SIL gates, Paper
 *   Trader state, season intelligence, colors, or any other engine.
 *   It never modifies 4SIL, NEI, gates, weights, or any color prediction.
 *   It never feeds back into any upstream engine. Output is an observer /
 *   protection layer for the dashboard only.
 *
 * SINGLE QUESTION:
 *   "Is the current 4SIL forecasting environment becoming dangerous,
 *    based only on what the NEI prediction log has historically done
 *    before 4SIL gate closures?"
 *
 * SEPARATION RULE (absolute):
 *   4SIL-GCI output → dashboard only
 *   4SIL-GCI output ✗→ 4SIL, 4SIL-NEI, call history, paper trader,
 *                       parliament, or any engine/gate/weight
 *
 * INPUT CONTRACT:
 *   advanceGCI() accepts the RAW 4SIL-NEI predictions ledger (the full,
 *   in-memory `neiState.predictions` array — newest-first, capped at
 *   MAX_PREDICTION_LOG by NEI itself) and this engine's own persistent
 *   state. Nothing else. Each record is expected to carry the shape NEI
 *   already produces:
 *     { id, openedAt, callDrawId, forecast: { timingState, primary,
 *       range, windowProbability, confidence, timingScore }, status,
 *       actualDrawsToEvent, resolvedDrawId, resolvedAt, resolvedColor,
 *       accurate, closedReason }
 *
 * TEN INTELLIGENCE LAYERS (per blueprint):
 *   1. Event Statistics            6. Latency Degradation
 *   2. Closure Statistics          7. False-Positive Profiles
 *   3. Closure Interval Model      8. Pattern Similarity
 *   4. Pre-Closure Miner           9. Closure Risk Score
 *   5. Range Sequence Miner       10. Warning/Action Engine
 */
'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LATE_EVENT_DRAWS       = 6;   // actualDrawsToEvent > this is "late"
const SIX_DRAW_CAPTURE_LIMIT = 6;   // 1-6 capture window
const FINGERPRINT_TAIL_SIZE  = 8;   // records examined immediately before a closure
const RANGE_BUFFER_MAX       = 500; // rolling range-label buffer for trigram/family mining
const TRIGRAM_MIN_SAMPLE     = 5;   // minimum occurrences before a trigram/family association is trusted
const RECENT_EPISODES_WINDOW = 5;   // "recent" episodes considered for weighted avg / recurrence risk
const MAX_STORED_EPISODES    = 200; // cap on closureEpisodes history retained

// Audit fix (§4/§19/§20): three closed episodes is not a reliable historical
// closure zone -- "three observations wearing a fancy suit." The model is
// only trusted once at least this many episodes exist; below it the engine
// reports LEARNING and the risk score stays at 0 rather than a confident
// number built on almost nothing.
const MIN_EPISODES_FOR_MODEL = 5;

// Audit fix (§4): sample-confidence tiers so every model-derived figure can
// be labeled with how much history actually backs it, instead of presenting
// a 3-sample estimate with the same confidence as a 50-sample one.
const CONFIDENCE_TIER_PRELIMINARY_MIN  = 5;
const CONFIDENCE_TIER_ESTABLISHED_MIN  = 10;
const CONFIDENCE_TIER_HIGH_MIN         = 20;

// Audit fix (§8): a false-positive classification on 1-2 events proves
// nothing. Require a minimum event sample before calling an episode a
// false positive at all.
const FALSE_POSITIVE_MIN_EVENT_SAMPLE = 5;

// Component weights for the Closure Risk Score (must sum to 100)
const W_POSITIONAL    = 25;
const W_PATTERN       = 25;
const W_LATENCY_DETER = 20;
const W_RANGE_DETER   = 15;
const W_RECURRENCE    = 15;

// Risk score → engine state thresholds
const RISK_NORMAL_MAX      = 24;
const RISK_WATCH_MAX       = 49;
const RISK_APPROACHING_MAX = 69;
const RISK_HIGH_RISK_MAX   = 84;
// 85-100 => AVOID

const FALSE_POSITIVE_ACCURACY_CEILING = 0.5; // events with accurate-rate below this => FALSE_POSITIVE episode

// Audit fix (§4): sample-confidence tier for a given count of closed
// episodes. Exposed on the summary so the dashboard/operator can see how
// much the model should actually be trusted right now.
function modelConfidenceTier(episodeCount) {
  if (episodeCount >= CONFIDENCE_TIER_HIGH_MIN) return 'HIGH_CONFIDENCE';
  if (episodeCount >= CONFIDENCE_TIER_ESTABLISHED_MIN) return 'ESTABLISHED';
  if (episodeCount >= CONFIDENCE_TIER_PRELIMINARY_MIN) return 'PRELIMINARY';
  return 'LEARNING';
}

// ---------------------------------------------------------------------------
// State factory
// ---------------------------------------------------------------------------

function freshGCIState() {
  return {
    schemaVersion: 1,
    lastProcessedPredictionId: 0,
    currentEpisode: {
      startedAt: null,
      predictions: [] // condensed, chronological oldest-first
    },
    closureEpisodes: [],   // most-recent-first
    statistics: {
      totalForecasts: 0,
      totalEvents: 0,
      accurateEvents: 0,
      lateEvents: 0,
      sixDrawCaptureCount: 0,
      gateClosures: 0
    },
    rangeHistoryBuffer: [],       // rolling, chronological, capped RANGE_BUFFER_MAX
    trigrams: {},                 // { "1-4>1-5>1-6": { totalOccurrences, precedesClosureCount } }
    // Audit fix (§10): range-family bank. Keyed on the SHAPE of consecutive
    // range movement (lowBoundDelta,highBoundDelta), e.g. "0,+1" for
    // 1-4 -> 1-5 (low bound held, high bound walked +1) -- independent of
    // the literal numeric labels, so 1-4>1-5 and 2-5>2-6 count as the same
    // family instead of two unrelated trigram strings.
    rangeFamilies: {},            // { "0,+1": { totalOccurrences, precedesClosureCount } }
    updatedAt: null
  };
}

function ensureGCIStateShape(s) {
  if (!s || typeof s !== 'object') return freshGCIState();
  if (!s.schemaVersion) s.schemaVersion = 1;
  if (typeof s.lastProcessedPredictionId !== 'number') s.lastProcessedPredictionId = 0;
  if (!s.currentEpisode || typeof s.currentEpisode !== 'object') {
    s.currentEpisode = { startedAt: null, predictions: [] };
  }
  if (!Array.isArray(s.currentEpisode.predictions)) s.currentEpisode.predictions = [];
  if (!Array.isArray(s.closureEpisodes)) s.closureEpisodes = [];
  if (!s.statistics || typeof s.statistics !== 'object') {
    s.statistics = { totalForecasts: 0, totalEvents: 0, accurateEvents: 0, lateEvents: 0, sixDrawCaptureCount: 0, gateClosures: 0 };
  }
  for (const k of ['totalForecasts', 'totalEvents', 'accurateEvents', 'lateEvents', 'sixDrawCaptureCount', 'gateClosures']) {
    if (typeof s.statistics[k] !== 'number') s.statistics[k] = 0;
  }
  if (!Array.isArray(s.rangeHistoryBuffer)) s.rangeHistoryBuffer = [];
  if (!s.trigrams || typeof s.trigrams !== 'object') s.trigrams = {};
  if (!s.rangeFamilies || typeof s.rangeFamilies !== 'object') s.rangeFamilies = {};
  if (typeof s.updatedAt === 'undefined') s.updatedAt = null;
  return s;
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function round2(n) { return Math.round(n * 100) / 100; }

function rangeLabelOf(pred) {
  const r = pred && pred.forecast && pred.forecast.range;
  return Array.isArray(r) && r.length === 2 ? `${r[0]}-${r[1]}` : null;
}

function widthOf(pred) {
  const r = pred && pred.forecast && pred.forecast.range;
  return Array.isArray(r) && r.length === 2 ? (r[1] - r[0]) : null;
}

function sorted(arr) { return arr.slice().sort((a, b) => a - b); }

function percentileValue(sortedArr, p) {
  if (!sortedArr.length) return null;
  if (sortedArr.length === 1) return sortedArr[0];
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

function median(arr) {
  if (!arr.length) return null;
  return percentileValue(sorted(arr), 50);
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

// Percentile RANK of `value` within sortedArr: what fraction of the
// historical distribution falls at or below `value` (0-100).
function percentileRank(value, sortedArr) {
  if (!sortedArr.length) return null;
  let countBelowOrEqual = 0;
  for (const v of sortedArr) if (v <= value) countBelowOrEqual++;
  return Math.round((countBelowOrEqual / sortedArr.length) * 100);
}

// Simple first-half vs second-half deterioration ratio. Returns null if
// insufficient data (need >= 4 points to split meaningfully).
function halfSplitRatio(arr) {
  if (!Array.isArray(arr) || arr.length < 4) return null;
  const mid = Math.floor(arr.length / 2);
  const firstHalf = arr.slice(0, mid);
  const secondHalf = arr.slice(mid);
  const m1 = mean(firstHalf);
  const m2 = mean(secondHalf);
  if (!m1) return null;
  return m2 / m1;
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// Audit fix (§9): latency deterioration compressed to a single
// secondHalf/firstHalf ratio loses the SHAPE of the deterioration (a slow
// creep and a single late spike both collapse to a similar ratio). Simple
// least-squares slope over the sequence index captures trend direction
// independent of that. Positive slope = latency increasing over time.
function linearSlope(arr) {
  const n = arr.length;
  if (n < 2) return null;
  const mx = (n - 1) / 2;
  const my = mean(arr);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (arr[i] - my);
    den += (i - mx) * (i - mx);
  }
  return den === 0 ? 0 : num / den;
}

// Audit fix (§10): shape delta between two consecutive range labels,
// independent of their literal numeric position -- "0,+1" describes
// 1-4->1-5 AND 2-5->2-6 identically, which is what lets the engine
// recognize a recurring range-family signature rather than treating every
// numeric label combination as unrelated.
function rangeShapeDelta(prevLabel, curLabel) {
  if (!prevLabel || !curLabel) return null;
  const prevParts = prevLabel.split('-').map(Number);
  const curParts = curLabel.split('-').map(Number);
  if (prevParts.length !== 2 || curParts.length !== 2) return null;
  const [pl, ph] = prevParts;
  const [cl, ch] = curParts;
  if ([pl, ph, cl, ch].some(n => Number.isNaN(n))) return null;
  return { lowDelta: cl - pl, highDelta: ch - ph };
}

function shapeKey(delta) {
  const fmt = (n) => (n > 0 ? `+${n}` : `${n}`);
  return `${fmt(delta.lowDelta)},${fmt(delta.highDelta)}`;
}

// ---------------------------------------------------------------------------
// LAYER 5 helper — Range Sequence Miner (rolling trigram + family banks)
// ---------------------------------------------------------------------------

function pushRangeToBuffer(state, rangeLabel) {
  if (!rangeLabel) return;
  const prevLabel = state.rangeHistoryBuffer.length
    ? state.rangeHistoryBuffer[state.rangeHistoryBuffer.length - 1]
    : null;

  state.rangeHistoryBuffer.push(rangeLabel);
  if (state.rangeHistoryBuffer.length > RANGE_BUFFER_MAX) {
    state.rangeHistoryBuffer.shift();
  }
  if (state.rangeHistoryBuffer.length >= 3) {
    const n = state.rangeHistoryBuffer.length;
    const trigram = state.rangeHistoryBuffer.slice(n - 3, n).join('>');
    if (!state.trigrams[trigram]) state.trigrams[trigram] = { totalOccurrences: 0, precedesClosureCount: 0 };
    state.trigrams[trigram].totalOccurrences++;
  }

  // Range-family shape bank (§10) — tracked alongside, keyed on movement
  // shape rather than literal labels.
  const delta = rangeShapeDelta(prevLabel, rangeLabel);
  if (delta) {
    const key = shapeKey(delta);
    if (!state.rangeFamilies[key]) state.rangeFamilies[key] = { totalOccurrences: 0, precedesClosureCount: 0 };
    state.rangeFamilies[key].totalOccurrences++;
  }
}

function markTrailingTrigramAsPreClosure(state) {
  const n = state.rangeHistoryBuffer.length;
  if (n < 3) return;
  const trigram = state.rangeHistoryBuffer.slice(n - 3, n).join('>');
  if (state.trigrams[trigram]) state.trigrams[trigram].precedesClosureCount++;
}

function markTrailingFamilyAsPreClosure(state) {
  const n = state.rangeHistoryBuffer.length;
  if (n < 2) return;
  const delta = rangeShapeDelta(state.rangeHistoryBuffer[n - 2], state.rangeHistoryBuffer[n - 1]);
  if (!delta) return;
  const key = shapeKey(delta);
  if (state.rangeFamilies[key]) state.rangeFamilies[key].precedesClosureCount++;
}

// Current trailing range TRIGRAM association, i.e. "the last three observed
// range labels form THIS exact sequence -- historically, how often has that
// specific sequence preceded a closure?" This is what actually answers "is
// this pattern predictive," as distinct from tailSimilarity's structural
// resemblance score (see §6/§7 of the audit).
function currentTrigramAssociation(state) {
  const n = state.rangeHistoryBuffer.length;
  if (n < 3) return { pct: 0, sampleSize: 0, insufficientSample: true, trigram: null };
  const trigram = state.rangeHistoryBuffer.slice(n - 3, n).join('>');
  const stats = state.trigrams[trigram];
  if (!stats) return { pct: 0, sampleSize: 0, insufficientSample: true, trigram };
  const sample = stats.totalOccurrences;
  return {
    pct: Math.round((stats.precedesClosureCount / sample) * 100),
    sampleSize: sample,
    insufficientSample: sample < TRIGRAM_MIN_SAMPLE,
    trigram
  };
}

// Current trailing range-family association, i.e. "the last observed range
// movement looked like THIS shape -- historically, how often has that
// specific shape preceded a closure?" Distinct from generic width widening.
function currentFamilyAssociation(state) {
  const n = state.rangeHistoryBuffer.length;
  if (n < 2) return { pct: 0, sampleSize: 0, insufficientSample: true, shape: null };
  const delta = rangeShapeDelta(state.rangeHistoryBuffer[n - 2], state.rangeHistoryBuffer[n - 1]);
  if (!delta) return { pct: 0, sampleSize: 0, insufficientSample: true, shape: null };
  const key = shapeKey(delta);
  const stats = state.rangeFamilies[key];
  if (!stats) return { pct: 0, sampleSize: 0, insufficientSample: true, shape: key };
  const sample = stats.totalOccurrences;
  return {
    pct: Math.round((stats.precedesClosureCount / sample) * 100),
    sampleSize: sample,
    insufficientSample: sample < TRIGRAM_MIN_SAMPLE,
    shape: key
  };
}

// ---------------------------------------------------------------------------
// LAYER 4 helper — episode finalization on closure
// ---------------------------------------------------------------------------

function finalizeEpisode(state, closedAt, closedReason) {
  const preds = state.currentEpisode.predictions; // chronological oldest-first
  const length = preds.length;

  const hitPreds = preds.filter(p => p.status === 'HIT');
  const events = hitPreds.length;
  const accurateEvents = hitPreds.filter(p => p.accurate === true).length;
  const lateEvents = hitPreds.filter(p => p.actualDrawsToEvent != null && p.actualDrawsToEvent > LATE_EVENT_DRAWS).length;
  const sixDrawCaptureCount = hitPreds.filter(p => p.actualDrawsToEvent != null && p.actualDrawsToEvent <= SIX_DRAW_CAPTURE_LIMIT).length;

  // Audit fix (§8): a false-positive call on 1-2 events proves nothing --
  // "2 events, 0 accurate" and "10 events, 4 accurate" were both being
  // labeled FALSE_POSITIVE with equal confidence. Episodes with too few
  // events to judge are now labeled LOW_SAMPLE instead, and are excluded
  // from the false-positive profile (buildFalsePositiveProfile below).
  let classification;
  if (events === 0) classification = 'NO_EVENT_EPISODE';
  else if (events < FALSE_POSITIVE_MIN_EVENT_SAMPLE) classification = 'LOW_SAMPLE';
  else if ((accurateEvents / events) < FALSE_POSITIVE_ACCURACY_CEILING) classification = 'FALSE_POSITIVE';
  else classification = 'NORMAL';

  const rangeSequence = preds.map(rangeLabelOf).filter(Boolean);
  const timingStateSequence = preds.map(p => p.forecast && p.forecast.timingState).filter(Boolean);
  const latencySequence = hitPreds.map(p => p.actualDrawsToEvent).filter(v => v != null);
  const latencyRatio = halfSplitRatio(latencySequence);
  const latencyTrend = latencyRatio == null ? null : (latencyRatio > 1.1 ? 'RISING' : latencyRatio < 0.9 ? 'FALLING' : 'FLAT');

  const tail = preds.slice(Math.max(0, length - FINGERPRINT_TAIL_SIZE));
  const fingerprint = {
    tailLength: tail.length,
    tailRanges: tail.map(rangeLabelOf),
    tailTimingStates: tail.map(p => p.forecast && p.forecast.timingState),
    tailLatencies: tail.map(p => p.actualDrawsToEvent),
    tailAccurate: tail.map(p => p.accurate),
    tailConfidences: tail.map(p => p.forecast && p.forecast.confidence)
  };

  const episode = {
    episodeId: (state.closureEpisodes.length > 0 ? state.closureEpisodes[0].episodeId + 1 : 1),
    startedAt: state.currentEpisode.startedAt,
    closedAt,
    closedReason: closedReason || null,
    length,
    events,
    accurateEvents,
    lateEvents,
    sixDrawCaptureCount,
    classification,
    rangeSequence,
    timingStateSequence,
    latencySequence,
    latencyTrend,
    fingerprint
  };

  state.closureEpisodes.unshift(episode);
  if (state.closureEpisodes.length > MAX_STORED_EPISODES) state.closureEpisodes.length = MAX_STORED_EPISODES;

  state.statistics.gateClosures++;

  markTrailingTrigramAsPreClosure(state);
  markTrailingFamilyAsPreClosure(state);

  state.currentEpisode = { startedAt: null, predictions: [] };

  return episode;
}

// ---------------------------------------------------------------------------
// Ingestion — process new NEI ledger records since lastProcessedPredictionId
// ---------------------------------------------------------------------------

function ingest(state, neiPredictions) {
  // Tracks whether the record with the HIGHEST id ingested this call was
  // itself a closure — i.e. whether the engine's live state is, right
  // now, freshly transitioned to CLOSED — as distinct from "a closure
  // happened somewhere in this batch" (which is all a closures-count
  // delta can tell you when many records are ingested in one call, e.g.
  // a backfill). Only the former should ever produce engineState CLOSED.
  const result = { justClosedEpisode: null };
  if (!Array.isArray(neiPredictions) || neiPredictions.length === 0) return result;

  // NEI ledger is newest-first; process strictly ascending by id so the
  // episode timeline reconstructs in true chronological order.
  const newOnes = neiPredictions
    .filter(p => typeof p.id === 'number' && p.id > state.lastProcessedPredictionId)
    .sort((a, b) => a.id - b.id);

  for (const pred of newOnes) {
    state.lastProcessedPredictionId = pred.id;
    state.statistics.totalForecasts++;
    result.justClosedEpisode = null; // reset each record; only the LAST record's outcome survives the loop

    if (pred.status === 'CLOSED') {
      result.justClosedEpisode = finalizeEpisode(state, pred.resolvedAt || new Date().toISOString(), pred.closedReason);
      continue;
    }

    if (!state.currentEpisode.startedAt) state.currentEpisode.startedAt = pred.openedAt || new Date().toISOString();

    const condensed = {
      id: pred.id,
      openedAt: pred.openedAt,
      status: pred.status,
      forecast: pred.forecast ? {
        timingState: pred.forecast.timingState,
        range: pred.forecast.range,
        confidence: pred.forecast.confidence
      } : null,
      actualDrawsToEvent: pred.actualDrawsToEvent,
      accurate: pred.accurate
    };
    state.currentEpisode.predictions.push(condensed);

    if (pred.status === 'HIT') {
      state.statistics.totalEvents++;
      if (pred.accurate === true) state.statistics.accurateEvents++;
      if (pred.actualDrawsToEvent != null && pred.actualDrawsToEvent > LATE_EVENT_DRAWS) state.statistics.lateEvents++;
      if (pred.actualDrawsToEvent != null && pred.actualDrawsToEvent <= SIX_DRAW_CAPTURE_LIMIT) state.statistics.sixDrawCaptureCount++;
    }

    const rl = rangeLabelOf(pred);
    if (rl) pushRangeToBuffer(state, rl);
  }

  return result;
}

// ---------------------------------------------------------------------------
// LAYER 3 — Closure Interval Model
// ---------------------------------------------------------------------------

function buildClosureIntervalModel(state) {
  const lengths = state.closureEpisodes.map(e => e.length);
  const confidenceTier = modelConfidenceTier(lengths.length);
  if (lengths.length < MIN_EPISODES_FOR_MODEL) {
    return { sampleSize: lengths.length, insufficientData: true, confidenceTier, mean: null, median: null, p25: null, p50: null, p75: null, p90: null, min: null, max: null, recentWeightedAvg: null };
  }
  const s = sorted(lengths);
  const recent = state.closureEpisodes.slice(0, RECENT_EPISODES_WINDOW).map(e => e.length);
  return {
    sampleSize: lengths.length,
    insufficientData: false,
    confidenceTier,
    mean: round2(mean(lengths)),
    median: round2(median(lengths)),
    p25: round2(percentileValue(s, 25)),
    p50: round2(percentileValue(s, 50)),
    p75: round2(percentileValue(s, 75)),
    p90: round2(percentileValue(s, 90)),
    min: s[0],
    max: s[s.length - 1],
    recentWeightedAvg: round2(mean(recent))
  };
}

// ---------------------------------------------------------------------------
// LAYER 7 — False-Positive Profiles
// ---------------------------------------------------------------------------

function buildFalsePositiveProfile(state) {
  const fps = state.closureEpisodes.filter(e => e.classification === 'FALSE_POSITIVE');
  if (fps.length === 0) return { sampleSize: 0 };

  const rangeCounts = {};
  const timingCounts = {};
  let confidenceSum = 0, confidenceN = 0;

  for (const ep of fps) {
    for (const r of ep.rangeSequence) rangeCounts[r] = (rangeCounts[r] || 0) + 1;
    for (const t of ep.timingStateSequence) timingCounts[t] = (timingCounts[t] || 0) + 1;
    for (const c of ep.fingerprint.tailConfidences) {
      if (typeof c === 'number') { confidenceSum += c; confidenceN++; }
    }
  }

  const topRanges = Object.entries(rangeCounts).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([range, count]) => ({ range, pct: Math.round((count / fps.reduce((s, e) => s + e.rangeSequence.length, 0)) * 100) }));
  const topTiming = Object.entries(timingCounts).sort((a, b) => b[1] - a[1])[0];

  return {
    sampleSize: fps.length,
    avgForecastsBeforeClosure: round2(mean(fps.map(e => e.length))),
    medianForecastsBeforeClosure: round2(median(fps.map(e => e.length))),
    mostCommonRanges: topRanges,
    mostCommonTimingState: topTiming ? topTiming[0] : null,
    avgConfidence: confidenceN > 0 ? Math.round(confidenceSum / confidenceN) : null,
    avgEventsBeforeClosure: round2(mean(fps.map(e => e.events)))
  };
}

// ---------------------------------------------------------------------------
// LAYER 5 — Range Sequence Intelligence (top associated trigrams)
// ---------------------------------------------------------------------------

function buildRangeSequenceIntelligence(state) {
  const trigramSignatures = Object.entries(state.trigrams)
    .filter(([, v]) => v.totalOccurrences >= TRIGRAM_MIN_SAMPLE)
    .map(([pattern, v]) => ({
      pattern,
      sample: v.totalOccurrences,
      closureAssociationPct: Math.round((v.precedesClosureCount / v.totalOccurrences) * 100)
    }))
    .sort((a, b) => b.closureAssociationPct - a.closureAssociationPct)
    .slice(0, 10);

  // Audit fix (§10): range-FAMILY signatures, e.g. "0,+1" (low bound held,
  // high bound walks +1 each forecast -- the 1-4>1-5>1-6 signature),
  // reported separately from the literal numeric trigrams above so the
  // same underlying behavior is recognized regardless of which specific
  // numbers it occurs at.
  const familySignatures = Object.entries(state.rangeFamilies)
    .filter(([, v]) => v.totalOccurrences >= TRIGRAM_MIN_SAMPLE)
    .map(([shape, v]) => ({
      shape,
      sample: v.totalOccurrences,
      closureAssociationPct: Math.round((v.precedesClosureCount / v.totalOccurrences) * 100)
    }))
    .sort((a, b) => b.closureAssociationPct - a.closureAssociationPct)
    .slice(0, 10);

  return { trigramSignatures, familySignatures };
}

// ---------------------------------------------------------------------------
// LAYER 8 — Pattern Similarity (current tail vs historical pre-closure fingerprints)
// ---------------------------------------------------------------------------

function tailSimilarity(currentTail, fingerprint) {
  const n = Math.min(currentTail.length, fingerprint.tailLength);
  if (n === 0) return 0;
  let matches = 0, comparisons = 0;
  for (let i = 1; i <= n; i++) {
    const cur = currentTail[currentTail.length - i];
    const fpRange = fingerprint.tailRanges[fingerprint.tailRanges.length - i];
    const fpTiming = fingerprint.tailTimingStates[fingerprint.tailTimingStates.length - i];
    comparisons += 2;
    if (rangeLabelOf(cur) === fpRange) matches++;
    if (cur.forecast && cur.forecast.timingState === fpTiming) matches++;
  }
  return comparisons === 0 ? 0 : Math.round((matches / comparisons) * 100);
}

function bestPatternSimilarity(state) {
  if (state.closureEpisodes.length === 0) return { score: 0, matchedEpisodeId: null };
  const currentTail = state.currentEpisode.predictions.slice(-FINGERPRINT_TAIL_SIZE);
  if (currentTail.length === 0) return { score: 0, matchedEpisodeId: null };

  let best = { score: 0, matchedEpisodeId: null };
  for (const ep of state.closureEpisodes) {
    const sim = tailSimilarity(currentTail, ep.fingerprint);
    if (sim > best.score) best = { score: sim, matchedEpisodeId: ep.episodeId };
  }
  return best;
}

// ---------------------------------------------------------------------------
// LAYER 9 — Closure Risk Score (five components)
// ---------------------------------------------------------------------------

// Audit fix (§9): latency deterioration was a single secondHalf/firstHalf
// ratio, which loses the SHAPE of the change -- [2,2,2,8] and [2,3,4,5] both
// "deteriorate" by a similar ratio but represent very different behavior.
// This adds slope (trend direction), a recent median/max, a consecutive
// expansion streak (how many forecasts in a row got slower than the one
// before), and a late-event streak (how many forecasts in a row have
// exceeded the LATE_EVENT_DRAWS baseline) -- then blends all four into one
// score instead of relying on the ratio alone.
function computeLatencyDeterioration(latencies) {
  const sampleSize = latencies.length;
  if (sampleSize < 4) {
    return { score: 0, sampleSize, insufficientSample: true, ratio: null, slope: null, recentMedian: null, recentMax: null, consecutiveExpansionStreak: 0, lateEventStreak: 0 };
  }
  const ratio = halfSplitRatio(latencies);
  const slope = linearSlope(latencies);
  const recentSlice = latencies.slice(-3);
  const recentMedian = median(recentSlice);
  const recentMax = Math.max(...recentSlice);

  let consecutiveExpansionStreak = 0;
  for (let i = latencies.length - 1; i > 0; i--) {
    if (latencies[i] > latencies[i - 1]) consecutiveExpansionStreak++;
    else break;
  }

  let lateEventStreak = 0;
  for (let i = latencies.length - 1; i >= 0; i--) {
    if (latencies[i] > LATE_EVENT_DRAWS) lateEventStreak++;
    else break;
  }

  const ratioScore = ratio == null ? 0 : clamp((ratio - 1) * 100, 0, 100);
  const slopeScore = slope == null ? 0 : clamp(slope * 20, 0, 100);
  const streakScore = clamp(consecutiveExpansionStreak * 15, 0, 100);
  const lateStreakScore = clamp(lateEventStreak * 20, 0, 100);
  const score = Math.round(ratioScore * 0.4 + slopeScore * 0.25 + streakScore * 0.2 + lateStreakScore * 0.15);

  return {
    score: clamp(score, 0, 100),
    sampleSize,
    insufficientSample: false,
    ratio: ratio == null ? null : round2(ratio),
    slope: slope == null ? null : round2(slope),
    recentMedian,
    recentMax,
    consecutiveExpansionStreak,
    lateEventStreak
  };
}

function computeClosureRisk(state) {
  const currentLen = state.currentEpisode.predictions.length;
  const lengths = state.closureEpisodes.map(e => e.length);
  // Audit fix (§4/§8): MIN_EPISODES_FOR_MODEL is now 5, and the final score
  // is gated on it below -- no component, however alarming in isolation,
  // can produce a confident-looking number while the model is still in its
  // LEARNING phase.
  const enoughHistory = lengths.length >= MIN_EPISODES_FOR_MODEL;

  // Component 1 — Positional risk
  let positional = 0;
  if (enoughHistory) positional = percentileRank(currentLen, sorted(lengths));

  // Component 2 — Pattern similarity vs. historical closure association.
  // Audit fix (§6/§7): these are NOT the same quantity. "84% similarity"
  // describes how closely the current tail resembles a past pre-closure
  // fingerprint; it says nothing about how often that resemblance actually
  // preceded closure. The trigram bank already tracks the latter honestly
  // (occurrences vs. precedesClosureCount for the CURRENT trailing range
  // sequence), so the risk score is driven by that association -- with its
  // own sample size -- rather than by raw structural similarity.
  const patternSim = enoughHistory ? bestPatternSimilarity(state) : { score: 0, matchedEpisodeId: null };
  const association = enoughHistory ? currentTrigramAssociation(state) : { pct: 0, sampleSize: 0, insufficientSample: true, trigram: null };
  const patternRiskDriver = association.insufficientSample ? 0 : association.pct;

  // Component 3 — Latency deterioration (see computeLatencyDeterioration above)
  const latencies = state.currentEpisode.predictions
    .filter(p => p.status === 'HIT' && p.actualDrawsToEvent != null)
    .map(p => p.actualDrawsToEvent);
  const latency = computeLatencyDeterioration(latencies);

  // Component 4 — Range deterioration: generic width-widening blended with
  // the range-FAMILY association (§10) so a recognized signature like
  // 1-4>1-5>1-6 carries weight independent of raw width growth.
  const widths = state.currentEpisode.predictions.map(widthOf).filter(w => w != null);
  const widthRatio = halfSplitRatio(widths);
  const widthDeter = widthRatio == null ? 0 : clamp((widthRatio - 1) * 150, 0, 100);
  const family = enoughHistory ? currentFamilyAssociation(state) : { pct: 0, sampleSize: 0, insufficientSample: true, shape: null };
  const rangeDeter = family.insufficientSample ? widthDeter : Math.round(widthDeter * 0.5 + family.pct * 0.5);

  // Component 5 — Closure recurrence (closures clustering closer together than usual)
  let recurrence = 0;
  if (enoughHistory) {
    const overallMean = mean(lengths);
    const recentMean = mean(state.closureEpisodes.slice(0, RECENT_EPISODES_WINDOW).map(e => e.length));
    if (overallMean) recurrence = clamp((1 - (recentMean / overallMean)) * 100, 0, 100);
  }

  const rawScore = Math.round(
    (positional * W_POSITIONAL +
     patternRiskDriver * W_PATTERN +
     latency.score * W_LATENCY_DETER +
     rangeDeter * W_RANGE_DETER +
     recurrence * W_RECURRENCE) / 100
  );

  // Audit fix (§8): the final score is only calibrated once enough closed
  // episodes exist. While LEARNING, every component above is still computed
  // (so they're visible for debugging/curiosity) but the score that drives
  // engineState is held at 0 rather than presenting a confident-looking
  // percentage built on almost no history.
  const score = enoughHistory ? clamp(rawScore, 0, 100) : 0;

  const reasons = [];
  if (enoughHistory && positional >= 50) reasons.push(`Current forecast position (${currentLen}) is inside or beyond the historical closure zone (${positional}th percentile, n=${lengths.length} episodes).`);
  if (!association.insufficientSample && association.pct >= 50) {
    reasons.push(`The current trailing range sequence has historically preceded closure ${association.pct}% of the time (n=${association.sampleSize} occurrences).`);
  } else if (patternSim.score >= 60) {
    reasons.push(`Current forecast sequence structurally resembles a prior pre-closure pattern at ${patternSim.score}% similarity, but there is not yet enough sample (n=${association.sampleSize}) to trust that as a closure signal.`);
  }
  if (!latency.insufficientSample && latency.score >= 40) {
    const parts = [];
    if (latency.consecutiveExpansionStreak >= 2) parts.push(`${latency.consecutiveExpansionStreak} consecutive slower forecasts`);
    if (latency.lateEventStreak >= 1) parts.push(`${latency.lateEventStreak} consecutive late event(s)`);
    reasons.push(`Recent event latency is deteriorating relative to earlier in this forecasting run${parts.length ? ' (' + parts.join(', ') + ')' : ''}.`);
  }
  if (rangeDeter >= 40) {
    if (!family.insufficientSample && family.pct >= 50) {
      reasons.push(`Forecast ranges are widening in a recognized family shape (${family.shape}) that has historically preceded closure ${family.pct}% of the time (n=${family.sampleSize}).`);
    } else {
      reasons.push('Forecast ranges are widening relative to earlier in this forecasting run.');
    }
  }
  if (recurrence >= 40) reasons.push('Recent gate closures are occurring after fewer forecasts than the historical average.');

  return {
    score,
    insufficientData: !enoughHistory,
    modelConfidence: modelConfidenceTier(lengths.length),
    components: {
      positional: { value: positional, weight: W_POSITIONAL, sampleSize: lengths.length, insufficientSample: !enoughHistory },
      patternSimilarity: {
        value: patternRiskDriver,
        weight: W_PATTERN,
        rawSimilarity: patternSim.score,
        matchedEpisodeId: patternSim.matchedEpisodeId,
        historicalClosureAssociation: association.pct,
        sampleSize: association.sampleSize,
        insufficientSample: association.insufficientSample
      },
      latencyDeterioration: {
        value: latency.score,
        weight: W_LATENCY_DETER,
        sampleSize: latency.sampleSize,
        insufficientSample: latency.insufficientSample,
        ratio: latency.ratio,
        slope: latency.slope,
        recentMedian: latency.recentMedian,
        recentMax: latency.recentMax,
        consecutiveExpansionStreak: latency.consecutiveExpansionStreak,
        lateEventStreak: latency.lateEventStreak
      },
      rangeDeterioration: {
        value: rangeDeter,
        weight: W_RANGE_DETER,
        widthDeterioration: Math.round(widthDeter),
        familyAssociation: family.pct,
        familyShape: family.shape,
        sampleSize: family.sampleSize,
        insufficientSample: family.insufficientSample
      },
      recurrence: { value: Math.round(recurrence), weight: W_RECURRENCE, sampleSize: lengths.length, insufficientSample: !enoughHistory }
    },
    reasons
  };
}

function riskScoreToState(score) {
  if (score <= RISK_NORMAL_MAX) return 'NORMAL';
  if (score <= RISK_WATCH_MAX) return 'WATCH';
  if (score <= RISK_APPROACHING_MAX) return 'APPROACHING';
  if (score <= RISK_HIGH_RISK_MAX) return 'HIGH_RISK';
  return 'AVOID';
}

// Audit fix (§19): a brand-new deployment (or one still under
// MIN_EPISODES_FOR_MODEL closed episodes) should say so plainly rather than
// defaulting to a reassuring-looking NORMAL. LEARNING takes priority over
// every risk-derived state except CLOSED, which always reflects the record
// that was just ingested regardless of model maturity.
function resolveEngineState(state, risk, justClosedEpisode) {
  if (justClosedEpisode) return 'CLOSED';
  if (state.closureEpisodes.length < MIN_EPISODES_FOR_MODEL) return 'LEARNING';
  return riskScoreToState(risk.score);
}

// ---------------------------------------------------------------------------
// LAYER 10 — Closure window estimate
// ---------------------------------------------------------------------------

function buildClosureWindow(state, intervalModel) {
  const currentLen = state.currentEpisode.predictions.length;
  if (intervalModel.insufficientData) {
    return { likelyLow: null, likelyHigh: null, label: 'Insufficient closure history to estimate a window.', basis: intervalModel };
  }
  const remainingLow = Math.max(0, Math.round(intervalModel.p25 - currentLen));
  const remainingHigh = Math.max(0, Math.round(intervalModel.p75 - currentLen));
  const label = currentLen >= intervalModel.p75
    ? 'Current position is already inside or beyond the typical historical closure zone.'
    : `Likely in approximately ${remainingLow}-${remainingHigh} more forecasts.`;
  return { likelyLow: remainingLow, likelyHigh: remainingHigh, label, basis: intervalModel };
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildGCISummary(state, justClosedEpisode) {
  const intervalModel = buildClosureIntervalModel(state);
  const risk = computeClosureRisk(state);
  const engineState = resolveEngineState(state, risk, justClosedEpisode);

  const st = state.statistics;
  const closureRate = st.totalForecasts > 0 ? Math.round((st.gateClosures / st.totalForecasts) * 100) : null;
  const accuracyRate = st.totalEvents > 0 ? Math.round((st.accurateEvents / st.totalEvents) * 100) : null;
  const sixDrawCaptureRate = st.totalEvents > 0 ? Math.round((st.sixDrawCaptureCount / st.totalEvents) * 100) : null;

  return {
    engine: '4SIL-GCI',
    version: '1.1',
    engineState, // LEARNING | NORMAL | WATCH | APPROACHING | HIGH_RISK | AVOID | CLOSED

    // Audit fix (§4/§19): explicit sample-confidence surface so the
    // dashboard/operator always knows how much history backs the current
    // numbers, independent of whatever the risk score happens to say.
    learning: {
      episodesRecorded: state.closureEpisodes.length,
      episodesRequiredForModel: MIN_EPISODES_FOR_MODEL,
      modelConfidence: modelConfidenceTier(state.closureEpisodes.length)
    },

    closureRisk: risk,

    currentEpisode: {
      startedAt: state.currentEpisode.startedAt,
      forecastsSinceLastClosure: state.currentEpisode.predictions.length,
      eventsSinceLastClosure: state.currentEpisode.predictions.filter(p => p.status === 'HIT').length
    },

    closureWindow: buildClosureWindow(state, intervalModel),

    closureIntervalModel: intervalModel,

    statistics: {
      totalForecasts: st.totalForecasts,
      totalEvents: st.totalEvents,
      accurateEvents: st.accurateEvents,
      accuracyRate,
      lateEvents: st.lateEvents,
      sixDrawCaptureCount: st.sixDrawCaptureCount,
      sixDrawCaptureRate,
      gateClosures: st.gateClosures,
      closureRate
    },

    falsePositiveProfile: buildFalsePositiveProfile(state),

    rangeSequenceIntelligence: buildRangeSequenceIntelligence(state),

    recentClosureEpisodes: state.closureEpisodes.slice(0, 5).map(e => ({
      episodeId: e.episodeId,
      closedAt: e.closedAt,
      closedReason: e.closedReason,
      length: e.length,
      events: e.events,
      accurateEvents: e.accurateEvents,
      lateEvents: e.lateEvents,
      classification: e.classification,
      latencyTrend: e.latencyTrend,
      rangeSequence: e.rangeSequence
    })),

    justClosedEpisode: justClosedEpisode || null,

    updatedAt: state.updatedAt
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Advance the 4SIL Gate Closure Intelligence Engine.
 *
 * STRICT INPUT CONTRACT: `neiPredictions` must be the raw 4SIL-NEI
 * predictions ledger array (newest-first, as held in NEI's own
 * in-memory state) — nothing else may be passed to or read by this
 * engine.
 *
 * @param {Array}  neiPredictions  raw 4SIL-NEI predictions ledger (read-only)
 * @param {object} gciState        this engine's own persistent state (mutated in place)
 * @returns {object} read-only 4SIL-GCI summary for the dashboard
 */
function advanceGCI(neiPredictions, gciState) {
  const state = ensureGCIStateShape(gciState);

  const { justClosedEpisode } = ingest(state, neiPredictions);

  state.updatedAt = new Date().toISOString();

  return buildGCISummary(state, justClosedEpisode);
}

module.exports = {
  freshGCIState,
  ensureGCIStateShape,
  advanceGCI,
  buildGCISummary
};
