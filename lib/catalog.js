'use strict';
// Reads SkyrimNet's official Plugin Hub catalog: ONE plain GET of index.json (the Plugin Hub API v1 guide,
// design/fateless-plugin-hub-api-v1.md), cached on disk so the page still works offline.
//
//   https://raw.githubusercontent.com/MinLL/SkyrimNet-Plugins/main/index.json   (about 320 KB, 250 entries on 2026-10-04)
//
// Rules from the guide: read it with a plain GET, never more often than every few minutes (we use 5), ignore fields
// we do not recognise. The first version of this file downloaded the whole repository as a zip and read every
// manifest.json; index.json replaces both the zip and the folder scan, and carries `plugin_id`, `stats` and `hidden`
// that the manifests never had.
//
// Every entry is handed on in the shape the rest of the app already used for a manifest (`id`, `title`, `version`,
// `external_url`, `changelog`, ...), with two differences: `id` is now the entry's `plugin_id` (author.slug, lower case,
// the Hub's canonical id and what the download call needs), and `folder` keeps the repository folder the catalog calls `id`.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const DEFAULT_CATALOG_URL = 'https://raw.githubusercontent.com/MinLL/SkyrimNet-Plugins/main/index.json';
// Tests point this at a stand-in; nothing else ever sets it.
const catalogUrl = () => process.env.SKYRIMNET_HUB_CATALOG_URL || DEFAULT_CATALOG_URL;
const CACHE_DIR = require('./data-dir').dataPath('cache');
const INDEX_PATH = path.join(CACHE_DIR, 'hub-index.json');
const META_PATH = path.join(CACHE_DIR, 'hub-index-meta.json');
const MIN_REFETCH_MS = 5 * 60 * 1000; // the guide: "don't re-read it more than every few minutes"
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BYTES = 20 * 1024 * 1024; // a runaway answer is dropped, not buffered forever
const PLUGIN_ID_RE = /^[a-z0-9_-]{1,64}\.[a-z0-9_-]{1,64}$/;

// The plugins site: every listing has its own page at <base>/<author>/<slug>, built from the entry's plugin_id (split on its single dot).
const HUB_PLUGINS_BASE_URL = 'https://fateless.ai/plugins';
function hubPageUrl(entry) {
    const id = entry && typeof entry.plugin_id === 'string' ? entry.plugin_id.toLowerCase() : '';
    if (!PLUGIN_ID_RE.test(id)) return null;
    const [author, slug] = id.split('.');
    return `${HUB_PLUGINS_BASE_URL}/${author}/${slug}`;
}

// One plain GET, with a conditional header when we hold an ETag / Last-Modified from last time.
// -> { status: 200, body, etag, lastModified } | { status: 304 }
function httpGet(url, meta, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        const headers = {};
        if (meta && meta.etag) headers['If-None-Match'] = meta.etag;
        else if (meta && meta.lastModified) headers['If-Modified-Since'] = meta.lastModified;
        const lib = url.startsWith('http:') ? http : https;
        const req = lib.get(url, { headers, timeout: REQUEST_TIMEOUT_MS }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                if (redirectsLeft <= 0) return reject(new Error('Too many redirects fetching the Plugin Hub catalog.'));
                let next;
                try { next = new URL(res.headers.location, url); } catch { return reject(new Error('The Plugin Hub catalog was sent to an address that was not valid.')); }
                if (next.protocol !== 'https:') return reject(new Error('The Plugin Hub catalog was sent to an address that is not secure (not https), so ModPacer stopped.'));
                return resolve(httpGet(next.href, meta, redirectsLeft - 1));
            }
            if (res.statusCode === 304) { res.resume(); return resolve({ status: 304 }); }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`Couldn't download the Plugin Hub catalog (HTTP ${res.statusCode}).`));
            }
            const chunks = [];
            let size = 0;
            res.on('data', (c) => {
                size += c.length;
                if (size > MAX_BYTES) { req.destroy(new Error('The Plugin Hub catalog answer was far too big.')); return; }
                chunks.push(c);
            });
            res.on('end', () => resolve({ status: 200, body: Buffer.concat(chunks).toString('utf8'), etag: res.headers.etag || null, lastModified: res.headers['last-modified'] || null }));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('The Plugin Hub catalog took too long to answer.')));
        req.on('error', reject);
    });
}

function readMeta() {
    try { return JSON.parse(fs.readFileSync(META_PATH, 'utf8')); } catch { return null; }
}
function writeMeta(meta) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2), 'utf8');
}
function readCachedIndex() {
    try {
        const raw = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
        return raw && Array.isArray(raw.plugins) ? raw : null;
    } catch { return null; }
}
function writeCachedIndex(text) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = `${INDEX_PATH}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, INDEX_PATH); // the last good copy is never half-written
}

// The older catalog cache (repository zip + extracted manifests) is ours and now unused: removed once, quietly.
let oldCacheRemoved = false;
function removeOldCache() {
    if (oldCacheRemoved) return;
    oldCacheRemoved = true;
    for (const name of ['catalog.zip', 'catalog-extracted', 'catalog-meta.json']) {
        try { fs.rmSync(path.join(CACHE_DIR, name), { recursive: true, force: true }); } catch { /* best effort */ }
    }
}

function validStats(s) {
    if (!s || typeof s !== 'object') return null;
    const d = Number(s.downloads), e = Number(s.endorsements);
    if (!Number.isFinite(d) || !Number.isFinite(e) || d < 0 || e < 0) return null;
    return { downloads: Math.floor(d), endorsements: Math.floor(e) };
}

// index.json's entries -> the app's catalog entries. An entry without a usable plugin_id is skipped (nothing could be matched or counted for it).
// A listing's link comes from a mod author: only a plain web address is kept, so a "javascript:" or "data:" link can never reach the page
// (security review 2026-10-06). Anything else becomes "no link".
function webUrlOrNull(u) {
    if (typeof u !== 'string') return null;
    const t = u.trim();
    if (!/^https?:\/\//i.test(t)) return null;
    try { return new URL(t).href && t; } catch { return null; }
}

function normalizeIndex(raw) {
    const out = [];
    for (const p of (raw && Array.isArray(raw.plugins) ? raw.plugins : [])) {
        if (!p || typeof p !== 'object') continue;
        const pluginId = typeof p.plugin_id === 'string' ? p.plugin_id.trim().toLowerCase() : '';
        if (!PLUGIN_ID_RE.test(pluginId)) continue;
        // The author's note for the version the catalog lists: the newest history entry, when it is that version.
        const newest = Array.isArray(p.history) ? p.history[0] : null;
        const changelog = newest && newest.version === p.version && typeof newest.changelog === 'string' && newest.changelog.trim() ? newest.changelog : null;
        out.push({ ...p, id: pluginId, plugin_id: pluginId, folder: typeof p.id === 'string' ? p.id : null, changelog, stats: validStats(p.stats), external_url: webUrlOrNull(p.external_url) });
    }
    return out;
}

function result(raw, meta, fromCache, extra = {}) {
    return { plugins: normalizeIndex(raw), fetchedAt: meta.fetchedAt, fromCache, generatedAt: raw.generated_at || null, statsAsOf: raw.stats_as_of || null, ...extra };
}

// Returns { plugins, fetchedAt, fromCache, generatedAt, statsAsOf, offline? }.
// Never reads the network more than once in 5 minutes, whoever asks (start-up, Check now, the automatic repeats): `force` is kept so
// callers did not have to change, but it cannot beat that limit. A 304 ("nothing changed") costs almost nothing. When the network is
// unreachable the last good copy is used (`offline: true`); with no copy at all the error is thrown, as before.
async function fetchCatalog({ force = false } = {}) { // eslint-disable-line no-unused-vars
    removeOldCache();
    const meta = readMeta() || {};
    const cached = readCachedIndex();
    if (cached && meta.fetchedAt && Date.now() - meta.fetchedAt < MIN_REFETCH_MS) return result(cached, meta, true);
    let answer;
    try {
        answer = await httpGet(catalogUrl(), cached ? meta : null);
    } catch (e) {
        let host = 'the catalog host';
        try { host = new URL(catalogUrl()).hostname; } catch { /* keep the plain words */ }
        require('./update-log').logRequestFailure(host, `${e && e.message ? e.message : 'no answer'}${cached ? ' (using the saved copy)' : ''}`);
        if (cached) return result(cached, meta, true, { offline: true });
        throw e;
    }
    const now = Date.now();
    if (answer.status === 304 && cached) {
        const next = { ...meta, fetchedAt: now };
        writeMeta(next);
        return result(cached, next, true);
    }
    let raw;
    try {
        raw = JSON.parse(answer.body || '');
        if (!raw || !Array.isArray(raw.plugins)) throw new Error('not a catalog');
    } catch {
        if (cached) return result(cached, meta, true, { offline: true });
        throw new Error("The Plugin Hub catalog came back in a shape ModPacer can't read.");
    }
    writeCachedIndex(answer.body);
    const next = { fetchedAt: now, etag: answer.etag, lastModified: answer.lastModified, generatedAt: raw.generated_at || null };
    writeMeta(next);
    return result(raw, next, false);
}

module.exports = { fetchCatalog, normalizeIndex, hubPageUrl, CACHE_DIR, INDEX_PATH, META_PATH, HUB_PLUGINS_BASE_URL, MIN_REFETCH_MS, PLUGIN_ID_RE };
