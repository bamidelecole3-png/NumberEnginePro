/**
 * Cross-Tier Progression Lab — Blueprint Phase 6.
 *
 * Every color maintains a progression timeline across the 3-ball -> 4-ball
 * -> 5-ball ladder. This engine studies that timeline historically to
 * answer three distinct questions per color:
 *
 *   1. Delays    — on average, how many draws pass between a 3-ball event
 *                  and the 4-ball event that follows it (when one does),
 *                  between a 4-ball event and the 5-ball event that
 *                  follows it, and between a 3-ball event and a 5-ball
 *                  event that follows DIRECTLY (no 4-ball event of this
 *                  color in between)?
 *   2. Transition probabilities — given a 3-ball event, what fraction of
 *                  the time does a 4-ball event follow within a fixed
 *                  draw window? Same question for 4-ball -> 5-ball, and
 *                  for the direct 3-ball -> 5-ball path. These are the
 *                  blueprint's named "82% within 4 draws" / "71% within 3
 *                  draws" style figures.
 *   3. Ladder score — given where this color sits RIGHT NOW (does it have
 *                  an unescalated 3-ball or 4-ball hit still within its
 *                  own historical transition window?), a single 0-100
 *                  score blending its current ladder position with this
 *                  color's own historical escalation rate.
 *
 * HONESTY NOTE (same spirit as gapDistributionEngine.js): these are real
 * frequencies computed from actual historical escalations, not calibrated
 * probabilities of a future event. A color with an 82% "3-ball -> 4-ball
 * within 4 draws" rate historically climbed the ladder that often when it
 * had a small sample of 3-ball events -- it is not a guarantee, and the
 * sample size (`sample` on each transition figure) should always be read
 * alongside the percentage, not instead of it.
 */

'use strict';

const { HIERARCHY, argMaxColorBy } = require('../core/colorMath');
const { mean } = require('../core/statMath');
const { tierValue } = require('./runwayFeatureEngine');

// Draw windows within which an escalation "counts" for the transition-
// probability figures. Chosen to roughly bracket the blueprint's own
// example windows (4 draws for 3->4, 3 draws for 4->5) while giving the
// rarer direct 3->5 path more room (8 draws) since skipping a rung
// entirely is inherently a longer-odds, more spread-out event.
const WINDOW_3_TO_4 = 5;
const WINDOW_4_TO_5 = 4;
const WINDOW_3_TO_5_DIRECT = 8;

// Below this many `fromTier` events, a transition probability is reported
// as null (insufficient sample) rather than a potentially wild percentage
// off 1 or 2 data points.
const MIN_SAMPLE_FOR_PROBABILITY = 3;

// Builds this color's chronological (oldest-first) sequence of tier
// events -- one entry per draw where the color reached tier 3, 4, or 5,
// carrying its position (`index`) in the ORIGINAL newest-first
// historicalDraws array so gap arithmetic stays consistent with every
// other engine in this codebase (index = draws-ago, smaller = more
// recent).
function buildTierEvents(historicalDraws, color) {
  const events = [];
  for (let i = historicalDraws.length - 1; i >= 0; i--) {
    const t = tierValue(historicalDraws[i], color);
    if (t > 0) events.push({ index: i, tier: t });
  }
  return events;
}

// For every event at exactly `fromTier`, looks at the IMMEDIATE next event
// chronologically (regardless of its tier); if that next event's tier is
// >= toTierMin, records the draw gap between them as a genuine escalation
// delay. An intervening event of a lower/different tier breaks the chain
// and is simply not counted (matches "the delay FROM a 3-ball event TO
// the 4-ball event that actually follows it," not an average over
// unrelated pairs).
function escalationDelays(events, fromTier, toTierMin) {
  const delays = [];
  for (let i = 0; i < events.length - 1; i++) {
    if (events[i].tier !== fromTier) continue;
    const next = events[i + 1];
    if (next.tier >= toTierMin) {
      delays.push(events[i].index - next.index); // index decreases forward in time
    }
  }
  return delays;
}

// For every event at exactly `fromTier`, checks whether ANY later event
// (not just the immediate next one) reaches >= toTierMin within `window`
// draws. This is deliberately more permissive than escalationDelays above
// -- a transition PROBABILITY should count "did it escalate at all within
// the window," even if another same-tier or lower event happened in
// between, whereas the DELAY figure specifically wants the direct
// next-event relationship.
function transitionProbability(events, fromTier, toTierMin, window) {
  const froms = events.filter(e => e.tier === fromTier);
  if (froms.length < MIN_SAMPLE_FOR_PROBABILITY) {
    return { probability: null, sample: froms.length };
  }
  let successes = 0;
  froms.forEach(f => {
    const escalated = events.some(e => e.tier >= toTierMin && e.index < f.index && (f.index - e.index) <= window);
    if (escalated) successes++;
  });
  return { probability: Math.round((successes / froms.length) * 100), sample: froms.length };
}

// Where does this color currently sit on the ladder? Scans from the most
// recent draw backward (uncapped -- a color's most recent 3/4-ball hit
// could be well outside the RUNWAY_WINDOW=20 used elsewhere, and knowing
// "how long ago" matters even when it's far outside any escalation
// window, to correctly report OFF_LADDER rather than a stale rung).
function currentLadderPosition(historicalDraws, color) {
  let gapSince3 = null, gapSince4 = null;
  for (let i = 0; i < historicalDraws.length; i++) {
    const t = tierValue(historicalDraws[i], color);
    if (t >= 3 && gapSince3 === null) gapSince3 = i;
    if (t >= 4 && gapSince4 === null) gapSince4 = i;
    if (gapSince3 !== null && gapSince4 !== null) break;
  }

  // On the 4-ball rung (awaiting 5) takes priority over the 3-ball rung
  // whenever the 4-ball hit is the MORE RECENT of the two (smaller gap) --
  // i.e. the color's most recent relevant hit was a 4-ball, not a 3-ball
  // that happens to still be lingering in memory from further back.
  if (gapSince4 !== null && (gapSince3 === null || gapSince4 <= gapSince3) && gapSince4 <= WINDOW_4_TO_5 * 2) {
    return { position: 'ON_4BALL_RUNG_AWAITING_5', gapSince3, gapSince4 };
  }
  if (gapSince3 !== null && (gapSince4 === null || gapSince3 < gapSince4) && gapSince3 <= WINDOW_3_TO_4 * 2) {
    return { position: 'ON_3BALL_RUNG_AWAITING_4', gapSince3, gapSince4 };
  }
  return { position: 'OFF_LADDER', gapSince3, gapSince4 };
}

function computeLadderScore(positionInfo, p3to4, p4to5) {
  const { position, gapSince3, gapSince4 } = positionInfo;

  if (position === 'ON_4BALL_RUNG_AWAITING_5') {
    const windowFactor = Math.max(0, 1 - (gapSince4 / WINDOW_4_TO_5));
    const base = p4to5.probability != null ? p4to5.probability : 50;
    return Math.round(base * (0.5 + 0.5 * windowFactor));
  }
  if (position === 'ON_3BALL_RUNG_AWAITING_4') {
    const windowFactor = Math.max(0, 1 - (gapSince3 / WINDOW_3_TO_4));
    const base = p3to4.probability != null ? p3to4.probability : 50;
    // Discounted relative to the 4-ball rung case: this color is two
    // rungs away from a 5-ball event, not one, so the same base
    // probability represents weaker evidence toward the actual target.
    return Math.round(base * (0.5 + 0.5 * windowFactor) * 0.6);
  }
  return 0;
}

function analyzeCrossTierProgressionForColor(historicalDraws, color) {
  const events = buildTierEvents(historicalDraws, color);

  const delays3to4 = escalationDelays(events, 3, 4);
  const delays4to5 = escalationDelays(events, 4, 5);
  const delays3to5Direct = escalationDelays(events, 3, 5);

  const p3to4 = transitionProbability(events, 3, 4, WINDOW_3_TO_4);
  const p4to5 = transitionProbability(events, 4, 5, WINDOW_4_TO_5);
  const p3to5Direct = transitionProbability(events, 3, 5, WINDOW_3_TO_5_DIRECT);

  const positionInfo = currentLadderPosition(historicalDraws, color);
  const ladderScore = computeLadderScore(positionInfo, p3to4, p4to5);

  const reasoning = positionInfo.position === 'ON_4BALL_RUNG_AWAITING_5'
    ? `${color} hit 4-ball ${positionInfo.gapSince4} draw(s) ago and hasn't escalated yet; historically escalates to 5-ball within ${WINDOW_4_TO_5} draws ${p4to5.probability != null ? `${p4to5.probability}% of the time (n=${p4to5.sample})` : '(insufficient sample)'}`
    : positionInfo.position === 'ON_3BALL_RUNG_AWAITING_4'
      ? `${color} hit 3-ball ${positionInfo.gapSince3} draw(s) ago and hasn't escalated yet; historically escalates to 4-ball within ${WINDOW_3_TO_4} draws ${p3to4.probability != null ? `${p3to4.probability}% of the time (n=${p3to4.sample})` : '(insufficient sample)'}`
      : `${color} is not currently on an active ladder rung (no recent unescalated 3-ball or 4-ball hit).`;

  return {
    color,
    ladderPosition: positionInfo.position,
    gapSince3: positionInfo.gapSince3,
    gapSince4: positionInfo.gapSince4,
    delays: {
      avg3to4: delays3to4.length ? Math.round(mean(delays3to4) * 10) / 10 : null,
      avg4to5: delays4to5.length ? Math.round(mean(delays4to5) * 10) / 10 : null,
      avg3to5Direct: delays3to5Direct.length ? Math.round(mean(delays3to5Direct) * 10) / 10 : null,
      sample3to4: delays3to4.length,
      sample4to5: delays4to5.length,
      sample3to5Direct: delays3to5Direct.length
    },
    transitionProbabilities: {
      threeToFourWithin: { window: WINDOW_3_TO_4, probability: p3to4.probability, sample: p3to4.sample },
      fourToFiveWithin: { window: WINDOW_4_TO_5, probability: p4to5.probability, sample: p4to5.sample },
      threeToFiveDirectWithin: { window: WINDOW_3_TO_5_DIRECT, probability: p3to5Direct.probability, sample: p3to5Direct.sample }
    },
    ladderScore,
    reasoning
  };
}

function analyzeCrossTierProgression(historicalDraws) {
  const result = {};
  HIERARCHY.forEach(color => {
    result[color] = analyzeCrossTierProgressionForColor(historicalDraws, color);
  });

  const ladderScores = {};
  HIERARCHY.forEach(c => { ladderScores[c] = result[c].ladderScore; });
  const ladderLeader = argMaxColorBy(ladderScores);

  return { perColor: result, ladderLeader, ladderLeaderScore: result[ladderLeader].ladderScore };
}

module.exports = {
  WINDOW_3_TO_4,
  WINDOW_4_TO_5,
  WINDOW_3_TO_5_DIRECT,
  MIN_SAMPLE_FOR_PROBABILITY,
  buildTierEvents,
  escalationDelays,
  transitionProbability,
  currentLadderPosition,
  analyzeCrossTierProgression
};
