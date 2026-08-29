/**
 * 4-Ball Dynamic Dominance Engine.
 *
 * Blueprint "4-Ball Engine Roadmap -> Dynamic Dominance": replaces a single
 * static "season leader" (a flat frequency count over the whole 100-draw
 * window) with a rolling, recency-weighted read on WHO is actually leading
 * right now, whether that's the same color the flat count would pick, and
 * whether a takeover is already underway.
 *
 *   - Rolling dominance: the leader within a short (10-draw) vs. a longer
 *     (30-draw) window -- these can disagree, which is itself the signal.
 *   - Weighted dominance: within each window, more recent draws count more
 *     (exponential half-life decay), so a color that's gone quiet for the
 *     first half of a window doesn't get equal credit to one that's been
 *     hitting steadily throughout it.
 *   - Momentum dominance: whether the leader's margin over its closest
 *     rival is widening (defending its lead) or narrowing (losing it),
 *     comparing the short-window gap to the long-window gap.
 *   - Projected dominance: a simple linear extrapolation of each color's
 *     weighted share across three nested windows (10/20/30), used to name
 *     a projected next-window leader distinct from either rolling leader.
 */

const { HIERARCHY, argMaxColorBy } = require('../core/colorMath');

const SHORT_WINDOW = 10;
const MID_WINDOW = 20;
const LONG_WINDOW = 30;
const HALF_LIFE = 5; // draws for a weight to decay by half

function emptyCounts() {
  return { RED: 0, BLUE: 0, GREEN: 0 };
}

// Recency-weighted 4-ball hit counts within the most recent `windowSize`
// draws. Index 0 (the most recent draw) carries weight 1.0; weight decays
// by half every HALF_LIFE draws further back.
function computeWeightedCounts(historicalDraws, windowSize) {
  const window = historicalDraws.slice(0, windowSize);
  const counts = emptyCounts();
  window.forEach((d, i) => {
    if (!d.fourBallColor || counts[d.fourBallColor] === undefined) return;
    const weight = Math.pow(0.5, i / HALF_LIFE);
    counts[d.fourBallColor] += weight;
  });
  return counts;
}

function totalOf(counts) {
  return HIERARCHY.reduce((sum, c) => sum + (counts[c] || 0), 0) || 1; // avoid div-by-zero
}

function closestRivalGap(counts, leader) {
  const rivals = HIERARCHY.filter(c => c !== leader);
  const topRival = rivals.reduce((best, c) => (counts[c] > counts[best] ? c : best), rivals[0]);
  return (counts[leader] || 0) - (counts[topRival] || 0);
}

function evaluateDynamicDominance(historicalDraws, staticDominantColor) {
  const shortCounts = computeWeightedCounts(historicalDraws, SHORT_WINDOW);
  const longCounts = computeWeightedCounts(historicalDraws, LONG_WINDOW);

  const rollingLeaderShort = argMaxColorBy(shortCounts);
  const rollingLeaderLong = argMaxColorBy(longCounts);

  const totalShort = totalOf(shortCounts);
  const totalLong = totalOf(longCounts);
  const weightedDominanceShortPct = Math.round((shortCounts[rollingLeaderShort] / totalShort) * 100);
  const weightedDominanceLongPct = Math.round((longCounts[rollingLeaderLong] / totalLong) * 100);

  const gapShort = closestRivalGap(shortCounts, rollingLeaderShort) / totalShort;
  const gapLong = closestRivalGap(longCounts, rollingLeaderLong) / totalLong;
  const momentumDominance = Math.round((gapShort - gapLong) * 100); // positive = leader's margin widening recently

  // Projected dominance: average slope of each color's weighted SHARE
  // across the three nested windows, added onto its current short-window
  // share to name a projected leader.
  const midCounts = computeWeightedCounts(historicalDraws, MID_WINDOW);
  const totalMid = totalOf(midCounts);

  const projectedShares = {};
  HIERARCHY.forEach(c => {
    const shareShort = shortCounts[c] / totalShort;
    const shareMid = midCounts[c] / totalMid;
    const shareLong = longCounts[c] / totalLong;
    const slope = ((shareShort - shareMid) + (shareMid - shareLong)) / 2;
    projectedShares[c] = Math.max(0, Math.min(1, shareShort + slope));
  });
  const projectedLeader = argMaxColorBy(projectedShares);

  const leaderTransition = rollingLeaderShort !== rollingLeaderLong;
  const challengerTakeover = leaderTransition && rollingLeaderShort !== staticDominantColor;
  const powerShift = leaderTransition || momentumDominance < -5;

  return {
    rollingLeaderShort,
    rollingLeaderLong,
    weightedDominanceShortPct,
    weightedDominanceLongPct,
    momentumDominance,
    projectedLeader,
    projectedShares: {
      RED: Math.round(projectedShares.RED * 100),
      BLUE: Math.round(projectedShares.BLUE * 100),
      GREEN: Math.round(projectedShares.GREEN * 100)
    },
    leaderTransition,
    challengerTakeover,
    powerShift,
    challenger: leaderTransition ? rollingLeaderShort : null
  };
}

module.exports = {
  SHORT_WINDOW,
  MID_WINDOW,
  LONG_WINDOW,
  evaluateDynamicDominance
};
