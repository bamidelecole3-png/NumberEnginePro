'use strict';

// ── GROUP INTELLIGENCE ENGINE — v19 ─────────────────────────────────────
//
// Distinct from SCIE: SCIE tracks *directed* trigger→target relationships
// across consecutive draws (does number A appearing predict number B
// showing up within the next few draws). Group Intelligence instead
// tracks *undirected co-occurrence groups* (pairs and triplets that tend
// to land in the SAME draw together), with an explicit lifecycle:
// strengthening, emerging, and retiring — then supplies a per-number
// "group confidence" score into CAME as its own 7th layer, exactly as the
// blueprint asks.
//
// Stateless by design (recomputed fully from draw history on every call),
// matching the existing SCIE convention (analyzeHistoricalReliability
// also recomputes from scratch every call, no persisted state) — the
// lifecycle labels below (ACTIVE / EMERGING / RETIRED) fall naturally out
// of comparing a group's full-history rate against its recent-window
// rate, so no separate "memory" needs to be carried between calls.

const RECENT_WINDOW = 20;      // window used to judge "is this group still active right now"
const MIN_TOTAL_OBSERVED = 4;  // a group needs at least this many co-occurrences to be considered at all
const STRENGTH_RATIO_ACTIVE = 1.8;   // co-occurs this many times more than an average pair/triplet
const STRENGTH_RATIO_EMERGING = 1.5; // slightly lower bar, since emerging groups have less history to prove themselves
const MAX_TRACKED = 40; // cap how many groups get returned, so the response stays a reasonable size

function safeSlice(draws, n) {
  return draws.slice(0, Math.min(n, draws.length));
}

function pairKey(a, b) {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function tripletKey(a, b, c) {
  return [a, b, c].sort((x, y) => x - y).join('-');
}

// Counts how many draws (within `slice`) contain every member of `key`
// together, for a Map already built with observation counts by key.
function buildCoOccurrenceCounts(draws) {
  const pairCounts = new Map();
  const tripletCounts = new Map();

  for (const d of draws) {
    const nums = d.numbers;
    for (let i = 0; i < nums.length; i++) {
      for (let j = i + 1; j < nums.length; j++) {
        const pk = pairKey(nums[i], nums[j]);
        pairCounts.set(pk, (pairCounts.get(pk) || 0) + 1);
        for (let k = j + 1; k < nums.length; k++) {
          const tk = tripletKey(nums[i], nums[j], nums[k]);
          tripletCounts.set(tk, (tripletCounts.get(tk) || 0) + 1);
        }
      }
    }
  }

  return { pairCounts, tripletCounts };
}

function classifyGroups(fullCounts, recentCounts, recentWindowSize, totalDraws, members) {
  const groups = [];
  if (fullCounts.size === 0) return groups;

  const totalObservedSum = [...fullCounts.values()].reduce((a, b) => a + b, 0);
  const avgRate = totalDraws > 0 ? (totalObservedSum / fullCounts.size) / totalDraws : 0;

  for (const [key, totalObserved] of fullCounts.entries()) {
    if (totalObserved < MIN_TOTAL_OBSERVED) continue;

    const actualRate = totalDraws > 0 ? totalObserved / totalDraws : 0;
    const strengthRatio = avgRate > 0 ? actualRate / avgRate : 0;
    const recentObserved = recentCounts.get(key) || 0;
    const recentRate = recentWindowSize > 0 ? recentObserved / recentWindowSize : 0;

    let status = null;
    if (strengthRatio >= STRENGTH_RATIO_ACTIVE && recentObserved >= 1) {
      status = 'ACTIVE';
    } else if (strengthRatio >= STRENGTH_RATIO_ACTIVE && recentObserved === 0) {
      status = 'RETIRED'; // used to be strong, has gone quiet in the recent window
    } else if (strengthRatio >= STRENGTH_RATIO_EMERGING && recentRate > actualRate * 1.4 && recentObserved >= 2) {
      status = 'EMERGING'; // heating up faster than its own long-run average suggests
    }
    if (!status) continue;

    groups.push({
      members: key.split('-').map(Number),
      size: members,
      totalObserved,
      recentObserved,
      strengthRatio: Math.round(strengthRatio * 100) / 100,
      confidence: Math.max(0, Math.min(100, Math.round((strengthRatio - 1) * 35 + (recentObserved > 0 ? 15 : 0)))),
      status
    });
  }

  return groups.sort((a, b) => b.confidence - a.confidence);
}

function computeGroupIntelligence(draws) {
  if (!draws || draws.length < 10) {
    return {
      groupScores: emptyScoreMap(),
      activeGroups: [],
      emergingGroups: [],
      retiredGroups: [],
      groupConfidence: 'LOW',
      totalGroupsTracked: 0
    };
  }

  const totalDraws = draws.length;
  const recentWindowSize = Math.min(RECENT_WINDOW, draws.length);
  const recent = safeSlice(draws, RECENT_WINDOW);

  const { pairCounts, tripletCounts } = buildCoOccurrenceCounts(draws);
  const { pairCounts: recentPairCounts, tripletCounts: recentTripletCounts } = buildCoOccurrenceCounts(recent);

  const pairGroups = classifyGroups(pairCounts, recentPairCounts, recentWindowSize, totalDraws, 2);
  const tripletGroups = classifyGroups(tripletCounts, recentTripletCounts, recentWindowSize, totalDraws, 3);

  const allGroups = [...pairGroups, ...tripletGroups]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_TRACKED);

  const activeGroups = allGroups.filter(g => g.status === 'ACTIVE');
  const emergingGroups = allGroups.filter(g => g.status === 'EMERGING');
  const retiredGroups = allGroups.filter(g => g.status === 'RETIRED');

  // Per-number group score: sum contributions from every ACTIVE/EMERGING
  // group a number belongs to (RETIRED groups don't feed the live score —
  // they're diagnostic only, showing what used to matter). Then normalize
  // to 0-100 the same way SCIE normalizes its own signal scores.
  const raw = {};
  for (let n = 1; n <= 49; n++) raw[n] = 0;

  for (const g of [...activeGroups, ...emergingGroups]) {
    const contribution = g.confidence * (g.status === 'ACTIVE' ? 1.0 : 0.6);
    for (const m of g.members) raw[m] += contribution;
  }

  const maxRaw = Math.max(0, ...Object.values(raw));
  const groupScores = {};
  for (let n = 1; n <= 49; n++) {
    groupScores[n] = maxRaw > 0 ? Math.round((raw[n] / maxRaw) * 100) : 10;
  }

  const topConfidence = activeGroups.length ? activeGroups[0].confidence : 0;
  const groupConfidence = topConfidence >= 65 ? 'HIGH' : topConfidence >= 35 ? 'MEDIUM' : 'LOW';

  return {
    groupScores,
    activeGroups: activeGroups.slice(0, 10),
    emergingGroups: emergingGroups.slice(0, 10),
    retiredGroups: retiredGroups.slice(0, 10),
    groupConfidence,
    totalGroupsTracked: allGroups.length
  };
}

function emptyScoreMap() {
  const m = {};
  for (let n = 1; n <= 49; n++) m[n] = 10;
  return m;
}

module.exports = {
  computeGroupIntelligence
};
