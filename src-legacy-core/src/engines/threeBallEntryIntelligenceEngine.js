/**
 * 3-Ball Entry Intelligence Engine — exact mirror of entryIntelligenceEngine.js
 * (the 4-ball Entry Intelligence Engine), re-keyed to the 3-ball color
 * stream (`threeBallColor`) instead of the 4-ball stream (`fourBallColor`).
 *
 * Every scoring function, threshold, and formula below is copied unchanged
 * from entryIntelligenceEngine.js — ageToScore's age buckets, the tier
 * classification ladder (DO_NOT_TRADE / WAIT / PREPARE / AGGRESSIVE_ENTRY /
 * ENTER / HOLD / EXIT_NOW), tierToOperatorAction, computeWarningLevel,
 * computeRiskLevel, and the entryScore/entryProbability blends are all
 * byte-for-byte identical math. The ONLY changes are:
 *
 *   1. Every place the original reads `d.fourBallColor` now reads
 *      `d.threeBallColor` (computeEntryStreak, detectActiveEntrySeason,
 *      findLastEntry, buildIntervalStats).
 *   2. computeDrawsUntilFirstHit reuses firstAppearanceEngine.js's
 *      buildAppearanceProfile/calculateTimingForecast exactly as the
 *      original does, via the SAME remapping convention already
 *      established elsewhere in this codebase (see
 *      eventIntelligenceEngineCP.js's own call to buildAppearanceProfile,
 *      which remaps its subject stream's color field onto the shape
 *      buildAppearanceProfile expects: `{ fourBallColor: <the color to
 *      track> }`). buildAppearanceProfile only ever reads `d.fourBallColor`
 *      internally, so 3-ball draws are remapped the same way before the
 *      call — no shared engine file is modified.
 *
 * Special-emphasis fields (per the operator's request, these four carry
 * the same weight/shape here as they do for 4-ball):
 *   - activeEntrySeason  (sustained ENTER+ streak detector)
 *   - detectedCycle      (activeEntrySeason.cycleLabel — approximate
 *                          recurrence interval for the tracked color)
 *   - lastEntry           (most recent confirmed 3-ball hit for the color)
 *   - intervalStats       (avg/median/mode/min/max spacing + sample size)
 *
 * Anchoring: unlike the 4-ball engine (which derives its own raw-frequency
 * "dominant color" independently), this engine is always called with the
 * 3-ball General Parliament's own predicted color (winningColor) as
 * `dominantColor` — see generalParliament.js. The 3-ball market already
 * has an 11-engine parliament voting on the predicted color every cycle,
 * so re-deriving a second, independent "dominant color" here would just
 * create a second, possibly-conflicting opinion. This engine's job is to
 * grade the QUALITY/TIMING of an entry into the parliament's own pick,
 * exactly as the 4-ball version grades an entry into that market's
 * season leader.
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
// Age → raw age score (unchanged from entryIntelligenceEngine.js)
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
// Tier → operator action label (unchanged)
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
// Entry warning level — analogous to Tie Warning (unchanged)
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
// Risk level — transition + exit pressure combined (unchanged formula;
// 3-ball has no dedicated Exit Intelligence engine yet, so exitRisk is
// supplied as 0 by generalParliament.js unless/until one exists — this
// keeps riskLevel honest (transition-risk-driven only) rather than
// fabricating a fake exit signal).
// ---------------------------------------------------------------------------
function computeRiskLevel(transitionRisk, exitRisk) {
  const combined = (transitionRisk * 0.55) + ((exitRisk || 0) * 0.45);
  if (combined >= 70) return 'VERY HIGH';
  if (combined >= 50) return 'HIGH';
  if (combined >= 30) return 'MODERATE';
  return 'LOW';
}

// ---------------------------------------------------------------------------
// Entry streak — how many consecutive draws has the current tier been
// ENTER+? (unchanged logic, keyed to threeBallColor)
// ---------------------------------------------------------------------------
function computeEntryStreak(historicalDraws, dominantColor, currentTier) {
  if (!Array.isArray(historicalDraws) || !dominantColor) return 0;
  const safeToEnterTiers = new Set(['AGGRESSIVE_ENTRY', 'ENTER', 'PREPARE']);
  if (!safeToEnterTiers.has(currentTier)) return 0;

  let streak = 0;
  for (const d of historicalDraws) {
    if (normalizeColor(d.threeBallColor) === dominantColor) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

// ---------------------------------------------------------------------------
// Active entry season — sustained ENTER+ window detected? (unchanged
// logic, keyed to threeBallColor). This — plus detectedCycle below — is
// one of the operator's special-emphasis fields.
// ---------------------------------------------------------------------------
function detectActiveEntrySeason(historicalDraws, dominantColor, lookback = 10) {
  if (!Array.isArray(historicalDraws) || !dominantColor) {
    return { active: false, hitsInWindow: 0, windowSize: lookback, mostRecentDrawsAgo: null, cycleLabel: null };
  }
  const window = historicalDraws.slice(0, lookback);
  const hits = window.filter(d => normalizeColor(d.threeBallColor) === dominantColor);
  const hitsInWindow = hits.length;
  const active = hitsInWindow >= 3; // At least 3 hits in last 10 draws = active season

  let mostRecentDrawsAgo = null;
  for (let i = 0; i < historicalDraws.length; i++) {
    if (normalizeColor(historicalDraws[i].threeBallColor) === dominantColor) {
      mostRecentDrawsAgo = i;
      break;
    }
  }

  // Infer approximate recurrence interval -- this is the "Detected Cycle"
  // special-emphasis field.
  const allIndexes = [];
  for (let i = 0; i < Math.min(historicalDraws.length, 40); i++) {
    if (normalizeColor(historicalDraws[i].threeBallColor) === dominantColor) allIndexes.push(i);
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
// Last confirmed entry — which draw was the most recent 3-ball hit?
// (unchanged logic, keyed to threeBallColor). Special-emphasis field.
// ---------------------------------------------------------------------------
function findLastEntry(historicalDraws, dominantColor) {
  if (!Array.isArray(historicalDraws) || !dominantColor) return null;
  for (let i = 0; i < historicalDraws.length; i++) {
    const d = historicalDraws[i];
    if (normalizeColor(d.threeBallColor) === dominantColor) {
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
// Draws-Until-First-Hit calculation (unchanged formula/engine call).
//
// Reuses firstAppearanceEngine.js's buildAppearanceProfile/
// calculateTimingForecast exactly as the 4-ball engine does, via the same
// field-remapping convention eventIntelligenceEngineCP.js already
// established for reusing this machinery on a non-4-ball stream:
// buildAppearanceProfile only ever reads `d.fourBallColor`, so the 3-ball
// draws are remapped onto that shape before the call.
// ---------------------------------------------------------------------------
function computeDrawsUntilFirstHit(historicalDraws, dominantColor) {
  if (!Array.isArray(historicalDraws) || !dominantColor) {
    return { available: false, approximateDraws: null, forecastWindow: null, timingConfidence: null, basis: 'No data.' };
  }

  const remapped = historicalDraws.map(d => ({
    drawId: d.drawId,
    fourBallColor: d.threeBallColor || null,
    threeBallColor: null,
    timestamp: d.timestamp || null
  }));

  const profile = buildAppearanceProfile(remapped, dominantColor);
  const forecast = calculateTimingForecast(profile, {
    // No independent "precursor" market exists below 3-ball, so this is
    // left at its default (0) rather than fabricating a leading indicator
    // the 4-ball version genuinely has (3-ball precursor hits ahead of a
    // 4-ball season). transitionPressure is likewise left at the default.
    precursor3BHits: 0,
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
// Interval stats — how consistent is the entry quality signal? (unchanged
// logic, keyed to threeBallColor). Special-emphasis field.
// ---------------------------------------------------------------------------
function buildIntervalStats(historicalDraws, dominantColor) {
  if (!Array.isArray(historicalDraws) || !dominantColor) return null;

  const lookback = Math.min(historicalDraws.length, 60);
  const window = historicalDraws.slice(0, lookback);

  const hitIndexes = [];
  for (let i = 0; i < window.length; i++) {
    if (normalizeColor(window[i].threeBallColor) === dominantColor) hitIndexes.push(i);
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
// Main export: evaluateThreeBallEntryQuality
// (exact mirror of evaluateEntryQuality — identical thresholds, identical
// weighted blends. Only the exported name and the field-name substitutions
// above differ.)
// ---------------------------------------------------------------------------
function evaluateThreeBallEntryQuality(seasonAge, confidence = 75, dominantColor = 'RED', options = {}) {
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

  // --- Entry-specific timing: draws until first 3-ball hit ---
  const drawsUntilFirstHit = computeDrawsUntilFirstHit(historicalDraws, dominantColor);

  // --- Entry streak ---
  const entryStreak = computeEntryStreak(historicalDraws, dominantColor, tier);

  // --- Active entry season (special emphasis) ---
  const activeEntrySeason = detectActiveEntrySeason(historicalDraws, dominantColor);

  // --- Last confirmed entry (special emphasis) ---
  const lastEntry = findLastEntry(historicalDraws, dominantColor);

  // --- Interval stats (special emphasis) ---
  const intervalStats = buildIntervalStats(historicalDraws, dominantColor);

  // --- Entry probability (0-100) ---
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
    // Core classification (backward-compatible shape with the 4-ball version)
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

    // --- Tier-Engine-depth fields ---
    operatorAction,
    marketStateLabel,
    warningLevel:         warningLevel.label,
    warningLevelPct:      warningLevel.pct,
    riskLevel,
    entryProbability,
    entryStreak,

    // The headline timing metric — "~N draws until first 3-ball hit"
    drawsUntilFirstHit,

    // Special-emphasis fields
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
  evaluateThreeBallEntryQuality
};
