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
// unknownWaitMs / pollMs: after a removal whose answer never came (a busy Vortex), how long ModPacer looks at Vortex's mod list, and how often, before it says the
// old copy is still there. The log of 2026-10-13 shows a busy Vortex taking about 80 s; the limit is far above that.
let removalTiming = { attempts: 3, delayMs: 3000, unknownWaitMs: 240000, pollMs: 3000 };
function setRemovalTiming(t) { removalTiming = { ...removalTiming, ...t }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One mod, the LIGHT way (2026-10-13, director: the full mod list is read only when ModPacer starts and on Check now; every other question is asked with the lightest read the
// Bridge has). GET /rules/:modId is one mod's rules and answers 404 when Vortex does not list that mod. 'listed' | 'gone' | 'unknown' (no answer: a busy Vortex).
async function probeMod(modId) {
    const r = await helperClient.readRulesOnce(modId);
    return r.status === 'ok' ? 'listed' : (r.status === 'notfound' ? 'gone' : 'unknown');
}

// A removal that got no answer in time is NOT a failure: Vortex may have done it (2026-10-13, Update all: the retry of such a call asked Vortex to remove a mod
// whose folder was already gone, and Vortex showed "Mod not found" for every mod). The same call is never sent again. This looks at Vortex (one mod at a time, the light
// read) until every id is gone (not listed; for a real removal also: listed with no real files left in its staging folder) or the time is up.
// Returns { gone: [...ids], left: [...ids] }.
// `stagingPaths`: { modId: its staging folder } so a real removal can count a mod whose folder is already empty as gone; `recordOnlyIds`: ids removed record-only (only "not listed" counts).
async function waitUntilGone(ids, staging, { recordOnly = false, stagingPaths = {}, recordOnlyIds = [] } = {}) {
    const { unknownWaitMs, pollMs } = removalTiming;
    const end = Date.now() + unknownWaitMs;
    const recordOnlySet = new Set(recordOnlyIds);
    let left = ids.slice(); const gone = [];
    let rounds = 0;
    let unanswered = 0; // reads in a row that got no answer: a busy Vortex is asked less and less often
    for (;;) {
        const still = [];
        let silent = false; // Vortex did not answer: the rest of the round is not asked (each ask is a timeout)
        let answered = false;
        for (const id of left) {
            const p = silent ? 'unknown' : await probeMod(id);
            if (p === 'unknown') { silent = true; still.push(id); continue; }
            answered = true;
            if (p === 'gone') { gone.push(id); continue; }
            if (!(recordOnly || recordOnlySet.has(id)) && stagingPaths[id] && !stagingHasRealFiles(stagingPaths[id])) { gone.push(id); continue; }
            still.push(id);
        }
        left = still;
        unanswered = answered ? 0 : unanswered + 1;
        if (left.length === 0 || Date.now() >= end) return { gone, left };
        rounds += 1;
        await sleep(helperClient.pollDelay(pollMs, unanswered + Math.floor(rounds / 4))); // also slower the longer it takes (every 4th look doubles the pause)
    }
}

// Which of these (metas: { vortexModId, stagingPath? }) are already gone, asked with the light read. Returns null when Vortex did not answer for one of them.
async function sortGone(metas) {
    const gone = []; const listed = [];
    for (const m of metas) {
        const p = await probeMod(m.vortexModId);
        if (p === 'unknown') return null;
        if (p === 'gone') { gone.push(m); continue; }
        if (m.stagingPath && !stagingHasRealFiles(m.stagingPath)) { gone.push(m); continue; } // no real files left: nothing left for a retry to safely act on
        listed.push(m);
    }
    return { gone, listed };
}

async function removeModsVerifiedRetry(idsWithMeta, staging, { attempts = removalTiming.attempts, delayMs = removalTiming.delayMs } = {}) {
    let remaining = idsWithMeta.slice();
    const confirmedRemoved = [];
    const stagingPaths = {};
    for (const m of idsWithMeta) if (m.stagingPath) stagingPaths[m.vortexModId] = m.stagingPath;
    for (let attempt = 1; attempt <= attempts && remaining.length > 0; attempt += 1) {
        const progress = await helperClient.getDeployAllProgress({ quick: true }); // one short look, never held up or repeated: a busy Vortex gets no extra waiting from it
        if (progress && (progress.externalChangesPending || (progress.blockingDialogs && progress.blockingDialogs.length > 0))) {
            const title = progress.blockingDialogs && progress.blockingDialogs[0] && progress.blockingDialogs[0].title;
            return {
                removed: confirmedRemoved, stillRemaining: remaining,
                blockedReason: title
                    ? `Vortex is waiting on you -- check its window (${title}) before continuing.`
                    : 'Vortex is waiting on you -- check its window before continuing.',
            };
        }
        const outcome = await helperClient.removeModsOutcome(remaining.map((m) => m.vortexModId));
        if (outcome === 'ok') return { removed: [...confirmedRemoved, ...remaining], stillRemaining: [] };
        if (outcome === 'unknown') { // no answer in time: never sent again; look until Vortex shows it gone
            const w = await waitUntilGone(remaining.map((m) => m.vortexModId), staging, { stagingPaths });
            const goneSet = new Set(w.gone);
            return { removed: [...confirmedRemoved, ...remaining.filter((m) => goneSet.has(m.vortexModId))], stillRemaining: remaining.filter((m) => !goneSet.has(m.vortexModId)), unknown: true };
        }
        if (attempt >= attempts) break;
        await sleep(delayMs);
        const sorted = await sortGone(remaining);
        if (!sorted) continue; // couldn't read live state -- don't guess, just retry the same set next round
        confirmedRemoved.push(...sorted.gone); // gone from live, or no real files left: an earlier attempt already removed it for real
        remaining = sorted.listed;
    }
    return { removed: confirmedRemoved, stillRemaining: remaining };
}

// remove-collection-runner.js applyRemoval: the choice, then the one call. The real removal goes through removeModsVerifiedRetry (above); record-only keeps ModPacer's one
// plain retry. A mod whose folder is already gone is never sent to the real removal (record-only). Returns { ok, real, blockedReason? }.
async function removeModThroughBridge(modId, { stagingExists, archiveExists, stagingRoot, stagingPath }, log = () => {}) {
    const r = await removeModsBatch([{ modId, stagingExists, archiveExists, stagingPath }], { staging: stagingRoot, log });
    return r.results[modId];
}

// ONE removal for a whole list of old mods (2026-10-13, Update all; Update Collection's way: one remove-mods call for the real ones, one record-only call for the others).
// entries: [{ modId, stagingExists, archiveExists, stagingPath? }]. BEFORE anything is sent every mod is looked at with the light read (one mod each, never the whole list):
// a mod Vortex does not list is already gone: no removal call at all (neither real nor record-only), because Vortex shows a "Mod not found" warning for it; a mod Vortex
// cannot be asked about (no answer) stops the batch there: nothing more is sent. Then ONE real removal (with Update Collection's verified retry) and ONE record-only removal.
// Neither is ever sent again after a timeout (Vortex may have done it): ONE look at the end settles which are gone. { results: { modId: { ok, real, alreadyGone?, unreadable?, blockedReason? } }, silent }
async function removeModsBatch(entries, { staging = '', log = () => {} } = {}) {
    const results = {};
    const realMetas = []; const recordOnlyIds = []; const stagingPaths = {};
    let silent = false;
    for (const e of entries) {
        if (silent) { results[e.modId] = { ok: false, real: false, unreadable: true }; continue; }
        const p = await probeMod(e.modId);
        if (p === 'unknown') { log("Vortex did not answer: no removal sent for the rest"); silent = true; results[e.modId] = { ok: false, real: false, unreadable: true }; continue; }
        if (p === 'gone') { log(`Vortex does not list ${e.modId}: already gone, no removal sent`); results[e.modId] = { ok: true, real: false, alreadyGone: true }; continue; }
        if (e.stagingPath) stagingPaths[e.modId] = e.stagingPath;
        if (e.stagingExists && e.archiveExists) { realMetas.push({ vortexModId: e.modId, stagingPath: e.stagingPath }); results[e.modId] = { ok: false, real: true }; }
        else { recordOnlyIds.push(e.modId); results[e.modId] = { ok: false, real: false }; }
    }
    const toLook = []; // sent and reported done: looked at once, below
    if (realMetas.length > 0) {
        const r = await removeModsVerifiedRetry(realMetas, staging);
        if (r.blockedReason) { log(r.blockedReason); for (const m of r.stillRemaining) results[m.vortexModId].blockedReason = r.blockedReason; }
        const one = realMetas.length === 1;
        if (r.unknown) log(r.stillRemaining.length === 0 ? `Vortex's removal gave no answer in time (it was busy), but the old ${one ? 'mod is' : 'mods are'} gone now: not sent again` : (one ? 'Vortex did not remove the old copy; it is still there (its removal gave no answer in time and was not sent again)' : 'Vortex did not remove every old mod; the rest are still there (the removal gave no answer in time and was not sent again)'));
        else if (r.stillRemaining.length > 0 && !r.blockedReason) log("Vortex's removal did not report success");
        for (const m of r.removed) toLook.push(m.vortexModId);
    }
    if (recordOnlyIds.length > 0) {
        let outcome = 'failed';
        for (let attempt = 1; attempt <= 2 && outcome === 'failed'; attempt++) {
            outcome = await helperClient.removeModsRecordOnlyOutcome(recordOnlyIds);
            if (outcome === 'failed') log(`Vortex's record-only removal did not report success (try ${attempt} of 2)`);
        }
        if (outcome === 'unknown') log("Vortex's record-only removal gave no answer in time: not sent again, Vortex is looked at instead");
        if (outcome !== 'failed') toLook.push(...recordOnlyIds);
    }
    if (toLook.length > 0) {
        const w = await waitUntilGone(toLook, staging, { stagingPaths, recordOnlyIds });
        const goneSet = new Set(w.gone);
        for (const id of toLook) results[id].ok = goneSet.has(id);
        if (w.left.length > 0) log(`still listed after the removal: ${w.left.join(', ')}`);
        // An earlier attempt may have removed the folder yet left the record (the folder-gone case VCT drops from the retry): the record then goes record-only, once, together.
        const stale = [];
        for (const id of w.gone) if (results[id].real && (await probeMod(id)) === 'listed') stale.push(id);
        if (stale.length > 0) {
            const outcome = await helperClient.removeModsRecordOnlyOutcome(stale);
            const settled = outcome === 'ok' ? { left: [] } : await waitUntilGone(stale, staging, { recordOnly: true });
            log(`the folder was already gone but the record was not: removed it record-only${settled.left.length === 0 ? '' : ' -- FAILED'}`);
            for (const id of stale) results[id].ok = settled.left.length === 0 || !settled.left.includes(id);
        }
    }
    return { results, silent };
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

module.exports = { probeMod, removeModsBatch, waitUntilGone, deleteEntries, stagingHasRealFiles, hashFileMd5, findCandidates, locateArchive, removeModsVerifiedRetry, setRemovalTiming, removeModThroughBridge, removeOldArchive, insideFolder };
