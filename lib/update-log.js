'use strict';
// A plain, append-only record of what an update did and why a step was skipped (queue:
// update-delete-old-and-deploy-ask, 2026-10-01) -- logs/update.log in the app's data folder. Never shown in the
// player's window. Only this tool's own mods are ever named in it (plugin ids and the Vortex ids of those mods),
// never another mod or collection, and never any file contents. Best-effort: logging can never break an update.

const fs = require('fs');
const path = require('path');
const { dataPath } = require('./data-dir');

const MAX_BYTES = 1_000_000;

function logFile() {
    return dataPath('logs', 'update.log');
}

function logUpdate(line) {
    try {
        const file = logFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1'); } catch { /* no file yet */ }
        fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
    } catch { /* never worth failing an update over */ }
}

module.exports = { logUpdate, logFile };
