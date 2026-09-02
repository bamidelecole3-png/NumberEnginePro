/**
 * Isotonic Calibration Utilities.
 */
function clamp(val, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(val)));
}

function applyCalibration(rawConfidence, historicalAccuracy = 80) {
  if (rawConfidence == null || isNaN(rawConfidence)) return 50;
  const factor = historicalAccuracy / 100;
  const calibrated = rawConfidence * (0.6 + 0.4 * factor);
  return clamp(calibrated, 5, 98);
}

module.exports = {
  clamp,
  applyCalibration
};
