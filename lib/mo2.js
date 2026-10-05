'use strict';
// Mod Organizer 2 support (queue: ask-which-mod-manager, 2026-10-01). READ-ONLY: this never writes
// anything into MO2's folders -- MO2 installs the update itself, from the downloaded archive.
//
// Reads each installed mod's version from MO2's own mods folder (the "Mod Staging Folder" setting
// doubles as MO2's mods folder): the mod's meta.ini version first, then the version in the file
// name (the archive name MO2 recorded, then the mod's own folder name), and otherwise reports
// nothing at all so the caller falls back to the mod's own manifest -- the same fallback order the
// Vortex path uses, just without Vortex.

const fs = require('fs');
const path = require('path');
const vortexUpdate = require('./vortex-update');

// [General] section of an MO2 meta.ini -> { version, installationFile } (either may be ''). MO2
// writes `key=value` lines; keys are matched case-insensitively. Never throws.
function readMetaIni(modRoot) {
    const out = { version: '', installationFile: '' };
    let text;
    try {
        text = fs.readFileSync(path.join(modRoot, 'meta.ini'), 'utf8');
    } catch {
        return out;
    }
    let inGeneral = false;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        const section = /^\[(.+)\]$/.exec(line);
        if (section) { inGeneral = section[1].toLowerCase() === 'general'; continue; }
        if (!inGeneral) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim().toLowerCase();
        let value = line.slice(eq + 1).trim();
        if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        if (key === 'version') out.version = value;
        else if (key === 'installationfile') out.installationFile = value;
    }
    return out;
}

// The installed version MO2 itself knows for this mod folder: meta.ini's version, else the version
// in the recorded archive name, else the folder's own name. null if none of those has one.
function readModVersion(modsFolder, modFolderName) {
    const modRoot = path.join(modsFolder, modFolderName);
    const meta = readMetaIni(modRoot);
    if (meta.version) return meta.version;
    return vortexUpdate.extractVersionFromFileName(meta.installationFile)
        || vortexUpdate.extractVersionFromFileName(modFolderName)
        || null;
}

// Which mod folder under MO2's mods folder holds this SkyrimNet plugin -- the same manifest scan
// the Vortex path uses (SKSE/Plugins/SkyrimNet/external/<id>/manifest.json, with or without a
// Data/ level). If more than one mod holds it (an old copy kept alongside), the one whose manifest
// was written most recently wins. null when none does.
function findModFolderForPlugin(modsFolder, pluginId) {
    let names;
    try {
        names = fs.readdirSync(modsFolder);
    } catch {
        return null;
    }
    let best = null;
    for (const name of names) {
        const modRoot = path.join(modsFolder, name);
        const manifest = vortexUpdate.findManifestPath(modRoot, pluginId);
        if (!manifest) continue;
        let mtime = 0;
        try { mtime = fs.statSync(manifest).mtimeMs; } catch { /* keep 0 */ }
        if (!best || mtime > best.mtime) best = { name, mtime };
    }
    return best ? best.name : null;
}

// Same shape as vortex-update.js's resolveVortexInfoBatch, so the engine can use either:
// { [pluginId]: { version, source: null, nexusModId: null, vortexModId: null, mo2ModFolder } } --
// but ONLY for a plugin whose version was actually found, so a plugin MO2 can't tell us about falls
// back to its own manifest exactly as it does without any mod manager.
function resolveInfoBatch(pluginIds, modsFolder) {
    const out = {};
    if (!modsFolder) return out;
    for (const pluginId of pluginIds) {
        const folder = findModFolderForPlugin(modsFolder, pluginId);
        if (!folder) continue;
        const version = readModVersion(modsFolder, folder);
        if (!version) continue;
        out[pluginId] = { version, source: null, nexusModId: null, vortexModId: null, mo2ModFolder: folder };
    }
    return out;
}

module.exports = { readMetaIni, readModVersion, findModFolderForPlugin, resolveInfoBatch };
