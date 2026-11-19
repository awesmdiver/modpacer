'use strict';
// "Current GitHub version" (queue: show-current-github-version-on-a-plugin-row-when-github-is-newer-than-the-hub): the Plugin Hub often lags the author's
// GitHub. When the newest FULL release of the GitHub repo a Hub listing links to is really newer than BOTH the version the Hub lists and the version
// installed here, the row gets one link line to that release. Information only: nothing here installs, updates or downloads anything.
//
// Source: GitHub's `/repos/<owner>/<repo>/releases/latest`, which is by definition the newest published release that is neither a draft nor a
// pre-release (one call per plugin, through lib/github.js's own 6-hour answers and ETags; a 304 is free). Both flags are checked again here.
// Never guesses: a version that cannot be read as numbers, schemes that clearly differ (a date against a counter), a failed, skipped or limited lookup,
// or a link that is not a GitHub repo all give nothing, silently.

const github = require('./github');
const { compareVersions } = require('./version-compare');

const MAX_AGE_MS = 24 * 60 * 60 * 1000; // an answer this old may still be shown from memory when nothing can be asked

function latestPath(parsed) { return `/repos/${parsed.owner}/${parsed.repo}/releases/latest`; }

// The first number of a version, for telling a counter (4.2) from a date (2026.11.17).
function firstNumber(v) { const m = /\d+/.exec(String(v || '')); return m ? Number(m[0]) : NaN; }
function sameScheme(a, b) {
    const x = firstNumber(a), y = firstNumber(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    return (x >= 1000) === (y >= 1000);
}

// The Hub's own link for a row: the listing's `external_url` (a row's `externalUrl` may have been replaced by a Nexus link), parsed when it is a GitHub repo.
// Owner and repo go into the request address, so only GitHub's own name characters pass (letters, digits, . _ -; never "." or ".."; at most 100).
function safeName(n) { return typeof n === 'string' && n.length <= 100 && /^[A-Za-z0-9._-]+$/.test(n) && n !== '.' && n !== '..'; }
function repoOf(row) {
    let parsed;
    try { parsed = github.parseGitHubUrl(row.listingUrl || (row.urlKind === 'github' ? row.externalUrl : null)); } catch { return null; }
    if (!parsed || !safeName(parsed.owner) || !safeName(parsed.repo)) return null;
    return /^https?:\/\/github\.com\//i.test(row.listingUrl || row.externalUrl || '') ? parsed : null;
}

// Decides from a release answer: -> { version, url } or null.
function decide(row, release, parsed) {
    if (!release || typeof release !== 'object' || release.draft || release.prerelease) return null;
    const version = github.versionOfTag(release.tag_name);
    if (!version || !/^[A-Za-z0-9.+_-]{1,40}$/.test(version)) return null; // shown text: version characters only, never long
    const hub = row.latestVersion;
    if (!hub || compareVersions(hub, version) !== 'newer' || !sameScheme(hub, version)) return null;
    if (!row.notInstalled) { // installed here: GitHub must also be ahead of what is on this PC
        if (!row.installedVersion || row.installedVersionUnknown) return null;
        if (compareVersions(row.installedVersion, version) !== 'newer' || !sameScheme(row.installedVersion, version)) return null;
    }
    const given = typeof release.html_url === 'string' ? release.html_url : '';
    const url = /^https:\/\/github\.com\//i.test(given) ? given : `https://github.com/${parsed.owner}/${parsed.repo}/releases/tag/${encodeURIComponent(release.tag_name)}`;
    return { version, url };
}

// Cheap and offline: from what is already remembered (no call). -> { version, url } | null
function fromMemory(row) {
    const parsed = repoOf(row);
    if (!parsed) return null;
    return decide(row, github.peekCached(latestPath(parsed), MAX_AGE_MS), parsed);
}

// May ask GitHub (an optional lookup: never spends the last of the budget). -> { version, url } | null, and `asked` says whether a call could have been made.
async function lookup(row) {
    const parsed = repoOf(row);
    if (!parsed) return null;
    try {
        const release = await github.apiRequest(latestPath(parsed), { optional: true });
        return decide(row, release, parsed);
    } catch {
        return null; // a failed, skipped or limited lookup shows nothing and looks like today
    }
}

// Would looking this row up cost a GitHub call (a link to a GitHub repo, and nothing fresh remembered)?
function needsCall(row) {
    const parsed = repoOf(row);
    return !!parsed && !github.isFresh(latestPath(parsed));
}

module.exports = { needsCall, fromMemory, lookup, decide, repoOf, sameScheme };
