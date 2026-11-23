'use strict';
// Matches an installed plugin (from skyrimnet-install.js) to its entry in the Hub catalog
// (catalog.js). The build task's own assumption was "same plugin ids as the installed ones" --
// checked against the director's real 14 installed plugins and the real 245-entry catalog
// (2026-09-30): only 5 of 14 (36%) match by exact id. Real causes, confirmed by inspecting the
// mismatches directly: the catalog's own `author`/`id` fields are whoever SUBMITTED the listing,
// which is very often a different name than the plugin's own internal manifest `author` (e.g.
// installed "deadohiosky48.kinship" vs catalog "deadohiosky.kinship" -- the catalog entry's own
// external_url points at github.com/deadohiosky48/..., confirming it's the same person, just a
// differently-spelled handle on the two sides) -- and catalog slugs are sometimes completely
// rewritten (installed "galanx.intelengine" vs catalog
// "phospheneoverdrive.intelengine-npc-autonomy-faction-politics", three different author names
// across the installed manifest/catalog author field/catalog's own external_url owner).
//
// A plain "one normalized title contains the other" fallback (the first version of this file)
// only resolved 12/14 -- two real titles diverge in the MIDDLE, not just a prefix/suffix, which
// substring containment can't catch at all: installed "iActions for SkyrimNet" vs catalog
// "iActions [Drunk+] for SkyrimNet" (an inserted word breaks the substring relationship both
// ways), and installed "Bathing in Skyrim Renewed SN&SA Plugins" vs catalog "Bathing in Skyrim
// Renewed integration for SkyrimNet" (a shared prefix, then two genuinely different endings).
// Replaced with a significant-word-overlap check (below), re-run against the same real 14 --
// resolves all 14/14 with zero ambiguous (more-than-one-hit) cases.

const STOPWORDS = new Set(['a', 'an', 'the', 'for', 'of', 'in', 'on', 'to', 'and', 'skyrimnet']);

function normalizeTitle(title) {
    return (title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Significant words: split on real word boundaries FIRST (whitespace/-/_//), THEN strip
// punctuation within each token -- not the other way around. Splitting straight on
// "non-alphanumeric" (an earlier version of this) tokenizes a dotted acronym like "M.A.R.A.S"
// into five isolated single letters, none of which clear the 3+ character bar, losing the word
// entirely (confirmed real, live: this dropped a genuine director-installed plugin to "not on the
// Hub" even though its catalog match, "M.A.R.A.S – Marry Anyone, Rule All Skyrim", was sitting
// right there). Splitting on whitespace/hyphen/underscore/slash first keeps "M.A.R.A.S" as ONE
// token, which then strips down to "maras" (5 characters) -- a real word again. Lowercased, minus
// a short stopword list (including "skyrimnet" itself -- present in enough real titles on both
// sides, e.g. "iActions for SkyrimNet"/"SkyrimNet Kinship", that it adds no discriminating signal
// and would otherwise prop up a coincidental match between two unrelated plugins that both just
// say "SkyrimNet").
// A bracketed note ("[Drunk+]", "(beta)") is not part of the mod's name: it is dropped first (unless nothing else is left).
function withoutBracketed(title) {
    const t = String(title || '');
    const cut = t.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').trim();
    return cut ? cut : t;
}
function significantWords(title) {
    const rawTokens = withoutBracketed(title).split(/[\s\-_/]+/);
    const words = rawTokens
        .map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, ''))
        .filter((w) => w.length >= 3);
    return new Set(words.filter((w) => !STOPWORDS.has(w)));
}

// 2026-11-20 (a player's "Beast Form OStimNet Bridge" was shown as "OStimNet"): a name that merely CONTAINS another mod's name, starts with it, ends with it or has
// extra words is a different mod, so the old "one side is a full subset of the other" rule is gone. Two names relate when their significant words are the SAME set, or
// when both have words the other lacks yet share at least 60% of the smaller set with at least 2 words (a word changed in the middle of an otherwise matching
// title, see the header comment). One name inside the other never relates.
function isStrictSubset(a, b) { // every word of the smaller is in the bigger, and the bigger has more
    if (a.size === b.size) return false;
    const [small, big] = a.size < b.size ? [a, b] : [b, a];
    for (const w of small) if (!big.has(w)) return false;
    return true;
}
function titlesRelate(setA, setB) {
    if (setA.size === 0 || setB.size === 0) return false;
    let shared = 0;
    for (const w of setA) if (setB.has(w)) shared += 1;
    if (shared === setA.size && shared === setB.size) return true; // the same words
    if (isStrictSubset(setA, setB)) return false; // one name inside the other: a different mod
    const smaller = Math.min(setA.size, setB.size);
    return shared >= 2 && shared / smaller >= 0.6;
}
// A Hub title may be "Name - Subtitle" or "Name: Subtitle": each part can be the whole name of the installed mod ("M.A.R.A.S" = "M.A.R.A.S - Marry Anyone, Rule All Skyrim").
// Only an EQUAL set counts for a part, never a part inside the other name.
function titleParts(title) {
    return String(title || '').split(/\s+[-\u2013\u2014]\s+|\s*[:|]\s+/).map((x) => x.trim()).filter(Boolean);
}
function sameWords(a, b) { return a.size > 0 && a.size === b.size && [...a].every((w) => b.has(w)); }
// A title whose other part says it is a patch, bridge or add-on ("Hypnosis - SeverActions patch") is that add-on, not the mod its first part names: its parts never stand for it.
const ADDON_WORDS = new Set(['patch', 'patches', 'addon', 'addons', 'compat', 'compatibility', 'bridge', 'nsfw', 'integration', 'conversion', 'converter', 'translation', 'replacer']);
function isAddonTitle(title) { return [...significantWords(title)].some((w) => ADDON_WORDS.has(w)); }
function titlesMatch(titleA, titleB) {
    if (titlesRelate(significantWords(titleA), significantWords(titleB))) return true;
    const partsA = isAddonTitle(titleA) ? [String(titleA || '')] : titleParts(titleA), partsB = isAddonTitle(titleB) ? [String(titleB || '')] : titleParts(titleB);
    if (partsA.length < 2 && partsB.length < 2) return false;
    const wa = significantWords(titleA), wb = significantWords(titleB);
    return partsA.some((x) => sameWords(significantWords(x), wb)) || partsB.some((x) => sameWords(significantWords(x), wa))
        || (partsA.length > 1 && partsB.length > 1 && partsA.some((x) => partsB.some((y) => sameWords(significantWords(x), significantWords(y)))));
}
// Names a loose rule used to match: one name inside the other (the case that is refused now), for the log.
function looksInside(titleA, titleB) { return isStrictSubset(significantWords(titleA), significantWords(titleB)); }
const refusedLogged = new Set();

// The same mod can be published under two ids (the author's manifest id, and the id the Hub gave the listing; real: installed
// "phospheneoverdrive.sqos-patch" / Hub "phospheneoverdrive.sidequests-of-skyrim-sqos-for-skyrimnet-patch"), with titles too far apart for the word check.
// Owner and repository only, lower case: https, www, ".git", a trailing slash and "/releases/latest" or any other tail do not matter.
function githubRepoOf(u) {
    const m = /^\s*(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s#?]+)\/([^/\s#?]+)/i.exec(String(u || ''));
    return m ? (m[1] + '/' + m[2]).toLowerCase().replace(/\.git$/, '') : null;
}
// Every link a SkyrimNet manifest carries: a url-like field of its own, or the "source_mods" urls of its actions (found by walking the manifest).
const LINK_FIELDS = new Set(['url', 'homepage', 'repository', 'repo', 'github', 'source', 'source_url', 'external_url', 'link']);
function githubReposOfManifest(manifest) {
    const repos = new Set();
    const walk = (v, key, depth) => {
        if (depth > 8 || v == null) return;
        if (typeof v === 'string') { if (LINK_FIELDS.has(key)) { const r = githubRepoOf(v); if (r) repos.add(r); } return; }
        if (Array.isArray(v)) { for (const x of v) walk(x, key, depth + 1); return; }
        if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k.toLowerCase(), depth + 1);
    };
    walk(manifest, '', 0);
    return repos;
}
// The author without case, punctuation or the digits some handles end in ("deadohiosky48" = "deadohiosky").
function authorKey(a) { return String(a || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/\d+$/, ''); }
function authorsOf(author, id) { return new Set([author, String(id || '').split('.')[0]].map(authorKey).filter(Boolean)); }
// Second pass, only for an installed mod the id and title checks left unmatched: the same GitHub repository AND the same author, to exactly one Hub listing
// that nothing else claimed, which exactly that one installed mod fits. Anything else (none, two, shared) stays unmatched, with a log line.
function matchByGithubLink(plugins, catalogPlugins, results, log) {
    const claimed = new Set();
    for (const r of results.values()) if (r && r.catalogEntry) claimed.add(r.catalogEntry);
    const hubRepo = new Map();
    for (const e of catalogPlugins) { const r = githubRepoOf(e.external_url); if (r) hubRepo.set(e, r); }
    if (!hubRepo.size) return;
    const fits = new Map(); // installed id -> Hub listings
    for (const p of plugins) {
        const r = results.get(p.id);
        if (r && r.catalogEntry) continue;
        const m = p.manifest;
        if (!m) continue;
        const repos = githubReposOfManifest(m);
        if (!repos.size) continue;
        const mine = authorsOf(m.author, p.id);
        const hits = [];
        for (const [e, repo] of hubRepo) {
            if (claimed.has(e) || !repos.has(repo)) continue;
            const theirs = authorsOf(e.author, e.plugin_id || e.id);
            if ([...mine].some((a) => theirs.has(a))) hits.push(e);
        }
        if (hits.length) fits.set(p.id, hits);
    }
    const users = new Map(); // Hub listing -> installed ids that fit it
    for (const [id, hits] of fits) for (const e of hits) users.set(e, (users.get(e) || []).concat(id));
    for (const [id, hits] of fits) {
        const hubIds = hits.map((e) => e.plugin_id || e.id);
        if (hits.length > 1) { if (log) log(`catalog: ${id} fits more than one Hub entry by its GitHub link (${hubIds.join(', ')}); not matched`); continue; }
        if (users.get(hits[0]).length > 1) { if (log) log(`catalog: Hub entry ${hubIds[0]} fits more than one installed mod by its GitHub link (${users.get(hits[0]).join(', ')}); not matched`); continue; }
        results.set(id, { catalogEntry: hits[0], matchedBy: 'github', ambiguous: false });
    }
}

// plugins: installed plugins from readInstalledPlugins() (each has .id, .manifest).
// catalogPlugins: manifests from fetchCatalog().
// Returns a Map<installedId, {catalogEntry, matchedBy: 'id'|'title', ambiguous: bool}>.
// An id with every non-letter, non-digit dropped ("nosimo.and_awareness" = "nosimo.and-awareness" = "nosimoandawareness").
const looseId = (id) => String(id || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const hubIdOf = (e) => e.plugin_id || e.id;

// `records` (optional): the match records (lib/match-records.js, not stale). A recorded pair wins over the guesses below when its installed side is here and its
// Hub entry still exists and is free; an exact id match to a DIFFERENT Hub entry beats a record (the author re-published under a new id) and says so
// (`replacesRecord`). `certain` marks a match made by id or by one unique full title: the only ones the caller may write a record from.
function matchPluginsToCatalog(plugins, catalogPlugins, log, records) {
    // Keyed by the Hub's own id (plugin_id: author.slug, lower case; an entry without one falls back to its id), compared case-blind.
    const byId = new Map(catalogPlugins.map((m) => [String(m.plugin_id || m.id || '').toLowerCase(), m]));
    const results = new Map();
    // Hub entries already taken: every exact-id match first, then each match the punctuation-blind rules below make. Those rules never take a taken entry.
    const claimed = new Set();
    for (const plugin of plugins) { const exact = byId.get(String(plugin.id || '').toLowerCase()); if (exact) claimed.add(exact); }
    // Recorded pairs next (before any guess can take their Hub entry).
    const recordOf = new Map();
    for (const r of records || []) if (r && r.manifest && r.manifest.id && r.hubId) recordOf.set(String(r.manifest.id).toLowerCase(), r);
    for (const plugin of plugins) {
        const key = String(plugin.id || '').toLowerCase();
        const r = recordOf.get(key);
        if (!r) continue;
        const exact = byId.get(key);
        if (exact) { if (hubIdOf(exact).toLowerCase() !== String(r.hubId).toLowerCase()) results.set(plugin.id, { catalogEntry: exact, matchedBy: 'id', ambiguous: false, certain: true, replacesRecord: true }); continue; }
        const entry = byId.get(String(r.hubId).toLowerCase());
        if (!entry || claimed.has(entry)) continue;
        claimed.add(entry);
        results.set(plugin.id, { catalogEntry: entry, matchedBy: 'record', ambiguous: false, certain: false });
    }

    for (const plugin of plugins) {
        if (results.has(plugin.id)) continue;
        const exact = byId.get(String(plugin.id || '').toLowerCase());
        if (exact) {
            results.set(plugin.id, { catalogEntry: exact, matchedBy: 'id', ambiguous: false, certain: true });
            continue;
        }
        // Same id apart from punctuation (underscore, hyphen, dot): only a unique, free Hub entry counts.
        const loose = looseId(plugin.id);
        if (loose) {
            const idHits = catalogPlugins.filter((m) => !claimed.has(m) && looseId(hubIdOf(m)) === loose);
            if (idHits.length === 1) {
                claimed.add(idHits[0]);
                results.set(plugin.id, { catalogEntry: idHits[0], matchedBy: 'id', ambiguous: false, certain: true });
                continue;
            }
        }
        if (!plugin.manifest || !plugin.manifest.title) {
            results.set(plugin.id, { catalogEntry: null, matchedBy: null, ambiguous: false });
            continue;
        }
        // The whole title with every special character dropped ("A.N.D. Awareness" = "AND-Awareness"), before any word check can reduce an acronym to a stopword.
        const strippedTitle = normalizeTitle(plugin.manifest.title);
        if (strippedTitle) {
            const titleHits = catalogPlugins.filter((m) => !claimed.has(m) && normalizeTitle(m.title) === strippedTitle);
            if (titleHits.length === 1) {
                claimed.add(titleHits[0]);
                results.set(plugin.id, { catalogEntry: titleHits[0], matchedBy: 'title', ambiguous: false, certain: true });
                continue;
            }
        }
        let hits = catalogPlugins.filter((m) => !claimed.has(m) && titlesMatch(plugin.manifest.title, m.title)); // a Hub entry another installed mod already has is never taken twice
        if (hits.length === 0 && log) {
            for (const m of catalogPlugins) {
                if (!looksInside(plugin.manifest.title, m.title)) continue;
                const key = `${plugin.id}|${hubIdOf(m)}`; // one line per pair, not one per check
                if (refusedLogged.has(key)) continue;
                refusedLogged.add(key);
                log(`catalog: ${plugin.id} (${plugin.manifest.title}) fits the Hub entry ${hubIdOf(m)} (${m.title}) only as a longer or shorter name; not matched`);
            }
        }
        if (hits.length > 1) {
            // Several Hub titles fit the words: keep the ones by the same author as this mod (or the first part of its id).
            const mine = authorsOf(plugin.manifest.author, plugin.id);
            const sameAuthor = hits.filter((m) => { const theirs = authorsOf(m.author, hubIdOf(m)); return [...mine].some((a) => theirs.has(a)); });
            if (sameAuthor.length === 1 && !claimed.has(sameAuthor[0])) { hits = sameAuthor; claimed.add(sameAuthor[0]); }
            else if (log) log(`catalog: ${plugin.id} fits more than one Hub entry by its title (${hits.map(hubIdOf).join(', ')}); not matched`);
        }
        if (hits.length === 1) {
            claimed.add(hits[0]);
            results.set(plugin.id, { catalogEntry: hits[0], matchedBy: 'title', ambiguous: false });
        } else if (hits.length > 1) {
            results.set(plugin.id, { catalogEntry: null, matchedBy: null, ambiguous: true });
        } else {
            results.set(plugin.id, { catalogEntry: null, matchedBy: null, ambiguous: false });
        }
    }
    matchByGithubLink(plugins, catalogPlugins, results, log);
    return results;
}

module.exports = { matchPluginsToCatalog, normalizeTitle, significantWords, titlesRelate, titlesMatch };
