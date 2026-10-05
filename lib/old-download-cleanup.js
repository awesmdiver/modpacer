'use strict';
// "Check the old downloads are really gone" (queue: finish-by-checking-old-downloads-are-gone, 2026-10-04).
//
// When "Delete old download after a successful update" is on, every updated mod's old archive has to be gone from the downloads
// folder AND no longer listed as a download in Vortex. The delete inside the update itself (vortex-update.js deleteOldDownload)
// needs Vortex to answer, so a busy or hung Vortex left old archives behind. Every update therefore leaves a short PENDING entry
// (state.json, via download-state.js) until the old download is confirmed gone; this pass works through the list, now and on every
// later chance (after a batch, after Try again, on a check, on start).
//
// Safety, in order: never anything outside the configured downloads folder; never the new version's file; never a file that is
// not provably the old one (its recorded hash, or, with no hash, a record Vortex itself ties to the old mod's archive id).
// When Vortex can't be asked, the file is still deleted (when proven) but the entry stays pending: only Vortex can drop its own
// list entry, so "done" is never claimed without asking it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const appConfig = require('./app-config');
const helperClient = require('./vortex-helper-client');
const downloadState = require('./download-state');
const vctRemoval = require('./vct-removal');
const updateLog = require('./update-log');

// Reasons the update itself chose to leave an old download alone on purpose: nothing is pending for these.
const LEFT_ALONE_ON_PURPOSE = ['still_referenced', 'no_identity', 'not_certain'];

function hashFileMd5(filePath) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('md5');
        fs.createReadStream(filePath).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
    });
}

// The file's path inside the downloads folder, or null when it would point anywhere else.
function insideDownloads(downloadFolder, fileName) {
    if (!downloadFolder || !fileName) return null;
    const full = path.resolve(downloadFolder, fileName);
    const rel = path.relative(path.resolve(downloadFolder), full);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return full;
}

// One pending entry. Returns { done, reason }.
async function cleanOne(entry, cfg, log) {
    const target = insideDownloads(cfg.downloadFolder, entry.fileName);
    if (!target) { log('left alone: the old file is not inside the downloads folder'); return { done: true, reason: 'outside_downloads' }; }
    if (entry.newFileName && path.resolve(cfg.downloadFolder, entry.newFileName).toLowerCase() === target.toLowerCase()) {
        log('left alone: the old and new versions are the same file'); return { done: true, reason: 'same_file' };
    }

    // A file on disk that is not the old version (its hash is not the saved one) is never touched.
    if (entry.md5 && fs.existsSync(target)) {
        let same = false;
        try { same = (await hashFileMd5(target)) === entry.md5; } catch { same = false; }
        if (!same) { log('left alone: the file on disk could not be proven to be the old version'); return { done: true, reason: 'not_certain' }; }
    }

    // The same code the update itself uses (lib/vct-removal.js, ported from Vortex Collection Tools' Update Collection): the archive is found by its MD5, its file is
    // deleted with the same plain delete, then its Vortex record is removed through the Bridge. Vortex must answer: nothing is deleted without it.
    const mods = await helperClient.getAllMods();
    const r = await vctRemoval.removeOldArchive({
        oldDownload: { archiveId: entry.archiveId || null, md5: entry.md5 || null, fileName: entry.fileName, fileSize: entry.fileSize || null },
        allMods: (mods && mods.mods) || {}, excludeIds: [entry.oldModId, entry.newModId], cfg, log,
    });
    if (r.deleted === true || r.deleted === 'record_only') { log('old download is gone from the folder and from Vortex'); return { done: true, reason: r.deleted === true ? 'gone' : 'shared_file' }; }
    if (LEFT_ALONE_ON_PURPOSE.includes(r.reason)) return { done: true, reason: r.reason };
    if (r.reason === 'downloads_unavailable') return { done: false, reason: 'vortex_not_asked' };
    if (r.reason === 'outside_downloads') return { done: true, reason: r.reason };
    if (r.reason === 'not_proven') return { done: true, reason: 'not_certain' };
    if (r.reason === 'not_found') return { done: true, reason: 'gone' };
    return { done: false, reason: r.fileGone === false ? 'file_still_there' : (r.recordGone === false ? 'still_listed' : (r.reason || 'unfinished')) };
}

let running = null;

// Works through every pending entry that is not waiting on its mod's rules. Never throws. Returns { cleaned, pending }.
function runCleanup() {
    if (running) return running;
    running = (async () => {
        let cleaned = 0;
        try {
            const cfg = appConfig.loadConfig();
            if (!cfg.deleteOldDownloadAfterUpdate) return { cleaned, pending: downloadState.pendingCleanup().length };
            for (const entry of downloadState.pendingCleanup()) {
                if (entry.waitingOnRules) continue;
                const log = (m) => updateLog.logUpdate(`[${entry.pluginId}] old download check: ${m}`);
                let r;
                try { r = await cleanOne(entry, cfg, log); } catch (e) { log(`stopped by an error: ${e.message}`); r = { done: false }; }
                if (r.done) { downloadState.removePendingCleanup(entry.pluginId, entry.fileName); cleaned++; }
            }
        } catch (e) {
            updateLog.logUpdate(`old download check stopped by an error: ${e.message}`);
        }
        return { cleaned, pending: downloadState.pendingCleanup().length };
    })().finally(() => { running = null; });
    return running;
}

function isRunning() { return !!running; }

module.exports = { runCleanup, isRunning, cleanOne, insideDownloads, LEFT_ALONE_ON_PURPOSE };
