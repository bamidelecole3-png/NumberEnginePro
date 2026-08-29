/**
 * Supreme Council Orchestrator module with Meta-Intelligence Integration.
 */
const { runGeneralParliament } = require('../parliaments/generalParliament');
const { runFourBallParliament } = require('../parliaments/fourBallParliament');
const { analyzeTies } = require('../engines/tieEngine');
const { evaluateTiePrecursorPatterns } = require('../engines/tiePrecursorPatternEngine');
const { analyzeThreeBallColor } = require('../engines/threeBallColorEngine');
const { runEventIntelligence } = require('../engines/eventIntelligenceEngineCP');
const { evaluateFourBallSeasonIntelligenceLab } = require('../engines/fourBallSeasonIntelligenceLab');
const { evaluateFourBallTieBirth } = require('../engines/fourBallTieBirthEngine');
const { evaluateFourBallTieCluster } = require('../engines/fourBallTieClusterEngine');
const { recordUnifiedAuditEntry } = require('../engines/fourSilUnifiedAuditLog');
const { evaluateThreeBallSeasonIntelligenceLab } = require('../engines/threeBallSeasonIntelligenceLab');
const { evaluateEntryTimingIntervals } = require('../engines/entryTimingIntervalEngine');
const { buildEntryConditionScorecard, recordConditionObservation, MIN_SAMPLES_FOR_TRUST } = require('../engines/entryConditionScorecard');
const { evaluateEntryAccuracy } = require('../engines/entryAccuracyEngine');
const { evaluateEntryHitCounter } = require('../engines/entryHitCounter');
const { evaluateThreeBallEntryHitCounter } = require('../engines/threeBallEntryHitCounter');
const { evaluateThreeBallNextEventHitCounter } = require('../engines/threeBallNextEventHitCounter');
const { evaluateTierOverduePrecursorHitCounter } = require('../engines/tierOverduePrecursorHitCounter');
const { arbitrateDecisions } = require('./arbitration');
const { evaluateMetaIntelligence } = require('./metaIntelligence');
const { applyCalibration } = require('../core/isotonic');
const { store } = require('../core/store');
const { advancePaperTrader } = require('../engines/paperTraderEngine');

/**
 * Derives 4SIL's optional gate threshold nudge from the condition
 * scorecard's AGGREGATE read -- deliberately a single conservative signal
 * (not per-condition) so this can't be gamed by any one condition's
 * noisy small sample: if the scorecard has enough total graded history
 * and shows the gate's confirmed conditions have recently been running
 * WEAK more than STRONG, nudge the confidence bar up slightly (make the
 * gate a bit more conservative); if predominantly STRONG, nudge it down
 * slightly (the gate is being too conservative given how well its
 * confirmed conditions have actually performed). Returns null (no
 * adjustment) until there's enough scorecard evidence to justify moving
 * anything -- see entryAccuracyEngine.js's header for the full rationale.
 */
function deriveThresholdAdjustment(scorecard) {
  if (!scorecard || scorecard.totalObservationsWithConditionData < MIN_SAMPLES_FOR_TRUST) return null;
  const graded = (scorecard.conditions || []).filter(c => c.verdict === 'STRONG' || c.verdict === 'WEAK');
  if (graded.length === 0) return null;

  const strongCount = graded.filter(c => c.verdict === 'STRONG').length;
  const weakCount = graded.filter(c => c.verdict === 'WEAK').length;
  const strongShare = strongCount / graded.length;
  const weakShare = weakCount / graded.length;

  if (weakShare >= 0.6) {
    return { confidenceDelta: 5, confirmationsDelta: 0, reason: `${Math.round(weakShare * 100)}% of graded conditions are WEAK -- tightening confidence bar.` };
  }
  if (strongShare >= 0.6) {
    return { confidenceDelta: -5, confirmationsDelta: 0, reason: `${Math.round(strongShare * 100)}% of graded conditions are STRONG -- easing confidence bar.` };
  }
  return null;
}

function runSupremeCouncil() {
  const historicalDraws = store.getRecentDraws(100);

  // Tie Intelligence -- 3-Ball market ONLY, per the clarified upgrade spec.
  // Recomputed fresh every cycle from historicalDraws, same convention as
  // the 5-ball lab. The 4-Ball engine does not experience the same
  // color-dominance ambiguity (it resolves via its own 4-of-6 methodology)
  // and deliberately has no tie concept at all -- see tieEngine.js's header.
  // Recommendation #2: build empirical calibration data from prior scored
  // forecasts BEFORE computing this cycle's forecast, so the probability
  // this cycle reports is itself calibrated against real history (not
  // just logged for some future cycle to use).
  const tierCalibrationData = store.buildTierCalibrationData();
  const tieP = analyzeTies(historicalDraws, tierCalibrationData);
  store.tieIntelligence = tieP;

  // Recommendation #1: log this cycle's forecast for the NEXT draw so
  // evaluateAndLearn() can grade it once that draw arrives. Recorded
  // against the most recent draw actually in history right now (i.e.
  // "this forecast was made with knowledge up through draw X"). Computed
  // once here and reused below for the Tie Precursor Pattern Engine's own
  // forecast log entry, since both are logged from the same
  // historicalDraws snapshot this cycle.
  const madeAfterDrawId = historicalDraws[0] ? historicalDraws[0].drawId : null;
  store.recordTierForecast(tieP, madeAfterDrawId);

  // Tie Precursor Pattern Engine -- second, independent layer on top of
  // the Tie Intelligence Engine above. Does not read tieP or feed back
  // into it; pure recompute from historicalDraws same as tieP itself.
  // See tiePrecursorPatternEngine.js's header.
  //
  // Closed-loop follow-up: build this engine's OWN calibration data from
  // its OWN scored forecast log (store.tiePrecursorForecastLog) BEFORE
  // computing this cycle's read, same ordering as tierCalibrationData
  // above -- so the score reported this cycle is itself calibrated
  // against real history, not just logged for some future cycle to use.
  const precursorCalibrationData = store.buildTiePrecursorCalibrationData();
  const tiePrecursor = evaluateTiePrecursorPatterns(historicalDraws, precursorCalibrationData, precursorCalibrationData);
  // Log this cycle's forecast for the NEXT draw so
  // scoreTiePrecursorForecast() (called from evaluateAndLearn()) can
  // grade it once that draw arrives.
  store.recordTiePrecursorForecast(tiePrecursor, madeAfterDrawId);

  // Tier Engine Overdue/Precursor Hit Counter -- the Tier Engine's own
  // OVERDUE (tieP.drawsUntilNextTie === 0) and PRECURSOR
  // (tiePrecursor.prediction.unifiedSignal.active) calls, scored against
  // whether a 3-ball tie actually lands within an 8-draw window,
  // mirroring threeBallEntryHitCounter.js's mechanics exactly. Run
  // immediately after both tieP and tiePrecursor are available (same
  // ordering discipline as 3SIL's own hit counter, computed right after
  // its parent engine). See tierOverduePrecursorHitCounter.js's header.
  const tierOverduePrecursorHitCounter = evaluateTierOverduePrecursorHitCounter(historicalDraws, tieP, tiePrecursor, store.tierOverduePrecursorHitCounter);

  // Event Intelligence -- 4-Ball engine only, ported from Color Parliament.
  // Unlike tieIntelligence, this mutates store.eventIntelligence in place
  // rather than replacing it wholesale (see eventIntelligenceEngineCP.js's
  // header for why its Event Memory / pending-resolution state can't be a
  // pure recompute-from-history function).
  const eventIntel = runEventIntelligence();

  const generalP = runGeneralParliament(historicalDraws, tieP);
  const fourBallP = runFourBallParliament(historicalDraws);

  // 3BALL SEASON INTELLIGENCE LAB (3SIL) -- mirrors 4SIL's architecture
  // for the 3-ball market. Strictly downstream of generalP: it consumes
  // generalP only as read-only context and never reads or reacts to its
  // winningColor/confidence/secondColor, per the 3SIL blueprint's system
  // boundary ("3SIL must never answer 'X is predicted because 3SIL
  // calculated it' -- the existing engine remains responsible for that").
  // Purely observational -- it does not vote, does not appear in
  // generalP.votes[], and does not feed back into arbitration/
  // metaIntelligence below. Deliberately simpler than 4SIL's call: no
  // thresholdAdjustment/entry-scorecard feedback loop is wired in, since
  // the 3SIL blueprint scopes 3SIL to a fully independent parallel timing
  // layer without that 4-ball-specific refinement.
  const threeSIL = evaluateThreeBallSeasonIntelligenceLab(historicalDraws, generalP, {
    tieIntelligence: tieP,
    eventIntelligence: eventIntel,
    persistentState: store.threeBallSILMemory
  });

  // 3-Ball Entry Hit Counter -- 3SIL's OLD ENTER-call scoring log,
  // mirroring entryHitCounter.js's mechanics but watching a single
  // challenger-color pick over an 8-draw window instead of 4SIL's
  // dual-pick 10-draw window. See threeBallEntryHitCounter.js's header.
  // RETIRED as 3SIL's badge scoring mechanism (superseded by
  // threeBallNextEventHitCounter below) -- still computed and still
  // exposed on the response payload below so any already-accumulated
  // history keeps showing on the frontend card, but it no longer reads
  // a live gate: badge.enterNow was removed from 3SIL's badge when the
  // Next Event Leaderboard replaced it, so this call will simply stop
  // opening new watches going forward (gateOpen permanently false) while
  // any watch already pending from before this change still resolves
  // normally. Run immediately after threeSIL (same ordering discipline
  // as 4SIL's entryHitCounter, computed right after its parent engine).
  const threeBallEntryHitCounter = evaluateThreeBallEntryHitCounter(historicalDraws, threeSIL, store.threeBallEntryHitCounter);

  // 3-Ball Next Event Hit Counter -- 3SIL's current ENTER-call scoring
  // log, scoring the Next Event Leaderboard's badge.topColor
  // continuously (every cycle, no gate) instead of the old binary ENTER
  // condition threeBallEntryHitCounter above watched. See
  // threeBallNextEventHitCounter.js's header. Run immediately after
  // threeBallEntryHitCounter (same ordering discipline).
  const threeBallNextEventHitCounter = evaluateThreeBallNextEventHitCounter(historicalDraws, threeSIL, store.threeBallNextEventHitCounter);

  // 3-Ball Color Hit Intelligence -- Tier-Engine-depth timing/statistics
  // for the General Parliament's own predicted color (winningColor),
  // computed fresh every cycle from historicalDraws exactly like
  // tieIntelligence above. See threeBallColorEngine.js's header for why
  // this replaced the old Entry Intelligence panel's noisier metrics.
  const threeBallColorIntel = analyzeThreeBallColor(historicalDraws, generalP.winningColor);

  // Entry Condition Scorecard -- built from store.entryTimingLog exactly
  // as it stood at the END of the PREVIOUS cycle (this cycle's own
  // observation hasn't been logged yet; that happens below via
  // evaluateEntryTimingIntervals). This ordering is required, not
  // incidental: computing the scorecard before 4SIL runs this cycle is
  // what lets its aggregate verdict feed INTO this cycle's 4SIL gate via
  // thresholdAdjustment below, without ever being circular (no
  // observation ever grades itself). See entryConditionScorecard.js.
  //
  // currentConditionDefs is sourced from the MOST RECENT logged
  // observation's own gateConditions (last cycle's condition list, which
  // carries each condition's id+weight) rather than re-deriving it from
  // scratch here -- keeps this file from needing to know 4SIL's condition
  // IDs at all. Falls back to null (scorecard shows designWeight: null
  // for everything) on a cold start with no prior observations yet.
  const mostRecentObservation = store.entryTimingLog && Array.isArray(store.entryTimingLog.observations)
    ? store.entryTimingLog.observations[0] : null;
  const currentConditionDefs = mostRecentObservation && Array.isArray(mostRecentObservation.gateConditions)
    ? mostRecentObservation.gateConditions : null;
  const scorecard = buildEntryConditionScorecard(store.entryTimingLog, currentConditionDefs);
  const thresholdAdjustment = deriveThresholdAdjustment(scorecard);

  // 4-BALL TIE-BIRTH ENGINE (pre-pass) -- normally this engine only needs
  // to run AFTER 4SIL, since its only use of 4SIL's own output is a
  // read-only "is 4SIL currently armed" flag (fourSIL.badge.enterNow) that
  // purely affects its own armedBonus scoring term and TIE_WATCH/
  // TIE_TRIGGER regime label. TIGHTENING condition L (REPEATED_TIE_CLUSTER,
  // see fourBallTieClusterEngine.js) now needs a Tie-Birth reading BEFORE
  // 4SIL runs, so this pre-pass breaks that circularity by calling
  // evaluateFourBallTieBirth with a conservative "not armed" stand-in
  // instead of the real (not-yet-computed) fourSIL. This is a safe
  // conservative choice, not a guess: the armed flag only ever ADDS a
  // flat +15 points to the Tie-Birth Score and only flips the regime
  // label between TIE_WATCH/TIE_TRIGGER (see fourBallTieBirthEngine.js's
  // computeTieBirthScore) -- it never changes tieAge, tieType, or any of
  // the empirical Tie->4-ball statistics isStrongTie() actually
  // thresholds against, so a Strong Tie call made without the armed bonus
  // is, if anything, slightly MORE conservative (harder to qualify as
  // Strong) than the real armed state would produce, never less. The
  // REAL fourBallTieBirth reading (with the actual armed flag) is still
  // computed after 4SIL below, unchanged, for accurate dashboard display.
  const fourBallTieBirthPrePass = evaluateFourBallTieBirth(historicalDraws, { badge: { enterNow: false } });

  // 4-BALL TIE CLUSTER ENGINE -- see fourBallTieClusterEngine.js's header.
  // Persistent (store.fourBallTieClusterMemory, mutated in place, same
  // convention as store.fourBallSILMemory below). Computed BEFORE 4SIL so
  // its tieVoteActive reading can feed condition L.
  const fourBallTieCluster = evaluateFourBallTieCluster(historicalDraws, fourBallTieBirthPrePass, store.fourBallTieClusterMemory);

  // 4BALL SEASON INTELLIGENCE LAB (4SIL) -- SNIPER_V4 PRO v7.2.
  // Institutional market-TIMING engine, strictly downstream of
  // fourBallP: it consumes fourBallP's already-computed season/exit/
  // dominance intelligence but never reads or reacts to its
  // winningColor/confidence/secondColor, per the blueprint's system
  // boundary ("4SIL must never predict, recommend, rank, or override
  // color selection"). Purely observational -- it does not vote and does
  // not feed back into arbitration/metaIntelligence below.
  //
  // thresholdAdjustment is the Entry Accuracy System's evidence-based
  // feedback (see deriveThresholdAdjustment above) -- optional and
  // narrowly capped inside evaluateEnterNow(); 4SIL's own condition
  // detection logic is completely unchanged by this.
  const fourSIL = evaluateFourBallSeasonIntelligenceLab(historicalDraws, fourBallP, {
    tieIntelligence: tieP,
    eventIntelligence: eventIntel,
    persistentState: store.fourBallSILMemory,
    thresholdAdjustment,
    // Condition L (REPEATED_TIE_CLUSTER) -- see fourBallTieClusterEngine.js
    // and the pre-pass comment above for why this is computed before 4SIL.
    tieClusterResult: fourBallTieCluster
  });

  // 4SIL Paper Trader Engine -- consumes ONLY 4SIL's own signal (never
  // fourBallP's picks/colors) plus this cycle's already-current
  // historicalDraws to paper-trade the fixed RED+BLUE+GREEN ladder
  // strategy. Runs synchronously right here, in the SAME council cycle
  // that just computed fourSIL for the current draw -- this is the fix
  // for the earlier one-draw-stale bug, where a separate ON_DRAW_INGESTED
  // bus handler read store.cachedSystemState (the PREVIOUS cycle's
  // snapshot, since that cache is only overwritten by the caller AFTER
  // publishing the event) instead of the state actually computed for the
  // draw that just landed. Being inline here means it always sees the
  // exact same fourSIL/historicalDraws this entire snapshot is built
  // from -- there is no cache to go stale. Purely an evaluation consumer;
  // its output is never read back into fourSIL or any gate/weight above
  // (ABSOLUTE SEPARATION RULE, blueprint §40). Mutates store.paperTrader
  // in place (ensureStateShape's own convention), same as
  // fourSilHitAverage above.
  const paperTrader = advancePaperTrader(historicalDraws, fourSIL, store.paperTrader);


  // 4-BALL TIE-BIRTH ENGINE (real pass) -- implements ONLY the Tie section
  // of the 4SIL upgrade blueprint (Event Density/Repeat/Response-Cascade/
  // Transition/Fast-Track are explicitly out of scope, per operator
  // direction). Purely additive and observational: reads fourSIL.badge.
  // enterNow ONLY as a read-only "is 4SIL currently armed" signal for
  // the Tie Watch vs Tie Trigger distinction -- never writes back into
  // fourSIL, never alters its ENTER NOW decision or thresholds, and does
  // not vote or feed arbitration/metaIntelligence below. This is the
  // SAME call this codebase already made every cycle prior to this
  // upgrade; only the new pre-pass above (fourBallTieBirthPrePass) and
  // the Tie Cluster Engine are new. See fourBallTieBirthEngine.js's
  // header for the full design rationale.
  const fourBallTieBirth = evaluateFourBallTieBirth(historicalDraws, fourSIL);

  // 4SIL UPGRADE BLUEPRINT §21 -- unified per-event audit log. Called
  // LAST among the 4-ball intelligence engines, once 4SIL, the real
  // Tie-Birth reading, and the Tie Cluster reading are all available for
  // this cycle -- a pure read-only observer, see
  // fourSilUnifiedAuditLog.js's header for why this is a genuinely
  // different log than fourBallTieClusterMemory's strongTieLog (that one
  // only records Strong Ties with 4 fields for its own vote-confirmation
  // purpose; this one records EVERY real draw with full cross-engine
  // context).
  recordUnifiedAuditEntry(store.fourSilUnifiedAuditLog, historicalDraws, fourSIL, fourBallTieBirth, fourBallTieCluster);

  // Log this cycle's condition observation now that 4SIL has run --
  // grades the PREVIOUS cycle's pending gate/conditions against the draw
  // that just landed, then stashes THIS cycle's fresh gate state as
  // pending for next cycle. This is entryConditionScorecard.js's own
  // persistent log now (store.entryTimingLog) -- fully decoupled from
  // Entry Timing Interval Engine, which no longer gates on 4SIL at all.
  const latestDraw = historicalDraws[0];
  const currentGateOpen = Boolean(fourSIL && fourSIL.badge && fourSIL.badge.enterNow);
  const currentGateDetail = fourSIL && fourSIL.enterNow && Array.isArray(fourSIL.enterNow.conditions)
    ? fourSIL.enterNow.conditions : null;
  recordConditionObservation(store.entryTimingLog, latestDraw, currentGateOpen, fourBallP.active ? fourBallP.winningColor : null, currentGateDetail);

  // Entry Timing Interval Engine -- pure, ungated recompute from
  // historicalDraws + fourBallP every cycle, mirroring
  // threeBallEntryIntelligenceEngine.js / entryIntelligenceEngine.js
  // exactly for the 4-Ball Parliament's 1st and 2nd pick colors. No 4SIL
  // dependency, no persistent log. See entryTimingIntervalEngine.js.
  const entryTiming = evaluateEntryTimingIntervals(historicalDraws, fourBallP);

  // Entry Accuracy Engine -- tiered STRIKE/ENTER/WATCH/STAND_DOWN
  // classification plus the live retreat monitor, built on top of the
  // scorecard computed above and this cycle's fresh 4SIL/entryTiming
  // output. See entryAccuracyEngine.js.
  const entryAccuracy = evaluateEntryAccuracy(fourSIL, fourBallP, entryTiming, scorecard);

  // Entry Hit Counter -- simple running hit/miss totals for 4SIL's
  // ENTER calls, watching the 4-Ball Parliament's 1st and 2nd pick
  // colors independently (see entryHitCounter.js's header). Replaces
  // the old Entry Accuracy Ladder. Runs off 4SIL/fourBallP directly
  // rather than entryAccuracy, since it counts raw ENTER calls, not
  // Entry Accuracy's own tiered STRIKE/ENTER/WATCH/STAND_DOWN calls.
  const entryHitCounter = evaluateEntryHitCounter(historicalDraws, fourBallP, fourSIL, store.entryHitCounter);

  // Enrich every engine vote with real weight/precision-derived status/last-hit
  // data from the store. Without this, the dashboard's engine cards would
  // silently show identical fallback placeholders (weight 1.0, status
  // Healthy, "1 draw ago") for all 34 engines regardless of real performance.
  const enrichVotes = (parliamentResult) => {
    if (!parliamentResult || !Array.isArray(parliamentResult.votes)) return;
    parliamentResult.votes.forEach(vote => {
      const stat = store.engineStats[vote.name] || {};
      vote.weight = store.engineWeights[vote.name] != null
        ? Math.round(store.engineWeights[vote.name] * 100) / 100
        : 1.0;
      vote.risk = vote.risk || (vote.confidence >= 75 ? 'LOW' : vote.confidence >= 55 ? 'MODERATE' : 'HIGH');
      vote.status = stat.precision >= 0.8 ? 'Healthy' : stat.precision >= 0.6 ? 'Watching' : 'Sleeping';
      vote.lastHit = stat.lastActivation
        ? new Date(stat.lastActivation).toLocaleTimeString()
        : 'No activations yet';
    });
  };
  enrichVotes(generalP);
  enrichVotes(fourBallP);
  const arbitration = arbitrateDecisions(generalP, fourBallP);
  const metaIntel = evaluateMetaIntelligence(generalP, fourBallP, historicalDraws, arbitration);

  const calibratedConfidence = applyCalibration(metaIntel.metaConfidence, 85);
  const basedOnDrawId = latestDraw ? latestDraw.drawId : 'NONE';

  const decisionTrace = [
    {
      step: 'Ingest',
      details: `${historicalDraws.length} historical draws in window; most recent Draw #${basedOnDrawId}.`
    },
    {
      step: 'General Parliament (3Ball)',
      details: generalP.active
        ? `${generalP.votes.length} engines voted, winning color ${generalP.winningColor} (2nd: ${generalP.secondColor}) at ${generalP.confidence}% confidence.`
        : 'No active 3-ball signal this cycle.'
    },
    {
      step: '4Ball Parliament',
      details: fourBallP.active
        ? `Season active (age ${fourBallP.seasonAge} draws), ${fourBallP.votes.length} engines voted, winning color ${fourBallP.winningColor} (2nd: ${fourBallP.secondColor}) at ${fourBallP.confidence}% confidence.`
        : (fourBallP.status || 'No active 4-ball season detected.')
    },
    {
      step: '4SIL (Season Intelligence Lab -- market timing)',
      details: fourSIL.active
        ? `Season stage ${fourSIL.seasonStage.stage}, battle status ${fourSIL.transitionBattle.battleStatus || 'INACTIVE'}. ENTER NOW: ${fourSIL.enterNow.enterNow ? 'YES' : 'NO'} (${fourSIL.enterNow.confirmedCount}/${fourSIL.enterNow.conditions ? fourSIL.enterNow.conditions.length : 10} conditions, ${fourSIL.enterNow.institutionalConfidence}% institutional confidence, readiness ${fourSIL.enterNow.marketReadiness}).`
        : '4SIL silent -- no active 4-ball season to time.'
    },
    {
      step: 'Entry Timing Interval Engine',
      details: entryTiming.active
        ? `Tracking ${entryTiming.trackedFirstColor || '--'} (1st pick, tier ${entryTiming.firstColor.tier}, streak ${entryTiming.firstColor.entryStreak})${entryTiming.secondColor ? ` and ${entryTiming.trackedSecondColor || '--'} (2nd pick mirror, tier ${entryTiming.secondColor.tier}, streak ${entryTiming.secondColor.entryStreak})` : ''} -- ${entryTiming.reasoning}`
        : 'No active 4-ball season -- Entry Timing Interval Engine in standby.'
    },
    {
      step: 'Entry Hit Counter',
      details: entryHitCounter.totalEnterCalls > 0
        ? `${entryHitCounter.totalEnterCalls} ENTER call(s) so far. 1st pick: ${entryHitCounter.firstPick.hits} hit / ${entryHitCounter.firstPick.misses} missed. 2nd pick: ${entryHitCounter.secondPick.hits} hit / ${entryHitCounter.secondPick.misses} missed.`
        : 'No ENTER call has fired yet.'
    },
    {
      step: 'Tier Intelligence (3-Ball only)',
      details: (() => {
        // Market-state-first reporting: answer the four operator questions
        // directly, then append the supporting stats.
        const ms = tieP.marketStateLabel || 'ACCUMULATING';
        const oa = tieP.operatorAction   || 'NEUTRAL';
        const du = tieP.drawsUntilNextTie;
        const duText = du === 0
          ? 'Tie OVERDUE.'
          : du !== null
            ? `~${du} draw(s) until next expected tie.`
            : 'Not enough history to project next tie.';
        const seasonText = tieP.activeSeason
          ? `Active tie season: ${tieP.activeSeason.tieCount} ties across last ${tieP.activeSeason.spanDraws} draws (most recent ${tieP.activeSeason.mostRecentTieDrawsAgo} draw(s) ago).`
          : `No active tie season. ${tieP.totalTies} ties in ${tieP.sampleSize} tracked draws.`;
        const alertText = tieP.tiePrediction.alert ? ` ${tieP.tiePrediction.alert}` : '';
        return `Market State: ${ms} | Operator: ${oa}. ${duText} ${seasonText}${alertText}`;
      })()
    },
    {
      step: 'Tie Precursor Pattern Engine (3-Ball second layer)',
      details: tiePrecursor.sufficientHistory
        ? tiePrecursor.prediction.reasoning
        : tiePrecursor.reasoning
    },
    {
      step: 'Arbitration',
      details: `Consensus type: ${arbitration.consensus}. Disagreement index: ${arbitration.disagreementIndex}. Unanimous: ${arbitration.isUnanimous ? 'yes' : 'no'}.`
    },
    {
      step: 'Meta-Intelligence',
      details: `Market regime classified as ${metaIntel.activeRegime}. ${metaIntel.reasoning}`
    },
    {
      step: 'Supreme Council',
      details: `Final decision: ${metaIntel.metaAction} ${metaIntel.recommendedColor} at ${calibratedConfidence}% calibrated confidence (raw ${metaIntel.metaConfidence}%).`
    }
  ];

  const supremeDecision = {
    action: metaIntel.metaAction,
    recommendedColor: metaIntel.recommendedColor,
    confidence: calibratedConfidence,
    consensus: arbitration.consensus,
    disagreementIndex: arbitration.disagreementIndex,
    marketRegime: metaIntel.activeRegime,
    targetType: metaIntel.anomalyOverride
      ? 'RARE ANOMALY OVERRIDE'
      : (fourBallP.active ? '4BALL / 3BALL SYNERGY' : '3BALL MOMENTUM'),
    basedOnDrawId,
    riskLevel: calibratedConfidence >= 75 && arbitration.disagreementIndex < 0.5 ? 'LOW' : 'MODERATE',
    reasoning: `Supreme Council [Meta-Intelligence Layer] evaluated ${metaIntel.activeRegime} regime: ${metaIntel.reasoning}`,
    decisionTrace
  };

  const snapshot = {
    supremeDecision,
    metaIntelligence: metaIntel,
    parliaments: {
      general: generalP,
      fourBall: fourBallP
    },
    arbitrationData: {
      disagreementIndex: arbitration.disagreementIndex,
      coalitions: arbitration.coalitions
    },
    tieIntelligence: tieP,
    // Tie Precursor Pattern Engine -- second-layer, independent read on
    // top of tieIntelligence. See tiePrecursorPatternEngine.js.
    tiePrecursorPatterns: tiePrecursor,
    // Tier Engine Overdue/Precursor Hit Counter -- see
    // tierOverduePrecursorHitCounter.js. Scores the Tier Engine's own
    // OVERDUE/PRECURSOR calls against whether a tie actually lands
    // within an 8-draw window, mirroring threeBallEntryHitCounter.js.
    tierOverduePrecursorHitCounter,
    threeBallColorIntelligence: threeBallColorIntel,
    eventIntelligence: eventIntel,
    fourBallSeasonIntelligenceLab: fourSIL,
    // 4-Ball Tie-Birth Engine -- see fourBallTieBirthEngine.js's header.
    // Purely additive/observational; never influences fourSIL above.
    fourBallTieBirth,
    // 4-Ball Tie Cluster Engine -- see fourBallTieClusterEngine.js's
    // header. This one DOES feed fourSIL above (condition L), unlike
    // fourBallTieBirth -- exposed here as its own field so the dashboard
    // can show the tightened Tie vote state (Strong Tie count, cluster
    // status, vote age/expiry, confidence) independently of 4SIL's own
    // badge/conditions display.
    fourBallTieCluster,
    // 4SIL Upgrade Blueprint §21 -- unified per-event audit log. Exposed
    // as its own field, same reasoning as fourBallTieCluster above: a
    // dedicated read for the dashboard's audit trail, independent of
    // 4SIL's own live badge/conditions display. Only the most recent
    // entries are sent to the dashboard (the persistent store keeps up
    // to MAX_LOG_ENTRIES=500) -- see fourSilUnifiedAuditLog.js.
    fourSilUnifiedAuditLog: {
      entries: store.fourSilUnifiedAuditLog.entries.slice(0, 50),
      totalEntries: store.fourSilUnifiedAuditLog.entries.length,
      updatedAt: store.fourSilUnifiedAuditLog.updatedAt
    },
    threeBallSeasonIntelligenceLab: threeSIL,
    entryTimingIntervalEngine: entryTiming,
    // Entry Accuracy System -- see entryConditionScorecard.js and
    // entryAccuracyEngine.js. scorecard is the per-condition graded
    // hit-rate history; entryAccuracy is the tiered STRIKE/ENTER/WATCH/
    // STAND_DOWN classification plus the live retreat monitor built on
    // top of it.
    entryConditionScorecard: scorecard,
    entryAccuracy,
    // Entry Hit Counter -- see entryHitCounter.js. Simple running
    // hit/miss totals for 4SIL's ENTER calls, watching fourBallP's 1st
    // and 2nd pick colors independently over a 10-draw window per call.
    entryHitCounter,
    // 3-Ball Entry Hit Counter -- see threeBallEntryHitCounter.js. 3SIL's
    // OLD ENTER-call scoring log, watching the transition battle's
    // challenger color over an 8-draw window per call. RETIRED as 3SIL's
    // badge scoring mechanism -- kept on the payload for continuity of
    // any already-accumulated history; see threeBallNextEventHitCounter
    // below for the current mechanism.
    threeBallEntryHitCounter,
    // 3-Ball Next Event Hit Counter -- see threeBallNextEventHitCounter.js.
    // 3SIL's current scoring log: watches the Next Event Leaderboard's
    // top-ranked color continuously, every cycle, over an 8-draw window.
    threeBallNextEventHitCounter,
    // 4SIL Paper Trader Engine -- see src/engines/paperTraderEngine.js.
    // Full live summary (state machine, ladder, window, capital, recent
    // trades/windows/cycles/resets, performance rollups).
    paperTrader,
    unanimousVerdict: {
      unanimous: arbitration.isUnanimous,
      unanimousColor: arbitration.isUnanimous ? metaIntel.recommendedColor : 'NONE',
      unanimousConfidence: arbitration.isUnanimous ? calibratedConfidence : 0,
      liveEventCount: [generalP.active, fourBallP.active].filter(Boolean).length
    },
    officialPredictions: {
      supremeDecision,
      tieWarning: tieP.tieWarning,
      tiePrediction: tieP.tiePrediction,
      next3Ball: {
        color: generalP.winningColor, confidence: generalP.confidence,
        secondColor: generalP.secondColor, secondConfidence: generalP.secondConfidence,
        tieWarning: tieP.tieWarning,
        tiePrediction: tieP.tiePrediction,
        tieAdjusted: generalP.tieAdjusted || false,
        basedOnDrawId
      },
      next4Ball: {
        color: fourBallP.winningColor, confidence: fourBallP.confidence,
        secondColor: fourBallP.secondColor, secondConfidence: fourBallP.secondConfidence,
        basedOnDrawId
      },
      // 4SIL's output belongs here as market TIMING intelligence, never as
      // a color pick -- it deliberately carries no color/confidence field
      // of its own that could be mistaken for a prediction.
      fourBallMarketTiming: fourSIL.badge,
      // Same non-prediction guarantee as 4SIL above, for the 3-ball
      // market -- threeSIL.badge.dominantColor describes which color
      // currently LEADS the 3-ball market (descriptive state, same field
      // 4SIL's own badge carries), never a predicted winner or a
      // confidence score for one; generalP.winningColor/confidence remain
      // the sole source of the actual 3-ball color pick.
      threeBallMarketTiming: threeSIL.badge,
      // Entry Timing Interval Engine -- same non-prediction guarantee as
      // 4SIL above. It only ever ECHOES whichever colors fourBallP is
      // already predicting (trackedFirstColor/trackedSecondColor), it
      // never selects or influences them.
      entryTimingIntervals: entryTiming,
    },
    ingestStats: store.ingestStats,
    engineStats: store.engineStats,
    engineWeights: store.engineWeights,
    drawHistoryLength: historicalDraws.length
  };

  store.cachedSystemState = snapshot;
  return snapshot;
}

module.exports = {
  runSupremeCouncil
};
