'use strict';
// A tiny "a check is running" note in the data folder, written by the headless check (the one Vortex starts at launch) so a page that
// opens meanwhile can show "checking" instead of starting a second check on top of it (queue: check-repeats-by-itself-until-the-results-
// are-complete, 2026-10-04). Another process cannot share memory, so this is a file: { pid, at }. Stale (older than STALE_MS, or its
// process gone) counts as not running. Never throws.

const fs = require('fs');
const { dataPath } = require('./data-dir');

const STALE_MS = 6 * 60 * 1000; // a headless check never lasts longer than its own limit (about 3 minutes of repeats + the check)
const file = () => dataPath('check-running.json');

function acquire() {
    try { fs.mkdirSync(require('path').dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify({ pid: process.pid, at: Date.now() })); } catch { /* a courtesy only */ }
}
function release() {
    try {
        const cur = JSON.parse(fs.readFileSync(file(), 'utf8'));
        if (cur.pid === process.pid) fs.rmSync(file(), { force: true });
    } catch { /* nothing to release */ }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
// true when ANOTHER live process holds the note.
function heldByOther() {
    try {
        const cur = JSON.parse(fs.readFileSync(file(), 'utf8'));
        if (!cur || cur.pid === process.pid) return false;
        return Date.now() - cur.at < STALE_MS && alive(cur.pid);
    } catch { return false; }
}

module.exports = { acquire, release, heldByOther };
