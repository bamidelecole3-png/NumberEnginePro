'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const dataStore = require('./dataStore');
const numberEngine = require('./engines/numberEngine');
const ladderTracker = require('./engines/ladderTracker');
const scieEngine = require('./engines/scieEngine');
const top4RealityEngine = require('./engines/top4RealityEngine');
const slipFeed = require('./slipFeed');
const telegramGate = require('./telegramGate');

const app = express();
const PORT = process.env.PORT || 3000;
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || null;

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Bet Slip Assistant feed (GET /api/v1/slip/latest, POST /api/v1/slip/refresh) — gated by its own SLIP_API_KEY, off until set.
app.use('/api/v1/slip', slipFeed.router);

function requireApiKey(req, res, next) {
  if (!GATEWAY_API_KEY) return next();
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  if (!apiKey) return res.status(401).json({ error: 'Unauthorized: API Key missing' });

  try {
    const a = Buffer.from(apiKey);
    const b = Buffer.from(GATEWAY_API_KEY);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return next();
    }
  } catch (e) {
    // fallthrough
  }
  return res.status(403).json({ error: 'Forbidden: Invalid API Key' });
}

// FIX: bound and validate the `size` query param used across prediction routes.
// Previously `parseInt(x,10) || 4` let size=0 fall back silently, but let
// negative values (e.g. -5) pass straight through to Array.slice(0, -5)
// (returning far more candidates than requested) and let oversized values
// (e.g. 999) silently clamp with no error, both hiding malformed input.
function parseSize(raw, fallback, min, max) {
  if (raw === undefined || raw === null || raw === '') return { value: fallback, error: null };
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    return { value: null, error: `size must be an integer between ${min} and ${max}` };
  }
  return { value: n, error: null };
}

// FIX: server-side sanitizer for any free-text field that gets echoed back to
// the client and rendered into the DOM (e.g. draw `source`). The frontend
// was interpolating this value directly into innerHTML without escaping,
// so an ingest payload could stash a script/markup payload that executes
// when the Draw Management tab renders it (stored XSS).
function sanitizeText(str, maxLen = 120) {
  if (typeof str !== 'string') return 'unknown';
  return str
    .replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]))
    .slice(0, maxLen);
}

// TOP 4 LIVE REALITY ENGINE — hooked into the successful-ingest lifecycle
// only (spec §34, §85: "Reality Engine only processes successfully accepted
// draws," triggered by accepted live draws, never frontend timers). Wrapped
// so a Reality Engine failure can never break the collector response or
// affect the accepted draw / normal Number Engine state (spec §83).
function notifyRealityEngine(result) {
  if (!result || !result.added) return;
  // Telegram signal channel: post the new prediction (no-op unless the bot env vars are set; never affects ingest).
  try { telegramGate.onNewDraws(result, { dataStore, numberEngine }); } catch (e) { console.error('[telegram] hook failed:', e.message); }
  try {
    top4RealityEngine.onNewDrawsIngested(dataStore.getAllDraws());
  } catch (e) {
    console.error('[top4RealityEngine] onNewDrawsIngested failed (accepted draw + existing engine state unaffected):', e.message);
  }
}

// ── DATA INGEST PIPELINE ────────────────────────────────────────────────
app.post('/api/v1/collector', requireApiKey, async (req, res) => {
  try {
    const payload = req.body;
    const items = payload.draws || payload.items || payload;
    const source = sanitizeText(payload.source || 'collector_gateway');
    const result = await dataStore.ingestDraws(items, source);
    notifyRealityEngine(result);
    res.json({ success: true, ...result, timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/ingest', async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'Invalid request body' });
    }
    const items = payload.draws || payload.items || payload;
    const source = sanitizeText(payload.source || 'manual');
    const result = await dataStore.ingestDraws(items, source);
    notifyRealityEngine(result);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── STATUS & SYSTEM METRICS ──────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const dsStatus = dataStore.getStatus();
  const draws = dataStore.getAllDraws();
  const scieRes = scieEngine.computeScieScores(draws);
  const archive = numberEngine.getArchive();

  const untunedBatches = archive.batches.length === 0;

  res.json({
    ...dsStatus,
    adaptive: {
      adaptationStatus: untunedBatches ? 'LEARNING (no completed batches yet)' : 'ACTIVE',
      regime: draws.length > 50 ? 'patterned' : 'learning',
      learningProgress: draws.length,
      layerRanking: archive.layerRanking,
      failureSummary: untunedBatches
        ? `SCIE Engine initialized with ${scieRes.activeSignals.length} active signals. Weights are still at their default split — real tuning begins after the first completed 5-draw batch.`
        : `SCIE Engine tracking ${scieRes.activeSignals.length} active signals. Layer weights last updated after batch #${archive.batches[0].batchId} based on real per-layer hit rates.`
    }
  });
});

// ── NUMBER PREDICTION API ────────────────────────────────────────────────
app.get('/api/number/predict', (req, res) => {
  const { value: size, error } = parseSize(req.query.size, 4, 1, 20);
  if (error) return res.status(400).json({ error });
  const result = numberEngine.predictNumbers(size);
  res.json(result);
});

app.get('/api/number/ladder', (req, res) => {
  const { value: size, error } = parseSize(req.query.size, 5, 1, 49);
  if (error) return res.status(400).json({ error });
  const ds = dataStore.getStatus();
  const status = ladderTracker.ladderProgress(ds.drawCount, size);
  res.json(status);
});

// ── SCIE ENGINE DIAGNOSTICS ──────────────────────────────────────────────
// FIX: this route used to call computeScieScores(draws) with no second
// argument, so Step 10 conflict resolution never received the other 5
// engines' scores and silently returned an empty conflicts array — even
// though real conflicts exist once that context is available. predictNumbers()
// already computes those layer scores and runs SCIE with them, so this
// route reuses that single result instead of recomputing SCIE blind,
// keeping the diagnostics widget consistent with what the meta engine
// actually saw when it last predicted.
app.get('/api/number/scie', (req, res) => {
  const draws = dataStore.getAllDraws();
  const predictResult = numberEngine.predictNumbers(4);

  if (predictResult.error) {
    // Not enough draws yet for a full prediction cycle — fall back to a
    // context-free SCIE computation so the widget still shows something.
    const scieData = scieEngine.computeScieScores(draws);
    return res.json({ success: true, drawsAnalyzed: draws.length, ...scieData });
  }

  res.json({
    success: true,
    drawsAnalyzed: draws.length,
    ...predictResult.scieSummary
  });
});

app.get('/api/meta/decision', (req, res) => {
  const draws = dataStore.getAllDraws();
  const scieRes = scieEngine.computeScieScores(draws);
  const predictResult = numberEngine.predictNumbers(4);
  const archive = numberEngine.getArchive();

  const combinedConfidence = predictResult.overallConfidence || null;

  // "Agreement" = how many of the 6 layers actually voted (score >= 60) for
  // at least one of the top predicted numbers, out of the 6 total layers.
  let agreement = null;
  if (!predictResult.error) {
    const votingLayers = new Set();
    for (const candidate of predictResult.numberDetails) {
      for (const [layer, score] of Object.entries(candidate.layerScores)) {
        if (score >= 60) votingLayers.add(layer);
      }
    }
    agreement = Math.round((votingLayers.size / 6) * 100);
  }

  res.json({
    recommendation: scieRes.clusterConfidence === 'HIGH' ? 'STRONG PLAY' : 'NORMAL PLAY',
    combinedConfidence,
    agreement,
    regime: draws.length > 50 ? 'patterned' : 'learning',
    explanation: `Meta Brain synthesized 6 engines (Markov, SCIE, Momentum, Survivor, Frequency, Combination) including ${scieRes.activeSignals.length} SCIE live cluster signals. Weights last tuned after batch #${archive.batches[0]?.batchId ?? 'none yet'}.`
  });
});

app.get('/api/analytics', (req, res) => {
  const archive = numberEngine.getArchive();
  const lifetimeWinRate = archive.performance.total
    ? Math.round((archive.performance.wins / archive.performance.total) * 100)
    : null;

  // Recent-N batches (most recent 10, i.e. last ~50 draws) computed from
  // real batch history rather than a fixed "recent100" placeholder, since
  // batches are evaluated every 5 draws, not every 1.
  const recentBatches = archive.batches.slice(0, 10);
  const recentWinRate = recentBatches.length
    ? Math.round((recentBatches.filter(b => b.result.isWin).length / recentBatches.length) * 100)
    : null;

  res.json({
    number: {
      lifetime: { sample: archive.performance.total, winRate: lifetimeWinRate },
      recentBatches: { sample: recentBatches.length, winRate: recentWinRate },
      layerRanking: archive.layerRanking
    }
  });
});

app.get('/api/number/archive', (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const archive = numberEngine.getArchive();
  res.json({
    batches: archive.batches.slice(0, limit),
    performance: archive.performance
  });
});

app.get('/api/number/ladder-performance-5', (req, res) => {
  const perf = numberEngine.getFiveDrawLadderPerformance();
  res.json(perf);
});

// ── CORRELATION-AWARE META ENGINE (CAME) DIAGNOSTICS ─────────────────────
// v18: surfaces the Brier calibration + pairwise correlation state that now
// drives layerWeights, plus redundancy warnings and the "effective
// independence" figure. getArchive() already computes this every call, so
// this route just re-exposes the `came` field under its own path for a
// dedicated dashboard widget.
app.get('/api/number/came', (req, res) => {
  const archive = numberEngine.getArchive();
  res.json({ success: true, ...archive.came });
});

// ── v19 — ENHANCED ENGINE HEALTH MONITOR ─────────────────────────────────
// Accuracy-by-layer, layer reliability trend, confidence trend, prediction
// consistency, learning progress, overall health status, and the current
// adaptive voting weights — all derived read-only from existing tracker
// state (see engines/healthMonitorEngine.js).
app.get('/api/number/health', (req, res) => {
  const health = numberEngine.getEngineHealth();
  res.json({ success: true, ...health });
});

app.get('/api/predict/live/all', (req, res) => {
  const numPred = numberEngine.predictNumbers(4);
  res.json({
    generatedAt: new Date().toISOString(),
    drawsUsed: dataStore.getStatus().drawCount,
    number: numPred
  });
});

app.get('/api/intelligence/report', (req, res) => {
  const archive = numberEngine.getArchive();

  const overallWinRate = archive.performance.total
    ? Math.round((archive.performance.wins / archive.performance.total) * 100)
    : null;

  // Calibration: compare each batch's stated overallConfidence against
  // whether it actually won, averaged across all completed batches. This
  // is the real analogue of "was our confidence justified" rather than a
  // hardcoded "Optimal" label.
  let calibration = null;
  if (archive.batches.length >= 3) {
    const avgConfidence = archive.batches.reduce((a, b) => a + b.prediction.overallConfidence, 0) / archive.batches.length;
    const actualSuccess = overallWinRate;
    const gap = Math.abs(avgConfidence - actualSuccess);
    calibration = {
      averageConfidence: Math.round(avgConfidence),
      actualSuccess,
      calibration: gap <= 8 ? 'Well-calibrated' : gap <= 18 ? 'Moderate drift' : 'Overconfident'
    };
  }

  // Momentum: compare win rate of the most recent half of batches vs the
  // earlier half, rather than a hardcoded "Rising" label.
  let momentum = null;
  if (archive.batches.length >= 4) {
    const half = Math.floor(archive.batches.length / 2);
    const recentHalf = archive.batches.slice(0, half);
    const olderHalf = archive.batches.slice(half);
    const recentRate = recentHalf.filter(b => b.result.isWin).length / recentHalf.length;
    const olderRate = olderHalf.filter(b => b.result.isWin).length / olderHalf.length;
    const trendPct = Math.round((recentRate - olderRate) * 1000) / 10;
    momentum = {
      rating: trendPct > 5 ? 'Rising' : trendPct < -5 ? 'Falling' : 'Flat',
      confidenceTrendPct: trendPct
    };
  }

  // Learning notes: only report batches where a layer's weight actually
  // moved meaningfully after that batch, derived from real weightsAfter
  // snapshots, instead of one fixed fabricated string.
  const learningNotes = [];
  for (let i = archive.batches.length - 2; i >= 0; i--) {
    const before = archive.batches[i + 1]?.weightsAfter;
    const after = archive.batches[i]?.weightsAfter;
    if (!before || !after) continue;
    for (const layer of Object.keys(after)) {
      const delta = after[layer] - before[layer];
      if (Math.abs(delta) >= 0.02) {
        learningNotes.push({
          batchId: archive.batches[i].batchId,
          layer,
          result: archive.batches[i].result.isWin ? 'WIN' : 'LOSS',
          notes: [`${layer} weight moved ${delta > 0 ? '+' : ''}${Math.round(delta * 1000) / 10}pp after this batch.`]
        });
      }
    }
  }

  const latestBatch = archive.batches[0];
  const predictionBreakdown = latestBatch
    ? {
        available: true,
        finalConfidence: latestBatch.prediction.overallConfidence,
        contributors: archive.layerRanking.map(l => ({ name: l.name, pct: Math.round(l.weight * 100) }))
      }
    : { available: false };

  res.json({
    executive: {
      overallWinRate,
      wins: archive.performance.wins,
      losses: archive.performance.losses,
      lastUpdated: new Date().toISOString(),
      calibration,
      momentum
    },
    ladderHistory: archive.batches.map(b => ({
      id: b.batchId,
      result: b.result.isWin ? 'WIN' : 'LOSS',
      engineLabel: 'SCIE Ensembled Number Engine',
      prediction: b.prediction.predictedNumbers,
      confidence: b.prediction.overallConfidence,
      reason: [`Matched ${b.result.numberHits} target numbers within 5 draws window.`],
      source: 'number'
    })),
    learningNotes,
    predictionBreakdown,
    stability: archive.batches.length >= 3 ? {
      current: overallWinRate >= 60 ? 'Stable' : overallWinRate >= 40 ? 'Volatile' : 'Underperforming',
      sample: archive.batches.length
    } : { current: 'Insufficient data' },
    timeline: archive.batches.map(b => ({ batchId: b.batchId, source: 'number', isWin: b.result.isWin, confidence: b.prediction.overallConfidence }))
  });
});

app.get('/api/intelligence/replay', (req, res) => {
  const draws = dataStore.getAllDraws().slice(0, 5);
  const archive = numberEngine.getArchive();
  const latestBatch = archive.batches[0];

  if (!latestBatch) {
    return res.json({ found: false, steps: [], turningPoint: null });
  }

  const predictedSet = new Set(latestBatch.prediction.predictedNumbers);
  let turningPoint = null;

  const steps = draws.map((d, i) => {
    const isHit = d.numbers.some(n => predictedSet.has(n));
    if (isHit && turningPoint === null) turningPoint = { step: i + 1 };
    return { step: i + 1, timestamp: d.timestamp, numbers: d.numbers, isHit };
  });

  res.json({ found: true, steps, turningPoint });
});

app.get('/api/draws', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 30));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  res.json(dataStore.getPaginatedDraws(limit, offset));
});

// ── TOP 4 LIVE REALITY ENGINE — API ──────────────────────────────────────
// Independent audit surface (spec §49-52). Entirely read-only: these routes
// never trigger snapshot creation/evaluation — that only happens via the
// accepted-draw ingest hook above (spec §44).
app.get('/api/v1/top4-reality', (req, res) => {
  res.json(top4RealityEngine.getStatus());
});

app.get('/api/v1/top4-reality/history', (req, res) => {
  res.json(top4RealityEngine.getHistory(req.query.limit));
});

app.get('/api/v1/top4-reality/stats', (req, res) => {
  res.json(top4RealityEngine.getStats());
});

app.get('/api/v1/top4-reality/debug', (req, res) => {
  res.json(top4RealityEngine.getDebug());
});

// BUG FIX: /api/clear deletes every ingested draw and all derived state —
// the only fully destructive route in this API — but was the one route
// with no requireApiKey gate at all, even when GATEWAY_API_KEY is set.
// Every other state-mutating route (/api/v1/collector) is gated; this one
// was reachable by anyone who could reach the server, unauthenticated.
app.post('/api/clear', requireApiKey, async (req, res) => {
  await dataStore.clearAllData();
  // BUG FIX: clearAllData() only wiped draws + normal engine derived state.
  // The Top4 Reality Engine keeps its own separate persistence file and was
  // never reset here, so a stale Reality snapshot (and stale rolling/
  // baseline/drought numbers) could survive a clear and reference draws
  // that no longer exist. Reset it alongside the rest of derived state.
  top4RealityEngine.reset();
  slipFeed.reset();   // a pinned slip prediction must not outlive the draws it was built from
  res.json({ success: true, message: 'All draw data cleared.' });
});

dataStore.ready.then(() => {
  // Restore any active Reality snapshot before accepting traffic (spec §41,
  // §72) — never generate a replacement snapshot just because the server
  // restarted.
  top4RealityEngine.init();

  app.listen(PORT, () => {
    console.log(`[49ja Engine v18 · CAME] Server running on port ${PORT}`);
    console.log(`[Top 4 Live Reality Engine] Background audit ACTIVE.`);
    if (!GATEWAY_API_KEY) {
      console.warn(`[SECURITY WARNING] GATEWAY_API_KEY is not set. Ingest endpoints are unauthenticated.`);
    }
    telegramGate.start().catch((e) => console.error('[telegram] start failed:', e.message));
    if (!process.env.SLIP_API_KEY) console.log('[slipFeed] SLIP_API_KEY not set — Bet Slip Assistant feed is disabled.');
  });
});
