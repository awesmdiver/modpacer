'use strict';
// "Is this a dummy master (stub)?" (queue: ask-is-this-a-dummy-master-stub-..., 2026-11-19). A person who removed a mod but kept an empty placeholder plugin so an
// old save still loads leaves a mod folder holding only that plugin. Its name matches the Hub listing, so ModPacer counted the listing as installed.
// This file only READS (never touches Vortex, Mod Organizer 2 or their folders):
//   - isHeaderOnly(bytes): is a plugin only its header (no records)? Read from the bytes, never from the size alone.
//   - inspectModDir(dir, ctx): is everything the mod holds a header-only plugin, with no real content anywhere else (its folder, Vortex's downloads, Overwrite)?
//   - the person's saved answers (dummy-masters.json in ModPacer's own data folder, the pattern of programs-have.json), and the judge a check uses.
// Anything short of all of it says nothing and today's behaviour stays: ModPacer never guesses that a real mod is a placeholder.
//
// File shape: { version: 1, answers: { "<hub id, lower case>": { answer: "yes" | "no", fingerprint: "<sha1>", mod: "<mod folder name>", at: "<ISO time>" } } }
// A file that is missing, damaged or of another version counts as an empty list.
// Vortex's own "Dummy plugin" flag is not in what the Vortex Bridge returns (GET /plugins/:name has enabled and loadOrder only), so the header test is the whole test for now.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataPath } = require('./data-dir');
const nameMatch = require('./vortex-name-match');

const HEADER_LEN = 24;            // a plugin record header: type(4) dataSize(4) flags(4) formId(4) versionControl(4) formVersion(2) unknown(2)
const MAX_PLUGIN_BYTES = 64 * 1024; // a header with its masters is far smaller than this; a bigger file is real content without reading it
const PLUGIN_RE = /\.(esp|esm|esl)(\.ghost)?$/i;
const FILE_VERSION = 1;

// Pure. True only when the bytes are a plugin made of its TES4 header record alone: the right type, the file ends exactly where the header's data ends (no groups
// after it), the header's own record count is zero. The subrecords are walked inside the declared size, so a damaged file is never header-only.
function isHeaderOnly(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < HEADER_LEN) return false;
    if (buf.toString('latin1', 0, 4) !== 'TES4') return false;
    const dataSize = buf.readUInt32LE(4);
    if (HEADER_LEN + dataSize !== buf.length) return false;
    let at = HEADER_LEN;
    let records = null;
    while (at < buf.length) {
        if (at + 6 > buf.length) return false;
        const type = buf.toString('latin1', at, at + 4);
        const size = buf.readUInt16LE(at + 4);
        if (type === 'XXXX') return false; // an oversized subrecord is never in a placeholder
        if (at + 6 + size > buf.length) return false;
        if (type === 'HEDR') {
            if (size < 12) return false;
            records = buf.readUInt32LE(at + 6 + 4); // HEDR: version (float), number of records, next object id
        }
        at += 6 + size;
    }
    return records === 0;
}

function sha1(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }
function readSmall(p) {
    try {
        const st = fs.statSync(p);
        if (!st.isFile() || st.size > MAX_PLUGIN_BYTES) return { big: st.isFile() };
        return { bytes: fs.readFileSync(p) };
    } catch { return { error: true }; }
}

// The plugins directly inside `dir`, or Data\ inside it. -> { real: true } | { files: [{ name, headerOnly, size, hash }] , unreadable }
function scanFolder(dir, isData) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { unreadable: true, files: [] }; }
    const files = [];
    for (const e of entries) {
        if (e.isFile()) {
            if (PLUGIN_RE.test(e.name)) {
                const r = readSmall(path.join(dir, e.name));
                if (r.error) return { unreadable: true, files: [] };
                if (r.big || !isHeaderOnly(r.bytes)) return { real: true, files: [] };
                files.push({ name: e.name.replace(/\.ghost$/i, ''), size: r.bytes.length, hash: sha1(r.bytes) });
            } else if (!(!isData && /^meta\.ini$/i.test(e.name))) return { real: true, files: [] }; // anything else (a manifest, a texture, ...) is real content; Mod Organizer 2's own meta.ini is not
        } else if (e.isDirectory()) {
            if (isData || !/^data$/i.test(e.name)) return { real: true, files: [] }; // no other folder at all (SKSE\, textures\, ...); Data\ only at the top
            const inner = scanFolder(path.join(dir, e.name), true);
            if (inner.unreadable || inner.real) return inner;
            files.push(...inner.files);
        } else return { real: true, files: [] };
    }
    return { files };
}

// What is sitting in Vortex's (or Mod Organizer 2's) downloads folder, as cleaned names: a download named like the mod means it was a real mod once. One readdir.
function buildDownloadsIndex(folder) {
    const out = new Set();
    if (!folder) return out;
    try {
        for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
            if (!e.isFile()) continue;
            const stem = e.name.replace(/\.(zip|7z|rar|7zip)$/i, '');
            const k = nameMatch.compact(nameMatch.cleanVortexName(stem));
            if (k) out.add(k);
        }
    } catch { /* an unreadable downloads folder proves nothing either way */ }
    return out;
}

function normFolder(s) { return nameMatch.compact(s); }
// Mod Organizer 2's Overwrite: the same plugin names there must be header-only too, and there is no SKSE\Plugins\<folder> named like the mod.
function overwriteHasRealContent(overwriteDirs, pluginNames, modName) {
    const want = normFolder(modName);
    for (const ow of overwriteDirs || []) {
        for (const base of [ow, path.join(ow, 'Data')]) {
            for (const n of pluginNames) {
                for (const cand of [n, `${n}.ghost`]) {
                    const p = path.join(base, cand);
                    if (!fs.existsSync(p)) continue;
                    const r = readSmall(p);
                    if (r.error || r.big || !isHeaderOnly(r.bytes)) return true;
                }
            }
            if (want.length >= 3) {
                let names = [];
                try { names = fs.readdirSync(path.join(base, 'SKSE', 'Plugins'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { names = []; }
                if (names.some((n) => normFolder(n) === want)) return true;
            }
        }
    }
    return false;
}

// -> { state: 'dummy' | 'real' | 'unreadable', fingerprint }.
// ctx: { modName, archiveName, downloadsFolder, downloadsIndex (a Set from buildDownloadsIndex), overwriteDirs }
function inspectModDir(dir, ctx = {}) {
    if (!dir) return { state: 'unreadable', fingerprint: null };
    const scan = scanFolder(dir, false);
    if (scan.unreadable) return { state: 'unreadable', fingerprint: null };
    if (scan.real || scan.files.length === 0) return { state: 'real', fingerprint: null };
    const key = normFolder(nameMatch.cleanVortexName(ctx.modName || path.basename(dir)));
    if (key && ctx.downloadsIndex && ctx.downloadsIndex.has(key)) return { state: 'real', fingerprint: null };
    if (ctx.archiveName && ctx.downloadsFolder) { try { if (fs.existsSync(path.join(ctx.downloadsFolder, String(ctx.archiveName)))) return { state: 'real', fingerprint: null }; } catch { /* nothing proven */ } }
    if (overwriteHasRealContent(ctx.overwriteDirs, scan.files.map((f) => f.name), ctx.modName || path.basename(dir))) return { state: 'real', fingerprint: null };
    const lines = scan.files.map((f) => `${f.name.toLowerCase()}|${f.size}|${f.hash}`).sort();
    return { state: 'dummy', fingerprint: sha1(Buffer.from(lines.join('\n'))) };
}

// Only the folder's own plugins, with no download or Overwrite look (inspectModDir does those): true when it holds plugins and every one is header-only and nothing
// else is there; false when anything real is; null when the folder cannot be read (a missing answer is never "header-only"). Used by lib/unverified-installed.js.
function headerOnlyFolder(dir) {
    if (!dir) return null;
    const scan = scanFolder(dir, false);
    if (scan.unreadable) return null;
    if (scan.real) return false;
    return scan.files.length > 0;
}

// ---- the person's saved answers ----
const lc = (s) => String(s || '').toLowerCase();
function file() { return dataPath('dummy-masters.json'); }
function readAll() {
    try {
        const p = JSON.parse(fs.readFileSync(file(), 'utf8'));
        if (!p || p.version !== FILE_VERSION || !p.answers || typeof p.answers !== 'object' || Array.isArray(p.answers)) return {};
        const out = {};
        for (const [id, rec] of Object.entries(p.answers)) {
            if (rec && (rec.answer === 'yes' || rec.answer === 'no') && typeof rec.fingerprint === 'string') out[lc(id)] = { answer: rec.answer, fingerprint: rec.fingerprint, mod: typeof rec.mod === 'string' ? rec.mod : '', at: typeof rec.at === 'string' ? rec.at : null };
        }
        return out;
    } catch { return {}; }
}
// Atomic: a temp file in the same folder, then a rename.
function writeAll(answers) {
    const target = file();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, answers }, null, 2), 'utf8');
    fs.renameSync(tmp, target);
}
function setAnswer(id, answer, fingerprint, mod) {
    if (!id || (answer !== 'yes' && answer !== 'no') || typeof fingerprint !== 'string' || !fingerprint) return false;
    const all = readAll();
    all[lc(id)] = { answer, fingerprint, mod: String(mod || '').slice(0, 200), at: new Date().toISOString() };
    writeAll(all);
    return true;
}
function removeAnswer(id) {
    const all = readAll();
    if (!(lc(id) in all)) return false;
    delete all[lc(id)];
    writeAll(all);
    return true;
}

// One per check. judge() decides for a Hub listing that a mod folder would make "installed":
//   'exclude' = the person said Yes and it is still only a placeholder (or it cannot be looked at right now: the answer stands)
//   'ask'     = it looks like a placeholder and nothing is answered (or the files changed since a No)
//   'none'    = say nothing, count it as installed as before
// It also drops a saved answer once real content shows up. excluded / asked collect what the page needs: id -> { fingerprint, mod }.
function makeJudge({ downloadsFolder = null, overwriteDirs = [], log = () => {}, entries = [], dropEntry = () => {} } = {}) {
    const answers = readAll();
    // A Yes lives in the same list as the Exclude button (excludedMods, reason 'dummy-master'); an older Yes still in this file counts too.
    for (const e of entries || []) if (e && e.reason === 'dummy-master' && e.id) answers[lc(e.id)] = { answer: 'yes', fingerprint: String(e.fingerprint || ''), mod: String(e.mod || ''), at: e.excludedAt || null };
    const drop = (hubId) => { removeAnswer(hubId); delete answers[lc(hubId)]; try { dropEntry(hubId); } catch { /* the list is tidied at the next check */ } };
    let index = null;
    const excluded = new Map();
    const asked = new Map();
    const downloadsIndex = () => { if (!index) index = buildDownloadsIndex(downloadsFolder); return index; };
    function judge(hubId, { dir, modName, archiveName } = {}) {
        const rec = answers[lc(hubId)] || null;
        const insp = inspectModDir(dir, { modName, archiveName, downloadsFolder, downloadsIndex: downloadsIndex(), overwriteDirs });
        if (insp.state === 'unreadable') {
            if (rec && rec.answer === 'yes') { excluded.set(hubId, { fingerprint: rec.fingerprint, mod: rec.mod || modName || '' }); return 'exclude'; }
            return 'none';
        }
        if (insp.state === 'real') {
            if (rec) { drop(hubId); log(`dummy master: ${modName || hubId} has real content now, so the saved answer was dropped`); }
            return 'none';
        }
        if (rec && rec.answer === 'yes') { excluded.set(hubId, { fingerprint: insp.fingerprint, mod: modName || rec.mod }); return 'exclude'; }
        if (rec && rec.answer === 'no' && rec.fingerprint === insp.fingerprint) return 'none';
        if (rec) drop(hubId); // a No for files that have since changed: ask again
        asked.set(hubId, { fingerprint: insp.fingerprint, mod: modName || '' });
        return 'ask';
    }
    // Vortex could not be read right now: only a saved Yes can still be honoured (no pairing was made, so nothing was looked at).
    function rememberedYes(hubId) {
        const rec = answers[lc(hubId)];
        if (!rec || rec.answer !== 'yes') return false;
        excluded.set(hubId, { fingerprint: rec.fingerprint, mod: rec.mod });
        return true;
    }
    return { judge, rememberedYes, excluded, asked };
}

module.exports = { isHeaderOnly, headerOnlyFolder, inspectModDir, buildDownloadsIndex, readAll, setAnswer, removeAnswer, makeJudge, file, HEADER_LEN };
