/**
 * 4SIL PAPER TRADER ENGINE — v1.1
 *
 * PURPOSE
 * -------
 * A virtual/paper trading engine that consumes the authoritative 4SIL
 * ENTER/MONITOR/PREPARE/PAUSE signal and measures how a fixed three-color
 * ladder strategy (RED+BLUE+GREEN simultaneously, every eligible ENTER
 * draw) would have performed against real draw outcomes.
 *
 *   LIVE DRAW DATA -> DATA PIPELINE -> 4SIL -> ENTER/MONITOR/PREPARE/PAUSE
 *     -> PAPER TRADER -> VIRTUAL TRADE -> RESULT EVALUATOR
 *     -> LADDER + WINDOW + CAPITAL ACCOUNTING
 *
 * No real-money betting is performed anywhere in this module. It never
 * writes to any real order/betting surface and it never feeds a signal,
 * weight, or gate back into 4SIL or any other engine (ABSOLUTE SEPARATION
 * RULE, spec section 40) -- this is a read-only evaluation consumer of
 * 4SIL's output, following the same one-way boundary this codebase
 * already enforces between fourBallEnterCallLog.js / entryHitCounter.js
 * and 4SIL.
 *
 * 4SIL SIGNAL MAPPING
 * --------------------
 * fourBallSeasonIntelligenceLab.js's own badge.operatorAction only ever
 * emits 'ENTER NOW' | 'PREPARE' | 'MONITOR' (see that engine's header);
 * there is no literal 'PAUSE' verb anywhere in this codebase. The spec's
 * four-state signal (ENTER/MONITOR/PREPARE/PAUSE) is derived here as:
 *   badge.active === false        -> 'PAUSE'  (no active 4-ball season;
 *                                               4SIL has nothing to time)
 *   operatorAction === 'ENTER NOW'-> 'ENTER'
 *   operatorAction === 'PREPARE'  -> 'PREPARE'
 *   operatorAction === 'MONITOR'  -> 'MONITOR'
 * Trading is permitted ONLY on 'ENTER'; the other three all stop trading
 * and preserve state exactly per spec section 2 / 19 / 43.
 *
 * DEBOUNCING (spec section 22)
 * -----------------------------
 * A trade happens only when a NEW eligible draw (drawId strictly greater
 * than lastProcessedDrawId) arrives while the signal is ENTER -- a run of
 * repeated ENTER cycles with no new draw never creates extra trades.
 * historicalDraws is newest-first (store convention); new draws are
 * collected and then replayed oldest-first so ladder/window state
 * advances in real chronological order.
 *
 * IDEMPOTENCY (spec section 21)
 * -------------------------------
 * lastProcessedDrawId is the dedup key: a draw already at or below it is
 * never re-traded, matching every other per-draw log in this codebase.
 *
 * This engine is OBSERVATIONAL/EVALUATIVE ONLY: it must be called AFTER
 * 4SIL each council cycle and never before, and its own state must never
 * be read back into 4SIL, fourBallParliament, or any gate/weight.
 */
'use strict';

const MAX_TRADE_LOG_ENTRIES = 3000;
const MAX_WINDOW_LOG_ENTRIES = 500;
const MAX_CYCLE_LOG_ENTRIES = 500;
const MAX_RESET_LOG_ENTRIES = 500;

// ---------------------------------------------------------------------------
// Default production configuration (spec sections 4, 6, 7, 17, 20)
// ---------------------------------------------------------------------------

// Ladder table -- section 6. Index 0 = Stage 1 (₦50/color) ... index 11 =
// Stage 12 (₦3,000/color). Configurable via config.ladder, but these
// remain the default production values.
const DEFAULT_LADDER = [50, 100, 150, 200, 300, 400, 600, 700, 1000, 1500, 2000, 3000];

// v1.2's single change from v1.1: every ladder stage now receives 3
// consecutive eligible trades instead of 2 (each ladder stage -- e.g.
// Stage 1 @ ₦50, Stage 2 @ ₦100, etc. -- is repeated 3x before the
// engine advances to the next stage).
const ATTEMPTS_PER_LADDER_STAGE = 3;

// Draw window clock -- section 8, 20. The window boundary used to CLOSE a
// window and open the next one. The spec allows the true boundary to be
// 10 or 11 depending on the configured 4SIL trading window; this engine
// defaults to the minimum (10) and exposes it as config.windowSize.
const WINDOW_SIZE_MIN = 10;
const WINDOW_SIZE_MAX = 11;
const DEFAULT_WINDOW_SIZE = WINDOW_SIZE_MIN;

// Reset trigger #1 -- section 9: minimum 3 hits within a window triggers
// an immediate ladder reset (does not wait for the window boundary).
const WINDOW_HIT_RESET_THRESHOLD = 3;

// Reset trigger #2 -- section 11: 2 consecutive HITs at the SAME ladder
// stage triggers an immediate ladder reset, regardless of stake size.
const SAME_STAGE_CONSECUTIVE_HIT_RESET_THRESHOLD = 2;

// Payout model -- section 4.
const DEFAULT_PAYOUT_MULTIPLIER = 12;

// Paper capital -- section 17.
const DEFAULT_STARTING_CAPITAL = 100000;

function defaultConfig() {
  return {
    ladder: DEFAULT_LADDER.slice(),
    attemptsPerStage: ATTEMPTS_PER_LADDER_STAGE,
    windowSize: DEFAULT_WINDOW_SIZE,
    windowHitResetThreshold: WINDOW_HIT_RESET_THRESHOLD,
    sameStageConsecutiveHitResetThreshold: SAME_STAGE_CONSECUTIVE_HIT_RESET_THRESHOLD,
    payoutMultiplier: DEFAULT_PAYOUT_MULTIPLIER,
    startingCapital: DEFAULT_STARTING_CAPITAL
  };
}

// ---------------------------------------------------------------------------
// State factory (persisted at store.paperTrader)
// ---------------------------------------------------------------------------

function freshLadderCycle(cycleId, startingCapital) {
  return {
    cycleId,
    startedAt: new Date().toISOString(),
    closedAt: null,
    startingCapital,
    endingCapital: null,
    stage: 1,               // 1-based index into config.ladder
    attempt: 0,              // attempts completed at the current stage
    stageHits: 0,
    stageMisses: 0,
    consecutiveHits: 0,      // consecutive HITs at the CURRENT stage only
    lastResultAtStage: null, // 'HIT' | 'MISS' | null -- resets whenever the stage changes
    maxStageReached: 1,
    totalStaked: 0,
    totalReturned: 0,
    netPnL: 0,
    resetTriggered: false,
    resetReason: null
  };
}

function freshDrawWindow(windowId) {
  return {
    windowId,
    startDrawId: null,
    endDrawId: null,
    eligibleDraws: 0,
    hits: 0,
    misses: 0,
    totalStaked: 0,
    totalReturned: 0,
    netPnL: 0,
    startingCapital: null,
    endingCapital: null,
    startingLadderStage: null,
    endingLadderStage: null,
    resetTriggered: false,
    resetReason: null,
    closedAt: null
  };
}

function freshPaperTraderState(config) {
  const cfg = { ...defaultConfig(), ...(config || {}) };
  return {
    schemaVersion: 1,
    config: cfg,

    // Paper Trader state machine -- spec section 30.
    // IDLE | WAITING_FOR_ENTER | ACTIVE | PAUSED | WINDOW_CLOSED | RESETTING | LADDER_LIMIT_REACHED
    tradingState: 'WAITING_FOR_ENTER',
    signal: null,           // last derived 4SIL signal: ENTER | MONITOR | PREPARE | PAUSE
    ladderLimitReached: false,

    lastProcessedDrawId: null,

    // ENTER-run tracking (independent of ladder cycleId — see NEI fix #1).
    // A "run" is one unbroken stretch of ENTER draws; it starts fresh any
    // time a draw is processed under ENTER immediately after a draw that
    // was NOT traded under ENTER. Ladder cycles can reset mid-run (hits,
    // stage limits) without ending the run, so this is tracked separately
    // and is the correct anchor for ENTER→EVENT latency measurement.
    wasLastDrawEnter: false,
    enterRun: { id: 0, startDrawId: null, drawsIntoRun: 0 },

    nextCycleId: 1,
    nextWindowId: 1,

    cycle: freshLadderCycle(1, cfg.startingCapital),
    window: freshDrawWindow(1),

    capital: {
      startingCapital: cfg.startingCapital,
      currentCapital: cfg.startingCapital,
      realizedPnL: 0,
      lockedProfit: 0,
      totalStaked: 0,
      totalReturned: 0
    },

    trades: [],   // newest-first
    windows: [],  // closed windows, newest-first
    cycles: [],   // closed cycles, newest-first
    resets: [],   // reset events, newest-first

    updatedAt: null
  };
}

// Mutates persistentState IN PLACE and returns the same reference --
// matches every other engine's ensureStateShape() convention in this
// codebase (see fourSilHitAverageEngine.js). This matters: council.js
// passes store.paperTrader directly, and the caller never reassigns
// store.paperTrader to whatever this function returns, so a copy here
// would silently detach the live state from the store.
function ensureStateShape(persistentState) {
  const fresh = freshPaperTraderState();
  const s = persistentState && typeof persistentState === 'object' ? persistentState : fresh;
  if (s.schemaVersion == null) s.schemaVersion = 1;
  s.config = { ...fresh.config, ...(s.config || {}) };
  if (!s.tradingState) s.tradingState = fresh.tradingState;
  if (typeof s.signal === 'undefined') s.signal = null;
  s.ladderLimitReached = Boolean(s.ladderLimitReached);
  if (typeof s.lastProcessedDrawId === 'undefined') s.lastProcessedDrawId = null;
  if (typeof s.wasLastDrawEnter === 'undefined') s.wasLastDrawEnter = false;
  if (!s.enterRun || typeof s.enterRun !== 'object') s.enterRun = { id: 0, startDrawId: null, drawsIntoRun: 0 };
  if (!s.nextCycleId) s.nextCycleId = fresh.nextCycleId;
  if (!s.nextWindowId) s.nextWindowId = fresh.nextWindowId;
  if (!s.cycle || typeof s.cycle !== 'object') s.cycle = fresh.cycle;
  if (!s.window || typeof s.window !== 'object') s.window = fresh.window;
  if (!s.capital || typeof s.capital !== 'object') s.capital = fresh.capital;
  if (!Array.isArray(s.trades)) s.trades = [];
  if (!Array.isArray(s.windows)) s.windows = [];
  if (!Array.isArray(s.cycles)) s.cycles = [];
  if (!Array.isArray(s.resets)) s.resets = [];
  if (typeof s.updatedAt === 'undefined') s.updatedAt = null;
  return s;
}

// ---------------------------------------------------------------------------
// 4SIL signal derivation -- see header comment for the mapping rationale.
// ---------------------------------------------------------------------------

function deriveSignal(fourSIL) {
  const f = fourSIL || {};
  if (f.active === false) return 'PAUSE';
  const badge = f.badge || {};
  if (badge.operatorAction === 'ENTER NOW') return 'ENTER';
  if (badge.operatorAction === 'PREPARE') return 'PREPARE';
  return 'MONITOR';
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Advance the paper trader for the current council cycle.
 * Must be called AFTER 4SIL (evaluateFourBallSeasonIntelligenceLab) each
 * cycle -- see header for the separation rule.
 *
 * @param {Array} historicalDraws newest-first draw history (store.getRecentDraws)
 * @param {Object} fourSIL        this cycle's 4SIL result (evaluateFourBallSeasonIntelligenceLab output)
 * @param {Object} persistentState store.paperTrader (mutated in place)
 * @returns {Object} read-only summary for snapshot / dashboard
 */
function advancePaperTrader(historicalDraws, fourSIL, persistentState) {
  const state = ensureStateShape(persistentState);
  const cfg = state.config;
  const draws = Array.isArray(historicalDraws) ? historicalDraws : [];
  const signal = deriveSignal(fourSIL);
  state.signal = signal;

  // Collect draws newer than lastProcessedDrawId, oldest-first, so ladder
  // and window state advances in real chronological order (spec section
  // 21 idempotency + section 22 debouncing).
  const lastId = state.lastProcessedDrawId != null ? Number(state.lastProcessedDrawId) : -Infinity;
  const newDraws = [];
  for (let i = 0; i < draws.length; i++) {
    const d = draws[i];
    const id = Number(d.drawId);
    if (Number.isFinite(id) && id > lastId) newDraws.push(d);
  }
  newDraws.sort((a, b) => Number(a.drawId) - Number(b.drawId));

  for (const draw of newDraws) {
    const isEnter = signal === 'ENTER';

    // ENTER-run boundary detection (NEI fix #1): a new run starts whenever
    // an ENTER draw is processed and the immediately preceding processed
    // draw (of any kind) was NOT an ENTER draw. This is independent of
    // ladder cycleId, which can reset mid-run without a genuine break in
    // 4SIL's ENTER signal.
    if (isEnter) {
      if (!state.wasLastDrawEnter) {
        state.enterRun.id += 1;
        state.enterRun.startDrawId = draw.drawId;
        state.enterRun.drawsIntoRun = 0;
      }
      state.enterRun.drawsIntoRun += 1;
    }

    processOneDraw(state, cfg, draw, signal, state.enterRun.id, state.enterRun.drawsIntoRun);
    state.wasLastDrawEnter = isEnter;
    state.lastProcessedDrawId = draw.drawId;
  }

  // Trading state machine -- spec section 30. When trading stops, the
  // current ladder, attempt counter, window counter, capital and all
  // statistics are preserved (spec section 2) -- nothing below this line
  // mutates cycle/window/capital.
  if (state.ladderLimitReached) {
    state.tradingState = 'LADDER_LIMIT_REACHED';
  } else if (signal === 'ENTER') {
    state.tradingState = 'ACTIVE';
  } else {
    state.tradingState = 'PAUSED';
  }

  state.updatedAt = new Date().toISOString();
  return buildSummary(state);
}

// ---------------------------------------------------------------------------
// Per-draw trade processing
// ---------------------------------------------------------------------------

function processOneDraw(state, cfg, draw, signal, enterRunId, drawsIntoEnterRun) {
  // MONITOR / PREPARE / PAUSE: does not consume a trading draw, is not a
  // MISS, does not close a window, does not reset, does not advance the
  // ladder (spec sections 2, 8, 19, 43). Only lastProcessedDrawId moves.
  if (signal !== 'ENTER' || state.ladderLimitReached) return;

  const ladder = Array.isArray(cfg.ladder) && cfg.ladder.length ? cfg.ladder : DEFAULT_LADDER;
  const cycle = state.cycle;
  const window = state.window;

  if (window.startDrawId == null) window.startDrawId = draw.drawId;
  if (window.startingCapital == null) window.startingCapital = state.capital.currentCapital;
  if (window.startingLadderStage == null) window.startingLadderStage = cycle.stage;

  const stakePerColor = ladder[cycle.stage - 1];
  const totalStake = stakePerColor * 3;

  // Market model -- section 3: RED+BLUE+GREEN simultaneously, each at the
  // current stake. Result model -- section 5: HIT if the draw's 4-ball
  // outcome is any of the three covered colors, i.e. whenever
  // draw.fourBallColor is set at all (RED/BLUE/GREEN are ALL covered).
  const winningColor = draw.fourBallColor || null;
  const result = winningColor ? 'HIT' : 'MISS';
  const grossReturn = result === 'HIT' ? stakePerColor * cfg.payoutMultiplier : 0;
  const netPnL = grossReturn - totalStake;

  const capitalBefore = state.capital.currentCapital;
  state.capital.totalStaked += totalStake;
  state.capital.totalReturned += grossReturn;
  state.capital.realizedPnL += netPnL;
  state.capital.currentCapital += netPnL;
  const capitalAfter = state.capital.currentCapital;

  cycle.attempt += 1;
  cycle.totalStaked += totalStake;
  cycle.totalReturned += grossReturn;
  cycle.netPnL += netPnL;
  if (result === 'HIT') cycle.stageHits += 1; else cycle.stageMisses += 1;

  // Same-stage consecutive-HIT tracking -- sections 11-13. The counter
  // resets whenever the stage changes (freshLadderCycle / the advance
  // branch below always zero it), so this is purely "did the previous
  // trade AT THIS STAGE also HIT."
  const consecutiveHits = (result === 'HIT' && cycle.lastResultAtStage === 'HIT')
    ? cycle.consecutiveHits + 1
    : (result === 'HIT' ? 1 : 0);
  cycle.consecutiveHits = consecutiveHits;
  cycle.lastResultAtStage = result;

  window.eligibleDraws += 1;
  window.totalStaked += totalStake;
  window.totalReturned += grossReturn;
  window.netPnL += netPnL;
  window.endDrawId = draw.drawId;
  if (result === 'HIT') window.hits += 1; else window.misses += 1;

  const windowResetTriggered = window.hits >= cfg.windowHitResetThreshold;
  const stageResetTriggered = consecutiveHits >= cfg.sameStageConsecutiveHitResetThreshold;
  const resetTriggered = windowResetTriggered || stageResetTriggered;

  let resetReason = null;
  if (windowResetTriggered && stageResetTriggered) {
    resetReason = 'WINDOW_3_HITS_AND_SAME_STAGE_2_CONSECUTIVE_HITS';
  } else if (windowResetTriggered) {
    resetReason = 'WINDOW_3_HITS';
  } else if (stageResetTriggered) {
    resetReason = 'SAME_STAGE_2_CONSECUTIVE_HITS';
  }

  const trade = {
    tradeId: `${draw.drawId}-${cycle.cycleId}`,
    timestamp: new Date().toISOString(),
    drawId: draw.drawId,
    signal: 'ENTER',
    windowId: window.windowId,
    windowDrawNumber: window.eligibleDraws,
    cycleId: cycle.cycleId,
    // ENTER-run identity — the correct anchor for ENTER→EVENT latency
    // (see NEI fix #1). Distinct from cycleId, which tracks ladder resets.
    enterRunId,
    drawsIntoEnterRun,
    ladderStage: cycle.stage,
    stakePerColor,
    totalStake,
    colors: { RED: stakePerColor, BLUE: stakePerColor, GREEN: stakePerColor },
    winningColor,
    result,
    grossReturn,
    netPnL,
    stageAttempt: cycle.attempt,
    stageHits: cycle.stageHits,
    stageMisses: cycle.stageMisses,
    consecutiveHits,
    windowHits: window.hits,
    windowMisses: window.misses,
    capitalBefore,
    capitalAfter,
    resetTriggered,
    resetReason
  };
  state.trades.unshift(trade);
  if (state.trades.length > MAX_TRADE_LOG_ENTRIES) state.trades.length = MAX_TRADE_LOG_ENTRIES;

  if (resetTriggered) {
    performReset(state, cfg, resetReason, draw.drawId);
  } else if (cycle.attempt >= cfg.attemptsPerStage) {
    advanceLadderStage(state, ladder);
  }

  maybeCloseWindow(state, cfg);
}

// ---------------------------------------------------------------------------
// Reset procedure -- spec section 15. Capital is never reset, only the
// ladder position; the window keeps counting independently toward its
// own boundary (spec section 24: "the two counters must remain
// independent").
// ---------------------------------------------------------------------------

function performReset(state, cfg, resetReason, drawId) {
  const cycle = state.cycle;
  const window = state.window;

  cycle.closedAt = new Date().toISOString();
  cycle.endingCapital = state.capital.currentCapital;
  cycle.resetTriggered = true;
  cycle.resetReason = resetReason;

  state.capital.lockedProfit += cycle.netPnL;

  window.resetTriggered = true;
  window.resetReason = window.resetReason
    ? `${window.resetReason}+${resetReason}`
    : resetReason;

  state.resets.unshift({
    resetAt: new Date().toISOString(),
    drawId,
    reason: resetReason,
    previousCycleId: cycle.cycleId,
    previousStage: cycle.stage,
    cyclePnL: cycle.netPnL,
    windowId: window.windowId,
    windowHits: window.hits,
    capitalAfter: state.capital.currentCapital
  });
  if (state.resets.length > MAX_RESET_LOG_ENTRIES) state.resets.length = MAX_RESET_LOG_ENTRIES;

  state.cycles.unshift(cycle);
  if (state.cycles.length > MAX_CYCLE_LOG_ENTRIES) state.cycles.length = MAX_CYCLE_LOG_ENTRIES;

  state.nextCycleId += 1;
  state.cycle = freshLadderCycle(state.nextCycleId, state.capital.currentCapital);
}

// ---------------------------------------------------------------------------
// Ladder advancement -- spec sections 28-29 (v1.1: after 2 attempts, not 3).
// ---------------------------------------------------------------------------

function advanceLadderStage(state, ladder) {
  const cycle = state.cycle;
  if (cycle.stage >= ladder.length) {
    // LADDER_LIMIT_REACHED -- section 29: stop and flag for operator
    // review rather than inventing a stage beyond the configured table.
    state.ladderLimitReached = true;
    return;
  }
  cycle.stage += 1;
  cycle.attempt = 0;
  cycle.stageHits = 0;
  cycle.stageMisses = 0;
  cycle.consecutiveHits = 0;
  cycle.lastResultAtStage = null;
  cycle.maxStageReached = Math.max(cycle.maxStageReached, cycle.stage);
}

// ---------------------------------------------------------------------------
// Window boundary -- spec sections 18, 20, 24.
// ---------------------------------------------------------------------------

function maybeCloseWindow(state, cfg) {
  const window = state.window;
  if (window.eligibleDraws < cfg.windowSize) return;

  window.closedAt = new Date().toISOString();
  window.endingCapital = state.capital.currentCapital;
  window.endingLadderStage = state.cycle.stage;

  state.windows.unshift(window);
  if (state.windows.length > MAX_WINDOW_LOG_ENTRIES) state.windows.length = MAX_WINDOW_LOG_ENTRIES;

  state.nextWindowId += 1;
  state.window = freshDrawWindow(state.nextWindowId);
}

// ---------------------------------------------------------------------------
// Performance / analytics rollups -- spec sections 25, 26, 34, 35, 37.
// Derived read-only from the stored logs, same convention as
// fourSilHitAverageEngine.js's buildSummary().
// ---------------------------------------------------------------------------

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function buildPerformance(state) {
  const trades = state.trades;
  const totalTrades = trades.length;
  let totalHits = 0, totalStake = 0, totalReturn = 0;
  let maxLadderStageReached = state.cycle.maxStageReached;
  let maxDrawdown = 0;
  let peakCapital = state.capital.startingCapital;
  const stageStats = {}; // stage -> { hits, misses, pnl, count, resets }

  // Walk oldest-first for drawdown/peak tracking.
  const chronological = trades.slice().reverse();
  for (const t of chronological) {
    if (t.result === 'HIT') totalHits++;
    totalStake += t.totalStake;
    totalReturn += t.grossReturn;
    if (t.capitalAfter > peakCapital) peakCapital = t.capitalAfter;
    const drawdown = peakCapital - t.capitalAfter;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    if (t.ladderStage > maxLadderStageReached) maxLadderStageReached = t.ladderStage;

    if (!stageStats[t.ladderStage]) {
      stageStats[t.ladderStage] = { stage: t.ladderStage, hits: 0, misses: 0, pnl: 0, count: 0, resets: 0 };
    }
    const ss = stageStats[t.ladderStage];
    ss.count += 1;
    ss.pnl += t.netPnL;
    if (t.result === 'HIT') ss.hits += 1; else ss.misses += 1;
    if (t.resetTriggered) ss.resets += 1;
  }

  const closedCycles = state.cycles;
  const avgLadderStage = closedCycles.length
    ? round2(closedCycles.reduce((sum, c) => sum + c.maxStageReached, 0) / closedCycles.length)
    : (totalTrades ? round2(trades.reduce((s, t) => s + t.ladderStage, 0) / totalTrades) : null);

  const closedWindows = state.windows;
  const windowsWith3PlusHits = closedWindows.filter(w => w.hits >= 3).length;

  const resets = state.resets;
  const windowResets = resets.filter(r => r.reason.indexOf('WINDOW_3_HITS') !== -1).length;
  const consecutiveHitResets = resets.filter(r => r.reason.indexOf('SAME_STAGE_2_CONSECUTIVE_HITS') !== -1).length;
  const combinedResets = resets.filter(r => r.reason === 'WINDOW_3_HITS_AND_SAME_STAGE_2_CONSECUTIVE_HITS').length;

  return {
    overall: {
      totalTrades,
      totalHits,
      totalMisses: totalTrades - totalHits,
      hitRate: totalTrades ? round2((totalHits / totalTrades) * 100) : null,
      totalStake: round2(totalStake),
      totalReturn: round2(totalReturn),
      netPnL: round2(totalReturn - totalStake),
      roi: totalStake ? round2(((totalReturn - totalStake) / totalStake) * 100) : null
    },
    ladder: {
      byStage: Object.values(stageStats)
        .sort((a, b) => a.stage - b.stage)
        .map(s => ({
          stage: s.stage,
          trades: s.count,
          hits: s.hits,
          misses: s.misses,
          hitRate: s.count ? round2((s.hits / s.count) * 100) : null,
          pnl: round2(s.pnl),
          resetsFromStage: s.resets
        })),
      maxLadderStageReached,
      averageLadderStage: avgLadderStage
    },
    windows: {
      totalWindows: closedWindows.length,
      averageHitsPerWindow: closedWindows.length
        ? round2(closedWindows.reduce((s, w) => s + w.hits, 0) / closedWindows.length)
        : null,
      windowsWith3PlusHits: windowsWith3PlusHits,
      windowsUnder3Hits: closedWindows.length - windowsWith3PlusHits,
      totalWindowPnL: round2(closedWindows.reduce((s, w) => s + w.netPnL, 0))
    },
    resets: {
      totalResets: resets.length,
      windowResets,
      consecutiveHitResets,
      combinedResets,
      averageCycleProfitBeforeReset: resets.length
        ? round2(resets.reduce((s, r) => s + r.cyclePnL, 0) / resets.length)
        : null
    },
    risk: {
      maxDrawdown: round2(maxDrawdown),
      maxLadderStageReached,
      ladderLimitReached: state.ladderLimitReached
    }
  };
}

function buildSummary(state) {
  const performance = buildPerformance(state);
  const cfg = state.config;
  return {
    engine: 'PaperTrader',
    tradingState: state.tradingState,
    signal: state.signal,
    ladderLimitReached: state.ladderLimitReached,
    config: cfg,
    cycle: state.cycle,
    window: state.window,
    capital: state.capital,
    currentTrade: state.trades[0] || null,
    lastReset: state.resets[0] || null,
    performance,
    trades: state.trades.slice(0, 100),
    windows: state.windows.slice(0, 50),
    cycles: state.cycles.slice(0, 50),
    resets: state.resets.slice(0, 50),
    updatedAt: state.updatedAt
  };
}

module.exports = {
  DEFAULT_LADDER,
  ATTEMPTS_PER_LADDER_STAGE,
  WINDOW_SIZE_MIN,
  WINDOW_SIZE_MAX,
  DEFAULT_WINDOW_SIZE,
  WINDOW_HIT_RESET_THRESHOLD,
  SAME_STAGE_CONSECUTIVE_HIT_RESET_THRESHOLD,
  DEFAULT_PAYOUT_MULTIPLIER,
  DEFAULT_STARTING_CAPITAL,
  defaultConfig,
  freshPaperTraderState,
  ensureStateShape,
  deriveSignal,
  advancePaperTrader,
  buildSummary
};
