/**
 * 4SIL PAPER TRADER — read API.
 *
 * v2: dedicated reads for the paper-trading ledger computed synchronously
 * inside runSupremeCouncil() (see src-legacy-core/src/engines/paperTraderEngine.js
 * and its wiring in src-legacy-core/src/supreme/council.js). GET
 * /v1/snapshot's own `paperTrader` field already carries the full live
 * summary; these routes exist for direct/filtered access.
 *
 * BUGFIX (superseding the v1 bus-driven implementation that used to live
 * in this file + src/foursil/paperTrader.js): the old design advanced the
 * paper trader from a separate ON_DRAW_INGESTED subscriber that read
 * store.cachedSystemState -- which is only overwritten by the collector's
 * POST handler AFTER it publishes that same event, so every subscriber
 * saw the PREVIOUS draw's 4SIL state, one draw stale, every time. The
 * paper trader could sit at WAITING_FOR_ENTER forever even while 4SIL was
 * genuinely firing ENTER, because it was always trading one draw late.
 *
 * Fix (ported from the sniper-fourball sibling project, v1.1): the paper
 * trader now runs synchronously inside council.js's runSupremeCouncil(),
 * in the exact same pass that computes fourSIL for the current draw --
 * there is no separate cache to go stale. This file is now a pure,
 * read-only proxy onto store.cachedSystemState.paperTrader / store.paperTrader.
 * It never advances the engine itself.
 */
'use strict';

const express = require('express');
const router = express.Router();

const { store } = require('../../src-legacy-core/src/core/store');
const { runSupremeCouncil } = require('../../src-legacy-core/src/supreme/council');
const { freshPaperTraderState } = require('../../src-legacy-core/src/engines/paperTraderEngine');
const { saveSnapshot } = require('../../src-legacy-core/src/services/persistence');

function getSnapshot() {
  return store.cachedSystemState || runSupremeCouncil();
}

// ---------------------------------------------------------------------------
// Config read/write -- dashboard-adjustable settings (stake ladder, starting
// capital). This is the one place this file is allowed to touch
// store.paperTrader beyond reading it: it never advances the engine (no
// trade/ladder/window logic runs here), it only replaces the *configuration*
// the engine reads on its next cycle. Applying a new config always restarts
// the live ledger via freshPaperTraderState(), the same way store.resetStore()
// already does elsewhere in this codebase -- an in-place edit to `ladder`
// while mid-cycle at some stage index would leave stage/attempt/window
// counters pointing at stakes that no longer mean what they meant when they
// were recorded, so a clean restart on the new config is the only
// non-corrupting option.
// ---------------------------------------------------------------------------

function validateConfigBody(body) {
  const errors = [];
  const out = {};

  if (body.ladder !== undefined) {
    if (!Array.isArray(body.ladder) || body.ladder.length === 0) {
      errors.push('ladder must be a non-empty array of positive numbers');
    } else {
      const ladder = body.ladder.map(Number);
      if (ladder.some((n) => !Number.isFinite(n) || n <= 0)) {
        errors.push('ladder must contain only positive numbers');
      } else {
        out.ladder = ladder;
      }
    }
  }

  if (body.startingCapital !== undefined) {
    const startingCapital = Number(body.startingCapital);
    if (!Number.isFinite(startingCapital) || startingCapital <= 0) {
      errors.push('startingCapital must be a positive number');
    } else {
      out.startingCapital = startingCapital;
    }
  }

  if (body.payoutMultiplier !== undefined) {
    const payoutMultiplier = Number(body.payoutMultiplier);
    if (!Number.isFinite(payoutMultiplier) || payoutMultiplier <= 0) {
      errors.push('payoutMultiplier must be a positive number');
    } else {
      out.payoutMultiplier = payoutMultiplier;
    }
  }

  return { out, errors };
}

router.get('/v1/paper-trader', (req, res) => {
  const snapshot = getSnapshot();
  res.json(snapshot.paperTrader || null);
});

router.get('/v1/paper-trader/state', (req, res) => {
  const pt = getSnapshot().paperTrader || {};
  res.json({
    engine: 'PaperTrader',
    tradingState: pt.tradingState,
    signal: pt.signal,
    ladderLimitReached: pt.ladderLimitReached,
    updatedAt: pt.updatedAt
  });
});

router.get('/v1/paper-trader/current', (req, res) => {
  const pt = getSnapshot().paperTrader || {};
  res.json({
    engine: 'PaperTrader',
    cycle: pt.cycle,
    window: pt.window,
    capital: pt.capital,
    currentTrade: pt.currentTrade,
    lastReset: pt.lastReset,
    updatedAt: pt.updatedAt
  });
});

router.get('/v1/paper-trader/history', (req, res) => {
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const snapshot = getSnapshot();
  const trades = (store.paperTrader && store.paperTrader.trades) || [];
  res.json({
    engine: 'PaperTrader',
    totalTrades: trades.length,
    trades: trades.slice(0, limit),
    updatedAt: snapshot.paperTrader ? snapshot.paperTrader.updatedAt : null
  });
});

router.get('/v1/paper-trader/windows', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const pt = getSnapshot().paperTrader || {};
  const closedWindows = (store.paperTrader && store.paperTrader.windows) || [];
  res.json({
    engine: 'PaperTrader',
    currentWindow: pt.window,
    closedWindows: closedWindows.slice(0, limit)
  });
});

router.get('/v1/paper-trader/cycles', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const pt = getSnapshot().paperTrader || {};
  const closedCycles = (store.paperTrader && store.paperTrader.cycles) || [];
  res.json({
    engine: 'PaperTrader',
    currentCycle: pt.cycle,
    closedCycles: closedCycles.slice(0, limit)
  });
});

router.get('/v1/paper-trader/daily', (req, res) => {
  // No dedicated daily rollup in v2 (the ported engine reports overall +
  // per-stage + per-window + per-reset rollups, not calendar-day
  // buckets); kept as an endpoint for backward compatibility, empty.
  res.json({ engine: 'PaperTrader', days: [] });
});

router.get('/v1/paper-trader/performance', (req, res) => {
  const pt = getSnapshot().paperTrader || {};
  res.json({
    engine: 'PaperTrader',
    performance: pt.performance,
    updatedAt: pt.updatedAt
  });
});

router.get('/v1/paper-trader/resets', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const resets = (store.paperTrader && store.paperTrader.resets) || [];
  res.json({
    engine: 'PaperTrader',
    totalResets: resets.length,
    resets: resets.slice(0, limit)
  });
});

router.get('/v1/paper-trader/config', (req, res) => {
  const pt = getSnapshot().paperTrader || {};
  res.json({ engine: 'PaperTrader', config: pt.config || null });
});

router.post('/v1/paper-trader/config', (req, res) => {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const { out, errors } = validateConfigBody(body);

  if (errors.length) {
    return res.status(400).json({ error: 'invalid_config', details: errors });
  }
  if (Object.keys(out).length === 0) {
    return res.status(400).json({ error: 'invalid_config', details: ['no recognized fields (ladder, startingCapital, payoutMultiplier) were provided'] });
  }

  const currentConfig = (store.paperTrader && store.paperTrader.config) || {};
  const nextConfig = { ...currentConfig, ...out };

  store.paperTrader = freshPaperTraderState(nextConfig);

  // getSnapshot()/store.cachedSystemState (read by every GET route in this
  // file, including the one right below, plus GET /api/v1/snapshot) is only
  // refreshed inside runSupremeCouncil()'s own cycle -- without forcing one
  // here, the dashboard would keep showing the pre-save config/capital until
  // the next real draw comes in and triggers a cycle on its own.
  runSupremeCouncil();
  saveSnapshot(store);

  res.json({
    status: 'config_updated',
    note: 'Paper trader ledger (cycle, window, ladder position, capital, trade log) was restarted to apply the new configuration.',
    config: store.paperTrader.config,
    capital: store.paperTrader.capital
  });
});

module.exports = { router, getPaperTraderSnapshot: () => getSnapshot().paperTrader || null };
