'use strict';

// ═════════════════════════════════════════════════════════════════════════
// TOP 4 LIVE REALITY ENGINE
//
// Autonomous observer/referee for Number Engine Pro v20 CAME's Top 4
// prediction intelligence. Runs a second, independent lifecycle alongside
// the existing user prediction + 5-draw CAME batch learning system:
//
//   NEW ACCEPTED DRAW → REALITY PREDICTION → FREEZE SNAPSHOT →
//   +1 / +2 / +3 EVALUATION → SCORE → LOG → NEXT REALITY TEST
//
// Golden rules enforced here (see build spec):
//  - Triggered only by newly accepted live draws, never by frontend timers.
//  - Uses the exact same Number Engine Pro v20 CAME intelligence
//    (numberEngine.generateRealityPrediction), never a second algorithm.
//  - Never mutates user prediction state, never resets the existing
//    numberEngine batch/CAME machinery (enforced on the numberEngine side
//    via mode:'reality').
//  - Every prediction becomes an immutable snapshot; source draw is never
//    itself an evaluation draw; windows are non-overlapping 3-draw audits.
//  - Own persistence file, own duplicate protection, own restart recovery.
//  - V1 observes and measures; it does not retrain CAME.
// ═════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const numberEngine = require('./numberEngine');

const DATA_FILE = path.join(__dirname, '..', 'data', 'top4Reality.json');
const REQUIRED_EVAL_DRAWS = 3;
const TOP4_SIZE = 4;
const RETAIN_COMPLETED = 1000; // spec §87: retain 500-1000 completed snapshots

// ── Calibration seeds (spec §25) — configurable, not permanent truths ─────
const THRESHOLDS = {
  healthy: 65,   // rate >= 65        → HEALTHY
  normal: 50,    // 50 <= rate < 65   → NORMAL
  caution: 35,   // 35 <= rate < 50   → CAUTION
  // rate < 35                        → HIT_DROUGHT (if sustained)
  weakWindow: 35,       // a completed window below this counts as "weak"
  droughtStreak: 2,     // consecutive weak windows required before DROUGHT
  recoveryStreak: 2     // consecutive improving windows required to exit DROUGHT/RECOVERING
};

const SAMPLE_STAGE = { EARLY_DATA: [0, 2], WATCHING: [3, 4], DEVELOPING: [5, 9], ESTABLISHED: [10, Infinity] };

function sampleStage(completedCount) {
  if (completedCount <= 2) return 'EARLY_DATA';
  if (completedCount <= 4) return 'WATCHING';
  if (completedCount <= 9) return 'DEVELOPING';
  return 'ESTABLISHED';
}

function round1(n) { return Math.round(n * 10) / 10; }

// ── State ───────────────────────────────────────────────────────────────
function defaultState() {
  return {
    activeSnapshot: null,
    completedSnapshots: [],
    nextTestSeq: 1,

    stats: {
      totalSnapshots: 0,
      completedSnapshots: 0,
      totalOccurrences: 0,
      totalOpportunities: 0,
      numberCoverageRate: 0,
      windowCoverageRate: 0,
      opportunityHitRate: 0
    },

    rolling: { last3: null, last5: null, last10: null, last20: null },

    baseline: { hitRate: null, deviation: null, established: false },

    condition: { status: 'EARLY_DATA', sampleStage: 'EARLY_DATA' },

    drought: {
      active: false,
      consecutiveWeakWindows: 0,
      consecutiveZeroHitDraws: 0,
      drawsSinceLastHit: 0
    },

    recovery: { active: false, consecutiveImprovingWindows: 0 },

    lastProcessedDrawId: null,
    // Bounded idempotency guard (spec §37) beyond the lastProcessedDrawId
    // cursor, in case onNewDrawsIngested is ever invoked twice for the
    // same ingest event.
    recentProcessedDrawIds: [],

    meta: {
      lastSnapshotCreatedAt: null,
      lastSnapshotCompletedAt: null,
      lastEngineError: null
    }
  };
}

let state = defaultState();

function loadState() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (data && typeof data === 'object') {
        state = Object.assign(defaultState(), data);
        // Defensive merge for nested objects in case of partial/older saves.
        state.stats = Object.assign(defaultState().stats, data.stats || {});
        state.rolling = Object.assign(defaultState().rolling, data.rolling || {});
        state.baseline = Object.assign(defaultState().baseline, data.baseline || {});
        state.condition = Object.assign(defaultState().condition, data.condition || {});
        state.drought = Object.assign(defaultState().drought, data.drought || {});
        state.recovery = Object.assign(defaultState().recovery, data.recovery || {});
        state.meta = Object.assign(defaultState().meta, data.meta || {});
      }
    } catch (e) {
      console.error('[top4RealityEngine] Failed to load persisted state, starting fresh:', e.message);
      state = defaultState();
    }
  }
}

function saveState() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.error('[top4RealityEngine] Failed to persist state:', e.message);
  }
}

// ── Snapshot creation ───────────────────────────────────────────────────
// drawsChronoUpToSource: full accepted-draw history in NEWEST-FIRST order,
// truncated so draws[0] === sourceDraw — i.e. "what was knowable at the
// moment the source draw arrived." Prevents look-ahead bias (spec §77).
function createRealitySnapshot(sourceDraw, drawsChronoUpToSource) {
  let result;
  try {
    result = numberEngine.generateRealityPrediction(drawsChronoUpToSource);
  } catch (e) {
    state.meta.lastEngineError = { at: new Date().toISOString(), message: e.message };
    saveState();
    return null;
  }

  if (!result || result.error || !Array.isArray(result.predictedNumbers) || result.predictedNumbers.length < TOP4_SIZE) {
    // Not enough draws yet, or engine failure. Leave state untouched
    // (spec §83 — engine failure safety) and just skip this cycle.
    if (result && result.error) {
      state.meta.lastEngineError = { at: new Date().toISOString(), message: result.error };
    }
    return null;
  }

  const predictionId = `REALITY-T4-${String(state.nextTestSeq).padStart(6, '0')}`;
  state.nextTestSeq += 1;

  const snapshot = {
    predictionId,
    sourceDrawId: sourceDraw.drawId,
    sourceTimestamp: sourceDraw.timestamp,
    createdAt: new Date().toISOString(),
    top4: result.predictedNumbers.slice(0, TOP4_SIZE),
    status: 'ACTIVE',
    evaluationProgress: 0,
    requiredDraws: REQUIRED_EVAL_DRAWS,
    evaluations: []
  };

  state.activeSnapshot = snapshot;
  state.stats.totalSnapshots += 1;
  state.meta.lastSnapshotCreatedAt = snapshot.createdAt;
  return snapshot;
}

// ── Evaluation ──────────────────────────────────────────────────────────
function evaluateActiveSnapshot(evalDraw) {
  const snap = state.activeSnapshot;
  if (!snap) return;

  const top4Set = new Set(snap.top4);
  const hits = evalDraw.numbers.filter(n => top4Set.has(n));
  const offset = snap.evaluationProgress + 1;

  snap.evaluations.push({
    offset,
    drawId: evalDraw.drawId,
    predictedNumbers: snap.top4.slice(),
    hits,
    hitCount: hits.length
  });
  snap.evaluationProgress = offset;

  // Zero-hit-draw monitor (spec §62) — early warning, independent of the
  // completed-window statistics it must not overwrite.
  if (hits.length === 0) {
    state.drought.consecutiveZeroHitDraws += 1;
    state.drought.drawsSinceLastHit += 1;
  } else {
    state.drought.consecutiveZeroHitDraws = 0;
    state.drought.drawsSinceLastHit = 0;
  }

  if (snap.evaluationProgress >= REQUIRED_EVAL_DRAWS) {
    completeSnapshot(snap);
  }
}

function calculateMetrics(snap) {
  const uniqueHitNumbers = new Set();
  let totalOccurrences = 0;
  let windowsWithHit = 0;

  for (const ev of snap.evaluations) {
    if (ev.hitCount > 0) windowsWithHit += 1;
    totalOccurrences += ev.hitCount;
    for (const h of ev.hits) uniqueHitNumbers.add(h);
  }

  const numberCoverage = round1((uniqueHitNumbers.size / TOP4_SIZE) * 100);
  const windowCoverage = round1((windowsWithHit / REQUIRED_EVAL_DRAWS) * 100);
  const totalOpportunities = TOP4_SIZE * REQUIRED_EVAL_DRAWS;
  const opportunityHitRate = round1((totalOccurrences / totalOpportunities) * 100);

  return {
    uniqueHitCount: uniqueHitNumbers.size,
    totalOccurrences,
    totalOpportunities,
    numberCoverage,
    windowCoverage,
    opportunityHitRate
  };
}

function completeSnapshot(snap) {
  const metrics = calculateMetrics(snap);

  snap.numberCoverage = metrics.numberCoverage;
  snap.windowCoverage = metrics.windowCoverage;
  snap.opportunityHitRate = metrics.opportunityHitRate;
  snap.status = 'COMPLETE';
  snap.completedAt = new Date().toISOString();

  // Lifetime tallies (spec §20)
  state.stats.completedSnapshots += 1;
  state.stats.totalOccurrences += metrics.totalOccurrences;
  state.stats.totalOpportunities += metrics.totalOpportunities;
  state.stats.numberCoverageRate = round1(
    (state.stats.numberCoverageRate * (state.stats.completedSnapshots - 1) + metrics.numberCoverage) / state.stats.completedSnapshots
  );
  state.stats.windowCoverageRate = round1(
    (state.stats.windowCoverageRate * (state.stats.completedSnapshots - 1) + metrics.windowCoverage) / state.stats.completedSnapshots
  );
  state.stats.opportunityHitRate = round1(
    (state.stats.totalOccurrences / state.stats.totalOpportunities) * 100
  );

  state.completedSnapshots.unshift(snap);
  if (state.completedSnapshots.length > RETAIN_COMPLETED) {
    state.completedSnapshots.length = RETAIN_COMPLETED;
  }

  snap.condition = calculateRollingAndCondition();

  state.activeSnapshot = null;
  state.meta.lastSnapshotCompletedAt = snap.completedAt;
}

// ── Rolling / baseline / condition / drought / recovery ────────────────
function rollingAvg(n) {
  const slice = state.completedSnapshots.slice(0, n);
  if (!slice.length) return null;
  const sum = slice.reduce((a, s) => a + s.opportunityHitRate, 0);
  return round1(sum / slice.length);
}

function calculateRollingMetrics() {
  state.rolling.last3 = rollingAvg(3);
  state.rolling.last5 = rollingAvg(5);
  state.rolling.last10 = rollingAvg(10);
  state.rolling.last20 = rollingAvg(20);
}

function calculateBaseline() {
  const completed = state.stats.completedSnapshots;
  const currentRate = state.rolling.last3 ?? state.stats.opportunityHitRate;
  if (completed === 0) {
    state.baseline = { hitRate: null, deviation: null, established: false };
    return;
  }
  // Lifetime opportunity hit rate is the long-run reference point (spec §21).
  const baselineRate = state.stats.opportunityHitRate;
  state.baseline = {
    hitRate: baselineRate,
    deviation: currentRate === null ? null : round1(currentRate - baselineRate),
    established: completed >= 10 // spec §22
  };
}

function bandFor(rate) {
  if (rate === null || rate === undefined) return 'EARLY_DATA';
  if (rate >= THRESHOLDS.healthy) return 'HEALTHY';
  if (rate >= THRESHOLDS.normal) return 'NORMAL';
  if (rate >= THRESHOLDS.caution) return 'CAUTION';
  return 'HIT_DROUGHT';
}

function detectDrought() {
  const last = state.completedSnapshots[0];
  if (!last) {
    state.drought.consecutiveWeakWindows = 0;
    return;
  }
  if (last.opportunityHitRate < THRESHOLDS.weakWindow) {
    state.drought.consecutiveWeakWindows += 1;
  } else {
    state.drought.consecutiveWeakWindows = 0;
  }

  const referenceRate = state.rolling.last5 ?? state.rolling.last3 ?? state.stats.opportunityHitRate;
  state.drought.active = state.drought.consecutiveWeakWindows >= THRESHOLDS.droughtStreak
    && referenceRate !== null && referenceRate < THRESHOLDS.weakWindow;
}

// BUG FIX: detectRecovery() previously read state.drought.active to decide
// whether there was anything to "recover" from — but detectDrought() runs
// immediately before this, in the same calculateRollingAndCondition() pass,
// and can already have cleared drought.active to false the moment a single
// window improves (consecutiveWeakWindows resets below droughtStreak). By
// the time detectRecovery() ran, the regime it needed to check against had
// already been erased, so RECOVERING could get skipped even after a real
// drought. Fix: capture wasInOrNearDrought from the *previous* condition
// label (set by the prior call to calculateCondition(), before this pass
// touched anything) instead of the drought flag detectDrought() just wrote.
function detectRecovery() {
  const snaps = state.completedSnapshots;
  const previousStatus = state.condition.status;
  const wasInOrNearDrought = state.drought.active || previousStatus === 'HIT_DROUGHT'
    || previousStatus === 'RECOVERING' || previousStatus === 'CAUTION';

  if (snaps.length < 2) {
    state.recovery.consecutiveImprovingWindows = 0;
    state.recovery.active = false;
    return;
  }
  const improving = snaps[0].opportunityHitRate > snaps[1].opportunityHitRate;
  if (improving) {
    state.recovery.consecutiveImprovingWindows += 1;
  } else {
    state.recovery.consecutiveImprovingWindows = 0;
  }

  // Recovery only means anything if we were (or still are) in/near a
  // drought — otherwise there's nothing to "recover" from (spec §27, §63).
  const wasWeak = wasInOrNearDrought || bandFor(snaps[0].opportunityHitRate) === 'HIT_DROUGHT'
    || bandFor(snaps[0].opportunityHitRate) === 'CAUTION';
  state.recovery.active = wasWeak && state.recovery.consecutiveImprovingWindows >= 1
    && state.recovery.consecutiveImprovingWindows < THRESHOLDS.recoveryStreak;
}

// Combines current rate + rolling trend + baseline + drought/recovery
// streaks + sample confidence into one condition label (spec §24-28, §60-63).
// Uses one-step hysteresis so a single good/bad window can't flip HEALTHY
// straight to HIT DROUGHT or vice versa.
function calculateCondition() {
  const completed = state.stats.completedSnapshots;
  const stage = sampleStage(completed);

  if (stage === 'EARLY_DATA' || stage === 'WATCHING') {
    // spec §26 — never let a tiny sample present as HEALTHY/DROUGHT.
    state.condition = { status: stage, sampleStage: stage };
    return;
  }

  const referenceRate = state.rolling.last5 ?? state.rolling.last3 ?? state.stats.opportunityHitRate;
  const rawBand = bandFor(referenceRate);
  const previousStatus = state.condition.status;

  let status;
  if (rawBand === 'HIT_DROUGHT') {
    // Require sustained weakness (spec §61) before declaring drought.
    status = state.drought.active ? 'HIT_DROUGHT' : 'CAUTION';
  } else if (state.drought.active || previousStatus === 'HIT_DROUGHT' || previousStatus === 'RECOVERING') {
    // Coming out of drought: require evidence, step through RECOVERING
    // rather than jumping straight to HEALTHY (spec §63).
    if (state.recovery.active) {
      status = 'RECOVERING';
    } else if (state.recovery.consecutiveImprovingWindows >= THRESHOLDS.recoveryStreak) {
      status = rawBand; // sustained improvement earns the raw band (NORMAL/HEALTHY)
    } else {
      status = rawBand === 'HEALTHY' ? 'NORMAL' : rawBand; // don't jump two levels at once
    }
  } else {
    status = rawBand;
  }

  state.condition = { status, sampleStage: stage };
}

function calculateRollingAndCondition() {
  calculateRollingMetrics();
  calculateBaseline();
  detectDrought();
  detectRecovery();
  calculateCondition();
  return state.condition.status;
}

// ── New-draw driver ─────────────────────────────────────────────────────
// allDrawsNewestFirst: dataStore.getAllDraws() — full accepted-draw history,
// sorted newest-first, taken immediately after a successful ingest.
function onNewDrawsIngested(allDrawsNewestFirst) {
  if (!Array.isArray(allDrawsNewestFirst) || !allDrawsNewestFirst.length) return;

  const chrono = allDrawsNewestFirst.slice().reverse(); // oldest → newest

  let startIdx = 0;
  if (state.lastProcessedDrawId) {
    const idx = chrono.findIndex(d => d.drawId === state.lastProcessedDrawId);
    startIdx = idx >= 0 ? idx + 1 : chrono.length; // if cursor draw vanished, don't reprocess blindly
  }

  for (let i = startIdx; i < chrono.length; i++) {
    const draw = chrono[i];

    // Defensive idempotency (spec §37) beyond the cursor.
    if (state.recentProcessedDrawIds.includes(draw.drawId)) continue;

    onNewDraw(draw, chrono.slice(0, i + 1));

    state.lastProcessedDrawId = draw.drawId;
    state.recentProcessedDrawIds.push(draw.drawId);
    if (state.recentProcessedDrawIds.length > 200) {
      state.recentProcessedDrawIds = state.recentProcessedDrawIds.slice(-200);
    }
  }

  saveState();
}

// drawsChronoSoFar: oldest→newest slice ending at `draw`. Converted to the
// newest-first shape numberEngine expects before use.
function onNewDraw(draw, drawsChronoSoFar) {
  try {
    if (!state.activeSnapshot) {
      // Snapshot duplicate protection (spec §38) — never key a new
      // snapshot off a draw already used as a source.
      const alreadyUsed = state.completedSnapshots.some(s => s.sourceDrawId === draw.drawId);
      if (alreadyUsed) return;

      const drawsNewestFirst = drawsChronoSoFar.slice().reverse();
      createRealitySnapshot(draw, drawsNewestFirst);
      // Source draw itself is never an evaluation draw (spec §9).
    } else {
      evaluateActiveSnapshot(draw);
    }
  } catch (e) {
    // Engine failure safety (spec §83) — never destroy active state, log and continue.
    state.meta.lastEngineError = { at: new Date().toISOString(), message: e.message };
  }
}

// ── Public read API ─────────────────────────────────────────────────────
function getStatus() {
  return {
    success: true,
    condition: state.condition.status,
    hitRate: state.stats.opportunityHitRate,
    numberCoverageRate: state.stats.numberCoverageRate,
    windowCoverageRate: state.stats.windowCoverageRate,
    rolling: { ...state.rolling },
    baseline: { ...state.baseline },
    sample: { completedTests: state.stats.completedSnapshots, stage: state.condition.sampleStage },
    drought: {
      active: state.drought.active,
      consecutiveWeakWindows: state.drought.consecutiveWeakWindows,
      drawsSinceLastHit: state.drought.drawsSinceLastHit
    },
    recovery: {
      active: state.recovery.active,
      consecutiveImprovingWindows: state.recovery.consecutiveImprovingWindows
    },
    activeTest: state.activeSnapshot ? {
      predictionId: state.activeSnapshot.predictionId,
      sourceDrawId: state.activeSnapshot.sourceDrawId,
      drawsCompleted: state.activeSnapshot.evaluationProgress,
      drawsRequired: state.activeSnapshot.requiredDraws
    } : null,
    backgroundAudit: true
  };
}

function getHistory(limit = 25) {
  const n = Math.min(200, Math.max(1, parseInt(limit, 10) || 25));
  return {
    success: true,
    tests: state.completedSnapshots.slice(0, n).map(s => ({
      predictionId: s.predictionId,
      sourceDrawId: s.sourceDrawId,
      top4: s.top4,
      evaluations: s.evaluations,
      numberCoverage: s.numberCoverage,
      windowCoverage: s.windowCoverage,
      opportunityHitRate: s.opportunityHitRate,
      condition: s.condition,
      completedAt: s.completedAt
    }))
  };
}

function getStats() {
  return {
    success: true,
    totalRealityTests: state.stats.totalSnapshots,
    completedRealityTests: state.stats.completedSnapshots,
    totalOccurrences: state.stats.totalOccurrences,
    totalOpportunities: state.stats.totalOpportunities,
    opportunityHitRate: state.stats.opportunityHitRate,
    numberCoverageRate: state.stats.numberCoverageRate,
    windowCoverageRate: state.stats.windowCoverageRate,
    rolling: { ...state.rolling },
    baseline: { ...state.baseline },
    drought: { ...state.drought },
    recovery: { ...state.recovery },
    sampleStage: state.condition.sampleStage
  };
}

function getDebug() {
  return {
    success: true,
    activeSnapshot: state.activeSnapshot,
    lastProcessedDrawId: state.lastProcessedDrawId,
    condition: state.condition,
    drought: state.drought,
    recovery: state.recovery,
    baseline: state.baseline,
    rolling: state.rolling,
    meta: state.meta
  };
}

function init() {
  loadState();
  // Restart recovery (spec §41): if an active snapshot exists it is simply
  // held in memory as-is — no replacement is generated on startup.
}

// BUG FIX: /api/clear wiped dataStore's draws but left this engine's
// persisted Reality state (activeSnapshot, completedSnapshots, stats,
// rolling, baseline, condition, drought, recovery, lastProcessedDrawId,
// recentProcessedDrawIds) fully intact. That let a stale Reality snapshot
// reference a sourceDrawId that no longer existed after a clear, and let
// old rolling/baseline/drought numbers keep influencing a "fresh" dataset.
// reset() restores this engine to defaultState() and persists it, so
// /api/clear can bring Reality state back in sync with draw history.
function reset() {
  state = defaultState();
  saveState();
}

// Kept for interface parity with the build spec (§32); the engine is
// entirely event-driven (onNewDrawsIngested), not interval-based, so these
// are no-ops beyond init().
function start() { /* no-op — event-driven, nothing to start */ }
function stop() { /* no-op — event-driven, nothing to stop */ }

module.exports = {
  init,
  start,
  stop,
  reset,
  onNewDrawsIngested,
  getStatus,
  getHistory,
  getStats,
  getDebug
};
