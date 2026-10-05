'use strict';
// Remembers which plugin ids have a confirmed, complete download sitting on disk, surviving a
// restart/reload of the updater itself (queue: no-duplicate-downloads, 2026-10-01). Real reported
// bug: a plugin downloaded but not yet installed got DOWNLOADED AGAIN after a restart with
// automatic downloads on, because every check() rebuilds its own in-memory rows from scratch --
// with no memory at all of a download that already finished in a PREVIOUS run -- leaving a real
// "(1)" duplicate behind. This file is the fix for that specific gap: a small, separate JSON file
// (NOT config.json -- that's the player's own Settings, this is the app's own remembered state,
// same split app-config.js's own header comment draws) at `state.json`, already carved out in
// .gitignore for exactly this before this task ever wrote to it.
//
// Never trusted blindly on its own: plugin-updater-engine.js's own findExistingDownload always
// re-verifies a remembered record against the real file on disk (still exists, same size) before
// using it -- deleting the file by hand, or a mismatch, means a normal fresh download happens, no
// different from this file never having existed.

const fs = require('fs');
const path = require('path');

const STATE_FILE = require('./data-dir').dataPath('state.json');

function loadAll() {
    try {
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch {
        return {}; // missing or corrupt -- never a thrown error, same as a fresh install with nothing remembered yet
    }
}

function saveAll(all) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(all, null, 2), 'utf8');
}

// { fileName, filePath, size, version, releaseVersion, downloadedAt } | null
// `version` is the version the ROW promised; `releaseVersion` is the version of the release the file really came from. They can differ
// (a Hub link pointing at an older release than its listed version), which is why a remembered file is only trusted when they match.
function get(pluginId) {
    return loadAll()[pluginId] || null;
}

function record(pluginId, { fileName, filePath, size, version, releaseVersion }) {
    const all = loadAll();
    all[pluginId] = { fileName, filePath, size, version, releaseVersion, downloadedAt: new Date().toISOString() };
    saveAll(all);
}

function remove(pluginId) {
    const all = loadAll();
    if (!(pluginId in all)) return;
    delete all[pluginId];
    saveAll(all);
}

// When each mod was last updated / deployed (queue: remember-when-each-mod-was-updated, 2026-10-04). Kept in this same file under one
// reserved key, so it survives a restart like the downloads do and needs no new file. { [pluginId]: { updatedAt, deployedAt } }, ISO
// times. An old file without the key just has none. remove() above never touches it (it only deletes a plugin's own download entry).
const UPDATES_KEY = '__updates';

function updateTimes(pluginId) {
    const all = loadAll()[UPDATES_KEY];
    const entry = all && typeof all === 'object' ? all[pluginId] : null;
    return { updatedAt: (entry && entry.updatedAt) || null, deployedAt: (entry && entry.deployedAt) || null };
}

// field: 'updatedAt' | 'deployedAt'. Returns the time written.
function recordUpdateTime(pluginId, field) {
    const all = loadAll();
    const times = all[UPDATES_KEY] && typeof all[UPDATES_KEY] === 'object' ? all[UPDATES_KEY] : {};
    const when = new Date().toISOString();
    times[pluginId] = { ...(times[pluginId] || {}), [field]: when };
    all[UPDATES_KEY] = times;
    saveAll(all);
    return when;
}

// Old downloads still to be confirmed gone (queue: finish-by-checking-old-downloads-are-gone, 2026-10-04; see old-download-cleanup.js).
// Same file, one more reserved key, so it survives a restart. [{ pluginId, fileName, md5, archiveId, newFileName, oldModId, newModId, waitingOnRules, addedAt }]
const CLEANUP_KEY = '__pendingCleanup';

function pendingCleanup() {
    const list = loadAll()[CLEANUP_KEY];
    return Array.isArray(list) ? list : [];
}

// One entry per (plugin, old file name); adding again replaces it.
function addPendingCleanup(entry) {
    const all = loadAll();
    const list = (Array.isArray(all[CLEANUP_KEY]) ? all[CLEANUP_KEY] : []).filter((e) => !(e.pluginId === entry.pluginId && e.fileName === entry.fileName));
    list.push({ ...entry, addedAt: new Date().toISOString() });
    all[CLEANUP_KEY] = list;
    saveAll(all);
}

// fileName omitted = every entry of that plugin.
function removePendingCleanup(pluginId, fileName) {
    const all = loadAll();
    if (!Array.isArray(all[CLEANUP_KEY])) return;
    all[CLEANUP_KEY] = all[CLEANUP_KEY].filter((e) => !(e.pluginId === pluginId && (fileName === undefined || e.fileName === fileName)));
    saveAll(all);
}

// The mod's rules are now all confirmed, so its old download may go.
function releasePendingCleanup(pluginId) {
    const all = loadAll();
    if (!Array.isArray(all[CLEANUP_KEY])) return;
    all[CLEANUP_KEY] = all[CLEANUP_KEY].map((e) => (e.pluginId === pluginId ? { ...e, waitingOnRules: false } : e));
    saveAll(all);
}

// Starting ModPacer forgets the old-download clean-up list (the start-up path only reads; the person may have cleaned up in Vortex already).
function clearPendingCleanup() {
    const all = loadAll();
    if (!(CLEANUP_KEY in all)) return;
    delete all[CLEANUP_KEY];
    saveAll(all);
}

module.exports = { get, record, remove, updateTimes, recordUpdateTime, pendingCleanup, addPendingCleanup, removePendingCleanup, releasePendingCleanup, clearPendingCleanup, STATE_FILE };
