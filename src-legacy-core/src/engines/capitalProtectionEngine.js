/**
 * Capital Protection Engine module.
 */
function evaluateCapitalProtection(
  tradesUsed = 0,
  consecutiveLosses = 0,
  exitRisk = 0,
  confidence = 75,
  options = {}
) {
  const MAX_ALLOWED_TRADES = 4;
  const used = Math.max(0, Number(tradesUsed) || 0);
  const losses = Math.max(0, Number(consecutiveLosses) || 0);
  const eRisk = Math.max(0, Math.min(100, Number(exitRisk) || 0));
  const conf = Math.max(0, Math.min(100, Number(confidence) || 0));
  const transitionConfirmed = Boolean(options.transitionConfirmed);
  const seasonState = options.seasonState || 'MATURE';

  if (used >= MAX_ALLOWED_TRADES) {
    return {
      allowTrade: false,
      vetoReason: `Maximum allowed trades reached for this season (${used}/${MAX_ALLOWED_TRADES}).`,
      maxAllowedTrades: MAX_ALLOWED_TRADES,
      tradesUsed: used,
      remainingTrades: 0,
      capitalRisk: 'HIGH'
    };
  }

  if (losses >= 2) {
    return {
      allowTrade: false,
      vetoReason: `Stop-trading triggered by ${losses} consecutive losses.`,
      maxAllowedTrades: MAX_ALLOWED_TRADES,
      tradesUsed: used,
      remainingTrades: MAX_ALLOWED_TRADES - used,
      capitalRisk: 'HIGH'
    };
  }

  if (eRisk >= 70) {
    return {
      allowTrade: false,
      vetoReason: `Critical exit risk detected (${eRisk}% >= 70%).`,
      maxAllowedTrades: MAX_ALLOWED_TRADES,
      tradesUsed: used,
      remainingTrades: MAX_ALLOWED_TRADES - used,
      capitalRisk: 'HIGH'
    };
  }

  if (conf < 55) {
    return {
      allowTrade: false,
      vetoReason: `Confidence (${conf}%) below safety floor (55%).`,
      maxAllowedTrades: MAX_ALLOWED_TRADES,
      tradesUsed: used,
      remainingTrades: MAX_ALLOWED_TRADES - used,
      capitalRisk: 'MEDIUM'
    };
  }

  if (transitionConfirmed || seasonState === 'DEAD' || seasonState === 'EXHAUSTED') {
    return {
      allowTrade: false,
      vetoReason: `Season state is ${seasonState} (transition confirmed: ${transitionConfirmed}).`,
      maxAllowedTrades: MAX_ALLOWED_TRADES,
      tradesUsed: used,
      remainingTrades: MAX_ALLOWED_TRADES - used,
      capitalRisk: 'EXTREME'
    };
  }

  let capitalRisk = 'LOW';
  if (used >= 3 || eRisk >= 50 || conf < 65) {
    capitalRisk = 'MEDIUM';
  }

  return {
    allowTrade: true,
    vetoReason: null,
    maxAllowedTrades: MAX_ALLOWED_TRADES,
    tradesUsed: used,
    remainingTrades: MAX_ALLOWED_TRADES - used,
    capitalRisk
  };
}

module.exports = {
  evaluateCapitalProtection
};
