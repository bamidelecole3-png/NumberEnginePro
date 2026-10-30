'use strict';

/**
 * slipFeed.js — read-only feed for the Number Engine Bet Slip Assistant (Chrome extension, BT-49 ladder).
 *
 * Contract (identical to the GEN X server's, so both extensions talk the same protocol):
 *   GET  /api/v1/slip/latest   → the latest LOCKED prediction + the latest draw record
 *   POST /api/v1/slip/refresh  → lock a fresh prediction if the locked one is older than the latest draw, then return it
 * Auth: header  X-API-Key: <SLIP_API_KEY>  (a separate key from GATEWAY_API_KEY; it cannot ingest or clear draws).
 * The feed is switched off (503 slip_feed_disabled) until SLIP_API_KEY is set.
 *
 * Reply fields the ladder (ladder.js) relies on:
 *   ok, numbers[4], predictionId, sourceDrawId, forLatestDraw, confidence, lastDraw:{drawId, numbers[], timestamp}, recentDraws[] (newest first, real ids only)
 *
 * Why a "lock": numberEngine.predictNumbers() is a live computation. The ladder must trade ONE fixed set draw after
 * draw, and must be able to tell an old prediction from a fresh one, so the feed pins one prediction per source draw
 * (predictionId = "NE-<sourceDrawId>") and only replaces it when /refresh is called after a newer draw has arrived.
 *
 * Safety rules (the ladder never guesses, so the feed must never hand it something it cannot trust):
 *   • the latest draw must carry a REAL drawId (not the synthetic "D-<timestamp>-<rand>" fallback): the ladder detects
 *     skipped draws from consecutive numeric ids, which synthetic ids cannot give → error draw_id_not_real.
 *   • a prediction must be exactly 4 distinct numbers in 1..49.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const dataStore = require('./dataStore');
const numberEngine = require('./engines/numberEngine');

const SLIP_API_KEY = process.env.SLIP_API_KEY || '';
const DATA_DIR = path.join(__dirname, 'data');
const LOCK_FILE = path.join(DATA_DIR, 'slip_lock.json');
const SLIP_SIZE = 4;
const RECENT_DRAWS = 12;   // how many of the latest draws the feed carries, so the ladder can still score a trade when two draws arrive in one burst

// ── the pinned prediction (survives a restart on the local disk; best-effort on ephemeral hosts) ─────────────
let lock = null;
function loadLock() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return null;
    const j = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    return j && j.predictionId && Array.isArray(j.numbers) ? j : null;
  } catch (e) { return null; }
}
function saveLock() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = LOCK_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(lock));
    fs.renameSync(tmp, LOCK_FILE);
  } catch (e) { console.error('[slipFeed] could not persist lock (continuing in memory):', e.message); }
}
lock = loadLock();

/** Called when all draw data is cleared (/api/clear): a lock that points at vanished draws must not survive. */
function reset() {
  lock = null;
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch (e) { /* ignore */ }
}

const validNumbers = (a) => Array.isArray(a) && a.length === SLIP_SIZE && new Set(a).size === SLIP_SIZE
  && a.every((n) => Number.isInteger(n) && n >= 1 && n <= 49);

function latestDraw() {
  const draws = dataStore.getAllDraws();            // newest first
  return draws && draws.length ? draws[0] : null;
}

/** The latest draws that carry a REAL drawId, newest first (the ladder needs ids it can count on). */
function recentDraws() {
  return dataStore.getAllDraws().filter((d) => !d.drawIdIsSynthetic).slice(0, RECENT_DRAWS)
    .map((d) => ({ drawId: String(d.drawId), numbers: d.numbers, timestamp: d.timestamp }));
}

function buildPayload() {
  const last = latestDraw();
  const lastDraw = last ? { drawId: String(last.drawId), numbers: last.numbers, timestamp: last.timestamp } : null;
  const base = { serverTime: new Date().toISOString(), lastDraw, drawSize: last && Array.isArray(last.numbers) ? last.numbers.length : null, recentDraws: recentDraws() };
  if (!last) return { ok: false, error: 'no_draws', ...base };
  if (last.drawIdIsSynthetic) return { ok: false, error: 'draw_id_not_real', ...base };
  if (!lock) return { ok: false, error: 'no_prediction_locked_yet', ...base };
  return {
    ok: true,
    predictionId: lock.predictionId,
    sourceDrawId: lock.sourceDrawId,
    latestDrawId: String(last.drawId),
    // false once a newer draw has arrived since this prediction was locked
    forLatestDraw: String(last.drawId) === String(lock.sourceDrawId),
    lockedAt: lock.lockedAt,
    confidence: lock.confidence,
    numbers: lock.numbers.slice(),
    ...base
  };
}

/**
 * Lock a prediction for the latest draw. predictNumbers() reads the layer weights BEFORE it evaluates a just-completed
 * 5-draw batch (which then updates those weights), so the very first call after such a draw scores with the old weights
 * and every later call (the dashboard's next poll) with the new ones. A second call settles that, so the locked set is
 * the one the dashboard shows from then on.
 */
function lockFresh() {
  const first = numberEngine.predictNumbers(SLIP_SIZE);
  if (!first || first.error) return { ok: false, reason: (first && first.error) || 'no_result' };
  const second = numberEngine.predictNumbers(SLIP_SIZE);
  const r = second && !second.error && String(second.sourceDrawId) === String(first.sourceDrawId) ? second : first;
  if (!validNumbers(r.predictedNumbers)) return { ok: false, reason: 'invalid_prediction' };
  lock = {
    predictionId: 'NE-' + String(r.sourceDrawId),
    sourceDrawId: String(r.sourceDrawId),
    numbers: r.predictedNumbers.slice(),
    confidence: r.overallConfidence,
    lockedAt: new Date().toISOString()
  };
  saveLock();
  return { ok: true };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────────────────
const router = express.Router();

// CORS for chrome-extension:// callers (custom X-API-Key header ⇒ preflight). Key-gated, so reflecting the origin is safe.
router.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    res.set('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function keyMatches(provided) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(SLIP_API_KEY));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function gate(req, res, next) {
  if (!SLIP_API_KEY) return res.status(503).json({ ok: false, error: 'slip_feed_disabled' });
  if (!keyMatches(req.get('X-API-Key'))) return res.status(401).json({ ok: false, error: 'bad_api_key' });
  next();
}

router.get('/latest', gate, (req, res) => res.json(buildPayload()));

router.post('/refresh', gate, (req, res) => {
  const last = latestDraw();
  if (!last) return res.json(buildPayload());
  if (last.drawIdIsSynthetic) return res.json(buildPayload());
  const stale = !lock || String(lock.sourceDrawId) !== String(last.drawId);
  let refreshed = false;
  if (stale) {
    const r = lockFresh();
    if (!r.ok) return res.json({ ...buildPayload(), ok: false, error: 'engine_not_ready', reason: r.reason });
    refreshed = true;
  }
  res.json({ ...buildPayload(), refreshed });
});

module.exports = { router, reset, buildPayload, lockFresh, validNumbers };
