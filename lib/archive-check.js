'use strict';
// Is a downloaded archive complete? Asked before a file is reused as "already downloaded and current", and right after a download ends
// (2026-10-28: a 900 KB piece of a 24 MB zip sat under the final name and counted as current, then failed every install with 7-Zip's whole listing).
// Three questions, cheapest first: the file is there; it is the size the source promised (when it promised one); 7-Zip can list it (a zip, 7z or
// rar that was cut off cannot be opened: their index sits at the end). A listing is used, not 7-Zip's full test: the test trips on healthy zips
// with an odd NTFS field ("Incorrect reparse stream", see sevenzip.js), the listing does not. Nothing here changes any file.

const fs = require('fs');
const sevenzip = require('./sevenzip');

// -> null when the archive looks complete (or cannot be judged: 7-Zip is not there), else
//    { kind: 'missing' | 'size' | 'unreadable', have, want, detail } -- detail is 7-Zip's own text, for a debug line only, never shown.
async function problem(archivePath, { expectedSize = null } = {}) {
    let have;
    try { have = fs.statSync(archivePath).size; } catch { return { kind: 'missing', have: null, want: expectedSize, detail: null }; }
    if (expectedSize != null && have !== expectedSize) return { kind: 'size', have, want: expectedSize, detail: null };
    if (process.env.MODPACER_TEST_SKIP_LISTING === '1') return null; // tests that download made-up bytes (not real archives) turn the 7-Zip listing off; the size check stays
    try {
        await sevenzip.listArchive(sevenzip.findSevenZip(), archivePath);
    } catch (e) {
        if (e && (e.code === 'ENOENT' || e.code === 'EACCES')) return null; // 7-Zip cannot run here: the install step says so in its own words
        if (e && e.sevenZipDetail !== undefined) return { kind: 'unreadable', have, want: expectedSize, detail: e.sevenZipDetail };
        return null; // anything else is not a statement about this file
    }
    return null;
}

const n = (x) => Number(x).toLocaleString('en-US');

// One plain line for the log: what is wrong with the file, without 7-Zip's text.
function describe(p) {
    if (!p) return '';
    if (p.kind === 'missing') return 'the downloaded file is not there';
    if (p.want != null) return `the downloaded file is incomplete (${n(p.have)} of ${n(p.want)} bytes)`;
    return `the downloaded file is incomplete (${n(p.have)} bytes, and 7-Zip cannot open it)`;
}

// The first few lines of 7-Zip's text, for a debug line.
function debugText(p) {
    return p && p.detail ? p.detail.split(/\r?\n/).filter(Boolean).slice(-6).join(' | ').slice(0, 400) : '';
}

module.exports = { problem, describe, debugText };
