/**
 * Entry Intelligence Engine — upgraded to Tier-Engine depth.
 *
 * Mirrors the analytical richness of tieEngine.js:
 *   - Operator Action  (AGGRESSIVE_ENTRY / ENTER / PREPARE / WAIT / HOLD /
 *                       DO_NOT_TRADE / EXIT_NOW)
 *   - Warning Level    (LOW / MODERATE / HIGH / CRITICAL)
 *   - Risk Level       (LOW / MODERATE / HIGH / VERY HIGH)
 *   - Entry Probability (0-100%)
 *   - Draws Until First 4-Ball Hit  (~N draws, from firstAppearanceEngine timing)
 *   - Current Entry Streak (consecutive draws inside optimal window)
 *   - Season Gate status
 *   - Active Entry Season detection (sustained ENTER+ streaks)
 *   - Interval stats and historical entry-quality log
 *
 * The "draws until first hit" is the key new metric: it answers
 * "how many draws before the predicted 4-ball color is expected to register
 * its first 4-ball ball appearance in this fresh season?" — exactly what the
 * Tie Engine does for ties.
 */

const { buildAppearanceProfile, calculateTimingForecast } = require('./firstAppearanceEngine');

const COLORS = ['RED', 'GREEN', 'BLUE'];

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function normalizeColor(v) {
  if (!v) return null;
  const c = String(v).trim().toUpperCase();
  return COLORS.includes(c) ? c : null;
}

// ---------------------------------------------------------------------------
// Age → raw age score (unchanged from original; keeps scoring stable)
// ---------------------------------------------------------------------------
function ageToScore(age) {
  if (age <= 1)                      return 0.10;
  if (age === 2)                     return 0.30;
  if (age === 3)                     return 0.60;
  if (age >= 4  && age <= 8)         return 1.00;
  if (age >= 9  && age <= 12)        return 0.80;
  if (age >= 13 && age <= 18)        return 0.40;
  return 0.10;
}

// ---------------------------------------------------------------------------
// Tier → operator action label
// ---------------------------------------------------------------------------
function tierToOperatorAction(tier) {
  switch (tier) {
    case 'AGGRESSIVE_ENTRY': return 'EXPLOIT';
    case 'ENTER':            return 'ENTER';
    case 'PREPARE':          return 'PREPARE';
    case 'WAIT':             return 'MONITOR';
    case 'HOLD':             return 'AVOID';
    case 'DO_NOT_TRADE':     return 'AVOID';
    case 'EXIT_NOW':         return 'EXIT';
    default:                 return 'MONITOR';
  }
}

// ---------------------------------------------------------------------------
// Entry warning level — analogous to Tie Warning
// ---------------------------------------------------------------------------
function computeWarningLevel(tier, entryScore) {
  if (tier === 'AGGRESSIVE_ENTRY')            return { label: 'HIGH',     pct: 85 };
  if (tier === 'ENTER' && entryScore >= 0.75) return { label: 'HIGH',     pct: 75 };
  if (tier === 'ENTER')                       return { label: 'MODERATE', pct: 60 };
  if (tier === 'PREPARE')                     return { label: 'MODERATE', pct: 45 };
  if (tier === 'WAIT')                        return { label: 'LOW',      pct: 25 };
  if (tier === 'HOLD')                        return { label: 'LOW',      pct: 15 };
  return                                             { label: 'LOW',      pct: 10 };
}

// ---------------------------------------------------------------------------
// Risk level — transition + exit pressure combined
// ---------------------------------------------------------------------------
function computeRiskLevel(transitionRisk, exitRisk) {
  const combined = (transitionRisk * 0.55) + ((exitRisk || 0) * 0.45);
  if (combined >= 70) return 'VERY HIGH';
  if (combined >= 50) return 'HIGH';
  if (combined >= 30) return 'MODERATE';
  return 'LOW';
}

// ---------------------------------------------------------------------------
// Entry streak — how many consecutive draws has the current tier been ENTER+?
// ---------------------------------------------------------------------------
function computeEntryStreak(historicalDraws, dominantColor, currentTier) {
  // Walk the recent draws (newest first) counting how long the dominant
  // color has consecutively appeared as the 4-ball output — a proxy for
  // how many draws we have been "inside the season window."
  if (!Array.isArray(historicalDraws) || !dominantColor) return 0;
  const safeToEnterTiers = new Set(['AGGRESSIVE_ENTRY', 'ENTER', 'PREPARE']);
  if (!safeToEnterTiers.has(currentTier)) return 0;

  let streak = 0;
  for (const d of historicalDraws) {
    if (normalizeColor(d.fourBallColor) === dominantColor) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

// ---------------------------------------------------------------------------
// Active entry season — sustained ENTER+ window detected?
// Analogous to Tie Engine's "active tie season".
// ---------------------------------------------------------------------------
function detectActiveEntrySeason(historicalDraws, dominantColor, lookback = 10) {
  if (!Array.isArray(historicalDraws) || !dominantColor) {
    return { active: false, hitsInWindow: 0, windowSize: lookback, mostRecentDrawsAgo: null, cycleLabel: null };
  }
  const window = historicalDraws.slice(0, lookback);
  const hits = window.filter(d => normalizeColor(d.fourBallColor) === dominantColor);
  const hitsInWindow = hits.length;
  const active = hitsInWindow >= 3; // At least 3 hits in last 10 draws = active season

  let mostRecentDrawsAgo = null;
  for (let i = 0; i < historicalDraws.length; i++) {
    if (normalizeColor(historicalDraws[i].fourBallColor) === dominantColor) {
      mostRecentDrawsAgo = i;
      break;
    }
  }

  // Infer approximate recurrence interval
  const allIndexes = [];
  for (let i = 0; i < Math.min(historicalDraws.length, 40); i++) {
    if (normalizeColor(historicalDraws[i].fourBallColor) === dominantColor) allIndexes.push(i);
  }
  let cycleLabel = null;
  if (allIndexes.length >= 3) {
    const gaps = [];
    for (let i = 1; i < allIndexes.length; i++) gaps.push(allIndexes[i] - allIndexes[i - 1]);
    if (gaps.length) {
      const avg = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
      cycleLabel = `${dominantColor} appears approximately every ${avg} draw${avg === 1 ? '' : 's'}`;
    }
  }

  return { active, hitsInWindow, windowSize: lookback, mostRecentDrawsAgo, cycleLabel };
}

// ---------------------------------------------------------------------------
// Last confirmed entry — which draw was the most recent 4-ball hit?
// ---------------------------------------------------------------------------
function findLastEntry(historicalDraws, dominantColor) {
  if (!Array.isArray(historicalDraws) || !dominantColor) return null;
  for (let i = 0; i < historicalDraws.length; i++) {
    const d = historicalDraws[i];
    if (normalizeColor(d.fourBallColor) === dominantColor) {
      return {
        drawId: d.drawId,
        drawsAgo: i,
        shape: d.colors ? d.colors.join('-') : null
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Draws-Until-First-Hit calculation
//
// Uses firstAppearanceEngine's timing machinery to answer:
// "Given the current dormancy of the predicted 4-ball color,
//  approximately how many more draws until it registers its first hit?"
//
// This is the Entry Intelligence equivalent of the Tie Engine's
// "Draws Until Next Tie" field.
// ---------------------------------------------------------------------------
function computeDrawsUntilFirstHit(historicalDraws, dominantColor) {
  if (!Array.isArray(historicalDraws) || !dominantColor) {
    return { available: false, approximateDraws: null, forecastWindow: null, timingConfidence: null, basis: 'No data.' };
  }

  const profile = buildAppearanceProfile(historicalDraws, dominantColor);
  const forecast = calculateTimingForecast(profile, {
    precursor3BHits: historicalDraws.slice(0, 5).filter(d => normalizeColor(d.threeBallColor) === dominantColor).length,
    transitionPressure: 0
  });

  if (!forecast.available) {
    return {
      available: false,
      approximateDraws: null,
      forecastWindow: null,
      timingConfidence: null,
      dormancy: profile.dormancy,
      basis: forecast.basis
    };
  }

  return {
    available: true,
    approximateDraws: forecast.approximateDraws,
    forecastWindow: forecast.forecastWindow,
    timingConfidence: forecast.timingConfidence,
    dormancy: profile.dormancy,
    probabilityNext5Draws: forecast.probabilityNext5Draws,
    probabilityNext10Draws: forecast.probabilityNext10Draws,
    probabilityNext20Draws: forecast.probabilityNext20Draws,
    historicalGap: forecast.historicalGap,
    basis: forecast.basis
  };
}

// ---------------------------------------------------------------------------
// Interval stats — how consistent is the entry quality signal?
// Analogous to Tie Engine's interval stats block.
// ---------------------------------------------------------------------------
function buildIntervalStats(historicalDraws, dominantColor) {
  if (!Array.isArray(historicalDraws) || !dominantColor) return null;

  const lookback = Math.min(historicalDraws.length, 60);
  const window = historicalDraws.slice(0, lookback);

  // Collect indexes where dominantColor 4-ball hit
  const hitIndexes = [];
  for (let i = 0; i < window.length; i++) {
    if (normalizeColor(window[i].fourBallColor) === dominantColor) hitIndexes.push(i);
  }

  if (hitIndexes.length < 2) return null;

  const gaps = [];
  for (let i = 1; i < hitIndexes.length; i++) gaps.push(hitIndexes[i] - hitIndexes[i - 1]);

  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sorted = gaps.slice().sort((a, b) => a - b);
  const med = sorted.length % 2
    ? sorted[Math.floor(sorted.length / 2)]
    : (sorted[Math.floor(sorted.length / 2) - 1] + sorted[Math.floor(sorted.length / 2)]) / 2;

  const counts = new Map();
  for (const g of gaps) {
    const k = Math.round(g);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const mode = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];

  return {
    samples: gaps.length,
    avgInterval: Math.round(avg * 10) / 10,
    medianInterval: Math.round(med * 10) / 10,
    modeInterval: mode,
    minInterval: sorted[0],
    maxInterval: sorted[sorted.length - 1],
    lookbackDraws: lookback,
    totalHits: hitIndexes.length
  };
}

// ---------------------------------------------------------------------------
// Main export: evaluateEntryQuality
// ---------------------------------------------------------------------------
function evaluateEntryQuality(seasonAge, confidence = 75, dominantColor = 'RED', options = {}) {
  const age     = Math.max(0, Number(seasonAge)   || 0);
  const conf    = clamp(Number(confidence)         || 0, 0, 100);
  const dominanceScore  = Number(options.dominanceScore)  || 50;
  const transitionRisk  = Number(options.transitionRisk)  || 0;
  const exitRisk        = Number(options.exitRisk)        || 0;
  const historicalDraws = Array.isArray(options.historicalDraws) ? options.historicalDraws : [];

  // --- Age score ---
  const ageScore   = ageToScore(age);
  const confScore  = clamp(conf / 100, 0, 1);
  const domScore   = clamp(dominanceScore / 100, 0, 1);
  const transPenalty = clamp(transitionRisk / 100, 0, 1);

  const rawScore = (
    (ageScore     * 0.35) +
    (confScore    * 0.30) +
    (domScore     * 0.20) +
    ((1.0 - transPenalty) * 0.15)
  );
  const entryScore = Math.round(clamp(rawScore, 0, 1.0) * 100) / 100;

  // --- Tier classification ---
  let tier = 'DO_NOT_TRADE';
  let safeToEnter = false;
  let reasoning = '';

  if (age < 2) {
    tier = 'DO_NOT_TRADE';
    reasoning = `Season age (${age}) too young — minimum 2 required.`;
  } else if (age === 2) {
    tier = 'WAIT';
    reasoning = `Season age ${age}: waiting for draw-3 confirmation.`;
  } else if (age === 3) {
    tier = 'PREPARE';
    safeToEnter = true;
    reasoning = `Season age ${age}: entering preparation window (optimal: draws 4-12).`;
  } else if (age >= 4 && age <= 8 && conf >= 80 && dominanceScore >= 60) {
    tier = 'AGGRESSIVE_ENTRY';
    safeToEnter = true;
    reasoning = `Prime window active (age ${age}), high confidence ${conf}%, dominance ${dominanceScore}%.`;
  } else if (age >= 4 && age <= 12 && conf >= 55) {
    tier = 'ENTER';
    safeToEnter = true;
    reasoning = `Optimal entry window active (age ${age}) — ${dominantColor} leading at ${conf}%.`;
  } else if (age >= 13 && age <= 18) {
    tier = 'HOLD';
    reasoning = `Season in mature/late stage (age ${age}) — new entries restricted.`;
  } else {
    tier = 'EXIT_NOW';
    reasoning = `Season age ${age} exceeds safe limits or transition risk is critical.`;
  }

  const bestEntryWindow = 'Draws 4 – 12';
  const operatorAction  = tierToOperatorAction(tier);
  const warningLevel    = computeWarningLevel(tier, entryScore);
  const riskLevel       = computeRiskLevel(transitionRisk, exitRisk);

  // --- Entry-specific timing: draws until first 4-ball hit ---
  const drawsUntilFirstHit = computeDrawsUntilFirstHit(historicalDraws, dominantColor);

  // --- Entry streak ---
  const entryStreak = computeEntryStreak(historicalDraws, dominantColor, tier);

  // --- Active entry season ---
  const activeEntrySeason = detectActiveEntrySeason(historicalDraws, dominantColor);

  // --- Last confirmed entry ---
  const lastEntry = findLastEntry(historicalDraws, dominantColor);

  // --- Interval stats ---
  const intervalStats = buildIntervalStats(historicalDraws, dominantColor);

  // --- Entry probability (0-100) ---
  // Blends entry score with warning level pct and drawsUntilFirstHit proximity.
  let entryProbability = Math.round(entryScore * 100 * 0.60 + warningLevel.pct * 0.40);
  if (drawsUntilFirstHit.available && drawsUntilFirstHit.approximateDraws <= 3) {
    entryProbability = Math.min(94, entryProbability + 10);
  }
  entryProbability = clamp(entryProbability, 0, 94);

  // --- Market state label ---
  const marketStateLabel =
    tier === 'AGGRESSIVE_ENTRY' ? 'PRIME ENTRY WINDOW' :
    tier === 'ENTER'            ? 'ENTRY WINDOW OPEN'  :
    tier === 'PREPARE'          ? 'APPROACH WINDOW'    :
    tier === 'WAIT'             ? 'STANDBY'            :
    tier === 'HOLD'             ? 'LATE SEASON'        :
    tier === 'EXIT_NOW'         ? 'EXIT ZONE'          :
                                  'INACTIVE';

  return {
    // Core classification (backward-compatible with original callers)
    tier,
    entryScore,
    safeToEnter,
    bestEntryWindow,
    reasoning,
    factors: {
      ageScore:     Math.round(ageScore    * 100),
      confScore:    Math.round(confScore   * 100),
      domScore:     Math.round(domScore    * 100),
      transPenalty: Math.round(transPenalty * 100)
    },

    // --- New Tier-Engine-depth fields ---
    operatorAction,
    marketStateLabel,
    warningLevel:         warningLevel.label,
    warningLevelPct:      warningLevel.pct,
    riskLevel,
    entryProbability,
    entryStreak,

    // The headline new metric — "~N draws until first 4-ball hit"
    drawsUntilFirstHit,

    activeEntrySeason,
    lastEntry,
    intervalStats,

    // Raw inputs echoed for UI display
    seasonAge:      age,
    dominantColor:  normalizeColor(dominantColor) || dominantColor,
    seasonConfidence: conf,
    dominanceScore,
    transitionRisk,
    exitRisk
  };
}

module.exports = {
  evaluateEntryQuality
};
