'use strict';

const fs = require('fs');
const path = require('path');

// Honors the same DATA_DIR override as src/foursil/persistence.js and
// src-legacy-core/src/services/persistence.js, so a mounted volume in
// Docker (DATA_DIR env var) captures GCI's derived intelligence in the
// same place as call history / paper trader state.
const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const GCI_DIR = path.join(DATA_DIR, '4sil-gci');
const FILE = path.join(GCI_DIR, 'gciState.json');

function ensureDir() {
  if (!fs.existsSync(GCI_DIR)) fs.mkdirSync(GCI_DIR, { recursive: true });
}

function loadGCIState(freshState) {
  try {
    ensureDir();
    if (fs.existsSync(FILE)) {
      const raw = fs.readFileSync(FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.closureEpisodes)) return parsed;
    }
  } catch (e) {
    console.error('[4sil-gci-persistence] failed to load state, starting fresh:', e.message);
  }
  return freshState();
}

// Audit fix (§12): a crash mid-writeFileSync() could previously leave
// gciState.json truncated/corrupted, and since the persisted state IS the
// engine's entire learned history (closure episodes, fingerprints, trigram
// and range-family banks), losing it silently resets months of learning.
// Writing to a temp file, fsyncing it, then renaming over the real file
// means the rename is the only atomic step: the real file is either the
// old complete state or the new complete state, never a partial write.
function saveGCIState(state) {
  try {
    ensureDir();
    const tmpFile = `${FILE}.tmp-${process.pid}-${Date.now()}`;
    const fd = fs.openSync(tmpFile, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(state, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpFile, FILE);
  } catch (e) {
    console.error('[4sil-gci-persistence] failed to save state:', e.message);
  }
}

module.exports = { loadGCIState, saveGCIState };
