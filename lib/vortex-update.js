'use strict';
// The "Update" flow: swap an old plugin mod for a freshly-downloaded new version inside Vortex,
// through the Vortex Bridge (lib/vortex-helper-client.js, copied verbatim -- see
// TECHNICAL.md), carrying over collection membership, enabled state, and FOMOD install choices.
// Never touches the old download/archive record -- only the MOD record (removeModsRecordOnly),
// so the old archive genuinely stays in Vortex's downloads list untouched.
//
// The actual swap (updateInVortex/_finishSwap) is still NOT run against a real Vortex -- never on
// the director's own install, per every build task's own explicit instruction -- tested only
// against tests/fake-helper.js (he closed his real Vortex for a few minutes, twice now, so that
// suite could run for real instead of skipping itself; see TECHNICAL.md). Collection MATCHING
// (which rule, if any, identifies an installed mod) IS verified read-only against the director's
// own real Vortex (2026-10-01). One real finding from that read: real collections do NOT always
// carry a `tag` -- his own 58-member "SkyrimNet" collection references every mod by plain Vortex
// id, no tag at all -- so a moved rule never carrying one (see buildMovedReference's own comment)
// matches what real collections actually do, not just an untested worst case. The new mod-record
// attribute shape below is also modeled on a real, live-read record (his own real BioForge-1.0.0,
// installed natively by Vortex itself after he reinstalled it -- see TECHNICAL.md), not guessed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const helperClient = require('./vortex-helper-client');
const { buildModFromLiveData } = require('./mod-identity');
const modRefMatch = require('./mod-reference-match');
const collectionMembership = require('./collection-membership');
const { compareVersions } = require('./version-compare');
const installArchive = require('./install-archive');
const appConfig = require('./app-config');
const vortexInfoCache = require('./vortex-info-cache');
const updateLog = require('./update-log');
const downloadState = require('./download-state');
const oldCleanup = require('./old-download-cleanup');
const oldCopyStore = require('./old-copy-store');
const vctRemoval = require('./vct-removal');
const { dataPath } = require('./data-dir');
const modManager = require('./mod-manager');
const updateProgress = require('./update-progress');
const modPlugins = require('./mod-plugins');

function hashFileMd5(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (d) => hash.update(d));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

// Resolves a path segment by segment, matching each entry against the real directory listing
// case-insensitively (queue: fix-update-button-folder-layout, 2026-09-30) -- NTFS being
// case-insensitive isn't something to rely on by accident, and some plugin authors capitalize
// "external"/"Plugins" differently. Returns the real, on-disk path if every segment matched, or
// null the moment one doesn't.
function resolveCaseInsensitive(root, parts) {
    let current = root;
    for (const part of parts) {
        let entries;
        try {
            entries = fs.readdirSync(current);
        } catch {
            return null;
        }
        const match = entries.find((e) => e.toLowerCase() === part.toLowerCase());
        if (!match) return null;
        current = path.join(current, match);
    }
    return current;
}

// A real Vortex staging folder has NO `Data\` level -- a mod's folder holds exactly what gets
// deployed INTO Data (director, 2026-09-30, from his own real install:
// `<staging folder>\BioForge-1.0.0\SKSE\Plugins\SkyrimNet\external\oldcustard.bioforge\`).
// Checked first, since it's the real, common case; a `Data`-prefixed layout is still accepted
// second in case some mod happens to pack it that way.
function findManifestPath(modRoot, pluginId) {
    const noData = resolveCaseInsensitive(modRoot, ['SKSE', 'Plugins', 'SkyrimNet', 'external', pluginId, 'manifest.json']);
    if (noData) return noData;
    return resolveCaseInsensitive(modRoot, ['Data', 'SKSE', 'Plugins', 'SkyrimNet', 'external', pluginId, 'manifest.json']);
}

// The freshly-extracted manifest.json's own version string -- a fallback for when the catalog's
// own reported version is empty (see _finishSwap's own comment). Best-effort: a missing/unreadable/
// malformed manifest, or a manifest with no version field, just means no fallback is available
// (empty string), never a thrown error during an update.
function readExtractedVersion(modRoot, pluginId) {
    const manifestPath = findManifestPath(modRoot, pluginId);
    if (!manifestPath) return '';
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return (manifest && manifest.version) || '';
    } catch {
        return '';
    }
}

// Finds which live Vortex mod's staging folder contains this plugin's deployed
// SKSE\Plugins\SkyrimNet\external\<id>\ folder. Needs `vortexStagingFolder` (Settings) -- the one
// deliberate addition beyond the mockup, flagged in the handoff: the Helper's own live /mods
// response gives each mod's installationPath (a folder NAME, not a full path), and there is
// currently no live way to ask Vortex for its staging ROOT, so a manual setting is the only
// honest option without adding a new Helper endpoint (out of scope for this project).
//
// Vortex keeps older versions of a mod around, and an entry made without install info (no version, no file name, no mod id) can sit
// beside the real one -- so several entries can hold the same plugin (queue: pick-the-real-vortex-entry-when-a-mod-is-listed-twice,
// 2026-10-04: Relationships 1.7.0 with no version next to 2.0.0, Kinship 1.9.6 next to 1.9.7; the old code took whichever came first).
// The installed one is chosen: entries with install info beat ones without; then the ones enabled in the active profile
// (`enabledModKeys`, when given); then the highest version; then the latest install time. Older copies are never reported.
function entryVersion(mod) {
    const attrs = (mod && mod.attributes) || {};
    return attrs.version || attrs.modVersion || extractVersionFromFileName(attrs.logicalFileName || attrs.fileName) || null;
}
function entryHasInfo(mod) {
    const attrs = (mod && mod.attributes) || {};
    return !!(attrs.version || attrs.modVersion || attrs.logicalFileName || attrs.fileName || attrs.modId || attrs.fileId || attrs.fileMD5);
}
function installTimeMs(mod) {
    const t = Date.parse(String(((mod && mod.attributes) || {}).installTime || ''));
    return Number.isNaN(t) ? 0 : t;
}
function pickInstalledEntry(candidates, enabledModKeys) {
    let pool = candidates;
    const withInfo = pool.filter((c) => entryHasInfo(c.mod));
    if (withInfo.length > 0) pool = withInfo;
    if (Array.isArray(enabledModKeys)) {
        const enabled = pool.filter((c) => enabledModKeys.includes(c.modId));
        if (enabled.length > 0) pool = enabled;
    }
    return pool.slice().sort((a, b) => {
        const va = entryVersion(a.mod); const vb = entryVersion(b.mod);
        const byVersion = compareVersions(va, vb); // 'newer' = b is the higher one
        if (byVersion === 'newer') return 1;
        if (byVersion === 'older') return -1;
        return installTimeMs(b.mod) - installTimeMs(a.mod);
    })[0];
}
// pluginId (the Hub's id) -> the Vortex mod id that check() paired it with by name. Set once per check; never persisted.
let pairedMods = {};
function setPairedMods(map) { pairedMods = { ...(map || {}) }; }
function findOwningModId(pluginId, allMods, enabledModKeys) {
    const cfg = appConfig.loadConfig();
    if (!cfg.vortexStagingFolder) return { modId: null, reason: 'no_staging_folder_configured' };
    // A mod recognised by NAME (vortex-name-match.js: a sure match, or a "Yes, same mod") has no plugin folder to look for: the check named its Vortex mod.
    const paired = pairedMods[pluginId];
    if (paired && allMods[paired]) return { modId: paired, reason: null };
    const candidates = [];
    for (const [modId, mod] of Object.entries(allMods)) {
        const installationPath = mod.installationPath || modId;
        const modRoot = path.join(cfg.vortexStagingFolder, installationPath);
        if (findManifestPath(modRoot, pluginId)) candidates.push({ modId, mod });
    }
    if (candidates.length === 0) return { modId: null, reason: 'not_found' };
    return { modId: pickInstalledEntry(candidates, enabledModKeys).modId, reason: null };
}

// Every collection mod's own rules[], read straight out of the /mods payload we already have (the
// Helper relays Vortex's untouched mods subtree, so each collection's `rules` array comes through
// there -- same live data /rules/:id reads). Zero extra requests: this used to call GET /rules/:id for
// EVERY collection in Vortex (32 on the director's install), one at a time, which on a still-loading
// Vortex meant 32 timeouts -- and put unrelated collections' names in the player's window (queue:
// vortex-ready-quiet-window, 2026-10-01). A collection record with no rules array counts as no rules.
function getRulesByCollection(allMods) {
    const map = {};
    for (const [id, mod] of Object.entries(allMods)) {
        if (mod && mod.type === 'collection') map[id] = Array.isArray(mod.rules) ? mod.rules : [];
    }
    return map;
}

// Matches via modRefMatch.testModReference (Vortex's own real mod-reference logic, ported --
// see that module's own header comment) against the RAW live mod record, not a pre-shaped
// "identity" object -- a plain Vortex-mod-id reference (the real bug here) only has anything to
// match against the real record's own `id`/`attributes`, never a derived summary of them.
// Which collections a mod is in, by Vortex's OWN rule (lib/collection-membership.js: what the Mods page's Collection column shows), one hit per
// rule that puts the mod in a collection (a collection can hold more than one). `rulesByCollection` is kept for callers; the answer comes from
// the full mod list, since a collection's membership is decided by its rules AND by which mods exist.
function matchCollectionsFromRules(oldModId, allMods) {
    const hits = [];
    for (const { collectionModId, rules } of collectionMembership.membershipOf(oldModId, allMods)) {
        for (const oldRule of rules) hits.push({ collectionModId, oldRule });
    }
    return hits;
}

// Every live mod whose own rules[] contains a requires/recommends rule identifying oldModId.
async function findCollectionsReferencing(oldModId, allMods) {
    return matchCollectionsFromRules(oldModId, allMods, getRulesByCollection(allMods));
}

// Strips a trailing version-looking segment off a mod id -- "iActions-0.6.6" -> "iActions",
// "BioForge-1.0.1" -> "BioForge", "PGPatcher Output" -> unchanged (no version-looking suffix at
// all). Used only to recognize a STALE reference as an older identity for a plugin this app still
// manages -- never for anything else, since it's a name heuristic, not a real identity check.
function stripVersionSuffix(name) {
    return String(name || '').replace(/[-_ ]v?\d+(\.\d+)*[a-zA-Z0-9.+-]*$/, '');
}

// True if `candidateId` looks like an OLDER identity for the same plugin now living at
// `currentModId`, via either naming scheme this app has ever used -- queue:
// repair-repoints-leftover-rules, 2026-10-01. Real reported case: PGPatcher Output's own `after`
// rule named "iActions-0.6.6", a dead id from the update BEFORE this app's own naming fix landed,
// which has no real matching data (fileMD5 etc) left to test against at all -- only the id/name
// pattern survives.
//   - The OLD `${pluginId}-${newVersion}` naming scheme this app used before Vortex-style naming:
//     candidateId starts with "<pluginId>-" (e.g. "oldcustard.bioforge-1.0.1").
//   - The CURRENT archive-basename scheme: candidateId and currentModId share the same name once a
//     trailing version is stripped from both (e.g. "iActions-0.6.6" vs "iActions-0.6.7" -> both
//     "iActions"). Never matches when nothing looks version-like, so it can't accidentally claim an
//     unrelated same-named mod with no version at all.
function isOlderIdentityForPlugin(candidateId, pluginId, currentModId) {
    if (!candidateId || !currentModId || candidateId === currentModId) return false;
    if (pluginId && candidateId.startsWith(`${pluginId}-`)) return true;
    const candidateBase = stripVersionSuffix(candidateId);
    if (!candidateBase || candidateBase === candidateId) return false; // nothing version-like was stripped -- too weak a signal to act on
    return candidateBase === stripVersionSuffix(currentModId);
}

// Every REGULAR (non-collection) mod whose own rules[] -- before/after/requires/recommends/
// conflicts, any type -- identifies oldModId via a REAL identity match (fileMD5/logicalFileName/
// etc, straight off the live /mods payload -- confirmed live, 2026-10-01, that a real mod's own
// `rules` array comes through on getAllMods() directly, same as a collection's), PLUS -- any mod,
// collections included -- whose rule's `reference.id` looks like an OLDER identity for the SAME
// plugin (isOlderIdentityForPlugin, above), a reference with no real matching data left to test at
// all. The real-identity check stays collection-excluded (their requires/recommends membership is
// findCollectionsReferencing's own job, via a real exact match; scanning them again here for THAT
// would double-apply the same rule change) -- but the name-heuristic check deliberately covers
// collections too, since findCollectionsReferencing never catches a multi-generation-old id this
// way at all. `pluginId` is optional (previewing callers that don't have it yet just skip the
// name-heuristic half).
function findOtherModsReferencingInOwnRules(oldModId, allMods, pluginId) {
    const oldModRecord = allMods[oldModId];
    if (!oldModRecord) return [];
    const hits = [];
    for (const [modId, mod] of Object.entries(allMods)) {
        if (modId === oldModId || !Array.isArray(mod.rules)) continue;
        for (const rule of mod.rules) {
            const ref = rule.reference || {};
            const realMatch = mod.type !== 'collection' && modRefMatch.testModReference(oldModRecord, ref);
            const olderIdentityMatch = ref.id && isOlderIdentityForPlugin(ref.id, pluginId, oldModId);
            if (realMatch || olderIdentityMatch) hits.push({ modId, oldRule: rule });
        }
    }
    return hits;
}

// True when `mod` already has some OTHER rule (not `excludeRule`) whose reference plainly
// identifies `targetModId` -- a pragmatic, bare-id check rather than a full testModReference, since
// every real reference on this install turns out to be exactly this shape (plain Vortex id). Used
// to decide "repoint a stale rule" vs. "just remove it, it would only duplicate one that's already
// there" (task's own explicit "no double membership" rule, generalized to any referencing mod, not
// just collections).
function hasExistingRuleForMod(mod, targetModId, excludeRule) {
    if (!Array.isArray(mod && mod.rules)) return false;
    return mod.rules.some((r) => r !== excludeRule && r.reference && r.reference.id === targetModId);
}

// Which of the OLD mod's own rules[] (before/after/requires/recommends/conflicts -- whatever it
// actually has) are safe to copy onto the new mod unchanged. A rule is skipped, never copied, when
// its own `reference` matches NO currently-installed mod at all -- carrying forward a reference
// that's already dangling would just be inventing a second broken copy of the same dead rule
// (task's own explicit instruction: "never invent rules"). The old mod itself is excluded from the
// match scan -- a rule can never legitimately reference its own owner.
function carryableOwnRules(oldModRecord, allMods, oldModId) {
    const rules = Array.isArray(oldModRecord && oldModRecord.rules) ? oldModRecord.rules : [];
    const kept = [];
    const skipped = [];
    for (const rule of rules) {
        const matchesSomeMod = Object.entries(allMods).some(([id, m]) => id !== oldModId && modRefMatch.testModReference(m, rule.reference));
        (matchesSomeMod ? kept : skipped).push(rule);
    }
    return { kept, skipped };
}

// The old mod's own file-override choices (which mod wins a conflicting deployed file) -- carried
// onto the new mod's own record, filtered to entries naming a file that still actually exists in
// the NEW staging content (the task's own explicit "where the files still exist" scope -- a
// version bump can drop or rename files, so an override naming one that's gone would be inventing
// a claim about a file that isn't there). ~70% confidence, disclosed plainly rather than assumed:
// real Vortex's own native "Replace" flow copies this SAME property straight across
// (`fileOverrides: existingMod.fileOverrides`, confirmed via its real InstallManager.ts source),
// which is the evidence this is the right real property name and that a direct, untransformed
// copy is the right shape of fix (unlike rules, a fileOverride names a FILE, not another mod's
// identity, so there's nothing to re-point the way buildMovedReference does for rules). What's NOT
// independently confirmed: this install has zero real non-empty example to test the exact entry
// shape against, and whether createMod's own relay to the real create-mod event persists an
// incoming fileOverrides field the same way Vortex's native replace's own direct reducer write
// does. Assumes the common real shape (a plain array of relative file path strings) -- if that
// assumption is wrong, the filter below just conservatively drops the entry rather than crashing or
// inventing one, the same safe-failure direction every other uncertain case in this file takes.
function carryableFileOverrides(oldModRecord, newStagingPath) {
    const overrides = Array.isArray(oldModRecord && oldModRecord.fileOverrides) ? oldModRecord.fileOverrides : [];
    return overrides.filter((entry) => typeof entry === 'string' && fs.existsSync(path.join(newStagingPath, entry)));
}

// Keeps a moved rule's reference in the SAME STYLE the old one used -- an id reference becomes the
// new mod's own Vortex id, an MD5 reference the new archive's MD5, a logicalFileName reference the
// new archive's own file name, and so on (queue: recognize-collections-by-vortex-name, 2026-10-01;
// director's own real report: a personal collection referencing every member by plain Vortex id was
// never recognized at all under the old fileMD5/Nexus-id/tag-only matcher). `type`/`extra`/every
// other rule-level field is left exactly as the old rule had it -- only `reference` is rebuilt.
//
// `tag` is never carried over or invented: a freshly created mod record has no Vortex-assigned tag
// (that's something Vortex's own download manager assigns, not something createMod can set), so a
// stale old tag would point at nothing and an invented one would be worse than having none at all.
// The other identity fields the old reference used (id/fileMD5/logicalFileName/repo) are what still
// correctly re-identify the new mod once moved.
function buildMovedReference(oldReference, newModId, newMod) {
    const ref = { ...oldReference };
    delete ref.tag;
    if (oldReference.id !== undefined) ref.id = newModId;
    if (oldReference.fileMD5 !== undefined) ref.fileMD5 = newMod.source.md5;
    if (oldReference.logicalFileName !== undefined) ref.logicalFileName = newMod.source.logicalFilename;
    if (oldReference.fileSize !== undefined) ref.fileSize = newMod.source.fileSize;
    if (oldReference.versionMatch !== undefined) ref.versionMatch = newMod.source.version;
    if (oldReference.description !== undefined) ref.description = newMod.name;
    if (oldReference.repo !== undefined) {
        if (newMod.source.type === 'nexus') {
            ref.repo = { ...oldReference.repo, modId: String(newMod.source.modId), fileId: String(newMod.source.fileId) };
        } else {
            // The new copy isn't Nexus-sourced -- a repo reference still pointing at the OLD
            // file's Nexus ids would be actively wrong, so fall back to fileMD5 instead (added
            // if the old reference didn't already carry one).
            delete ref.repo;
            if (ref.fileMD5 === undefined) ref.fileMD5 = newMod.source.md5;
        }
    }
    return ref;
}

function buildMembershipRule(oldRule, newModId, newMod) {
    return { ...oldRule, reference: buildMovedReference(oldRule.reference || {}, newModId, newMod) };
}

// Vortex's own real new-mod naming (confirmed via source read, modIdManager.ts's
// deriveModInstallName + InstallManager.ts's own archive-basename-without-extension) -- NOT this
// app's earlier invented `${pluginId}-${newVersion}` scheme, which never matched what Vortex
// itself would have called the mod on a normal install (the real reported bug: "BioForge-1.0.1.zip"
// landed as "oldcustard.bioforge-1.0.1", not "BioForge-1.0.1").
//
// Collision handling: real Vortex's own answer is a live, interactive "replace / create a variant
// / rename" modal (InstallManager.ts's queryUserReplace) -- there is no headless equivalent in
// Vortex itself, and vortex-collection-tools doesn't replicate one either (it either reuses a
// known modId or trusts a freshly-downloaded archive name is unique). This function's own
// collision fallback is therefore THIS project's own judgment call, not a port of anything: the
// same "(1)", "(2)", ... suffix convention Windows Explorer itself uses for a colliding file name
// -- disclosed here and in the handoff rather than assumed to be exactly what Vortex would have
// done.
//
// `archiveMd5` is what tells a genuine name collision (a DIFFERENT mod that happens to already
// use this name) apart from a leftover record from an earlier, failed attempt at installing this
// SAME archive -- a taken name whose own fileMD5 already matches is reused as-is rather than
// spawning a needless "(1)" on every retry: createMod is itself idempotent for the same modId (see
// vortex-helper-client.js's own createMod comment), so this is a clean retry, never a duplicate.
function resolveAvailableModId(baseName, allMods, archiveMd5) {
    for (let n = 0; ; n++) {
        const candidate = n === 0 ? baseName : `${baseName} (${n})`;
        const existing = allMods[candidate];
        if (!existing) return candidate;
        if (existing.attributes && existing.attributes.fileMD5 === archiveMd5) return candidate;
    }
}

// Reuses an existing Vortex download record for this exact archive -- matched by MD5 first, then by file name -- before ever registering a brand new one.
// PORTED from Vortex Collection Tools, lib/update-collection-v2-runner.js (resolveDownloadIdForArchive, resolveDownloadIdByLocalPath, resolveOrRegisterArchiveId),
// including its 2026-08-29 fix (queue: modpacer-gets-vct-fixes-for-a-failed-downloads-read-and-a-blind-mod-removal-retry, 2026-10-05; the first copy here had lost it):
// a downloads read that FAILED (the Bridge timed out or answered an error) is NOT the same as "confirmed no match". Treating it as no match registered the archive
// again, leaving a second, duplicate download row for the same file (confirmed live in VCT: byte-identical downloads registered under different ids). A failed
// read gets exactly one more FRESH attempt; still failing, nothing is registered and the archiveId is left unset this time (cheap and recoverable: a later update
// gets another chance), never a blind registration.
// Return contract (resolveDownloadIdForArchive): { archiveId } for a match; null for a CONFIRMED no match (the read succeeded and nothing matches); undefined for
// a read that FAILED. Callers must not treat undefined like null.
async function resolveDownloadIdForArchive(md5, prefetchedDownloads) {
    // Real downloads lists can contain entries with no computed fileMD5 of their own: without this guard, `undefined === undefined` false-matches the first such
    // entry (VCT, 2026-08-30). Nothing real to match by: a confirmed no-match, not undetermined.
    if (!md5) return null;
    try {
        const data = prefetchedDownloads || await helperClient.getAllDownloads();
        if (!data || !data.files) return undefined; // read failed: NOT the same as "confirmed no match"
        for (const [downloadId, file] of Object.entries(data.files)) {
            if (file.fileMD5 && file.fileMD5 === md5) return { archiveId: downloadId };
        }
        return null; // confirmed: the read succeeded and nothing matches
    } catch {
        return undefined; // read failed
    }
}

// The final guard, by file name, immediately before registering (VCT, 2026-09-01): a download Vortex's own downloader registered a moment ago can have no fileMD5
// computed on it YET, so the MD5 check finds nothing and a second registration would follow. The file name does not depend on Vortex having finished hashing.
async function resolveDownloadIdByLocalPath(archiveBasename, prefetchedDownloads) {
    try {
        const data = prefetchedDownloads || await helperClient.getAllDownloads();
        if (!data || !data.files) return null;
        for (const [downloadId, file] of Object.entries(data.files)) {
            if (file.localPath === archiveBasename) return downloadId;
        }
        return null;
    } catch {
        return null;
    }
}

// Returns the archive id (an existing download's, or a newly registered one), or null when it is not known (never registers on an undetermined read).
async function resolveOrRegisterArchiveId(fileName, md5, fileSize) {
    let existing = await resolveDownloadIdForArchive(md5, null);
    if (existing === undefined) existing = await resolveDownloadIdForArchive(md5, null); // one more real, FRESH read
    if (existing) return existing.archiveId;
    if (existing === undefined) {
        updateLog.logUpdate(`archiveId resolution undetermined for ${fileName} (the downloads read kept failing): archiveId left unset this pass, nothing registered`);
        return null; // still undetermined: do NOT register blind
    }
    const byName = await resolveDownloadIdByLocalPath(fileName, null);
    if (byName) return byName; // avoided a duplicate registration
    const registered = await helperClient.registerLocalDownload(crypto.randomUUID(), fileName, fileSize);
    if (!registered) updateLog.logUpdate(`registerLocalDownload failed for ${fileName}: archiveId left unset this pass`);
    return registered || null;
}

// Finds the OLD download the robust way (task's own explicit instruction, real reported gap): the
// old mod's own `archiveId` first -- the most direct, authoritative link, when it has one -- then
// MD5, then file name. NOT solely fileMD5: a real mod's own attributes.fileMD5 isn't always where
// the identifying hash lives relative to a GENUINE Vortex download record, and relying on it alone
// meant the delete step could silently never find anything to remove even though a perfectly good
// archiveId/download record existed all along.
function findOldDownloadId(downloadsData, { archiveId, md5, fileName }) {
    if (!downloadsData || !downloadsData.files) return null;
    if (archiveId && downloadsData.files[archiveId]) return archiveId;
    if (md5) {
        const byMd5 = Object.entries(downloadsData.files).find(([, f]) => f.fileMD5 && f.fileMD5 === md5);
        if (byMd5) return byMd5[0];
    }
    if (fileName) {
        const byName = Object.entries(downloadsData.files).find(([, f]) => f.localPath === fileName);
        if (byName) return byName[0];
    }
    return null;
}

// ---------------------------------------------------------------------------------------------
// THE ORDER OF AN UPDATE (director's design, 2026-10-01; queue: update-delete-old-and-deploy-ask):
//   1. READ everything about the old mod that has to survive -- its own rules, other mods' rules that point at it,
//      its collection membership, file overrides, enabled state, install choices -- into a snapshot (memory + a file
//      in the data folder until the update is fully done), so nothing depends on asking a busy Vortex later.
//   2. (changed 2026-10-05) The old mod stays put while the new one goes in, so a failed install leaves the old one untouched.
//   3. INSTALL the new mod: files, record, download link, enabled state. Once Vortex shows it installed and enabled, the OLD COPY is
//      removed THROUGH THE BRIDGE (see "THE OLD COPY" below: Vortex's own removal when its folder and archive are there, record-only
//      otherwise), and the update is only "Updated" once the old mod, its archive and its folder are checked gone.
//   4. APPLY the saved rules in ONE batch, then read Vortex back and confirm every rule took.
//   5. THEN remove the old download through the Bridge (when the setting is on, and the new version is fully in).
// If step 3 fails the player still has the old version, untouched (it is only removed after the new one is confirmed in).
// A rule write that doesn't confirm after retries is NOT a failed update (the mod is installed): it is reported as a
// partial result with the snapshot kept, and "Try again" re-applies just that part.
// ---------------------------------------------------------------------------------------------

function snapshotDir() { return dataPath('pending-updates'); }
function writeSnapshot(snapshot) {
    const file = path.join(snapshotDir(), `${String(snapshot.pluginId).replace(/[^a-zA-Z0-9._-]/g, '_')}-${Date.now()}.json`);
    fs.mkdirSync(snapshotDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf8');
    return file;
}
function readSnapshot(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function removeSnapshot(file) {
    try { if (file) fs.rmSync(file, { force: true }); } catch { /* best effort */ }
}

// Step 1: what must survive (pure -- no Vortex calls).
function buildUpdateSnapshot({ pluginId, oldModId, allMods, enabledModKeys, oldMod }) {
    const oldRecord = JSON.parse(JSON.stringify(allMods[oldModId] || {}));
    const attrs = oldRecord.attributes || {};
    return {
        version: 1, pluginId, createdAt: new Date().toISOString(), oldModId, oldRecord,
        wasEnabled: enabledModKeys.includes(oldModId),
        oldDownload: { archiveId: oldRecord.archiveId || null, md5: attrs.fileMD5 || null, fileName: attrs.fileName || attrs.logicalFileName || null, fileSize: attrs.fileSize || null },
        choices: (oldMod && oldMod.choices) || null,
    };
}

// The rule moves as ONE list of { modId, remove?, add?, kind } (pure). `kind` is for the report only (stripped before sending).
function planRuleItems({ oldModId, oldRecord, allMods, pluginId, newModId, newMod, referencingCollections }) {
    const items = [];
    for (const { collectionModId, oldRule } of referencingCollections) {
        items.push({ kind: 'membership', modId: collectionModId, remove: oldRule, add: buildMembershipRule(oldRule, newModId, newMod) });
    }
    const { kept: ownRulesToCopy, skipped: skippedOwnRules } = carryableOwnRules(oldRecord, allMods, oldModId);
    for (const rule of ownRulesToCopy) items.push({ kind: 'own', modId: newModId, add: rule });
    const modsWithFreshMembership = new Set(items.filter((i) => i.kind === 'membership').map((i) => i.modId));
    for (const { modId: referencingModId, oldRule } of findOtherModsReferencingInOwnRules(oldModId, allMods, pluginId)) {
        const wouldDuplicate = modsWithFreshMembership.has(referencingModId) || hasExistingRuleForMod(allMods[referencingModId], newModId, oldRule);
        if (wouldDuplicate) items.push({ kind: 'remove_duplicate', modId: referencingModId, remove: oldRule });
        else items.push({ kind: 'repoint', modId: referencingModId, remove: oldRule, add: buildMembershipRule(oldRule, newModId, newMod) });
    }
    return { items, skippedOwnRules };
}

const stripKind = ({ kind, ...rest }) => rest; // eslint-disable-line no-unused-vars
function stableStringify(v) {
    if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
    return JSON.stringify(v);
}
const ruleEq = (a, b) => stableStringify(a) === stableStringify(b);

// True when Vortex's own state shows this change in place: the rule to add is there, the rule to remove is gone.
function ruleItemApplied(item, mods) {
    const mod = mods && mods[item.modId];
    if (!mod) return false;
    return ruleItemAppliedIn(item, Array.isArray(mod.rules) ? mod.rules : []);
}
function ruleItemAppliedIn(item, rules) {
    const addOk = !item.add || rules.some((r) => ruleEq(r, item.add));
    const removeOk = !item.remove || (item.add && ruleEq(item.remove, item.add)) || !rules.some((r) => ruleEq(r, item.remove));
    return addOk && removeOk;
}

// Pauses between confirmation reads (2026-10-05, the real SeverActions update: Vortex was too busy to answer the read-back, and the rules, which had taken, were
// reported as "didn't carry over"). A busy Vortex gets time, not a request storm: 5 s, 10, 20, 25, 30 = about 90 s in all. Tests shorten them.
let rulesRetryDelaysMs = [5000, 10000, 20000, 25000, 30000];
function setRulesRetryDelays(list) { rulesRetryDelaysMs = list; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One read-back of the given rule changes, with the light read (GET /rules/:modId, one mod) -- only when the Bridge answers 404 for it (an older Bridge) does it fall back to
// the whole mod list, once per round. Sorts each item into done (Vortex shows it), missing (a read SUCCEEDED and it is not there) or unknown (the read could not be done).
async function readBackRules(pending) {
    const out = { done: [], missing: [], unknown: [] };
    const byMod = new Map();
    for (const i of pending) { if (!byMod.has(i.modId)) byMod.set(i.modId, []); byMod.get(i.modId).push(i); }
    let allMods; // undefined = not read this round
    let silent = false; // Vortex did not answer: the rest of the round is not asked (each ask is a timeout)
    for (const [modId, list] of byMod) {
        let judge = null;
        if (!silent) {
            const r = await helperClient.readRulesOnce(modId);
            if (r.status === 'ok') judge = (i) => ruleItemAppliedIn(i, r.rules);
            else if (r.status === 'notfound') {
                if (allMods === undefined) { const d = await helperClient.getAllMods(); allMods = d && d.mods ? d.mods : null; }
                if (allMods) judge = (i) => ruleItemApplied(i, allMods);
                else silent = true;
            } else silent = true;
        }
        for (const i of list) { if (!judge) out.unknown.push(i); else (judge(i) ? out.done : out.missing).push(i); }
    }
    return out;
}

// Step 4. Sends the changes in ONE batch (unless { send: false }: only confirm), then reads Vortex back. Three outcomes per change: confirmed; MISSING (a read that
// succeeded does not show it: re-sent ONCE, then read again; still missing = failed); UNCONFIRMED (the read could not be done: only the READ is repeated, with a
// patient back-off, never the apply). A change a successful read shows is already there is never sent again.
// Returns { allApplied, failed: [really missing], unconfirmed: [could not be checked] }.
async function applyAndConfirmRules(items, { send = true } = {}) {
    if (items.length === 0) return { allApplied: true, failed: [], unconfirmed: [] };
    if (send) await helperClient.applyRuleChangesBatchOnce(items.map(stripKind));
    let pending = items.slice();
    const resent = new Set();
    const failed = [];
    for (let attempt = 0; ; attempt++) {
        const rb = await readBackRules(pending);
        failed.push(...rb.missing.filter((i) => resent.has(i)));
        const toSend = rb.missing.filter((i) => !resent.has(i));
        pending = [...toSend, ...rb.unknown];
        if (toSend.length > 0) { await helperClient.applyRuleChangesBatchOnce(toSend.map(stripKind)); for (const i of toSend) resent.add(i); }
        if (pending.length === 0 || attempt >= rulesRetryDelaysMs.length) break;
        await sleep(rulesRetryDelaysMs[attempt]);
    }
    return { allApplied: failed.length === 0 && pending.length === 0, failed, unconfirmed: pending };
}

// Rollback for a failed install (step 3): the old mod's record, recreated exactly as it was from the snapshot (its staging
// folder was never touched), its download link, its enabled state -- then confirmed present. false if any of that fails.
async function restoreOldVersion(snapshot) {
    const rec = snapshot.oldRecord;
    if (!(await helperClient.createMod(snapshot.oldModId, rec))) return false;
    if (rec.archiveId) await helperClient.setDownloadInstalled(rec.archiveId, snapshot.oldModId);
    if (snapshot.wasEnabled) await helperClient.setModEnabled(snapshot.oldModId, true);
    const data = await helperClient.getAllMods();
    return !!(data && data.mods && data.mods[snapshot.oldModId]);
}

// Step 5: delete the old download -- the archive FILE and its Vortex download record -- but only when it is CERTAIN which download that is and nothing
// else needs it. Done the way Vortex Collection Tools' Update Collection does it (lib/vct-removal.js, a port): the archive is found by its MD5 and the file is
// deleted with the same plain delete; the record is then removed through the Bridge. The Bridge's /downloads/remove is no longer used (it fails on some Vortex
// versions). Never throws; every decision is written to logs/update.log (not the page). Returns { deleted, reason }.
async function deleteOldDownload({ pluginId, oldDownload, allMods, excludeIds, cfg }) {
    return vctRemoval.removeOldArchive({ oldDownload, allMods, excludeIds, cfg, log: (msg) => updateLog.logUpdate(`[${pluginId}] old download: ${msg}`) });
}

// Removes the old mod's staging folder -- only ever from inside Vortex's staging folder, never the folder itself.
function cleanupOldStaging(stagingPath) {
    const cfg = appConfig.loadConfig();
    if (!stagingPath || !cfg.vortexStagingFolder) return false;
    const rel = path.relative(cfg.vortexStagingFolder, stagingPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    try { fs.rmSync(stagingPath, { recursive: true, force: true }); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------------------------
// THE OLD COPY (queue: a-mod-only-shows-updated-once-the-old-copy-is-fully-gone, 2026-10-05; director: "Before we show Updated we need to
// verify the mod is gone from Vortex, the archive and the staging directory. Until it is fully deleted, it is not Updated." and "we just do what
// is needed; the Bridge has the ability to remove a mod, we call that, not delete it directly").
// Everything goes through the Bridge, the way Vortex Collection Tools does it (remove-collection-runner.js, duplicate-version-cleanup.js):
//   - the old MOD: when its staging folder really has files AND its archive is there, Vortex's own real removal (removeMods: undeploys, deletes the
//     staging folder, removes the record); otherwise record-only (a real removal of a folder that is already gone shows a blocking "Mod not found"
//     dialog in Vortex). One retry on a failure.
//   - the old DOWNLOAD, Update Collection's way (lib/vct-removal.js, a port): found by its MD5 in the Bridge's downloads list, the archive FILE deleted with the
//     same plain delete (the Bridge's /downloads/remove is not used: it fails on some Vortex versions), then its record removed through the Bridge. The shared-
//     archive checks are kept.
//   - then LOOK (the Bridge's lists, the file system), never trusting that a call returned: (a) the old mod id is not in /mods, (b) the old
//     download is not in /downloads and its archive file is gone, (c) the old staging folder is gone.
// The one backup is for the staging folder: only after the Bridge's real removal was asked and did not take it, the mod's record is gone but the folder is still
// there, it is inside Vortex's staging folder (never the folder itself) and no listed mod uses it: ModPacer removes it itself and logs it. No deploy decision anywhere.
// ---------------------------------------------------------------------------------------------
let oldCopyWait = { tries: 8, ms: 500 };
function setOldCopyWaitTiming(t) { oldCopyWait = { ...oldCopyWait, ...t }; }

const stagingHasRealFiles = vctRemoval.stagingHasRealFiles; // ported from Vortex Collection Tools (lib/vct-removal.js)

// Inside Vortex's staging folder, never the folder itself.
function insideStaging(stagingRoot, p) {
    if (!stagingRoot || !p) return false;
    const rel = path.relative(path.resolve(stagingRoot), path.resolve(p));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function readMods() { try { return await helperClient.getAllMods(); } catch { return null; } }
async function readDownloads() { try { return await helperClient.getAllDownloads(); } catch { return null; } }

// Where the old archive sits on disk (from Vortex's own record when it has one, else the saved file name), or null.
function archivePathOf(cfg, downloadsData, oldDownload) {
    const id = findOldDownloadId(downloadsData, oldDownload || {});
    const rec = id && downloadsData.files[id];
    const name = (rec && rec.localPath) || (oldDownload && oldDownload.fileName) || null;
    return name && cfg.downloadFolder ? path.resolve(cfg.downloadFolder, name) : null;
}

// Removes what is left of an old copy and checks it is all gone. `entry` = { pluginId, oldModId, oldStagingPath, oldDownload, newModId, newFileName, deleteArchive }.
// `phase`: 'mod' (the mod and its folder only) or 'all' (also the old download). The update runs 'all' right after the old mod's removal, BEFORE plugins and rules and whatever
// the rules outcome (2026-10-05, the real SeverActions update: the archive belongs to the old mod, which is already gone from Vortex, and has nothing to do with the rules).
// `onDownload`: called just before the archive step (the row's step log).
// Returns { complete, left: ['mod' | 'archive' | 'folder' | 'bridge'], download } -- never throws; every decision is in logs/update.log.
async function removeOldCopy(entry, { phase = 'all', onDownload = null } = {}) {
    const log = (msg) => updateLog.logUpdate(`[${entry.pluginId}] old copy: ${msg}`);
    const cfg = appConfig.loadConfig();
    const left = [];
    let download = { attempted: false };
    try {
        let mods = await readMods();
        if (!mods || !mods.mods) { log("Vortex's mod list could not be read: nothing changed"); return { complete: false, left: ['bridge'], download }; }
        // (1) the mod
        if (mods.mods[entry.oldModId]) {
            const downloads = await readDownloads();
            const stagingExists = stagingHasRealFiles(entry.oldStagingPath);
            const ap = archivePathOf(cfg, downloads, entry.oldDownload);
            const archiveExists = !!(ap && fs.existsSync(ap));
            let archiveFound = archiveExists;
            if (!archiveFound && entry.oldDownload && entry.oldDownload.md5 && entry.oldDownload.fileSize && cfg.downloadFolder) { // archive-locator.js: by its exact size and MD5
                try { archiveFound = !!(await vctRemoval.locateArchive(cfg.downloadFolder, { md5: entry.oldDownload.md5, fileSize: entry.oldDownload.fileSize })); } catch { archiveFound = false; }
            }
            const { ok, real } = await vctRemoval.removeModThroughBridge(entry.oldModId, { stagingExists, archiveExists: archiveFound, stagingRoot: cfg.vortexStagingFolder }, log);
            log(`old mod ${entry.oldModId}: ${real ? "Vortex's own removal (its folder and archive are there)" : 'record-only (its folder or archive is already gone, so nothing is left for Vortex to undeploy)'}${ok ? '' : ' -- FAILED'}`);
        }
        // (2) the download: right after the mod (Update Collection's order), whatever happens to the rules later. Never while Vortex still lists the old mod.
        const hasIdentity = !!(entry.oldDownload && (entry.oldDownload.archiveId || entry.oldDownload.md5 || entry.oldDownload.fileName));
        const afterMod = (phase === 'all' && entry.deleteArchive && hasIdentity) ? await readMods() : null;
        const modsUnreadable = !!(phase === 'all' && entry.deleteArchive && hasIdentity && !(afterMod && afterMod.mods));
        const modStillListed = modsUnreadable || !!(afterMod && afterMod.mods && afterMod.mods[entry.oldModId]);
        if (modsUnreadable) log("Vortex's mod list could not be read after the removal: its archive is left alone for now");
        else if (modStillListed) log('Vortex still lists the old mod: its archive is left alone for now');
        if (phase === 'all' && entry.deleteArchive && hasIdentity && !modStillListed) {
            if (onDownload) onDownload();
            const fresh = afterMod;
            let r = null;
            for (let attempt = 1; attempt <= 2; attempt++) {
                r = await deleteOldDownload({ pluginId: entry.pluginId, oldDownload: entry.oldDownload, allMods: (fresh && fresh.mods) || mods.mods, excludeIds: [entry.oldModId, entry.newModId], cfg });
                if (r.deleted === true || r.deleted === 'record_only' || oldCleanup.LEFT_ALONE_ON_PURPOSE.includes(r.reason)) break;
            }
            download = { attempted: true, ...r };
        }
        // (3) look: the three checks, with a moment for Vortex to finish what it was asked
        const archiveDecided = phase !== 'all' || !entry.deleteArchive || !hasIdentity
            || oldCleanup.LEFT_ALONE_ON_PURPOSE.includes(download.reason) || download.deleted === 'record_only';
        const check = { mod: false, archive: archiveDecided, folder: false, unreadable: false };
        for (let i = 0; i < oldCopyWait.tries; i++) {
            mods = await readMods();
            const downloads = await readDownloads();
            if (!mods || !mods.mods) check.unreadable = true;
            else {
                check.unreadable = false;
                check.mod = !mods.mods[entry.oldModId];
                check.folder = !fs.existsSync(entry.oldStagingPath);
                if (!archiveDecided) {
                    const id = findOldDownloadId(downloads, entry.oldDownload);
                    const ap = archivePathOf(cfg, downloads, entry.oldDownload);
                    check.archive = !!downloads && !!downloads.files && !id && !(ap && fs.existsSync(ap));
                }
            }
            if (!check.unreadable && check.mod && check.archive && check.folder) break;
            if (i < oldCopyWait.tries - 1) await new Promise((r) => setTimeout(r, oldCopyWait.ms));
        }
        // THE BACKUP for the folder: the Bridge's real removal (Update Collection's way) was asked and the mod's record is gone, but the folder is still there. Only inside Vortex's staging folder (never the folder itself), and only when no listed mod uses it. Logged.
        if (!check.unreadable && !check.folder && insideStaging(cfg.vortexStagingFolder, entry.oldStagingPath)) {
            const fresh = await readMods();
            if (fresh && fresh.mods && !fresh.mods[entry.oldModId]) {
                const target = path.resolve(entry.oldStagingPath).toLowerCase();
                const used = Object.values(fresh.mods).some((m) => m && m.installationPath && path.resolve(cfg.vortexStagingFolder, m.installationPath).toLowerCase() === target);
                if (!used) {
                    cleanupOldStaging(entry.oldStagingPath);
                    check.folder = !fs.existsSync(entry.oldStagingPath);
                    log(check.folder ? 'Vortex left the folder, removed it directly (backup)' : 'Vortex left the folder and it could not be removed directly');
                } else log('Vortex left the folder but a listed mod uses it: left alone');
            }
        }
        if (check.unreadable) left.push('bridge');
        else {
            if (!check.mod) left.push('mod');
            if (!check.archive) left.push('archive');
            if (!check.folder) left.push('folder');
        }
        log(left.length === 0 ? `gone: its Vortex record, ${phase === 'all' && entry.deleteArchive ? 'its archive and ' : ''}its staging folder` : `still there: ${left.join(', ')}`);
        return { complete: left.length === 0, left, download };
    } catch (e) {
        log(`stopped by an error: ${e.message}`);
        return { complete: false, left: left.length ? left : ['bridge'], download };
    }
}

// A saved entry's retry (the row's Try again, and the next run of ModPacer): asks Vortex's state first, then does the whole removal again.
async function finishOldCopy(entry) {
    const state = await getWritableState();
    if (state !== 'connected') return { complete: false, left: ['bridge'], reason: state };
    return removeOldCopy(entry, { phase: 'all' });
}

// "Installed" means Vortex says so. After the install is sent, ask the Bridge (/mods) until the new mod is listed with the new version
// and switched on (when it should be), and -- for an update -- the old one is gone. Polls about every second at first, then every few
// seconds, for up to 3 minutes per mod. Returns { ok, seconds }. The Bridge has no one-mod "installed and enabled" answer, so this
// uses the closest honest signal: the mod's own entry in /mods plus enabledModKeys.
let installWaitTiming = { timeoutMs: 180_000, fastMs: 1000, slowMs: 3000, fastPolls: 10 };
function setInstallWaitTiming(t) { installWaitTiming = { ...installWaitTiming, ...t }; }
function modShowsInstalled(data, { modId, version, expectEnabled, oldModId }) {
    const mod = data && data.mods && data.mods[modId];
    if (!mod) return false;
    if (mod.state && mod.state !== 'installed') return false;
    if (version && entryVersion(mod) !== version) return false;
    if (expectEnabled && !(data.enabledModKeys || []).includes(modId)) return false;
    if (oldModId && oldModId !== modId && data.mods[oldModId]) return false;
    return true;
}
async function waitForVortexInstall(check) {
    const t = installWaitTiming;
    const started = Date.now();
    let polls = 0;
    for (;;) {
        let data = null;
        try { data = await helperClient.getAllMods(); } catch { data = null; }
        if (modShowsInstalled(data, check)) return { ok: true, seconds: Math.round((Date.now() - started) / 100) / 10 };
        if (Date.now() - started >= t.timeoutMs) return { ok: false, seconds: Math.round((Date.now() - started) / 100) / 10 };
        polls += 1;
        await new Promise((r) => setTimeout(r, polls <= t.fastPolls ? t.fastMs : t.slowMs));
    }
}

async function _finishSwap({ pluginId, archivePath, newVersion, oldModId, oldMod, allMods, enabledModKeys, plan, displayName, urlKind, ifDisabled }) {
    const cfg = appConfig.loadConfig();
    const archiveFileName = path.basename(archivePath);
    const archiveBaseName = path.basename(archivePath, path.extname(archivePath));
    const archiveMd5 = await hashFileMd5(archivePath);
    const archiveStat = fs.statSync(archivePath);
    const newModId = resolveAvailableModId(archiveBaseName, allMods, archiveMd5);
    const newStagingPath = path.join(cfg.vortexStagingFolder, newModId);
    // Pure local work first (nothing in Vortex changes yet): a bad archive fails here, before the old mod is touched.
    updateProgress.step(pluginId, 'extracting');
    await installArchive.extractPlan(plan, archivePath, newStagingPath);

    // A blank catalog version falls back to the extracted manifest's own version (see readExtractedVersion).
    const resolvedVersion = newVersion || readExtractedVersion(newStagingPath, pluginId) || '';
    const isFomod = plan.kind === 'fomod';
    const sourceType = urlKind === 'nexus' ? 'nexus' : 'offsite';
    const newMod = {
        name: displayName || newModId,
        source: { type: sourceType, md5: archiveMd5, fileSize: archiveStat.size, version: resolvedVersion, logicalFilename: archiveFileName },
        choices: isFomod ? { type: 'fomod', options: plan.choicesUsed.options } : undefined,
    };
    // Reuses a download Vortex already has for this exact archive before registering a new one (the "two rows" fix).
    const archiveId = await resolveOrRegisterArchiveId(archiveFileName, archiveMd5, archiveStat.size);
    // A mod that is not in Vortex at all (oldModId null) is installed as new: every step that needs an old copy is skipped
    // (no snapshot, no rules carried over, no old mod removed, no old-download cleanup), and the new mod is switched on.
    const fresh = !oldModId;
    const oldModRecord = fresh ? {} : (allMods[oldModId] || {});
    const fileOverridesToCopy = fresh ? [] : carryableFileOverrides(oldModRecord, newStagingPath);
    const oldInstallationPath = oldModRecord.installationPath || oldModId;
    const oldStagingPath = fresh ? null : path.join(cfg.vortexStagingFolder, oldInstallationPath);

    // 1. READ -- the snapshot, and the rule plan worked out from it, before anything in Vortex changes.
    let snapshot = { wasEnabled: true, oldDownload: null };
    let ruleItems = [];
    let skippedOwnRules = [];
    let snapshotPath = null;
    let oldCollectionIds = null; // the collections the old copy was in at the moment of the update (null for a fresh install)
    let oldPluginStates = null; // each of the old mod's plugins: on / off / ghosted / unknown, read now while Vortex still lists them
    if (!fresh) {
        const dataFolder = cfg.skyrimInstallPath ? path.join(cfg.skyrimInstallPath, 'Data') : null;
        oldPluginStates = await modPlugins.readPluginStates(modPlugins.listPluginFiles(oldStagingPath), { dataFolder });
        snapshot = buildUpdateSnapshot({ pluginId, oldModId, allMods, enabledModKeys, oldMod });
        const referencingCollections = matchCollectionsFromRules(oldModId, allMods, getRulesByCollection(allMods));
        ({ items: ruleItems, skippedOwnRules } = planRuleItems({ oldModId, oldRecord: oldModRecord, allMods, pluginId, newModId, newMod, referencingCollections }));
        snapshot.newModId = newModId;
        snapshot.ruleItems = ruleItems;
        // The collections the old copy is in right now (Vortex's own view): the new copy must end in exactly these.
        oldCollectionIds = [...new Set(referencingCollections.map((h) => h.collectionModId))];
        snapshot.collectionIds = oldCollectionIds;
        snapshotPath = writeSnapshot(snapshot);
        updateLog.logUpdate(`[${pluginId}] update ${oldModId} -> ${newModId}: snapshot saved (${ruleItems.length} rule change(s)) at ${snapshotPath}`);

    } else {
        updateLog.logUpdate(`[${pluginId}] not in Vortex: installing ${newModId} as new (no old copy to replace)`);
    }

    // 3. INSTALL the new mod.
    updateProgress.step(pluginId, 'installing');
    const created = await helperClient.createMod(newModId, {
        id: newModId, state: 'installed', type: '', installationPath: newModId,
        ...(archiveId ? { archiveId } : {}), // a sibling of attributes on the real mod record, never nested inside it
        ...(fileOverridesToCopy.length > 0 ? { fileOverrides: fileOverridesToCopy } : {}),
        attributes: {
            // name = the mod's own folder/id; customFileName = the nicer display name (the same split Vortex itself uses).
            name: newModId,
            installTime: new Date().toISOString(),
            ...(displayName ? { customFileName: displayName } : {}),
            fileName: archiveFileName,
            logicalFileName: archiveFileName,
            fileMD5: archiveMd5,
            fileSize: archiveStat.size,
            version: resolvedVersion,
            // "unknown", not "offsite": the real value Vortex assigns a plain archive install with no recognized provenance.
            source: sourceType === 'nexus' ? 'nexus' : 'unknown',
            ...(isFomod ? { installerChoices: newMod.choices } : {}),
        },
    });
    if (!created && fresh) {
        fs.rmSync(newStagingPath, { recursive: true, force: true });
        updateLog.logUpdate(`[${pluginId}] installing as new failed; nothing was changed`);
        return { ok: false, reason: 'install_failed' };
    }
    if (!created) {
        // The old mod is only removed AFTER the new one is confirmed in, so it is still exactly as it was: nothing to restore.
        const stillThere = await readMods();
        fs.rmSync(newStagingPath, { recursive: true, force: true });
        removeSnapshot(snapshotPath);
        if (stillThere && stillThere.mods && stillThere.mods[oldModId]) {
            updateLog.logUpdate(`[${pluginId}] installing the new version failed; the old version was never touched`);
            return { ok: false, reason: 'update_failed_restored' };
        }
        updateLog.logUpdate(`[${pluginId}] installing the new version failed AND Vortex no longer lists the old version; its saved record is at ${snapshotPath}`);
        const restored = await restoreOldVersion(snapshot);
        if (restored) return { ok: false, reason: 'update_failed_restored' };
        fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');
        return { ok: false, reason: 'update_failed_restore_failed', snapshotPath };
    }
    // The download's own side of the link (needs Helper v0.21.0+; a no-op on an older one, never blocks the update).
    if (archiveId) await helperClient.setDownloadInstalled(archiveId, newModId);
    // A mod that was OFF in Vortex: the person chose to enable it with the update ('enable') or keep it off (anything else: the old "change nothing" rule).
    const enableDisabled = ifDisabled === 'enable' && !snapshot.wasEnabled;
    const wasEnabled = enableDisabled ? true : snapshot.wasEnabled;
    const enableOk = wasEnabled ? await helperClient.setModEnabled(newModId, true) : true;

    // 3a. WAIT for Vortex to really have it: listed, the new version, switched on. Nothing after this (plugins, rules, "Updated",
    // the deploy offer) runs before then.
    const sentAt = Date.now();
    updateLog.logUpdate(`[${pluginId}] install sent to Vortex (${newModId})`);
    updateProgress.step(pluginId, 'waiting_for_vortex');
    const seen = await waitForVortexInstall({ modId: newModId, version: resolvedVersion, expectEnabled: wasEnabled && enableOk, oldModId: null });
    if (!seen.ok) {
        updateLog.logUpdate(`[${pluginId}] Vortex had not shown ${newModId} as installed and enabled after ${Math.round((Date.now() - sentAt) / 1000)} s; left out of the deploy`);
        return { ok: false, reason: 'vortex_unfinished', snapshotPath };
    }
    updateLog.logUpdate(`[${pluginId}] Vortex showed ${newModId} as installed and enabled after ${seen.seconds} s`);
    // 3a'. THE OLD COPY, first part: the old mod and its staging folder, through the Bridge (never a direct delete). The old download follows in step 5.
    const od0 = snapshot.oldDownload || {};
    const oldCopyEntry = fresh ? null : {
        pluginId, oldModId, oldStagingPath, oldDownload: { archiveId: od0.archiveId || null, md5: od0.md5 || null, fileName: od0.fileName || null, fileSize: od0.fileSize || null },
        newModId, newFileName: archiveFileName, deleteArchive: !!cfg.deleteOldDownloadAfterUpdate,
    };
    let oldCopy = { complete: true, left: [] };
    if (oldCopyEntry) {
        updateProgress.step(pluginId, 'removing_old');
        // The old mod and then its archive, right here: before the plugins and the rules, and whatever their outcome (the archive belongs to the old mod, which is gone).
        oldCopy = await removeOldCopy(oldCopyEntry, { phase: 'all', onDownload: () => updateProgress.step(pluginId, 'deleting_old_download') });
    }

    // 3b. THE PLUGINS -- a second switch, separate from the mod's. Only when the mod itself is on (it was, or this is a fresh
    // install that was just switched on): a mod the person turned off is left exactly as it was, plugins included.
    const plugins = { turnedOn: 0, failed: [], heldOff: [] };
    if (wasEnabled && enableOk) {
        const plan = modPlugins.planPlugins({ newNames: modPlugins.listPluginFiles(newStagingPath), oldStates: enableDisabled ? {} : oldPluginStates, modWasEnabled: true }); // a mod just switched on: all its plugins are new to the list
        plugins.heldOff = plan.heldOff;
        if (plan.enable.length > 0) {
            updateProgress.step(pluginId, 'enabling_plugins');
            const r = await modPlugins.enablePlugins(plan.enable);
            plugins.turnedOn = r.turnedOn.length;
            plugins.failed = r.failed;
            updateLog.logUpdate(`[${pluginId}] plugins: turned on ${r.turnedOn.length} of ${plan.enable.length}${r.failed.length ? `; Vortex would not switch on ${r.failed.join(', ')} yet (tried again before the deploy)` : ''}`);
        }
        if (plan.heldOff.length > 0) {
            const putBack = await modPlugins.keepOff(plan.heldOff);
            updateLog.logUpdate(`[${pluginId}] plugins left off, as the person had them: ${plan.heldOff.join(', ')}${putBack.length ? `; switched back off after the swap: ${putBack.join(', ')}` : ''}`);
        }
    }

    // 4. APPLY the saved rules in one batch and confirm they took (the step only shows when there are rules to carry).
    if (ruleItems.length > 0) updateProgress.step(pluginId, 'carrying_rules');
    const ruleResult = await applyAndConfirmRules(ruleItems);
    const failedKeys = new Set([...ruleResult.failed, ...ruleResult.unconfirmed].map((i) => stableStringify(stripKind(i))));
    const confirmed = (item) => !failedKeys.has(stableStringify(stripKind(item)));
    const membershipMoves = ruleItems.filter((i) => i.kind === 'membership').map((i) => ({ collectionModId: i.modId, ok: confirmed(i) }));
    const ruleMoves = ruleItems.filter((i) => i.kind === 'repoint' || i.kind === 'remove_duplicate')
        .map((i) => ({ modId: i.modId, ok: confirmed(i), action: i.kind === 'repoint' ? 'repointed' : 'removed_duplicate' }));
    // 4b. The new copy must be in exactly the old copy's collections: whatever Vortex (or a leftover rule that happens to match its name) added is
    // taken out again. Read from Vortex after the install, never assumed.
    const collections = { carried: [], removedExtra: [], failedExtra: 0, unconfirmedExtra: 0 };
    if (!fresh && oldCollectionIds) {
        const afterData = await helperClient.getAllMods();
        const names = (ids, mods) => ids.map((id) => collectionMembership.collectionName(mods, id));
        if (afterData && afterData.mods && afterData.mods[newModId]) {
            const now = collectionMembership.membershipOf(newModId, afterData.mods);
            const extra = now.filter((m) => !oldCollectionIds.includes(m.collectionModId));
            collections.carried = names(oldCollectionIds, afterData.mods);
            if (extra.length > 0) {
                const extraItems = [];
                for (const { collectionModId, rules } of extra) for (const rule of rules) extraItems.push({ kind: 'extra', modId: collectionModId, remove: rule });
                const extraResult = await applyAndConfirmRules(extraItems);
                collections.removedExtra = names(extra.map((e) => e.collectionModId), afterData.mods);
                collections.failedExtra = extraResult.failed.length;
                collections.unconfirmedExtra = extraResult.unconfirmed.length;
                if (extraResult.failed.length > 0) ruleResult.failed.push(...extraResult.failed);
                updateLog.logUpdate(`[${pluginId}] the new copy was in collections the old copy was not in (${collections.removedExtra.join(', ')}): taken out again`);
            }
        } else {
            collections.carried = names(oldCollectionIds, allMods);
        }
    }
    const partial = [];
    // 'rules' = a read that SUCCEEDED shows a change missing; 'rules_unchecked' = Vortex could not be asked (too busy), so nothing is known to be wrong.
    if (ruleResult.failed.length > 0 || collections.failedExtra > 0) partial.push('rules');
    else if (ruleResult.unconfirmed.length > 0 || collections.unconfirmedExtra > 0) partial.push('rules_unchecked');
    if (!enableOk) partial.push('enable');
    if (!enableOk) { snapshot.enableFailed = true; }

    // 5. The old copy was removed (mod, archive, folder) right after the install, before the plugins and the rules. What is still there is remembered here and removed
    // again later (Try again, the next check, the next start). A partial rules outcome is kept separately (the snapshot and its Try again) and never holds the archive back.
    let oldDownload = (oldCopy && oldCopy.download) || { attempted: false };
    if (oldCopyEntry) {
        if (!oldCopy.complete) oldCopyStore.add({ ...oldCopyEntry, left: oldCopy.left, waitingOnRules: partial.length > 0 });
        else oldCopyStore.remove(pluginId);
    }

    if (fresh) {
        updateLog.logUpdate(`[${pluginId}] installed as new (${newModId})${partial.length ? `; not everything worked (${partial.join(', ')})` : ''}`);
    } else if (partial.length === 0) {
        removeSnapshot(snapshotPath);
        updateLog.logUpdate(`[${pluginId}] collections carried: ${collections.carried.length}${collections.carried.length ? ` (${collections.carried.join(', ')})` : ''}; rule changes: ${ruleItems.filter((i) => i.kind !== 'membership').length}`);
        updateLog.logUpdate(`[${pluginId}] update complete (${oldModId} -> ${newModId})`);
    } else {
        fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');
        updateLog.logUpdate(`[${pluginId}] update installed but not everything carried over (${partial.join(', ')}); ${ruleResult.failed.length} rule change(s) missing, ${ruleResult.unconfirmed.length} could not be checked; snapshot kept at ${snapshotPath}`);
    }

    return {
        ok: true, oldModId, newModId, wasEnabled, collections, membershipMoves, ruleMoves, skippedOwnRules, fileOverridesToCopy,
        fomodWarnings: isFomod ? plan.warnings : [],
        partial, failedRuleCount: ruleResult.failed.length + ruleResult.unconfirmed.length, oldDownload, oldStagingPath, oldCopy: { complete: oldCopy.complete && partial.length === 0, left: oldCopy.left, waitingOnRules: partial.length > 0 }, plugins,
        snapshotPath: partial.length === 0 || fresh ? null : snapshotPath,
        fresh,
    };
}

// "Try again" for a partial update: re-applies ONLY the rule changes Vortex doesn't show yet (and the enabled flag if that
// failed), then -- once everything is confirmed -- does the old-download deletion that was held back. Reads the snapshot
// the update left behind. Returns { ok, reason?, partial?, oldDownload? }.
async function retryCarryOver(snapshotPath) {
    const snapshot = readSnapshot(snapshotPath);
    if (!snapshot) return { ok: false, reason: 'snapshot_missing' };
    const state = await getWritableState();
    if (state !== 'connected') return { ok: false, reason: state };
    // Reads first: what a successful read shows is already there is never sent again; only what is missing is, once.
    const result = await applyAndConfirmRules(snapshot.ruleItems || [], { send: false });
    let enableOk = true;
    if (snapshot.enableFailed) enableOk = await helperClient.setModEnabled(snapshot.newModId, true);
    const partial = [];
    if (result.failed.length > 0) partial.push('rules');
    else if (result.unconfirmed.length > 0) partial.push('rules_unchecked');
    if (!enableOk) partial.push('enable');
    if (partial.length > 0) {
        updateLog.logUpdate(`[${snapshot.pluginId}] try again: still not everything (${partial.join(', ')})`);
        return { ok: false, reason: 'not_confirmed', partial };
    }
    const cfg = appConfig.loadConfig();
    let oldDownload = { attempted: false };
    let oldCopy = { complete: true, left: [] };
    const saved = oldCopyStore.get(snapshot.pluginId);
    if (saved) {
        oldCopy = await removeOldCopy({ ...saved, deleteArchive: !!cfg.deleteOldDownloadAfterUpdate }, { phase: 'all' });
        oldDownload = oldCopy.download || oldDownload;
        if (oldCopy.complete) oldCopyStore.remove(snapshot.pluginId);
        else oldCopyStore.update(snapshot.pluginId, { left: oldCopy.left, waitingOnRules: false });
    }
    removeSnapshot(snapshotPath);
    updateLog.logUpdate(`[${snapshot.pluginId}] try again: everything carried over`);
    return { ok: true, partial: [], oldDownload, oldCopy: { complete: oldCopy.complete, left: oldCopy.left } };
}

// Fetches the Helper's live state and resolves which mod owns pluginId -- shared by updateInVortex
// and finishFomodWizard so both start from the exact same real, current data. Returns
// {ok:false, reason} directly (not thrown) for every "expected" outcome this shares with its
// callers' own early-return contract.
async function _loadOwningMod(pluginId) {
    const connectionState = await getWritableState();
    if (connectionState !== 'connected') return { ok: false, reason: connectionState };

    const allModsData = await loadAllMods();
    if (!allModsData) return { ok: false, reason: 'vortex_starting' };
    const { mods: allMods, enabledModKeys } = allModsData;

    const { modId: oldModId, reason } = findOwningModId(pluginId, allMods, enabledModKeys);
    if (!oldModId && reason === 'not_found' && Object.keys(allMods).length > 0) {
        // Not in Vortex at all: installed as new. Nothing old exists, so no old choices, rules or mod to remove.
        return { ok: true, fresh: true, allMods, enabledModKeys, oldModId: null, oldMod: { name: null, choices: undefined } };
    }
    if (!oldModId) return { ok: false, reason: reason || 'not_found' };

    const oldMod = buildModFromLiveData(allMods, oldModId);
    if (!oldMod) return { ok: false, reason: 'not_found' };

    return { ok: true, allMods, enabledModKeys, oldModId, oldMod };
}

// The full swap: download an archive is already done by the caller (plugin-updater-engine.js) --
// this takes it from there. Returns {ok, reason?, detail?}. Never throws for an "expected" outcome
// (mod not found, nothing to carry over) -- only a genuine unexpected failure propagates.
//
// On a FOMOD, the result is reason 'fomod_mismatch': the caller shows the picker screen (prepareFomodWizard) and nothing is installed.
async function updateInVortex(pluginId, archivePath, newVersion, { displayName, urlKind, ifDisabled } = {}) {
    const loaded = await _loadOwningMod(pluginId);
    if (!loaded.ok) return loaded;
    const { allMods, enabledModKeys, oldModId, oldMod } = loaded; // oldModId is null for a mod that is not in Vortex yet (a fresh install)

    // FOMOD plan, carrying over the old choices -- a mismatch is returned to the caller (the web
    // UI shows the wizard), never guessed at here.
    const plan = await installArchive.planInstall(archivePath, oldMod.choices);
    if (plan.kind === 'fomod-mismatch') {
        return { ok: false, reason: 'fomod_mismatch', detail: { kind: plan.kind, reason: plan.reason } };
    }
    if (plan.kind === 'fomod') plan.choicesUsed = oldMod.choices;

    return _finishSwap({ pluginId, archivePath, newVersion, oldModId, oldMod, allMods, enabledModKeys, plan, displayName, urlKind, ifDisabled });
}

// Which of these mods are switched OFF in Vortex right now (read fresh, for the "enable it or keep it disabled?" question).
// Returns the plugin ids; a mod Vortex cannot be read for, or that is not in Vortex, is never listed.
async function disabledModIds(pluginIds) {
    if (modManager.isMo2() || pluginIds.length === 0) return [];
    if ((await getHelperConnectionState()) !== 'connected') return [];
    const data = await loadAllMods();
    if (!data) return [];
    return pluginIds.filter((id) => {
        const { modId } = findOwningModId(id, data.mods, data.enabledModKeys);
        return !!modId && !data.enabledModKeys.includes(modId);
    });
}

// Resumes an update after the player stepped through the picker screen (queue: updater-v1-polish,
// 2026-09-30) -- `picks` is what the screen reports: { [stepIdx]: { [groupIdx]: number[] } }, plugin indices
// into the NEW archive's own FOMOD. Re-fetches the
// Helper's live state fresh (rather than trusting anything cached from the earlier mismatch call)
// -- the player may have taken a while clicking through the wizard, and Vortex's own live state is
// the only thing that's ever trusted here.
async function finishFomodWizard(pluginId, archivePath, newVersion, picks, { displayName, urlKind, ifDisabled } = {}) {
    const loaded = await _loadOwningMod(pluginId);
    if (!loaded.ok) return loaded;
    const { allMods, enabledModKeys, oldModId, oldMod } = loaded;

    const { plan, choices } = await installArchive.planInstallWithPicks(archivePath, picks);
    plan.choicesUsed = choices;

    return _finishSwap({ pluginId, archivePath, newVersion, oldModId, oldMod, allMods, enabledModKeys, plan, displayName, urlKind, ifDisabled });
}

// The FOMOD screen's data for one mod, WITHOUT installing anything: the new archive's parsed options, the old
// recorded choices (the screen pre-fills from them), and its preview images registered for GET /api/fomod-image.
// { ok:true, picker } for a FOMOD; { ok:true, picker:null } for a plain archive (no screen to show). The page asks
// this when the player presses a FOMOD row's Update, and for each FOMOD mod an Update all reaches.
async function prepareFomodWizard(pluginId, archivePath) {
    const loaded = await _loadOwningMod(pluginId);
    if (!loaded.ok) return loaded;
    const plan = await installArchive.planInstall(archivePath, loaded.oldMod.choices);
    if (plan.kind !== 'fomod-mismatch') return { ok: true, picker: null };
    const { parsedFomod, imageCacheToken } = await installArchive.prepareFomodScreen(archivePath, pluginId);
    const recorded = loaded.oldMod.choices && loaded.oldMod.choices.type === 'fomod' ? loaded.oldMod.choices : undefined;
    return {
        ok: true,
        picker: {
            modId: pluginId,
            // Something recorded -> its picks pre-fill the screen (marked as the previous pick); nothing -> a fresh FOMOD.
            reason: recorded ? 'mismatch' : 'open',
            parsedFomod,
            existingChoices: recorded,
            installedFileState: { available: false },
            imageCacheToken,
        },
    };
}

// For the "Before it updates" confirm card -- what Update would do, without doing it. Returns
// null if the Helper isn't reachable or the mod can't be found (the caller falls back to no
// Update button at all in that case, per the task's own spec).
async function previewUpdate(pluginId) {
    const loaded = await _loadOwningMod(pluginId);
    if (!loaded.ok) return null;
    const { allMods, oldModId, oldMod } = loaded;
    if (loaded.fresh) return { oldModId: null, oldModName: null, collectionNames: [], notInVortex: true };
    const referencingCollections = await findCollectionsReferencing(oldModId, allMods);
    const collectionNames = [...new Set(referencingCollections.map(({ collectionModId }) => {
        const c = allMods[collectionModId];
        return (c && c.attributes && (c.attributes.customFileName || c.attributes.name)) || collectionModId;
    }))];
    return { oldModId, oldModName: oldMod.name, collectionNames };
}

// Recomputes "can Update" for a whole batch of already-downloaded plugin ids in one pass (queue:
// fix-update-button-folder-layout, 2026-09-30) -- the Plugins tab calls this every time it asks for
// state, not only once right after a download, so a row whose owning mod wasn't findable yet
// (Helper not running, staging folder not set, or the match itself failing -- the original bug
// here) picks up its Update button the moment all three line up, with no re-download needed. One
// shared Helper fetch (allMods + every collection's rules) for the whole batch, never one Helper
// round trip per row. Returns `{ [pluginId]: { preview: {...}|null, reason: string|null } }` --
// `reason` is only ever meaningful when `preview` is null, and is the same vocabulary
// `_loadOwningMod` already uses elsewhere ('helper_unavailable', 'no_staging_folder_configured',
// 'not_found').
async function previewUpdatesBatch(pluginIds) {
    const out = {};
    if (pluginIds.length === 0) return out;

    const connectionState = applyStartingWindow(await getWritableState());
    if (connectionState !== 'connected') {
        for (const id of pluginIds) out[id] = { preview: null, reason: connectionState };
        return out;
    }
    const allModsData = await loadAllMods();
    if (!allModsData) {
        for (const id of pluginIds) out[id] = { preview: null, reason: 'vortex_starting' };
        return out;
    }
    const { mods: allMods } = allModsData;
    const rulesByCollection = getRulesByCollection(allMods);

    for (const pluginId of pluginIds) {
        const { modId: oldModId, reason } = findOwningModId(pluginId, allMods, allModsData.enabledModKeys);
        if (!oldModId && reason === 'not_found' && Object.keys(allMods).length > 0) {
            // Not in Vortex at all: nothing old to replace, so the row just offers Install (no old rules, no old mod to remove).
            out[pluginId] = { preview: { oldModId: null, oldModName: null, collectionNames: [], notInVortex: true }, reason: null };
            continue;
        }
        if (!oldModId) {
            out[pluginId] = { preview: null, reason: reason || 'not_found' };
            continue;
        }
        const oldMod = buildModFromLiveData(allMods, oldModId);
        if (!oldMod) {
            out[pluginId] = { preview: null, reason: 'not_found' };
            continue;
        }
        const referencingCollections = matchCollectionsFromRules(oldModId, allMods, rulesByCollection);
        const collectionNames = [...new Set(referencingCollections.map(({ collectionModId }) => {
            const c = allMods[collectionModId];
            return (c && c.attributes && (c.attributes.customFileName || c.attributes.name)) || collectionModId;
        }))];
        out[pluginId] = { preview: { oldModId, oldModName: oldMod.name, collectionNames }, reason: null };
    }
    return out;
}

// A /mods request (the one big read) that fails or times out is NOT retried straight away: after a
// failure every caller gets "not available" for a while (10 s, doubling to 60 s on repeats) instead of
// sending the same heavy request into a Vortex that can't answer it yet (queue: vortex-ready-quiet-window,
// 2026-10-01). A success clears it. resetBackoff() is for tests.
let modsBackoffStep = 0;
let modsBackoffUntil = 0;
async function loadAllMods() {
    if (Date.now() < modsBackoffUntil) return null;
    const data = await helperClient.getAllMods();
    if (!data) {
        modsBackoffStep = modsBackoffStep ? Math.min(modsBackoffStep * 2, 60_000) : 10_000;
        modsBackoffUntil = Date.now() + modsBackoffStep;
        helperClient.noteReadFailed(); // busy again: it has to prove it is ready (two good reads) before anyone is sent real work
        return null;
    }
    modsBackoffStep = 0;
    modsBackoffUntil = 0;
    return data;
}
function resetBackoff() { modsBackoffStep = 0; modsBackoffUntil = 0; listLookedEmpty = false; }
// The last resolve got a mod list with nothing in it from a Vortex that has had mods: it has not loaded yet (the rows wait and retry).
let listLookedEmpty = false;
function lastListLookedEmpty() { return listLookedEmpty; }
// True while a failed big read is still being waited out (the rows say "Waiting for Vortex...").
function isModsReadBackingOff() { return modsBackoffStep > 0; }

// "Vortex is starting" (queue: no-fake-downloading, 2026-10-01). Vortex running but its Helper not
// answering yet is normal for the first stretch after Vortex opens, and looks identical to a Helper
// that is never going to answer. For STARTING_WINDOW_MS after we first see that state it is reported
// as 'vortex_starting' (rows say "Waiting for Vortex..."); only if it persists past that does it
// become the real 'vortex_running_helper_unreachable' (the "try restarting Vortex" notice). Any other
// state resets the clock. Tests set the window with setStartingWindowMs.
let startingWindowMs = 90_000;
let silentSince = null;
function setStartingWindowMs(ms) { startingWindowMs = ms; silentSince = null; }
function applyStartingWindow(state, now = Date.now()) {
    if (state !== 'vortex_running_helper_unreachable') { silentSince = null; return state; }
    if (silentSince === null) silentSince = now;
    return now - silentSince < startingWindowMs ? 'vortex_starting' : state;
}

// True if Helper's own real HTTP server is answering right now -- the SIMPLE, binary question
// most of this file already asks via helperClient.checkHelperAvailable. getHelperConnectionState
// below is the richer, THREE-way version of this same question, for callers that need to tell a
// closed Vortex apart from an open-but-unreachable one.
async function getHelperConnectionState() {
    const state = await computeHelperConnectionState();
    if (connectionListener) { try { connectionListener(applyStartingWindow(state)); } catch { /* a listener must never break a check */ } }
    return state;
}

// The state for anything that CHANGES Vortex or needs a newer Bridge route (an update, Try again, the old copy's removal, the update preview, the deploy): the connection
// state, except 'helper_outdated' when the Bridge answered but reports a version older than MIN_HELPER_VERSION (2026-10-05). Those operations are held back then, with the
// same sentence on the page, instead of half-working. A Bridge whose version could not be read is never "outdated". Reading Vortex (the version check) is not held back.
async function getWritableState() {
    const state = await getHelperConnectionState();
    return state === 'connected' && helperClient.bridgeIsTooOld() ? 'helper_outdated' : state;
}

// Told the (start-up-window-adjusted) state every time it is worked out -- the black window's plain
// "Vortex is starting... / ready" lines hang off this (lib/console-notes.js).
let connectionListener = null;
function setConnectionListener(fn) { connectionListener = fn; }

async function computeHelperConnectionState() {
    // Mod Organizer 2 chosen (queue: ask-which-mod-manager, 2026-10-01): no Helper, no checks, no
    // retries -- MO2 installs the update itself, so there is nothing to ask Vortex about.
    if (modManager.isMo2()) return 'mo2_manual';
    const reachable = await helperClient.checkHelperAvailable('skyrimse');
    if (reachable) {
        // Listening is not the same as ready: Vortex may still be loading and too busy for anything but
        // /health. Until a real (tiny) request is answered it is "starting" -- nobody sends it real work.
        return (await helperClient.checkHelperResponsive()) ? 'connected' : 'vortex_starting';
    }
    helperClient.resetReadiness();
    // Not answering. If the Helper extension isn't even installed, say THAT -- opening Vortex or
    // restarting it can't help. (A real answer from it in the past counts as installed.)
    if (!modManager.isHelperInstalled()) return 'helper_not_installed';
    // Real reported case, queue: helper-down-message-and-version-fallback, 2026-10-01: Vortex's
    // own log showed "listen EADDRINUSE" at startup -- something else already held port 59595, so
    // the Helper's own server never bound at all, even though Vortex itself was genuinely running.
    // checkHelperAvailable alone can't distinguish this from Vortex simply not being open.
    return helperClient.isVortexRunning() ? 'vortex_running_helper_unreachable' : 'vortex_not_running';
}

// This project's own invented heuristic -- NOT a port of anything (confirmed via a thorough real-
// source research pass, queue: helper-down-message-and-version-fallback, 2026-10-01: Vortex itself
// has no filename-to-version guessing logic anywhere in its own real source -- every real version
// Vortex ever shows comes from metadata it already has, Nexus's own API or a local meta.json
// (mod_management/util/extractors.ts's real attributeExtractor/upgradeExtractor, both read only
// `meta.fileVersion`), never derived from a file's own name). Used only as a fallback when Vortex's
// own real version attribute is genuinely empty (confirmed real case: the director's own real
// OStimNet record has `attributes.version === ""`).
//
// Finds the first dotted, version-looking group (digits-dot-digits, one optional further dot) in
// the name -- requiring a dot is what correctly tells a real version apart from an unrelated
// undotted number elsewhere in the name, the real case this has to get right:
// "OStimNet_v2.5.2_SkyrimNet_v25.zip" must read 2.5.2, never 25 -- "_v25" has no dot at all, so
// it's never even a candidate. Returns null, never a guess, when nothing dotted and version-shaped
// is found. A real, disclosed limitation: this only ever returns the FIRST such match, so a name
// mentioning two dotted numbers (a mod version AND, say, a game/SKSE version) trusts whichever
// comes first -- true for every real plugin name seen on this install, where the mod's own version
// always comes first.
function extractVersionFromFileName(fileName) {
    if (!fileName) return null;
    const match = /\d+\.\d+(?:\.\d+)?/.exec(fileName);
    return match ? match[0] : null;
}

// Resolves each installed plugin's OWN Vortex-reported identity -- its real installed version
// (`attributes.version`, falling back to `attributes.modVersion`, then a filename-derived guess
// when Vortex's own version is genuinely empty -- see extractVersionFromFileName) and where it was
// actually installed FROM (source + Nexus mod id) -- in one shared Helper fetch for the whole
// batch (queue: compare-against-vortex-version, 2026-10-01). check() calls this once per run so the
// Plugins tab compares against what the player actually sees in Vortex, not just the plugin's own
// inner manifest.json: confirmed real, the director's own Lover's Ledger installed Vortex mod
// reports version 1.1.0 while its inner manifest.json still says 1.0.2 (the author never bumped
// it) -- the Plugin Hub's own listing form defines its "version" field as the hosted mod's own
// version, i.e. the same thing Vortex shows, so Vortex's own reported value is the authoritative
// one whenever a match exists.
//
// Every real resolution (live, this call) is remembered via vortex-info-cache.js (queue:
// helper-down-message-and-version-fallback, 2026-10-01) -- the real reported bug: when the Helper
// went briefly unreachable, this used to return `{}` for everything, and every caller's own
// fallback to the plugin's inner manifest version then looked exactly as confident as a real
// Vortex-confirmed one, even though it's genuinely less reliable. Now, whenever the Helper can't be
// reached at all, this returns the REMEMBERED entry for each plugin instead (tagged `fromCache:
// true`) rather than nothing -- a plugin that's NEVER been resolved via Vortex (live or
// remembered) still correctly gets no entry at all, so callers that fall back to the manifest only
// for THOSE plugins keep doing exactly that, unaffected.
// Plugins the last COMPLETE read of Vortex's mod list had no entry for (installed for SkyrimNet, not in Vortex). Empty whenever the read was not complete.
let notInVortex = new Set();
function notInVortexIds() { return new Set(notInVortex); }
// The last COMPLETE read of Vortex's mod list, kept for the name matching in the same check (no second heavy request). Cleared at the start of every resolve.
let lastLoaded = null;
function lastLoadedMods(maxAgeMs = 120_000) { return lastLoaded && Date.now() - lastLoaded.at <= maxAgeMs ? lastLoaded : null; }
// The list for name matching when the resolve did not read it (no installed plugins to resolve): one read, with the same backoff as every other.
async function modsForPairing() {
    const have = lastLoadedMods();
    if (have) return have;
    if (modManager.isMo2() || (await getHelperConnectionState()) !== 'connected') return null;
    const data = await loadAllMods();
    if (!data || Object.keys(data.mods).length === 0) return null;
    lastLoaded = { mods: data.mods, enabledModKeys: data.enabledModKeys, at: Date.now() };
    return lastLoaded;
}
// What a Vortex mod record says about itself, in the shape resolveVortexInfoBatch reports (the version falls back to the one in its name: "STFU.v1.2.0").
function describeVortexMod(allMods, vortexModId) {
    const raw = allMods[vortexModId];
    if (!raw) return null;
    const mod = buildModFromLiveData(allMods, vortexModId);
    return {
        vortexModId,
        version: entryVersion(raw) || extractVersionFromFileName(vortexModId),
        source: mod ? mod.source.type : 'offsite',
        nexusModId: mod && mod.source.type === 'nexus' ? mod.source.modId : null,
    };
}
async function resolveVortexInfoBatch(pluginIds) {
    notInVortex = new Set();
    lastLoaded = null;
    const out = {};
    if (pluginIds.length === 0) return out;
    if (modManager.isMo2()) return out; // never contact the Vortex Helper under MO2
    const rememberedOnly = () => {
        for (const pluginId of pluginIds) {
            const remembered = vortexInfoCache.get(pluginId);
            if (remembered) out[pluginId] = { ...remembered, fromCache: true };
        }
        return out;
    };
    // Only a READY Vortex is asked for anything; otherwise what Vortex last said, from memory.
    if ((await getHelperConnectionState()) !== 'connected') return rememberedOnly();
    const allModsData = await loadAllMods();
    if (!allModsData) return rememberedOnly();
    const { mods: allMods, enabledModKeys } = allModsData;
    // A read that answers but lists nothing, from a Vortex that has listed mods before, is a list that has not loaded: not live data.
    if (Object.keys(allMods).length === 0 && vortexInfoCache.hasAny()) { listLookedEmpty = true; return rememberedOnly(); }
    listLookedEmpty = false;
    lastLoaded = { mods: allMods, enabledModKeys, at: Date.now() };

    for (const pluginId of pluginIds) {
        const { modId: vortexModId, reason: ownerReason } = findOwningModId(pluginId, allMods, enabledModKeys);
        if (!vortexModId) { if (ownerReason === 'not_found') notInVortex.add(pluginId); continue; }
        const raw = allMods[vortexModId];
        const mod = buildModFromLiveData(allMods, vortexModId);
        const version = entryVersion(raw);
        const info = {
            vortexModId,
            version,
            source: mod ? mod.source.type : 'offsite', // 'nexus' | 'offsite'
            nexusModId: mod && mod.source.type === 'nexus' ? mod.source.modId : null,
        };
        out[pluginId] = info;
        vortexInfoCache.record(pluginId, info);
    }
    return out;
}

module.exports = {
    setInstallWaitTiming, modShowsInstalled,
    updateInVortex, finishFomodWizard, prepareFomodWizard, previewUpdate, previewUpdatesBatch, resolveVortexInfoBatch,
    findOwningModId, findCollectionsReferencing, matchCollectionsFromRules, buildMembershipRule,
    resolveAvailableModId, resolveOrRegisterArchiveId, deleteOldDownload, retryCarryOver, cleanupOldStaging, removeOldCopy, finishOldCopy, setOldCopyWaitTiming, stagingHasRealFiles, setRulesRetryDelays, applyAndConfirmRules, ruleItemApplied,
    findOtherModsReferencingInOwnRules, carryableOwnRules, carryableFileOverrides,
    stripVersionSuffix, isOlderIdentityForPlugin, hasExistingRuleForMod, buildMovedReference,
    getHelperConnectionState, getWritableState, extractVersionFromFileName, findManifestPath,
    disabledModIds, lastLoadedMods, modsForPairing, describeVortexMod, setPairedMods,
    applyStartingWindow, setStartingWindowMs, setConnectionListener, resetBackoff, isModsReadBackingOff, lastListLookedEmpty, pickInstalledEntry, notInVortexIds, getRulesByCollection,
};
