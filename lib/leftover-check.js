'use strict';
// Older versions of an add-on left behind in Vortex (queue: modpacer-finds-old-versions-left-behind-in-vortex-and-removes-them..., 2026-10-22).
//
// Real case: after a slow Update all the old copies were never removed, and ModPacer then forgot them (the start-up cleared pending-old-copies.json), so Vortex held two
// enabled copies of one add-on while every ModPacer row read up to date. This looks at the mod list ModPacer already holds (lib/mod-list-hold.js; no extra Bridge call) and finds,
// for every add-on the Hub lists that is installed in Vortex, the OTHER Vortex mods that are an older version of the SAME add-on. "The same add-on" is the add-on's own
// manifest id inside the mod's staging folder (SKSE\Plugins\SkyrimNet\external\<id>\manifest.json, the way the rest of ModPacer finds it), or an old mod id ModPacer itself
// recorded (an update snapshot in pending-updates/, the saved list, the update log's "the old copy (X) waits for Removing old mods" line); never a similar-looking name.
// "Older" is lib/version-compare.js, the comparison used everywhere.
//
// Two kinds:
//   own    -- the old mod id is RECORDED by ModPacer, and a newer copy is installed and enabled: removed by itself (the same removal as "Removing old mods").
//   other  -- no record (the player installed both, or ModPacer has no note): never removed on its own; the page lists them and one button removes them after a yes.
// Never touched: the newest copy, a copy that is not older, a different add-on, an add-on whose newest copy is switched off (the player's choice), a mod whose add-on cannot be
// established, a copy whose version cannot be compared (listed as unknown in the log only), downloads (the old-download cleanup owns those).
// Removal is only ever through the Bridge, one call for the whole batch (lib/vct-removal.js removeModsBatch), never resent after a timeout.

const fs = require('fs');
const path = require('path');
const vortexUpdate = require('./vortex-update');
const vctRemoval = require('./vct-removal');
const modHold = require('./mod-list-hold');
const oldCopyStore = require('./old-copy-store');
const appConfig = require('./app-config');
const updateLog = require('./update-log');
const { compareVersions } = require('./version-compare');

const log = (...parts) => updateLog.logArea('leftover', ...parts);
const LOG_WINDOW_MS = 7 * 24 * 3600 * 1000; // an old copy named only by a log line counts for a week
const REINSTALL_SLACK_MS = 60 * 1000;
const RE_WAITS = /^(\S+) \[([^\]]+)\] installed \((.+?)\); the old copy \((.+?)\) waits for "Removing old mods"/;
const RE_ADOPTED = /^(\S+) \[([^\]]+)\] the new version \((.+?)\) is already in Vortex: not installed again; the old copy \((.+?)\) waits/;

// Every old mod id ModPacer wrote down: Map oldModId -> { pluginId, newModId, at (ms or 0), source, snapshotPath? }. A snapshot is the strongest note (it also says what is owed).
function recordedCopies() {
    const out = new Map();
    const dir = vortexUpdate.snapshotDir();
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { files = []; }
    for (const f of files) {
        const file = path.join(dir, f);
        const s = vortexUpdate.readSnapshot(file);
        if (!s || !s.oldModId || !s.pluginId) continue;
        const at = Date.parse(s.createdAt || '') || 0;
        const had = out.get(s.oldModId);
        if (!had || at >= had.at) out.set(s.oldModId, { pluginId: s.pluginId, newModId: s.newModId || null, at, source: 'an update note', snapshotPath: file });
    }
    for (const e of oldCopyStore.list()) {
        if (!e || !e.oldModId || !e.pluginId || out.has(e.oldModId)) continue;
        out.set(e.oldModId, { pluginId: e.pluginId, newModId: e.newModId || null, at: Date.parse(e.savedAt || '') || 0, source: 'the saved list' });
    }
    const since = Date.now() - LOG_WINDOW_MS;
    for (const file of [updateLog.logFile() + '.1', updateLog.logFile()]) {
        let text = '';
        try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        for (const line of text.split('\n')) {
            const m = RE_WAITS.exec(line) || RE_ADOPTED.exec(line);
            if (!m) continue;
            const at = Date.parse(m[1]) || 0;
            if (at < since) continue;
            const oldModId = m[4];
            if (out.has(oldModId)) continue;
            out.set(oldModId, { pluginId: m[2], newModId: m[3], at, source: 'the update log' });
        }
    }
    return out;
}

// Which Vortex mods hold which Hub add-on: Map rowId -> [{ modId, mod }], from each mod's own manifest folder.
function indexByAddOn(held, rows, cfg) {
    const ids = new Map();
    for (const r of rows || []) if (r && r.id && !r.notInstalled) ids.set(String(r.id).toLowerCase(), r);
    const index = new Map();
    const push = (row, modId, mod) => { const l = index.get(row.id) || []; if (!l.some((c) => c.modId === modId)) l.push({ modId, mod }); index.set(row.id, l); };
    for (const [modId, mod] of Object.entries(held.mods || {})) {
        if (!mod || (mod.state && mod.state !== 'installed') || mod.type === 'collection') continue;
        const root = path.join(cfg.vortexStagingFolder, mod.installationPath || modId);
        const dir = vortexUpdate.resolveCaseInsensitive(root, ['SKSE', 'Plugins', 'SkyrimNet', 'external']) || vortexUpdate.resolveCaseInsensitive(root, ['Data', 'SKSE', 'Plugins', 'SkyrimNet', 'external']);
        if (!dir) continue;
        let names = [];
        try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { names = []; }
        for (const n of names) {
            const row = ids.get(n.toLowerCase());
            if (row && fs.existsSync(path.join(dir, n, 'manifest.json'))) push(row, modId, mod);
        }
    }
    return { index, ids };
}

// -> { own: [item], other: [item], unknown: [item] }. item = { pluginId, title, oldModId, oldName, oldVersion, newModId, newVersion, kind, rec }.
function scan({ rows, held, cfg }) {
    const out = { own: [], other: [], unknown: [] };
    if (!held || !held.mods || !cfg || cfg.modManager === 'mo2' || !cfg.vortexStagingFolder) return out;
    const enabled = new Set(held.enabledModKeys || []);
    const recorded = recordedCopies();
    const { index, ids } = indexByAddOn(held, rows, cfg);
    for (const [oldModId, rec] of recorded) { // an old copy ModPacer recorded whose folder carries no manifest any more is still that add-on's
        const row = ids.get(String(rec.pluginId).toLowerCase());
        const mod = held.mods[oldModId];
        if (row && mod && !(mod.state && mod.state !== 'installed')) { const l = index.get(row.id) || []; if (!l.some((c) => c.modId === oldModId)) l.push({ modId: oldModId, mod }); index.set(row.id, l); }
    }
    const seen = new Set();
    for (const [rowId, cands] of index) {
        if (cands.length < 2) continue;
        const row = ids.get(String(rowId).toLowerCase());
        const withVersion = cands.map((c) => ({ ...c, version: vortexUpdate.entryVersion(c.mod) }));
        // the newest copy: the highest version that can be compared
        let best = null;
        for (const c of withVersion) {
            if (!c.version || compareVersions(c.version, c.version) === 'unknown') continue; // a version with no number in it cannot be placed
            if (!best) { best = c; continue; }
            if (compareVersions(best.version, c.version) === 'newer') best = c;
        }
        if (!best || !enabled.has(best.modId)) continue; // nothing to compare, or the newest copy is switched off: the player's choice, nothing said
        for (const c of withVersion) {
            if (c === best || seen.has(c.modId)) continue;
            const item = { pluginId: rowId, title: row.title || rowId, oldModId: c.modId, oldName: (c.mod.attributes && (c.mod.attributes.customFileName || c.mod.attributes.name)) || c.modId, oldVersion: c.version, newModId: best.modId, newVersion: best.version, kind: 'other', rec: null };
            const rel = c.version && compareVersions(c.version, c.version) !== 'unknown' ? compareVersions(c.version, best.version) : 'unknown';
            if (rel === 'unknown') { out.unknown.push(item); continue; }
            if (rel !== 'newer') continue; // the same version twice: not "older"
            const rec = recorded.get(c.modId);
            const installedAt = Date.parse((c.mod.attributes || {}).installTime || '');
            const reinstalled = rec && rec.at && Number.isFinite(installedAt) && installedAt > rec.at + REINSTALL_SLACK_MS; // put there again by hand after the note was written
            if (rec && !reinstalled && String(rec.pluginId).toLowerCase() === String(rowId).toLowerCase()) { item.kind = 'own'; item.rec = rec; }
            seen.add(c.modId);
            (item.kind === 'own' ? out.own : out.other).push(item);
        }
    }
    return out;
}

function entryFor(item, held, cfg) {
    const saved = oldCopyStore.get(item.pluginId);
    if (saved && saved.oldModId === item.oldModId) return { ...saved, deleteArchive: !!cfg.deleteOldDownloadAfterUpdate };
    const mod = held.mods[item.oldModId] || {};
    const a = mod.attributes || {};
    return {
        pluginId: item.pluginId, oldModId: item.oldModId, oldStagingPath: path.join(cfg.vortexStagingFolder, mod.installationPath || item.oldModId),
        oldDownload: { archiveId: mod.archiveId || null, md5: a.fileMD5 || null, fileName: a.fileName || a.logicalFileName || null, fileSize: a.fileSize || null },
        newModId: item.newModId, newFileName: null, deleteArchive: !!cfg.deleteOldDownloadAfterUpdate,
    };
}

const label = (i) => `${i.title} ${i.oldVersion} (${i.oldModId}; newer ${i.newVersion} in ${i.newModId})`;

// Removes these items through the Bridge, one removal call for all of them. `patient`: wait for a busy Vortex (the button); otherwise one question (the check).
// Returns { removed: [item], left: [{ item, left: [...] }], reason? }. Never throws.
async function removeLeftovers(items, { patient = false } = {}) {
    const res = { removed: [], left: [] };
    if (items.length === 0) return res;
    try {
        const state = patient ? await vortexUpdate.waitForVortexAnswer() : await vortexUpdate.getWritableState();
        if (state !== 'connected') { res.reason = state; res.left = items.map((item) => ({ item, left: ['bridge'] })); log(`Vortex is not answering (${state}): ${items.length} older cop${items.length === 1 ? 'y' : 'ies'} stay for now`); return res; }
        const cfg = appConfig.loadConfig();
        const held = modHold.get();
        const downloads = await vortexUpdate.readDownloads();
        // THE GUARD: the list the scan used may be old. Vortex is read fresh and the newer copy must still be installed and switched on (vortexUpdate.confirmNewVersions); nothing else is removed.
        const candidates = items.map((item) => ({ item, entry: entryFor(item, held, cfg) }));
        const verdicts = await vortexUpdate.confirmNewVersions(candidates.map((c) => c.entry));
        if (!verdicts) { res.left = items.map((item) => ({ item, left: ['bridge'] })); log(`Vortex's mod list could not be read: ${items.length} older cop${items.length === 1 ? 'y' : 'ies'} stay for now`); return res; }
        const entries = []; const byId = new Map();
        for (const { item, entry: asked } of candidates) {
            const v = verdicts.get(item.oldModId);
            if (!v.ok) { vortexUpdate.dropRefusedNote(asked, v.reason); res.left.push({ item, left: ['mod'] }); log(`${label(item)}: kept, the newer copy is not confirmed in Vortex (${v.reason})`); continue; }
            const entry = v.newModId !== asked.newModId ? { ...asked, newModId: v.newModId } : asked;
            byId.set(item.oldModId, { item, entry });
            entries.push({ modId: item.oldModId, stagingPath: entry.oldStagingPath, ...(await vortexUpdate.classifyOldCopy(entry, downloads, cfg)) });
        }
        const removal = await vctRemoval.removeModsBatch(entries, { staging: cfg.vortexStagingFolder, log: (m) => log(`removing: ${m}`) });
        for (const { item, entry } of byId.values()) {
            const r = removal.results[item.oldModId] || { ok: false };
            if (r.unreadable) { res.left.push({ item, left: ['bridge'] }); log(`${label(item)}: Vortex did not answer, nothing sent for it`); continue; }
            if (!r.ok) { res.left.push({ item, left: ['mod'] }); log(`${label(item)}: still in Vortex after the removal`); continue; }
            modHold.noteRemoved(item.oldModId);
            const copy = await vortexUpdate.removeOldCopy(entry, { phase: 'all', validated: true }); // its old download and the three checks, as after "Removing old mods"
            if (!copy.complete && copy.left.length) log(`${label(item)}: the mod is gone; still there: ${copy.left.join(', ')}`);
            const saved = oldCopyStore.get(item.pluginId);
            if (copy.complete && saved && saved.oldModId === item.oldModId) oldCopyStore.remove(item.pluginId);
            else if (saved && saved.oldModId === item.oldModId) oldCopyStore.update(item.pluginId, { left: copy.left.filter((x) => x !== 'mod'), deferred: false });
            if (item.rec && item.rec.snapshotPath && fs.existsSync(item.rec.snapshotPath)) { // the rules this update still owed (reads first, sends only what is missing)
                try {
                    const c = await vortexUpdate.retryCarryOver(item.rec.snapshotPath);
                    log(`${label(item)}: rules ${c.ok ? 'carried' : `not all confirmed yet (${c.reason || 'unknown'})`}`);
                } catch (e) { log(`${label(item)}: the rules could not be carried (${e.message})`); }
            }
            res.removed.push(item);
            log(`${label(item)}: removed${copy.complete ? '' : ' (not everything)'}`);
        }
    } catch (e) {
        log(`stopped by an error: ${e.message}`);
        const done = new Set(res.removed.concat(res.left.map((l) => l.item)));
        for (const item of items) if (!done.has(item)) res.left.push({ item, left: ['bridge'] });
    }
    return res;
}

module.exports = { scan, removeLeftovers, recordedCopies, label };
