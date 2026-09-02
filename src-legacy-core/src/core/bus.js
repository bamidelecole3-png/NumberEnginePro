/**
 * Active Intelligence Bus module.
 * Provides active Pub/Sub subscriptions for inter-engine communication.
 */
const EventEmitter = require('events');

class IntelligenceBus extends EventEmitter {
  subscribe(event, listener) {
    this.on(event, listener);
    return () => this.off(event, listener);
  }

  publish(event, data) {
    this.emit(event, data);
  }
}

const bus = new IntelligenceBus();

// Only ON_DRAW_INGESTED is currently published (adapter.js). The other four
// event names were declared for future use but are never published or
// subscribed to anywhere in the codebase -- removed to avoid dead-code confusion.
const EVENTS = {
  ON_DRAW_INGESTED: 'ON_DRAW_INGESTED'
};

module.exports = {
  bus,
  EVENTS
};
