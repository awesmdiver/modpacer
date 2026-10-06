'use strict';
// Mod Organizer 2's own settings file (ModOrganizer.ini), READ-ONLY -- never written. From one folder the player
// picks (the program folder, its base folder, the mods folder, or one level inside) this finds the instance's
// game folder, mods folder and overwrite folder, so the player does not have to point at each one.
//
// Facts (the director's real MO2 2.5.2 install, and MO2's own public settings code, GPL-3.0, read for facts only --
// nothing copied): the file is Qt QSettings ini; a value may be wrapped `@ByteArray(...)`; backslashes are doubled;
// a path may use forward slashes or the `%BASE_DIR%` variable; `[Settings] base_directory` defaults to the folder the
// ini itself sits in; mods, overwrite, downloads and profiles default to `<base_directory>\mods` etc. unless
// `mod_directory`, `overwrite_directory`, `download_directory`, `profiles_directory` say otherwise.

const fs = require('fs');
const path = require('path');

const GAME = 'skyrim special edition';

function isDir(p) {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function isFile(p) {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function inside(child, parent) {
    if (!child || !parent) return false;
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// One raw value -> a plain string: `@ByteArray(x)` unwrapped, quotes dropped, `\\` -> `\`.
function cleanValue(raw) {
    let v = String(raw).trim();
    const wrapped = /^@ByteArray\(([\s\S]*)\)$/i.exec(v);
    if (wrapped) v = wrapped[1];
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    return v.replace(/\\\\/g, '\\');
}

// ini text -> { section(lowercase): { key(lowercase): value } }. Never throws.
function parseIni(text) {
    const out = {};
    let section = '';
    try {
        for (const rawLine of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith(';') || line.startsWith('#')) continue;
            const sec = /^\[(.*)\]$/.exec(line);
            if (sec) { section = sec[1].trim().toLowerCase(); continue; }
            const eq = line.indexOf('=');
            if (eq < 1) continue;
            (out[section] = out[section] || {})[line.slice(0, eq).trim().toLowerCase()] = cleanValue(line.slice(eq + 1));
        }
    } catch { /* a broken file reads as what was understood so far */ }
    return out;
}

// UTF-8 first; text that is not valid UTF-8 (the system code page) is read as latin1 instead.
function readIniText(file) {
    const buf = fs.readFileSync(file);
    const utf8 = buf.toString('utf8');
    return utf8.includes('�') ? buf.toString('latin1') : utf8;
}

// The one ModOrganizer.ini -> { iniPath, programDir, gameName, gamePath, baseDir, modsDir, overwriteDir, downloadsDir, profilesDir } or null if unreadable.
function readInstance(iniPath) {
    let ini;
    try { ini = parseIni(readIniText(iniPath)); } catch { return null; }
    const programDir = path.dirname(iniPath);
    const general = ini.general || {};
    const settings = ini.settings || {};
    const norm = (p) => (p ? path.normalize(p.replace(/\//g, '\\')) : '');
    const baseDir = norm(settings.base_directory) || programDir;
    const resolve = (value, def) => norm(value ? value.replace(/%BASE_DIR%/gi, baseDir) : path.join(baseDir, def));
    return {
        iniPath,
        programDir,
        gameName: general.gamename || '',
        gamePath: norm(general.gamepath),
        baseDir,
        modsDir: resolve(settings.mod_directory, 'mods'),
        overwriteDir: resolve(settings.overwrite_directory, 'overwrite'),
        downloadsDir: resolve(settings.download_directory, 'downloads'),
        profilesDir: resolve(settings.profiles_directory, 'profiles'),
    };
}

// 'yes' | 'unknown' (the file does not say) | 'no'
function gameMatch(inst) {
    if (!inst.gameName) return 'unknown';
    return inst.gameName.toLowerCase().includes(GAME) ? 'yes' : 'no';
}

// Every ModOrganizer.ini a picked folder can lead to: in the folder, one level up, two levels up (the mods
// folder inside the base folder inside the program folder), and -- when none of those -- one level down (a folder of instances, like
// %LOCALAPPDATA%\ModOrganizer).
function findInis(folder) {
    const start = path.resolve(folder);
    const up = [start, path.dirname(start), path.dirname(path.dirname(start))];
    const hits = [];
    for (const d of up) {
        const ini = path.join(d, 'ModOrganizer.ini');
        if (isFile(ini) && !hits.includes(ini)) hits.push(ini);
        if (hits.length) break; // the nearest instance only
    }
    if (hits.length) return hits;
    try {
        for (const e of fs.readdirSync(start, { withFileTypes: true })) {
            if (!e.isDirectory()) continue;
            const ini = path.join(start, e.name, 'ModOrganizer.ini');
            if (isFile(ini)) hits.push(ini);
        }
    } catch { /* not a folder */ }
    return hits;
}

// Plain-words problems (shown in the existing warning style; no file-format words).
const problemNone = (folder) => `ModPacer found no Mod Organizer 2 settings in ${folder}. Pick the folder with ModOrganizer.exe in it.`;
const problemGame = (folder, name) => `The Mod Organizer 2 in ${folder} is set up for ${name || 'another game'}, not Skyrim Special Edition.`;
const problemMany = (folder, names) => `There is more than one Skyrim Special Edition setup in ${folder} (${names.join(', ')}). Pick the folder of the one you use.`;

// A picked folder -> { instance, problem }. instance is null with a plain-words problem when nothing usable.
// Several instances: the Skyrim Special Edition ones; if more than one, the one the picked folder belongs to;
// otherwise no pick (a problem naming them), never a silent guess.
function resolveInstance(folder) {
    if (!folder) return { instance: null, problem: null };
    const all = findInis(folder).map(readInstance).filter(Boolean);
    if (!all.length) return { instance: null, problem: problemNone(folder), found: false };
    const matching = all.filter((i) => gameMatch(i) !== 'no');
    if (!matching.length) return { instance: null, problem: problemGame(folder, all[0].gameName), found: true };
    let pick = matching;
    if (pick.length > 1) {
        const known = pick.filter((i) => gameMatch(i) === 'yes');
        if (known.length) pick = known;
    }
    if (pick.length > 1) {
        const mine = pick.filter((i) => inside(folder, i.programDir) || inside(folder, i.baseDir) || inside(folder, i.modsDir));
        if (mine.length === 1) pick = mine;
    }
    if (pick.length > 1) return { instance: null, problem: problemMany(folder, pick.map((i) => path.basename(i.programDir))), found: true };
    return { instance: pick[0], problem: null, found: true };
}

// The instances the player's settings lead to, best source first: the MO2 folder, then the Skyrim and staging
// folders they may have pointed at an MO2 folder. Each distinct instance once. `problem` is only for the MO2 folder.
function instancesFor(cfg = {}) {
    const found = [];
    for (const f of [cfg.mo2Folder, cfg.skyrimInstallPath, cfg.vortexStagingFolder]) {
        if (!f) continue;
        const { instance } = resolveInstance(f);
        if (instance && !found.some((i) => same(i.iniPath, instance.iniPath))) found.push(instance);
    }
    return found;
}

// The mods folder to use: the player's own staging folder if it is a real folder of mods; else the one the instance
// names (so a player who picked the program folder, or the base folder, still gets the mods folder).
function effectiveModsFolder(cfg = {}) {
    const [inst] = instancesFor(cfg);
    const own = cfg.vortexStagingFolder;
    if (inst && (!own || same(own, inst.programDir) || same(own, inst.baseDir) || !isDir(own))) return inst.modsDir;
    if (own) return own;
    return inst ? inst.modsDir : null;
}

// The patch to save when the player picked a folder (mo2Folder, or an MO2 folder in the Skyrim or staging field):
// fills what they have not set and turns a program/base-folder pick into the real folder. Never overwrites a
// choice that already points at something real. Returns {} when there is nothing to add.
function derivePatch(cfg, patch) {
    const merged = { ...cfg, ...patch };
    const out = {};
    const pickedMo2 = 'mo2Folder' in patch && patch.mo2Folder;
    const staging = merged.vortexStagingFolder;
    const skyrim = merged.skyrimInstallPath;

    if (pickedMo2) {
        const { instance } = resolveInstance(patch.mo2Folder);
        if (instance) {
            if (!staging && isDir(instance.modsDir)) out.vortexStagingFolder = instance.modsDir;
            if (!skyrim && instance.gamePath && isDir(instance.gamePath)) out.skyrimInstallPath = instance.gamePath;
        }
    }
    if ('vortexStagingFolder' in patch && patch.vortexStagingFolder) {
        const { instance } = resolveInstance(patch.vortexStagingFolder);
        if (instance && (same(patch.vortexStagingFolder, instance.programDir) || same(patch.vortexStagingFolder, instance.baseDir))) {
            out.vortexStagingFolder = instance.modsDir;
        }
        if (instance && !merged.mo2Folder && !('mo2Folder' in patch)) out.mo2Folder = instance.programDir;
    }
    if ('skyrimInstallPath' in patch && patch.skyrimInstallPath) {
        const folder = patch.skyrimInstallPath;
        const { instance } = resolveInstance(folder);
        const isGame = isFile(path.join(folder, 'SkyrimSE.exe')) || isDir(path.join(folder, 'Data'));
        if (instance && !isGame && (same(folder, instance.programDir) || same(folder, instance.baseDir) || same(folder, instance.modsDir))) {
            if (instance.gamePath && isDir(instance.gamePath)) out.skyrimInstallPath = instance.gamePath;
            if (!merged.vortexStagingFolder && !out.vortexStagingFolder && isDir(instance.modsDir)) out.vortexStagingFolder = instance.modsDir;
        }
        if (instance && !isGame && !merged.mo2Folder && !('mo2Folder' in patch)) out.mo2Folder = instance.programDir;
    }
    return out;
}

module.exports = { parseIni, readInstance, findInis, resolveInstance, instancesFor, effectiveModsFolder, derivePatch, gameMatch, cleanValue };
