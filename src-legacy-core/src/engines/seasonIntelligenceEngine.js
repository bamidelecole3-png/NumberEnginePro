/**
 * 4-Ball Season Intelligence Engine.
 *
 * Blueprint "4-Ball Engine Roadmap -> Season Intelligence": replaces a
 * single "age" number with a real multi-metric read on how a 4-ball
 * season is actually behaving right now -- density (how often the leader
 * is hitting), velocity (is that rate rising or falling), acceleration
 * (is the rate-of-change itself speeding up or slowing down), decay (how
 * long since the last hit, normalized), and recovery (has it bounced back
 * from a recent dip) -- rolled into a single 0-100 "heat" score and a
 * COLD / GROWING / PEAK / DECLINING / ENDING classification.
 *
 * Pure function of (historicalDraws, dominantColor, seasonAge,
 * consecutiveNoHitCount) -- no persisted state, consistent with every
 * other 4-Ball engine in this codebase, all of which are recomputed fresh
 * from store.getRecentDraws(100) on every Supreme Council cycle.
 */

const SHORT_WINDOW = 5;
const MID_WINDOW = 10;
const LONG_WINDOW = 20;

// Fraction of draws in the window that were a hit for `color` (fourBallColor
// match). Windows are always the most recent N draws (historicalDraws is
// newest-first, per store.js's unshift-based addDraw).
function windowDensity(historicalDraws, color, windowSize, offset = 0) {
  const window = historicalDraws.slice(offset, offset + windowSize);
  if (window.length === 0) return 0;
  const hits = window.filter(d => d.fourBallColor === color).length;
  return hits / window.length;
}

// How far the current short-window density has bounced back from its own
// recent trough within the long window -- e.g. a color that dropped to 0%
// density three "5-draw slices" ago and is back to 40% now shows real
// recovery, distinct from a color that has simply been flat the whole time.
function computeRecoveryScore(historicalDraws, color) {
  const window = historicalDraws.slice(0, LONG_WINDOW);
  if (window.length < SHORT_WINDOW + 3) return 0;

  const rollingDensities = [];
  for (let offset = 0; offset + 3 <= window.length; offset += 1) {
    const slice = window.slice(offset, offset + 3);
    const hits = slice.filter(d => d.fourBallColor === color).length;
    rollingDensities.push(hits / 3);
  }
  if (rollingDensities.length < 2) return 0;

  const current = rollingDensities[0]; // most recent 3-draw density (window is newest-first)
  const trough = Math.min(...rollingDensities.slice(1)); // lowest point among everything older
  return Math.round(Math.max(0, current - trough) * 100);
}

// How many draws in a row (most-recent-first) have passed since `color`
// last landed a 4-ball hit. Deliberately computed HERE rather than reusing
// tacticalEngine's `consecutiveNoHitCount`, which tracks a gap for ANY
// color's 4-ball hit -- during exactly the situation this engine most
// needs to detect (the season's original leader has gone quiet while a
// different color keeps the season itself "active"), that generic gap
// stays near 0 and would silently mask the leader's own drought.
function computeColorSpecificNoHitStreak(historicalDraws, color) {
  let streak = 0;
  for (const d of historicalDraws) {
    if (d.fourBallColor === color) break;
    streak++;
  }
  return streak;
}

function evaluateSeasonIntelligence(historicalDraws, dominantColor, seasonAge) {
  const consecutiveNoHitCount = computeColorSpecificNoHitStreak(historicalDraws, dominantColor);

  const densityShort = windowDensity(historicalDraws, dominantColor, SHORT_WINDOW, 0);
  const densityMid = windowDensity(historicalDraws, dominantColor, MID_WINDOW, 0);
  const densityLong = windowDensity(historicalDraws, dominantColor, LONG_WINDOW, 0);

  // Velocity: change in density between the current short window and the
  // short window immediately preceding it.
  const priorShortDensity = windowDensity(historicalDraws, dominantColor, SHORT_WINDOW, SHORT_WINDOW);
  const velocity = Math.round((densityShort - priorShortDensity) * 100) / 100;

  // Acceleration: change in velocity itself, one short-window further back.
  const priorPriorDensity = windowDensity(historicalDraws, dominantColor, SHORT_WINDOW, SHORT_WINDOW * 2);
  const priorVelocity = Math.round((priorShortDensity - priorPriorDensity) * 100) / 100;
  const acceleration = Math.round((velocity - priorVelocity) * 100) / 100;

  // Decay: how far the current no-hit streak has run, normalized against
  // the mid window length as a rough "expected gap" baseline.
  const decay = Math.min(100, Math.round((consecutiveNoHitCount / MID_WINDOW) * 100));

  const recovery = computeRecoveryScore(historicalDraws, dominantColor);

  // Heat: a single composite read blending current activity level
  // (density), direction of travel (velocity, only rewarded when
  // positive), and freshness (inverse of decay).
  const heatRaw = (densityShort * 45) + (Math.max(0, velocity) * 30) + ((1 - decay / 100) * 25);
  const heat = Math.round(Math.max(0, Math.min(100, heatRaw)));

  let classification;
  if (seasonAge <= 2 && densityShort < 0.2) {
    classification = 'COLD';
  } else if (decay >= 80 || (densityShort === 0 && consecutiveNoHitCount >= LONG_WINDOW * 0.75)) {
    classification = 'ENDING';
  } else if (velocity > 0.05 && acceleration >= 0 && densityShort >= densityMid) {
    classification = 'GROWING';
  } else if (densityShort >= 0.35 && Math.abs(velocity) <= 0.1) {
    classification = 'PEAK';
  } else if (velocity < -0.05 || (decay > 40 && decay < 80)) {
    classification = 'DECLINING';
  } else {
    classification = densityShort >= densityMid ? 'GROWING' : 'DECLINING';
  }

  return {
    seasonAge,
    drawsSinceLastHit: consecutiveNoHitCount,
    densityShort: Math.round(densityShort * 100) / 100,
    densityMid: Math.round(densityMid * 100) / 100,
    densityLong: Math.round(densityLong * 100) / 100,
    velocity,
    acceleration,
    decay,
    recovery,
    heat,
    classification
  };
}

module.exports = {
  SHORT_WINDOW,
  MID_WINDOW,
  LONG_WINDOW,
  evaluateSeasonIntelligence
};
