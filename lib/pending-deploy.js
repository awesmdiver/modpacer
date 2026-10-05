'use strict';
// Updated mods that Vortex hasn't deployed yet (queue: update-delete-old-and-deploy-ask, 2026-10-01). Updates no longer
// deploy by themselves: the page asks first, and a Cancel leaves the mods here so the player can deploy later from the page
// (it survives a restart of the updater). An entry written before 2026-10-05 also remembered the OLD mod's staging folder (`oldStagingPath`, removed after a deploy);
// the update now removes the old copy itself, through the Bridge, and new entries carry no folder. Stored in the data folder as pending-deploy.json; plain data, no secrets.

const fs = require('fs');
const path = require('path');
const { dataPath } = require('./data-dir');

// The run of ModPacer an entry belongs to. What the page OFFERS (the "Updated, not deployed yet" line, the Deploy button, the "Ready to deploy in
// Vortex?" banner) is only what this run did: an entry saved by an earlier run is kept for its clean-up (its plugins
// to keep off) but is never shown, counted or offered again. Tests set it to simulate a restart.
let runId = `${process.pid}-${Date.now()}`;
function setRunId(id) { runId = id; }

function file() { return dataPath('pending-deploy.json'); }

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

// { pluginId, title, newModId, wasEnabled, oldStagingPath } -- one entry per plugin (a newer update replaces an older one)
function add(entry) {
    const entries = list().filter((e) => e.pluginId !== entry.pluginId);
    entries.push({ ...entry, runId, updatedAt: new Date().toISOString() });
    save(entries);
}

// The entries the page may offer: made by this run, and with something to deploy.
function listThisRun() {
    return list().filter((e) => e.runId === runId && !e.noDeploy);
}

function remove(pluginIds) {
    const ids = new Set(pluginIds);
    save(list().filter((e) => !ids.has(e.pluginId)));
}

// Starting ModPacer forgets every entry: Vortex is the truth about what is installed and deployed.
function clear() { save([]); }

module.exports = { list, listThisRun, add, remove, clear, setRunId };
