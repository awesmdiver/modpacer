'use strict';
// 2026-10-05 (the director's screenshot: a raw "API rate limit exceeded" block under four rows): GitHub's unauthenticated budget is 60 calls an hour for a whole
// internet connection, so every call is now remembered on disk with its ETag (a repeat sends If-None-Match, and a 304 does not count against the budget), an answer
// younger than 6 hours is used without asking at all, the remaining budget is read from every answer (below 10 left, optional lookups such as release dates stop so the
// budget stays for the downloads a person clicks), and an error that reaches the page is one plain sentence (friendlyError), never GitHub's own JSON.
//
// Resolves a Hub catalog entry's `external_url` (a GitHub release tag page or a bare releases
// page) to a real release + its downloadable asset(s), via GitHub's own REST API -- no token, so
// every call below counts against GitHub's unauthenticated 60-requests-an-hour budget. That's a
// real, disclosed constraint: this app makes at most one or two of these calls per plugin that
// actually has an update, not per plugin checked (the catalog itself is fetched separately, via
// catalog.js's own codeload-zip approach, which doesn't touch this budget at all).

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const dataDir = require('./data-dir');
const semver = require('semver');
const { downloadToFile } = require('./download-file');

const ARCHIVE_EXT_RE = /\.(7z|zip|rar)$/i;

// ---- what GitHub told us about the budget, and what was already asked ----
const FRESH_MS = 6 * 60 * 60 * 1000; // an answer younger than this is used without asking
const RESERVE = 10; // below this many calls left, optional lookups stop
const NO_RESET_WAIT_MS = 15 * 60 * 1000; // a limit with no reset time: "a little while"
const limit = { remaining: null, resetAt: null }; // from x-ratelimit-remaining / x-ratelimit-reset of the latest answer

// Tests point this at a stand-in (http://127.0.0.1:port); the real one is https://api.github.com.
function apiBase() {
    const url = process.env.MODPACER_GITHUB_API_URL;
    if (!url) return { lib: https, hostname: 'api.github.com', port: undefined };
    const u = new URL(url);
    return { lib: u.protocol === 'http:' ? http : https, hostname: u.hostname, port: u.port || undefined };
}
function cachePath() { return dataDir.dataPath('cache', 'github-releases.json'); }
function readCache() { try { return JSON.parse(fs.readFileSync(cachePath(), 'utf8')) || {}; } catch { return {}; } }
function writeCache(cache) {
    try {
        fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
        fs.writeFileSync(cachePath(), JSON.stringify(cache), 'utf8');
    } catch { /* a cache that cannot be saved only costs calls */ }
}
function noteHeaders(headers) {
    const remaining = Number(headers['x-ratelimit-remaining']);
    const reset = Number(headers['x-ratelimit-reset']);
    if (Number.isFinite(remaining)) limit.remaining = remaining;
    if (Number.isFinite(reset) && reset > 0) limit.resetAt = reset * 1000;
}
// True while GitHub says nothing is left and the reset time has not come.
function limitedNow() { return limit.remaining === 0 && (!limit.resetAt || Date.now() < limit.resetAt); }
// Optional lookups (release dates) only run while enough of the budget is left for what a person clicks.
function optionalAllowed() { return !limitedNow() && (limit.remaining === null || limit.remaining >= RESERVE); }
function budget() { return { remaining: limit.remaining, resetAt: limit.resetAt }; }
function resetBudgetForTests() { limit.remaining = null; limit.resetAt = null; }

function githubError(message, props) { return Object.assign(new Error(message), { githubApi: true }, props); }
function rateLimitError(resetAt, detail) { return githubError(`GitHub API rate limit reached${detail ? ': ' + detail : ''}`, { statusCode: 403, rateLimited: true, resetAt: resetAt || null }); }

// The one plain sentence for a GitHub failure that reaches a row, a banner or a download (the full text only goes to the log).
function resetTimeText(resetAt) {
    try { return new Date(resetAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return null; }
}
function friendlyError(e) {
    if (e && e.rateLimited) {
        const t = e.resetAt ? resetTimeText(e.resetAt) : null;
        return t ? `GitHub is limiting requests from your internet connection. Try again after ${t}.` : 'GitHub is limiting requests from your internet connection. Try again in a little while.';
    }
    return "Couldn't reach GitHub. Check your internet and try again.";
}

function rawRequest(apiPath, etag) {
    return new Promise((resolve, reject) => {
        const base = apiBase();
        const headers = { 'User-Agent': 'modpacer', Accept: 'application/vnd.github+json' };
        if (etag) headers['If-None-Match'] = etag;
        const req = base.lib.request({ hostname: base.hostname, port: base.port, path: apiPath, method: 'GET', headers }, (res) => {
            const chunks = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', (e) => { require('./update-log').logRequestFailure(base.hostname, `no answer (${e && e.code ? e.code : 'network error'})`); reject(githubError(`GitHub API request failed: ${e.message}`)); });
        req.setTimeout(20000, () => req.destroy(new Error('timed out')));
        req.end();
    });
}

// One GitHub API call, through the on-disk memory. `optional`: a lookup nobody clicked for (a release date): it never spends the last of the budget, and when it
// cannot run it throws an error with `skipped` set (the caller shows nothing, no error line).
async function apiRequest(apiPath, { optional = false } = {}) {
    const cache = readCache();
    const hit = cache[apiPath];
    const now = Date.now();
    const answerOf = (h) => { if (h.status === 404) throw githubError('GitHub API request failed (HTTP 404): not found', { statusCode: 404 }); return h.body; };
    if (hit && now - hit.fetchedAt < FRESH_MS) return answerOf(hit); // young enough: no call at all
    if (optional && !optionalAllowed()) {
        if (hit) return answerOf(hit); // an older answer is better than none for something nobody clicked
        throw githubError('GitHub lookup skipped (budget reserved for downloads)', { skipped: true, rateLimited: limitedNow(), resetAt: limit.resetAt });
    }
    if (limitedNow()) {
        if (hit) return answerOf(hit);
        throw rateLimitError(limit.resetAt);
    }
    const r = await rawRequest(apiPath, hit && hit.etag);
    noteHeaders(r.headers);
    if (r.status === 304 && hit) { // unchanged: free, and the answer is fresh again
        cache[apiPath] = { ...hit, fetchedAt: now };
        writeCache(cache);
        return answerOf(hit);
    }
    if (r.status === 200) {
        let body;
        try { body = JSON.parse(r.text); } catch (e) { throw githubError(`GitHub API returned unparseable JSON: ${e.message}`); }
        cache[apiPath] = { etag: r.headers.etag || null, body, fetchedAt: now };
        writeCache(cache);
        return body;
    }
    if (r.status !== 404) require('./update-log').logRequestFailure(apiBase().hostname, `HTTP ${r.status}`); // a 404 is an ordinary "try the next spelling"
    if (r.status === 404) { // remembered too: a stale link's guessed tags are asked about once per six hours, not every start
        cache[apiPath] = { status: 404, fetchedAt: now };
        writeCache(cache);
    }
    const rateLimited = r.status === 429 || (r.status === 403 && (/rate limit/i.test(r.text) || r.headers['x-ratelimit-remaining'] === '0'));
    if (rateLimited) {
        if (!limit.resetAt && r.headers['retry-after']) limit.resetAt = now + Number(r.headers['retry-after']) * 1000;
        limit.remaining = 0;
        throw Object.assign(rateLimitError(limit.resetAt || now + NO_RESET_WAIT_MS, r.text.slice(0, 300)), { statusCode: r.status });
    }
    throw githubError(`GitHub API request failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`, { statusCode: r.status });
}

// Parses a GitHub URL into {owner, repo, tag} -- tag is null for a bare "/releases" page (means
// "use the latest release"). Returns null if the URL isn't recognizably GitHub-shaped.
function parseGitHubUrl(url) {
    const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/releases(?:\/tag\/([^/?#]+))?)?/.exec(url || '');
    if (!m) return null;
    return { owner: m[1], repo: m[2].replace(/\.git$/, ''), tag: m[3] ? decodeURIComponent(m[3]) : null };
}

async function resolveRelease(externalUrl, opts) {
    const parsed = parseGitHubUrl(externalUrl);
    if (!parsed) throw new Error(`Not a recognizable GitHub URL: ${externalUrl}`);
    const path = parsed.tag
        ? `/repos/${parsed.owner}/${parsed.repo}/releases/tags/${encodeURIComponent(parsed.tag)}`
        : `/repos/${parsed.owner}/${parsed.repo}/releases/latest`;
    return module.exports.apiRequest(path, opts);
}

// The version a release tag stands for ("v4.1.0", "4.1.0", "v3.9.14-beta25" -> 4.1.0 / 3.9.14), or null when the tag says
// no version at all. Compared with the Hub entry's own version to catch a link that points at a different release.
function versionOfTag(tag) {
    const v = semver.coerce(String(tag || ''));
    return v ? v.version : null;
}

// The release the row's version actually is (the Hub lists a version AND a link; the author can bump one and forget the
// other -- real case: version 4.1.0, link still .../releases/tag/v4.0.1). Resolves `externalUrl` as written, except when it
// is a pinned tag OLDER than `wantedVersion`: then it looks for the release of `wantedVersion` in the same repo (tags
// v<version>, <version>, then releases/latest only if that one IS the wanted version).
// Returns { release, linkVersion } -- `release` is null only when the link is stale AND no release of the wanted version
// exists (`linkVersion` is then the stale link's version). A bare releases page, a link that agrees, and a link whose
// version can't be read are all left exactly as before.
async function resolveReleaseForVersion(externalUrl, wantedVersion, opts) {
    const api = module.exports;
    const parsed = parseGitHubUrl(externalUrl);
    const wanted = versionOfTag(wantedVersion);
    const linkVersion = parsed && parsed.tag ? versionOfTag(parsed.tag) : null;
    if (!parsed || !parsed.tag || !wanted || !linkVersion || !semver.lt(linkVersion, wanted)) {
        return { release: await api.resolveRelease(externalUrl, opts), linkVersion };
    }
    const base = `/repos/${parsed.owner}/${parsed.repo}/releases`;
    const bare = String(wantedVersion).replace(/^v/i, '');
    for (const tag of [`v${bare}`, bare]) {
        try {
            const release = await api.apiRequest(`${base}/tags/${encodeURIComponent(tag)}`, opts);
            if (versionOfTag(release.tag_name || tag) === wanted) return { release, linkVersion };
        } catch (e) {
            if (e.statusCode !== 404) throw e; // not found just means: try the next spelling
        }
    }
    try {
        const latest = await api.apiRequest(`${base}/latest`, opts);
        if (versionOfTag(latest.tag_name) === wanted) return { release: latest, linkVersion };
    } catch (e) {
        if (e.statusCode !== 404) throw e;
    }
    return { release: null, linkVersion };
}

// Picks the "obvious mod archive" among a release's assets: the biggest .7z/.zip/.rar file.
// Biggest, not first, because a real release with multiple archives (main file + an "Optional -
// Textures" extra, say) tends to have the full package be the larger one -- not proven universal,
// just the best available heuristic; every OTHER archive-shaped asset is returned too
// (`otherCandidates`) so a caller can disclose them rather than silently drop them.
function pickModArchiveAsset(release) {
    const assets = (release && release.assets) || [];
    const archiveAssets = assets.filter((a) => ARCHIVE_EXT_RE.test(a.name));
    if (archiveAssets.length === 0) return { chosen: null, otherCandidates: [] };
    const sorted = [...archiveAssets].sort((a, b) => b.size - a.size);
    return { chosen: sorted[0], otherCandidates: sorted.slice(1) };
}

// Where a release file may come from (github.com itself, and the hosts GitHub redirects release files to).
const GITHUB_DOWNLOAD_HOSTS = ['github.com', '*.github.com', '*.githubusercontent.com'];

async function downloadAsset(asset, destPath, { onProgress } = {}) {
    return downloadToFile(asset.browser_download_url, destPath, {
        headers: { 'User-Agent': 'modpacer' },
        allowedHosts: GITHUB_DOWNLOAD_HOSTS,
        onProgress,
    });
}

module.exports = { parseGitHubUrl, versionOfTag, resolveRelease, resolveReleaseForVersion, pickModArchiveAsset, downloadAsset, apiRequest, friendlyError, optionalAllowed, budget, resetBudgetForTests, RESERVE, FRESH_MS };
