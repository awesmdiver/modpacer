'use strict';
// One [versions] line per installed add-on in logs/update.log (queue: the update log says, for every add-on, which version ModPacer found and
// where it came from, 2026-10-20). A player's wrong version could not be diagnosed from "registry 23 ... 4 with an update" alone.
// Written on the first check after start-up, on Check now, and whenever an add-on's line differs from the last one written -- so a quiet
// 15-second check adds nothing. This file only DESCRIBES the choice the engine already made; it never changes which version is used.
// Privacy is the log's own (redact() in update-log.js); a line carries ids, version numbers and mod FOLDER NAMES, never a path.

const fs = require('fs');
const path = require('path');
const { logArea } = require('./update-log');

const VERDICT = { up_to_date: 'up to date', update_available: 'update', unknown_version: 'unknown', not_on_hub: 'not on the Hub' };
const lastLines = new Map(); // add-on id -> the line last written

function manifestVersion(manifestPath) {
    try { const v = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version; return v == null || v === '' ? null : String(v); } catch { return null; }
}
const place = (mod) => (mod === null || mod === undefined ? 'Overwrite' : `mod '${mod}'`);
const ver = (v) => (v ? String(v) : 'none');

// What Mod Organizer 2 records for a mod folder, named by what supplied the number (lib/mo2.js readModRecord: the newer of meta.ini and the archive name).
function modRecord(mo2, modsDir, mod) {
    return mo2.readModRecord(modsDir, mod);
}

// -> the text after "[versions] " for one add-on.
//   row: the finished row (installedVersion, latestVersion, status); plugin: what readInstalledPlugins found (evidence, where, manifest);
//   info: the version source the engine used (Vortex's record or the Mod Organizer 2 lookup), or undefined; scan: the Mod Organizer 2 folder scan or null.
function describe({ row, plugin, info, scan, mo2, isMo2, settingsFolder }) {
    let elsewhere = false; // the copy was read from a folder other than the settings' Mods folder
    const used = row.installedVersion;
    const manifestV = (plugin.manifest && plugin.manifest.version) || null;
    const locs = (scan && scan.externals && scan.externals.get(String(plugin.id).toLowerCase())) || [];
    const win = locs[0] || null; // the winning enabled copy: highest priority
    const found = plugin.evidence || (plugin.nameHit ? 'name' : 'paired by name');
    const seen = [];
    let from;
    if (info && !isMo2) {
        from = row.vortexInfoFromCache ? "Vortex's record (remembered from the last time Vortex answered)" : "Vortex's record";
        if (manifestV) seen.push(`manifest ${manifestV}`);
    } else if (info && isMo2) {
        const mod = info.mo2ModFolder;
        const modsDir = (locs.find((l) => l.mod === mod) || {}).modsDir || (win && win.modsDir) || (scan && (scan.enabledNames.find((e) => e.name === mod) || {}).modsDir);
        if (modsDir && settingsFolder && path.resolve(modsDir).toLowerCase() !== path.resolve(settingsFolder).toLowerCase()) elsewhere = true;
        const rec = modsDir && mod ? modRecord(mo2, modsDir, mod) : { version: null, from: null };
        const viaManifest = manifestV && manifestV === used && !(rec.version && rec.version === used && plugin.nameHit);
        from = viaManifest ? `manifest of ${place(mod)}` : rec.from === 'archive name' ? `the archive name '${rec.detail}' of mod '${mod}'` : `${rec.from || 'the mod'} of mod '${mod}'`;
        if (rec.dateStamp) seen.push(`meta.ini of mod '${mod}' has only Mod Organizer 2's date stamp ${rec.dateStamp} (ignored)`);
        if (rec.version && rec.version !== used) seen.push(`${rec.from} of mod '${mod}' ${rec.version}`);
        if (manifestV && manifestV !== used) seen.push(`manifest of ${place(win ? win.mod : mod)} ${manifestV}`);
    } else {
        from = plugin.evidence && win ? `manifest of ${place(win.mod)}` : 'its manifest';
        if (!manifestV) from = 'nothing (no version in its manifest)';
    }
    if (isMo2) {
        const seenMods = new Set([win && win.mod]);
        for (const l of locs.slice(1)) if (!seenMods.has(l.mod) && seenMods.add(l.mod)) seen.push(`manifest of ${place(l.mod)} ${ver(manifestVersion(l.path))}`);
        const off = scan && scan.disabled && scan.disabled.get(String(plugin.id).toLowerCase());
        if (off) seen.push(`manifest in a switched-off mod ${ver(manifestVersion(off))} (not counted)`);
    }
    const parts = [
        `${row.id}: used ${ver(used)}`,
        `from ${from}`,
        `found via ${found}`,
        elsewhere ? 'read from the folder the mod list scan found' : null,
        seen.length ? `also saw ${seen.join(', ')}` : null,
        `Hub ${ver(row.latestVersion)}`,
        VERDICT[row.status] || row.status,
    ];
    return parts.filter(Boolean).join('; ');
}

// Writes the lines that are new or changed (all of them when `force`). Returns how many it wrote.
function logVersions({ rows, plugins, vortexInfo, scan, mo2, isMo2, force = false, settingsFolder = null }) {
    const byId = new Map(plugins.map((p) => [p.id, p]));
    let wrote = 0;
    for (const row of rows) {
        const plugin = byId.get(row.id);
        if (!plugin || row.notInstalled) continue;
        let line;
        try { line = describe({ row, plugin, info: vortexInfo && vortexInfo[row.id], scan, mo2, isMo2, settingsFolder }); } catch { continue; } // logging never breaks a check
        if (!force && lastLines.get(row.id) === line) continue;
        lastLines.set(row.id, line);
        logArea('versions', line);
        wrote++;
    }
    return wrote;
}
function forgetLines() { lastLines.clear(); }

module.exports = { logVersions, describe, forgetLines };
