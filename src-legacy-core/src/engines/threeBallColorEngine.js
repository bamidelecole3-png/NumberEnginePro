/**
 * 3-Ball Color Hit Intelligence Engine -- structural/mathematical mirror of
 * tieEngine.js's analyzeTies(), re-keyed from "tie detection" to "predicted
 * -color hit detection" for the 3-Ball market.
 *
 * WHY THIS EXISTS: the old 3-Ball Entry Intelligence panel displayed
 * Entry Warning/Risk/Tier metrics that don't map onto anything an operator
 * can act on moment-to-moment -- it answers "is now a good time to be in
 * this trade" but never "when does the predicted color actually land
 * next, and how confident should I be in that timing." The Tier (Tie)
 * Engine already solves exactly that problem for ties, with a track
 * record of clear, auditable intelligence (Last Tie Record / Interval
 * Statistics / Rate Analysis / Active Season / Market Reasoning). This
 * engine applies the identical four-signal (Frequency / Interval /
 * Pattern / Transition) pressure-score methodology to a different event:
 * "the 3-Ball Parliament's predicted color actually wins the draw."
 *
 * EVENT DEFINITION (fixed):
 * A "hit" is any 3-ball draw whose threeBallColor exactly equals the
 * color being tracked (the General Parliament's current winningColor,
 * passed in as trackedColor). This is a real, verifiable outcome --
 * validator.js already resolves threeBallColor deterministically (see
 * tieEngine.js's own header for that resolution logic), so hit detection
 * here needs no extra inference.
 *
 * historicalDraws is newest-first (index 0 = most recent), matching every
 * other engine's convention in this codebase.
 */
const { clamp } = require('../core/isotonic');

const SEASON_WINDOW_MIN = 10;
const SEASON_WINDOW_MAX = 15;
const SEASON_MAX_GAP = 2;
const SEASON_MIN_TIES = 3; // kept as "min hits" here; name mirrors tieEngine.js's constant for easy diffing

function median(sortedArr) {
  const n = sortedArr.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedArr[mid - 1] + sortedArr[mid]) / 2 : sortedArr[mid];
}

function modeOf(arr) {
  const freq = new Map();
  let best = arr[0];
  let bestCount = 0;
  for (const v of arr) {
    const c = (freq.get(v) || 0) + 1;
    freq.set(v, c);
    if (c > bestCount) {
      bestCount = c;
      best = v;
    }
  }
  return best;
}

// --- Hit detection -----------------------------------------------------

function isColorHit(draw, trackedColor) {
  if (!draw || !trackedColor) return false;
  // A hit is the tracked color landing with EITHER exactly 3 balls
  // (threeBallColor) OR 4 balls (fourBallColor) -- 4 is a stronger
  // showing of the same color and must still count as a win for it.
  return draw.threeBallColor === trackedColor || draw.fourBallColor === trackedColor;
}

/**
 * Split shape at the moment of the hit -- reuses the same leader/margin
 * read as tieEngine.js's classifyPrecursorSignature/tieShape, described
 * in the vocabulary an operator already recognizes from the Tie Engine
 * (e.g. "3-2-1 (RED leads, BLUE/GREEN trail)").
 */
function hitShape(draw) {
  if (!draw || !draw.colorCounts) return null;
  const HIERARCHY = ['RED', 'BLUE', 'GREEN'];
  const entries = HIERARCHY.map(c => ({ color: c, count: draw.colorCounts[c] || 0 }));
  const sorted = [...entries].sort((a, b) => b.count - a.count);
  const [a, b, c] = sorted;
  if (a.count === b.count && b.count === c.count) {
    return `${a.count}-${a.count}-${a.count} (even split)`;
  }
  if (b.count === c.count) {
    return `${a.count}-${b.count}-${b.count} (${a.color} leads, ${b.color}/${c.color} even)`;
  }
  return `${a.count}-${b.count}-${c.count} (${a.color} leads, ${c.color} trails)`;
}

// --- Signal engines (identical math to tieEngine.js's four signals) ----

function computeFrequencyScore(hitRatePct, recentRatePct, recentWindowSize) {
  if (recentWindowSize < 3) return { score: 30, note: 'Insufficient recent-window sample.' };
  const delta = recentRatePct - hitRatePct;
  const score = clamp(Math.round(50 + delta * 3), 0, 100);
  return { score, hitRatePct, recentRatePct, deltaPct: Math.round(delta * 10) / 10 };
}

function computeIntervalScore(avgIntervalDraws, lastHitDrawsAgo) {
  if (avgIntervalDraws === null || avgIntervalDraws <= 0 || lastHitDrawsAgo === null) {
    return { score: 25, ratio: null, note: 'Not enough interval history yet.' };
  }
  const ratio = lastHitDrawsAgo / avgIntervalDraws;
  const score = ratio >= 1
    ? clamp(Math.round(70 + (ratio - 1) * 60), 0, 100)
    : clamp(Math.round(ratio * 70), 0, 100);
  return { score, ratio: Math.round(ratio * 100) / 100 };
}

function classifyPrecursorSignature(draw, trackedColor) {
  if (!draw || !draw.colorCounts) return null;
  const trackedCount = draw.colorCounts[trackedColor] || 0;
  const others = Object.keys(draw.colorCounts)
    .filter(c => c !== trackedColor)
    .map(c => draw.colorCounts[c] || 0);
  const bestOther = others.length ? Math.max(...others) : 0;
  const margin = trackedCount - bestOther;
  if (margin <= 0) return 'BEHIND';
  if (margin === 1) return 'NARROW';
  return 'WIDE';
}

function computePatternScore(historicalDraws, hitDrawsAgoList, trackedColor) {
  const precursors = [];
  for (const hitIdx of hitDrawsAgoList) {
    const precursorDraw = historicalDraws[hitIdx + 1];
    const sig = classifyPrecursorSignature(precursorDraw, trackedColor);
    if (sig) precursors.push(sig);
  }
  if (precursors.length < 3) {
    return {
      score: 30,
      dominantSignature: null,
      dominantSharePct: null,
      currentSignature: classifyPrecursorSignature(historicalDraws[0], trackedColor),
      matches: false,
      sampleSize: precursors.length,
      note: 'Insufficient hit history to detect a precursor pattern.'
    };
  }
  const counts = new Map();
  for (const sig of precursors) counts.set(sig, (counts.get(sig) || 0) + 1);
  const [dominantSignature, dominantCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const dominantSharePct = Math.round((dominantCount / precursors.length) * 1000) / 10;
  const currentSignature = classifyPrecursorSignature(historicalDraws[0], trackedColor);
  const matches = currentSignature !== null && currentSignature === dominantSignature;
  const score = matches
    ? clamp(Math.round(40 + dominantSharePct * 0.6), 40, 95)
    : clamp(Math.round(15 + dominantSharePct * 0.2), 10, 40);
  return { score, dominantSignature, dominantSharePct, currentSignature, matches, sampleSize: precursors.length };
}

function computeTransitionPressure(historicalDraws, trackedColor) {
  const marginOf = (d) => {
    if (!d || !d.colorCounts) return null;
    const trackedCount = d.colorCounts[trackedColor] || 0;
    const others = Object.keys(d.colorCounts)
      .filter(c => c !== trackedColor)
      .map(c => d.colorCounts[c] || 0);
    const bestOther = others.length ? Math.max(...others) : 0;
    return trackedCount - bestOther;
  };
  const recent = historicalDraws.slice(0, 6).map(marginOf).filter(v => v !== null);
  if (recent.length < 6) {
    return { score: 30, trend: 'INSUFFICIENT_DATA', newestAvgMargin: null, olderAvgMargin: null };
  }
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const newestAvg = avg(recent.slice(0, 3));
  const olderAvg = avg(recent.slice(3, 6));
  const delta = newestAvg - olderAvg; // positive = tracked color gaining ground = converging toward a hit
  const score = clamp(Math.round(50 + delta * 25), 0, 100);
  const trend = delta > 0.3 ? 'STRENGTHENING' : (delta < -0.3 ? 'WEAKENING' : 'STABLE');
  return {
    score,
    trend,
    newestAvgMargin: Math.round(newestAvg * 10) / 10,
    olderAvgMargin: Math.round(olderAvg * 10) / 10
  };
}

function computeExpectedWindow(intervalScore, patternScore, transitionScore, drawsUntilNextHit) {
  const allAgree = intervalScore >= 60 && patternScore >= 60 && transitionScore >= 60;
  if (!allAgree) {
    return { label: 'NEXT 1-5 DRAWS', fromDraws: 1, toDraws: 5, tightened: false };
  }
  if (drawsUntilNextHit !== null && drawsUntilNextHit <= 1) {
    return { label: 'NEXT 1-2 DRAWS', fromDraws: 1, toDraws: 2, tightened: true };
  }
  return { label: 'NEXT 1-3 DRAWS', fromDraws: 1, toDraws: 3, tightened: true };
}

function computeConfidenceLabel(agreementCount, sufficientSample, effectiveSampleSize) {
  if (!sufficientSample || effectiveSampleSize < 10) return 'LOW';
  if (agreementCount >= 3) return 'HIGH';
  if (agreementCount >= 2) return 'MEDIUM';
  return 'LOW';
}

// --- Season detection (identical walk to tieEngine.js's findTieSeasons) --

function findHitSeasons(hitFlags, maxGap = SEASON_MAX_GAP, minHits = SEASON_MIN_TIES) {
  const hitIndices = [];
  for (let i = hitFlags.length - 1; i >= 0; i--) {
    if (hitFlags[i]) hitIndices.push(i);
  }
  const seasons = [];
  let runIndices = [];
  for (let k = 0; k < hitIndices.length; k++) {
    const idx = hitIndices[k];
    if (runIndices.length === 0) {
      runIndices = [idx];
      continue;
    }
    const prevIdx = runIndices[runIndices.length - 1];
    const gap = prevIdx - idx - 1;
    if (gap <= maxGap) {
      runIndices.push(idx);
    } else {
      if (runIndices.length >= minHits) {
        seasons.push(finalizeSeason(runIndices, maxGap));
      }
      runIndices = [idx];
    }
  }
  if (runIndices.length >= minHits) {
    seasons.push(finalizeSeason(runIndices, maxGap));
  }
  return seasons
    .filter(s => s.spanDraws >= 1 && s.mostRecentHitDrawsAgo <= SEASON_WINDOW_MAX)
    .reverse();
}

function finalizeSeason(runIndices, maxGap = SEASON_MAX_GAP) {
  const oldestIdx = runIndices[0];
  const newestIdx = runIndices[runIndices.length - 1];
  const spanDraws = oldestIdx - newestIdx + 1;
  return {
    hitCount: runIndices.length,
    spanDraws,
    startedDrawsAgo: oldestIdx,
    mostRecentHitDrawsAgo: newestIdx,
    stillActive: newestIdx <= maxGap
  };
}

/**
 * Full 3-ball color hit intelligence analysis, for the given trackedColor
 * (the General Parliament's current predicted winningColor). Mirrors
 * analyzeTies()'s structure and math exactly -- see that function's own
 * header in tieEngine.js for what each block does; only the tracked event
 * (predicted-color hit vs. tie) differs.
 */
function analyzeThreeBallColor(historicalDraws, trackedColor) {
  const draws = historicalDraws || [];
  const total = draws.length;

  if (!trackedColor) {
    return {
      available: false,
      trackedColor: null,
      reasoning: 'No predicted color available yet from the General Parliament.'
    };
  }

  const hitFlags = draws.map(d => isColorHit(d, trackedColor));
  const totalHits = hitFlags.filter(Boolean).length;

  let lastHitDrawsAgo = null;
  let lastHitDrawId = null;
  let lastHitShape = null;
  for (let i = 0; i < draws.length; i++) {
    if (hitFlags[i]) {
      lastHitDrawsAgo = i;
      lastHitDrawId = draws[i].drawId;
      lastHitShape = hitShape(draws[i]);
      break;
    }
  }

  const hitDrawsAgoList = [];
  for (let i = 0; i < draws.length; i++) {
    if (hitFlags[i]) hitDrawsAgoList.push(i);
  }
  const intervals = [];
  for (let i = 0; i < hitDrawsAgoList.length - 1; i++) {
    intervals.push(hitDrawsAgoList[i + 1] - hitDrawsAgoList[i]);
  }
  const avgIntervalDraws = intervals.length > 0
    ? Math.round((intervals.reduce((a, b) => a + b, 0) / intervals.length) * 10) / 10
    : null;
  const medianIntervalDraws = intervals.length > 0
    ? median([...intervals].sort((a, b) => a - b))
    : null;
  const longestGapDraws = intervals.length > 0 ? Math.max(...intervals) : null;
  const shortestGapDraws = intervals.length > 0 ? Math.min(...intervals) : null;
  const mostCommonInterval = intervals.length > 0 ? modeOf(intervals) : null;

  const hitRatePct = total > 0 ? Math.round((totalHits / total) * 1000) / 10 : 0;

  const recentWindow = draws.slice(0, SEASON_WINDOW_MAX);
  const recentHits = recentWindow.filter(d => isColorHit(d, trackedColor)).length;
  const recentRatePct = recentWindow.length > 0
    ? Math.round((recentHits / recentWindow.length) * 1000) / 10
    : 0;

  const seasons = findHitSeasons(hitFlags);
  const activeSeason = seasons.find(s => s.stillActive) || null;

  let currentHitStreak = 0;
  for (let i = 0; i < hitFlags.length; i++) {
    if (hitFlags[i]) currentHitStreak++;
    else break;
  }
  const detectedCycle = mostCommonInterval && intervals.filter(iv => iv === mostCommonInterval).length >= 2
    ? `${trackedColor} hits approximately every ${mostCommonInterval} draw(s)`
    : null;

  // --- Four Intelligence Layers, blended 25/25/25/25 into Hit Pressure ---
  const frequencySignal = computeFrequencyScore(hitRatePct, recentRatePct, recentWindow.length);
  const intervalSignal = computeIntervalScore(avgIntervalDraws, lastHitDrawsAgo);
  const patternSignal = computePatternScore(draws, hitDrawsAgoList, trackedColor);
  const transitionSignal = computeTransitionPressure(draws, trackedColor);

  const hitPressureScore = clamp(Math.round(
    (frequencySignal.score * 0.25) +
    (intervalSignal.score * 0.25) +
    (patternSignal.score * 0.25) +
    (transitionSignal.score * 0.25)
  ), 0, 100);

  const sufficientSample = total >= SEASON_WINDOW_MIN;
  const agreementCount = [frequencySignal.score, intervalSignal.score, patternSignal.score, transitionSignal.score]
    .filter(s => s >= 60).length;
  const confidenceLabel = computeConfidenceLabel(agreementCount, sufficientSample, total);

  // Draws until next hit -- direct read off avg spacing vs. current gap,
  // same "due/overdue" framing as the Tie Engine's own timing metric.
  const drawsUntilNextHit = (avgIntervalDraws !== null && lastHitDrawsAgo !== null)
    ? Math.max(0, Math.round(avgIntervalDraws - lastHitDrawsAgo))
    : null;

  const hitProbabilityPct = clamp(Math.round(
    (hitPressureScore * 0.6) + (recentRatePct * 0.4)
  ), 5, 95);

  const riskLevel = confidenceLabel === 'HIGH' && hitProbabilityPct >= 55 ? 'LOW'
    : confidenceLabel === 'LOW' ? 'HIGH'
    : 'MODERATE';

  const warningScore = hitProbabilityPct;
  const warningLevel = warningScore >= 60 ? 'ELEVATED' : warningScore >= 35 ? 'MODERATE' : 'LOW';

  const expectedWindow = computeExpectedWindow(
    intervalSignal.score, patternSignal.score, transitionSignal.score, drawsUntilNextHit
  );

  const marketStateLabel = activeSeason ? 'ACTIVE HIT SEASON'
    : hitPressureScore >= 60 ? 'BUILDING PRESSURE'
    : 'NO EDGE';

  const operatorAction = hitPressureScore >= 70 ? 'WATCH CLOSELY'
    : hitPressureScore >= 45 ? 'MONITOR'
    : 'NO ACTION';

  const reasoning = activeSeason
    ? `${trackedColor} is in an active hit season: ${activeSeason.hitCount} hits across the last ${activeSeason.spanDraws} draws, most recent ${activeSeason.mostRecentHitDrawsAgo} draw(s) ago.`
    : lastHitDrawsAgo !== null
      ? `Last ${trackedColor} hit was ${lastHitDrawsAgo} draw(s) ago against an average spacing of ${avgIntervalDraws != null ? avgIntervalDraws + ' draws' : 'an undetermined interval'}.`
      : `No ${trackedColor} hits observed yet in the tracked window.`;

  return {
    available: true,
    trackedColor,
    currentHitStreak,
    hitRatePct,
    recentRatePct,
    sampleSize: total,
    sufficientSample,
    detectedCycle,

    lastHit: lastHitDrawId !== null ? {
      drawId: lastHitDrawId,
      drawsAgo: lastHitDrawsAgo,
      shape: lastHitShape
    } : null,

    intervalStats: {
      avgIntervalDraws,
      medianIntervalDraws,
      shortestGapDraws,
      longestGapDraws,
      sampleSize: intervals.length
    },

    activeSeason,

    hitPressureScore,
    hitProbabilityPct,
    confidenceLabel,
    riskLevel,
    warningLevel,
    warningScore,
    drawsUntilNextHit,
    expectedWindow,
    marketStateLabel,
    operatorAction,
    reasoning,

    signals: {
      frequency: frequencySignal,
      interval: intervalSignal,
      pattern: patternSignal,
      transition: transitionSignal
    }
  };
}

module.exports = {
  analyzeThreeBallColor,
  isColorHit,
  hitShape
};
