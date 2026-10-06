'use strict';
// Finds SkyrimNet's own install folder (MO2-aware) and reads which plugins are installed,
// straight from SkyrimNet's own content-registry.json + each external plugin's own manifest.json.
// Real data confirmed against the director's own install (2026-09-30): 14 external plugins.

const fs = require('fs');
const path = require('path');
const mo2Instance = require('./mo2-instance');

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
    return isDir(path.join(candidate, 'config')) && (hasRegistry(candidate) || yamlMtime(candidate) >= 0);
}

function classify(candidate) {
    if (isValidSkyrimNetDir(candidate)) return 'found';
    if (isDir(path.join(candidate, 'config'))) return 'other-mod';
    return isDir(candidate) ? 'no-config' : 'missing';
}

function yamlMtime(candidate) {
    try {
        return fs.statSync(path.join(candidate, 'config', 'SkyrimNet.yaml')).mtimeMs;
    } catch {
        return -1;
    }
}

function hasRegistry(candidate) {
    try { return fs.statSync(path.join(candidate, 'content-registry.json')).isFile(); } catch { return false; }
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

// Looks for SkyrimNet and records every place it looked. Returns { dir, given, checked }, where
// `checked` is [{ place, status }] and status is 'found' | 'no-config' (folder exists, no config
// inside) | 'missing'. A mods-style folder is ONE entry (it can hold hundreds of mods): place is
// "<mods>\*" and `modsScanned` says how many mod folders it had.
function findSkyrimNet(skyrimPath, opts = {}) {
    const checked = [];
    const seen = new Set();
    const note = (place, status, extra) => {
        const key = path.normalize(place).toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        checked.push({ place, status, ...(extra || {}) });
    };
    let chosenProblem = null; // the folder chosen by hand failed the SkyrimNet test: { folder, why }
    const result = (dir) => ({ dir, given: skyrimPath || null, chosen: opts.skyrimNetFolder || null, chosenProblem, checked });

    function probe(candidate) {
        const status = classify(candidate);
        note(candidate, status);
        return status === 'found';
    }
    // A folder that holds mod folders (MO2's mods, Vortex's staging): the best valid SkyrimNet inside.
    function scanMods(modsDir) {
        const names = listDirs(modsDir);
        const hits = [];
        const decoys = [];
        for (const name of names) {
            for (const rel of [REL_FLAT, REL_DATA]) {
                const c = path.join(modsDir, name, ...rel);
                const s = classify(c);
                if (s === 'found') hits.push(c);
                else if (s === 'other-mod') decoys.push(c);
            }
        }
        note(path.join(modsDir, '*'), hits.length ? 'found' : (decoys.length ? 'other-mod' : (isDir(modsDir) ? 'no-config' : 'missing')), { modsScanned: names.length, decoys });
        return hits.length ? pickBest(hits) : null;
    }

    // 1. The folder the player pointed at by hand (the SkyrimNet folder itself, or the folder holding it).
    const chosen = opts.skyrimNetFolder;
    if (chosen) {
        if (probe(chosen)) return result(chosen);
        const inner = path.join(chosen, 'SkyrimNet');
        if (probe(inner)) return result(inner);
        const why = { found: '', 'other-mod': 'it has a config folder but no content-registry.json or SkyrimNet.yaml, so it belongs to another mod', 'no-config': 'it has no config folder inside', missing: 'it is not there' };
        const s = classify(chosen);
        const si = classify(inner);
        chosenProblem = { folder: chosen, why: why[s === 'missing' && si !== 'missing' ? si : s] };
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
                const c = path.join(inst.overwriteDir, ...rel);
                if (probe(c)) return c;
            }
        }
        return null;
    }

    if (!skyrimPath) return result(searchInstances());
    const base = path.normalize(skyrimPath);
    const p1 = path.dirname(base);
    const p2 = path.dirname(p1);

    // 2. The folder that was given: a game folder (Data\...), or a Data folder / mod folder / Stock Game itself (SKSE\...).
    for (const rel of [REL_DATA, REL_FLAT]) {
        const c = path.join(base, ...rel);
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
        const m = path.join(inst, 'mods');
        if (isDir(m) && !mods.includes(m)) mods.push(m);
    }
    for (const m of mods) { const hit = scanMods(m); if (hit) modHits.push(hit); }
    if (modHits.length) return result(pickBest(modHits));

    const overwrites = instances.map((inst) => path.join(inst, 'overwrite'));
    for (const ow of overwrites) {
        if (!isDir(ow)) continue; // MO2 always has one in an instance; a folder that is not there is not worth listing
        for (const rel of [REL_FLAT, REL_DATA]) {
            const c = path.join(ow, ...rel);
            if (probe(c)) return result(c);
        }
    }

    // 3b. A "Stock Game" (or similar) copy of the game inside the instance folder given.
    for (const name of listDirs(base)) {
        if (['mods', 'overwrite', 'profiles', 'downloads', 'data'].includes(name.toLowerCase())) continue;
        if (!isDir(path.join(base, name, 'Data'))) continue;
        const c = path.join(base, name, ...REL_DATA);
        if (probe(c)) return result(c);
    }

    // 4. The "Mod Staging Folder" setting (MO2's mods folder, or Vortex's staging folder).
    if (opts.modsFolder && isDir(opts.modsFolder)) {
        const hit = scanMods(path.normalize(opts.modsFolder));
        if (hit) return result(hit);
    }

    return result(null);
}

function resolveSkyrimNetDir(skyrimPath, opts) {
    return findSkyrimNet(skyrimPath, opts).dir;
}

// What the page shows when nothing was found: plain words, folder names only.
const NOT_FOUND_MESSAGE = "ModPacer couldn't find SkyrimNet in the folders it looked in.";

function describeSearch(search) {
    const lines = (search.checked || []).map((c) => {
        if (c.status === 'missing') return `${c.place} (not there)`;
        if (c.status === 'other-mod') return `${c.place} (another mod's folder, not SkyrimNet itself)`;
        if (c.status === 'no-config') return c.modsScanned != null ? `${c.place} (no SkyrimNet with a config folder)` : `${c.place} (no config folder inside)`;
        return c.place;
    });
    return { given: search.given, chosen: search.chosen, chosenProblem: search.chosenProblem || null, places: lines };
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
        log(`  checked ${c.place} -> ${c.status}${c.modsScanned != null ? ` (${c.modsScanned} mod folders)` : ''}`);
    }
}

// Reads content-registry.json's own `plugins` map plus each external plugin's own manifest.json.
// Returns { skyrimNetDir, plugins: [{id, source, manifest, manifestPath}], error, search }. Parses the
// JSON properly (never greps) -- content-registry.json and a manifest can both carry other
// version-like fields, so only the real, structured `version` field is ever trusted.
//
// "hub"-sourced plugins (SkyrimNet installs/updates these itself) are deliberately excluded --
// this tool has nothing useful to check or do for them.
// opts: { skyrimNetFolder, modsFolder, mo2Folder, log }.
function readInstalledPlugins(skyrimPath, opts = {}) {
    const search = findSkyrimNet(skyrimPath, opts);
    const skyrimNetDir = search.dir;
    if (!skyrimNetDir) {
        logSearch(opts.log, search);
        return { skyrimNetDir: null, plugins: [], error: NOT_FOUND_MESSAGE, search: describeSearch(search), searchSummary: summarizeSearch(search) };
    }

    const registryPath = path.join(skyrimNetDir, 'content-registry.json');
    if (!hasRegistry(skyrimNetDir)) {
        // Accepted by config\SkyrimNet.yaml alone: SkyrimNet is there, it just has no plugin list yet.
        if (typeof opts.log === 'function') opts.log(`SkyrimNet found at ${skyrimNetDir} but content-registry.json is missing there; no plugin list yet`);
        return { skyrimNetDir, plugins: [], error: null, search: describeSearch(search), searchSummary: summarizeSearch(search, 'accepted by config\\SkyrimNet.yaml, no content-registry.json') };
    }
    let registry;
    try {
        registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    } catch (e) {
        return { skyrimNetDir, plugins: [], error: `Could not read content-registry.json: ${e.message}`, searchSummary: summarizeSearch(search, 'registry unreadable') };
    }

    const plugins = [];
    const entries = registry && registry.plugins && typeof registry.plugins === 'object' ? registry.plugins : {};
    for (const [id, entry] of Object.entries(entries)) {
        if (!entry || entry.source !== 'external') continue; // "hub" plugins: SkyrimNet manages these itself
        const manifestPath = path.join(skyrimNetDir, 'external', id, 'manifest.json');
        let manifest = null;
        let manifestError = null;
        try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        } catch (e) {
            manifestError = e.message;
        }
        plugins.push({ id, source: entry.source, manifest, manifestPath, manifestError });
    }

    return { skyrimNetDir, plugins, error: null, searchSummary: summarizeSearch(search, 'has content-registry.json') };
}

module.exports = { summarizeSearch, resolveSkyrimNetDir, findSkyrimNet, readInstalledPlugins, NOT_FOUND_MESSAGE };
