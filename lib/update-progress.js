'use strict';
// What an update is really doing right now, per mod: the engine and the swap call step() as each real step starts, and the page
// reads list() (it rides on /api/state) to show it. In memory only, nothing is estimated: a step is shown only once it begins.
// While an update is running it also asks the Helper, every couple of seconds (one request at a time), whether Vortex is
// showing a dialog that blocks it, so the row can say so by name. Ported in spirit from Vortex Collection Tools' Apply screens.

// The fine steps of an update. They are for logs/update.log only: the row shows just "Updating…" (or "Installing…" for a mod new to Vortex)
// and then "Updated ✓", never the sub-steps (director, 2026-10-05).
const STEP_KEYS = ['extracting', 'removing_old', 'installing', 'waiting_for_vortex', 'enabling_plugins', 'carrying_rules', 'deleting_old_download'];
const { logUpdate } = require('./update-log');

const entries = new Map(); // pluginId -> { step, waiting, blockedBy }
let poller = null;
let pollerFn = null; // returns the Helper's progress object (or null); set by the engine so this file needs no Helper import

function setProgressReader(fn) { pollerFn = fn; }

function blockedByFrom(progress) {
    const dialogs = (progress && progress.blockingDialogs) || [];
    if (dialogs.length > 0 && dialogs[0].title) return String(dialogs[0].title);
    if (progress && progress.externalChangesPending) return 'External Changes';
    return null;
}

function anyRunning() {
    for (const e of entries.values()) if (!e.waiting) return true;
    return false;
}

function startPolling() {
    if (poller || !pollerFn) return;
    let busy = false;
    poller = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
            const progress = await pollerFn();
            const blockedBy = blockedByFrom(progress);
            for (const e of entries.values()) if (!e.waiting) e.blockedBy = blockedBy;
        } catch { /* best effort: no fresh signal this tick */ }
        busy = false;
    }, 2000);
    if (poller.unref) poller.unref();
}
function stopPollingIfIdle() {
    if (poller && !anyRunning()) { clearInterval(poller); poller = null; }
}

// An update for this mod has started (no step yet: the row says "Updating…").
function begin(id) {
    entries.set(id, { step: null, waiting: false, blockedBy: null });
    startPolling();
}
function step(id, key) {
    const e = entries.get(id);
    if (!e || !STEP_KEYS.includes(key)) return;
    e.step = key; e.waiting = false;
    logUpdate(`[${id}] step: ${key}`);
}
// Vortex stopped answering mid-update: keep the last real step and say we are waiting, until the next attempt starts.
function markWaiting(id) {
    const e = entries.get(id);
    if (!e) return;
    e.waiting = true; e.blockedBy = null;
    stopPollingIfIdle();
}
function end(id) {
    entries.delete(id);
    stopPollingIfIdle();
}
// A new check starts fresh: a row left "waiting for Vortex" from an earlier attempt goes back to its normal state.
function clearWaiting() { for (const [id, e] of entries) if (e.waiting) entries.delete(id); }
function list() {
    const out = {};
    for (const [id, e] of entries) out[id] = { step: e.step, waiting: e.waiting, blockedBy: e.blockedBy };
    return out;
}
function reset() { entries.clear(); if (poller) { clearInterval(poller); poller = null; } }

module.exports = { STEP_KEYS, begin, step, markWaiting, end, list, reset, clearWaiting, setProgressReader, blockedByFrom };
