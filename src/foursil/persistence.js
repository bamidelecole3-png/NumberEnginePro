'use strict';

const fs = require('fs');
const path = require('path');

// BUGFIX: must honor the same DATA_DIR override as src-legacy-core/src/
// services/persistence.js. Previously this was hardcoded relative to
// __dirname, so setting DATA_DIR (e.g. to point at a mounted volume in
// Docker) would move the legacy state.json but silently leave call
// history writing to the old on-image path, splitting persisted state
// across two locations with no error or warning.
const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const CALLS_DIR = path.join(DATA_DIR, 'calls');
const FILE = path.join(CALLS_DIR, 'callHistory.json');
const PAPER_TRADER_DIR = path.join(DATA_DIR, 'paper-trader');
const PAPER_TRADER_FILE = path.join(PAPER_TRADER_DIR, 'paperTrader.json');

function ensurePaperTraderDir() {
  if (!fs.existsSync(PAPER_TRADER_DIR)) fs.mkdirSync(PAPER_TRADER_DIR, { recursive: true });
}

function loadPaperTraderState(freshPaperTraderState) {
  try {
    ensurePaperTraderDir();
    if (fs.existsSync(PAPER_TRADER_FILE)) {
      const raw = fs.readFileSync(PAPER_TRADER_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.ladder && parsed.window) return parsed;
    }
  } catch (e) {
    console.error('[paper-trader-persistence] failed to load state, starting fresh:', e.message);
  }
  return freshPaperTraderState();
}

function savePaperTraderState(state) {
  try {
    ensurePaperTraderDir();
    fs.writeFileSync(PAPER_TRADER_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[paper-trader-persistence] failed to save state:', e.message);
  }
}

function ensureDir() {
  if (!fs.existsSync(CALLS_DIR)) fs.mkdirSync(CALLS_DIR, { recursive: true });
}

function loadCallHistory(freshState) {
  try {
    ensureDir();
    if (fs.existsSync(FILE)) {
      const raw = fs.readFileSync(FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.calls)) return parsed;
    }
  } catch (e) {
    console.error('[foursil-persistence] failed to load call history, starting fresh:', e.message);
  }
  return freshState();
}

function saveCallHistory(state) {
  try {
    ensureDir();
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[foursil-persistence] failed to save call history:', e.message);
  }
}

module.exports = { loadCallHistory, saveCallHistory, loadPaperTraderState, savePaperTraderState };
