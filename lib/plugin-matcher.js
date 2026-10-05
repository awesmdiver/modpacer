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
function significantWords(title) {
    const rawTokens = (title || '').split(/[\s\-_/]+/);
    const words = rawTokens
        .map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, ''))
        .filter((w) => w.length >= 3);
    return new Set(words.filter((w) => !STOPWORDS.has(w)));
}

// True if either word set is a (non-empty) subset of the other, OR they overlap by at least 60%
// of the SMALLER set's size with at least 2 words shared -- catches a word inserted/changed in
// the middle of an otherwise-matching title (see header comment) without being so loose that two
// genuinely different plugins that merely share one common word (e.g. both mention "Skyrim")
// would ever match.
function titlesRelate(setA, setB) {
    if (setA.size === 0 || setB.size === 0) return false;
    let shared = 0;
    for (const w of setA) if (setB.has(w)) shared += 1;
    const smaller = Math.min(setA.size, setB.size);
    if (shared === smaller) return true; // one side is a full subset of the other
    return shared >= 2 && shared / smaller >= 0.6;
}

// plugins: installed plugins from readInstalledPlugins() (each has .id, .manifest).
// catalogPlugins: manifests from fetchCatalog().
// Returns a Map<installedId, {catalogEntry, matchedBy: 'id'|'title', ambiguous: bool}>.
function matchPluginsToCatalog(plugins, catalogPlugins) {
    // Keyed by the Hub's own id (plugin_id: author.slug, lower case; an entry without one falls back to its id), compared case-blind.
    const byId = new Map(catalogPlugins.map((m) => [String(m.plugin_id || m.id || '').toLowerCase(), m]));
    const results = new Map();

    for (const plugin of plugins) {
        const exact = byId.get(String(plugin.id || '').toLowerCase());
        if (exact) {
            results.set(plugin.id, { catalogEntry: exact, matchedBy: 'id', ambiguous: false });
            continue;
        }
        if (!plugin.manifest || !plugin.manifest.title) {
            results.set(plugin.id, { catalogEntry: null, matchedBy: null, ambiguous: false });
            continue;
        }
        const installedWords = significantWords(plugin.manifest.title);
        const hits = catalogPlugins.filter((m) => titlesRelate(installedWords, significantWords(m.title)));
        if (hits.length === 1) {
            results.set(plugin.id, { catalogEntry: hits[0], matchedBy: 'title', ambiguous: false });
        } else if (hits.length > 1) {
            results.set(plugin.id, { catalogEntry: null, matchedBy: null, ambiguous: true });
        } else {
            results.set(plugin.id, { catalogEntry: null, matchedBy: null, ambiguous: false });
        }
    }
    return results;
}

module.exports = { matchPluginsToCatalog, normalizeTitle, significantWords, titlesRelate };
