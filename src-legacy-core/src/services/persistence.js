/**
 * Snapshot Persistence module.
 * Clean path resolution using process.cwd() / DATA_DIR.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'state.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function saveSnapshot(store) {
  ensureDataDir();
  const state = {
    historicalDraws: store.historicalDraws.slice(0, 500),
    engineWeights: store.engineWeights,
    engineStats: store.engineStats,
    regimeEngineStats: store.regimeEngineStats,
    recommendationLog: store.recommendationLog,
    ingestStats: store.ingestStats,
    // BUGFIX: tieIntelligence and eventIntelligence were not saved, so both
    // reset to their constructor defaults on every server restart.
    // - tieIntelligence losing activeSeason / intervalStats / detected
    //   cycle history means the tie engine restarts its season detection
    //   from scratch each time and silently loses its whole "recent tie
    //   streak" context.
    // - eventIntelligence losing colorReturnModel / eventMemory /
    //   pendingFirstAppearance is worse: eventIntelligenceEngineCP.js's own
    //   header explicitly documents that its Event Memory and pending
    //   First Appearance state CAN'T be a pure recompute-from-history
    //   function -- this is exactly why it mutates store.eventIntelligence
    //   in place rather than returning a fresh object each call. Losing
    //   it on restart discards all accumulated event memory and breaks
    //   First Appearance resolution for any pending detection.
    tieIntelligence: store.tieIntelligence,
    eventIntelligence: store.eventIntelligence,
    // BUGFIX: tierForecastLog was not saved, so every server restart
    // silently discarded the Tier Engine's forecast-accuracy history --
    // /api/tier-engine-accuracy would reset to empty and
    // buildTierCalibrationData()'s empirical calibration blend would lose
    // all its scored samples, exactly the same loss-on-restart problem
    // already fixed above for tieIntelligence/eventIntelligence.
    tierForecastLog: store.tierForecastLog,
    // Tie Precursor Pattern Engine's own forecast-accuracy log -- same
    // reasoning as tierForecastLog directly above: without saving this,
    // the closed loop (recordTiePrecursorForecast/scoreTiePrecursorForecast/
    // buildTiePrecursorCalibrationData) would silently reset to empty on
    // every restart, losing all scored history the dashboard's Self-
    // Graded Accuracy block depends on.
    tiePrecursorForecastLog: store.tiePrecursorForecastLog,
    // 4SIL has a true cross-restart knowledge archive. The live 4SIL output
    // is recomputed from draws, while this memory preserves institutional
    // observations, transition history, season records and knowledge
    // snapshots beyond the rolling draw window.
    fourBallSILMemory: store.fourBallSILMemory,
    // 4-Ball Tie Cluster Engine's persistent Strong Tie log -- see
    // fourBallTieClusterEngine.js's header. Same reasoning as
    // fourBallSILMemory above: must survive restarts or a confirmed
    // cluster's confirming draw pair (and its vote's remaining lifetime)
    // would silently reset every time the process restarts.
    fourBallTieClusterMemory: store.fourBallTieClusterMemory,
    // 4SIL Upgrade Blueprint §21 -- unified per-event audit log. Must
    // survive restarts for the same reason fourBallTieClusterMemory does:
    // it's a historical trail, not a recompute-from-history value.
    fourSilUnifiedAuditLog: store.fourSilUnifiedAuditLog,
    // 3SIL's own, separate cross-restart knowledge archive -- see
    // threeBallSeasonIntelligenceLab.js's header and store.js's
    // threeBallSILMemory comment for why this is intentionally never
    // merged with fourBallSILMemory above.
    threeBallSILMemory: store.threeBallSILMemory,
    // Entry Condition Scorecard's observation log -- see
    // entryConditionScorecard.js's header for why this can't be a pure
    // recompute-from-history function (a draw record carries no memory of
    // which 4SIL gate conditions were true, or whether ENTER was open, at
    // the moment that draw happened). BUGFIX: this was never saved
    // before, so every server restart silently discarded the scorecard's
    // entire condition-grading history back to zero.
    entryTimingLog: store.entryTimingLog,
    // Entry Hit Counter's running totals + pending watches -- see
    // entryHitCounter.js's header for why this can't be a pure
    // recompute-from-history function either. Without saving this, every
    // server restart would silently drop all ENTER-call hit/miss counts
    // back to zero (replaces the old entryAccuracyLadder field).
    entryHitCounter: store.entryHitCounter,
    // 4SIL Paper Trader Engine's full ledger (see
    // src-legacy-core/src/engines/paperTraderEngine.js). Must survive
    // restarts: lastProcessedDrawId, the open cycle/window, capital, and
    // every closed trade/window/cycle/reset are historical facts, not
    // values that can be recomputed from historicalDraws once the
    // underlying draw ages out of the rolling window.
    paperTrader: store.paperTrader,
    // 3-Ball Entry Hit Counter -- 3SIL's own ENTER-call scoring log, same
    // reasoning as entryHitCounter above. See
    // threeBallEntryHitCounter.js's header. RETIRED as 3SIL's badge
    // scoring mechanism (see store.js's comment on this field) but still
    // saved/restored so any already-accumulated history isn't silently
    // dropped from existing snapshots.
    threeBallEntryHitCounter: store.threeBallEntryHitCounter,
    // 3-Ball Next Event Hit Counter -- scores the Next Event
    // Leaderboard's topColor continuously. Same reasoning as
    // threeBallEntryHitCounter above for why this can't be a pure
    // recompute-from-history function. See
    // threeBallNextEventHitCounter.js's header.
    threeBallNextEventHitCounter: store.threeBallNextEventHitCounter
  };

  const tempFile = `${SNAPSHOT_FILE}.tmp`;
  try {
    fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tempFile, SNAPSHOT_FILE);
  } catch (err) {
    console.error('Snapshot save error:', err);
  }
}

function loadSnapshot(store) {
  ensureDataDir();
  if (!fs.existsSync(SNAPSHOT_FILE)) return false;

  try {
    const raw = fs.readFileSync(SNAPSHOT_FILE, 'utf8');
    const data = JSON.parse(raw);

    if (Array.isArray(data.historicalDraws)) store.historicalDraws = data.historicalDraws;
    if (data.engineWeights) store.engineWeights = data.engineWeights;
    if (data.engineStats) store.engineStats = data.engineStats;
    if (data.regimeEngineStats) store.regimeEngineStats = data.regimeEngineStats;
    if (Array.isArray(data.recommendationLog)) store.recommendationLog = data.recommendationLog;
    if (data.ingestStats) store.ingestStats = data.ingestStats;
    // Restore stateful intelligence that can't be recomputed from draws alone.
    if (data.tieIntelligence) store.tieIntelligence = data.tieIntelligence;
    if (data.eventIntelligence) store.eventIntelligence = data.eventIntelligence;
    if (Array.isArray(data.tierForecastLog)) store.tierForecastLog = data.tierForecastLog;
    if (Array.isArray(data.tiePrecursorForecastLog)) store.tiePrecursorForecastLog = data.tiePrecursorForecastLog;

    // Backward-compatible restore for the 4SIL institutional archive.
    // Older snapshots simply have no field and retain the store's defaults.
    if (data.fourBallSILMemory && typeof data.fourBallSILMemory === 'object') {
      const m = data.fourBallSILMemory;
      store.fourBallSILMemory = {
        schemaVersion: Number(m.schemaVersion) || 1,
        lastProcessedDrawId: m.lastProcessedDrawId ?? null,
        observations: Array.isArray(m.observations) ? m.observations : [],
        transitionArchive: Array.isArray(m.transitionArchive) ? m.transitionArchive : [],
        knowledgeSnapshots: Array.isArray(m.knowledgeSnapshots) ? m.knowledgeSnapshots : [],
        seasonRecords: Array.isArray(m.seasonRecords) ? m.seasonRecords : [],
        currentState: m.currentState && typeof m.currentState === 'object' ? m.currentState : null,
        updatedAt: m.updatedAt || null
      };
    }

    // Backward-compatible restore for the 4-Ball Tie Cluster Engine's
    // Strong Tie log. Older snapshots simply have no field and retain the
    // store's defaults -- an empty log means the engine starts fresh from
    // this point forward (no vote can be reconstructed from missing
    // history, so it correctly requires two NEW Strong Ties rather than
    // guessing at pre-upgrade state).
    if (data.fourBallTieClusterMemory && typeof data.fourBallTieClusterMemory === 'object') {
      const t = data.fourBallTieClusterMemory;
      store.fourBallTieClusterMemory = {
        schemaVersion: Number(t.schemaVersion) || 1,
        lastProcessedDrawId: t.lastProcessedDrawId ?? null,
        strongTieLog: Array.isArray(t.strongTieLog) ? t.strongTieLog : [],
        activeCluster: t.activeCluster && typeof t.activeCluster === 'object' ? t.activeCluster : null,
        updatedAt: t.updatedAt || null
      };
    }

    // Backward-compatible restore for the §21 unified audit log. Older
    // snapshots simply have no field and retain the store's defaults --
    // an empty log means the trail starts fresh from this point forward,
    // same reasoning as fourBallTieClusterMemory's restore just above.
    if (data.fourSilUnifiedAuditLog && typeof data.fourSilUnifiedAuditLog === 'object') {
      const u = data.fourSilUnifiedAuditLog;
      store.fourSilUnifiedAuditLog = {
        schemaVersion: Number(u.schemaVersion) || 1,
        lastProcessedDrawId: u.lastProcessedDrawId ?? null,
        entries: Array.isArray(u.entries) ? u.entries : [],
        updatedAt: u.updatedAt || null
      };
    }

    // Backward-compatible restore for 3SIL's own, separate institutional
    // archive. Same defensive field-by-field merge as fourBallSILMemory
    // above, since threeBallSeasonIntelligenceLab.js mutates
    // observations/transitionArchive/knowledgeSnapshots in place and
    // expects each to already be an array -- a missing or malformed field
    // here would otherwise surface as a confusing crash deep inside
    // persistThreeSILObservation() instead of a clear fallback right here.
    // No seasonRecords/currentState fields (unlike 4SIL) since 3SIL
    // doesn't use them -- see store.js's threeBallSILMemory comment.
    if (data.threeBallSILMemory && typeof data.threeBallSILMemory === 'object') {
      const m = data.threeBallSILMemory;
      store.threeBallSILMemory = {
        schemaVersion: Number(m.schemaVersion) || 1,
        lastProcessedDrawId: m.lastProcessedDrawId ?? null,
        observations: Array.isArray(m.observations) ? m.observations : [],
        transitionArchive: Array.isArray(m.transitionArchive) ? m.transitionArchive : [],
        knowledgeSnapshots: Array.isArray(m.knowledgeSnapshots) ? m.knowledgeSnapshots : [],
        updatedAt: m.updatedAt || null
      };
    }

    // Backward-compatible restore for the Entry Condition Scorecard's
    // observation log. Older snapshots simply have no field and retain
    // the store's defaults (BUGFIX -- see saveSnapshot's comment above).
    if (data.entryTimingLog && typeof data.entryTimingLog === 'object') {
      const t = data.entryTimingLog;
      store.entryTimingLog = {
        schemaVersion: Number(t.schemaVersion) || 1,
        lastProcessedDrawId: t.lastProcessedDrawId ?? null,
        pendingGate: t.pendingGate && typeof t.pendingGate === 'object' ? t.pendingGate : null,
        observations: Array.isArray(t.observations) ? t.observations : [],
        updatedAt: t.updatedAt || null
      };
    }

    // Backward-compatible restore for the Entry Hit Counter. Older
    // snapshots simply have no field and retain the store's defaults.
    if (data.entryHitCounter && typeof data.entryHitCounter === 'object') {
      const c = data.entryHitCounter;
      const restorePick = p => ({
        hits: Number(p && p.hits) || 0,
        misses: Number(p && p.misses) || 0,
        pending: p && p.pending && typeof p.pending === 'object' ? p.pending : null
      });
      store.entryHitCounter = {
        schemaVersion: Number(c.schemaVersion) || 1,
        lastProcessedDrawId: c.lastProcessedDrawId ?? null,
        totalEnterCalls: Number(c.totalEnterCalls) || 0,
        firstPick: restorePick(c.firstPick),
        secondPick: restorePick(c.secondPick),
        updatedAt: c.updatedAt || null
      };
    }

    // Backward-compatible restore for the 4SIL Paper Trader Engine.
    // Older snapshots have no field and retain the store's fresh
    // defaults (freshPaperTraderState(), set in the store constructor).
    // ensureStateShape() fills in any missing sub-fields defensively,
    // same convention as every other engine's restore here.
    if (data.paperTrader && typeof data.paperTrader === 'object') {
      const { ensureStateShape } = require('../engines/paperTraderEngine');
      store.paperTrader = ensureStateShape(data.paperTrader);
    }

    // Backward-compatible restore for the 3-Ball Entry Hit Counter.
    // Older snapshots simply have no field and retain the store's
    // defaults. Same restorePick shape as entryHitCounter above, just a
    // single challengerPick slot instead of firstPick/secondPick.
    // RETIRED as 3SIL's badge scoring mechanism -- restored for
    // continuity of any already-accumulated history, not read by
    // council.js's threeSIL wiring anymore.
    if (data.threeBallEntryHitCounter && typeof data.threeBallEntryHitCounter === 'object') {
      const c = data.threeBallEntryHitCounter;
      const restorePick = p => ({
        hits: Number(p && p.hits) || 0,
        misses: Number(p && p.misses) || 0,
        pending: p && p.pending && typeof p.pending === 'object' ? p.pending : null
      });
      store.threeBallEntryHitCounter = {
        schemaVersion: Number(c.schemaVersion) || 1,
        lastProcessedDrawId: c.lastProcessedDrawId ?? null,
        totalEnterCalls: Number(c.totalEnterCalls) || 0,
        challengerPick: restorePick(c.challengerPick),
        updatedAt: c.updatedAt || null
      };
    }

    // Backward-compatible restore for the 3-Ball Next Event Hit Counter.
    // Older snapshots simply have no field and retain the store's
    // defaults. Same restorePick shape as threeBallEntryHitCounter
    // above, just a topColorPick slot instead of challengerPick.
    //
    // rankWatch (added in schemaVersion:2 -- see threeBallNextEventHitCounter.js's
    // header, "FIX 1") is restored the same defensive way: a
    // schemaVersion:1 snapshot saved before this change simply won't
    // have c.rankWatch, so it falls through to a fresh { pending: null,
    // byRank: {} } exactly like a brand-new counter would -- no crash,
    // no data loss for topColorPick's already-accumulated history, the
    // rank-level breakdown just starts counting from zero going forward.
    if (data.threeBallNextEventHitCounter && typeof data.threeBallNextEventHitCounter === 'object') {
      const c = data.threeBallNextEventHitCounter;
      const restorePick = p => ({
        hits: Number(p && p.hits) || 0,
        misses: Number(p && p.misses) || 0,
        pending: p && p.pending && typeof p.pending === 'object' ? p.pending : null
      });
      const restoreRankWatch = rw => {
        if (!rw || typeof rw !== 'object') return { pending: null, byRank: {} };
        const byRank = {};
        if (rw.byRank && typeof rw.byRank === 'object') {
          for (const rank of Object.keys(rw.byRank)) {
            const cell = rw.byRank[rank];
            byRank[rank] = {
              hits: Number(cell && cell.hits) || 0,
              misses: Number(cell && cell.misses) || 0
            };
          }
        }
        return {
          pending: rw.pending && typeof rw.pending === 'object' ? rw.pending : null,
          byRank
        };
      };
      store.threeBallNextEventHitCounter = {
        schemaVersion: Number(c.schemaVersion) || 1,
        lastProcessedDrawId: c.lastProcessedDrawId ?? null,
        totalCalls: Number(c.totalCalls) || 0,
        topColorPick: restorePick(c.topColorPick),
        rankWatch: restoreRankWatch(c.rankWatch),
        updatedAt: c.updatedAt || null
      };
    }
    return true;
  } catch (err) {
    console.error('Snapshot load error:', err);
    return false;
  }
}

module.exports = {
  saveSnapshot,
  loadSnapshot
};
