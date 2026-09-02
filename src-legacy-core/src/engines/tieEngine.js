/**
 * Tie Intelligence Engine module -- 3-Ball market ONLY.
 *
 * SCOPE (per the clarified upgrade spec): Tie detection, learning,
 * forecasting, and statistics apply exclusively to the 3-Ball Color
 * Engine. The 4-Ball Color Engine evaluates all six balls under its own
 * 4-of-6 methodology and does not experience the same color-dominance
 * ambiguity, so no tie concept applies there. A prior iteration of this
 * file added analyzeFourBallTies()/isFourBallTie()/fourBallTieShape() --
 * those have been removed. If 4-ball tie tracking is ever reintroduced,
 * it must be a deliberate, separately-scoped decision, not a byproduct of
 * generalizing this module.
 *
 * TIE DEFINITION (fixed):
 * A tie is ANY 3-ball draw that fails to produce a definite single-color
 * winner. Previously this was implemented as "the top two color counts are
 * equal", which only catches symmetric splits like 2-2-2 or 3-3-0. That
 * definition is wrong: it misses genuine no-winner draws like RED:2,
 * BLUE:1, GREEN:1 (the max color never reached the winning threshold of 3)
 * or RED:2, BLUE:1, GREEN:0 -- both of which are "no clear 3-ball winner"
 * in real terms, just not symmetric splits. These asymmetric no-winner
 * shapes happen whenever one or more of the 6 drawn balls is the special
 * "yellow" #49 ball, which maps to none of RED/BLUE/GREEN (validator.js's
 * parseItem() already silently drops any non RED/BLUE/GREEN entry from
 * colorsList/colorCounts, so a draw can legitimately have fewer than 6
 * colored balls -- this is exactly the "2-2-1 with Yellow" example from
 * the spec).
 *
 * The correct, threshold-based rule: a tie is whenever the 3-ball market's
 * own winner field is null. validator.js already computes this correctly
 * -- threeBallColor is only ever set when EXACTLY ONE color reaches
 * count===3 AND no color reached 4 or 5 (see validator.js's two-pass
 * resolution). So:
 *
 *   3-ball tie  <=>  !threeBallColor && !fourBallColor
 *
 * (the fourBallColor check matters because a count>=4 draw
 * is a real 4-ball win, not a "no 3-ball winner" tie -- it's just not a
 * 3-ball-tier event at all.)
 *
 * historicalDraws is newest-first (index 0 = most recent), matching every
 * other engine's convention (see gapEvolutionEngine.js).
 */
const { HIERARCHY } = require('../core/colorMath');
const { clamp } = require('../core/isotonic');

const SEASON_WINDOW_MIN = 10; // "10-15 draw windows" per spec
const SEASON_WINDOW_MAX = 15;
const SEASON_MAX_GAP = 2;      // "after one or two draws continuously" -- a
                                // season survives a gap of up to 2 non-tie
                                // draws between consecutive ties before it's
                                // considered broken/ended.
const SEASON_MIN_TIES = 3;     // minimum tie count within the window to call
                                // it a genuine recurring season, not noise.

/**
 * Recommendation #4: Wilson score confidence interval for a binomial
 * proportion (hits/n). Preferred over a naive normal approximation
 * (p ± z*sqrt(p(1-p)/n)) because the naive version produces nonsensical
 * bounds (below 0% or above 100%) for exactly the small-n cases this
 * engine most needs to communicate honestly about -- Wilson stays within
 * [0,1] by construction and is well-behaved even at n as low as 3-5.
 * z=1.96 -> 95% confidence interval.
 */
function wilsonScoreInterval(hits, n, z = 1.96) {
  if (n <= 0) return { lowerPct: 0, upperPct: 100, widthPct: 100 };
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  const lower = Math.max(0, (center - margin) / denom);
  const upper = Math.min(1, (center + margin) / denom);
  return {
    lowerPct: Math.round(lower * 1000) / 10,
    upperPct: Math.round(upper * 1000) / 10,
    widthPct: Math.round((upper - lower) * 1000) / 10
  };
}

/**
 * Recommendation #2: calibrate the raw formula-derived tie probability
 * against REAL historical hit-rate data, using the same shrinkage
 * philosophy as core/isotonic.js's applyCalibration() (blend toward the
 * empirical rate, weighted by how much empirical data actually exists,
 * rather than either fully trusting the hand-tuned formula or fully
 * trusting a possibly-thin sample).
 *
 * calibrationData shape (built by council.js from store.tierForecastLog):
 *   { byRiskLevel: { LOW: {sampleSize, tieRatePct}, MODERATE: {...}, HIGH: {...}, 'VERY HIGH': {...} } }
 * where tieRatePct is the empirical share of SCORED forecasts made at
 * that risk level whose next draw actually was a tie -- i.e. "of all the
 * times this engine said HIGH risk, how often was the next draw really a
 * tie." riskLevel (not marketStateLabel) is used as the calibration key
 * because it's derived purely from warningScore, independent of
 * tieProbabilityPct itself -- calibrating against a bucket that the
 * probability being calibrated doesn't influence avoids circularity.
 *
 * Trust in the empirical rate scales with sample size: fewer than 5
 * scored observations at this risk level and the raw formula dominates
 * (empirical data too thin to trust); 5-20 observations blend the two;
 * 20+ observations let the empirical rate dominate.
 */
function calibrateTieProbability(rawProbabilityPct, riskLevel, calibrationData) {
  const bucket = calibrationData && calibrationData.byRiskLevel && calibrationData.byRiskLevel[riskLevel];
  if (!bucket || bucket.sampleSize < 5) {
    return rawProbabilityPct;
  }
  // Shrinkage weight: 0 at sampleSize=5, approaches 1 as sampleSize grows,
  // reaching ~0.75 at 20 observations and asymptoting toward 1.
  const trust = Math.min(0.9, (bucket.sampleSize - 5) / (bucket.sampleSize - 5 + 15));
  const blended = (rawProbabilityPct * (1 - trust)) + (bucket.tieRatePct * trust);
  return clamp(Math.round(blended), 5, 95);
}

// --- Tie Pressure signal engines (blueprint upgrade) -----------------------
//
// The four signals below are independent reads on the same underlying
// draw history, each scored 0-100, then blended 25/25/25/25 into a single
// TIE PRESSURE SCORE. None of these functions replace or remove any of
// the existing statistics (tieRatePct, intervalStats, seasons, etc.) --
// they're new layers computed ALONGSIDE that data inside analyzeTies()
// below, using numbers that data already provides.

/**
 * Frequency Engine: blends the long-run baseline tie rate with the
 * recent-window tie rate. Score sits at 50 when the recent rate exactly
 * matches baseline (no signal either way), rises above 50 when recent
 * draws are running hotter than history, falls below 50 when colder.
 */
function computeFrequencyScore(tieRatePct, recentRatePct, recentWindowSize) {
  if (recentWindowSize < 3) return { score: 30, note: 'Insufficient recent-window sample.' };
  const delta = recentRatePct - tieRatePct;
  const score = clamp(Math.round(50 + delta * 3), 0, 100);
  return { score, tieRatePct, recentRatePct, deltaPct: Math.round(delta * 10) / 10 };
}

/**
 * Interval Engine: how close is the CURRENT gap (draws since the last
 * tie) to the historically expected gap (average interval)? A gap right
 * at the average scores ~70 ("due"); a gap well past average ("overdue")
 * scores up to 100; a gap still well short of average scores low (too
 * early to expect one yet).
 */
function computeIntervalScore(avgIntervalDraws, lastTieDrawsAgo) {
  if (avgIntervalDraws === null || avgIntervalDraws <= 0 || lastTieDrawsAgo === null) {
    return { score: 25, ratio: null, note: 'Not enough interval history yet.' };
  }
  const ratio = lastTieDrawsAgo / avgIntervalDraws;
  const score = ratio >= 1
    ? clamp(Math.round(70 + (ratio - 1) * 60), 0, 100)
    : clamp(Math.round(ratio * 70), 0, 100);
  return { score, ratio: Math.round(ratio * 100) / 100 };
}

/**
 * Classifies a draw's color-count "shape" by the margin between the
 * leading color and the runner-up -- the structural signature the
 * Pattern Engine looks for immediately BEFORE a tie:
 *   EVEN   -- leader and runner-up already level (margin 0)
 *   NARROW -- one-ball margin (e.g. 3-2-1, 2-1-1)
 *   WIDE   -- two or more ball margin (e.g. 4-1-1, 3-1-0)
 */
function classifyPrecursorSignature(draw) {
  if (!draw || !draw.colorCounts) return null;
  const counts = HIERARCHY.map(c => draw.colorCounts[c] || 0).sort((a, b) => b - a);
  const margin = counts[0] - counts[1];
  if (margin <= 0) return 'EVEN';
  if (margin === 1) return 'NARROW';
  return 'WIDE';
}

/**
 * Pattern Engine: does a recurring 3-ball structure precede this market's
 * ties? For every historical tie, looks at the draw immediately BEFORE it
 * (chronologically) and classifies its shape via classifyPrecursorSignature.
 * Finds the most common precursor shape across all ties, then checks
 * whether the CURRENT most-recent draw (the precursor to the next,
 * not-yet-seen draw) matches that dominant shape. A match against a
 * strongly dominant pattern scores high; no match (or a weak/no pattern
 * at all) scores low.
 *
 * historicalDraws: newest-first. tieIndices: indices (into
 * historicalDraws) of every historical tie, oldest-first (as produced by
 * findTieSeasons' internal walk) -- recomputed locally here instead since
 * analyzeTies has its own newest-first tieDrawsAgoList already.
 */
function computePatternScore(historicalDraws, tieDrawsAgoList) {
  const precursors = [];
  for (const tieIdx of tieDrawsAgoList) {
    const precursorDraw = historicalDraws[tieIdx + 1]; // one draw further back in time
    const sig = classifyPrecursorSignature(precursorDraw);
    if (sig) precursors.push(sig);
  }
  if (precursors.length < 3) {
    return { score: 30, dominantSignature: null, dominantSharePct: null, currentSignature: classifyPrecursorSignature(historicalDraws[0]), matches: false, sampleSize: precursors.length, note: 'Insufficient tie history to detect a precursor pattern.' };
  }
  const counts = new Map();
  for (const sig of precursors) counts.set(sig, (counts.get(sig) || 0) + 1);
  const [dominantSignature, dominantCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const dominantSharePct = Math.round((dominantCount / precursors.length) * 1000) / 10;
  const currentSignature = classifyPrecursorSignature(historicalDraws[0]);
  const matches = currentSignature !== null && currentSignature === dominantSignature;

  const score = matches
    ? clamp(Math.round(40 + dominantSharePct * 0.6), 40, 95)
    : clamp(Math.round(15 + dominantSharePct * 0.2), 10, 40);

  return { score, dominantSignature, dominantSharePct, currentSignature, matches, sampleSize: precursors.length };
}

/**
 * Transition Engine: is the market's underlying color-count structure
 * CURRENTLY moving toward a tie? Compares the average leader/runner-up
 * margin (see classifyPrecursorSignature's margin concept, kept
 * continuous here rather than bucketed) over the most recent 3 draws
 * against the 3 draws before that. A shrinking margin (colors converging
 * toward an even split) raises the score; a widening margin (a color
 * pulling away, moving further from tie territory) lowers it.
 */
function computeTransitionPressure(historicalDraws) {
  const marginOf = (d) => {
    if (!d || !d.colorCounts) return null;
    const counts = HIERARCHY.map(c => d.colorCounts[c] || 0).sort((a, b) => b - a);
    return counts[0] - counts[1];
  };
  const recent = historicalDraws.slice(0, 6).map(marginOf).filter(v => v !== null);
  if (recent.length < 6) {
    return { score: 30, trend: 'INSUFFICIENT_DATA', newestAvgMargin: null, olderAvgMargin: null };
  }
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const newestAvg = avg(recent.slice(0, 3));
  const olderAvg = avg(recent.slice(3, 6));
  const delta = olderAvg - newestAvg; // positive = margins shrinking = converging toward tie
  const score = clamp(Math.round(50 + delta * 25), 0, 100);
  const trend = delta > 0.3 ? 'NARROWING' : (delta < -0.3 ? 'WIDENING' : 'STABLE');
  return {
    score,
    trend,
    newestAvgMargin: Math.round(newestAvg * 10) / 10,
    olderAvgMargin: Math.round(olderAvg * 10) / 10
  };
}

/**
 * Expected Window (spec section 5): replaces an overly precise "next tie
 * in exactly N draws" claim with a range. Only tightens from the default
 * wide window when the Interval, Pattern, AND Transition signals all
 * independently agree (each scoring >= 60) -- deliberately excludes the
 * Frequency signal from the agreement gate, per spec wording ("Only
 * tighten the window when interval + pattern + transition signals
 * agree").
 */
function computeExpectedWindow(intervalScore, patternScore, transitionScore, drawsUntilNextTie) {
  const allAgree = intervalScore >= 60 && patternScore >= 60 && transitionScore >= 60;
  if (!allAgree) {
    return { label: 'NEXT 1-5 DRAWS', fromDraws: 1, toDraws: 5, tightened: false };
  }
  if (drawsUntilNextTie !== null && drawsUntilNextTie <= 1) {
    return { label: 'NEXT 1-2 DRAWS', fromDraws: 1, toDraws: 2, tightened: true };
  }
  return { label: 'NEXT 1-3 DRAWS', fromDraws: 1, toDraws: 3, tightened: true };
}

/**
 * Confidence label (spec section 3 -- kept separate from riskLevel and
 * tieProbabilityPct). Reflects how many of the four signals actually
 * agree AND whether there's enough real sample size behind the read, not
 * just how high the pressure score happens to be -- a high score built
 * from one strong signal and three weak/insufficient ones is a WEAKER
 * claim than the same score built from broad agreement.
 */
function computeConfidenceLabel(agreementCount, sufficientSample, effectiveSampleSize) {
  if (!sufficientSample || effectiveSampleSize < 10) return 'LOW';
  if (agreementCount >= 3) return 'HIGH';
  if (agreementCount >= 2) return 'MEDIUM';
  return 'LOW';
}

// --- 3-Ball tie detection ---------------------------------------------------


function isThreeBallTie(draw) {
  if (!draw) return false;
  return !draw.threeBallColor && !draw.fourBallColor;
}

// Back-compat: detectTie() historically meant "3-ball tie" everywhere it
// was called in this codebase (dashboard, council.js). Keep that meaning
// -- it's the only tie concept in this module now.
function detectTie(draw) {
  return isThreeBallTie(draw);
}

function tieShape(draw) {
  if (!draw || !draw.colorCounts) return null;
  if (!isThreeBallTie(draw)) return null;
  const entries = HIERARCHY.map(c => ({ color: c, count: draw.colorCounts[c] || 0 }));
  const sorted = [...entries].sort((a, b) => b.count - a.count);
  const [a, b, c] = sorted;

  if (a.count === b.count && b.count === c.count) {
    return a.count === 0
      ? 'no colored balls landed (all wildcard/yellow)'
      : `${a.count}-${a.count}-${a.count} (three-way even split)`;
  }
  if (a.count === b.count) {
    return `${a.count}-${a.count}-${c.count} (${a.color}/${b.color} even, ${c.color} trails)`;
  }
  // Asymmetric no-winner shape -- e.g. 2-1-1, 2-1-0, 1-1-0 -- the max
  // color never reached the winning threshold of 3. Covers the spec's
  // "2-2-1 with Yellow" example when one ball is the wildcard #49.
  return `${a.count}-${b.count}-${c.count} (no color reached 3)`;
}

/**
 * Walks the tie/non-tie sequence (newest-first) and finds "seasons": runs
 * of ties where consecutive ties are separated by no more than maxGap
 * non-tie draws, with at least minTies occurrences.
 *
 * maxGap/minTies default to the live SEASON_MAX_GAP/SEASON_MIN_TIES
 * constants but can be overridden -- this is what lets
 * sweepSeasonParameters() below evaluate alternative parameter choices
 * against real logged history (Recommendation #3) without needing a
 * second, duplicated implementation of the season-detection walk.
 */
function findTieSeasons(tieFlags, maxGap = SEASON_MAX_GAP, minTies = SEASON_MIN_TIES) {
  const tieIndices = [];
  for (let i = tieFlags.length - 1; i >= 0; i--) {
    if (tieFlags[i]) tieIndices.push(i);
  }
  // tieIndices is now chronological (oldest -> newest): largest index
  // (oldest draw) first, smallest index (newest draw) last.

  const seasons = [];
  let runIndices = [];

  for (let k = 0; k < tieIndices.length; k++) {
    const idx = tieIndices[k];
    if (runIndices.length === 0) {
      runIndices = [idx];
      continue;
    }
    const prevIdx = runIndices[runIndices.length - 1];
    const gap = prevIdx - idx - 1; // non-tie draws between the two ties
    if (gap <= maxGap) {
      runIndices.push(idx);
    } else {
      if (runIndices.length >= minTies) {
        seasons.push(finalizeSeason(runIndices, maxGap));
      }
      runIndices = [idx];
    }
  }
  if (runIndices.length >= minTies) {
    seasons.push(finalizeSeason(runIndices, maxGap));
  }

  return seasons
    // A season qualifies if its MOST RECENT tie is within the 10-15 draw
    // recency window, regardless of how long the season's total span is.
    // (A season that started 20 draws ago and is still firing today is
    // still an active season; one whose most recent tie was >
    // SEASON_WINDOW_MAX draws ago is stale and correctly excluded.)
    .filter(s => s.spanDraws >= 1 && s.mostRecentTieDrawsAgo <= SEASON_WINDOW_MAX)
    .reverse(); // newest season first, matching codebase convention
}

function finalizeSeason(runIndices, maxGap = SEASON_MAX_GAP) {
  const oldestIdx = runIndices[0];
  const newestIdx = runIndices[runIndices.length - 1];
  const spanDraws = oldestIdx - newestIdx + 1;
  return {
    tieCount: runIndices.length,
    spanDraws,
    startedDrawsAgo: oldestIdx,
    mostRecentTieDrawsAgo: newestIdx,
    stillActive: newestIdx <= maxGap
  };
}

/**
 * Full tie intelligence analysis for the 3-ball market: historical
 * tracking (count, rate, last occurrence, intervals), frequency analysis
 * (rolling window density), season detection, and a forward-looking
 * tieWarning (probability/confidence/risk level + explanation) that the
 * 3-ball parliament can use to temper its own confidence.
 */
function analyzeTies(historicalDraws, calibrationData) {
  const draws = historicalDraws || [];
  const total = draws.length;

  const tieFlags = draws.map(detectTie);
  const totalTies = tieFlags.filter(Boolean).length;

  let lastTieDrawsAgo = null;
  let lastTieDrawId = null;
  let lastTieShape = null;
  for (let i = 0; i < draws.length; i++) {
    if (tieFlags[i]) {
      lastTieDrawsAgo = i;
      lastTieDrawId = draws[i].drawId;
      lastTieShape = tieShape(draws[i]);
      break;
    }
  }

  // Interval statistics between consecutive ties (spec: "average spacing",
  // "median spacing", "most common interval lengths").
  const tieDrawsAgoList = [];
  for (let i = 0; i < draws.length; i++) {
    if (tieFlags[i]) tieDrawsAgoList.push(i);
  }
  const intervals = [];
  for (let i = 0; i < tieDrawsAgoList.length - 1; i++) {
    // tieDrawsAgoList is newest-first; interval = gap between two
    // consecutive ties in actual draw count.
    intervals.push(tieDrawsAgoList[i + 1] - tieDrawsAgoList[i]);
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

  const tieRatePct = total > 0 ? Math.round((totalTies / total) * 1000) / 10 : 0;

  const recentWindow = draws.slice(0, SEASON_WINDOW_MAX);
  const recentTies = recentWindow.filter(detectTie).length;
  const recentRatePct = recentWindow.length > 0
    ? Math.round((recentTies / recentWindow.length) * 1000) / 10
    : 0;

  const seasons = findTieSeasons(tieFlags);
  const activeSeason = seasons.find(s => s.stillActive) || null;

  // Current streak: consecutive ties ending at the most recent draw (0 if
  // the most recent draw wasn't a tie). Distinguished from "cycle" (the
  // repeating interval length, e.g. "tie every 2 draws") per spec section 4.
  let currentTieStreak = 0;
  for (let i = 0; i < tieFlags.length; i++) {
    if (tieFlags[i]) currentTieStreak++;
    else break;
  }
  const detectedCycle = mostCommonInterval && intervals.filter(iv => iv === mostCommonInterval).length >= 2
    ? `Tie approximately every ${mostCommonInterval} draw(s)`
    : null;

  // ── Tie Pressure Score (blueprint upgrade, spec section 3) ───────────────
  // Four independent signals, each 0-100, blended 25/25/25/25. Computed
  // here (rather than after warningScore below) because riskLevel now
  // derives from tiePressureScore instead of the legacy warningScore
  // formula -- see computeIntervalScore/computePatternScore/
  // computeTransitionPressure/computeFrequencyScore's own headers for what
  // each signal actually measures.
  const frequencySignal = computeFrequencyScore(tieRatePct, recentRatePct, recentWindow.length);
  const intervalSignal = computeIntervalScore(avgIntervalDraws, lastTieDrawsAgo);
  const patternSignal = computePatternScore(draws, tieDrawsAgoList);
  const transitionSignal = computeTransitionPressure(draws);

  const tiePressureScore = Math.round(
    (frequencySignal.score * 0.25) +
    (intervalSignal.score * 0.25) +
    (patternSignal.score * 0.25) +
    (transitionSignal.score * 0.25)
  );

  // Signal agreement count: how many of the four independently cross a
  // "meaningfully elevated" bar (>=60). Drives both confidenceLabel and
  // the TIE APPROACHING market-state gate below -- spec section 4 requires
  // TIE APPROACHING to need multiple supporting signals, not probability
  // alone.
  const agreementCount = [frequencySignal.score, intervalSignal.score, patternSignal.score, transitionSignal.score]
    .filter(s => s >= 60).length;

  // Forward-looking warning: combines (a) whether we're currently inside a
  // recognized tie season, (b) how hot the recent 10-15 draw window is
  // relative to the baseline rate, (c) how recently the last tie hit, and
  // (d) whether the current gap since the last tie matches a detected
  // repeating cycle (i.e. "due" for the next tie in the pattern).
  // Deliberately conservative -- "elevated risk ahead", not a hard
  // prediction of the exact next draw. NOTE: kept unchanged as the input
  // to tieProbabilityPct's blend formula below (probability and pressure
  // are deliberately separate metrics per spec section 3 -- this legacy
  // score now feeds ONLY probability, not risk/market-state anymore).
  let warningScore = 0;

  if (activeSeason) {
    warningScore += 45 + Math.min(25, activeSeason.tieCount * 5);
  }
  if (recentRatePct > tieRatePct * 1.5 && recentWindow.length >= SEASON_WINDOW_MIN) {
    warningScore += 20;
  }
  if (lastTieDrawsAgo !== null && lastTieDrawsAgo <= 1) {
    warningScore += 15; // a tie just happened -- seasons often continue back-to-back
  }
  if (mostCommonInterval && lastTieDrawsAgo !== null && lastTieDrawsAgo >= mostCommonInterval - 1) {
    warningScore += 10; // due, per the detected cycle length
  }
  warningScore = Math.min(95, warningScore);

  let warningLevel;
  if (tiePressureScore >= 60) warningLevel = 'HIGH';
  else if (tiePressureScore >= 30) warningLevel = 'ELEVATED';
  else warningLevel = 'LOW';

  // Risk level per spec section 6 (Low / Moderate / High / Very High) --
  // now driven by tiePressureScore (the unified 4-signal blend) instead of
  // the legacy single-formula warningScore, since Risk is one of the four
  // headline metrics (Pressure/Probability/Confidence/Risk) the upgrade
  // spec wants sourced from the same pressure read.
  let riskLevel;
  if (tiePressureScore >= 75) riskLevel = 'VERY HIGH';
  else if (tiePressureScore >= 55) riskLevel = 'HIGH';
  else if (tiePressureScore >= 30) riskLevel = 'MODERATE';
  else riskLevel = 'LOW';

  const rawTieProbabilityPct = Math.min(90, Math.max(5, Math.round(
    (recentRatePct * 0.6) + (warningScore * 0.4)
  )));

  // Recommendation #2: calibrate the raw formula-based probability against
  // REAL historical hit-rate data from the forecast log, instead of
  // trusting the hand-blended (recentRatePct*0.6 + warningScore*0.4)
  // formula's weights at face value. calibrationData is supplied by the
  // caller (council.js) from store.tierForecastLog -- see
  // calibrateTieProbability()'s header below for the blending method.
  // Falls back to the raw formula unchanged when no calibration data is
  // available yet (e.g. fresh install, or analyzeTies() called directly
  // without a caller that tracks history -- keeps this function callable
  // standalone/in tests without requiring the full store wiring).
  const tieProbabilityPct = calibrateTieProbability(rawTieProbabilityPct, riskLevel, calibrationData);

  // Recommendation #4: a 90% probability backed by 3 observations and a
  // 90% probability backed by 60 observations are very different claims,
  // but rendered identically before this. Attach a Wilson-score 95%
  // confidence interval so consumers (the dashboard, council.js's
  // decision trace) can show the uncertainty, not just the point estimate.
  // Effective sample size: the calibration bucket's sampleSize when
  // calibration actually had enough data to meaningfully move the
  // estimate (matching calibrateTieProbability()'s own >=5 threshold),
  // otherwise the recentWindow sample the raw formula itself leans on --
  // whichever number of observations actually informed the figure being
  // reported is the one the interval should be honest about.
  const calibrationBucket = calibrationData && calibrationData.byRiskLevel && calibrationData.byRiskLevel[riskLevel];
  const effectiveSampleSize = (calibrationBucket && calibrationBucket.sampleSize >= 5)
    ? calibrationBucket.sampleSize
    : recentWindow.length;
  const effectiveHits = (calibrationBucket && calibrationBucket.sampleSize >= 5)
    ? Math.round((calibrationBucket.tieRatePct / 100) * calibrationBucket.sampleSize)
    : recentTies;
  const tieProbabilityCI = wilsonScoreInterval(effectiveHits, effectiveSampleSize);
  const tieProbabilityConfidenceNote = effectiveSampleSize < SEASON_WINDOW_MIN
    ? `Provisional -- based on only ${effectiveSampleSize} observation(s), 95% CI is wide (±${Math.round(tieProbabilityCI.widthPct / 2 * 10) / 10}pp). Treat as a rough signal, not a precise figure.`
    : `Based on ${effectiveSampleSize} observations, 95% CI ±${Math.round(tieProbabilityCI.widthPct / 2 * 10) / 10}pp.`;

  const reasoningParts = [];
  if (activeSeason) {
    reasoningParts.push(`Active tie season: ${activeSeason.tieCount} ties across the last ${activeSeason.spanDraws} draws, most recent ${activeSeason.mostRecentTieDrawsAgo} draw(s) ago.`);
  } else if (totalTies === 0) {
    reasoningParts.push('No ties observed yet in the tracked window.');
  } else {
    reasoningParts.push(`No active tie season. Last tie was ${lastTieDrawsAgo} draw(s) ago (${lastTieShape || 'unknown split'}). Baseline tie rate ${tieRatePct}% over ${total} draws.`);
  }
  if (detectedCycle) {
    reasoningParts.push(`${detectedCycle} recently (most common interval).`);
  }
  const reasoning = reasoningParts.join(' ');

  // ── Tie Pressure → Market State → Action (blueprint upgrade) ─────────────
  //
  // The Tier Engine's job is NOT to predict which color wins — it is to
  // turn the four independent signals above into a market-state read so
  // operators can position accordingly:
  //
  //   Frequency + Interval + Pattern + Transition → Tie Pressure
  //   → Market State → Action
  //
  // rather than simply displaying historical tie statistics.

  // drawsUntilNextTie: remaining draws before reaching the historically
  // expected next tie. Zero = overdue. null = not enough interval history
  // to project (requires at least 2 recorded gaps between consecutive ties).
  // lastTieDrawsAgo is newest-first index (0 = tie just happened this draw).
  const drawsUntilNextTie = (avgIntervalDraws !== null && lastTieDrawsAgo !== null)
    ? Math.max(0, Math.round(avgIntervalDraws - lastTieDrawsAgo))
    : null;

  // tieApproaching: kept as a simple boolean convenience flag (probability
  // OR interval projection), but note this is NOT what gates the
  // TIE_APPROACHING market state below anymore -- that now requires
  // multiple independently-agreeing signals per spec section 4.
  const tieApproaching = tieProbabilityPct >= 50
    || (drawsUntilNextTie !== null && drawsUntilNextTie <= 2);

  // Expected Window (spec section 5) -- computed before marketStateLabel
  // since TIE_APPROACHING's classification below reads its `tightened`
  // flag as part of the multi-signal agreement requirement.
  const expectedWindow = computeExpectedWindow(intervalSignal.score, patternSignal.score, transitionSignal.score, drawsUntilNextTie);

  // marketStateLabel: six states (spec section 4), evaluated in strict
  // priority order so they are always mutually exclusive. TIE_APPROACHING
  // deliberately requires >=2 agreeing signals (agreementCount), not
  // probability or pressure score alone -- a single strong signal (e.g.
  // frequency) with three flat/insufficient ones should NOT read as
  // "approaching".
  //
  //   NO_EDGE         — not enough sample to say anything (thin history).
  //   TIE_ACTIVE       — a tie is happening right now: last draw was itself
  //                       a tie, or we're inside a back-to-back cluster.
  //   TIE_APPROACHING  — high pressure AND multiple signals agree. Stand by.
  //   TIE_BUILDING     — pressure is rising with some signal support, but
  //                       not yet strong/broad enough to call approaching.
  //   TIE_COOLING      — a tie just happened (<=3 draws ago) and pressure
  //                       has already eased back down. Market resetting.
  //   NORMAL           — baseline conditions, nothing elevated.
  let marketStateLabel;
  if (total < SEASON_WINDOW_MIN) {
    marketStateLabel = 'NO_EDGE';
  } else if ((lastTieDrawsAgo !== null && lastTieDrawsAgo === 0) || (activeSeason && currentTieStreak >= 2)) {
    marketStateLabel = 'TIE_ACTIVE';
  } else if (tiePressureScore >= 65 && agreementCount >= 3) {
    marketStateLabel = 'TIE_APPROACHING';
  } else if (tiePressureScore >= 45 && agreementCount >= 2) {
    marketStateLabel = 'TIE_BUILDING';
  } else if (lastTieDrawsAgo !== null && lastTieDrawsAgo <= 3 && tiePressureScore < 45) {
    marketStateLabel = 'TIE_COOLING';
  } else {
    marketStateLabel = 'NORMAL';
  }

  // operatorAction: single clear directive derived directly from
  // marketStateLabel (spec section 7). Four states, deliberately more
  // conservative in wording than the old EXPLOIT/AVOID vocabulary --
  // never presents a weak statistical signal as a strong prediction:
  //   READY      — tie active right now: position accordingly.
  //   WATCH      — approaching: multiple signals agreeing, stay close.
  //   MONITOR    — building or cooling: early/fading signal, just track it.
  //   NO_ACTION  — normal or no-edge: nothing actionable right now.
  let operatorAction;
  if (marketStateLabel === 'TIE_ACTIVE') {
    operatorAction = 'READY';
  } else if (marketStateLabel === 'TIE_APPROACHING') {
    operatorAction = 'WATCH';
  } else if (marketStateLabel === 'TIE_BUILDING' || marketStateLabel === 'TIE_COOLING') {
    operatorAction = 'MONITOR';
  } else {
    operatorAction = 'NO_ACTION';
  }

  // Confidence label (spec section 3) -- separate from riskLevel and
  // tieProbabilityPct, see computeConfidenceLabel's header.
  const confidenceLabel = computeConfidenceLabel(agreementCount, total >= SEASON_WINDOW_MIN, effectiveSampleSize);

  // Reasoning panel (spec section 8): every alert explains itself by
  // naming WHICH signals are contributing, not just restating the score.
  const signalReasons = [];
  if (intervalSignal.score >= 60) {
    signalReasons.push(intervalSignal.ratio >= 1
      ? 'current gap is at or past the historical average spacing'
      : 'current gap is approaching the historical average spacing');
  }
  if (patternSignal.matches && patternSignal.score >= 60) {
    signalReasons.push(`recurring pre-tie structure detected (${patternSignal.dominantSignature} margin, seen ${patternSignal.dominantSharePct}% of prior ties)`);
  }
  if (transitionSignal.trend === 'NARROWING') {
    signalReasons.push('transition pressure increasing (color margins narrowing)');
  }
  if (frequencySignal.score >= 60) {
    signalReasons.push(`recent tie rate (${recentRatePct}%) running hot vs baseline (${tieRatePct}%)`);
  }
  const reasoningWhy = signalReasons.length > 0
    ? `Why: ${signalReasons.join(' + ')}.`
    : (total < SEASON_WINDOW_MIN
      ? `Why: insufficient sample (${total} draws) for a confident read.`
      : 'Why: no signals currently elevated -- baseline conditions.');

  // Market-state-aware alert: leads with the operator directive, not just
  // the raw probability — replaces the old "Warning: High probability…" text.
  const alert = tiePressureScore >= 60
    ? `Market State: ${marketStateLabel} — Tie Pressure ${tiePressureScore}/100. Operator action: ${operatorAction}. ${reasoningWhy}`
    : (tiePressureScore >= 30
      ? `Market State: ${marketStateLabel} — Elevated tie pressure. Operator action: ${operatorAction}. ${reasoningWhy}`
      : null);

  return {
    tier: '3-ball',
    sufficientSample: total >= SEASON_WINDOW_MIN,
    sampleSize: total,
    totalTies,
    tieRatePct,
    recentWindowDraws: recentWindow.length,
    recentTies,
    recentRatePct,
    lastTie: lastTieDrawsAgo !== null ? {
      drawId: lastTieDrawId,
      drawsAgo: lastTieDrawsAgo,
      shape: lastTieShape
    } : null,
    intervalStats: {
      count: intervals.length,
      avgIntervalDraws,
      medianIntervalDraws,
      longestGapDraws,
      shortestGapDraws,
      mostCommonInterval
    },
    currentTieStreak,
    detectedCycle,
    seasons,
    activeSeason,

    // ── Tie Pressure Score (blueprint upgrade, spec section 3) ──────────
    // Kept top-level and separate from tiePrediction.tieProbabilityPct --
    // Pressure and Probability are deliberately different metrics.
    tiePressure: {
      score: tiePressureScore,
      agreementCount,               // how many of the 4 signals are elevated (>=60)
      signals: {
        frequency: frequencySignal,
        interval: intervalSignal,
        pattern: patternSignal,
        transition: transitionSignal
      }
    },
    expectedWindow,
    confidenceLabel,

    tiePrediction: {
      tieProbabilityPct,
      // Recommendation #4: confidence interval around tieProbabilityPct,
      // so a probability backed by 3 observations isn't rendered with the
      // same implied precision as one backed by 60.
      tieProbabilityCI,
      tieProbabilityConfidenceNote,
      tieProbabilitySampleSize: effectiveSampleSize,
      confidenceScore: tiePressureScore,
      riskLevel,
      confidenceLabel,
      // ── Market-state answers (blueprint upgrade) ──
      marketStateLabel,
      operatorAction,
      tieApproaching,
      drawsUntilNextTie,
      expectedWindow,
      tiePressureScore,
      // ─────────────────────────────────────────────
      alert
    },
    tieWarning: {
      level: warningLevel,
      score: tiePressureScore,
      reasoning: `${reasoning} ${reasoningWhy}`.trim()
    },
    // Top-level aliases so consumers can reach market-state answers without
    // drilling into tiePrediction. All values are the same objects
    // computed above — no second derivation.
    marketStateLabel,
    operatorAction,
    tieApproaching,
    drawsUntilNextTie,
    tiePressureScore,
    confidenceLabel
  };
}

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

/**
 * Recommendation #3: sweep candidate (maxGap, minTies) season-detection
 * parameters against REAL ingested draw history and report which
 * combination's "active season" flag best predicts the next draw actually
 * being a tie, compared to the unconditional baseline tie rate.
 *
 * This does NOT change live behavior -- SEASON_MAX_GAP/SEASON_MIN_TIES
 * (the constants findTieSeasons()/analyzeTies() use by default) are
 * untouched. This is a diagnostic: it walks historicalDraws exactly the
 * way analyzeTies() does at every historical point in time (using only
 * draws that would have been available AT that point -- no lookahead),
 * evaluates findTieSeasons() with each candidate parameter pair, and
 * measures whether "active season" under that pairing actually correlated
 * with the next draw being a tie more often than base rate. The result
 * tells a human operator whether the current defaults (gap=2, minTies=3)
 * are well-chosen or whether a different pairing would have performed
 * better on the data actually observed so far -- changing the live
 * constants remains a deliberate decision for a person to make from this
 * report, not something this function does automatically.
 *
 * historicalDraws: newest-first, same convention as analyzeTies().
 * candidateGaps/candidateMinTies: arrays of values to try; defaults cover
 * a reasonable neighborhood around the current constants.
 * minEvaluations: a candidate pairing needs at least this many historical
 * "active season" occurrences to be reported (thin-sample pairings are
 * included in the raw results but flagged low-confidence rather than
 * hidden, so the report is honest about what it doesn't know yet).
 */
function sweepSeasonParameters(historicalDraws, options = {}) {
  const draws = historicalDraws || [];
  const candidateGaps = options.candidateGaps || [1, 2, 3, 4];
  const candidateMinTies = options.candidateMinTies || [2, 3, 4, 5];
  const minEvaluations = options.minEvaluations != null ? options.minEvaluations : 5;

  const tieFlags = draws.map(detectTie);
  const totalDraws = draws.length;

  if (totalDraws < SEASON_WINDOW_MIN + 5) {
    return {
      sufficientHistory: false,
      totalDraws,
      minimumRequired: SEASON_WINDOW_MIN + 5,
      results: [],
      currentDefault: { maxGap: SEASON_MAX_GAP, minTies: SEASON_MIN_TIES },
      recommendation: null
    };
  }

  // Unconditional baseline: across every point in history where there was
  // a "next draw" to check, what fraction of those next draws were ties.
  // Walk oldest-to-newest by index (recall index 0 = newest, so higher
  // index = older draw = earlier point in time).
  let baselineEvals = 0, baselineHits = 0;
  for (let idx = totalDraws - 2; idx >= 0; idx--) {
    baselineEvals++;
    if (tieFlags[idx]) baselineHits++;
  }
  const baselineRatePct = baselineEvals > 0 ? Math.round((baselineHits / baselineEvals) * 1000) / 10 : 0;

  const results = [];
  for (const maxGap of candidateGaps) {
    for (const minTies of candidateMinTies) {
      let evaluations = 0;
      let hits = 0;
      // At each historical point t (draw index idx, walking from oldest
      // testable point to newest), reconstruct "what analyzeTies would
      // have seen" as draws[idx..end] (everything from that point
      // backward in time, newest-first slice starting at idx), run
      // findTieSeasons with the candidate params, and check whether an
      // active season detected AT that point predicted THE NEXT draw
      // (index idx-1, which is chronologically after idx) being a tie.
      for (let idx = totalDraws - 2; idx >= 0; idx--) {
        const historyAtT = draws.slice(idx); // newest-first slice: draws[idx] is "now"
        const flagsAtT = historyAtT.map(detectTie);
        const seasons = findTieSeasons(flagsAtT, maxGap, minTies);
        const activeSeason = seasons.find(s => s.stillActive);
        if (!activeSeason) continue; // only scoring the "season active" claim, matching the actionable-call scoping used elsewhere in this module

        evaluations++;
        if (tieFlags[idx - 1]) hits++; // idx-1 is the next (more recent) draw after "now"
      }

      const hitRatePct = evaluations > 0 ? Math.round((hits / evaluations) * 1000) / 10 : null;
      const liftPct = hitRatePct !== null ? Math.round((hitRatePct - baselineRatePct) * 10) / 10 : null;

      results.push({
        maxGap,
        minTies,
        evaluations,
        hitRatePct,
        liftPct,
        sufficientSample: evaluations >= minEvaluations,
        isCurrentDefault: maxGap === SEASON_MAX_GAP && minTies === SEASON_MIN_TIES
      });
    }
  }

  // Best candidate: highest lift over baseline among pairings with enough
  // evaluations to trust. Ties broken by higher evaluation count (more
  // trustworthy estimate), then by preferring the current default (avoid
  // recommending a change on a marginal, possibly-noise difference).
  const trustworthy = results.filter(r => r.sufficientSample && r.hitRatePct !== null);
  let best = null;
  for (const r of trustworthy) {
    if (!best || r.liftPct > best.liftPct
        || (r.liftPct === best.liftPct && r.evaluations > best.evaluations)) {
      best = r;
    }
  }

  const currentDefaultResult = results.find(r => r.isCurrentDefault) || null;

  let recommendation;
  if (!best) {
    recommendation = 'Insufficient scored history at any parameter pairing to recommend a change -- keep current defaults until more draws accumulate.';
  } else if (best.isCurrentDefault) {
    recommendation = `Current defaults (gap=${SEASON_MAX_GAP}, minTies=${SEASON_MIN_TIES}) are already the best-performing pairing tested (+${best.liftPct}pp lift over baseline, n=${best.evaluations}). No change recommended.`;
  } else if (currentDefaultResult && best.liftPct - (currentDefaultResult.liftPct || 0) < 3) {
    recommendation = `Best pairing (gap=${best.maxGap}, minTies=${best.minTies}, +${best.liftPct}pp lift) only marginally beats current defaults (+${currentDefaultResult.liftPct}pp) -- difference is within likely noise (n=${best.evaluations}); no change recommended yet.`;
  } else {
    recommendation = `gap=${best.maxGap}, minTies=${best.minTies} outperformed current defaults (gap=${SEASON_MAX_GAP}, minTies=${SEASON_MIN_TIES}) by ${Math.round((best.liftPct - (currentDefaultResult ? currentDefaultResult.liftPct : 0)) * 10) / 10}pp lift (n=${best.evaluations}). Consider updating SEASON_MAX_GAP/SEASON_MIN_TIES in tieEngine.js -- review the full results table first, this is a point-in-time read on current history, not a guarantee it holds going forward.`;
  }

  return {
    sufficientHistory: true,
    totalDraws,
    baseline: { evaluations: baselineEvals, hits: baselineHits, ratePct: baselineRatePct },
    currentDefault: { maxGap: SEASON_MAX_GAP, minTies: SEASON_MIN_TIES, result: currentDefaultResult },
    results: results.sort((a, b) => (b.liftPct ?? -999) - (a.liftPct ?? -999)),
    best,
    recommendation
  };
}

module.exports = {
  detectTie,
  isThreeBallTie,
  tieShape,
  analyzeTies,
  calibrateTieProbability,
  sweepSeasonParameters,
  wilsonScoreInterval
};
