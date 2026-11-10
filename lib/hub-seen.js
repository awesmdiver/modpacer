'use strict';
// The Hub mods ModPacer has already counted (hub-seen.json in ModPacer's own settings folder), so a mod just added to the Hub can show in the
// New section once. Plain data, no secrets.
//
// File shape: { version: 1, seen: ["author.slug", ...], shown: ["author.slug", ...] }
//   seen  = ids already counted: they are never New again.
//   shown = ids the page drew in the New section but that stay New until the next check or start moves them onto `seen`.
// The list only ever grows: a catalog that is empty or could not be read never writes, seeds or wipes anything. A file that cannot be read or has
// another version number is treated as missing (the next readable check seeds it again, so nothing shouts New).

const fs = require('fs');
const path = require('path');
const { dataPath } = require('./data-dir');

const FILE_VERSION = 1;
const lc = (s) => String(s || '').toLowerCase();

function file() { return dataPath('hub-seen.json'); }

// -> { exists, seen: Set, shown: Set }
function read() {
    try {
        const p = JSON.parse(fs.readFileSync(file(), 'utf8'));
        if (!p || p.version !== FILE_VERSION || !Array.isArray(p.seen) || !Array.isArray(p.shown || [])) return { exists: false, seen: new Set(), shown: new Set() };
        const ids = (a) => new Set((a || []).filter((x) => typeof x === 'string' && x).map(lc));
        return { exists: true, seen: ids(p.seen), shown: ids(p.shown) };
    } catch {
        return { exists: false, seen: new Set(), shown: new Set() };
    }
}

// Atomic: a temp file in the same folder, then a rename, so a crash never leaves half a file. ModPacer is the only writer.
function write(rec) {
    const target = file();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, seen: [...rec.seen].sort(), shown: [...rec.shown].sort() }, null, 2), 'utf8');
    fs.renameSync(tmp, target);
}

// One check's turn. catalogIds: every id the (readable) catalog lists. candidateIds: the not-installed listings, in the order wanted.
// -> { firstStart, moved: [ids], newIds: [ids from candidateIds that are New] }
// An empty catalog changes nothing and shows nothing.
function applyCheck(catalogIds, candidateIds) {
    const catalog = (catalogIds || []).map(lc).filter(Boolean);
    if (catalog.length === 0) return { firstStart: false, moved: [], newIds: [] };
    const rec = read();
    if (!rec.exists) {
        write({ seen: new Set(catalog), shown: new Set() });
        return { firstStart: true, moved: [], newIds: [], seededCount: new Set(catalog).size };
    }
    let changed = false;
    const moved = [];
    for (const id of rec.shown) { if (!rec.seen.has(id)) { rec.seen.add(id); moved.push(id); } }
    if (rec.shown.size > 0) { rec.shown = new Set(); changed = true; }
    // Counted: every catalog entry that is not a not-installed candidate (installed, by hand, waiting to deploy, a bundle, hidden) is never New later.
    const cand = new Set((candidateIds || []).map(lc));
    for (const id of catalog) if (!cand.has(id) && !rec.seen.has(id)) { rec.seen.add(id); changed = true; }
    if (changed) write(rec);
    return { firstStart: false, moved, newIds: (candidateIds || []).filter((id) => !rec.seen.has(lc(id))) };
}

// The page says it drew these New ids. Only ids that are New right now are kept (currentNewIds); they wait on `shown` until the next check.
// -> the ids accepted.
function noteShown(ids, currentNewIds) {
    const now = new Set((currentNewIds || []).map(lc));
    const asked = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string').map(lc).filter((id) => now.has(id));
    if (asked.length === 0) return [];
    const rec = read();
    if (!rec.exists) return []; // nothing seeded yet: nothing can be New, so nothing is shown
    let changed = false;
    for (const id of asked) if (!rec.seen.has(id) && !rec.shown.has(id)) { rec.shown.add(id); changed = true; }
    if (changed) write(rec);
    return asked;
}

module.exports = { applyCheck, noteShown, read, file };
