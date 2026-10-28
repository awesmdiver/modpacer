'use strict';
// A mod's cover picture and description from the Plugin Hub's store (queue: show-each-mods-cover-picture-and-description-from-the-hub).
//
//   picture      https://raw.githubusercontent.com/MinLL/SkyrimNet-Plugins/{image.commit}/{folder}/{image.file}   (the catalog entry's `image`)
//   description  https://raw.githubusercontent.com/MinLL/SkyrimNet-Plugins/{newest history commit}/{folder}/manifest.json  (its `description` field)
//
// Only these two raw GitHub files are ever read. The Hub's download endpoint is NEVER called from here (it counts a download).
// Rules, all of them about being kind to GitHub and safe for the page:
//   * Fetched one mod at a time on request (the page asks only for rows that are on screen), never more than 4 at once, never all of them.
//   * A 403/429 or a timeout backs everything off for a while and is never retried in a loop. A failure is just "no picture" (no message).
//   * The picture's git blob sha is checked against the catalog's `image.sha` before it is used; a mismatch is "can't load".
//   * Only a real PNG or JPEG (or a small WebP) is accepted, at most 8 MB. It is shrunk to 384 px wide and kept as a ~30 KB JPEG
//     in <data>/cache/covers, so the page only ever loads pictures from ModPacer itself (the page's img-src is 'self').
//   * The description is turned into PLAIN TEXT lines here (no links, images, HTML or author formatting survive), about 6,000 characters at most.
//   * Nothing is fetched or shown for an adult mod unless the Settings adult switch is on, and nothing at all when "Show mod pictures" is off.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const { dataPath } = require('./data-dir');

const DEFAULT_RAW_BASE = 'https://raw.githubusercontent.com/MinLL/SkyrimNet-Plugins';
// Tests point this at a stand-in; nothing else ever sets it.
function rawBase() {
    const base = (process.env.SKYRIMNET_HUB_RAW_BASE || DEFAULT_RAW_BASE).replace(/\/+$/, '');
    if (process.env.MODPACER_TEST_RUN_DIR && /githubusercontent\.com/i.test(base)) throw new Error('a test tried to read the real Hub store');
    return base;
}

const COVER_DIR = () => dataPath('cache', 'covers');
const MAX_PICTURE_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_WEBP_KEPT_BYTES = 400 * 1024; // a WebP cannot be shrunk here; a small one is kept as it is, a big one is "can't load"
const MAX_PIXELS = 16_000_000; // about 4000 x 4000; a decode needs roughly 12 bytes per pixel, so one stays under ~200 MB
const THUMB_WIDTH = 384;
const JPEG_QUALITY = 80;
const MAX_DESCRIPTION_CHARS = 6000;
const CACHE_CAP_BYTES = 40 * 1024 * 1024;   // above this, the oldest saved copies go first...
const CACHE_TRIM_TO_BYTES = 32 * 1024 * 1024; // ...down to this
const MAX_AT_ONCE = 4;
const REQUEST_TIMEOUT_MS = 15_000;
const FAIL_MEMORY_MS = 10 * 60 * 1000;     // a mod that could not be read is not asked for again for a while
const DEFAULT_BACKOFF_MS = 5 * 60 * 1000;  // after a 403/429/timeout, nothing is asked of GitHub for this long (or Retry-After)
const PLUGIN_ID_RE = /^[a-z0-9_-]{1,64}\.[a-z0-9_-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const FOLDER_RE = /^plugins\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const FILE_RE = /^[A-Za-z0-9_.-]{1,100}\.(png|jpe?g|webp)$/i;

const timing = { backoffMs: DEFAULT_BACKOFF_MS, failMemoryMs: FAIL_MEMORY_MS, timeoutMs: REQUEST_TIMEOUT_MS };
function setTiming(t) { Object.assign(timing, t || {}); }

// ---- addresses -----------------------------------------------------------------------------------------------------------------------

function safeFolder(entry) {
    const f = entry && typeof entry.folder === 'string' ? entry.folder : '';
    return FOLDER_RE.test(f) && !f.includes('..') ? f : null;
}
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

// The catalog entry's `image` -> the address of the picture, or null when the entry has no usable cover.
function coverUrl(entry) {
    const img = entry && entry.image;
    const folder = safeFolder(entry);
    if (!img || typeof img !== 'object' || !folder) return null;
    if (typeof img.commit !== 'string' || !SHA_RE.test(img.commit) || typeof img.sha !== 'string' || !SHA_RE.test(img.sha)) return null;
    if (typeof img.file !== 'string' || !FILE_RE.test(img.file) || img.file.includes('..')) return null;
    return `${rawBase()}/${img.commit}/${encodePath(folder)}/${encodeURIComponent(img.file)}`;
}
function hasCover(entry) { try { return !!entry && !!entry.image && !!safeFolder(entry) && !!(entry.image.sha && SHA_RE.test(entry.image.sha)) && FILE_RE.test(String(entry.image.file || '')) && SHA_RE.test(String(entry.image.commit || '')); } catch { return false; } }

function descriptionCommit(entry) {
    const h = entry && Array.isArray(entry.history) ? entry.history[0] : null;
    return h && typeof h.commit === 'string' && SHA_RE.test(h.commit) ? h.commit : null;
}
function manifestUrl(entry) {
    const folder = safeFolder(entry);
    const commit = descriptionCommit(entry);
    if (!folder || !commit) return null;
    return `${rawBase()}/${commit}/${encodePath(folder)}/manifest.json`;
}

// The git blob SHA-1 the Hub guide checks files against: sha1("blob <size>\0" + bytes).
function gitBlobSha(bytes) {
    return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

// ---- the picture: what it is, and a small copy of it ---------------------------------------------------------------------------------

function sniff(buf) {
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
    if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
    return null;
}

// Area-average shrink of RGBA pixels to `outW` wide (keeps the shape). The picture's transparent parts are laid over the page's dark background.
function shrinkRgba(src, w, h, outW) {
    const outH = Math.max(1, Math.round(h * outW / w));
    const out = Buffer.alloc(outW * outH * 4);
    const bg = [24, 24, 28];
    for (let y = 0; y < outH; y++) {
        const y0 = Math.floor(y * h / outH), y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / outH));
        for (let x = 0; x < outW; x++) {
            const x0 = Math.floor(x * w / outW), x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / outW));
            let r = 0, g = 0, b = 0, n = 0;
            for (let yy = y0; yy < y1; yy++) {
                for (let xx = x0; xx < x1; xx++) {
                    const i = (yy * w + xx) * 4, a = src[i + 3] / 255;
                    r += src[i] * a + bg[0] * (1 - a); g += src[i + 1] * a + bg[1] * (1 - a); b += src[i + 2] * a + bg[2] * (1 - a); n++;
                }
            }
            const o = (y * outW + x) * 4;
            out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = 255;
        }
    }
    return { data: out, width: outW, height: outH };
}

// bytes -> { ok: true, bytes, mime } | { ok: false, reason }. Never throws.
function makeSmallCopy(buf) {
    try {
        if (!Buffer.isBuffer(buf) || buf.length === 0) return { ok: false, reason: 'empty' };
        if (buf.length > MAX_PICTURE_BYTES) return { ok: false, reason: 'too-big' };
        const kind = sniff(buf);
        if (!kind) return { ok: false, reason: 'not-an-image' };
        if (kind === 'webp') return buf.length <= MAX_WEBP_KEPT_BYTES ? { ok: true, bytes: buf, mime: 'image/webp' } : { ok: false, reason: 'webp-too-big' };
        let px;
        if (kind === 'png') {
            // A tiny PNG can declare a huge size (a decompression bomb): read the declared size from the header BEFORE decoding anything.
            if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return { ok: false, reason: 'unreadable' };
            if (buf.readUInt32BE(16) * buf.readUInt32BE(20) > MAX_PIXELS) return { ok: false, reason: 'too-many-pixels' };
            const png = PNG.sync.read(buf);
            px = { data: png.data, width: png.width, height: png.height };
        } else {
            const j = jpeg.decode(buf, { useTArray: true, maxResolutionInMP: MAX_PIXELS / 1e6, maxMemoryUsageInMB: 512, formatAsRGBA: true });
            px = { data: Buffer.from(j.data.buffer, j.data.byteOffset, j.data.byteLength), width: j.width, height: j.height };
        }
        if (!(px.width > 0 && px.height > 0) || px.width * px.height > MAX_PIXELS) return { ok: false, reason: 'too-many-pixels' };
        const small = px.width > THUMB_WIDTH ? shrinkRgba(px.data, px.width, px.height, THUMB_WIDTH) : { data: px.data, width: px.width, height: px.height };
        const enc = jpeg.encode({ data: small.data, width: small.width, height: small.height }, JPEG_QUALITY);
        return { ok: true, bytes: Buffer.from(enc.data), mime: 'image/jpeg' };
    } catch (e) {
        return { ok: false, reason: 'unreadable' };
    }
}

// ---- the description: the author's text -> plain lines ------------------------------------------------------------------------------

// A line is a list of runs: { t: text, b: true when bold }. Bullets start with a dot. Nothing here can carry a link, image, tag or script:
// the page only ever puts these runs in as escaped text, and this strips the marks first so they do not even show.
function inlineRuns(s) {
    // links and images lose their address, keeping the words
    s = s.replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, '$1').replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1');
    s = s.replace(/<\/?[A-Za-z!][^>\n]{0,200}>/g, ''); // HTML tags
    s = s.replace(/`([^`\n]*)`/g, '$1').replace(/~~/g, '');
    const runs = [];
    const push = (t, b) => { if (t) { if (runs.length && runs[runs.length - 1].b === b) runs[runs.length - 1].t += t; else runs.push({ t, b }); } };
    const re = /\*\*([^*\n]+?)\*\*|(^|[\s(])__([^_\n]+?)__(?=[\s).,!?:;]|$)/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
        if (m[1] !== undefined) { push(s.slice(last, m.index), false); push(m[1], true); }
        else { push(s.slice(last, m.index) + m[2], false); push(m[3], true); }
        last = m.index + m[0].length;
    }
    push(s.slice(last), false);
    // leftover single-star / single-underscore emphasis and stray marks
    return runs.map((r) => ({ t: r.t
        .replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s).,!?:;]|$)/g, '$1$2')
        .replace(/(^|[\s(])_([^_\n]+?)_(?=[\s).,!?:;]|$)/g, '$1$2')
        .replace(/\*\*/g, ''), b: r.b })).filter((r) => r.t);
}
const allBold = (runs) => runs.reduce((out, r) => { if (out.length) out[out.length - 1].t += r.t; else out.push({ t: r.t, b: true }); return out; }, []);
const plainOf = (runs) => runs.map((r) => r.t).join('');

// The Hub's authors write markdown-ish text ("## Features", "- item", "**Bold**") and sometimes plain "Features" lines, sometimes with a
// literal backslash-n inside a bullet. -> { lines: [[run]] } (an empty array is a blank line), or null when there is nothing to show.
function cleanDescription(raw) {
    if (typeof raw !== 'string') return null;
    let text = raw.slice(0, MAX_DESCRIPTION_CHARS)
        .replace(/\r\n?/g, '\n')
        .replace(/\\n/g, '\n')          // a stray literal \n becomes a line break
        .replace(/\\(["'`*_#\\])/g, '$1') // a stray backslash before a mark
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
        .replace(/[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\u061c\ufeff]/g, ''); // invisible text-direction and zero-width marks
    const src = text.split('\n').map((l) => l.replace(/\s+$/, ''));
    const lines = [];
    const nextNonBlank = (i) => { for (let k = i + 1; k < src.length; k++) if (src[k].trim()) return src[k]; return null; };
    src.forEach((line, i) => {
        const t = line.trim();
        if (!t) { if (lines.length && lines[lines.length - 1].length) lines.push([]); return; }
        let m;
        if ((m = /^#{1,6}\s+(.*)$/.exec(t))) { const runs = allBold(inlineRuns(m[1])); if (runs.length) lines.push(runs); return; }
        if ((m = /^(?:[-*+•]|\d{1,3}[.)])\s+(.*)$/.exec(t))) { const runs = inlineRuns(m[1]); if (runs.length) lines.push([{ t: '• ', b: false }, ...runs]); return; }
        if (/^([-*_=])\1{2,}$/.test(t)) return; // a rule line
        const runs = inlineRuns(t);
        if (!runs.length) return;
        // a short line with no ending mark, followed by more text, is a heading even without "##" (the way "Features" is written in some manifests)
        const plain = plainOf(runs);
        const nxt = nextNonBlank(i);
        const looksLikeHeading = plain.length <= 32 && plain.split(/\s+/).length <= 4 && !/[.:,;!?)]$/.test(plain) && nxt !== null && !/^\s*$/.test(nxt);
        lines.push(looksLikeHeading ? allBold(runs) : runs);
    });
    while (lines.length && !lines[0].length) lines.shift();
    while (lines.length && !lines[lines.length - 1].length) lines.pop();
    return lines.length ? { lines } : null;
}

// ---- fetching ------------------------------------------------------------------------------------------------------------------------

let backoffUntil = 0;
const failedAt = new Map(); // cache key -> when it failed
let active = 0;
const waiting = [];
function limited(fn) {
    return new Promise((resolve, reject) => {
        const run = () => { active++; fn().then(resolve, reject).finally(() => { active--; const next = waiting.shift(); if (next) next(); }); };
        if (active < MAX_AT_ONCE) run(); else waiting.push(run);
    });
}

// One plain GET (no redirects followed, no cookies). -> { status, body, retryAfterMs } | throws on a network failure / timeout / too big.
function getBytes(url, maxBytes) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('http:') ? http : https;
        const req = lib.get(url, { timeout: timing.timeoutMs, headers: { Accept: '*/*' } }, (res) => {
            const ra = Number(res.headers['retry-after']);
            const retryAfterMs = Number.isFinite(ra) && ra >= 0 ? ra * 1000 : null;
            if (res.statusCode !== 200) { res.resume(); return resolve({ status: res.statusCode, body: null, retryAfterMs }); }
            const chunks = [];
            let size = 0;
            res.on('data', (c) => {
                size += c.length;
                if (size > maxBytes) { req.destroy(new Error('too big')); return; }
                chunks.push(c);
            });
            res.on('end', () => resolve({ status: 200, body: Buffer.concat(chunks), retryAfterMs }));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

// -> { ok: true, body } | { ok: false, reason }. A 403/429 or a timeout starts the back-off; nothing then asks GitHub until it is over.
async function fetchStore(url, maxBytes) {
    if (Date.now() < backoffUntil) return { ok: false, reason: 'backoff' };
    let r;
    try {
        r = await limited(() => getBytes(url, maxBytes));
    } catch (e) {
        if (/timeout/.test(e && e.message)) backoffUntil = Date.now() + timing.backoffMs;
        return { ok: false, reason: e && e.message === 'too big' ? 'too-big' : 'network' };
    }
    if (r.status === 429 || r.status === 403) { backoffUntil = Date.now() + (r.retryAfterMs != null ? Math.min(r.retryAfterMs, 3600_000) : timing.backoffMs); return { ok: false, reason: `http-${r.status}` }; }
    if (r.status !== 200) return { ok: false, reason: `http-${r.status}` };
    return { ok: true, body: r.body };
}

// ---- the saved copies ----------------------------------------------------------------------------------------------------------------

function ensureDir() { fs.mkdirSync(COVER_DIR(), { recursive: true }); }
const picName = (id, sha) => `cover-${id}-${sha}.img`;
const descName = (id, commit) => `desc-${id}-${commit}.json`;

// Saved files are <kind>-<id>-<sha or commit>.<ext>; the sha/commit has no dash, so split on the LAST dash and compare the id exactly
// (a prefix match would let "a.b" and "a.b-c" delete each other's copy).
function savedFileId(f, kind, ext) {
    if (!f.startsWith(kind + '-') || !f.endsWith(ext)) return null;
    const core = f.slice(kind.length + 1, f.length - ext.length);
    const dash = core.lastIndexOf('-');
    return dash > 0 ? core.slice(0, dash) : null;
}
function removeOthers(kind, ext, id, keep) {
    try {
        for (const f of fs.readdirSync(COVER_DIR())) if (savedFileId(f, kind, ext) === id && f !== keep) { try { fs.unlinkSync(path.join(COVER_DIR(), f)); } catch { /* best effort */ } }
    } catch { /* nothing there */ }
}

// Oldest-first eviction once the folder passes its cap.
function trimCache() {
    try {
        const dir = COVER_DIR();
        const files = fs.readdirSync(dir).map((f) => { const st = fs.statSync(path.join(dir, f)); return { f, size: st.size, at: st.mtimeMs }; });
        let total = files.reduce((n, x) => n + x.size, 0);
        if (total <= CACHE_CAP_BYTES) return;
        for (const x of files.sort((a, b) => a.at - b.at)) {
            if (total <= CACHE_TRIM_TO_BYTES) break;
            try { fs.unlinkSync(path.join(dir, x.f)); total -= x.size; } catch { /* best effort */ }
        }
    } catch { /* the cache is a convenience */ }
}
function touch(file) { try { const now = new Date(); fs.utimesSync(file, now, now); } catch { /* ordering only */ } }

function writeAtomic(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
}

const inFlight = new Map(); // one fetch per key, whoever asks
function once(key, fn) {
    if (inFlight.has(key)) return inFlight.get(key);
    const p = fn().finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
}
function recentlyFailed(key) {
    const at = failedAt.get(key);
    if (at == null) return false;
    if (Date.now() - at < timing.failMemoryMs) return true;
    failedAt.delete(key);
    return false;
}

// Whether the Settings allow a picture for this mod: "Show mod pictures" on, and an adult mod only with the adult switch on.
function pictureAllowed(entry, cfg) {
    if (!cfg || cfg.showModPictures === false) return false;
    if (entry && entry.nsfw && !cfg.showAdultNotInstalled) return false;
    return true;
}

// -> { ok: true, file, mime } (the saved small copy; the page serves this file) | { ok: false, reason }.
async function getCover(entry, cfg) {
    if (!entry || !PLUGIN_ID_RE.test(String(entry.plugin_id || ''))) return { ok: false, reason: 'no-entry' };
    if (!pictureAllowed(entry, cfg)) return { ok: false, reason: 'not-allowed' };
    if (!hasCover(entry)) return { ok: false, reason: 'no-cover' };
    const id = entry.plugin_id, sha = entry.image.sha;
    const file = path.join(COVER_DIR(), picName(id, sha));
    try {
        if (fs.statSync(file).isFile()) { touch(file); return { ok: true, file, mime: readMime(file) }; }
    } catch { /* not saved yet */ }
    const key = `pic|${id}|${sha}`;
    if (recentlyFailed(key)) return { ok: false, reason: 'failed-lately' };
    return once(key, async () => {
        const url = coverUrl(entry);
        if (!url) return { ok: false, reason: 'no-cover' };
        const got = await fetchStore(url, MAX_PICTURE_BYTES);
        if (!got.ok) { if (got.reason !== 'backoff') failedAt.set(key, Date.now()); return got; }
        if (gitBlobSha(got.body) !== sha) { failedAt.set(key, Date.now()); return { ok: false, reason: 'sha-mismatch' }; }
        const small = makeSmallCopy(got.body);
        if (!small.ok) { failedAt.set(key, Date.now()); return small; }
        try {
            ensureDir();
            // first byte of the saved file says which kind it is: JPEG files start 0xFF, WebP files start 'R'
            writeAtomic(file, small.bytes);
            removeOthers('cover', '.img', id, picName(id, sha));
            trimCache();
        } catch { return { ok: false, reason: 'cannot-save' }; }
        return { ok: true, file, mime: small.mime };
    });
}
function readMime(file) {
    try {
        const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd);
        return b.toString('latin1', 0, 4) === 'RIFF' ? 'image/webp' : 'image/jpeg';
    } catch { return 'image/jpeg'; }
}

// -> { ok: true, lines } | { ok: false, reason } (no description at all is { ok: true, lines: null }, remembered like any answer).
async function getDescription(entry) {
    if (!entry || !PLUGIN_ID_RE.test(String(entry.plugin_id || ''))) return { ok: false, reason: 'no-entry' };
    const commit = descriptionCommit(entry);
    if (!commit || !safeFolder(entry)) return { ok: false, reason: 'no-commit' };
    const id = entry.plugin_id;
    const file = path.join(COVER_DIR(), descName(id, commit));
    try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (saved && saved.v === 1) { touch(file); return { ok: true, lines: saved.lines || null }; }
    } catch { /* not saved yet */ }
    const key = `desc|${id}|${commit}`;
    if (recentlyFailed(key)) return { ok: false, reason: 'failed-lately' };
    return once(key, async () => {
        const got = await fetchStore(manifestUrl(entry), MAX_MANIFEST_BYTES);
        if (!got.ok) { if (got.reason !== 'backoff') failedAt.set(key, Date.now()); return got; }
        let desc = null;
        try {
            const m = JSON.parse(got.body.toString('utf8'));
            desc = m && typeof m.description === 'string' ? cleanDescription(m.description) : null;
        } catch { failedAt.set(key, Date.now()); return { ok: false, reason: 'unreadable' }; }
        try {
            ensureDir();
            writeAtomic(file, JSON.stringify({ v: 1, lines: desc ? desc.lines : null }));
            removeOthers('desc', '.json', id, descName(id, commit));
            trimCache();
        } catch { /* shown this time, fetched again next time */ }
        return { ok: true, lines: desc ? desc.lines : null };
    });
}

// Tests only.
function _reset() { backoffUntil = 0; failedAt.clear(); inFlight.clear(); }
function _state() { return { backoffUntil, active, waiting: waiting.length }; }

module.exports = {
    coverUrl, manifestUrl, hasCover, gitBlobSha, makeSmallCopy, cleanDescription, getCover, getDescription, pictureAllowed, setTiming, trimCache,
    COVER_DIR, removeOthers, MAX_AT_ONCE, MAX_PICTURE_BYTES, MAX_DESCRIPTION_CHARS, CACHE_CAP_BYTES, _reset, _state,
};
