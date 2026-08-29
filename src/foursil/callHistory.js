/**
 * CALL HISTORY + EVALUATION LAB — new engine (blueprint §28-31).
 *
 * Every 4SIL-timed decision becomes an immutable call record. Calls are
 * opened when 4SIL confirms enterNow (never invented here -- see
 * non-negotiable #26), and resolved by watching real, already-ingested
 * draws for a 4-ball event of ANY color inside the recorded window
 * (blueprint §3/§7: the engine doesn't care which color; the trade
 * target is a 4-ball event, period).
 *
 * Persistence: plain JSON snapshot under data/calls + data/evaluations,
 * following this codebase's existing persistence convention
 * (src-legacy-core/src/services/persistence.js).
 */
'use strict';

function freshState() {
  return {
    schemaVersion: 1,
    calls: [],          // immutable once resolved
    nextId: 1,
    lastSeasonActive: false,
    updatedAt: null
  };
}

const SEASON_STAGES = ['Early', 'Growth', 'Active', 'Peak', 'Decay'];

// TP entry-log stages (fixes the old "silent PENDING carried into the next
// window" behavior). Each stage is its own scored window: as soon as a
// stage's own draw range has fully elapsed with no qualifying event inside
// it, that stage is written as MISS immediately -- it is never left
// hanging until a later window produces a hit.
const TP_STAGES = [
  { name: 'TP1', window: [1, 3] },
  { name: 'TP2', window: [4, 7] },
  { name: 'TP3', window: [8, 11] }
];

function freshTpStages() {
  return TP_STAGES.map(s => ({
    name: s.name,
    window: s.window,
    status: 'PENDING',   // PENDING -> HIT | MISS | N/A
    drawsToHit: null,
    resolvedDrawId: null
  }));
}

/**
 * Scores each TP stage independently against the draws observed so far
 * this cycle. Mutates call.tpStages in place. `hitDraw` info (drawsToHit,
 * drawId) is the same single qualifying event the overall call resolution
 * already found -- this function only decides which stage(s) it belongs
 * to and which stages have simply run out of road with nothing landing.
 */
function scoreTpStages(call, drawsElapsed, hitInfo) {
  if (!Array.isArray(call.tpStages) || call.tpStages.length === 0) {
    call.tpStages = freshTpStages();
  }
  call.tpStages.forEach(stage => {
    if (stage.status !== 'PENDING') return; // immutable once resolved

    if (hitInfo && hitInfo.drawsToHit >= stage.window[0] && hitInfo.drawsToHit <= stage.window[1]) {
      stage.status = 'HIT';
      stage.drawsToHit = hitInfo.drawsToHit;
      stage.resolvedDrawId = hitInfo.drawId;
      return;
    }

    // No qualifying event landed inside this stage's own window, and that
    // window has now fully elapsed -- write MISS now, not "pending".
    if (drawsElapsed >= stage.window[1]) {
      if (hitInfo && hitInfo.drawsToHit > stage.window[1]) {
        // The event exists but landed in a later stage -- this stage is a
        // clean, real MISS on its own terms.
        stage.status = 'MISS';
        stage.resolvedDrawId = hitInfo.drawId;
      } else if (!hitInfo) {
        stage.status = 'MISS';
      }
    }
  });
}

/**
 * Once the call itself is fully resolved (HIT / EXPIRED / EXIT), any TP
 * stage still sitting at PENDING is closed out so nothing is left
 * dangling in the log:
 *  - overall HIT landed inside an earlier stage  -> later stages: N/A (never reached)
 *  - overall EXPIRED (11-draw window ran out)    -> any leftover stage: MISS
 *  - overall EXIT (season closed under the call)  -> any leftover stage: N/A (market closed, not a miss)
 */
function closeOutTpStages(call, finalStatus) {
  if (!Array.isArray(call.tpStages)) return;
  call.tpStages.forEach(stage => {
    if (stage.status !== 'PENDING') return;
    if (finalStatus === 'EXPIRED') stage.status = 'MISS';
    else stage.status = 'N/A';
  });
}

function seasonStageFor(seasonAge) {
  if (seasonAge == null) return 'Early';
  if (seasonAge < 10) return 'Early';
  if (seasonAge < 20) return 'Growth';
  if (seasonAge < 30) return 'Active';
  if (seasonAge < 40) return 'Peak';
  return 'Decay';
}

function gateComboLabel(gateMatrix) {
  const confirmed = (gateMatrix.gates || []).filter(g => g.status === 'CONFIRMED').map(g => g.id);
  return confirmed.length > 0 ? confirmed.join(' + ') : 'NONE';
}

/**
 * Advances call-history state for the current cycle. Must be called
 * once per snapshot cycle, after 4SIL and the timing/gate engines have
 * already run for that cycle.
 *
 * @param {object} state          persisted call-history state (mutated in place)
 * @param {object} fourSIL        ported 4SIL result for this cycle
 * @param {object} heroData       this cycle's Hero Data Object (timingEngine.buildHeroData)
 * @param {object} gateMatrix     this cycle's gate matrix (timingEngine.buildGateMatrix)
 * @param {Array}  historicalDraws newest-first draw history
 */
function advanceCallHistory(state, fourSIL, heroData, gateMatrix, historicalDraws) {
  const draws = historicalDraws || [];
  const latestDrawId = draws.length > 0 ? draws[0].drawId : null;
  const active = !!(fourSIL && fourSIL.active);

  const openCall = state.calls.find(c => c.status === 'PENDING');

  // Resolve an already-open call against real draws that have landed
  // since it opened.
  let eventConfirmedThisCycle = false;
  if (openCall) {
    const drawsSince = draws.findIndex(d => String(d.drawId) === String(openCall.openedDrawId));
    // drawsSince === -1 means the opening draw fell outside the window
    // we still hold; treat conservatively as 0 new draws observed.
    const newDraws = drawsSince > 0 ? draws.slice(0, drawsSince) : [];
    const drawsElapsed = drawsSince > 0 ? drawsSince : 0;
    openCall.drawsSinceOpen = drawsElapsed;

    const hitDraw = [...newDraws].reverse().find(d => !!d.fourBallColor); // oldest-first scan for first event
    const hitIndexFromOpen = hitDraw ? newDraws.findIndex(d => d.drawId === hitDraw.drawId) : -1;
    const drawsToHit = hitDraw ? newDraws.length - hitIndexFromOpen : null; // 1-based distance from open
    const hitInfo = hitDraw ? { drawsToHit, drawId: hitDraw.drawId } : null;

    // Score TP1/TP2/TP3 independently every cycle, regardless of whether
    // the overall call has resolved yet -- a stage MISSes the moment its
    // own draw range elapses, it never waits on a later stage's outcome.
    scoreTpStages(openCall, drawsElapsed, hitInfo);

    if (hitDraw) {
      const inCore = drawsToHit >= openCall.coreWindow[0] && drawsToHit <= openCall.coreWindow[1];
      const inSafety = drawsToHit >= openCall.safetyWindow[0] && drawsToHit <= openCall.safetyWindow[1];
      openCall.status = 'HIT';
      openCall.result = 'HIT';
      openCall.resolvedDrawId = hitDraw.drawId;
      openCall.resolvedAt = new Date().toISOString();
      openCall.drawsToHit = drawsToHit;
      openCall.hitColor = hitDraw.fourBallColor;
      openCall.coreWindowHit = inCore;
      openCall.safetyWindowHit = inSafety;
      eventConfirmedThisCycle = true;
      closeOutTpStages(openCall, 'HIT');
    } else if (drawsElapsed > (openCall.tradeWindow ? openCall.tradeWindow[1] : 11)) {
      openCall.status = 'EXPIRED';
      openCall.result = 'MISS';
      openCall.resolvedDrawId = latestDrawId;
      openCall.resolvedAt = new Date().toISOString();
      closeOutTpStages(openCall, 'EXPIRED');
    } else if (!active) {
      // Season closed while the call was still open -- an exit call, not
      // a miss (the market itself ended the opportunity).
      openCall.status = 'EXIT';
      openCall.result = 'CLOSED';
      openCall.resolvedDrawId = latestDrawId;
      openCall.resolvedAt = new Date().toISOString();
      closeOutTpStages(openCall, 'EXIT');
    }
  }

  // Open a new call the moment 4SIL genuinely confirms ENTER and there is
  // no call already open (non-negotiable #26 -- one live call at a time,
  // never stacked).
  const stillNoOpenCall = !state.calls.some(c => c.status === 'PENDING');
  if (active && fourSIL.enterNow && fourSIL.enterNow.enterNow && stillNoOpenCall && latestDrawId != null) {
    state.calls.unshift({
      id: state.nextId++,
      openedDrawId: latestDrawId,
      openedAt: new Date().toISOString(),
      state: 'ENTER',
      tp: heroData.tp,
      coreWindow: heroData.coreWindow,
      safetyWindow: heroData.safetyWindow,
      tpWindow: heroData.tpWindow || heroData.coreWindow,
      tradeWindow: heroData.tradeWindow || [1, 11],
      confidenceAtOpen: heroData.confidence,
      gateConfirmations: heroData.gateConfirmations,
      gateRequired: heroData.gateRequired,
      gateCombo: gateComboLabel(gateMatrix),
      seasonStageAtOpen: seasonStageFor(fourSIL.seasonAge),
      drawsSinceOpen: 0,
      status: 'PENDING',
      result: 'PENDING',
      tpStages: freshTpStages()
    });
  }

  state.lastSeasonActive = active;
  state.updatedAt = new Date().toISOString();

  // cap history to keep persistence bounded
  if (state.calls.length > 1000) state.calls.length = 1000;

  const currentOpen = state.calls.find(c => c.status === 'PENDING');
  return {
    openCall: currentOpen ? { ...currentOpen, eventConfirmedThisCycle } : null
  };
}

function buildCallHistoryView(state, limit) {
  return state.calls.slice(0, limit || 100).map(c => ({
    time: c.openedAt,
    draw: c.openedDrawId,
    state: c.state,
    tp: c.tp,
    window: `${c.coreWindow[0]}\u2013${c.coreWindow[1]}`,
    confidence: c.confidenceAtOpen,
    result: c.status === 'PENDING' ? 'Pending' : (c.status === 'HIT' ? 'HIT' : (c.status === 'EXIT' ? 'Correct' : 'MISS')),
    // Per-TP entry log: each stage reports its own HIT/MISS/N/A/PENDING --
    // never a stale "pending" once its own window has elapsed.
    tpStages: (c.tpStages || []).map(s => ({
      name: s.name,
      window: `${s.window[0]}\u2013${s.window[1]}`,
      status: s.status,
      drawsToHit: s.drawsToHit
    }))
  }));
}

function buildEvaluationLab(state) {
  const resolved = state.calls.filter(c => c.status !== 'PENDING');
  const hits = resolved.filter(c => c.status === 'HIT');
  const misses = resolved.filter(c => c.status === 'EXPIRED');
  const exits = resolved.filter(c => c.status === 'EXIT');
  const coreHits = hits.filter(c => c.coreWindowHit);
  const safetyHits = hits.filter(c => c.safetyWindowHit);

  const pct = (num, den) => (den > 0 ? Math.round((num / den) * 100) : 0);

  const totals = {
    totalCalls: state.calls.length,
    enterAccuracyPct: pct(hits.length, resolved.length),
    tpAccuracyPct: pct(coreHits.length, hits.length),
    tenDrawHitRatePct: pct(hits.length, hits.length + misses.length),
    coreWindowHitRatePct: pct(coreHits.length, hits.length),
    safetyWindowHitRatePct: pct(safetyHits.length, hits.length),
    exitAccuracyPct: pct(exits.length, resolved.length) || (resolved.length > 0 ? 100 - pct(misses.length, resolved.length) : 0),
    falseEntryRatePct: pct(misses.length, resolved.length),
    avgDrawsToHit: hits.length > 0
      ? Math.round((hits.reduce((sum, c) => sum + (c.drawsToHit || 0), 0) / hits.length) * 10) / 10
      : null
  };

  // Evaluation by season stage (blueprint §30)
  const bySeasonStage = SEASON_STAGES.map(stage => {
    const calls = resolved.filter(c => c.seasonStageAtOpen === stage);
    const stageHits = calls.filter(c => c.status === 'HIT');
    return {
      stage,
      calls: calls.length,
      hitRatePct: pct(stageHits.length, calls.length),
      avgDrawsToHit: stageHits.length > 0
        ? Math.round((stageHits.reduce((s, c) => s + (c.drawsToHit || 0), 0) / stageHits.length) * 10) / 10
        : null
    };
  }).filter(row => row.calls > 0);

  // Evaluation by gate combination (blueprint §31) -- analytical only,
  // never fed back into gate weights (non-negotiable #27).
  const comboMap = new Map();
  resolved.forEach(c => {
    const key = c.gateCombo || 'NONE';
    if (!comboMap.has(key)) comboMap.set(key, { combo: key, calls: 0, hits: 0 });
    const row = comboMap.get(key);
    row.calls++;
    if (c.status === 'HIT') row.hits++;
  });
  const byGateProfile = Array.from(comboMap.values())
    .map(row => ({ combo: row.combo, calls: row.calls, hitRatePct: pct(row.hits, row.calls) }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 20);

  // Per-TP scoreboard (TP1 1-3 / TP2 4-9 / TP3 9-11): counted only from
  // calls whose stage record has actually resolved (HIT or MISS) -- N/A
  // (never reached because an earlier stage already hit) and any
  // still-PENDING stage are excluded from the rate, not folded into MISS.
  const byTpStage = TP_STAGES.map(def => {
    let hitCount = 0;
    let missCount = 0;
    resolved.forEach(c => {
      const stage = (c.tpStages || []).find(s => s.name === def.name);
      if (!stage) return;
      if (stage.status === 'HIT') hitCount++;
      else if (stage.status === 'MISS') missCount++;
    });
    const decided = hitCount + missCount;
    return {
      name: def.name,
      window: `${def.window[0]}\u2013${def.window[1]}`,
      hits: hitCount,
      misses: missCount,
      hitRatePct: pct(hitCount, decided)
    };
  });

  return { totals, bySeasonStage, byGateProfile, byTpStage };
}

module.exports = { freshState, advanceCallHistory, buildCallHistoryView, buildEvaluationLab, TP_STAGES };
