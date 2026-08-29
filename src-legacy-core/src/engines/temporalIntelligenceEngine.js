/**
 * Temporal Intelligence Engine — Blueprint Phase 9.
 *
 * Every draw carries a real `timestamp` (validator.js sets one from the
 * payload, or defaults to ingest time when the upstream feed doesn't
 * supply one — see src/collector/validator.js). This engine is the first
 * one in the codebase to actually read that field for analysis rather
 * than just storing it, and answers the blueprint's four questions per
 * color:
 *
 *   1. Hour-of-day / session clustering — does this color's tier-3+
 *      activity concentrate in particular hours or trading sessions
 *      (Morning / Afternoon / Evening / Night) more than an even spread
 *      would predict?
 *   2. Day-of-week effects — same question, by weekday, with a specific
 *      weekend-vs-weekday comparison since that's the blueprint's named
 *      example.
 *   3. Draw velocity / inter-arrival time — how much real wall-clock time
 *      typically separates consecutive draws right now (useful context
 *      for interpreting "10-draw window" style forecasts from other
 *      engines in actual time, and for detecting rapid-burst periods).
 *   4. Rapid bursts — spans where several tier-3+ events for the same
 *      color land within an unusually short wall-clock span relative to
 *      that color's own typical inter-arrival time.
 *
 * HONESTY NOTE: this system's actual draw MECHANISM (however Bet9ja
 * generates these draws) has no known physical dependency on clock time.
 * Any hour/session/weekday skew this engine finds is a description of
 * this dataset's OBSERVED distribution — worth surfacing, and legitimate
 * input to a similarity/clustering signal — but it is not evidence of a
 * causal time-of-day effect, and every score here is reported alongside
 * its sample size so a thin, noisy skew isn't mistaken for a strong one.
 *
 * Pure function of historicalDraws, like every other 5-ball lab engine —
 * no persisted state, recomputed fresh each call (see rareEventLabEngine.js's
 * header comment on why these aggregate engines aren't incremental).
 */

'use strict';

const { HIERARCHY } = require('../core/colorMath');
const { mean, stddev } = require('../core/statMath');
const { tierValue } = require('./runwayFeatureEngine');

// Below this many timestamped tier-3+ events for a color, hour/session/
// weekday skew figures are reported as null (insufficient sample) rather
// than a percentage computed from 1-2 points that would look far more
// confident than it is.
const MIN_SAMPLE_FOR_TEMPORAL_STATS = 6;

const SESSION_BOUNDARIES = [
  { name: 'NIGHT', startHour: 0, endHour: 6 },
  { name: 'MORNING', startHour: 6, endHour: 12 },
  { name: 'AFTERNOON', startHour: 12, endHour: 18 },
  { name: 'EVENING', startHour: 18, endHour: 24 }
];

function sessionForHour(hour) {
  const found = SESSION_BOUNDARIES.find(s => hour >= s.startHour && hour < s.endHour);
  return found ? found.name : 'NIGHT';
}

// Parses a draw's timestamp into a Date, or null if missing/unparseable.
// Draws from before this engine existed, or from a feed that never sent
// a real timestamp, fall back to validator.js's ingest-time default --
// which is still a real Date, just not necessarily meaningful for
// "when did this actually happen" analysis. We don't try to distinguish
// the two cases here; that's a data-quality question for the operator,
// not something this engine can detect from the timestamp alone.
function parseTimestamp(draw) {
  if (!draw || !draw.timestamp) return null;
  const d = new Date(draw.timestamp);
  return isNaN(d.getTime()) ? null : d;
}

// Builds the chronological (oldest-first) sequence of real Dates for every
// draw where this color reached at least tier 3, alongside the draw's
// index in the original newest-first array (for gap/velocity bookkeeping
// consistent with every other engine in this codebase).
function buildTimestampedEvents(historicalDraws, color) {
  const events = [];
  for (let i = historicalDraws.length - 1; i >= 0; i--) {
    const draw = historicalDraws[i];
    if (tierValue(draw, color) < 3) continue;
    const ts = parseTimestamp(draw);
    if (!ts) continue;
    events.push({ index: i, timestamp: ts });
  }
  return events;
}

// Observed-vs-expected skew for a set of bucket counts against a uniform
// distribution over `bucketCount` equally-likely buckets. Returns, per
// bucket key, how many standard deviations above/below the uniform
// expectation that bucket's count sits (a simple z-score against a
// binomial-ish null), plus the raw share. This is deliberately simpler
// than a full chi-square test — good enough to say "this bucket is
// unusually over/under-represented," not intended as a rigorous
// significance test.
function bucketSkew(counts, bucketCount, total) {
  if (total === 0) return {};
  const expectedShare = 1 / bucketCount;
  const expectedCount = total * expectedShare;
  // Standard deviation of a binomial(total, expectedShare) count.
  const sd = Math.sqrt(total * expectedShare * (1 - expectedShare));
  const result = {};
  for (const key of Object.keys(counts)) {
    const observed = counts[key];
    const share = Math.round((observed / total) * 1000) / 10; // 0-100, 1dp
    const z = sd > 0 ? Math.round(((observed - expectedCount) / sd) * 100) / 100 : 0;
    result[key] = { count: observed, sharePct: share, zScore: z };
  }
  return result;
}

function analyzeHourAndSessionClustering(events) {
  if (events.length < MIN_SAMPLE_FOR_TEMPORAL_STATS) {
    return { sufficientSample: false, sample: events.length, hourly: null, sessions: null, peakSession: null };
  }

  const hourCounts = {};
  const sessionCounts = { MORNING: 0, AFTERNOON: 0, EVENING: 0, NIGHT: 0 };
  events.forEach(e => {
    const hour = e.timestamp.getHours();
    hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    sessionCounts[sessionForHour(hour)]++;
  });

  const hourly = bucketSkew(hourCounts, 24, events.length);
  const sessions = bucketSkew(sessionCounts, 4, events.length);

  const peakSession = Object.entries(sessions).sort((a, b) => b[1].count - a[1].count)[0];

  return {
    sufficientSample: true,
    sample: events.length,
    hourly,
    sessions,
    peakSession: { name: peakSession[0], sharePct: peakSession[1].sharePct, zScore: peakSession[1].zScore }
  };
}

function analyzeDayOfWeek(events) {
  if (events.length < MIN_SAMPLE_FOR_TEMPORAL_STATS) {
    return { sufficientSample: false, sample: events.length, byDay: null, weekendVsWeekday: null };
  }

  const dayNames = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const dayCounts = { SUN: 0, MON: 0, TUE: 0, WED: 0, THU: 0, FRI: 0, SAT: 0 };
  let weekendCount = 0;
  events.forEach(e => {
    const day = e.timestamp.getDay(); // 0 = Sunday, 6 = Saturday
    dayCounts[dayNames[day]]++;
    if (day === 0 || day === 6) weekendCount++;
  });

  const byDay = bucketSkew(dayCounts, 7, events.length);

  // Weekend vs weekday isn't a uniform-bucket comparison (2/7 of days are
  // weekend) -- compare observed weekend share against the 2/7 baseline
  // its calendar share would predict under no effect.
  const expectedWeekendShare = 2 / 7;
  const observedWeekendShare = weekendCount / events.length;
  const weekendSd = Math.sqrt(events.length * expectedWeekendShare * (1 - expectedWeekendShare));
  const weekendZ = weekendSd > 0
    ? Math.round(((weekendCount - events.length * expectedWeekendShare) / weekendSd) * 100) / 100
    : 0;

  return {
    sufficientSample: true,
    sample: events.length,
    byDay,
    weekendVsWeekday: {
      weekendCount,
      weekdayCount: events.length - weekendCount,
      observedWeekendSharePct: Math.round(observedWeekendShare * 1000) / 10,
      expectedWeekendSharePct: Math.round(expectedWeekendShare * 1000) / 10,
      zScore: weekendZ,
      skew: weekendZ >= 1 ? 'WEEKEND_HEAVY' : weekendZ <= -1 ? 'WEEKDAY_HEAVY' : 'NO_CLEAR_SKEW'
    }
  };
}

// Inter-arrival times (in minutes) between this color's consecutive
// tier-3+ events, chronologically. Distinct from the "draw gap" concept
// used everywhere else in this codebase (which counts intervening
// DRAWS, not wall-clock time) -- this is specifically about real elapsed
// time, which is what "draw velocity" in the blueprint is asking for.
function computeInterArrivalMinutes(events) {
  const deltas = [];
  for (let i = 1; i < events.length; i++) {
    const ms = events[i].timestamp.getTime() - events[i - 1].timestamp.getTime();
    if (ms > 0) deltas.push(ms / 60000);
  }
  return deltas;
}

// Overall draw velocity (ANY color, not per-color) -- the typical
// wall-clock spacing between consecutive draws in the current window,
// used to translate other engines' "N-draw window" language into real
// time for a human reading the dashboard.
function computeOverallDrawVelocity(historicalDraws) {
  const timestamped = historicalDraws
    .map(d => parseTimestamp(d))
    .filter(ts => ts !== null);

  if (timestamped.length < 2) {
    return { sufficientSample: false, sample: timestamped.length, avgMinutesBetweenDraws: null };
  }

  // historicalDraws is newest-first; reverse to chronological for delta math.
  const chrono = [...timestamped].reverse();
  const deltas = [];
  for (let i = 1; i < chrono.length; i++) {
    const ms = chrono[i].getTime() - chrono[i - 1].getTime();
    if (ms > 0) deltas.push(ms / 60000);
  }
  if (deltas.length === 0) {
    return { sufficientSample: false, sample: timestamped.length, avgMinutesBetweenDraws: null };
  }

  return {
    sufficientSample: true,
    sample: deltas.length,
    avgMinutesBetweenDraws: Math.round(mean(deltas) * 10) / 10,
    stddevMinutesBetweenDraws: Math.round(stddev(deltas) * 10) / 10
  };
}

// Rapid burst detection: flags this color's most recent inter-arrival gap
// as a "burst" when it's unusually short relative to this SAME color's
// own historical inter-arrival distribution (z-score-based, consistent
// with how gapDistributionEngine.js flags overdue gaps on the long side --
// this is the mirror case, flagging unusually SHORT gaps).
const BURST_Z_THRESHOLD = -1.5;

function detectRecentBurst(events) {
  const deltas = computeInterArrivalMinutes(events);
  if (deltas.length < MIN_SAMPLE_FOR_TEMPORAL_STATS) {
    return { sufficientSample: false, sample: deltas.length, isRecentBurst: false, mostRecentGapMinutes: null, zScore: null };
  }

  const mostRecentGap = deltas[deltas.length - 1];
  const priorDeltas = deltas.slice(0, -1);
  const sd = stddev(priorDeltas);
  const avg = mean(priorDeltas);

  // BUGFIX: when priorDeltas has zero variance (every earlier gap
  // identical -- realistic on a small/early sample, or synthetic data),
  // z fell back to a flat 0 via statMath's documented divide-by-zero
  // guard, which silently reported "no signal" even for a dramatically
  // shorter final gap (e.g. 20 minutes after a string of perfectly
  // regular 24-hour gaps) -- exactly the case burst detection exists to
  // catch. Fall back to a simple ratio-against-average check in that
  // narrow case: a gap at or below half the (zero-variance) average is
  // still a real burst even though no z-score is defined for it.
  let z;
  let isRecentBurst;
  if (sd > 0) {
    z = Math.round(((mostRecentGap - avg) / sd) * 100) / 100;
    isRecentBurst = z <= BURST_Z_THRESHOLD;
  } else {
    z = null; // no variance in the comparison set -- a z-score isn't meaningful here
    isRecentBurst = avg > 0 && mostRecentGap <= avg * 0.5;
  }

  return {
    sufficientSample: true,
    sample: deltas.length,
    mostRecentGapMinutes: Math.round(mostRecentGap * 10) / 10,
    avgGapMinutes: Math.round(avg * 10) / 10,
    zScore: z,
    isRecentBurst
  };
}

function analyzeTemporalIntelligenceForColor(historicalDraws, color) {
  const events = buildTimestampedEvents(historicalDraws, color);

  const clustering = analyzeHourAndSessionClustering(events);
  const dayOfWeek = analyzeDayOfWeek(events);
  const burst = detectRecentBurst(events);

  const reasoningParts = [];
  if (clustering.sufficientSample && Math.abs(clustering.peakSession.zScore) >= 1) {
    reasoningParts.push(`${color} activity skews toward ${clustering.peakSession.name} (${clustering.peakSession.sharePct}% of events, z=${clustering.peakSession.zScore})`);
  }
  if (dayOfWeek.sufficientSample && dayOfWeek.weekendVsWeekday.skew !== 'NO_CLEAR_SKEW') {
    reasoningParts.push(`${dayOfWeek.weekendVsWeekday.skew.replace('_', ' ').toLowerCase()} (weekend z=${dayOfWeek.weekendVsWeekday.zScore})`);
  }
  if (burst.isRecentBurst) {
    reasoningParts.push(`recent burst detected (last gap ${burst.mostRecentGapMinutes}m vs avg ${burst.avgGapMinutes}m, z=${burst.zScore})`);
  }
  const reasoning = reasoningParts.length > 0
    ? reasoningParts.join('; ')
    : `${color}: no significant temporal skew detected (sample=${events.length})`;

  return {
    color,
    sample: events.length,
    clustering,
    dayOfWeek,
    burst,
    reasoning
  };
}

function evaluateTemporalIntelligence(historicalDraws) {
  const perColor = {};
  HIERARCHY.forEach(color => {
    perColor[color] = analyzeTemporalIntelligenceForColor(historicalDraws, color);
  });

  const drawVelocity = computeOverallDrawVelocity(historicalDraws);

  return { perColor, drawVelocity };
}

module.exports = {
  MIN_SAMPLE_FOR_TEMPORAL_STATS,
  BURST_Z_THRESHOLD,
  sessionForHour,
  parseTimestamp,
  computeOverallDrawVelocity,
  detectRecentBurst,
  evaluateTemporalIntelligence
};
