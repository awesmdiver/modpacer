'use strict';
// Finds SkyrimNet's own install folder (MO2-aware) and reads which plugins are installed,
// straight from SkyrimNet's own content-registry.json + each external plugin's own manifest.json.
// Real data confirmed against the director's own install (2026-09-30): 14 external plugins.

const fs = require('fs');
const path = require('path');

// Ported from skyrimnet-multiproxy-dev's own proxy.py _resolve_skyrimnet_dir (2026-09-22 fix,
// same project, credited in TECHNICAL.md) -- same algorithm, same reasoning: a normal Vortex/
// manual install's SkyrimNet folder sits directly under <skyrimPath>/Data/SKSE/Plugins/SkyrimNet,
// but under Mod Organizer 2 that merge only exists inside the real game process (MO2's virtual
// filesystem hook) -- a separate program like this one only ever sees what's really, physically
// on disk, which for MO2 means SkyrimNet's own files land inside one mod's own
// mods/<name>/Data/... folder (or, rarer, MO2's overwrite/ catch-all), never under the linked
// root's own Data/ at all. Treats the linked root's PARENT as a possible MO2 instance folder (the
// right shape when a player links an MO2 instance's own "Stock Game" folder) and searches
// mods/*/Data/SKSE/Plugins/SkyrimNet and overwrite/Data/SKSE/Plugins/SkyrimNet siblings. A
// candidate is only accepted if it has a `config` subfolder (SkyrimNet.yaml lives there) -- never
// just "a folder happens to be named SkyrimNet". mods/* wins over overwrite/ when both have a
// valid candidate; if more than one mods/* candidate exists, the one with the most recently
// modified config/SkyrimNet.yaml wins.
function isValidSkyrimNetDir(candidate) {
    try {
        return fs.statSync(path.join(candidate, 'config')).isDirectory();
    } catch {
        return false;
    }
}

function yamlMtime(candidate) {
    try {
        return fs.statSync(path.join(candidate, 'config', 'SkyrimNet.yaml')).mtimeMs;
    } catch {
        return -1;
    }
}

function resolveSkyrimNetDir(skyrimPath) {
    const direct = path.join(skyrimPath, 'Data', 'SKSE', 'Plugins', 'SkyrimNet');
    if (isValidSkyrimNetDir(direct)) return direct;

    const parent = path.dirname(path.normalize(skyrimPath));
    const modsCandidates = [];
    try {
        const modsDir = path.join(parent, 'mods');
        for (const name of fs.readdirSync(modsDir)) {
            const candidate = path.join(modsDir, name, 'Data', 'SKSE', 'Plugins', 'SkyrimNet');
            if (isValidSkyrimNetDir(candidate)) modsCandidates.push(candidate);
        }
    } catch {
        // No mods/ folder (not an MO2 instance, or a differently-shaped link) -- fine, fall through.
    }

    if (modsCandidates.length > 0) {
        modsCandidates.sort((a, b) => yamlMtime(b) - yamlMtime(a));
        return modsCandidates[0];
    }

    const overwriteCandidate = path.join(parent, 'overwrite', 'Data', 'SKSE', 'Plugins', 'SkyrimNet');
    if (isValidSkyrimNetDir(overwriteCandidate)) return overwriteCandidate;

    return null;
}

// Reads content-registry.json's own `plugins` map plus each external plugin's own manifest.json.
// Returns { skyrimNetDir, plugins: [{id, source, manifest, manifestPath}], error }. Parses the
// JSON properly (never greps) -- content-registry.json and a manifest can both carry other
// version-like fields, so only the real, structured `version` field is ever trusted.
//
// "hub"-sourced plugins (SkyrimNet installs/updates these itself) are deliberately excluded --
// this tool has nothing useful to check or do for them.
function readInstalledPlugins(skyrimPath) {
    const skyrimNetDir = resolveSkyrimNetDir(skyrimPath);
    if (!skyrimNetDir) {
        return { skyrimNetDir: null, plugins: [], error: 'Could not find a SkyrimNet install under this Skyrim folder.' };
    }

    const registryPath = path.join(skyrimNetDir, 'content-registry.json');
    let registry;
    try {
        registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    } catch (e) {
        return { skyrimNetDir, plugins: [], error: `Could not read content-registry.json: ${e.message}` };
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

    return { skyrimNetDir, plugins, error: null };
}

module.exports = { resolveSkyrimNetDir, readInstalledPlugins };
