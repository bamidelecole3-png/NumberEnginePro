'use strict';

/**
 * 4-Ball First Appearance / Return Timing Engine.
 *
 * Purpose:
 *   Identify the strongest dormant 4-ball color AND estimate when its next
 *   appearance is most likely to register, expressed explicitly as
 *   "approximately N draws".
 *
 * The timing forecast is empirical. It combines:
 *   - historical inter-appearance gaps;
 *   - conditional residual life (what happened after similar dormancies);
 *   - recent gap behaviour;
 *   - current dormancy pressure;
 *   - 3-ball precursor activity;
 *   - transition pressure when supplied by the caller;
 *   - prior certified first-appearance memory when supplied.
 *
 * No forecast can guarantee an exact future draw. "approximately N draws"
 * is the engine's point estimate from the available history, while the
 * forecastWindow / horizon probabilities expose the uncertainty explicitly.
 */

const { HIERARCHY, argMaxColorBy } = require('../core/colorMath');

const COLORS = HIERARCHY.filter(c => ['RED', 'GREEN', 'BLUE'].includes(c));
const LOOKBACK_4B = 60;
const RECENT_GAPS = 8;
const MIN_GAP_SAMPLES = 3;
const MAX_FORECAST_DRAWS = 60;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(values, q) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function normalizeColor(value) {
  if (!value) return null;
  const c = String(value).trim().toUpperCase();
  return COLORS.includes(c) ? c : null;
}

/**
 * historicalDraws is newest-first, matching the project's central store.
 * Returns chronological appearance indexes and inter-appearance gaps.
 */
function buildAppearanceProfile(historicalDraws, color) {
  const draws = Array.isArray(historicalDraws) ? historicalDraws.slice(0, LOOKBACK_4B) : [];
  const chronological = draws.slice().reverse();
  const indexes = [];

  chronological.forEach((d, i) => {
    if (normalizeColor(d.fourBallColor) === color) indexes.push(i);
  });

  const gaps = [];
  for (let i = 1; i < indexes.length; i++) {
    gaps.push(indexes[i] - indexes[i - 1]);
  }

  // Distance from the newest draw to the most recent appearance.
  const newestIndex = chronological.length - 1;
  const lastAppearanceIndex = indexes.length ? indexes[indexes.length - 1] : -1;
  const dormancy = indexes.length ? newestIndex - lastAppearanceIndex : chronological.length;

  return {
    appearanceCount: indexes.length,
    gaps,
    recentGaps: gaps.slice(-RECENT_GAPS),
    dormancy,
    lastAppearanceDrawId: indexes.length ? chronological[lastAppearanceIndex].drawId : null
  };
}

function conditionalResidualForecast(gaps, dormancy) {
  if (!gaps.length) return { residual: null, sampleSize: 0 };

  // Conditional residual life: only historical gaps that survived at least
  // as long as today's dormancy are relevant to a color that has not fired yet.
  const surviving = gaps.filter(g => g >= dormancy);
  if (surviving.length) {
    const residuals = surviving.map(g => Math.max(1, g - dormancy));
    return {
      residual: mean(residuals),
      sampleSize: surviving.length
    };
  }

  // If today's dormancy is longer than every historical gap, the empirical
  // dataset has no true right-tail examples. Do NOT collapse that uncertainty
  // to a false "1 draw" forecast. Use a conservative half-typical-gap
  // residual and explicitly report zero conditional samples.
  const typical = median(gaps);
  return {
    residual: typical == null ? null : Math.max(1, Math.round(typical * 0.5)),
    sampleSize: 0
  };
}

function horizonProbability(gaps, dormancy, horizon) {
  if (!gaps.length) return null;
  const eligible = gaps.filter(g => g >= dormancy);
  if (!eligible.length) return null;
  const hit = eligible.filter(g => g <= dormancy + horizon).length;
  return Math.round((hit / eligible.length) * 100);
}

function calculateTimingForecast(profile, context = {}) {
  const gaps = profile.gaps.filter(g => Number.isFinite(g) && g > 0);
  const recentGaps = profile.recentGaps.filter(g => Number.isFinite(g) && g > 0);
  const dormancy = Math.max(0, profile.dormancy);

  if (!gaps.length) {
    return {
      available: false,
      approximateDraws: null,
      projectedReturnGap: null,
      forecastWindow: null,
      probabilityNext5Draws: null,
      probabilityNext10Draws: null,
      probabilityNext20Draws: null,
      timingConfidence: 20,
      basis: 'No historical 4-ball return gaps for this color.'
    };
  }

  const avgGap = mean(gaps);
  const medianGap = median(gaps);
  const recentAvg = mean(recentGaps) || avgGap;
  const conditional = conditionalResidualForecast(gaps, dormancy);

  // Three independent point estimates. Conditional residual receives the
  // highest weight because it answers the actual question: "given that the
  // color has already been dormant this long, how much longer is typical?"
  const conditionalResidual = conditional.residual != null
    ? conditional.residual
    : Math.max(1, medianGap - Math.min(dormancy, medianGap));
  const medianResidual = Math.max(1, medianGap - Math.min(dormancy, medianGap));
  const recentResidual = Math.max(1, recentAvg - Math.min(dormancy, recentAvg));

  let point = 0.55 * conditionalResidual + 0.25 * medianResidual + 0.20 * recentResidual;

  // 3-ball precursor and transition pressure are leading indicators. They
  // may pull the forecast earlier, but only modestly so they cannot erase
  // the empirical gap model.
  const precursor = clamp(Number(context.precursor3BHits || 0), 0, 5);
  const transitionPressure = clamp(Number(context.transitionPressure || 0), 0, 100);
  const precursorPull = Math.min(0.18, precursor * 0.025);
  const transitionPull = transitionPressure >= 60 ? 0.10 : transitionPressure >= 40 ? 0.05 : 0;
  point *= (1 - precursorPull - transitionPull);

  // If the color has already exceeded its normal gap, increase urgency but
  // never force a zero-draw prediction.
  if (dormancy > medianGap) {
    const overdueFactor = clamp((dormancy - medianGap) / Math.max(medianGap, 1), 0, 0.35);
    point *= (1 - overdueFactor * 0.35);
  }

  const approximateDraws = clamp(Math.max(1, Math.round(point)), 1, MAX_FORECAST_DRAWS);
  const q25Residual = Math.round(quantile(gaps, 0.25) - dormancy);
  const q75Residual = Math.round(quantile(gaps, 0.75) - dormancy);
  const low = Math.max(1, q25Residual);
  const high = conditional.sampleSize > 0
    ? Math.max(approximateDraws, q75Residual)
    : Math.max(approximateDraws, Math.round(avgGap * 0.75));
  const forecastWindow = {
    fromDraws: clamp(low, 1, MAX_FORECAST_DRAWS),
    toDraws: clamp(high, 1, MAX_FORECAST_DRAWS)
  };

  const p5 = horizonProbability(gaps, dormancy, 5);
  const p10 = horizonProbability(gaps, dormancy, 10);
  const p20 = horizonProbability(gaps, dormancy, 20);

  const sampleStrength = clamp(gaps.length / 10, 0, 1);
  const spread = Math.abs(avgGap - medianGap) / Math.max(avgGap, 1);
  const consistency = clamp(1 - spread, 0, 1);
  const conditionalStrength = clamp(conditional.sampleSize / Math.max(3, gaps.length), 0, 1);
  const timingConfidence = Math.round(clamp(
    45 + sampleStrength * 25 + consistency * 15 + conditionalStrength * 15,
    35,
    94
  ));

  return {
    available: true,
    approximateDraws,
    projectedReturnGap: Math.round(dormancy + point),
    forecastWindow,
    probabilityNext5Draws: p5,
    probabilityNext10Draws: p10,
    probabilityNext20Draws: p20,
    timingConfidence,
    historicalGap: {
      average: Math.round(avgGap * 10) / 10,
      median: Math.round(medianGap * 10) / 10,
      recentAverage: Math.round(recentAvg * 10) / 10,
      samples: gaps.length,
      conditionalSamples: conditional.sampleSize
    },
    basis: `Conditional residual ${Math.round(conditionalResidual * 10) / 10} draws, median residual ${Math.round(medianResidual * 10) / 10}, recent residual ${Math.round(recentResidual * 10) / 10}.`
  };
}

function evaluateFirstAppearance(historicalDraws) {
  const draws = Array.isArray(historicalDraws) ? historicalDraws : [];
  const currentWindow = draws.slice(0, 15);
  const active4BColors = new Set(currentWindow.map(d => normalizeColor(d.fourBallColor)).filter(Boolean));
  const dormantColors = COLORS.filter(c => !active4BColors.has(c));

  if (dormantColors.length === 0) {
    return {
      active: false,
      breakoutColor: null,
      confidence: 0,
      reasoning: 'All 4-ball colors have appeared inside the current 15-draw window; no first-appearance candidate is dormant.',
      candidates: [],
      nextAppearance: null
    };
  }

  const breakoutScores = {};
  const candidates = dormantColors.map(color => {
    const profile = buildAppearanceProfile(draws, color);
    const recent5 = currentWindow.slice(0, 5);
    const precursor3BHits = recent5.filter(d => normalizeColor(d.threeBallColor) === color).length;
    const profileForecast = calculateTimingForecast(profile, { precursor3BHits });

    // Stronger score = closer to the color's historically expected return,
    // meaningful dormancy, and evidence that the color is waking up through
    // the 3-ball market.
    const avgGap = profileForecast.historicalGap?.average || 0;
    const medianGap = profileForecast.historicalGap?.median || avgGap || 0;
    let dormancyScore = 0;
    if (avgGap > 0) {
      const distance = Math.abs(profile.dormancy - avgGap);
      dormancyScore = clamp(100 - (distance / Math.max(avgGap * 0.75, 4)) * 70, 10, 100);
      if (profile.dormancy >= medianGap) dormancyScore = Math.min(100, dormancyScore + 10);
    } else {
      dormancyScore = clamp(profile.dormancy * 4, 0, 80);
    }

    const precursorScore = clamp(precursor3BHits * 20, 0, 100);
    const timingScore = profileForecast.available
      ? clamp(100 - Math.max(0, profileForecast.approximateDraws - 1) * 5, 25, 100)
      : 25;
    const sampleScore = profileForecast.available
      ? clamp(profileForecast.historicalGap.samples * 8, 0, 80)
      : 0;

    const score = Math.round(clamp(
      dormancyScore * 0.30 +
      timingScore * 0.30 +
      precursorScore * 0.20 +
      sampleScore * 0.20,
      0, 100
    ));

    breakoutScores[color] = score;
    return {
      color,
      birthScore: score,
      dormancy: profile.dormancy,
      projectedReturnGap: profileForecast.projectedReturnGap,
      forecast: profileForecast,
      components: {
        dormancyScore: Math.round(dormancyScore),
        timingScore: Math.round(timingScore),
        precursor3BScore: Math.round(precursorScore),
        historicalSampleScore: Math.round(sampleScore)
      },
      precursor3BHits
    };
  });

  candidates.sort((a, b) => b.birthScore - a.birthScore);
  const top = candidates[0];
  const breakoutColor = top ? top.color : argMaxColorBy(breakoutScores);
  const confidence = top ? Math.min(94, Math.max(55, top.birthScore)) : 55;

  const supportingEvidenceCount = top
    ? [
        top.components.dormancyScore >= 55,
        top.components.timingScore >= 55,
        top.precursor3BHits > 0,
        top.forecast && top.forecast.historicalGap && top.forecast.historicalGap.samples >= MIN_GAP_SAMPLES
      ].filter(Boolean).length
    : 0;

  const timing = top && top.forecast && top.forecast.available ? top.forecast : null;
  const timingText = timing
    ? `Next ${breakoutColor} 4-ball appearance is approximately ${timing.approximateDraws} draw${timing.approximateDraws === 1 ? '' : 's'} away (forecast window ${timing.forecastWindow.fromDraws}-${timing.forecastWindow.toDraws}, timing confidence ${timing.timingConfidence}%).`
    : `Insufficient 4-ball return history to project an approximate draw count for ${breakoutColor}.`;

  return {
    active: true,
    breakoutColor,
    confidence,
    certified: confidence >= 65 && supportingEvidenceCount >= 2,
    confirmationThreshold: 65,
    supportingEvidenceCount,
    topCandidate: top,
    candidates,
    nextAppearance: timing ? {
      color: breakoutColor,
      approximatelyDraws: timing.approximateDraws,
      forecastWindow: timing.forecastWindow,
      timingConfidence: timing.timingConfidence,
      probabilityNext5Draws: timing.probabilityNext5Draws,
      probabilityNext10Draws: timing.probabilityNext10Draws,
      probabilityNext20Draws: timing.probabilityNext20Draws
    } : null,
    reasoning: `Dormant ${breakoutColor} has the strongest first-appearance profile. ${timingText}`
  };
}

module.exports = {
  evaluateFirstAppearance,
  buildAppearanceProfile,
  calculateTimingForecast
};
