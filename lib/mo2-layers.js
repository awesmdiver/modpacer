'use strict';
// Which copy of a SkyrimNet file would Mod Organizer 2 itself serve? (2026-10-07, "Overwrite is a catch-all folder": SkyrimNet's live
// files can sit in Overwrite, in the SkyrimNet mod, or in any other mod the player dragged them into.)
//
// Facts (Mod Organizer 2's public source and the director's real profiles, read for facts only, nothing copied):
//   * The active profile is `[General] selected_profile` in ModOrganizer.ini; its mod list is `<profiles>\<name>\modlist.txt`.
//   * Each line is `+Name` (enabled), `-Name` (switched off), `*Name` (a foreign/unmanaged entry, no folder in mods); `#` lines are comments.
//     A separator is a mod named `<label>_separator`: no files, skipped.
//   * The file is written HIGHEST priority first: the first mod line is the LAST row of the list in the window and wins; the bottom line is
//     priority 0. (Written by walking the priority map in reverse.) Overwrite sits above every mod. A switched-off mod serves nothing.
//
// Speed (a 4,000-mod list on a slow disk): modlist.txt is read ONCE and is the index; each enabled mod costs one existence check per folder in
// REL_FOLDERS and nothing else. Only a mod that has the folder is ever opened. No folder tree is walked. The hit list is cached (see CACHE_MS) and
// can be filled ahead of time in chunks (`prewarm`) so the page never waits on it. File contents are never cached.

const fs = require('fs');
const path = require('path');
const platform = require('./platform');

// The folders a mod can carry SkyrimNet's files in. Hub listings carry no folder name of their own (checked against the real index.json,
// 252 entries: id, plugin_id, type, title, tagline, author, tags, nsfw, icon, mods, version, history, contents, stats, external_url ...), so an
// add-on is told apart by what the registry and its own external\<id>\manifest.json say, never by a folder name from the catalog.
const REL_FOLDERS = [['SKSE', 'Plugins', 'SkyrimNet'], ['Data', 'SKSE', 'Plugins', 'SkyrimNet']];
const CACHE_MS = 60 * 1000;
const cache = new Map(); // `${iniPath}|${profile}` -> { at, sig, hits, modsChecked, ms }

const stat = (p) => { try { return fs.statSync(p, { throwIfNoEntry: false }) || null; } catch { return null; } };
const isDir = (p) => { const s = stat(p); return !!s && s.isDirectory(); };

// base + parts, matched without regard to letter case; null when it is not there. Windows folders already ignore case, so there it is one stat.
function existingPath(base, parts) {
    const direct = path.join(base, ...parts);
    if (isDir(direct)) return direct;
    return null;
}

function profileNameFor(inst) {
    if (inst.selectedProfile && isDir(path.join(inst.profilesDir, inst.selectedProfile))) return inst.selectedProfile;
    let names = [];
    try { names = fs.readdirSync(inst.profilesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* none */ }
    if (inst.selectedProfile) return inst.selectedProfile; // named but not there: reported as not read
    if (names.length === 1) return names[0];
    return names.find((n) => n.toLowerCase() === 'default') || null;
}

// modlist.txt text -> [{ name, enabled, priority }], highest priority first. Separators, foreign entries and comments are not mods.
function parseModlist(text) {
    const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
    const mods = [];
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const flag = line[0];
        if (flag !== '+' && flag !== '-') continue; // '*' = foreign (no folder in mods); anything else is not a mod line
        const name = line.slice(1);
        if (!name || /_separator$/i.test(name)) continue;
        mods.push({ name, enabled: flag === '+' });
    }
    const top = mods.length - 1;
    mods.forEach((m, i) => { m.priority = top - i; });
    return mods;
}

// The active profile's mod list: { ok, profile, file, mtimeMs, size, mods } or { ok: false, reason }. Read only.
function readModlist(inst) {
    const profile = profileNameFor(inst);
    if (!profile) return { ok: false, reason: 'the profile in use could not be told' };
    const file = path.join(inst.profilesDir, profile, 'modlist.txt');
    const s = stat(file);
    if (!s || !s.isFile()) return { ok: false, reason: `profile '${profile}' has no modlist.txt`, profile };
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, reason: `profile '${profile}' mod list unreadable`, profile }; }
    return { ok: true, profile, file, mtimeMs: s.mtimeMs, size: s.size, mods: parseModlist(text) };
}

const keyOf = (inst, profile) => `${inst.iniPath}|${profile}`;
const sigOf = (ml, inst) => { const ow = stat(inst.overwriteDir); return `${ml.mtimeMs}|${ml.size}|${ow ? ow.mtimeMs : 0}`; };

function hitFor(inst, mod, dirs) {
    return { name: mod.name, priority: mod.priority, dirs, dirMtimes: dirs.map((d) => { const s = stat(d); return s ? s.mtimeMs : 0; }) };
}
function modDirsOf(modsDir, name) {
    const dirs = [];
    for (const rel of REL_FOLDERS) { const p = existingPath(path.join(modsDir, name), rel); if (p) dirs.push(p); }
    return dirs;
}

// Every enabled mod, highest priority first, one existence check per folder in REL_FOLDERS.
function scanSync(inst, mods) {
    const hits = [];
    for (const m of mods) {
        const dirs = modDirsOf(inst.modsDir, m.name);
        if (dirs.length) hits.push(hitFor(inst, m, dirs));
    }
    return hits;
}
// The same scan in chunks, giving the server a turn between them, so the page and the first rows never freeze behind a huge list.
async function scanChunked(inst, mods, chunk = 150) {
    const hits = [];
    for (let i = 0; i < mods.length; i += chunk) {
        for (const m of mods.slice(i, i + chunk)) {
            const dirs = modDirsOf(inst.modsDir, m.name);
            if (dirs.length) hits.push(hitFor(inst, m, dirs));
        }
        await new Promise((r) => setImmediate(r));
    }
    return hits;
}

function cacheStillGood(entry, sig) {
    if (!entry || entry.sig !== sig || Date.now() - entry.at > CACHE_MS) return false;
    return entry.hits.every((h) => h.dirs.every((d, i) => { const s = stat(d); return !!s && s.mtimeMs === h.dirMtimes[i]; }));
}

// Shape the answer. enabled mods in priority order (highest first); Overwrite's own copies above them.
function shape(inst, ml, hits, modsChecked, ms, cached) {
    const overwriteDirs = [];
    for (const rel of REL_FOLDERS) { const p = existingPath(inst.overwriteDir, rel); if (p) overwriteDirs.push(p); }
    return {
        ok: true, profile: ml.profile, file: ml.file, modsDir: inst.modsDir, overwriteDir: inst.overwriteDir,
        enabledCount: modsChecked, disabledCount: ml.mods.length - modsChecked, modsChecked, ms, cached,
        hits, overwriteDirs,
        enabledNames: ml.mods.filter((m) => m.enabled).map((m) => m.name),
        disabledNames: ml.mods.filter((m) => !m.enabled).map((m) => m.name),
    };
}
const enabledOf = (ml) => ml.mods.filter((m) => m.enabled);

// Sync: used by the check itself. Uses the hit list `prewarm` left, when it is still good.
function resolveLayers(inst, opts = {}) {
    const ml = readModlist(inst);
    if (!ml.ok) return ml;
    const t0 = Date.now();
    const key = keyOf(inst, ml.profile);
    const sig = sigOf(ml, inst);
    const enabled = enabledOf(ml);
    const entry = cache.get(key);
    if (!opts.fresh && cacheStillGood(entry, sig)) return shape(inst, ml, entry.hits, enabled.length, Date.now() - t0, true);
    const hits = scanSync(inst, enabled);
    cache.set(key, { at: Date.now(), sig, hits });
    return shape(inst, ml, hits, enabled.length, Date.now() - t0, false);
}

// Async, in chunks: fills the cache so the sync resolve that follows costs one list read and a few stats.
async function prewarm(inst, opts = {}) {
    const ml = readModlist(inst);
    if (!ml.ok) return ml;
    const key = keyOf(inst, ml.profile);
    const sig = sigOf(ml, inst);
    if (!opts.fresh && cacheStillGood(cache.get(key), sig)) return { ok: true, cached: true };
    const hits = await scanChunked(inst, enabledOf(ml));
    cache.set(key, { at: Date.now(), sig, hits });
    return { ok: true, cached: false };
}

// Mods that carry the folder but are switched off in the profile: only asked for when no enabled mod has it, to say why.
function disabledHolders(inst) {
    const ml = readModlist(inst);
    const out = [];
    if (!ml.ok) return out;
    for (const m of ml.mods) if (!m.enabled && modDirsOf(inst.modsDir, m.name).length) out.push(m.name);
    return out;
}

module.exports = { REL_FOLDERS, parseModlist, readModlist, resolveLayers, prewarm, disabledHolders, existingPath, profileNameFor, _clearCache: () => cache.clear() };
