/**
 * Color Parliament Last Stand + Alam System — computed together.
 *
 * Wires up the three byte-for-byte ported Color Parliament modules
 * (threeBallLastStandCP.js, fourBallLastStandCP.js, alamSystemCP.js)
 * against Sniper V4's own draw history, via colorParliamentSeasonAdapter.js
 * for the 4-ball engine's archive dependency. See that adapter's header
 * comment for why the archive has to be replayed rather than reused
 * directly from Sniper V4's own (different) season model.
 */
'use strict';

const { store } = require('../core/store');
const threeBallLastStandCP = require('./threeBallLastStandCP');
const fourBallLastStandCP = require('./fourBallLastStandCP');
const alamSystemCP = require('./alamSystemCP');
const { replaySeasonAndArchive } = require('./colorParliamentSeasonAdapter');

/**
 * Converts Sniper V4's historicalDraws (newest-first, `.threeBallColor`)
 * into Color Parliament's expected oldest-first {drawId, color, timestamp}
 * shape for the 3-ball engine, which has no archive/season dependency of
 * its own -- see threeBallLastStandCP.js's header comment: it's active
 * whenever there's enough draw history, no season gate.
 */
function toThreeBallCPDraws(historicalDraws) {
  return (historicalDraws || [])
    .slice()
    .reverse()
    .map(d => ({
      drawId: d.drawId,
      color: d.threeBallColor || null,
      timestamp: d.timestamp || null
    }));
}

/**
 * Computes all three ported systems fresh from the current draw history.
 * Cheap enough to call on every request (same O(n) recompute-per-call
 * pattern this codebase already uses elsewhere, e.g. rareEventLabEngine.js)
 * -- no additional persisted state needed beyond store.historicalDraws,
 * which already exists.
 */
function computeColorParliamentLastStandAndAlam() {
  const historicalDraws = store.historicalDraws;

  const threeBallCPDraws = toThreeBallCPDraws(historicalDraws);
  const threeBall = threeBallLastStandCP.computeThreeBallLastStand(threeBallCPDraws);

  const { archiveState, cpDraws } = replaySeasonAndArchive(historicalDraws);
  const fourBall = fourBallLastStandCP.computeFourBallLastStand(cpDraws, archiveState);

  const alam = alamSystemCP.generateAlamAlerts({ threeBall, fourBall });

  return { threeBall, fourBall, alam };
}

module.exports = {
  computeColorParliamentLastStandAndAlam
};
