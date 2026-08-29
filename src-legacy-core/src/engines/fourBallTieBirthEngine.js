/**
 * 4-BALL TIE-BIRTH ENGINE
 *
 * Implements ONLY the Tie section of the "4SIL Upgrade Blueprint" (Event
 * Density, Repeat 4-Ball, Response/Cascade, Transition changes, and
 * Fast-Track from that same blueprint are explicitly OUT of scope here --
 * per operator direction, "carefully implement ONLY the TIE part").
 *
 * WHAT THIS IS: a purely additive, observational engine. It does NOT
 * touch fourBallSeasonIntelligenceLab.js (the protected original 4SIL
 * engine) in any way -- it only READS 4SIL's already-public badge.enterNow
 * field (to know whether 4SIL is currently "armed," per the blueprint's
 * Tie Watch vs Tie Trigger distinction) and never writes back into it.
 * 4SIL's own ENTER NOW decision, thresholds, and gate logic are completely
 * unchanged by this file's existence. This matches the blueprint's own
 * Learning Mode directive (deploy OBSERVATIONAL first: collect, calculate,
 * compare, rank, display, audit -- do not auto-change live thresholds) and
 * its non-negotiable rule "Do not replace the original 4SIL."
 *
 * TIE DEFINITION (blueprint section 10, applied literally): "any draw in
 * which no color reaches the 4-ball threshold" -- i.e. MAX_COLOR_COUNT < 4.
 * This is NOT the same "tie" concept as tieEngine.js's 3-ball tie
 * (!threeBallColor && !fourBallColor, a much rarer "no color reached 3
 * OR 4" event) -- this Tie-Birth engine's tie is specifically about the
 * 4-ball market's own threshold, and by that literal definition includes
 * every draw that ISN'T a 4-ball event (a 3-ball win, a 2-1-1 split,
 * etc). Since 4-ball events are the rare side of this market, this tie
 * definition is necessarily common -- which is exactly why the blueprint
 * insists the ~85% Tie-precedes-4-ball observation be continuously
 * VALIDATED against real history rather than hard-coded as truth (a very
 * common "precursor" could easily just be echoing the market's base
 * rate). This engine reports the actual measured rate every cycle instead
 * of assuming the 85% figure.
 *
 * REUSED DIRECTLY from tiePrecursorPatternEngine.js (its
 * hasFourBallEvent/hasYellow49 flag helpers and its generic, already-
 * battle-tested precursor-window statistics -- evaluatePrecursorWindow,
 * conditionalRemainingHitRate, findLiveOccurrence -- were all written
 * generically over arbitrary boolean flag arrays, not hardcoded to any
 * one meaning, so they apply cleanly here with "tie" and "4-ball event"
 * swapped into the precursor/outcome roles they were built for):
 *   hasFourBallEvent(draw)      -- Boolean(draw.fourBallColor)
 *   hasYellow49(draw)           -- was ball #49 drawn (or null if unknown)
 *   evaluatePrecursorWindow     -- per-lag (T+1..T+N) hit-rate statistics
 *   conditionalRemainingHitRate -- "given we're N draws past a tie with no
 *                                   4-ball yet, what does history say the
 *                                   remaining odds are" (survivorship-
 *                                   correct, not the flat windowed rate)
 *   findLiveOccurrence          -- locates the most recent still-live tie
 *
 * NO PERSISTENT STATE, following tiePrecursorPatternEngine.js's own
 * precedent exactly: every statistic here is a pure recompute from
 * historicalDraws each cycle (there is no "calling context" that only
 * exists transiently and needs logging, unlike e.g.
 * threeBallEntryHitCounter.js's watch-and-resolve pattern -- everything
 * this engine needs is already sitting in the historical draw record).
 *
 * SECTION 19 -- TIE DOES NOT SELECT THE COLOR: this engine never outputs
 * a predicted/recommended color. Where a color appears in this engine's
 * output (e.g. seasonReset.confirmedColor), it is always describing an
 * ALREADY-LANDED, backward-looking historical or live-audit fact ("this
 * is the color that in fact landed after that tie"), never a forecast of
 * what color comes next. Parliament remains the sole color authority.
 *
 * historicalDraws is newest-first (index 0 = most recent), matching every
 * other engine's convention.
 */
'use strict';

const { mean } = require('../core/statMath');
const { HIERARCHY } = require('../core/colorMath');
const {
  hasFourBallEvent,
  hasYellow49,
  evaluatePrecursorWindow,
  conditionalRemainingHitRate,
  findLiveOccurrence
} = require('./tiePrecursorPatternEngine');

// Blueprint section 12: "calculate tieTo4Ball_T1 ... tieTo4Ball_T5" -- a
// 5-draw lookahead window.
const TIE_TO_4BALL_LOOKAHEAD = 5;

// Blueprint section 17 (Tie Freshness): AGE 0 = IMMEDIATE, 1-2 = FRESH,
// 3 = WEAKENING, 4+ = EXPIRED. Kept as named constants (not magic
// numbers) so a future tuning pass can adjust them in one place --
// per the blueprint, "make the decay configurable... later optimize
// from actual performance," this engine does not self-adjust them.
const TIE_FRESH_AGE_MAX = 2;
const TIE_WEAKENING_AGE = 3;

// Blueprint section 14/15: how many draws a Season Reset Watch stays
// open after a tie before either confirming (a 4-ball event lands) or
// expiring unconfirmed. Reuses the same 5-draw window as the Tie->4Ball
// audit above -- both are asking "what happens in the draws right after
// this tie," so there's no principled reason for two different windows.
const SEASON_RESET_WATCH_WINDOW = TIE_TO_4BALL_LOOKAHEAD;

const TIE_TYPES = ['THREE_WAY_EVEN', 'DUAL_THREE', 'TWO_WAY_EVEN', 'ASYMMETRIC'];

function round1(n) {
  return Math.round(n * 10) / 10;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Blueprint section 10: a 4-ball Tie is any draw where no color reached
 * the 4-ball threshold -- i.e. simply the inverse of hasFourBallEvent.
 */
function isFourBallTie(draw) {
  return !hasFourBallEvent(draw);
}

/**
 * Blueprint section 11 (Tie Must Be Structured): classifies the SHAPE of
 * a qualifying tie from its colorCounts, generalizing tieEngine.js's own
 * tieShape() (built for the stricter 3-ball tie, where the max count is
 * capped at 2) to the 4-ball tie's wider 0-3 range. Four categories:
 *   THREE_WAY_EVEN -- all three colors equal (covers the blueprint's
 *                     "2/2/2" example, and 1-1-1/0-0-0)
 *   DUAL_THREE     -- exactly two colors tied at 3 (the blueprint's
 *                     "3/3" example -- both reached 3-ball level with
 *                     no clear winner between them)
 *   TWO_WAY_EVEN    -- exactly two colors tied at some other count
 *                      (e.g. 2-2-1, covers the blueprint's "2/2/1 + #49"
 *                      example structurally -- yellow49Present is
 *                      tracked as its own separate field per section 11,
 *                      not folded into this type)
 *   ASYMMETRIC      -- no two colors tied (e.g. 3-2-0, 2-1-0) -- still a
 *                      tie by the section 10 definition (max color < 4),
 *                      just with no even split
 */
function classifyTieType(draw) {
  if (!draw || !draw.colorCounts) return 'UNKNOWN';
  const counts = HIERARCHY.map(c => draw.colorCounts[c] || 0).sort((a, b) => b - a);
  const [a, b, c] = counts;
  if (a === b && b === c) return 'THREE_WAY_EVEN';
  if (a === b && a === 3) return 'DUAL_THREE';
  if (a === b) return 'TWO_WAY_EVEN';
  return 'ASYMMETRIC';
}

/**
 * Blueprint section 17 (Tie Freshness) label for a given tie age (draws
 * since the tie landed; 0 = the tie WAS the most recent draw).
 */
function tieFreshnessLabel(age) {
  if (age == null) return 'NONE';
  if (age === 0) return 'IMMEDIATE';
  if (age <= TIE_FRESH_AGE_MAX) return 'FRESH';
  if (age === TIE_WEAKENING_AGE) return 'WEAKENING';
  return 'EXPIRED';
}

/**
 * How many draws ago the most recent qualifying tie landed. null if none
 * found in the given history at all.
 */
function findMostRecentTieAge(draws, tieFlags) {
  for (let i = 0; i < draws.length; i++) {
    if (tieFlags[i]) return i;
  }
  return null;
}

/**
 * Blueprint sections 13-15 (Season Reset): for EVERY historical tie, was
 * it followed by a 4-ball event within SEASON_RESET_WATCH_WINDOW draws
 * (a "confirmed reset"), and when it was, did the confirming color
 * differ from the color that was leading going into the tie (a "new
 * color season" vs. the same color simply resuming)? This is the
 * retrospective audit backing blueprint sections 33/35 (Performance
 * Audit -- Tie / Season Reset) -- a pure recompute over historicalDraws,
 * same no-persistence approach as the rest of this file.
 */
function auditSeasonReset(draws, tieFlags) {
  const total = draws.length;
  let sampleSize = 0;
  let confirmedCount = 0;
  let newColorCount = 0;
  const latencies = [];

  for (let idx = total - 1; idx >= 1; idx--) {
    if (!tieFlags[idx]) continue;

    // Pre-tie color: the most recent 4-ball color at or before this tie
    // (scanning further into the past, i.e. increasing index).
    let preColor = null;
    for (let back = idx; back < total; back++) {
      if (draws[back].fourBallColor) { preColor = draws[back].fourBallColor; break; }
    }

    sampleSize++;
    let latency = null;
    let confirmColor = null;
    for (let lag = 1; lag <= SEASON_RESET_WATCH_WINDOW; lag++) {
      const futureIdx = idx - lag;
      if (futureIdx < 0) break;
      if (draws[futureIdx].fourBallColor) {
        latency = lag;
        confirmColor = draws[futureIdx].fourBallColor;
        break;
      }
    }

    if (latency != null) {
      confirmedCount++;
      latencies.push(latency);
      if (preColor && confirmColor && confirmColor !== preColor) newColorCount++;
    }
  }

  return {
    windowDraws: SEASON_RESET_WATCH_WINDOW,
    sampleSize,
    resetConfirmedCount: confirmedCount,
    resetConfirmedRatePct: sampleSize > 0 ? round1((confirmedCount / sampleSize) * 100) : null,
    avgResetLatency: latencies.length > 0 ? round1(mean(latencies)) : null,
    // Of the resets that DID confirm, what share landed on a DIFFERENT
    // color than was leading before the tie -- the blueprint's
    // TIE_TO_NEW_SEASON_RATE.
    newSeasonColorRatePct: confirmedCount > 0 ? round1((newColorCount / confirmedCount) * 100) : null
  };
}

/**
 * Live Season Reset Watch status for the CURRENT (most recent) tie only
 * -- blueprint sections 13/14: "Immediately after a qualifying Tie,
 * SEASON_RESET_WATCH = TRUE. Do not immediately declare a new season...
 * If confirmed: NEW_COLOR_SEASON_CONFIRMED."
 */
function liveSeasonReset(draws, tieAge) {
  if (tieAge == null) {
    return { status: 'NONE', drawsElapsed: null, confirmedColor: null, isNewColor: null };
  }

  let preColor = null;
  for (let back = tieAge; back < draws.length; back++) {
    if (draws[back].fourBallColor) { preColor = draws[back].fourBallColor; break; }
  }

  // Scan the draws strictly after the tie (smaller index = more recent)
  // for the first 4-ball event, up to the watch window.
  const scanLimit = Math.min(tieAge, SEASON_RESET_WATCH_WINDOW);
  for (let j = 0; j < scanLimit; j++) {
    if (draws[j].fourBallColor) {
      const confirmedColor = draws[j].fourBallColor;
      return {
        status: 'NEW_COLOR_SEASON_CONFIRMED',
        drawsElapsed: tieAge - j,
        confirmedColor,
        isNewColor: preColor != null ? confirmedColor !== preColor : null
      };
    }
  }

  if (tieAge >= SEASON_RESET_WATCH_WINDOW) {
    return { status: 'EXPIRED', drawsElapsed: tieAge, confirmedColor: null, isNewColor: null };
  }

  return { status: 'SEASON_RESET_WATCH', drawsElapsed: tieAge, confirmedColor: null, isNewColor: null };
}

/**
 * Blueprint section 16 (Tie-Birth Score) -- a transparent, documented
 * 0-100 display figure, explicitly NOT a calibrated probability (the
 * blueprint's own words: "don't hard-code 85% as a permanent score, let
 * the performance system verify it"). Built from:
 *   - the ACTUAL measured overall tie->4-ball rate (half the weight --
 *     this is the "let performance verify it" half, replacing any
 *     assumed constant)
 *   - freshness (a stale tie contributes less)
 *   - whether 4SIL is currently armed (blueprint section 18 -- an armed
 *     Tie Trigger is a stronger situation than an unarmed Tie Watch)
 *   - how this tie's own TYPE has historically performed vs. the overall
 *     rate, when there's enough sample to say anything (section 34)
 */
function computeTieBirthScore({ age, overallHitRatePct, overallSampleSize, armed, typeHitRatePct, typeSampleSize }) {
  const freshnessPoints = age === 0 ? 25 : age <= TIE_FRESH_AGE_MAX ? 18 : age === TIE_WEAKENING_AGE ? 8 : 0;
  const empiricalBase = overallSampleSize >= 5 && overallHitRatePct != null ? overallHitRatePct : 50; // neutral prior until there's real sample
  const armedBonus = armed ? 15 : 0;
  const typeAdjustment = (typeSampleSize >= 5 && typeHitRatePct != null && overallHitRatePct != null)
    ? clamp((typeHitRatePct - overallHitRatePct) * 0.3, -15, 15)
    : 0;

  const score = empiricalBase * 0.5 + freshnessPoints + armedBonus + typeAdjustment;
  return Math.round(clamp(score, 0, 100));
}

/**
 * Blueprint section 15 (Season Reset Score) -- same "documented display
 * figure, not a fixed probability" philosophy as computeTieBirthScore.
 * Bands: 0-39 NORMAL_TIE, 40-59 RESET_WATCH, 60-74 STRONG_RESET,
 * 75-89 RESET_PROBABLE, 90-100 RESET_CONFIRMED.
 */
function computeSeasonResetScore({ age, resetConfirmedRatePct, resetSampleSize, liveStatus }) {
  const freshnessPoints = age === 0 ? 20 : age <= TIE_FRESH_AGE_MAX ? 14 : age === TIE_WEAKENING_AGE ? 6 : 0;
  const empiricalBase = resetSampleSize >= 5 && resetConfirmedRatePct != null ? resetConfirmedRatePct : 50;
  const confirmedBonus = liveStatus === 'NEW_COLOR_SEASON_CONFIRMED' ? 25 : 0;

  const score = empiricalBase * 0.45 + freshnessPoints + confirmedBonus;
  return Math.round(clamp(score, 0, 100));
}

function seasonResetBand(score) {
  if (score >= 90) return 'RESET_CONFIRMED';
  if (score >= 75) return 'RESET_PROBABLE';
  if (score >= 60) return 'STRONG_RESET';
  if (score >= 40) return 'RESET_WATCH';
  return 'NORMAL_TIE';
}

/**
 * Main entry point, called once per council cycle. fourSIL is the full
 * evaluateFourBallSeasonIntelligenceLab() result -- read-only, only
 * fourSIL.badge.enterNow is consulted (blueprint section 18's "armed"
 * signal). Nothing here writes back into fourSIL or its store.
 */
function evaluateFourBallTieBirth(historicalDraws, fourSIL) {
  const draws = historicalDraws || [];

  if (draws.length < 20) {
    return {
      engine: '4-Ball Tie-Birth Engine',
      ready: false,
      reasoning: `Need at least 20 draws for a reliable tie->4-ball read (have ${draws.length}).`
    };
  }

  const tieFlags = draws.map(isFourBallTie);
  const fourBallFlags = draws.map(hasFourBallEvent);
  const armed = Boolean(fourSIL && fourSIL.badge && fourSIL.badge.enterNow);

  // ---- Section 12: overall Tie -> 4-Ball audit (T+1..T+5, per-lag) ----
  const overall = evaluatePrecursorWindow(draws, fourBallFlags, tieFlags, TIE_TO_4BALL_LOOKAHEAD);

  // ---- Section 34: per tie-TYPE breakdown ----
  const perType = {};
  TIE_TYPES.forEach(type => {
    const typeFlags = draws.map((d, i) => (tieFlags[i] && classifyTieType(d) === type));
    perType[type] = evaluatePrecursorWindow(draws, fourBallFlags, typeFlags, TIE_TO_4BALL_LOOKAHEAD);
  });

  // ---- Section 35: Season Reset audit (retrospective, all ties) ----
  const seasonResetAudit = auditSeasonReset(draws, tieFlags);

  // ---- Live state: the most recent tie, if any ----
  const latestDraw = draws[0];
  const tieAge = findMostRecentTieAge(draws, tieFlags);
  const freshness = tieFreshnessLabel(tieAge);
  const currentType = tieAge != null ? classifyTieType(draws[tieAge]) : null;

  // "Given we're exactly `tieAge` draws past the most recent tie with no
  // 4-ball event yet, what does history say the remaining odds are" --
  // the survivorship-correct read, not the flat windowed rate.
  let liveConditional = null;
  if (tieAge != null && tieAge <= TIE_TO_4BALL_LOOKAHEAD) {
    const alreadyHit = (() => {
      for (let lag = 1; lag <= tieAge; lag++) {
        const idx = tieAge - lag;
        if (idx >= 0 && fourBallFlags[idx]) return true;
      }
      return false;
    })();
    if (!alreadyHit) {
      liveConditional = conditionalRemainingHitRate(draws, fourBallFlags, tieFlags, TIE_TO_4BALL_LOOKAHEAD, tieAge);
    }
  }

  // ---- Section 18: Tie Watch vs Tie Trigger ----
  let regime = 'NONE';
  if (tieAge != null && freshness !== 'EXPIRED') {
    regime = armed ? 'TIE_TRIGGER' : 'TIE_WATCH';
  }

  const typeStats = currentType && perType[currentType] ? perType[currentType] : null;

  // ---- Section 16: Tie-Birth Score ----
  const tieBirthScore = tieAge != null
    ? computeTieBirthScore({
        age: tieAge,
        overallHitRatePct: overall.hitRatePct,
        overallSampleSize: overall.sampleSize,
        armed,
        typeHitRatePct: typeStats ? typeStats.hitRatePct : null,
        typeSampleSize: typeStats ? typeStats.sampleSize : 0
      })
    : 0;

  // ---- Sections 13-15: live Season Reset Watch for the current tie ----
  const seasonResetLive = liveSeasonReset(draws, tieAge);
  const seasonResetScore = tieAge != null
    ? computeSeasonResetScore({
        age: tieAge,
        resetConfirmedRatePct: seasonResetAudit.resetConfirmedRatePct,
        resetSampleSize: seasonResetAudit.sampleSize,
        liveStatus: seasonResetLive.status
      })
    : 0;
  const seasonResetBandLabel = tieAge != null ? seasonResetBand(seasonResetScore) : 'NORMAL_TIE';

  const currentTieSnapshot = tieAge === 0
    ? {
        drawId: latestDraw.drawId != null ? latestDraw.drawId : null,
        tieType: currentType,
        redCount: (latestDraw.colorCounts && latestDraw.colorCounts.RED) || 0,
        blueCount: (latestDraw.colorCounts && latestDraw.colorCounts.BLUE) || 0,
        greenCount: (latestDraw.colorCounts && latestDraw.colorCounts.GREEN) || 0,
        yellow49Present: hasYellow49(latestDraw)
      }
    : null;

  const reasoning = tieAge == null
    ? 'No qualifying 4-ball tie found in the tracked history.'
    : `Most recent tie: ${freshness} (${tieAge} draw(s) ago), type ${currentType}. `
      + `Overall tie->4-ball rate: ${overall.hitRatePct != null ? overall.hitRatePct + '%' : 'n/a'} (n=${overall.sampleSize}) within ${TIE_TO_4BALL_LOOKAHEAD} draws. `
      + `Regime: ${regime}${armed ? ' (4SIL currently armed)' : ''}. `
      + `Season reset: ${seasonResetLive.status}${seasonResetLive.confirmedColor ? ` (confirmed color: ${seasonResetLive.confirmedColor}${seasonResetLive.isNewColor ? ', a NEW color vs. pre-tie' : ', SAME color as pre-tie'})` : ''}.`;

  return {
    engine: '4-Ball Tie-Birth Engine',
    ready: true,
    currentTie: currentTieSnapshot,
    tieAge,
    freshness,
    regime, // NONE | TIE_WATCH | TIE_TRIGGER
    armed,
    tieBirthScore,
    seasonReset: {
      live: seasonResetLive,
      score: seasonResetScore,
      band: seasonResetBandLabel,
      audit: seasonResetAudit
    },
    audit: {
      overall,
      perType,
      liveConditional
    },
    reasoning
  };
}

module.exports = {
  TIE_TO_4BALL_LOOKAHEAD,
  TIE_FRESH_AGE_MAX,
  TIE_WEAKENING_AGE,
  SEASON_RESET_WATCH_WINDOW,
  TIE_TYPES,
  isFourBallTie,
  classifyTieType,
  tieFreshnessLabel,
  auditSeasonReset,
  liveSeasonReset,
  computeTieBirthScore,
  computeSeasonResetScore,
  seasonResetBand,
  evaluateFourBallTieBirth
};
