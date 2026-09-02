/**
 * General Parliament (3Ball) — All 11 Autonomous Engines.
 */
const { store } = require('../core/store');
const { HIERARCHY, argMaxColorBy, topNColorsBy } = require('../core/colorMath');
const { evaluateTacticalActivation } = require('../engines/tacticalEngine');
const { evaluateThreeBallEntryQuality } = require('../engines/threeBallEntryIntelligenceEngine');

// Below this many recorded 3-ball draws, every engine's window (recent10/
// recent30/recent50, the DNA gap scan, the pattern n-gram matcher) is
// operating on data too thin to mean anything -- most of them fall through
// to their all-zero-input default. Those defaults happen to agree with each
// other (e.g. argMaxColorBy's tie-break always picks the same HIERARCHY[0]
// color), which produces a false-unanimous, high-confidence vote out of
// pure fallback behavior rather than any real signal. fourBallParliament.js
// already has an equivalent activation gate (evaluateTacticalActivation);
// this brings General Parliament in line with it.
const MIN_DRAWS_FOR_ACTIVATION = 3;

function runGeneralParliament(historicalDraws, tieIntelligence) {
  if (!historicalDraws || historicalDraws.length < MIN_DRAWS_FOR_ACTIVATION) {
    return {
      parliament: 'General (3Ball)',
      active: false,
      status: `Insufficient draw history (${historicalDraws ? historicalDraws.length : 0}/${MIN_DRAWS_FOR_ACTIVATION} minimum) -- no vote cast.`,
      winningColor: null,
      confidence: 0,
      secondColor: null,
      secondConfidence: 0,
      tieAdjusted: false,
      votes: []
    };
  }

  const weights = store.engineWeights;
  const colorScores = { RED: 0, BLUE: 0, GREEN: 0 };
  const votes = [];

  const recent10 = historicalDraws.slice(0, 10);
  const recent30 = historicalDraws.slice(0, 30);
  const recent50 = historicalDraws.slice(0, 50);

  // 1. Momentum Engine
  const counts10 = { RED: 0, BLUE: 0, GREEN: 0 };
  recent10.forEach(d => {
    if (d.threeBallColor && counts10[d.threeBallColor] !== undefined) counts10[d.threeBallColor]++;
  });
  const momentumColor = argMaxColorBy(counts10);
  colorScores[momentumColor] += 25 * (weights['3B_Momentum'] || 1.4);
  votes.push({
    name: '3B_Momentum', council: '3-Ball', color: momentumColor,
    confidence: Math.min(90, 50 + (counts10[momentumColor] * 10)), eligible: true,
    reason: `Highest 3-ball frequency (${counts10[momentumColor]}) in last 10 draws`
  });

  // 2. Cycle Engine
  const lastDraw = historicalDraws[0];
  const prevDraw = historicalDraws[1];
  const lastColor = lastDraw ? (lastDraw.threeBallColor || (lastDraw.colors && lastDraw.colors[0]) || 'RED') : 'RED';
  const prevColor = prevDraw ? (prevDraw.threeBallColor || (prevDraw.colors && prevDraw.colors[0]) || 'BLUE') : 'BLUE';
  const isRepeating = lastColor === prevColor;
  const cycleColor = isRepeating ? lastColor : (lastColor === 'RED' ? 'BLUE' : 'RED');
  colorScores[cycleColor] += 18 * (weights['3B_Cycle'] || 1.1);
  votes.push({
    name: '3B_Cycle', council: '3-Ball', color: cycleColor,
    confidence: isRepeating ? 75 : 62, eligible: true,
    reason: isRepeating ? `Cycle persistence repeating ${cycleColor}` : `Alternating cycle sequence`
  });

  // 3. DNA Engine
  const dnaGaps = { RED: 0, BLUE: 0, GREEN: 0 };
  HIERARCHY.forEach(c => {
    let gap = 0;
    for (const d of recent50) {
      if (d.threeBallColor === c) break;
      gap++;
    }
    dnaGaps[c] = gap;
  });
  const dnaScores = {};
  HIERARCHY.forEach(c => {
    const g = dnaGaps[c];
    dnaScores[c] = (g >= 3 && g <= 7) ? (10 - Math.abs(g - 5)) : 1;
  });
  const dnaColor = argMaxColorBy(dnaScores);
  colorScores[dnaColor] += 20 * (weights['3B_DNA'] || 1.2);
  votes.push({
    name: '3B_DNA', council: '3-Ball', color: dnaColor,
    confidence: Math.min(85, 60 + dnaScores[dnaColor] * 3), eligible: true,
    reason: `DNA sweet-spot gap profile (${dnaGaps[dnaColor]} draws elapsed)`
  });

  // 4. Probability Engine
  const counts30 = { RED: 0, BLUE: 0, GREEN: 0 };
  recent30.forEach(d => {
    if (d.threeBallColor && counts30[d.threeBallColor] !== undefined) counts30[d.threeBallColor]++;
  });
  const probColor = argMaxColorBy(counts30);
  const total30Hits = Object.values(counts30).reduce((a, b) => a + b, 0) || 1;
  const empiricalProb = Math.round((counts30[probColor] / total30Hits) * 100);
  colorScores[probColor] += 22 * (weights['3B_Probability'] || 1.3);
  votes.push({
    name: '3B_Probability', council: '3-Ball', color: probColor,
    confidence: Math.min(92, Math.max(50, empiricalProb * 2)), eligible: true,
    reason: `Empirical 30-draw probability ${empiricalProb}%`
  });

  // 5. Transition Engine
  let transitionChallenger = momentumColor;
  let transitionActive = false;
  if (counts10[momentumColor] < 2) {
    transitionChallenger = HIERARCHY.find(c => c !== momentumColor && counts10[c] >= 1) || 'BLUE';
    transitionActive = true;
  }
  colorScores[transitionChallenger] += 18 * (weights['3B_Transition'] || 1.3);
  votes.push({
    name: '3B_Transition', council: '3-Ball', color: transitionChallenger,
    confidence: transitionActive ? 78 : 65, eligible: true,
    reason: transitionActive ? `Transition handoff favoring ${transitionChallenger}` : `Stable leader retention`
  });

  // 6. Recovery Engine
  let recoveryColor = momentumColor;
  for (const c of HIERARCHY) {
    if (dnaGaps[c] >= 4 && dnaGaps[c] <= 9 && counts30[c] >= 3) {
      recoveryColor = c;
      break;
    }
  }
  colorScores[recoveryColor] += 15 * (weights['3B_Recovery'] || 1.0);
  votes.push({
    name: '3B_Recovery', council: '3-Ball', color: recoveryColor,
    confidence: 68, eligible: true,
    reason: `Suppressed color recovery signal after ${dnaGaps[recoveryColor]} draws`
  });

  // 7. Pattern Engine
  const patternSeq = historicalDraws.slice(0, 3).map(d => d.threeBallColor || (d.colors && d.colors[0]) || 'RED').join('-');
  let patternColor = momentumColor;
  for (let i = 3; i < historicalDraws.length - 3; i++) {
    const seq = historicalDraws.slice(i, i + 3).map(d => d.threeBallColor || (d.colors && d.colors[0]) || 'RED').join('-');
    if (seq === patternSeq) {
      patternColor = historicalDraws[i - 1]
        ? (historicalDraws[i - 1].threeBallColor || (historicalDraws[i - 1].colors && historicalDraws[i - 1].colors[0]) || momentumColor)
        : momentumColor;
      break;
    }
  }
  colorScores[patternColor] += 18 * (weights['3B_Pattern'] || 1.2);
  votes.push({
    name: '3B_Pattern', council: '3-Ball', color: patternColor,
    confidence: 70, eligible: true,
    reason: `N-gram pattern match [${patternSeq}] -> ${patternColor}`
  });

  // 8. Gap Engine
  const overdueColor = argMaxColorBy(dnaGaps);
  colorScores[overdueColor] += 15 * (weights['3B_Gap'] || 1.0);
  votes.push({
    name: '3B_Gap', council: '3-Ball', color: overdueColor,
    confidence: Math.min(88, 50 + dnaGaps[overdueColor] * 4), eligible: true,
    reason: `Gap overdue analyzer (${dnaGaps[overdueColor]} draws elapsed)`
  });

  // 9. Confidence Engine
  // When momentum and probability agree, that shared color is the
  // high-confidence signal. When they disagree, cast the vote for the
  // probability signal (the disagreement itself is reflected in the
  // lower confStability below) rather than silently defaulting back to
  // momentum regardless of outcome.
  const agreeColor = (momentumColor === probColor) ? momentumColor : probColor;
  const confStability = (momentumColor === probColor) ? 88 : 64;
  colorScores[agreeColor] += 16 * (weights['3B_Confidence'] || 1.1);
  votes.push({
    name: '3B_Confidence', council: '3-Ball', color: agreeColor,
    confidence: confStability, eligible: true,
    reason: `Signal alignment stability score ${confStability}%`
  });

  // 10. Capital Protection Engine
  const safePick = (counts10[momentumColor] >= 2) ? momentumColor : argMaxColorBy(counts30);
  colorScores[safePick] += 20 * (weights['3B_CapitalProtection'] || 1.5);
  votes.push({
    name: '3B_CapitalProtection', council: '3-Ball', color: safePick,
    confidence: 82, eligible: true,
    reason: `Low-volatility capital protection filter for ${safePick}`
  });

  // 11. Dominance Engine
  const domColor = argMaxColorBy(counts30);
  const domShare = Math.round((counts30[domColor] / total30Hits) * 100);
  colorScores[domColor] += 20 * (weights['3B_Dominance'] || 1.2);
  votes.push({
    name: '3B_Dominance', council: '3-Ball', color: domColor,
    confidence: Math.min(92, 50 + domShare), eligible: true,
    reason: `30-draw market dominance share ${domShare}%`
  });

  const winningColor = argMaxColorBy(colorScores);
  const totalScore = Object.values(colorScores).reduce((a, b) => a + b, 0);
  const baseConfidence = Math.min(95, Math.max(40, Math.round((colorScores[winningColor] / (totalScore || 1)) * 100 * 2.2)));

  // Second-most-likely color, from the SAME aggregated colorScores every
  // engine above already voted into -- no individual engine's own logic
  // changes, this just reads one rank deeper into the existing tally. Two
  // colors are now always returned per draw per the two-color prediction
  // requirement; confidence for the second pick is scaled down relative to
  // the winner's confidence (it's a real but weaker signal, not a tie).
  const ranked = topNColorsBy(colorScores, 2);
  const secondColor = ranked[1] ? ranked[1].color : HIERARCHY.find(c => c !== winningColor);
  const secondScore = ranked[1] ? ranked[1].score : 0;
  const baseSecondConfidence = totalScore > 0
    ? Math.min(baseConfidence - 1, Math.max(20, Math.round((secondScore / totalScore) * 100 * 2.2)))
    : Math.max(20, baseConfidence - 25);

  // Tie-aware confidence dampening (spec section 6/7/9): when the Tie
  // Prediction Engine reports elevated tie risk for the 3-ball market, this
  // parliament's own color-dominance confidence is inherently less
  // reliable -- a "no clear winner" pattern is actively recurring, so
  // asserting high confidence in either color is overconfident. This does
  // NOT touch any individual engine's vote, colorScores, or the winning
  // color/second color selection itself -- only the two final confidence
  // numbers are damped, and only when tieIntelligence says risk is
  // meaningfully elevated (ELEVATED or HIGH tieWarning level).
  let confidence = baseConfidence;
  let secondConfidence = baseSecondConfidence;
  let tieAdjusted = false;
  if (tieIntelligence && tieIntelligence.tieWarning) {
    const level = tieIntelligence.tieWarning.level;
    const tieScore = tieIntelligence.tieWarning.score || 0;
    if (level === 'HIGH' || level === 'ELEVATED') {
      // Dampening factor scales with the tie warning score itself (0-95),
      // capped so confidence is reduced, never inflated, and never driven
      // below a 25% floor (a "no prediction possible" state isn't useful --
      // the engine should still name its best guess, just with appropriately
      // lowered confidence, matching how every other engine in this
      // codebase floors its own confidence rather than emitting 0%).
      const dampFactor = 1 - Math.min(0.35, (tieScore / 95) * 0.35);
      confidence = Math.max(25, Math.round(baseConfidence * dampFactor));
      secondConfidence = Math.max(20, Math.round(baseSecondConfidence * dampFactor));
      tieAdjusted = true;
    }
  }

  // 3-Ball Entry Intelligence Engine — mirrors fourBallParliament.js's own
  // `fullEntryIntelligence` wiring exactly, just re-keyed to the 3-ball
  // stream and anchored to THIS parliament's own predicted color
  // (winningColor) rather than an independently-recomputed dominant color
  // -- see threeBallEntryIntelligenceEngine.js's header for why.
  const threeBallActivation = evaluateTacticalActivation(historicalDraws).threeBall;
  const threeBallSeasonAge = threeBallActivation.reconstructedSeasonAge;

  const threeBallCounts = { RED: 0, BLUE: 0, GREEN: 0 };
  for (const d of historicalDraws) {
    if (d.threeBallColor && threeBallCounts[d.threeBallColor] !== undefined) {
      threeBallCounts[d.threeBallColor]++;
    }
  }
  const totalThreeBallHits = Object.values(threeBallCounts).reduce((a, b) => a + b, 0) || 1;
  const threeBallDominanceSharePct = Math.round((threeBallCounts[winningColor] / totalThreeBallHits) * 100);

  // Same conservative heuristic fourBallParliament.js uses for transRisk
  // (see its own "6. Transition Risk Engine" comment) -- no dedicated
  // 3-ball transition-risk engine exists yet, so this stays a simple,
  // clearly-labeled placeholder rather than a fabricated sophisticated one.
  const threeBallTransitionRisk = threeBallSeasonAge > 10 ? 60 : 15;

  const threeBallEntryIntelligence = evaluateThreeBallEntryQuality(
    threeBallSeasonAge,
    confidence,
    winningColor,
    {
      dominanceScore: threeBallDominanceSharePct,
      transitionRisk: threeBallTransitionRisk,
      exitRisk: 0, // no 3-ball Exit Intelligence engine exists yet -- see computeRiskLevel's comment in threeBallEntryIntelligenceEngine.js
      historicalDraws
    }
  );

  return {
    parliament: 'General (3Ball)',
    active: true,
    winningColor,
    confidence,
    secondColor,
    secondConfidence,
    tieAdjusted,
    // Exposed so downstream consumers (council, UI) get the full
    // Tier-Engine-depth 3-ball entry analysis without recomputing it --
    // same exposure pattern as fourBallP.entryIntelligence.
    entryIntelligence: threeBallEntryIntelligence,
    votes
  };
}

module.exports = {
  runGeneralParliament
};
