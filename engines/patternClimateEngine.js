'use strict';

// ── PATTERN CLIMATE ENGINE — v19 ────────────────────────────────────────
//
// Runs before candidate scoring on every predictNumbers() cycle and
// answers one question: "what kind of environment is the game in right
// now?" It does not predict numbers itself — it characterizes the
// *conditions* every other layer is predicting into, so those layers can
// (lightly, boundedly) consult it rather than treating every draw as
// equally analyzable.
//
// Stateless by design, matching the existing SCIE convention
// (analyzeHistoricalReliability recomputes from full draw history on
// every call, no persisted state) — the climate is always a read of
// "current conditions," not something that accumulates its own history.
//
// Output fields map directly to the blueprint:
//   - state / stateScore        → Stable or Chaotic Pattern State
//   - frequencyDominance        → Frequency Dominance
//   - momentumDominance         → Momentum Dominance
//   - repeatActivity            → Repeat Activity
//   - companionGroupActivity    → Companion Group Activity
//   - transitionPhase           → Transition Phase
//   - patternStrength           → Pattern Strength (composite, 0-100)

const RECENT_WINDOW = 10;
const BASELINE_WINDOW = 25;

function safeSlice(draws, n) {
  return draws.slice(0, Math.min(n, draws.length));
}

// ── Frequency Dominance ──────────────────────────────────────────────────
// Which numbers are showing up far more than an even distribution would
// predict, over the recent window.
function computeFrequencyDominance(draws) {
  const recent = safeSlice(draws, RECENT_WINDOW);
  if (recent.length === 0) {
    return { leadingNumbers: [], strength: 0, label: 'NONE' };
  }
  const counts = {};
  for (const d of recent) {
    for (const n of d.numbers) counts[n] = (counts[n] || 0) + 1;
  }
  const totalSlots = recent.length * 6;
  const expected = totalSlots / 49;
  const ranked = Object.entries(counts)
    .map(([num, count]) => ({ num: Number(num), count, overExpected: count / (expected || 1) }))
    .filter(r => r.overExpected >= 1.8)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  const strength = ranked.length
    ? Math.min(100, Math.round((ranked[0].overExpected - 1) * 40))
    : 0;

  return {
    leadingNumbers: ranked.map(r => r.num),
    strength,
    label: strength >= 65 ? 'STRONG' : strength >= 30 ? 'MODERATE' : ranked.length ? 'MILD' : 'NONE'
  };
}

// ── Momentum Dominance ────────────────────────────────────────────────────
// Is overall repeat/hot-number activity accelerating or cooling, comparing
// the most recent half of the window against the earlier half.
function computeMomentumDominance(draws) {
  const window = safeSlice(draws, RECENT_WINDOW);
  if (window.length < 6) {
    return { direction: 'INSUFFICIENT_DATA', strength: 0 };
  }
  const half = Math.floor(window.length / 2);
  const recentHalf = window.slice(0, half);
  const olderHalf = window.slice(half);

  const hotCount = (slice) => {
    const counts = {};
    for (const d of slice) for (const n of d.numbers) counts[n] = (counts[n] || 0) + 1;
    return Object.values(counts).filter(c => c >= 2).length;
  };

  const recentHot = hotCount(recentHalf);
  const olderHot = hotCount(olderHalf);
  const delta = recentHot - olderHot;

  const direction = delta > 0 ? 'ACCELERATING' : delta < 0 ? 'DECELERATING' : 'STEADY';
  const strength = Math.min(100, Math.abs(delta) * 25);

  return { direction, strength };
}

// ── Repeat Activity ───────────────────────────────────────────────────────
// How often a number from the immediately preceding draw reappears in the
// very next draw, across the recent window — a proxy for short-cycle
// repetition pressure.
function computeRepeatActivity(draws) {
  const window = safeSlice(draws, RECENT_WINDOW + 1);
  if (window.length < 3) {
    return { rate: 0, label: 'INSUFFICIENT_DATA' };
  }
  let repeatDraws = 0;
  let comparisons = 0;
  for (let i = 0; i < window.length - 1; i++) {
    const curr = new Set(window[i].numbers);
    const prev = window[i + 1].numbers;
    comparisons++;
    if (prev.some(n => curr.has(n))) repeatDraws++;
  }
  const rate = comparisons ? Math.round((repeatDraws / comparisons) * 100) : 0;
  return {
    rate,
    label: rate >= 60 ? 'HIGH' : rate >= 30 ? 'MODERATE' : 'LOW'
  };
}

// ── Companion Group Activity ──────────────────────────────────────────────
// Lightweight self-contained co-occurrence density check (does not depend
// on groupIntelligenceEngine, so this module stays independently testable
// and won't break if that engine's shape ever changes) — how often pairs
// within a single draw repeat together across the recent window versus
// what a flat baseline would predict.
function computeCompanionGroupActivity(draws) {
  const window = safeSlice(draws, RECENT_WINDOW);
  if (window.length < 4) {
    return { density: 0, label: 'INSUFFICIENT_DATA' };
  }
  const pairCounts = new Map();
  for (const d of window) {
    const nums = d.numbers;
    for (let i = 0; i < nums.length; i++) {
      for (let j = i + 1; j < nums.length; j++) {
        const key = nums[i] < nums[j] ? `${nums[i]}-${nums[j]}` : `${nums[j]}-${nums[i]}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
    }
  }
  const repeatingPairs = [...pairCounts.values()].filter(c => c >= 2).length;
  const totalPairsObserved = pairCounts.size || 1;
  const density = Math.round((repeatingPairs / totalPairsObserved) * 100);
  return {
    density,
    repeatingPairs,
    label: density >= 25 ? 'HIGH' : density >= 10 ? 'MODERATE' : 'LOW'
  };
}

// ── Stable vs Chaotic + Transition Phase ──────────────────────────────────
// Compares the "shape" (frequency distribution entropy proxy) of the
// recent window against a longer baseline window. A recent window that
// looks a lot like the baseline = stable/mature pattern. A recent window
// that looks very different = the game is transitioning to something new,
// or currently chaotic if no clear new leaders have emerged yet either.
function computeStabilityAndTransition(draws, frequencyDominance) {
  const recent = safeSlice(draws, RECENT_WINDOW);
  const baseline = safeSlice(draws, BASELINE_WINDOW);

  if (recent.length < 6 || baseline.length < 12) {
    return {
      state: 'INSUFFICIENT_DATA',
      stateScore: 0,
      transitionPhase: 'UNKNOWN'
    };
  }

  const topSet = (slice, topK) => {
    const counts = {};
    for (const d of slice) for (const n of d.numbers) counts[n] = (counts[n] || 0) + 1;
    return new Set(
      Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, topK).map(([n]) => Number(n))
    );
  };

  const recentTop = topSet(recent, 10);
  const baselineTop = topSet(baseline, 10);
  const overlap = [...recentTop].filter(n => baselineTop.has(n)).length;
  const overlapPct = Math.round((overlap / 10) * 100);

  // High overlap with the longer-run baseline = stable pattern (the same
  // numbers that have mattered over the long run still matter right now).
  const stateScore = overlapPct;
  const state = stateScore >= 55 ? 'STABLE' : 'CHAOTIC';

  let transitionPhase;
  if (stateScore >= 70) {
    transitionPhase = 'PEAK'; // long-run leaders are fully in control right now
  } else if (stateScore >= 45) {
    transitionPhase = frequencyDominance.leadingNumbers.length ? 'FORMING' : 'NEUTRAL';
  } else {
    transitionPhase = frequencyDominance.leadingNumbers.length ? 'BREAKING' : 'NEUTRAL';
  }

  return { state, stateScore, transitionPhase };
}

// ── Composite Pattern Strength ─────────────────────────────────────────────
function computePatternStrength({ stability, frequencyDominance, momentumDominance, repeatActivity, companionGroupActivity }) {
  if (stability.state === 'INSUFFICIENT_DATA') return 0;
  const parts = [
    stability.stateScore,
    frequencyDominance.strength,
    momentumDominance.strength,
    repeatActivity.rate,
    companionGroupActivity.density != null ? companionGroupActivity.density * 2 : 0 // density tends to run lower-scale, weight it up
  ];
  const avg = parts.reduce((a, b) => a + b, 0) / parts.length;
  return Math.max(0, Math.min(100, Math.round(avg)));
}

function buildSummary(climate) {
  if (climate.state === 'INSUFFICIENT_DATA') {
    return 'Not enough draw history yet to characterize the current pattern climate.';
  }
  const bits = [];
  bits.push(`${climate.state === 'STABLE' ? 'Stable' : 'Chaotic'} pattern (${climate.stateScore}% long-run overlap)`);
  if (climate.frequencyDominance.leadingNumbers.length) {
    bits.push(`${climate.frequencyDominance.label.toLowerCase()} frequency dominance from ${climate.frequencyDominance.leadingNumbers.length} number(s)`);
  }
  bits.push(`momentum ${climate.momentumDominance.direction.toLowerCase()}`);
  bits.push(`repeat activity ${climate.repeatActivity.label.toLowerCase()}`);
  bits.push(`transition phase: ${climate.transitionPhase.toLowerCase()}`);
  return bits.join(', ') + '.';
}

function computeClimate(draws) {
  const frequencyDominance = computeFrequencyDominance(draws);
  const momentumDominance = computeMomentumDominance(draws);
  const repeatActivity = computeRepeatActivity(draws);
  const companionGroupActivity = computeCompanionGroupActivity(draws);
  const stability = computeStabilityAndTransition(draws, frequencyDominance);

  const climate = {
    state: stability.state,
    stateScore: stability.stateScore,
    frequencyDominance,
    momentumDominance,
    repeatActivity,
    companionGroupActivity,
    transitionPhase: stability.transitionPhase,
    patternStrength: computePatternStrength({ stability, frequencyDominance, momentumDominance, repeatActivity, companionGroupActivity })
  };
  climate.summary = buildSummary(climate);
  return climate;
}

// ── Layer consultation ────────────────────────────────────────────────────
// Every prediction layer "consults" the climate via this single, bounded,
// clearly-labeled adjustment step — applied to each layer's per-number
// score BEFORE it enters the composite formula. This intentionally does
// NOT touch how any layer computes its own base score (Markov transition
// math, SCIE cluster logic, etc. are all untouched); it only nudges the
// result by up to ±12% based on current conditions, and only in
// well-motivated directions:
//   - Chaotic climate: discount trend-following layers a bit (momentum,
//     markov) since recent trend is less trustworthy when the pattern
//     itself is unstable; leave freq/survivor/combination alone since
//     those already lean on longer-run structure.
//   - BREAKING transition: discount frequency dominance itself, since the
//     numbers currently "leading" are, by definition, the ones losing
//     control.
//   - PEAK transition (long-run leaders fully in control): mildly boost
//     freq/combination, which are the layers most anchored to that
//     long-run structure.
const CLIMATE_ADJUSTMENT_CAP = 0.12;

function applyClimateAdjustment(preScores, climate) {
  if (!climate || climate.state === 'INSUFFICIENT_DATA') return preScores; // nothing to consult yet

  const multipliers = { markov: 1, momentum: 1, survivor: 1, freq: 1, combination: 1 };

  if (climate.state === 'CHAOTIC') {
    multipliers.markov -= CLIMATE_ADJUSTMENT_CAP * 0.6;
    multipliers.momentum -= CLIMATE_ADJUSTMENT_CAP;
  } else if (climate.state === 'STABLE') {
    multipliers.markov += CLIMATE_ADJUSTMENT_CAP * 0.4;
    multipliers.momentum += CLIMATE_ADJUSTMENT_CAP * 0.5;
  }

  if (climate.transitionPhase === 'BREAKING') {
    multipliers.freq -= CLIMATE_ADJUSTMENT_CAP * 0.5;
  } else if (climate.transitionPhase === 'PEAK') {
    multipliers.freq += CLIMATE_ADJUSTMENT_CAP * 0.5;
    multipliers.combination += CLIMATE_ADJUSTMENT_CAP * 0.3;
  }

  const adjusted = { markov: {}, momentum: {}, survivor: {}, freq: {}, combination: {} };
  for (let n = 1; n <= 49; n++) {
    for (const layer of Object.keys(adjusted)) {
      const mult = Math.max(1 - CLIMATE_ADJUSTMENT_CAP, Math.min(1 + CLIMATE_ADJUSTMENT_CAP, multipliers[layer]));
      adjusted[layer][n] = Math.max(0, Math.min(100, Math.round((preScores[layer][n] || 0) * mult)));
    }
  }
  return adjusted;
}

module.exports = {
  computeClimate,
  applyClimateAdjustment,
  CLIMATE_ADJUSTMENT_CAP
};
