'use strict';
// ModPacer 2.0, part 4: the link to the browser helper (an extension the person loads in their own browser; it reads a LoversLab page with their own sign-in).
// This file is the server's side of it and nothing else: the pairing, the checks ModPacer asks for, and what a report may change.
//
// The rules (design reviews, 2026-11-20):
//   * Pairing is authorised, not only authenticated. ModPacer makes a short code; the helper trades it ONCE for a long secret token (kept only in the helper's own local
//     storage, never synced). The code expires if unused (30 minutes), can be made again and can be removed. The saved file holds the code only while it waits, and the
//     token only as a hash. The helper's origin (chrome-extension://<id>) is browser isolation, NOT proof against another program on this PC: the token is the secret.
//   * Every report is tied to a check ModPacer asked for (a one-time request id) and to the EXACT registered page address. A report can change nothing but the observation
//     for that page. An unasked, used, expired or other-page report is refused and changes nothing.
//   * The helper reads only the page it is handed, never a link found on it.
//   * Page addresses and titles stay out of the log: this file logs codes and counts only.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dataDir = require('./data-dir');
const { logArea } = require('./update-log');

const FILE = 'browser-helper.json';
const CODE_LIFE_MS = 30 * 60 * 1000;
const CHECK_LIFE_MS = 20 * 60 * 1000;
const PREVIEW_LIFE_MS = 3 * 60 * 1000;
const RESEND_AFTER_MS = 2 * 60 * 1000; // a check handed out but never reported is handed out again after this
const SEEN_WITHIN_MS = 3 * 60 * 1000; // the helper asks about every 30 seconds; seen within this is "connected"
const MAX_BAD_CODES = 5;
const MAX_POLL = 10; // the helper handles ten at a time; the rest wait for the next ask (they are not marked as handed out)
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
const ORIGIN_RE = /^(chrome|moz|ms-browser)-extension:\/\/[a-z0-9-]{8,64}$/i;

const filePath = () => dataDir.dataPath(FILE);
let cache = null;
function load() {
    if (cache) return cache;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(filePath(), 'utf8')); } catch { /* none yet, or damaged: starts empty (nothing in it is precious: the person pairs again) */ }
    cache = { version: 1, pending: null, paired: null };
    if (raw && typeof raw === 'object') {
        if (raw.pending && typeof raw.pending.code === 'string') cache.pending = { code: raw.pending.code, createdAt: Number(raw.pending.createdAt) || 0, expiresAt: Number(raw.pending.expiresAt) || 0, bad: Number(raw.pending.bad) || 0 };
        if (raw.paired && typeof raw.paired.tokenHash === 'string') cache.paired = raw.paired;
    }
    return cache;
}
function save() {
    const f = filePath();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = [f, process.pid, 'tmp'].join('.');
    try { fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8'); fs.renameSync(tmp, f); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ } throw e; }
}
function reloadFromDisk() { cache = null; requests.clear(); return load(); }
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function sameSecret(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

// ---- the pairing code and the token ----
function newCode() {
    let s = '';
    for (let i = 0; i < 9; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    return `${s.slice(0, 3)}-${s.slice(3, 6)}-${s.slice(6)}`;
}
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// A new code (the old unused one is gone). -> { code, expiresAt }
function makeCode(now = Date.now()) {
    const f = load();
    f.pending = { code: newCode(), createdAt: now, expiresAt: now + CODE_LIFE_MS, bad: 0 };
    save();
    logArea('browser-helper', 'a pairing code was made');
    return { code: f.pending.code, expiresAt: f.pending.expiresAt };
}
// The helper trades the code for a token. -> { ok: true, token } | { ok: false, reason: 'no_code' | 'expired' | 'wrong' | 'locked' | 'origin' }
function pair({ code, origin, helperVersion, browser }, now = Date.now()) {
    const f = load();
    if (!ORIGIN_RE.test(String(origin || ''))) return { ok: false, reason: 'origin' };
    const p = f.pending;
    if (!p) return { ok: false, reason: 'no_code' };
    if (p.expiresAt <= now) { f.pending = null; save(); return { ok: false, reason: 'expired' }; }
    if (!sameSecret(normCode(code), normCode(p.code))) {
        p.bad += 1;
        if (p.bad >= MAX_BAD_CODES) { f.pending = null; logArea('browser-helper', 'a pairing code was removed after too many wrong tries'); save(); return { ok: false, reason: 'locked' }; }
        save();
        return { ok: false, reason: 'wrong' };
    }
    const token = crypto.randomBytes(32).toString('hex');
    f.pending = null;
    f.paired = { tokenHash: sha(token), origin: String(origin).toLowerCase(), pairedAt: now, lastSeenAt: now, helperVersion: cleanShort(helperVersion, 20), browser: cleanShort(browser, 30) };
    save();
    logArea('browser-helper', 'a browser helper was paired');
    return { ok: true, token };
}
function cleanShort(v, n) { return String(v == null ? '' : v).replace(/[^A-Za-z0-9 ._()-]/g, '').trim().slice(0, n); }
// The helper's access is removed (the code too). The token stops working at once.
function revoke() {
    const f = load();
    f.pending = null; f.paired = null; save();
    requests.clear();
    logArea('browser-helper', 'the browser helper was removed');
}
// Is this token, from this origin, the paired helper? Records that it was seen.
function authorize(token, origin, { helperVersion, browser } = {}, now = Date.now()) {
    const f = load();
    const p = f.paired;
    if (!p || !token || typeof token !== 'string' || token.length > 200) return false;
    if (!sameSecret(sha(token), p.tokenHash)) return false;
    if (String(origin || '').toLowerCase() !== p.origin) return false;
    p.lastSeenAt = now;
    if (helperVersion !== undefined) p.helperVersion = cleanShort(helperVersion, 20);
    if (browser !== undefined) p.browser = cleanShort(browser, 30);
    try { save(); } catch { /* the sign of life is best effort */ }
    return true;
}
const isPaired = () => !!load().paired;

// ---- the checks ModPacer asks for ----
// id -> { id, kind: 'check' | 'preview', modId, sourceId, page, createdAt, expiresAt, handedAt, result }
const requests = new Map();
const newRequestId = () => crypto.randomBytes(16).toString('hex');
function sweep(now) { for (const [id, r] of requests) if (r.expiresAt <= now && !(r.result && r.kind === 'preview')) requests.delete(id); }
// Ask for one page to be read. A check for the same mod and source that is still waiting is reused. -> the request
function ask({ kind = 'check', modId = null, sourceId = null, page }, now = Date.now()) {
    sweep(now);
    if (kind === 'check') for (const r of requests.values()) if (r.kind === 'check' && r.modId === modId && r.sourceId === sourceId && r.page === page) return r;
    const r = { id: newRequestId(), kind, modId, sourceId, page, createdAt: now, expiresAt: now + (kind === 'preview' ? PREVIEW_LIFE_MS : CHECK_LIFE_MS), handedAt: 0, result: null };
    requests.set(r.id, r);
    return r;
}
const getRequest = (id) => requests.get(String(id)) || null;
const forget = (id) => { requests.delete(String(id)); };
const waitingCount = (now = Date.now()) => { sweep(now); let n = 0; for (const r of requests.values()) if (!r.result) n++; return n; };
// What the helper is handed now: the checks not handed out yet (or handed out and never answered). Nothing but an id and the exact page.
function poll(now = Date.now()) {
    sweep(now);
    const out = [];
    for (const r of requests.values()) {
        if (out.length >= MAX_POLL) break;
        if (r.result) continue;
        if (r.handedAt && now - r.handedAt < RESEND_AFTER_MS) continue;
        r.handedAt = now;
        out.push({ id: r.id, page: r.page, kind: r.kind });
    }
    return out;
}
// A report is accepted only for a request that is waiting and for exactly its page; it is used up. -> { ok: true, request } | { ok: false, reason }
function take(id, page, now = Date.now()) {
    sweep(now);
    const r = requests.get(String(id));
    if (!r || r.result) return { ok: false, reason: 'unknown_request' };
    if (!r.handedAt) return { ok: false, reason: 'unknown_request' }; // never handed out: nobody could have been asked
    if (String(page) !== r.page && require('./tracked-loverslab').canonicalPage(page) !== r.page) return { ok: false, reason: 'other_page' }; // the same address written another way (hex in lower case, a raw dash) is the same page; anything else is not
    return { ok: true, request: r };
}

// ---- what the page of Settings shows ----
// bundledVersion: the helper that comes with this ModPacer; a connected helper with an older version says so.
function status({ bundledVersion = null, signedOut = false, bundled = true } = {}, now = Date.now()) {
    const f = load();
    const p = f.paired;
    const code = f.pending && f.pending.expiresAt > now ? { code: f.pending.code, expiresAt: f.pending.expiresAt } : null;
    if (!p) return { state: code ? 'waiting_for_code' : 'not_set_up', code, bundled, bundledVersion, paired: false, outdated: false };
    const seen = now - (p.lastSeenAt || 0) <= SEEN_WITHIN_MS;
    const old = !!(bundledVersion && p.helperVersion && versionLess(p.helperVersion, bundledVersion));
    let state = seen ? 'connected' : 'browser_closed';
    if (seen && old) state = 'old';
    if (seen && !old && signedOut) state = 'signed_out';
    // `outdated`: the paired helper reported a version older than the one that comes with this ModPacer (a newer one, a test copy, is never outdated), seen recently or not
    return { state, code, paired: true, bundled, bundledVersion, outdated: old, helperVersion: p.helperVersion || null, browser: p.browser || null, lastSeenAt: p.lastSeenAt || null, waiting: waitingCount(now) };
}
function versionLess(a, b) {
    const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0; }
    return false;
}

module.exports = { MAX_POLL, FILE, ORIGIN_RE, CODE_LIFE_MS, CHECK_LIFE_MS, PREVIEW_LIFE_MS, SEEN_WITHIN_MS, filePath, reloadFromDisk, makeCode, pair, revoke, authorize, isPaired, ask, getRequest, forget, poll, take, waitingCount, status, versionLess };
