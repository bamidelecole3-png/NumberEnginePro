/**
 * Shared Statistics Primitives.
 *
 * Blueprint Phases 3/5/6/7 all need the same underlying math (mean,
 * variance, percentiles, z-scores, cosine similarity) applied to
 * different feature sets. Centralizing it here means every engine
 * computes "variance" or "percentile" the same way, with the same
 * empty-input and zero-variance edge cases handled once instead of
 * six times with six chances to diverge.
 *
 * Every function here is a pure function of its arguments: no store
 * access, no side effects. That keeps them trivially unit-testable
 * and reusable outside the 5-ball lab if useful later.
 */

function mean(values) {
  if (!values || values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function variance(values) {
  if (!values || values.length < 2) return 0;
  const m = mean(values);
  const sumSq = values.reduce((acc, v) => acc + (v - m) * (v - m), 0);
  // Sample variance (n-1 denominator): these are always small historical
  // samples (gap counts between rare events), never a full population, so
  // the unbiased estimator is the appropriate one.
  return sumSq / (values.length - 1);
}

function stddev(values) {
  return Math.sqrt(variance(values));
}

function median(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function mode(values) {
  if (!values || values.length === 0) return null;
  const counts = new Map();
  let best = values[0];
  let bestCount = 0;
  for (const v of values) {
    const c = (counts.get(v) || 0) + 1;
    counts.set(v, c);
    if (c > bestCount) {
      bestCount = c;
      best = v;
    }
  }
  return best;
}

// Linear-interpolation percentile (the same convention Excel/numpy's
// default "linear" method uses), so a p=50 call agrees with median()
// above rather than silently using a different definition.
function percentile(values, p) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const frac = rank - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * frac;
}

function interquartileRange(values) {
  return percentile(values, 75) - percentile(values, 25);
}

// z-score of `value` against the distribution described by `values`.
// Returns 0 (rather than NaN/Infinity) when the distribution has fewer
// than 2 points or zero variance -- a single-sample or perfectly uniform
// history gives no basis for "how many standard deviations away," so
// "not unusual" (0) is the honest answer, not an undefined one.
function zScore(value, values) {
  const sd = stddev(values);
  if (sd === 0) return 0;
  return (value - mean(values)) / sd;
}

// Cosine similarity between two equal-length numeric vectors, returned
// as a 0-100 scale (not the raw -1..1 range) to match how confidence/
// similarity scores are expressed everywhere else in this codebase.
// Vectors are expected to already be normalized to comparable ranges by
// the caller (see runwayFeatureEngine's normalizeVector) -- this function
// only does the dot-product/magnitude math, not feature scaling.
function cosineSimilarity(vecA, vecB) {
  const keys = Object.keys(vecA);
  let dot = 0, magA = 0, magB = 0;
  for (const k of keys) {
    const a = vecA[k] || 0;
    const b = vecB[k] || 0;
    dot += a * b;
    magA += a * a;
    magB += b * b;
  }
  if (magA === 0 || magB === 0) return 0; // an all-zero vector has no defined direction
  const cos = dot / (Math.sqrt(magA) * Math.sqrt(magB));
  // Cosine similarity is mathematically in [-1, 1]; every feature in this
  // system's vectors is non-negative by construction (counts, 0-100
  // scores, ratios), so in practice this is always [0, 1] -- but clamp
  // defensively rather than assume, and rescale to a 0-100 display range.
  return Math.round(Math.max(0, Math.min(1, cos)) * 100);
}

// Simple linear regression slope over an ordered series (used for
// "momentum slope" / "window acceleration" style features). Index-based
// x-values (0, 1, 2, ...), so the returned slope is "average change per
// step," not tied to real time units.
function linearSlope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const xs = values.map((_, i) => i);
  const mx = mean(xs);
  const my = mean(values);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (values[i] - my);
    den += (xs[i] - mx) * (xs[i] - mx);
  }
  if (den === 0) return 0;
  return num / den;
}

// Shannon entropy (base 2) of a discrete distribution given as raw
// counts (not pre-normalized probabilities) -- callers pass e.g.
// { RED: 5, BLUE: 2, GREEN: 1 } and get bits of entropy back. Returns 0
// for an empty or all-zero distribution (no information, not NaN).
function shannonEntropyOf(counts) {
  const values = Object.values(counts).filter(v => v > 0);
  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let h = 0;
  for (const v of values) {
    const p = v / total;
    h -= p * Math.log2(p);
  }
  return h;
}

module.exports = {
  mean,
  variance,
  stddev,
  median,
  mode,
  percentile,
  interquartileRange,
  zScore,
  cosineSimilarity,
  linearSlope,
  shannonEntropyOf
};
