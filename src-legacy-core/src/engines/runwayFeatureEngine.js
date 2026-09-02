/**
 * Runway Intelligence Engine — Blueprint Phase 3.
 *
 * Builds a multi-dimensional feature vector per color describing the
 * "runway" leading up to the current moment -- the last RUNWAY_WINDOW
 * (20) draws' worth of tier activity, momentum, compression, gaps,
 * dominance, suppression, entropy, and season/session context. This is
 * the feature set the Signature Engine (Phase 4) compares via cosine
 * similarity, and that the Prediction Engine (Phase 11) draws several of
 * its named sub-scores from.
 *
 * Each color's vector has the same ~30 named dimensions (see
 * FEATURE_KEYS below), which is what makes cosine similarity between two
 * different moments in history meaningful -- same axes, different
 * values, rather than an apples-to-oranges comparison.
 */

'use strict';

const { HIERARCHY } = require('../core/colorMath');
const { mean, stddev, linearSlope, shannonEntropyOf } = require('../core/statMath');

const RUNWAY_WINDOW = 20;

// Every dimension the runway vector produces, in a fixed order. Exported
// so the Signature Engine (and anyone building a historical vector
// database entry) knows exactly which keys to expect without having to
// re-derive them from buildRunwayVector's implementation.
const FEATURE_KEYS = [
  'threeBallFrequency', 'fourBallFrequency',
  'averageTier', 'maximumTier', 'tierTrend',
  'momentumSlope', 'compressionScore',
  'gapSince3Ball', 'gapSince4Ball',
  'dominanceScore', 'suppressionScore',
  'entropy', 'tierVolatility',
  'consecutiveAppearances', 'tierEscalationSpeed',
  'rollingDensity', 'windowAcceleration',
  'rivalPressure', 'colorBalance', 'tierLadderScore'
];

function tierValue(draw, color) {
  if (draw.fourBallColor === color) return 4;
  if (draw.threeBallColor === color) return 3;
  return 0;
}

// How many draws back (0 = most recent) is the most recent draw where
// this color reached at least `minTier`. Returns the window length
// itself (i.e. "at least this far, possibly further") if no such draw
// exists inside the window -- callers treat that as "no recent event,"
// not as a precise gap.
function gapSinceTier(window, color, minTier) {
  for (let i = 0; i < window.length; i++) {
    if (tierValue(window[i], color) >= minTier) return i;
  }
  return window.length;
}

function buildRunwayVector(historicalDraws, color) {
  const window = historicalDraws.slice(0, RUNWAY_WINDOW);
  const n = window.length;

  if (n === 0) {
    const empty = {};
    FEATURE_KEYS.forEach(k => { empty[k] = 0; });
    return { color, windowSize: 0, features: empty };
  }

  // Per-draw tier value for this color across the window, chronological
  // (oldest-first) for trend/slope calculations.
  const tiersNewestFirst = window.map(d => tierValue(d, color));
  const tiersChrono = [...tiersNewestFirst].reverse();

  const threeBallFrequency = window.filter(d => d.threeBallColor === color).length;
  const fourBallFrequency = window.filter(d => d.fourBallColor === color).length;

  const nonZeroTiers = tiersNewestFirst.filter(t => t > 0);
  const averageTier = nonZeroTiers.length > 0 ? mean(nonZeroTiers) : 0;
  const maximumTier = nonZeroTiers.length > 0 ? Math.max(...nonZeroTiers) : 0;

  // Tier trend: slope of tier value over the window (positive = climbing
  // toward higher tiers recently, negative = fading).
  const tierTrend = linearSlope(tiersChrono);

  // Momentum slope: slope of a binary "did this color appear at all"
  // series -- distinct from tierTrend, which only reacts to actual tier
  // reached; this reacts to raw appearance frequency over time.
  const appearanceSeries = tiersChrono.map(t => (t > 0 ? 1 : 0));
  const momentumSlope = linearSlope(appearanceSeries);

  // Compression score: how tightly this color's appearances are bunched
  // in the recent half of the window vs the earlier half. High = most
  // activity is recent (compressing toward now); low = spread out or
  // concentrated earlier.
  const half = Math.floor(n / 2);
  const recentHalfCount = appearanceSeries.slice(half).reduce((a, b) => a + b, 0);
  const totalCount = appearanceSeries.reduce((a, b) => a + b, 0);
  const compressionScore = totalCount > 0 ? Math.round((recentHalfCount / totalCount) * 100) : 0;

  const gapSince3Ball = gapSinceTier(window, color, 3);
  const gapSince4Ball = gapSinceTier(window, color, 4);

  // Dominance score: this color's share of ALL tier-3+ events across ALL
  // colors within the window (0-100). How much of the "action" this
  // color is currently claiming relative to its rivals.
  const allTierEvents = window.filter(d => d.threeBallColor || d.fourBallColor).length;
  const thisColorEvents = window.filter(d =>
    d.threeBallColor === color || d.fourBallColor === color
  ).length;
  const dominanceScore = allTierEvents > 0 ? Math.round((thisColorEvents / allTierEvents) * 100) : 0;

  // Suppression score: inverse of dominance, scaled by how long since
  // this color's last appearance of any tier within the window -- a
  // color that's both low-share AND has gone many draws without
  // appearing at all is more "suppressed" than one that's simply
  // slightly behind on share. gapSinceAny is "draws since last
  // appearance," clamped to the window size when it never appeared at
  // all in-window.
  const firstAppearanceIdx = tiersNewestFirst.findIndex(t => t > 0);
  const gapSinceAny = firstAppearanceIdx === -1 ? n : firstAppearanceIdx;
  const suppressionScore = Math.min(100, Math.round((100 - dominanceScore) * 0.5 + (gapSinceAny / n) * 50));

  // Entropy: Shannon entropy of this color's tier-value distribution
  // within the window (0, 3, 4, 5 as the discrete outcomes) -- high
  // entropy means this color's tier outcomes have been unpredictable/
  // varied; low entropy means consistent (e.g. always tier 0, or always
  // the same tier).
  const tierCounts = { t0: 0, t3: 0, t4: 0, t5: 0 };
  tiersNewestFirst.forEach(t => {
    if (t === 0) tierCounts.t0++;
    else if (t === 3) tierCounts.t3++;
    else if (t === 4) tierCounts.t4++;
    else if (t === 5) tierCounts.t5++;
  });
  const entropy = Math.round(shannonEntropyOf(tierCounts) * 100) / 100;

  // Tier volatility: standard deviation of tier value across the window
  // (distinct from entropy -- this captures MAGNITUDE of swings, e.g.
  // oscillating between 0 and 5 is more volatile than oscillating
  // between 0 and 3, even if both have similar entropy).
  const tierVolatility = Math.round(stddev(tiersNewestFirst) * 100) / 100;

  // Consecutive appearances: current streak of consecutive draws (most
  // recent first) where this color reached at least tier 3.
  let consecutiveAppearances = 0;
  for (const t of tiersNewestFirst) {
    if (t > 0) consecutiveAppearances++;
    else break;
  }

  // Tier escalation speed: draws between this color's most recent
  // tier-3 event and its most recent tier-4+ event, when both exist
  // inside the window and the tier-4+ event is the more recent of the
  // two (i.e. genuinely escalated, not coincidentally out of order).
  // Null (represented as -1) when no escalation is observable in-window.
  const last3Idx = window.findIndex(d => d.threeBallColor === color);
  const last4PlusIdx = window.findIndex(d => d.fourBallColor === color);
  const tierEscalationSpeed = (last3Idx !== -1 && last4PlusIdx !== -1 && last3Idx > last4PlusIdx)
    ? last3Idx - last4PlusIdx
    : -1;

  // Rolling density: appearances per draw over the window, as a 0-100
  // percentage -- simple activity-rate measure distinct from dominance
  // (which is relative to rivals) and compression (which is about
  // recency, not overall rate).
  const rollingDensity = Math.round((totalCount / n) * 100);

  // Window acceleration: compares appearance rate in the most recent
  // quarter of the window vs the rate in the window as a whole -- a
  // simple, robust "is this heating up right now" signal distinct from
  // the linear-regression-based momentumSlope. appearanceSeries is
  // chronological (oldest-first, built from tiersChrono above), so the
  // most recent quarter is the LAST `quarter` entries, i.e. slice(-quarter)
  // -- slice(0, quarter) would grab the OLDEST quarter instead.
  const quarter = Math.max(1, Math.floor(n / 4));
  const recentQuarterRate = mean(appearanceSeries.slice(-quarter));
  const overallRate = mean(appearanceSeries);
  const windowAcceleration = Math.round((recentQuarterRate - overallRate) * 100);

  // Rival pressure: how much of the window's tier-3+ activity belongs to
  // the SINGLE strongest rival color (not this one) -- a simple,
  // single-vector-local proxy for "how contested is this color's space
  // right now." The full cross-color equilibrium view lives in
  // rivalPressureEngine.js (Phase 8); this is just this color's own
  // vector's view of it.
  let strongestRivalCount = 0;
  HIERARCHY.forEach(rival => {
    if (rival === color) return;
    const rivalCount = window.filter(d =>
      d.threeBallColor === rival || d.fourBallColor === rival
    ).length;
    if (rivalCount > strongestRivalCount) strongestRivalCount = rivalCount;
  });
  const rivalPressure = allTierEvents > 0 ? Math.round((strongestRivalCount / allTierEvents) * 100) : 0;

  // Color balance: how close this color's share is to an even 1/3 split
  // across the window's tier-3+ events (100 = exactly even, 0 = this
  // color claims either 0% or 100% of activity -- maximally imbalanced
  // in either direction). The distance from the 33.33% "even" point to
  // 100% (66.67 points) is not the same as the distance to 0% (33.33
  // points), so the normalization divisor has to differ by side, or the
  // 0%-dominance case would incorrectly score ~50 instead of 0.
  const evenShare = 100 / 3;
  const distFromEven = Math.abs(dominanceScore - evenShare);
  const maxDistOnThisSide = dominanceScore >= evenShare ? (100 - evenShare) : evenShare;
  const colorBalance = Math.round(100 - (distFromEven / maxDistOnThisSide) * 100);

  // Tier ladder score: composite of how far up the 3->4->5 ladder this
  // color has been climbing recently -- weighted sum of tier frequencies
  // favoring higher tiers, scaled to 0-100.
  const ladderRaw = (threeBallFrequency * 1) + (fourBallFrequency * 2.5);
  const ladderMax = n * 5; // theoretical max if every draw were a 5-ball hit for this color
  const tierLadderScore = ladderMax > 0 ? Math.round((ladderRaw / ladderMax) * 100) : 0;

  const features = {
    threeBallFrequency,
    fourBallFrequency,
    averageTier: Math.round(averageTier * 100) / 100,
    maximumTier,
    tierTrend: Math.round(tierTrend * 100) / 100,
    momentumSlope: Math.round(momentumSlope * 1000) / 1000,
    compressionScore,
    gapSince3Ball,
    gapSince4Ball,
    dominanceScore,
    suppressionScore,
    entropy,
    tierVolatility,
    consecutiveAppearances,
    tierEscalationSpeed,
    rollingDensity,
    windowAcceleration,
    rivalPressure,
    colorBalance,
    tierLadderScore
  };

  return { color, windowSize: n, features };
}

// Builds vectors for every color at once, plus session/season context
// dimensions that are shared across colors (not per-color) but still
// useful to carry alongside the per-color vectors for the Signature
// Engine to include in its comparison. drawIndex (0 = most recent) lets
// the caller build a HISTORICAL vector as of an earlier point in time by
// passing historicalDraws.slice(drawIndex) instead of the live array.
function buildAllRunwayVectors(historicalDraws) {
  const vectors = {};
  HIERARCHY.forEach(color => {
    vectors[color] = buildRunwayVector(historicalDraws, color);
  });
  return vectors;
}

module.exports = {
  RUNWAY_WINDOW,
  FEATURE_KEYS,
  buildRunwayVector,
  buildAllRunwayVectors,
  tierValue
};
