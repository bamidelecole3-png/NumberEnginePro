/**
 * Rival Pressure Engine — Blueprint Phase 8.
 *
 * Every engine elsewhere in this lab evaluates colors independently. This
 * one evaluates SYSTEM EQUILIBRIUM: when one color has been clearly
 * dominant over a stretch of draws, what typically happens to each rival
 * during and after that stretch?
 *
 *   - Pressure Matrix    — for every ordered (dominant, rival) pair, the
 *                          rival's average share of tier-3+ activity DURING
 *                          the dominant color's dominant stretches.
 *   - Suppression Matrix — the same data reframed as a 0-100 suppression
 *                          index (100 = rival gets essentially nothing
 *                          while the other color dominates; 0 = rival
 *                          keeps its normal ~1/3 share regardless).
 *   - Release Probability — historically, how often has the rival landed
 *                          a real (4-ball+) hit within RELEASE_LOOKAHEAD
 *                          draws immediately after one of the dominant
 *                          color's dominant stretches?
 *   - Dominance Transfer  — has the currently-dominant color changed from
 *                          who was dominant one window ago (a handoff
 *                          already underway)?
 *   - Pressure Index      — how concentrated the CURRENT window's activity
 *                          is across the three colors overall (inverse of
 *                          normalized entropy; high = one color is
 *                          soaking up nearly everything right now).
 *
 * Performance note: unlike the O(n) single-pass engines elsewhere in this
 * lab (gapDistribution, behaviorFingerprints, comparativeIntel), building
 * the pressure matrix requires scanning a rolling window across the
 * entire history (O(n * DOMINANCE_WINDOW)). historicalDraws is capped at
 * 2000 (store.js), so even at PRESSURE_STRIDE=1 this is at most a few tens
 * of thousands of cheap array operations per call -- well within budget
 * for an engine that runs once per ingest batch, not per draw or per
 * request. PRESSURE_STRIDE is kept at 2 anyway as a deliberate, documented
 * safety margin rather than because 1 was measured to be a problem.
 */

'use strict';

const { HIERARCHY, argMaxColorBy } = require('../core/colorMath');
const { mean, shannonEntropyOf } = require('../core/statMath');
const { tierValue } = require('./runwayFeatureEngine');

const DOMINANCE_WINDOW = 15; // draws considered one "dominance stretch" sample
const RELEASE_LOOKAHEAD = 10; // draws after a dominance stretch checked for a rival's release
const DOMINANCE_SHARE_THRESHOLD = 0.5; // a color must hold > this share of tier-3+ activity to count as "dominant" for a given stretch
const MIN_RELEASE_SAMPLE = 3;
const PRESSURE_STRIDE = 2; // sample every Nth window start rather than every draw -- see module docstring

function activityShares(windowDraws) {
  const counts = { RED: 0, BLUE: 0, GREEN: 0 };
  windowDraws.forEach(d => HIERARCHY.forEach(c => { if (tierValue(d, c) >= 3) counts[c]++; }));
  const total = counts.RED + counts.BLUE + counts.GREEN;
  const shares = { RED: 0, BLUE: 0, GREEN: 0 };
  if (total > 0) HIERARCHY.forEach(c => { shares[c] = counts[c] / total; });
  return { counts, shares, total };
}

// Scans a rolling DOMINANCE_WINDOW across the full history, and for every
// stretch where one color clearly dominates, records each rival's share
// during that stretch plus whether the rival landed a real hit in the
// RELEASE_LOOKAHEAD draws immediately afterward (smaller array index =
// later in real time, per this codebase's newest-first convention).
function buildPressureMatrix(historicalDraws) {
  const raw = {};
  HIERARCHY.forEach(a => {
    raw[a] = {};
    HIERARCHY.forEach(b => {
      if (a !== b) raw[a][b] = { rivalShareSamples: [], releaseSuccesses: 0, releaseSample: 0 };
    });
  });

  const lastStart = historicalDraws.length - DOMINANCE_WINDOW;
  for (let i = 0; i <= lastStart; i += PRESSURE_STRIDE) {
    const windowSlice = historicalDraws.slice(i, i + DOMINANCE_WINDOW);
    const { shares, total } = activityShares(windowSlice);
    if (total === 0) continue;

    const dominant = argMaxColorBy(shares);
    if (shares[dominant] < DOMINANCE_SHARE_THRESHOLD) continue; // not a clear dominance stretch -- skip

    HIERARCHY.forEach(rival => {
      if (rival === dominant) return;
      raw[dominant][rival].rivalShareSamples.push(shares[rival]);

      if (i - RELEASE_LOOKAHEAD >= 0) {
        raw[dominant][rival].releaseSample++;
        const afterSlice = historicalDraws.slice(i - RELEASE_LOOKAHEAD, i);
        const rivalReleased = afterSlice.some(d => tierValue(d, rival) >= 4);
        if (rivalReleased) raw[dominant][rival].releaseSuccesses++;
      }
    });
  }

  const summary = {};
  HIERARCHY.forEach(a => {
    summary[a] = {};
    HIERARCHY.forEach(b => {
      if (a === b) return;
      const cell = raw[a][b];
      const avgRivalSharePct = cell.rivalShareSamples.length ? Math.round(mean(cell.rivalShareSamples) * 1000) / 10 : null;
      // Suppression index: an UN-suppressed rival would still hold roughly
      // its "fair" 1/3 share (~33%) even while another color leads --
      // three colors, one dominant, two sharing the rest roughly evenly is
      // the no-suppression baseline. Full suppression (rival share -> 0%)
      // scores 100; a rival holding its normal ~33% scores 0.
      const suppressionIndex = avgRivalSharePct !== null
        ? Math.max(0, Math.min(100, Math.round(100 - avgRivalSharePct * 3)))
        : null;
      const releaseProbability = cell.releaseSample >= MIN_RELEASE_SAMPLE
        ? Math.round((cell.releaseSuccesses / cell.releaseSample) * 100)
        : null;

      summary[a][b] = {
        avgRivalSharePct,
        suppressionIndex,
        releaseProbability,
        releaseSampleSize: cell.releaseSample,
        dominanceSampleSize: cell.rivalShareSamples.length
      };
    });
  });

  return summary;
}

function evaluateRivalPressure(historicalDraws) {
  const matrix = buildPressureMatrix(historicalDraws);

  const currentWindow = historicalDraws.slice(0, DOMINANCE_WINDOW);
  const current = activityShares(currentWindow);
  const currentSharesPct = {};
  HIERARCHY.forEach(c => { currentSharesPct[c] = Math.round(current.shares[c] * 100); });
  const currentDominant = current.total > 0 ? argMaxColorBy(current.shares) : null;
  const isDominanceActive = currentDominant !== null && current.shares[currentDominant] >= DOMINANCE_SHARE_THRESHOLD;

  const priorWindow = historicalDraws.slice(DOMINANCE_WINDOW, DOMINANCE_WINDOW * 2);
  const prior = activityShares(priorWindow);
  const priorDominant = prior.total > 0 ? argMaxColorBy(prior.shares) : null;
  const priorDominanceActive = priorDominant !== null && prior.shares[priorDominant] >= DOMINANCE_SHARE_THRESHOLD;
  const dominanceTransferDetected = isDominanceActive && priorDominanceActive && currentDominant !== priorDominant;

  const rivalOutlook = {};
  HIERARCHY.forEach(c => {
    if (!isDominanceActive || c === currentDominant) { rivalOutlook[c] = null; return; }
    rivalOutlook[c] = matrix[currentDominant][c] || null;
  });

  // Pressure index: how concentrated CURRENT activity is across the three
  // colors (inverse of normalized Shannon entropy) -- 100 means one color
  // is taking essentially all tier-3+ activity right now; 0 means a
  // perfectly even three-way split.
  const pressureIndex = current.total > 0
    ? Math.round((1 - (shannonEntropyOf(current.counts) / Math.log2(3))) * 100)
    : 0;

  const bestReleaseCandidate = isDominanceActive
    ? HIERARCHY.filter(c => c !== currentDominant)
      .map(c => ({ color: c, outlook: rivalOutlook[c] }))
      .filter(x => x.outlook && x.outlook.releaseProbability !== null)
      .sort((a, b) => b.outlook.releaseProbability - a.outlook.releaseProbability)[0] || null
    : null;

  const reasoning = isDominanceActive
    ? `${currentDominant} currently holds ${currentSharesPct[currentDominant]}% of tier-3+ activity (dominant). ` +
      HIERARCHY.filter(c => c !== currentDominant).map(c => {
        const o = rivalOutlook[c];
        if (!o) return `${c}: no data`;
        return `${c} suppression index ${o.suppressionIndex ?? 'n/a'}, historical release probability ${o.releaseProbability != null ? `${o.releaseProbability}%` : 'insufficient sample'}`;
      }).join('; ')
    : `No single color currently holds a clear majority (>=${Math.round(DOMINANCE_SHARE_THRESHOLD * 100)}%) of tier-3+ activity; system is currently contested.`;

  return {
    currentDominant,
    isDominanceActive,
    currentSharesPct,
    priorDominant,
    dominanceTransferDetected,
    pressureIndex,
    matrix,
    rivalOutlook,
    bestReleaseCandidate: bestReleaseCandidate ? bestReleaseCandidate.color : null,
    bestReleaseProbability: bestReleaseCandidate ? bestReleaseCandidate.outlook.releaseProbability : null,
    reasoning
  };
}

module.exports = {
  DOMINANCE_WINDOW,
  RELEASE_LOOKAHEAD,
  DOMINANCE_SHARE_THRESHOLD,
  MIN_RELEASE_SAMPLE,
  buildPressureMatrix,
  evaluateRivalPressure
};
