'use strict';
// Which installed mods have LEFT the Plugin Hub (hub-absent.json in ModPacer's own settings folder). Plain data, no secrets.
//
// A mod ModPacer once matched to a Hub entry (a match record, lib/match-records.js) whose entry is no longer in the catalog gets the row status
// "No longer on the Plugin Hub", but only when that is certainly true:
//   - the catalog was read successfully (not the saved copy used while offline), and it is plausible: a normal-size list, not far smaller than the last
//     good read (a half-empty answer must never label anything);
//   - the entry was absent in TWO consecutive such reads, so a one-off glitch never mislabels a mod;
//   - an entry that is in the catalog at all (an adult-flagged one, a hidden one) is never absent.
// A read that is not trusted changes nothing and keeps the previous state. When the entry returns, the mod goes back to normal at the next read.
//
// File shape: { version: 1, lastIds: ["author.slug", ...], lastFetchedAt: number|null, missing: { "<hub id>": { manifestId, count } } }
//   lastIds = every id in the last trusted read (the size baseline); missing = entries absent from the last trusted read(s), count capped at 2.
// A file that cannot be read or has another version number is treated as missing (the next trusted reads rebuild it). Nothing is ever deleted
// from Vortex or Mod Organizer 2 by this: it only labels.

const fs = require('fs');
const path = require('path');
const { dataPath } = require('./data-dir');

const FILE_VERSION = 1;
const NEEDED = 2;            // consecutive trusted reads an entry must be absent from
const MIN_PLAUSIBLE = 20;    // a catalog with fewer entries than this is not a normal list (the Hub has hundreds)
const MIN_KEEP_RATIO = 0.8;  // nor one with far fewer entries than the last good read
const lc = (s) => String(s || '').toLowerCase();

function file() { return dataPath('hub-absent.json'); }

function empty() { return { lastIds: [], lastFetchedAt: null, missing: {} }; }

function read() {
    try {
        const p = JSON.parse(fs.readFileSync(file(), 'utf8'));
        if (!p || p.version !== FILE_VERSION || !Array.isArray(p.lastIds) || !p.missing || typeof p.missing !== 'object' || Array.isArray(p.missing)) return empty();
        const missing = {};
        for (const [k, v] of Object.entries(p.missing)) {
            if (!v || typeof v.manifestId !== 'string' || !v.manifestId) continue;
            const count = Math.min(NEEDED, Math.max(1, Math.floor(Number(v.count)) || 1));
            missing[lc(k)] = { manifestId: lc(v.manifestId), count };
        }
        return { lastIds: p.lastIds.filter((x) => typeof x === 'string' && x).map(lc), lastFetchedAt: Number.isFinite(p.lastFetchedAt) ? p.lastFetchedAt : null, missing };
    } catch {
        return empty();
    }
}

// Atomic: a temp file in the same folder, then a rename, so a crash never leaves half a file. ModPacer is the only writer.
function write(rec) {
    const target = file();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, lastIds: [...rec.lastIds].sort(), lastFetchedAt: rec.lastFetchedAt, missing: rec.missing }, null, 2), 'utf8');
    fs.renameSync(tmp, target);
}

// Is this read one to trust? `ids` = every id the catalog lists; `lastCount` = how many the last trusted read had (0 = none yet).
function plausible(count, lastCount) {
    if (count < MIN_PLAUSIBLE) return false;
    return lastCount === 0 || count >= Math.ceil(lastCount * MIN_KEEP_RATIO);
}

// One check's turn. catalogIds: every id the catalog listed (all kinds: adult, hidden, bundles). fetchedAt: when the catalog was really read (null = unknown, always new).
// offline: the read failed and the saved copy was used. pairs: [{ hubId, manifestId }] from the match records (stale ones too).
// -> { trusted, gone: Set of installed manifest ids (lower case) that have left the Hub }
function applyRead({ catalogIds, fetchedAt = null, offline = false, pairs = [] }) {
    const rec = read();
    const standing = () => new Set(Object.values(rec.missing).filter((m) => m.count >= NEEDED).map((m) => m.manifestId));
    const ids = new Set((catalogIds || []).map(lc).filter(Boolean));
    if (offline || !plausible(ids.size, rec.lastIds.length)) return { trusted: false, gone: standing() };
    if (fetchedAt != null && fetchedAt === rec.lastFetchedAt) return { trusted: true, gone: standing() }; // the same read again (saved within 5 minutes): not a second read
    const before = JSON.stringify(rec.missing);
    const known = new Map(Object.entries(rec.missing).map(([hubId, m]) => [hubId, m.manifestId]));
    for (const p of pairs) if (p && p.hubId && p.manifestId) known.set(lc(p.hubId), lc(p.manifestId));
    const missing = {};
    for (const [hubId, manifestId] of known) {
        if (ids.has(hubId)) continue; // in the catalog: normal again
        const was = rec.missing[hubId];
        missing[hubId] = { manifestId, count: Math.min(NEEDED, (was ? was.count : 0) + 1) };
    }
    rec.missing = missing;
    const changed = before !== JSON.stringify(missing) || fetchedAt !== rec.lastFetchedAt || ids.size !== rec.lastIds.length;
    rec.lastIds = [...ids];
    rec.lastFetchedAt = fetchedAt;
    if (changed) write(rec);
    return { trusted: true, gone: standing() };
}

module.exports = { applyRead, read, file, NEEDED, MIN_PLAUSIBLE, MIN_KEEP_RATIO };
