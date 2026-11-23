'use strict';
// ModPacer 2.0, part 1: the saved list of mods the person asked ModPacer to follow with the + button. This PC only: one JSON file in ModPacer's own data folder,
// never in Vortex or the mod manager.
//
// The shape is made once for all the parts of 2.0, so the later ones (a folder, several sources and the pin, and one more kind of source) add values and never change it:
//   { version: 1, mods: [ {
//       id            'tracked.<repo>' (also the row id on the page; the repository name only, so it is never a path of anything else)
//       name          what the person calls it (display text only, never a path)
//       sources       a LIST, so a mod can have more than one place to look later: [{ id: 's1', type: 'github', url, owner, repo }]
//                     (a folder is type 'folder'; a later part adds one more type; a source carries its own `stopped` while its link is dead)
//       pin           the id of the source the person pinned, or null (null = the newest of the readable sources wins). Part 3 reads and sets it
//       kind          'mod' (default; older files) or 'application': a program that is only tracked (the person chose "It's not a mod"); ModPacer never installs it
//       choice        { sourceId, at } or null: the answer to "which one should it follow?" when two sources cannot be compared, asked once
//       installedNote what the person typed: { version, at } or null (used until the mod manager says which mod it is)
//       managerLink   { manager: 'vortex' | 'mo2', modId (Vortex) | folder (Mod Organizer 2), name, seenVersion } or null ("Not installed yet")
//       observation   the last read, per source: { <sourceId>: { version, tag, url, readAt, how } }
//       baseline      the version the person accepted with "I checked it" (a lower or renumbered version they have seen): { version, at } or null
//       state         'read' | 'confirm' | 'cannot' | null (null = nothing read yet), settled by lib/tracked-rows.js from the facts above, saved for the page
//       lastError     { code, text, at } or null (a short plain sentence, never GitHub's own text)
//       retry         { fails, nextAt } for the slow back-off
//       addedAt
//   } ] }
// Written atomically (a new file beside the old one, renamed over it); a damaged file is moved aside once and the list starts empty (the damaged copy is kept).
// Unknown fields are kept when a record is saved again, so a newer ModPacer's extra fields survive an older one.

const fs = require('fs');
const path = require('path');
const dataDir = require('./data-dir');

// 2 (ModPacer 2.0, part 3): a mod may have several sources, each with its own error and back-off, and a remembered choice. A version 1 file (parts 1 and 2) is read as a mod with
// one source: its error and back-off move onto that source (and stay on the mod as well, so an older ModPacer reading it again still finds them).
const CURRENT_VERSION = 2;
const FILE = 'tracked-mods.json';
const filePath = () => dataDir.dataPath(FILE);

function emptyFile() { return { version: CURRENT_VERSION, mods: [] }; }

// Brings any saved shape up to the current one. Version 0 / no version (a list written before the version field) becomes 1. A file from a NEWER ModPacer
// (version above ours) is read as far as it fits and kept as it is, never rewritten smaller. -> { file, newer: boolean }
function migrate(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { file: emptyFile(), newer: false };
    const v = Number(raw.version);
    if (Number.isFinite(v) && v > CURRENT_VERSION) return { file: raw, newer: true };
    const mods = (Array.isArray(raw.mods) ? raw.mods : []).filter((m) => m && typeof m === 'object' && typeof m.id === 'string' && m.id).map(normalizeMod);
    return { file: { ...raw, version: CURRENT_VERSION, mods }, newer: false };
}
function normalizeMod(m) {
    const sources = Array.isArray(m.sources) ? m.sources.filter((s) => s && typeof s === 'object' && typeof s.type === 'string') : [];
    sources.forEach((s, i) => { if (!s.id) s.id = `s${i + 1}`; });
    // version 1 saved the error and the back-off on the mod, for its one source
    if (sources[0]) {
        if (!Object.prototype.hasOwnProperty.call(sources[0], 'lastError')) sources[0].lastError = m.lastError && typeof m.lastError === 'object' ? m.lastError : null;
        if (!(sources[0].retry && typeof sources[0].retry === 'object')) sources[0].retry = m.retry && typeof m.retry === 'object' ? m.retry : { fails: 0, nextAt: 0 };
    }
    return {
        ...m,
        name: typeof m.name === 'string' ? m.name : m.id,
        sources,
        kind: m.kind === 'application' ? 'application' : 'mod', // 'application' (ModPacer 2.0): a program to be told about, never installed by ModPacer; 'mod' (the default, and what older files are)
        pin: typeof m.pin === 'string' && sources.some((s) => s.id === m.pin) ? m.pin : null, // the id of the one source the person pinned (part 3), or null
        choice: m.choice && typeof m.choice === 'object' && typeof m.choice.sourceId === 'string' ? m.choice : null, // which source to follow when two cannot be compared (asked once)
        installedNote: m.installedNote && typeof m.installedNote === 'object' && m.installedNote.version ? m.installedNote : null,
        managerLink: m.managerLink && typeof m.managerLink === 'object' && m.managerLink.manager ? m.managerLink : null,
        observation: m.observation && typeof m.observation === 'object' ? m.observation : {},
        baseline: m.baseline && typeof m.baseline === 'object' && m.baseline.version ? m.baseline : null,
        state: ['read', 'confirm', 'cannot'].includes(m.state) ? m.state : null,
        lastError: m.lastError && typeof m.lastError === 'object' ? m.lastError : null,
        retry: m.retry && typeof m.retry === 'object' ? m.retry : { fails: 0, nextAt: 0 },
        addedAt: m.addedAt || null,
    };
}

let newerOnDisk = false; // the file on disk is from a newer ModPacer: this one only reads it and never saves over it
let cache = null;
function load() {
    if (cache) return cache;
    let text = null;
    try { text = fs.readFileSync(filePath(), 'utf8'); } catch { /* none yet */ }
    if (text === null) { cache = emptyFile(); return cache; }
    let raw;
    try { raw = JSON.parse(text); } catch {
        // A damaged file: kept aside (never deleted) and the list starts empty, so the page still works and nothing is lost for good.
        try { fs.renameSync(filePath(), `${filePath()}.damaged-${Date.now()}`); } catch { /* best effort */ }
        try { require('./update-log').logArea('tracked', 'the saved list of tracked mods could not be read; it was set aside and the list starts empty'); } catch { /* the log is best effort */ }
        cache = emptyFile();
        return cache;
    }
    const r = migrate(raw);
    newerOnDisk = r.newer;
    cache = r.file;
    return cache;
}
function save() {
    if (newerOnDisk) return false; // never write a smaller copy over a newer ModPacer's file
    const file = filePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = [file, process.pid, 'tmp'].join('.'); // built as parts, so the strings list does not read it as screen text
    try {
        fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
        fs.renameSync(tmp, file);
    } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ } throw e; }
    return true;
}
// Tests (and a settings reset) read the file again from disk.
function reloadFromDisk() { cache = null; newerOnDisk = false; return load(); }

// The folder the person last saved an application's file into (only a hint for where the folder window starts; it is checked again before every use).
function getLastAppFolder() { const v = load().lastAppFolder; return typeof v === 'string' && v ? v : null; }
function setLastAppFolder(dir) { load().lastAppFolder = String(dir || ''); save(); }
function list() { return load().mods; }
function get(id) { return load().mods.find((m) => m.id === id) || null; }

// A row id from the repository name: 'tracked.<repo>' (lower-case, only [a-z0-9._-]); a second mod with the same repository name gets '-2', '-3'...
function newId(repo) {
    const base = `tracked.${String(repo || 'mod').toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^\.+/, '').slice(0, 60) || 'mod'}`;
    const taken = new Set(list().map((m) => m.id));
    if (!taken.has(base)) return base;
    for (let n = 2; n < 1000; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
    return `${base}-${Date.now()}`;
}
// A folder source: the same folder read with the same file-name pattern.
function findFolder(dir, pattern) {
    const norm = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));
    return list().find((m) => m.sources.some((s) => s.type === 'folder' && norm(s.path) === norm(dir) && String(s.pattern) === String(pattern))) || null;
}
function findBySource(type, url) { return list().find((m) => m.sources.some((s) => s.type === type && s.url && String(s.url).toLowerCase() === String(url).toLowerCase())) || null; }

// Adds a mod. `mod` carries name, source ({ type, url, owner, repo }), installedNote, managerLink, observation (the one read in step 2). -> the saved record
function add({ name, source, installedVersion = null, managerLink = null, observation = null, kind = 'mod', now = Date.now() }) {
    const id = newId(source.repo || name);
    const sid = 's1';
    const rec = normalizeMod({
        id, name, kind, sources: [{ id: sid, ...source }], pin: null,
        installedNote: installedVersion ? { version: installedVersion, at: new Date(now).toISOString() } : null,
        managerLink, observation: observation ? { [sid]: observation } : {}, baseline: null, state: null, lastError: null, retry: { fails: 0, nextAt: 0 },
        addedAt: new Date(now).toISOString(),
    });
    load().mods.push(rec);
    save();
    return rec;
}
// Changes a record in one step (the caller passes a function that edits it), then saves. -> the record or null
function update(id, fn) {
    const rec = get(id);
    if (!rec) return null;
    fn(rec);
    save();
    return rec;
}
function remove(id) {
    const f = load();
    const i = f.mods.findIndex((m) => m.id === id);
    if (i < 0) return false;
    f.mods.splice(i, 1);
    save();
    return true;
}

module.exports = { getLastAppFolder, setLastAppFolder, CURRENT_VERSION, FILE, filePath, migrate, load, save, reloadFromDisk, list, get, add, update, remove, newId, findBySource, findFolder, emptyFile };
