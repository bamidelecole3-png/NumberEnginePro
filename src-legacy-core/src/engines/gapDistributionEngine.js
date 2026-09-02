/**
 * Gap Distribution & Cycle Engine — Blueprint Phase 5.
 *
 * Replaces "current gap vs. mean gap" with a full distributional and
 * cyclical analysis of the gaps between a color's 5-ball events:
 *
 *   1. Distribution Analysis  — mean/median/mode/variance/stddev/
 *      percentiles/min/max/IQR over the color's historical gap sequence.
 *   2. Gap Shape              — CLUSTERED / UNIFORM / PERIODIC / RANDOM /
 *      EXPANDING / CONTRACTING, derived from the coefficient of variation
 *      and the trend of recent gaps vs. older ones.
 *   3. Gap Cycles             — detects an 18-22 draw cycle, a ~30 draw
 *      cycle, burst patterns (several short gaps in a row), decay
 *      patterns (gaps trending longer), twin events / double spikes
 *      (two hits very close together after a long drought).
 *   4. Gap Forecast           — a risk score, an expected return window,
 *      an expected range, and late/extreme-delay warnings.
 *
 * HONESTY NOTE: everything here is real, deterministic statistics
 * computed from the actual historical gap sequence -- no hardcoded
 * per-color numbers, no fabricated confidence. But it's worth being
 * explicit about what these numbers are and are not: an "overdue
 * probability" or "gap risk score" describes how unusual the CURRENT
 * gap is relative to this color's own history, not a calibrated
 * probability that the color will actually hit soon. If draws are
 * genuinely independent, a long observed gap says nothing at all about
 * what happens next (the "gambler's fallacy" is exactly the belief that
 * it does). This module treats these figures as descriptive signals for
 * a human or a downstream engine to weigh -- not as ground truth.
 */

'use strict';

const { HIERARCHY } = require('../core/colorMath');
const {
  mean, median, mode, variance, stddev, percentile, interquartileRange, linearSlope
} = require('../core/statMath');

const CYCLE_TOLERANCE = 2; // draws of slack when matching a gap against a target cycle length
const MIN_GAPS_FOR_CYCLE_DETECTION = 4; // need at least this many gaps to call something "a cycle" and not noise
const MIN_GAPS_FOR_SHAPE = 3;

// Builds the raw ordered gap sequence (oldest-to-newest) for one color:
// every draws-between-consecutive-hits value, plus the current
// (still-open) gap since the most recent hit.
//
// historicalDraws is newest-first (store.js's unshift() convention).
// Walking i = 0..length therefore walks backward in time.
function buildGapSequence(historicalDraws, color) {
  const gapsNewestFirst = []; // gap[k] = draws between hit(k) and hit(k+1), most recent gap first
  let currentGap = 0;
  let lastHitIndex = null;
  let foundFirst = false;
  let hitCount = 0;

  for (let i = 0; i < historicalDraws.length; i++) {
    const d = historicalDraws[i];
    if (d.fourBallColor === color) {
      hitCount++;
      if (!foundFirst) {
        currentGap = i;
        foundFirst = true;
      } else {
        gapsNewestFirst.push(i - lastHitIndex);
      }
      lastHitIndex = i;
    }
  }

  // Reverse to chronological (oldest-first) order for trend/cycle analysis,
  // where "recent" naturally means "end of the array."
  const gapsChronological = [...gapsNewestFirst].reverse();

  return { gapsChronological, currentGap, hitCount, hasAnyHit: foundFirst };
}

// ── 1. Distribution Analysis ──────────────────────────────────────────
function buildDistribution(gaps) {
  if (gaps.length === 0) {
    return {
      sample: 0,
      mean: null, median: null, mode: null, variance: null, stddev: null,
      p25: null, p75: null, iqr: null, min: null, max: null
    };
  }
  return {
    sample: gaps.length,
    mean: Math.round(mean(gaps) * 10) / 10,
    median: median(gaps),
    mode: mode(gaps),
    variance: Math.round(variance(gaps) * 100) / 100,
    stddev: Math.round(stddev(gaps) * 100) / 100,
    p25: Math.round(percentile(gaps, 25) * 10) / 10,
    p75: Math.round(percentile(gaps, 75) * 10) / 10,
    iqr: Math.round(interquartileRange(gaps) * 10) / 10,
    min: Math.min(...gaps),
    max: Math.max(...gaps)
  };
}

// ── 2. Gap Shape ───────────────────────────────────────────────────────
// Classifies the overall shape of a color's gap sequence:
//   CLUSTERED    — low coefficient of variation AND a short mean (hits
//                  tend to bunch together)
//   PERIODIC     — low coefficient of variation AND a longer, consistent
//                  mean (hits recur on a near-fixed rhythm)
//   UNIFORM      — moderate, unremarkable variability
//   EXPANDING    — recent gaps trending longer than older gaps
//   CONTRACTING  — recent gaps trending shorter than older gaps
//   RANDOM       — high variability with no clear trend either way
//
// Trend (expanding/contracting) is checked first against a meaningful
// slope threshold, since a real trend is a more specific and more
// actionable claim than a static variability label; shape only falls
// back to the variability-based labels when no clear trend is present.
function classifyGapShape(gaps) {
  if (gaps.length < MIN_GAPS_FOR_SHAPE) {
    return { shape: 'INSUFFICIENT_DATA', coefficientOfVariation: null, trendSlope: null };
  }

  const m = mean(gaps);
  const sd = stddev(gaps);
  const cv = m > 0 ? sd / m : 0; // coefficient of variation: scale-free spread measure
  const slope = linearSlope(gaps);
  // Normalize slope by the mean gap so "trending" is judged relative to
  // this color's own typical gap size, not an absolute draw count that
  // would mean something different for a short-gap vs long-gap color.
  const normalizedSlope = m > 0 ? slope / m : 0;

  let shape;
  if (normalizedSlope > 0.15) {
    shape = 'EXPANDING';
  } else if (normalizedSlope < -0.15) {
    shape = 'CONTRACTING';
  } else if (cv < 0.35) {
    shape = m <= 10 ? 'CLUSTERED' : 'PERIODIC';
  } else if (cv < 0.65) {
    shape = 'UNIFORM';
  } else {
    shape = 'RANDOM';
  }

  return {
    shape,
    coefficientOfVariation: Math.round(cv * 1000) / 1000,
    trendSlope: Math.round(slope * 100) / 100
  };
}

// ── 3. Gap Cycles ────────────────────────────────────────────────────
// Checks whether a meaningful fraction of observed gaps cluster around
// a target cycle length (within CYCLE_TOLERANCE draws), plus burst/
// decay/twin-event pattern detection.
function detectCycles(gaps) {
  const cycles = {
    cycle18to22: false,
    cycle30: false,
    burstPattern: false,
    decayPattern: false,
    twinEvents: false,
    doubleSpikes: false
  };

  if (gaps.length < MIN_GAPS_FOR_CYCLE_DETECTION) {
    return { ...cycles, note: 'Insufficient gap history for cycle detection (need >= 4 gaps).' };
  }

  const matchesTarget = (target) => gaps.filter(g => Math.abs(g - target) <= CYCLE_TOLERANCE).length;

  // A "cycle" is real evidence, not a coincidence, only if a clear
  // majority of gaps land near the target -- otherwise every color would
  // trivially "match" some cycle length by chance.
  const CYCLE_MATCH_RATIO = 0.5;
  const near20 = matchesTarget(20);
  cycles.cycle18to22 = near20 / gaps.length >= CYCLE_MATCH_RATIO;
  const near30 = matchesTarget(30);
  cycles.cycle30 = near30 / gaps.length >= CYCLE_MATCH_RATIO;

  // Burst pattern: at least 3 consecutive short gaps (below half the
  // overall mean) somewhere in the sequence -- hits bunching up.
  const m = mean(gaps);
  let consecutiveShort = 0, maxConsecutiveShort = 0;
  for (const g of gaps) {
    if (g < m * 0.5) {
      consecutiveShort++;
      maxConsecutiveShort = Math.max(maxConsecutiveShort, consecutiveShort);
    } else {
      consecutiveShort = 0;
    }
  }
  cycles.burstPattern = maxConsecutiveShort >= 3;

  // Decay pattern: the back half of the sequence is meaningfully longer
  // on average than the front half -- gaps trending longer over time.
  const half = Math.floor(gaps.length / 2);
  if (half >= 2) {
    const earlyMean = mean(gaps.slice(0, half));
    const lateMean = mean(gaps.slice(gaps.length - half));
    cycles.decayPattern = earlyMean > 0 && (lateMean - earlyMean) / earlyMean >= 0.4;
  }

  // Twin events / double spikes: a very short gap (<=2 draws, i.e. two
  // hits landing almost back-to-back) immediately following a gap that
  // was well above this color's own mean -- a burst right after a lull.
  for (let i = 1; i < gaps.length; i++) {
    if (gaps[i] <= 2 && gaps[i - 1] > m * 1.3) {
      cycles.twinEvents = true;
      break;
    }
  }
  // Double spikes: two consecutive very-short gaps anywhere (three hits
  // clustered within a handful of draws).
  for (let i = 1; i < gaps.length; i++) {
    if (gaps[i] <= 2 && gaps[i - 1] <= 2) {
      cycles.doubleSpikes = true;
      break;
    }
  }

  return cycles;
}

// ── 4. Gap Forecast ──────────────────────────────────────────────────
// Turns the distribution + current (still-open) gap into a risk score,
// an expected return window, and warning flags.
function buildForecast(distribution, currentGap, gapsCount) {
  if (gapsCount === 0 || distribution.mean === null) {
    return {
      gapRiskScore: 50,
      returnWindow: 'Unknown (insufficient history)',
      expectedRange: null,
      lateWarning: false,
      extremeDelayAlert: false
    };
  }

  // Risk score: how unusual the current (open) gap is relative to this
  // color's own history, expressed on a 0-100 scale. A gap right at the
  // mean scores ~50; two standard deviations over scores near 95.
  const gapZ = distribution.stddev > 0
    ? (currentGap - distribution.mean) / distribution.stddev
    : 0;
  const gapRiskScore = Math.max(5, Math.min(97, Math.round(50 + gapZ * 22.5)));

  const lowerBound = Math.max(0, Math.round(distribution.p25));
  const upperBound = Math.round(distribution.p75);

  const lateWarning = currentGap > distribution.mean;
  const extremeDelayAlert = distribution.stddev > 0 && gapZ >= 2;

  return {
    gapRiskScore,
    returnWindow: `Draws ${lowerBound}-${upperBound} (based on this color's own 25th-75th percentile gap range)`,
    expectedRange: { low: lowerBound, high: upperBound },
    gapZScore: Math.round(gapZ * 100) / 100,
    lateWarning,
    extremeDelayAlert
  };
}

function analyzeGapDistribution(historicalDraws) {
  const result = {};

  HIERARCHY.forEach(color => {
    const { gapsChronological, currentGap, hitCount } = buildGapSequence(historicalDraws, color);
    const distribution = buildDistribution(gapsChronological);
    const shape = classifyGapShape(gapsChronological);
    const cycles = detectCycles(gapsChronological);
    const forecast = buildForecast(distribution, currentGap, gapsChronological.length);

    result[color] = {
      color,
      hitCount,
      currentGap,
      distribution,
      shape,
      cycles,
      forecast
    };
  });

  return result;
}

module.exports = {
  analyzeGapDistribution,
  buildGapSequence,
  buildDistribution,
  classifyGapShape,
  detectCycles,
  buildForecast
};
