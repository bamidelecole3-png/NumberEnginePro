'use strict';

// ── OVEREXTENSION DETECTOR — blueprint §11 ──────────────────────────────
//
// Protection layer against "it appeared three times, so pick it again."
// A number that has fired well above its own normal rate in a short
// recent window is flagged OVEREXTENDED and its score is discounted —
// rather than momentum/EMA rewarding the same hot streak further, which
// is what the engine did before this existed.
//
// Deliberately per-number: "normal rate" is each number's own long-run
// frequency, not a flat 6/49 assumption, so a number that's always been
// somewhat frequent isn't mistakenly flagged just for being itself.
//
// Stateless by design, matching the SCIE/Climate/Group convention —
// recomputed fully from draw history on every call.

const RECENT_WINDOW = 10;
const MIN_HISTORY_FOR_BASELINE = 20; // need enough long-run history to trust an "expected" rate
const OVEREXTENSION_SIGMA_THRESHOLD = 2.0; // flag when recent deviation exceeds this many std-devs
const MAX_PENALTY = 0.30; // never discount a layer score by more than 30%, however extreme the deviation

function safeSlice(draws, n) {
  return draws.slice(0, Math.min(n, draws.length));
}

// Treats each draw as a Bernoulli trial for "does number n appear in this
// draw" (p = long-run rate). Over `windowSize` independent trials, the
// expected count is windowSize * p with std-dev sqrt(windowSize * p * (1-p)) —
// standard normal-approximation to a binomial, used only to judge how
// unusual the recent count is relative to the number's own history.
function binomialStdDev(windowSize, p) {
  return Math.sqrt(windowSize * p * (1 - p));
}

function computeOverextension(draws) {
  if (!draws || draws.length < MIN_HISTORY_FOR_BASELINE) {
    return {
      flags: {},        // num -> { status, deviation, recentCount, expectedCount }
      overextendedNumbers: [],
      insufficientData: true
    };
  }

  const totalDraws = draws.length;
  const recentWindowSize = Math.min(RECENT_WINDOW, draws.length);
  const recent = safeSlice(draws, RECENT_WINDOW);

  const longRunCounts = {};
  const recentCounts = {};
  for (let n = 1; n <= 49; n++) { longRunCounts[n] = 0; recentCounts[n] = 0; }
  for (const d of draws) for (const n of d.numbers) longRunCounts[n]++;
  for (const d of recent) for (const n of d.numbers) recentCounts[n]++;

  const flags = {};
  const overextendedNumbers = [];

  for (let n = 1; n <= 49; n++) {
    const longRunRate = longRunCounts[n] / totalDraws; // per-draw appearance probability
    const expectedRecent = longRunRate * recentWindowSize;
    const stdDev = binomialStdDev(recentWindowSize, longRunRate);
    const actualRecent = recentCounts[n];

    // A number with essentially zero long-run rate has no meaningful
    // std-dev to deviate against — skip rather than divide by ~0.
    if (stdDev < 0.05) {
      flags[n] = { status: 'NORMAL', deviation: 0, recentCount: actualRecent, expectedCount: Math.round(expectedRecent * 100) / 100 };
      continue;
    }

    const deviation = (actualRecent - expectedRecent) / stdDev;
    const status = deviation >= OVEREXTENSION_SIGMA_THRESHOLD ? 'OVEREXTENDED' : 'NORMAL';

    flags[n] = {
      status,
      deviation: Math.round(deviation * 100) / 100,
      recentCount: actualRecent,
      expectedCount: Math.round(expectedRecent * 100) / 100
    };

    if (status === 'OVEREXTENDED') {
      overextendedNumbers.push({ num: n, deviation: flags[n].deviation, recentCount: actualRecent });
    }
  }

  overextendedNumbers.sort((a, b) => b.deviation - a.deviation);

  return { flags, overextendedNumbers, insufficientData: false };
}

// Penalty scales with how far past the threshold a number's deviation is,
// capped at MAX_PENALTY so a single extreme outlier can't zero out a
// layer's score outright — this reduces the score's contribution rather
// than vetoing the number entirely, consistent with the blueprint's
// "can reduce its score rather than automatically chasing it."
function penaltyMultiplierFor(deviation) {
  if (deviation < OVEREXTENSION_SIGMA_THRESHOLD) return 1;
  const excess = deviation - OVEREXTENSION_SIGMA_THRESHOLD;
  // Every extra 1.0 sigma past the threshold adds 10% penalty, capped.
  const penalty = Math.min(MAX_PENALTY, excess * 0.10);
  return 1 - penalty;
}

// Applies the overextension penalty to momentum/markov/combination —
// the trend-following layers most prone to "chase the hot number." Freq,
// survivor, and group are left alone: freq already reflects long-run
// truth rather than a recent spike, survivor already penalizes short
// gaps on its own terms, and group strength is a relationship property,
// not an individual chase signal.
const PENALIZED_LAYERS = ['momentum', 'markov', 'combination'];

function applyOverextensionPenalty(preScores, overextension) {
  if (!overextension || overextension.insufficientData) return preScores;

  const adjusted = {};
  for (const layer of Object.keys(preScores)) {
    adjusted[layer] = {};
    for (let n = 1; n <= 49; n++) {
      const base = preScores[layer][n] || 0;
      if (PENALIZED_LAYERS.includes(layer)) {
        const flag = overextension.flags[n];
        const mult = flag ? penaltyMultiplierFor(flag.deviation) : 1;
        adjusted[layer][n] = Math.round(base * mult);
      } else {
        adjusted[layer][n] = base;
      }
    }
  }
  return adjusted;
}

module.exports = {
  computeOverextension,
  applyOverextensionPenalty,
  OVEREXTENSION_SIGMA_THRESHOLD,
  MAX_PENALTY
};
