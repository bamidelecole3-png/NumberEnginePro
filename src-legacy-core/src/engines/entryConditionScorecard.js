/**
 * Entry Condition Scorecard Engine.
 *
 * Part of the Entry Accuracy System (see fourBallSeasonIntelligenceLab.js's
 * evaluateEnterNow()). 4SIL's ENTER NOW gate is built from ~10 independent
 * conditions (A-J), each with a fixed, hand-picked weight (20-30) chosen
 * at design time. Those weights have never been checked against what
 * actually happened after they fired.
 *
 * This engine closes that loop: it maintains its OWN persistent, per-draw
 * observation log (previously owned by entryTimingIntervalEngine.js --
 * that engine has since been rewritten into a pure, ungated recompute
 * with no logging of its own, so this responsibility now lives here,
 * fully decoupled from it). Each cycle, recordConditionObservation()
 * logs which of 4SIL's gate conditions were true going into the draw
 * that just landed, and whether that draw's real outcome matched the
 * color 4SIL's gate was tracking at the time. buildEntryConditionScorecard()
 * then reads that log and computes, per condition ID:
 *
 *   - timesConfirmed:     how many logged draws had this condition true
 *   - hitRate:            of those, what fraction were followed by an
 *                         actual hit within HIT_HORIZON_DRAWS
 *   - avgDrawsToHit:      average spacing (in draws) to that hit, when it
 *                         happened
 *   - evidenceWeight:     0-1 confidence in this condition's own score,
 *                         based on sample size (few confirmations = low
 *                         trust regardless of the observed hit rate)
 *   - empiricalWeight:    a suggested REPLACEMENT for the condition's
 *                         fixed design-time weight (20-30), derived from
 *                         hitRate * evidenceWeight, rescaled onto the same
 *                         0-30 range so it can be compared directly
 *                         against fourBallSeasonIntelligenceLab.js's
 *                         hardcoded constants
 *
 * This module NEVER mutates fourBallSeasonIntelligenceLab.js's live
 * weights itself -- see entryAccuracyEngine.js for how empiricalWeight
 * actually gets folded back into gating decisions. This module only
 * grades; it doesn't decide.
 */

const HIT_HORIZON_DRAWS = 5;     // "did a hit land within N draws of this condition being true?"
const MIN_SAMPLES_FOR_TRUST = 8; // below this, evidenceWeight stays low regardless of hitRate
const DESIGN_WEIGHT_SCALE = 30;  // matches evaluateEnterNow()'s max individual condition weight
const MAX_LOG_ENTRIES = 300;

/**
 * Appends one observation to the log for the LATEST draw, if it hasn't
 * already been logged (dedup by drawId).
 *
 * Each observation records, for THIS draw:
 *   - whether 4SIL's ENTER gate was open going into it (from the PRIOR
 *     cycle's state -- i.e. "was ENTER active before this draw landed",
 *     the only causally sound reading; we can't grade against this
 *     draw's own just-recomputed 4SIL state, since that's computed FROM
 *     draws including this one)
 *   - the color that was being tracked going into this draw (same
 *     prior-cycle-state reasoning)
 *   - whether this draw's real outcome (fourBallColor) matched that
 *     tracked color
 *   - which of 4SIL's A-J conditions were true at that moment
 *
 * "Going into it" is captured by log.pendingGate -- set at the END of
 * this function from the CURRENT cycle's fresh 4SIL state, to be read
 * back in on the NEXT call once a new draw has actually landed.
 */
function recordConditionObservation(log, latestDraw, currentGateOpen, currentColor, currentGateDetail) {
  if (!latestDraw || latestDraw.drawId == null) return;

  const drawId = String(latestDraw.drawId);
  const alreadyLogged = log.lastProcessedDrawId != null && String(log.lastProcessedDrawId) === drawId;

  if (!alreadyLogged) {
    const pending = log.pendingGate;
    if (pending) {
      const actualColor = latestDraw.fourBallColor || null;
      log.observations.unshift({
        drawId,
        timestamp: new Date().toISOString(),
        gateOpen: pending.gateOpen,
        predictedColor: pending.color,
        actualColor,
        hit: pending.gateOpen && pending.color != null && actualColor === pending.color,
        gateConditions: pending.gateConditions || null
      });
      if (log.observations.length > MAX_LOG_ENTRIES) log.observations.pop();
    }
    log.lastProcessedDrawId = drawId;
  }

  // Always refresh the pending gate to the CURRENT cycle's state, so the
  // next NEW draw (whenever it arrives) gets graded against what's
  // believed right now.
  log.pendingGate = {
    gateOpen: Boolean(currentGateOpen),
    color: currentColor || null,
    gateConditions: Array.isArray(currentGateDetail) ? currentGateDetail.map(c => ({ id: c.id, met: c.met, weight: c.weight })) : null
  };
  log.updatedAt = new Date().toISOString();
}

/**
 * Walks the observation log chronologically and, for every draw where a
 * given condition was confirmed true, checks whether a hit landed on
 * that same draw or within the next HIT_HORIZON_DRAWS draws.
 *
 * observations are stored newest-first -- reversed here to walk
 * oldest-to-newest so "look forward N draws" means forward in real time.
 */
function scoreCondition(chronologicalObs, conditionId) {
  const n = chronologicalObs.length;
  let timesConfirmed = 0;
  let hits = 0;
  const gapsToHit = [];

  for (let i = 0; i < n; i++) {
    const obs = chronologicalObs[i];
    if (!Array.isArray(obs.gateConditions)) continue; // older log entries with no per-condition data
    const cond = obs.gateConditions.find(c => c.id === conditionId);
    if (!cond || !cond.met) continue;

    timesConfirmed++;

    // Look forward from this draw (inclusive) up to HIT_HORIZON_DRAWS for
    // a hit -- whichever comes first.
    let foundGap = null;
    for (let g = 0; g <= HIT_HORIZON_DRAWS && i + g < n; g++) {
      if (chronologicalObs[i + g].hit) { foundGap = g; break; }
    }
    if (foundGap != null) {
      hits++;
      gapsToHit.push(foundGap);
    }
  }

  const hitRate = timesConfirmed > 0 ? Math.round((hits / timesConfirmed) * 100) / 100 : null;
  const avgDrawsToHit = gapsToHit.length > 0
    ? Math.round((gapsToHit.reduce((a, b) => a + b, 0) / gapsToHit.length) * 10) / 10
    : null;

  // Evidence weight: ramps from 0 to 1 as timesConfirmed approaches
  // MIN_SAMPLES_FOR_TRUST, capping at 1 -- a condition seen twice can't
  // earn full trust no matter how clean its hit rate looks.
  const evidenceWeight = Math.min(1, timesConfirmed / MIN_SAMPLES_FOR_TRUST);

  // Empirical weight: hitRate scaled onto the same 0-30 range as the
  // design-time weights, discounted by evidenceWeight so low-sample
  // conditions can't swing the gate on a lucky streak of 2-3 hits.
  const empiricalWeight = hitRate != null
    ? Math.round(hitRate * DESIGN_WEIGHT_SCALE * evidenceWeight * 10) / 10
    : null;

  return {
    conditionId,
    timesConfirmed,
    hits,
    hitRate,
    avgDrawsToHit,
    evidenceWeight: Math.round(evidenceWeight * 100) / 100,
    empiricalWeight
  };
}

/**
 * Builds the full scorecard across every condition ID seen in the log,
 * plus a comparison against each condition's current design-time weight
 * (passed in from the live 4SIL evaluation so this stays in sync with
 * fourBallSeasonIntelligenceLab.js without hardcoding weight values here
 * too).
 */
function buildEntryConditionScorecard(entryTimingLog, currentConditionDefs) {
  const observations = entryTimingLog && Array.isArray(entryTimingLog.observations)
    ? entryTimingLog.observations : [];
  const chronological = observations.slice().reverse(); // oldest first

  // Collect every condition ID that has ever appeared in the log, plus
  // any currently-defined condition (so a condition that's never fired
  // yet still shows up with zero samples rather than being invisible).
  const idSet = new Set();
  chronological.forEach(o => {
    if (Array.isArray(o.gateConditions)) o.gateConditions.forEach(c => idSet.add(c.id));
  });
  if (Array.isArray(currentConditionDefs)) currentConditionDefs.forEach(c => idSet.add(c.id));

  const designWeightById = {};
  if (Array.isArray(currentConditionDefs)) {
    currentConditionDefs.forEach(c => { designWeightById[c.id] = c.weight; });
  }

  const scorecard = [...idSet].map(id => {
    const scored = scoreCondition(chronological, id);
    const designWeight = designWeightById[id] != null ? designWeightById[id] : null;
    let verdict = 'INSUFFICIENT_DATA';
    if (scored.timesConfirmed >= MIN_SAMPLES_FOR_TRUST && scored.hitRate != null) {
      if (scored.hitRate >= 0.65) verdict = 'STRONG';
      else if (scored.hitRate >= 0.40) verdict = 'MODERATE';
      else verdict = 'WEAK';
    } else if (scored.timesConfirmed > 0) {
      verdict = 'BUILDING_EVIDENCE';
    }
    return { ...scored, designWeight, verdict };
  }).sort((a, b) => (b.empiricalWeight || 0) - (a.empiricalWeight || 0));

  const totalObservationsWithConditionData = chronological.filter(o => Array.isArray(o.gateConditions)).length;

  return {
    engine: 'EntryConditionScorecard',
    hitHorizonDraws: HIT_HORIZON_DRAWS,
    minSamplesForTrust: MIN_SAMPLES_FOR_TRUST,
    totalObservationsWithConditionData,
    conditions: scorecard,
    reasoning: totalObservationsWithConditionData < MIN_SAMPLES_FOR_TRUST
      ? `Only ${totalObservationsWithConditionData} observation(s) carry per-condition data so far -- scorecard verdicts remain provisional until at least ${MIN_SAMPLES_FOR_TRUST} samples accumulate per condition.`
      : `${totalObservationsWithConditionData} observations with per-condition data. ${scorecard.filter(c => c.verdict === 'STRONG').length} condition(s) graded STRONG, ${scorecard.filter(c => c.verdict === 'WEAK').length} graded WEAK against their design-time weight.`
  };
}

module.exports = {
  HIT_HORIZON_DRAWS,
  MIN_SAMPLES_FOR_TRUST,
  DESIGN_WEIGHT_SCALE,
  MAX_LOG_ENTRIES,
  recordConditionObservation,
  scoreCondition,
  buildEntryConditionScorecard
};
