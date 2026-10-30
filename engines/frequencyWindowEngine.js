'use strict';

// ── MULTI-WINDOW FREQUENCY ENGINE — blueprint §4 ────────────────────────
//
// The engine's existing `freq` layer (numberEngine.js) only ever computed
// one all-history frequency count. That collapses "currently hot,"
// "historically strong," "recently cooling," and "persistently weak"
// into a single number, even though the blueprint explicitly wants them
// distinguished:
//
//   NUMBER   5D   10D   20D   50D
//   12       2     4     7    15
//
// This engine computes exactly that table (per-number counts across the
// last 5/10/20/50 draws plus full history), and classifies each number's
// trend by comparing its recent-window rate against its long-term rate.
// It does not replace numberEngine.js's existing `freq` layer or change
// its math — it's a new, additive signal exposed alongside it.
//
// Stateless by design, matching the SCIE/Climate/Group/Overextension
// convention — recomputed fully from draw history on every call.

const WINDOWS = [5, 10, 20, 50];

function safeSlice(draws, n) {
  return draws.slice(0, Math.min(n, draws.length));
}

function countInWindow(draws, windowSize) {
  const window = safeSlice(draws, windowSize);
  const counts = {};
  for (let n = 1; n <= 49; n++) counts[n] = 0;
  for (const d of window) for (const n of d.numbers) counts[n]++;
  return { counts, windowSize: window.length };
}

// Classifies a number's trend by comparing its rate in the shortest
// available window against its long-run (full-history) rate. A number
// firing well above its long-run rate recently is HOT; well below is
// COOLING; a number essentially absent both recently and historically is
// WEAK; everything else is STABLE.
function classifyTrend(shortRate, longRunRate, longRunTotal) {
  // Not enough long-run signal yet to call anything besides "insufficient."
  if (longRunTotal < 10) return 'INSUFFICIENT_DATA';
  if (longRunRate < 0.01 && shortRate < 0.01) return 'WEAK';

  const ratio = longRunRate > 0 ? shortRate / longRunRate : (shortRate > 0 ? 3 : 1);
  if (ratio >= 1.6) return 'HOT';
  if (ratio <= 0.5) return 'COOLING';
  return 'STABLE';
}

function computeFrequencyWindows(draws) {
  if (!draws || draws.length === 0) {
    return { table: {}, insufficientData: true };
  }

  const totalDraws = draws.length;
  const windowData = {};
  for (const w of WINDOWS) {
    windowData[w] = countInWindow(draws, w);
  }
  const longRunCounts = {};
  for (let n = 1; n <= 49; n++) longRunCounts[n] = 0;
  for (const d of draws) for (const n of d.numbers) longRunCounts[n]++;

  const table = {};
  for (let n = 1; n <= 49; n++) {
    const row = { num: n };
    for (const w of WINDOWS) {
      row[`d${w}`] = windowData[w].counts[n];
    }
    row.longTerm = longRunCounts[n];

    const shortest = WINDOWS[0]; // 5
    const shortRate = windowData[shortest].windowSize > 0
      ? windowData[shortest].counts[n] / windowData[shortest].windowSize
      : 0;
    const longRunRate = longRunCounts[n] / totalDraws;

    row.trend = classifyTrend(shortRate, longRunRate, totalDraws);
    table[n] = row;
  }

  return { table, windowSizes: WINDOWS, drawsAvailable: totalDraws, insufficientData: false };
}

module.exports = {
  computeFrequencyWindows,
  WINDOWS
};
