'use strict';
// How an old mod and its archive are removed -- PORTED from Vortex Collection Tools (queue: modpacer-removes-the-old-mod-and-archive-exactly-the-way-
// vortex-collection-tools-update-collection-does, 2026-10-05; director: "Use the exact way in VCT Update Collection in ModPacer too. The idea is we reuse the
// same code and do everything that exact same way.").
//
// Ported from Vortex Collection Tools, lib/update-collection-v2-runner.js, lib/remove-collection-runner.js, lib/cleanup-scan.js and lib/archive-locator.js
// (a separate repository, so the logic is copied here, not required; names and comments are kept recognisable):
//   - stagingHasRealFiles           update-collection-v2-runner.js (hoisted there for remove-collection-runner.js): a folder that exists but holds no real file
//                                   is "already deleted" as far as Vortex's undeploy is concerned.
//   - the mod-removal choice        remove-collection-runner.js, applyRemoval (about lines 196 to 262): when the mod's staging folder really has files AND its archive
//                                   exists, ONE real `removeMods` call (Vortex's own removal: undeploys, deletes the staging folder, removes the record);
//                                   otherwise `removeModsRecordOnly`, because Vortex shows a blocking "Mod not found" dialog when it is asked to undeploy a
//                                   folder that no longer exists.
//   - locateArchive / findCandidates  archive-locator.js: the archive on disk by its exact size and MD5 (a few bytes of tolerance), never by name alone.
//   - deleteStaleArchive            update-collection-v2-runner.js (about line 2500): the archive is found in the Bridge's downloads list by its MD5.
//   - deleteEntries                 cleanup-scan.js: the one file-delete primitive, a plain fs.rmSync per path with its own try/catch per path.
// Update Collection never asks the Bridge's /downloads/remove (on the director's Vortex that call fails: "api.removeDownload is not a function"): it deletes the
// archive FILE itself with deleteEntries. Here the Vortex download RECORD is then removed through the Bridge (record-only), so the Bridge's list agrees.
// Differences from the originals: ModPacer removes ONE old mod, not a collection's list; the safety checks below (the file is inside the downloads folder,
// nothing else uses it, it is provably the old file) are ModPacer's own and are applied on top of the originals' guards, never instead of them.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const helperClient = require('./vortex-helper-client');

// ---- ported verbatim in logic ----

// cleanup-scan.js deleteEntries
function deleteEntries(paths) {
    const results = [];
    for (const p of paths) {
        try {
            fs.rmSync(p, { recursive: true, force: false });
            results.push({ path: p, ok: true });
        } catch (e) {
            results.push({ path: p, ok: false, error: e.message });
        }
    }
    return results;
}

// update-collection-v2-runner.js stagingHasRealFiles
function stagingHasRealFiles(dirPath) {
    let entries;
    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
        return false;
    }
    for (const entry of entries) {
        if (entry.isFile()) return true;
        if (entry.isDirectory() && stagingHasRealFiles(path.join(dirPath, entry.name))) return true;
    }
    return false;
}

function hashFileMd5(filePath) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('md5');
        fs.createReadStream(filePath).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
    });
}

// archive-locator.js findCandidates / locateArchive (the md5 branch; a source with no md5 is not located here)
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.7z', '.rar']);
const SIZE_TOLERANCE_BYTES = 1024;
function findCandidates(downloadsDir, fileSize, tolerance = 0) {
    return fs.readdirSync(downloadsDir)
        .filter((name) => ARCHIVE_EXTENSIONS.has(path.extname(name).toLowerCase()))
        .map((name) => path.join(downloadsDir, name))
        .filter((full) => Math.abs(fs.statSync(full).size - fileSize) <= tolerance);
}
async function locateArchive(downloadsDir, source) {
    let candidates = findCandidates(downloadsDir, source.fileSize);
    if (candidates.length === 0) candidates = findCandidates(downloadsDir, source.fileSize, SIZE_TOLERANCE_BYTES);
    if (candidates.length === 0) { const err = new Error(`No archive of size ${source.fileSize} found in ${downloadsDir}`); err.code = 'NOT_FOUND'; throw err; }
    const matches = [];
    for (const candidate of candidates) {
        if ((await hashFileMd5(candidate)) === source.md5) matches.push(candidate);
    }
    if (matches.length === 0) { const err = new Error('No same-size archive matches the md5'); err.code = 'HASH_MISMATCH'; throw err; }
    if (matches.length > 1) { const err = new Error('Multiple archives match md5+fileSize: ambiguous, refusing to guess'); err.code = 'AMBIGUOUS'; throw err; }
    return matches[0];
}

// update-collection-v2-runner.js removeModsVerifiedRetry (PORTED, 2026-09-01 in VCT; ModPacer's first copy retried blindly). A plain retry of a real removal re-sends the
// exact same call with nothing checked in between: an EARLIER attempt can genuinely finish server-side while the client is still timing out, and a LATER blind retry then
// hits a mod whose staging is already gone, which makes Vortex show its blocking "Mod not found" dialog. So: BEFORE every attempt, check Vortex is not already showing a
// blocking dialog (stop with a clear reason if it is); and before every RETRY, re-read the live state and DROP any mod that is already gone (not listed, or listed with
// no real staging files left) instead of re-sending it. Only ever shrinks the retry batch. Scoped to the real removal path (record-only never undeploys, so it never
// could trigger that dialog).
let removalTiming = { attempts: 3, delayMs: 3000 };
function setRemovalTiming(t) { removalTiming = { ...removalTiming, ...t }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function removeModsVerifiedRetry(idsWithMeta, staging, { attempts = removalTiming.attempts, delayMs = removalTiming.delayMs } = {}) {
    let remaining = idsWithMeta.slice();
    const confirmedRemoved = [];
    for (let attempt = 1; attempt <= attempts && remaining.length > 0; attempt += 1) {
        const progress = await helperClient.getDeployAllProgress();
        if (progress && (progress.externalChangesPending || (progress.blockingDialogs && progress.blockingDialogs.length > 0))) {
            const title = progress.blockingDialogs && progress.blockingDialogs[0] && progress.blockingDialogs[0].title;
            return {
                removed: confirmedRemoved, stillRemaining: remaining,
                blockedReason: title
                    ? `Vortex is waiting on you -- check its window (${title}) before continuing.`
                    : 'Vortex is waiting on you -- check its window before continuing.',
            };
        }
        const ok = await helperClient.removeMods(remaining.map((m) => m.vortexModId));
        if (ok) return { removed: [...confirmedRemoved, ...remaining], stillRemaining: [] };
        if (attempt >= attempts) break;
        await sleep(delayMs);
        let freshData = null;
        try { freshData = await helperClient.getAllMods(); } catch { freshData = null; }
        if (!freshData || !freshData.mods) continue; // couldn't read live state -- don't guess, just retry the same set next round
        const stillNeeded = [];
        for (const m of remaining) {
            const liveMod = freshData.mods[m.vortexModId];
            if (!liveMod) { confirmedRemoved.push(m); continue; } // gone from live entirely -- an earlier attempt already removed it for real
            const stillHasStaging = !!(liveMod.installationPath && stagingHasRealFiles(path.join(staging, liveMod.installationPath)));
            if (!stillHasStaging) { confirmedRemoved.push(m); continue; } // no real files left -- nothing left for a retry to safely act on
            stillNeeded.push(m);
        }
        remaining = stillNeeded;
    }
    return { removed: confirmedRemoved, stillRemaining: remaining };
}

// remove-collection-runner.js applyRemoval: the choice, then the one call. The real removal goes through removeModsVerifiedRetry (above); record-only keeps ModPacer's one
// plain retry. A mod whose folder is already gone is never sent to the real removal (record-only). Returns { ok, real, blockedReason? }.
async function removeModThroughBridge(modId, { stagingExists, archiveExists, stagingRoot }, log = () => {}) {
    // BEFORE the first attempt: Vortex's live mod list. A mod Vortex does not list is already gone: no removal call at all (neither real nor record-only), because
    // Vortex shows a "Mod not found" warning for it. A list that cannot be read sends nothing either.
    let live = null;
    try { live = await helperClient.getAllMods(); } catch { live = null; }
    if (!live || !live.mods) { log("Vortex's mod list could not be read: no removal sent"); return { ok: false, real: false }; }
    if (!live.mods[modId]) { log('Vortex does not list this mod: already gone, no removal sent'); return { ok: true, real: false, alreadyGone: true }; }
    const real = !!(stagingExists && archiveExists);
    if (!real) {
        let ok = false;
        for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
            ok = await helperClient.removeModsRecordOnly([modId]);
            if (!ok) log(`Vortex's record-only removal did not report success (try ${attempt} of 2)`);
        }
        return { ok, real: false };
    }
    const r = await removeModsVerifiedRetry([{ vortexModId: modId }], stagingRoot || '');
    if (r.blockedReason) { log(r.blockedReason); return { ok: false, real: true, blockedReason: r.blockedReason }; }
    if (r.stillRemaining.length > 0) { log("Vortex's removal did not report success"); return { ok: false, real: true }; }
    // An earlier attempt may have removed the folder yet left the record (the folder-gone case VCT drops from the retry): the record then goes record-only.
    let data = null;
    try { data = await helperClient.getAllMods(); } catch { data = null; }
    if (data && data.mods && data.mods[modId]) {
        const ok = await helperClient.removeModsRecordOnly([modId]);
        log(`the folder was already gone but the record was not: removed it record-only${ok ? '' : ' -- FAILED'}`);
        return { ok, real: true };
    }
    return { ok: true, real: true };
}

// ---- ModPacer's own wrapper around the archive ----

function insideFolder(root, rel) {
    if (!root || !rel) return null;
    const full = path.resolve(root, rel);
    const r = path.relative(path.resolve(root), full);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
    return full;
}

// The old mod's archive: find it, delete the FILE with deleteEntries (Update Collection's way), then remove the Vortex download record through the Bridge
// (record-only) and look. Only when it is CERTAIN which download that is and nothing else needs it. Never throws; every decision goes to `log`.
// Identity = the old mod's archiveId, its MD5 in the Bridge's downloads list (deleteStaleArchive), or the file name with the file's own hash matching.
// Returns { deleted: true | 'record_only' | false, reason?, recordGone?, fileGone? }.
async function removeOldArchive({ oldDownload, allMods, excludeIds, cfg, log }) {
    try {
        const { archiveId, md5, fileName } = oldDownload || {};
        if (!archiveId && !md5 && !fileName) { log('left alone: the old mod records no archive'); return { deleted: false, reason: 'no_identity' }; }
        const referenced = Object.entries(allMods || {}).some(([id, m]) => {
            if (excludeIds.includes(id)) return false;
            if (archiveId && m.archiveId === archiveId) return true;
            return !!(md5 && m.attributes && m.attributes.fileMD5 === md5);
        });
        if (referenced) { log('left alone: another installed mod still uses this archive'); return { deleted: false, reason: 'still_referenced' }; }

        const downloadsData = await helperClient.getAllDownloads();
        if (!downloadsData || !downloadsData.files) { log("left alone: Vortex's download list could not be read"); return { deleted: false, reason: 'downloads_unavailable' }; }
        const files = downloadsData.files;
        let id = null;
        if (archiveId && files[archiveId]) id = archiveId;
        if (!id && md5) { const hit = Object.entries(files).find(([, f]) => f.fileMD5 && f.fileMD5 === md5); if (hit) id = hit[0]; } // deleteStaleArchive: by MD5
        if (!id && fileName) {
            const hit = Object.entries(files).find(([, f]) => f.localPath === fileName);
            if (hit) {
                const onDisk = path.join(cfg.downloadFolder || '', hit[1].localPath);
                const sameFile = md5 && fs.existsSync(onDisk) && (await hashFileMd5(onDisk)) === md5;
                if (sameFile) id = hit[0];
                else { log('left alone: found only by file name and could not be proven to be the old version'); return { deleted: false, reason: 'not_certain' }; }
            }
        }
        // No record at all (an earlier try already removed it): the archive is found on disk by its size and MD5 (locateArchive) and the file goes the same way.
        let filePath = null;
        let record = null;
        if (id) {
            record = files[id];
            filePath = insideFolder(cfg.downloadFolder, record.localPath);
            if (!filePath) { log('left alone: the old file is not inside the downloads folder'); return { deleted: false, reason: 'outside_downloads' }; }
        } else if (md5 && fileName && cfg.downloadFolder) {
            const candidate = insideFolder(cfg.downloadFolder, path.basename(fileName));
            let proven = false;
            try { proven = !!candidate && fs.existsSync(candidate) && (await hashFileMd5(candidate)) === md5; } catch { proven = false; }
            if (proven) filePath = candidate;
            else if (oldDownload.fileSize) { try { filePath = await locateArchive(cfg.downloadFolder, { md5, fileSize: oldDownload.fileSize }); } catch { filePath = null; } }
        }
        if (!id && !filePath) { log('left alone: no matching download record'); return { deleted: false, reason: 'not_found' }; }

        if (id) {
            const shared = Object.entries(files).some(([otherId, f]) => otherId !== id && ((f.fileMD5 && f.fileMD5 === record.fileMD5) || (f.localPath && f.localPath === record.localPath)));
            if (shared) {
                await helperClient.removeDownloadRecordOnly([id]);
                log('another download record shares this file: removed only the record, kept the file');
                return { deleted: 'record_only', reason: 'shared_file' };
            }
        }

        // The file. Identity is Vortex's own record (the old mod's archive id, or the saved MD5 matching the record's fileMD5: deleteStaleArchive). A record whose own
        // fileMD5 contradicts the saved one is refused. With NO record, the file found by name must hash to the saved MD5 (checked above).
        let fileGone = !fs.existsSync(filePath || '');
        if (!fileGone) {
            if (record && md5 && record.fileMD5 && record.fileMD5 !== md5) { log("left alone: Vortex's record for it has a different MD5 than the old version's"); return { deleted: false, reason: 'not_proven' }; }
            const [rm] = deleteEntries([filePath]);
            log(rm.ok ? "deleted the archive file (Vortex Collection Tools' way: found by its MD5, plain file delete)" : `could not delete the archive file: ${rm.error}`);
            fileGone = !fs.existsSync(filePath);
        }
        // The record, through the Bridge (record-only: the file is already gone, so Vortex's removeDownload, the call that fails on some Vortex versions, is not needed).
        let recordGone = true;
        if (id) {
            if (fileGone) await helperClient.removeDownloadRecordOnly([id]);
            const after = await helperClient.getAllDownloads();
            recordGone = !!(after && after.files && !after.files[id]);
        }
        log(`deleted: record ${recordGone ? 'gone' : 'STILL LISTED'}, file ${fileGone ? 'gone' : 'STILL ON DISK'}`);
        return { deleted: recordGone && fileGone, recordGone, fileGone };
    } catch (e) {
        log(`stopped by an error: ${e.message}`);
        return { deleted: false, reason: 'error' };
    }
}

module.exports = { deleteEntries, stagingHasRealFiles, hashFileMd5, findCandidates, locateArchive, removeModsVerifiedRetry, setRemovalTiming, removeModThroughBridge, removeOldArchive, insideFolder };
