'use strict';
// The old copies an update could not finish removing (queue: a-mod-only-shows-updated-once-the-old-copy-is-fully-gone, 2026-10-05).
//
// An update is only finished when the old copy is GONE: its Vortex record, its archive and its staging folder. When Vortex is busy, a file is
// locked or the Bridge does not answer, the update installs the new version but leaves a short entry here, and the old copy is removed again
// later: by the row's Try again, and on its own the next time ModPacer starts or checks. The entry survives a restart and is never hidden
// because an earlier run saved it (unlike pending-deploy.json's "offer", which only shows what this run did). Plain data in the data folder
// (pending-old-copies.json), no secrets. Nothing here touches Vortex or the disk beyond its own file.
//
// An entry: { pluginId, title, oldModId, oldStagingPath, oldDownload: { archiveId, md5, fileName }, newModId, newFileName, deleteArchive, left: [...], savedAt }
// `left` says what was still there at the last try: 'mod' (Vortex still lists it), 'archive', 'folder', 'bridge' (nothing could be read).

const fs = require('fs');
const path = require('path');
const { dataPath } = require('./data-dir');

function file() { return dataPath('pending-old-copies.json'); }

function list() {
    try {
        const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function save(entries) {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(entries, null, 2), 'utf8');
}

// One entry per mod: a newer update of the same mod replaces the older entry.
function add(entry) {
    const entries = list().filter((e) => e.pluginId !== entry.pluginId);
    entries.push({ ...entry, savedAt: new Date().toISOString() });
    save(entries);
}

function update(pluginId, patch) {
    const entries = list().map((e) => (e.pluginId === pluginId ? { ...e, ...patch } : e));
    save(entries);
}

function get(pluginId) {
    return list().find((e) => e.pluginId === pluginId) || null;
}

function remove(pluginId) {
    const entries = list();
    const kept = entries.filter((e) => e.pluginId !== pluginId);
    if (kept.length !== entries.length) save(kept);
}

// Starting ModPacer forgets every entry: they live only for the run that made them.
function clear() { save([]); }

module.exports = { list, add, update, get, remove, clear };
