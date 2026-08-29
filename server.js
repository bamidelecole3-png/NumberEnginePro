/**
 * 4-BALL TIMING INTELLIGENCE + 4SIL — Main Server Entry Point.
 *
 * Per the blueprint's non-negotiables (#1, #15-18, #24-26): this is a
 * brand-new entry point, but it mounts the SNIPER_V4 PRO v6.2 legacy
 * router UNCHANGED for ingestion, auth, and reset (src-legacy-core/src/
 * routes/api.js -- POST /api/v1/collector, its X-API-Key auth, and
 * POST /api/v1/reset all come from that file byte-for-byte, apart from
 * one renamed debug route -- see that file's own note above its
 * /legacy-snapshot handler). The new timing/CBI/call-history layer
 * (src/routes/timingApi.js) is mounted alongside it and owns every new
 * blueprint endpoint, including the canonical GET /api/v1/snapshot.
 */
'use strict';

const express = require('express');
const path = require('path');

const legacyApiRoutes = require('./src-legacy-core/src/routes/api');
const timingApiRoutes = require('./src/routes/timingApi');
const paperTraderApiRoutes = require('./src/routes/paperTraderApi');
const { store } = require('./src-legacy-core/src/core/store');
const { loadSnapshot, saveSnapshot } = require('./src-legacy-core/src/services/persistence');
const { runSupremeCouncil } = require('./src-legacy-core/src/supreme/council');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Root-level health alias (parity with the reference project's bare
// /health path); /api/health itself is served by timingApiRoutes below.
app.get('/health', (req, res) => {
  res.json({ status: 'HEALTHY', engine: '4-BALL TIMING INTELLIGENCE + 4SIL', version: require('./package.json').version });
});

// Mount the new timing layer FIRST so its canonical GET /api/v1/snapshot
// (the Hero Data Object) wins on that path; the legacy router's own
// snapshot route has been renamed to /api/v1/legacy-snapshot precisely so
// this ordering never needs to matter for any other route (collector,
// reset, history, etc. don't collide with anything in timingApi.js).
app.use('/api', timingApiRoutes);
app.use('/api', paperTraderApiRoutes.router);
app.use('/api', legacyApiRoutes);

loadSnapshot(store);
runSupremeCouncil();

// Autosave cadence matches the reference project's own interval.
setInterval(() => {
  saveSnapshot(store);
}, 30000);

app.listen(PORT, () => {
  console.log(`4-BALL TIMING INTELLIGENCE + 4SIL v${require('./package.json').version} running on port ${PORT}`);
  console.log('Legacy collector: POST /api/v1/collector (X-API-Key via GATEWAY_API_KEY env var)');
  console.log('New consolidated snapshot: GET /api/v1/snapshot');
});

module.exports = app;
