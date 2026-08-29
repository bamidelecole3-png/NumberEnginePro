/**
 * Canonical 3-Color Math & Deterministic Tie-breaking Utilities.
 * Valid colors are strictly RED, BLUE, and GREEN.
 * Priority: RED > BLUE > GREEN.
 */
const HIERARCHY = ['RED', 'BLUE', 'GREEN'];
const VALID_COLORS = new Set(HIERARCHY);

function safeColor(colorStr, fallback = 'RED') {
  if (!colorStr || typeof colorStr !== 'string') return fallback;
  const upper = colorStr.toUpperCase().trim();
  if (VALID_COLORS.has(upper)) return upper;
  return fallback;
}

function pickMaxColor(counts) {
  if (!counts || typeof counts !== 'object') return 'RED';
  let maxVal = -1;
  let winner = 'RED';
  for (const col of HIERARCHY) {
    const val = counts[col] || 0;
    if (val > maxVal) {
      maxVal = val;
      winner = col;
    }
  }
  return winner;
}

function argMaxColorBy(scoreMap) {
  if (!scoreMap || typeof scoreMap !== 'object') return 'RED';
  let maxVal = -Infinity;
  let winner = 'RED';
  for (const col of HIERARCHY) {
    const score = scoreMap[col] != null ? scoreMap[col] : -Infinity;
    if (score > maxVal) {
      maxVal = score;
      winner = col;
    }
  }
  return winner;
}

// Ranks all colors by score, highest first, with deterministic RED > BLUE >
// GREEN tie-breaking (matches argMaxColorBy's tie-break exactly, since both
// iterate HIERARCHY in order and only replace the incumbent on a STRICT >).
// Returns [{ color, score }, ...] length n (or fewer if scoreMap is smaller).
// Used to extend a single-winner engine into a top-2 (or top-N) prediction
// without changing how any individual color score was computed.
function topNColorsBy(scoreMap, n = 2) {
  if (!scoreMap || typeof scoreMap !== 'object') {
    return HIERARCHY.slice(0, n).map(color => ({ color, score: 0 }));
  }
  const ranked = HIERARCHY
    .map(color => ({ color, score: scoreMap[color] != null ? scoreMap[color] : -Infinity }))
    .sort((a, b) => b.score - a.score); // stable sort preserves HIERARCHY order on ties
  return ranked.slice(0, n);
}

module.exports = {
  HIERARCHY,
  VALID_COLORS,
  safeColor,
  pickMaxColor,
  argMaxColorBy,
  topNColorsBy
};
