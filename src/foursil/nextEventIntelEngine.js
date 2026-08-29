/**
 * 4SIL NEXT EVENT INTELLIGENCE ENGINE (4SIL-NEI) — v1.1
 *
 * CONSTITUTIONAL RULE — immutable:
 *   This engine has no voice until 4SIL speaks.
 *   It never modifies 4SIL, never feeds back into gates/weights,
 *   never predicts a color, and never manufactures a forecast
 *   during an inactive 4SIL season.
 *
 * SINGLE QUESTION:
 *   "Now that 4SIL is active, based on how previous 4SIL calls and
 *    paper-trader executions behaved, how soon should the next
 *    4-ball event of ANY color occur?"
 *
 * THREE AUTHORITATIVE INPUT SOURCES (read-only — v1.1 clarification):
 *   1. 4SIL Operator      — live authority/state (eligibility gate)
 *   2. 4SIL Call History  — ENTER→EVENT latency, event spacing, and
 *                           signal signatures (gate combo / season stage)
 *   3. Paper Trader       — observed per-draw execution behavior during
 *                           genuine 4SIL ENTER runs
 *   Everything below (signal latency, event spacing, momentum, hazard
 *   curves, signature profiles) is DERIVED intelligence computed from
 *   these three sources — not a fourth input.
 *
 * LIFECYCLE (v1.1 formalization):
 *   NEI never invents its own ENTER signal. The only trigger that opens
 *   a forecast is a genuine PENDING call in Call History, which itself
 *   only exists because 4SIL confirmed ENTER (see callHistory.js). NEI
 *   purely times a market 4SIL and Call History have already declared
 *   open:
 *       4SIL ENTER → Call History records ENTER → NEI opens a forecast
 *
 * ENGINE STATES (v1.1 — three explicit states, was two):
 *   DORMANT     — 4SIL inactive. No observation, no forecast.
 *   ARMED       — 4SIL active (season live) but no ENTER call is open.
 *                 NEI is watching, not forecasting.
 *   FORECASTING — a Call History ENTER call is PENDING. NEI is actively
 *                 timing this specific event window (forecast may still
 *                 be null if sample size is insufficient).
 *
 * TIMING FUSION WEIGHTS (v1.1 — event spacing now a first-class fusion
 * component instead of collected-but-unused intelligence):
 *   Call-History Timing Score    30 %
 *   Paper-Trader Timing Score    30 %
 *   Live 4SIL State              20 %
 *   Event-Spacing Regime         10 %
 *   Recent Timing Momentum       10 %
 *
 * FORECAST STATES (unchanged):
 *   IMMEDIATE   ( ≥90 )  — event historically arrives on draw 1
 *   NEAR        (75–89)  — typically draw 2–3
 *   DEVELOPING  (60–74)  — clustering around draw 3–5
 *   EXTENDED    (40–59)  — latency is unusually long
 *   NO FORECAST ( <40 )  — insufficient data
 *
 * SEPARATION RULE (absolute):
 *   NEI output → dashboard only
 *   NEI output ✗→ 4SIL gates, weights, ENTER, parliament, or any engine
 */
'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PREDICTION_LOG      = 500;
const RECENT_WINDOW_SIZES     = [10, 25, 50];  // for weighted momentum calc
const RECENT_HIGH_WEIGHT      = 3.0;            // last 10 calls
const RECENT_MED_HIGH_WEIGHT  = 2.0;            // last 25 calls
const RECENT_MED_WEIGHT       = 1.5;            // last 50 calls
const BASELINE_WEIGHT         = 1.0;            // all older calls

// Fusion score thresholds (§9 of the specification)
const THRESHOLD_IMMEDIATE  = 90;
const THRESHOLD_NEAR       = 75;
const THRESHOLD_DEVELOPING = 60;
const THRESHOLD_EXTENDED   = 40;

// Fusion component weights (v1.1 — must sum to 100; spacing added as a
// first-class component per fix #2, taking 10pts from call+paper evenly).
const W_CALL_HISTORY   = 30;
const W_PAPER_TRADER   = 30;
const W_LIVE_STATE     = 20;
const W_SPACING        = 10;
const W_RECENT_MOM     = 10;

// Target probability mass captured by the forecast window (fix #6).
const WINDOW_TARGET_MASS = 75; // percent
const MAX_FORECAST_DRAW  = 11; // matches Call History's tradeWindow ceiling

// Minimum matched sample before a signature profile is trusted (fix #9).
const SIGNATURE_MIN_SAMPLE = 5;

// ---------------------------------------------------------------------------
// State factory
// ---------------------------------------------------------------------------

function freshNEIState() {
  return {
    schemaVersion: 2,
    predictions: [],
    nextPredictionId: 1,
    callIntel: {
      latencies: [],       // raw drawsToHit values from resolved HIT calls (newest-first)
      spacings: [],        // EVENT → EVENT draw gaps while 4SIL is active
      censored: [],        // fix #7: EXPIRED calls — "survived N draws, no event" (right-censored)
      lastEventDrawId: null
    },
    paperIntel: {
      latencies: [],       // draws from genuine ENTER-run start until first HIT (fix #1)
      spacings: [],        // consecutive HIT draw gaps, run-to-run
      censored: [],        // fix #7: ENTER runs that ended (superseded) with no HIT at all
      lastProcessedTradeId: null
    },
    liveCallOpenedDrawId: null,
    updatedAt: null
  };
}

// ---------------------------------------------------------------------------
// INTEL 2 — Call-History Analyzer
// ---------------------------------------------------------------------------

/**
 * Extracts latency + event-spacing + censored-survival measurements from
 * the call history log.
 *   - HIT calls   → latency observations (event) + spacing between events
 *   - EXPIRED calls (fix #7) → censored observations: the signal survived
 *     its full trade window with no qualifying event. These are not
 *     discarded — they inform the hazard/survival curve (an EXPIRED call
 *     that ran the full window tells NEI "this signature can go at least
 *     N draws without an event", which lowers confidence at long horizons
 *     even though it contributes no latency value).
 */
function extractCallIntel(callState, neiState) {
  if (!callState || !Array.isArray(callState.calls)) return;
  const ci = neiState.callIntel;

  const resolved = callState.calls.filter(c => c.status !== 'PENDING');
  const hitCalls = resolved.filter(c => c.status === 'HIT' && c.drawsToHit != null);
  const expiredCalls = resolved.filter(c => c.status === 'EXPIRED');

  ci.latencies = hitCalls.map(c => c.drawsToHit);

  // Censored survival value: how many draws this signal was observed
  // through with no event. Prefer the actual elapsed count if recorded,
  // fall back to the call's configured trade-window ceiling.
  ci.censored = expiredCalls.map(c =>
    Number.isFinite(c.drawsSinceOpen) ? c.drawsSinceOpen
      : (Array.isArray(c.tradeWindow) ? c.tradeWindow[1] : MAX_FORECAST_DRAW)
  );

  // Event spacing: the gap between consecutive HIT draws (drawIds are numeric).
  const spacings = [];
  const ordered = hitCalls.slice().reverse();   // oldest-first
  for (let i = 1; i < ordered.length; i++) {
    const prev = Number(ordered[i - 1].resolvedDrawId);
    const curr = Number(ordered[i].resolvedDrawId);
    if (Number.isFinite(prev) && Number.isFinite(curr) && curr > prev) {
      spacings.push(curr - prev);
    }
  }
  ci.spacings = spacings.slice().reverse(); // newest-first, matching latencies
}

// ---------------------------------------------------------------------------
// INTEL 3 — Paper-Trader Analyzer
// ---------------------------------------------------------------------------

/**
 * Extracts per-ENTER-run first-HIT latency, HIT→HIT spacing, and censored
 * (no-HIT) run survival from the paper trader's trade log.
 *
 * FIX #1: grouping is anchored to trade.enterRunId — an unbroken stretch
 * of genuine 4SIL ENTER draws (see paperTraderEngine.js) — rather than
 * cycleId. A ladder cycle can reset mid-ENTER-run (window-hit threshold,
 * same-stage consecutive hits, stage-limit) without 4SIL ever leaving
 * ENTER, so cycleId over-counts ENTER→EVENT observations. enterRunId only
 * changes when 4SIL genuinely left and re-entered ENTER.
 *
 * Falls back to cycleId grouping for legacy trade logs recorded before
 * enterRunId existed (older persisted state), so upgrades don't crash.
 */
function extractPaperIntel(paperTraderState, neiState) {
  if (!paperTraderState) return;
  const pi = neiState.paperIntel;

  const trades = Array.isArray(paperTraderState.trades) ? paperTraderState.trades : [];
  if (trades.length === 0) return;

  const ordered = trades.slice().reverse(); // oldest-first
  const hasRunId = ordered.some(t => t.enterRunId != null);
  const groupKey = hasRunId ? 'enterRunId' : 'cycleId'; // legacy fallback

  const runMap = new Map();
  let latestKey = null;
  for (const t of ordered) {
    const key = t[groupKey];
    latestKey = key;
    if (!runMap.has(key)) {
      runMap.set(key, { drawsToFirstHit: null, firstHitDrawId: null, drawCount: 0, lastDrawId: null });
    }
    const rec = runMap.get(key);
    rec.drawCount = hasRunId ? (t.drawsIntoEnterRun || rec.drawCount + 1) : rec.drawCount + 1;
    rec.lastDrawId = t.drawId;
    if (t.result === 'HIT' && rec.drawsToFirstHit == null) {
      rec.drawsToFirstHit = rec.drawCount;
      rec.firstHitDrawId  = t.drawId;
    }
  }

  const runsChronological = Array.from(runMap.entries()); // insertion order == chronological (oldest-first)

  const runsWithHit = runsChronological.filter(([, r]) => r.drawsToFirstHit != null);
  pi.latencies = runsWithHit.map(([, r]) => r.drawsToFirstHit).reverse(); // newest-first

  const spacings = [];
  for (let i = 1; i < runsWithHit.length; i++) {
    const prev = Number(runsWithHit[i - 1][1].firstHitDrawId);
    const curr = Number(runsWithHit[i][1].firstHitDrawId);
    if (Number.isFinite(prev) && Number.isFinite(curr) && curr > prev) {
      spacings.push(curr - prev);
    }
  }
  pi.spacings = spacings.reverse(); // newest-first

  // FIX #7: censored runs — an ENTER run that ended (i.e. it is not the
  // most recent, possibly-still-open run) with no HIT at all tells NEI
  // this signature can survive at least drawCount draws with no event.
  pi.censored = runsChronological
    .filter(([key, r]) => key !== latestKey && r.drawsToFirstHit == null && r.drawCount > 0)
    .map(([, r]) => r.drawCount)
    .reverse();
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function weightedAvg(arr) {
  if (!arr || arr.length === 0) return null;
  let sumVal = 0, sumW = 0;
  for (let i = 0; i < arr.length; i++) {
    const w = i < RECENT_WINDOW_SIZES[0] ? RECENT_HIGH_WEIGHT
            : i < RECENT_WINDOW_SIZES[1] ? RECENT_MED_HIGH_WEIGHT
            : i < RECENT_WINDOW_SIZES[2] ? RECENT_MED_WEIGHT
            : BASELINE_WEIGHT;
    sumVal += arr[i] * w;
    sumW   += w;
  }
  return round2(sumVal / sumW);
}

function median(arr) {
  if (!arr || arr.length === 0) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? round2((s[m - 1] + s[m]) / 2) : s[m];
}

function mode(arr) {
  if (!arr || arr.length === 0) return null;
  const freq = {};
  let best = null, bestCount = 0;
  for (const v of arr) {
    freq[v] = (freq[v] || 0) + 1;
    if (freq[v] > bestCount) { bestCount = freq[v]; best = v; }
  }
  return best;
}

function buildDistribution(latencies) {
  if (!latencies || latencies.length === 0) return [];
  const freq = {};
  for (const v of latencies) {
    const bucket = v > 6 ? '6+' : String(v);
    freq[bucket] = (freq[bucket] || 0) + 1;
  }
  const total = latencies.length;
  return Object.entries(freq)
    .map(([draw, count]) => ({ draw, count, pct: Math.round((count / total) * 100) }))
    .sort((a, b) => {
      const av = a.draw === '6+' ? 99 : Number(a.draw);
      const bv = b.draw === '6+' ? 99 : Number(b.draw);
      return av - bv;
    });
}

/**
 * Plain empirical CDF — the probability the event has arrived by `byDraw`,
 * ignoring censoring. Used as a fallback when there isn't enough censored
 * data to justify a Kaplan-Meier estimate.
 */
function cumulativeProbByDraw(latencies, byDraw) {
  if (!latencies || latencies.length === 0) return 0;
  const within = latencies.filter(v => v <= byDraw).length;
  return Math.round((within / latencies.length) * 100);
}

/**
 * FIX #7 — Kaplan-Meier survival estimator.
 *
 * `latencies` are event times (draws-to-hit); `censored` are right-censored
 * survival times (signal observed through draw N with no event). Unlike a
 * plain ECDF, this correctly accounts for the fact that a censored
 * observation was still "at risk" of an event at every draw up to N —
 * it just wasn't followed long enough (or the season closed) to say
 * whether/when the event would have landed. This is the correct estimator
 * for "P(event by draw N)" when some observations never reach an event.
 */
function kaplanMeierCurve(latencies, censored) {
  const events = Array.isArray(latencies) ? latencies.filter(v => Number.isFinite(v) && v > 0) : [];
  const cens   = Array.isArray(censored)  ? censored.filter(v => Number.isFinite(v) && v > 0)  : [];
  if (events.length === 0) return [];

  const obs = [
    ...events.map(t => ({ t, event: true })),
    ...cens.map(t => ({ t, event: false }))
  ];
  const eventTimes = Array.from(new Set(events)).sort((a, b) => a - b);

  let survival = 1;
  const curve = [];
  for (const t of eventTimes) {
    const atRisk = obs.filter(o => o.t >= t).length;
    const d = obs.filter(o => o.t === t && o.event).length;
    if (atRisk > 0) survival *= (1 - d / atRisk);
    curve.push({ t, survival, cumProbPct: round2((1 - survival) * 100) });
  }
  return curve;
}

function cumProbFromCurve(curve, byDraw) {
  if (!curve || curve.length === 0) return null;
  let val = 0;
  for (const point of curve) {
    if (point.t <= byDraw) val = point.cumProbPct;
    else break;
  }
  return Math.round(val);
}

function bestCumulativeProb(latencies, censored, byDraw) {
  if (censored && censored.length > 0) {
    const curve = kaplanMeierCurve(latencies, censored);
    const v = cumProbFromCurve(curve, byDraw);
    if (v != null) return v;
  }
  return cumulativeProbByDraw(latencies, byDraw);
}

// ---------------------------------------------------------------------------
// Timing Score — converts a weighted-average latency into a 0–100 score
// ---------------------------------------------------------------------------

function latencyToScore(weightedMean, med) {
  if (weightedMean == null || weightedMean <= 0) return 0;
  const meanScore   = Math.min(100, Math.round(100 * Math.pow(1 / weightedMean, 0.65)));
  const medianScore = med != null
    ? Math.min(100, Math.round(100 * Math.pow(1 / med, 0.65)))
    : meanScore;
  return Math.round(meanScore * 0.4 + medianScore * 0.6);
}

// ---------------------------------------------------------------------------
// Live 4SIL State Score (INTEL 1)
// ---------------------------------------------------------------------------

function liveSilScore(fourSIL, openCall) {
  if (!fourSIL || !fourSIL.active) return 0;

  const badge = (fourSIL.badge) || {};
  const op    = badge.operatorAction || 'MONITOR';

  const age = (openCall && openCall.drawsSinceOpen != null)
    ? Number(openCall.drawsSinceOpen)
    : 0;

  const baseByOp = op === 'ENTER NOW' ? 100
                 : op === 'PREPARE'   ? 65
                 :                      40;  // MONITOR

  const agePenalty = Math.min(40, age * 4);
  return Math.max(30, baseByOp - agePenalty);
}

// ---------------------------------------------------------------------------
// FIX #2 — Event-Spacing Regime Score
// ---------------------------------------------------------------------------

/**
 * Compares the recent event-to-event spacing against the full baseline
 * spacing, separately per stream, then combines. A shrinking gap (events
 * arriving more often than the signal's own history) raises the score
 * (event more imminent); a growing gap lowers it.
 */
function spacingRegimeScore(callSpacings, paperSpacings) {
  const streamScore = (spacings) => {
    if (!spacings || spacings.length < 2) return null;
    const recent = spacings.slice(0, Math.min(5, spacings.length));
    const recentAvg   = weightedAvg(recent);
    const baselineAvg = weightedAvg(spacings);
    if (recentAvg == null || baselineAvg == null || baselineAvg === 0) return null;
    const ratio = recentAvg / baselineAvg;
    const score = Math.max(0, Math.min(100, Math.round(50 * (2 - ratio))));
    return { score, ratio };
  };

  const callR  = streamScore(callSpacings);
  const paperR = streamScore(paperSpacings);

  let score = 50;
  let ratio = 1;
  if (callR && paperR) {
    score = Math.round((callR.score + paperR.score) / 2);
    ratio = (callR.ratio + paperR.ratio) / 2;
  } else if (callR) {
    score = callR.score; ratio = callR.ratio;
  } else if (paperR) {
    score = paperR.score; ratio = paperR.ratio;
  }

  let regime = 'NORMAL';
  if (ratio < 0.7)        regime = 'CLUSTERING';
  else if (ratio < 0.9)   regime = 'COMPRESSING';
  else if (ratio <= 1.15) regime = 'NORMAL';
  else                    regime = 'EXPANDING';

  return { score, regime, ratio: round2(ratio) };
}

// ---------------------------------------------------------------------------
// FIX #8 — Recent Momentum, computed per-stream then combined
// ---------------------------------------------------------------------------

function streamMomentumScore(latencies) {
  if (!latencies || latencies.length < 3) return null;
  const recent10 = latencies.slice(0, Math.min(10, latencies.length));
  const recentAvg   = weightedAvg(recent10);
  const baselineAvg = weightedAvg(latencies);
  if (recentAvg == null || baselineAvg == null || baselineAvg === 0) return null;
  const ratio = recentAvg / baselineAvg;
  const score = Math.round(50 * (2 - ratio));
  return Math.max(0, Math.min(100, score));
}

function combinedMomentumScore(callLatencies, paperLatencies) {
  const callM  = streamMomentumScore(callLatencies);
  const paperM = streamMomentumScore(paperLatencies);
  const callN  = (callLatencies || []).length;
  const paperN = (paperLatencies || []).length;

  if (callM == null && paperM == null) return 50;
  if (callM != null && paperM == null) return callM;
  if (callM == null && paperM != null) return paperM;

  const totalN = callN + paperN;
  return Math.round((callM * callN + paperM * paperN) / totalN);
}

// ---------------------------------------------------------------------------
// FIX #9 — Signature-specific timing profile
// ---------------------------------------------------------------------------

function buildSignatureProfile(callState, openCall) {
  if (!callState || !Array.isArray(callState.calls) || !openCall) return null;

  const resolved = callState.calls.filter(c => c.status === 'HIT' || c.status === 'EXPIRED');
  if (resolved.length === 0) return null;

  const byStage = resolved.filter(c => c.seasonStageAtOpen === openCall.seasonStageAtOpen);
  let matched = byStage;
  let basis = 'seasonStage';

  if (openCall.gateCombo) {
    const byStageAndGate = byStage.filter(c => c.gateCombo === openCall.gateCombo);
    if (byStageAndGate.length >= SIGNATURE_MIN_SAMPLE) {
      matched = byStageAndGate;
      basis = 'seasonStage+gateCombo';
    }
  }

  if (matched.length < SIGNATURE_MIN_SAMPLE) {
    return {
      basis,
      seasonStage: openCall.seasonStageAtOpen,
      gateCombo: openCall.gateCombo || null,
      sampleSize: matched.length,
      trusted: false,
      hitRatePct: null,
      medianLatency: null
    };
  }

  const hits = matched.filter(c => c.status === 'HIT');
  const hitRatePct = Math.round((hits.length / matched.length) * 100);
  const medianLatency = median(hits.map(c => c.drawsToHit));

  return {
    basis,
    seasonStage: openCall.seasonStageAtOpen,
    gateCombo: openCall.gateCombo || null,
    sampleSize: matched.length,
    trusted: true,
    hitRatePct,
    medianLatency
  };
}

// ---------------------------------------------------------------------------
// Forecast assembly
// ---------------------------------------------------------------------------

function timingStateLabel(score) {
  if (score >= THRESHOLD_IMMEDIATE)  return 'IMMEDIATE';
  if (score >= THRESHOLD_NEAR)       return 'NEAR';
  if (score >= THRESHOLD_DEVELOPING) return 'DEVELOPING';
  if (score >= THRESHOLD_EXTENDED)   return 'EXTENDED';
  return 'NO FORECAST';
}

/**
 * FIX #6 — forecast range derived directly from the per-draw posterior
 * probability mass (best-available cumulative curve — KM-adjusted where
 * censored data exists):
 *   PRIMARY DRAW    = draw with the single highest marginal probability
 *   EXPECTED WINDOW = smallest contiguous [lo, hi] range whose summed
 *                     marginal probability first reaches WINDOW_TARGET_MASS
 */
function buildForecastRange(callLatencies, paperLatencies, callCensored, paperCensored) {
  const allLatencies = [...(callLatencies || []), ...(paperLatencies || [])];
  const allCensored  = [...(callCensored || []), ...(paperCensored || [])];
  if (allLatencies.length === 0) return { primary: null, range: null, windowProbability: null, marginal: [] };

  const cum = [0];
  for (let d = 1; d <= MAX_FORECAST_DRAW; d++) {
    cum[d] = bestCumulativeProb(allLatencies, allCensored, d);
  }
  const marginal = [];
  for (let d = 1; d <= MAX_FORECAST_DRAW; d++) {
    marginal.push({ draw: d, pct: Math.max(0, cum[d] - cum[d - 1]) });
  }

  let primary = 1;
  let bestPct = -1;
  for (const m of marginal) {
    if (m.pct > bestPct) { bestPct = m.pct; primary = m.draw; }
  }

  let lo = primary, hi = primary;
  let mass = marginal.find(m => m.draw === primary).pct;
  while (mass < WINDOW_TARGET_MASS && (lo > 1 || hi < MAX_FORECAST_DRAW)) {
    const leftPct  = lo > 1 ? marginal.find(m => m.draw === lo - 1).pct : -1;
    const rightPct = hi < MAX_FORECAST_DRAW ? marginal.find(m => m.draw === hi + 1).pct : -1;
    if (rightPct >= leftPct && hi < MAX_FORECAST_DRAW) { hi += 1; mass += rightPct; }
    else if (lo > 1) { lo -= 1; mass += leftPct; }
    else break;
  }

  return { primary, range: [lo, hi], windowProbability: Math.round(mass), marginal };
}

// ---------------------------------------------------------------------------
// Prediction logging
// ---------------------------------------------------------------------------

function openPrediction(neiState, forecast, callOpenedDrawId) {
  const pred = {
    id: neiState.nextPredictionId++,
    openedAt: new Date().toISOString(),
    callDrawId: callOpenedDrawId,
    forecast: { ...forecast },
    status: 'OPEN',
    actualDrawsToEvent: null,
    resolvedDrawId: null,
    resolvedAt: null,
    resolvedColor: null,
    accurate: null
  };
  neiState.predictions.unshift(pred);
  if (neiState.predictions.length > MAX_PREDICTION_LOG) {
    neiState.predictions.length = MAX_PREDICTION_LOG;
  }
  return pred;
}

function resolvePrediction(pred, actualDrawsToEvent, drawId, color) {
  pred.status              = 'HIT';
  pred.actualDrawsToEvent  = actualDrawsToEvent;
  pred.resolvedDrawId      = drawId;
  pred.resolvedAt          = new Date().toISOString();
  pred.resolvedColor       = color;
  const [lo, hi]           = pred.forecast.range || [pred.forecast.primary, pred.forecast.primary];
  pred.accurate            = actualDrawsToEvent >= lo && actualDrawsToEvent <= hi;
}

function closePrediction(pred, reason) {
  pred.status     = 'CLOSED';
  pred.resolvedAt = new Date().toISOString();
  pred.closedReason = reason;
}

// ---------------------------------------------------------------------------
// Evaluation rollup
// ---------------------------------------------------------------------------

function buildNEIEvaluation(predictions) {
  const resolved = predictions.filter(p => p.status === 'HIT');
  const total    = predictions.length;
  const hits     = resolved.length;
  const accurate = resolved.filter(p => p.accurate).length;

  const avgActualLatency = hits > 0
    ? round2(resolved.reduce((s, p) => s + (p.actualDrawsToEvent || 0), 0) / hits)
    : null;

  return {
    totalPredictions: total,
    resolvedPredictions: hits,
    accuratePredictions: accurate,
    accuracyRate: hits > 0 ? Math.round((accurate / hits) * 100) : null,
    avgActualLatency
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Advance the 4SIL-NEI for the current council cycle.
 *
 * Must be called AFTER 4SIL and AFTER advanceCallHistory() and
 * advancePaperTrader() have already run for this cycle — it is a
 * pure, read-only downstream consumer of their outputs.
 *
 * SEPARATION RULE: this function's return value must NEVER be passed
 * back into 4SIL, fourBallParliament, council.js's gate logic, or
 * any engine weight/arbitration.
 *
 * @param {object} fourSIL          this cycle's 4SIL result
 * @param {object} callState        callHistory module's persistent state
 * @param {object} paperTraderState store.paperTrader (read-only)
 * @param {Array}  historicalDraws  newest-first draw history
 * @param {object} neiState         NEI's own persistent state (mutated in place)
 * @returns {object} read-only NEI summary for the dashboard
 */
function advanceNEI(fourSIL, callState, paperTraderState, historicalDraws, neiState) {
  const state  = ensureNEIStateShape(neiState);
  const active = !!(fourSIL && fourSIL.active);
  const draws  = Array.isArray(historicalDraws) ? historicalDraws : [];

  // CONSTITUTIONAL RULE: no voice without 4SIL
  if (!active) {
    const openPred = state.predictions.find(p => p.status === 'OPEN');
    if (openPred) closePrediction(openPred, '4SIL_INACTIVE');
    state.liveCallOpenedDrawId = null;
    state.updatedAt = new Date().toISOString();
    return buildNEISummary(state, 'DORMANT', null, fourSIL);
  }

  // ── Update intel streams ─────────────────────────────────────────────────
  extractCallIntel(callState, state);
  extractPaperIntel(paperTraderState, state);

  // ── Determine open call (FIX #4: this is the ONLY thing that opens a
  //    forecast — NEI never independently discovers/declares ENTER) ───────
  const openCall = callState && Array.isArray(callState.calls)
    ? callState.calls.find(c => c.status === 'PENDING')
    : null;

  // FIX #3: three explicit engine states.
  const engineState = openCall ? 'FORECASTING' : 'ARMED';

  // ── Resolve any open prediction ──────────────────────────────────────────
  const openPred = state.predictions.find(p => p.status === 'OPEN');
  if (openPred && draws.length > 0) {
    const callDrawIdStr = String(openPred.callDrawId);
    const openIdx       = draws.findIndex(d => String(d.drawId) === callDrawIdStr);
    const newDraws = openIdx > 0 ? draws.slice(0, openIdx) : [];
    const hitDraw  = [...newDraws].reverse().find(d => !!d.fourBallColor);
    if (hitDraw) {
      const hitIdx = newDraws.findIndex(d => d.drawId === hitDraw.drawId);
      const actualLatency = newDraws.length - hitIdx; // 1-based
      resolvePrediction(openPred, actualLatency, hitDraw.drawId, hitDraw.fourBallColor);
    }
  }

  // ── Compute per-stream statistics ────────────────────────────────────────
  const callLats   = state.callIntel.latencies;
  const paperLats  = state.paperIntel.latencies;
  const callCens   = state.callIntel.censored;
  const paperCens  = state.paperIntel.censored;

  const callStats = {
    n           : callLats.length,
    weightedMean: weightedAvg(callLats),
    median      : median(callLats),
    mode        : mode(callLats),
    distribution: buildDistribution(callLats),
    recentAvg   : callLats.length > 0
      ? weightedAvg(callLats.slice(0, Math.min(10, callLats.length)))
      : null,
    censoredSamples: callCens.length,
    prob1       : bestCumulativeProb(callLats, callCens, 1),
    prob2       : bestCumulativeProb(callLats, callCens, 2),
    prob3       : bestCumulativeProb(callLats, callCens, 3),
    prob5       : bestCumulativeProb(callLats, callCens, 5)
  };

  const paperStats = {
    n           : paperLats.length,
    weightedMean: weightedAvg(paperLats),
    median      : median(paperLats),
    mode        : mode(paperLats),
    distribution: buildDistribution(paperLats),
    recentAvg   : paperLats.length > 0
      ? weightedAvg(paperLats.slice(0, Math.min(10, paperLats.length)))
      : null,
    censoredSamples: paperCens.length,
    prob1       : bestCumulativeProb(paperLats, paperCens, 1),
    prob2       : bestCumulativeProb(paperLats, paperCens, 2),
    prob3       : bestCumulativeProb(paperLats, paperCens, 3),
    prob5       : bestCumulativeProb(paperLats, paperCens, 5)
  };

  // ── Fused latency (display only — the range is now derived directly
  //    from the posterior distribution per fix #6) ─────────────────────────
  let fusedLatency = null;
  const hasCall  = callStats.median  != null;
  const hasPaper = paperStats.median != null;
  if (hasCall && hasPaper) {
    fusedLatency = round2((callStats.median * W_CALL_HISTORY + paperStats.median * W_PAPER_TRADER) / (W_CALL_HISTORY + W_PAPER_TRADER));
  } else if (hasCall) {
    fusedLatency = callStats.median;
  } else if (hasPaper) {
    fusedLatency = paperStats.median;
  }

  // ── Per-component fusion scores ──────────────────────────────────────────
  const callScore    = latencyToScore(callStats.weightedMean, callStats.median);
  const paperScore   = latencyToScore(paperStats.weightedMean, paperStats.median);
  const liveScore    = liveSilScore(fourSIL, openCall);
  const spacing       = spacingRegimeScore(state.callIntel.spacings, state.paperIntel.spacings); // FIX #2
  const momentumScore = combinedMomentumScore(callLats, paperLats); // FIX #8

  const totalSamples = callStats.n + paperStats.n;
  const hasData = totalSamples >= 3;

  // ── Fusion / timing score (urgency, not a probability — see FIX #5) ─────
  let timingScore = 0;
  if (hasData) {
    const callW   = callStats.n > 0  ? W_CALL_HISTORY : 0;
    const paperW  = paperStats.n > 0 ? W_PAPER_TRADER : 0;
    const totalW  = callW + paperW + W_LIVE_STATE + W_SPACING + W_RECENT_MOM;
    timingScore = Math.round(
      (callScore   * callW  +
       paperScore  * paperW +
       liveScore   * W_LIVE_STATE +
       spacing.score * W_SPACING +
       momentumScore * W_RECENT_MOM) / totalW
    );
  }

  // ── FIX #6: forecast range derived directly from the posterior curve ────
  const timingState = hasData ? timingStateLabel(timingScore) : 'NO FORECAST';
  const rangeResult = hasData
    ? buildForecastRange(callLats, paperLats, callCens, paperCens)
    : { primary: null, range: null, windowProbability: null, marginal: [] };

  // ── FIX #9: signature profile (advisory) ─────────────────────────────────
  const signature = openCall ? buildSignatureProfile(callState, openCall) : null;

  // ── FIX #5: confidence = empirical window probability, sample-size
  //    penalized, with a small, capped nudge from a *trusted* signature
  //    match — never the raw fusion/timing score. ───────────────────────────
  let modelConfidence = null;
  if (hasData && rangeResult.windowProbability != null) {
    const dataPenalty = totalSamples < 5 ? 0.7 : totalSamples < 10 ? 0.85 : 1.0;
    let confidence = rangeResult.windowProbability * dataPenalty;
    if (signature && signature.trusted && signature.hitRatePct != null) {
      confidence = confidence * 0.85 + signature.hitRatePct * 0.15;
    }
    modelConfidence = Math.max(0, Math.min(99, Math.round(confidence)));
  }

  const combinedLats = [...callLats, ...paperLats];
  const combinedDist = buildDistribution(combinedLats);

  // ── Open a new prediction when a fresh ENTER call opens (FIX #4) ────────
  const callDrawId = openCall ? openCall.openedDrawId : null;
  const isNewCall  = callDrawId != null && callDrawId !== state.liveCallOpenedDrawId;
  if (isNewCall && timingState !== 'NO FORECAST' && !state.predictions.find(p => p.status === 'OPEN')) {
    openPrediction(state, {
      timingState,
      primary: rangeResult.primary,
      range: rangeResult.range,
      windowProbability: rangeResult.windowProbability,
      confidence: modelConfidence,
      timingScore
    }, callDrawId);
    state.liveCallOpenedDrawId = callDrawId;
  } else if (callDrawId != null) {
    state.liveCallOpenedDrawId = callDrawId;
  }

  const forecast = {
    timingState,
    primary: rangeResult.primary,
    range: rangeResult.range,
    windowProbability: rangeResult.windowProbability,
    confidence: modelConfidence,
    timingScore
  };

  state.updatedAt = new Date().toISOString();
  return buildNEISummary(state, engineState, forecast, fourSIL, {
    callStats, paperStats, fusedLatency, callScore, paperScore,
    liveScore, spacing, momentumScore, totalSamples, combinedDist, signature,
    marginal: rangeResult.marginal
  });
}

// ---------------------------------------------------------------------------
// State shape guard
// ---------------------------------------------------------------------------

function ensureNEIStateShape(s) {
  if (!s || typeof s !== 'object') return freshNEIState();
  if (!s.schemaVersion) s.schemaVersion = 1;
  if (!Array.isArray(s.predictions))    s.predictions = [];
  if (typeof s.nextPredictionId !== 'number') s.nextPredictionId = 1;
  if (!s.callIntel  || typeof s.callIntel  !== 'object') s.callIntel  = { latencies: [], spacings: [], censored: [], lastEventDrawId: null };
  if (!s.paperIntel || typeof s.paperIntel !== 'object') s.paperIntel = { latencies: [], spacings: [], censored: [], lastProcessedTradeId: null };
  if (!Array.isArray(s.callIntel.latencies))  s.callIntel.latencies  = [];
  if (!Array.isArray(s.callIntel.spacings))   s.callIntel.spacings   = [];
  if (!Array.isArray(s.callIntel.censored))   s.callIntel.censored   = [];
  if (!Array.isArray(s.paperIntel.latencies)) s.paperIntel.latencies = [];
  if (!Array.isArray(s.paperIntel.spacings))  s.paperIntel.spacings  = [];
  if (!Array.isArray(s.paperIntel.censored))  s.paperIntel.censored  = [];
  if (typeof s.liveCallOpenedDrawId === 'undefined') s.liveCallOpenedDrawId = null;
  if (typeof s.updatedAt === 'undefined')             s.updatedAt = null;
  s.schemaVersion = 2;
  return s;
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildNEISummary(state, engineState, forecast, fourSIL, computed) {
  const c = computed || {};
  const evaluation = buildNEIEvaluation(state.predictions);

  return {
    engine: '4SIL-NEI',
    version: '1.1',
    engineState,          // 'DORMANT' | 'ARMED' | 'FORECASTING'

    forecast: forecast && forecast.timingState !== 'NO FORECAST' ? {
      timingState      : forecast.timingState,
      primary          : forecast.primary,
      range            : forecast.range,
      rangeLabel       : forecast.range ? `DRAW ${forecast.range[0]}–${forecast.range[1]}` : null,
      // FIX #5: two distinct numbers instead of one overloaded "confidence":
      //   windowProbability = empirical probability mass inside the range
      //   confidence        = that probability, sample-size penalized and
      //                        lightly signature-adjusted
      //   timingScore       = fusion/urgency score (was mislabeled "confidence")
      windowProbability: forecast.windowProbability,
      confidence       : forecast.confidence,
      timingScore      : forecast.timingScore
    } : null,

    intel: {
      call: c.callStats ? {
        samples         : c.callStats.n,
        censoredSamples : c.callStats.censoredSamples,
        weightedMean    : c.callStats.weightedMean,
        median          : c.callStats.median,
        mode            : c.callStats.mode,
        recentAvg       : c.callStats.recentAvg,
        prob1Draw       : c.callStats.prob1,
        prob2Draws      : c.callStats.prob2,
        prob3Draws      : c.callStats.prob3,
        prob5Draws      : c.callStats.prob5,
        distribution    : c.callStats.distribution,
        timingScore     : c.callScore
      } : null,
      paper: c.paperStats ? {
        samples         : c.paperStats.n,
        censoredSamples : c.paperStats.censoredSamples,
        weightedMean    : c.paperStats.weightedMean,
        median          : c.paperStats.median,
        mode            : c.paperStats.mode,
        recentAvg       : c.paperStats.recentAvg,
        prob1Draw       : c.paperStats.prob1,
        prob2Draws      : c.paperStats.prob2,
        prob3Draws      : c.paperStats.prob3,
        prob5Draws      : c.paperStats.prob5,
        distribution    : c.paperStats.distribution,
        timingScore     : c.paperScore
      } : null,
      spacing: c.spacing ? {
        regime: c.spacing.regime,
        score: c.spacing.score,
        recentToBaselineRatio: c.spacing.ratio
      } : null,
      signature: c.signature,
      fusion: c.fusedLatency != null ? {
        fusedLatency         : c.fusedLatency,
        liveStateScore        : c.liveScore,
        momentumScore         : c.momentumScore,
        totalSamples          : c.totalSamples,
        combinedDistribution  : c.combinedDist,
        marginalByDraw         : c.marginal
      } : null
    },

    liveCall: {
      openedDrawId: state.liveCallOpenedDrawId
    },

    predictions: state.predictions.slice(0, 50),

    evaluation,

    updatedAt: state.updatedAt
  };
}

module.exports = {
  freshNEIState,
  ensureNEIStateShape,
  advanceNEI,
  buildNEISummary
};
