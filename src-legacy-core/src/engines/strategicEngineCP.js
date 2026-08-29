'use strict';

/**
 * strategicEngine.js
 * Layer Two — Strategic Intelligence (formerly "Sticky Archive Leader").
 *
 * The engine's "Memory". Remains DORMANT until the first confirmed 4BALL
 * event after season activation. Once awakened, responsible for:
 *  - Creating the season leaderboard.
 *  - Tracking the dominant color.
 *  - Measuring leader stability.
 *  - Tracking challenger colors.
 *  - Monitoring leadership decay.
 *  - Following the dominant color throughout the season.
 *  - Closing and archiving completed seasons.
 */

/**
 * Wake the archive on the first confirmed 4BALL hit of a season.
 * @param {Object} archiveState - state.archive
 * @param {string} seasonId - identifier for the season (e.g. activation drawId)
 * @param {Object} firstHitDraw - { drawId, color, timestamp }
 */
function wake(archiveState, seasonId, firstHitDraw) {
  if (archiveState.awake) return archiveState;
  archiveState.awake = true;
  archiveState.seasonId = seasonId;
  archiveState.leaderboard = {};
  archiveState.dominantColor = null;
  recordHit(archiveState, firstHitDraw);
  return archiveState;
}

/**
 * Strength weight for a single 4BALL hit, based on the real number of
 * same-color balls in that draw (4, 5, or 6 of 6). A bare 4-of-6 is the
 * minimum qualifying event and stays at the historical weight of 1 so
 * existing leaderboards/thresholds don't shift; 5-of-6 and 6-of-6 are
 * rarer, stronger same-color clustering and are weighted up accordingly.
 * draw.matchCount is null for callers that don't supply colorCounts (e.g.
 * manual /api/draws posts without it) -- those fall back to the baseline
 * weight of 1, same as before this change.
 */
const HIT_WEIGHT_BY_MATCH_COUNT = { 4: 1, 5: 1.5, 6: 2 };
const DEFAULT_HIT_WEIGHT = 1;

function hitWeight(matchCount) {
  if (!matchCount) return DEFAULT_HIT_WEIGHT;
  return HIT_WEIGHT_BY_MATCH_COUNT[matchCount] || DEFAULT_HIT_WEIGHT;
}

/**
 * Record a confirmed 4BALL hit into the leaderboard. Hits are weighted by
 * real match strength (see hitWeight) rather than counted as a flat +1, so
 * a 6-of-6 draw counts as stronger evidence of that color's dominance than
 * a bare 4-of-6 -- both in the leaderboard tally itself and in every
 * downstream read (dominant color, leader stability, challenger pressure).
 */
function recordHit(archiveState, draw) {
  if (!archiveState.awake || !draw.color) return archiveState;

  const board = archiveState.leaderboard;
  if (!board[draw.color]) {
    board[draw.color] = {
      hits: 0,
      rawHitCount: 0, // unweighted count of qualifying draws, for display/debugging
      firstSeenDrawId: draw.drawId,
      lastSeenDrawId: draw.drawId,
      growthHistory: [] // { drawId, hits, hitSeq, matchCount } over time, for growth-rate calc
    };
  }
  const entry = board[draw.color];
  const weight = hitWeight(draw.matchCount);
  entry.hits += weight;
  entry.rawHitCount = (entry.rawHitCount || 0) + 1;
  entry.lastSeenDrawId = draw.drawId;

  // Global, cross-color hit sequence number -- unlike drawId (an opaque
  // external Bet9ja ID with no guaranteed fixed step per draw) this is a
  // simple incrementing counter over confirmed archive hits only, so it can
  // be safely compared across colors to answer "how recently, in terms of
  // hit order, did this color last land" -- which drawId subtraction cannot.
  archiveState._hitSeq = (archiveState._hitSeq || 0) + 1;
  entry.lastSeenHitSeq = archiveState._hitSeq;
  entry.growthHistory.push({ drawId: draw.drawId, hits: entry.hits, hitSeq: archiveState._hitSeq, matchCount: draw.matchCount || 4 });

  recomputeDominant(archiveState);
  return archiveState;
}

/**
 * Recompute the dominant (leading) color by total hits.
 *
 * On a hit-count TIE, prefer to KEEP the current dominant color if it's
 * still among the tied leaders (real stickiness) -- previously this instead
 * broke every tie by `lastSeenDrawId` recency, which (a) subtracted an
 * opaque external Bet9ja identifier with no reliable numeric meaning, and
 * (b) even when it happened to coerce numerically, rewarded "whichever
 * color just hit" -- meaning two colors trading the lead back and forth
 * flipped `dominantColor` on literally every single draw, regardless of
 * which was actually ahead. That fed directly into strategicPredict() and
 * arbitrate(), producing rapid prediction flapping between colors.
 *
 * Only when the current dominant color is no longer tied for the lead (or
 * there is no current dominant color yet) do we pick a new one -- using
 * lastSeenHitSeq (a safe monotonic counter, see recordHit) rather than
 * lastSeenDrawId for that tie-break.
 */
function recomputeDominant(archiveState) {
  const board = archiveState.leaderboard;
  const colors = Object.keys(board);
  if (colors.length === 0) {
    archiveState.dominantColor = null;
    return;
  }

  const topHits = Math.max(...colors.map(c => board[c].hits));
  const tiedLeaders = colors.filter(c => board[c].hits === topHits);

  const current = archiveState.dominantColor;
  if (current && tiedLeaders.includes(current)) {
    // Current leader is still (at least) tied for the top spot -- keep it.
    return;
  }

  tiedLeaders.sort((a, b) => (board[b].lastSeenHitSeq || 0) - (board[a].lastSeenHitSeq || 0));
  archiveState.dominantColor = tiedLeaders[0];
}

/**
 * Leader stability: how firmly the dominant color holds its lead.
 * Combines hit-count margin over the strongest challenger and consistency
 * of growth over time. Returns 0..1 (1 = rock solid).
 */
function computeLeaderStability(archiveState) {
  const board = archiveState.leaderboard;
  const leader = archiveState.dominantColor;
  if (!leader || !board[leader]) return 0;

  const leaderHits = board[leader].hits;
  const challengers = Object.keys(board).filter(c => c !== leader);
  const strongestChallengerHits = challengers.length
    ? Math.max(...challengers.map(c => board[c].hits))
    : 0;

  const totalHits = Object.values(board).reduce((sum, e) => sum + e.hits, 0);
  const margin = totalHits > 0 ? (leaderHits - strongestChallengerHits) / totalHits : 0;

  // Growth consistency: is the leader still actively accumulating hits
  // recently, relative to every other color's hits? Measured via the global
  // hit sequence number (recordHit) rather than growthHistory.length, since
  // "has this color ever reached 3 hits" stays true forever once crossed and
  // says nothing about recency.
  const recentGrowth = recencyScore(archiveState, leader);

  const stability = clamp01(0.7 * clamp01(margin + 0.5) + 0.3 * recentGrowth);
  return stability;
}

/**
 * Identify the strongest challenger color and its pressure on the leader.
 */
function computeChallengerPressure(archiveState) {
  const board = archiveState.leaderboard;
  const leader = archiveState.dominantColor;
  if (!leader || !board[leader]) return { challenger: null, pressure: 0 };

  const challengers = Object.keys(board).filter(c => c !== leader);
  if (challengers.length === 0) return { challenger: null, pressure: 0 };

  challengers.sort((a, b) => board[b].hits - board[a].hits);
  const topChallenger = challengers[0];
  const leaderHits = board[leader].hits;
  const challengerHits = board[topChallenger].hits;

  const pressure = leaderHits > 0
    ? clamp01(challengerHits / leaderHits)
    : (challengerHits > 0 ? 1 : 0);

  return { challenger: topChallenger, pressure };
}

/**
 * Pressure a specific challenger color is exerting against a specific
 * reference color (not necessarily the archive's overall dominant color).
 * Used when arbitrating a transition away from the ladder's standing
 * prediction, which may differ from the archive's current leaderboard
 * leader (e.g. early in a season before the archive has caught up).
 */
function computePressureAgainst(archiveState, referenceColor, challengerColor) {
  const board = archiveState.leaderboard;
  if (!challengerColor || !referenceColor) return 0;
  const referenceHits = board[referenceColor] ? board[referenceColor].hits : 0;
  const challengerHits = board[challengerColor] ? board[challengerColor].hits : 0;
  if (referenceHits === 0) return challengerHits > 0 ? 1 : 0;
  return clamp01(challengerHits / referenceHits);
}

/**
 * Stability of a specific reference color (e.g. the ladder's standing
 * prediction), which may not be the archive's current overall dominant
 * color. Mirrors computeLeaderStability but pinned to referenceColor.
 */
function computeStabilityOf(archiveState, referenceColor) {
  const board = archiveState.leaderboard;
  if (!referenceColor || !board[referenceColor]) return 0;

  const referenceHits = board[referenceColor].hits;
  const others = Object.keys(board).filter(c => c !== referenceColor);
  const strongestOtherHits = others.length ? Math.max(...others.map(c => board[c].hits)) : 0;
  const totalHits = Object.values(board).reduce((sum, e) => sum + e.hits, 0);
  const margin = totalHits > 0 ? (referenceHits - strongestOtherHits) / totalHits : 0;

  const recentGrowth = recencyScore(archiveState, referenceColor);

  return clamp01(0.7 * clamp01(margin + 0.5) + 0.3 * recentGrowth);
}

// Scales expectedShare (the leader's fraction of recent draws) so that
// even a modest recent hit share meaningfully reduces the decay score,
// rather than requiring the leader to win ~100% of recent draws before
// decay reads as low. With 4 colors in play, a "healthy" leader hitting
// roughly 1-in-3 recent draws (a 3-4x-random share) should already read as
// non-decayed -- 1/3 * DECAY_RECENCY_SCALE == 1 gives exactly that.
const DECAY_RECENCY_SCALE = 3;

/**
 * Leadership decay: has the dominant color gone cold recently relative to
 * its historical pace? Returns 0..1 (1 = fully decayed / stale leader).
 */
function computeLeadershipDecay(archiveState, draws, lookback = 10) {
  const leader = archiveState.dominantColor;
  if (!leader) return 0;
  const recent = draws.slice(-lookback);
  const recentHitsForLeader = recent.filter(d => d.color === leader).length;
  const expectedShare = recent.length > 0 ? recentHitsForLeader / recent.length : 0;
  // Low recent share = high decay
  return clamp01(1 - expectedShare * DECAY_RECENCY_SCALE);
}

/**
 * Strategic prediction: follow the dominant color.
 */
function strategicPredict(archiveState) {
  if (!archiveState.awake || !archiveState.dominantColor) {
    return { color: null, confidence: 0 };
  }
  const stability = computeLeaderStability(archiveState);
  const confidence = Math.round(clamp01(stability) * 100);
  return { color: archiveState.dominantColor, confidence, stability };
}

/**
 * Close and archive the current season's leaderboard.
 */
function closeSeason(archiveState, closedAtDrawId) {
  if (!archiveState.awake) return archiveState;
  archiveState.history.push({
    seasonId: archiveState.seasonId,
    closedAtDrawId,
    finalLeaderboard: JSON.parse(JSON.stringify(archiveState.leaderboard)),
    dominantColor: archiveState.dominantColor
  });
  archiveState.awake = false;
  archiveState.seasonId = null;
  archiveState.leaderboard = {};
  archiveState.dominantColor = null;
  archiveState._hitSeq = 0;
  return archiveState;
}

/**
 * How recently a color last hit, relative to the total number of confirmed
 * archive hits seen so far across ALL colors -- 1 = this color holds the
 * single most recent hit in the whole archive, decaying toward 0 as more
 * hits for OTHER colors land after this color's last one.
 *
 * Uses the global hitSeq counter (recordHit) rather than growthHistory.length
 * (which only reflects total hit count for this one color and stays
 * permanently maxed out once it crosses a fixed count, regardless of how
 * long ago that was) or drawId arithmetic (drawId is an opaque external
 * Bet9ja identifier with no guaranteed fixed increment per draw).
 */
function recencyScore(archiveState, color) {
  const board = archiveState.leaderboard;
  const entry = board[color];
  if (!entry || !entry.lastSeenHitSeq) return 0;

  const totalHits = archiveState._hitSeq || 0;
  if (totalHits === 0) return 0;

  const hitsSinceThisColor = totalHits - entry.lastSeenHitSeq; // 0 = most recent hit overall
  const RECENCY_WINDOW = 3; // hits (by any color) allowed to elapse before recency fully decays
  return clamp01(1 - hitsSinceThisColor / RECENCY_WINDOW);
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

module.exports = {
  wake,
  recordHit,
  recomputeDominant,
  computeLeaderStability,
  computeChallengerPressure,
  computePressureAgainst,
  computeStabilityOf,
  computeLeadershipDecay,
  strategicPredict,
  closeSeason
};
