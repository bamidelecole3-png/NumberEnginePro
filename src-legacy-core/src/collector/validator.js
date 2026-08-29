/**
 * Validator module for incoming Bet9ja draw payloads.
 */
const { VALID_COLORS, safeColor } = require('../core/colorMath');

function parseAndValidateDraw(rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object') {
    return { valid: false, reason: 'Invalid payload object' };
  }

  const rawId = rawPayload.drawId || rawPayload.id || rawPayload.draw_id;
  if (rawId === null || rawId === undefined || rawId === '') {
    return { valid: false, reason: 'Missing required real Bet9ja drawId' };
  }

  const drawId = String(rawId).trim();
  if (!/^\d+$/.test(drawId)) {
    return { valid: false, reason: `Invalid drawId format: ${drawId}` };
  }

  const colorsList = [];
  const parseItem = (item) => {
    if (!item) return;
    const str = typeof item === 'object' ? item.color : item;
    if (typeof str === 'string') {
      const upper = str.toUpperCase().trim();
      if (VALID_COLORS.has(upper)) {
        colorsList.push(upper);
      }
    }
  };

  if (Array.isArray(rawPayload.colors)) {
    rawPayload.colors.forEach(parseItem);
  } else if (Array.isArray(rawPayload.balls)) {
    rawPayload.balls.forEach(parseItem);
  } else if (rawPayload.color) {
    parseItem(rawPayload.color);
  }

  if (colorsList.length === 0) {
    return {
      valid: false,
      reason: 'No valid RED/BLUE/GREEN colors found in payload (colors/balls/color field missing, empty, or contained only unrecognized values)'
    };
  }

  const colorCounts = { RED: 0, BLUE: 0, GREEN: 0 };
  colorsList.forEach(c => {
    colorCounts[c] = (colorCounts[c] || 0) + 1;
  });

  let threeBallColor = null;
  let fourBallColor = null;
  // Two-pass classification: resolve fourBall across ALL colors first,
  // then only look for a genuine 3-ball-only color once the higher tier is known.
  for (const [col, count] of Object.entries(colorCounts)) {
    if (count >= 4) {
      fourBallColor = col;
    }
  }
  if (!fourBallColor) {
    // TIE FIX: a draw can have TWO colors at count === 3 (the 3-3-0 tie
    // shape -- e.g. RED:3, BLUE:3, GREEN:0). The original single-color scan
    // just took the first count-3 color it hit in RED -> BLUE -> GREEN
    // order and called it a threeBallColor winner, which silently turned a
    // genuine tie draw into a phantom win for whichever color happened to
    // come first alphabetically/in HIERARCHY order. That both corrupted
    // every 3-ball engine's training data on tie draws and made this
    // record disagree with tieEngine.js's detectTie(), which correctly
    // flags the same draw as a tie via colorCounts. A draw only gets a
    // threeBallColor winner when EXACTLY ONE color has count === 3.
    const colorsAtThree = Object.entries(colorCounts)
      .filter(([, count]) => count === 3)
      .map(([col]) => col);
    if (colorsAtThree.length === 1) {
      threeBallColor = colorsAtThree[0];
    }
    // colorsAtThree.length >= 2 (the 3-3-0 tie) intentionally leaves
    // threeBallColor as null -- tieEngine.js's detectTie()/tieShape() are
    // the source of truth for this draw, not a fabricated winner here.
  }

  if (!fourBallColor && rawPayload.fourBallColor) {
    const norm = safeColor(rawPayload.fourBallColor, null);
    if (norm) fourBallColor = norm;
  }

  if (!threeBallColor && rawPayload.threeBallColor) {
    const norm = safeColor(rawPayload.threeBallColor, null);
    if (norm) threeBallColor = norm;
  }

  const rawTimestamp = rawPayload.timestamp || rawPayload.time;
  let timestamp;
  if (rawTimestamp) {
    const parsed = new Date(rawTimestamp);
    timestamp = Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  } else {
    timestamp = new Date().toISOString();
  }

  return {
    valid: true,
    draw: {
      drawId,
      timestamp,
      colors: colorsList,
      colorCounts,
      threeBallColor,
      fourBallColor,
      raw: rawPayload
    }
  };
}

module.exports = {
  parseAndValidateDraw
};
