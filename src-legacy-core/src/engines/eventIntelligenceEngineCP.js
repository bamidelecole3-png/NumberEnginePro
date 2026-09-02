'use strict';

/**
 * eventIntelligenceEngineCP.js
 *
 * Byte-for-byte port of Color Parliament's eventIntelligenceEngine.js
 * (4Ball Event Intelligence Engine v2.0) into Sniper V4, following the
 * exact same porting convention already established by
 * colorParliamentLastStand.js / threeBallLastStandCP.js / fourBallLastStandCP.js
 * / colorParliamentSeasonAdapter.js:
 *
 *   - The scoring math, component weights, thresholds, confirmation rules,
 *     and Event Memory lifecycle below are copied unmodified from the
 *     original project's engines/eventIntelligenceEngine.js.
 *   - Sniper V4's own historicalDraws (newest-first, single unified stream)
 *     is converted to Color Parliament's expected oldest-first, split
 *     4-ball/3-ball draw shape via colorParliamentSeasonAdapter.js's
 *     replaySeasonAndArchive() (for the 4-ball stream + archive/season
 *     state) and colorParliamentLastStand.js's toThreeBallCPDraws() pattern
 *     (for the independent 3-ball stream), exactly as those existing ports
 *     already do for fourBallLastStandCP.js / threeBallLastStandCP.js.
 *   - tacticalTransitionSignal() has no existing Sniper V4 port (Color
 *     Parliament's tacticalEngine.js was never brought over as a whole
 *     module), so it is reconstructed here from the SAME primitive that
 *     IS already ported and battle-tested: threeBallLastStandCP.js's
 *     computeColorMomentum() (byte-for-byte identical algorithm --
 *     12-draw lookback, 0.85 decay, oldest-first walk-from-the-back --
 *     to Color Parliament's original tacticalEngine.computeMomentum()).
 *     Applied here to the 4-ball stream instead of the 3-ball stream.
 *   - Unlike the stateless colorParliamentLastStand.js (which recomputes
 *     fresh every call with no memory), this engine's Event Memory
 *     Database, pending-First-Appearance resolution window, and
 *     color-return-gap model are genuinely STATEFUL by design in the
 *     original (they depend on what happened across PRIOR calls, e.g.
 *     "did this color repeat within 5 draws of the call firing?", which
 *     cannot be answered by a pure recompute-from-full-history function).
 *     Persisted at store.eventIntelligence, written in place by
 *     runEventIntelligence() below -- same persisted-slot pattern as
 *     store.tieIntelligence, but mutated across calls rather than
 *     replaced wholesale each time, because this module's memory can't be
 *     losslessly re-derived from historicalDraws alone.
 *   - colorDNA lookup (Module C's avgDuration input) has no populated
 *     Sniper V4 equivalent; ctxDnaLookup's original duck-typed "return
 *     null if absent" fallback is kept as-is, so computeCollapseScore's
 *     existing avgDuration=8 default (identical to the original) applies.
 *
 * All function names, constants, comments, and scoring formulas below are
 * kept identical to the source file so this stays auditable line-by-line
 * against the original -- see the header note above each module.
 */

const { store } = require('../core/store');
const { replaySeasonAndArchive } = require('./colorParliamentSeasonAdapter');
const threeBallLastStandCP = require('./threeBallLastStandCP');
const { buildAppearanceProfile, calculateTimingForecast } = require('./firstAppearanceEngine');

// ─── Constants (unchanged from the original) ───────────────────────────────

const HISTORICAL_RETURN_MAX_SAMPLES = 20; // rolling gap-sample cap per color
const EVENT_MEMORY_MAX = 500;             // bounded persisted event log
const FIRST_APPEARANCE_CONFIRM_MIN_SCORE = 65; // Birth Score floor to certify
const LAST_STAND_CONFIRM_MIN_SCORE = 70;       // Collapse Score floor to flag Last Stand

// Ported unmodified from Color Parliament's tacticalEngine.js -- same
// lookback/decay used by threeBallLastStandCP.js's computeColorMomentum,
// applied here to the 4-ball stream.
const MOMENTUM_LOOKBACK = 12;
const MOMENTUM_DECAY = 0.85;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function clamp01(n) { return clamp(n, 0, 1); }
function average(arr) {
  if (!arr || arr.length === 0) return null;
  return arr.reduce((s, n) => s + n, 0) / arr.length;
}

// ─── State ──────────────────────────────────────────────────────────────────

function freshEventIntelligenceState() {
  return {
    // Per-color dormancy/return-window model, keyed by color. Persists
    // across seasons (a color's historical return interval is learned over
    // the long run, not reset every season).
    colorReturnModel: {}, // { color: { gaps: [...], lastSeenSeasonEndIndex } }

    // Event Memory Database -- every certified First Appearance / Last
    // Stand event, newest last, bounded.
    eventMemory: [],

    // Currently pending (unconfirmed) First Appearance candidate, if any --
    // one candidate tracked at a time so Event Memory records clean,
    // resolvable calls rather than overlapping ones.
    pendingFirstAppearance: null,

    // Last certified Last Stand call for the current standing color, so we
    // don't re-fire the same call every draw once certified.
    lastCertifiedLastStand: null,

    // Bookkeeping for onSeasonEnd(): the last season-close index/color we
    // already recorded a return-gap for, so a season-boundary transition
    // detected via replaySeasonAndArchive() (recomputed fresh every call,
    // unlike the original's incremental engine.js hook) is only recorded
    // once rather than on every subsequent call that still sees the same
    // closed season in the replay.
    lastRecordedSeasonEnd: null // { color, seasonEndIndex }
  };
}

// ─── 4-ball momentum / transition signal (reconstructed from the same
// primitive threeBallLastStandCP.js already ports for the 3-ball stream) ──

/**
 * Byte-for-byte identical to Color Parliament's tacticalEngine.computeMomentum
 * and to threeBallLastStandCP.js's computeColorMomentum -- decay-weighted
 * per-color momentum over the last `lookback` draws, oldest-first input.
 */
function computeMomentum(draws, lookback = MOMENTUM_LOOKBACK, decay = MOMENTUM_DECAY) {
  const recent = draws.slice(-lookback);
  const scores = {};
  let weight = 1;
  let totalWeight = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const d = recent[i];
    if (d.color) {
      scores[d.color] = (scores[d.color] || 0) + weight;
    }
    totalWeight += weight;
    weight *= decay;
  }
  const normalized = {};
  for (const color of Object.keys(scores)) {
    normalized[color] = totalWeight > 0 ? scores[color] / totalWeight : 0;
  }
  return normalized;
}

/**
 * Byte-for-byte port of tacticalEngine.tacticalTransitionSignal, applied to
 * the 4-ball cpDraws stream (Color Parliament's original also runs this
 * against the 4-ball stream for eventIntelligenceEngine's purposes).
 */
function tacticalTransitionSignal(draws, currentPredictedColor) {
  const momentum = computeMomentum(draws);

  if (!currentPredictedColor) {
    return { weakening: false, challenger: null, pressure: 0, volatility: 0 };
  }

  const leaderMomentum = momentum[currentPredictedColor] || 0;
  let challenger = null;
  let challengerMomentum = 0;
  for (const [color, score] of Object.entries(momentum)) {
    if (color === currentPredictedColor) continue;
    if (score > challengerMomentum) {
      challenger = color;
      challengerMomentum = score;
    }
  }

  const pressure = clamp01(challengerMomentum - leaderMomentum + 0.5);
  const weakening = challenger !== null && challengerMomentum >= leaderMomentum * 0.9;

  // Volatility: Color Parliament's original computeVolatility() measures
  // how often the leading color flips over a recent window -- not yet
  // ported standalone, so approximated here directly from the same
  // momentum spread this function already has on hand (how close the top
  // two colors are), which is the same underlying signal computeVolatility
  // captures (a tight race flips leaders more often than a runaway one).
  const sortedMomentum = Object.values(momentum).sort((a, b) => b - a);
  const volatility = sortedMomentum.length >= 2
    ? clamp01(1 - Math.abs(sortedMomentum[0] - sortedMomentum[1]))
    : 0;

  return { weakening, challenger, pressure, leaderMomentum, challengerMomentum, volatility };
}

// ─── MODULE A: FIRST APPEARANCE DETECTOR (unchanged from the original) ────

function dormancyLength(draws, color) {
  for (let i = draws.length - 1; i >= 0; i--) {
    if (draws[i].color === color) return draws.length - 1 - i;
  }
  return draws.length;
}

function historicalReturnWindow(colorReturnModel, color) {
  const model = colorReturnModel[color];
  const gaps = model ? model.gaps : [];
  if (gaps.length === 0) {
    return { avgGap: null, minGap: null, maxGap: null, sampleSize: 0 };
  }
  const avgGap = average(gaps);
  return {
    avgGap,
    minGap: Math.min(...gaps),
    maxGap: Math.max(...gaps),
    sampleSize: gaps.length
  };
}

function nearMissScore(threeBallRankingEntry, hitsThisSeasonForColor) {
  if (!threeBallRankingEntry) return 0;
  if (hitsThisSeasonForColor > 0) return 0;
  const strength = clamp(threeBallRankingEntry.seasonScore, 0, 100);
  const velocityBonus = { Accelerating: 20, Growing: 10, Stable: 0, Declining: -10, Collapsing: -20 }[
    threeBallRankingEntry.momentumVelocity
  ] ?? 0;
  return clamp(strength * 0.6 + velocityBonus, 0, 100);
}

function eventMemorySimilarity(eventMemory, color, currentDormancy) {
  const priorSuccesses = eventMemory.filter(
    e => e.type === 'FIRST_APPEARANCE' && e.color === color && e.outcome === 'SUCCESS'
  );
  if (priorSuccesses.length === 0) return { similarity: 0, sampleSize: 0 };

  const priorDormancies = priorSuccesses.map(e => e.dormancyLength).filter(d => d != null);
  if (priorDormancies.length === 0) return { similarity: 0, sampleSize: priorSuccesses.length };

  const avgPriorDormancy = average(priorDormancies);
  const spread = Math.max(avgPriorDormancy * 0.5, 3);
  const distance = Math.abs(currentDormancy - avgPriorDormancy);
  const similarity = clamp(100 - (distance / spread) * 100, 0, 100);

  return { similarity, sampleSize: priorSuccesses.length };
}

function computeBirthScore(ctx) {
  const {
    draws, color, colorReturnModel, tacticalTransitionSignal: signal,
    threeBallRankingEntry, hitsThisSeasonForColor, eventMemory
  } = ctx;

  const dormancy = dormancyLength(draws, color);
  const returnWindow = historicalReturnWindow(colorReturnModel, color);
  let dormancyScore;
  if (returnWindow.avgGap != null) {
    const distanceFromAvg = Math.abs(dormancy - returnWindow.avgGap);
    const tolerance = Math.max(returnWindow.avgGap * 0.6, 4);
    dormancyScore = clamp(100 - (distanceFromAvg / tolerance) * 60, 10, 100);
  } else {
    dormancyScore = clamp((dormancy / 20) * 100, 0, 100);
  }

  let transitionPressureScore = 0;
  if (signal && signal.weakening) {
    if (signal.challenger === color) {
      transitionPressureScore = clamp(signal.pressure * 100, 0, 100);
    } else {
      transitionPressureScore = clamp(signal.pressure * 40, 0, 100);
    }
  }

  const threeBallMomentumScore = threeBallRankingEntry
    ? clamp(threeBallRankingEntry.seasonScore, 0, 100)
    : 0;

  const nearMiss = nearMissScore(threeBallRankingEntry, hitsThisSeasonForColor);

  const historicalWindowScore = returnWindow.sampleSize > 0
    ? clamp(15 + returnWindow.sampleSize * 10, 0, 90)
    : 0;

  const memoryMatch = eventMemorySimilarity(eventMemory, color, dormancy);

  // Upgrade: convert the engine's chronological 4-ball stream into the
  // central engine's newest-first format and reuse the empirical residual-life
  // model so First Appearance can answer the operator's actual timing
  // question: approximately how many draws until this dormant color appears?
  const timingDraws = (draws || []).slice().reverse().map(d => ({
    drawId: d.drawId,
    fourBallColor: d.color || null,
    threeBallColor: null,
    timestamp: d.timestamp || null
  }));
  const timingProfile = buildAppearanceProfile(timingDraws, color);
  const timingForecast = calculateTimingForecast(timingProfile, {
    transitionPressure: signal && signal.weakening ? signal.pressure * 100 : 0
  });

  const components = {
    dormancyScore: Math.round(dormancyScore),
    transitionPressureScore: Math.round(transitionPressureScore),
    threeBallMomentumScore: Math.round(threeBallMomentumScore),
    nearMissScore: Math.round(nearMiss),
    historicalWindowScore: Math.round(historicalWindowScore),
    eventMemoryScore: Math.round(memoryMatch.similarity)
  };

  const birthScore = clamp(
    components.dormancyScore * 0.25 +
    components.transitionPressureScore * 0.20 +
    components.threeBallMomentumScore * 0.20 +
    components.nearMissScore * 0.15 +
    components.historicalWindowScore * 0.10 +
    components.eventMemoryScore * 0.10,
    0, 100
  );

  return {
    color,
    birthScore: Math.round(birthScore),
    dormancy,
    projectedReturnGap: returnWindow.avgGap,
    // Precise timing layer: empirical point estimate + uncertainty window.
    nextAppearance: timingForecast.available ? {
      approximatelyDraws: timingForecast.approximateDraws,
      forecastWindow: timingForecast.forecastWindow,
      timingConfidence: timingForecast.timingConfidence,
      probabilityNext5Draws: timingForecast.probabilityNext5Draws,
      probabilityNext10Draws: timingForecast.probabilityNext10Draws,
      probabilityNext20Draws: timingForecast.probabilityNext20Draws
    } : null,
    timingForecast,
    components,
    memorySampleSize: memoryMatch.sampleSize
  };
}

const COLOR_BATTLE_COLORS = new Set(['RED', 'GREEN', 'BLUE']);

function evaluateFirstAppearance(evalCtx) {
  const { draws, standingColor, colorReturnModel, tacticalTransitionSignal: signal,
          threeBallRanking, seasonHits, eventMemory } = evalCtx;

  const allColors = new Set([
    ...Object.keys(colorReturnModel),
    ...threeBallRanking.map(r => r.color),
    ...draws.map(d => d.color).filter(Boolean)
  ]);
  allColors.delete(null);
  if (standingColor) allColors.delete(standingColor);
  for (const c of Array.from(allColors)) {
    if (!COLOR_BATTLE_COLORS.has(c)) allColors.delete(c);
  }

  const candidates = Array.from(allColors).map(color => computeBirthScore({
    draws,
    color,
    colorReturnModel,
    tacticalTransitionSignal: signal,
    threeBallRankingEntry: threeBallRanking.find(r => r.color === color) || null,
    hitsThisSeasonForColor: seasonHits[color] || 0,
    eventMemory
  }));

  candidates.sort((a, b) => b.birthScore - a.birthScore);
  const top = candidates[0] || null;

  let certified = false;
  let supportingEvidenceCount = 0;
  if (top) {
    if (top.components.threeBallMomentumScore >= 50) supportingEvidenceCount += 1;
    if (top.components.transitionPressureScore >= 40) supportingEvidenceCount += 1;
    if (top.components.eventMemoryScore >= 50) supportingEvidenceCount += 1;
    if (top.components.historicalWindowScore >= 50) supportingEvidenceCount += 1;

    certified = top.birthScore >= FIRST_APPEARANCE_CONFIRM_MIN_SCORE && supportingEvidenceCount >= 2;
  }

  return {
    candidates: candidates.slice(0, 5),
    topCandidate: top,
    certified,
    supportingEvidenceCount,
    confirmationThreshold: FIRST_APPEARANCE_CONFIRM_MIN_SCORE,
    nextAppearance: top && top.nextAppearance ? {
      color: top.color,
      approximatelyDraws: top.nextAppearance.approximatelyDraws,
      forecastWindow: top.nextAppearance.forecastWindow,
      timingConfidence: top.nextAppearance.timingConfidence,
      probabilityNext5Draws: top.nextAppearance.probabilityNext5Draws,
      probabilityNext10Draws: top.nextAppearance.probabilityNext10Draws,
      probabilityNext20Draws: top.nextAppearance.probabilityNext20Draws
    } : null
  };
}

// ─── MODULE B: TRANSITION CORRIDOR (unchanged from the original) ──────────

function evaluateTransitionCorridor({ standingColor, tacticalTransitionSignal: signal, firstAppearanceResult, lifecyclePhaseIndex }) {
  if (!standingColor || !signal) {
    return {
      leader: standingColor || null,
      challenger: null,
      takeoverProbability: 0,
      transitionConfidence: 0,
      corridorActive: false
    };
  }

  const challenger = signal.challenger;
  if (!challenger) {
    return {
      leader: standingColor,
      challenger: null,
      takeoverProbability: 0,
      transitionConfidence: 0,
      corridorActive: false
    };
  }

  const challengerBirthScore = (firstAppearanceResult.topCandidate && firstAppearanceResult.topCandidate.color === challenger)
    ? firstAppearanceResult.topCandidate.birthScore
    : (firstAppearanceResult.candidates.find(c => c.color === challenger)?.birthScore || 0);

  const phaseMultiplier = lifecyclePhaseIndex >= 5 ? 1.15 : (lifecyclePhaseIndex <= 3 ? 0.85 : 1.0);

  const rawTakeover = clamp01(
    0.55 * signal.pressure +
    0.25 * clamp01(challengerBirthScore / 100) +
    0.20 * clamp01(signal.volatility)
  ) * phaseMultiplier;

  const takeoverProbability = Math.round(clamp(rawTakeover * 100, 0, 100));

  const transitionConfidence = Math.round(clamp(
    50 + (signal.challengerMomentum - signal.leaderMomentum) * 100,
    10, 95
  ));

  return {
    leader: standingColor,
    challenger,
    takeoverProbability,
    transitionConfidence,
    corridorActive: takeoverProbability >= 40,
    challengerBirthScore: Math.round(challengerBirthScore)
  };
}

// ─── MODULE C: LAST STAND DETECTOR (unchanged from the original) ──────────

const FREQUENCY_DECLINE_MIN_SAMPLE = 4;

function frequencyDecline(draws, color, windowSize = 5) {
  const recentWindow = draws.slice(-windowSize);
  const priorWindow = draws.slice(-windowSize * 2, -windowSize);
  const recentCount = recentWindow.filter(d => d.color === color).length;
  const priorCount = priorWindow.filter(d => d.color === color).length;

  if (priorWindow.length === 0) return { declineScore: 0, recentCount, priorCount };

  const decline = priorCount - recentCount;
  const rawDeclineScore = clamp((decline / Math.max(1, priorCount)) * 100, 0, 100);

  const totalSample = priorCount + recentCount;
  const sampleTrust = clamp(totalSample / FREQUENCY_DECLINE_MIN_SAMPLE, 0, 1);
  const declineScore = rawDeclineScore * sampleTrust;

  return { declineScore: Math.round(declineScore), recentCount, priorCount, sampleTrust: Math.round(sampleTrust * 100) / 100 };
}

function failedFollowThrough(draws, color, seasonAgeInDraws) {
  const lastHitGap = dormancyLength(draws, color);
  if (lastHitGap === 0) return { score: 0, drawsSinceLastHit: 0 };

  const severity = seasonAgeInDraws > 0 ? clamp01(lastHitGap / Math.max(3, seasonAgeInDraws * 0.4)) : 0;
  return { score: Math.round(severity * 100), drawsSinceLastHit: lastHitGap };
}

function crossEngineAgreement({ tacticalTransitionSignal: signal, transitionCorridorResult }) {
  if (!signal || !signal.challenger) {
    return { agreementScore: 0, agreeingEngines: [] };
  }
  const agreeing = [];
  if (signal.weakening) agreeing.push('tactical');
  if (transitionCorridorResult.corridorActive) agreeing.push('transitionCorridor');
  if (transitionCorridorResult.challenger) agreeing.push('strategic');

  const agreementScore = Math.round((agreeing.length / 3) * 100);
  return { agreementScore, agreeingEngines: agreeing };
}

function computeCollapseScore(ctx) {
  const {
    draws, standingColor, seasonAgeInDraws, lifecyclePhaseIndex,
    tacticalTransitionSignal: signal, transitionCorridorResult, eventMemory, dna
  } = ctx;

  const avgDuration = dna && dna.averageDuration ? dna.averageDuration : 8;
  const seasonAgeScore = clamp((seasonAgeInDraws / Math.max(1, avgDuration)) * 100, 0, 100);

  const decline = frequencyDecline(draws, standingColor);

  const challengerPressureScore = transitionCorridorResult.takeoverProbability;

  const followThrough = failedFollowThrough(draws, standingColor, seasonAgeInDraws);

  const agreement = crossEngineAgreement({ tacticalTransitionSignal: signal, transitionCorridorResult });

  const priorLastStands = eventMemory.filter(
    e => e.type === 'LAST_STAND' && e.color === standingColor && e.outcome === 'SUCCESS'
  );
  let historicalMemoryScore = 0;
  if (priorLastStands.length > 0) {
    const priorAges = priorLastStands.map(e => e.seasonAgeInDraws).filter(a => a != null);
    if (priorAges.length > 0) {
      const avgPriorAge = average(priorAges);
      const spread = Math.max(avgPriorAge * 0.5, 3);
      const distance = Math.abs(seasonAgeInDraws - avgPriorAge);
      historicalMemoryScore = clamp(100 - (distance / spread) * 100, 0, 100);
    }
  }

  const components = {
    seasonAgeScore: Math.round(seasonAgeScore),
    frequencyDeclineScore: decline.declineScore,
    challengerPressureScore: Math.round(challengerPressureScore),
    failedFollowThroughScore: followThrough.score,
    crossEngineAgreementScore: agreement.agreementScore,
    historicalMemoryScore: Math.round(historicalMemoryScore)
  };

  // BUGFIX: lifecyclePhaseIndex was destructured from ctx but never applied
  // anywhere in this function -- the FATIGUE/COLLAPSE (>=5) vs PRIME (<=3)
  // phase multiplier described in this engine's header comment (see the
  // lifecyclePhaseIndex derivation above, ~line 760) was only ever wired
  // into evaluateTransitionCorridor()'s takeoverProbability, not into the
  // collapse score itself. A Last Stand call late in a color's lifecycle
  // was therefore scored identically to one still in its prime, silencing
  // exactly the signal this index exists to provide. Mirrors
  // evaluateTransitionCorridor()'s phaseMultiplier pattern.
  const phaseMultiplier = lifecyclePhaseIndex >= 5 ? 1.15 : (lifecyclePhaseIndex <= 3 ? 0.85 : 1.0);

  const collapseScore = clamp(
    (components.seasonAgeScore * 0.15 +
    components.frequencyDeclineScore * 0.20 +
    components.challengerPressureScore * 0.25 +
    components.failedFollowThroughScore * 0.20 +
    components.crossEngineAgreementScore * 0.10 +
    components.historicalMemoryScore * 0.10) * phaseMultiplier,
    0, 100
  );

  return {
    collapseScore: Math.round(collapseScore),
    components,
    lifecyclePhaseIndex,
    phaseMultiplier,
    drawsSinceLastHit: followThrough.drawsSinceLastHit,
    agreeingEngines: agreement.agreeingEngines
  };
}

// ─── Colour return-model bookkeeping (unchanged from the original) ────────

function recordSeasonEndForColor(colorReturnModel, color, seasonEndIndex) {
  if (!color) return;
  if (!colorReturnModel[color]) {
    colorReturnModel[color] = { gaps: [], lastSeenSeasonEndIndex: null };
  }
  const model = colorReturnModel[color];
  if (model.lastSeenSeasonEndIndex != null) {
    const gap = seasonEndIndex - model.lastSeenSeasonEndIndex;
    if (gap > 0) {
      model.gaps.push(gap);
      if (model.gaps.length > HISTORICAL_RETURN_MAX_SAMPLES) {
        model.gaps = model.gaps.slice(-HISTORICAL_RETURN_MAX_SAMPLES);
      }
    }
  }
  model.lastSeenSeasonEndIndex = seasonEndIndex;
}

// ─── Event Memory Database (unchanged from the original) ──────────────────

function recordEvent(eventMemoryState, event) {
  eventMemoryState.push({ ...event, recordedAt: new Date().toISOString() });
  if (eventMemoryState.length > EVENT_MEMORY_MAX) {
    eventMemoryState.splice(0, eventMemoryState.length - EVENT_MEMORY_MAX);
  }
}

function getEventLog(eiState, limit = 30) {
  if (!eiState || !Array.isArray(eiState.eventMemory)) return [];
  return eiState.eventMemory.slice(-limit).reverse();
}

function resolvePendingFirstAppearance(eiState, draws) {
  const pending = eiState.pendingFirstAppearance;
  if (!pending) return;

  const latestIndex = draws.length - 1;
  const RESOLUTION_WINDOW = 5;

  if (latestIndex < pending.firedAtIndex + 1) return;

  let hitsSince = 0;
  for (let i = pending.firedAtIndex + 1; i <= latestIndex; i++) {
    if (draws[i] && draws[i].color === pending.color) hitsSince += 1;
  }

  if (hitsSince >= 2) {
    finalizePendingFirstAppearance(eiState, pending, 'SUCCESS');
    return;
  }
  if (latestIndex - pending.firedAtIndex >= RESOLUTION_WINDOW) {
    finalizePendingFirstAppearance(eiState, pending, 'FAILED');
  }
}

function finalizePendingFirstAppearance(eiState, pending, outcome) {
  recordEvent(eiState.eventMemory, {
    type: 'FIRST_APPEARANCE',
    color: pending.color,
    drawId: pending.firedAtDrawId,
    birthScore: pending.birthScore,
    dormancyLength: pending.dormancyLength,
    outcome
  });
  eiState.pendingFirstAppearance = null;
}

function dormantRead() {
  return {
    seasonGate: { active: false, triggerDrawId: null },
    firstAppearance: {
      topCandidate: null,
      candidates: [],
      certified: false,
      supportingEvidenceCount: 0,
      confirmationThreshold: FIRST_APPEARANCE_CONFIRM_MIN_SCORE,
      pending: null
    },
    transitionCorridor: {
      leader: null,
      challenger: null,
      takeoverProbability: 0,
      transitionConfidence: 0,
      corridorActive: false
    },
    lastStand: null,
    eventMemorySize: 0,
    eventMemoryLog: []
  };
}

/**
 * Detects a season-boundary transition from the fresh replay (season went
 * ACTIVE -> INACTIVE since the last call) and records the return-gap for
 * the color that just lost the season, plus resolves any still-open Last
 * Stand / pending First Appearance for that color -- equivalent to the
 * original's onSeasonEnd() hook, but driven by comparing this call's
 * replay result against what was recorded last time, since Sniper V4 has
 * no incremental per-ingest hook into this stateless-recompute adapter.
 */
function detectAndHandleSeasonEnd(eiState, cpDraws, archiveState, seasonStatus) {
  if (seasonStatus !== 'INACTIVE') return;
  if (!eiState.lastCertifiedLastStand && !eiState.pendingFirstAppearance && archiveState.history.length === 0) return;

  const lastClosed = archiveState.history[archiveState.history.length - 1];
  if (!lastClosed) return;

  const alreadyRecorded = eiState.lastRecordedSeasonEnd
    && eiState.lastRecordedSeasonEnd.color === lastClosed.dominantColor
    && eiState.lastRecordedSeasonEnd.closedAtDrawId === lastClosed.closedAtDrawId;
  if (alreadyRecorded) return;

  const outgoingColor = lastClosed.dominantColor;
  const closedIndex = cpDraws.findIndex(d => String(d.drawId) === String(lastClosed.closedAtDrawId));
  const seasonEndIndex = closedIndex >= 0 ? closedIndex : cpDraws.length - 1;

  recordSeasonEndForColor(eiState.colorReturnModel, outgoingColor, seasonEndIndex);
  eiState.lastRecordedSeasonEnd = { color: outgoingColor, closedAtDrawId: lastClosed.closedAtDrawId };

  if (eiState.lastCertifiedLastStand && eiState.lastCertifiedLastStand.color === outgoingColor) {
    const evt = eiState.eventMemory.find(
      e => e.type === 'LAST_STAND'
        && e.color === outgoingColor
        && e.outcome === 'PENDING'
        && e.drawId === eiState.lastCertifiedLastStand.drawId
    );
    if (evt) evt.outcome = 'SUCCESS';
    eiState.lastCertifiedLastStand = null;
  }

  if (eiState.pendingFirstAppearance) {
    finalizePendingFirstAppearance(eiState, eiState.pendingFirstAppearance, 'FAILED');
  }
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * Runs the full ported Event Intelligence Engine against Sniper V4's
 * current draw history. Reads/writes store.eventIntelligence in place
 * (lazily initialized), same call-on-demand cadence as
 * computeColorParliamentLastStandAndAlam() -- cheap enough to call every
 * council cycle, matching this codebase's existing "recompute fresh every
 * call" convention (rareEventLabEngine.js, colorParliamentLastStand.js).
 *
 * @returns {Object} same public shape as the original's evaluate() return
 */
function runEventIntelligence() {
  if (!store.eventIntelligence) {
    store.eventIntelligence = freshEventIntelligenceState();
  }
  const eiState = store.eventIntelligence;

  const historicalDraws = store.historicalDraws;

  // 4-ball stream: oldest-first, Color-Parliament-shaped, plus the replayed
  // archive/season state -- exactly what fourBallLastStandCP.js already
  // reuses from this same adapter.
  const { archiveState, seasonStatus, cpDraws: draws } = replaySeasonAndArchive(historicalDraws);

  detectAndHandleSeasonEnd(eiState, draws, archiveState, seasonStatus);

  // STAGE 1 -- SEASON GATE. Mirrors the original's own gate (which reused
  // tacticalEngine.evaluateActivation) by reading the SAME activation rule
  // already applied inside replaySeasonAndArchive() for this exact draw
  // history, rather than calling it a second time.
  if (seasonStatus !== 'ACTIVE') {
    return dormantRead();
  }

  resolvePendingFirstAppearance(eiState, draws);

  const standingColor = archiveState.dominantColor || null;

  // seasonAgeInDraws: draws since this season's activation trigger, mirrors
  // the original's `draws.length - 1 - activatedAtIndex`. archiveState
  // does not carry activatedAtIndex directly, so it's derived from the
  // wake record's drawId position in `draws`.
  let seasonAgeInDraws = 0;
  if (archiveState.awake && archiveState.seasonId) {
    const activationIndex = draws.findIndex(d => String(d.drawId) === String(archiveState.seasonId));
    seasonAgeInDraws = activationIndex >= 0 ? (draws.length - 1 - activationIndex) : 0;
  }

  const seasonHits = {};
  if (archiveState.leaderboard) {
    for (const [color, entry] of Object.entries(archiveState.leaderboard)) {
      seasonHits[color] = entry.hits;
    }
  }

  // Independent 3-ball stream, oldest-first, same conversion
  // colorParliamentLastStand.js's toThreeBallCPDraws() already uses.
  const threeBallCPDraws = (historicalDraws || [])
    .slice()
    .reverse()
    .map(d => ({ drawId: d.drawId, color: d.threeBallColor || null, timestamp: d.timestamp || null }));
  const threeBallRanking = threeBallCPDraws.length > 0
    ? threeBallLastStandCP.computeColorRanking(threeBallCPDraws)
    : [];

  const signal = standingColor ? tacticalTransitionSignal(draws, standingColor) : null;

  // MODULE A
  const firstAppearanceResult = evaluateFirstAppearance({
    draws,
    standingColor,
    colorReturnModel: eiState.colorReturnModel,
    tacticalTransitionSignal: signal,
    threeBallRanking,
    seasonHits,
    eventMemory: eiState.eventMemory
  });

  if (firstAppearanceResult.certified && !eiState.pendingFirstAppearance) {
    const top = firstAppearanceResult.topCandidate;
    eiState.pendingFirstAppearance = {
      color: top.color,
      birthScore: top.birthScore,
      dormancyLength: top.dormancy,
      firedAtIndex: draws.length - 1,
      firedAtDrawId: draws[draws.length - 1].drawId
    };
  }

  // lifecyclePhaseIndex: Sniper V4 has no direct port of Color Parliament's
  // lifecycleEngine phase index. Approximated from seasonAgeInDraws against
  // the same avgDuration=8 fallback computeCollapseScore already uses when
  // colorDNA is absent, keeping the FATIGUE/COLLAPSE (>=5) vs PRIME (<=3)
  // boundary semantics intact rather than always taking the neutral 1.0
  // multiplier path.
  const lifecyclePhaseIndex = seasonAgeInDraws >= 10 ? 6 : seasonAgeInDraws >= 6 ? 5 : seasonAgeInDraws <= 2 ? 2 : 4;

  // MODULE B
  const transitionCorridorResult = evaluateTransitionCorridor({
    standingColor,
    tacticalTransitionSignal: signal,
    firstAppearanceResult,
    lifecyclePhaseIndex
  });

  // MODULE C
  let lastStandResult = null;
  if (standingColor) {
    lastStandResult = computeCollapseScore({
      draws,
      standingColor,
      seasonAgeInDraws,
      lifecyclePhaseIndex,
      tacticalTransitionSignal: signal,
      transitionCorridorResult,
      eventMemory: eiState.eventMemory,
      dna: null // no populated Sniper V4 colorDNA equivalent -- see header note
    });

    const alreadyCertifiedThisRun = eiState.lastCertifiedLastStand
      && eiState.lastCertifiedLastStand.color === standingColor
      && eiState.lastCertifiedLastStand.seasonId === archiveState.seasonId;

    if (lastStandResult.collapseScore >= LAST_STAND_CONFIRM_MIN_SCORE && !alreadyCertifiedThisRun) {
      eiState.lastCertifiedLastStand = {
        color: standingColor,
        seasonId: archiveState.seasonId,
        drawId: draws[draws.length - 1].drawId
      };
      recordEvent(eiState.eventMemory, {
        type: 'LAST_STAND',
        color: standingColor,
        drawId: draws[draws.length - 1].drawId,
        collapseScore: lastStandResult.collapseScore,
        seasonAgeInDraws,
        replacementCandidate: transitionCorridorResult.challenger,
        outcome: 'PENDING'
      });
    }
  }

  return {
    seasonGate: {
      active: true,
      triggerDrawId: archiveState.seasonId
    },
    // BUG FIX: this object previously omitted `nextAppearance` entirely,
    // even though evaluateFirstAppearance() (above, this file) already
    // correctly computes it -- per-candidate, inside computeBirthScore()
    // via firstAppearanceEngine.js's buildAppearanceProfile/
    // calculateTimingForecast, then assembled onto firstAppearanceResult
    // itself at its own `return { ..., nextAppearance: ... }` (see
    // evaluateFirstAppearance() above). That data was being computed and
    // then silently dropped at this exact hand-off point: the frontend
    // (public/index.html's `faNext = (eventIntel && eventIntel.firstAppearance)
    // ... fa.nextAppearance`) reads this object specifically, so
    // "approximately N draws", the forecast window, and the horizon
    // probabilities never reached the dashboard even though the underlying
    // engine had already computed them correctly -- every timing field
    // rendered as the placeholder '--', which read as "the engine only
    // shows the likely color" even though the timing math existed and ran
    // successfully one call frame away. This is the one-line fix: forward
    // the field that was already there.
    firstAppearance: {
      topCandidate: firstAppearanceResult.topCandidate,
      candidates: firstAppearanceResult.candidates,
      certified: firstAppearanceResult.certified,
      supportingEvidenceCount: firstAppearanceResult.supportingEvidenceCount,
      confirmationThreshold: firstAppearanceResult.confirmationThreshold,
      nextAppearance: firstAppearanceResult.nextAppearance,
      pending: eiState.pendingFirstAppearance
    },
    transitionCorridor: transitionCorridorResult,
    lastStand: lastStandResult,
    eventMemorySize: eiState.eventMemory.length,
    eventMemoryLog: getEventLog(eiState, 30)
  };
}

module.exports = {
  runEventIntelligence,
  freshEventIntelligenceState,
  dormantRead,
  getEventLog,
  FIRST_APPEARANCE_CONFIRM_MIN_SCORE,
  LAST_STAND_CONFIRM_MIN_SCORE
};
