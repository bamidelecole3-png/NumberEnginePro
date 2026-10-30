'use strict';

/**
 * telegramGate.js — timed-access Telegram signal channel for Number Engine Pro.
 *
 * Flow: admin makes a code (/gen 1w) -> user DMs the bot and sends the code -> bot hands out a single-use invite link
 * to the PRIVATE signal channel and starts the clock -> a sweeper removes the user when time is up -> every new
 * prediction is posted to the channel automatically after draws are ingested.
 *
 * No extra npm dependencies (plain https + long polling). OFF until TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID are set.
 *
 * Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID (e.g. -1001234567890), TELEGRAM_ADMIN_IDS (comma-separated user ids),
 *      TG_JSONBIN_BIN_ID (optional, durable state; reuses JSONBIN_API_KEY), TG_BULK_SKIP (default 5),
 *      TELEGRAM_API_BASE (tests only).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHANNEL = process.env.TELEGRAM_CHANNEL_ID || '';
const ADMINS = new Set((process.env.TELEGRAM_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));
const BIN_ID = process.env.TG_JSONBIN_BIN_ID || '';
const BIN_KEY = process.env.JSONBIN_API_KEY || '';
const API_BASE = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
const BULK_SKIP = parseInt(process.env.TG_BULK_SKIP || '5', 10);
const ENABLED = !!(TOKEN && CHANNEL);

const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'tg_state.json');
const SWEEP_MS = 60 * 1000;
const REMIND_BEFORE_MS = 3 * 60 * 60 * 1000;
const UNITS = { min: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3 };

let state = { codes: {}, users: {}, lastBroadcast: null };
let stopped = false;
let saveTimer = null;

// ── persistence (local file + optional JSONBin, same pattern as dataStore) ───────────────────────────────────
function binRequest(method, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.jsonbin.io', path: `/v3/b/${BIN_ID}${method === 'GET' ? '/latest' : ''}`, method,
      headers: { 'X-Master-Key': BIN_KEY, 'Content-Type': 'application/json' }
    }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
async function loadState() {
  let loaded = null;
  if (BIN_ID && BIN_KEY) {
    try { const r = await binRequest('GET'); if (r && r.record && r.record.codes) loaded = r.record; }
    catch (e) { console.error('[telegram] JSONBin load failed:', e.message); }
  }
  if (!loaded) {
    try { if (fs.existsSync(STATE_FILE)) loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { /* ignore */ }
  }
  if (loaded && loaded.codes) state = { codes: loaded.codes, users: loaded.users || {}, lastBroadcast: loaded.lastBroadcast || null };
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state));
      fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    } catch (e) { console.error('[telegram] local save failed:', e.message); }
    if (BIN_ID && BIN_KEY) { try { await binRequest('PUT', state); } catch (e) { console.error('[telegram] JSONBin save failed:', e.message); } }
  }, 500);
}

// ── Telegram Bot API ─────────────────────────────────────────────────────────────────────────────────────────
function tg(method, params = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${API_BASE}/bot${TOKEN}/${method}`);
    const lib = u.protocol === 'http:' ? http : https;
    const payload = JSON.stringify(params);
    const req = lib.request({
      hostname: u.hostname, port: u.port || undefined, path: u.pathname, method: 'POST', timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.ok) resolve(j.result); else reject(Object.assign(new Error(j.description || 'telegram_error'), { code: j.error_code }));
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const say = (chatId, text) => tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }).catch((e) => console.error('[telegram] send failed:', e.message));

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
function parseDuration(s) {
  const m = /^(\d+)(min|h|d|w|m)$/i.exec(String(s || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n > 0 && n <= 1000 ? { label: m[1] + m[2].toLowerCase(), ms: n * UNITS[m[2].toLowerCase()] } : null;
}
function humanLeft(ms) {
  if (ms <= 0) return 'expired';
  const mins = Math.floor(ms / 60e3), d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from(crypto.randomBytes(4), (b) => A[b % A.length]).join('');
  return `NE-${part()}-${part()}`;
}
const normCode = (s) => String(s || '').trim().toUpperCase();
const isAdmin = (id) => ADMINS.has(String(id));

// ── redeem / membership ──────────────────────────────────────────────────────────────────────────────────────
const attempts = new Map(); // userId -> {n, resetAt}  (brute-force guard)
function tooManyAttempts(uid) {
  const now = Date.now(); const a = attempts.get(uid);
  if (!a || a.resetAt < now) { attempts.set(uid, { n: 1, resetAt: now + 10 * 60e3 }); return false; }
  a.n++; return a.n > 8;
}

async function redeem(msg, rawCode) {
  const uid = String(msg.from.id), chatId = msg.chat.id;
  if (tooManyAttempts(uid)) return say(chatId, 'Too many attempts. Try again in a few minutes.');
  const code = normCode(rawCode);
  const c = state.codes[code];
  if (!c || c.revoked) return say(chatId, 'Invalid code.');
  if (c.usedBy) return say(chatId, 'This code has already been used.');
  const now = Date.now();
  const u = state.users[uid] || { joinedAt: now, expiresAt: 0 };
  const base = u.expiresAt > now ? u.expiresAt : now;       // renewing while active stacks time
  u.expiresAt = base + c.ms; u.username = msg.from.username || ''; u.name = msg.from.first_name || '';
  u.status = 'active'; u.reminded = false; u.codes = (u.codes || []).concat(code);
  state.users[uid] = u;
  c.usedBy = uid; c.usedAt = now;
  save();
  let link = '';
  try {
    const inv = await tg('createChatInviteLink', { chat_id: CHANNEL, member_limit: 1, expire_date: Math.floor(now / 1000) + 15 * 60, name: `u${uid}` });
    link = inv.invite_link;
  } catch (e) { console.error('[telegram] invite link failed:', e.message); }
  const when = new Date(u.expiresAt).toUTCString();
  await say(chatId, link
    ? `✅ Access active for <b>${esc(c.label)}</b> (until ${when}).\n\nJoin the signal channel (link works once, for 15 min):\n${link}`
    : `✅ Access active until ${when}, but I could not create the invite link. Contact the admin.`);
}

async function removeUser(uid, why) {
  try {
    await tg('banChatMember', { chat_id: CHANNEL, user_id: Number(uid) });
    await tg('unbanChatMember', { chat_id: CHANNEL, user_id: Number(uid), only_if_banned: true });
  } catch (e) { console.error(`[telegram] remove ${uid} failed:`, e.message); return false; }
  const u = state.users[uid];
  if (u) { u.status = 'removed'; u.removedAt = Date.now(); u.removedWhy = why; }
  save();
  return true;
}

async function sweep() {
  const now = Date.now();
  for (const [uid, u] of Object.entries(state.users)) {
    if (u.status !== 'active') continue;
    if (u.expiresAt <= now) {
      if (await removeUser(uid, 'expired')) say(uid, '⏰ Your access has expired and you were removed from the channel. Send a new code here to renew.');
    } else if (!u.reminded && u.expiresAt - now <= REMIND_BEFORE_MS) {
      u.reminded = true; save();
      say(uid, `⚠️ Your access ends in about ${humanLeft(u.expiresAt - now)}. Send a new code here to extend it.`);
    }
  }
}

// ── commands ─────────────────────────────────────────────────────────────────────────────────────────────────
async function onMessage(msg) {
  if (!msg || !msg.text || !msg.from || !msg.chat || msg.chat.type !== 'private') return;
  const text = msg.text.trim(), chatId = msg.chat.id, uid = String(msg.from.id);
  const [cmdRaw, ...args] = text.split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@\w+$/, '');

  if (/^NE-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(text)) return redeem(msg, text);
  if (cmd === '/start') {
    return say(chatId, 'Welcome. Send your access code (looks like <code>NE-XXXX-XXXX</code>) to get into the signal channel.' + (isAdmin(uid) ? '\n\nAdmin: /gen, /codes, /members, /revoke, /extend, /kick' : ''));
  }
  if (cmd === '/redeem') return args[0] ? redeem(msg, args[0]) : say(chatId, 'Usage: /redeem NE-XXXX-XXXX');
  if (cmd === '/status') {
    const u = state.users[uid];
    return say(chatId, u && u.status === 'active' && u.expiresAt > Date.now() ? `Active — ${humanLeft(u.expiresAt - Date.now())} left.` : 'No active access. Send a code to join.');
  }
  if (!isAdmin(uid)) return;

  if (cmd === '/gen') {
    const d = parseDuration(args[0]);
    if (!d) return say(chatId, 'Usage: /gen 24h | 1w | 1m [count]   (units: min, h, d, w, m=30 days)');
    const n = Math.min(Math.max(parseInt(args[1] || '1', 10) || 1, 1), 50);
    const made = [];
    for (let i = 0; i < n; i++) { const code = makeCode(); state.codes[code] = { label: d.label, ms: d.ms, createdAt: Date.now() }; made.push(code); }
    save();
    return say(chatId, `Created ${n} code(s) for ${d.label} (clock starts when redeemed):\n` + made.map((c) => `<code>${c}</code>`).join('\n'));
  }
  if (cmd === '/codes') {
    const unused = Object.entries(state.codes).filter(([, c]) => !c.usedBy && !c.revoked);
    return say(chatId, unused.length ? `Unused codes:\n` + unused.map(([k, c]) => `<code>${k}</code> ${c.label}`).join('\n') : 'No unused codes.');
  }
  if (cmd === '/revoke') {
    const code = normCode(args[0]);
    if (!state.codes[code]) return say(chatId, 'Code not found.');
    const c = state.codes[code]; c.revoked = true;
    let extra = '';
    if (c.usedBy && state.users[c.usedBy] && state.users[c.usedBy].status === 'active') { await removeUser(c.usedBy, 'revoked'); extra = ' User removed from channel.'; }
    save();
    return say(chatId, 'Revoked.' + extra);
  }
  if (cmd === '/members') {
    const now = Date.now();
    const act = Object.entries(state.users).filter(([, u]) => u.status === 'active');
    return say(chatId, act.length ? act.map(([id, u]) => `${id} ${u.username ? '@' + esc(u.username) : esc(u.name || '')} — ${humanLeft(u.expiresAt - now)}`).join('\n') : 'No active members.');
  }
  if (cmd === '/extend') {
    const u = state.users[args[0]], d = parseDuration(args[1]);
    if (!u || !d) return say(chatId, 'Usage: /extend USER_ID 1w');
    u.expiresAt = Math.max(u.expiresAt, Date.now()) + d.ms; u.reminded = false; u.status = 'active'; save();
    return say(chatId, `Extended. ${humanLeft(u.expiresAt - Date.now())} left.`);
  }
  if (cmd === '/kick') {
    if (!state.users[args[0]]) return say(chatId, 'Unknown user id.');
    return say(chatId, (await removeUser(args[0], 'kicked')) ? 'Removed.' : 'Could not remove (check bot admin rights).');
  }
}

// ── polling ──────────────────────────────────────────────────────────────────────────────────────────────────
async function poll() {
  let offset = 0, backoff = 1000;
  while (!stopped) {
    try {
      const ups = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 40000);
      backoff = 1000;
      for (const up of ups) { offset = up.update_id + 1; try { await onMessage(up.message); } catch (e) { console.error('[telegram] handler error:', e.message); } }
    } catch (e) {
      if (stopped) break;
      console.error('[telegram] poll error:', e.message, e.code === 409 ? '(another instance is polling this bot)' : '');
      await new Promise((r) => setTimeout(r, backoff)); backoff = Math.min(backoff * 2, 30000);
    }
  }
}

// ── signal broadcast ─────────────────────────────────────────────────────────────────────────────────────────
let debounce = null;
/** Call after draws are ingested: `result` is dataStore.ingestDraws()'s return value. */
function onNewDraws(result, deps) {
  if (!ENABLED || !result || !result.added) return;
  if (result.added > BULK_SKIP) return;                 // bulk/historical import: don't spam the channel
  clearTimeout(debounce);
  debounce = setTimeout(() => broadcastSignal(deps).catch((e) => console.error('[telegram] broadcast failed:', e.message)), 3000);
}

async function broadcastSignal({ dataStore, numberEngine }) {
  const draws = dataStore.getAllDraws();
  const last = draws && draws[0];
  if (!last) return;
  const first = numberEngine.predictNumbers(4);
  if (!first || first.error) return;
  const second = numberEngine.predictNumbers(4);        // settle weights (same reason slipFeed.lockFresh calls twice)
  const r = second && !second.error && String(second.sourceDrawId) === String(first.sourceDrawId) ? second : first;
  const key = String(r.sourceDrawId);
  if (state.lastBroadcast === key) return;
  if (!Array.isArray(r.predictedNumbers) || r.predictedNumbers.length !== 4) return;
  state.lastBroadcast = key; save();
  const pad = (n) => String(n).padStart(2, '0');
  const conf = typeof r.overallConfidence === 'number' ? `${Math.round(r.overallConfidence <= 1 ? r.overallConfidence * 100 : r.overallConfidence)}%` : null;
  const text = `🎯 <b>NUMBER ENGINE SIGNAL</b>\nAfter draw ${esc(last.drawId)}: ${esc((last.numbers || []).map(pad).join(' '))}\n\n<b>Pick: ${r.predictedNumbers.map(pad).join(' · ')}</b>` + (conf ? `\nConfidence: ${conf}` : '');
  await tg('sendMessage', { chat_id: CHANNEL, text, parse_mode: 'HTML', protect_content: true });
}

// ── lifecycle ────────────────────────────────────────────────────────────────────────────────────────────────
async function start() {
  if (!ENABLED) { console.log('[telegram] TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID not set — Telegram access gate is disabled.'); return; }
  if (!ADMINS.size) console.warn('[telegram] TELEGRAM_ADMIN_IDS is empty — nobody can generate codes.');
  await loadState();
  setInterval(() => sweep().catch((e) => console.error('[telegram] sweep error:', e.message)), SWEEP_MS).unref();
  sweep().catch(() => {});
  poll();
  console.log('[telegram] access gate ACTIVE.');
}
function stop() { stopped = true; }

module.exports = { start, stop, onNewDraws, broadcastSignal, sweep, _state: () => state, ENABLED };
