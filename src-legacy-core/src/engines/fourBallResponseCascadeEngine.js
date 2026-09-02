/**
 * 4-BALL RESPONSE/CASCADE ENGINE
 *
 * Implements ONLY the Response/Cascade section of the "4SIL Upgrade
 * Blueprint" -- Event Density, Repeat 4-Ball (general), Tie-Birth,
 * Transition changes, and Fast-Track from that same blueprint are
 * explicitly OUT of scope here, per operator direction ("carefully
 * implement ONLY CASCADE/RESPONSE").
 *
 * OPERATOR-SPECIFIED DEFINITION (narrower and more precise than the
 * blueprint's own generic Response/Cascade section 7-9, which this engine
 * follows literally instead of the blueprint's more elaborate NONE ->
 * WATCH -> CONFIRMED -> MULTI-COLOR -> CASCADE staged model):
 *
 *   Let "Top color" = the season's overall dominant 4-ball color
 *   (fourBallSeasonIntelligenceLab.js's own `dominantColor` -- the same
 *   value every other 4SIL sub-engine already treats as the incumbent
 *   leader). The other two colors are the "non-Top colors."
 *
 *   Within the same rolling 10-draw window 4SIL already uses everywhere
 *   else (ENTER_NOW_EVENT_WINDOW), a strong ENTER signal fires when
 *   EITHER:
 *     (a) REPEAT NON-TOP: any ONE non-Top color fires a 4-ball event
 *         twice (>=2) in that window, or
 *     (b) DUAL NON-TOP: BOTH non-Top colors each fire a 4-ball event at
 *         least once (>=1 each) in that window.
 *
 * WHY THIS IS DIFFERENT FROM THE BLUEPRINT'S OWN SECTION 7 EXAMPLE:
 * blueprint section 7 defines the "trigger color" as whichever color
 * repeats (COLOR_A >= 2x4ball), then watches for ANY other color to
 * respond. The operator's definition anchors the trigger specifically to
 * the market's TOP (dominant/incumbent) color's two non-Top challengers --
 * i.e. "is activity concentrating away from the leader" rather than "did
 * whichever color repeated get a response." This matters architecturally:
 * it reads directly off dominantColor (already the leader every other
 * 4SIL sub-engine references) instead of introducing a second, competing
 * notion of "trigger color" that could disagree with the leader read
 * elsewhere in the same cycle.
 *
 * THIS IS A STRONG ENTER SIGNAL, NOT AN OBSERVATIONAL SIDE-ENGINE: unlike
 * fourBallTieBirthEngine.js (which was scoped, per separate operator
 * direction, to stay purely read-only and NOT feed into 4SIL's own ENTER
 * NOW decision), this engine's whole purpose per THIS operator direction
 * is to become one more piece of evidence 4SIL's own gate consults --
 * exactly the blueprint's own Critical Rule: "NEW MODULES -> provide
 * additional evidence -> ORIGINAL 4SIL -> final timing decision." It is
 * wired into evaluateEnterNow() as one more weighted condition alongside
 * the existing ones (see fourBallSeasonIntelligenceLab.js), contributing
 * to confirmedCount/institutionalConfidence exactly the way every other
 * condition already does -- no new gate, no new required-AND, no
 * bypassing of the existing hard vetoes/thresholds. This also matches
 * blueprint rule 6 ("STABILIZED does not mean NO OPPORTUNITY") and rule 5
 * ("Do not require transition before every opportunity"): this condition
 * is intentionally NOT scoped to "only while an active transition battle
 * is underway" the way several of 4SIL's existing conditions are --
 * concentrated non-Top activity is real evidence on its own, transition
 * battle or not.
 *
 * TIE DOES NOT SELECT THE COLOR (blueprint section 19, same principle
 * applied here): this engine never outputs a recommended/predicted color.
 * It reports WHICH non-Top color(s) fired, as a factual, backward-looking
 * observation for the reasoning string -- Parliament remains the sole
 * color authority, and 4SIL (not this engine) decides what that fact is
 * worth toward timing.
 *
 * NO PERSISTENT STATE: pure recompute from historicalDraws every cycle,
 * same convention as fourBallTieBirthEngine.js and tiePrecursorPatternEngine.js.
 *
 * historicalDraws is newest-first (index 0 = most recent), matching every
 * other engine's convention.
 */
'use strict';

const { HIERARCHY } = require('../core/colorMath');

// Matches fourBallSeasonIntelligenceLab.js's own ENTER_NOW_EVENT_WINDOW --
// deliberately the SAME rolling window 4SIL's other tactical conditions
// (G, H, I, J) already use, so "strong ENTER signal" means the same thing
// here as it does everywhere else in 4SIL's own reasoning this cycle.
const RESPONSE_CASCADE_WINDOW = 10;
const REPEAT_NON_TOP_THRESHOLD = 2;

/**
 * @param {Array} historicalDraws  newest-first draw records (each with a
 *                                  .fourBallColor and .drawId)
 * @param {string|null} topColor   the season's dominant 4-ball color, or
 *                                  null when no season is active
 * @returns {object}
 */
function evaluateFourBallResponseCascade(historicalDraws, topColor) {
  const draws = Array.isArray(historicalDraws) ? historicalDraws : [];

  if (!topColor) {
    return {
      engine: '4-Ball Response/Cascade Engine',
      ready: false,
      cascadeResponse: false,
      reasoning: 'No Top color established (no active 4-ball season) -- Response/Cascade has nothing to compare against.'
    };
  }

  const window = draws.slice(0, RESPONSE_CASCADE_WINDOW);
  const nonTopColors = HIERARCHY.filter(c => c !== topColor);

  // Per non-Top color: how many 4-ball events it fired in the window, and
  // which draws those were (for the reasoning string / audit trail).
  const nonTopActivity = {};
  nonTopColors.forEach(color => {
    const hits = window.filter(d => d.fourBallColor === color);
    nonTopActivity[color] = {
      count: hits.length,
      drawIds: hits.map(d => d.drawId != null ? d.drawId : null)
    };
  });

  // (a) REPEAT NON-TOP: any single non-Top color fired >= 2 times.
  const repeatColor = nonTopColors.find(c => nonTopActivity[c].count >= REPEAT_NON_TOP_THRESHOLD) || null;
  const repeatNonTop = {
    active: !!repeatColor,
    color: repeatColor,
    count: repeatColor ? nonTopActivity[repeatColor].count : 0,
    drawIds: repeatColor ? nonTopActivity[repeatColor].drawIds : []
  };

  // (b) DUAL NON-TOP: BOTH non-Top colors fired at least once each.
  const dualNonTopFire = {
    active: nonTopColors.every(c => nonTopActivity[c].count >= 1),
    colors: nonTopColors.filter(c => nonTopActivity[c].count >= 1)
  };

  const cascadeResponse = repeatNonTop.active || dualNonTopFire.active;

  let reasoning;
  if (repeatNonTop.active && dualNonTopFire.active) {
    reasoning = `Strong ENTER signal: non-Top color ${repeatNonTop.color} fired ${repeatNonTop.count}x 4-ball in the last ${window.length} draws, AND both non-Top colors (${dualNonTopFire.colors.join(', ')}) fired at least once each -- activity is concentrating away from Top color ${topColor} on two independent fronts.`;
  } else if (repeatNonTop.active) {
    reasoning = `Strong ENTER signal: non-Top color ${repeatNonTop.color} fired ${repeatNonTop.count}x 4-ball events in the last ${window.length} draws (Top color is ${topColor}) -- repeated activity away from the incumbent leader.`;
  } else if (dualNonTopFire.active) {
    reasoning = `Strong ENTER signal: both non-Top colors (${dualNonTopFire.colors.join(', ')}) each fired a 4-ball event in the last ${window.length} draws (Top color is ${topColor}) -- activity is spreading across the whole field, not just the leader.`;
  } else {
    reasoning = `No cascade/response signal: non-Top colors ${nonTopColors.map(c => `${c}=${nonTopActivity[c].count}`).join(', ')} in the last ${window.length} draws (Top color is ${topColor}).`;
  }

  return {
    engine: '4-Ball Response/Cascade Engine',
    ready: true,
    topColor,
    nonTopColors,
    windowSize: window.length,
    nonTopActivity,
    repeatNonTop,
    dualNonTopFire,
    cascadeResponse,
    reasoning
  };
}

module.exports = {
  RESPONSE_CASCADE_WINDOW,
  REPEAT_NON_TOP_THRESHOLD,
  evaluateFourBallResponseCascade
};
