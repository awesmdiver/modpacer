'use strict';
// Tells the plugins page (fateless.ai) that the person installed, updated or visited a Hub mod, so its author's numbers are right.
// The rules are the Plugin Hub API v1 guide's "How downloads are counted" (design/fateless-plugin-hub-api-v1.md); authors see these
// numbers, so every rule here is about never counting something the person did not ask for:
//
//   * ONE call per plugin and version per install action. The plugin id + version already counted in this process is remembered
//     (even if the call failed), so a retry or a restart of the same install never counts again.
//   * Never for a check, the automatic check, a prefetch, a preview, a download that happens by itself, or the fateless icon.
//   * A page visit (the Mod page arrow, Open on Nexus) is one call per click, and a second click on the same mod within 10 s is ignored.
//   * The install NEVER waits on the count: callers fire it and carry on. A short timeout, errors handled quietly:
//       429 -> wait Retry-After once, then drop      503 -> one retry after ~5 s, then drop
//       400 / 404 / 422 -> drop, one log line        network failure / timeout -> drop
//     A failed call is not counted by the server, so dropping is honest.
//   * The calls go through one queue, one at a time with a gap, so Install all of many mods stays under the limit (60 a minute per address).
//   * Nothing is sent but {"v":1,"plugin_id":"..."} and the Content-Type header: no user id, no cookies, no PC, no other mods.
//   * Always on: there is no Settings switch (director, 2026-10-07). An old saved tellHubOnInstall is ignored.

const http = require('http');
const https = require('https');
const { logUpdate } = require('./update-log');

const DEFAULT_API_BASE = 'https://fateless.ai';
// Tests point this at a fake Hub; nothing else ever sets it.
const apiBase = () => {
    const base = (process.env.SKYRIMNET_HUB_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
    // A test process can never reach the real endpoint (every successful call counts as a real download for a real author).
    if (process.env.MODPACER_TEST_RUN_DIR && /fateless\.ai/i.test(base)) throw new Error('a test tried to call the real plugins-page endpoint');
    return base;
};

const timing = { gapMs: 1200, retryDelayMs: 5000, timeoutMs: 5000, maxRetryAfterMs: 60_000, visitWindowMs: 10_000 };
function setTiming(t) { Object.assign(timing, t || {}); }

const counted = new Set();   // `${plugin_id}|${version}` already asked for in this process
const lastVisit = new Map(); // plugin_id -> when a visit was last counted
let queue = Promise.resolve();
let pending = 0;
let lastStartAt = 0;
const startTimes = []; // when each call actually started (the spacing guarantee is about these, not about when a server sees them); for tests

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One POST. Only Content-Type (and the length/host the protocol itself needs) goes out: https.request adds no User-Agent or cookies.
// -> { status, retryAfterMs, body } or throws on a network failure / timeout.
function postOnce(pluginId) {
    return new Promise((resolve, reject) => {
        const url = new URL('/v1/hub/download', apiBase() + '/');
        const body = JSON.stringify({ v: 1, plugin_id: pluginId });
        const lib = url.protocol === 'http:' ? http : https;
        const req = lib.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: timing.timeoutMs }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (c) => { size += c.length; if (size < 65536) chunks.push(c); });
            res.on('end', () => {
                const ra = Number(res.headers['retry-after']);
                resolve({ status: res.statusCode, retryAfterMs: Number.isFinite(ra) && ra >= 0 ? ra * 1000 : null, body: Buffer.concat(chunks).toString('utf8') });
            });
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end(body);
    });
}

function note(pluginId, what) { logUpdate(`plugins-page: ${pluginId}: ${what}`); }

// The whole policy for one count, run inside the queue. Never throws.
async function runCall(pluginId, ourUrl) {
    let r;
    try {
        r = await postOnce(pluginId);
        if (r.status === 429) {
            await sleep(Math.min(r.retryAfterMs == null ? timing.retryDelayMs : r.retryAfterMs, timing.maxRetryAfterMs));
            r = await postOnce(pluginId); // once; whatever comes back after this is the end of it
        } else if (r.status === 503) {
            await sleep(timing.retryDelayMs);
            r = await postOnce(pluginId);
        }
    } catch (e) {
        note(pluginId, `not counted (${e.message})`);
        return { counted: false, reason: 'network' };
    }
    if (r.status === 200) {
        try {
            const j = JSON.parse(r.body);
            if (j && j.type === 'listing' && j.external_url && ourUrl && j.external_url !== ourUrl) note(pluginId, `the Hub's link (${j.external_url}) differs from the one used (${ourUrl})`);
        } catch { /* the answer is not needed for anything */ }
        return { counted: true };
    }
    note(pluginId, `not counted (HTTP ${r.status})`);
    return { counted: false, reason: `http-${r.status}` };
}

// Puts one call on the queue. Returns a promise nobody has to await (callers never do).
function enqueue(pluginId, ourUrl) {
    pending++;
    const job = queue.then(async () => {
        const wait = lastStartAt + timing.gapMs - Date.now();
        if (wait > 0) await sleep(wait);
        lastStartAt = Date.now();
        startTimes.push(lastStartAt);
        return runCall(pluginId, ourUrl);
    }).finally(() => { pending--; });
    queue = job.catch(() => {});
    return job;
}

// An install, update or download the person asked for. `version` is the version being installed (the key of "already counted").
// -> { sent: false, reason } or { sent: true, done: Promise }
function countInstall({ pluginId, version, listingUrl } = {}) {
    if (!pluginId || typeof pluginId !== 'string') return { sent: false, reason: 'no-id' };
    const key = `${pluginId}|${version || ''}`;
    if (counted.has(key)) return { sent: false, reason: 'already-counted' };
    counted.add(key);
    return { sent: true, done: enqueue(pluginId, listingUrl || null) };
}

// A click through to the mod's own page (the Mod page arrow, Open on Nexus). One call per click; a second click on the same mod
// within 10 seconds counts once.
function countVisit({ pluginId, listingUrl } = {}) {
    if (!pluginId || typeof pluginId !== 'string') return { sent: false, reason: 'no-id' };
    const now = Date.now();
    const last = lastVisit.get(pluginId);
    if (last != null && now - last < timing.visitWindowMs) return { sent: false, reason: 'double-click' };
    lastVisit.set(pluginId, now);
    return { sent: true, done: enqueue(pluginId, listingUrl || null) };
}

// Tests only.
function _reset() { counted.clear(); lastVisit.clear(); lastStartAt = 0; startTimes.length = 0; }
function whenIdle() { return queue.then(() => (pending > 0 ? whenIdle() : undefined)); }

module.exports = { countInstall, countVisit, setTiming, whenIdle, _reset, timing, _startTimes: startTimes };
