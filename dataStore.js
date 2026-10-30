'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, 'data');
const DRAWS_FILE = path.join(DATA_DIR, 'draws.json');

// ── JSONBin.io persistence ──────────────────────────────────────────────
// Render's filesystem is ephemeral: local writes to `data/draws.json`
// survive only until the next deploy/restart, at which point ingested
// draws and everything derived from them (layer weights, batch history)
// are lost. Every other project in this ecosystem solves this with
// JSONBin.io as external persistence; this project was missing it.
//
// Behavior:
//  - If JSONBIN_API_KEY and JSONBIN_BIN_ID are both set, state is loaded
//    from and saved to JSONBin on every ingest/clear, IN ADDITION to the
//    local file (local file acts as a fast warm cache within a single
//    process lifetime; JSONBin is the durable source of truth).
//  - If either env var is missing, the module falls back to local-fs-only
//    behavior (useful for local dev) and logs a warning once at startup,
//    mirroring the warning style already used for GATEWAY_API_KEY.
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY || null;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID || null;
const JSONBIN_ENABLED = !!(JSONBIN_API_KEY && JSONBIN_BIN_ID);
const JSONBIN_HOST = 'api.jsonbin.io';

function jsonbinRequest(method, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: JSONBIN_HOST,
      path: `/v3/b/${JSONBIN_BIN_ID}${method === 'GET' ? '/latest' : ''}`,
      method,
      headers: {
        'X-Master-Key': JSONBIN_API_KEY,
        'Content-Type': 'application/json'
      }
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`JSONBin ${method} failed: ${res.statusCode} ${raw}`));
        }
        try {
          resolve(raw ? JSON.parse(raw) : null);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function loadFromJsonbin() {
  if (!JSONBIN_ENABLED) return null;
  try {
    const result = await jsonbinRequest('GET');
    const record = result && result.record;
    if (record && Array.isArray(record.draws)) {
      return record;
    }
    return null;
  } catch (e) {
    console.error('[dataStore] JSONBin load failed, falling back to local file:', e.message);
    return null;
  }
}

async function saveToJsonbin(payload) {
  if (!JSONBIN_ENABLED) return;
  try {
    await jsonbinRequest('PUT', payload);
  } catch (e) {
    console.error('[dataStore] JSONBin save failed (state still saved locally):', e.message);
  }
}

const state = {
  draws: [],
  lastIngestAt: null
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function calculateRange(numbers) {
  if (!Array.isArray(numbers) || numbers.length === 0) return 'mid';
  const sum = numbers.reduce((a, b) => a + b, 0);
  if (sum < 125) return 'low';
  if (sum > 175) return 'high';
  return 'mid';
}

function normalizeDraw(item, defaultSource = 'api') {
  if (!item) return null;
  let numbers = [];
  if (Array.isArray(item.numbers)) {
    numbers = item.numbers.map(Number);
  } else if (Array.isArray(item.draw)) {
    numbers = item.draw.map(Number);
  } else if (typeof item === 'string') {
    numbers = item.split(/[\s,;|]+/).map(Number);
  }

  numbers = numbers.filter(n => Number.isInteger(n) && n >= 1 && n <= 49);
  // BUG FIX: a real 49-ball draw is 6 *distinct* balls. Without a uniqueness
  // check, a malformed/corrupted ingest payload like [1,1,2,3,4,5] passed
  // straight through (length === 6), silently polluting frequency counts,
  // Markov transitions, and SCIE reliability stats with an impossible draw.
  if (new Set(numbers).size !== numbers.length) return null;
  if (numbers.length !== 6) return null;

  const timestamp = item.timestamp ? new Date(item.timestamp).toISOString() : new Date().toISOString();
  const suppliedDrawId = item.drawId || item.id || null;
  const drawId = suppliedDrawId || `D-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const source = item.source || defaultSource;

  return {
    drawId,
    // True only when the ingest payload itself carried a drawId/id — i.e.
    // a real vendor-supplied draw identifier (e.g. the actual Bet9ja draw
    // ID), as opposed to the synthetic `D-<timestamp>-<rand>` fallback
    // generated when no ID was provided. Lets downstream consumers (like
    // the ON DEMAND prediction) avoid presenting a fabricated ID as if it
    // were the real draw ID.
    drawIdIsSynthetic: !suppliedDrawId,
    numbers,
    timestamp,
    range: calculateRange(numbers),
    source
  };
}

function loadDrawsLocal() {
  ensureDir();
  if (fs.existsSync(DRAWS_FILE)) {
    try {
      const raw = fs.readFileSync(DRAWS_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        state.draws = data;
      } else if (data && Array.isArray(data.draws)) {
        state.draws = data.draws;
        state.lastIngestAt = data.lastIngestAt || null;
      }
    } catch (e) {
      console.error('[dataStore] Failed to parse local draws file:', e.message);
      state.draws = [];
    }
  }
  sortDraws();
}

// Initial load: try JSONBin first (durable source of truth across
// redeploys), then fall back to whatever's on the local disk (covers cold
// start before the first JSONBin save, and local dev without env vars).
async function loadDraws() {
  if (JSONBIN_ENABLED) {
    const remote = await loadFromJsonbin();
    if (remote) {
      state.draws = remote.draws;
      state.lastIngestAt = remote.lastIngestAt || null;
      sortDraws();
      // Warm the local cache too, so a mid-process crash/restart before the
      // next ingest still has something to read locally.
      try {
        ensureDir();
        fs.writeFileSync(DRAWS_FILE, JSON.stringify({ draws: state.draws, lastIngestAt: state.lastIngestAt }, null, 2), 'utf8');
      } catch (e) {
        console.error('[dataStore] Failed to warm local cache from JSONBin:', e.message);
      }
      return;
    }
    console.warn('[dataStore] No usable JSONBin record found yet; falling back to local file.');
  } else {
    console.warn('[dataStore] JSONBIN_API_KEY / JSONBIN_BIN_ID not set — draw data will NOT survive a Render redeploy. Set both env vars to enable durable persistence.');
  }
  loadDrawsLocal();
}

function saveDrawsLocal() {
  ensureDir();
  const payload = {
    draws: state.draws,
    lastIngestAt: state.lastIngestAt
  };
  fs.writeFileSync(DRAWS_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

async function persist() {
  saveDrawsLocal();
  await saveToJsonbin({ draws: state.draws, lastIngestAt: state.lastIngestAt });
}

function sortDraws() {
  state.draws.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

// BUG FIX: this used to dedupe purely by sorted-numbers key, meaning any
// two draws with the same 6 numbers were treated as the same draw even
// when they carried different real vendor-supplied drawIds — a rare but
// real possibility over a long history (49-choose-6 repeats do happen
// eventually), and a much more likely one if a vendor ever reissues a
// corrected draw under a new ID for the same numbers. That would silently
// drop a genuinely distinct real draw as a "duplicate."
//
// Fix: prefer keying on drawId when the payload actually supplied a real
// one (drawIdIsSynthetic === false) — two entries sharing a real drawId
// really are the same draw, and two entries with different real drawIds
// really are different draws regardless of what numbers they contain.
// Only fall back to the numbers-based key for draws with no real ID
// (synthetic-ID entries), where sorted-numbers equality is the only
// duplicate signal available at all — same behavior as before for that
// case.
function getDrawKey(draw) {
  if (draw.drawId && draw.drawIdIsSynthetic === false) {
    return `id:${draw.drawId}`;
  }
  return `nums:${draw.numbers.slice().sort((a, b) => a - b).join('-')}`;
}

async function ingestDraws(items, source = 'api') {
  if (!Array.isArray(items)) {
    items = [items];
  }

  const existingKeys = new Set(state.draws.map(getDrawKey));
  let added = 0;
  let skipped = 0;

  for (const item of items) {
    const norm = normalizeDraw(item, source);
    if (!norm) {
      skipped++;
      continue;
    }
    const key = getDrawKey(norm);
    if (existingKeys.has(key)) {
      skipped++;
      continue;
    }
    existingKeys.add(key);
    state.draws.push(norm);
    added++;
  }

  if (added > 0) {
    state.lastIngestAt = new Date().toISOString();
    sortDraws();
    await persist();
  }

  return { added, skipped, total: state.draws.length };
}

function getAllDraws() {
  return state.draws.slice();
}

function getPaginatedDraws(limit = 30, offset = 0) {
  const slice = state.draws.slice(offset, offset + limit);
  return {
    draws: slice,
    total: state.draws.length,
    limit,
    offset
  };
}

function getStatus() {
  return {
    drawCount: state.draws.length,
    lastIngestAt: state.lastIngestAt,
    latestDraw: state.draws[0] || null,
    persistence: JSONBIN_ENABLED ? 'jsonbin' : 'local-fs-only'
  };
}

async function clearAllData() {
  state.draws = [];
  state.lastIngestAt = null;
  await persist();
}

const ready = loadDraws();

module.exports = {
  ingestDraws,
  getAllDraws,
  getPaginatedDraws,
  getStatus,
  clearAllData,
  calculateRange,
  ready
};
