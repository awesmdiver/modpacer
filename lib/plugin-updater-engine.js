'use strict';
// Top-level orchestration: check installed plugins against the Hub catalog, download updates
// (GitHub automatically; Nexus automatically only for a confirmed Premium account), and hand off
// to vortex-update.js for the in-Vortex swap. Holds the one in-memory status list the web UI
// polls/acts on -- this app has no need for anything heavier (sqlite, a job queue) at this scale.

const fs = require('fs');
const path = require('path');

// Namespace imports throughout, deliberately never destructured (queue: updater-v1-polish,
// 2026-09-30) -- a destructured `const { readInstalledPlugins } = require(...)` captures that
// function object at require time, so a test monkeypatching the exported property later (e.g.
// `skyrimnetInstall.readInstalledPlugins = fakeFn`) would silently have no effect on calls already
// bound to the original. Property access at call time (`skyrimnetInstall.readInstalledPlugins(...)`)
// stays mockable, matching how nexus/github/appConfig/vortexUpdate already had to be imported here.
const skyrimnetInstall = require('./skyrimnet-install');
const catalogLib = require('./catalog');
const hubApi = require('./hub-api');
const { logUpdate, logArea } = require('./update-log');
const selfUpdateCheck = require('./self-update-check');
const { APP_VERSION } = require('./app-version');
const pluginMatcher = require('./plugin-matcher');
const nameMatch = require('./vortex-name-match');
const vortexInfoCache = require('./vortex-info-cache');
const { compareVersions } = require('./version-compare');
const github = require('./github');
const nexus = require('./nexus');
const { chooseDownloadFileName, uniqueFileName } = require('./download-naming');
const appConfig = require('./app-config');
const vortexUpdate = require('./vortex-update');
const releaseDatesLib = require('./release-dates');
const downloadState = require('./download-state');
const helperClient = require('./vortex-helper-client');
const modManager = require('./mod-manager');
const firstRunSetup = require('./first-run-setup');
const pendingDeploy = require('./pending-deploy');
const modPlugins = require('./mod-plugins');
const mo2 = require('./mo2');
const mo2Instance = require('./mo2-instance');
const installArchive = require('./install-archive');
const oldCleanup = require('./old-download-cleanup');
const oldCopyStore = require('./old-copy-store');
const downloadState_ = require('./download-state');
const updateProgress = require('./update-progress');
const deployJob = require('./deploy-job');
updateProgress.setProgressReader(() => require('./vortex-helper-client').getDeployAllProgress({ quick: true }));

// One row per installed (external-source) plugin -- see TECHNICAL.md for the full status enum.
let state = {
    lastCheckedAt: null,
    skyrimNetDir: null,
    rows: [], // [{id, title, author, installedVersion, latestVersion, externalUrl, urlKind, status, ...}]
    error: null,
    vortexHelperState: null, // 'connected' | 'vortex_running_helper_unreachable' | 'vortex_not_running' | null (not checked yet)
};

function classifyUrl(externalUrl) {
    if (!externalUrl) return 'none';
    if (/^https?:\/\/github\.com\//i.test(externalUrl)) return 'github';
    if (/^https?:\/\/(?:www\.)?nexusmods\.com\//i.test(externalUrl)) return 'nexus';
    return 'other';
}

// The name shown for a mod everywhere (its row, the FOMOD screen): its own manifest title; when that is missing or just its id,
// the Hub's title for it; the id only as a last resort.
function displayTitle(manifest, plugin, catalogEntry) {
    const own = (manifest.title || '').trim();
    if (own && own !== plugin.id) return own;
    const hub = ((catalogEntry && catalogEntry.title) || '').trim();
    return hub || own || plugin.id;
}

// What a row knows about its Hub entry: the plugins-site page, the Hub's own id (what the plugins-page count needs), the catalog's counts
// (as of its stats_as_of time), and the link the catalog itself lists (kept to notice if the Hub's answer ever differs).
function hubFields(entry) {
    if (!entry) return { hubUrl: null, hubId: null, stats: null, listingUrl: null };
    return { hubUrl: catalogLib.hubPageUrl(entry), hubId: entry.plugin_id || null, stats: entry.stats || null, listingUrl: entry.external_url || null };
}

// A Hub listing the player does not have yet (queue: mods-not-installed-section). Same row shape as an installed one, so the download /
// install / FOMOD / deploy machinery (and Update all's) works on it unchanged; `notInstalled` keeps it out of Updates and Up to date.
function buildNotInstalledRow(entry) {
    const externalUrl = entry.external_url || null;
    return {
        id: entry.id,
        title: (entry.title || '').trim() || entry.id,
        author: entry.author || null,
        tagline: entry.tagline || null,
        // The plugin files it needs (the manifest's `mods` list, required ones only): shown as a plain warning, never blocks Install.
        requires: (Array.isArray(entry.mods) ? entry.mods : []).filter((m) => m && m.required).map((m) => m.name || m.file).filter(Boolean),
        installedVersion: null, installedVersionUnknown: false, vortexInfoFromCache: false, manifestVersionNote: null, manifestError: null,
        matchedBy: null, ambiguousMatch: false,
        downloadProgress: null, downloadedArchivePath: null, downloadedFileName: null,
        updatePreview: null, updateUnavailableReason: null, releaseDate: null, updatedAt: null, error: null,
        nsfw: !!entry.nsfw,
        ...hubFields(entry),
        latestVersion: entry.version || null,
        externalUrl, urlKind: classifyUrl(externalUrl),
        status: 'update_available',
        changelog: entry.changelog || null,
        notInstalled: true,
    };
}
// The Hub's external mod LISTINGS that are not installed: only type "listing" (never a bundle, whatever its other fields look like),
// not paired with anything installed by the matcher, not waiting to be deployed. Adult ones are built too; getState() hides (and so does not
// count) them while the Settings switch is off, so flipping the switch needs no new check.
function buildNotInstalledRows(catalogPlugins, matches, installedPlugins, cfg) {
    const matched = new Set();
    for (const m of matches.values()) if (m && m.catalogEntry && m.catalogEntry.id) matched.add(m.catalogEntry.id);
    // `hidden` (set by the Hub's moderators): never offered here. A hidden mod the player already has installed keeps its own row (it is matched
    // like any other; hiding only stops it being listed as something to install).
    const installedIds = new Set(installedPlugins.map((p) => p.id));
    const waitingToDeploy = new Set(pendingDeploy.list().map((e) => e.pluginId));
    return (catalogPlugins || [])
        .filter((e) => e && e.type === 'listing' && !e.hidden && !selfUpdateCheck.isOwnListing(e) &&!matched.has(e.id) && !installedIds.has(e.id) && !waitingToDeploy.has(e.id))
        .map(buildNotInstalledRow)
        .sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }));
}

// A Hub listing whose files are already on disk (an add-on folder in a mod) but which no SkyrimNet registry lists yet: SkyrimNet adds it the
// next time the game runs, so the row says so instead of offering it as something to install. `unregistered` comes from readInstalledPlugins.
const NOT_REGISTERED_YET = 'Start the game once to register this add-on.';
function markNotRegisteredYet(notInstalledRows, unregistered, ours) {
    if (!Array.isArray(unregistered) || unregistered.length === 0 || notInstalledRows.length === 0) return;
    const matches = pluginMatcher.matchPluginsToCatalog(unregistered, ours);
    const waiting = new Set();
    for (const m of matches.values()) if (m && m.catalogEntry && m.catalogEntry.id) waiting.add(m.catalogEntry.id);
    for (const row of notInstalledRows) if (waiting.has(row.id)) row.notRegisteredYet = NOT_REGISTERED_YET;
    if (waiting.size) logArea('setup', `on disk but not in SkyrimNet's registry yet: ${unregistered.map((u) => u.id).join(', ')}`);
}

// Mod Organizer 2: a Hub listing whose files are on disk with no manifest to say so (an enabled mod named like it, or a SKSE\Plugins\<its own folder>) is
// installed too. The Hub listings carry no folder information, so only the listing's title and the part of plugin_id after the dot are compared.
function addInstalledByName({ cfg, scan, plugins, matches, ours }) {
    if (!modManager.isMo2(cfg) || !scan) return;
    const done = new Set(plugins.map((p) => p.id));
    for (const m of matches.values()) if (m && m.catalogEntry && m.catalogEntry.id) done.add(m.catalogEntry.id);
    const hits = skyrimnetInstall.findInstalledByName(scan, ours, done);
    for (const hit of hits) {
        const e = hit.listing;
        plugins.push({ id: e.id, source: 'external', manifest: { title: e.title, author: e.author || null, version: null }, manifestError: null, evidence: hit.kind, where: skyrimnetInstall.whereOf([{ mod: hit.overwrite ? null : hit.mod }]), nameHit: hit });
        matches.set(e.id, { catalogEntry: e, matchedBy: `mo2-${hit.kind}`, ambiguous: false });
    }
    if (hits.length) logArea('setup', `installed because of a folder or mod name: ${hits.map((h) => `${h.listing.title} (${h.kind}: ${h.overwrite ? 'Overwrite' : h.mod})`).join(', ')}`);
}
// Their version is the mod's own (meta.ini), when there is one.
function addNameVersions(plugins, vortexInfo) {
    for (const p of plugins) {
        const h = p.nameHit;
        if (!h || !h.mod || !h.modsDir) continue;
        vortexInfo[p.id] = { version: mo2.readModVersion(h.modsDir, h.mod) || null, source: null, nexusModId: null, vortexModId: null, mo2ModFolder: h.mod };
    }
}
// The two things a row says about where its add-on is: only in Overwrite (a quiet label), or installed but not in SkyrimNet's registry yet.
function markWhereRows(rows, plugins) {
    const byId = new Map(plugins.map((p) => [p.id, p]));
    for (const row of rows) {
        const p = byId.get(row.id);
        if (!p) continue;
        if (p.where && p.where.onlyOverwrite) row.inOverwriteOnly = true;
        if (p.evidence === 'mod' || p.evidence === 'folder' || p.evidence === 'name') row.notRegisteredYet = NOT_REGISTERED_YET;
    }
}

// The same recognition for Mod Organizer 2, with the same matcher (lib/vortex-name-match.js): each enabled mod of the active profile is described the way a
// Vortex mod is -- its folder name, and what its own meta.ini says (the Nexus mod id, the archive it was installed from, its page address) -- so a
// sure match (same Nexus id, same GitHub repository, or the cleaned name equal to a name form of the listing) counts as installed, and a close name asks once.
function mo2ModsForPairing(scan, modsFolderFallback) {
    const mods = {};
    for (const m of (scan && scan.enabledNames) || []) {
        const meta = mo2.readMetaIni(path.join(m.modsDir || modsFolderFallback, m.name));
        const attributes = { modName: m.name, fileName: meta.installationFile || undefined, homepage: meta.url || undefined };
        if (/^[1-9]\d*$/.test(meta.modId)) { attributes.source = 'nexus'; attributes.modId = meta.modId; }
        mods[m.name] = { installationPath: m.name, attributes, modsDir: m.modsDir };
    }
    return mods;
}
function pairMo2Mods({ ours, plugins, matches, vortexInfo, cfg, scan, out }) {
    if (!scan || !scan.enabledNames || scan.enabledNames.length === 0) return out;
    const matched = new Set();
    for (const m of matches.values()) if (m && m.catalogEntry && m.catalogEntry.id) matched.add(m.catalogEntry.id);
    const installedIds = new Set(plugins.map((p) => p.id));
    const candidates = (ours || []).filter((e) => e && !matched.has(e.id) && !installedIds.has(e.id));
    if (candidates.length === 0) return out;
    const mods = mo2ModsForPairing(scan, cfg.vortexStagingFolder);
    const owned = new Set(Object.values(vortexInfo).filter((i) => i && i.mo2ModFolder).map((i) => i.mo2ModFolder));
    const found = nameMatch.findPairs({ vortexMods: nameMatch.prepareVortexMods(mods), catalogEntries: candidates, ownedModIds: owned, answers: cfg.modPairs });
    for (const e of candidates) {
        const sure = found.sure.get(e.id);
        if (!sure) continue;
        const mod = mods[sure.modId];
        out.plugins.push({ id: e.id, source: 'external', manifest: { title: e.title, author: e.author || null, version: null }, manifestError: null });
        matches.set(e.id, { catalogEntry: e, matchedBy: 'mo2-name-match', ambiguous: false });
        vortexInfo[e.id] = { version: (mod && mod.modsDir && mo2.readModVersion(mod.modsDir, sure.modId)) || null, source: null, nexusModId: null, vortexModId: null, mo2ModFolder: sure.modId };
        out.by.set(e.id, sure.by);
    }
    for (const [id, a] of found.ask) { const e = candidates.find((c) => c.id === id); if (e && !e.hidden && !out.by.has(id)) out.ask.set(id, { ...a, vortexName: a.modId }); } // the mod's folder name is what the person sees in Mod Organizer 2
    if (out.by.size) logArea('setup', `installed because its name differs from the Hub listing: ${[...out.by].map(([id, by]) => `${(candidates.find((c) => c.id === id) || {}).title} (${by}: ${vortexInfo[id].mo2ModFolder})`).join(', ')}`);
    return out;
}

// Recognises Hub listings that are already in Vortex under a different name. Returns { plugins, ask, by }: stand-in installed plugins for the
// SURE matches (and the person's earlier "Yes"), the listings to ASK about, and how each was found. Fills `matches` and `vortexInfo` for the
// stand-ins, and tells vortex-update.js which Vortex mod each belongs to (its update path needs that). With Vortex out of reach the last
// pairing is reused from memory, so a closed Vortex never sends a recognised mod back to "Mods not installed".
async function pairVortexMods({ ours, plugins, matches, vortexInfo, cfg, vortexHelperState, scan }) {
    const out = { plugins: [], ask: new Map(), by: new Map() };
    vortexUpdate.setPairedMods({});
    if (modManager.isMo2(cfg)) return pairMo2Mods({ ours, plugins, matches, vortexInfo, cfg, scan, out });
    const matched = new Set();
    for (const m of matches.values()) if (m && m.catalogEntry && m.catalogEntry.id) matched.add(m.catalogEntry.id);
    const installedIds = new Set(plugins.map((p) => p.id));
    const candidates = (ours || []).filter((e) => e && !matched.has(e.id) && !installedIds.has(e.id));
    if (candidates.length === 0) return out;
    const standIn = (entry, info, by) => {
        out.plugins.push({ id: entry.id, source: 'external', manifest: { title: entry.title, author: entry.author || null, version: null }, manifestError: null });
        matches.set(entry.id, { catalogEntry: entry, matchedBy: 'vortex-name', ambiguous: false });
        vortexInfo[entry.id] = info;
        out.by.set(entry.id, by);
    };
    let loaded = null;
    if (vortexHelperState === 'connected') { try { loaded = vortexUpdate.lastLoadedMods() || await vortexUpdate.modsForPairing(); } catch { loaded = null; } }
    if (!loaded) { // Vortex cannot be read right now: what it last said
        for (const e of candidates) { const c = vortexInfoCache.get(e.id); if (c && c.paired) standIn(e, { ...c, fromCache: true }, 'remembered'); }
        return out;
    }
    const owned = new Set(Object.values(vortexInfo).filter((i) => i && i.vortexModId).map((i) => i.vortexModId));
    const found = nameMatch.findPairs({
        vortexMods: nameMatch.prepareVortexMods(loaded.mods), catalogEntries: candidates, ownedModIds: owned, answers: cfg.modPairs,
        pickCandidate: (cands) => vortexUpdate.pickInstalledEntry(cands, loaded.enabledModKeys),
    });
    const paired = {};
    for (const e of candidates) {
        const sure = found.sure.get(e.id);
        const info = sure ? vortexUpdate.describeVortexMod(loaded.mods, sure.modId) : null;
        if (!info) { const c = vortexInfoCache.get(e.id); if (c && c.paired) vortexInfoCache.forget(e.id); continue; }
        standIn(e, info, sure.by);
        paired[e.id] = sure.modId;
        vortexInfoCache.record(e.id, { ...info, paired: true });
    }
    vortexUpdate.setPairedMods(paired);
    for (const [id, a] of found.ask) { const e = candidates.find((c) => c.id === id); if (e && !e.hidden && !out.by.has(id)) out.ask.set(id, a); }
    return out;
}

// The person's answer to "Is this the same as ... which you already have in Vortex?" (queue: a-mod-already-in-vortex-is-recognised-even-when-
// its-name-differs). Saved in the settings file; the next check moves the row (Yes) or never asks about that pair again (No).
function answerPair(id, answer) {
    if (answer !== 'yes' && answer !== 'no') return { ok: false, status: 400, error: 'Answer yes or no.' };
    const row = findRow(id);
    if (!row || !row.sameAs) return { ok: false, status: 404, error: 'Nothing to answer for this mod.' };
    const cfg = appConfig.loadConfig();
    const pairs = (Array.isArray(cfg.modPairs) ? cfg.modPairs : []).filter((p) => !(p && p.catalogId === id && p.key === row.sameAs.key));
    pairs.push({ catalogId: id, vortexModId: row.sameAs.vortexModId, vortexName: row.sameAs.vortexName, key: row.sameAs.key, answer, answeredAt: new Date().toISOString() });
    appConfig.saveConfig({ modPairs: pairs });
    return { ok: true };
}

// An installed mod the catalog has no entry for is written down (once per change), so a wrong match shows up in the log, never silently.
// ModPacer's own listing (lib/self-update-check.js): a reason it could not be read is written down once per change, never shown.
let lastSelfCheckReason = null;
function noteSelfCheck(reason) {
    if (reason === lastSelfCheckReason) return;
    lastSelfCheckReason = reason;
    if (reason) logArea('check', `ModPacer's own listing: ${reason}`);
}
let lastUnmatchedKey = '';
function reportUnmatched(plugins, matches) {
    const ids = plugins.filter((p) => { const m = matches.get(p.id); return !(m && m.catalogEntry); }).map((p) => p.id).sort();
    const key = ids.join('|');
    if (key === lastUnmatchedKey) return;
    lastUnmatchedKey = key;
    for (const id of ids) logUpdate(`catalog: installed mod ${id} has no matching Hub entry`);
}

function buildRow(plugin, match, vortexInfo) {
    const manifest = plugin.manifest || {};
    const manifestVersion = manifest.version || null;
    // Vortex's own reported version wins over the plugin's own inner manifest.json whenever a
    // Vortex match exists and reports one (queue: compare-against-vortex-version, 2026-10-01) --
    // that's what the player actually sees in Vortex, and the Plugin Hub's own listing form
    // defines its "version" field the same way. Some authors never bump the inner manifest string
    // on a real release (confirmed real: Lover's Ledger installed at 1.1.0 in Vortex, its own
    // manifest.json still says 1.0.2) -- comparing against that stale inner value offered an
    // update the player already had.
    // Once Vortex has EVER spoken for this plugin (live right now, or remembered from the last
    // time it did -- see vortex-info-cache.js), its own version is trusted even if it's currently
    // unknown (null) -- the manifest is never used as a silent, equally-confident-looking
    // substitute for a Vortex-tracked plugin (queue: helper-down-message-and-version-fallback,
    // 2026-10-01, the real reported bug: OStimNet/Lover's Ledger showed stale inner-manifest
    // numbers with no indication they weren't the real, Vortex-confirmed ones). A plugin Vortex has
    // NEVER tracked at all (vortexInfo entirely absent, live or remembered) still falls back to the
    // manifest exactly as before -- nothing lost for a plugin outside Vortex's purview anyway.
    const vortexKnowsThisPlugin = !!vortexInfo;
    const installedVersion = vortexKnowsThisPlugin ? (vortexInfo.version || null) : manifestVersion;
    const installedVersionUnknown = vortexKnowsThisPlugin && !vortexInfo.version;
    const manifestVersionNote = (vortexInfo && vortexInfo.version && manifestVersion && vortexInfo.version !== manifestVersion)
        ? `Mod file says ${manifestVersion}` : null;
    const catalogEntry = match && match.catalogEntry;
    const base = {
        id: plugin.id,
        title: displayTitle(manifest, plugin, catalogEntry),
        author: manifest.author || null,
        installedVersion,
        installedVersionUnknown,
        vortexInfoFromCache: !!(vortexInfo && vortexInfo.fromCache),
        manifestVersionNote,
        manifestError: plugin.manifestError || null,
        matchedBy: match ? match.matchedBy : null,
        ambiguousMatch: match ? match.ambiguous : false,
        downloadProgress: null,
        downloadedArchivePath: null,
        downloadedFileName: null,
        updatePreview: null,
        updateUnavailableReason: null,
        releaseDate: null,
        updatedAt: downloadState.updateTimes(plugin.id).updatedAt, // when this mod was last updated through the updater (the list sorts by it)
        error: null,
        // Adult listings carry a small NSFW pill wherever they show; every catalog-matched row links to its page on the plugins site.
        nsfw: !!(match && match.catalogEntry && match.catalogEntry.nsfw),
        ...hubFields(match && match.catalogEntry),
    };

    if (!catalogEntry) {
        return { ...base, status: 'not_on_hub', latestVersion: null, externalUrl: null, urlKind: 'none', changelog: null };
    }

    const latestVersion = catalogEntry.version || null;
    let externalUrl = catalogEntry.external_url || null;
    let urlKind = classifyUrl(externalUrl);
    // The release link (and, inside downloadPlugin, the actual download source) follows where
    // Vortex says THIS copy was really installed from, not the Hub listing's own external_url --
    // confirmed real: M.A.R.A.S's Hub listing points at GitHub, but the director's own install
    // came from Nexus. A Vortex-confirmed Nexus source always wins over the catalog's own link.
    if (vortexInfo && vortexInfo.source === 'nexus' && vortexInfo.nexusModId) {
        externalUrl = `https://www.nexusmods.com/skyrimspecialedition/mods/${vortexInfo.nexusModId}`;
        urlKind = 'nexus';
    }
    const cmp = compareVersions(installedVersion, latestVersion);
    const status = cmp === 'newer' ? 'update_available' : cmp === 'unknown' ? 'unknown_version' : 'up_to_date';

    return {
        ...base, latestVersion, externalUrl, urlKind, status,
        changelog: catalogEntry.changelog || null,
        versionCompare: cmp,
    };
}

// A check that could not read Vortex because it was still busy (rows say "Waiting for Vortex...") is retried by itself,
// quietly: a few tries over a couple of minutes, further and further apart. Once Vortex answers the rows are filled in
// with no button pressed. Only when the tries run out does the page get the amber helper state (with Retry).
// (queue: starting-vortex-waits-until-vortex-is-really-ready, 2026-10-04.) Tests shorten the waits.
// Total about 3 minutes (173 s) of trying, then it settles and shows the amber banner with Retry.
const DEFAULT_RETRY_DELAYS = [3000, 5000, 10_000, 15_000, 20_000, 30_000, 30_000, 30_000, 30_000];
let vortexRetryDelays = DEFAULT_RETRY_DELAYS;
let vortexRetry = { timer: null, tries: 0, gaveUp: false, checking: false };
function setVortexRetryDelays(delays) { vortexRetryDelays = delays || DEFAULT_RETRY_DELAYS; }
function cancelVortexRetry() { if (vortexRetry.timer) { clearTimeout(vortexRetry.timer); vortexRetry.timer = null; } }
function resetVortexRetry() { cancelVortexRetry(); vortexRetry = { timer: null, tries: 0, gaveUp: false, checking: false }; }
function scheduleVortexRetry() {
    cancelVortexRetry();
    if (vortexRetry.tries >= vortexRetryDelays.length) return false;
    vortexRetry.timer = setTimeout(runVortexRetry, vortexRetryDelays[vortexRetry.tries]);
    if (vortexRetry.timer.unref) vortexRetry.timer.unref(); // never keeps the process alive on its own
    return true;
}
async function runVortexRetry() {
    vortexRetry.timer = null;
    // Something else is working on the rows right now (a download, an update, another check): wait, without using up a try.
    const busy = vortexRetry.checking || state.rows.some((r) => r.status === 'queued' || r.status === 'downloading') || Object.keys(updateProgress.list()).length > 0 || deployJob.snapshot().state === 'running';
    if (busy) { vortexRetry.timer = setTimeout(runVortexRetry, 2000); if (vortexRetry.timer.unref) vortexRetry.timer.unref(); return; }
    vortexRetry.tries++;
    try { await check({ force: false, retry: true }); } catch { /* the next try (or the banner) covers it */ }
}

// Any check in this process, retries included (the page shows "checking" from this).
let checksRunning = 0;
async function check({ force = false, retry = false } = {}) {
    if (retry) vortexRetry.checking = true; else resetVortexRetry();
    checksRunning++;
    logArea('check', 'check started', force && '(forced)', retry && '(automatic repeat)');
    try {
        const result = await checkOnce({ force, retry });
        logCheckResult(result);
        return result;
    } catch (e) {
        logArea('error', `check failed: ${e && e.message ? e.message : e}`);
        throw e;
    } finally { checksRunning--; vortexRetry.checking = false; }
}
// The end of a check, in numbers and the words the player was shown. Names and counts only.
function logCheckResult(result) {
    if (!result) return;
    if (result.error) { logArea('check', `check ended with a message shown to the player: ${result.error}`); return; }
    const mods = (result.rows || []).filter((r) => !r.notInstalled);
    const withUpdate = mods.filter((r) => ['downloaded', 'queued', 'downloading', 'update_available'].includes(r.status));
    logArea('check', `check ended: ${mods.length} mod(s), ${withUpdate.length} with an update`);
}
// Resolves once no automatic repeat is pending or running (or at the limit). The headless check waits on this before its summary.
async function waitForSettled({ limitMs = 200_000 } = {}) {
    const until = Date.now() + limitMs;
    while ((vortexRetry.timer || checksRunning > 0) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
}

// The helper is reachable and stable-ready again: a stale "isn't answering" state (and the gave-up flag) clears by itself, and ONE
// fresh automatic check runs. Called by the status poll; does nothing when there is nothing stale.
function clearStaleHelperTrouble() {
    if (!vortexRetry.gaveUp && state.vortexHelperState !== 'vortex_running_helper_unreachable') return false;
    vortexRetry.gaveUp = false;
    state = { ...state, vortexHelperState: 'connected' };
    if (checksRunning === 0) check({ force: false }).catch(() => {});
    return true;
}

async function checkOnce({ force, retry }) {
    updateProgress.clearWaiting();
    const cfg = appConfig.loadConfig();
    if (!cfg.skyrimInstallPath) {
        logArea('setup', 'Skyrim folder: not set, so nothing could be checked');
        state = { ...state, error: 'Choose your Skyrim folder in Settings first.', notSetUp: true, rows: [], skyrimNetSearch: null };
        return getState();
    }
    const snOpts = { mo2Mode: modManager.isMo2(cfg), skyrimNetFolder: cfg.skyrimNetFolder, modsFolder: cfg.vortexStagingFolder, downloadFolder: cfg.downloadFolder, mo2Folder: modManager.isMo2(cfg) ? cfg.mo2Folder : null, fresh: !!force };
    await skyrimnetInstall.prewarm(cfg.skyrimInstallPath, snOpts); // Mod Organizer 2's mod list, read in chunks so a huge list never freezes the page
    const { skyrimNetDir, plugins, error, search, searchSummary, registryNote, evidenceNote, unregistered, scan } = skyrimnetInstall.readInstalledPlugins(cfg.skyrimInstallPath, { ...snOpts, log: logUpdate });
    if (error) {
        logArea('setup', searchSummary || `SkyrimNet: ${error} (Skyrim folder given: ${cfg.skyrimInstallPath})`);
        state = { ...state, error, notSetUp: false, rows: [], skyrimNetDir, skyrimNetSearch: search || null };
        return getState();
    }
    logArea('setup', `${searchSummary ? searchSummary + '; ' : `SkyrimNet: found at ${skyrimNetDir}; `}${plugins.length} plugin(s) installed`);
    if (registryNote) logArea('setup', registryNote);
    if (evidenceNote) logArea('setup', evidenceNote);
    let catalog;
    try {
        catalog = await catalogLib.fetchCatalog({ force });
    } catch (e) {
        noteSelfCheck("the Plugin Hub catalog could not be read");
        state = { ...state, selfUpdate: null };
        throw e;
    }
    const { plugins: catalogPlugins, statsAsOf } = catalog;
    // Only listings are ours: a bundle is a plugin SkyrimNet itself installs, so it is never matched, listed, counted or downloaded here.
    // ModPacer's own listing is this program, not an add-on: it is read for the "newer ModPacer" notice only, never matched or listed.
    const allOurs = (catalogPlugins || []).filter((e) => e && (!e.type || e.type === 'listing'));
    const ours = allOurs.filter((e) => !selfUpdateCheck.isOwnListing(e));
    const matches = pluginMatcher.matchPluginsToCatalog(plugins, ours);
    reportUnmatched(plugins, matches);
    addInstalledByName({ cfg, scan, plugins, matches, ours });
    const own = selfUpdateCheck.inspectOwnListing(allOurs, APP_VERSION);
    noteSelfCheck(own.reason);
    // Where each mod's installed version comes from depends on the mod manager the player chose:
    // MO2 -> its own mods folder (meta.ini etc.), never the Vortex Helper; otherwise Vortex's live state.
    const pluginIds = plugins.map((p) => p.id);
    const vortexInfo = modManager.isMo2(cfg)
        ? mo2.resolveInfoBatch(pluginIds, mo2Instance.effectiveModsFolder(cfg))
        : await vortexUpdate.resolveVortexInfoBatch(pluginIds);
    // Computed once per check(), not per-row -- queue: helper-down-message-and-version-fallback,
    // 2026-10-01. Drives the one top-of-page banner; see getState()'s own comment for why this
    // isn't just inferred from whether any row's vortexInfo came back empty (a plugin genuinely
    // outside Vortex's purview looks identical to one Vortex can't currently be reached for).
    const vortexHelperState = modManager.isMo2(cfg) ? null : await vortexUpdate.getHelperConnectionState();

    // Hub listings that are already in Vortex under another name are installed mods too (lib/vortex-name-match.js).
    const pairing = await pairVortexMods({ ours, plugins, matches, vortexInfo, cfg, vortexHelperState, scan });
    addNameVersions(plugins, vortexInfo);
    const rows = plugins.concat(pairing.plugins).map((p) => buildRow(p, matches.get(p.id), vortexInfo[p.id]));
    markWhereRows(rows, plugins);
    for (const row of rows) if (pairing.by.has(row.id)) row.pairedByName = pairing.by.get(row.id);
    // Vortex was open but still busy (or its big read just failed): a row Vortex has not spoken for LIVE says so, instead of
    // looking checked. Retried by itself.
    const waitingOnVortex = !modManager.isMo2(cfg) && (vortexUpdate.applyStartingWindow(vortexHelperState) === 'vortex_starting'
        || (vortexHelperState === 'connected' && vortexUpdate.isModsReadBackingOff()));
    // Retried by itself only when the mod list itself was not available (the helper failed or timed out, or the read came back
    // empty). A complete read where the matching entry simply has no version is NOT "still loading": that row says what is true
    // ("Installed, but Vortex doesn't know its version") and nothing waits.
    const waiting = waitingOnVortex || (!modManager.isMo2(cfg) && vortexUpdate.lastListLookedEmpty());
    const incomplete = [];
    const gaveUp = waiting && !scheduleVortexRetry();
    if (waiting && !gaveUp) {
        if (waitingOnVortex) for (const row of rows) if (!(vortexInfo[row.id] && !vortexInfo[row.id].fromCache)) row.vortexWaiting = true;
        for (const row of incomplete) row.vortexWaiting = true;
    }
    vortexRetry.gaveUp = gaveUp;
    // A plugin that is installed for SkyrimNet but has no entry in Vortex at all (the read was complete): not an error. If the
    // Hub lists a version we cannot show is already installed, the row just offers Install (the listed version, nothing old to replace).
    const notInVortex = vortexUpdate.notInVortexIds();
    for (const row of rows) {
        if (!notInVortex.has(row.id) || !row.latestVersion || waiting) continue;
        if (row.status === 'unknown_version') row.status = 'update_available';
        if (row.status === 'update_available') row.notInVortex = true;
    }
    if (!waiting) cancelVortexRetry();
    const releaseDates = await releaseDatesLib.resolveReleaseDates(rows);
    for (const row of rows) row.releaseDate = releaseDates[row.id] || null;
    // The Hub listings that are not installed (kept apart from `rows` below, so nothing automatic -- auto-download, release dates -- touches them).
    const catalogReadable = (catalogPlugins || []).length > 0;
    const notInstalledRows = catalogReadable ? buildNotInstalledRows(catalogPlugins, matches, plugins, cfg) : [];
    markNotRegisteredYet(notInstalledRows, unregistered, ours);
    // A close-but-not-sure name: the row asks once. Nothing about the row changes until the person answers.
    for (const row of notInstalledRows) { const a = pairing.ask.get(row.id); if (a) row.sameAs = { vortexModId: a.modId, vortexName: a.vortexName, key: a.key }; }
    state = { lastCheckedAt: Date.now(), skyrimNetDir, rows: rows.concat(notInstalledRows), error: null, vortexHelperState, notInstalledState: catalogReadable ? 'ok' : 'unreadable', statsAsOf: statsAsOf || null, selfUpdate: own.available };

    // A remembered download that is not the file of the promised version is forgotten now (no network), not only when a download starts.
    for (const row of rows) if (row.status === 'update_available') rememberedDownload(row);
    await maybeAutoDownloadPending(rows, cfg);
    // Old downloads an earlier update could not finish removing (Vortex was busy): another try, in the background.
    if (downloadState_.pendingCleanup().length > 0) oldCleanup.runCleanup();
    // Old copies (mod, archive, folder) an earlier update could not finish removing: their rows say so, and the removal is tried again, in the background.
    flagOldCopyRows(state.rows);
    if (oldCopyStore.list().length > 0) retryOldCopies().catch(() => {});
    return getState();
}

// The real auto-download pass -- pulled out of check() (queue: plugins-tab-notice-saved-settings,
// 2026-09-30) so saving a download folder in Settings can trigger it immediately too (see
// maybeAutoDownloadNow below), not only the next Check now/Vortex restart. No download folder set
// yet: automatic downloads skip quietly, with no per-row errors piling up -- the single banner +
// disabled buttons on the Plugins tab already say why nothing's downloading; row-level errors here
// would just repeat that same one fact N times over.
async function maybeAutoDownloadPending(rows, cfg) {
    if (!cfg.autoDownload || !cfg.downloadFolder) return;
    // Never a Hub listing the player does not have: those are only ever fetched by a person's click (Install).
    const pending = rows.filter((r) => r.status === 'update_available' && !r.notInstalled);
    // Premium status checked ONCE per run, not once per Nexus plugin (queue:
    // updater-v1-polish, 2026-09-30) -- a real API call, so a player with several Nexus
    // updates pending would otherwise pay for it that many times over on every single run.
    // undefined (not a boolean) when there's nothing to check for (no key, or no Nexus rows
    // pending this run) or the check itself fails -- downloadPlugin falls back to its own
    // per-call check in that case, same as a manual "Download" click already does.
    let knownNexusPremium;
    const hasNexusPending = pending.some((r) => r.urlKind === 'nexus');
    if (hasNexusPending && cfg.nexusApiKey) {
        try {
            knownNexusPremium = (await nexus.checkApiKey(cfg.nexusApiKey)).isPremium;
        } catch {
            // Leave undefined -- a bad/expired key surfaces per-row via downloadPlugin's own
            // check instead of silently skipping every Nexus row with no explanation.
        }
    }
    for (const row of pending) {
        // Fire-and-forget -- the dashboard polls getState() for live progress.
        const run = downloadPlugin(row.id, { knownPremium: knownNexusPremium }).catch(() => {}); // downloadPlugin already records its own error onto the row
        autoDownloads.add(run);
        run.finally(() => autoDownloads.delete(run));
    }
}
// The automatic downloads still running in the background (nobody awaits them). Resolves when they have all ended: what a test, or a clean
// shutdown, waits on so that work started by one run never lands in the next one.
const autoDownloads = new Set();
function whenAutoDownloadsSettled() { return Promise.all([...autoDownloads]).then(() => undefined); }

// Called by server.js right after the player saves a setting that could newly satisfy
// maybeAutoDownloadPending's own guard (a download folder, or turning autoDownload on) -- starts
// downloading whatever's ALREADY known to be pending from the last check, immediately, rather than
// waiting for the next Check now or Vortex restart. A no-op (same guard, same silence) if nothing
// about the current rows/config actually qualifies.
async function maybeAutoDownloadNow() {
    await maybeAutoDownloadPending(state.rows, appConfig.loadConfig());
}

// Read fresh every call (never baked into `state` at check()-time only) so a player changing the
// download folder in Settings is reflected on the very next poll, not just after their next Check
// now (queue: fill-staging-folder-keep-changelogs, 2026-09-30) -- drives the Plugins tab's single
// "no download folder" banner and the disabled Download/Download all/Update all buttons.
// The one short sentence for a row whose update installed but whose old copy is not fully gone yet (draft; the design side runs it through Gemini).
const OLD_COPY_LEFT_TEXT = 'The old version is still in Vortex. Try the update again.';
// What is left, in one short sentence (drafts; the design side runs them through Gemini). Try again shows the one that is true NOW.
const OLD_COPY_TEXTS = {
    bridge: "Vortex didn't answer. Check that Vortex is open.",
    archive: 'The old download is still in the downloads folder.',
    folder: "The old mod's folder is still in Vortex's staging folder.",
    archiveAndFolder: "The old download and the old mod's folder are still there.",
};
function oldCopyText(left) {
    const l = left || [];
    if (l.includes('bridge')) return OLD_COPY_TEXTS.bridge;
    if (l.includes('mod') || l.length === 0) return OLD_COPY_LEFT_TEXT;
    if (l.includes('archive') && l.includes('folder')) return OLD_COPY_TEXTS.archiveAndFolder;
    if (l.includes('archive')) return OLD_COPY_TEXTS.archive;
    return OLD_COPY_TEXTS.folder;
}
const OLD_COPY_ALL_TEXTS = new Set([OLD_COPY_LEFT_TEXT, ...Object.values(OLD_COPY_TEXTS)]);

// Puts a saved unfinished old copy on its row (a row rebuilt by a check, or from an earlier run of ModPacer, still says so).
function flagOldCopyRows(rows) {
    for (const entry of oldCopyStore.list()) {
        if (entry.waitingOnRules) continue; // the row's "didn't carry over" Try again owns this one until its rules are in
        const row = (rows || []).find((r) => r.id === entry.pluginId);
        if (!row || row.status === 'updated' || row.status === 'deployed') continue;
        markOldCopyLeft(row, entry.left);
    }
}
function markOldCopyLeft(row, left) {
    row.oldCopyLeft = { left: left || [] };
    row.updatePreview = null;
    row.updateUnavailableReason = null;
    row.error = oldCopyText(left);
    row.errorWarn = true;
}
function clearOldCopyLeft(row) {
    row.oldCopyLeft = null;
    if (OLD_COPY_ALL_TEXTS.has(row.error)) { row.error = null; row.errorWarn = false; }
}

// Tries again every saved unfinished old copy (the next run of ModPacer, a check, the row's Try again): Vortex must answer, and each one is
// removed through the Bridge and then looked at. One at a time, never twice at once. A finished one is forgotten and its row stops saying so.
let retryingOldCopies = null;
function retryOldCopies() {
    if (retryingOldCopies) return retryingOldCopies;
    retryingOldCopies = (async () => {
        for (const entry of oldCopyStore.list()) { // an entry whose rules are still partial is retried too: the old copy never waits for the rules
            let r;
            try { r = await vortexUpdate.finishOldCopy(entry); } catch { r = { complete: false, left: ['bridge'] }; }
            const row = findRow(entry.pluginId);
            if (r.complete) {
                oldCopyStore.remove(entry.pluginId);
                if (row) finishRowAfterOldCopy(row);
            } else if (r.reason === undefined || r.left.length > 0) {
                oldCopyStore.update(entry.pluginId, { left: r.left });
                if (row && row.oldCopyLeft) row.oldCopyLeft = { left: r.left };
            }
        }
    })().finally(() => { retryingOldCopies = null; });
    return retryingOldCopies;
}
// Starting ModPacer: forget all unfinished-update bookkeeping (queue: modpacer-starts-fresh-every-time-it-starts..., 2026-10-05). Rows are rebuilt from the Hub
// and Vortex's current mods; nothing from an earlier run is retried or finished, and nothing is deleted. Rows live in memory only, so clearing the saved
// stores is all it takes.
function startFresh() {
    oldCopyStore.clear();
    pendingDeploy.clear();
    downloadState.clearPendingCleanup();
    state = { ...state, rows: [] };
}
// The old copy is fully gone: only now does the row say Updated.
function finishRowAfterOldCopy(row) {
    const wasStuck = !!row.oldCopyLeft;
    clearOldCopyLeft(row);
    if (wasStuck && row.status !== 'updated' && row.status !== 'deployed') {
        row.status = 'updated';
        row.installedNew = false;
        try { row.updatedAt = downloadState.recordUpdateTime(row.id, 'updatedAt'); } catch { /* a missing time only affects the sort */ }
    }
}

// A row stopped by GitHub's limit goes back to its normal Download / Update state the moment the limit has passed (no restart), and the automatic download tries again.
function clearPassedGithubLimits() {
    let cleared = false;
    for (const row of state.rows || []) {
        if (row.rateLimitedUntil && Date.now() >= row.rateLimitedUntil) {
            row.error = null; row.errorWarn = false; row.rateLimitedUntil = null; cleared = true;
        }
    }
    if (cleared) maybeAutoDownloadNow().catch(() => {});
}

function getState() {
    clearPassedGithubLimits();
    const cfg = appConfig.loadConfig();
    const manager = modManager.getModManager(cfg);
    const mo2Chosen = manager === 'mo2';
    return {
        ...state,
        rows: (state.rows || []).filter((r) => !(r.notInstalled && r.nsfw && !cfg.showAdultNotInstalled)),
        // True until first-run setup is finished (see lib/first-run-setup.js): the page then shows "Finish setup" instead of a list.
        needsSetup: !firstRunSetup.isSetupComplete(cfg),
        setup: firstRunSetup.setupSummary(cfg),
        downloadFolderMissing: !cfg.downloadFolder,
        modManager: manager,
        platform: require('./platform').current(), // the page leaves out what its system does not have
        // Vortex-only facts -- never reported (and never looked up) once MO2 is chosen.
        // The tries ran out with Vortex still busy: the page gets the amber "helper isn't answering" state, with its Retry button.
        // gaveUp means "stop retrying", never "the helper is down": the banner is only for a helper that is not connected.
        vortexHelperState: mo2Chosen ? null : (vortexRetry.gaveUp && state.vortexHelperState !== 'connected' ? 'vortex_running_helper_unreachable' : vortexUpdate.applyStartingWindow(state.vortexHelperState)),
        vortexGaveUp: !mo2Chosen && vortexRetry.gaveUp,
        // "Mods not installed": a Nexus key is set (Nexus-hosted listings can install by themselves), the adult switch, and whether the Hub's list was readable.
        nexusKeySet: !!cfg.nexusApiKey,
        showAdultNotInstalled: !!cfg.showAdultNotInstalled,
        notInstalledState: state.notInstalledState || 'ok',
        // When the catalog's counts were taken (its stats_as_of), shown as the tooltip on each row's visits line.
        statsAsOf: state.statsAsOf || null,
        // A newer ModPacer is listed on the Plugin Hub: { version, url | null } (nothing when up to date, or the switch is off).
        selfUpdate: cfg.tellNewModPacer !== false ? (state.selfUpdate || null) : null,
        vortexRetrying: !mo2Chosen && (!!vortexRetry.timer || vortexRetry.checking),
        // A check is running in this process right now (the page shows "Checking..." from it, also on a fresh page load).
        checking: checksRunning > 0,
        helperInstalled: mo2Chosen ? null : require('./bridge-status').cached().installed,
        bridge: mo2Chosen ? null : require('./bridge-status').cached(), // the one shared answer about the Bridge (version, newer one bundled, ...)
        // The Bridge answered but reports a version older than ModPacer needs (nothing read = false): the same banner as "missing", with the same Get the Vortex Bridge button.
        helperOutdated: !mo2Chosen && helperClient.bridgeIsTooOld(),
        helperDownloadUrl: modManager.HELPER_DOWNLOAD_URL,
        helperBundled: require('./helper-bundle').isBundled(), // this copy of ModPacer carries the Bridge
        // Updated mods Vortex hasn't been asked to deploy yet (the page asks after an update; Cancel leaves them here).
        pendingDeploy: pendingDeploy.listThisRun().map((e) => ({ pluginId: e.pluginId, title: e.title })),
        // Old downloads not yet confirmed gone (only while "Delete old download after a successful update" is on).
        oldDownloadsPending: cfg.deleteOldDownloadAfterUpdate ? downloadState_.pendingCleanup().length : 0,
        oldDownloadsCleaning: oldCleanup.isRunning(),
        // What each running update is on right now: { [pluginId]: { step, label, waiting, blockedBy } } (lib/update-progress.js).
        updateProgress: updateProgress.list(),
        // Whether a deploy is running right now, so a reloaded page can pick it up again: { state: 'idle' | 'running' | 'done', ... }.
        deploy: deployJob.snapshot(),
    };
}

function findRow(id) {
    return state.rows.find((r) => r.id === id) || null;
}

// Whether this row's downloaded archive is a FOMOD (it always gets the options screen, never a silent install). Looked at
// once per downloaded row and remembered on it. If the archive can't be read, the row stays unmarked: pressing Update
// still never installs a FOMOD silently (the install step itself asks for the screen).
async function detectFomod(row) {
    if (row.isFomod !== undefined || !row.downloadedArchivePath) return;
    try { row.isFomod = await installArchive.archiveIsFomod(row.downloadedArchivePath); } catch { /* left unmarked */ }
}

// Plain-language line shown on a downloaded row with no Update button, so it's never a silent
// dead end (queue: fix-update-button-folder-layout, 2026-09-30, director's own report).
function updateUnavailableReasonText(reason) {
    // Split from a single flat 'helper_unavailable' (queue: helper-down-message-and-version-
    // fallback, 2026-10-01) -- Vortex genuinely not running and Vortex running-but-unreachable are
    // different situations with different fixes, confirmed real: the director's own real Vortex
    // was open the whole time, its Helper extension just never bound (port 59595 already taken at
    // startup) -- "Open Vortex" was actively wrong advice for what he was actually seeing.
    if (reason === 'vortex_running_helper_unreachable') return "Vortex is open, but the Vortex Bridge isn't answering. Vortex may be busy. Press Retry at the top of the page.";
    if (reason === 'vortex_starting') return 'Waiting for Vortex\u2026';
    if (reason === 'vortex_not_running' || reason === 'helper_unavailable') return 'Open Vortex to install.';
    if (reason === 'helper_not_installed') return 'Install in Vortex.';
    if (reason === 'helper_outdated') return BRIDGE_OUTDATED_TEXT;
    if (reason === 'mo2_manual') {
        return 'Install in MO2.';
    }
    if (reason === 'no_staging_folder_configured') return 'Set your Mod Staging Folder in Settings to update automatically.';
    return 'Not found in Vortex — install it yourself.';
}

// Recomputes "can Update" for every already-downloaded row against Vortex's CURRENT live state
// (queue: fix-update-button-folder-layout, 2026-09-30) -- called by server.js every time the
// Plugins tab asks for state, not only once right after a download (downloadPlugin's own inline
// previewUpdate call still gives a row its FIRST best-effort guess immediately on download, same
// as before; this is what lets a row that missed it then -- Helper not open yet, staging folder
// not set yet, or the match genuinely failing -- pick it up on the very next poll with no
// re-download needed). A no-op, no Helper call at all, when nothing is downloaded yet.
// True while any mod's update is running: the page's polling then gets quick answers (no heavy read of Vortex's mod list in the way of the live steps).
function updateRunning() { return Object.keys(updateProgress.list()).length > 0; }
// One refresh at a time: a poll that arrives while the last one is still waiting on a slow Vortex joins it instead of starting another.
// A downloaded row whose "can Update" read is still waiting on a slow Vortex says so (the page then keeps polling until it is answered).
function markPreviewsPending() {
    for (const row of state.rows) if (row.status === 'downloaded' && !row.updatePreview && !row.updateUnavailableReason) row.updateUnavailableReason = updateUnavailableReasonText('vortex_starting');
}
let previewsInFlight = null;
function refreshUpdatePreviews() {
    if (updateRunning()) return Promise.resolve();
    if (!previewsInFlight) previewsInFlight = refreshUpdatePreviewsNow().finally(() => { previewsInFlight = null; });
    return previewsInFlight;
}
async function refreshUpdatePreviewsNow() {
    const downloaded = state.rows.filter((r) => r.status === 'downloaded');
    if (downloaded.length === 0) return;
    for (const row of downloaded) await detectFomod(row); // once per row; a no-op after that
    const results = await vortexUpdate.previewUpdatesBatch(downloaded.map((r) => r.id));
    for (const row of downloaded) {
        const result = results[row.id];
        if (!result) continue;
        row.updatePreview = result.preview;
        row.updateUnavailableReason = result.preview ? null : updateUnavailableReasonText(result.reason);
    }
}

// Decides whether this plugin's current latest-version archive is ALREADY sitting somewhere real
// and complete -- this app's own remembered state, the downloads folder itself, or Vortex's own
// download records -- before ever starting a new download (queue: no-duplicate-downloads,
// 2026-10-01; real reported bug: a restart with automatic downloads on re-downloaded a file
// already fetched, leaving a "(1)" duplicate). Returns {archivePath, fileName} if something real
// and matching was found, or null to proceed with an actual download. `expectedSize` is the
// remote release's own reported size when that's a source this app trusts for it (GitHub's own
// asset.size, confirmed reliable) -- null for a source that isn't (Nexus's own reported file size
// has a real, confirmed-elsewhere case of being a few bytes off from the genuinely correct file;
// see this project's own Credits/TECHNICAL.md), in which case only this app's OWN remembered
// state -- which never depends on trusting a remote-reported size at all, only the real file's own
// stat'd size at the time THIS app downloaded it -- gets a strict check; the folder/Vortex fallback
// below is intentionally weaker (name-only) for that source, disclosed plainly rather than
// pretending a size gate it can't really trust.
// Returns {archivePath, fileName, size} on a match -- `size` is always the REAL, already-known
// size (never a fresh fs.statSync the caller has to do again), so recording it onto this app's own
// remembered state afterward never needs its own extra disk read.
// This app's own remembered download for this row's current latest version, re-verified against the
// real file (it must still exist at its recorded size) before being trusted -- a stale/gone record is
// forgotten, never acted on. Needs NO network, which is the point: downloadPlugin asks this FIRST, so
// a file that is already here is never shown as "Downloading..." and never costs a GitHub/Nexus call
// (queue: no-fake-downloading, 2026-10-01).
function rememberedDownload(row) {
    const remembered = downloadState.get(row.id);
    // The file must come from a release OF the promised version: a record whose `version` says 4.1.0 but whose file came from the
    // 4.0.1 release (a Hub link left on the old tag) is not that update. Records from before this was written down are trusted for
    // Nexus as they always were, never for GitHub (that is exactly where the old record was wrong), so those are looked up again.
    const recordedRelease = remembered && (remembered.releaseVersion !== undefined ? remembered.releaseVersion : (row.urlKind === 'github' ? null : remembered.version));
    const releaseMatches = recordedRelease == null ? false : compareVersions(recordedRelease, row.latestVersion) === 'same';
    if (remembered && remembered.version === row.latestVersion && !releaseMatches) {
        downloadState.remove(row.id); // the stale entry goes; the file itself stays (the old-downloads cleanup owns deleting files)
        return null;
    }
    if (remembered && remembered.version === row.latestVersion) {
        if (fs.existsSync(remembered.filePath) && fs.statSync(remembered.filePath).size === remembered.size) {
            return { archivePath: remembered.filePath, fileName: path.basename(remembered.filePath), size: remembered.size, releaseVersion: recordedRelease };
        }
        downloadState.remove(row.id);
    }
    return null;
}

async function findExistingDownload(row, cfg, { expectedFileName, expectedSize }) {
    // 1. This app's own remembered state -- the fix for the actual reported restart bug.
    const rememberedHit = rememberedDownload(row);
    if (rememberedHit) return rememberedHit;
    if (!expectedFileName) return null;
    const candidatePath = path.join(cfg.downloadFolder, expectedFileName);

    // 2. The downloads folder itself, under the exact name this download would use.
    if (fs.existsSync(candidatePath)) {
        const realSize = fs.statSync(candidatePath).size;
        if (expectedSize != null) {
            if (realSize === expectedSize) return { archivePath: candidatePath, fileName: expectedFileName, size: realSize };
            if (realSize < expectedSize) {
                // Smaller than the release's own real size -- a partial/interrupted download of
                // THIS same file, never treated as finished. Deleted outright (never resumed --
                // downloadToFile has no Range-header support to resume INTO, and a plain replace
                // is simpler and no less safe) so the real download below lands at this SAME
                // name, not a "(1)" alongside a broken file left behind.
                console.warn(`[download] "${expectedFileName}" is only ${realSize} of the expected ${expectedSize} bytes -- a partial download, replacing it rather than keeping it alongside a new one.`);
                fs.rmSync(candidatePath, { force: true });
            } else {
                // Same name, genuinely different (and not smaller/truncated-looking) -- never
                // silently reused OR overwritten; the real download below still runs, through
                // uniqueFileName's own "(1)" disambiguation, exactly as it already does for any
                // other real collision.
                console.warn(`[download] "${expectedFileName}" already exists but is ${realSize} bytes, not the expected ${expectedSize} -- treating it as a different file, not reusing it.`);
            }
        } else {
            // No trustworthy expected size for this source (Nexus) -- existence under the exact
            // expected name is the only signal available; see this function's own header comment.
            return { archivePath: candidatePath, fileName: expectedFileName, size: realSize };
        }
    }

    // 3. Vortex's own download records (the Helper) -- a file Vortex itself already knows about
    // under this exact name, confirmed finished and (when a trustworthy expected size exists) the
    // right size. A real, additional signal the task's own spec calls for: Vortex can know about a
    // file under a name this app never computed itself (e.g. the player renamed it by hand), as
    // long as it's still sitting at the expected path in the downloads folder.
    // The file must actually be there before the Helper is even asked -- while Vortex is starting, a
    // Helper call can stall for seconds, and with no file there is nothing for it to confirm.
    const available = fs.existsSync(candidatePath) && await helperClient.checkHelperAvailable('skyrimse');
    if (available) {
        const realSize = fs.statSync(candidatePath).size;
        if (expectedSize == null || realSize === expectedSize) {
            const downloadsData = await helperClient.getAllDownloads();
            const vortexKnowsIt = downloadsData && downloadsData.files && Object.values(downloadsData.files).some((f) => f.localPath === expectedFileName && f.state === 'finished'
                && (expectedSize == null || f.size === expectedSize));
            if (vortexKnowsIt) return { archivePath: candidatePath, fileName: expectedFileName, size: realSize };
        }
    }

    return null;
}

// Hub links found to point at an older release than the version the Hub lists, remembered for this run so a repeated Check now does
// not spend GitHub's small unauthenticated budget asking again. Key: "<link>|<version>".
const linkStaleCache = new Map();

// The Hub's own link, even after the row's link was swapped for the releases page.
function staleKey(row) { return `${row.hubLink || row.externalUrl}|${row.latestVersion}`; }

function releasesPageOf(externalUrl) {
    const parsed = github.parseGitHubUrl(externalUrl);
    return parsed ? `https://github.com/${parsed.owner}/${parsed.repo}/releases` : externalUrl;
}

// The honest line for a mod whose release can't be found at the version the row shows (queue: update-downloads-the-version-it-says,
// 2026-10-04). Nothing is downloaded or installed; the row keeps a link to the repo's releases page, which is the way to the
// download for someone who wants to install it by hand. Words are the page's (renderRow: row.linkOutOfDate).
function markLinkOutOfDate(row, oldVersion, releasesUrl) {
    row.status = 'needs_you';
    row.error = null;
    row.downloadProgress = null;
    row.linkOutOfDate = { newVersion: row.latestVersion, oldVersion };
    if (!row.hubLink) row.hubLink = row.externalUrl;
    row.externalUrl = releasesUrl || releasesPageOf(row.externalUrl);
    return row;
}
function rememberStaleLink(row, oldVersion) {
    const releasesUrl = releasesPageOf(row.externalUrl);
    linkStaleCache.set(staleKey(row), { oldVersion, releasesUrl });
    return markLinkOutOfDate(row, oldVersion, releasesUrl);
}

// Before an archive is handed to the options screen or installed: refuses one whose release is OLDER than the version the row
// promised, or older than what is installed (never a downgrade). Returns true after turning the row into the honest line.
function refuseWrongRelease(row) {
    const rel = row.downloadedReleaseVersion;
    if (!rel) return false;
    const olderThanPromised = row.latestVersion && compareVersions(rel, row.latestVersion) === 'newer';
    const olderThanInstalled = row.installedVersion && !row.installedVersionUnknown && compareVersions(row.installedVersion, rel) === 'older';
    if (!olderThanPromised && !olderThanInstalled) return false;
    row.downloadedArchivePath = null;
    row.downloadedFileName = null;
    row.updatePreview = null;
    markLinkOutOfDate(row, rel);
    return true;
}

// knownPremium (queue: updater-v1-polish, 2026-09-30) -- lets a caller that already checked the
// Nexus key once for a whole batch (check()'s own auto-download loop) skip a second real API call
// here. undefined (the default) means "not checked yet for this call", so a standalone
// "Download" click on a single Nexus row still works exactly as before -- it just does its own
// check, same as always.
// `userAsked`: the person pressed a button for this (never the automatic download). Under Mod Organizer 2 that download IS the install,
// so it is where the plugins-page count is sent; under Vortex the count is sent by the Update / Install that follows.
async function downloadPlugin(id, { knownPremium, userAsked = false } = {}) {
    const row = findRow(id);
    if (!row || row.status !== 'update_available' && row.status !== 'needs_you') return row;
    if (row.notInstalled && !userAsked) return row; // a mod that is not installed is never fetched without a person's click
    const cfg = appConfig.loadConfig();
    // No per-row error here (queue: fill-staging-folder-keep-changelogs, 2026-09-30) -- the
    // Download/Download all buttons are disabled client-side whenever this is the case, so this is
    // only ever reached by something bypassing that (a stale page, a direct API call); silently
    // no-op rather than pile up a row error the single top-of-page banner already covers.
    if (!cfg.downloadFolder) return row;
    row.error = null;
    if (userAsked && modManager.isMo2(cfg) && row.status === 'update_available' && (row.urlKind === 'github' || (row.urlKind === 'nexus' && cfg.nexusApiKey))) countRowInstall(row);

    // Local files first: if this version's file is already here (remembered, and still on disk at its
    // recorded size), the row goes straight to "downloaded" -- never "Downloading...", no progress bar,
    // and no GitHub/Nexus request at all.
    const alreadyHere = rememberedDownload(row);
    if (alreadyHere) {
        row.downloadedArchivePath = alreadyHere.archivePath;
        row.downloadedFileName = alreadyHere.fileName;
        row.downloadedReleaseVersion = alreadyHere.releaseVersion;
        row.status = 'downloaded';
        row.downloadProgress = null;
        downloadState.record(row.id, { fileName: alreadyHere.fileName, filePath: alreadyHere.archivePath, size: alreadyHere.size, version: row.latestVersion, releaseVersion: alreadyHere.releaseVersion });
        return finishDownload(row, cfg);
    }
    // Not known to be here yet. "queued" until bytes really arrive: looking up the release and checking
    // the downloads folder by name can take a moment, and none of that is downloading.
    // A link already found to be out of date for this version: the same honest line, no new GitHub calls.
    const knownStale = linkStaleCache.get(staleKey(row));
    if (row.urlKind === 'github' && knownStale) return markLinkOutOfDate(row, knownStale.oldVersion, knownStale.releasesUrl);
    row.status = 'queued';
    row.downloadProgress = null;

    try {
        if (row.urlKind === 'github') {
            const { release, linkVersion } = await github.resolveReleaseForVersion(row.externalUrl, row.latestVersion);
            if (!release) return rememberStaleLink(row, linkVersion);
            // Whatever release came back, it must not be OLDER than the version the row promised (a bare link can resolve to
            // an older latest than the Hub lists). Newer is fine and is recorded as what it is.
            const releaseVersion = github.versionOfTag(release.tag_name) || row.latestVersion;
            if (compareVersions(releaseVersion, row.latestVersion) === 'newer') return rememberStaleLink(row, releaseVersion);
            row.linkOutOfDate = null;
            const { chosen, otherCandidates } = github.pickModArchiveAsset(release);
            if (!chosen) throw new Error('No downloadable archive (.7z, .zip, or .rar) attached to this release.');
            if (otherCandidates.length > 0) {
                row.otherAssetsNotDownloaded = otherCandidates.map((a) => a.name);
            }
            const candidateFileName = chooseDownloadFileName(chosen.name, { pluginTitle: row.title, newVersion: row.latestVersion });
            const reused = await findExistingDownload(row, cfg, { expectedFileName: candidateFileName, expectedSize: chosen.size });
            if (reused) {
                row.downloadedArchivePath = reused.archivePath;
                row.downloadedFileName = reused.fileName;
                row.downloadedReleaseVersion = releaseVersion;
                row.status = 'downloaded';
                downloadState.record(row.id, { fileName: reused.fileName, filePath: reused.archivePath, size: reused.size, version: row.latestVersion, releaseVersion });
            } else {
                const fileName = uniqueFileName(cfg.downloadFolder, candidateFileName);
                const destPath = path.join(cfg.downloadFolder, fileName);
                const downloadResult = await github.downloadAsset(chosen, destPath, {
                    onProgress: (p) => { row.status = 'downloading'; row.downloadProgress = p; },
                });
                row.downloadedArchivePath = destPath;
                row.downloadedFileName = fileName;
                row.downloadedReleaseVersion = releaseVersion;
                row.status = 'downloaded';
                downloadState.record(row.id, { fileName, filePath: destPath, size: downloadResult.bytes, version: row.latestVersion, releaseVersion });
            }
        } else if (row.urlKind === 'nexus') {
            if (!cfg.nexusApiKey) {
                row.status = 'needs_you';
                row.error = 'Add a Nexus API key in Settings to download this automatically, or use the link.';
                return row;
            }
            const isPremium = knownPremium !== undefined ? knownPremium : (await nexus.checkApiKey(cfg.nexusApiKey)).isPremium;
            if (!isPremium) {
                row.status = 'needs_you';
                row.error = 'Nexus only lets Premium members download automatically -- use the link instead.';
                return row;
            }
            const parsed = nexus.parseNexusUrl(row.externalUrl);
            if (!parsed) throw new Error('Could not read a mod id out of this Nexus URL.');
            // No trustworthy pre-download size for Nexus (see findExistingDownload's own header
            // comment) -- resolving the file's own real name first still lets the remembered-state
            // and folder/Vortex name-only checks below do their real job before ever downloading
            // again.
            const nexusFile = await nexus.resolveMainFile(cfg.nexusApiKey, parsed.gameDomain, parsed.modId);
            const expectedNexusName = nexusFile && nexusFile.file_name;
            const reused = await findExistingDownload(row, cfg, { expectedFileName: expectedNexusName, expectedSize: null });
            if (reused) {
                row.downloadedArchivePath = reused.archivePath;
                row.downloadedFileName = reused.fileName;
                row.status = 'downloaded';
                downloadState.record(row.id, { fileName: reused.fileName, filePath: reused.archivePath, size: reused.size, version: row.latestVersion, releaseVersion: row.latestVersion });
            } else {
                const result = await nexus.downloadMod({
                    apiKey: cfg.nexusApiKey, gameDomain: parsed.gameDomain, modId: parsed.modId,
                    destDir: cfg.downloadFolder,
                    onProgress: (p) => { row.status = 'downloading'; row.downloadProgress = p; },
                });
                row.downloadedArchivePath = result.archivePath;
                row.downloadedFileName = result.fileName;
                row.status = 'downloaded';
                downloadState.record(row.id, { fileName: result.fileName, filePath: result.archivePath, size: result.bytes, version: row.latestVersion, releaseVersion: row.latestVersion });
            }
        } else {
            row.status = 'needs_you';
            row.error = 'No automatic download available for this link -- use the link instead.';
        }
    } catch (e) {
        row.status = 'update_available';
        if (e && e.githubApi) {
            // GitHub's own words (a raw JSON block) never reach the row: one plain amber sentence; the full text goes to the log. A limit that has passed clears it by itself (getState).
            try { require('./update-log').logUpdate(`[${row.id}] ${e.message}`); } catch { /* the log is best effort */ }
            row.error = github.friendlyError(e);
            row.errorWarn = true;
            row.rateLimitedUntil = e.rateLimited ? (e.resetAt || Date.now() + 15 * 60 * 1000) : null;
        } else row.error = e.message;
        return row;
    }

    return finishDownload(row, cfg);
}

// Everything after a download is in place: whether an Update button should show at all (the Helper
// reachable, the owning mod found) -- or, under MO2, the line saying MO2 installs it.
async function finishDownload(row, cfg) {
    // Best-effort: whether an "Update" button should show at all (Helper reachable, owning mod
    // found). A failure here is never fatal to the download itself -- the row just ends at
    // "Downloaded [check]" with no button, per the task's own spec.
    if (modManager.isMo2(cfg)) { // MO2 installs it itself -- no preview, no Helper
        row.updatePreview = null;
        row.updateUnavailableReason = updateUnavailableReasonText('mo2_manual');
        return row;
    }
    await detectFomod(row);
    try {
        row.updatePreview = await vortexUpdate.previewUpdate(row.id);
    } catch {
        row.updatePreview = null;
    }
    return row;
}

// Tells the plugins page about an install the person asked for (see lib/hub-api.js: one call per plugin and version, never waits).
function countRowInstall(row) {
    try { hubApi.countInstall({ pluginId: row.hubId, version: row.latestVersion, listingUrl: row.listingUrl }); } catch { /* the count never matters to the install */ }
}

// Records a click through to a mod's own page (the Mod page arrow, Open on Nexus). The Hub id comes from the row, never from the page.
function recordVisit(id) {
    const row = findRow(id);
    if (!row || !row.hubId) return { ok: false };
    try { return { ok: true, ...hubApi.countVisit({ pluginId: row.hubId, listingUrl: row.listingUrl }) }; } catch { return { ok: false }; }
}

// Plain-language text for a swap that did not complete (queue: update-delete-old-and-deploy-ask, 2026-10-01).
// The one sentence for a Vortex Bridge older than ModPacer needs (the page's banner says the same: web/public/setup-flow.js BRIDGE_OUTDATED).
const BRIDGE_OUTDATED_TEXT = "Your Vortex Bridge is out of date. Drop the new zip file onto Vortex's Extensions page.";
function updateFailureText(reason) {
    if (reason === 'helper_outdated') return BRIDGE_OUTDATED_TEXT;
    if (reason === 'update_failed_restored') return "The update didn't go through, and the old version was restored. Nothing was lost.";
    if (reason === 'update_failed_restore_failed') return "The update didn't go through, and the old version couldn't be put back automatically. Everything needed to restore it is saved, so nothing is lost.";
    if (reason === 'vortex_unfinished') return "Vortex hasn't finished this mod. Check Vortex.";
    if (reason === 'remove_old_failed') return "Vortex wouldn't replace the old version, so nothing was changed.";
    return `Couldn't update in Vortex (${reason}).`;
}

const CONNECTION_LOSS_REASONS = ['vortex_not_running', 'vortex_running_helper_unreachable', 'vortex_starting', 'helper_unavailable', 'helper_not_installed'];

// What an update's result means for the row. "Updated" only when EVERY part worked; if the mod is installed but something
// didn't carry over, the row is flagged (carryOver) instead of showing a clean tick. A finished swap is remembered as
// waiting to be deployed -- updates never deploy by themselves.
function applyUpdateResult(row, result) {
    // The new version is in, but the old copy is not fully gone (its Vortex record, its archive, its staging folder): NOT Updated. The row keeps its
    // place with one short sentence and a Try again; the removal is tried again later from the saved entry (lib/old-copy-store.js).
    const oldCopyUnfinished = !!(result.ok && result.oldCopy && !result.oldCopy.complete && !result.oldCopy.waitingOnRules);
    if (oldCopyUnfinished) {
        row.notInstalled = false;
        row.vortexUpdateResult = result;
        row.fomodMismatch = null;
        row.carryOver = null;
        markOldCopyLeft(row, result.oldCopy.left);
        pendingDeploy.add({ pluginId: row.id, title: row.title, newModId: result.newModId, wasEnabled: !!result.wasEnabled, noDeploy: result.wasEnabled === false,
            pluginsTurnedOn: (result.plugins && result.plugins.turnedOn) || 0, pluginsToRetry: (result.plugins && result.plugins.failed) || [], pluginsHeldOff: (result.plugins && result.plugins.heldOff) || [] });
        return;
    }
    if (result.ok) {
        clearOldCopyLeft(row);
        row.status = 'updated';
        row.installedNew = !result.oldModId; // it was new to Vortex: the row says Installed, not Updated
        row.notInstalled = false; // installed now: it moves out of "Mods not installed" into Up to date
        try { row.updatedAt = downloadState.recordUpdateTime(row.id, 'updatedAt'); } catch { /* a missing time only affects the sort */ }
        row.vortexUpdateResult = result;
        const pl = result.plugins || { turnedOn: 0, failed: [] };
        row.pluginsTurnedOn = pl.turnedOn || 0;
        row.pluginsAllFailed = pl.turnedOn === 0 && (pl.failed || []).length > 0;
        row.fomodMismatch = null;
        row.error = null;
        row.errorWarn = false;
        row.carryOver = result.partial && result.partial.length > 0 ? { snapshotPath: result.snapshotPath, partial: result.partial } : null;
        // A mod that was left disabled has nothing to deploy: it stays on the list only so its plugins held off are put back after the next deploy
        // (`noDeploy`: never offered, never counted -- see getState).
        pendingDeploy.add({ pluginId: row.id, title: row.title, newModId: result.newModId, wasEnabled: !!result.wasEnabled, noDeploy: result.wasEnabled === false,
            pluginsTurnedOn: (result.plugins && result.plugins.turnedOn) || 0, pluginsToRetry: (result.plugins && result.plugins.failed) || [], pluginsHeldOff: (result.plugins && result.plugins.heldOff) || [] });
    } else if (CONNECTION_LOSS_REASONS.includes(result.reason)) {
        // Vortex stopped answering: not this mod's fault, so no error is pinned on the row -- the page shows the
        // "Vortex is open, but..." notice and leaves the row as it was.
    } else if (result.reason === 'fomod_mismatch') {
        // Not a failure: a FOMOD always waits for the player's options screen. Nothing was installed; no error on the row.
        row.error = null;
        row.fomodMismatch = result.detail;
    } else {
        row.error = updateFailureText(result.reason);
        row.errorWarn = result.reason === 'vortex_unfinished'; // amber, not red: the mod may still show up in Vortex
        row.fomodMismatch = null;
    }
}

// Runs one mod's update while its real steps are published (lib/update-progress.js, shown on the row). If Vortex stops
// answering, the row keeps its last real step marked "waiting"; anything else ends the progress.
async function withProgress(id, fn) {
    updateProgress.begin(id);
    let result;
    try { result = await fn(); } catch (e) { updateProgress.end(id); throw e; }
    if (result && CONNECTION_LOSS_REASONS.includes(result.reason)) updateProgress.markWaiting(id);
    else updateProgress.end(id);
    return result;
}

// The "Update" button/confirm action -- only valid once a row has a real downloaded archive.
// The person's answer to "This mod is currently disabled. Do you want to enable it or keep it disabled?": 'enable' | 'keep', per mod, used by the
// next update of that mod (single, batch or after a FOMOD screen) and then forgotten.
const disabledChoices = new Map();
function setDisabledChoice(ids, choice) {
    if (choice !== 'enable' && choice !== 'keep') return { ok: false, status: 400, error: 'Choose enable or keep.' };
    for (const id of ids || []) disabledChoices.set(id, choice);
    return { ok: true };
}
function takeDisabledChoice(id) { const c = disabledChoices.get(id); disabledChoices.delete(id); return c; }
// Of these rows, the ones whose Vortex mod is switched off right now (read fresh): [{ id, title }].
async function findDisabled(ids) {
    const rows = (ids || []).map((id) => findRow(id)).filter(Boolean);
    const off = new Set(await vortexUpdate.disabledModIds(rows.map((r) => r.id)));
    return rows.filter((r) => off.has(r.id)).map((r) => ({ id: r.id, title: r.title }));
}

async function updatePlugin(id) {
    const row = findRow(id);
    if (!row || !row.downloadedArchivePath) return { ok: false, reason: 'not_downloaded' };
    // Picking up after the helper stopped answering can ask again for a mod that finished after all: never install it twice.
    if (row.status === 'updated' || row.status === 'deployed') return { row, result: { ok: false, reason: 'already_updated' } };
    if (refuseWrongRelease(row)) return { row, result: { ok: false, reason: 'link_out_of_date' } };
    if (!row.isFomod) countRowInstall(row); // a FOMOD counts when its options screen is finished (finishWizard); a retry of either never counts twice
    const result = await withProgress(id, () => vortexUpdate.updateInVortex(id, row.downloadedArchivePath, row.latestVersion, { displayName: row.title, urlKind: row.urlKind, ifDisabled: takeDisabledChoice(id) }));
    applyUpdateResult(row, result);
    return { row, result };
}

// The picker screen's own "Finish" action (queue: updater-v1-polish, 2026-09-30) -- `picks` is what the player chose:
// { [stepIdx]: { [groupIdx]: number[] } }.
// Clears row.fomodMismatch either way: a genuine success moves on to "Updated", and a real failure still means there's
// no wizard left to show (the error explains why).
async function finishWizard(id, picks) {
    const row = findRow(id);
    if (!row || !row.downloadedArchivePath || !row.fomodMismatch) return { ok: false, reason: 'no_wizard_pending' };
    if (refuseWrongRelease(row)) return { row, result: { ok: false, reason: 'link_out_of_date' } };
    countRowInstall(row);
    const result = await withProgress(id, () => vortexUpdate.finishFomodWizard(id, row.downloadedArchivePath, row.latestVersion, picks, { displayName: row.title, urlKind: row.urlKind, ifDisabled: takeDisabledChoice(id) }));
    row.fomodMismatch = null;
    if (result.ok) applyUpdateResult(row, result);
    else row.error = CONNECTION_LOSS_REASONS.includes(result.reason) ? null : updateFailureText(result.reason);
    return { row, result };
}

// Opens a FOMOD mod's options screen: the new archive's options with the old choices pre-filled, nothing installed.
// Returns { row, result } where result.picker is the screen's data (null if the archive turns out not to be a FOMOD).
async function prepareWizard(id) {
    const row = findRow(id);
    if (!row || !row.downloadedArchivePath) return { row: null, result: { ok: false, reason: 'not_downloaded' } };
    if (refuseWrongRelease(row)) return { row, result: { ok: false, reason: 'link_out_of_date' } };
    const result = await vortexUpdate.prepareFomodWizard(id, row.downloadedArchivePath);
    if (result.ok && result.picker) row.fomodMismatch = { kind: 'fomod-mismatch', reason: 'always_ask' }; // a small marker; the screen's data goes to the page, not into the row
    else if (result.ok) row.isFomod = false;
    return { row, result };
}

// "Try again" for a mod that installed but whose rules didn't all carry over: re-applies just that part.
async function retryCarryOver(id) {
    const row = findRow(id);
    if (row && row.oldCopyLeft && !row.carryOver) {
        // The new version is in; only the old copy is left. Remove it again through the Bridge, then look.
        const entry = oldCopyStore.get(id);
        if (OLD_COPY_ALL_TEXTS.has(row.error)) { row.error = null; row.errorWarn = false; } // the old sentence goes at once; a new one only if this try ends badly
        if (!entry) { clearOldCopyLeft(row); return { row, result: { ok: true, oldCopy: { complete: true, left: [] } } }; }
        const r = await vortexUpdate.finishOldCopy(entry);
        if (r.complete) { oldCopyStore.remove(id); finishRowAfterOldCopy(row); }
        else { oldCopyStore.update(id, { left: r.left }); markOldCopyLeft(row, r.left); }
        return { row, result: { ok: r.complete, reason: r.reason, oldCopy: { complete: r.complete, left: r.left } } };
    }
    if (!row || !row.carryOver) return { ok: false, reason: 'nothing_to_retry' };
    const result = await vortexUpdate.retryCarryOver(row.carryOver.snapshotPath);
    if (result.ok) {
        row.carryOver = null;
        if (result.oldCopy && !result.oldCopy.complete) { // the rules are in, but the old copy is still not fully gone
            row.status = row.status === 'updated' || row.status === 'deployed' ? 'downloaded' : row.status;
            markOldCopyLeft(row, result.oldCopy.left);
        }
    } else if (result.partial) row.carryOver = { ...row.carryOver, partial: result.partial };
    return { row, result };
}

// "Deploy": Vortex's REAL full deploy (lib/deploy-job.js) -- there is no single-mod deploy any more. The updated mods were already
// installed and enabled by the update itself; this one deploy covers the whole install. Only when Vortex agrees it is done do the
// mods that were waiting (as of the press) become "Deployed". (Until 2026-10-05 this also removed the OLD mod's staging folder; the update itself now removes the old copy
// through the Bridge, so nothing here deletes a folder.)
// Any other outcome keeps the waiting list. Returns { started } | { busy } | { ok: false, reason }.
// True when this deploy covers mods whose plugins ModPacer switched on itself, and none were skipped or refused: the finish note
// can then say so instead of asking the person to go and check.
let lastDeployPluginsAllOn = false;
function pluginsAllOn(entries) {
    const withPlugins = entries.filter((e) => (e.pluginsTurnedOn || 0) > 0 || (e.pluginsToRetry || []).length > 0 || (e.pluginsHeldOff || []).length > 0);
    return withPlugins.length > 0 && withPlugins.every((e) => (e.pluginsToRetry || []).length === 0 && (e.pluginsHeldOff || []).length === 0);
}

async function startDeploy() {
    const entries = pendingDeploy.list();
    lastDeployPluginsAllOn = pluginsAllOn(entries);
    return deployJob.start({
        isConnected: async () => { const st = await vortexUpdate.getHelperConnectionState(); return st === 'connected' && helperClient.bridgeIsTooOld() ? 'helper_outdated' : st; }, // held back for a Bridge older than ModPacer needs
        // Plugins Vortex would not switch on at install time (it had not listed them yet) get another try just before the deploy.
        beforeDeploy: async () => {
            for (const entry of entries) {
                if (entry.pluginsToRetry && entry.pluginsToRetry.length > 0) await modPlugins.enablePlugins(entry.pluginsToRetry);
            }
        },
        onConfirmed: () => completeDeployed(entries),
    });
}

// What follows a real deploy for these saved entries (any run's): plugins that must stay off are put back, the row turns Deployed, and the entries are forgotten.
// (No folder is deleted here since 2026-10-05: the old copy is removed by the update itself, through the Bridge.)
async function completeDeployed(entries) {
    for (const entry of entries) {
        // A plugin the person had off must still be off after the deploy: switch it back if Vortex brought it back.
        if (entry.pluginsHeldOff && entry.pluginsHeldOff.length > 0) await modPlugins.keepOff(entry.pluginsHeldOff);
        // The old copy is removed by the update itself, through the Bridge (lib/vortex-update.js removeOldCopy), never here and never by a direct delete.
        const row = findRow(entry.pluginId);
        if (row && row.status === 'updated') row.status = 'deployed';
        try { downloadState.recordUpdateTime(entry.pluginId, 'deployedAt'); } catch { /* a missing time only affects the sort */ }
    }
    if (entries.length > 0) pendingDeploy.remove(entries.map((e) => e.pluginId));
}

// The person deployed inside Vortex themselves (or Vortex did): when the Bridge says nothing needs deploying, the offer goes away and the saved
// entries are cleaned up as after our own deploy. Read-only toward Vortex. If the Bridge cannot say (no answer, or an older one without
// `needToDeploy`), nothing changes: the this-run rule alone decides. A fresh entry is given a moment: Vortex notices a new install a little late.
let deployNeededGraceMs = 20_000;
function setDeployNeededGraceMs(ms) { deployNeededGraceMs = ms; }
let deployNeededInFlight = null;
function refreshDeployNeeded() {
    if (updateRunning()) return Promise.resolve();
    if (!deployNeededInFlight) deployNeededInFlight = refreshDeployNeededNow().finally(() => { deployNeededInFlight = null; });
    return deployNeededInFlight;
}
async function refreshDeployNeededNow() {
    const entries = pendingDeploy.list();
    if (entries.length === 0 || deployJob.snapshot().state === 'running' || modManager.isMo2()) return;
    let p = null;
    try { p = await helperClient.getDeployAllProgress(); } catch { p = null; }
    if (!p || p.active || typeof p.needToDeploy !== 'boolean' || p.needToDeploy) return;
    const settled = entries.filter((e) => Date.now() - Date.parse(e.updatedAt || 0) >= deployNeededGraceMs);
    await completeDeployed(settled);
}

// What the running (or last) deploy is doing: { state: 'idle' | 'running' | 'done', ... } -- see lib/deploy-job.js.
function deployProgress() { return { ...deployJob.snapshot(), pluginsAllOn: lastDeployPluginsAllOn }; }

module.exports = { buildNotInstalledRows, startFresh, markNotRegisteredYet, markWhereRows, addInstalledByName, NOT_REGISTERED_YET, OLD_COPY_LEFT_TEXT, OLD_COPY_TEXTS, oldCopyText, retryOldCopies, flagOldCopyRows, whenAutoDownloadsSettled, markPreviewsPending, updateRunning, refreshDeployNeeded, setDeployNeededGraceMs, setDisabledChoice, findDisabled, answerPair, pairVortexMods, recordVisit, displayTitle, check, getState, findRow, downloadPlugin, updatePlugin, prepareWizard, finishWizard, retryCarryOver, startDeploy, deployProgress, applyUpdateResult, classifyUrl, maybeAutoDownloadNow, refreshUpdatePreviews, updateUnavailableReasonText, setVortexRetryDelays, resetVortexRetry, waitForSettled, clearStaleHelperTrouble };
