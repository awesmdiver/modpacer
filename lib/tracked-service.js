'use strict';
// ModPacer 2.0, part 1: everything the engine and the routes do with tracked mods, apart from the pure rules (lib/tracked-rows.js), the saved list
// (lib/tracked-mods.js) and the GitHub reading (lib/tracked-github.js).
//
// `mgr` is what the engine knows about the mod manager right now (never read from here, so tests pass a stand-in):
//   { manager: 'vortex' | 'mo2', live: boolean (the list is fresh, not remembered), mods: { <key>: Vortex-like mod record }, versionOf(key) -> string | null }
// For Vortex the key is the Vortex mod id; for Mod Organizer 2 it is the mod's folder name. Vortex is only ever read through the Bridge by the engine; this file
// never touches Vortex, Mod Organizer 2, a mod folder or the settings.

const tracked = require('./tracked-mods');
const tg = require('./tracked-github');
const rows = require('./tracked-rows');
const nameMatch = require('./vortex-name-match');
const ll = require('./tracked-loverslab');
const helperLink = require('./helper-link');
const { compareVersions } = require('./version-compare');
const folderSource = require('./folder-source');
const fs = require('fs');
const path = require('path');
const { logArea } = require('./update-log');

const REASONS = {
    empty: 'Paste the link to the mod’s GitHub page.',
    bad: 'That doesn’t look like a GitHub page. Paste a link such as https://github.com/owner/mod.',
    already: (name) => `You already follow this repository as “${name}”.`,
    version: 'That doesn’t look like a version number.',
    noName: 'Give the mod a name.',
    badLink: 'ModPacer can’t find that mod in your mod manager.',
    linkUsed: 'That mod in your mod manager is already used by another mod you follow.',
    // several sources for one mod (ModPacer 2.0, part 3)
    notApp: "That isn't an application.",
    noVersionYet: "ModPacer hasn't read a version for it yet.",
    haveGithub: 'This mod already has a GitHub source.',
    // a LoversLab page (ModPacer 2.0, part 4)
    llEmpty: 'Paste the link to the mod\u2019s LoversLab page.',
    llBad: 'That doesn\u2019t look like a LoversLab file page. Paste a link such as https://www.loverslab.com/files/file/12345-some-mod/.',
    llAlready: (name) => `You already follow this page as \u201c${name}\u201d.`,
    noHelper: 'The browser helper isn\u2019t connected yet. Set it up in Settings, then try again.',
    llSilent: 'Your browser didn\u2019t answer. Is it open? Try again in a moment.',
    llGone: 'LoversLab has no page at that address.',
    llNetwork: 'Your browser couldn\u2019t reach LoversLab just now. Try again in a little while.',
    haveLoversLab: 'This mod already has a LoversLab source.',
    haveFolder: 'This mod already has a folder.',
    onlySource: 'This is the only place ModPacer looks. Use Stop tracking to stop following the mod.',
    noSource: 'That place is not one of this mod\u2019s.',
    // a folder on this PC (ModPacer 2.0, part 2)
    folderChoose: 'Choose the folder where your builds land.',
    folderMissing: 'ModPacer can\u2019t find that folder.',
    folderRefused: 'That folder belongs to ModPacer or your mod manager, so ModPacer won\u2019t watch it. Choose the folder where your builds land.',
    folderEmpty: 'There are no .zip, .7z or .rar files in that folder yet.',
    folderAlready: (name) => `You already follow this folder as \u201c${name}\u201d.`,
    patternEmpty: 'Type how your files are named, for example {name}-{version}-{variant}.',
    patternNoVersion: 'The file name needs {version}, {build} or {date}, so ModPacer can tell the builds apart.',
    patternBad: 'That doesn\u2019t look like a file name pattern. Use pieces such as {name}-{version}-{variant}.',
    patternNoMatch: (sample) => `ModPacer couldn\u2019t read ${sample ? sample : 'the files in that folder'} with this pattern. Add the missing piece, for example {name}-{version}-{variant}.`,
    variantNone: 'ModPacer found no build of that variant in the folder.',
};

function nowIso() { return new Date().toISOString(); }

// ---- what the person has installed -------------------------------------------------------------------------------------------------------
// -> { version, fromManager, missing, unconfirmed }. Until the person says which mod it is, the version they typed; after, the mod manager's own answer.
function installedFor(rec, mgr) {
    const link = rec.managerLink;
    if (link && mgr && link.manager === mgr.manager && link.key) {
        if (mgr.live && mgr.mods && mgr.mods[link.key]) {
            const v = mgr.versionOf(link.key) || null;
            return { version: v, fromManager: true, missing: false, unconfirmed: false, seen: v };
        }
        if (mgr.live && mgr.complete && mgr.mods && !mgr.mods[link.key]) return { version: null, fromManager: true, missing: true, unconfirmed: false, seen: null }; // the manager no longer has it: reads as not installed
        return { version: link.seenVersion || null, fromManager: true, missing: false, unconfirmed: true, seen: null }; // the manager cannot be read now: what it last said
    }
    return { version: rec.installedNote ? rec.installedNote.version : null, fromManager: false, missing: false, unconfirmed: false, seen: null };
}

// Puts the tracked rows into the page's row list (the engine's state.rows), in place. A row that is downloading or being installed keeps its live fields.
const BUSY = new Set(['queued', 'downloading', 'downloaded', 'updated', 'deployed']);
function syncRows(list, mgr) {
    const old = new Map();
    for (let i = list.length - 1; i >= 0; i--) if (list[i] && list[i].tracked) { old.set(list[i].id, list[i]); list.splice(i, 1); }
    for (const rec of tracked.list()) {
        const inst = installedFor(rec, mgr);
        if (inst.seen && rec.managerLink && rec.managerLink.seenVersion !== inst.seen) { rec.managerLink.seenVersion = inst.seen; try { tracked.save(); } catch { /* remembered only for later */ } }
        const fresh = rows.buildRow(rec, inst, rows.decide(rec, inst));
        if (fresh.tracked && fresh.tracked.app) fresh.tracked.lastAppFolder = tracked.getLastAppFolder();
        const prior = old.get(rec.id);
        // A row whose download or install is under way (or finished and waiting) keeps its status and details; a "choose one file" question stays while the version it is about is still the newest.
        // ...but a build that was only downloaded (not yet installed) is not kept once a newer one has appeared: the row offers the newer one.
        const staleDownload = prior && prior.status === 'downloaded' && fresh.latestVersion && prior.downloadedReleaseVersion && fresh.latestVersion !== prior.downloadedReleaseVersion;
        const keep = prior && !staleDownload && (BUSY.has(prior.status) || (prior.status === 'needs_you' && prior.latestVersion === fresh.latestVersion));
        if (keep) {
            Object.assign(prior, { title: fresh.title, author: fresh.author, tracked: fresh.tracked, externalUrl: fresh.externalUrl });
            list.push(prior);
        } else list.push(fresh);
    }
}

// ---- reading -------------------------------------------------------------------------------------------------------------------------------
// ---- reading, one source at a time (ModPacer 2.0, part 3: a mod may have several) ----
const sourceById = (rec, id) => (rec && rec.sources.find((s) => s.id === id)) || null;
// Saves what one look found on that source. The first source's error and back-off are also kept on the mod, where parts 1 and 2 saved them.
function saveLook(x, s, { observation, error, retry }) {
    if (observation) x.observation[s.id] = observation;
    s.lastError = error || null;
    s.retry = retry;
    if (x.sources[0] === s) { x.lastError = s.lastError; x.retry = s.retry; }
}
// One look at one GitHub source; `manual` asks GitHub again after a minute instead of a few hours. Saves the result.
async function readGithubSource(rec, sourceId, { manual = false, now = Date.now() } = {}) {
    const src = sourceById(rec, sourceId);
    if (!src || src.type !== 'github') return;
    const r = await tg.readLatest(src.owner, src.repo, { manual });
    tracked.update(rec.id, (x) => {
        const s = sourceById(x, sourceId);
        if (!s) return; // the source was removed while GitHub was being asked
        const prevObs = x.observation[s.id] || null;
        const at = new Date(now).toISOString();
        if (r.ok) {
            if (s.stopped) delete s.stopped;
            saveLook(x, s, {
                observation: { version: r.version, tag: r.tag, url: r.url, assets: r.assets, readAt: at, how: manual ? 'manual' : 'background', prev: prevObs && prevObs.version && prevObs.version !== r.version ? prevObs.version : (prevObs && prevObs.prev) || null },
                error: null, retry: rows.afterRead({ retry: rows.retryOf(x, s) }, r, now),
            });
        } else {
            if (r.code === 'gone') s.stopped = { code: 'gone', at }; // a 404 or 410 stops checking this source until the person acts
            saveLook(x, s, { error: { code: r.code, text: r.code, at }, retry: rows.afterRead({ retry: rows.retryOf(x, s) }, r, now) });
            logArea('tracked', `a followed GitHub mod could not be read (${String(r.code).replace(/[^a-z_]/g, '')})`); // names and addresses stay out of routine logs: the code only
        }
        x.state = rows.decide(x, installedFor(x, null)).state;
    });
}
// One look at the mod: every source of it, or just `sourceId`. Saves the results. -> the record
async function readOne(rec, { manual = false, now = Date.now(), sourceId = null } = {}) {
    const ids = (sourceId ? rec.sources.filter((s) => s.id === sourceId) : rec.sources).map((s) => ({ id: s.id, type: s.type }));
    for (const s of ids) {
        const cur = tracked.get(rec.id);
        if (!cur) break;
        if (s.type === 'folder') readFolderOne(cur, { now, sourceId: s.id });
        else if (s.type === 'github') await readGithubSource(cur, s.id, { manual, now });
        else if (s.type === 'loverslab') queueLoversLab(cur, s.id, { now });
    }
    return tracked.get(rec.id);
}

let running = null;
// Reads what is due (or everything, for Check now): the folders first, at once (they are on this PC), then the GitHub ones one at a time with a short gap. Each SOURCE has its own
// back-off. `onChange` is called after each so the page can show it. Never throws.
function checkDue({ manual = false, gapMs = 1500, onChange = null, now = () => Date.now() } = {}) {
    if (running) return running;
    const p = (async () => {
        try {
            const items = [];
            for (const rec of tracked.list()) for (const s of rec.sources) if (manual || rows.sourceDue(rec, s, now())) items.push({ id: rec.id, sid: s.id, type: s.type });
            items.sort((a, b) => Number(b.type === 'folder' || b.type === 'loverslab') - Number(a.type === 'folder' || a.type === 'loverslab'));
            let needGap = false;
            for (const it of items) {
                const rec = tracked.get(it.id);
                if (!rec || !sourceById(rec, it.sid)) continue;
                if (it.type === 'folder') { try { readFolderOne(rec, { now: now(), sourceId: it.sid }); } catch { /* one folder never stops the others */ } if (onChange) { try { onChange(); } catch { /* polled anyway */ } } continue; }
                if (it.type === 'loverslab') { try { queueLoversLab(rec, it.sid, { now: now() }); } catch { /* the browser answers later */ } if (onChange) { try { onChange(); } catch { /* polled anyway */ } } continue; }
                if (needGap && gapMs > 0) await new Promise((res) => setTimeout(res, gapMs));
                needGap = true;
                try { await readGithubSource(rec, it.sid, { manual, now: now() }); } catch (e) { logArea('tracked', `a look at a tracked mod failed: ${String(e && e.message || e).slice(0, 80)}`); }
                if (onChange) { try { onChange(); } catch { /* the page is refreshed anyway by the next poll */ } }
            }
            return items.length;
        } finally { /* running is cleared below, once it has been set */ }
    })();
    running = p;
    p.then(() => { if (running === p) running = null; }, () => { if (running === p) running = null; });
    return p;
}
function isReading() { return !!running; }

// ---- adding --------------------------------------------------------------------------------------------------------------------------------
// Step 2: read the repository once and say what was found. -> { ok:false, error } | { ok:true, owner, repo, url, repoName, found: {version, tag, url, publishedAt} | null, note: null | 'no_release' | ... }
async function preview(address, { manual = true } = {}) {
    const p = tg.parseAddress(address);
    if (!p.ok) return { ok: false, error: p.reason === 'empty' ? REASONS.empty : REASONS.bad };
    const dup = tracked.findBySource('github', p.url);
    if (dup) return { ok: false, error: REASONS.already(dup.name) };
    const r = await tg.readLatest(p.owner, p.repo, { manual });
    const base = { ok: true, owner: p.owner, repo: p.repo, url: p.url, repoName: p.repo };
    if (r.ok) return { ...base, found: { version: r.version, tag: r.tag, url: r.url, publishedAt: r.publishedAt }, note: null };
    if (r.code === 'gone') return { ok: false, error: 'GitHub has no repository at that address.' };
    if (r.code === 'no_release' || r.code === 'unreadable') return { ...base, found: null, note: r.code };
    return { ok: false, error: 'Couldn’t reach GitHub just now. Try again in a little while.' };
}

// The mods of the mod manager the person can point at: [{ key, name, version, variant, enabled, installedAt }], without the ones another tracked mod already uses.
// `variant` is the mod's own Variant field in Vortex (attributes.variant, which the Bridge's mod list returns whole); `enabled` is true / false (null when the manager
// did not say); `installedAt` is Vortex's installTime. Enabled copies come first, then by name, the newest version first, the highest build-like variant first, the
// latest install first. Nothing is written.
const cleanFact = (v, n) => (v === undefined || v === null ? '' : String(v)).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').trim().slice(0, n);
const variantNumber = (v) => { const m = /(\d+)\s*$/.exec(String(v || '')); return m ? parseInt(m[1], 10) : null; };
function enabledOf(mgr, key) {
    if (mgr.manager === 'mo2') return true; // Mod Organizer 2: the list holds the enabled mods of the active profile only
    const keys = mgr.enabledKeys;
    if (!keys) return null;
    return keys.has ? keys.has(key) : (Array.isArray(keys) ? keys.includes(key) : null);
}
function copyFacts(mgr, key, display) {
    const mod = mgr.mods[key] || {};
    const a = mod.attributes || {};
    const t = Date.parse(String(a.installTime || ''));
    return { key, name: String(display).slice(0, 120), version: mgr.versionOf(key) || null, variant: cleanFact(a.variant, 40) || null, enabled: enabledOf(mgr, key), installedAt: Number.isFinite(t) ? new Date(t).toISOString() : null };
}
function compareCopies(a, b) {
    const ea = a.enabled === false ? 1 : 0, eb = b.enabled === false ? 1 : 0;
    if (ea !== eb) return ea - eb;
    const n = a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
    if (n) return n;
    if (a.version && b.version && a.version !== b.version) { const c = compareVersions(b.version, a.version); if (c === 'newer') return -1; if (c === 'older') return 1; }
    const va = variantNumber(a.variant), vb = variantNumber(b.variant);
    if (va !== vb && (va === null || vb === null)) return va === null ? 1 : -1; // a build-like number before a variant with none
    if (va !== null && vb !== null && va !== vb) return vb - va;
    return (Date.parse(b.installedAt || '') || 0) - (Date.parse(a.installedAt || '') || 0);
}
function managerChoices(mgr) {
    if (!mgr || !mgr.mods) return [];
    const used = new Set(tracked.list().filter((r) => r.managerLink && r.managerLink.manager === mgr.manager).map((r) => r.managerLink.key));
    const out = [];
    for (const m of nameMatch.prepareVortexMods(mgr.mods)) {
        if (used.has(m.modId)) continue;
        out.push(copyFacts(mgr, m.modId, m.display));
    }
    return out.sort(compareCopies);
}
// Of several copies of one mod (the same name), the one the person most likely means, or null when it is not clear. The variant the folder step read comes first
// (the copy being tracked), then "exactly one is enabled".
function pickCopy(copies, variantHint) {
    if (copies.length === 1) return copies[0];
    const hint = cleanFact(variantHint, 40).toLowerCase();
    if (hint) {
        const same = copies.filter((c) => c.variant && c.variant.toLowerCase() === hint);
        if (same.length === 1) return same[0];
        const on = same.filter((c) => c.enabled !== false);
        if (same.length > 1 && on.length === 1) return on[0];
    }
    const on = copies.filter((c) => c.enabled === true);
    return on.length === 1 ? on[0] : null;
}
// The mod the new one most likely is. -> { sure: {key, name, by} | null, ask: {key|null, name, choose} | null, choose }
// When the mod manager holds several copies with the same name, the answer is only given when one copy is clearly the one (see pickCopy); otherwise `choose` is true
// and the person is asked to pick (no copy is preselected).
function suggestLink(mgr, { name, url, variant }) {
    if (!mgr || !mgr.mods) return { sure: null, ask: null };
    const used = new Set(tracked.list().filter((r) => r.managerLink && r.managerLink.manager === mgr.manager).map((r) => r.managerLink.key));
    const entry = { id: 'new.tracked', title: name, external_url: url };
    const found = nameMatch.findPairs({ vortexMods: nameMatch.prepareVortexMods(mgr.mods), catalogEntries: [entry], ownedModIds: used, answers: [] });
    const nameOf = (key) => { const m = nameMatch.prepareVortexMods({ [key]: mgr.mods[key] })[0]; return m ? String(m.display).slice(0, 120) : String(key); };
    const copiesOf = (key) => {
        const want = nameOf(key).trim().toLowerCase();
        return nameMatch.prepareVortexMods(mgr.mods).filter((m) => !used.has(m.modId) && String(m.display).trim().toLowerCase() === want).map((m) => copyFacts(mgr, m.modId, m.display));
    };
    const s = found.sure.get(entry.id);
    if (s) {
        const pick = pickCopy(copiesOf(s.modId), variant);
        return pick ? { sure: { key: pick.key, name: nameOf(pick.key), by: s.by }, ask: null } : { sure: null, ask: null, choose: true, name: nameOf(s.modId) };
    }
    const a = found.ask.get(entry.id);
    if (!a) return { sure: null, ask: null };
    const pick = pickCopy(copiesOf(a.modId), variant);
    return { sure: null, ask: { key: pick ? pick.key : null, name: nameOf(a.modId), choose: !pick } };
}

// Step 1 to 3 finished: save the mod. link: { key } (a mod the manager holds) or null (Not installed yet). -> { ok:true, rec } | { ok:false, error, field }
// `application`: the person said "It's not a mod": a program that is only tracked (no manager link; its installed version is what the person says, or the version seen now).
async function addMod({ name, address, version, link = null, application = false }, mgr) {
    if (application) link = null;
    const p = tg.parseAddress(address);
    if (!p.ok) return { ok: false, field: 'address', error: p.reason === 'empty' ? REASONS.empty : REASONS.bad };
    const dup = tracked.findBySource('github', p.url);
    if (dup) return { ok: false, field: 'address', error: REASONS.already(dup.name) };
    const cleanName = tg.cleanText(name, 80) || p.repo;
    if (!cleanName) return { ok: false, field: 'name', error: REASONS.noName };
    let typed = null;
    if (version !== undefined && version !== null && String(version).trim() !== '') {
        typed = tg.cleanTypedVersion(version);
        if (!typed) return { ok: false, field: 'version', error: REASONS.version };
    }
    let managerLink = null;
    if (link && link.key) {
        if (!mgr || !mgr.mods || !Object.prototype.hasOwnProperty.call(mgr.mods, String(link.key))) return { ok: false, field: 'link', error: REASONS.badLink };
        if (tracked.list().some((r) => r.managerLink && r.managerLink.manager === mgr.manager && r.managerLink.key === String(link.key))) return { ok: false, field: 'link', error: REASONS.linkUsed };
        managerLink = { manager: mgr.manager, key: String(link.key), name: String(nameMatch.displayNameOf(mgr.mods[link.key], link.key)).slice(0, 120), seenVersion: mgr.versionOf(link.key) || null };
    }
    const r = await tg.readLatest(p.owner, p.repo, { manual: true });
    const observation = r.ok ? { version: r.version, tag: r.tag, url: r.url, assets: r.assets, readAt: nowIso(), how: 'manual', prev: null } : null;
    // An application with no version typed starts from the version seen now: it is told about NEWER ones only.
    if (application && !typed && observation) typed = observation.version;
    const rec = tracked.add({ name: cleanName, source: { type: 'github', url: p.url, owner: p.owner, repo: p.repo }, installedVersion: managerLink ? null : typed, managerLink, observation, kind: application ? 'application' : 'mod' });
    tracked.update(rec.id, (x) => {
        const s0 = x.sources[0];
        s0.retry = rows.afterRead({ retry: null }, r); x.retry = s0.retry;
        if (!r.ok && r.code !== 'network' && r.code !== 'rate_limited') { s0.lastError = { code: r.code, text: r.code, at: nowIso() }; x.lastError = s0.lastError; }
        if (!r.ok && r.code === 'gone') s0.stopped = { code: 'gone', at: nowIso() };
        if (typed && managerLink) x.installedNote = { version: typed, at: nowIso() }; // kept, but the manager's own answer wins while the link holds
    });
    logArea('tracked', 'now following one more GitHub mod');
    return { ok: true, rec: tracked.get(rec.id) };
}

// Forgets what was read from one source (its observation, error and back-off), so it is read afresh.
function clearSource(x, s) {
    delete x.observation[s.id];
    s.lastError = null; s.retry = { fails: 0, nextAt: 0 };
    if (x.sources[0] === s) { x.lastError = null; x.retry = { fails: 0, nextAt: 0 }; }
}
function stop(id) { const had = tracked.remove(id); if (had) logArea('tracked', 'stopped following a mod'); return had; }

// "Update the link": a new repository for the same mod. Clears what was read and reads again.
async function updateLink(id, address) {
    const rec = tracked.get(id);
    if (!rec) return { ok: false, status: 404, error: 'That mod is not tracked.' };
    const gh = rec.sources.find((s) => s.type === 'github');
    const page = rec.sources.find((s) => s.type === 'loverslab');
    if (page && (!gh || ll.parseAddress(address).ok || /loverslab\.com/i.test(String(address)))) { // a LoversLab page: the same, asked of the browser again
        const q = ll.parseAddress(address);
        if (!q.ok) return { ok: false, status: 400, error: q.reason === 'empty' ? REASONS.llEmpty : REASONS.llBad };
        const same = tracked.findBySource('loverslab', q.url);
        if (same && same.id !== id) return { ok: false, status: 400, error: REASONS.llAlready(same.name) };
        tracked.update(id, (x) => { const s = sourceById(x, page.id); Object.assign(s, { url: q.url, fileId: q.id }); delete s.stopped; clearSource(x, s); x.baseline = null; });
        const cur = tracked.get(id);
        queueLoversLab(cur, page.id);
        return { ok: true, rec: tracked.get(id) };
    }
    if (!gh) return { ok: false, status: 400, error: REASONS.folderChoose }; // a folder has its own "Choose another folder"
    const p = tg.parseAddress(address);
    if (!p.ok) return { ok: false, status: 400, error: p.reason === 'empty' ? REASONS.empty : REASONS.bad };
    const dup = tracked.findBySource('github', p.url);
    if (dup && dup.id !== id) return { ok: false, status: 400, error: REASONS.already(dup.name) };
    if (gh.url === p.url) return { ok: true, rec }; // the same link as now: nothing to change, nothing to re-read
    tracked.update(id, (x) => {
        const s = sourceById(x, gh.id);
        Object.assign(s, { url: p.url, owner: p.owner, repo: p.repo });
        delete s.stopped;
        clearSource(x, s); x.baseline = null;
    });
    await readOne(tracked.get(id), { manual: true, sourceId: gh.id });
    return { ok: true, rec: tracked.get(id) };
}

// "I checked it": the person has looked. The version GitHub lists now is accepted as right (so a lower or renumbered one is no longer questioned), and, when ModPacer
// has no mod-manager link for it, the version they have installed is recorded (what they typed).
function checked(id, { version } = {}, mgr = null) {
    const rec = tracked.get(id);
    if (!rec) return { ok: false, status: 404, error: 'That mod is not tracked.' };
    const inst = installedFor(rec, mgr);
    let typed = null;
    if (!inst.fromManager) {
        typed = tg.cleanTypedVersion(version);
        if (!typed) return { ok: false, status: 400, error: REASONS.version };
    }
    const followed = rows.decide(rec, inst).source;
    const obs = (followed && rec.observation[followed.id]) || null;
    tracked.update(id, (x) => {
        if (typed) x.installedNote = { version: typed, at: nowIso() };
        if (obs && obs.version) x.baseline = { version: obs.version, at: nowIso() };
    });
    return { ok: true };
}

// "I've updated it" (an application): the person installed the new version themselves. ModPacer cannot read what is installed for a program, so the version it follows is now what the
// person has: the installed note and the accepted version both become the newest one seen.
function appUpdated(id) {
    const rec = tracked.get(id);
    if (!rec) return { ok: false, status: 404, error: 'That mod is not tracked.' };
    if (rec.kind !== 'application') return { ok: false, status: 400, error: REASONS.notApp };
    const inst = installedFor(rec, null);
    const src = rows.decide(rec, inst).source;
    const obs = (src && rec.observation[src.id]) || null;
    if (!obs || !obs.version) return { ok: false, status: 400, error: REASONS.noVersionYet };
    tracked.update(id, (x) => { x.installedNote = { version: obs.version, at: nowIso() }; x.baseline = { version: obs.version, at: nowIso() }; });
    return { ok: true, version: obs.version };
}

// After ModPacer itself installed an update (or a first install) for a tracked row: the version the person has is now the one installed; with Vortex the new mod is the link.
function afterInstall(id, { version, modKey = null, manager = null, modName = null } = {}) {
    const rec = tracked.get(id);
    if (!rec) return;
    tracked.update(id, (x) => {
        if (version) x.installedNote = { version, at: nowIso() };
        if (modKey && manager && (!x.managerLink || x.managerLink.manager !== manager || x.managerLink.key !== modKey)) x.managerLink = { manager, key: String(modKey), name: String(modName || modKey).slice(0, 120), seenVersion: version || null };
        else if (x.managerLink && version) x.managerLink.seenVersion = version;
    });
}

// ---- a folder on this PC (ModPacer 2.0, part 2) ---------------------------------------------------------------------------------------------
// Folder.js does the reading (read-only, narrow). Here: which folders are refused, the saved record, and the check. A folder is looked at on this PC, so it is quick,
// has no back-off and runs on every Check now.
let forbiddenProvider = () => [];
// The engine says which folders belong to ModPacer or the mod manager: [{ path, label }]. Asked every time (a setting may change later).
function setFolderGuard(fn) { forbiddenProvider = typeof fn === 'function' ? fn : () => []; }
function folderError(code, sample) {
    if (code === 'folder_refused') return REASONS.folderRefused;
    if (code === 'folder_missing') return REASONS.folderMissing;
    if (code === 'bad_path') return REASONS.folderChoose;
    if (code === 'folder_empty') return REASONS.folderEmpty;
    if (code === 'pattern') return REASONS.patternNoMatch(sample);
    if (code === 'variant_missing') return REASONS.variantNone;
    return rows.WORDS.folderUnreadable;
}
// The folder and the pattern, checked and read once. -> { ok: false, field, code, error } | { ok: true, dir, compiled, exclude, variant, scan }
function inspectFolder({ folder, pattern, exclude, variant }) {
    const allowed = folderSource.checkAllowed(folder, forbiddenProvider());
    if (!allowed.ok) return { ok: false, field: 'folder', code: allowed.code, error: folderError(allowed.code) };
    const compiled = folderSource.parsePattern(pattern);
    if (!compiled.ok) return { ok: false, field: 'pattern', code: 'pattern_bad', error: compiled.reason === 'empty' ? REASONS.patternEmpty : compiled.reason === 'no_version' ? REASONS.patternNoVersion : REASONS.patternBad };
    const words = folderSource.cleanExcludeWords(exclude);
    const v = variant ? folderSource.cleanPiece(variant, 40) : null;
    const scan = folderSource.scan(allowed.dir, compiled, { exclude: words, variant: v });
    if (!scan.ok) return { ok: false, field: scan.code === 'pattern' ? 'pattern' : 'folder', code: scan.code, error: folderError(scan.code, scan.sample) };
    return { ok: true, dir: allowed.dir, compiled, exclude: words, variant: v, scan };
}
// Step 2 of the pop-up for a folder: what the newest file reads as. -> { ok: false, error, field } | { ok: true, folder, newest, matched, unmatched, variants, needsVariant }
function previewFolder(body) {
    const b = body || {};
    const r = inspectFolder({ folder: b.folder, pattern: b.pattern, exclude: b.exclude, variant: b.variant });
    if (!r.ok) return { ok: false, field: r.field, error: r.error };
    const dup = tracked.findFolder(r.dir, String(b.pattern).trim());
    if (dup) return { ok: false, field: 'folder', error: REASONS.folderAlready(dup.name) };
    const s = r.scan;
    return { ok: true, folder: r.dir, newest: s.newest, matched: s.matched, unmatched: s.unmatched, variants: s.variants.map((v) => ({ variant: v.variant, fileName: v.fileName, version: v.version })), needsVariant: s.variants.length > 1 && !r.variant, tooMany: !!s.tooMany };
}
function sourceScan(src) {
    const allowed = folderSource.checkAllowed(src.path, forbiddenProvider());
    if (!allowed.ok) return { ok: false, code: allowed.code === 'folder_refused' ? 'folder_refused' : 'folder_missing' };
    const compiled = folderSource.parsePattern(src.pattern);
    if (!compiled.ok) return { ok: false, code: 'pattern' };
    const scan = folderSource.scan(allowed.dir, compiled, { exclude: src.exclude, variant: src.variant });
    return scan.ok ? { ok: true, scan, dir: allowed.dir } : { ok: false, code: scan.code };
}
// One quick look at a followed folder source; saves the result. Never throws, never waits.
function readFolderOne(rec, { now = Date.now(), sourceId = null } = {}) {
    const first = sourceId ? sourceById(rec, sourceId) : rec.sources.find((s) => s.type === 'folder');
    if (!first || first.type !== 'folder') return rec;
    const sid = first.id;
    const r = sourceScan(first);
    tracked.update(rec.id, (x) => {
        const s = sourceById(x, sid);
        if (!s) return;
        const prevObs = x.observation[s.id] || null;
        const at = new Date(now).toISOString();
        if (r.ok) {
            const n = r.scan.newest;
            saveLook(x, s, {
                observation: {
                    version: n.version, file: folderSource.cleanPiece(n.fileName, 150), variant: n.variant, build: n.build, date: n.date, size: n.size, readAt: at, how: 'local',
                    prev: prevObs && prevObs.version && prevObs.version !== n.version ? prevObs.version : (prevObs && prevObs.prev) || null,
                },
                error: null, retry: rows.afterRead({ retry: rows.retryOf(x, s) }, { ok: true, local: true }, now),
            });
        } else {
            saveLook(x, s, { error: { code: r.code, text: r.code, at }, retry: rows.afterRead({ retry: rows.retryOf(x, s) }, { ok: false, local: true, code: r.code }, now) });
            logArea('tracked', `a followed folder could not be read (${String(r.code).replace(/[^a-z_]/g, '')})`); // the folder is never written to the log
        }
        x.state = rows.decide(x, installedFor(x, null)).state;
    });
    return tracked.get(rec.id);
}
// Every followed folder, at once (the check calls this before it draws the rows: a folder is on this PC, so nothing waits).
function readFoldersNow() {
    for (const rec of tracked.list()) for (const s of rec.sources) if (s.type === 'folder') { try { readFolderOne(tracked.get(rec.id), { sourceId: s.id }); } catch { /* one folder never stops the others */ } }
}
// The build to hand to the mod manager NOW (looked up again at the moment of the click, so it is the newest one then). -> { ok: true, srcPath, fileName, version, size } | { ok: false, message }
function currentBuild(rec, sourceId = null) {
    const src = rec && (sourceId ? sourceById(rec, sourceId) : rec.sources.find((s) => s.type === 'folder'));
    if (!src || src.type !== 'folder') return { ok: false, message: REASONS.folderChoose };
    const r = sourceScan(src);
    if (!r.ok) return { ok: false, message: folderError(r.code) };
    const n = r.scan.newest;
    if (path.basename(n.fileName) !== n.fileName) return { ok: false, message: REASONS.folderChoose }; // a name with a folder in it is never used as a path
    return { ok: true, srcPath: path.join(r.dir, n.fileName), fileName: n.fileName, version: n.version, size: n.size };
}
// True when a file is inside a folder ModPacer only reads: anything about to DELETE a file asks this first, so the person's own builds are never removed.
function insideWatchedFolder(file) {
    const dirs = [].concat(...tracked.list().map((r) => r.sources)).filter((s) => s && s.type === 'folder' && s.path).map((s) => s.path);
    return folderSource.isInsideAny(file, dirs);
}
// Step 1 to 3 finished for a folder: save the mod. -> { ok: true, rec } | { ok: false, error, field }
function addFolderMod(body, mgr) {
    const b = { ...(body || {}) };
    if (b.application) b.link = null;
    const r = inspectFolder({ folder: b.folder, pattern: b.pattern, exclude: b.exclude, variant: b.variant });
    if (!r.ok) return { ok: false, field: r.field, error: r.error };
    const pattern = String(b.pattern).trim();
    const dup = tracked.findFolder(r.dir, pattern);
    if (dup) return { ok: false, field: 'folder', error: REASONS.folderAlready(dup.name) };
    if (r.scan.variants.length > 1 && !r.variant) return { ok: false, field: 'variant', error: 'Choose which variant to follow.' };
    const n = r.scan.newest;
    const cleanName = tg.cleanText(b.name, 80) || folderSource.cleanPiece(n.name, 80) || folderSource.cleanPiece(path.basename(r.dir), 80);
    if (!cleanName) return { ok: false, field: 'name', error: REASONS.noName };
    let typed = null;
    if (b.version !== undefined && b.version !== null && String(b.version).trim() !== '') {
        typed = tg.cleanTypedVersion(b.version);
        if (!typed) return { ok: false, field: 'version', error: REASONS.version };
    }
    let managerLink = null;
    const link = b.link;
    if (link && link.key) {
        if (!mgr || !mgr.mods || !Object.prototype.hasOwnProperty.call(mgr.mods, String(link.key))) return { ok: false, field: 'link', error: REASONS.badLink };
        if (tracked.list().some((x) => x.managerLink && x.managerLink.manager === mgr.manager && x.managerLink.key === String(link.key))) return { ok: false, field: 'link', error: REASONS.linkUsed };
        managerLink = { manager: mgr.manager, key: String(link.key), name: String(nameMatch.displayNameOf(mgr.mods[link.key], link.key)).slice(0, 120), seenVersion: mgr.versionOf(link.key) || null };
    }
    const observation = { version: n.version, file: folderSource.cleanPiece(n.fileName, 150), variant: n.variant, build: n.build, date: n.date, size: n.size, readAt: nowIso(), how: 'local', prev: null };
    if (b.application && !typed) typed = observation.version;
    const rec = tracked.add({ name: cleanName, source: { type: 'folder', path: r.dir, pattern, exclude: r.exclude, variant: r.variant }, installedVersion: managerLink ? null : typed, managerLink, observation, kind: b.application ? 'application' : 'mod' });
    tracked.update(rec.id, (x) => { x.sources[0].retry = rows.afterRead({ retry: null }, { ok: true, local: true }); x.retry = x.sources[0].retry; if (typed && managerLink) x.installedNote = { version: typed, at: nowIso() }; });
    logArea('tracked', 'now following one more folder');
    return { ok: true, rec: tracked.get(rec.id) };
}
// "Choose another folder": the same mod, the same file names, a different folder.
function updateFolder(id, folder) {
    const rec = tracked.get(id);
    if (!rec) return { ok: false, status: 404, error: 'That mod is not tracked.' };
    const src = rec.sources.find((s) => s.type === 'folder');
    if (!src) return { ok: false, status: 400, error: REASONS.bad };
    const r = inspectFolder({ folder, pattern: src.pattern, exclude: src.exclude, variant: src.variant });
    if (!r.ok) return { ok: false, status: 400, error: r.error };
    const dup = tracked.findFolder(r.dir, src.pattern);
    if (dup && dup.id !== id) return { ok: false, status: 400, error: REASONS.folderAlready(dup.name) };
    tracked.update(id, (x) => { const s = sourceById(x, src.id); s.path = r.dir; clearSource(x, s); x.baseline = null; });
    readFolderOne(tracked.get(id), { sourceId: src.id });
    return { ok: true, rec: tracked.get(id) };
}

// ---- several sources, the pin and the choice (ModPacer 2.0, part 3) ----
const nextSourceId = (rec) => `s${rec.sources.reduce((m, s) => Math.max(m, Number(String(s.id).replace(/^\D+/, '')) || 0), 0) + 1}`;
// "Add another source": the same checks as adding a mod (an address or a folder), read once, then added to the SAME mod. A mod has at most one source of each kind.
async function addSource(id, body) {
    const rec = tracked.get(id);
    if (!rec) return { ok: false, status: 404, error: 'That mod is not tracked.' };
    const b = body || {};
    const kind = b.source === 'folder' ? 'folder' : b.source === 'loverslab' ? 'loverslab' : 'github';
    if (rec.sources.some((s) => s.type === kind)) return { ok: false, status: 400, error: kind === 'folder' ? REASONS.haveFolder : kind === 'loverslab' ? REASONS.haveLoversLab : REASONS.haveGithub };
    const sid = nextSourceId(rec);
    const at = nowIso();
    if (kind === 'loverslab') {
        const p = ll.parseAddress(b.address);
        if (!p.ok) return { ok: false, status: 400, error: p.reason === 'empty' ? REASONS.llEmpty : REASONS.llBad };
        const dup = tracked.findBySource('loverslab', p.url);
        if (dup) return { ok: false, status: 400, error: REASONS.llAlready(dup.name) };
        tracked.update(id, (x) => { x.sources.push({ id: sid, type: 'loverslab', url: p.url, fileId: p.id, retry: { fails: 0, nextAt: 0 } }); });
        queueLoversLab(tracked.get(id), sid);
    } else if (kind === 'github') {
        const p = tg.parseAddress(b.address);
        if (!p.ok) return { ok: false, status: 400, error: p.reason === 'empty' ? REASONS.empty : REASONS.bad };
        const dup = tracked.findBySource('github', p.url);
        if (dup) return { ok: false, status: 400, error: REASONS.already(dup.name) };
        const r = await tg.readLatest(p.owner, p.repo, { manual: true });
        if (!tracked.get(id)) return { ok: false, status: 404, error: 'That mod is not tracked.' };
        tracked.update(id, (x) => {
            const s = { id: sid, type: 'github', url: p.url, owner: p.owner, repo: p.repo };
            x.sources.push(s);
            if (r.ok) x.observation[sid] = { version: r.version, tag: r.tag, url: r.url, assets: r.assets, readAt: at, how: 'manual', prev: null };
            else if (r.code !== 'network' && r.code !== 'rate_limited') s.lastError = { code: r.code, text: r.code, at };
            if (!r.ok && r.code === 'gone') s.stopped = { code: 'gone', at };
            s.retry = rows.afterRead({ retry: null }, r.ok ? r : r, Date.now());
        });
    } else {
        const r = inspectFolder({ folder: b.folder, pattern: b.pattern, exclude: b.exclude, variant: b.variant });
        if (!r.ok) return { ok: false, status: 400, error: r.error };
        const pattern = String(b.pattern).trim();
        const dup = tracked.findFolder(r.dir, pattern);
        if (dup) return { ok: false, status: 400, error: REASONS.folderAlready(dup.name) };
        if (r.scan.variants.length > 1 && !r.variant) return { ok: false, status: 400, error: 'Choose which variant to follow.' };
        const n = r.scan.newest;
        tracked.update(id, (x) => {
            x.sources.push({ id: sid, type: 'folder', path: r.dir, pattern, exclude: r.exclude, variant: r.variant, retry: rows.afterRead({ retry: null }, { ok: true, local: true }) });
            x.observation[sid] = { version: n.version, file: folderSource.cleanPiece(n.fileName, 150), variant: n.variant, build: n.build, date: n.date, size: n.size, readAt: at, how: 'local', prev: null };
        });
    }
    logArea('tracked', 'a followed mod has one more place to look');
    return { ok: true, rec: tracked.get(id) };
}
// "Remove this source": the others stay. The last one cannot be removed (that is Stop tracking). A pin or a choice that pointed at it goes with it.
function removeSource(id, sourceId) {
    const rec = tracked.get(id);
    if (!rec) return { ok: false, status: 404, error: 'That mod is not tracked.' };
    const s = sourceById(rec, sourceId);
    if (!s) return { ok: false, status: 400, error: REASONS.noSource };
    if (rec.sources.length <= 1) return { ok: false, status: 400, error: REASONS.onlySource };
    tracked.update(id, (x) => {
        x.sources = x.sources.filter((y) => y.id !== sourceId);
        delete x.observation[sourceId];
        if (x.pin === sourceId) x.pin = null;
        if (x.choice && x.choice.sourceId === sourceId) x.choice = null;
        const first = x.sources[0];
        if (first) { x.lastError = rows.errOf({ ...x, sources: [first] }, first); x.retry = rows.retryOf({ ...x, sources: [first] }, first) || { fails: 0, nextAt: 0 }; }
    });
    return { ok: true, rec: tracked.get(id) };
}
// "Use this source" pins it; null is "Unpin". A pin selects exactly that source.
function setPin(id, sourceId) {
    const rec = tracked.get(id);
    if (!rec) return { ok: false, status: 404, error: 'That mod is not tracked.' };
    if (sourceId !== null && !sourceById(rec, sourceId)) return { ok: false, status: 400, error: REASONS.noSource };
    tracked.update(id, (x) => { x.pin = sourceId; });
    return { ok: true, rec: tracked.get(id) };
}
// The person's answer to "which one should it follow?" when two sources cannot be compared: asked once, remembered.
function chooseSource(id, sourceId) {
    const rec = tracked.get(id);
    if (!rec) return { ok: false, status: 404, error: 'That mod is not tracked.' };
    if (!sourceById(rec, sourceId)) return { ok: false, status: 400, error: REASONS.noSource };
    tracked.update(id, (x) => { x.choice = { sourceId, at: nowIso() }; });
    return { ok: true, rec: tracked.get(id) };
}


// ---- a LoversLab page, read through the browser helper (ModPacer 2.0, part 4) ----
// ModPacer never fetches the page. It ASKS (a one-time request in lib/helper-link.js); the person's own browser reads the page with their own sign-in and REPORTS; the report is
// accepted only for that request and that exact address (see applyHelperReport). Updating never downloads from a page: the row's button opens it.
function queueLoversLab(rec, sourceId, { now = Date.now() } = {}) {
    const src = sourceById(rec, sourceId);
    if (!src || src.type !== 'loverslab' || !src.url) return null;
    if (!helperLink.isPaired()) {
        tracked.update(rec.id, (x) => {
            const s = sourceById(x, sourceId);
            if (!s) return;
            saveLook(x, s, { error: { code: 'no_helper', text: 'no_helper', at: new Date(now).toISOString() }, retry: { fails: 0, nextAt: now + 10 * 60 * 1000 } });
            x.state = rows.decide(x, installedFor(x, null)).state;
        });
        return null;
    }
    const req = helperLink.ask({ kind: 'check', modId: rec.id, sourceId, page: src.url }, now);
    tracked.update(rec.id, (x) => {
        const s = sourceById(x, sourceId);
        if (!s) return;
        saveLook(x, s, { error: s.lastError && s.lastError.code === 'no_helper' ? null : s.lastError, retry: rows.afterRead({ retry: null }, { page: true }, now) });
    });
    return req;
}
// Every LoversLab source that is due gets its check asked for (no network here: the answer comes later, from the browser).
function queueDueLoversLab({ manual = false, now = Date.now() } = {}) {
    let n = 0;
    for (const rec of tracked.list()) for (const s of rec.sources) if (s.type === 'loverslab' && (manual || rows.sourceDue(rec, s, now))) { if (queueLoversLab(rec, s.id, { now })) n++; }
    return n;
}
// The helper was just paired: every LoversLab source is asked for at once.
function helperPaired(now = Date.now()) {
    for (const rec of tracked.list()) for (const s of rec.sources) if (s.type === 'loverslab') {
        tracked.update(rec.id, (x) => { const y = sourceById(x, s.id); if (y) { y.retry = { fails: 0, nextAt: 0 }; if (y.lastError && y.lastError.code === 'no_helper') saveLook(x, y, { error: null, retry: y.retry }); } });
    }
    return queueDueLoversLab({ now });
}
// The helper's report for a request it was handed. The caller (lib/helper-link.js take) has already checked the request id, that it is still waiting and that the page is exactly the
// registered one. What this may change: the observation and the error of THAT source, and nothing else. -> { ok }
function applyHelperReport(request, report, now = Date.now()) {
    if (!request) return { ok: false };
    if (request.kind === 'preview') {
        const cleaned = ll.cleanReport(report, { page: request.page, now });
        request.result = { cleaned, title: report && typeof report === 'object' ? tg.cleanText(report.title, 120) : '' };
        return { ok: true };
    }
    const rec = tracked.get(request.modId);
    const src = rec && sourceById(rec, request.sourceId);
    if (!src || src.type !== 'loverslab' || src.url !== request.page) { helperLink.forget(request.id); return { ok: false }; } // the mod, the source or its address changed meanwhile
    const prev = (rec.observation || {})[src.id] || null;
    const cleaned = ll.cleanReport(report, { page: request.page, now, prev });
    helperLink.forget(request.id);
    const at = new Date(now).toISOString();
    tracked.update(rec.id, (x) => {
        const s = sourceById(x, src.id);
        if (!s || s.url !== request.page) return;
        if (cleaned.ok) {
            delete s.stopped;
            saveLook(x, s, { observation: cleaned.observation, error: null, retry: rows.afterRead({ retry: null }, { ok: true }, now) });
        } else {
            if (cleaned.code === 'gone') s.stopped = { code: 'gone', at };
            // a sign-in problem or a missing version waits for the person (an hour at least, checked again by itself); a network problem backs off
            const retry = cleaned.code === 'network' || cleaned.code === 'rate_limited' ? rows.afterRead({ retry: rows.retryOf(x, s) }, { ok: false, code: cleaned.code }, now) : cleaned.code === 'gone' ? rows.afterRead({ retry: null }, { ok: false, code: 'gone' }, now) : { fails: 1, nextAt: now + 60 * 60 * 1000 };
            saveLook(x, s, { error: { code: cleaned.code, text: cleaned.code, at }, retry });
            logArea('tracked', `a followed LoversLab page could not be read (${String(cleaned.code).replace(/[^a-z_]/g, '')})`); // the code only: no address, no title
        }
        x.state = rows.decide(x, installedFor(x, null)).state;
    });
    return { ok: true };
}
// Is any LoversLab source waiting on the person to sign in? (the Settings line says so)
function anySignedOut() { return tracked.list().some((r) => r.sources.some((s) => s.type === 'loverslab' && s.lastError && s.lastError.code === 'signin')); }

// Step 2 of the pop-up for a LoversLab page: ask the person's browser to read it once. -> { ok: false, error, code? } | { ok: true, requestId, url }
function previewPage(address, { now = Date.now() } = {}) {
    const p = ll.parseAddress(address);
    if (!p.ok) return { ok: false, error: p.reason === 'empty' ? REASONS.llEmpty : REASONS.llBad };
    const dup = tracked.findBySource('loverslab', p.url);
    if (dup) return { ok: false, error: REASONS.llAlready(dup.name) };
    if (!helperLink.isPaired()) return { ok: false, code: 'no_helper', error: REASONS.noHelper };
    const req = helperLink.ask({ kind: 'preview', page: p.url }, now);
    return { ok: true, requestId: req.id, url: p.url };
}
// The answer to that, when it is there. -> { state: 'waiting' } | { state: 'silent', error } | { state: 'done', ok: false, error } | { state: 'done', ok: true, url, found, note, nameHint }
function previewPageResult(requestId, { now = Date.now() } = {}) {
    const req = helperLink.getRequest(requestId);
    if (!req || req.kind !== 'preview') return { state: 'silent', error: REASONS.llSilent };
    if (!req.result) return now - req.createdAt > 45 * 1000 ? { state: 'silent', error: REASONS.llSilent } : { state: 'waiting' };
    const c = req.result.cleaned;
    const nameHint = tg.cleanText(String(req.result.title || '').replace(/\s+v?\d+(?:\.\d+)*[a-z]?$/i, ''), 80) || null;
    if (c.ok) return { state: 'done', ok: true, requestId: req.id, url: req.page, found: { version: c.observation.version, from: c.observation.source, alsoListed: c.observation.alsoListed, dates: c.observation.dates }, note: null, nameHint };
    if (c.code === 'gone') return { state: 'done', ok: false, code: 'gone', error: REASONS.llGone };
    if (c.code === 'network' || c.code === 'rate_limited') return { state: 'done', ok: false, code: 'network', error: REASONS.llNetwork };
    return { state: 'done', ok: true, requestId: req.id, url: req.page, found: null, note: c.code, nameHint }; // 'signin' or 'layout': the person can still add it and say the version themselves
}
// Add the mod (step 3 done): the same link to the mod manager as a GitHub mod, the version from the reading the person already saw.
async function addPageMod(b, mgr) {
    const application = b.application === true;
    const p = ll.parseAddress(b.address);
    if (!p.ok) return { ok: false, field: 'address', error: p.reason === 'empty' ? REASONS.llEmpty : REASONS.llBad };
    const dup = tracked.findBySource('loverslab', p.url);
    if (dup) return { ok: false, field: 'address', error: REASONS.llAlready(dup.name) };
    const req = b.requestId ? helperLink.getRequest(b.requestId) : null;
    const seen = req && req.kind === 'preview' && req.page === p.url && req.result ? req.result : null;
    const hint = seen && seen.cleaned && seen.cleaned.ok ? tg.cleanText(String(seen.title || '').replace(/\s+v?\d+(?:\.\d+)*[a-z]?$/i, ''), 80) : '';
    const slug = p.id;
    const cleanName = tg.cleanText(b.name, 80) || hint || `LoversLab ${slug}`;
    let typed = null;
    if (b.version !== undefined && b.version !== null && String(b.version).trim() !== '') {
        typed = tg.cleanTypedVersion(b.version);
        if (!typed) return { ok: false, field: 'version', error: REASONS.version };
    }
    let managerLink = null;
    const link = application ? null : b.link;
    if (link && link.key) {
        if (!mgr || !mgr.mods || !Object.prototype.hasOwnProperty.call(mgr.mods, String(link.key))) return { ok: false, field: 'link', error: REASONS.badLink };
        if (tracked.list().some((r) => r.managerLink && r.managerLink.manager === mgr.manager && r.managerLink.key === String(link.key))) return { ok: false, field: 'link', error: REASONS.linkUsed };
        managerLink = { manager: mgr.manager, key: String(link.key), name: String(nameMatch.displayNameOf(mgr.mods[link.key], link.key)).slice(0, 120), seenVersion: mgr.versionOf(link.key) || null };
    }
    const observation = seen && seen.cleaned && seen.cleaned.ok ? seen.cleaned.observation : null;
    if (application && !typed && observation) typed = observation.version;
    const rec = tracked.add({ name: cleanName, source: { type: 'loverslab', url: p.url, fileId: slug }, installedVersion: managerLink ? null : typed, managerLink, observation, kind: application ? 'application' : 'mod' });
    if (req) helperLink.forget(req.id);
    tracked.update(rec.id, (x) => { const s0 = x.sources[0]; s0.retry = observation ? rows.afterRead({ retry: null }, { ok: true }) : { fails: 0, nextAt: 0 }; x.retry = s0.retry; });
    if (!observation) queueLoversLab(tracked.get(rec.id), 's1');
    logArea('tracked', 'a LoversLab mod is now followed');
    return { ok: true, rec: tracked.get(rec.id) };
}

module.exports = { queueLoversLab, queueDueLoversLab, helperPaired, applyHelperReport, anySignedOut, previewPage, previewPageResult, addPageMod, appUpdated, addSource, removeSource, setPin, chooseSource, installedFor, syncRows, readOne, checkDue, isReading, preview, managerChoices, suggestLink, addMod, stop, updateLink, checked, afterInstall, REASONS,
    setFolderGuard, previewFolder, addFolderMod, updateFolder, readFolderOne, readFoldersNow, currentBuild, insideWatchedFolder };
