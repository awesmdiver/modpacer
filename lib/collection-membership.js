// ModPacer -- free software under the GNU General Public License, version 3 only (see LICENSE).
// This file contains code ported from Vortex (https://github.com/Nexus-Mods/Vortex, Black Tree Gaming Ltd. / Nexus Mods):
// src/renderer/src/extensions/collections/index.ts (generateCollectionMap) and src/extensions/mod_management/util/findModByRef.ts, GPL-3.0. It is distributed
// WITHOUT ANY WARRANTY; see the GNU General Public License for details. Full list: THIRD-PARTY-NOTICES.md.
'use strict';
// Which collections a mod is in, worked out the way Vortex itself does it (queue: an-update-keeps-the-collections-the-mod-is-in, 2026-10-05).
//
// Where membership is stored (confirmed in Vortex's own source, src/renderer/src/extensions/collections/index.ts, and mirrored by Vortex
// Collection Tools: lib/state-query-worker.js scanAllCollections, lib/collection-runner.js, lib/add-mods-to-collections.js isAlreadyInCollection):
// a mod's own record has NO field naming its collections. The Mods page's "Collection" column (generateCollectionMap) is computed from the
// COLLECTION mods' own `rules` lists: for every collection mod, for every rule in it (whatever its type),
//   - a rule whose `reference.id` is set puts exactly that mod id in the collection -- no other field of the reference is looked at;
//   - any other rule is matched to an installed mod by content (findModByRef: idHint, md5Hint, then the first mod testModReference accepts).
// ModPacer used to ask a stricter question (testModReference on every rule, requires/recommends rules only, first rule per collection), which
// misses a rule that names the mod by id but also carries a hash or version that no longer matches, so a mod Vortex shows in a collection could
// look like it was in none. This file is that algorithm, for one mod at a time.

const modRefMatch = require('./mod-reference-match');

// findModByRef.ts, ported (no install spec): the mod a content reference points at, or undefined.
function findModByRef(reference, mods) {
    if (!reference) return undefined;
    const matches = (mod) => mod != null && modRefMatch.testModReference(mod, reference);
    if (reference.idHint !== undefined && matches(mods[reference.idHint])) return mods[reference.idHint];
    let ref = reference;
    if (ref.versionMatch !== undefined && modRefMatch.isFuzzyVersion(ref.versionMatch) && ref.fileMD5 !== undefined
        && (ref.logicalFileName !== undefined || ref.fileExpression !== undefined)) {
        ref = { md5Hint: ref.fileMD5, ...ref };
        delete ref.fileMD5;
    }
    if (ref.md5Hint !== undefined) {
        const id = Object.keys(mods).find((k) => mods[k] && mods[k].attributes && mods[k].attributes.fileMD5 === ref.md5Hint);
        if (id !== undefined) return mods[id];
    }
    return Object.values(mods).find((mod) => mod != null && modRefMatch.testModReference(mod, ref));
}

// Does this rule put `modId` in its collection, by Vortex's own rule?
function ruleHoldsMod(rule, modId, allMods) {
    const ref = rule && rule.reference;
    if (!ref || typeof ref !== 'object') return false;
    if (ref.id !== undefined) return ref.id === modId;
    const record = allMods[modId];
    if (!record || !modRefMatch.testModReference(record, ref)) return false; // cheap exit: the mod itself does not match, so it is not the one found
    const found = findModByRef(ref, allMods);
    return found === record || (!!found && found.id === modId);
}

// [{ collectionModId, rules: [every rule of that collection that puts modId in it] }], one entry per collection, in the Bridge's order.
function membershipOf(modId, allMods) {
    const out = [];
    if (!allMods || !allMods[modId]) return out;
    for (const [collectionModId, coll] of Object.entries(allMods)) {
        if (!coll || coll.type !== 'collection' || collectionModId === modId) continue;
        const rules = (Array.isArray(coll.rules) ? coll.rules : []).filter((rule) => ruleHoldsMod(rule, modId, allMods));
        if (rules.length > 0) out.push({ collectionModId, rules });
    }
    return out;
}

// A collection's display name the way the Mods page shows it.
function collectionName(allMods, collectionModId) {
    const a = (allMods[collectionModId] && allMods[collectionModId].attributes) || {};
    return a.customFileName || a.name || collectionModId;
}

module.exports = { findModByRef, ruleHoldsMod, membershipOf, collectionName };
