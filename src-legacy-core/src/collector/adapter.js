/**
 * Ingestion Adapter module.
 */
const { parseAndValidateDraw } = require('./validator');
const { store } = require('../core/store');
const { bus, EVENTS } = require('../core/bus');

function processIngestPayload(payload) {
  const startTime = Date.now();
  let rawBatch = [];

  if (Array.isArray(payload)) {
    rawBatch = payload;
  } else if (payload && Array.isArray(payload.draws)) {
    rawBatch = payload.draws;
  } else if (payload && typeof payload === 'object') {
    rawBatch = [payload];
  }

  let accepted = 0;
  let rejected = 0;
  const errors = [];
  const processedDraws = [];

  for (const item of rawBatch) {
    const result = parseAndValidateDraw(item);
    if (!result.valid) {
      rejected++;
      errors.push({ drawId: item.drawId || 'unknown', reason: result.reason });
      continue;
    }

    const isDuplicate = store.hasDraw(result.draw.drawId);
    if (isDuplicate) {
      rejected++;
      errors.push({ drawId: result.draw.drawId, reason: 'Duplicate drawId rejected' });
      continue;
    }

    store.addDraw(result.draw);
    processedDraws.push(result.draw);
    accepted++;
  }

  const processingTimeMs = Date.now() - startTime;
  store.updateIngestStats({
    accepted,
    rejected,
    errors,
    processingTimeMs
  });

  if (processedDraws.length > 0) {
    bus.publish(EVENTS.ON_DRAW_INGESTED, {
      count: processedDraws.length,
      latest: processedDraws[processedDraws.length - 1]
    });
  }

  return {
    accepted,
    rejected,
    totalProcessed: rawBatch.length,
    processingTimeMs,
    latestDrawId: processedDraws.length > 0 ? processedDraws[processedDraws.length - 1].drawId : null,
    errors
  };
}

module.exports = {
  processIngestPayload
};
