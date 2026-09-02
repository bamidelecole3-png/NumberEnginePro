/**
 * NEW READ ENDPOINTS (blueprint §38-39).
 *
 * Every route here is read-only and additive. /api/v1/collector itself
 * is defined in src-legacy-core/src/routes/api.js and is NEVER touched
 * or re-implemented here (non-negotiable #15).
 */
'use strict';

const express = require('express');
const router = express.Router();

const { store } = require('../../src-legacy-core/src/core/store');
const { runSupremeCouncil } = require('../../src-legacy-core/src/supreme/council');
const { bus, EVENTS } = require('../../src-legacy-core/src/core/bus');
const { buildHeroData, buildSeasonTelemetry, buildSeasonRunway, buildGateMatrix, buildLegacyBadge } = require('../foursil/timingEngine');
const { buildColorBehaviorIntelligence } = require('../foursil/cbiEngine');
const { freshState, advanceCallHistory, buildCallHistoryView, buildEvaluationLab } = require('../foursil/callHistory');
const { loadCallHistory, saveCallHistory } = require('../foursil/persistence');
const { freshNEIState, ensureNEIStateShape, advanceNEI, getRawPredictionsLedger } = require('../foursil/nextEventIntelEngine');
const { freshGCIState, advanceGCI } = require('../foursil/gateClosureIntelligenceEngine');
const { loadGCIState, saveGCIState } = require('../foursil/gciPersistence');

let callState = loadCallHistory(freshState);
let neiState  = freshNEIState();   // in-memory only (rebuilt from callState + paperTrader each cycle)
let gciState  = loadGCIState(freshGCIState); // persisted — GCI's own derived intelligence, NOT rebuilt from scratch
let lastSavedAt = 0;
let lastGCISavedAt = 0;

function persistIfDue() {
  const now = Date.now();
  if (now - lastSavedAt > 15000) {
    saveCallHistory(callState);
    lastSavedAt = now;
  }
  // 4SIL-GCI persists on its own cadence: its derived state (closure
  // episodes, fingerprints, trigram bank) must survive process restarts
  // even though NEI's own ledger is in-memory-only, otherwise "learning
  // over months of operation" (blueprint §17-18) resets every deploy.
  if (now - lastGCISavedAt > 15000) {
    saveGCIState(gciState);
    lastGCISavedAt = now;
  }
}

// Advances 4SIL-GCI. STRICT INPUT CONTRACT: only the raw NEI predictions
// ledger is passed in — never draws, gates, paper trader, or any other
// engine (see gateClosureIntelligenceEngine.js header). NEI must have
// already been advanced this cycle before this runs.
function advanceGCICycle() {
  try {
    const ledger = getRawPredictionsLedger(neiState);
    return advanceGCI(ledger, gciState);
  } catch (e) {
    console.error('[4sil-gci] failed to advance:', e.message);
    return null;
  }
}

function getFourSIL() {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  return snapshot.fourBallSeasonIntelligenceLab;
}

// BUGFIX: see the matching comment in src/routes/paperTraderApi.js --
// store.cachedSystemState is always one draw stale at the moment
// ON_DRAW_INGESTED fires (the collector's POST handler publishes the
// event, via adapter.js, BEFORE it calls runSupremeCouncil() for this
// draw). Call history opening/resolving on the exact ENTER draw depends
// on fresh data here, not the previous draw's snapshot.
function getFreshFourSIL() {
  const snapshot = runSupremeCouncil();
  return snapshot.fourBallSeasonIntelligenceLab;
}

// The 4-Ball Parliament's own dual color pick (winningColor/secondColor +
// confidences), i.e. officialPredictions.next4Ball on the full snapshot.
// See buildLegacyBadge()'s header in timingEngine.js for why this is
// paired with fourSIL.badge and exposed as read-only supporting evidence.
function getDualPick() {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  return snapshot.officialPredictions ? snapshot.officialPredictions.next4Ball : null;
}

/**
 * Builds every piece the dashboard needs for this cycle, in the order
 * the blueprint's intelligence-refresh pipeline expects (§32): read
 * 4SIL's already-computed state, derive timing/gates, advance call
 * history against real draws, then assemble.
 */
function buildFullCycle() {
  const fourSIL = getFourSIL();
  const historicalDraws = store.historicalDraws;

  // First pass: derive hero data assuming no open call, purely to get a
  // fresh tp/window if one needs opening this cycle.
  const provisionalHero = buildHeroData(fourSIL, null);
  const gateMatrix = buildGateMatrix(fourSIL);
  const { openCall } = advanceCallHistory(callState, fourSIL, provisionalHero, gateMatrix, historicalDraws);
  persistIfDue();

  // Second pass: final hero data, now aware of whatever call is open
  // (freshly opened this cycle, or already in flight).
  const hero = buildHeroData(fourSIL, openCall);
  hero.legacyBadge = buildLegacyBadge(fourSIL, getDualPick());
  const seasonTelemetry = buildSeasonTelemetry(fourSIL);
  const seasonRunway = buildSeasonRunway(fourSIL);
  const colorIntel = buildColorBehaviorIntelligence(historicalDraws);
  const evaluation = buildEvaluationLab(callState);
  const callHistoryView = buildCallHistoryView(callState, 100);

  // 4SIL NEXT EVENT INTELLIGENCE ENGINE — downstream consumer, runs LAST
  // in the pipeline after 4SIL, call history, and paper trader have all
  // completed for this cycle. Read-only: never modifies fourSIL or any
  // gate/weight/parliament. State is in-memory (neiState) and rebuilt from
  // the two intel streams on every cycle.
  const nei = advanceNEI(
    fourSIL,
    callState,
    getPaperTraderSnapshotSafe(true),   // raw paperTrader state (trades array)
    historicalDraws,
    neiState
  );

  // 4SIL GATE CLOSURE INTELLIGENCE ENGINE — runs immediately after NEI,
  // consuming ONLY NEI's raw predictions ledger (see advanceGCICycle()
  // above). Pure observer/protection layer; output is dashboard-only and
  // is never read back by 4SIL, NEI, call history, or the paper trader.
  const gci = advanceGCICycle();
  persistIfDue();

  const pipeline = {
    status: store.ingestStats.lastIngestTime
      ? (Date.now() - new Date(store.ingestStats.lastIngestTime).getTime() < 5 * 60 * 1000 ? 'LIVE' : 'STALE')
      : 'OFFLINE',
    drawCount: historicalDraws.length,
    lastDrawId: store.ingestStats.lastDrawId,
    lastReceived: store.ingestStats.lastIngestTime,
    lastProcessed: store.ingestStats.lastIngestTime,
    lagMs: store.ingestStats.lastProcessingTimeMs
  };

  const apiHealth = { status: 'HEALTHY' };
  const pulse = { active: pipeline.status === 'LIVE' };

  return {
    pipeline,
    apiHealth,
    pulse,
    draw: historicalDraws[0] || null,
    season: { active: !!(fourSIL && fourSIL.active), stage: fourSIL && fourSIL.seasonStage ? fourSIL.seasonStage.stage : 'INACTIVE', telemetry: seasonTelemetry, runway: seasonRunway },
    timing: hero,
    foursil: { active: !!(fourSIL && fourSIL.active), badge: fourSIL ? fourSIL.badge : null },
    colorIntel,
    gateSummary: gateMatrix,
    evaluation,
    call: callHistoryView[0] || null,
    paperTrader: getPaperTraderSnapshotSafe(),
    nei,
    gci
  };
}

// Read-only, best-effort include of the paper trader's own snapshot
// (blueprint §39). Lazily required to avoid a hard circular dependency
// at module-load time between the two route files; if the paper trader
// module fails to load for any reason, the main snapshot must still
// succeed (blueprint §40 -- paper trader is a pure consumer and must
// never be able to break 4SIL/timing output).
// rawState=true returns the persistent store.paperTrader object (needed
// by NEI's paperTraderAnalyzer to walk the trades array directly).
function getPaperTraderSnapshotSafe(rawState) {
  try {
    if (rawState) {
      const { store } = require('../../src-legacy-core/src/core/store');
      return store.paperTrader || null;
    }
    return require('./paperTraderApi').getPaperTraderSnapshot();
  } catch (e) {
    return null;
  }
}

// BUGFIX: advanceCallHistory() (which opens a new call the moment 4SIL
// confirms ENTER, and resolves any open call against newly-landed draws)
// previously only ran inside buildFullCycle(), which itself only ran when
// something issued GET /snapshot or GET /v1/snapshot. That means the
// "immutable call history" (non-negotiable #20) silently depended on the
// dashboard happening to be open and polling at the right moment: a real
// ENTER signal that fired between two dashboard polls -- or with no
// dashboard open at all -- would never get logged, and any call that did
// open would record whatever tp/window happened to be current at poll
// time rather than at the moment 4SIL actually confirmed. This violates
// the blueprint's own intelligence-refresh pipeline (§32: call history
// advances as part of every new-draw refresh, not as a side effect of a
// GET request).
//
// Fix: subscribe directly to the collector's own ON_DRAW_INGESTED event
// (published by src-legacy-core/src/collector/adapter.js on every
// accepted draw, after council.js has already re-run for that draw) and
// advance call history right there, independent of whether anyone is
// polling the dashboard. buildFullCycle() below still calls
// advanceCallHistory() too (advanceCallHistory is idempotent per-draw via
// its own drawsSinceOpen bookkeeping and the "no call already open" gate,
// so a GET immediately after an ingest just observes the same state
// rather than double-opening or double-resolving anything).
bus.subscribe(EVENTS.ON_DRAW_INGESTED, () => {
  try {
    const fourSIL = getFreshFourSIL(); // BUGFIX: never trust the stale cache here -- see comment above.
    const historicalDraws = store.historicalDraws;
    const provisionalHero = buildHeroData(fourSIL, null);
    const gateMatrix = buildGateMatrix(fourSIL);
    advanceCallHistory(callState, fourSIL, provisionalHero, gateMatrix, historicalDraws);
    // NEI runs immediately after call history advances, so it always sees
    // the freshest call state for this draw (same separation-rule guarantee
    // as paper trader: downstream-only, never feeds back into 4SIL).
    advanceNEI(fourSIL, callState, getPaperTraderSnapshotSafe(true), historicalDraws, neiState);
    // 4SIL-GCI advances on every ingest too, immediately after NEI, so its
    // closure-episode ledger and trigram bank never fall behind real-time
    // regardless of whether the dashboard happens to be polling.
    advanceGCICycle();
    persistIfDue();
  } catch (e) {
    console.error('[foursil-timing] failed to advance call history on ingest:', e.message);
  }
});

router.get('/health', (req, res) => {
  res.json({ status: 'HEALTHY', engine: '4-BALL TIMING INTELLIGENCE + 4SIL', version: '1.0.0' });
});

router.get(['/v1/snapshot', '/snapshot'], (req, res) => {
  res.json(buildFullCycle());
});

router.get('/v1/foursil', (req, res) => {
  res.json(getFourSIL());
});

router.get('/v1/timing', (req, res) => {
  const fourSIL = getFourSIL();
  const openCall = callState.calls.find(c => c.status === 'PENDING');
  const hero = buildHeroData(fourSIL, openCall ? { ...openCall, eventConfirmedThisCycle: false } : null);
  hero.legacyBadge = buildLegacyBadge(fourSIL, getDualPick());
  res.json(hero);
});

router.get('/v1/season', (req, res) => {
  const fourSIL = getFourSIL();
  res.json({
    active: !!(fourSIL && fourSIL.active),
    stage: fourSIL && fourSIL.seasonStage ? fourSIL.seasonStage.stage : 'INACTIVE',
    telemetry: buildSeasonTelemetry(fourSIL),
    runway: buildSeasonRunway(fourSIL)
  });
});

router.get('/v1/colors', (req, res) => {
  res.json(buildColorBehaviorIntelligence(store.historicalDraws));
});

router.get('/v1/color-relationships', (req, res) => {
  res.json(buildColorBehaviorIntelligence(store.historicalDraws).relationship);
});

router.get('/v1/calls', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  res.json({ calls: buildCallHistoryView(callState, limit), totalLogged: callState.calls.length });
});

router.get('/v1/evaluation', (req, res) => {
  res.json(buildEvaluationLab(callState));
});

router.get('/v1/performance', (req, res) => {
  const evaluation = buildEvaluationLab(callState);
  res.json(evaluation.totals);
});

// 4SIL Next Event Intelligence Engine — dedicated read endpoint.
// Returns the current NEI summary: engineState, forecast, intel streams,
// prediction history, and evaluation. This is purely additive and
// read-only; the response is never fed back into 4SIL or any gate.
router.get(['/v1/nei', '/v1/next-event'], (req, res) => {
  const fourSIL = getFourSIL();
  const summary = advanceNEI(
    fourSIL,
    callState,
    getPaperTraderSnapshotSafe(true),
    store.historicalDraws,
    neiState
  );
  res.json(summary);
});

// 4SIL Gate Closure Intelligence Engine — dedicated read endpoint.
// Returns the current GCI summary: engineState, closureRisk (with
// component breakdown and explainable reasons), closure interval model,
// closure window estimate, statistics, false-positive profile, range
// sequence intelligence, and recent closure episodes. Read-only; this
// response is never fed back into 4SIL, NEI, or any gate.
router.get(['/v1/gci', '/v1/gate-closure', '/v1/closure-protection'], (req, res) => {
  const summary = advanceGCICycle();
  if (!summary) return res.status(503).json({ error: 'GCI_UNAVAILABLE' });
  res.json(summary);
});

module.exports = router;
