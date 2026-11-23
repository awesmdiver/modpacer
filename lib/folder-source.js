'use strict';
// ModPacer 2.0, part 2 (queue: "ModPacer 2.0, part 2: a folder on this PC as a source"): a folder where the person's own builds land, as a place to follow a mod.
// Public issue 3: a mod developer goes through tens or hundreds of builds, each installed by hand today.
//
// What this file does, and never does:
//   * READ-ONLY and narrow: it lists the folder itself (not its sub-folders, never following a link), looks at archive files only (.zip .7z .rar), and for those only at the
//     NAME, the size and the date. It never opens a file's contents, never runs, writes, moves or deletes anything in the watched folder. The only thing that ever touches a
//     build's bytes is `copyStable` (below), which READS the file and writes a copy somewhere else.
//   * The file-name pattern: the person says once how the files are named ({name}-{version}-{variant}.zip). Six pieces: {name} {version} {variant} {build} {date} {skip};
//     everything else must match exactly. One of {version}, {build} or {date} is required (it is what tells the builds apart; without a {version} the date, or else the build number, is the version). Only the NEWEST build of the (chosen) variant is ever shown; an older one is never listed or installed.
//   * Everything read from a file name is cleaned (no control characters, no slash, backslash or ".." , capped) and is DISPLAY TEXT only: the name of the copy that is
//     handed to the mod manager is made by download-naming.js from the real file name, never from a piece.
//   * A folder that belongs to ModPacer or the mod manager (Vortex's staging and download folders, a Mod Organizer 2 instance's folders, ModPacer's own folders) is refused
//     as a watched folder, so no clean-up of ours can ever reach the person's own archives.

const fs = require('fs');
const path = require('path');
const { compareVersions } = require('./version-compare');

const ARCHIVE_RE = /\.(zip|7z|rar)$/i;
const MAX_PATTERN = 120;
const MAX_FILE_NAME = 200; // longer names are never read (a file name of 255 is at the limit of every file system)
const MAX_ENTRIES = 50000; // a folder with more files than this is only read as far as this
const MAX_TRIED = 5000; // at most this many archive names are read with the pattern (each is one regular-expression run)
const PIECE_NAMES = ['name', 'version', 'variant', 'build', 'date', 'skip'];

// ---- cleaning what is read from a file name ----
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
function cleanPiece(s, max) {
    const t = String(s == null ? '' : s).replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
    if (!t || /[\\/]|\.\./.test(t)) return null; // refused, not repaired: nothing odd is ever shown or saved
    return t;
}
function cleanVersionPiece(s) {
    const t = String(s == null ? '' : s).trim().replace(/^v(?=\d)/i, '');
    if (!/^[A-Za-z0-9.+_-]{1,40}$/.test(t) || compareVersions(t, t) === 'unknown') return null;
    return t;
}
function cleanDatePiece(s) {
    const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${m[1]}-${m[2]}-${m[3]}`;
}
// Words that leave a build out ("beta", "wip"): letters and digits, lower case, at most 10 words of at most 20 characters.
function cleanExcludeWords(input) {
    const list = Array.isArray(input) ? input : String(input == null ? '' : input).split(/[,;\s]+/);
    const out = [];
    for (const w of list) {
        const t = String(w || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
        if (t && !out.includes(t)) out.push(t);
        if (out.length >= 10) break;
    }
    return out;
}

// ---- the pattern ----
const PIECE_RE = {
    name: '(.+?)',
    version: 'v?(\\d+(?:\\.\\d+)*[A-Za-z]?)',
    variant: '(.+?)',
    build: '(\\d{1,9})',
    date: '(\\d{4}-\\d{2}-\\d{2}|\\d{8})',
    skip: '.+?',
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// -> { ok: true, source, regex, fullName, pieces: [names in order] } | { ok: false, reason }
// A pattern that ends with an archive extension is matched against the whole file name; otherwise against the name without its extension (any of the three).
function parsePattern(input) {
    const raw = typeof input === 'string' ? input.trim() : '';
    const bad = (reason) => ({ ok: false, reason });
    if (!raw) return bad('empty');
    if (raw.length > MAX_PATTERN) return bad('too_long');
    if (/[\u0000-\u001f\u007f\\/]/.test(raw) || raw.includes('..')) return bad('bad_characters'); // a file name has no folders in it
    const parts = raw.split(/(\{[^{}]*\})/);
    const seen = {};
    const pieces = [];
    let re = '';
    let freeText = 0;
    let freeTouching = false; // the last piece was free text and nothing but nothing has come since
    for (const part of parts) {
        const m = /^\{([^{}]*)\}$/.exec(part);
        if (!m) { if (/[{}]/.test(part)) return bad('bad_braces'); re += escapeRe(part); if (part !== '') freeTouching = false; continue; }
        const piece = m[1].toLowerCase();
        if (!PIECE_NAMES.includes(piece)) return bad('unknown_piece');
        if (piece !== 'skip' && seen[piece]) return bad('twice');
        seen[piece] = (seen[piece] || 0) + 1;
        if (piece === 'name' || piece === 'variant' || piece === 'skip') {
            // two free pieces side by side ({name}{variant}) can be split a hundred ways: a long name that does not fit makes the regular expression try them all (about 40 ms a name, seconds for a folder)
            if (freeTouching) return bad('free_pieces_touch');
            freeTouching = true;
            freeText++;
        } else freeTouching = false;
        pieces.push(piece);
        re += PIECE_RE[piece];
    }
    if (!seen.version && !seen.build && !seen.date) return bad('no_version'); // something must tell the builds apart: a version, a build number or a date
    if (freeText > 4) return bad('too_many_free');
    const fullName = ARCHIVE_RE.test(raw);
    return { ok: true, source: raw, fullName, pieces, regex: new RegExp(`^${re}$`, 'i') };
}

// One file name read with a compiled pattern. -> { ok: true, name, version, variant, build, date } | { ok: false }
function readName(fileName, compiled) {
    if (typeof fileName !== 'string' || fileName.length > MAX_FILE_NAME || !ARCHIVE_RE.test(fileName)) return { ok: false };
    const subject = compiled.fullName ? fileName : fileName.replace(ARCHIVE_RE, '');
    const m = compiled.regex.exec(subject);
    if (!m) return { ok: false };
    const out = { ok: true, name: null, version: null, variant: null, build: null, date: null };
    let i = 1;
    for (const piece of compiled.pieces) {
        if (piece === 'skip') continue;
        const v = m[i++];
        if (piece === 'name') { out.name = cleanPiece(v, 80); if (!out.name) return { ok: false }; }
        else if (piece === 'version') { out.version = cleanVersionPiece(v); if (!out.version) return { ok: false }; }
        else if (piece === 'variant') { out.variant = cleanPiece(v, 40); if (!out.variant) return { ok: false }; }
        else if (piece === 'build') out.build = Number(v);
        else if (piece === 'date') { out.date = cleanDatePiece(v); if (!out.date) return { ok: false }; }
    }
    // A file with no {version} in its name is told apart by its date, else its build number: that is its "version" here (2026.11.20, or 217).
    if (!out.version) out.version = out.date ? out.date.split('-').join('.') : (out.build != null ? String(out.build) : null);
    if (!out.version) return { ok: false };
    return out;
}

function excluded(fileName, words) {
    if (!words || words.length === 0) return false;
    const tokens = new Set(fileName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    return words.some((w) => tokens.has(w));
}

// -1 / 0 / 1: which build is newer. The version first, then the build number, then the date in the name, then the file's own date. A version that cannot be compared
// falls to the file's own date (never an invented order between two versions that cannot be ordered).
function order(a, b) {
    const c = compareVersions(a.version, b.version);
    if (c === 'newer') return -1;
    if (c === 'older') return 1;
    if (c === 'same') {
        if ((a.build || 0) !== (b.build || 0)) return (a.build || 0) < (b.build || 0) ? -1 : 1;
        if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
    }
    return a.mtimeMs === b.mtimeMs ? 0 : (a.mtimeMs < b.mtimeMs ? -1 : 1);
}

// ---- the folder ----
// What the person's folder holds right now. -> { ok: true, newest, matched, unmatched, variants: [{ variant, fileName, version }] , tooMany }
// | { ok: false, code: 'folder_missing' | 'folder_unreadable' | 'folder_empty' | 'pattern' , sample }
//   `sample`: a file name that could not be read with the pattern (so the page can say which). `options`: { exclude: [words], variant: string | null }
function scan(dir, compiled, options = {}) {
    let st;
    try { st = fs.statSync(dir); } catch { return { ok: false, code: 'folder_missing' }; }
    if (!st.isDirectory()) return { ok: false, code: 'folder_missing' };
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { ok: false, code: 'folder_unreadable' }; }
    const words = cleanExcludeWords(options.exclude);
    const wantVariant = options.variant ? String(options.variant).toLowerCase() : null;
    let archives = 0, tooMany = false, tried = 0;
    let sample = null;
    const found = [];
    for (let i = 0; i < entries.length; i++) {
        if (i >= MAX_ENTRIES) { tooMany = true; break; }
        const e = entries[i];
        if (!e.isFile() || e.isSymbolicLink() || !ARCHIVE_RE.test(e.name)) continue; // archives only; a link is never followed
        archives++;
        if (excluded(e.name, words)) continue;
        if (++tried > MAX_TRIED) { tooMany = true; continue; } // counted as an archive above, not read
        const r = readName(e.name, compiled);
        if (!r.ok) { if (!sample) sample = e.name; continue; }
        found.push({ fileName: e.name, ...r });
    }
    if (found.length === 0) return { ok: false, code: archives === 0 ? 'folder_empty' : 'pattern', sample: sample ? cleanPiece(sample, 120) : null, archives };
    // the newest of each variant (so the page can offer a choice), and the newest overall of the wanted one
    const stat = (f) => { try { const s = fs.statSync(path.join(dir, f.fileName)); f.size = s.size; f.mtimeMs = s.mtimeMs; } catch { f.size = 0; f.mtimeMs = 0; f.gone = true; } return f; };
    // the file's own date is only needed to break ties: look at the files whose version ties for the best first, the others never
    for (const f of found) { f.size = 0; f.mtimeMs = 0; }
    const pick = (list) => {
        let best = null;
        for (const f of list) {
            if (!best) { best = f; continue; }
            let c = order(f, best);
            if (c === 0 || (compareVersions(f.version, best.version) === 'unknown')) { stat(f); stat(best); c = order(f, best); }
            if (c > 0) best = f;
        }
        return best ? stat(best) : null;
    };
    const byVariant = new Map();
    for (const f of found) { const k = (f.variant || '').toLowerCase(); if (!byVariant.has(k)) byVariant.set(k, []); byVariant.get(k).push(f); }
    const variants = [];
    for (const list of byVariant.values()) { const b = pick(list); if (b) variants.push({ variant: b.variant || null, fileName: b.fileName, version: b.version, mtimeMs: b.mtimeMs }); }
    const pool = wantVariant ? found.filter((f) => (f.variant || '').toLowerCase() === wantVariant) : found;
    if (pool.length === 0) return { ok: false, code: 'variant_missing', variants };
    const newest = pick(pool);
    variants.sort((a, b) => order(b, a)); // the variant with the newest build first
    return { ok: true, newest: { fileName: newest.fileName, name: newest.name, version: newest.version, variant: newest.variant, build: newest.build, date: newest.date, size: newest.size, mtimeMs: newest.mtimeMs }, matched: found.length, unmatched: archives - found.length, variants, tooMany };
}

// ---- which folders may be watched ----
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
function realOf(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }
function inside(child, parent) {
    const c = realOf(child), p = realOf(parent);
    if (samePath(c, p)) return true;
    const rel = path.relative(p, c);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
// `forbidden`: [{ path, label }]. -> { ok: true, dir } | { ok: false, code }
function checkAllowed(dir, forbidden = []) {
    if (typeof dir !== 'string' || !dir.trim() || dir.length > 400 || /[\u0000-\u001f]/.test(dir)) return { ok: false, code: 'bad_path' };
    if (!path.isAbsolute(dir)) return { ok: false, code: 'bad_path' };
    let st;
    try { st = fs.statSync(dir); } catch { return { ok: false, code: 'folder_missing' }; }
    if (!st.isDirectory()) return { ok: false, code: 'folder_missing' };
    for (const f of forbidden) {
        if (f && f.path && inside(dir, f.path)) return { ok: false, code: 'folder_refused', why: f.label || 'folder' };
    }
    return { ok: true, dir: realOf(dir) };
}
// True when `file` is inside one of the watched folders: used by any code that is about to delete a file, so the person's own builds are never removed.
function isInsideAny(file, folders) {
    if (!file || !Array.isArray(folders)) return false;
    return folders.some((d) => d && inside(file, d));
}

// ---- the copy handed to the mod manager ----
// Copies a build to `destPath` (somewhere that is ModPacer's / the mod manager's downloads folder, never the watched folder), after checking it is not still being written:
// its size and date are read, `stableMs` later read again, and they must be the same. The copy is written as `<dest>.part`, checked to be the size that was read, the source is
// read once more (it must still be the same), and only then renamed into place. The source is only ever READ.
// -> { bytes } ; throws an Error with `.code` 'still_writing' | 'folder_missing' | 'copy_failed'
async function copyStable(srcPath, destPath, { stableMs = 4000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const fail = (code, message) => Object.assign(new Error(message), { code, warn: true }); // `warn`: the row shows it as an amber line, not a red one
    const same = (a, b) => a.size === b.size && a.mtimeMs === b.mtimeMs;
    let s1;
    try { s1 = fs.statSync(srcPath); } catch { throw fail('folder_missing', 'That build is no longer in the folder.'); }
    if (!s1.isFile()) throw fail('folder_missing', 'That build is no longer in the folder.');
    await sleep(stableMs);
    let s2;
    try { s2 = fs.statSync(srcPath); } catch { throw fail('folder_missing', 'That build is no longer in the folder.'); }
    if (!same(s1, s2)) throw fail('still_writing', 'That build is still being written.');
    const part = [destPath, 'part'].join('.');
    try { fs.rmSync(part, { force: true }); } catch { /* a stale half copy of ours */ }
    try {
        fs.copyFileSync(srcPath, part, fs.constants.COPYFILE_EXCL);
        const copied = fs.statSync(part);
        let s3;
        try { s3 = fs.statSync(srcPath); } catch { throw fail('still_writing', 'That build is still being written.'); }
        if (copied.size !== s2.size || !same(s2, s3)) throw fail('still_writing', 'That build is still being written.');
        fs.renameSync(part, destPath);
    } catch (e) {
        try { fs.rmSync(part, { force: true }); } catch { /* the half copy is ours; best effort */ }
        if (e && e.code && ['still_writing', 'folder_missing'].includes(e.code)) throw e;
        throw fail('copy_failed', 'ModPacer could not copy that build.');
    }
    return { bytes: s2.size };
}

module.exports = { parsePattern, readName, scan, checkAllowed, isInsideAny, copyStable, cleanExcludeWords, cleanPiece, cleanVersionPiece, order, ARCHIVE_RE, PIECE_NAMES, MAX_PATTERN };
