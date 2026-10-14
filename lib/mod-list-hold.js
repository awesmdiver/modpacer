'use strict';
// The full Vortex mod list, held in memory (queue: update-all-installs-every-new-mod-first..., 2026-10-13; director: "We only do a full mod-list read when the
// application starts up or Check now is clicked.").
//
// GET /mods is about 46 MB on a large install and Vortex answers one thing at a time, so every extra read made the removal and the rules wait. The ONLY places that
// ask Vortex for the whole list are ModPacer's start-up check and Check now (lib/vortex-update.js readFullModList, called from resolveVortexInfoBatch and
// modsForPairing). Everything else (an update's steps, the page's refreshes, the old-copy and old-download checks) uses the lightest read the Bridge has (one mod: GET
// /rules/:modId; lib/vct-removal.js probeMod) or the list held here: the result of the last full read, kept up to date with what ModPacer itself does to Vortex
// (a mod it created, a mod it removed, a rule it changed), never refreshed by itself. Nothing here talks to Vortex; plain data in memory, never saved.

let held = null; // { gameId, profileId, enabledModKeys, mods }, the Bridge's own answer, then edited in place
let heldAt = 0;
let maxAgeMs = Infinity; // the held list is good for the whole run. (Tests that change Vortex's world between two steps lower it, as if Check now had run in between.)
const reads = []; // [{ reason, at }]: every full read ModPacer made this run (what a test and the log look at)

function get() { return held; }
function set(data) { held = data; heldAt = Date.now(); }
function clear() { held = null; }
function isStale() { return !held || (maxAgeMs !== Infinity && Date.now() - heldAt >= maxAgeMs); }
function setMaxAge(ms) { maxAgeMs = ms; }
function recordRead(reason) { reads.push({ reason, at: Date.now() }); }
function readLog() { return reads.slice(); }
function resetReadLog() { reads.length = 0; }

function stable(v) {
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
    return JSON.stringify(v);
}
const same = (a, b) => stable(a) === stable(b);

// ModPacer created this mod record in Vortex (and switched it on, or not).
function noteCreated(modId, record, enabled) {
    if (!held) return;
    held.mods[modId] = JSON.parse(JSON.stringify(record));
    if (enabled && !held.enabledModKeys.includes(modId)) held.enabledModKeys.push(modId);
}
// This mod is gone from Vortex (its removal was looked at and Vortex no longer lists it).
function noteRemoved(modId) {
    if (!held) return;
    delete held.mods[modId];
    const i = held.enabledModKeys.indexOf(modId);
    if (i !== -1) held.enabledModKeys.splice(i, 1);
}
// These rule changes ({ modId, remove?, add? }) are confirmed in Vortex: the held list shows them too.
function noteRules(items) {
    if (!held) return;
    for (const it of items || []) {
        const mod = held.mods[it.modId];
        if (!mod) continue;
        const rules = Array.isArray(mod.rules) ? mod.rules.slice() : [];
        if (it.remove) { const i = rules.findIndex((r) => same(r, it.remove)); if (i !== -1) rules.splice(i, 1); }
        if (it.add && !rules.some((r) => same(r, it.add))) rules.push(JSON.parse(JSON.stringify(it.add)));
        mod.rules = rules;
    }
}

module.exports = { get, set, clear, isStale, setMaxAge, recordRead, readLog, resetReadLog, noteCreated, noteRemoved, noteRules };
