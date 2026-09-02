/**
 * 3-Ball Tie Precursor Pattern Engine.
 *
 * A second, independent layer of analysis sitting ALONGSIDE the existing
 * Tie Intelligence Engine (tieEngine.js). Nothing in tieEngine.js is
 * touched, read-modified, or depended on for its live output here --
 * this engine studies two specific operator-observed precursor patterns
 * and builds its own separate prediction on top of the same underlying
 * historicalDraws:
 *
 *   1. FOUR-BALL PRECURSOR -- a 3-ball tie tends to land within a draw
 *      or two immediately after a 4-ball event (draw.fourBallColor
 *      truthy).
 *   2. YELLOW-49 PRECURSOR -- a 3-ball tie tends to land not long after
 *      a draw that included the wildcard #49 ball (the "odd yellow
 *      ball" in the color battle).
 *
 * WHY BALL #49 ISN'T ALREADY TRACKED ANYWHERE
 * ---------------------------------------------
 * The 3-color system (core/colorMath.js) is strictly RED/BLUE/GREEN.
 * validator.js's parseAndValidateDraw() silently drops any ball whose
 * color isn't one of those three when it builds colors/colorCounts, so
 * ball #49 (color "yellow" -- see the Bet9ja collector extension's own
 * validator.js: `ballColor(49) === 'yellow'`) never appears in
 * colors/colorCounts/threeBallColor/fourBallColor at all. It still
 * exists, though, inside the untouched original payload every draw is
 * stored with: validator.js keeps `raw: rawPayload` on every parsed
 * draw, and the collector's payload for each draw carries a `numbers`
 * array (the 6 raw ball numbers, 1-49) alongside the color-mapped
 * fields. hasYellow49() below reads straight from draw.raw.numbers --
 * this is the "check the payload output" workaround. If a draw's raw
 * payload is missing a numbers array (an older or foreign ingestion
 * path), presence is UNKNOWN, not false -- unknown draws are excluded
 * from the yellow-49 statistics rather than silently counted as "no 49
 * present", which would quietly bias the empirical rate downward.
 *
 * PURE RECOMPUTE, NO PERSISTENT LOG
 * ------------------------------------
 * Unlike the Entry Timing/Condition engines (which need to remember
 * live, cycle-only state that draw records don't carry), every signal
 * this engine needs -- fourBallColor, threeBallColor, and the raw ball
 * numbers -- is already sitting in historicalDraws for every draw that
 * ever happened. So, exactly like tieEngine.js itself, this is a full
 * recompute from historicalDraws every cycle: nothing to persist,
 * nothing that can drift out of sync with a server restart.
 *
 * HISTORY BRAIN
 * ---------------
 * buildPrecursorMemory() walks the entire draw history and empirically
 * measures how often each precursor actually preceded a tie within its
 * lookahead window, broken out by exact lag (1 draw later, 2 draws
 * later, ...). evaluateLiveSignals() then reads the CURRENT state (was
 * there a 4-ball event / yellow-49 draw within the last few draws, and
 * how many draws ago, still unresolved) and looks up the matching
 * CONDITIONAL empirical rate from that memory -- i.e. "of every past
 * occasion the board looked like it looks right now, how often did a
 * tie follow" -- rather than a fixed hand-tuned formula.
 *
 * historicalDraws is newest-first (index 0 = most recent), matching
 * every other engine's convention (see tieEngine.js).
 */

const { detectTie } = require('./tieEngine');

const FOUR_BALL_LOOKAHEAD_DRAWS = 2; // "a draw or two immediately after a 4-ball event"
const YELLOW49_LOOKAHEAD_DRAWS = 3;  // "not long after" -- given a little more room than the
                                      // 4-ball precursor since the spec phrasing is vaguer
const MIN_SAMPLES_FOR_TRUST = 5;     // matches tieEngine.js's own calibration threshold

function round1(n) {
  return Math.round(n * 10) / 10;
}

// --- Precursor detection -----------------------------------------------

function hasFourBallEvent(draw) {
  return Boolean(draw && draw.fourBallColor);
}

/**
 * Returns true/false if determinable, or null if this draw's raw payload
 * doesn't carry enough information to tell (see header). Never treat
 * null as false -- the caller must exclude unknown draws from stats.
 */
function hasYellow49(draw) {
  if (!draw || !draw.raw || !Array.isArray(draw.raw.numbers)) return null;
  return draw.raw.numbers.includes(49);
}

// --- History brain: windowed precursor -> tie statistics ----------------

/**
 * For every historical occurrence of a precursor (flagged true in
 * precursorFlags), checks whether a tie landed within `lookaheadDraws`
 * draws afterward, and breaks the result down per exact lag (1, 2, ...).
 * Occurrences too close to "now" to have a full window of future draws
 * to check are simply skipped (their outcome isn't known yet) rather
 * than counted as a miss.
 */
function evaluatePrecursorWindow(draws, tieFlags, precursorFlags, lookaheadDraws) {
  const total = draws.length;
  let sampleSize = 0;
  let hits = 0;
  const lagGaps = [];
  const perLag = {};
  for (let lag = 1; lag <= lookaheadDraws; lag++) perLag[lag] = { evals: 0, hits: 0 };

  for (let idx = total - 1; idx >= 1; idx--) {
    if (precursorFlags[idx] !== true) continue;

    sampleSize++;
    let firstHitLag = null;
    for (let lag = 1; lag <= lookaheadDraws; lag++) {
      const futureIdx = idx - lag;
      if (futureIdx < 0) break;
      perLag[lag].evals++;
      if (tieFlags[futureIdx]) {
        perLag[lag].hits++;
        if (firstHitLag === null) firstHitLag = lag;
      }
    }
    if (firstHitLag !== null) {
      hits++;
      lagGaps.push(firstHitLag);
    }
  }

  const hitRatePct = sampleSize > 0 ? round1((hits / sampleSize) * 100) : null;
  const avgLagToHit = lagGaps.length > 0
    ? round1(lagGaps.reduce((a, b) => a + b, 0) / lagGaps.length)
    : null;
  const perLagBreakdown = Object.entries(perLag).map(([lag, s]) => ({
    lag: Number(lag),
    evals: s.evals,
    hits: s.hits,
    hitRatePct: s.evals > 0 ? round1((s.hits / s.evals) * 100) : null
  }));

  return { windowDraws: lookaheadDraws, sampleSize, hits, hitRatePct, avgLagToHit, perLag: perLagBreakdown };
}

/**
 * The "history brain" comparison proper: among every past occurrence of
 * this precursor that SURVIVED (no tie yet) through exactly
 * `drawsAlreadyElapsed` draws afterward -- i.e. every past situation
 * that looked, at that point, exactly like today's situation looks
 * right now -- what fraction went on to tie within the remaining lags
 * of the window? This is what evaluateLiveSignals() calls to answer
 * "given where we are right now in this precursor's window, what does
 * history say happens next," rather than reusing the flat windowed rate
 * from evaluatePrecursorWindow() (which mixes occurrences that hit on
 * lag 1 together with ones that took the full window).
 */
function conditionalRemainingHitRate(draws, tieFlags, precursorFlags, lookaheadDraws, drawsAlreadyElapsed) {
  const total = draws.length;
  let evals = 0;
  let hits = 0;

  for (let idx = total - 1; idx >= 1; idx--) {
    if (precursorFlags[idx] !== true) continue;

    let survivedSoFar = true;
    for (let lag = 1; lag <= drawsAlreadyElapsed; lag++) {
      const futureIdx = idx - lag;
      if (futureIdx < 0) { survivedSoFar = false; break; } // not enough history to judge fairly
      if (tieFlags[futureIdx]) { survivedSoFar = false; break; } // resolved earlier -- not analogous to "still pending"
    }
    if (!survivedSoFar) continue;

    evals++;
    for (let lag = drawsAlreadyElapsed + 1; lag <= lookaheadDraws; lag++) {
      const futureIdx = idx - lag;
      if (futureIdx < 0) break;
      if (tieFlags[futureIdx]) { hits++; break; }
    }
  }

  return {
    evals,
    hits,
    hitRatePct: evals > 0 ? round1((hits / evals) * 100) : null
  };
}

/**
 * Scans the most recent `lookaheadDraws` draws for the newest still-
 * "live" occurrence of a precursor -- one that hasn't already resolved
 * (i.e. no tie has landed in the draws since it happened). Returns
 * { active: false } if none found.
 */
function findLiveOccurrence(draws, tieFlags, precursorFlags, lookaheadDraws) {
  const scanLimit = Math.min(lookaheadDraws, draws.length);
  for (let idx = 0; idx < scanLimit; idx++) {
    if (precursorFlags[idx] !== true) continue;

    const drawsAgo = idx; // 0 = the precursor WAS the most recent draw
    let alreadyResolved = false;
    for (let lag = 1; lag <= drawsAgo; lag++) {
      if (tieFlags[idx - lag]) { alreadyResolved = true; break; }
    }
    if (alreadyResolved) continue;

    return {
      active: true,
      drawsAgo,
      drawsRemainingInWindow: lookaheadDraws - drawsAgo
    };
  }
  return { active: false };
}

function riskLevelFromScore(score) {
  if (score >= 75) return 'VERY HIGH';
  if (score >= 55) return 'HIGH';
  if (score >= 30) return 'MODERATE';
  return 'LOW';
}

/**
 * Closed-loop calibration (follow-up to the header's "PURE RECOMPUTE, NO
 * PERSISTENT LOG" note) -- direct structural port of tieEngine.js's
 * calibrateTieProbability(). Blends this cycle's raw, purely
 * historically-derived combinedScore toward the empirical tie rate this
 * engine's OWN past elevatedRisk calls have actually achieved at the
 * same riskLevel bucket, trust scaling with how much scored history
 * exists. This is what turns "more data -> better raw estimate" into
 * "the engine also self-corrects against its own track record" -- until
 * council.js starts passing calibrationData (built from
 * store.tiePrecursorForecastLog via store.buildTiePrecursorCalibrationData()),
 * this is a no-op that returns rawScore unchanged, so the engine behaves
 * exactly as before for any caller that hasn't wired the closed loop in
 * yet.
 *
 * calibrationData shape (built by council.js from
 * store.tiePrecursorForecastLog, mirroring tieEngine.js's own
 * calibrationData contract):
 *   { byRiskLevel: { LOW: {sampleSize, tieRatePct}, MODERATE: {...}, HIGH: {...}, 'VERY HIGH': {...} } }
 * riskLevel (not the raw score itself) is the calibration key for the
 * same reason tieEngine.js uses riskLevel there: it's a deterministic
 * function of the score being calibrated, so bucketing by it doesn't
 * introduce circularity the way bucketing by, say, rounded score would.
 */
function calibratePrecursorScore(rawScore, riskLevel, calibrationData) {
  const bucket = calibrationData && calibrationData.byRiskLevel && calibrationData.byRiskLevel[riskLevel];
  if (!bucket || bucket.sampleSize < MIN_SAMPLES_FOR_TRUST) {
    return rawScore;
  }
  // Identical shrinkage curve to calibrateTieProbability(): 0 trust at
  // sampleSize=5, ~0.75 at 20, asymptoting toward 1 (capped at 0.9 so the
  // raw historical read is never fully discarded regardless of sample
  // size -- this engine's precursor logic still deserves some say).
  const trust = Math.min(0.9, (bucket.sampleSize - MIN_SAMPLES_FOR_TRUST) / (bucket.sampleSize - MIN_SAMPLES_FOR_TRUST + 15));
  const blended = (rawScore * (1 - trust)) + (bucket.tieRatePct * trust);
  return Math.max(0, Math.min(100, Math.round(blended)));
}

/**
 * Main entry point. Builds the history brain (empirical stats for both
 * precursors) and the live prediction (current signal state read
 * against that history) in one pass.
 *
 * calibrationData (optional) -- see calibratePrecursorScore()'s header.
 * Passed by council.js as store.buildTiePrecursorCalibrationData()'s
 * output; omitted (or undefined), combinedScore is returned as the raw
 * historical read, unchanged from this engine's pre-closed-loop
 * behavior.
 *
 * trackRecord (optional) -- the same buildTiePrecursorCalibrationData()
 * result, attached to the returned object as-is so the dashboard can
 * render the Self-Graded Accuracy block without council.js needing to
 * shape a separate payload for it. Kept as a distinct parameter (rather
 * than reusing calibrationData in the return) so a caller could in
 * principle calibrate against one dataset while surfacing a different
 * one for display -- in practice council.js passes the same object for
 * both.
 */
function evaluateTiePrecursorPatterns(historicalDraws, calibrationData, trackRecord) {
  const draws = historicalDraws || [];
  const total = draws.length;

  if (total < MIN_SAMPLES_FOR_TRUST + FOUR_BALL_LOOKAHEAD_DRAWS) {
    return {
      engine: 'TiePrecursorPatternEngine',
      sufficientHistory: false,
      totalDraws: total,
      minimumRequired: MIN_SAMPLES_FOR_TRUST + FOUR_BALL_LOOKAHEAD_DRAWS,
      fourBallPrecursor: null,
      yellow49Precursor: null,
      liveSignals: { fourBall: { active: false }, yellow49: { active: false } },
      prediction: {
        elevatedRisk: false,
        combinedScore: 0,
        riskLevel: 'LOW',
        unifiedSignal: { active: false, type: null, message: null, drawsRemaining: null, probabilityPct: null },
        reasoning: `Only ${total} draw(s) in history -- need at least ${MIN_SAMPLES_FOR_TRUST + FOUR_BALL_LOOKAHEAD_DRAWS} to evaluate precursor patterns.`
      },
      trackRecord: trackRecord || null,
      reasoning: 'Insufficient history to evaluate tie precursor patterns yet.'
    };
  }

  const tieFlags = draws.map(detectTie);
  const fourBallFlags = draws.map(hasFourBallEvent);
  const yellow49Flags = draws.map(hasYellow49);

  const yellow49KnownCount = yellow49Flags.filter(f => f !== null).length;
  const baselineTieRatePct = round1((tieFlags.filter(Boolean).length / total) * 100);

  // --- History brain: windowed empirical stats for each precursor -------
  const fourBallStats = evaluatePrecursorWindow(draws, tieFlags, fourBallFlags, FOUR_BALL_LOOKAHEAD_DRAWS);
  const yellow49Stats = evaluatePrecursorWindow(draws, tieFlags, yellow49Flags, YELLOW49_LOOKAHEAD_DRAWS);

  const fourBallPrecursor = {
    ...fourBallStats,
    baselineTieRatePct,
    liftPct: fourBallStats.hitRatePct != null ? round1(fourBallStats.hitRatePct - baselineTieRatePct) : null,
    sufficientSample: fourBallStats.sampleSize >= MIN_SAMPLES_FOR_TRUST
  };
  const yellow49Precursor = {
    ...yellow49Stats,
    baselineTieRatePct,
    liftPct: yellow49Stats.hitRatePct != null ? round1(yellow49Stats.hitRatePct - baselineTieRatePct) : null,
    sufficientSample: yellow49Stats.sampleSize >= MIN_SAMPLES_FOR_TRUST,
    knownDrawCount: yellow49KnownCount,
    unknownDrawCount: total - yellow49KnownCount
  };

  // --- Live signal state --------------------------------------------------
  const fourBallLive = findLiveOccurrence(draws, tieFlags, fourBallFlags, FOUR_BALL_LOOKAHEAD_DRAWS);
  const yellow49Live = findLiveOccurrence(draws, tieFlags, yellow49Flags, YELLOW49_LOOKAHEAD_DRAWS);

  if (fourBallLive.active) {
    const cond = conditionalRemainingHitRate(draws, tieFlags, fourBallFlags, FOUR_BALL_LOOKAHEAD_DRAWS, fourBallLive.drawsAgo);
    fourBallLive.conditionalHitRatePct = cond.hitRatePct;
    fourBallLive.conditionalSampleSize = cond.evals;
    fourBallLive.sufficientSample = cond.evals >= MIN_SAMPLES_FOR_TRUST;
  }
  if (yellow49Live.active) {
    const cond = conditionalRemainingHitRate(draws, tieFlags, yellow49Flags, YELLOW49_LOOKAHEAD_DRAWS, yellow49Live.drawsAgo);
    yellow49Live.conditionalHitRatePct = cond.hitRatePct;
    yellow49Live.conditionalSampleSize = cond.evals;
    yellow49Live.sufficientSample = cond.evals >= MIN_SAMPLES_FOR_TRUST;
  }

  // --- Combined prediction --------------------------------------------------
  // Each active, sufficiently-sampled precursor contributes its
  // conditional hit rate (falling back to the flat windowed rate when a
  // conditional read isn't trustworthy yet). Two simultaneously active
  // precursors are combined as roughly-independent probability boosts
  // (1 - (1-p1)(1-p2)) -- a standard, clearly-labeled heuristic combination,
  // NOT a separately-measured joint-empirical rate (the codebase doesn't
  // yet have enough dual-precursor history to trust a real joint bucket).
  const activeReads = [];
  if (fourBallLive.active) {
    const p = fourBallLive.sufficientSample ? fourBallLive.conditionalHitRatePct
      : (fourBallPrecursor.sufficientSample ? fourBallPrecursor.hitRatePct : null);
    if (p != null) activeReads.push({ source: 'FOUR_BALL', probabilityPct: p, ...fourBallLive });
  }
  if (yellow49Live.active) {
    const p = yellow49Live.sufficientSample ? yellow49Live.conditionalHitRatePct
      : (yellow49Precursor.sufficientSample ? yellow49Precursor.hitRatePct : null);
    if (p != null) activeReads.push({ source: 'YELLOW_49', probabilityPct: p, ...yellow49Live });
  }

  let rawCombinedScore = 0;
  if (activeReads.length === 1) {
    rawCombinedScore = activeReads[0].probabilityPct;
  } else if (activeReads.length === 2) {
    const p1 = activeReads[0].probabilityPct / 100;
    const p2 = activeReads[1].probabilityPct / 100;
    rawCombinedScore = round1((1 - (1 - p1) * (1 - p2)) * 100);
  }

  // riskLevel is bucketed off the RAW score, then calibration blends
  // toward that same bucket's own scored track record -- same ordering
  // as tieEngine.js's calibrateTieProbability() (bucket key must be
  // independent of the value being calibrated to avoid circularity).
  const riskLevel = riskLevelFromScore(rawCombinedScore);
  const combinedScore = activeReads.length > 0
    ? calibratePrecursorScore(rawCombinedScore, riskLevel, calibrationData)
    : rawCombinedScore;
  const elevatedRisk = combinedScore > baselineTieRatePct && activeReads.length > 0;

  const wasCalibrated = combinedScore !== rawCombinedScore;

  let reasoning;
  if (activeReads.length === 0) {
    reasoning = 'Neither precursor pattern is currently active -- no elevated 3-ball tie risk signaled by this engine.';
  } else {
    const parts = activeReads.map(r => {
      const label = r.source === 'FOUR_BALL' ? '4-ball event' : 'yellow #49 draw';
      const when = r.drawsAgo === 0 ? 'on the most recent draw' : `${r.drawsAgo} draw(s) ago`;
      return `${label} ${when} (${r.probabilityPct}% historical follow-through, ${r.drawsRemainingInWindow} draw(s) left in window)`;
    });
    const calibrationClause = wasCalibrated
      ? ` (raw ${rawCombinedScore}%, calibrated against this engine's own scored ${riskLevel} track record)`
      : '';
    reasoning = `${parts.join(' AND ')} -- combined tie-precursor score ${combinedScore}%${calibrationClause} vs. baseline ${baselineTieRatePct}%.`;
  }

  const calibrationNote = wasCalibrated
    ? `Calibrated: raw historical read was ${rawCombinedScore}%, blended toward this engine's own scored ${riskLevel}-bucket hit rate to reach ${combinedScore}%.`
    : (calibrationData
      ? `Not calibrated this cycle -- fewer than ${MIN_SAMPLES_FOR_TRUST} scored ${riskLevel}-bucket forecasts on record, so the raw historical read (${rawCombinedScore}%) is used as-is.`
      : 'Calibration not yet wired for this cycle -- showing the raw historical read.');

  // --- Unified signal (operator-facing summary) --------------------------
  // Reduces the engine's full read into a single actionable line for the
  // dashboard's small precursor space on the main Tie card. This is a
  // presentation-layer summary ONLY -- every statistic above (windowed
  // stats, conditional rates, calibration, track record) keeps running
  // in full every cycle regardless of whether a unified signal fires.
  // Two conditions, checked in priority order, mirroring exactly how the
  // operator described the pattern:
  //   NEXT_DRAW -- a live precursor has exactly 1 draw left in its
  //     window (the very next draw is its last chance) -> "expect a tie
  //     in the next draw."
  //   WINDOW    -- a live precursor still has 1-4 draws left in its
  //     window (always true when active, since both lookaheads top out
  //     at 3 draws) -> "tie probability elevated over the next N draws."
  // No live, unresolved precursor -> no signal at all (active: false) --
  // the dashboard strip stays hidden rather than showing a manufactured
  // "all clear" every cycle.
  let unifiedSignal;
  const nextDrawRead = activeReads.find(r => r.drawsRemainingInWindow === 1);
  if (nextDrawRead) {
    const label = nextDrawRead.source === 'FOUR_BALL' ? '4-ball event' : 'yellow #49 draw';
    unifiedSignal = {
      active: true,
      type: 'NEXT_DRAW',
      message: `Expect a tie in the next draw (${nextDrawRead.probabilityPct}% historical follow-through, ${label} precursor).`,
      drawsRemaining: 1,
      probabilityPct: combinedScore
    };
  } else {
    const soonest = activeReads.reduce((min, r) => {
      const inWindow = r.drawsRemainingInWindow >= 1 && r.drawsRemainingInWindow <= 4;
      if (!inWindow) return min;
      return (min === null || r.drawsRemainingInWindow < min.drawsRemainingInWindow) ? r : min;
    }, null);
    if (soonest) {
      const label = soonest.source === 'FOUR_BALL' ? '4-ball event' : 'yellow #49 draw';
      unifiedSignal = {
        active: true,
        type: 'WINDOW',
        message: `Tie probability elevated over the next ${soonest.drawsRemainingInWindow} draw(s) (${combinedScore}% combined score, ${label} precursor).`,
        drawsRemaining: soonest.drawsRemainingInWindow,
        probabilityPct: combinedScore
      };
    } else {
      unifiedSignal = { active: false, type: null, message: null, drawsRemaining: null, probabilityPct: null };
    }
  }

  return {
    engine: 'TiePrecursorPatternEngine',
    sufficientHistory: true,
    totalDraws: total,
    baselineTieRatePct,
    fourBallPrecursor,
    yellow49Precursor,
    liveSignals: {
      fourBall: fourBallLive,
      yellow49: yellow49Live
    },
    prediction: {
      elevatedRisk,
      combinedScore,
      rawCombinedScore,
      calibratedCombinedScore: combinedScore,
      riskLevel,
      activePrecursors: activeReads.map(r => r.source),
      calibrationNote,
      unifiedSignal,
      reasoning
    },
    // Self-graded accuracy readout (closed loop) -- see
    // calibratePrecursorScore()'s header and store.js's
    // buildTiePrecursorCalibrationData(). Passed through verbatim from
    // whatever council.js supplied; null/undefined until that wiring is
    // in place, which the dashboard's renderTiePrecursorEngine() already
    // handles gracefully.
    trackRecord: trackRecord || null,
    reasoning: `4-ball precursor: ${fourBallPrecursor.sampleSize} historical occurrence(s), ${fourBallPrecursor.hitRatePct != null ? fourBallPrecursor.hitRatePct + '%' : 'n/a'} led to a tie within ${FOUR_BALL_LOOKAHEAD_DRAWS} draws. Yellow-49 precursor: ${yellow49Precursor.sampleSize} historical occurrence(s) (${yellow49Precursor.unknownDrawCount} draw(s) had no ball data to check), ${yellow49Precursor.hitRatePct != null ? yellow49Precursor.hitRatePct + '%' : 'n/a'} led to a tie within ${YELLOW49_LOOKAHEAD_DRAWS} draws. Baseline unconditional tie rate: ${baselineTieRatePct}%.`
  };
}

module.exports = {
  FOUR_BALL_LOOKAHEAD_DRAWS,
  YELLOW49_LOOKAHEAD_DRAWS,
  MIN_SAMPLES_FOR_TRUST,
  hasFourBallEvent,
  hasYellow49,
  evaluatePrecursorWindow,
  conditionalRemainingHitRate,
  findLiveOccurrence,
  calibratePrecursorScore,
  evaluateTiePrecursorPatterns
};
