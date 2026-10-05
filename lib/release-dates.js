'use strict';
// Resolves each installed row's own release date -- a GitHub release's real `published_at`, or a
// Nexus file's own `uploaded_timestamp` when a key is configured (queue:
// plugin-rows-revision-3-dates-icons-legend, 2026-10-01). Cached alongside the catalog itself
// (`catalog.js`'s own CACHE_DIR) with the same TTL, so a date already resolved isn't re-fetched on
// every single check -- only once it's gone stale, or has simply never been resolved before.
//
// Deliberately NOT tied to check()'s own `force` flag the way the catalog refetch is: "Check now"
// clicked several times in an hour must never multiply into that many GitHub API calls per row --
// github.js's own header comment already discloses the real unauthenticated 60/hour budget, and
// this cache is what keeps a repeated Check now from ever touching it beyond the TTL's own cadence.
//
// Never guesses: a row whose date can't be resolved (no Nexus key, parse failure, rate-limited,
// network error) simply has no date -- cached as null, same TTL, tried again next cycle, never a
// stale or made-up value shown in its place.

const fs = require('fs');
const path = require('path');

const github = require('./github');
const nexus = require('./nexus');
const appConfig = require('./app-config');
const catalogLib = require('./catalog');

const CACHE_PATH = path.join(catalogLib.CACHE_DIR, 'release-dates.json');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // same cadence as the catalog's own cache

function readCache() {
    try {
        return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    } catch {
        return {};
    }
}

function writeCache(cache) {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

// A row has an update when the page would show it under Updates; only those get a date looked up (the rest keep whatever date was remembered).
const UPDATE_STATUSES = ['update_available', 'queued', 'downloading', 'downloaded', 'needs_you'];

// -> { date } or { transient: true } (GitHub's budget ran out or was kept in reserve: nothing cached, asked again later, no error line).
async function resolveOne(row, cfg) {
    try {
        if (row.urlKind === 'github') {
            // The release of the version the row shows (see github.resolveReleaseForVersion), never a stale link's older one.
            // An optional lookup: it never spends the last of GitHub's budget, and the same answer is remembered on disk for the download.
            const { release } = await github.resolveReleaseForVersion(row.externalUrl, row.latestVersion, { optional: true });
            return { date: (release && release.published_at) || null };
        }
        if (row.urlKind === 'nexus' && cfg.nexusApiKey) {
            const parsed = nexus.parseNexusUrl(row.externalUrl);
            if (!parsed) return null;
            const file = await nexus.resolveMainFile(cfg.nexusApiKey, parsed.gameDomain, parsed.modId);
            if (file && file.uploaded_timestamp) return { date: new Date(file.uploaded_timestamp * 1000).toISOString() };
        }
    } catch (e) {
        if (e && e.githubApi && (e.skipped || e.rateLimited)) return { transient: true };
        // Never guess -- no date for this row this cycle, cached as null below just like any
        // other "couldn't find one" outcome.
    }
    return { date: null };
}

// Returns { [pluginId]: isoDateString|null } for every row with an externalUrl. A row with no
// externalUrl at all (not_on_hub, or no catalog match) is skipped entirely -- nothing to resolve
// and nothing worth caching.
async function resolveReleaseDates(rows) {
    const cache = readCache();
    const cfg = appConfig.loadConfig();
    const now = Date.now();
    const out = {};

    const toResolve = rows.filter((row) => {
        if (!row.externalUrl) return false;
        const cached = cache[row.id];
        if (cached && (now - cached.fetchedAt) < CACHE_TTL_MS) {
            out[row.id] = cached.date;
            return false;
        }
        if (!UPDATE_STATUSES.includes(row.status)) { // no update: nothing is asked, whatever was remembered is shown
            if (cached) out[row.id] = cached.date;
            return false;
        }
        return true;
    });

    let changed = false;
    await Promise.all(toResolve.map(async (row) => {
        const r = await resolveOne(row, cfg);
        if (r.transient) { const old = cache[row.id]; if (old) out[row.id] = old.date; return; } // not cached: tried again once the budget is back
        cache[row.id] = { date: r.date, fetchedAt: now };
        out[row.id] = r.date;
        changed = true;
    }));

    if (changed) writeCache(cache);
    return out;
}

module.exports = { resolveReleaseDates, CACHE_PATH };
