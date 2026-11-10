'use strict';
// The programs (lib/program-listings.js) the person says they have, and which version (programs-have.json in ModPacer's own data folder).
// ModPacer cannot see a program in Vortex, so this is its only way to watch one for updates. Nothing here touches Vortex.
//
// File shape: { version: 1, programs: { "<hub plugin id, lower case>": { version: "4.2.0", at: "<ISO time>" } } }
// Only the person's buttons write it (never a check). A file that is missing, damaged or of another version counts as an empty list.
// A program the Hub stops listing stays in the file; it is just not drawn.

const fs = require('fs');
const path = require('path');
const { dataPath } = require('./data-dir');

const FILE_VERSION = 1;
const lc = (s) => String(s || '').toLowerCase();
function file() { return dataPath('programs-have.json'); }

function readAll() {
    try {
        const p = JSON.parse(fs.readFileSync(file(), 'utf8'));
        if (!p || p.version !== FILE_VERSION || !p.programs || typeof p.programs !== 'object' || Array.isArray(p.programs)) return {};
        const out = {};
        for (const [id, rec] of Object.entries(p.programs)) if (rec && typeof rec.version === 'string' && rec.version.trim()) out[lc(id)] = { version: rec.version.trim(), at: typeof rec.at === 'string' ? rec.at : null };
        return out;
    } catch {
        return {};
    }
}

// Atomic: a temp file in the same folder, then a rename.
function writeAll(programs) {
    const target = file();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, programs }, null, 2), 'utf8');
    fs.renameSync(tmp, target);
}

function set(id, version) {
    const v = String(version == null ? '' : version).trim().slice(0, 64);
    if (!id || !v) return false;
    const all = readAll();
    all[lc(id)] = { version: v, at: new Date().toISOString() };
    writeAll(all);
    return true;
}

function remove(id) {
    const all = readAll();
    if (!(lc(id) in all)) return false;
    delete all[lc(id)];
    writeAll(all);
    return true;
}

module.exports = { readAll, set, remove, file };
