'use strict';
// "Current Nexus version" (queue: show-current-nexus-version-on-a-plugin-row-when-nexus-is-ahead-the-way-github-does, 2026-11-19): the Plugin Hub often lags the author's
// Nexus page. When the mod's current Nexus version is really newer than BOTH the version the Hub lists and the version installed here, the row gets one link line to
// the mod's Files tab. Information only: nothing here installs, updates or downloads anything.
//
// Which Nexus mod: (a) the Hub listing's own link when it is a skyrimspecialedition page on nexusmods.com, else (b) the Nexus mod id the mod manager recorded (Vortex's record
// through the Bridge, or Mod Organizer 2's meta.ini), else nothing. The version: Nexus's own mod record (`GET /v1/games/skyrimspecialedition/mods/<id>.json`, its `version`:
// the mod's version, the one Vortex shows) with the person's own saved key; no key, no line, no message. One call per mod per 6 hours (remembered on disk with its time,
// like lib/github.js), serialised, and only while Nexus's own rate-limit headers say there is plenty left. Any failure shows nothing.
// The link is built only from the mod id and the fixed host; the version is capped and limited to version characters.

const fs = require('fs');
const path = require('path');
const nexus = require('./nexus');
const { dataPath } = require('./data-dir');
const { compareVersions, isLoneInteger } = require('./version-compare');
const { sameScheme } = require('./github-current');

const GAME = 'skyrimspecialedition';
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // an answer this old is asked again
const GAP_MS = 250;                    // calls go one after another with a small gap: never a burst
const MIN_HOURLY = 20, MIN_DAILY = 200; // Nexus allows 100 an hour and 2,500 a day: stop well before the end
const FILE_VERSION = 1;
const VERSION_RE = /^[A-Za-z0-9.+_-]{1,40}$/;

function file() { return dataPath('nexus-current.json'); }
function readAll() {
    try {
        const p = JSON.parse(fs.readFileSync(file(), 'utf8'));
        return p && p.version === FILE_VERSION && p.entries && typeof p.entries === 'object' && !Array.isArray(p.entries) ? p.entries : {};
    } catch { return {}; }
}
function writeAll(entries) {
    const target = file();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, entries }, null, 2), 'utf8');
    fs.renameSync(tmp, target);
}
function remember(id, version) {
    const all = readAll();
    all[String(id)] = { version: version || null, at: Date.now() };
    writeAll(all);
}
function fresh(id, now = Date.now()) {
    const e = readAll()[String(id)];
    return e && typeof e.at === 'number' && now - e.at < MAX_AGE_MS ? { version: typeof e.version === 'string' ? e.version : null } : null;
}

// The Nexus mod id of a row: the Hub listing's own Nexus page first, then the id the mod manager recorded. Digits only; null when there is none.
function modIdOf(row) {
    if (!row) return null;
    const parsed = nexus.parseNexusUrl(row.listingUrl || '');
    if (parsed && parsed.gameDomain.toLowerCase() === GAME && Number.isInteger(parsed.modId) && parsed.modId > 0) return String(parsed.modId);
    const n = Number(row.nexusModId);
    return Number.isInteger(n) && n > 0 ? String(n) : null;
}
const linkOf = (id) => `https://www.nexusmods.com/${GAME}/mods/${id}?tab=files`;

// -> { version, url } when Nexus's version is newer than the Hub's and the installed one (a lone whole number against a dotted version cannot be compared: nothing).
function decide(row, id, version) {
    if (!id || typeof version !== 'string' || !VERSION_RE.test(version)) return null;
    const comparable = (a, b) => !!a && !!b && isLoneInteger(a) === isLoneInteger(b) && sameScheme(a, b);
    const hub = row.latestVersion;
    if (!comparable(hub, version) || compareVersions(hub, version) !== 'newer') return null;
    if (!row.notInstalled) {
        if (!row.installedVersion || row.installedVersionUnknown) return null;
        if (!comparable(row.installedVersion, version) || compareVersions(row.installedVersion, version) !== 'newer') return null;
    }
    return { version, url: linkOf(id) };
}

function fromMemory(row) {
    const id = modIdOf(row);
    const e = id ? fresh(id) : null;
    return e ? decide(row, id, e.version) : null;
}
// Would looking this row up cost a Nexus call (a Nexus mod id, and nothing fresh remembered)?
function needsCall(row) { const id = modIdOf(row); return !!id && !fresh(id); }
// Enough of Nexus's allowance left (its own headers from the last answer; unknown counts as enough).
function budgetOk() {
    const l = nexus.rateLimits();
    return !((l.hourly !== null && l.hourly < MIN_HOURLY) || (l.daily !== null && l.daily < MIN_DAILY));
}

let chain = Promise.resolve();
function queued(fn) {
    const run = chain.then(fn);
    chain = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, GAP_MS)));
    return run;
}

// May ask Nexus (one call, serialised). -> { version, url } | null. Never throws, never logs the key.
async function lookup(row, apiKey) {
    const id = modIdOf(row);
    if (!id || !apiKey) return null;
    const known = fresh(id);
    if (known) return decide(row, id, known.version);
    if (!budgetOk()) return null;
    try {
        const info = await queued(() => nexus.getModInfo(apiKey, GAME, id));
        const v = info && typeof info.version === 'string' ? info.version.trim() : '';
        const version = VERSION_RE.test(v) ? v : null;
        remember(id, version);
        return decide(row, id, version);
    } catch (e) {
        if (e && (e.statusCode === 403 || e.statusCode === 404)) remember(id, null); // "mod not available": not asked again for 6 hours
        return null;
    }
}

module.exports = { modIdOf, decide, fromMemory, needsCall, lookup, budgetOk, linkOf, file, MAX_AGE_MS };
