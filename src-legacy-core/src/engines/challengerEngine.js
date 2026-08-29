/**
 * 4-Ball Challenger Engine.
 *
 * Blueprint "4-Ball Engine Roadmap -> Challenger Engine": detects a color
 * OTHER than the current season leader that is showing the specific
 * suppressed -> rising-3-ball -> early-4-ball pattern the blueprint
 * describes, and estimates its leadership (takeover) probability and an
 * expected takeover window in draws.
 *
 * Distinct from firstAppearanceEngine.js, which only looks for colors with
 * ZERO 4-ball hits in the last 15 draws (pure dormancy/breakout detection).
 * A challenger here can already have scored an early 4-ball hit or two --
 * the signal is the TREND (was quiet, now climbing), not total absence.
 */

const { HIERARCHY } = require('../core/colorMath');

const RECENT_WINDOW = 10;
const PRIOR_WINDOW = 10; // the 10 draws immediately before RECENT_WINDOW
const SUPPRESSION_THRESHOLD_DRAWS = 6;

function evaluateChallengerEmergence(historicalDraws, currentLeader) {
  const candidates = HIERARCHY.filter(c => c !== currentLeader);
  let best = null;

  candidates.forEach(color => {
    const recentWindow = historicalDraws.slice(0, RECENT_WINDOW);
    const priorWindow = historicalDraws.slice(RECENT_WINDOW, RECENT_WINDOW + PRIOR_WINDOW);

    const recent3BHits = recentWindow.filter(d => d.threeBallColor === color).length;
    const prior3BHits = priorWindow.filter(d => d.threeBallColor === color).length;
    const threeBallTrend = recent3BHits - prior3BHits;

    const recent4BHits = recentWindow.filter(d => d.fourBallColor === color).length;

    // Suppression must be measured as of the START of the recent window,
    // not "right now" -- once a challenger lands its early 4-ball hit,
    // its CURRENT gap-since-last-hit collapses back to a small number,
    // which would make a color that just broke out look "not suppressed"
    // by the naive current-gap check. What actually matters is whether it
    // was quiet BEFORE this recent activity began.
    let drawsQuietBeforeRecentWindow = 0;
    for (const d of historicalDraws.slice(RECENT_WINDOW)) {
      if (d.fourBallColor === color) break;
      drawsQuietBeforeRecentWindow++;
    }
    const wasSuppressed = drawsQuietBeforeRecentWindow >= SUPPRESSION_THRESHOLD_DRAWS;

    // The full pattern requires all three legs: a genuine quiet period
    // beforehand, a rising 3-ball trend now, AND at least one early 4-ball
    // hit already landed -- any one alone (e.g. just a rising 3-ball trend
    // with no 4-ball confirmation yet) isn't a confirmed challenger.
    if (!wasSuppressed || threeBallTrend <= 0 || recent4BHits === 0) return;

    const leadershipScore = Math.min(100, Math.round(
      (threeBallTrend * 15) +
      (recent4BHits * 20) +
      (Math.min(drawsQuietBeforeRecentWindow, 20) * 1.5)
    ));

    // Stronger signal -> sooner expected takeover; floor of 2 draws so this
    // never claims an implausibly immediate takeover.
    const expectedTakeoverWindow = Math.max(2, Math.round(12 - (leadershipScore / 10)));

    if (!best || leadershipScore > best.leadershipScore) {
      best = { challenger: color, leadershipScore, threeBallTrend, recent4BHits, drawsQuietBeforeRecentWindow, expectedTakeoverWindow };
    }
  });

  if (!best) {
    return {
      active: false,
      challenger: null,
      leadershipProbability: 0,
      expectedTakeoverWindow: null,
      reasoning: 'No color currently exhibits the full suppressed -> rising 3-ball -> early 4-ball challenger pattern.'
    };
  }

  return {
    active: true,
    challenger: best.challenger,
    leadershipProbability: best.leadershipScore,
    expectedTakeoverWindow: best.expectedTakeoverWindow,
    reasoning: `${best.challenger} was quiet for at least ${best.drawsQuietBeforeRecentWindow} draws before this window, then showed a rising 3-ball trend (+${best.threeBallTrend} vs. the prior window) and ${best.recent4BHits} early 4-ball appearance(s) in the last ${RECENT_WINDOW} draws — estimated takeover window ~${best.expectedTakeoverWindow} draws`
  };
}

module.exports = {
  RECENT_WINDOW,
  PRIOR_WINDOW,
  SUPPRESSION_THRESHOLD_DRAWS,
  evaluateChallengerEmergence
};
