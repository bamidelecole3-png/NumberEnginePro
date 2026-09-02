/**
 * Express API Router.
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { processIngestPayload } = require('../collector/adapter');
const { runSupremeCouncil } = require('../supreme/council');
const { evaluateAndLearn } = require('../services/learning');
const { store } = require('../core/store');
const { saveSnapshot } = require('../services/persistence');
const { computeColorParliamentLastStandAndAlam } = require('../engines/colorParliamentLastStand');
const { runEventIntelligence } = require('../engines/eventIntelligenceEngineCP');
const { sweepSeasonParameters } = require('../engines/tieEngine');

// BUGFIX: was a plain `===` string comparison, which leaks timing
// information about how many leading characters of the key were guessed
// correctly (JS string equality short-circuits at the first mismatched
// character). Buffer lengths are compared first -- timingSafeEqual throws
// on mismatched lengths rather than returning false -- before the
// constant-time comparison itself.
function checkAuth(req, res, next) {
  const requiredKey = process.env.GATEWAY_API_KEY;
  if (!requiredKey) return next();
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing X-API-Key header' });
  }
  try {
    const a = Buffer.from(apiKey);
    const b = Buffer.from(requiredKey);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return next();
    }
  } catch (e) {
    // fall through to the 401 below
  }
  return res.status(401).json({ error: 'Unauthorized: Invalid or missing X-API-Key header' });
}

// Ingestion Routes
router.post(['/v1/collector', '/collector', '/receive-draws', '/draws'], checkAuth, (req, res) => {
  const result = processIngestPayload(req.body);
  if (result.accepted > 0) {
    const latestDraw = store.historicalDraws[0];
    evaluateAndLearn(latestDraw);
    runSupremeCouncil();
    saveSnapshot(store);
  }
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json({
    status: 'ok',
    ingest: result,
    snapshot
  });
});

// Snapshot & Intelligence Feeds
// NOTE (4-Ball Timing Intelligence rebuild, non-negotiable #15/#39): the
// blueprint's canonical GET /api/v1/snapshot must be the NEW consolidated
// Hero object (src/routes/timingApi.js), not this legacy parliamentary
// snapshot. This route is therefore exposed under /legacy-snapshot instead
// -- the collector ingestion route above (POST /v1/collector) and its auth
// are completely untouched; only this GET debug/legacy path was renamed to
// avoid colliding with the new endpoint.
router.get(['/legacy-snapshot', '/v1/legacy-snapshot'], (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json(snapshot);
});

router.get('/meta-intelligence', (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json({
    metaIntelligence: snapshot.metaIntelligence,
    regimeEngineStats: store.regimeEngineStats
  });
});


// Color Parliament port: 3-Ball Last Stand, 4-Ball Last Stand, and the
// Alam (Alert / Last-stand Alert Monitor) system that watches both. See
// src/engines/colorParliamentLastStand.js and
// src/engines/colorParliamentSeasonAdapter.js for the full port notes.
router.get('/color-parliament/last-stand', (req, res) => {
  res.json(computeColorParliamentLastStandAndAlam());
});

// Color Parliament port: 4Ball Event Intelligence Engine v2.0 (First
// Appearance Detector / Transition Corridor / Last Stand Detector +
// Event Memory Database). Dormant (seasonGate.active: false) whenever no
// 4-ball season is currently active. See
// src/engines/eventIntelligenceEngineCP.js for the full port notes.
router.get('/color-parliament/event-intelligence', (req, res) => {
  res.json(runEventIntelligence());
});

router.get('/prediction', (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json(snapshot.officialPredictions || {});
});

router.get('/recommendation', (req, res) => {
  const snapshot = store.cachedSystemState || runSupremeCouncil();
  res.json(snapshot.supremeDecision || {});
});

// Draw History & Performance — recommendationLog + raw draw records, joined
// by drawId, plus lightweight aggregate accuracy windows. Backs the Draw
// History table and Performance Terminal panel on the dashboard.
router.get('/history', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const drawsById = new Map(store.historicalDraws.map(d => [String(d.drawId), d]));

  const rows = store.recommendationLog.slice(0, limit).map(entry => {
    const draw = drawsById.get(String(entry.drawId));
    return {
      drawId: entry.drawId,
      timestamp: entry.timestamp,
      colors: draw ? draw.colors : [],
      threeBallColor: draw ? draw.threeBallColor : null,
      fourBallColor: draw ? draw.fourBallColor : null,
      recommendedColor: entry.recommendedColor,
      action: entry.action,
      actualWinner: entry.actualWinner,
      wasCorrect: entry.wasCorrect,
      marketRegime: entry.marketRegime
    };
  });

  function accuracyOver(n) {
    const slice = store.recommendationLog.slice(0, n);
    if (slice.length === 0) return null;
    const hits = slice.filter(r => r.wasCorrect).length;
    return { sampleSize: slice.length, accuracyPct: Math.round((hits / slice.length) * 100) };
  }

  res.json({
    rows,
    totalLogged: store.recommendationLog.length,
    windows: {
      last10: accuracyOver(10),
      last30: accuracyOver(30),
      last100: accuracyOver(100)
    }
  });
});

// Tier Engine forecast-accuracy feed (Recommendation #1). Mirrors
// /history's shape/windowing conventions but scores the Tier Engine's own
// market-state forecasts against real outcomes, independent of the
// color-prediction engines /history covers.
router.get('/tier-engine-accuracy', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const log = store.tierForecastLog;
  const scored = log.filter(e => e.scored);

  const rows = log.slice(0, limit).map(e => ({
    forDrawId: e.forDrawId,
    madeAfterDrawId: e.madeAfterDrawId,
    timestamp: e.timestamp,
    marketStateLabel: e.marketStateLabel,
    operatorAction: e.operatorAction,
    riskLevel: e.riskLevel,
    tieProbabilityPct: e.tieProbabilityPct,
    drawsUntilNextTie: e.drawsUntilNextTie,
    // Blueprint upgrade (spec section 9 Performance Loop): Pressure,
    // Expected Window, Confidence -- alongside the existing fields above.
    tiePressureScore: e.tiePressureScore,
    expectedWindowLabel: e.expectedWindowLabel,
    confidenceLabel: e.confidenceLabel,
    scored: e.scored,
    actualWasTie: e.actualWasTie,
    hit: e.hit
  }));

  // Actionable-call accuracy: only TIE_ACTIVE/READY and TIE_APPROACHING/WATCH
  // calls carry a hit/miss verdict (see store.scoreTierForecast()'s
  // reasoning) -- MONITOR/NO_ACTION are excluded from this figure rather
  // than counted as automatic misses.
  function actionableAccuracyOver(n) {
    const slice = scored.filter(e => e.hit !== null).slice(0, n);
    if (slice.length === 0) return null;
    const hits = slice.filter(e => e.hit).length;
    return { sampleSize: slice.length, hitRatePct: Math.round((hits / slice.length) * 1000) / 10 };
  }

  // Baseline: raw tie rate across every SCORED draw regardless of what the
  // engine called, for comparison against actionableAccuracyOver() above.
  // If the engine isn't beating this number, its actionable calls aren't
  // adding value over just knowing the unconditional tie rate.
  function baselineTieRateOver(n) {
    const slice = scored.slice(0, n);
    if (slice.length === 0) return null;
    const ties = slice.filter(e => e.actualWasTie).length;
    return { sampleSize: slice.length, tieRatePct: Math.round((ties / slice.length) * 1000) / 10 };
  }

  res.json({
    rows,
    totalLogged: log.length,
    totalScored: scored.length,
    actionableAccuracy: {
      last10: actionableAccuracyOver(10),
      last30: actionableAccuracyOver(30),
      last100: actionableAccuracyOver(100)
    },
    baselineTieRate: {
      last10: baselineTieRateOver(10),
      last30: baselineTieRateOver(30),
      last100: baselineTieRateOver(100)
    }
  });
});

// Tie Precursor Pattern Engine forecast-accuracy feed -- direct
// structural mirror of /tier-engine-accuracy above, scoped to
// store.tiePrecursorForecastLog instead of store.tierForecastLog.
// Independent log, independent engine, same shape so any client already
// consuming /tier-engine-accuracy can reuse the same rendering logic
// here with a different field set.
router.get('/tie-precursor-accuracy', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const log = store.tiePrecursorForecastLog;
  const scored = log.filter(e => e.scored);

  const rows = log.slice(0, limit).map(e => ({
    forDrawId: e.forDrawId,
    madeAfterDrawId: e.madeAfterDrawId,
    timestamp: e.timestamp,
    riskLevel: e.riskLevel,
    rawCombinedScore: e.rawCombinedScore,
    calibratedCombinedScore: e.calibratedCombinedScore,
    elevatedRisk: e.elevatedRisk,
    activePrecursors: e.activePrecursors,
    scored: e.scored,
    actualWasTie: e.actualWasTie,
    hit: e.hit
  }));

  // Actionable-call accuracy: only elevatedRisk===true calls carry a
  // hit/miss verdict (see store.scoreTiePrecursorForecast()'s reasoning)
  // -- cycles where neither precursor was live are excluded from this
  // figure rather than counted as automatic misses.
  function actionableAccuracyOver(n) {
    const slice = scored.filter(e => e.hit !== null).slice(0, n);
    if (slice.length === 0) return null;
    const hits = slice.filter(e => e.hit).length;
    return { sampleSize: slice.length, hitRatePct: Math.round((hits / slice.length) * 1000) / 10 };
  }

  // Baseline: raw tie rate across every SCORED draw regardless of what
  // the engine called, for comparison against actionableAccuracyOver()
  // above -- if the engine isn't beating this number, its elevated-risk
  // calls aren't adding value over just knowing the unconditional tie
  // rate.
  function baselineTieRateOver(n) {
    const slice = scored.slice(0, n);
    if (slice.length === 0) return null;
    const ties = slice.filter(e => e.actualWasTie).length;
    return { sampleSize: slice.length, tieRatePct: Math.round((ties / slice.length) * 1000) / 10 };
  }

  res.json({
    rows,
    totalLogged: log.length,
    totalScored: scored.length,
    actionableAccuracy: {
      last10: actionableAccuracyOver(10),
      last30: actionableAccuracyOver(30),
      last100: actionableAccuracyOver(100)
    },
    baselineTieRate: {
      last10: baselineTieRateOver(10),
      last30: baselineTieRateOver(30),
      last100: baselineTieRateOver(100)
    },
    // Same shape store.buildTiePrecursorCalibrationData() returns and
    // what council.js feeds back into the engine as calibrationData --
    // included here too so a caller can inspect exactly what's driving
    // this cycle's calibration without cross-referencing /snapshot.
    calibrationByRiskLevel: store.buildTiePrecursorCalibrationData().byRiskLevel
  });
});

// Recommendation #3: season-detection parameter sweep. Diagnostic-only --
// evaluates candidate (maxGap, minTies) pairings against REAL ingested
// history to report which would have best predicted "next draw is a tie"
// via the active-season signal, compared to baseline. Does NOT change
// live SEASON_MAX_GAP/SEASON_MIN_TIES; those remain a deliberate manual
// edit to tieEngine.js's constants if this report recommends a change.
// Optional query params let a caller widen/narrow the grid or the
// minimum-sample-size floor; sane defaults apply otherwise.
router.get('/tier-engine-parameter-sweep', (req, res) => {
  const parseIntList = (raw, fallback) => {
    if (!raw) return fallback;
    const parsed = String(raw).split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n >= 0);
    return parsed.length > 0 ? parsed : fallback;
  };
  const options = {
    candidateGaps: parseIntList(req.query.gaps, undefined),
    candidateMinTies: parseIntList(req.query.minTies, undefined),
    minEvaluations: req.query.minEvaluations ? Math.max(1, parseInt(req.query.minEvaluations, 10) || 5) : undefined
  };
  const result = sweepSeasonParameters(store.historicalDraws, options);
  res.json(result);
});

// Reset Utility
router.post(['/reset', '/v1/reset'], checkAuth, (req, res) => {
  store.resetStore();
  const snapshot = runSupremeCouncil();
  saveSnapshot(store);
  res.json({ status: 'reset_ok', snapshot });
});

module.exports = router;
