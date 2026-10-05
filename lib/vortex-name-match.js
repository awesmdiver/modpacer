'use strict';
// Recognises a mod that is ALREADY in Vortex but whose name differs from its Hub listing (queue: a-mod-already-in-vortex-is-
// recognised-even-when-its-name-differs, 2026-10-04). The real case: Vortex's list has `STFU.v1.2.0.zip`, the Hub lists
// "S.T.F.U - Skyrim Talk Filter Utility" (1.2.1): the same mod, but ModPacer offered it under "Mods not installed".
//
// Two answers, never a guess presented as a fact:
//   - SURE   : stronger evidence first (the same Nexus mod id, or the same GitHub repository, from the Vortex record or its archive
//              name); otherwise the cleaned Vortex name EQUALS one of the Hub entry's name forms (whole title, each part of it split
//              on " - ", the dotted acronym collapsed, the id's slug, the repository name). The mod is treated as installed.
//   - PROBABLE: a close name (a small spelling difference, a word missing or added, every real word of the shorter name present in
//              the longer one). ModPacer asks once; nothing changes until the person answers.
// The older matcher (plugin-matcher.js, installed SkyrimNet plugins against the catalog) is not touched.
//
// Speed: the Hub side is prepared once per catalog list and the Vortex side once per check (a Vortex list can hold thousands of mods).

const STOP = new Set(['a', 'an', 'the', 'for', 'of', 'in', 'on', 'to', 'and', 'with', 'by', 'skyrimnet']);
// Words that say nothing about which mod it is: a name made only of these is never a probable match.
const GENERIC = new Set(['skyrim', 'mod', 'mods', 'plugin', 'plugins', 'patch', 'fix', 'fixes', 'utility', 'main', 'file', 'files', 'sse', 'special', 'edition', 'addon', 'addons', 'pack', 'version', 'beta', 'alpha', 'release', 'update', 'new', 'extra', 'extras', 'complete', 'standalone', 'integration']);

// ---------- cleaning a Vortex name ----------
// "STFU.v1.2.0.zip" -> "STFU"; "Kinship-1.9.7" -> "Kinship"; "BioForge-12345-1-0-1-1700000000.7z" -> "BioForge"; "Mod_v1_2" -> "Mod".
function cleanVortexName(raw) {
    let s = String(raw == null ? '' : raw).trim();
    s = s.replace(/\.(zip|7z|rar|7zip)$/i, '');
    s = s.replace(/\s*\(\d+\)$/, '');                                   // a duplicate download: "name (1)"
    s = s.replace(/-\d{2,8}(?:-\d{1,4}){1,5}-\d{9,11}$/, '');            // Nexus tail: -modid-1-0-1-timestamp
    s = s.replace(/[-_ ]\d{9,11}$/, '');                                  // a lone timestamp
    for (let i = 0; i < 4; i += 1) {                                      // version markers, however many are stacked on the end
        const before = s;
        s = s
            .replace(/[\s._-]*(?<![A-Za-z0-9])v?\d+(?:[._]\d+)+(?:[a-z]{1,3}\d*)?$/i, '')   // .v1.2.0  -1.2.0  _1_2  v1.2  1.2.0b
            .replace(/[\s._-]*(?<![A-Za-z0-9])v\d+(?:[a-z]{1,3})?$/i, '')                    // v2
            .replace(/[\s._-]+(?:version|ver)$/i, '')                                        // "Foo version" left after "3.1" went
            .replace(/[\s._-]*[([]\s*v?\d+(?:[._]\d+)*\s*[)\]]$/i, '');                      // (1.2)  [v2]
        if (s === before) break;
    }
    return s.replace(/[\s._-]+$/g, '').replace(/^[\s._-]+/g, '').trim();
}

function compact(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// A dotted acronym ("S.T.F.U") stays one word ("stfu"); other dots separate words ("Foo.Bar" -> foo, bar).
function wordsOf(s) {
    const out = [];
    for (const tok of String(s || '').split(/[\s_\-/,:;|()[\]]+/)) {
        if (!tok) continue;
        if (/^(?:[a-z0-9]\.)+[a-z0-9]?$/i.test(tok)) { out.push(tok.replace(/\./g, '').toLowerCase()); continue; }
        for (const part of tok.split('.')) out.push(part.replace(/[^a-z0-9]/gi, '').toLowerCase());
    }
    return out.filter((w) => w.length >= 3 && !STOP.has(w));
}

function levenshtein(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
        const cur = [i];
        let rowMin = i;
        for (let j = 1; j <= b.length; j += 1) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            if (cur[j] < rowMin) rowMin = cur[j];
        }
        if (rowMin > max) return max + 1;
        prev = cur;
    }
    return prev[b.length];
}

// ---------- the Hub side ----------
function nexusIdOfUrl(u) { const m = /nexusmods\.com\/[^/]+\/mods\/(\d+)/i.exec(String(u || '')); return m ? m[1] : null; }
function githubRepoOfUrl(u) { const m = /github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(String(u || '')); return m ? `${m[1]}/${m[2]}`.toLowerCase().replace(/\.git$/, '') : null; }

const preparedCatalogs = new WeakMap();
function prepareEntry(entry) {
    const title = String(entry.title || '').trim();
    const parts = title.split(/\s+[-–—]\s+|\s*[:|]\s+/).map((p) => p.trim()).filter(Boolean);
    const slug = String(entry.plugin_id || entry.id || '').split('.').slice(1).join('.');
    const repoUrl = String(entry.external_url || '');
    const gh = githubRepoOfUrl(repoUrl);
    const repoName = gh ? gh.split('/')[1] : '';
    const withoutSN = (t) => t.replace(/\s+for\s+skyrimnet\b/i, '').replace(/\bskyrimnet\s+/i, '').trim();
    const exactSources = [title, ...parts, slug, repoName]; // "without SkyrimNet" forms are only ever probable
    const exact = new Set();
    for (const f of exactSources) { const c = compact(f); if (c.length >= 4 && !GENERIC.has(c) && c !== 'skyrimnet') exact.add(c); }
    // the "close" forms: the whole title and each part, as words and as one compact string
    const closeForms = [];
    for (const f of [title, ...parts, withoutSN(title), repoName]) {
        const c = compact(f);
        if (!c) continue;
        closeForms.push({ compact: c, words: new Set(wordsOf(f)) });
    }
    return { entry, exact, closeForms, nexusId: nexusIdOfUrl(repoUrl), repo: gh };
}
function prepareCatalog(entries) {
    let p = preparedCatalogs.get(entries);
    if (!p) {
        p = entries.filter((e) => e && (e.title || e.plugin_id || e.id)).map(prepareEntry);
        // so a Vortex name is only compared with the few entries that share a word or the first letters with it
        p.wordIndex = new Map();
        p.prefixIndex = new Map();
        p.forEach((pe, i) => {
            for (const f of pe.closeForms) {
                for (const w of f.words) { if (!p.wordIndex.has(w)) p.wordIndex.set(w, new Set()); p.wordIndex.get(w).add(i); }
                if (f.compact.length >= 6) { const k = f.compact.slice(0, 3); if (!p.prefixIndex.has(k)) p.prefixIndex.set(k, new Set()); p.prefixIndex.get(k).add(i); }
            }
        });
        preparedCatalogs.set(entries, p);
    }
    return p;
}

// ---------- the Vortex side ----------
function nexusIdOfArchiveName(name) { const m = /-(\d{2,8})(?:-\d{1,4}){1,5}-\d{9,11}\.(?:zip|7z|rar)$/i.exec(String(name || '')); return m ? m[1] : null; }
function urlsOf(attrs) {
    const out = [];
    for (const k of ['homepage', 'url', 'sourceURL', 'sourceUrl', 'source_url', 'website', 'modPage', 'downloadUrl', 'description']) if (typeof attrs[k] === 'string') out.push(attrs[k]);
    return out;
}
function displayNameOf(mod, modId) {
    const a = (mod && mod.attributes) || {};
    for (const v of [a.customFileName, a.fileName, a.modName, a.name, a.logicalFileName, modId]) if (v && String(v).trim()) return String(v).trim();
    return String(modId);
}
function prepareVortexMods(allMods) {
    const out = [];
    for (const [modId, mod] of Object.entries(allMods || {})) {
        const a = (mod && mod.attributes) || {};
        if (a.type === 'collection' || (mod && mod.type === 'collection')) continue;
        const raws = [a.customFileName, a.modName, a.name, a.fileName, a.logicalFileName, modId, mod && mod.installationPath];
        const names = [];
        const seen = new Set();
        for (const r of raws) {
            if (!r) continue;
            const cleaned = cleanVortexName(r);
            const c = compact(cleaned);
            if (c.length < 3 || seen.has(c)) continue;
            seen.add(c);
            names.push({ cleaned, compact: c, words: new Set(wordsOf(cleaned)) });
        }
        if (names.length === 0) continue;
        let nexusId = null;
        if (a.source === 'nexus' && a.modId != null && String(a.modId) !== '' && String(a.modId) !== '-1') nexusId = String(a.modId);
        if (!nexusId) nexusId = nexusIdOfArchiveName(a.fileName) || nexusIdOfArchiveName(modId) || nexusIdOfArchiveName(a.logicalFileName);
        const repos = new Set();
        for (const u of urlsOf(a)) { const g = githubRepoOfUrl(u); if (g) repos.add(g); if (!nexusId) nexusId = nexusIdOfUrl(u) || nexusId; }
        out.push({ modId, mod, names, nexusId, repos, display: displayNameOf(mod, modId) });
    }
    return out;
}

// ---------- comparing ----------
// A score in (0, 1] when the Vortex name is close to the Hub entry (never reached by a sure match), else 0.
function closeScore(vname, prepared) {
    let best = 0;
    for (const form of prepared.closeForms) {
        const a = vname.words, b = form.words;
        if (a.size > 0 && b.size > 0) {
            const [small, big] = a.size <= b.size ? [a, b] : [b, a];
            let shared = 0, meaningful = 0;
            for (const w of small) if (big.has(w)) { shared += 1; if (!GENERIC.has(w)) meaningful += 1; }
            if (shared === small.size && meaningful > 0 && (small.size >= 2 || [...small][0].length >= 5)) best = Math.max(best, 0.85 - 0.01 * Math.min(10, big.size - small.size));
            else if (shared >= 2 && meaningful >= 1 && shared / small.size >= 0.6) best = Math.max(best, 0.7);
        }
        // a small spelling difference: one or two letters in a name of six or more
        const len = Math.min(vname.compact.length, form.compact.length);
        if (len >= 6) {
            const max = len >= 12 ? 2 : 1;
            if (levenshtein(vname.compact, form.compact, max) <= max) best = Math.max(best, 0.8);
        }
    }
    return best;
}

// answers: [{catalogId, vortexModId, key, answer: 'yes'|'no'}] (what the person said before; `key` = the compact cleaned Vortex name, so
// the answer still holds after an update has renamed the mod's archive).
// Returns { sure: Map<entryId, {modId, by}>, ask: Map<entryId, {modId, vortexName, score}> }.
function findPairs({ vortexMods, catalogEntries, ownedModIds, answers, pickCandidate }) {
    const owned = ownedModIds instanceof Set ? ownedModIds : new Set(ownedModIds || []);
    const prepared = prepareCatalog(catalogEntries);
    const mods = vortexMods.filter((m) => !owned.has(m.modId));
    const answerList = Array.isArray(answers) ? answers : [];
    const answeredFor = (entryId, m, what) => answerList.some((a) => a && a.catalogId === entryId && a.answer === what
        && (a.vortexModId === m.modId || m.names.some((n) => n.compact === a.key)));

    const sureCandidates = new Map(); // entryId -> [{modId, mod, by}]
    const addSure = (entryId, m, by) => { if (!sureCandidates.has(entryId)) sureCandidates.set(entryId, []); sureCandidates.get(entryId).push({ modId: m.modId, mod: m.mod, by }); };
    const sureMods = new Set();

    // index the Hub entries by their strong evidence and their exact forms: one pass over the Vortex list, no nested scans for the sure cases
    const byNexus = new Map(), byRepo = new Map(), byForm = new Map();
    for (const p of prepared) {
        if (p.nexusId) { if (!byNexus.has(p.nexusId)) byNexus.set(p.nexusId, []); byNexus.get(p.nexusId).push(p); }
        if (p.repo) { if (!byRepo.has(p.repo)) byRepo.set(p.repo, []); byRepo.get(p.repo).push(p); }
        for (const f of p.exact) { if (!byForm.has(f)) byForm.set(f, []); byForm.get(f).push(p); }
    }
    for (const m of mods) {
        const entries = new Map(); // entry id -> by
        if (m.nexusId) for (const p of byNexus.get(m.nexusId) || []) entries.set(p.entry.id, 'nexus id');
        for (const r of m.repos) for (const p of byRepo.get(r) || []) if (!entries.has(p.entry.id)) entries.set(p.entry.id, 'github repository');
        if (entries.size === 0) for (const n of m.names) for (const p of byForm.get(n.compact) || []) if (!entries.has(p.entry.id)) entries.set(p.entry.id, 'name');
        if (entries.size > 1 && [...entries.values()].every((b) => b === 'name')) entries.clear(); // one name fits several listings: not sure of any
        for (const [id, by] of entries) { if (!answeredFor(id, m, 'no') || by !== 'name') { addSure(id, m, by); sureMods.add(m.modId); } }
        // an earlier "Yes, same mod" counts as sure
        for (const a of answerList) if (a && a.answer === 'yes' && !entries.has(a.catalogId) && (a.vortexModId === m.modId || m.names.some((n) => n.compact === a.key))) { addSure(a.catalogId, m, 'your answer'); sureMods.add(m.modId); }
    }
    const sure = new Map();
    for (const [entryId, cands] of sureCandidates) {
        const chosen = cands.length === 1 || !pickCandidate ? cands[0] : (pickCandidate(cands.map((c) => ({ modId: c.modId, mod: c.mod }))) || cands[0]);
        const found = cands.find((c) => c.modId === chosen.modId) || cands[0];
        sure.set(entryId, { modId: found.modId, by: found.by });
    }

    // probable: only for Hub entries that are not sure, and Vortex mods that are not sure for anything
    const ask = new Map();
    const bestForMod = new Map(); // modId -> {entryId, score}
    const sureEntries = new Set(sure.keys());
    for (const m of mods) {
        if (sureMods.has(m.modId)) continue;
        const near = new Set();
        for (const n of m.names) {
            for (const w of n.words) for (const i of prepared.wordIndex.get(w) || []) near.add(i);
            if (n.compact.length >= 6) for (const i of prepared.prefixIndex.get(n.compact.slice(0, 3)) || []) near.add(i);
        }
        for (const i of near) {
            const p = prepared[i];
            if (sureEntries.has(p.entry.id)) continue;
            if (answeredFor(p.entry.id, m, 'no')) continue;
            let score = 0;
            for (const n of m.names) score = Math.max(score, closeScore(n, p));
            if (score <= 0) continue;
            const cur = bestForMod.get(m.modId);
            if (!cur || score > cur.score) bestForMod.set(m.modId, { entryId: p.entry.id, score, m });
        }
    }
    // one question per Hub listing: the best Vortex mod for it
    for (const [modId, b] of bestForMod) {
        const cur = ask.get(b.entryId);
        if (!cur || b.score > cur.score) ask.set(b.entryId, { modId, vortexName: b.m.display, score: b.score, key: b.m.names[0].compact });
    }
    return { sure, ask };
}

module.exports = { cleanVortexName, wordsOf, compact, prepareVortexMods, prepareCatalog, findPairs, closeScore, nexusIdOfUrl, githubRepoOfUrl, nexusIdOfArchiveName, displayNameOf };
