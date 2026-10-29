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
const { logUpdate, logArea, logAreaOnce } = require('./update-log');
const versionLog = require('./version-log');
const downloadLog = require('./download-log');
const selfUpdateCheck = require('./self-update-check');
const { APP_VERSION } = require('./app-version');
const pluginMatcher = require('./plugin-matcher');
const programListings = require('./program-listings');
const waitLog = require('./vortex-wait-log');
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
const archiveCheck = require('./archive-check');
const vctRemoval = require('./vct-removal');
const modManager = require('./mod-manager');
const firstRunSetup = require('./first-run-setup');
const pendingDeploy = require('./pending-deploy');
const modPlugins = require('./mod-plugins');
const mo2 = require('./mo2');
const mo2Instance = require('./mo2-instance');
const installArchive = require('./install-archive');
const oldCleanup = require('./old-download-cleanup');
const oldCopyStore = require('./old-copy-store');
const modHold = require('./mod-list-hold');
const leftoverCheck = require('./leftover-check');
const downloadState_ = require('./download-state');
const matchRecords = require('./match-records');
const updateProgress = require('./update-progress');
const deployJob = require('./deploy-job');

// One row per installed (external-source) plugin -- see TECHNICAL.md for the full status enum.
let state = {
    lastCheckedAt: null,
    skyrimNetDir: null,
    rows: [], // [{id, title, author, installedVersion, latestVersion, externalUrl, urlKind, status, ...}]
    error: null,
    vortexHelperState: null, // 'connected' | 'vortex_running_helper_unreachable' | 'vortex_not_running' | 'vortex_other_game' | null (not checked yet)
};

function classifyUrl(externalUrl) {
    if (!externalUrl) return 'none';
    if (/^https?:\/\/github\.com\//i.test(externalUrl)) return 'github';
    if (/^https?:\/\/(?:www\.)?nexusmods\.com\//i.test(externalUrl)) return 'nexus';
    return 'other';
}

// The name shown for a mod everywhere (its row, the FOMOD screen): its own manifest title; when that is missing or just its id,
// the Hub's title for it; the id only as a last resort.
function displayTitle(manifest, plugin, catalogEntry, matchedBy) {
    if (matchedBy === 'github') { const h = ((catalogEntry && catalogEntry.title) || '').trim(); if (h) return h; } // the Hub's name for a mod found by its link
    const own = (manifest.title || '').trim();
    if (own && own !== plugin.id) return own;
    const hub = ((catalogEntry && catalogEntry.title) || '').trim();
    const named = (typeof manifest.name === 'string' ? manifest.name : '').trim(); // a manifest with no title but a name still reads as a name
    return hub || (named && named !== plugin.id ? named : '') || own || plugin.id;
}

// What a row knows about its Hub entry: the plugins-site page, the Hub's own id (what the plugins-page count needs), the catalog's counts
// (as of its stats_as_of time), and the link the catalog itself lists (kept to notice if the Hub's answer ever differs).
function hubFields(entry) {
    if (!entry) return { hubUrl: null, hubId: null, stats: null, listingUrl: null, hasCover: false, coverAdult: false };
    // hasCover: the catalog lists a cover picture for it (the page asks for the picture only for these, and only when it is on screen); coverAdult: it is an adult mod.
    return { hubUrl: catalogLib.hubPageUrl(entry), hubId: entry.plugin_id || null, stats: entry.stats || null, listingUrl: entry.external_url || null, hasCover: require('./hub-covers').hasCover(entry), coverAdult: !!entry.nsfw };
}

// A Hub listing the player does not have yet (queue: mods-not-installed-section). Same row shape as an installed one, so the download /
// install / FOMOD / deploy machinery (and Update all's) works on it unchanged; `notInstalled` keeps it out of Updates and Up to date.
function buildNotInstalledRow(entry) {
    const externalUrl = entry.external_url || null;
    return {
        ...programFields(entry),
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
// A listed program (lib/program-listings.json) never installs: the row only says so and opens its download page.
function programFields(entry) {
    return programListings.isProgram(entry) ? { isProgram: true, programLine: programListings.PROGRAM_LINE } : {};
}
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
// Mod Organizer 2: an add-on's installed version comes from its own files (the winning enabled copy's manifest, or a newer one recorded by the mod that
// holds only that add-on), never from a mod that merely contains it or from a disabled copy. A plugin with no `where` (no layer information) keeps the old lookup.
function mo2VersionInfo(plugins, modsFolder) {
    const withWhere = plugins.filter((p) => p.where);
    const info = mo2.resolveInfoForPlugins(withWhere, modsFolder, compareVersions);
    const rest = plugins.filter((p) => !p.where).map((p) => p.id);
    return rest.length ? { ...mo2.resolveInfoBatch(rest, modsFolder), ...info } : info;
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
const loggedOnce = new Set();
function logUpdateOnce(line) { if (loggedOnce.has(line)) return; loggedOnce.add(line); logUpdate(line); }
let lastUnmatchedKey = '';
function reportUnmatched(plugins, matches) {
    const ids = plugins.filter((p) => { const m = matches.get(p.id); return !(m && m.catalogEntry); }).map((p) => p.id).sort();
    const key = ids.join('|');
    if (key === lastUnmatchedKey) return;
    lastUnmatchedKey = key;
    for (const id of ids) logUpdate(`catalog: installed mod ${id} has no matching Hub entry`);
}

// A registry entry whose own add-on folder has no manifest anywhere (the author re-published under a new id, or the files were removed) and that the Hub does not list: nothing is
// installed under that id, so there is nothing to show, count or do. Left off the page, one log line. A manifest that exists but cannot be read, an add-on the Hub lists, and an
// add-on found in Overwrite or an enabled mod keep their row. ModPacer never writes SkyrimNet's registry. `plugins` is edited in place.
function isGhost(p, match) {
    if (!p || p.evidence !== 'registry' || p.manifest) return false;
    if (match && match.catalogEntry) return false;
    if (!/ENOENT/.test(String(p.manifestError || ''))) return false;
    if (p.manifestPath && fs.existsSync(p.manifestPath)) return false;
    const w = p.where || {};
    return !w.overwrite && !(w.mods && w.mods.length);
}
function dropGhosts(plugins, matches) {
    for (let i = plugins.length - 1; i >= 0; i--) {
        if (!isGhost(plugins[i], matches.get(plugins[i].id))) continue;
        const id = plugins[i].id;
        plugins.splice(i, 1);
        logAreaOnce(`ghost:${id}`, 'versions', `${id}: SkyrimNet still lists it, but its files are not on disk, so it is left out`);
    }
}

// A version Vortex holds that is HIGHER than the one in the name of the mod's archive is not trusted: the archive is what is really installed
// ("SQOSPatcher-v0-3.zip" recorded as 0.4.0 by an old "It's <version>" press is still 0.3). So the archive name wins, and the row offers the update.
// Not for a mod Nexus identifies (its version is Nexus's own) or one ModPacer itself updated (a release file's name can lag its version).
function judgeByArchiveName(vortexInfo) {
    for (const [id, info] of Object.entries(vortexInfo || {})) {
        if (!info || info.fromCache || !info.archiveVersion || !info.recordedVersion) continue;
        if (info.source === 'nexus' && info.nexusModId) continue;
        if (downloadState.updateTimes(id).updatedAt) continue;
        if (compareVersions(info.archiveVersion, info.recordedVersion) !== 'newer') continue;
        logAreaOnce(`archive-version:${id}:${info.recordedVersion}`, 'versions', `${id}: Vortex says ${info.recordedVersion}, but the mod's archive name says ${info.archiveVersion}; going by the archive name`);
        info.version = info.archiveVersion;
        info.versionFromArchiveName = true;
        info.setByPlayer = false;
        vortexInfoCache.record(id, info);
    }
}

// The match record per mod (lib/match-records.js): written the first time a mod ModPacer did not install is matched with certainty (by id, or by one unique
// full title; never from an ambiguous or guessed match), kept current with what Vortex and the manifest say now, and marked stale when its installed side or
// its Hub entry is gone. Never throws: a record is a help, not part of the check.
function keepMatchRecords({ plugins, matches, rows, vortexInfo, ours, isMo2 }) {
    try {
        if (!plugins.length || !ours.length) return; // nothing read (or the catalog unreadable): records stay as they are
        const manager = isMo2 ? 'mo2' : 'vortex';
        const rowOf = new Map(rows.map((r) => [r.id, r]));
        const have = new Map(matchRecords.active().map((r) => [`${String(r.hubId).toLowerCase()}|${String(r.manifest.id).toLowerCase()}`, r]));
        const seen = {};
        for (const p of plugins) {
            const m = matches.get(p.id);
            const entry = m && m.catalogEntry;
            if (!entry || !entry.plugin_id) continue;
            const row = rowOf.get(p.id);
            const info = vortexInfo && vortexInfo[p.id];
            const live = info && !info.fromCache ? info : null;
            const man = p.manifest || {};
            const hubKey = String(entry.plugin_id).toLowerCase();
            if (live && live.recordedVersion && man.version && live.recordedVersion !== man.version) {
                logAreaOnce(`three:${p.id}:${live.recordedVersion}:${live.archiveVersion}:${man.version}`, 'versions', `${p.id}: the three versions disagree: Vortex's record says ${live.recordedVersion}, the archive name says ${live.archiveVersion || 'nothing'}, the mod file says ${man.version}`);
            }
            const vortex = live ? { modId: live.vortexModId, name: live.vortexModName, version: live.recordedVersion } : null;
            if (m.certain) {
                if (!have.has(`${hubKey}|${String(p.id).toLowerCase()}`) || m.replacesRecord) {
                    const w = matchRecords.write({ how: 'matched', manager, installedVersion: row && row.installedVersion,
                        hub: { id: entry.plugin_id, title: entry.title, externalUrl: entry.external_url },
                        manifest: { id: p.id, title: man.title, author: man.author, version: man.version },
                        archive: live ? { fileNames: [live.archiveFileName], md5: live.archiveMd5 } : null,
                        vortex: vortex ? { modId: vortex.modId, name: vortex.name, version: vortex.version } : null });
                    if (w) logAreaOnce(`record:${p.id}:${hubKey}`, 'versions', `${p.id}: match record written for the Hub entry ${entry.plugin_id} (matched by ${m.matchedBy})`);
                }
            }
            seen[hubKey] = { installedVersion: row && row.installedVersion, manifestVersion: man.version, vortex };
        }
        const r = matchRecords.reconcile({ installedIds: plugins.map((p) => p.id), hubIds: ours.map((e) => e.plugin_id).filter(Boolean), seen });
        for (const k of r.stale) logArea('versions', `match record for ${k} is stale (the installed mod or its Hub entry is gone); ignored`);
    } catch (e) { logArea('versions', `match record not kept: ${e.message}`); }
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
        title: displayTitle(manifest, plugin, catalogEntry, match && match.matchedBy),
        author: manifest.author || null,
        manifestTitle: manifest.title || null, // for the match record
        hubTitle: (catalogEntry && catalogEntry.title) || null,
        installedVersion,
        installedVersionUnknown,
        vortexModId: (vortexInfo && vortexInfo.vortexModId) || null,
        vortexInfoFromCache: !!(vortexInfo && vortexInfo.fromCache),
        versionSetByPlayer: !!(vortexInfo && vortexInfo.setByPlayer && !vortexInfo.fromCache), // the version came from the player's "It's <version>" press
        versionFromArchiveName: !!(vortexInfo && vortexInfo.versionFromArchiveName),
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
        ...base, ...programFields(catalogEntry), latestVersion, externalUrl, urlKind, status,
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

// The update log's story of a wait for a busy Vortex (logging only): one line when it begins, one per try (which ask failed and how, the try number out of the
// total, the time waited, the next delay), one when it ends. The detail of every request stays in logs/helper.log.
let waitStory = null; // { startedAt, looks } while a wait is going on
function logWaitStory({ waiting, gaveUp, retry, rawState, shownState }) {
    try {
        const total = vortexRetryDelays.length;
        if (waiting) {
            if (!waitStory) { waitStory = { startedAt: Date.now(), looks: 0 }; logArea('vortex', waitLog.beginLine(rawState, shownState)); }
            waitStory.looks++;
            const waited = Date.now() - waitStory.startedAt;
            const which = retry ? `try ${vortexRetry.tries} of ${total} (automatic repeat)` : waitStory.looks === 1 ? 'first look' : 'look after Check now or Retry';
            const asked = waitLog.askedText(rawState, { listBackingOff: vortexUpdate.isModsReadBackingOff(), listEmpty: vortexUpdate.lastListLookedEmpty() });
            if (gaveUp) {
                logArea('vortex', `waiting for Vortex: ${which}; asked: ${asked}`);
                logArea('vortex', `Vortex did not answer: gave up after ${waitLog.dur(waited)} (${waitLog.plural(vortexRetry.tries, 'try')}); the amber banner with Retry is shown`);
                waitStory = null;
            } else {
                logArea('vortex', `waiting for Vortex: ${which}; asked: ${asked}; next try in ${waitLog.dur(vortexRetryDelays[vortexRetry.tries])}; waited ${waitLog.dur(waited)} so far`);
            }
        } else if (waitStory) {
            const waited = Date.now() - waitStory.startedAt;
            if (rawState === 'connected') logArea('vortex', `Vortex answered after ${waitLog.dur(waited)} (${retry ? `try ${vortexRetry.tries} of ${total}` : 'a check you started'})`);
            else logArea('vortex', `no longer waiting for Vortex after ${waitLog.dur(waited)}: its state is now ${rawState}`);
            waitStory = null;
        }
    } catch { /* logging never breaks a check */ }
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

// Mod Organizer 2 with the downloads folder saved as the Mods folder (a first-run mix-up): put the instance's mods folder in its place, once, and say so in the log.
function repairModsFolder(cfg) {
    if (!modManager.isMo2(cfg)) return cfg;
    let patch = null;
    try { patch = mo2Instance.repairModsFolder(cfg); } catch { /* the check goes on with what is saved */ }
    if (!patch) return cfg;
    try {
        const saved = appConfig.saveConfig(patch);
        logArea('settings', `Mods folder was the downloads folder; now the mod folders (${patch.vortexStagingFolder})`);
        return saved && typeof saved === 'object' ? saved : { ...cfg, ...patch };
    } catch { return { ...cfg, ...patch }; }
}

async function checkOnce({ force, retry }) {
    helperClient.clearAskNotes(); // the reasons the update log gives for a wait are this check's own
    updateProgress.clearWaiting();
    let cfg = appConfig.loadConfig();
    cfg = repairModsFolder(cfg);
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
    const matches = pluginMatcher.matchPluginsToCatalog(plugins, ours, logUpdateOnce, matchRecords.active());
    dropGhosts(plugins, matches);
    reportUnmatched(plugins, matches);
    addInstalledByName({ cfg, scan, plugins, matches, ours });
    const own = selfUpdateCheck.inspectOwnListing(allOurs, APP_VERSION);
    noteSelfCheck(own.reason);
    // Where each mod's installed version comes from depends on the mod manager the player chose:
    // MO2 -> its own mods folder (meta.ini etc.), never the Vortex Helper; otherwise Vortex's live state.
    const pluginIds = plugins.map((p) => p.id);
    const vortexInfo = modManager.isMo2(cfg)
        ? mo2VersionInfo(plugins, mo2Instance.effectiveModsFolder(cfg))
        : await vortexUpdate.resolveVortexInfoBatch(pluginIds);
    if (!modManager.isMo2(cfg)) judgeByArchiveName(vortexInfo);
    // Computed once per check(), not per-row -- queue: helper-down-message-and-version-fallback,
    // 2026-10-01. Drives the one top-of-page banner; see getState()'s own comment for why this
    // isn't just inferred from whether any row's vortexInfo came back empty (a plugin genuinely
    // outside Vortex's purview looks identical to one Vortex can't currently be reached for).
    const vortexHelperState = modManager.isMo2(cfg) ? null : await vortexUpdate.getHelperConnectionState();

    // Hub listings that are already in Vortex under another name are installed mods too (lib/vortex-name-match.js).
    const pairing = await pairVortexMods({ ours, plugins, matches, vortexInfo, cfg, vortexHelperState, scan });
    addNameVersions(plugins, vortexInfo);
    const rows = plugins.concat(pairing.plugins).map((p) => buildRow(p, matches.get(p.id), vortexInfo[p.id]));
    keepMatchRecords({ plugins, matches, rows, vortexInfo, ours, isMo2: modManager.isMo2(cfg) });
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
    logWaitStory({ waiting, gaveUp, retry, rawState: vortexHelperState, shownState: vortexUpdate.applyStartingWindow(vortexHelperState) });
    // A version remembered from before Vortex stopped answering is not today's version (mods updated since would all show as updates, 2026-10-27: 19 listed,
    // 1 real). While Vortex is open but not answering, a row built from memory keeps its last version, marked not-confirmed, and is never listed as an update
    // (so no Download, no automatic download). Vortex closed on purpose keeps the remembered list; a live answer replaces all of this on the next check.
    if (!modManager.isMo2(cfg) && vortexHelperState !== 'vortex_not_running' && vortexHelperState !== 'helper_not_installed') {
        for (const row of rows) {
            if (!row.vortexInfoFromCache) continue;
            row.versionUnconfirmed = true;
            if (row.status === 'update_available') row.status = 'unknown_version';
        }
        const held = rows.filter((r) => r.versionUnconfirmed).length;
        if (held) logArea('check', `Vortex did not answer; ${held} mod(s) keep the version remembered from before and are not listed as updates until Vortex answers`);
    }
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
    dropExcludedThatAreInstalled(rows);
    // The evidence behind each installed version, one line per add-on (only what is new or changed since the last check; every line on Check now).
    versionLog.logVersions({ rows, plugins: plugins.concat(pairing.plugins), vortexInfo, scan, mo2, isMo2: modManager.isMo2(cfg), force, settingsFolder: modManager.isMo2(cfg) ? cfg.vortexStagingFolder : null });
    downloadLog.noteChecked(rows, { isMo2: modManager.isMo2(cfg), force });
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
    // A saved note is only true while Vortex still holds what it says: against the list this check just read, a note whose new version is gone is dropped (and that add-on is a normal update again) BEFORE any row is flagged.
    reconcileSavedNotes();
    flagOldCopyRows(state.rows);
    // Then the leftover check (older versions of an add-on still in Vortex), after the saved old copies had their turn so the two never remove the same mod at once.
    (oldCopyStore.list().length > 0 ? retryOldCopies().catch(() => {}) : Promise.resolve()).then(() => runLeftoverCheck('check')).catch(() => {});
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
    const pending = rows.filter((r) => r.status === 'update_available' && !r.notInstalled && !r.isProgram); // a program is never fetched
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
        const run = downloadPlugin(row.id, { knownPremium: knownNexusPremium, how: 'automatic' }).catch(() => {}); // downloadPlugin already records its own error onto the row
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
    bridge: 'New version installed. The old one will be removed once Vortex answers.',
    busy: 'Installed, but Vortex was too busy to remove the old version.',
    archive: 'The old download is still in the downloads folder.',
    folder: "The old mod's folder is still in Vortex's staging folder.",
    archiveAndFolder: "The old download and the old mod's folder are still there.",
};
function oldCopyText(left) {
    const l = left || [];
    if (l.includes('busy')) return OLD_COPY_TEXTS.busy;
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
        if (entry.waitingOnRules && !entry.deferred) continue; // the row's "didn't carry over" Try again owns this one until its rules are in (an Update all's mod waiting for "Removing old mods" is flagged too: its row never offers a second install)
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

// Drops every saved note that the mod list ModPacer just read contradicts (the new version is not installed any more, or is the wrong way round). Nothing is installed or removed: the add-on is
// then an ordinary update again (the check's own rows). Nothing is touched when Vortex's list is not there or an update is running.
function reconcileSavedNotes() {
    if (batchOpen() || updateRunning()) return;
    const held = modHold.get();
    if (!held || !held.mods || Object.keys(held.mods).length === 0) return;
    const cfg = appConfig.loadConfig();
    for (const entry of oldCopyStore.list()) {
        if (vortexUpdate.isDeferred(entry.pluginId)) continue;
        const v = vortexUpdate.judgeNote(entry, held, cfg);
        if (v.ok) continue;
        vortexUpdate.dropRefusedNote(entry, v.reason);
    }
}
// Tries again every saved unfinished old copy (the next run of ModPacer, a check, the row's Try again): Vortex must answer, and each one is
// removed through the Bridge and then looked at. One at a time, never twice at once. A finished one is forgotten and its row stops saying so.
let retryingOldCopies = null;
function retryOldCopies() {
    if (retryingOldCopies) return retryingOldCopies;
    retryingOldCopies = (async () => {
        // Mods an Update all installed but could not finish (Vortex was not answering): once Vortex answers and no Update all is running, "Removing old mods" and the carry-over are done
        // here by themselves, in one go, the same way the page's second pass does it (a removal is never sent twice; an old copy already gone counts as done).
        if (!batchOpen()) {
            const waiting = oldCopyStore.list().map((e) => e.pluginId).filter((id) => vortexUpdate.isDeferred(id));
            if (waiting.length > 0) {
                logUpdate(`[update] Vortex is answering: finishing ${waiting.length} old cop${waiting.length === 1 ? 'y' : 'ies'} left from an Update all`);
                try { await finishUpdateBatch(waiting); } catch (e) { logUpdate(`[update] finishing them stopped: ${e.message}`); }
            }
        }
        for (const entry of oldCopyStore.list()) { // an entry whose rules are still partial is retried too: the old copy never waits for the rules
            if (vortexUpdate.isDeferred(entry.pluginId)) continue; // an Update all's mod still waiting (a batch is open, or Vortex did not answer): its own pass 2 and 3 finish it (rules too), never this
            let r;
            try { r = await vortexUpdate.finishOldCopy(entry); } catch { r = { complete: false, left: ['bridge'] }; }
            const row = findRow(entry.pluginId);
            if (r.refused) { // the guard found the new version missing: the note is already dropped; the row is the ordinary update again, nothing is installed by itself
                if (row) clearOldCopyLeft(row);
                continue;
            }
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
    vortexUpdate.clearDeferred();
    // The saved old copies are NOT cleared (2026-10-22): an entry is dropped only when Vortex's mod list no longer holds that old mod. Clearing it here made ModPacer forget old copies
    // that were still in Vortex (two enabled copies of one add-on). The leftover check finishes them once the newer copy is seen installed.
    pendingDeploy.clear();
    downloadState.clearPendingCleanup();
    state = { ...state, rows: [] };
}
// THE LEFTOVER CHECK (lib/leftover-check.js): older versions of an add-on still in Vortex. Uses the mod list already held (no new Bridge call to look). ModPacer's own recorded leftovers are
// removed by themselves; any other older copy is only listed (state.leftoverOlder) for the Remove old versions button. Never while an Update all is open or an update is running.
let leftoverScan = { own: [], other: [], unknown: [] };
let leftoverRunning = null;
function logFound(s) {
    for (const i of s.own) logArea('leftover', `found: ${leftoverCheck.label(i)}: ModPacer's own leftover (noted by ${i.rec.source})`);
    for (const i of s.other) logArea('leftover', `found: ${leftoverCheck.label(i)}: no note from ModPacer, not removed by itself`);
    for (const i of s.unknown) logArea('leftover', `found: ${leftoverCheck.label(i)}: its version cannot be compared, left alone`);
}
function runLeftoverCheck(source) {
    if (leftoverRunning) return leftoverRunning;
    leftoverRunning = (async () => {
        if (retryingOldCopies) await retryingOldCopies.catch(() => {}); // the saved old copies first, so the two never remove the same mod at once
        if (batchOpen() || updateRunning()) return;
        const cfg = appConfig.loadConfig();
        if (modManager.isMo2(cfg)) { leftoverScan = { own: [], other: [], unknown: [] }; return; }
        const held = modHold.get();
        if (!held) return;
        let s = leftoverCheck.scan({ rows: state.rows, held, cfg });
        if (s.own.length + s.other.length + s.unknown.length > 0) { logArea('leftover', `check (${source}): ${s.own.length} of ModPacer's own, ${s.other.length} other, ${s.unknown.length} unknown`); logFound(s); }
        if (s.own.length > 0) {
            const r = await leftoverCheck.removeLeftovers(s.own);
            for (const item of r.removed) { const row = findRow(item.pluginId); if (row && row.oldCopyLeft) finishRowAfterOldCopy(row); }
            s = leftoverCheck.scan({ rows: state.rows, held: modHold.get(), cfg });
            logArea('leftover', `left after the removal: ${s.own.length} of ModPacer's own, ${s.other.length} other`);
        }
        leftoverScan = s;
    })().catch((e) => logArea('leftover', `stopped by an error: ${e.message}`)).finally(() => { leftoverRunning = null; });
    return leftoverRunning;
}
// The Remove old versions button (after a yes): only copies the check itself lists, by their Vortex mod id; anything else in the request is ignored.
async function removeOlderVersions(ids) {
    if (batchOpen() || updateRunning()) return { ok: false, reason: 'busy' };
    if (leftoverRunning) await leftoverRunning;
    const cfg = appConfig.loadConfig();
    const held = modHold.get();
    if (!held) return { ok: false, reason: 'no_list' };
    const want = new Set((ids || []).filter((x) => typeof x === 'string'));
    const items = leftoverCheck.scan({ rows: state.rows, held, cfg }).other.filter((i) => want.has(i.oldModId));
    if (items.length === 0) return { ok: true, removed: 0, left: 0 };
    logArea('leftover', `the player asked to remove ${items.length} older cop${items.length === 1 ? 'y' : 'ies'}`);
    const r = await leftoverCheck.removeLeftovers(items, { patient: true });
    leftoverScan = leftoverCheck.scan({ rows: state.rows, held: modHold.get(), cfg });
    logArea('leftover', `removed ${r.removed.length}, left ${r.left.length}${r.reason ? ` (Vortex: ${r.reason})` : ''}`);
    return { ok: true, removed: r.removed.length, left: r.left.length, reason: r.reason || null };
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

// ---- Excluded mods (2026-10-20): a Hub listing that is NOT installed can be left completely alone. Saved by the Hub id in the settings file.
const excludeKey = (x) => String((x && (x.hubId || x.id)) || '').toLowerCase();
function excludedSet(cfg) { return new Set((Array.isArray(cfg.excludedMods) ? cfg.excludedMods : []).map((e) => String(e && e.id || '').toLowerCase()).filter(Boolean)); }
function excludeMod(id) {
    const row = findRow(id);
    if (!row || !row.notInstalled) return { ok: false, status: 400, error: 'Only a mod that is not installed can be excluded.' };
    const key = row.hubId || row.id;
    const cfg = appConfig.loadConfig();
    const list = (Array.isArray(cfg.excludedMods) ? cfg.excludedMods : []).filter((e) => String(e && e.id || '').toLowerCase() !== key.toLowerCase());
    list.push({ id: key, title: row.title, author: row.author || null, excludedAt: new Date().toISOString() });
    appConfig.saveConfig({ excludedMods: list });
    logArea('settings', `excluded: ${row.title}`);
    return { ok: true };
}
function includeMod(id) {
    const cfg = appConfig.loadConfig();
    const list = Array.isArray(cfg.excludedMods) ? cfg.excludedMods : [];
    const next = list.filter((e) => String(e && e.id || '').toLowerCase() !== String(id).toLowerCase());
    if (next.length === list.length) return { ok: false, status: 404, error: 'That mod is not on the excluded list.' };
    appConfig.saveConfig({ excludedMods: next });
    logArea('settings', `included again: ${(list.find((e) => String(e && e.id || '').toLowerCase() === String(id).toLowerCase()) || {}).title || id}`);
    return { ok: true };
}
// An excluded mod that turns out to be installed (put in by hand, or found on disk) is shown normally and leaves the list: an installed mod is never hidden.
// "Installed" is the check's own answer: one of the installed rows (found by the same evidence as the rest of the page).
function dropExcludedThatAreInstalled(installedRows) {
    const cfg = appConfig.loadConfig();
    const list = Array.isArray(cfg.excludedMods) ? cfg.excludedMods : [];
    if (list.length === 0) return;
    const have = new Set();
    for (const r of installedRows) { if (r.id) have.add(String(r.id).toLowerCase()); if (r.hubId) have.add(String(r.hubId).toLowerCase()); }
    const gone = list.filter((e) => have.has(String(e && e.id || '').toLowerCase()));
    if (gone.length === 0) return;
    appConfig.saveConfig({ excludedMods: list.filter((e) => !gone.includes(e)) });
    logArea('settings', `no longer excluded because it is installed: ${gone.map((e) => e.title || e.id).join(', ')}`);
}

function getState() {
    clearPassedGithubLimits();
    const cfg = appConfig.loadConfig();
    const excluded = excludedSet(cfg);
    const manager = modManager.getModManager(cfg);
    const mo2Chosen = manager === 'mo2';
    return {
        ...state,
        rows: (state.rows || []).filter((r) => !(r.notInstalled && r.nsfw && !cfg.showAdultNotInstalled) && !(r.notInstalled && excluded.has(excludeKey(r)))),
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
        showModPictures: cfg.showModPictures !== false, // "Show mod pictures" (on unless the person turned it off)
        modListSort: ['az', 'za'].includes(cfg.modListSort) ? cfg.modListSort : 'list', // how the page orders each section
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
        // Older versions of an add-on still in Vortex that ModPacer has no note about (never removed by itself): [{ id, title, version }]. The page lists them with a Remove old versions button.
        leftoverOlder: leftoverScan.other.map((i) => ({ id: i.oldModId, title: i.title, version: i.oldVersion })),
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
    if (reason === 'vortex_other_game') return OTHER_GAME_TEXT;
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
// After an Update all: every mod that has an update and was not part of it says why, in one log line each (never a mod that just silently was not there).
function logLeftOutOfUpdateAll() {
    const lines = [];
    for (const row of state.rows) {
        if (row.notInstalled || row.isProgram) continue;
        if (!['update_available', 'queued', 'downloading', 'downloaded', 'needs_you'].includes(row.status)) continue;
        if (row.status === 'downloaded' && row.updatePreview && !row.oldCopyLeft) continue; // it was in the batch
        let why;
        if (row.status === 'downloaded') why = row.oldCopyLeft ? 'the old version is still in Vortex' : (row.updateUnavailableReason || 'Vortex has no matching mod to update');
        else if (row.status === 'queued' || row.status === 'downloading') why = 'still downloading';
        else if (row.status === 'needs_you') why = row.error || 'waiting for you';
        else why = row.error || 'not downloaded yet';
        lines.push(`${row.id} ${row.latestVersion || ''}: not part of this Update all (${why})`.replace('  ', ' '));
    }
    for (const l of lines) logArea('update', l);
    return lines.length;
}
// A downloaded mod that cannot be offered Update (and so is left out of Update all) says why in the log, once per reason.
function noteNoUpdateButton(row, why) {
    logAreaOnce(`no-update-button|${row.id}|${row.latestVersion}|${why}`, 'update', `${row.id} ${row.latestVersion || ''}: downloaded, but not offered Update and left out of Update all (${why})`.replace('  ', ' '));
}
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
        if (!result.preview) noteNoUpdateButton(row, result.reason || 'not found in Vortex');
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

// ---- A downloaded file must be complete before anything uses it (2026-10-28) ----
// Words (draft; the design side runs them through Gemini): the first shows on the row while ModPacer fetches the file again, the second when the new copy is cut off too.
const CUT_OFF_AGAIN_TEXT = 'The download stopped, so ModPacer is starting it again.';
const CUT_OFF_TWICE_TEXT = 'The download stopped twice. Click Check now to try again later.';
const verifiedFiles = new Set(); // "path|size|mtime" of files that already passed, so a repeated check does not open them again

// A file found in the downloads folder (or remembered) that is going to be reused: complete, or removed (and null returned, so a fresh copy is fetched).
async function usableOrRemoved(row, cfg, hit, expectedSize) {
    if (!hit) return null;
    let key = null;
    try { const st = fs.statSync(hit.archivePath); key = `${hit.archivePath}|${st.size}|${st.mtimeMs}`; } catch { /* the check below says it is missing */ }
    if (key && verifiedFiles.has(key)) return hit;
    const p = await archiveCheck.problem(hit.archivePath, { expectedSize });
    if (!p) { if (key) verifiedFiles.add(key); return hit; }
    downloadLog.incomplete(row, archiveCheck.describe(p), archiveCheck.debugText(p));
    await removeBadDownload(row, cfg, hit.archivePath);
    downloadState.remove(row.id);
    row.error = CUT_OFF_AGAIN_TEXT;
    row.errorWarn = true;
    return null;
}

// Takes a bad download away, the way Vortex Collection Tools removes an archive: under Vortex the file is deleted and its record removed THROUGH THE BRIDGE
// (record-only; nothing here edits Vortex's saved data); under Mod Organizer 2 only a file ModPacer itself downloaded (its own record names it) is deleted.
// Never throws. A file that cannot be taken away is left; the new copy is saved beside it (or over it, for a Nexus file name).
async function removeBadDownload(row, cfg, filePath) {
    try {
        if (modManager.isMo2(cfg)) {
            const mine = downloadState.get(row.id);
            if (mine && mine.filePath && path.resolve(mine.filePath) === path.resolve(filePath) && vctRemoval.isPlainFile(filePath)) {
                const [rm] = vctRemoval.deleteEntries([filePath]);
                logUpdate(`${row.id}: removed the incomplete download (ModPacer's own file): ${rm.ok ? 'gone' : 'could not delete it'}`);
            } else logUpdate(`${row.id}: the incomplete download was not made by ModPacer, so it is left in place`);
            return;
        }
        const data = await helperClient.getAllDownloads();
        if (!data || !data.files) { logUpdate(`${row.id}: the incomplete download is left for now (Vortex's download list could not be read)`); return; }
        if (fs.existsSync(filePath) && !vctRemoval.isPlainFile(filePath)) { logUpdate(`${row.id}: the incomplete download is not a plain file, so it is left in place`); return; }
        const name = path.basename(filePath);
        const hit = Object.entries(data.files).find(([, f]) => f.localPath === name);
        const [rm] = vctRemoval.deleteEntries([filePath]);
        let recordGone = true;
        if (hit) {
            await helperClient.removeDownloadRecordOnly([hit[0]]);
            const after = await helperClient.getAllDownloads();
            recordGone = !!(after && after.files && !after.files[hit[0]]);
        }
        logUpdate(`${row.id}: removed the incomplete download through the Vortex Bridge: file ${rm.ok ? 'gone' : 'could not be deleted'}, record ${hit ? (recordGone ? 'gone' : 'STILL LISTED') : 'none'}`);
    } catch (e) {
        logUpdate(`${row.id}: could not remove the incomplete download: ${e.message}`);
    }
}

// Fetches a file and makes sure it arrived whole. `fetchOnce` downloads one copy and returns { path, fileName, bytes }. A copy that is not complete is deleted
// and fetched ONE more time; a second bad copy stops with a plain line.
async function downloadChecked(row, fetchOnce, { expectedSize = null } = {}) {
    for (let attempt = 1; ; attempt += 1) {
        const got = await fetchOnce(attempt);
        const p = await archiveCheck.problem(got.path, { expectedSize });
        if (!p || p.kind === 'missing') { // (no file to judge: whatever uses it says so in its own words)
            if (row.error === CUT_OFF_AGAIN_TEXT) { row.error = null; row.errorWarn = false; } // the new copy is whole: the warning goes
            return got;
        }
        downloadLog.incomplete(row, archiveCheck.describe(p), archiveCheck.debugText(p), attempt < 2);
        try { fs.rmSync(got.path, { force: true }); } catch { /* a file that cannot be removed is reported by the next check */ }
        if (attempt >= 2) {
            const err = new Error(CUT_OFF_TWICE_TEXT);
            err.plainReason = 'the file was cut off both times';
            err.warn = true;
            throw err;
        }
        row.error = CUT_OFF_AGAIN_TEXT;
        row.errorWarn = true;
        row.status = 'queued';
        row.downloadProgress = null;
    }
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
    const available = fs.existsSync(candidatePath) && await helperClient.checkHelperAvailable(helperClient.skyrimGameId());
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
async function downloadPlugin(id, { knownPremium, userAsked = false, how = userAsked ? 'button' : 'automatic' } = {}) {
    const row = findRow(id);
    if (!row || row.status !== 'update_available' && row.status !== 'needs_you') return row;
    if (row.isProgram) { logUpdate(`${row.id}: a program, not a mod; nothing is downloaded`); return row; }
    if (row.notInstalled && !userAsked) return row; // a mod that is not installed is never fetched without a person's click
    const cfg = appConfig.loadConfig();
    // No per-row error here (queue: fill-staging-folder-keep-changelogs, 2026-09-30) -- the
    // Download/Download all buttons are disabled client-side whenever this is the case, so this is
    // only ever reached by something bypassing that (a stale page, a direct API call); silently
    // no-op rather than pile up a row error the single top-of-page banner already covers.
    if (!cfg.downloadFolder) return row;
    row.error = null;
    const mo2Mode = modManager.isMo2(cfg);
    let startedAt = null;
    if (userAsked && modManager.isMo2(cfg) && row.status === 'update_available' && (row.urlKind === 'github' || (row.urlKind === 'nexus' && cfg.nexusApiKey))) countRowInstall(row);

    // Local files first: if this version's file is already here (remembered, and still on disk at its
    // recorded size), the row goes straight to "downloaded" -- never "Downloading...", no progress bar,
    // and no GitHub/Nexus request at all.
    const alreadyHere = await usableOrRemoved(row, cfg, rememberedDownload(row), null);
    if (alreadyHere) {
        downloadLog.skipped(row, 'already downloaded and current');
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
    if (row.urlKind === 'github' && knownStale) { downloadLog.skipped(row, 'the Hub link points at an older release'); return markLinkOutOfDate(row, knownStale.oldVersion, knownStale.releasesUrl); }
    row.status = 'queued';
    row.downloadProgress = null;

    try {
        if (row.urlKind === 'github') {
            const { release, linkVersion } = await github.resolveReleaseForVersion(row.externalUrl, row.latestVersion);
            if (!release) { downloadLog.skipped(row, 'the Hub link points at an older release'); return rememberStaleLink(row, linkVersion); }
            // Whatever release came back, it must not be OLDER than the version the row promised (a bare link can resolve to
            // an older latest than the Hub lists). Newer is fine and is recorded as what it is.
            const releaseVersion = github.versionOfTag(release.tag_name) || row.latestVersion;
            if (compareVersions(releaseVersion, row.latestVersion) === 'newer') { downloadLog.skipped(row, 'the Hub link points at an older release'); return rememberStaleLink(row, releaseVersion); }
            row.linkOutOfDate = null;
            const { chosen, otherCandidates, ambiguous } = github.pickModArchiveAsset(release, { id: row.id, title: row.title, version: row.latestVersion });
            if (ambiguous) { // several archives and none clearly the mod: never pick one
                logUpdate(`${row.id}: ${ambiguous} archives in the release, none clearly the mod; left to the person`);
                downloadLog.skipped(row, 'several archives in the release, none clearly the mod');
                row.status = 'needs_you';
                row.releaseAmbiguous = true;
                row.downloadProgress = null;
                return row;
            }
            if (!chosen) throw new Error('No downloadable archive (.7z, .zip, or .rar) attached to this release.');
            if (otherCandidates.length > 0) {
                row.otherAssetsNotDownloaded = otherCandidates.map((a) => a.name);
            }
            const candidateFileName = chooseDownloadFileName(chosen.name, {
                pluginTitle: row.title, newVersion: row.latestVersion, pluginId: row.id,
                onUnsafe: (name, why, used) => logUpdate(`${row.id}: the release file name was not a safe file name (${why}); saved as ${used}`),
            });
            const reused = await usableOrRemoved(row, cfg, await findExistingDownload(row, cfg, { expectedFileName: candidateFileName, expectedSize: chosen.size }), chosen.size);
            if (reused) {
                downloadLog.skipped(row, 'already downloaded and current');
                row.downloadedArchivePath = reused.archivePath;
                row.downloadedFileName = reused.fileName;
                row.downloadedReleaseVersion = releaseVersion;
                row.status = 'downloaded';
                downloadState.record(row.id, { fileName: reused.fileName, filePath: reused.archivePath, size: reused.size, version: row.latestVersion, releaseVersion });
            } else {
                startedAt = downloadLog.started(row, how, chosen.browser_download_url);
                const got = await downloadChecked(row, async () => {
                    const name = uniqueFileName(cfg.downloadFolder, candidateFileName);
                    const dest = path.join(cfg.downloadFolder, name);
                    const r = await github.downloadAsset(chosen, dest, {
                        onProgress: (p) => { row.status = 'downloading'; row.downloadProgress = p; },
                    });
                    return { path: dest, fileName: name, bytes: r.bytes };
                }, { expectedSize: chosen.size > 0 ? chosen.size : null });
                const fileName = got.fileName;
                const destPath = got.path;
                const downloadResult = { bytes: got.bytes };
                row.downloadedArchivePath = destPath;
                row.downloadedFileName = fileName;
                row.downloadedReleaseVersion = releaseVersion;
                row.status = 'downloaded';
                downloadState.record(row.id, { fileName, filePath: destPath, size: downloadResult.bytes, version: row.latestVersion, releaseVersion });
                downloadLog.saved(row, { fileName, bytes: downloadResult.bytes, folder: cfg.downloadFolder, startedAt, mo2: mo2Mode });
            }
        } else if (row.urlKind === 'nexus') {
            if (!cfg.nexusApiKey) {
                row.status = 'needs_you';
                row.error = 'Add a Nexus API key in Settings to download this automatically, or use the link.';
                downloadLog.skipped(row, 'waiting for a Nexus key');
                return row;
            }
            const isPremium = knownPremium !== undefined ? knownPremium : (await nexus.checkApiKey(cfg.nexusApiKey)).isPremium;
            if (!isPremium) {
                row.status = 'needs_you';
                row.error = 'Nexus only lets Premium members download automatically -- use the link instead.';
                downloadLog.skipped(row, 'the Nexus key is not Premium');
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
            const reused = await usableOrRemoved(row, cfg, await findExistingDownload(row, cfg, { expectedFileName: expectedNexusName, expectedSize: null }), null);
            if (reused) {
                downloadLog.skipped(row, 'already downloaded and current');
                row.downloadedArchivePath = reused.archivePath;
                row.downloadedFileName = reused.fileName;
                row.status = 'downloaded';
                downloadState.record(row.id, { fileName: reused.fileName, filePath: reused.archivePath, size: reused.size, version: row.latestVersion, releaseVersion: row.latestVersion });
            } else {
                startedAt = downloadLog.started(row, how);
                const result = await downloadChecked(row, async () => {
                    const r = await nexus.downloadMod({
                        apiKey: cfg.nexusApiKey, gameDomain: parsed.gameDomain, modId: parsed.modId,
                        destDir: cfg.downloadFolder,
                        onProgress: (p) => { row.status = 'downloading'; row.downloadProgress = p; },
                    });
                    return { path: r.archivePath, fileName: r.fileName, bytes: r.bytes, archivePath: r.archivePath };
                });
                row.downloadedArchivePath = result.archivePath;
                row.downloadedFileName = result.fileName;
                row.status = 'downloaded';
                downloadState.record(row.id, { fileName: result.fileName, filePath: result.archivePath, size: result.bytes, version: row.latestVersion, releaseVersion: row.latestVersion });
                downloadLog.saved(row, { fileName: result.fileName, bytes: result.bytes, folder: cfg.downloadFolder, startedAt, mo2: mo2Mode });
            }
        } else {
            row.status = 'needs_you';
            row.error = 'No automatic download available for this link -- use the link instead.';
            downloadLog.skipped(row, 'no automatic download for this link');
        }
    } catch (e) {
        row.status = 'update_available';
        downloadLog.failed(row, e);
        if (e && e.githubApi) {
            // GitHub's own words (a raw JSON block) never reach the row: one plain amber sentence; the full text goes to the log. A limit that has passed clears it by itself (getState).
            try { require('./update-log').logUpdate(`[${row.id}] ${e.message}`); } catch { /* the log is best effort */ }
            row.error = github.friendlyError(e);
            row.errorWarn = true;
            row.rateLimitedUntil = e.rateLimited ? (e.resetAt || Date.now() + 15 * 60 * 1000) : null;
        } else { row.error = e.message; if (e && e.warn) row.errorWarn = true; }
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
        if (!row.updatePreview) noteNoUpdateButton(row, 'Vortex has no matching mod to update, or is not answering');
    } catch (e) {
        row.updatePreview = null;
        noteNoUpdateButton(row, `reading Vortex failed: ${String(e && e.message || e).split('\n')[0].slice(0, 120)}`);
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
// Vortex's active game is not Skyrim (the Bridge says which game is open): the one plain line, shown in the Vortex banner and on an update row.
const OTHER_GAME_TEXT = 'Switch Vortex to Skyrim and click Check now.';
const BRIDGE_OUTDATED_TEXT = "Your Vortex Bridge is out of date. Drop the new zip file onto Vortex's Extensions page.";
function updateFailureText(reason) {
    if (reason === 'download_incomplete') return CUT_OFF_TWICE_TEXT;
    if (reason === 'helper_outdated') return BRIDGE_OUTDATED_TEXT;
    if (reason === 'update_failed_restored') return "The update didn't go through, and the old version was restored. Nothing was lost.";
    if (reason === 'update_failed_restore_failed') return "The update didn't go through, and the old version couldn't be put back automatically. Everything needed to restore it is saved, so nothing is lost.";
    if (reason === 'vortex_unfinished') return 'Let Vortex finish installing this mod, then click Check now.';
    if (reason === 'remove_old_failed') return "Vortex wouldn't replace the old version, so nothing was changed.";
    return `Couldn't update in Vortex (${reason}).`;
}

const CONNECTION_LOSS_REASONS = ['vortex_other_game', 'vortex_not_running', 'vortex_running_helper_unreachable', 'vortex_starting', 'helper_unavailable', 'helper_not_installed'];

// What an update's result means for the row. "Updated" only when EVERY part worked; if the mod is installed but something
// didn't carry over, the row is flagged (carryOver) instead of showing a clean tick. A finished swap is remembered as
// waiting to be deployed -- updates never deploy by themselves.
// When ModPacer installs a mod it knows all four names right then: the Hub entry, the installed manifest, the archive and the Vortex mod. One record, written now
// (lib/match-records.js). A mod new to the player has no manifest id to read yet (the row carries the Hub's id), so nothing is invented: its first check writes the record.
function recordInstall(row, result) {
    try {
        if (!result || !result.ok || !row.hubId || row.installedNew || row.notInstalled) return;
        const dl = downloadState.get(row.id) || {};
        const w = matchRecords.write({
            how: 'installed-by-modpacer', manager: 'vortex', installedVersion: row.latestVersion,
            hub: { id: row.hubId, title: row.hubTitle || row.title, externalUrl: row.listingUrl },
            manifest: { id: row.id, title: row.manifestTitle || row.title, author: row.author, version: row.latestVersion },
            archive: { fileNames: [row.downloadedFileName || dl.fileName], size: dl.size },
            vortex: { gameId: result.gameId, modId: result.newModId, name: row.title, version: row.latestVersion },
        });
        if (w) logArea('versions', `${row.id}: match record written when it was installed (Hub entry ${row.hubId}, Vortex mod ${result.newModId || 'unknown'}, version ${row.latestVersion || 'unknown'})`);
    } catch (e) { logArea('versions', `${row.id}: match record not written: ${e.message}`); }
}

function applyUpdateResult(row, result) {
    // The guard found the new version missing from Vortex: no claim is made. The old copy and its archive stay, no note is kept, and the row is the normal update row.
    if (result.ok && result.oldCopy && result.oldCopy.refused) { clearOldCopyLeft(row); row.carryOver = null; row.error = null; row.errorWarn = false; return; }
    // The new version is in, but the old copy is not fully gone (its Vortex record, its archive, its staging folder): NOT Updated. The row keeps its
    // place with one short sentence and a Try again; the removal is tried again later from the saved entry (lib/old-copy-store.js).
    const oldCopyUnfinished = !!(result.ok && result.oldCopy && !result.oldCopy.complete && !result.oldCopy.waitingOnRules);
    if (oldCopyUnfinished) {
        row.notInstalled = false;
        row.vortexUpdateResult = result;
        row.fomodMismatch = null;
        row.carryOver = null;
        markOldCopyLeft(row, result.oldCopy.left);
        recordInstall(row, result);
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
        recordInstall(row, result);
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
        row.errorDetail = result.detail ? `Why: ${result.detail}.` : null; // the hover on the red or amber line (words: design side)
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

// The Nexus identity of a mod that is about to be installed from a Nexus listing, so Vortex shows it like one it downloaded itself (no "missing
// identification information"): the mod id from the page address (always), and -- with the Nexus key and a working connection -- the file id of the exact
// archive (found by its file name) and the mod's details. Best effort: any trouble leaves the install as it was, and nothing secret is ever logged.
async function nexusIdentityFor(row) {
    if (row.urlKind !== 'nexus') return null;
    const parsed = nexus.parseNexusUrl(row.externalUrl);
    if (!parsed) return null;
    const id = { gameDomain: parsed.gameDomain, modId: parsed.modId };
    const key = appConfig.loadConfig().nexusApiKey;
    if (!key) { logUpdate(`[${row.id}] Nexus details for Vortex: the mod id only (no Nexus key set)`); return id; }
    try { const f = await nexus.findFileByName(key, parsed.gameDomain, parsed.modId, path.basename(row.downloadedArchivePath || '')); if (f) { id.fileId = f.file_id; id.file = f; } } catch (e) { logUpdate(`[${row.id}] Nexus file details not read (${e.statusCode ? 'HTTP ' + e.statusCode : 'no answer'})`); }
    try { id.info = await nexus.getModInfo(key, parsed.gameDomain, parsed.modId); } catch (e) { logUpdate(`[${row.id}] Nexus mod details not read (${e.statusCode ? 'HTTP ' + e.statusCode : 'no answer'})`); }
    logUpdate(`[${row.id}] Nexus details for Vortex: mod ${id.modId}, file ${id.fileId || 'not found'}, details ${id.info ? 'read' : 'not read'}`);
    return id;
}

async function updatePlugin(id, { defer = false } = {}) {
    if (defer) batchTouchedAt = Date.now();
    const row = findRow(id);
    if (!row || !row.downloadedArchivePath) return { ok: false, reason: 'not_downloaded' };
    // Picking up after the helper stopped answering can ask again for a mod that finished after all: never install it twice.
    if (row.status === 'updated' || row.status === 'deployed') return { row, result: { ok: false, reason: 'already_updated' } };
    // An Update all already installed this one and is waiting to remove its old copy: never installed twice. In a batch that is just "pass 1 done"; on its own it finishes the mod.
    if (vortexUpdate.isDeferred(id)) {
        if (defer) return { row, result: { ok: true, deferred: true } };
        return finishDeferredRow(id);
    }
    if (refuseWrongRelease(row)) return { row, result: { ok: false, reason: 'link_out_of_date' } };
    // The file about to be installed is complete, or it is fetched again once (a cut-off file used to fail here with 7-Zip's whole listing).
    {
        const hit = fs.existsSync(row.downloadedArchivePath) ? await usableOrRemoved(row, appConfig.loadConfig(), { archivePath: row.downloadedArchivePath }, null) : true; // a file that is gone fails in the install step's own words
        if (!hit) {
            row.downloadedArchivePath = null; row.downloadedFileName = null; row.updatePreview = null; row.status = 'update_available';
            await downloadPlugin(id, { how: 'update' });
            if (row.status !== 'downloaded' || !row.downloadedArchivePath) return { row, result: { ok: false, reason: 'download_incomplete' } };
        }
    }
    if (!row.isFomod) countRowInstall(row); // a FOMOD counts when its options screen is finished (finishWizard); a retry of either never counts twice
    const result = await withProgress(id, async () => vortexUpdate.updateInVortex(id, row.downloadedArchivePath, row.latestVersion, { displayName: row.title, urlKind: row.urlKind, ifDisabled: takeDisabledChoice(id), nexusIdentity: await nexusIdentityFor(row), defer }));
    if (result.deferred) {
        markOldCopyLeft(row, ['mod']); // installed; the old copy waits for "Removing old mods" (the row keeps saying Updating... until then)
        if (!defer) return finishDeferredRow(id); // a single update whose new version was already in Vortex: only its old copy and rules were left
    } else applyUpdateResult(row, result);
    return { row, result };
}

// An Update all is "open" from its first install until the page says it is done (closeBatch). While it is open, a check never finishes the mods it installed (the page's own
// "Removing old mods" does); a page that vanished mid-batch stops counting after ten minutes.
let batchTouchedAt = 0;
const BATCH_OPEN_MS = 10 * 60 * 1000;
function batchOpen() { return batchTouchedAt > 0 && Date.now() - batchTouchedAt < BATCH_OPEN_MS; }
const WAITING_ROW_TEXT = "Vortex didn't answer, so we haven't updated this yet.";
// The page is done with its Update all (whatever happened). A row still "waiting for Vortex" ends here with one sentence instead of waiting for ever.
function closeBatch() {
    batchTouchedAt = 0;
    for (const [id, p] of Object.entries(updateProgress.list())) {
        if (!p.waiting) continue;
        updateProgress.end(id);
        const row = findRow(id);
        if (row && !row.error && row.status !== 'updated' && row.status !== 'deployed') { row.error = WAITING_ROW_TEXT; row.errorWarn = true; }
    }
}

// PASS 2 AND 3 of an Update all (the page calls this once every mod's pass 1 is done): "Removing old mods", then the carry-over, for these ids. Rows end as Updated (or with their
// own sentence); a mod Vortex could not be asked about stays installed with its old copy listed (its row says so, with Try again) and is reported in `lost`.
// `patient`: wait for a busy Vortex (up to about five minutes) instead of giving up at the first silence.
// Returns { results: { id: result }, lost: [ids], reason? }.
async function finishUpdateBatch(ids, { patient = false } = {}) {
    const out = await vortexUpdate.finishDeferred(ids || [], { patient });
    for (const id of ids || []) {
        const row = findRow(id);
        if (!row) continue;
        if (out.results[id]) applyUpdateResult(row, out.results[id]);
        else if (out.lost.includes(id)) markOldCopyLeft(row, ['bridge']);
    }
    return out;
}
async function finishDeferredRow(id) {
    const row = findRow(id);
    const out = await finishUpdateBatch([id]);
    const result = out.results[id] || { ok: false, reason: out.reason || 'vortex_running_helper_unreachable' };
    return { row, result };
}

// The picker screen's own "Finish" action (queue: updater-v1-polish, 2026-09-30) -- `picks` is what the player chose:
// { [stepIdx]: { [groupIdx]: number[] } }.
// Clears row.fomodMismatch either way: a genuine success moves on to "Updated", and a real failure still means there's
// no wizard left to show (the error explains why).
async function finishWizard(id, picks, { defer = false, again = false } = {}) {
    if (defer) batchTouchedAt = Date.now();
    const row = findRow(id);
    if (!row || !row.downloadedArchivePath || !row.fomodMismatch) return { ok: false, reason: 'no_wizard_pending' };
    if (refuseWrongRelease(row)) return { row, result: { ok: false, reason: 'link_out_of_date' } };
    countRowInstall(row);
    const result = await withProgress(id, async () => vortexUpdate.finishFomodWizard(id, row.downloadedArchivePath, row.latestVersion, picks, { displayName: row.title, urlKind: row.urlKind, ifDisabled: takeDisabledChoice(id), nexusIdentity: await nexusIdentityFor(row), defer, again }));
    // A silent Vortex installed nothing: the wizard stays pending, so the page can finish it again with the options already confirmed (the screen is never shown twice).
    if (!(result.ok === false && CONNECTION_LOSS_REASONS.includes(result.reason))) row.fomodMismatch = null;
    if (result.deferred) markOldCopyLeft(row, ['mod']);
    else if (result.ok) applyUpdateResult(row, result);
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
    if (row && vortexUpdate.isDeferred(id)) { // an Update all stopped before this mod's old copy was removed: finish it (the removal, then the rules)
        if (OLD_COPY_ALL_TEXTS.has(row.error)) { row.error = null; row.errorWarn = false; }
        return finishDeferredRow(id);
    }
    if (row && row.oldCopyLeft && !row.carryOver) {
        // The new version is in; only the old copy is left. Remove it again through the Bridge, then look.
        const entry = oldCopyStore.get(id);
        if (OLD_COPY_ALL_TEXTS.has(row.error)) { row.error = null; row.errorWarn = false; } // the old sentence goes at once; a new one only if this try ends badly
        if (!entry) { clearOldCopyLeft(row); return { row, result: { ok: true, oldCopy: { complete: true, left: [] } } }; }
        const r = await vortexUpdate.finishOldCopy(entry);
        if (r.refused) { // the new version is not in Vortex any more: the note is dropped, nothing removed or installed; the row is the ordinary update again
            clearOldCopyLeft(row);
            return { row, result: { ok: false, reason: r.refused, oldCopy: { complete: false, left: ['mod'], refused: r.refused } } };
        }
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

// "It's <version>": a mod the player installed by hand, which Vortex holds with no version. Tells Vortex the version the row shows as the latest
// (the Bridge's set-attributes, a small repeatable attribute write; nothing is downloaded or removed), then the row compares normally.
// Only for a LIVE Vortex entry with no version (never one remembered from before Vortex stopped answering).
async function setKnownVersion(id) {
    const row = findRow(id);
    if (!row || !row.installedVersionUnknown || row.vortexInfoFromCache || !row.vortexModId || !row.latestVersion) return { row: null, result: { ok: false, reason: 'nothing_to_set' } };
    const connection = await vortexUpdate.getWritableState();
    if (connection !== 'connected') return { row, result: { ok: false, reason: connection } };
    const version = row.latestVersion;
    // Two attributes in the one call: the version, and a note of the same value that says the player vouched for it (so "Update anyway" can take it back).
    if (!(await helperClient.setModAttributes(row.vortexModId, { version, [vortexUpdate.SET_BY_PLAYER_ATTR]: version }))) {
        logArea('versions', `${id}: Vortex did not take the version ${version} for ${row.vortexModId}`);
        return { row, result: { ok: false, reason: 'helper_unavailable' } };
    }
    logArea('versions', `${id}: told Vortex that ${row.vortexModId} is version ${version} (the player pressed "It's ${version}")`);
    vortexInfoCache.record(id, { vortexModId: row.vortexModId, version, source: row.urlKind === 'nexus' ? 'nexus' : 'offsite', nexusModId: null });
    row.installedVersion = version;
    row.installedVersionUnknown = false;
    row.versionSetByPlayer = true;
    row.versionCompare = compareVersions(version, version);
    row.status = 'up_to_date';
    return { row, result: { ok: true } };
}

// "Update" on a mod whose version is not known (or "Update anyway" on one the player vouched for): the player wants the latest installed
// over what is there, so the row becomes a normal update (the page then downloads and installs it the usual way, old copy removal included).
// A version the "It's <version>" button wrote is taken back first (one set-attributes call clearing both attributes), so the mod is "unknown" again
// rather than wrongly "latest" if the update is not finished. Only for a LIVE Vortex entry.
async function updateAnyway(id) {
    const row = findRow(id);
    const unknown = row && row.installedVersionUnknown && row.status === 'unknown_version';
    const vouched = row && row.versionSetByPlayer;
    if (!row || row.vortexInfoFromCache || !row.vortexModId || !row.latestVersion || !(unknown || vouched)) return { row: null, result: { ok: false, reason: 'nothing_to_update' } };
    if (vouched) {
        const connection = await vortexUpdate.getWritableState();
        if (connection !== 'connected') return { row, result: { ok: false, reason: connection } };
        if (!(await helperClient.setModAttributes(row.vortexModId, { version: null, [vortexUpdate.SET_BY_PLAYER_ATTR]: null }))) {
            logArea('versions', `${id}: Vortex did not take back the version it was told for ${row.vortexModId}`);
            return { row, result: { ok: false, reason: 'helper_unavailable' } };
        }
        logArea('versions', `${id}: took back the version told to Vortex for ${row.vortexModId} (the player pressed "Update anyway")`);
        vortexInfoCache.record(id, { vortexModId: row.vortexModId, version: null, source: row.urlKind === 'nexus' ? 'nexus' : 'offsite', nexusModId: null });
    } else logArea('versions', `${id}: the player chose to update ${row.vortexModId}, whose version Vortex does not know`);
    row.installedVersion = null;
    row.installedVersionUnknown = true;
    row.versionSetByPlayer = false;
    row.versionCompare = 'newer';
    row.status = 'update_available';
    row.updateAnyway = true;
    return { row, result: { ok: true } };
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
                if (entry.pluginsToRetry && entry.pluginsToRetry.length > 0) {
                    const r = await modPlugins.enablePlugins(entry.pluginsToRetry);
                    if (r.turnedOn.length > 0) { const row = findRow(entry.pluginId); if (row) row.pluginsAllFailed = false; } // the warning goes away at once
                }
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
        // A later look at Vortex's plugin list: if the plugins are on after all, the warning line goes.
        if (row && row.pluginsAllFailed && entry.pluginsToRetry && entry.pluginsToRetry.length > 0) {
            try { const st = await modPlugins.readPluginStates(entry.pluginsToRetry); if (entry.pluginsToRetry.some((n) => st[n] === 'on')) row.pluginsAllFailed = false; } catch { /* the line stays */ }
        }
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

module.exports = { finishDownload, logLeftOutOfUpdateAll, repairModsFolder, excludeMod, includeMod, addNameVersions, mo2VersionInfo, buildRow, nexusIdentityFor, buildNotInstalledRows, startFresh, markNotRegisteredYet, markWhereRows, addInstalledByName, NOT_REGISTERED_YET, OLD_COPY_LEFT_TEXT, OLD_COPY_TEXTS, oldCopyText, retryOldCopies, flagOldCopyRows, whenAutoDownloadsSettled, markPreviewsPending, updateRunning, refreshDeployNeeded, setDeployNeededGraceMs, setDisabledChoice, findDisabled, answerPair, pairVortexMods, recordVisit, displayTitle, check, getState, findRow, downloadPlugin, updatePlugin, prepareWizard, finishWizard, finishUpdateBatch, closeBatch, batchOpen, runLeftoverCheck, removeOlderVersions, retryCarryOver, setKnownVersion, updateAnyway, startDeploy, deployProgress, applyUpdateResult, classifyUrl, maybeAutoDownloadNow, refreshUpdatePreviews, updateUnavailableReasonText, setVortexRetryDelays, resetVortexRetry, waitForSettled, clearStaleHelperTrouble };
