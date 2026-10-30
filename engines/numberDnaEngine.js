'use strict';

// ── NUMBER DNA ENGINE — blueprint §13 ───────────────────────────────────
//
// Pure, read-only synthesis layer. Classifies each number into a
// behavioral profile (STABLE RECURRER, FAST REPEATER, GAP RUNNER,
// CLUSTER NUMBER, COMPANION NUMBER, VOLATILE NUMBER, RECOVERY NUMBER)
// using signals that already exist elsewhere — frequency-window trend,
// gap/survivor behavior, group membership, and momentum — rather than
// computing anything new from raw draw history itself. It does not feed
// back into scoring; it's a diagnostic label, same convention as
// explainabilityEngine.js (computed last, cannot influence the
// prediction it's describing).
//
// Six named DNA attributes per number, each HIGH/MEDIUM/LOW, feed a
// single DNA_CLASS label per the blueprint's example:
//   Frequency        HIGH
//   Recurrence       HIGH
//   Gap behavior     MEDIUM
//   Companion links  VERY HIGH
//   Momentum         HIGH
//   Volatility       LOW
//   DNA CLASS: STABLE RECURRER

function bucket3(value, lowMax, highMin) {
  if (value >= highMin) return 'HIGH';
  if (value <= lowMax) return 'LOW';
  return 'MEDIUM';
}

// Recurrence: how often a number shows up more than once within short
// historical windows (blueprint §6) — approximated here from the
// frequency-window table's 5-draw and 10-draw counts, since a number
// appearing 2+ times in a 5-draw window is a repeat within a short span.
function recurrenceLevel(freqRow) {
  if (!freqRow) return 'LOW';
  const d5 = freqRow.d5 || 0;
  const d10 = freqRow.d10 || 0;
  if (d5 >= 2 || d10 >= 3) return 'HIGH';
  if (d10 >= 1) return 'MEDIUM';
  return 'LOW';
}

function gapBehaviorLevel(survivorScore) {
  // survivorScore is already a 0-100 gap-health score from numberEngine.js
  // (higher = gap sitting in a healthy, "about to repeat" range).
  return bucket3(survivorScore || 0, 45, 75);
}

function companionLinksLevel(groupIntel, num) {
  if (!groupIntel) return 'LOW';
  const inActive = (groupIntel.activeGroups || []).some(g => g.members.includes(num));
  const inEmerging = (groupIntel.emergingGroups || []).some(g => g.members.includes(num));
  if (inActive) return 'VERY HIGH';
  if (inEmerging) return 'MEDIUM';
  return 'LOW';
}

function momentumLevel(momentumScore) {
  return bucket3(momentumScore || 0, 40, 70);
}

function frequencyLevel(freqRow) {
  if (!freqRow || freqRow.trend === 'INSUFFICIENT_DATA') return 'LOW';
  if (freqRow.trend === 'HOT') return 'HIGH';
  if (freqRow.trend === 'COOLING' || freqRow.trend === 'WEAK') return 'LOW';
  return 'MEDIUM';
}

// Volatility: how much a number's short-window rate swings relative to
// its long-run rate — a HOT-or-WEAK-swinging number is volatile; a
// consistently STABLE-trending number is not. Approximated from the same
// frequency-window row rather than a separate variance computation,
// since the trend classification already captures this deviation.
function volatilityLevel(freqRow, overextensionFlag) {
  if (overextensionFlag && overextensionFlag.status === 'OVEREXTENDED') return 'HIGH';
  if (!freqRow) return 'LOW';
  if (freqRow.trend === 'HOT' || freqRow.trend === 'COOLING') return 'MEDIUM';
  return 'LOW';
}

// Maps the six attribute levels to one named DNA class. Order of checks
// matters — more specific/extreme profiles are checked before falling
// back to general ones.
function classify(attrs) {
  const { frequency, recurrence, gapBehavior, companionLinks, momentum, volatility } = attrs;

  if (volatility === 'HIGH') return 'VOLATILE NUMBER';
  if (companionLinks === 'VERY HIGH' && frequency !== 'LOW') return 'CLUSTER NUMBER';
  if (companionLinks !== 'LOW' && recurrence !== 'HIGH' && frequency === 'LOW') return 'COMPANION NUMBER';
  if (gapBehavior === 'HIGH' && frequency === 'LOW') return 'RECOVERY NUMBER';
  if (recurrence === 'HIGH' && momentum === 'HIGH' && gapBehavior !== 'LOW') return 'FAST REPEATER';
  if (frequency === 'HIGH' && recurrence !== 'LOW' && volatility === 'LOW') return 'STABLE RECURRER';
  if (gapBehavior !== 'LOW' && frequency !== 'HIGH') return 'GAP RUNNER';
  if (frequency === 'LOW' && recurrence === 'LOW' && companionLinks === 'LOW') return 'DORMANT NUMBER';
  return 'STABLE RECURRER'; // sensible default for a middling, unremarkable profile
}

// `candidates` is the array numberEngine.js already builds (one entry per
// number 1-49 with layerScores). `freqWindows` is frequencyWindowEngine's
// output; `groupIntel` and `overextension` are the other engines' own
// outputs — all already computed by the time this runs.
function computeNumberDna(candidates, freqWindows, groupIntel, overextension) {
  const profiles = {};

  for (const c of candidates) {
    const num = c.num;
    const freqRow = freqWindows && freqWindows.table ? freqWindows.table[num] : null;
    const overextFlag = overextension && overextension.flags ? overextension.flags[num] : null;

    const attrs = {
      frequency: frequencyLevel(freqRow),
      recurrence: recurrenceLevel(freqRow),
      gapBehavior: gapBehaviorLevel(c.layerScores ? c.layerScores.survivor : null),
      companionLinks: companionLinksLevel(groupIntel, num),
      momentum: momentumLevel(c.layerScores ? c.layerScores.momentum : null),
      volatility: volatilityLevel(freqRow, overextFlag)
    };

    profiles[num] = {
      num,
      attributes: attrs,
      dnaClass: classify(attrs)
    };
  }

  return profiles;
}

module.exports = {
  computeNumberDna
};
