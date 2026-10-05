'use strict';
// A mod and its plugins are two separate switches in Vortex (queue: enable-the-mods-plugins-after-install-and-update, 2026-10-04).
// A person can have a mod ON and still have one of its plugins OFF (disabled, or ghosted: the plugin file hidden from the game by
// a ".ghost" ending). An update replaces the mod's files, which leaves Vortex's list of plugins asking "enable all?" -- this turns
// the right ones on by itself, and only the right ones:
//   - a plugin that was ON before the update stays on (turned on again if the swap dropped it)
//   - a plugin that is NEW to the mod (a fresh install: all of them) is turned on
//   - a plugin that was DISABLED or GHOSTED stays that way: never enabled, never un-ghosted
//   - a plugin Vortex had no state for (not in its list yet) is left alone: nobody can say it was on
//   - if the MOD itself was off, nothing is touched at all (the caller never calls in that case)
// Plugins that belong to other mods are never touched: only file names found inside THIS mod's own staging folder are used.
// Never throws, and nothing here may fail an install.

const fs = require('fs');
const path = require('path');
const helperClient = require('./vortex-helper-client');

const PLUGIN_RE = /\.(esp|esm|esl)(\.ghost)?$/i;
const GHOST_RE = /\.ghost$/i;

// The plugin file names inside a mod's staging folder (as they appear in plugins.txt: no ".ghost"). Plugins live at the root of
// the mod, or inside a top-level "Data" folder -- never deeper. Unique, original case kept.
function listPluginFiles(stagingDir) {
    const found = new Map(); // lowercase -> original
    const scan = (dir) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
        const subdirs = [];
        for (const e of entries) {
            if (e.isFile() && PLUGIN_RE.test(e.name)) {
                const name = e.name.replace(GHOST_RE, '');
                if (!found.has(name.toLowerCase())) found.set(name.toLowerCase(), name);
            } else if (e.isDirectory()) subdirs.push(e.name);
        }
        return subdirs;
    };
    if (!stagingDir) return [];
    const subdirs = scan(stagingDir);
    const data = subdirs.find((d) => d.toLowerCase() === 'data');
    if (data) scan(path.join(stagingDir, data));
    return [...found.values()];
}

// True when the game's Data folder holds this plugin under its ghost name (the file Vortex hid from the game).
function isGhostedOnDisk(dataFolder, name) {
    if (!dataFolder) return false;
    try { return fs.existsSync(path.join(dataFolder, `${name}.ghost`)); } catch { return false; }
}

// Reads each plugin's state from Vortex, separately from the mod's own state: 'on', 'off' (disabled), 'ghosted', or 'unknown'
// (Vortex has no entry, or did not answer). Run BEFORE the old mod is touched: Vortex drops a plugin from its list once its mod
// is gone.
async function readPluginStates(names, { dataFolder } = {}) {
    const states = {};
    for (const name of names) {
        let state = 'unknown';
        try {
            const live = await helperClient.getPluginLoadOrder(name);
            if (live && live.found === true) state = live.enabled ? 'on' : 'off';
        } catch { /* unknown */ }
        if (state !== 'on' && isGhostedOnDisk(dataFolder, name)) state = 'ghosted';
        states[name] = state;
    }
    return states;
}

// Pure. oldStates: { [pluginFileName]: state } from readPluginStates, or null for a mod with no old copy (a fresh install).
// Returns { enable: [names to turn on], heldOff: [names that must stay off], untouched: [names left alone] }.
function planPlugins({ newNames, oldStates, modWasEnabled }) {
    const plan = { enable: [], heldOff: [], untouched: [] };
    if (!modWasEnabled) { plan.untouched = newNames.slice(); return plan; } // a mod the person turned off: change nothing
    const old = new Map(Object.entries(oldStates || {}).map(([n, s]) => [n.toLowerCase(), s]));
    for (const name of newNames) {
        const before = old.get(name.toLowerCase());
        if (before === undefined || before === 'on') plan.enable.push(name); // new to the mod, or was on
        else if (before === 'off' || before === 'ghosted') plan.heldOff.push(name);
        else plan.untouched.push(name);
    }
    return plan;
}

// Turns the plugins on through the Helper. Returns { turnedOn: [names], failed: [names] }; never throws.
async function enablePlugins(names) {
    const out = { turnedOn: [], failed: [] };
    for (const name of names) {
        let ok = false;
        try { ok = await helperClient.setPluginEnabled(name, true); } catch { ok = false; }
        (ok ? out.turnedOn : out.failed).push(name);
    }
    return out;
}

// A plugin that must stay off is switched back off if Vortex shows it on (an update or a deploy can quietly bring a hidden plugin
// back). Returns the names that had to be put back.
async function keepOff(names) {
    const putBack = [];
    for (const name of names) {
        try {
            const live = await helperClient.getPluginLoadOrder(name);
            if (live && live.found === true && live.enabled === true && (await helperClient.setPluginEnabled(name, false)) === true) putBack.push(name);
        } catch { /* best effort */ }
    }
    return putBack;
}

module.exports = { listPluginFiles, readPluginStates, planPlugins, enablePlugins, keepOff, isGhostedOnDisk };
