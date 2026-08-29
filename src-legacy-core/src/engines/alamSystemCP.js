'use strict';
/**
 * alamSystem.js  v1.0.0 (COLOR LAB port)
 *
 * ALAM — Alert / Last-stand Alert Monitor.
 *
 * Watches the 3-Color Last Stand (threeBallLastStand.js) and the 4-Ball
 * Last Stand (four-ball-last-stand route, derived from lifecycleEngine) and
 * turns a LAST_STAND detection on EITHER engine into a single high-visibility
 * warning the frontend renders regardless of which tab the user is on.
 *
 * No prediction math lives here — this only reads battleStatus / statePill
 * fields already computed elsewhere and formats the alert banner text.
 */

/**
 * Builds one ALAM alert entry for a single engine.
 * @param {string} engineLabel - '3-COLOR' | '4-BALL'
 * @param {object} battle      - battle/last-stand object with battleStatus or statePill,
 *                               leader, lastStandProbability, leadGap / drawsRemaining
 */
function buildAlamAlert(engineLabel, battle) {
  // 3-Color: battleStatus === 'LAST_STAND'
  // 4-Ball:  confirmed === true OR statePill === 'LAST STAND'
  const is3Ball = engineLabel === '3-COLOR';
  const active  = is3Ball
    ? (!!battle && battle.battleStatus === 'LAST_STAND')
    : (!!battle && (battle.confirmed === true || battle.statePill === 'LAST STAND'));

  const leader = battle && battle.leader
    ? battle.leader.toUpperCase()
    : battle && battle.currentColor
    ? battle.currentColor.toUpperCase()
    : null;

  // Urgency suffix — 3-ball uses leadGap, 4-ball uses drawsRemaining
  let urgencySuffix = '';
  if (active) {
    if (is3Ball && battle.leadGap != null) {
      const g = Math.max(0, Math.round(battle.leadGap));
      urgencySuffix = ` (${g} pt${g === 1 ? '' : 's'} lead left)`;
    } else if (!is3Ball && battle.drawsRemaining != null && battle.drawsRemaining !== '—') {
      const d = Math.round(battle.drawsRemaining);
      urgencySuffix = ` (${d} draw${d === 1 ? '' : 's'} remaining)`;
    }
  }

  return {
    engine:              engineLabel,
    triggered:           active,
    severity:            active ? 'CRITICAL' : 'NONE',
    icon:                active ? '🚨' : null,
    headline:            active && leader
      ? `🚨 LAST STAND — ${leader} possibly about to fire its final shot before exit${urgencySuffix}.`
      : null,
    leader:              (battle && (battle.leader || battle.currentColor)) || null,
    challenger:          (battle && battle.challenger) || null,
    lastStandProbability:(battle && battle.lastStandProbability) || 0,
  };
}

/**
 * Aggregates ALAM alerts across the 3-Color and 4-Ball engines.
 *
 * @param {object} params
 * @param {object} params.threeBall - result of computeThreeBallLastStand()
 * @param {object} params.fourBall  - result of /api/trading/four-ball-last-stand
 * @returns {{ alerts, triggeredAlerts, anyTriggered }}
 */
function generateAlamAlerts({ threeBall, fourBall } = {}) {
  const alerts = [];

  if (threeBall) alerts.push(buildAlamAlert('3-COLOR', threeBall));
  if (fourBall)  alerts.push(buildAlamAlert('4-BALL',  fourBall));

  const triggeredAlerts = alerts.filter(a => a.triggered);

  return {
    alerts,
    triggeredAlerts,
    anyTriggered: triggeredAlerts.length > 0,
  };
}

module.exports = { buildAlamAlert, generateAlamAlerts };
