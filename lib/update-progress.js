'use strict';
// What an update is really doing right now, per mod: the engine and the swap call step() as each real step starts, and the page
// reads list() (it rides on /api/state) to show it. In memory only, nothing is estimated: a step is shown only once it begins.
// It never asks Vortex anything itself (2026-10-13: it used to ask for the deploy progress every 2 seconds for the whole update, which only gave a
// busy Vortex more to do). It also times each step for logs/update.log: a step line says how long the step before it took.

// The fine steps of an update. They go to logs/update.log, and the row shows the one it is on as a muted line under "Updating…" (director, 2026-10-28).
const STEP_KEYS = ['extracting', 'removing_old', 'installing', 'waiting_for_vortex', 'enabling_plugins', 'carrying_rules', 'deleting_old_download'];
const { logUpdate } = require('./update-log');

const entries = new Map(); // pluginId -> { step, waiting, blockedBy }
let now = () => Date.now(); // a test swaps in a clock
function setClock(fn) { now = fn; }

function blockedByFrom(progress) {
    const dialogs = (progress && progress.blockingDialogs) || [];
    if (dialogs.length > 0 && dialogs[0].title) return String(dialogs[0].title);
    if (progress && progress.externalChangesPending) return 'External Changes';
    return null;
}

// 70.84 -> "70.8 s"
function seconds(ms) { return `${(Math.round(ms / 100) / 10).toFixed(1)} s`; }

// An update for this mod has started (no step yet: the row says "Updating…").
function begin(id) {
    entries.set(id, { step: null, waiting: false, blockedBy: null, beganAt: now(), stepAt: now() });
}
// Makes sure a row has an entry WITHOUT wiping the step it is on (a wait for Vortex mid-update keeps its last real step).
function ensure(id) { if (!entries.has(id)) begin(id); }
function step(id, key) {
    const e = entries.get(id);
    if (!e || !STEP_KEYS.includes(key)) return;
    const took = e.step ? ` (${e.step} took ${seconds(now() - e.stepAt)})` : '';
    e.step = key; e.waiting = false; e.stepAt = now();
    logUpdate(`[${id}] step: ${key}${took}`);
}
// Vortex stopped answering mid-update: keep the last real step and say we are waiting, until the next attempt starts.
function markWaiting(id) {
    const e = entries.get(id);
    if (!e) return;
    e.waiting = true; e.blockedBy = null;
}
function end(id) {
    entries.delete(id);
}
// For the line that closes an update: how long the last step took and the whole update, e.g. " in 105.3 s (carrying_rules took 32.1 s)". '' when nothing is known.
function timing(id) {
    const e = entries.get(id);
    if (!e) return '';
    return ` in ${seconds(now() - e.beganAt)}${e.step ? ` (${e.step} took ${seconds(now() - e.stepAt)})` : ''}`;
}
// A new check starts fresh: a row left "waiting for Vortex" from an earlier attempt goes back to its normal state.
function clearWaiting() { for (const [id, e] of entries) if (e.waiting) entries.delete(id); }
function list() {
    const out = {};
    for (const [id, e] of entries) out[id] = { step: e.step, waiting: e.waiting, blockedBy: e.blockedBy };
    return out;
}
function reset() { entries.clear(); }

module.exports = { STEP_KEYS, begin, ensure, step, markWaiting, end, list, reset, clearWaiting, blockedByFrom, timing, seconds, setClock };
