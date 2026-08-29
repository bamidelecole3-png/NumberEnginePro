# 4-BALL TIMING INTELLIGENCE + 4SIL

A brand-new project built per the "4-Ball Timing Intelligence + 4SIL" blueprint,
using SNIPER_V4 PRO v6.2 ("SNIPER MEDIUM GATE") as the **reference
implementation** for its proven 4-ball and 4SIL mathematics.

## Audit summary (blueprint vs. reference codebase)

The uploaded `SNIPER_MEDIUM_GATE.zip` is a 3-color (RED/BLUE/GREEN) **color
prediction** platform — its final output is `winningColor` + `confidence`
(see `fourBallParliament.js`, `council.js`). That is exactly the "old
philosophy" the blueprint retires. The reference math itself, however, maps
directly onto the blueprint's requirements:

| Blueprint requirement | Found in reference, as | Status |
|---|---|---|
| 4-ball season math, season lifecycle, gaps, transitions, dominance, decay | `fourBallSeasonIntelligenceLab.js`, `lifecycleEngine.js`, `dynamicDominanceEngine.js`, `runwayFeatureEngine.js` | Ported unmodified |
| Last Stand / Response Cascade / Tie Birth / Tie Cluster / First Appearance / Rival Pressure / Suppression / Behavioral Fingerprints / Entropy | `fourBallLastStandCP.js`, `fourBallResponseCascadeEngine.js`, `fourBallTieBirthEngine.js`, `fourBallTieClusterEngine.js`, `firstAppearanceEngine.js`, `rivalPressureEngine.js`, `suppressionIntelligenceEngine.js`, `behaviorFingerprintEngine.js`, `shannonEntropy.js` | Ported unmodified |
| 4SIL gates, weights, thresholds, confirmation rules | `fourBallSeasonIntelligenceLab.js`'s `evaluateEnterNow()` — 12 weighted conditions (Battle Max Intensity 30, Independent Takeover 25, First Appearance 20, Leader Losing Control 15, Historical Match 10, Transition Cycle 15, 2×4-Ball 20, Dormant Fires 25, Last Stand 25, Takeover Burst 30, Response Cascade 30, Tie Cluster 25) | Matches blueprint §25's gate matrix almost 1:1. Ported unmodified. |
| `/api/v1/collector` ingestion, auth, payload contract | `src/collector/adapter.js`, `validator.js`, `src/routes/api.js` (`checkAuth`, `X-API-Key`) | Ported unmodified, mounted verbatim |
| **Final objective = ENTER/HOLD/EXIT of ANY color** | Not present — reference always outputs a specific winning color | **Gap — new project builds this** |
| Trade Penetration Point, core/safety 10-draw window | Not present | **Gap — new (`src/foursil/timingEngine.js`)** |
| Season health / decay / remaining runway framed as a trader metric | Present as raw features (`seasonIntelligenceEngine.js`, `runwayFeatureEngine.js`) but never assembled into the blueprint's Hero Data Object | **Gap — new (`timingEngine.js`)** |
| Color Behavioral Intelligence (table, sparklines, relationship matrix, drought/recovery) | Not present as its own engine | **Gap — new (`src/foursil/cbiEngine.js`)** |
| Immutable call history + evaluation lab (by season stage / gate profile) | `entryHitCounter.js` tracks color-pick hits, not ENTER/HOLD/EXIT calls | **Gap — new (`src/foursil/callHistory.js`)** |
| Aurora "Season Trader" Hero-Card-first dashboard | Reference dashboard (`public/index.html`, kept here as `src-legacy-core/public/legacy-dashboard.html`) is a dense multi-panel color-prediction terminal, not Hero-first | **Gap — new (`public/index.html`)** |

## What this project does

- **Ports exactly** (non-negotiables #2–#4, #27): the entire reference
  `src/` tree is copied unmodified into `src-legacy-core/` and required
  as-is. No gate, weight, or threshold was touched.
- **Keeps `/api/v1/collector` unchanged** (non-negotiable #15): it's the
  same file, same auth, same payload contract, mounted directly.
- **Adds the new timing layer** (`src/foursil/timingEngine.js`): turns
  4SIL's own `enterNow` gate result into ENTER / WATCH / APPROACHING TP /
  ENTER / PREPARE / MONITOR / PAUSE / TAKE PROFIT / WINDOW CLOSED, a Trade Penetration Point,
  and core/safety windows — without recomputing or overriding any of
  4SIL's evidence (non-negotiables #24–#26).
- **Adds Color Behavioral Intelligence** (`src/foursil/cbiEngine.js`) as
  pure analytics, never a color prediction (non-negotiable #6/#7).
- **Adds an immutable call/evaluation ledger**
  (`src/foursil/callHistory.js` + `persistence.js`) that opens exactly one
  call when 4SIL confirms ENTER, resolves it against real ingested draws,
  and reports hit-rate by season stage and by gate combination — read-only
  analytics, never fed back into the gates (non-negotiable #27).
- **New endpoints** (`src/routes/timingApi.js`): `/api/health`,
  `/api/v1/snapshot` (new consolidated Hero object), `/api/v1/foursil`,
  `/api/v1/timing`, `/api/v1/season`, `/api/v1/colors`,
  `/api/v1/color-relationships`, `/api/v1/calls`, `/api/v1/evaluation`,
  `/api/v1/performance`. The old parliamentary snapshot is still available
  at `/api/v1/legacy-snapshot` for debugging.
- **New dashboard** (`public/index.html`): Hero Card first, Aurora color
  language (emerald/cyan/violet/amber/red), trade window timeline, season
  telemetry, CBI table + sparklines + relationship matrix, gate/evidence
  matrix, call history, evaluation lab.

## Running it

```bash
npm install
npm run check   # node --check on every new file
npm start        # listens on PORT (default 3000)
```

Point your existing Bet9ja collector/extension at `POST /api/v1/collector`
exactly as before (same `X-API-Key` header). Open `/` for the new
dashboard, or `/legacy-dashboard.html` for the original reference UI.

## Structure

```
server.js                  new, clean entry point
src/
  foursil/
    timingEngine.js         Hero Data Object, telemetry, runway, gate matrix
    cbiEngine.js             Color Behavioral Intelligence (new)
    callHistory.js           immutable call ledger + evaluation lab (new)
    persistence.js           JSON persistence for the above
  routes/
    timingApi.js             new read endpoints + consolidated snapshot
public/
  index.html                 new Aurora / Season Trader dashboard
  legacy-dashboard.html       original reference dashboard, kept for parity
src-legacy-core/             SNIPER_V4 PRO v6.2, byte-for-byte, unmodified
  src/collector/              /api/v1/collector, adapter, validator
  src/engines/                4-ball math + 4SIL gates (ported exactly)
  src/parliaments/, src/supreme/, src/core/, src/services/
data/                        runtime state (gitignored contents)
```

## Compliance audit + fixes (this pass)

The previous delivery of this project (before the reference
`SNIPER_MEDIUM_GATE.zip` was made available) was **not runnable**. This
pass audited it against the real reference codebase and fixed every gap:

| Issue | Status |
|---|---|
| `server.js` and `package.json` were absent entirely | **Fixed** — new clean entry point, mounts both the untouched legacy router and the new timing router; minimal `package.json` (dropped an unused `jsdom` dependency that was never `require`d anywhere) |
| `src-legacy-core/src/core/{store,bus,colorMath,statMath,isotonic}.js` were missing | **Fixed** — restored byte-for-byte from the reference project |
| `POST /api/v1/collector` and its `X-API-Key` auth (`src/routes/api.js`, `checkAuth`) were entirely absent — the collector route did not exist | **Fixed** — restored unmodified from reference, including its timing-safe (`crypto.timingSafeEqual`) key comparison. Verified: unauthenticated POST → `401`, correctly-keyed POST → accepted and processed |
| `src/supreme/council.js`, `arbitration.js`, `metaIntelligence.js`, both parliaments, and 24 engine files (incl. `fourBallSeasonIntelligenceLab.js`'s own direct dependencies: `shannonEntropy`, `lifecycleEngine`, `firstAppearanceEngine`, `fourBallLastStandCP`, `rivalPressureEngine`, `suppressionIntelligenceEngine`, etc.) were missing — 4SIL itself could not load | **Fixed** — restored unmodified from reference |
| `engines/entryHitCounter.js` existed as a 0-byte file (required by `council.js`, would have crashed on first ENTER cycle) | **Fixed** — restored the real 145-line implementation from reference |
| `public/legacy-dashboard.html` referenced by this README but absent | **Fixed** — restored from reference `public/index.html` |
| New `src/routes/timingApi.js` and the restored legacy `src/routes/api.js` both defined `GET /snapshot` \| `/v1/snapshot`, a hard route collision | **Fixed** — legacy's debug snapshot route renamed to `/legacy-snapshot` / `/v1/legacy-snapshot` (documented inline in that file); the canonical `/api/v1/snapshot` now unambiguously serves the new Hero Data Object. This is the only line changed in the entire ported `src-legacy-core` tree — collector ingestion, auth, and all engine math are untouched |
| **Persistence bug**: `src/foursil/persistence.js` ignored the `DATA_DIR` env var that the legacy persistence module honors, so a `DATA_DIR` override (e.g. a Docker volume) would silently split call-history state from the rest of persisted state | **Fixed** — now resolves `DATA_DIR` the same way as `src-legacy-core/src/services/persistence.js` |
| **Logic bug**: call-history/evaluation-lab advancement (`advanceCallHistory`) only ran inside `buildFullCycle()`, which only executed on `GET /snapshot`. If nobody polled the dashboard, a genuine 4SIL ENTER signal between polls was never logged, and any call that did open recorded a stale tp/window from whenever the next poll happened rather than the moment ENTER actually fired | **Fixed** — `timingApi.js` now subscribes to the collector's own `ON_DRAW_INGESTED` bus event (already published by `adapter.js` on every accepted draw, previously unused by anything) and advances call history immediately on ingestion, independent of dashboard polling. `GET /snapshot` still calls it too — idempotent, since `advanceCallHistory`'s own dedup logic keys off `lastProcessedDrawId`/one-open-call-at-a-time |

**Verified this pass:** full `node --check` across every file in the
project (0 failures); `npm install` from a clean `package.json`; live
boot with `GATEWAY_API_KEY` set; unauthenticated `POST /api/v1/collector`
→ `401`; authenticated ingestion of synthetic draws → 4SIL fired a
genuine ENTER (5/4 gates, ported math, not fabricated); confirmed a call
opened and resolved to `HIT` **without ever polling `/snapshot`**,
proving the ingestion-hook fix; confirmed `/api/v1/legacy-snapshot`
(200) and `/api/v1/snapshot` (200, new Hero object, not the old
parliamentary payload) are both live and non-colliding; confirmed state
survives a full process restart (`data/state.json` +
`data/calls/callHistory.json` both round-trip correctly).
