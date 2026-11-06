'use strict';
// "Remember my choice" for a release with several files that could each be the mod (queue: a-release-with-several-files-lets-you-choose-one-or-get-an-extra...,
// 2026-11-05). What is remembered, per mod, is the SHAPE of the chosen file's name with the version cut out ("ostimnet_v{version}_skyrimnet_v25"), not the file:
// the next release has another version in its names, and the one file with the same shape is the same choice. None or two files with that shape means the choice
// no longer fits, and the person is asked again.
// Plain data in ModPacer's own data folder (file-choices.json), no secrets, written atomically; a file that cannot be read counts as empty. The uninstaller's
// "also delete my settings" removes it (installer/modpacer.nsi).
// File shape: { version: 1, choices: { "<plugin id>": { shape, savedAt } } }

const fs = require('fs');
const path = require('path');
const { dataPath } = require('./data-dir');

const FILE_VERSION = 1;
const ARCHIVE_EXT_RE = /\.(7z|zip|rar)$/i;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function file() { return dataPath('file-choices.json'); }

function readAll() {
    try {
        const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
        if (!parsed || parsed.version !== FILE_VERSION || !parsed.choices || typeof parsed.choices !== 'object' || Array.isArray(parsed.choices)) return {};
        return parsed.choices;
    } catch {
        return {};
    }
}
function writeAll(choices) {
    const target = file();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, choices }, null, 2), 'utf8');
    fs.renameSync(tmp, target);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The file name without its extension, lower case, with every given version (the new one and the old one, wherever they appear, with or without a "v") replaced by {version}.
function shapeOf(fileName, versions = []) {
    let s = String(fileName || '').replace(ARCHIVE_EXT_RE, '').toLowerCase();
    const list = [...new Set((versions || []).map((v) => String(v || '').trim().replace(/^v/i, '').toLowerCase()).filter(Boolean))].sort((a, b) => b.length - a.length);
    for (const v of list) s = s.replace(new RegExp(`(?<![0-9])${escapeRe(v)}(?![0-9])`, 'g'), '{version}');
    return s;
}

function get(pluginId) {
    const all = readAll();
    return has(all, pluginId) ? all[pluginId] : null;
}
// Every mod that has a saved choice, read once (the page's state asks for all rows at a time).
function ids() { return new Set(Object.keys(readAll())); }
function has_(pluginId) { return get(pluginId) !== null; }
function save(pluginId, shape) {
    if (!pluginId || !shape) return false;
    const all = readAll();
    all[pluginId] = { shape, savedAt: new Date().toISOString() };
    writeAll(all);
    return true;
}
function forget(pluginId) {
    const all = readAll();
    if (!has(all, pluginId)) return false;
    delete all[pluginId];
    writeAll(all);
    return true;
}

// Of these files ({ name }), the ones that fit the saved shape for this mod. -> { saved: bool, matches: [asset] }
function matchSaved(pluginId, assets, versions) {
    const rec = get(pluginId);
    if (!rec) return { saved: false, matches: [] };
    return { saved: true, matches: (assets || []).filter((a) => shapeOf(a.name, versions) === rec.shape) };
}

module.exports = { shapeOf, get, ids, has: has_, save, forget, matchSaved, file };
