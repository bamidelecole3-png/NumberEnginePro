/**
 * 4BALL SEASON INTELLIGENCE LAB (4SIL) -- Institutional Market Intelligence
 * Engine, SNIPER_V4 PRO v7.2 blueprint.
 *
 * PURPOSE: 4SIL studies, understands, and times the 4-Ball market. It is
 * NOT a prediction engine and never picks, ranks, or recommends a color --
 * that remains fourBallParliament.js's job exclusively. 4SIL answers
 * "WHEN is it safe to enter"; the Parliament answers "WHICH color."
 *
 * ARCHITECTURE -- fusion, not duplication: every section below is a THIN
 * synthesis layer over engines that already exist and already compute this
 * intelligence. 4SIL calls the same functions those engines export (or
 * receives their already-computed output from council.js) rather than
 * reimplementing any of their math. Specifically:
 *
 *   Season stage (birth/growth/peak/.../collapse)  -> lifecycleEngine.js
 *   Dominance strength/momentum/decay/recovery      -> seasonIntelligenceEngine.js
 *   Exit / structural-control-loss probability      -> exitIntelligenceEngine.js
 *   Rolling-window leader & takeover detection       -> dynamicDominanceEngine.js
 *   New-color confirmed first appearance             -> firstAppearanceEngine.js
 *   Leader's terminal burst before surrender          -> lastStandEngine.js
 *   Battle status vocabulary (Color Parliament port)  -> colorParliamentSeasonAdapter.js
 *                                                        + fourBallLastStandCP.js
 *   Third/non-leader color historical behavior        -> rivalPressureEngine.js
 *   Per-color long-run behavioral profile              -> behaviorFingerprintEngine.js
 *   Per-color drought/activity/entropy read             -> suppressionIntelligenceEngine.js
 *   4-Ball market regime (order/transition/chaos)       -> shannonEntropy.js
 *   3-Ball tie volatility (cross-market context)        -> tieEngine.js (via council.js)
 *   Confirmed-event log (cross-engine "voice")          -> eventIntelligenceEngineCP.js (via council.js)
 *
 * KNOWLEDGE BANK -- PERSISTENCE NOTE (updated; see audit pass below): real
 * cross-restart persistence now exists. store.js's fourBallSILMemory,
 * persistence.js's disk wiring, and persistFourSILObservation() (below)
 * together give 4SIL a genuine append-only archive -- observations,
 * transitionArchive, knowledgeSnapshots, and seasonRecords all survive a
 * restart. knowledgeBank (below) is still a fresh recompute from
 * historicalDraws every call -- that part of the original design note
 * still holds, and is the right call for a live per-cycle read -- but it
 * is no longer true that nothing here survives independently of the
 * rolling window: buildTransitionHistory's interval/cycle detection now
 * explicitly reads back context.persistentState.transitionArchive (see
 * its own comment below) precisely so that estimate compounds across
 * sessions instead of resetting whenever the window moves on. Earlier
 * revisions of this header described the persisted archive as a "separate,
 * larger architectural change" that hadn't been built yet -- that's no
 * longer accurate, and this note replaces it so the next person auditing
 * this file doesn't draw the same wrong conclusion.
 *
 * historicalDraws is newest-first (index 0 = most recent), matching every
 * other engine's convention.
 */
const { HIERARCHY, argMaxColorBy } = require('../core/colorMath');
const { mean, median, mode, stddev } = require('../core/statMath');
const { calculateShannonEntropy } = require('./shannonEntropy');
const { evaluateTacticalActivation } = require('./tacticalEngine');
const { computeLifecycle } = require('./lifecycleEngine');
const { evaluateFirstAppearance } = require('./firstAppearanceEngine');
const { evaluateLastStand } = require('./lastStandEngine');
const { replaySeasonAndArchive } = require('./colorParliamentSeasonAdapter');
const { computeFourBallBattle } = require('./fourBallLastStandCP');
const { evaluateRivalPressure } = require('./rivalPressureEngine');
const { buildBehaviorFingerprints } = require('./behaviorFingerprintEngine');
const { evaluateSuppressionIntelligence } = require('./suppressionIntelligenceEngine');
// 4SIL UPGRADE BLUEPRINT -- Response/Cascade section ONLY (per operator
// direction). See fourBallResponseCascadeEngine.js's header for the full
// scoped-down definition and why, unlike the Tie-Birth engine, this one
// DOES feed into evaluateEnterNow() as genuine additional evidence.
const { evaluateFourBallResponseCascade } = require('./fourBallResponseCascadeEngine');

// ENTER NOW requires at least this many independent confirmation
// conditions to be true (see evaluateEnterNow below), matching the
// blueprint's "multiple independent intelligence sources confirm" bar --
// no single engine's read, however strong, is sufficient on its own.
const ENTER_NOW_MIN_CONFIRMATIONS = 4;
const ENTER_NOW_MIN_CONFIDENCE = 70;

// Narrow clamp used only by evaluateEnterNow()'s optional threshold
// feedback -- kept separate from any general-purpose clamp elsewhere in
// this file so its bounds are obviously local to that one adjustment.
function clampAdjust(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Rolling-window size used to determine "who leads right now" at each
// historical point when building the transition event log below --
// matches dynamicDominanceEngine.js's own SHORT_WINDOW so "a transition
// happened" means the same thing here as it does there.
const TRANSITION_ROLLING_WINDOW = 10;
const TRANSITION_SEASON_WINDOW_MAX = 20; // "cluster of transitions" lookback, mirrors tieEngine's SEASON_WINDOW_MAX
const TRANSITION_SEASON_MIN_EVENTS = 2;  // 2+ transitions in that window = a genuinely choppy/volatile stretch
// ENTER NOW tactical trigger window. These rules use the same 10-draw transition window.
const ENTER_NOW_EVENT_WINDOW = 10;
const ENTER_NOW_EVENT_MINIMUM = 2;

// -----------------------------------------------------------------------
// TRANSITION HISTORY INTELLIGENCE -- mirrors tieEngine.js's own
// event-log/interval/cycle/probability machinery exactly (same field
// names and vocabulary where the concepts line up: intervalStats,
// detectedCycle, lastEvent w/ drawId+drawsAgo, escalating probability
// forecast), just applied to "the rolling-window 4-ball leader changed"
// instead of "this draw was a tie". This answers directly: approximately
// how many draws does a transition battle take before a new leader
// actually takes over, and how many draws until the next one is due.
// -----------------------------------------------------------------------
function rollingLeaderAt(draws, idx) {
  const window = draws.slice(idx, idx + TRANSITION_ROLLING_WINDOW);
  if (window.length < Math.min(TRANSITION_ROLLING_WINDOW, 5)) return null; // not enough data at this point yet
  const counts = { RED: 0, BLUE: 0, GREEN: 0 };
  window.forEach(d => { if (d.fourBallColor && counts[d.fourBallColor] !== undefined) counts[d.fourBallColor]++; });
  if (counts.RED + counts.BLUE + counts.GREEN === 0) return null;
  return argMaxColorBy(counts);
}

function buildTransitionHistory(draws, persistedArchive) {
  // Walk from the oldest computable point toward the present (index 0),
  // recording every drawId at which the rolling-window leader flips.
  const events = []; // built oldest-first
  let prevLeader = null;
  for (let idx = draws.length - 1; idx >= 0; idx--) {
    const leader = rollingLeaderAt(draws, idx);
    if (leader === null) continue;
    if (prevLeader !== null && leader !== prevLeader) {
      events.push({ drawId: draws[idx].drawId, fromColor: prevLeader, toColor: leader, drawsAgo: idx });
    }
    prevLeader = leader;
  }

  const totalTransitions = events.length;
  const lastTransition = totalTransitions > 0 ? events[events.length - 1] : null;

  // AUDIT FIX (persisted-archive interval enrichment): the live window
  // above only ever sees transition events still inside `draws` -- once
  // the rolling window moves on, an event vanishes from `events` even
  // though store.fourBallSILMemory.transitionArchive (persisted by
  // persistFourSILObservation, below, across every restart) still has
  // it. Merge the two -- deduped by the exact same `drawId|fromColor|
  // toColor` key persistFourSILObservation already uses -- so the "how
  // many draws per transition" interval/cycle estimate strengthens with
  // every session instead of resetting whenever the window moves on.
  // currentBattleAge / drawsUntilNextTransition's numerator /
  // activeCluster / transitionWarning / recentEvents below deliberately
  // keep reading from the LIVE `events`/`draws` only -- "what's
  // happening right now" must reflect the current window, not a blend
  // with history; only the interval/cycle statistics benefit from the
  // deeper sample.
  const archiveEvents = Array.isArray(persistedArchive) ? persistedArchive : [];
  const seenEventKeys = new Set();
  const chronological = [];
  events.forEach(e => {
    const key = `${String(e.drawId)}|${e.fromColor}|${e.toColor}`;
    if (seenEventKeys.has(key)) return;
    seenEventKeys.add(key);
    chronological.push({ drawId: Number(e.drawId), fromColor: e.fromColor, toColor: e.toColor });
  });
  archiveEvents.forEach(e => {
    const key = `${String(e.drawId)}|${e.fromColor}|${e.toColor}`;
    if (seenEventKeys.has(key)) return;
    seenEventKeys.add(key);
    chronological.push({ drawId: Number(e.drawId), fromColor: e.fromColor, toColor: e.toColor });
  });
  // Chronological order comes from drawId (numeric, sequential in this
  // platform -- the same convention buildKnowledgeBank already relies on
  // for its own closedAtDrawId span calculation below), not drawsAgo,
  // since archived entries were recorded against different rolling-
  // window offsets across sessions and drawsAgo is not comparable
  // across them.
  chronological.sort((a, b) => a.drawId - b.drawId);

  const intervals = [];
  for (let i = 1; i < chronological.length; i++) {
    const span = chronological[i].drawId - chronological[i - 1].drawId;
    // Same sanity bound buildKnowledgeBank uses for closedAtDrawId spans
    // -- guards a stale/corrupt archive entry or a drawId reset from
    // producing a nonsensical negative or absurdly large interval.
    if (span > 0 && span < 200) intervals.push(span);
  }

  const avgIntervalDraws = intervals.length > 0 ? Math.round(mean(intervals) * 10) / 10 : null;
  const medianIntervalDraws = intervals.length > 0 ? median(intervals) : null;
  const longestGapDraws = intervals.length > 0 ? Math.max(...intervals) : null;
  const shortestGapDraws = intervals.length > 0 ? Math.min(...intervals) : null;
  const mostCommonInterval = intervals.length > 0 ? mode(intervals) : null;

  // AUDIT FIX (dispersion check): a plurality match (>=2 identical
  // intervals) alone doesn't mean the underlying pattern is tight --
  // intervals of [6, 6] and [4, 4, 11, 13] both satisfy that bar, but
  // the second is loose/noisy, not a real cycle. Require the full
  // interval set to also cluster tightly around its own mean
  // (coefficient of variation = stddev / mean) before calling a cycle
  // "detected". This feeds directly into TRANSITION_CYCLE_DUE and,
  // through it, the ENTER_NOW gate, so a falsely-confident cycle read
  // has real downstream consequences.
  const intervalMeanRaw = intervals.length > 0 ? mean(intervals) : 0;
  const intervalStdDev = intervals.length > 0 ? stddev(intervals) : 0;
  const coefficientOfVariation = intervalMeanRaw > 0
    ? Math.round((intervalStdDev / intervalMeanRaw) * 1000) / 1000
    : null;
  const CYCLE_MAX_COEFFICIENT_OF_VARIATION = 0.35; // empirically tight: [6,6] -> 0 (passes), [4,4,11,13] -> ~0.586 (fails)
  const dispersionOK = coefficientOfVariation !== null && coefficientOfVariation <= CYCLE_MAX_COEFFICIENT_OF_VARIATION;

  const detectedCycle = (mostCommonInterval && intervals.filter(iv => iv === mostCommonInterval).length >= 2 && dispersionOK)
    ? `Transition approximately every ${mostCommonInterval} draw(s)`
    : null;

  // How long has the CURRENT leader held the rolling-window lead --
  // directly analogous to tieEngine's "draws since last tie".
  const currentBattleAge = lastTransition ? lastTransition.drawsAgo : draws.length;

  const drawsUntilNextTransition = mostCommonInterval != null
    ? Math.max(0, mostCommonInterval - currentBattleAge)
    : null;

  // Escalating probability forecast, same "1 - (1-p)^n" compounding used
  // by tieEngine's probability engine -- p derived from how far past (or
  // short of) the detected cycle the current battle age already is.
  let pNextDraw = 0.08; // conservative floor when no cycle detected yet
  if (mostCommonInterval) {
    pNextDraw = currentBattleAge >= mostCommonInterval
      ? Math.min(0.5, 0.15 + (currentBattleAge - mostCommonInterval) * 0.05)
      : Math.max(0.05, 0.15 - (mostCommonInterval - currentBattleAge) * 0.02);
  }
  const within = n => Math.round((1 - Math.pow(1 - pNextDraw, n)) * 1000) / 10;
  const transitionProbability = {
    nextDrawPct: Math.round(pNextDraw * 1000) / 10,
    within3DrawsPct: within(3),
    within5DrawsPct: within(5)
  };

  // Recent cluster of transitions -- a genuinely choppy/volatile stretch,
  // mirroring tieEngine's "active tie season" concept.
  const recentEvents = events.filter(e => e.drawsAgo <= TRANSITION_SEASON_WINDOW_MAX);
  const activeCluster = recentEvents.length >= TRANSITION_SEASON_MIN_EVENTS
    ? { eventCount: recentEvents.length, spanDraws: TRANSITION_SEASON_WINDOW_MAX, mostRecentDrawsAgo: recentEvents[recentEvents.length - 1].drawsAgo }
    : null;

  let warningLevel = 'LOW';
  let warningScore = 0;
  if (activeCluster) warningScore += 30 + Math.min(20, activeCluster.eventCount * 8);
  if (drawsUntilNextTransition !== null && drawsUntilNextTransition <= 2) warningScore += 30;
  if (mostCommonInterval && currentBattleAge >= mostCommonInterval) warningScore += 20;
  warningScore = Math.min(95, Math.round(warningScore));
  if (warningScore >= 60) warningLevel = 'HIGH';
  else if (warningScore >= 30) warningLevel = 'ELEVATED';

  const reasoning = activeCluster
    ? `Active transition cluster: ${activeCluster.eventCount} leadership changes across the last ${activeCluster.spanDraws} draws, most recent ${activeCluster.mostRecentDrawsAgo} draw(s) ago. ${detectedCycle || ''}`.trim()
    : (totalTransitions === 0
      ? 'No leadership transitions observed yet in the tracked window.'
      : `No active cluster. Current leader has held for ${currentBattleAge} draw(s) (last transition ${lastTransition.drawsAgo} draw(s) ago, ${lastTransition.fromColor} -> ${lastTransition.toColor}). ${detectedCycle || `Baseline: ${totalTransitions} transitions in ${draws.length} tracked draws.`}`);

  return {
    totalTransitions,
    lastTransition,
    intervalStats: {
      count: intervals.length,
      avgIntervalDraws,
      medianIntervalDraws,
      longestGapDraws,
      shortestGapDraws,
      mostCommonInterval,
      coefficientOfVariation,
      // Transparency into the audit-item-1 fix: how many of the interval
      // samples above came from this call's live window vs. how many
      // extra distinct events the persisted archive contributed -- lets
      // the dashboard/operator see the estimate is genuinely enriched by
      // cross-restart history, not just recomputed from the same window.
      liveWindowEventCount: events.length,
      archiveEventCount: archiveEvents.length,
      crossRestartEnriched: archiveEvents.length > 0
    },
    detectedCycle,
    currentBattleAge,
    drawsUntilNextTransition,
    transitionProbability,
    activeCluster,
    transitionWarning: { level: warningLevel, score: warningScore, reasoning },
    recentEvents: recentEvents.slice(-10)
  };
}


// -----------------------------------------------------------------------
// SEASON INTELLIGENCE -- birth/growth/peak/stability/fatigue/decline/
// collapse/recovery/new-season-formation, built on lifecycleEngine.js's
// existing 7-phase model plus two overlay states (RECOVERY, NEW_SEASON_
// FORMATION) derived from the Color Parliament season archive.
// -----------------------------------------------------------------------
function classifySeasonStage(lifecycle, archiveState, dominantColor) {
  const history = (archiveState && archiveState.history) || [];
  const lastClosed = history.length > 0 ? history[history.length - 1] : null;

  if (lifecycle.phase === 'DETECTION' || lifecycle.phase === 'BIRTH') {
    if (lastClosed && lastClosed.dominantColor === dominantColor) {
      return { stage: 'RECOVERY', detail: `${dominantColor} re-establishing dominance after its previous season closed.` };
    }
    if (history.length > 0) {
      return { stage: 'NEW_SEASON_FORMATION', detail: `A new season is forming under ${dominantColor} following ${history.length} prior closed season(s).` };
    }
  }
  return { stage: lifecycle.phase, detail: `Lifecycle phase ${lifecycle.phase} (confidence ${Math.round(lifecycle.confidence * 100)}%).` };
}

// -----------------------------------------------------------------------
// THIRD COLOR INTELLIGENCE -- when two colors are contesting dominance,
// how does the third (uninvolved) color behave? Reuses rivalPressureEngine's
// per-pair historical release data and suppressionIntelligenceEngine's
// drought/activity read for that specific color, rather than inventing new
// tracking.
// -----------------------------------------------------------------------
function evaluateThirdColorIntelligence(battle, rivalPressure, suppression) {
  if (!battle.active || !battle.challenger) {
    return { applicable: false, thirdColor: null, behavior: null, detail: 'No active two-color battle to evaluate a third color against.' };
  }
  const thirdColor = HIERARCHY.find(c => c !== battle.leader && c !== battle.challenger);
  if (!thirdColor) {
    return { applicable: false, thirdColor: null, behavior: null, detail: 'Could not isolate a distinct third color.' };
  }

  const outlook = rivalPressure.rivalOutlook ? rivalPressure.rivalOutlook[thirdColor] : null;
  const supp = suppression[thirdColor];

  let behavior;
  if (supp && supp.rollingActivity <= 15 && supp.tierDrought >= 15) {
    behavior = 'RETREATING';
  } else if (outlook && outlook.releaseProbability != null && outlook.releaseProbability >= 55) {
    behavior = 'EMERGING_NEXT_LEADER';
  } else if (supp && supp.momentumAcceleration > 0 && supp.rollingActivity >= 20) {
    behavior = 'ACCUMULATING';
  } else if (supp && supp.tierEntropy >= 1.3) {
    behavior = 'DISRUPTOR';
  } else {
    behavior = 'DORMANT';
  }

  const detail = outlook
    ? `${thirdColor} sitting out the ${battle.leader}/${battle.challenger} battle -- classified ${behavior}. Historical release probability after similar dominant stretches: ${outlook.releaseProbability != null ? outlook.releaseProbability + '%' : 'insufficient sample'}. Suppression index: ${outlook.suppressionIndex != null ? outlook.suppressionIndex : 'n/a'}.`
    : `${thirdColor} sitting out the ${battle.leader}/${battle.challenger} battle -- classified ${behavior}.`;

  return { applicable: true, thirdColor, behavior, detail, rivalOutlook: outlook || null };
}

// -----------------------------------------------------------------------
// ENTER NOW DECISION ENGINE -- the engine's sole executable output. Fires
// only when multiple INDEPENDENT engines agree a genuine transition is
// underway, not on any single strong reading. Each condition below comes
// from a different engine/model, matching the blueprint's explicit
// "supporting intelligence from integrated engines aligns" requirement.
//
// `thresholdAdjustment` (optional, default null) is the Entry Accuracy
// System's feedback channel -- see entryConditionScorecard.js and
// entryAccuracyEngine.js. It NEVER changes which conditions exist or how
// they're detected; it only allows ENTER_NOW_MIN_CONFIRMATIONS and
// ENTER_NOW_MIN_CONFIDENCE to be nudged within a narrow, capped range
// once the scorecard has enough graded history to justify it. Omitting
// this argument (every existing call site) reproduces the exact original
// fixed-constant behavior -- this is purely additive and opt-in.
// -----------------------------------------------------------------------
function evaluateEnterNow({ battle, dynamicDom, firstApp, exitIntel, thirdColorIntel, rivalPressure, lastStand, transitionHistory, knowledgeBank, draws, thresholdAdjustment, responseCascade, tieIntelligence, tieClusterResult }) {
  const conditions = [];
  const recent10 = Array.isArray(draws) ? draws.slice(0, ENTER_NOW_EVENT_WINDOW) : [];
  const recentFourBallEvents = recent10.filter(d => !!d.fourBallColor);
  const recentFourBallCount = recentFourBallEvents.length;
  const transitionBattleActive = !!(battle && battle.active);

  // A takeover is "just registered" only when the transition event is at the
  // current draw or immediately preceding draw.
  const transitionJustRegistered = !!(
    transitionHistory &&
    transitionHistory.lastTransition &&
    transitionHistory.lastTransition.drawsAgo <= 1
  );

  // A. Transition battle has reached maximum intensity / leader losing control.
  const battleAtMaxIntensity = transitionBattleActive && battle.battleStatus === 'LEADER_COLLAPSING';
  conditions.push({
    id: 'BATTLE_MAX_INTENSITY',
    met: battleAtMaxIntensity,
    weight: 30,
    detail: battleAtMaxIntensity
      ? `Battle status LEADER_COLLAPSING: ${battle.challenger} (${battle.challengerStrength}%) has overtaken ${battle.leader} (${battle.leaderStrength}%).`
      : `Battle status is ${transitionBattleActive ? battle.battleStatus : 'INACTIVE'} -- not yet at maximum transition intensity.`
  });

  // B. Independent Dynamic Dominance confirmation.
  const independentTakeover = !!dynamicDom.challengerTakeover &&
    (!battle.challenger || dynamicDom.challenger === battle.challenger || dynamicDom.rollingLeaderShort === battle.challenger);
  conditions.push({
    id: 'INDEPENDENT_TAKEOVER_CONFIRMED',
    met: independentTakeover,
    weight: 25,
    detail: independentTakeover
      ? `Dynamic Dominance Engine independently confirms a challenger takeover (${dynamicDom.rollingLeaderShort} 10-draw leader vs ${dynamicDom.rollingLeaderLong} 30-draw leader).`
      : 'Dynamic Dominance Engine does not yet corroborate a challenger takeover.'
  });

  // C. New color establishing its first confirmed appearance.
  const firstAppearanceConfirmed = firstApp.active &&
    (!battle.challenger || firstApp.breakoutColor === battle.challenger || firstApp.breakoutColor === dynamicDom.rollingLeaderShort);
  conditions.push({
    id: 'NEW_COLOR_FIRST_APPEARANCE',
    met: firstAppearanceConfirmed,
    weight: 20,
    detail: firstAppearanceConfirmed
      ? `First Appearance Engine confirms ${firstApp.breakoutColor} breaking out (confidence ${firstApp.confidence}%).` +
        (firstApp.nextAppearance && firstApp.nextAppearance.approximatelyDraws != null
          ? ` Expected approximately ~${firstApp.nextAppearance.approximatelyDraws} draw(s) to appearance.`
          : '')
      : 'No confirmed first-appearance breakout aligned with the current challenger.'
  });

  // D. Incumbent leader losing structural control.
  const leaderLosingControl = exitIntel.exitProbability >= 65 || (lastStand && lastStand.isLastStand);
  conditions.push({
    id: 'LEADER_LOSING_CONTROL',
    met: leaderLosingControl,
    weight: 15,
    detail: `Exit Intelligence puts ${exitIntel.exitProbability}% probability on the incumbent leader losing control.` +
      (lastStand && lastStand.isLastStand ? ` Last Stand Engine independently confirms a terminal burst (${lastStand.confidence}%).` : '')
  });

  // E. Historical transition pattern match -- previously rested entirely
  // on a single threshold (rivalPressure's releaseProbability >= 50),
  // with knowledgeBank.behaviourLibrary's richer per-color stats
  // (repeatTendencyScore, recoverySpeed) computed in this same function
  // call but never consulted. Now requires the behavioral library to
  // corroborate before the condition is considered met: a challenger
  // with a track record of repeating quickly after taking the lead
  // (repeatTendencyScore, 0-100 scale) or recovering fast from droughts
  // (recoverySpeed FAST/MODERATE) makes a >=50% release-probability read
  // meaningfully more credible than the same number for a color with no
  // such history. Either signal corroborating is sufficient -- this is
  // a corroboration check, not a second independent gate to also clear.
  const challengerColor = battle.challenger;
  const challengerOutlook = (thirdColorIntel.applicable && challengerColor && rivalPressure.rivalOutlook)
    ? rivalPressure.rivalOutlook[challengerColor]
    : null;
  const releaseProbability = challengerOutlook && challengerOutlook.releaseProbability != null
    ? challengerOutlook.releaseProbability
    : null;
  const challengerBehaviour = (challengerColor && knowledgeBank && knowledgeBank.behaviourLibrary)
    ? knowledgeBank.behaviourLibrary[challengerColor]
    : null;
  const repeatTendencyCorroborates = !!(challengerBehaviour && challengerBehaviour.repeatTendencyScore != null && challengerBehaviour.repeatTendencyScore >= 40);
  const recoverySpeedCorroborates = !!(challengerBehaviour && (challengerBehaviour.recoverySpeed === 'FAST' || challengerBehaviour.recoverySpeed === 'MODERATE'));
  const behaviourCorroborates = repeatTendencyCorroborates || recoverySpeedCorroborates;
  const releaseProbabilityMet = releaseProbability != null && releaseProbability >= 50;
  const historicalMatch = releaseProbabilityMet && behaviourCorroborates;
  conditions.push({
    id: 'HISTORICAL_PATTERN_MATCH',
    met: historicalMatch,
    weight: 10,
    detail: historicalMatch
      ? `Historical precedent supports this takeover shape (${challengerColor} release probability ${releaseProbability}%, corroborated by behavioral library: repeat tendency ${challengerBehaviour.repeatTendencyScore}%, recovery speed ${challengerBehaviour.recoverySpeed}).`
      : (releaseProbabilityMet
        ? `Release probability (${releaseProbability}%) alone insufficient -- behavioral library does not corroborate this takeover shape (repeat tendency ${challengerBehaviour ? challengerBehaviour.repeatTendencyScore + '%' : 'n/a'}, recovery speed ${challengerBehaviour ? challengerBehaviour.recoverySpeed : 'n/a'}).`
        : 'Insufficient or unfavorable historical precedent for this exact takeover shape.')
  });

  // F. Empirical transition cycle is due/overdue.
  const cycleDue = transitionHistory && transitionHistory.detectedCycle
    ? transitionHistory.currentBattleAge >= (transitionHistory.intervalStats.mostCommonInterval - 1)
    : false;
  conditions.push({
    id: 'TRANSITION_CYCLE_DUE',
    met: cycleDue,
    weight: 15,
    detail: transitionHistory && transitionHistory.detectedCycle
      ? `${transitionHistory.detectedCycle}. Current leader has held for ${transitionHistory.currentBattleAge} draws -- ${cycleDue ? 'at or past' : 'short of'} that cycle length.`
      : 'Not enough transition history yet to detect a reliable cycle.'
  });

  // G. NEW RULE: at least two 4-ball events of ANY color inside a 10-draw
  // window while an active transition battle is underway.
  const twoFourBallsInTransition = transitionBattleActive && recentFourBallCount >= ENTER_NOW_EVENT_MINIMUM;
  conditions.push({
    id: 'TWO_4BALL_EVENTS_IN_TRANSITION_WINDOW',
    met: twoFourBallsInTransition,
    weight: 20,
    detail: twoFourBallsInTransition
      ? `${recentFourBallCount} 4-ball events detected in the last ${recent10.length} draws during an active transition battle.`
      : `Fewer than ${ENTER_NOW_EVENT_MINIMUM} 4-ball events in the last ${recent10.length} draws during an active transition battle.`
  });

  // H. NEW RULE: the dormant third color suddenly fires a 4-ball in the
  // middle of the leader/challenger transition battle.
  const thirdColorFired = transitionBattleActive &&
    !!(thirdColorIntel && thirdColorIntel.applicable && thirdColorIntel.thirdColor) &&
    thirdColorIntel.behavior === 'DORMANT' &&
    recentFourBallEvents.some(d => d.fourBallColor === thirdColorIntel.thirdColor);
  conditions.push({
    id: 'DORMANT_THIRD_COLOR_FIRES',
    met: thirdColorFired,
    weight: 25,
    detail: thirdColorFired
      ? `Dormant third color ${thirdColorIntel.thirdColor} suddenly fired a 4-ball during the ${battle.leader}/${battle.challenger} transition battle.`
      : 'No dormant third-color 4-ball firing detected inside the active transition battle.'
  });

  // I. NEW RULE: the incumbent leader fires a 4-ball while it is already
  // losing dominance/control -- the 4-ball is classified as a Last Stand.
  const leaderFiredWhileLosing = transitionBattleActive &&
    !!battle.leader &&
    recentFourBallEvents.some(d => d.fourBallColor === battle.leader) &&
    leaderLosingControl;
  conditions.push({
    id: 'LEADER_LAST_STAND_4BALL',
    met: leaderFiredWhileLosing,
    weight: 25,
    detail: leaderFiredWhileLosing
      ? `Incumbent leader ${battle.leader} fired a 4-ball while losing dominance/control -- classified as a Last Stand event.`
      : `No qualifying ${battle.leader || 'leader'} 4-ball Last Stand detected while control is deteriorating.`
  });

  // J. NEW RULE: when a new leader has JUST registered a takeover and there
  // are already at least two 4-ball events in that same 10-draw window,
  // ENTER NOW activates automatically. This explicit rule bypasses the
  // ordinary multi-condition confidence gate.
  const autoTakeoverBurst = transitionBattleActive &&
    transitionJustRegistered &&
    !!dynamicDom.challengerTakeover &&
    recentFourBallCount >= ENTER_NOW_EVENT_MINIMUM;
  conditions.push({
    id: 'NEW_LEADER_TAKEOVER_2X_4BALL_AUTO',
    met: autoTakeoverBurst,
    weight: 30,
    detail: autoTakeoverBurst
      ? `New leader ${dynamicDom.rollingLeaderShort} just registered a takeover and ${recentFourBallCount} 4-ball events occurred within the same ${recent10.length}-draw window -- automatic ENTER NOW activated.`
      : 'No fresh leader takeover accompanied by the required 2+ 4-ball events in the same 10-draw window.'
  });

  // K. NEW RULE (Response/Cascade, per operator direction -- see
  // fourBallResponseCascadeEngine.js): activity concentrating in the two
  // NON-TOP colors is a strong signal on its own. Unlike conditions G, H,
  // and I above, this one is deliberately NOT scoped to "only while an
  // active transition battle is underway" -- blueprint rule 5 ("Do not
  // require transition before every opportunity") and rule 6 ("STABILIZED
  // does not mean NO OPPORTUNITY") apply directly here: the market can be
  // fully STABILIZED around the Top color and still show two non-Top
  // colors independently firing 4-balls, and that is real evidence in its
  // own right.
  const cascadeResponseConfirmed = !!(responseCascade && responseCascade.ready && responseCascade.cascadeResponse);
  conditions.push({
    id: 'CROSS_COLOR_RESPONSE_CASCADE',
    met: cascadeResponseConfirmed,
    weight: 30,
    detail: cascadeResponseConfirmed
      ? responseCascade.reasoning
      : (responseCascade && responseCascade.ready
        ? responseCascade.reasoning
        : 'Response/Cascade Engine has no Top color established this cycle.')
  });

  // L. Fires when the 4-Ball Tie Cluster Engine (fourBallTieClusterEngine.js)
  // reports an ACTIVE confirmed cluster -- i.e. two DISTINCT genuine ties
  // (using the SAME tie rule as the 3-Ball Tie Engine, tieEngine.js's
  // isThreeBallTie: no color reached a real win, 3-ball or 4-ball, that
  // draw) landed within its rolling confirmation window (a window narrow
  // enough that two ties landing back-to-back/consecutively automatically
  // qualifies too), deduplicated by real draw ID so the dashboard's
  // auto-refresh can never manufacture a second qualifying tie from the
  // same draw. See fourBallTieClusterEngine.js's header for the earlier,
  // stricter score-gated version this replaced (diagnosed as missing a
  // real repeated-tie event that should have fired).
  // Same as condition K: deliberately NOT scoped to "only during an
  // active transition battle" -- a confirmed Tie cluster is evidence of
  // market churn/volatility in its own right, independent of which color
  // currently leads.
  //
  // This condition remains SUPPORTING evidence only, same weight and slot
  // as before -- it still cannot open the gate by itself, and a confirmed
  // cluster contributes exactly one condition's worth of weight regardless
  // of whether 2 or more qualifying ties are in the window (vote
  // confirmation, not vote inflation; see tieClusterResult.tieConfidence
  // for the separate, non-gate-affecting confidence readout).
  const repeatedTieClusterMet = !!(tieClusterResult && tieClusterResult.tieVoteActive);
  conditions.push({
    id: 'REPEATED_TIE_CLUSTER',
    met: repeatedTieClusterMet,
    weight: 25,
    detail: tieClusterResult
      ? tieClusterResult.reasoning
      : 'Tie Cluster Engine did not run this cycle -- no repeated-tie evidence available.'
  });

  const confirmedCount = conditions.filter(c => c.met).length;
  const institutionalConfidence = Math.min(97, conditions.reduce((sum, c) => sum + (c.met ? c.weight : 0), 0));

  // Apply the Entry Accuracy System's threshold feedback, if provided and
  // within its allowed range. Confirmations can move by at most +-1 and
  // confidence by at most +-10 points from the design-time constants --
  // deliberately narrow so accumulated evidence can tighten or loosen the
  // gate at the margins without being able to invert it outright (e.g.
  // it can never require 0 confirmations or demand 100% confidence).
  const effectiveMinConfirmations = thresholdAdjustment && Number.isFinite(thresholdAdjustment.confirmationsDelta)
    ? clampAdjust(ENTER_NOW_MIN_CONFIRMATIONS + thresholdAdjustment.confirmationsDelta, ENTER_NOW_MIN_CONFIRMATIONS - 1, ENTER_NOW_MIN_CONFIRMATIONS + 1)
    : ENTER_NOW_MIN_CONFIRMATIONS;
  const effectiveMinConfidence = thresholdAdjustment && Number.isFinite(thresholdAdjustment.confidenceDelta)
    ? clampAdjust(ENTER_NOW_MIN_CONFIDENCE + thresholdAdjustment.confidenceDelta, ENTER_NOW_MIN_CONFIDENCE - 10, ENTER_NOW_MIN_CONFIDENCE + 10)
    : ENTER_NOW_MIN_CONFIDENCE;

  const standardGate = confirmedCount >= effectiveMinConfirmations &&
    institutionalConfidence >= effectiveMinConfidence;
  const enterNow = autoTakeoverBurst || standardGate;

  let marketReadiness;
  if (confirmedCount <= 1) marketReadiness = 'LOW';
  else if (confirmedCount === 2) marketReadiness = 'MODERATE';
  else if (confirmedCount === 3) marketReadiness = 'HIGH';
  else marketReadiness = 'OPTIMAL';

  const reasoning = enterNow
    ? (autoTakeoverBurst
      ? `ENTER NOW (AUTOMATIC TAKEOVER-BURST RULE): ${conditions.filter(c => c.met).map(c => c.detail).join(' ')}`
      : `ENTER NOW: ${confirmedCount}/${conditions.length} independent conditions confirmed at ${institutionalConfidence}% institutional confidence. ${conditions.filter(c => c.met).map(c => c.detail).join(' ')}`)
    : `Silent (no signal): only ${confirmedCount}/${conditions.length} conditions confirmed (standard gate requires >= ${effectiveMinConfirmations} at >= ${effectiveMinConfidence}% confidence${thresholdAdjustment ? ', adjusted from design-time defaults by the Entry Accuracy System' : ''}). Missing: ${conditions.filter(c => !c.met).map(c => c.id).join(', ') || 'none -- confidence threshold not met'}.`;

  return {
    enterNow,
    automaticActivation: autoTakeoverBurst,
    marketReadiness,
    institutionalConfidence,
    confirmedCount,
    conditions,
    recentFourBallCount,
    transitionJustRegistered,
    // Effective thresholds actually applied this cycle -- equal to the
    // fixed design-time constants unless a valid thresholdAdjustment was
    // supplied (see entryAccuracyEngine.js). Exposed so the UI/scorecard
    // can show when and by how much the gate has been tuned.
    effectiveMinConfirmations,
    effectiveMinConfidence,
    thresholdAdjusted: Boolean(thresholdAdjustment),
    reasoning
  };
}

// -----------------------------------------------------------------------
// KNOWLEDGE BANK -- see the module header's scope note. Recomputed fresh
// from historicalDraws every call.
// -----------------------------------------------------------------------
function buildKnowledgeBank(historicalDraws, archiveState, behaviorProfiles, suppression) {
  const history = (archiveState && archiveState.history) || [];
  const closedCount = history.length;

  // Approximate season spans from consecutive closed-season drawIds. This
  // is a proxy, not an exact replay of activation boundaries (see header
  // scope note) -- documented here rather than presented as more precise
  // than it is.
  const spans = [];
  for (let i = 1; i < history.length; i++) {
    const span = history[i].closedAtDrawId - history[i - 1].closedAtDrawId;
    if (span > 0 && span < 200) spans.push(span);
  }
  const avgSeasonSpanDraws = spans.length > 0 ? Math.round(mean(spans) * 10) / 10 : null;

  const dominantColorTally = { RED: 0, BLUE: 0, GREEN: 0 };
  history.forEach(h => { if (dominantColorTally[h.dominantColor] !== undefined) dominantColorTally[h.dominantColor]++; });
  if (archiveState && archiveState.dominantColor) dominantColorTally[archiveState.dominantColor]++;
  const mostFrequentDominantColor = closedCount + (archiveState.awake ? 1 : 0) > 0
    ? argMaxColorBy(dominantColorTally)
    : null;

  const behaviourLibrary = {};
  HIERARCHY.forEach(c => {
    const bf = behaviorProfiles[c] || {};
    const sup = suppression[c] || {};
    behaviourLibrary[c] = {
      totalHits: bf.totalHits ?? null,
      clusterTendencyScore: bf.clusterTendencyScore ?? null,
      repeatTendencyScore: bf.repeatTendencyScore ?? null,
      maxDrought: bf.maxDrought ?? null,
      avgGap: bf.avgGap ?? null,
      recoverySpeed: bf.recoverySpeed ?? null,
      rollingActivityPct: sup.rollingActivity ?? null,
      tierEntropy: sup.tierEntropy ?? null,
      suppressionClassification: sup.classification ?? null
    };
  });

  return {
    seasonsObserved: closedCount + (archiveState && archiveState.awake ? 1 : 0),
    seasonsClosed: closedCount,
    avgSeasonSpanDraws,
    mostFrequentDominantColor,
    dominantColorTally,
    behaviourLibrary,
    sampleWindowDraws: historicalDraws.length
  };
}


// -----------------------------------------------------------------------
// PERSISTENT INSTITUTIONAL MEMORY
// -----------------------------------------------------------------------
// 4SIL's live intelligence is deliberately recomputed from the available
// draw window, but its KNOWLEDGE BANK must not disappear on restart.  This
// helper appends only when a genuinely new latest draw is observed, so the
// Supreme Council can safely run repeatedly (startup, API reads, ingest,
// dashboard polling) without duplicating records.
//
// The archive is intentionally compact: it stores institutional observations,
// unique transition events, season identity changes and periodic knowledge
// snapshots rather than copying the entire draw history into 4SIL.
const FOUR_SIL_MAX_OBSERVATIONS = 5000;
const FOUR_SIL_MAX_TRANSITIONS = 5000;
const FOUR_SIL_MAX_KNOWLEDGE_SNAPSHOTS = 500;
const FOUR_SIL_MAX_SEASON_RECORDS = 1000;

function persistFourSILObservation(memory, draws, result) {
  if (!memory || typeof memory !== 'object' || !result) {
    return {
      persisted: false,
      reason: 'Persistent 4SIL memory was not supplied by the orchestrator.'
    };
  }

  if (!Array.isArray(memory.observations)) memory.observations = [];
  if (!Array.isArray(memory.transitionArchive)) memory.transitionArchive = [];
  if (!Array.isArray(memory.knowledgeSnapshots)) memory.knowledgeSnapshots = [];
  if (!Array.isArray(memory.seasonRecords)) memory.seasonRecords = [];

  const latest = draws && draws[0];
  if (!latest || latest.drawId == null) {
    return {
      persisted: false,
      reason: 'No draw available to anchor the 4SIL observation.'
    };
  }

  const drawId = String(latest.drawId);
  const alreadyProcessed = memory.lastProcessedDrawId != null
    && String(memory.lastProcessedDrawId) === drawId;

  if (alreadyProcessed) {
    return {
      persisted: true,
      recorded: false,
      reason: 'Latest draw already incorporated; no duplicate archive entry created.'
    };
  }

  const now = new Date().toISOString();
  const observation = {
    drawId: latest.drawId,
    timestamp: now,
    active: Boolean(result.active),
    seasonStage: result.seasonStage ? result.seasonStage.stage : 'INACTIVE',
    dominantColor: result.dominantColor || null,
    seasonAge: result.seasonAge || 0,
    transitionBattleStatus: result.transitionBattle
      ? (result.transitionBattle.battleStatus || 'INACTIVE')
      : 'INACTIVE',
    transitionProbabilityPct: result.badge ? result.badge.transitionProbabilityPct : 0,
    drawsUntilNextTransition: result.transitionHistory
      ? result.transitionHistory.drawsUntilNextTransition
      : null,
    enterNow: Boolean(result.enterNow && result.enterNow.enterNow),
    institutionalConfidence: result.enterNow ? result.enterNow.institutionalConfidence : 0,
    marketReadiness: result.enterNow ? result.enterNow.marketReadiness : 'LOW',
    regime: result.regime ? result.regime.current : null
  };

  memory.observations.unshift(observation);
  if (memory.observations.length > FOUR_SIL_MAX_OBSERVATIONS) {
    memory.observations.length = FOUR_SIL_MAX_OBSERVATIONS;
  }

  // Merge transition events discovered in the current rolling window.
  // The draw window can move on after an event, so the archive must be
  // append-only and keyed by the event itself rather than by array position.
  const existingTransitions = new Set(
    memory.transitionArchive.map(e =>
      `${String(e.drawId)}|${e.fromColor}|${e.toColor}`
    )
  );
  const recentEvents = result.transitionHistory &&
    Array.isArray(result.transitionHistory.recentEvents)
    ? result.transitionHistory.recentEvents
    : [];

  recentEvents.forEach(event => {
    const key = `${String(event.drawId)}|${event.fromColor}|${event.toColor}`;
    if (existingTransitions.has(key)) return;
    existingTransitions.add(key);
    memory.transitionArchive.unshift({
      drawId: event.drawId,
      fromColor: event.fromColor,
      toColor: event.toColor,
      drawsAgoAtDetection: event.drawsAgo,
      recordedAt: now
    });
  });
  if (memory.transitionArchive.length > FOUR_SIL_MAX_TRANSITIONS) {
    memory.transitionArchive.length = FOUR_SIL_MAX_TRANSITIONS;
  }

  // Preserve a compact institutional snapshot so long-run behavior can be
  // compared even after the rolling draw window has moved on.
  if (result.knowledgeBank) {
    memory.knowledgeSnapshots.unshift({
      drawId: latest.drawId,
      timestamp: now,
      seasonsObserved: result.knowledgeBank.seasonsObserved,
      seasonsClosed: result.knowledgeBank.seasonsClosed,
      avgSeasonSpanDraws: result.knowledgeBank.avgSeasonSpanDraws,
      mostFrequentDominantColor: result.knowledgeBank.mostFrequentDominantColor,
      dominantColorTally: result.knowledgeBank.dominantColorTally,
      behaviourLibrary: result.knowledgeBank.behaviourLibrary,
      sampleWindowDraws: result.knowledgeBank.sampleWindowDraws
    });
    if (memory.knowledgeSnapshots.length > FOUR_SIL_MAX_KNOWLEDGE_SNAPSHOTS) {
      memory.knowledgeSnapshots.length = FOUR_SIL_MAX_KNOWLEDGE_SNAPSHOTS;
    }
  }

  // A season record is created when the active/inactive state or dominant
  // color changes. This gives 4SIL a durable season lifecycle archive
  // without pretending that every draw is a new season.
  const previous = memory.currentState;
  const currentIdentity = `${result.active ? 'ACTIVE' : 'INACTIVE'}:${result.dominantColor || 'NONE'}`;
  const previousIdentity = previous
    ? `${previous.active ? 'ACTIVE' : 'INACTIVE'}:${previous.dominantColor || 'NONE'}`
    : null;

  if (!previous || currentIdentity !== previousIdentity) {
    if (previous) {
      previous.closedAtDrawId = latest.drawId;
      previous.closedAt = now;
    }
    const seasonRecord = {
      sequence: memory.seasonRecords.length + 1,
      openedAtDrawId: latest.drawId,
      openedAt: now,
      active: Boolean(result.active),
      dominantColor: result.dominantColor || null,
      stageAtOpening: result.seasonStage ? result.seasonStage.stage : 'INACTIVE'
    };
    memory.seasonRecords.unshift(seasonRecord);
    if (memory.seasonRecords.length > FOUR_SIL_MAX_SEASON_RECORDS) {
      memory.seasonRecords.length = FOUR_SIL_MAX_SEASON_RECORDS;
    }
  }

  memory.currentState = {
    drawId: latest.drawId,
    updatedAt: now,
    active: Boolean(result.active),
    dominantColor: result.dominantColor || null,
    seasonStage: result.seasonStage ? result.seasonStage.stage : 'INACTIVE',
    seasonAge: result.seasonAge || 0,
    transitionBattleStatus: result.transitionBattle
      ? (result.transitionBattle.battleStatus || 'INACTIVE')
      : 'INACTIVE',
    enterNow: Boolean(result.enterNow && result.enterNow.enterNow),
    institutionalConfidence: result.enterNow ? result.enterNow.institutionalConfidence : 0,
    marketReadiness: result.enterNow ? result.enterNow.marketReadiness : 'LOW'
  };
  memory.lastProcessedDrawId = latest.drawId;
  memory.updatedAt = now;
  memory.schemaVersion = 1;

  return {
    persisted: true,
    recorded: true,
    observationCount: memory.observations.length,
    transitionArchiveCount: memory.transitionArchive.length,
    knowledgeSnapshotCount: memory.knowledgeSnapshots.length,
    seasonRecordCount: memory.seasonRecords.length,
    lastProcessedDrawId: memory.lastProcessedDrawId
  };
}

// -----------------------------------------------------------------------
// NEXT EVENT LEADERBOARD (4-Ball) -- direct 4-ball port of
// threeBallSeasonIntelligenceLab.js's buildNextEventLeaderboard3B. Same
// continuous per-color ranking, same reasoning for why a continuous board
// beats a binary gate (see that file's header) -- the only change is the
// draw field read (`d.fourBallColor` instead of `d.threeBallColor`).
//
// TAILORED TO 4-BALL MARKET METRICS: no math is copied blind. Because a
// 4-ball hit is a rarer, higher-tier event than a 3-ball hit (this is the
// same tierValue()-driven suppression/drought data 4SIL already uses
// elsewhere in this file), running this against the 4-ball-only gap
// history naturally produces longer avgHistoricalGap / colorDrought /
// estimatedDrawsUntilNext figures than the 3-ball board ever would -- the
// board is native to the 4-ball event stream, not a relabeled copy of the
// 3-ball one.
function computeColorReturnEstimate4B(historicalDraws, color, supp) {
  const chronological = historicalDraws.slice().reverse();
  const hitIndexes = [];
  chronological.forEach((d, i) => { if (d.fourBallColor === color) hitIndexes.push(i); });
  const gaps = [];
  for (let i = 1; i < hitIndexes.length; i++) gaps.push(hitIndexes[i] - hitIndexes[i - 1]);

  const sampleSize = gaps.length;
  const avgGap = sampleSize > 0 ? Math.round(mean(gaps)) : null;
  const currentDrought = (supp && supp.colorDrought) || 0;

  // Same honest-zero-confidence convention as computeColorReturnEstimate3B:
  // confidence only ever gets a real value once approximatelyDraws is
  // actually computed below, never as a blanket default.
  let approximatelyDraws = null;
  let confidence = 0;
  if (avgGap != null && sampleSize >= 3) {
    approximatelyDraws = Math.max(1, Math.round(avgGap - currentDrought));
    if (approximatelyDraws === 1 && currentDrought >= avgGap) {
      confidence = Math.min(85, 55 + Math.round(((currentDrought - avgGap) / Math.max(1, avgGap)) * 30));
    } else {
      confidence = Math.min(80, 45 + sampleSize * 3);
    }
  }

  return { color, sampleSize, avgGap, currentDrought, approximatelyDraws, confidence };
}

function buildNextEventLeaderboard4B(historicalDraws, suppression) {
  const classRank = s => (s === 'RECOVERING' ? 0 : s === 'SUPPRESSED' ? 1 : s === 'DORMANT' ? 2 : 3);

  const ranked = HIERARCHY.map(color => {
    const supp = suppression[color] || {};
    const est = computeColorReturnEstimate4B(historicalDraws, color, supp);
    return {
      color,
      classification: supp.classification || 'ACTIVE',
      recoveryVelocity: supp.recoveryVelocity != null ? supp.recoveryVelocity : null,
      colorDrought: est.currentDrought,
      estimatedDrawsUntilNext: est.approximatelyDraws,
      avgHistoricalGap: est.avgGap,
      sampleSize: est.sampleSize,
      confidence: est.confidence
    };
  }).sort((a, b) => {
    const aHas = a.estimatedDrawsUntilNext != null;
    const bHas = b.estimatedDrawsUntilNext != null;
    if (aHas && bHas && a.estimatedDrawsUntilNext !== b.estimatedDrawsUntilNext) {
      return a.estimatedDrawsUntilNext - b.estimatedDrawsUntilNext;
    }
    if (aHas !== bHas) return aHas ? -1 : 1;
    const rankDiff = classRank(a.classification) - classRank(b.classification);
    if (rankDiff !== 0) return rankDiff;
    return (b.colorDrought || 0) - (a.colorDrought || 0);
  });

  const summary = ranked.map(r => {
    const eta = r.estimatedDrawsUntilNext != null ? `est. ${r.estimatedDrawsUntilNext} draw(s)` : 'no estimate yet';
    return `${r.color} (${eta})`;
  }).join(' -> then ');

  return {
    ranked,
    topColor: ranked[0].color,
    summary: `Next likely: ${summary}`,
    detail: ranked.map(r =>
      `${r.color}: ${r.classification}, drought ${r.colorDrought} draw(s)` +
      (r.avgHistoricalGap != null ? `, avg historical gap ~${r.avgHistoricalGap} draws (n=${r.sampleSize})` : ', insufficient gap sample') +
      (r.estimatedDrawsUntilNext != null ? `, estimated ~${r.estimatedDrawsUntilNext} draw(s) to next hit (${r.confidence}% confidence)` : '')
    ).join(' | ')
  };
}

/**
 * Main 4SIL entry point.
 *
 * @param {Array} historicalDraws newest-first draw history (from store.getRecentDraws)
 * @param {Object} fourBallP the already-computed fourBallParliament.js result for this
 *   cycle (used ONLY for its already-derived seasonIntelligence/exitIntelligence/
 *   dynamicDominance fields -- 4SIL never reads or reacts to winningColor/confidence/
 *   secondColor from it, per the blueprint's system boundaries).
 * @param {Object} [context] optional cross-engine context from council.js: { tieIntelligence, tieClusterResult, eventIntelligence, persistentState }
 */
function evaluateFourBallSeasonIntelligenceLab(historicalDraws, fourBallP, context = {}) {
  const draws = historicalDraws || [];
  const activation = evaluateTacticalActivation(draws);
  const fourBallActivation = activation.fourBall;

  if (!fourBallActivation.active) {
    // Even with no active season, suppression/drought/gap data still
    // exists per color (evaluateSuppressionIntelligence below doesn't
    // depend on season activation) -- so the Next Event Leaderboard,
    // like its 3-ball counterpart, still has something to report here
    // instead of going silent alongside the rest of the inactive-season
    // fields.
    const inactiveSuppression = evaluateSuppressionIntelligence(draws);
    const inactiveLeaderboard = buildNextEventLeaderboard4B(draws, inactiveSuppression);
    const inactiveResult = {
      engine: '4SIL',
      active: false,
      seasonStage: { stage: 'INACTIVE', detail: 'No active 4-ball season detected.' },
      dominantColor: null,
      seasonAge: 0,
      dominanceIntelligence: null,
      transitionBattle: { active: false, battleStatus: 'INACTIVE' },
      thirdColorIntelligence: { applicable: false, thirdColor: null, behavior: null, detail: 'No active season.' },
      transitionHistory: buildTransitionHistory(draws, context.persistentState && context.persistentState.transitionArchive),
      timing: { estimatedDrawsUntilTransition: null, confidence: 0 },
      enterNow: { enterNow: false, marketReadiness: 'LOW', institutionalConfidence: 0, confirmedCount: 0, conditions: [], reasoning: 'No active 4-ball season -- 4SIL remains silent.' },
      responseCascade: { engine: '4-Ball Response/Cascade Engine', ready: false, cascadeResponse: false, reasoning: 'No active 4-ball season -- no Top color to compare against.' },
      nextEventLeaderboard: inactiveLeaderboard,
      regime: { current: 'ORDERED', detail: 'No active season to classify.' },
      knowledgeBank: buildKnowledgeBank(draws, { history: [], awake: false, dominantColor: null },
        buildBehaviorFingerprints(draws), inactiveSuppression),
      crossEngineContext: buildCrossEngineContext(context),
      badge: {
        seasonStatus: 'INACTIVE',
        dominantColor: null,
        seasonAge: 0,
        dominanceDuration: 0,
        dominanceStrength: 0,
        transitionBattleStatus: 'INACTIVE',
        estimatedDrawsUntilTransition: null,
        transitionWarning: { level: 'LOW', score: 0, reasoning: 'No active season.' },
        riskLevel: 'LOW',
        transitionProbabilityPct: 0,
        drawsUntilNextTransition: null,
        currentBattleAge: 0,
        lastTransition: null,
        detectedCycle: null,
        intervalStats: { count: 0, avgIntervalDraws: null, medianIntervalDraws: null, longestGapDraws: null, shortestGapDraws: null, mostCommonInterval: null },
        activeCluster: null,
        operatorAction: 'MONITOR',
        institutionalConfidence: 0,
        marketReadiness: 'LOW',
        enterNow: false,
        reasoning: 'No active 4-ball season -- 4SIL has nothing to time yet.',
        // Next Event Badge (4-ball) -- see buildNextEventLeaderboard4B.
        // Named nextEventDetail (not `reasoning`) so it doesn't collide
        // with the operator-action reasoning field just above, which the
        // existing full 4SIL panel (#silReasoning) already reads.
        nextEventLeaderboard: inactiveLeaderboard.ranked,
        topColor: inactiveLeaderboard.topColor,
        nextEventSummary: inactiveLeaderboard.summary,
        nextEventDetail: inactiveLeaderboard.detail,
        cascadeResponseActive: false,
        cascadeResponseDetail: 'No active 4-ball season -- no Top color to compare against.'
      }
    };
    const persistence = persistFourSILObservation(context.persistentState, draws, inactiveResult);
    inactiveResult.persistentMemory = {
      ...persistence,
      totalObservations: context.persistentState && Array.isArray(context.persistentState.observations)
        ? context.persistentState.observations.length : 0,
      totalTransitions: context.persistentState && Array.isArray(context.persistentState.transitionArchive)
        ? context.persistentState.transitionArchive.length : 0,
      totalSeasonRecords: context.persistentState && Array.isArray(context.persistentState.seasonRecords)
        ? context.persistentState.seasonRecords.length : 0,
      updatedAt: context.persistentState ? context.persistentState.updatedAt : null
    };
    return inactiveResult;
  }

  const seasonAge = fourBallActivation.reconstructedSeasonAge;

  // Dominant color: informational context only -- 4SIL reads it the same
  // way every other consumer of tactical/season data does, but never
  // scores, ranks, or votes on it.
  const counts = { RED: 0, BLUE: 0, GREEN: 0 };
  draws.forEach(d => { if (d.fourBallColor && counts[d.fourBallColor] !== undefined) counts[d.fourBallColor]++; });
  const dominantColor = argMaxColorBy(counts);

  const seasonIntel = fourBallP && fourBallP.seasonIntelligence
    ? fourBallP.seasonIntelligence
    : null;
  const exitIntel = fourBallP && fourBallP.exitIntelligence ? fourBallP.exitIntelligence : null;
  const dynamicDom = fourBallP && fourBallP.dynamicDominance ? fourBallP.dynamicDominance : null;
  const firstApp = (fourBallP && fourBallP.firstAppearance) ? fourBallP.firstAppearance : evaluateFirstAppearance(draws);
  // 4Ball Last Stand Engine -- terminal-burst signal for the incumbent
  // leader, folded into dominanceIntelligence's fatigue read and into the
  // ENTER NOW reasoning (a leader firing a last-stand burst corroborates
  // "losing structural control" independently of exitIntel's own model).
  // Reused from fourBallParliament.js's already-computed result when
  // available (it computes this for its own 4B_LastStand vote) rather
  // than recomputing -- true fusion, not duplication.
  const lastStand = (fourBallP && fourBallP.lastStand) ? fourBallP.lastStand : evaluateLastStand(draws, dominantColor, seasonAge);

  // Season stage: lifecycleEngine driven by the SAME density metric
  // Season Intelligence already computed (densityShort), rather than the
  // Parliament's own hardcoded 0.5 placeholder -- a genuine improvement
  // available here because 4SIL, unlike the Parliament, has no color vote
  // whose stability depends on staying byte-identical.
  const hitFrequency = seasonIntel ? seasonIntel.densityShort : 0.5;
  const lifecycle = computeLifecycle(seasonAge, hitFrequency, fourBallActivation.consecutiveNoHitCount);

  const { archiveState, cpDraws } = replaySeasonAndArchive(draws);
  const seasonStage = classifySeasonStage(lifecycle, archiveState, dominantColor);

  // BUGFIX (this pass): was calling computeFourBallBattle(draws, ...) with
  // raw Sniper-native draws (newest-first, .fourBallColor field). That
  // engine's internal computeColorMomentum()/computeColorRanking() (see
  // threeBallLastStandCP.js) check `d.color` and iterate assuming
  // oldest-first order -- so every draw silently matched nothing,
  // recent5Score was always 0, and fatigueIndex was always 'Exhausted'
  // for every color. replaySeasonAndArchive() already builds and returns
  // exactly the right shape for this (cpDraws) -- its own docstring says
  // so explicitly. Passing cpDraws instead makes battle-status escalation
  // (LEADER_WEAKENING -> LAST_STAND/TRANSITION_BATTLE -> LEADER_COLLAPSING)
  // actually work.
  const battle = computeFourBallBattle(cpDraws, archiveState);
  const rivalPressure = evaluateRivalPressure(draws);
  const behaviorProfiles = buildBehaviorFingerprints(draws);
  const suppression = evaluateSuppressionIntelligence(draws);

  const thirdColorIntel = evaluateThirdColorIntelligence(battle, rivalPressure, suppression);

  // Transition History Intelligence -- the empirical "how many draws per
  // transition battle before a new leader takes over" record, built fresh
  // from historicalDraws every call (same convention as tieEngine.js).
  const transitionHistory = buildTransitionHistory(draws, context.persistentState && context.persistentState.transitionArchive);

  // 4-Ball-specific regime detection (Shannon entropy over 4-ball hits in
  // the recent window) -- distinct from metaIntelligence.js's 3-ball
  // regime read, reusing the same shared entropy utility.
  const recent20 = draws.slice(0, 20);
  const fourBallCounts20 = { RED: 0, BLUE: 0, GREEN: 0 };
  recent20.forEach(d => { if (d.fourBallColor && fourBallCounts20[d.fourBallColor] !== undefined) fourBallCounts20[d.fourBallColor]++; });
  const entropyData = calculateShannonEntropy(fourBallCounts20);
  const regime = {
    current: entropyData.marketRegime,
    normalizedEntropy: entropyData.normalizedEntropy,
    detail: `4-Ball activity distribution over the last ${recent20.length} draws classifies as ${entropyData.marketRegime} (normalized entropy ${entropyData.normalizedEntropy}).`
  };

  // Timing analysis: draws remaining before a likely transition. Prefers
  // the empirical Transition History record (this market's own measured
  // cycle length, same rigor as tieEngine's detectedCycle) when a cycle
  // has actually been detected; falls back to the Color Parliament battle
  // port's own estimate (ballsBeforeExit), then to an exit-probability
  // heuristic, in that order.
  let estimatedDrawsUntilTransition = null;
  let timingConfidence = 0;
  if (transitionHistory.drawsUntilNextTransition != null) {
    estimatedDrawsUntilTransition = transitionHistory.drawsUntilNextTransition;
    timingConfidence = transitionHistory.transitionWarning.score;
  } else if (battle.active && battle.ballsBeforeExit != null) {
    estimatedDrawsUntilTransition = battle.ballsBeforeExit;
    timingConfidence = battle.lastStandProbability;
  } else if (exitIntel) {
    estimatedDrawsUntilTransition = Math.max(1, Math.round(15 * (1 - exitIntel.exitProbability / 100)));
    timingConfidence = exitIntel.exitProbability;
  }

  // AUDIT FIX (item 5 ordering): knowledgeBank is now computed BEFORE
  // evaluateEnterNow (previously it was computed after, so
  // HISTORICAL_PATTERN_MATCH could never see it) so condition E below
  // can corroborate rivalPressure's releaseProbability against the
  // Knowledge Bank's own per-color behavioral library.
  const knowledgeBank = buildKnowledgeBank(draws, archiveState, behaviorProfiles, suppression);

  // Response/Cascade Engine -- see fourBallResponseCascadeEngine.js. Only
  // needs draws + dominantColor (the Top color), both already available.
  const responseCascade = evaluateFourBallResponseCascade(draws, dominantColor);

  const enterNowResult = evaluateEnterNow({
    battle,
    dynamicDom: dynamicDom || { challengerTakeover: false, rollingLeaderShort: dominantColor, rollingLeaderLong: dominantColor, challenger: null },
    firstApp,
    exitIntel: exitIntel || { exitProbability: 0 },
    thirdColorIntel,
    rivalPressure,
    lastStand,
    transitionHistory,
    knowledgeBank,
    draws,
    // Entry Accuracy System feedback (see entryAccuracyEngine.js /
    // entryConditionScorecard.js) -- undefined on every call site that
    // doesn't explicitly pass context.thresholdAdjustment, which
    // reproduces the exact original fixed-constant behavior.
    thresholdAdjustment: context.thresholdAdjustment || null,
    responseCascade,
    // Condition L (REPEATED_TIE_CLUSTER) previously read context.
    // tieIntelligence (analyzeTies()'s loose currentTieStreak/
    // tieFrequencyScore signals) directly. TIGHTENED per operator
    // direction: now reads context.tieClusterResult instead --
    // fourBallTieClusterEngine.js's output, computed by council.js from
    // fourBallTieBirthEngine.js's Tie-Birth Score and requiring two
    // DISTINCT Strong Ties within a rolling window before the condition
    // can be met. tieIntelligence itself is left wired through unchanged
    // below and elsewhere in this file for the display/badge purposes it
    // already served -- only condition L's source of truth changed.
    tieIntelligence: context.tieIntelligence || null,
    tieClusterResult: context.tieClusterResult || null
  });

  const crossEngineContext = buildCrossEngineContext(context);

  const dominanceIntelligence = {
    duration: seasonAge,
    strength: seasonIntel ? seasonIntel.heat : null,
    momentum: seasonIntel ? seasonIntel.velocity : null,
    stability: battle.active ? battle.leaderStrength : null,
    fatigueProgression: seasonIntel ? seasonIntel.decay : null,
    recoveryCapability: seasonIntel ? seasonIntel.recovery : null,
    classification: seasonIntel ? seasonIntel.classification : null,
    terminalBurstDetected: lastStand.isLastStand,
    terminalBurstConfidence: lastStand.confidence
  };

  // Operator Action -- mirrors the Tie Engine badge's MONITOR/etc field
  // exactly: a single at-a-glance verb summarizing what 4SIL wants the
  // operator to do right now.
  const operatorAction = enterNowResult.enterNow
    ? 'ENTER NOW'
    : (transitionHistory.transitionWarning.level === 'HIGH'
        || enterNowResult.marketReadiness === 'HIGH'
        || battle.battleStatus === 'LEADER_COLLAPSING'
        || battle.battleStatus === 'TRANSITION_BATTLE')
      ? 'PREPARE'
      : 'MONITOR';

  // Next Event Leaderboard (4-ball) -- see buildNextEventLeaderboard4B's
  // header above. Native 4-ball read: built from suppression, which was
  // already computed against this market's own fourBallColor gap history.
  const nextEventLeaderboard = buildNextEventLeaderboard4B(draws, suppression);

  const badge = {
    // Season / dominance block
    seasonStatus: seasonStage.stage,
    dominantColor,
    seasonAge,
    dominanceDuration: seasonAge,
    dominanceStrength: dominanceIntelligence.strength,
    // Transition battle block
    transitionBattleStatus: battle.active ? battle.battleStatus : 'INACTIVE',
    estimatedDrawsUntilTransition,
    // Transition History block -- mirrors tieEngine's badge fields 1:1:
    // Tie Warning -> Transition Warning, Tie Probability -> Transition
    // Probability, Draws Until Next Tie -> Draws Until Next Transition,
    // Current Streak -> Current Battle Age, Last Tie -> Last Transition.
    transitionWarning: transitionHistory.transitionWarning,
    riskLevel: transitionHistory.transitionWarning.level === 'HIGH' ? 'VERY HIGH'
      : transitionHistory.transitionWarning.level === 'ELEVATED' ? 'HIGH' : 'MODERATE',
    transitionProbabilityPct: transitionHistory.transitionProbability.nextDrawPct,
    drawsUntilNextTransition: transitionHistory.drawsUntilNextTransition,
    currentBattleAge: transitionHistory.currentBattleAge,
    lastTransition: transitionHistory.lastTransition,
    detectedCycle: transitionHistory.detectedCycle,
    intervalStats: transitionHistory.intervalStats,
    activeCluster: transitionHistory.activeCluster,
    // Institutional decision block
    operatorAction,
    institutionalConfidence: enterNowResult.institutionalConfidence,
    marketReadiness: enterNowResult.marketReadiness,
    enterNow: enterNowResult.enterNow,
    reasoning: enterNowResult.reasoning,
    // Next Event Badge (4-ball) -- continuous per-color ranking, direct
    // counterpart to 3SIL's badge.topColor / nextEventLeaderboard /
    // nextEventSummary. nextEventDetail (not `reasoning`) so it doesn't
    // collide with the operator-action reasoning field just above.
    nextEventLeaderboard: nextEventLeaderboard.ranked,
    topColor: nextEventLeaderboard.topColor,
    nextEventSummary: nextEventLeaderboard.summary,
    nextEventDetail: nextEventLeaderboard.detail,
    // Response/Cascade block -- see fourBallResponseCascadeEngine.js.
    cascadeResponseActive: responseCascade.cascadeResponse,
    cascadeResponseDetail: responseCascade.reasoning
  };

  const result = {
    engine: '4SIL',
    active: true,
    seasonStage,
    dominantColor,
    seasonAge,
    dominanceIntelligence,
    transitionBattle: battle,
    transitionHistory,
    lastStand,
    thirdColorIntelligence: thirdColorIntel,
    timing: { estimatedDrawsUntilTransition, confidence: timingConfidence },
    enterNow: enterNowResult,
    responseCascade,
    nextEventLeaderboard,
    regime,
    knowledgeBank,
    crossEngineContext,
    badge
  };

  const persistence = persistFourSILObservation(context.persistentState, draws, result);
  result.persistentMemory = {
    ...persistence,
    totalObservations: context.persistentState && Array.isArray(context.persistentState.observations)
      ? context.persistentState.observations.length : 0,
    totalTransitions: context.persistentState && Array.isArray(context.persistentState.transitionArchive)
      ? context.persistentState.transitionArchive.length : 0,
    totalKnowledgeSnapshots: context.persistentState && Array.isArray(context.persistentState.knowledgeSnapshots)
      ? context.persistentState.knowledgeSnapshots.length : 0,
    totalSeasonRecords: context.persistentState && Array.isArray(context.persistentState.seasonRecords)
      ? context.persistentState.seasonRecords.length : 0,
    lastProcessedDrawId: context.persistentState ? context.persistentState.lastProcessedDrawId : null,
    updatedAt: context.persistentState ? context.persistentState.updatedAt : null
  };

  return result;
}

// Cross-Engine Intelligence Fusion (blueprint section): lightweight,
// read-only synthesis of the Tie Engine and Unified Event Voice
// (eventIntelligenceEngineCP) outputs already computed by council.js this
// cycle -- 4SIL does not recompute either, only references them for
// context in its own reasoning.
function buildCrossEngineContext(context) {
  const tie = context.tieIntelligence || null;
  const events = context.eventIntelligence || null;
  return {
    tieMarketVolatility: tie ? (tie.tieWarning ? tie.tieWarning.level : null) : null,
    tieNote: tie
      ? `3-Ball Tie Engine reports ${tie.tieWarning ? tie.tieWarning.level : 'LOW'} tie risk -- elevated tie activity signals broader color-competition volatility across the platform.`
      : 'Tie Engine data unavailable this cycle.',
    recentEventCount: events && Array.isArray(events.recentEvents) ? events.recentEvents.length : (events && events.eventLog ? events.eventLog.length : null),
    eventNote: events ? 'Unified Event Voice intelligence available for cross-reference.' : 'Event Intelligence data unavailable this cycle.'
  };
}

module.exports = {
  ENTER_NOW_MIN_CONFIRMATIONS,
  ENTER_NOW_MIN_CONFIDENCE,
  classifySeasonStage,
  evaluateThirdColorIntelligence,
  buildTransitionHistory,
  evaluateEnterNow,
  buildKnowledgeBank,
  persistFourSILObservation,
  buildNextEventLeaderboard4B,
  evaluateFourBallSeasonIntelligenceLab
};
