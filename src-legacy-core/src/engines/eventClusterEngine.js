/**
 * Event Cluster Engine — Blueprint Phase 10 (Knowledge Clustering).
 *
 * Rather than treating every 5-ball event as an independent occurrence,
 * this engine names which recurring PATTERN the current moment most
 * resembles, using the seven cluster types the blueprint explicitly
 * names:
 *
 *   MOMENTUM_EXPLOSION   — rapidly rising appearance rate right now
 *                          (runway momentumSlope/windowAcceleration both
 *                          strongly positive).
 *   COMPRESSION_RELEASE  — activity has been tightly bunched into the
 *                          recent part of the window (high
 *                          compressionScore) after a quieter start,
 *                          consistent with pressure that built up and is
 *                          now discharging.
 *   LATE_CYCLE_RETURN    — this color is overdue relative to its own gap
 *                          distribution (gapDistribution's forecast
 *                          already flags lateWarning/extremeDelayAlert)
 *                          AND has a history of eventually returning
 *                          after long gaps.
 *   SHORT_GAP_REPEAT     — this color's current open gap is unusually
 *                          SHORT relative to its own distribution (the
 *                          mirror case of LATE_CYCLE_RETURN) -- it just
 *                          fired and its own history says a repeat soon
 *                          is plausible.
 *   LONG_GAP_RECOVERY    — suppressionIntelligenceEngine classifies this
 *                          color RECOVERING or better after a real
 *                          drought (tierDrought was substantial).
 *   TIER_ESCALATION      — crossTierProgressionEngine has this color
 *                          actively sitting on an unescalated 3-ball or
 *                          4-ball rung with a real ladderScore.
 *   PRESSURE_RELEASE     — rivalPressureEngine identifies this color as
 *                          the bestReleaseCandidate against a currently
 *                          dominant rival.
 *
 * A color's current moment can genuinely match more than one archetype
 * at once (e.g. overdue AND on an active ladder rung) -- this engine
 * scores every archetype's fit and returns them ranked, not a forced
 * single label, since collapsing to one name would throw away real
 * information when two patterns are both present.
 *
 * HONESTY NOTE: these are pattern-matching labels applied to the CURRENT
 * moment's own already-computed engine outputs (gap distribution,
 * suppression classification, progression ladder, rival pressure,
 * runway vector) -- this engine adds no new statistics of its own, it
 * only names which combination of existing signals is active and how
 * strongly. The taxonomy itself (these seven names, these thresholds) is
 * a reasonable, documented judgment call, not a scientifically derived
 * clustering from unsupervised learning over the data -- a real
 * k-means/hierarchical clustering pass would require a much larger
 * historical signature library than this system currently builds (see
 * signatureVectorEngine.js's MIN_LIBRARY_SIZE_FOR_MATCHING) to be
 * meaningful, and is a reasonable future upgrade path rather than
 * something this pass fabricates evidence for today.
 *
 * Pure function of the ALREADY-COMPUTED per-color outputs from the other
 * Phase 3/5/6/7/8 engines (passed in, not recomputed here) plus the
 * current runway vector -- keeps this engine cheap and avoids importing
 * every other engine's internals just to re-derive numbers they already
 * produced this same cycle.
 */

'use strict';

const { HIERARCHY } = require('../core/colorMath');

// Minimum fit score (0-100) for an archetype to be included in a color's
// active cluster list at all -- below this, "matches" would mostly be
// noise (e.g. a mildly positive momentumSlope isn't a real "explosion").
const MIN_FIT_SCORE = 40;

function clamp0to100(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

// MOMENTUM_EXPLOSION: strongly positive momentumSlope AND windowAcceleration
// both agreeing the color is heating up right now, not just one weak signal.
function fitMomentumExplosion(runwayFeatures) {
  if (!runwayFeatures) return 0;
  const { momentumSlope, windowAcceleration } = runwayFeatures;
  // momentumSlope is a per-step regression slope of a 0/1 series, so its
  // practical range is small (see normalizeVector's divisor of 0.5 for
  // this field) -- scale accordingly rather than assuming a 0-100 range.
  const slopeFit = clamp0to100((momentumSlope / 0.4) * 100);
  const accelFit = clamp0to100(windowAcceleration + 50);
  // Require both signals to genuinely agree (average, not max) -- a
  // strong slope with flat/negative acceleration is climbing steadily,
  // not "exploding" right now.
  return clamp0to100((slopeFit * 0.5) + (accelFit * 0.5));
}

// COMPRESSION_RELEASE: high compressionScore (most of the window's
// activity is in the recent half) combined with real overall activity --
// a color that's simply inactive scores 0% compression trivially and
// shouldn't be labeled as "releasing" anything.
function fitCompressionRelease(runwayFeatures) {
  if (!runwayFeatures) return 0;
  const { compressionScore, rollingDensity } = runwayFeatures;
  if (rollingDensity < 15) return 0; // too inactive overall for "release" to mean anything
  return clamp0to100(compressionScore);
}

// LATE_CYCLE_RETURN: gap distribution's own forecast already flags this
// color as overdue -- lean on that existing z-score-based figure rather
// than re-deriving a second overdue metric.
function fitLateCycleReturn(gapDistEntry) {
  if (!gapDistEntry || !gapDistEntry.forecast) return 0;
  const { gapZScore, lateWarning, extremeDelayAlert } = gapDistEntry.forecast;
  if (!lateWarning) return 0;
  const base = extremeDelayAlert ? 85 : 55;
  // Extra credit scaled by how far over the z-threshold, capped so a
  // wildly extreme z doesn't blow past 100.
  const zBonus = gapZScore != null ? clamp0to100(gapZScore * 8) : 0;
  return clamp0to100(base + zBonus * 0.2);
}

// SHORT_GAP_REPEAT: mirror case -- current gap is unusually SHORT
// (negative z-score) relative to this color's own distribution, meaning
// it just fired recently relative to its normal rhythm.
function fitShortGapRepeat(gapDistEntry) {
  if (!gapDistEntry || !gapDistEntry.forecast) return 0;
  const { gapZScore } = gapDistEntry.forecast;
  if (gapZScore == null || gapZScore >= -0.5) return 0;
  return clamp0to100(Math.abs(gapZScore) * 35);
}

// LONG_GAP_RECOVERY: suppressionIntelligenceEngine already classifies
// this -- RECOVERING/CHARGING/EXPLOSIVE after a real drought is exactly
// what this archetype names. Reuse its classification directly rather
// than re-deriving drought/recovery math.
const RECOVERY_CLASS_FIT = { EXPLOSIVE: 90, CHARGING: 70, RECOVERING: 50, SUPPRESSED: 0, DORMANT: 0 };
function fitLongGapRecovery(suppressionEntry) {
  if (!suppressionEntry) return 0;
  const base = RECOVERY_CLASS_FIT[suppressionEntry.classification] || 0;
  if (base === 0) return 0;
  // Only counts as "recovery FROM a long gap" (not just "currently
  // active") when there was a real drought to recover from.
  if (suppressionEntry.tierDrought < 8) return Math.round(base * 0.4);
  return base;
}

// TIER_ESCALATION: crossTierProgressionEngine already computes exactly
// this -- an active, unescalated ladder rung with a real score.
function fitTierEscalation(progressionEntry) {
  if (!progressionEntry) return 0;
  if (progressionEntry.ladderPosition === 'OFF_LADDER') return 0;
  return clamp0to100(progressionEntry.ladderScore);
}

// PRESSURE_RELEASE: rivalPressureEngine already identifies the single
// best release candidate system-wide with a real historical release
// probability -- this color gets that fit score only if IT is that
// candidate, 0 otherwise (this is inherently a single-winner archetype
// per moment, unlike the others which are computed independently per
// color).
function fitPressureRelease(rivalPressure, color) {
  if (!rivalPressure || !rivalPressure.isDominanceActive) return 0;
  if (rivalPressure.bestReleaseCandidate !== color) return 0;
  return clamp0to100(rivalPressure.bestReleaseProbability || 0);
}

function classifyClustersForColor(color, context) {
  const { runwayFeatures, gapDistEntry, suppressionEntry, progressionEntry, rivalPressure } = context;

  const fits = [
    { cluster: 'MOMENTUM_EXPLOSION', score: fitMomentumExplosion(runwayFeatures) },
    { cluster: 'COMPRESSION_RELEASE', score: fitCompressionRelease(runwayFeatures) },
    { cluster: 'LATE_CYCLE_RETURN', score: fitLateCycleReturn(gapDistEntry) },
    { cluster: 'SHORT_GAP_REPEAT', score: fitShortGapRepeat(gapDistEntry) },
    { cluster: 'LONG_GAP_RECOVERY', score: fitLongGapRecovery(suppressionEntry) },
    { cluster: 'TIER_ESCALATION', score: fitTierEscalation(progressionEntry) },
    { cluster: 'PRESSURE_RELEASE', score: fitPressureRelease(rivalPressure, color) }
  ];

  const active = fits
    .filter(f => f.score >= MIN_FIT_SCORE)
    .sort((a, b) => b.score - a.score);

  const primaryCluster = active.length > 0 ? active[0].cluster : 'NO_CLEAR_PATTERN';
  const primaryScore = active.length > 0 ? active[0].score : 0;

  const reasoning = active.length > 0
    ? `${color} best matches ${primaryCluster} (${primaryScore}%)` +
      (active.length > 1 ? `, also showing ${active.slice(1).map(f => `${f.cluster} (${f.score}%)`).join(', ')}` : '')
    : `${color} shows no clearly dominant pattern right now (all archetype fits below ${MIN_FIT_SCORE}%).`;

  return {
    color,
    primaryCluster,
    primaryScore,
    activeClusters: active,
    allFits: fits,
    reasoning
  };
}

// Main entry point. Takes the already-computed per-color outputs from the
// other engines (recomputed fresh every cycle from historicalDraws).
// the time this runs in rareEventLabEngine.js's update sequence have
// already been freshly recomputed this same cycle) plus the current
// runway vectors, and returns a per-color cluster classification.
function evaluateEventClusters(runwayVectorsByColor, gapDistribution, suppressionIntelligence, crossTierProgression, rivalPressure) {
  const perColor = {};
  HIERARCHY.forEach(color => {
    const context = {
      runwayFeatures: runwayVectorsByColor && runwayVectorsByColor[color] ? runwayVectorsByColor[color].features : null,
      gapDistEntry: gapDistribution ? gapDistribution[color] : null,
      suppressionEntry: suppressionIntelligence ? suppressionIntelligence[color] : null,
      progressionEntry: crossTierProgression && crossTierProgression.perColor ? crossTierProgression.perColor[color] : null,
      rivalPressure
    };
    perColor[color] = classifyClustersForColor(color, context);
  });

  return { perColor };
}

module.exports = {
  MIN_FIT_SCORE,
  classifyClustersForColor,
  evaluateEventClusters
};
