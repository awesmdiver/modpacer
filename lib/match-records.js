'use strict';
// The match record per mod: what ModPacer SAW when it tied one mod's four names together, so later checks use that instead of guessing again.
// The four: the Hub entry (id, title, link), the installed manifest (id, title, author, version), the archive (file name, MD5/size) and the Vortex
// mod (game, mod id, name, recorded version). Plain data in the data folder (match-records.json), no secrets.
//
// File shape: { version: 1, records: { "<hub plugin_id, lower case>": Record } }
// Record: { hubId, hub: {id, title, externalUrl}, manifest: {id, title, author, version}, archive: {fileNames: [], md5, size},
//           vortex: {gameId, modId, name, version}, manager: 'vortex'|'mo2', installedVersion, how: 'installed-by-modpacer'|'matched',
//           recordedAt, stale: false, staleAt }
// A missing part is null. A record is stale when its installed side is gone or its Hub entry vanished: it is ignored by matching and dropped after 30 days.
// A file that cannot be read or has another version number is treated as empty (matching works without it, and the next write replaces it).

const fs = require('fs');
const path = require('path');
const { dataPath } = require('./data-dir');

const FILE_VERSION = 1;
const STALE_DAYS = 30;
const lc = (s) => String(s || '').toLowerCase();

function file() { return dataPath('match-records.json'); }

function readAll() {
    try {
        const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
        if (!parsed || parsed.version !== FILE_VERSION || !parsed.records || typeof parsed.records !== 'object' || Array.isArray(parsed.records)) return {};
        return parsed.records;
    } catch {
        return {};
    }
}

// Atomic: a temp file in the same folder, then a rename, so a crash never leaves half a file. ModPacer is the only writer.
function writeAll(records) {
    const target = file();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, records }, null, 2), 'utf8');
    fs.renameSync(tmp, target);
}

const str = (v) => (v == null || v === '' ? null : String(v));
function clean(input) {
    const hub = input.hub || {}, man = input.manifest || {}, arc = input.archive || {}, vor = input.vortex || {};
    const hubId = str(hub.id || input.hubId);
    return {
        hubId,
        hub: { id: hubId, title: str(hub.title), externalUrl: str(hub.externalUrl) },
        manifest: { id: str(man.id), title: str(man.title), author: str(man.author), version: str(man.version) },
        archive: { fileNames: (Array.isArray(arc.fileNames) ? arc.fileNames : []).map(str).filter(Boolean), md5: str(arc.md5), size: Number.isFinite(arc.size) ? arc.size : null },
        vortex: { gameId: str(vor.gameId), modId: str(vor.modId), name: str(vor.name), version: str(vor.version) },
        manager: input.manager === 'mo2' ? 'mo2' : 'vortex',
        installedVersion: str(input.installedVersion),
        how: input.how === 'matched' ? 'matched' : 'installed-by-modpacer',
    };
}

// Writes (or replaces) the record for one Hub entry. Needs the Hub id and the installed manifest id, or nothing is written. `how: 'matched'` is only for a
// certain match (by id, or by exactly one unique title): never pass an ambiguous or guessed one. Returns the record, or null when nothing was written.
// A hand-installed 'matched' record never replaces an 'installed-by-modpacer' one for the same pair (that one saw more).
function write(input) {
    const rec = clean(input || {});
    if (!rec.hubId || !rec.manifest.id) return null;
    const key = lc(rec.hubId);
    const records = readAll();
    const old = records[key];
    if (old && !old.stale && rec.how === 'matched' && old.how === 'installed-by-modpacer' && lc(old.manifest && old.manifest.id) === lc(rec.manifest.id)) return old;
    // Keep what the old record knew about parts this write did not see (the archive and Vortex parts of an install, when a later match sees only the manifest).
    if (old && lc(old.manifest && old.manifest.id) === lc(rec.manifest.id)) {
        if (!rec.archive.fileNames.length && !rec.archive.md5 && old.archive) rec.archive = old.archive;
        if (!rec.vortex.modId && old.vortex) rec.vortex = old.vortex;
    }
    const out = { ...rec, recordedAt: new Date().toISOString(), stale: false, staleAt: null };
    records[key] = out;
    // One installed mod belongs to one Hub entry: a record of another Hub entry for the same installed id is the old, wrong pairing.
    for (const [k, r] of Object.entries(records)) if (k !== key && lc(r && r.manifest && r.manifest.id) === lc(rec.manifest.id)) delete records[k];
    writeAll(records);
    return out;
}

// Every record that matching may use: not stale.
function active() {
    return Object.values(readAll()).filter((r) => r && !r.stale && r.hubId && r.manifest && r.manifest.id);
}

function get(hubId) { return readAll()[lc(hubId)] || null; }

function sameRecordData(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// After a check: `installedIds` = the manifest ids that are installed now, `hubIds` = the Hub entries that exist now, `seen` = { [hubId lower]: { installedVersion, manifestVersion, vortex: {modId, name, version} } }
// for the records whose pair was used. Marks the ones whose side is gone stale (dated, ignored), brings a revived one back, updates the versions, and drops those
// stale for 30 days. Writes only when something changed. Returns { stale: [hubIds], dropped: [hubIds], updated: [hubIds] }.
function reconcile({ installedIds, hubIds, seen = {}, now = Date.now() }) {
    const records = readAll();
    const out = { stale: [], dropped: [], updated: [] };
    const have = new Set([...installedIds].map(lc)), hub = new Set([...hubIds].map(lc));
    for (const [key, r] of Object.entries({ ...records })) {
        if (!r || !r.manifest) { delete records[key]; continue; }
        const gone = !have.has(lc(r.manifest.id)) || !hub.has(key);
        if (gone) {
            if (!r.stale) { records[key] = { ...r, stale: true, staleAt: new Date(now).toISOString() }; out.stale.push(key); }
            else if (now - Date.parse(r.staleAt || 0) > STALE_DAYS * 86400000) { delete records[key]; out.dropped.push(key); }
            continue;
        }
        let next = r;
        if (r.stale) next = { ...r, stale: false, staleAt: null };
        const s = seen[key];
        if (s) {
            const v = { ...(next.vortex || {}) };
            if (s.vortex) { if (s.vortex.modId) v.modId = String(s.vortex.modId); if (s.vortex.name) v.name = s.vortex.name; if (s.vortex.version) v.version = s.vortex.version; }
            next = { ...next, installedVersion: str(s.installedVersion) || next.installedVersion, manifest: { ...next.manifest, version: str(s.manifestVersion) || next.manifest.version }, vortex: v };
        }
        if (!sameRecordData(next, r)) { records[key] = next; out.updated.push(key); }
    }
    if (out.stale.length || out.dropped.length || out.updated.length) writeAll(records);
    return out;
}

// The words for "how was this mod matched", for the log (matchedBy as the matcher sets it).
function whyText(matchedBy, hubId) {
    if (matchedBy === 'record') return `matched to the Hub entry ${hubId} by the record made when it was installed`;
    if (matchedBy === 'github') return `matched to the Hub entry ${hubId} by its GitHub link`;
    if (matchedBy === 'id') return `matched to the Hub entry ${hubId} by its id`;
    if (matchedBy === 'title') return `matched to the Hub entry ${hubId} by its name`;
    return null;
}

module.exports = { write, active, get, reconcile, whyText, readAll, FILE_VERSION, STALE_DAYS };
