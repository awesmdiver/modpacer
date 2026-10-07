'use strict';
// Finds SkyrimNet's own install folder (MO2-aware) and reads which plugins are installed,
// straight from SkyrimNet's own content-registry.json + each external plugin's own manifest.json.
// Real data confirmed against the director's own install (2026-09-30): 14 external plugins.

const fs = require('fs');
const path = require('path');
const mo2Instance = require('./mo2-instance');
const mo2Layers = require('./mo2-layers');
const { joinCI } = require('./ci-path');

// Ported from skyrimnet-multiproxy-dev's own proxy.py _resolve_skyrimnet_dir (2026-09-22 fix,
// same project, credited in TECHNICAL.md) -- same reasoning: a normal Vortex/manual install's
// SkyrimNet folder sits directly under <skyrimPath>/Data/SKSE/Plugins/SkyrimNet, but under Mod
// Organizer 2 that merge only exists inside the real game process (MO2's virtual filesystem
// hook) -- a separate program like this one only ever sees what's really, physically on disk,
// which for MO2 means SkyrimNet's own files land inside one mod's own mods/<name>/ folder (or,
// rarer, MO2's overwrite/ catch-all), never under the game folder's own Data/ at all.
//
// Widened 2026-10-06 (the first outside report: "Couldn't find Skyrimnet installed"): MO2 normally
// keeps a mod's files DIRECTLY under the mod folder (mods/<name>/SKSE/Plugins/SkyrimNet, no Data),
// some mods carry a Data folder, and a player may link the MO2 instance folder, its mods folder, a
// profile, a mod folder or a "Stock Game" folder instead of the game folder. Every shape is tried.
//
// A candidate is only accepted if it has a `config` subfolder (SkyrimNet.yaml lives there) -- never
// just "a folder happens to be named SkyrimNet". Order: the folder the player chose by hand, then the
// game folder's own Data, then MO2 mod folders (the one with SkyrimNet's content-registry.json first,
// then the most recently modified config/SkyrimNet.yaml), then overwrite/, then the mod folders in
// the "Mod Staging Folder" setting.
const REL_DATA = ['Data', 'SKSE', 'Plugins', 'SkyrimNet'];
const REL_FLAT = ['SKSE', 'Plugins', 'SkyrimNet'];

function isDir(p) {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// SkyrimNet's own folder has a config folder AND its registry or config\SkyrimNet.yaml. An add-on mod can ship a
// SKSE\Plugins\SkyrimNet folder with only its own config folder; that is not SkyrimNet (1.1.0 report, 2026-10-06).
function isValidSkyrimNetDir(candidate) {
    return isDir(joinCI(candidate, 'config')) && (hasRegistry(candidate) || yamlMtime(candidate) >= 0);
}

function classify(candidate) {
    if (isValidSkyrimNetDir(candidate)) return 'found';
    if (isDir(joinCI(candidate, 'config'))) return 'other-mod';
    return isDir(candidate) ? 'no-config' : 'missing';
}

function yamlMtime(candidate) {
    try {
        return fs.statSync(joinCI(candidate, 'config', 'SkyrimNet.yaml')).mtimeMs;
    } catch {
        return -1;
    }
}

function hasRegistry(candidate) {
    try { return fs.statSync(joinCI(candidate, 'content-registry.json')).isFile(); } catch { return false; }
}

function listDirs(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
        return [];
    }
}

// Several valid mod folders: the one holding SkyrimNet's registry first, then the newest SkyrimNet.yaml.
function pickBest(list) {
    return list.slice().sort((a, b) => (hasRegistry(b) - hasRegistry(a)) || (yamlMtime(b) - yamlMtime(a)))[0];
}

// The folder the player chose by hand: the SkyrimNet folder itself, or the folder holding it. { dir } when it is SkyrimNet's, else { dir: null, problem }.
function checkHandChosen(chosen) {
    if (classify(chosen) === 'found') return { dir: chosen };
    const inner = joinCI(chosen, 'SkyrimNet');
    if (classify(inner) === 'found') return { dir: inner };
    const why = { found: '', 'other-mod': 'it belongs to another mod', 'no-config': 'it has no config folder', missing: "it doesn't exist" };
    const s = classify(chosen);
    const si = classify(inner);
    return { dir: null, problem: { folder: chosen, why: why[s === 'missing' && si !== 'missing' ? si : s] } };
}

// Looks for SkyrimNet and records every place it looked. Returns { dir, given, checked }, where
// `checked` is [{ place, status }] and status is 'found' | 'no-config' (folder exists, no config
// inside) | 'missing'. A mods-style folder is ONE entry (it can hold hundreds of mods): place is
// "<mods>\*" and `modsScanned` says how many mod folders it had.
function findSkyrimNetFolder(skyrimPath, opts = {}) {
    const checked = [];
    const seen = new Set();
    const note = (place, status, extra) => {
        const key = path.normalize(place).toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        checked.push({ place, status, ...(extra || {}) });
    };
    let chosenProblem = null; // the folder chosen by hand failed the SkyrimNet test: { folder, why }
    // The instance folders around the Mods and Downloads folders the person gave (step 3c); the message names them.
    const instanceDirs = [];
    for (const f of [opts.modsFolder, opts.downloadFolder]) {
        if (!f) continue;
        const parent = path.dirname(path.normalize(f));
        if (parent === path.dirname(parent)) continue; // a drive root is not an instance
        if (!instanceDirs.some((d) => d.toLowerCase() === parent.toLowerCase()) && isDir(parent)) instanceDirs.push(parent);
    }
    const result = (dir) => ({ dir, given: skyrimPath || null, chosen: opts.skyrimNetFolder || null, chosenProblem, checked, instances: instanceDirs });

    function probe(candidate) {
        const status = classify(candidate);
        note(candidate, status);
        return status === 'found';
    }
    // A folder that holds mod folders (MO2's mods, Vortex's staging): the best valid SkyrimNet inside.
    function scanMods(modsDir) {
        if (opts.skipModScan) return null; // Mod Organizer 2's own mod list was read: it already said which mods count
        const names = listDirs(modsDir);
        const hits = [];
        const decoys = [];
        for (const name of names) {
            for (const rel of [REL_FLAT, REL_DATA]) {
                const c = joinCI(modsDir, name, ...rel);
                const s = classify(c);
                if (s === 'found') hits.push(c);
                else if (s === 'other-mod') decoys.push(c);
            }
        }
        note(joinCI(modsDir, '*'), hits.length ? 'found' : (decoys.length ? 'other-mod' : (isDir(modsDir) ? 'no-config' : 'missing')), { modsScanned: names.length, decoys });
        return hits.length ? pickBest(hits) : null;
    }

    // 1. The folder the player pointed at by hand (the SkyrimNet folder itself, or the folder holding it).
    const chosen = opts.skyrimNetFolder;
    if (chosen) {
        if (probe(chosen)) return result(chosen);
        const inner = joinCI(chosen, 'SkyrimNet');
        if (probe(inner)) return result(inner);
        chosenProblem = checkHandChosen(chosen).problem;
    }

    // 1b. Mod Organizer 2's own settings (ModOrganizer.ini, read only): the folders it names, from the MO2 folder the
    // player picked or from an MO2 folder given as the Skyrim or staging folder.
    function searchInstances() {
        const found = mo2Instance.instancesFor({ mo2Folder: opts.mo2Folder, skyrimInstallPath: skyrimPath, vortexStagingFolder: opts.modsFolder });
        const hits = [];
        for (const inst of found) {
            const hit = scanMods(inst.modsDir);
            if (hit) hits.push(hit);
        }
        if (hits.length) return pickBest(hits);
        for (const inst of found) {
            if (!isDir(inst.overwriteDir)) continue;
            for (const rel of [REL_FLAT, REL_DATA]) {
                const c = joinCI(inst.overwriteDir, ...rel);
                if (probe(c)) return c;
            }
        }
        return null;
    }

    // 3c (runs before concluding "missing"). The Mod Organizer 2 instance AROUND the Mods and Downloads folders the person gave
    // (2026-10-07, a "Nordic Souls" log): a modlist with a Stock Game keeps SkyrimNet's own files in the instance's overwrite folder
    // or in the Stock Game's Data folder, never in a mod folder or the Steam game folder. The folders next to mods\ and downloads\.
    function searchSettingsInstances() {
        const hits = [];
        const look = (c) => {
            const status = classify(c);
            note(c, status);
            if (status === 'found') hits.push(c);
        };
        for (const inst of instanceDirs) {
            const ow = joinCI(inst, 'overwrite');
            if (isDir(ow)) for (const rel of [REL_FLAT, REL_DATA]) look(joinCI(ow, ...rel));
            for (const name of listDirs(inst)) {
                if (['mods', 'overwrite', 'profiles', 'downloads', 'data'].includes(name.toLowerCase())) continue;
                if (isDir(joinCI(inst, name, 'Data'))) look(joinCI(inst, name, ...REL_DATA));
            }
        }
        return hits.length ? pickBest(hits) : null;
    }

    if (!skyrimPath) return result(searchInstances() || searchSettingsInstances());
    const base = path.normalize(skyrimPath);
    const p1 = path.dirname(base);
    const p2 = path.dirname(p1);

    // 2. The folder that was given: a game folder (Data\...), or a Data folder / mod folder / Stock Game itself (SKSE\...).
    for (const rel of [REL_DATA, REL_FLAT]) {
        const c = joinCI(base, ...rel);
        if (probe(c)) return result(c);
    }

    const fromIni = searchInstances();
    if (fromIni) return result(fromIni);

    // 3. Mod Organizer 2 without its settings file. The instance folder is the folder given, or one or two levels up (a Stock Game, a mods
    // folder or a mod folder, a profile). The folder given may also be the mods folder itself.
    const instances = [base, p1, p2];
    const modHits = [];
    const mods = [];
    if (path.basename(base).toLowerCase() === 'mods') mods.push(base);
    for (const inst of instances) {
        const m = joinCI(inst, 'mods');
        if (isDir(m) && !mods.includes(m)) mods.push(m);
    }
    for (const m of mods) { const hit = scanMods(m); if (hit) modHits.push(hit); }
    if (modHits.length) return result(pickBest(modHits));

    const overwrites = instances.map((inst) => joinCI(inst, 'overwrite'));
    for (const ow of overwrites) {
        if (!isDir(ow)) continue; // MO2 always has one in an instance; a folder that is not there is not worth listing
        for (const rel of [REL_FLAT, REL_DATA]) {
            const c = joinCI(ow, ...rel);
            if (probe(c)) return result(c);
        }
    }

    // 3b. A "Stock Game" (or similar) copy of the game inside the instance folder given.
    for (const name of listDirs(base)) {
        if (['mods', 'overwrite', 'profiles', 'downloads', 'data'].includes(name.toLowerCase())) continue;
        if (!isDir(joinCI(base, name, 'Data'))) continue;
        const c = joinCI(base, name, ...REL_DATA);
        if (probe(c)) return result(c);
    }

    // 4. The "Mod Staging Folder" setting (MO2's mods folder, or Vortex's staging folder).
    if (opts.modsFolder && isDir(opts.modsFolder)) {
        const hit = scanMods(path.normalize(opts.modsFolder));
        if (hit) return result(hit);
    }

    const around = searchSettingsInstances();
    if (around) return result(around);

    return result(null);
}

// ---- The live copy (Mod Organizer 2's Overwrite) ----------------------------------------------------------------------------
// In Mod Organizer 2 a file that is in a mod folder AND in Overwrite is served from Overwrite (highest priority), and SkyrimNet, running
// under it, writes content-registry.json and config\SkyrimNet.yaml into Overwrite: the mod folder keeps only the install-time copy. So the
// Overwrite copy is the live one and is read first (2026-10-07: "mods I installed show as not installed").
const sameP = (a, b) => !!a && !!b && path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
const isInside = (child, parent) => {
    const c = path.normalize(child).toLowerCase();
    const p = path.normalize(parent).toLowerCase().replace(/[\\/]+$/, '');
    return c === p || c.startsWith(p + path.sep);
};

// The Overwrite and mods folders that belong with a SkyrimNet folder. A folder the person chose by hand only gets the ones above it on its own
// path (the same instance, the same relative path); otherwise also the ones Mod Organizer 2's settings, the Mods / Downloads folders and the
// Skyrim folder point at.
function contextDirs(foundDir, skyrimPath, opts, byHand) {
    const overwrites = [];
    const mods = [];
    const addOw = (p) => { if (p && isDir(p) && !overwrites.some((o) => sameP(o, p))) overwrites.push(p); };
    const addMods = (p) => { if (p && isDir(p) && !mods.some((o) => sameP(o, p))) mods.push(p); };
    let a = path.dirname(path.normalize(foundDir));
    for (let i = 0; i < 6; i++) {
        addOw(joinCI(a, 'overwrite'));
        if (path.basename(a).toLowerCase() === 'mods') addMods(a);
        const up = path.dirname(a);
        if (up === a) break;
        a = up;
    }
    if (!byHand) {
        try {
            for (const inst of mo2Instance.instancesFor({ mo2Folder: opts.mo2Folder, skyrimInstallPath: skyrimPath, vortexStagingFolder: opts.modsFolder })) { addOw(inst.overwriteDir); addMods(inst.modsDir); }
        } catch { /* settings file unreadable: the other sources still count */ }
        for (const f of [opts.modsFolder, opts.downloadFolder]) {
            if (!f) continue;
            const parent = path.dirname(path.normalize(f));
            if (parent !== path.dirname(parent)) addOw(joinCI(parent, 'overwrite'));
        }
        if (opts.modsFolder) addMods(path.normalize(opts.modsFolder));
        if (skyrimPath) {
            const base = path.normalize(skyrimPath);
            for (const inst of [base, path.dirname(base), path.dirname(path.dirname(base))]) addOw(joinCI(inst, 'overwrite'));
        }
    }
    for (const ow of overwrites.slice()) addMods(joinCI(path.dirname(ow), 'mods'));
    return { overwrites, mods };
}

// findSkyrimNetFolder + the live copy: `liveDir` is the SkyrimNet folder inside Overwrite whose files the game really reads (null when there
// is none), `modCopyDir` the mod folder's own (older) copy it replaces, `modsDirs` the mods folders around.
function findWithLive(skyrimPath, opts = {}) {
    const r = findSkyrimNetFolder(skyrimPath, opts);
    r.liveDir = null; r.modCopyDir = null; r.modsDirs = []; r.overwriteDirs = [];
    if (!r.dir) return r;
    const chosen = opts.skyrimNetFolder;
    const byHand = !!chosen && (sameP(r.dir, chosen) || sameP(r.dir, joinCI(chosen, 'SkyrimNet')));
    const ctx = contextDirs(r.dir, skyrimPath, opts, byHand);
    r.modsDirs = ctx.mods;
    r.overwriteDirs = ctx.overwrites;
    if (ctx.overwrites.some((ow) => isInside(r.dir, ow))) { r.liveDir = r.dir; return r; } // already the live one
    const live = [];
    for (const ow of ctx.overwrites) {
        for (const rel of [REL_FLAT, REL_DATA]) {
            const c = joinCI(ow, ...rel);
            if (!sameP(c, r.dir) && classify(c) === 'found') live.push(c);
        }
    }
    const best = live.find((c) => hasRegistry(c)) || live[0] || null;
    if (best) { r.liveDir = best; r.modCopyDir = r.dir; }
    return r;
}

// ---- Mod Organizer 2's own mod order and on/off switches (lib/mo2-layers.js) -----------------------------------------------------
// With the active profile's modlist.txt in hand, the copies of SkyrimNet's files are the ones Mod Organizer 2 would serve: Overwrite first,
// then the enabled mods from the highest priority down; a switched-off mod never counts. A folder chosen by hand still wins, and with no
// readable mod list everything below is skipped and the folder search above is what runs (as before).
function instanceFor(skyrimPath, opts) {
    try { return mo2Instance.instancesFor({ mo2Folder: opts.mo2Folder, skyrimInstallPath: skyrimPath, vortexStagingFolder: opts.modsFolder })[0] || null; } catch { return null; }
}

// Every SkyrimNet folder the mod list leads to, in serving order: { dir, mod, priority, state }.
function layerCopies(L) {
    const copies = [];
    for (const d of L.overwriteDirs) copies.push({ dir: d, mod: 'Overwrite', priority: null, state: classify(d) });
    for (const h of L.hits) for (const d of h.dirs) copies.push({ dir: d, mod: h.name, priority: h.priority, state: classify(d) });
    return copies;
}

function fromLayers(skyrimPath, opts, hand, L, copies) {
    const valid = copies.filter((c) => c.state === 'found');
    const decoys = copies.filter((c) => c.state === 'other-mod').map((c) => c.dir);
    const withYaml = valid.find((c) => yamlMtime(c.dir) >= 0);
    const withReg = valid.find((c) => hasRegistry(c.dir));
    const ow = valid.find((c) => c.mod === 'Overwrite');
    const checked = [];
    for (const c of copies.filter((x) => x.mod === 'Overwrite')) checked.push({ place: c.dir, status: c.state });
    checked.push({ place: joinCI(L.modsDir, '*'), status: valid.some((c) => c.mod !== 'Overwrite') ? 'found' : (decoys.length ? 'other-mod' : 'no-config'), modsScanned: L.modsChecked, decoys });
    for (const c of valid.filter((x) => x.mod !== 'Overwrite')) checked.push({ place: c.dir, status: 'found' });
    return {
        dir: (withYaml || withReg || valid[0]).dir, given: skyrimPath || null, chosen: opts.skyrimNetFolder || null, chosenProblem: hand ? hand.problem || null : null,
        checked, instances: [], liveDir: ow ? ow.dir : null, modCopyDir: null, modsDirs: [],
        copies, validCopies: valid, layers: L,
    };
}

function findSkyrimNet(skyrimPath, opts = {}) {
    const chosen = opts.skyrimNetFolder;
    const hand = chosen ? checkHandChosen(chosen) : null;
    let inner = opts;
    let layered = null; // { inst, L } when the mod list was read but led to no SkyrimNet
    let listNote = null;
    if (!(hand && hand.dir)) {
        const inst = instanceFor(skyrimPath, opts);
        if (inst) {
            const L = mo2Layers.resolveLayers(inst, { fresh: opts.fresh });
            if (!L.ok) listNote = `mod list: not read (${L.reason}); used the folder search`;
            else {
                const copies = layerCopies(L);
                if (copies.some((c) => c.state === 'found')) { const r = fromLayers(skyrimPath, opts, hand, L, copies); return r; }
                inner = { ...opts, skipModScan: true };
                layered = { inst, L };
            }
        }
    }
    const r = findWithLive(skyrimPath, inner);
    if (listNote) r.listNote = listNote;
    if (layered) {
        r.modsDirs = []; // the mod list is the index: no walking of every mod folder
        r.layers = layered.L;
        if (!r.dir) r.disabledHolders = mo2Layers.disabledHolders(layered.inst);
    }
    return r;
}

function resolveSkyrimNetDir(skyrimPath, opts) {
    return findSkyrimNet(skyrimPath, opts).dir;
}

// What the page shows when nothing was found: plain words, folder names only.
const NOT_FOUND_MESSAGE = "ModPacer couldn't find SkyrimNet.";

function describeSearch(search) {
    const lines = (search.checked || []).map((c) => {
        if (c.status === 'missing') return `${c.place} (not there)`;
        if (c.status === 'other-mod') return `${c.place} (another mod's folder, not SkyrimNet itself)`;
        if (c.status === 'no-config') return c.modsScanned != null ? `${c.place} (no SkyrimNet with a config folder)` : `${c.place} (no config folder inside)`;
        return c.place;
    });
    return { given: search.given, chosen: search.chosen, chosenProblem: search.chosenProblem || null, places: lines, instances: search.instances || [], switchedOff: search.disabledHolders || [] };
}

// One line for the log: what was found or chosen, why it was accepted or rejected, the real list of places
// checked, and the folders the player gave. Names of folders only.
function summarizeSearch(search, note) {
    const places = (search.checked || []).map((c) => `${c.place} -> ${c.status}${c.decoys && c.decoys.length ? ` (another mod's: ${c.decoys.join(', ')})` : ''}`);
    const chosen = search.chosen ? `chosen by hand: ${search.chosen}${search.chosenProblem ? ` (rejected: ${search.chosenProblem.why})` : ''}` : 'chosen by hand: (none)';
    return `SkyrimNet ${search.dir ? `folder used: ${search.dir}` : 'not found'}${note ? ` (${note})` : ''}; Skyrim folder given: ${search.given || '(none)'}; ${chosen}; checked: ${places.length ? places.join(' | ') : '(nowhere)'}`;
}

// Names of folders only, never file contents -- one line per place, so a player can send the log.
function logSearch(log, search) {
    if (typeof log !== 'function') return;
    log(`SkyrimNet not found. Skyrim folder given: ${search.given || '(none)'}; SkyrimNet folder chosen by hand: ${search.chosen || '(none)'}`);
    for (const c of search.checked || []) {
        log(`  checked ${c.place} -> ${c.status}${c.modsScanned != null ? ` (${c.modsScanned} mod folders)` : ''}${c.decoys && c.decoys.length ? ` (another mod's: ${c.decoys.join(', ')})` : ''}`);
    }
    log(`  Mod Organizer 2 instance folder(s) also looked in (around the Mods and Downloads folders): ${(search.instances || []).join(', ') || '(none)'}`);
    if (search.listNote) log(`  ${search.listNote}`);
    if (search.layers) log(`  mod list: profile '${search.layers.profile}', ${search.layers.modsChecked} enabled mods checked in ${search.layers.ms} ms; none of them has SkyrimNet's files`);
    if (search.disabledHolders && search.disabledHolders.length) log(`  SkyrimNet's files are in mod(s) switched off in that profile, so they do not count: ${search.disabledHolders.join(', ')}`);
}

function readRegistryFile(dir) {
    const file = joinCI(dir, 'content-registry.json');
    let registry;
    try {
        registry = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return { dir, file, error: e.message, externals: [] };
    }
    const entries = registry && registry.plugins && typeof registry.plugins === 'object' ? registry.plugins : {};
    const externals = [];
    for (const [id, entry] of Object.entries(entries)) if (entry && entry.source === 'external') externals.push({ id, source: entry.source });
    return { dir, file, error: null, externals, allIds: new Set(Object.keys(entries).map((k) => k.toLowerCase())) };
}

// ---- Where each add-on's files are (2026-10-07) -----------------------------------------------------------------------------
// An add-on is INSTALLED when any one of these is true (the order they are tried and logged in):
//   registry  SkyrimNet's live registry (content-registry.json) lists it;
//   overwrite its manifest (external\<id>\manifest.json) is in Mod Organizer 2's Overwrite folder;
//   mod       its manifest is in an ENABLED mod folder (any mod, an "output mod" included, not only the original);
//   folder    an enabled mod (or Overwrite) has SKSE\Plugins\<its own folder>, named like the Hub listing (some add-ons install beside SkyrimNet);
//   name      an enabled mod's folder name is the listing's name.
// The Hub listings carry NO folder information (id, plugin_id, title, mods, external_url ...), so `folder` and `name` use the listing's title and
// the part of plugin_id after the dot, nothing else. "Enabled" is the active profile's modlist.txt; with no readable profile every mod counts.
// Overwrite is not "temporary": SkyrimNet and many mods put their data there on purpose. So an add-on that is only there is simply labelled.

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// A mod folder name without a trailing version ("Name-1.2.3", "Name v1.2", "Name 1.2"), for comparing with a listing's name.
const bareModName = (s) => String(s || '').replace(/[\s_-]*(?:v|ver|version)?[\s_-]*\d+(?:[._-]\d+)*[a-z]?\s*$/i, '');

// The enabled mods of the active profile: { set (lower case), profileDir } or null when no profile can be read.
function statFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

// One cheap look per mod folder (no tree walk): the add-on folders under SKSE\Plugins\SkyrimNet\external and the folder names under SKSE\Plugins.
//   -> { externals: Map(lower id -> [{ path, mod, modsDir }]), disabled: Map(lower id -> path), pluginFolders: [{ norm, name, mod, modsDir }], enabledNames: [{ name, modsDir }] }
// mod is the mod folder's name, null for Overwrite.
function scanForAddons({ modsDirs, overwriteDirs, firstDirs, enabled, modEntries }) {
    const externals = new Map();
    const disabled = new Map();
    const pluginFolders = [];
    const enabledNames = [];
    const add = (map, id, loc) => { const k = id.toLowerCase(); if (!map.has(k)) map.set(k, []); map.get(k).push(loc); };
    const lookIn = (skyrimNetBase, pluginsDir, mod, modsDir, on) => {
        const ext = joinCI(skyrimNetBase, 'external');
        for (const id of listDirs(ext)) {
            const m = joinCI(ext, id, 'manifest.json');
            if (!statFile(m)) continue;
            if (on) add(externals, id, { path: m, mod, modsDir, id });
            else if (!disabled.has(id.toLowerCase())) disabled.set(id.toLowerCase(), m);
        }
        if (!on) return;
        for (const name of listDirs(pluginsDir)) pluginFolders.push({ norm: normName(name), name, mod, modsDir });
    };
    for (const { dir, mod, modsDir } of firstDirs) {
        if (!dir) continue;
        lookIn(dir, path.dirname(dir), mod, modsDir, true);
    }
    for (const ow of overwriteDirs) {
        lookIn(joinCI(ow, ...REL_FLAT), joinCI(ow, 'SKSE', 'Plugins'), null, null, true);
        lookIn(joinCI(ow, ...REL_DATA), joinCI(ow, 'Data', 'SKSE', 'Plugins'), null, null, true);
    }
    // The mods to look at: Mod Organizer 2's own mod list when it was read (enabled mods in priority order, highest first, then the switched-off ones),
    // otherwise every folder in the mods folders with every mod counted as on.
    const entries = modEntries || modsDirs.flatMap((modsDir) => listDirs(modsDir).map((name) => ({ name, modsDir, on: !enabled || enabled.set.has(name.toLowerCase()) })));
    for (const { name, modsDir, on } of entries) {
        if (on) enabledNames.push({ name, modsDir });
        const root = joinCI(modsDir, name);
        lookIn(joinCI(root, ...REL_FLAT), joinCI(root, 'SKSE', 'Plugins'), name, modsDir, on);
        lookIn(joinCI(root, ...REL_DATA), joinCI(root, 'Data', 'SKSE', 'Plugins'), name, modsDir, on);
    }
    return { externals, disabled, pluginFolders, enabledNames };
}

// Where one add-on's files are: { overwrite, mods: [names], onlyOverwrite }. onlyOverwrite is the one case the page labels.
function whereOf(locs) {
    const overwrite = locs.some((l) => l.mod === null);
    const mods = [...new Set(locs.filter((l) => l.mod !== null).map((l) => l.mod))];
    return { overwrite, mods, onlyOverwrite: overwrite && mods.length === 0 };
}

// Hub listings whose files are on disk although no manifest says so: an enabled mod named like the listing, or a SKSE\Plugins\<folder> named like it.
// listings: [{ id, title, plugin_id }]; skip: Set of listing ids already accounted for. -> [{ listing, kind: 'folder' | 'name', mod, modsDir, overwrite }]
function findInstalledByName(scan, listings, skip = new Set()) {
    if (!scan) return [];
    const byName = new Map();
    for (const l of listings || []) {
        if (!l || !l.id || skip.has(l.id)) continue;
        const pid = String(l.plugin_id || l.id);
        const names = [l.title, pid.includes('.') ? pid.slice(pid.indexOf('.') + 1) : pid, String(l.id).split('/').pop()];
        for (const n of names) {
            const k = normName(n);
            if (k.length < 5 || k === 'skyrimnet') continue;
            if (!byName.has(k)) byName.set(k, new Set());
            byName.get(k).add(l);
        }
    }
    const hits = new Map(); // listing id -> hit (a mod folder beats Overwrite)
    const put = (l, hit) => { const old = hits.get(l.id); if (!old || (old.overwrite && !hit.overwrite)) hits.set(l.id, { listing: l, ...hit }); };
    for (const m of scan.enabledNames || []) {
        const set = byName.get(normName(bareModName(m.name))) || byName.get(normName(m.name));
        if (set) for (const l of set) put(l, { kind: 'name', mod: m.name, modsDir: m.modsDir, overwrite: false });
    }
    for (const f of scan.pluginFolders || []) {
        const set = byName.get(f.norm);
        if (set) for (const l of set) put(l, { kind: 'folder', mod: f.mod, modsDir: f.modsDir, overwrite: f.mod === null });
    }
    return [...hits.values()];
}

// Which add-ons are installed, and where their files are, once the registries are read (the same for every way SkyrimNet was found).
// The enabled mods come from ONE place, Mod Organizer 2's own mod list (lib/mo2-layers.js, search.layers); with no readable list every mod folder counts.
// -> { plugins (the registry's add-ons first, then those found only by their folder, with .evidence and .where), unregistered, evidenceNote, scan }
function collectAddons({ search, opts, merged, readable, skyrimNetDir, liveDir = null, copies = null }) {
    const mo2Mode = !!opts.mo2Mode;
    const L = search.layers || null;
    const enabled = mo2Mode && L ? { set: new Set(L.enabledNames.map((n) => n.toLowerCase())), profile: L.profile } : null;
    const modsDirs = L ? [L.modsDir] : (search.modsDirs || []);
    const overwriteDirs = L ? [L.overwriteDir] : (search.overwriteDirs || []);
    const where = (dir) => {
        if (overwriteDirs.some((ow) => isInside(dir, ow))) return { mod: null, modsDir: null };
        const md = modsDirs.find((m) => isInside(dir, m));
        if (md) return { mod: path.relative(md, dir).split(path.sep)[0], modsDir: md };
        return { mod: '(game folder)', modsDir: null }; // SkyrimNet's own folder in the game's Data: a permanent home
    };
    const firstDirs = copies
        ? copies.map((c) => (c.mod === 'Overwrite' ? { dir: c.dir, mod: null, modsDir: null } : { dir: c.dir, mod: c.mod, modsDir: L.modsDir }))
        : [skyrimNetDir, liveDir].filter(Boolean).map((d) => ({ dir: d, ...where(d) }));
    // With the mod list: enabled mods in priority order (highest first), then the switched-off ones; without it, every folder, all on.
    const modEntries = L ? [...L.enabledNames.map((name) => ({ name, modsDir: L.modsDir, on: true })), ...L.disabledNames.map((name) => ({ name, modsDir: L.modsDir, on: false }))] : null;
    const scan = scanForAddons({ modsDirs, overwriteDirs, firstDirs, enabled, modEntries });
    const locsOf = (id) => scan.externals.get(id.toLowerCase()) || [];
    const readManifest = (manifestPath) => {
        try { return { manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')), manifestError: null }; } catch (err) { return { manifest: null, manifestError: err.message }; }
    };
    const plugins = [];
    for (const e of merged) {
        const locs = locsOf(e.id);
        let manifestPath;
        if (copies) manifestPath = (locs[0] && locs[0].path) || joinCI(e.registryDir, 'external', e.id, 'manifest.json'); // the highest enabled copy
        else {
            const candidates = [skyrimNetDir, liveDir, e.registryDir].filter(Boolean).map((d) => joinCI(d, 'external', e.id, 'manifest.json'));
            manifestPath = candidates.find(statFile) || (locs[0] && locs[0].path) || candidates[0];
        }
        plugins.push({ id: e.id, source: e.source, ...readManifest(manifestPath), manifestPath, evidence: 'registry', where: whereOf(locs) });
    }
    // Add-on folders on disk that no registry lists (any source: hub entries are SkyrimNet's own and count as listed).
    const listed = new Set();
    for (const x of readable) for (const id of x.allIds) listed.add(id);
    const unregistered = [];
    for (const [id, locs] of scan.externals) {
        if (listed.has(id)) continue;
        const folderName = path.basename(path.dirname(locs[0].path));
        const w = whereOf(locs);
        if (mo2Mode) plugins.push({ id: folderName, source: 'external', ...readManifest(locs[0].path), manifestPath: locs[0].path, evidence: w.overwrite ? 'overwrite' : 'mod', where: w });
        else unregistered.push({ id: folderName, source: 'external', ...readManifest(locs[0].path), manifestPath: locs[0].path });
    }
    // An add-on only in a mod that is switched off is ignored: nothing will register it, so no "start the game" line for it (`scan.disabled` is kept for the log only).
    const counts = {};
    for (const p of plugins) counts[p.evidence] = (counts[p.evidence] || 0) + 1;
    const evidenceNote = `installed because: ${['registry', 'overwrite', 'mod'].map((k) => `${k} ${counts[k] || 0}`).join(', ')}${enabled ? `; enabled mods read from profile ${enabled.profile} (${enabled.set.size} on)` : '; no profile list read, every mod folder counts'}`;
    return { plugins, unregistered, evidenceNote, scan: mo2Mode ? scan : null };
}

// Reads content-registry.json's own `plugins` map plus each external plugin's own manifest.json.
// Returns { skyrimNetDir, plugins: [{id, source, manifest, manifestPath, evidence, where}], error, search, registryNote, evidenceNote, unregistered, scan }. Parses the
// JSON properly (never greps) -- content-registry.json and a manifest can both carry other
// version-like fields, so only the real, structured `version` field is ever trusted.
//
// "hub"-sourced plugins (SkyrimNet installs/updates these itself) are deliberately excluded --
// this tool has nothing useful to check or do for them.
//
// Mod Organizer 2: the registry in Overwrite is the live one (see findSkyrimNet). When the SkyrimNet mod folder also has one, the plugins are
// the live list PLUS any external plugin only the mod folder's older copy lists (still true for what that mod folder holds).
// With opts.mo2Mode, an add-on folder found in Overwrite or an enabled mod that no registry lists yet is INSTALLED too (evidence 'overwrite' / 'mod');
// `unregistered` then holds only add-on folders of mods that are switched off. Without it (Vortex) every such folder is `unregistered`:
// SkyrimNet adds them to its registry the next time the game runs.
// opts: { skyrimNetFolder, modsFolder, mo2Folder, mo2Mode, log }.
// `unregistered`: add-on folders on disk (a mod's own external\<id>\manifest.json) that no registry lists yet: SkyrimNet adds them the next
// time the game runs.
// opts: { skyrimNetFolder, modsFolder, mo2Folder, log }.
// How a copy is named in the log: Overwrite, or the mod with its place in the mod list.
const labelOf = (c) => (c.mod === 'Overwrite' ? 'Overwrite' : `mod '${c.mod}' (priority ${c.priority}, enabled)`);

// The mod list was read (search.validCopies, in the order Mod Organizer 2 serves them): each file comes from the first copy that has it. The plugin
// list is still the union (an add-on only a lower copy lists is kept); add-on manifests come from the highest enabled copy; switched-off mods are
// never looked at, so an add-on only they hold is not "on disk".
function readFromLayers(search, opts) {
    const L = search.layers;
    const copies = search.copies.filter((c) => c.state !== 'missing');
    const regCopies = search.validCopies.filter((c) => hasRegistry(c.dir));
    const yamlCopies = search.validCopies.filter((c) => yamlMtime(c.dir) >= 0);
    const fileNote = (name, list) => {
        if (!list.length) return `${name}: none${search.liveDir ? '' : ' (Overwrite has none)'}`;
        const also = list.slice(1);
        return `${name}: from ${labelOf(list[0])}${also.length ? `; also in ${also.map(labelOf).join(', ')}: used the higher` : ''}${list.some((c) => c.mod === 'Overwrite') ? '' : '; Overwrite has none'}`;
    };
    const listLine = `mod list: profile '${L.profile}', ${L.modsChecked} enabled mod${L.modsChecked === 1 ? '' : 's'} checked in ${L.ms} ms${L.cached ? ' (from the earlier check)' : ''}, ${L.disabledCount} switched off`;
    const notes = [listLine, fileNote('registry', regCopies), fileNote('config\\SkyrimNet.yaml', yamlCopies)];
    const skyrimNetDir = search.dir;
    if (!regCopies.length) {
        if (typeof opts.log === 'function') opts.log(`SkyrimNet found at ${skyrimNetDir} but content-registry.json is missing there; no plugin list yet`);
        return { skyrimNetDir, liveDir: search.liveDir, copies, plugins: [], error: null, search: describeSearch(search), searchSummary: summarizeSearch(search, 'accepted by config\\SkyrimNet.yaml, no content-registry.json'), unregistered: [], registryNote: notes.join('; '), enabledModNames: L.enabledNames };
    }
    const sources = regCopies.map((c) => readRegistryFile(c.dir));
    const readable = sources.filter((x) => !x.error);
    if (!readable.length) return { skyrimNetDir, plugins: [], error: `Could not read content-registry.json: ${sources[0].error}`, searchSummary: summarizeSearch(search, 'registry unreadable') };
    const merged = [];
    const seen = new Set();
    for (const src of readable) {
        for (const e of src.externals) {
            if (seen.has(e.id.toLowerCase())) continue;
            seen.add(e.id.toLowerCase());
            merged.push({ ...e, registryDir: src.dir });
        }
    }
    notes[1] += `; ${readable[0].externals.length} external plugin${readable[0].externals.length === 1 ? '' : 's'} listed, ${merged.length} in all`;
    if (sources.some((x) => x.error)) notes.push(`one registry could not be read (${sources.find((x) => x.error).dir})`);

    const added = collectAddons({ search, opts, merged, readable, skyrimNetDir, copies });
    return { skyrimNetDir, liveDir: search.liveDir, copies, plugins: added.plugins, unregistered: added.unregistered, registryNote: notes.join('; '), evidenceNote: added.evidenceNote, scan: added.scan, error: null, searchSummary: summarizeSearch(search, 'has content-registry.json'), enabledModNames: L.enabledNames };
}

// Fills the mod list's hit cache in chunks before the (synchronous) check runs, so a huge list never freezes the page. Never throws.
async function prewarm(skyrimPath, opts = {}) {
    try {
        if (opts.skyrimNetFolder && checkHandChosen(opts.skyrimNetFolder).dir) return;
        const inst = instanceFor(skyrimPath, opts);
        if (inst) await mo2Layers.prewarm(inst, { fresh: opts.fresh });
    } catch { /* the check itself reads it the slow way */ }
}

function readInstalledPlugins(skyrimPath, opts = {}) {
    const search = findSkyrimNet(skyrimPath, opts);
    const skyrimNetDir = search.dir;
    if (!skyrimNetDir) {
        logSearch(opts.log, search);
        return { skyrimNetDir: null, plugins: [], error: NOT_FOUND_MESSAGE, search: describeSearch(search), searchSummary: summarizeSearch(search) };
    }
    if (search.validCopies) return readFromLayers(search, opts);

    const liveDir = search.liveDir && !sameP(search.liveDir, skyrimNetDir) ? search.liveDir : null;
    const modDir = liveDir ? skyrimNetDir : null;
    // The folder whose registry counts first: the live copy when there is one.
    const primaryDir = liveDir || skyrimNetDir;
    const primaryHas = hasRegistry(primaryDir);
    const secondaryHas = !!modDir && hasRegistry(modDir);
    if (!primaryHas && !secondaryHas) {
        // Accepted by config\SkyrimNet.yaml alone: SkyrimNet is there, it just has no plugin list yet.
        if (typeof opts.log === 'function') opts.log(`SkyrimNet found at ${skyrimNetDir} but content-registry.json is missing there; no plugin list yet`);
        return { skyrimNetDir, plugins: [], error: null, search: describeSearch(search), searchSummary: summarizeSearch(search, 'accepted by config\\SkyrimNet.yaml, no content-registry.json'), unregistered: [], registryNote: `registry: none yet (${primaryDir})` };
    }

    const sources = [];
    if (primaryHas) sources.push(readRegistryFile(primaryDir));
    if (liveDir && secondaryHas) sources.push(readRegistryFile(modDir));
    const readable = sources.filter((x) => !x.error);
    if (!readable.length) {
        return { skyrimNetDir, plugins: [], error: `Could not read content-registry.json: ${sources[0].error}`, searchSummary: summarizeSearch(search, 'registry unreadable') };
    }
    const first = readable[0];
    const merged = first.externals.map((e) => ({ ...e, registryDir: first.dir }));
    const seen = new Set(merged.map((e) => e.id.toLowerCase()));
    let keptFromModCopy = 0;
    for (const other of readable.slice(1)) {
        for (const e of other.externals) {
            if (seen.has(e.id.toLowerCase())) continue;
            seen.add(e.id.toLowerCase());
            merged.push({ ...e, registryDir: other.dir });
            keptFromModCopy++;
        }
    }
    const isLive = !!search.liveDir && sameP(first.dir, search.liveDir);
    const modCopyRead = readable.find((x) => liveDir && sameP(x.dir, modDir));
    let registryNote = `registry: ${first.file}${isLive ? ' (live copy)' : ''}, ${first.externals.length} external plugin${first.externals.length === 1 ? '' : 's'}`;
    if (isLive && modCopyRead) registryNote += `; the mod folder's copy lists ${modCopyRead.externals.length}${keptFromModCopy ? `, ${keptFromModCopy} of them only there and kept` : ''}`;
    else if (isLive && !secondaryHas) registryNote += '; the SkyrimNet mod folder has no registry of its own';
    if (sources.some((x) => x.error)) registryNote += `; one copy could not be read (${sources.find((x) => x.error).dir})`;

    const added = collectAddons({ search, opts, merged, readable, skyrimNetDir, liveDir });
    return { skyrimNetDir, liveDir, plugins: added.plugins, unregistered: added.unregistered, registryNote, evidenceNote: added.evidenceNote, scan: added.scan, error: null, searchSummary: summarizeSearch(search, 'has content-registry.json') };
}

module.exports = { summarizeSearch, resolveSkyrimNetDir, findSkyrimNet, readInstalledPlugins, prewarm, findInstalledByName, whereOf, NOT_FOUND_MESSAGE };
