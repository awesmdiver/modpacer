'use strict';
// A picture for a mod tracked from GitHub (queue: "Show a picture for GitHub-tracked mods: from the release page first, then the README").
//
//   1. the newest release's description (markdown ![..](url) and html <img src=..>), from the same GitHub answer ModPacer already reads for the version check
//      (lib/github.js keeps it on disk, so this is normally no request at all);
//   2. else the repository's README (one API answer, kept on disk for six hours like every other GitHub answer).
// First usable picture wins. Badges and tiny pictures are skipped.
//
// Safety, the same rules as the Hub covers (lib/hub-covers.js, whose small-copy maker is reused):
//   * https:// on GitHub's own hosts only (HOSTS below); a redirect is followed only to one of those hosts, at most 3 hops; avatars are never used (their host is not listed);
//   * PNG, JPEG, WebP and GIF only, decided by the file's own first bytes (never its name or Content-Type); SVG is refused;
//   * at most 5 MB, a 15 s limit for the whole fetch, no cookies, no token, no Referer, no ModPacer data sent to the image host;
//   * the picture is saved small in <data>/cache/covers and the page only ever loads it from ModPacer itself (img-src 'self').
// Anything that goes wrong is "no picture", never a message.
//
// Cost per tracked mod: per release tag, zero GitHub API calls when the version check's answer is still saved (6 hours; the version check itself is the only call), one call for the README
// when the release has no usable picture, and at most 3 picture downloads per place from the picture hosts (which do not count against the API budget). A "no picture" answer is
// remembered for a day (so the README is looked at most once a day); a rate limit, no network or a timeout is not remembered as "none": it is tried again later.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const github = require('./github');
const hubCovers = require('./hub-covers');

const HOSTS = new Set(['github.com', 'raw.githubusercontent.com', 'user-images.githubusercontent.com', 'camo.githubusercontent.com',
    // github.com/user-attachments/... (the address GitHub now gives a picture dragged into a release or README) always redirects to this one
    'private-user-images.githubusercontent.com']);
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TOTAL_TIMEOUT_MS = 15_000;
const MAX_TRIES_PER_PLACE = 3;
const NONE_FOR_MS = 24 * 60 * 60 * 1000;
const FAIL_MEMORY_MS = 10 * 60 * 1000;
const BACKOFF_MS = 5 * 60 * 1000;
const MAX_AT_ONCE = 2;
const MAX_GIF_KEPT_BYTES = 400 * 1024; // a GIF is not shrunk here; a small one is kept as it is
const MIN_WIDTH = 100, PREFERRED_WIDTH = 300;
const MAX_TEXT = 512 * 1024;

const timing = { noneForMs: NONE_FOR_MS, failMemoryMs: FAIL_MEMORY_MS, backoffMs: BACKOFF_MS, timeoutMs: TOTAL_TIMEOUT_MS };
function setTiming(t) { Object.assign(timing, t || {}); }

// Tests (and only tests: MODPACER_TEST_RUN_DIR is set by tests/_isolate-helper.js) may name one local stand-in host that is read over plain http.
function testHost() { return process.env.MODPACER_TEST_RUN_DIR && process.env.MODPACER_GITHUB_IMAGE_TEST_HOST ? process.env.MODPACER_GITHUB_IMAGE_TEST_HOST : null; }
function hostAllowed(u) {
    if (!(u instanceof URL)) return false;
    if (u.username || u.password) return false;
    const th = testHost();
    if (th && u.protocol === 'http:' && u.host === th) return true;
    return u.protocol === 'https:' && !u.port && HOSTS.has(u.hostname);
}

// ---- finding the pictures in a text ---------------------------------------------------------------------------------------------------------

const BADGE_RE = /badge|shields\.io|badgen\.net|\/actions\/workflows\/|travis-ci\.|codecov\.io|coveralls\.io|sonarcloud\.io|\.svg(\?|#|$)/i;
function attr(tag, name) {
    const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
    return m ? (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) : null;
}
const sizeOf = (v) => { const n = parseInt(String(v || ''), 10); return Number.isFinite(n) && n > 0 && !/%/.test(String(v)) ? n : null; };

// text + the address relative paths are read against -> [{ url, width }] in the order they appear (usable ones only: right host, not a badge, not declared tiny).
function picturesIn(text, base) {
    const found = [];
    const add = (raw, width) => {
        let u;
        try { u = new URL(String(raw || '').trim().replace(/^<|>$/g, ''), base); } catch { return; }
        if (!hostAllowed(u) || BADGE_RE.test(u.href) || /^https?:\/\/github\.com\/[^/]+\.(png|jpe?g)$/i.test(u.href)) return;
        if (width !== null && width < MIN_WIDTH) return;
        found.push({ url: u.href, width, at: 0 });
    };
    const src = String(text || '').slice(0, MAX_TEXT);
    const hits = [];
    let m;
    const md = /!\[[^\]]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
    while ((m = md.exec(src))) hits.push({ at: m.index, raw: m[1], width: null });
    const html = /<img\b[^>]*>/gi;
    while ((m = html.exec(src))) hits.push({ at: m.index, raw: attr(m[0], 'src'), width: sizeOf(attr(m[0], 'width')) });
    hits.sort((a, b) => a.at - b.at);
    for (const h of hits) if (h.raw) add(h.raw, h.width);
    // a picture declared 100-299 px wide is tried after the ones that are wider or of unknown size (stable otherwise)
    const small = (p) => (p.width !== null && p.width < PREFERRED_WIDTH ? 1 : 0);
    return found.map((p, i) => ({ ...p, i })).sort((a, b) => small(a) - small(b) || a.i - b.i).map(({ url, width }) => ({ url, width }));
}

// ---- fetching one picture ------------------------------------------------------------------------------------------------------------------

let backoffUntil = 0;
let active = 0;
const waiting = [];
function limited(fn) {
    return new Promise((resolve, reject) => {
        const run = () => { active++; fn().then(resolve, reject).finally(() => { active--; const next = waiting.shift(); if (next) next(); }); };
        if (active < MAX_AT_ONCE) run(); else waiting.push(run);
    });
}

// One GET with no cookies and no extras. -> { status, body, location, retryAfterMs }. Throws on a network failure, a timeout or a body that is too big.
function getOnce(u, deadline) {
    return new Promise((resolve, reject) => {
        const lib = u.protocol === 'http:' ? http : https;
        const left = Math.max(1, deadline - Date.now());
        const req = lib.get(u, { timeout: Math.min(left, timing.timeoutMs), headers: { 'User-Agent': 'modpacer', Accept: 'image/png,image/jpeg,image/webp,image/gif,*/*;q=0.1' } }, (res) => {
            const ra = Number(res.headers['retry-after']);
            const retryAfterMs = Number.isFinite(ra) && ra >= 0 ? ra * 1000 : null;
            const code = res.statusCode;
            if (code >= 300 && code < 400) { res.resume(); return resolve({ status: code, location: res.headers.location || null, body: null, retryAfterMs }); }
            if (code !== 200) { res.resume(); return resolve({ status: code, body: null, location: null, retryAfterMs }); }
            const chunks = [];
            let size = 0;
            res.on('data', (c) => { size += c.length; if (size > MAX_BYTES) { req.destroy(new Error('too big')); return; } chunks.push(c); });
            res.on('end', () => resolve({ status: 200, body: Buffer.concat(chunks), location: null, retryAfterMs }));
            res.on('error', reject);
        });
        const stop = setTimeout(() => req.destroy(new Error('timeout')), left); // the whole fetch has a limit, not only the idle time
        stop.unref();
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', (e) => { clearTimeout(stop); reject(e); });
        req.on('close', () => clearTimeout(stop));
    });
}

// -> { ok: true, body } | { ok: false, reason, transient } (transient: a limit, no network or a timeout: worth trying again later; otherwise the picture itself is refused)
async function fetchPicture(url) {
    if (Date.now() < backoffUntil) return { ok: false, reason: 'backoff', transient: true };
    let u;
    try { u = new URL(url); } catch { return { ok: false, reason: 'bad-address', transient: false }; }
    const deadline = Date.now() + timing.timeoutMs;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (!hostAllowed(u)) return { ok: false, reason: 'off-host', transient: false };
        let r;
        try { r = await limited(() => getOnce(u, deadline)); } catch (e) {
            const msg = e && e.message;
            if (msg === 'too big') return { ok: false, reason: 'too-big', transient: false };
            if (msg === 'timeout') backoffUntil = Date.now() + timing.backoffMs;
            return { ok: false, reason: 'network', transient: true };
        }
        if (r.status >= 300 && r.status < 400) {
            if (!r.location) return { ok: false, reason: 'bad-redirect', transient: false };
            try { u = new URL(r.location, u); } catch { return { ok: false, reason: 'bad-redirect', transient: false }; }
            continue;
        }
        if (r.status === 429 || r.status === 403) { backoffUntil = Date.now() + (r.retryAfterMs != null ? Math.min(r.retryAfterMs, 3600_000) : timing.backoffMs); return { ok: false, reason: `http-${r.status}`, transient: true }; }
        if (r.status !== 200) return { ok: false, reason: `http-${r.status}`, transient: r.status >= 500 };
        return { ok: true, body: r.body };
    }
    return { ok: false, reason: 'too-many-redirects', transient: false };
}

const isGif = (b) => b.length >= 6 && (b.toString('latin1', 0, 6) === 'GIF87a' || b.toString('latin1', 0, 6) === 'GIF89a');
// bytes -> { ok: true, bytes, mime, ext } | { ok: false, reason }. Decided by the first bytes only; SVG, HTML and anything else is refused.
function smallCopy(buf) {
    if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, reason: 'empty' };
    if (buf.length > MAX_BYTES) return { ok: false, reason: 'too-big' };
    if (isGif(buf) && !hubCovers.sizeOk(hubCovers.gifSize(buf))) return { ok: false, reason: 'too-many-pixels' }; // the size the file declares, not only its bytes
    if (isGif(buf)) return buf.length <= MAX_GIF_KEPT_BYTES ? { ok: true, bytes: buf, mime: 'image/gif', ext: 'gif' } : { ok: false, reason: 'gif-too-big' };
    const s = hubCovers.makeSmallCopy(buf);
    if (!s.ok) return s;
    return { ok: true, bytes: s.bytes, mime: s.mime, ext: s.mime === 'image/webp' ? 'webp' : 'jpg' };
}

// ---- the saved copies ------------------------------------------------------------------------------------------------------------------------

const h20 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);
const repoKey = (owner, repo) => h20(`${owner}/${repo}`.toLowerCase());
const stem = (owner, repo, tag) => `ghcover-${repoKey(owner, repo)}-${h20(String(tag))}`;
const MIMES = { jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

function savedPicture(s) {
    for (const ext of Object.keys(MIMES)) {
        const file = path.join(hubCovers.COVER_DIR(), `${s}.${ext}`);
        try { if (fs.statSync(file).isFile()) return { file, mime: MIMES[ext] }; } catch { /* not this kind */ }
    }
    return null;
}
function noneFresh(s) {
    try { return Date.now() - fs.statSync(path.join(hubCovers.COVER_DIR(), `${s}.none`)).mtimeMs < timing.noneForMs; } catch { return false; }
}
function save(owner, repo, s, name, data) {
    const dir = hubCovers.COVER_DIR();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
    const own = `ghcover-${repoKey(owner, repo)}-`; // an older release's copy of this repository goes
    try { for (const f of fs.readdirSync(dir)) if (f.startsWith(own) && !f.startsWith(s)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* best effort */ } } } catch { /* nothing there */ }
    hubCovers.trimCache();
    return file;
}

// ---- the look ----------------------------------------------------------------------------------------------------------------------------------

const failedAt = new Map();
const inFlight = new Map();
function recentlyFailed(key) {
    const at = failedAt.get(key);
    if (at == null) return false;
    if (Date.now() - at < timing.failMemoryMs) return true;
    failedAt.delete(key);
    return false;
}
const rawBase = (owner, repo) => `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/`;
const apiOpts = { optional: true }; // a look nobody clicked for never spends the last of GitHub's budget (lib/github.js)

// Tries up to MAX_TRIES_PER_PLACE pictures of one place. -> { got: {bytes,mime,ext} | null, transient }
async function tryPlace(list) {
    let transient = false;
    for (const p of list.slice(0, MAX_TRIES_PER_PLACE)) {
        const f = await fetchPicture(p.url);
        if (!f.ok) { if (f.transient) { transient = true; if (f.reason === 'backoff' || /^http-4(03|29)$/.test(f.reason)) break; } continue; }
        const c = smallCopy(f.body);
        if (c.ok) return { got: c, transient };
    }
    return { got: null, transient };
}

async function lookFor(owner, repo, tag) {
    let transient = false;
    // 1. the release's own description
    try {
        const rel = await github.apiRequest(`/repos/${owner}/${repo}/releases/latest`, apiOpts);
        if (rel && typeof rel.body === 'string' && String(rel.tag_name) === String(tag)) {
            const r = await tryPlace(picturesIn(rel.body, rawBase(owner, repo)));
            if (r.got) return { got: r.got, transient: false, from: 'release' };
            transient = transient || r.transient;
        }
    } catch { transient = true; }
    // 2. the README
    try {
        const rd = await github.apiRequest(`/repos/${owner}/${repo}/readme`, apiOpts);
        if (rd && typeof rd.content === 'string' && (rd.encoding || 'base64') === 'base64') {
            let base = rawBase(owner, repo);
            try { const d = new URL(String(rd.download_url || '')); if (hostAllowed(d)) base = d.href; } catch { /* the plain base */ }
            const text = Buffer.from(rd.content, 'base64').toString('utf8');
            const r = await tryPlace(picturesIn(text, base));
            if (r.got) return { got: r.got, transient: false, from: 'readme' };
            transient = transient || r.transient;
        }
    } catch (e) { if (!(e && e.statusCode === 404)) transient = true; } // a repository with no README is an answer, not a failure
    return { got: null, transient };
}

// owner/repo/tag -> { ok: true, file, mime } | { ok: false, reason }. `cfg.showModPictures === false` is "no picture, nothing fetched".
async function getGithubCover(owner, repo, tag, cfg) {
    if (!cfg || cfg.showModPictures === false) return { ok: false, reason: 'not-allowed' };
    const { safeOwner, safeRepo } = require('./tracked-github');
    if (!safeOwner(owner) || !safeRepo(repo) || !tag || typeof tag !== 'string') return { ok: false, reason: 'no-entry' };
    const s = stem(owner, repo, tag);
    const saved = savedPicture(s);
    if (saved) { try { const n = new Date(); fs.utimesSync(saved.file, n, n); } catch { /* ordering only */ } return { ok: true, ...saved }; }
    if (noneFresh(s)) return { ok: false, reason: 'none' };
    if (recentlyFailed(s)) return { ok: false, reason: 'failed-lately' };
    if (inFlight.has(s)) return inFlight.get(s);
    const p = (async () => {
        const r = await lookFor(owner, repo, tag);
        if (r.got) {
            try { const file = save(owner, repo, s, `${s}.${r.got.ext}`, r.got.bytes); return { ok: true, file, mime: r.got.mime }; } catch { return { ok: false, reason: 'cannot-save' }; }
        }
        if (r.transient) { failedAt.set(s, Date.now()); return { ok: false, reason: 'failed-lately' }; }
        try { save(owner, repo, s, `${s}.none`, String(Date.now())); } catch { /* looked at again next time */ }
        return { ok: false, reason: 'none' };
    })().finally(() => inFlight.delete(s));
    inFlight.set(s, p);
    return p;
}

// The tracked mod's record -> the picture for the GitHub place it follows (the first GitHub source), by the release tag the version check last read.
async function getForTracked(rec, cfg) {
    const src = rec && Array.isArray(rec.sources) ? rec.sources.find((x) => x && x.type === 'github') : null;
    if (!src) return { ok: false, reason: 'no-source' };
    const obs = rec.observation && rec.observation[src.id];
    if (!obs || typeof obs.tag !== 'string' || !obs.tag) return { ok: false, reason: 'no-release' };
    return getGithubCover(src.owner, src.repo, obs.tag, cfg);
}

function _reset() { backoffUntil = 0; failedAt.clear(); inFlight.clear(); }

module.exports = { picturesIn, smallCopy, fetchPicture, getGithubCover, getForTracked, hostAllowed, setTiming, _reset, HOSTS, MAX_BYTES };
