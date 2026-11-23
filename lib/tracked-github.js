'use strict';
// ModPacer 2.0, part 1 (queue: "ModPacer 2.0, part 1: the + button, the Add a mod pop-up and GitHub tracking"): the GitHub half of "Add a mod".
//   * parseAddress: the strict reading of an address the person typed. Only https://github.com/<owner>/<repo> (a release or tag address is reduced to the
//     repository). Everything else is refused WITHOUT any request: no other host, no user name or password, no port, no encoded slashes, nothing after the repo
//     that is not a release page. Owner and repo are only the characters GitHub allows, so they can go into an API path and never into a file path.
//   * cleanText / cleanVersion: everything that is READ from GitHub (a name, a tag, a version) is cleaned before it is saved or shown: control characters out,
//     no slash, backslash or "..", capped. It is only ever shown as text and never used in a path.
//   * readLatest: the newest published release of the repository, through lib/github.js (its saved answers, ETags, rate-limit rules and the one honest
//     User-Agent). api.github.com is the only host ModPacer contacts for this. Never sends a Nexus key or any saved secret.

const github = require('./github');
const { compareVersions } = require('./version-compare');

const NAME_RE = /^[A-Za-z0-9._-]+$/;
// GitHub's own limits: an owner is up to 39 characters, a repository up to 100. "." and ".." are never a name.
function safeOwner(s) { return typeof s === 'string' && s.length >= 1 && s.length <= 39 && /^[A-Za-z0-9-]+$/.test(s) && !s.startsWith('-') && !s.endsWith('-'); }
function safeRepo(s) { return typeof s === 'string' && s.length >= 1 && s.length <= 100 && NAME_RE.test(s) && s !== '.' && s !== '..'; }

// -> { ok: true, owner, repo, url } | { ok: false, reason }
// A pasted release page (".../releases", ".../releases/tag/v1.2", ".../releases/latest", ".../releases/download/...") is reduced to the repository.
function parseAddress(input) {
    const raw = typeof input === 'string' ? input.trim() : '';
    const bad = (reason) => ({ ok: false, reason });
    if (!raw) return bad('empty');
    if (raw.length > 300) return bad('too_long');
    if (/[\u0000-\u001f\u007f\s\\]/.test(raw)) return bad('bad_characters'); // spaces, control characters and backslashes never belong in an address
    if (/%2f|%5c|%2e%2e|%00/i.test(raw)) return bad('encoded_path'); // an encoded slash, backslash or ".." is a trick
    let u;
    try { u = new URL(raw); } catch { return bad('not_an_address'); }
    if (u.protocol !== 'https:') return bad('not_https');
    if (u.hostname !== 'github.com') return bad('not_github');
    if (u.username || u.password) return bad('has_user_info');
    if (u.port) return bad('has_port');
    const parts = u.pathname.split('/').filter((p) => p !== ''); // a trailing slash is nothing
    if (parts.length < 2) return bad('no_repository');
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, '');
    if (!safeOwner(owner) || !safeRepo(repo)) return bad('bad_name');
    const rest = parts.slice(2);
    // After the repository only a release page may follow (a bare repository, /releases, /releases/latest, /releases/tag/<tag>, /releases/download/<tag>/<file>).
    if (rest.length > 0) {
        if (rest[0] !== 'releases') return bad('not_a_release_page');
        if (rest.length > 1 && !['latest', 'tag', 'download'].includes(rest[1])) return bad('not_a_release_page');
    }
    return { ok: true, owner, repo, url: `https://github.com/${owner}/${repo}` };
}

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
// Text shown on screen: control characters out, spaces folded, capped. Not for paths.
function cleanText(s, max = 80) {
    return String(s == null ? '' : s).replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
// Text READ from GitHub (a release name, a tag) must also hold no slash, backslash or "..": it is refused, not repaired, so nothing odd is saved.
function cleanFromGithub(s, max = 80) {
    const t = cleanText(s, max);
    if (!t || /[\\/]|\.\./.test(t)) return null;
    return t;
}
// A version read from a release tag: version characters only, 1 to 40 long, and something compareVersions can read as numbers. Else null.
function cleanVersion(tag) {
    const t = typeof tag === 'string' ? tag : '';
    if (!t || t.length > 80 || /[\u0000-\u001f\u007f\\/]|\.\./.test(t)) return null;
    const v = github.versionOfTag(t);
    if (!v || !/^[A-Za-z0-9.+_-]{1,40}$/.test(v)) return null;
    return v;
}
// A version the person typed: the same characters (a leading v is dropped), or null.
function cleanTypedVersion(s) {
    const t = String(s == null ? '' : s).trim().replace(/^v(?=\d)/i, '');
    if (!t) return null;
    if (!/^[A-Za-z0-9.+_-]{1,40}$/.test(t) || compareVersions(t, t) === 'unknown') return null;
    return t;
}

const MANUAL_MAX_AGE_MS = 60 * 1000;
// The newest published release. -> { ok: true, version, tag, name, url, publishedAt }
// | { ok: false, code, retry }  code: 'no_release' (the repository has none), 'gone' (404/410: the repository does not exist), 'rate_limited', 'network', 'unreadable'
// (a release with a tag that gives no version). `retry`: false for what only the person can fix.
async function readLatest(owner, repo, { manual = false, maxAgeMs = null } = {}) {
    if (!safeOwner(owner) || !safeRepo(repo)) return { ok: false, code: 'gone', retry: false };
    // A look nobody asked for right now (the slow background one) is an OPTIONAL lookup in lib/github.js: it never spends the last of GitHub's hourly budget, which stays for the
    // downloads a person clicks. Check now, adding a mod and Update the link are asked for, so they are not.
    const opts = { maxAgeMs: maxAgeMs || (manual ? MANUAL_MAX_AGE_MS : 3 * 60 * 60 * 1000), optional: !manual };
    let release;
    try {
        release = await github.apiRequest(`/repos/${owner}/${repo}/releases/latest`, opts);
    } catch (e) {
        if (e && (e.statusCode === 404 || e.statusCode === 410)) {
            // GitHub answers 404 both for "no release yet" and "no such repository": the repository itself tells them apart.
            try {
                await github.apiRequest(`/repos/${owner}/${repo}`, { ...opts });
                return { ok: false, code: 'no_release', retry: true };
            } catch (e2) {
                if (e2 && (e2.statusCode === 404 || e2.statusCode === 410)) return { ok: false, code: 'gone', retry: false };
                return failureOf(e2);
            }
        }
        return failureOf(e);
    }
    if (!release || typeof release !== 'object' || release.draft || release.prerelease) return { ok: false, code: 'no_release', retry: true };
    const version = cleanVersion(release.tag_name);
    if (!version) return { ok: false, code: 'unreadable', retry: true };
    const tag = cleanFromGithub(release.tag_name, 80);
    const given = typeof release.html_url === 'string' ? release.html_url : '';
    const url = /^https:\/\/github\.com\//i.test(given) && tag ? `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tag)}` : `https://github.com/${owner}/${repo}/releases`;
    return { ok: true, version, tag: tag || version, name: cleanFromGithub(release.name, 80), url, publishedAt: typeof release.published_at === 'string' ? cleanText(release.published_at, 40) : null, assets: cleanAssets(release.assets) };
}
// The files a release carries, as plain facts for the row: a clean name and a size (never the address: the download asks GitHub again for it). At most 30.
function cleanAssets(list) {
    const out = [];
    for (const a of Array.isArray(list) ? list : []) {
        const name = a && typeof a.name === 'string' ? cleanFromGithub(a.name, 150) : null;
        if (!name) continue;
        out.push({ name, size: Number.isFinite(Number(a.size)) && Number(a.size) >= 0 ? Number(a.size) : 0 });
        if (out.length >= 30) break;
    }
    return out;
}
// The newest release itself, with the files' addresses, for the person's own click on Download (an application). -> { ok: true, release } | { ok: false, code }
async function fetchLatestRelease(owner, repo) {
    if (!safeOwner(owner) || !safeRepo(repo)) return { ok: false, code: 'gone' };
    try {
        const release = await github.apiRequest(`/repos/${owner}/${repo}/releases/latest`, { maxAgeMs: MANUAL_MAX_AGE_MS });
        if (!release || typeof release !== 'object' || release.draft || release.prerelease) return { ok: false, code: 'no_release' };
        return { ok: true, release };
    } catch (e) {
        if (e && (e.statusCode === 404 || e.statusCode === 410)) return { ok: false, code: 'gone' };
        return failureOf(e);
    }
}
function failureOf(e) {
    if (e && (e.rateLimited || e.skipped)) return { ok: false, code: 'rate_limited', retry: true, resetAt: e.resetAt || null }; // limited, or the budget is being kept for downloads
    return { ok: false, code: 'network', retry: true };
}

module.exports = { fetchLatestRelease, cleanAssets, parseAddress, cleanText, cleanFromGithub, cleanVersion, cleanTypedVersion, readLatest, safeOwner, safeRepo, MANUAL_MAX_AGE_MS };
