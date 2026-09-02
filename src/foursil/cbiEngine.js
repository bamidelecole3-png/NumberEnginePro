/**
 * COLOR BEHAVIORAL INTELLIGENCE (CBI) — new engine (blueprint §8/§22-24).
 *
 * This is analytics, not a prediction board (blueprint explicit
 * requirement, repeated at §22 and §24): it never outputs a "next color"
 * pick, only descriptive season-relative behavior per color and the
 * pairwise relationship between them. 4SIL consumes color-level evidence
 * from the PORTED engines (rivalPressure, suppression, dynamicDominance,
 * etc, all under src-legacy-core) -- CBI does not feed 4SIL's gates; it
 * exists purely for operator visibility (blueprint §42: only 4SIL may
 * declare a trade).
 */
'use strict';

const COLORS = ['RED', 'BLUE', 'GREEN'];
const WINDOW = 30;
const RECENT_WINDOW = 10;

function recoverySpeedLabel(avgDrought) {
  if (avgDrought == null) return 'Unknown';
  if (avgDrought <= 3) return 'Fast';
  if (avgDrought <= 6) return 'Medium';
  return 'Slow';
}

function participationLabel(density) {
  if (density >= 35) return 'High';
  if (density >= 15) return 'Medium';
  return 'Low';
}

function closingBehaviorLabel(trendSlope) {
  if (trendSlope > 0.05) return 'Strengthening';
  if (trendSlope < -0.05) return 'Weakening';
  return 'Stable';
}

function droughtsForColor(window, color) {
  // window is newest-first; walk oldest->newest to find run lengths
  // between 4-ball appearances of `color`.
  const chrono = [...window].reverse();
  const droughts = [];
  let running = 0;
  let sawFirst = false;
  chrono.forEach(d => {
    if (d.fourBallColor === color) {
      if (sawFirst) droughts.push(running);
      running = 0;
      sawFirst = true;
    } else if (sawFirst) {
      running++;
    }
  });
  return { droughts, currentDrought: running, everAppeared: sawFirst };
}

function pearson(seriesA, seriesB) {
  const n = seriesA.length;
  if (n === 0) return 0;
  const meanA = seriesA.reduce((a, b) => a + b, 0) / n;
  const meanB = seriesB.reduce((a, b) => a + b, 0) / n;
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = seriesA[i] - meanA;
    const db = seriesB[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return 0;
  return Math.round((cov / Math.sqrt(varA * varB)) * 100) / 100;
}

function linearSlope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const xs = values.map((_, i) => i);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (values[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function buildColorBehaviorIntelligence(historicalDraws) {
  const draws = historicalDraws || [];
  const window = draws.slice(0, WINDOW);
  const recent = draws.slice(0, RECENT_WINDOW);
  const n = window.length;

  const table = {};
  const sparklines = {};

  COLORS.forEach(color => {
    const appearances = window.filter(d => d.fourBallColor === color).length;
    const { droughts, currentDrought } = droughtsForColor(window, color);
    const avgGap = droughts.length > 0 ? Math.round((droughts.reduce((a, b) => a + b, 0) / droughts.length) * 10) / 10 : null;
    const maxDrought = droughts.length > 0 ? Math.max(...droughts, currentDrought) : currentDrought;

    // Average active run: mean consecutive-draw streak length where this
    // color's tier stayed >=3 (3-ball or 4-ball), oldest->newest scan.
    const chrono = [...window].reverse();
    const runs = [];
    let run = 0;
    chrono.forEach(d => {
      const active = d.fourBallColor === color || d.threeBallColor === color;
      if (active) run++;
      else { if (run > 0) runs.push(run); run = 0; }
    });
    if (run > 0) runs.push(run);
    const avgActiveRun = runs.length > 0 ? Math.round((runs.reduce((a, b) => a + b, 0) / runs.length) * 10) / 10 : 0;

    const recentDensity = recent.length > 0
      ? Math.round((recent.filter(d => d.fourBallColor === color).length / recent.length) * 100)
      : 0;

    const trendSeries = chrono.map(d => (d.fourBallColor === color ? 1 : 0));
    const trendSlope = linearSlope(trendSeries);

    table[color] = {
      seasonAppearances: appearances,
      currentGap: currentDrought,
      avgGap,
      maxDrought,
      currentDrought,
      avgActiveRun,
      tenDrawDensity: recentDensity,
      recoverySpeed: recoverySpeedLabel(avgGap),
      seasonParticipation: participationLabel(recentDensity),
      closingBehavior: closingBehaviorLabel(trendSlope)
    };

    // Sparkline: last 15 draws, 1 = this color's 4-ball, 0 = not.
    sparklines[color] = window.slice(0, 15).map(d => (d.fourBallColor === color ? 1 : 0)).reverse();
  });

  // Relationship matrix: pairwise correlation of each color's binary
  // 4-ball-appearance series across the window -- a co-activity read,
  // explicitly not a betting probability (blueprint §24).
  const series = {};
  COLORS.forEach(c => {
    series[c] = [...window].reverse().map(d => (d.fourBallColor === c ? 1 : 0));
  });
  const matrix = {};
  let strongestPair = null;
  let strongestValue = -Infinity;
  COLORS.forEach(a => {
    matrix[a] = {};
    COLORS.forEach(b => {
      if (a === b) { matrix[a][b] = null; return; }
      const r = pearson(series[a], series[b]);
      matrix[a][b] = r;
      if (r > strongestValue) { strongestValue = r; strongestPair = [a, b]; }
    });
  });

  let regime = 'LOW CO-ACTIVITY';
  if (strongestValue >= 0.5) regime = 'STRONG CO-ACTIVITY';
  else if (strongestValue >= 0.2) regime = 'MODERATE CO-ACTIVITY';

  return {
    table,
    sparklines,
    relationship: {
      matrix,
      dominantRelationship: strongestPair ? `${strongestPair[0]} \u2194 ${strongestPair[1]}` : null,
      regime
    },
    droughtRecovery: COLORS.reduce((acc, color) => {
      const t = table[color];
      acc[color] = {
        currentDrought: t.currentDrought,
        historicalAvg: t.avgGap,
        max: t.maxDrought,
        recovery: t.recoverySpeed
      };
      return acc;
    }, {}),
    windowSize: n
  };
}

module.exports = { buildColorBehaviorIntelligence };
