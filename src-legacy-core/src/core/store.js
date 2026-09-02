/**
 * Central State, Regime Statistics & Weight Registry module.
 * Registers state, weights, and EMA Brier statistics for all 34 engines.
 */
const INITIAL_ENGINE_WEIGHTS = {
  // General Parliament (11 Engines)
  '3B_Momentum': 1.4,
  '3B_Cycle': 1.1,
  '3B_DNA': 1.2,
  '3B_Probability': 1.3,
  '3B_Transition': 1.3,
  '3B_Recovery': 1.0,
  '3B_Pattern': 1.2,
  '3B_Gap': 1.0,
  '3B_Confidence': 1.1,
  '3B_CapitalProtection': 1.5,
  '3B_Dominance': 1.2,

  // 4Ball Parliament (11 Engines)
  '4B_SeasonStrength': 1.8,
  '4B_EntryIntel': 1.6,
  '4B_ExitIntel': 1.5,
  '4B_FirstAppearance': 1.4,
  '4B_LastStand': 1.5,
  '4B_TransitionRisk': 1.3,
  '4B_CapitalProtection': 1.9,
  '4B_DNA': 1.3,
  '4B_Lifecycle': 1.4,
  '4B_Recovery': 1.2,
  '4B_Dominance': 1.5,
  // Blueprint "4-Ball Engine Roadmap" additions (Season Intelligence,
  // Dynamic Dominance, Challenger Engine) -- see src/engines/
  // {seasonIntelligenceEngine,dynamicDominanceEngine,challengerEngine}.js.
  // Exit Intelligence is NOT a separate weighted vote: it replaces the
  // existing '4B_ExitIntel' engine's threshold logic in place, so no new
  // weight entry is needed for it.
  '4B_SeasonIntelligence': 1.7,
  '4B_DynamicDominance': 1.6,
  '4B_Challenger': 1.5,

};

const REGIMES = ['ORDERED', 'TRANSITION', 'CHAOTIC'];

// Tier Engine forecast-accuracy tracking (Recommendation #1: close the
// feedback loop). Every runSupremeCouncil() cycle appends ONE entry here
// recording what the Tier Engine forecast for the NEXT draw, BEFORE that
// draw's outcome is known. The next time a draw is ingested,
// evaluateAndLearn() (learning.js) looks up the most recent unscored
// entry and grades it against what actually happened, then marks it
// scored in place. This is the only way to answer "is this engine's
// TIE_IMMINENT call actually better than the baseline tie rate?" -- see
// tieEngine.js's header for the full rationale; before this, the engine's
// forecasts were silently overwritten every cycle with nothing checking
// whether they came true.
function defaultTierForecastLogEntry() {
  return {
    forDrawId: null,           // the draw ID this forecast was made ABOUT (filled in once that draw arrives, since it's unknown at forecast time)
    madeAfterDrawId: null,     // the most recent draw ID the forecast was computed FROM
    timestamp: null,
    marketStateLabel: null,
    operatorAction: null,
    riskLevel: null,
    tieProbabilityPct: null,
    drawsUntilNextTie: null,
    activeSeasonAtForecast: false,
    // Blueprint upgrade (spec section 9 Performance Loop): Pressure,
    // Expected Window, and Confidence alongside the existing
    // Probability/Draw ID/Actual/Hit-Miss fields already tracked below.
    tiePressureScore: null,
    expectedWindowLabel: null,
    confidenceLabel: null,
    scored: false,
    actualWasTie: null,
    hit: null                  // for TIE_ACTIVE/READY and TIE_APPROACHING/WATCH calls specifically: did the next draw(s) actually tie?
  };
}

// Tie Precursor Pattern Engine forecast-accuracy tracking -- the same
// closed-loop treatment as defaultTierForecastLogEntry()/tierForecastLog
// above, applied to tiePrecursorPatternEngine.js. Before this, the
// engine recomputed a fresh combinedScore/riskLevel every cycle from
// pure historical recompute (see that engine's own header: "PURE
// RECOMPUTE, NO PERSISTENT LOG") but never logged what it called before
// the outcome was known, never checked whether a specific call turned
// out right, and never fed its own track record back into its
// combinedScore the way calibrateTieProbability() does for the Tier
// Engine's tieProbabilityPct. This log is what closes that loop:
// - recordTiePrecursorForecast() appends one entry per cycle, BEFORE the
//   next draw's outcome is known, recording exactly what the engine
//   currently believes (riskLevel, combinedScore, which precursor(s) are
//   live).
// - scoreTiePrecursorForecast() (called from evaluateAndLearn(), same
//   call site and same "score before this cycle's forecast overwrites
//   anything" ordering as scoreTierForecast()) grades the oldest unscored
//   entry against what the next draw actually was.
// - buildTiePrecursorCalibrationData() aggregates the scored history by
//   riskLevel bucket for tiePrecursorPatternEngine.js's own
//   calibratePrecursorScore() to blend against, mirroring
//   calibrateTieProbability()'s shrinkage method exactly.
function defaultTiePrecursorForecastLogEntry() {
  return {
    forDrawId: null,           // the draw ID this forecast was made ABOUT (filled in once that draw arrives)
    madeAfterDrawId: null,     // the most recent draw ID the forecast was computed FROM
    timestamp: null,
    riskLevel: null,
    rawCombinedScore: null,    // the engine's own pre-calibration combinedScore this cycle
    calibratedCombinedScore: null, // combinedScore actually shown on the dashboard this cycle (post-calibration)
    elevatedRisk: false,       // prediction.elevatedRisk at forecast time
    activePrecursors: [],      // e.g. ['FOUR_BALL'], ['YELLOW_49'], both, or []
    scored: false,
    actualWasTie: null,
    hit: null                  // for elevatedRisk===true calls specifically: did the next draw actually tie? null for non-calls (same convention as tierForecastLog's hit field)
  };
}

class MemoryStore {
  constructor() {
    this.historicalDraws = [];
    this.engineWeights = { ...INITIAL_ENGINE_WEIGHTS };
    this.engineStats = {};
    this.regimeEngineStats = {};
    this.recommendationLog = [];
    // Tier Engine forecast-accuracy log -- see defaultTierForecastLogEntry()
    // above. Every runSupremeCouncil() cycle appends the current forecast
    // for the NEXT draw; evaluateAndLearn() scores the most recent
    // unscored entry once that draw's outcome is known. Bounded the same
    // way recommendationLog is (100 entries).
    this.tierForecastLog = [];
    // Tie Precursor Pattern Engine forecast-accuracy log -- see
    // defaultTiePrecursorForecastLogEntry() above. Same mechanics as
    // tierForecastLog, independent log, independent engine.
    this.tiePrecursorForecastLog = [];
    this.cachedSystemState = null;
    this.startTime = Date.now();
    // BUGFIX: `this.tieIntelligence = {` was missing here in the original
    // constructor — the property lines below were orphaned floating
    // expressions (a JS labeled-statement no-op). The field was effectively
    // undefined until the first runSupremeCouncil() call overwrote it, which
    // worked at runtime but broke --check syntax validation and confused
    // any consumer that read tieIntelligence before the first council cycle.
    this.tieIntelligence = {
      sufficientSample: false,
      sampleSize: 0,
      totalTies: 0,
      tieRatePct: 0,
      recentWindowDraws: 0,
      recentTies: 0,
      recentRatePct: 0,
      lastTie: null,
      intervalStats: { count: 0, avgIntervalDraws: null, medianIntervalDraws: null, longestGapDraws: null, shortestGapDraws: null, mostCommonInterval: null },
      currentTieStreak: 0,
      detectedCycle: null,
      seasons: [],
      activeSeason: null,
      // Tie Pressure Score defaults (blueprint upgrade, spec section 3)
      tiePressure: {
        score: 0,
        agreementCount: 0,
        signals: {
          frequency: { score: 0 },
          interval: { score: 0 },
          pattern: { score: 0 },
          transition: { score: 0 }
        }
      },
      expectedWindow: { label: 'NEXT 1-5 DRAWS', fromDraws: 1, toDraws: 5, tightened: false },
      confidenceLabel: 'LOW',
      tiePrediction: {
        tieProbabilityPct: 0,
        confidenceScore: 0,
        riskLevel: 'LOW',
        confidenceLabel: 'LOW',
        // Market-state defaults (blueprint upgrade)
        marketStateLabel: 'NO_EDGE',
        operatorAction: 'NO_ACTION',
        tieApproaching: false,
        drawsUntilNextTie: null,
        expectedWindow: { label: 'NEXT 1-5 DRAWS', fromDraws: 1, toDraws: 5, tightened: false },
        tiePressureScore: 0,
        alert: null
      },
      tieWarning: { level: 'LOW', score: 0, reasoning: 'No draws ingested yet.' },
      // Top-level aliases matching tieEngine.js's return shape
      marketStateLabel: 'NO_EDGE',
      operatorAction: 'NO_ACTION',
      tieApproaching: false,
      drawsUntilNextTie: null,
      tiePressureScore: 0,
      confidenceLabel: 'LOW'
    };
    // Event Intelligence -- ported from Color Parliament's
    // eventIntelligenceEngine.js (First Appearance / Transition Corridor /
    // Last Stand for the 4-Ball engine). Unlike tieIntelligence above, this
    // IS genuinely stateful across calls (Event Memory, pending First
    // Appearance resolution, color return-gap model) -- see
    // engines/eventIntelligenceEngineCP.js's header for why it can't be a
    // pure recompute-from-history function. Mutated in place by
    // runEventIntelligence(), not replaced wholesale each call.
    this.eventIntelligence = {
      colorReturnModel: {},
      eventMemory: [],
      pendingFirstAppearance: null,
      lastCertifiedLastStand: null,
      lastRecordedSeasonEnd: null
    };
    // 4-Ball Tie Cluster Engine persistent memory -- see
    // fourBallTieClusterEngine.js's header. Tracks genuine tie occurrences
    // (deduplicated by drawId) across cycles so the REPEATED_TIE_CLUSTER
    // gate condition can require two DISTINCT genuine ties within a
    // rolling window before voting, rather than a stateless per-cycle
    // frequency read. Separate object from fourBallSILMemory (never read
    // or written by 4SIL directly) -- 4SIL only ever sees this engine's
    // already-computed OUTPUT via council.js, same read-only boundary as
    // fourBallTieBirthEngine.js's own relationship to 4SIL.
    this.fourBallTieClusterMemory = {
      schemaVersion: 1,
      lastProcessedDrawId: null,
      strongTieLog: [],
      activeCluster: null,
      updatedAt: null
    };
    // 4SIL Upgrade Blueprint §21 -- unified per-event audit log. One
    // record per real draw (drawId + tieScore + cascadeState +
    // transitionState + final4SILState + enterSignal, all cross-
    // referenced together), distinct from fourBallTieClusterMemory's
    // strongTieLog above, which only logs Strong Ties with 4 narrow
    // fields for its own vote-confirmation purpose -- see
    // fourSilUnifiedAuditLog.js's header for the full distinction.
    this.fourSilUnifiedAuditLog = {
      schemaVersion: 1,
      lastProcessedDrawId: null,
      entries: [],
      updatedAt: null
    };
    // 4-Ball Season Intelligence Lab (4SIL) persistent institutional memory.
    // Live 4SIL analysis is recomputed from the rolling draw window, but this
    // archive survives restarts and compounds intelligence across sessions.
    this.fourBallSILMemory = {
      schemaVersion: 1,
      lastProcessedDrawId: null,
      observations: [],
      transitionArchive: [],
      knowledgeSnapshots: [],
      seasonRecords: [],
      currentState: null,
      updatedAt: null
    };
    // 4SIL Paper Trader Engine -- see src/engines/paperTraderEngine.js.
    // Paper-trades 4SIL's ENTER signal against a fixed RED+BLUE+GREEN
    // ladder strategy every council cycle (never real-money). Persisted
    // ledger of trades/windows/cycles/resets + running capital.
    this.paperTrader = require('../engines/paperTraderEngine').freshPaperTraderState();
    // 3-Ball Season Intelligence Lab (3SIL) persistent institutional memory
    // -- see src/engines/threeBallSeasonIntelligenceLab.js. Deliberately a
    // SEPARATE object from fourBallSILMemory above (never read or written
    // by 3SIL, and vice versa), so 3SIL's own transition/observation
    // history can never overwrite or alter 4SIL's, per the 3SIL blueprint's
    // explicit separation rule. No seasonRecords/currentState fields here
    // (unlike 4SIL) since the 3-ball stream has no discrete season archive
    // of its own -- see threeBallSeasonIntelligenceLab.js's
    // classifySeasonStage3B for why.
    this.threeBallSILMemory = {
      schemaVersion: 1,
      lastProcessedDrawId: null,
      observations: [],
      transitionArchive: [],
      knowledgeSnapshots: [],
      updatedAt: null
    };
    // Entry Condition Scorecard's persistent observation log (see
    // entryConditionScorecard.js's header). Unlike tieEngine.js's
    // analyzeTies() (a pure recompute from historicalDraws), the
    // scorecard needs to know -- at the moment each NEW draw lands --
    // whether 4SIL's ENTER gate was open, which conditions were true, and
    // which color was being tracked right before that draw happened. Draw
    // records themselves carry no memory of that context, so it has to be
    // logged incrementally, once per new draw, here. (Previously owned by
    // entryTimingIntervalEngine.js -- that engine is now a pure, ungated
    // recompute with no log of its own; this field name is kept
    // unchanged to avoid a persisted-state migration.)
    this.entryTimingLog = {
      schemaVersion: 1,
      lastProcessedDrawId: null,
      pendingGate: null,
      observations: [],
      updatedAt: null
    };
    // Entry Hit Counter's persistent watch state (see
    // entryHitCounter.js's header for the full reasoning -- replaces the
    // old Entry Accuracy Ladder, removed per operator direction).
    this.entryHitCounter = {
      schemaVersion: 1,
      lastProcessedDrawId: null,
      totalEnterCalls: 0,
      firstPick: { hits: 0, misses: 0, pending: null },
      secondPick: { hits: 0, misses: 0, pending: null },
      updatedAt: null
    };
    // 3-Ball Entry Hit Counter's persistent watch state -- 3SIL's own
    // ENTER-call scoring log, mirroring entryHitCounter.js above but for
    // the 3-ball market (single challenger-color watch, 8-draw window
    // instead of 4SIL's 10). See threeBallEntryHitCounter.js's header.
    // RETIRED as 3SIL's badge scoring mechanism (superseded by
    // threeBallNextEventHitCounter below, which scores the continuous
    // Next Event Leaderboard instead of the old binary ENTER gate this
    // counter watched) -- the field/module are left in place, unread by
    // council.js's threeSIL wiring, rather than deleted, per this
    // codebase's convention of not deleting working code paths.
    this.threeBallEntryHitCounter = {
      schemaVersion: 1,
      lastProcessedDrawId: null,
      totalEnterCalls: 0,
      challengerPick: { hits: 0, misses: 0, pending: null },
      updatedAt: null
    };
    // 3-Ball Next Event Hit Counter's persistent watch state -- scores
    // the Next Event Leaderboard's badge.topColor continuously (every
    // cycle has a topColor, no gate), unlike threeBallEntryHitCounter
    // above which only watched when the old binary ENTER gate was open.
    // See threeBallNextEventHitCounter.js's header.
    //
    // schemaVersion bumped 1 -> 2: added rankWatch (FIX 1 in that file's
    // header -- full-rank scoring alongside the original topColor-only
    // pick). persistence.js's restore path treats rankWatch as optional
    // so a schemaVersion:1 snapshot from before this change loads fine
    // and simply starts rankWatch fresh, same backward-compatibility
    // approach this codebase already uses everywhere else a counter's
    // shape has grown.
    this.threeBallNextEventHitCounter = {
      schemaVersion: 2,
      lastProcessedDrawId: null,
      totalCalls: 0,
      topColorPick: { hits: 0, misses: 0, pending: null },
      rankWatch: { pending: null, byRank: {} },
      updatedAt: null
    };
    // Tier Engine Overdue/Precursor Hit Counter's persistent watch state
    // -- the Tier Engine's own OVERDUE/PRECURSOR-call scoring log,
    // mirroring threeBallEntryHitCounter.js above but watching for a
    // landed tie (not a color match) over the same 8-draw window. See
    // tierOverduePrecursorHitCounter.js's header.
    this.tierOverduePrecursorHitCounter = {
      schemaVersion: 1,
      lastProcessedDrawId: null,
      totalCalls: 0,
      tierCall: { hits: 0, misses: 0, pending: null },
      updatedAt: null
    };
    this.ingestStats = {
      totalDrawsIngested: 0,
      acceptedDraws: 0,
      rejectedDraws: 0,
      threeBallStoreCount: 0,
      fourBallStoreCount: 0,
      lastProcessingTimeMs: 0,
      lastDrawId: null,
      lastIngestTime: null,
      errors: []
    };
    this.initializeEngineStats();
  }

  initializeEngineStats() {
    for (const name of Object.keys(INITIAL_ENGINE_WEIGHTS)) {
      if (!this.engineStats[name]) {
        this.engineStats[name] = {
          winRate: 85,
          totalEvaluations: 0,
          wins: 0,
          losses: 0,
          brierScore: 0.15,
          precision: 0.85,
          lastActivation: null
        };
      }
    }

    for (const reg of REGIMES) {
      if (!this.regimeEngineStats[reg]) {
        this.regimeEngineStats[reg] = {};
      }
      for (const name of Object.keys(INITIAL_ENGINE_WEIGHTS)) {
        if (!this.regimeEngineStats[reg][name]) {
          this.regimeEngineStats[reg][name] = {
            totalEvaluations: 0,
            wins: 0,
            losses: 0,
            precision: 0.80
          };
        }
      }
    }
  }

  hasDraw(drawId) {
    return this.historicalDraws.some(d => String(d.drawId) === String(drawId));
  }

  addDraw(draw) {
    const incomingId = Number(draw.drawId);
    if (!Number.isFinite(incomingId) || this.historicalDraws.length === 0) {
      this.historicalDraws.unshift(draw);
    } else {
      let insertAt = this.historicalDraws.length;
      for (let i = 0; i < this.historicalDraws.length; i++) {
        const existingId = Number(this.historicalDraws[i].drawId);
        if (!Number.isFinite(existingId) || incomingId > existingId) {
          insertAt = i;
          break;
        }
      }
      this.historicalDraws.splice(insertAt, 0, draw);
    }
    if (this.historicalDraws.length > 2000) {
      this.historicalDraws.pop();
    }
    this.ingestStats.totalDrawsIngested++;
    // lastDrawId reflects the most recently *ingested* draw for telemetry
    // purposes (what just came in), independent of numeric ordering.
    this.ingestStats.lastDrawId = draw.drawId;
    // lastIngestTime: no field anywhere previously captured WHEN a draw was
    // ingested (only ingest counts and the draw's own drawId), so the
    // dashboard's ingest panel had no way to show "last ingest N ago."
    this.ingestStats.lastIngestTime = new Date().toISOString();
    if (draw.threeBallColor) this.ingestStats.threeBallStoreCount++;
    if (draw.fourBallColor) this.ingestStats.fourBallStoreCount++;
  }

  getRecentDraws(limit = 50) {
    return this.historicalDraws.slice(0, limit);
  }

  updateIngestStats({ accepted, rejected, errors, processingTimeMs }) {
    // BUG: `accepted` was destructured but never written back -- the per-batch
    // accepted counter stayed at 0 forever. totalDrawsIngested is incremented
    // per-draw in addDraw(); acceptedDraws tracks the cumulative ingest total
    // from this call path for display in API responses / the dashboard.
    this.ingestStats.acceptedDraws = (this.ingestStats.acceptedDraws || 0) + accepted;
    this.ingestStats.rejectedDraws += rejected;
    this.ingestStats.lastProcessingTimeMs = processingTimeMs;
    this.ingestStats.errors = errors.slice(0, 10);
  }

  updateEnginePerformanceDirect(name, wasCorrect, predictedConfidence = 80, marketRegime = 'ORDERED') {
    if (!this.engineWeights[name]) this.engineWeights[name] = 1.0;
    if (!this.engineStats[name]) {
      this.engineStats[name] = { winRate: 80, totalEvaluations: 0, wins: 0, losses: 0, brierScore: 0.2, precision: 0.8, lastActivation: null };
    }

    const stat = this.engineStats[name];
    stat.totalEvaluations++;
    if (wasCorrect) stat.wins++;
    else stat.losses++;

    const outcome = wasCorrect ? 1.0 : 0.0;
    const prob = Math.min(1.0, Math.max(0.0, predictedConfidence / 100));
    const brierLoss = Math.pow(prob - outcome, 2);
    stat.brierScore = Math.round((stat.brierScore * 0.85 + brierLoss * 0.15) * 1000) / 1000;
    stat.precision = Math.round((stat.wins / stat.totalEvaluations) * 100) / 100;
    stat.winRate = Math.round(stat.precision * 100);
    stat.lastActivation = new Date().toISOString();

    // Per-Regime tracking
    const activeRegime = REGIMES.includes(marketRegime) ? marketRegime : 'ORDERED';
    if (!this.regimeEngineStats[activeRegime]) this.regimeEngineStats[activeRegime] = {};
    if (!this.regimeEngineStats[activeRegime][name]) {
      this.regimeEngineStats[activeRegime][name] = { totalEvaluations: 0, wins: 0, losses: 0, precision: 0.80 };
    }
    const regStat = this.regimeEngineStats[activeRegime][name];
    regStat.totalEvaluations++;
    if (wasCorrect) regStat.wins++;
    else regStat.losses++;
    regStat.precision = Math.round((regStat.wins / regStat.totalEvaluations) * 100) / 100;

    // EMA Smoothed Learning Rate (alpha = 0.02)
    if (stat.totalEvaluations >= 5) {
      const alpha = 0.02;
      const weightAdjustment = (stat.precision - 0.5) * alpha;
      this.engineWeights[name] = Math.max(0.3, Math.min(2.5, Math.round((this.engineWeights[name] + weightAdjustment) * 1000) / 1000));
    }
  }

  // Tier Engine forecast logging (Recommendation #1). Called once per
  // runSupremeCouncil() cycle with the freshly-computed tieP, AFTER the
  // draw the forecast is based on is already in historicalDraws. Records
  // what the engine currently believes about the NEXT (not-yet-seen) draw.
  recordTierForecast(tieP, madeAfterDrawId) {
    const entry = defaultTierForecastLogEntry();
    entry.madeAfterDrawId = madeAfterDrawId;
    entry.timestamp = new Date().toISOString();
    entry.marketStateLabel = tieP.marketStateLabel;
    entry.operatorAction = tieP.operatorAction;
    entry.riskLevel = tieP.tiePrediction.riskLevel;
    entry.tieProbabilityPct = tieP.tiePrediction.tieProbabilityPct;
    entry.drawsUntilNextTie = tieP.drawsUntilNextTie;
    entry.activeSeasonAtForecast = Boolean(tieP.activeSeason);
    // Blueprint upgrade (spec section 9 Performance Loop)
    entry.tiePressureScore = tieP.tiePressureScore;
    entry.expectedWindowLabel = tieP.expectedWindow ? tieP.expectedWindow.label : null;
    entry.confidenceLabel = tieP.confidenceLabel;
    this.tierForecastLog.unshift(entry);
    if (this.tierForecastLog.length > 100) {
      this.tierForecastLog.pop();
    }
  }

  // Tier Engine forecast scoring (Recommendation #1). Called once per
  // ingested draw, BEFORE runSupremeCouncil() recomputes the next
  // forecast (see routes/api.js's call order). Finds the most recent
  // unscored forecast entry -- which, by construction, was made after the
  // PREVIOUS draw and is therefore a forecast FOR this incoming draw --
  // and grades it against what actually happened.
  //
  // If tierForecastLog is empty (first-ever draw) or every entry is
  // already scored (shouldn't normally happen given one entry per cycle,
  // but guards against double-scoring if this is ever called twice for
  // the same draw), this is a no-op.
  scoreTierForecast(latestDraw) {
    const entry = this.tierForecastLog.find(e => !e.scored);
    if (!entry) return;

    const { isThreeBallTie } = require('../engines/tieEngine');
    const actualWasTie = isThreeBallTie(latestDraw);

    entry.forDrawId = latestDraw.drawId;
    entry.scored = true;
    entry.actualWasTie = actualWasTie;
    // "Hit" is scoped to the engine's actionable calls (TIE_ACTIVE / READY
    // and TIE_APPROACHING / WATCH, the blueprint-upgrade successors to the
    // old TIE_IMMINENT/CLUSTER_ACTIVE + EXPLOIT/AVOID vocabulary) --
    // MONITOR and NO_ACTION aren't claims that a tie is about to happen on
    // THIS specific draw, so scoring them as right/wrong the same way
    // would conflate "didn't call it" with "called it and was wrong."
    if (entry.operatorAction === 'READY' || entry.operatorAction === 'WATCH') {
      entry.hit = actualWasTie === true;
    } else {
      entry.hit = null;
    }
  }

  // Recommendation #2: aggregate the SCORED portion of tierForecastLog
  // into per-riskLevel empirical tie rates, for tieEngine.js's
  // calibrateTieProbability() to blend against the raw formula-based
  // estimate. Built fresh each cycle from whatever's currently in the log
  // -- cheap (log is capped at 100 entries) and always exactly consistent
  // with the log's current contents, same "recompute rather than
  // incrementally maintain" convention used throughout this store (see
  // tieIntelligence's own header comments).
  buildTierCalibrationData() {
    const scored = this.tierForecastLog.filter(e => e.scored);
    const byRiskLevel = {};
    for (const level of ['LOW', 'MODERATE', 'HIGH', 'VERY HIGH']) {
      const atLevel = scored.filter(e => e.riskLevel === level);
      if (atLevel.length === 0) {
        byRiskLevel[level] = { sampleSize: 0, tieRatePct: 0 };
        continue;
      }
      const ties = atLevel.filter(e => e.actualWasTie).length;
      byRiskLevel[level] = {
        sampleSize: atLevel.length,
        tieRatePct: Math.round((ties / atLevel.length) * 1000) / 10
      };
    }
    return { byRiskLevel };
  }

  // Tie Precursor Pattern Engine forecast logging -- direct structural
  // mirror of recordTierForecast() above. Called once per
  // runSupremeCouncil() cycle with the freshly-computed precursor result
  // AFTER the draw it's based on is already in historicalDraws. Records
  // what the engine currently believes about the NEXT (not-yet-seen)
  // draw's tie risk.
  recordTiePrecursorForecast(precursor, madeAfterDrawId) {
    if (!precursor || !precursor.sufficientHistory) return; // nothing meaningful to log yet
    const entry = defaultTiePrecursorForecastLogEntry();
    entry.madeAfterDrawId = madeAfterDrawId;
    entry.timestamp = new Date().toISOString();
    const pred = precursor.prediction || {};
    entry.riskLevel = pred.riskLevel;
    entry.rawCombinedScore = pred.combinedScore;
    entry.calibratedCombinedScore = pred.calibratedCombinedScore != null ? pred.calibratedCombinedScore : pred.combinedScore;
    entry.elevatedRisk = Boolean(pred.elevatedRisk);
    entry.activePrecursors = pred.activePrecursors || [];
    this.tiePrecursorForecastLog.unshift(entry);
    if (this.tiePrecursorForecastLog.length > 100) {
      this.tiePrecursorForecastLog.pop();
    }
  }

  // Tie Precursor Pattern Engine forecast scoring -- direct structural
  // mirror of scoreTierForecast() above. Called once per ingested draw
  // (from evaluateAndLearn(), same call site as scoreTierForecast()),
  // BEFORE runSupremeCouncil() recomputes the next forecast. Finds the
  // oldest unscored entry -- made after the PREVIOUS draw, therefore a
  // forecast FOR this incoming draw -- and grades it against what
  // actually happened.
  scoreTiePrecursorForecast(latestDraw) {
    const entry = this.tiePrecursorForecastLog.find(e => !e.scored);
    if (!entry) return;

    const { isThreeBallTie } = require('../engines/tieEngine');
    const actualWasTie = isThreeBallTie(latestDraw);

    entry.forDrawId = latestDraw.drawId;
    entry.scored = true;
    entry.actualWasTie = actualWasTie;
    // "Hit" is scoped to this engine's actionable calls (elevatedRisk
    // true) -- same reasoning as scoreTierForecast()'s MONITOR/NO_ACTION
    // exclusion: a cycle where neither precursor was live isn't a claim
    // that a tie was imminent, so scoring it right/wrong the same way
    // would conflate "didn't call it" with "called it and was wrong."
    entry.hit = entry.elevatedRisk ? (actualWasTie === true) : null;
  }

  // Aggregates the SCORED portion of tiePrecursorForecastLog into
  // per-riskLevel empirical tie rates, for
  // tiePrecursorPatternEngine.js's calibratePrecursorScore() to blend
  // against the raw historically-derived combinedScore -- direct
  // structural mirror of buildTierCalibrationData() above, same 4
  // riskLevel buckets (this engine's riskLevelFromScore() already uses
  // the identical LOW/MODERATE/HIGH/VERY HIGH vocabulary as the Tier
  // Engine, so no bucket-name translation is needed).
  buildTiePrecursorCalibrationData() {
    const scored = this.tiePrecursorForecastLog.filter(e => e.scored);
    const byRiskLevel = {};
    for (const level of ['LOW', 'MODERATE', 'HIGH', 'VERY HIGH']) {
      const atLevel = scored.filter(e => e.riskLevel === level);
      if (atLevel.length === 0) {
        byRiskLevel[level] = { sampleSize: 0, tieRatePct: 0 };
        continue;
      }
      const ties = atLevel.filter(e => e.actualWasTie).length;
      byRiskLevel[level] = {
        sampleSize: atLevel.length,
        tieRatePct: Math.round((ties / atLevel.length) * 1000) / 10
      };
    }

    const elevatedCalls = scored.filter(e => e.elevatedRisk);
    const elevatedHits = elevatedCalls.filter(e => e.hit === true).length;

    return {
      byRiskLevel,
      totalScored: scored.length,
      elevatedRiskCalls: elevatedCalls.length,
      elevatedRiskHitRatePct: elevatedCalls.length > 0 ? Math.round((elevatedHits / elevatedCalls.length) * 1000) / 10 : null
    };
  }

  resetStore() {
    this.historicalDraws = [];
    this.engineWeights = { ...INITIAL_ENGINE_WEIGHTS };
    this.recommendationLog = [];
    this.tierForecastLog = [];
    this.tiePrecursorForecastLog = [];
    this.cachedSystemState = null;
    // BUGFIX: initializeEngineStats() (called at the end of this method)
    // only fills in stats for engine names NOT already present in
    // engineStats/regimeEngineStats -- it never overwrote existing
    // entries. Since those two objects were never cleared here, a "reset"
    // silently kept every engine's win/loss/precision/brierScore/
    // lastActivation from the previous session, so the Performance Panel
    // and engine-ranking data would keep showing accuracy figures computed
    // from draws that reset() had just wiped from historicalDraws.
    this.engineStats = {};
    this.regimeEngineStats = {};
    // constructor's default, recomputed fresh on the next council cycle
    // from the now-empty historicalDraws.
    this.tieIntelligence = {
      sufficientSample: false,
      sampleSize: 0,
      totalTies: 0,
      tieRatePct: 0,
      recentWindowDraws: 0,
      recentTies: 0,
      recentRatePct: 0,
      lastTie: null,
      intervalStats: { count: 0, avgIntervalDraws: null, medianIntervalDraws: null, longestGapDraws: null, shortestGapDraws: null, mostCommonInterval: null },
      currentTieStreak: 0,
      detectedCycle: null,
      seasons: [],
      activeSeason: null,
      // Tie Pressure Score defaults (blueprint upgrade, spec section 3)
      tiePressure: {
        score: 0,
        agreementCount: 0,
        signals: {
          frequency: { score: 0 },
          interval: { score: 0 },
          pattern: { score: 0 },
          transition: { score: 0 }
        }
      },
      expectedWindow: { label: 'NEXT 1-5 DRAWS', fromDraws: 1, toDraws: 5, tightened: false },
      confidenceLabel: 'LOW',
      tiePrediction: {
        tieProbabilityPct: 0,
        confidenceScore: 0,
        riskLevel: 'LOW',
        confidenceLabel: 'LOW',
        // Market-state defaults (blueprint upgrade)
        marketStateLabel: 'NO_EDGE',
        operatorAction: 'NO_ACTION',
        tieApproaching: false,
        drawsUntilNextTie: null,
        expectedWindow: { label: 'NEXT 1-5 DRAWS', fromDraws: 1, toDraws: 5, tightened: false },
        tiePressureScore: 0,
        alert: null
      },
      tieWarning: { level: 'LOW', score: 0, reasoning: 'No draws ingested yet.' },
      // Top-level aliases matching tieEngine.js's return shape
      marketStateLabel: 'NO_EDGE',
      operatorAction: 'NO_ACTION',
      tieApproaching: false,
      drawsUntilNextTie: null,
      tiePressureScore: 0,
      confidenceLabel: 'LOW'
    };
    // Event Intelligence reset -- clears Event Memory, pending First
    // Appearance, and the color return-gap model along with everything
    // else on a full reset, same full-shape-reset pattern as above.
    this.eventIntelligence = {
      colorReturnModel: {},
      eventMemory: [],
      pendingFirstAppearance: null,
      lastCertifiedLastStand: null,
      lastRecordedSeasonEnd: null
    };
    // BUGFIX: fourBallSILMemory was never cleared here -- unlike every
    // other piece of state above, a reset left 4SIL's persistent
    // institutional memory (observations/transitionArchive/
    // knowledgeSnapshots/seasonRecords/currentState) fully intact even
    // though historicalDraws was wiped. Since this object is persisted to
    // disk and fed back into every runSupremeCouncil() cycle as
    // persistentState, the stale memory would survive the reset and keep
    // influencing 4SIL's output as if the reset had never happened for it.
    //
    // Same reasoning applies to the Tie Cluster Engine's own memory --
    // stale tie log entries pointing at drawIds that no longer exist
    // after a reset must not survive it either.
    this.fourBallTieClusterMemory = {
      schemaVersion: 1,
      lastProcessedDrawId: null,
      strongTieLog: [],
      activeCluster: null,
      updatedAt: null
    };
    // Same reasoning applies to the unified audit log (§21) -- entries
    // reference drawIds from the pre-reset history and must not survive
    // a reset either.
    this.fourSilUnifiedAuditLog = {
      schemaVersion: 1,
      lastProcessedDrawId: null,
      entries: [],
      updatedAt: null
    };
    this.fourBallSILMemory = {
      schemaVersion: 1,
      lastProcessedDrawId: null,
      observations: [],
      transitionArchive: [],
      knowledgeSnapshots: [],
      seasonRecords: [],
      currentState: null,
      updatedAt: null
    };
    // Paper Trader ledger is reset too (trades/windows/cycles/resets all
    // reference drawIds from the pre-reset history), but its config
    // (ladder table, payout multiplier, starting capital, window size --
    // anything the operator may have customized) survives the reset.
    this.paperTrader = require('../engines/paperTraderEngine').freshPaperTraderState(
      this.paperTrader && this.paperTrader.config
    );
    // 3SIL's own separate persistent memory -- a reset must wipe this too,
    // or 3SIL would keep grading/archiving against a historicalDraws that
    // no longer exists from the reset's point of view.
    this.threeBallSILMemory = {
      schemaVersion: 1,
      lastProcessedDrawId: null,
      observations: [],
      transitionArchive: [],
      knowledgeSnapshots: [],
      updatedAt: null
    };
    // Same reasoning as the fourBallSILMemory BUGFIX comment just above --
    // entryTimingLog (now owned by entryConditionScorecard.js) is
    // persistent, cross-cycle observation state that must be wiped on
    // reset or it would keep grading against draws that (from the reset
    // historicalDraws' point of view) never happened.
    this.entryTimingLog = {
      schemaVersion: 1,
      lastProcessedDrawId: null,
      pendingGate: null,
      observations: [],
      updatedAt: null
    };
    // Same reasoning again -- the counter's pending watches are
    // cross-cycle state tied to specific draw IDs that a reset wipes out
    // from under it; leaving them behind would let them resolve (or time
    // out) against a draw history that, post-reset, never produced them.
    this.entryHitCounter = {
      schemaVersion: 1,
      lastProcessedDrawId: null,
      totalEnterCalls: 0,
      firstPick: { hits: 0, misses: 0, pending: null },
      secondPick: { hits: 0, misses: 0, pending: null },
      updatedAt: null
    };
    // Same reasoning, 3-ball counterpart. RETIRED as 3SIL's badge
    // scoring mechanism -- see the constructor's comment above this same
    // field.
    this.threeBallEntryHitCounter = {
      schemaVersion: 1,
      lastProcessedDrawId: null,
      totalEnterCalls: 0,
      challengerPick: { hits: 0, misses: 0, pending: null },
      updatedAt: null
    };
    // Same reasoning again -- the Next Event Hit Counter's pending watch
    // is cross-cycle state tied to specific draw IDs that a reset wipes
    // out from under it. Same schemaVersion:2 shape as the constructor
    // above (rankWatch included).
    this.threeBallNextEventHitCounter = {
      schemaVersion: 2,
      lastProcessedDrawId: null,
      totalCalls: 0,
      topColorPick: { hits: 0, misses: 0, pending: null },
      rankWatch: { pending: null, byRank: {} },
      updatedAt: null
    };
    // Same reasoning, Tier Engine counterpart.
    this.tierOverduePrecursorHitCounter = {
      schemaVersion: 1,
      lastProcessedDrawId: null,
      totalCalls: 0,
      tierCall: { hits: 0, misses: 0, pending: null },
      updatedAt: null
    };
    this.ingestStats = {
      totalDrawsIngested: 0,
      acceptedDraws: 0,
      rejectedDraws: 0,
      threeBallStoreCount: 0,
      fourBallStoreCount: 0,
      lastProcessingTimeMs: 0,
      lastDrawId: null,
      lastIngestTime: null,
      errors: []
    };
    this.initializeEngineStats();
  }
}

const store = new MemoryStore();

module.exports = {
  store,
  INITIAL_ENGINE_WEIGHTS,
  REGIMES
};
