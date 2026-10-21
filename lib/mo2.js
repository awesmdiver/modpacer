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
const { joinCI } = require('./ci-path');

// [General] section of an MO2 meta.ini -> { version, installationFile, modId, url } (any may be ''; modId is the Nexus mod id, 0 / -1 mean none). MO2
// writes `key=value` lines; keys are matched case-insensitively. Never throws.
function readMetaIni(modRoot) {
    const out = { version: '', installationFile: '', modId: '', url: '' };
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
        else if (key === 'modid') out.modId = value;
        else if (key === 'url') out.url = value;
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

// How many add-on folders (with a manifest) a mod folder holds under SKSE\Plugins\SkyrimNet\external. A mod that holds several (SkyrimNet's own output
// mod, a bundle) has ONE meta.ini version that says nothing about any single add-on in it.
function addonCountIn(modRoot) {
    let n = 0;
    for (const rel of [['SKSE', 'Plugins', 'SkyrimNet', 'external'], ['Data', 'SKSE', 'Plugins', 'SkyrimNet', 'external']]) {
        let dir;
        try { dir = joinCI(modRoot, ...rel); fs.readdirSync(dir); } catch { continue; }
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'manifest.json'))) n++;
        }
    }
    return n;
}

// The installed version of each add-on, from the add-on's OWN files (2026-10-20). `plugins` carry `.manifest` (read from the winning enabled copy) and
// `.where.mods` (the enabled mods that hold it, highest first). The version is the manifest's, unless the mod that holds ONLY this add-on records a newer
// one (meta.ini / archive name / folder name): a stale value never beats a newer one, whichever side is stale (a renamed folder keeps an old meta.ini;
// some authors never bump the inner manifest). A mod that merely contains other things, or holds several add-ons, contributes nothing.
// Same shape as resolveInfoBatch; an add-on with nothing to add is left out, so it falls back to its manifest exactly as before.
function resolveInfoForPlugins(plugins, modsFolder, compare) {
    const out = {};
    if (!modsFolder) return out;
    for (const p of plugins) {
        const mod = p.where && p.where.mods && p.where.mods[0];
        if (!mod) continue;
        const root = path.join(modsFolder, mod);
        if (addonCountIn(root) > 1) continue;
        const fromMod = readModVersion(modsFolder, mod);
        if (!fromMod) continue;
        const fromManifest = (p.manifest && p.manifest.version) || null;
        const version = fromManifest && compare(fromManifest, fromMod) !== 'newer' && compare(fromManifest, fromMod) !== 'unknown' ? fromManifest : fromMod;
        out[p.id] = { version, source: null, nexusModId: null, vortexModId: null, mo2ModFolder: mod };
    }
    return out;
}

module.exports = { readMetaIni, readModVersion, findModFolderForPlugin, resolveInfoBatch, resolveInfoForPlugins, addonCountIn };
