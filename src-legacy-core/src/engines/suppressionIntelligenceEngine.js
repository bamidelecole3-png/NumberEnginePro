/**
 * Suppression Intelligence Engine — Blueprint Phase 7.
 *
 * "Measure whether explosions follow silence." For each color, computes:
 *
 *   - tierDrought    — draws since this color's most recent 4-ball-or-
 *                       higher event (the meaningful drought; 3-ball
 *                       events are common enough to be noisy on their own).
 *   - colorDrought    — draws since this color's most recent event of ANY
 *                       tier (3-ball or higher) -- a broader "has this
 *                       color done ANYTHING lately" measure.
 *   - rollingActivity — % of the last ACTIVITY_WINDOW draws in which this
 *                       color reached tier 3+.
 *   - tierInactivity  — the complement of rollingActivity, reported as its
 *                       own named figure per the blueprint's metric list.
 *   - tierEntropy     — Shannon entropy of this color's tier-value
 *                       distribution within the window (low = consistent/
 *                       predictable tier behavior, high = erratic).
 *   - recoveryVelocity — change in activity rate between the most recent
 *                       RECENT_SUBWINDOW draws and the rest of the window
 *                       -- positive means picking back up.
 *   - momentumAcceleration — second derivative of tier-weighted activity
 *                       across three successive sub-windows, distinguishing
 *                       "recovering with real (4/5-ball) hits accelerating"
 *                       from "recovering with just noisy 3-ball activity."
 *
 * Classified into DORMANT / SUPPRESSED / RECOVERING / CHARGING / EXPLOSIVE.
 */

'use strict';

const { HIERARCHY } = require('../core/colorMath');
const { mean, shannonEntropyOf } = require('../core/statMath');
const { tierValue } = require('./runwayFeatureEngine');

const ACTIVITY_WINDOW = 20;
const RECENT_SUBWINDOW = 5;
const DROUGHT_SCAN_CAP = 500; // safety cap so a color that has NEVER hit doesn't walk the entire 2000-draw history pointlessly

function droughtSince(historicalDraws, color, minTier) {
  let drought = 0;
  for (const d of historicalDraws) {
    if (tierValue(d, color) >= minTier) return drought;
    drought++;
    if (drought >= DROUGHT_SCAN_CAP) break;
  }
  return drought;
}

function evaluateSuppressionForColor(historicalDraws, color) {
  const window = historicalDraws.slice(0, ACTIVITY_WINDOW);
  const n = window.length;

  if (n === 0) {
    return {
      color, tierDrought: 0, colorDrought: 0, rollingActivity: 0, tierInactivity: 100,
      tierEntropy: 0, recoveryVelocity: 0, momentumAcceleration: 0,
      classification: 'DORMANT', reasoning: `No draw history yet for ${color}.`
    };
  }

  const tierDrought = droughtSince(historicalDraws, color, 4); // since last 4-ball-or-higher
  const colorDrought = droughtSince(historicalDraws, color, 3); // since last 3-ball-or-higher

  const activityCount = window.filter(d => tierValue(d, color) >= 3).length;
  const rollingActivity = Math.round((activityCount / n) * 100);
  const tierInactivity = 100 - rollingActivity;

  const tierCounts = { t0: 0, t3: 0, t4: 0, t5: 0 };
  window.forEach(d => {
    const t = tierValue(d, color);
    if (t === 0) tierCounts.t0++;
    else if (t === 3) tierCounts.t3++;
    else if (t === 4) tierCounts.t4++;
    else tierCounts.t5++;
  });
  const tierEntropy = Math.round(shannonEntropyOf(tierCounts) * 100) / 100;

  const recentSlice = window.slice(0, RECENT_SUBWINDOW);
  const olderSlice = window.slice(RECENT_SUBWINDOW);
  const recentActivityRate = recentSlice.length ? recentSlice.filter(d => tierValue(d, color) >= 3).length / recentSlice.length : 0;
  const olderActivityRate = olderSlice.length ? olderSlice.filter(d => tierValue(d, color) >= 3).length / olderSlice.length : 0;
  const recoveryVelocity = Math.round((recentActivityRate - olderActivityRate) * 100);

  // Three successive RECENT_SUBWINDOW-sized segments (most-recent-first),
  // using tier-WEIGHTED mean rather than binary presence so a recovery
  // built on real 4/5-ball hits reads differently from one built purely
  // on 3-ball noise.
  const segmentTierMean = (start) => {
    const seg = window.slice(start, start + RECENT_SUBWINDOW);
    return seg.length ? mean(seg.map(d => tierValue(d, color))) : 0;
  };
  const segA = segmentTierMean(0);
  const segB = segmentTierMean(RECENT_SUBWINDOW);
  const segC = segmentTierMean(RECENT_SUBWINDOW * 2);
  const velocityAB = segA - segB;
  const velocityBC = segB - segC;
  const momentumAcceleration = Math.round((velocityAB - velocityBC) * 100) / 100;

  let classification;
  if (tierDrought >= ACTIVITY_WINDOW && rollingActivity < 15) {
    classification = 'DORMANT';
  } else if (tierDrought >= 10 && rollingActivity < 35) {
    classification = 'SUPPRESSED';
  } else if (recoveryVelocity > 15 && momentumAcceleration >= 0) {
    classification = recoveryVelocity > 35 ? 'EXPLOSIVE' : 'CHARGING';
  } else if (recoveryVelocity > 0) {
    classification = 'RECOVERING';
  } else {
    classification = rollingActivity >= 35 ? 'CHARGING' : 'SUPPRESSED';
  }

  const reasoning = `${color}: ${tierDrought} draws since last 4-ball+ hit, ${rollingActivity}% rolling activity over the last ${ACTIVITY_WINDOW} draws, recovery velocity ${recoveryVelocity >= 0 ? '+' : ''}${recoveryVelocity} — classified ${classification}`;

  return {
    color,
    tierDrought,
    colorDrought,
    rollingActivity,
    tierInactivity,
    tierEntropy,
    recoveryVelocity,
    momentumAcceleration,
    classification,
    reasoning
  };
}

function evaluateSuppressionIntelligence(historicalDraws) {
  const result = {};
  HIERARCHY.forEach(color => {
    result[color] = evaluateSuppressionForColor(historicalDraws, color);
  });
  return result;
}

module.exports = {
  ACTIVITY_WINDOW,
  RECENT_SUBWINDOW,
  evaluateSuppressionForColor,
  evaluateSuppressionIntelligence
};
