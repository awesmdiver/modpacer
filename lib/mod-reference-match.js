// ModPacer -- free software under the GNU General Public License, version 3 only (see LICENSE).
// This file contains code ported from Vortex (https://github.com/Nexus-Mods/Vortex, Black Tree Gaming Ltd. / Nexus Mods):
// src/extensions/mod_management/util/testModReference.ts, coerceToSemver.ts and isFuzzyVersion.ts, GPL-3.0. It is distributed WITHOUT ANY WARRANTY;
// see the GNU General Public License for details. Full list: THIRD-PARTY-NOTICES.md.
'use strict';
// Faithful port of Vortex's own mod-reference matching -- whether a collection rule's `reference`
// identifies a given installed mod -- from Nexus-Mods/Vortex's
// src/extensions/mod_management/util/testModReference.ts (+ coerceToSemver.ts, isFuzzyVersion.ts),
// GNU GPLv3, see Credits (queue: recognize-collections-by-vortex-name, 2026-10-01).
//
// This is NOT vortex-collection-tools' own, much simpler ruleReferenceIdentity/makeIdentityMatcher
// (lib/vortex-sync/lib.js, already credited elsewhere in this project) -- that only ever compares
// fileMD5, Nexus modId+fileId, and tag. Real reported bug: a personal collection ("SkyrimNet", the
// director's own real install) references every one of its 58 members by PLAIN Vortex mod id --
// `{"reference":{"id":"BioForge-1.0.0"}}`, nothing else -- which the simpler matcher never
// recognized at all, so Update would silently drop a mod out of its own collection on every single
// swap. Identical results to Vortex's own Collection column is the bar here, not "close enough",
// hence this verbatim-logic port (id / fileMD5 / logicalFileName+fileExpression / Nexus repo /
// tag / versionMatch) rather than one more special case bolted onto the simpler one.
//
// Deliberately trimmed from the original: the `source`/`onRefResolved` telemetry-callback
// parameters (an internal Vortex cache-invalidation hook, never relevant to a one-shot read-only
// match here) and the already-flattened-IModLookupInfo input branch of `modAttributesToLookupInfo`
// (the Vortex Bridge's own getAllMods() response is always a raw mod record with
// `.attributes`, never that already-flat shape) are both left out as genuinely dead code for this
// project's one real input shape -- everything that can actually run against real data here is
// ported as-is.

const path = require('path');
const semver = require('semver');
const { minimatch } = require('minimatch');

function truthy(v) {
    return !!v;
}

// coerceToSemver.ts, ported verbatim.
const COERCEABLE_RE = /^v?[0-9.]+$/;
function coerceToSemver(version) {
    version = version && typeof version.trim === 'function' ? version.trim() : version;
    if (!version) return undefined;
    const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version);
    if (match) {
        const [, major, minor, patch] = match;
        let preRelease = match[4].trim();
        if (preRelease) {
            preRelease = preRelease.replace(/^[.\-+]/, '');
            return `${major}.${minor}.${patch}-${preRelease}`;
        }
        return `${major}.${minor}.${patch}`;
    }
    if (COERCEABLE_RE.test(version)) {
        const sanitized = version.replace(/\b0+(\d)/g, '$1');
        const coerced = semver.coerce(sanitized);
        return coerced ? coerced.version : version;
    }
    return undefined;
}
function safeCoerce(input) {
    return COERCEABLE_RE.test(input) ? (coerceToSemver(input) || input) : input;
}

// isFuzzyVersion.ts, ported verbatim minus its module-level memo cache -- this project's own call
// volume (one collection scan per Update, never a UI redraw loop) never needs it.
function isFuzzyVersion(input) {
    if (!input || typeof input !== 'string') return false;
    if (input.endsWith('+prefer') || input === '*') return true;
    // semver.validRange accepts partial versions as ranges ("1.5" ~ "1.5.x"), which a
    // non-semantic version where "1.5" should match only exactly "1.5" can't afford.
    const coerced = safeCoerce(input);
    const valRange = semver.validRange(coerced);
    return valRange !== null && valRange !== coerced;
}

// modAttributesToLookupInfo, trimmed to this project's one real input shape (see header comment).
function modAttributesToLookupInfo(mod) {
    const attrs = mod.attributes || {};
    return {
        id: mod.id,
        fileMD5: attrs.fileMD5,
        fileName: attrs.fileName || attrs.modName || attrs.name,
        name: attrs.modName || attrs.name,
        logicalFileName: attrs.logicalFileName,
        additionalLogicalFileNames: attrs.additionalLogicalFileNames,
        customFileName: attrs.customFileName,
        version: attrs.version || attrs.modVersion || '',
        game: attrs.game,
        fileId: attrs.fileId != null ? String(attrs.fileId) : undefined,
        modId: attrs.modId != null ? String(attrs.modId) : undefined,
        source: attrs.source,
        referenceTag: attrs.referenceTag,
        referenceTags: attrs.referenceTags,
    };
}

// test if the reference is by id only, meaning it is only useful in the current setup
function idOnlyRef(ref) {
    if (!ref || ref.id === undefined) return false;
    const keys = Object.keys(ref).filter((k) => k !== 'archiveId' && k !== 'versionMatch' && k !== 'idHint');
    return keys.length === 1;
}

function sanitizeExpression(fileName) {
    if (fileName == null || typeof fileName !== 'string') return '';
    // drop extension and anything like ".1" or " (1)" at the end, which probably indicates
    // duplicate downloads (either Vortex's own format or common browser style).
    return path.basename(fileName, path.extname(fileName))
        .replace(/\.\d+$/, '')
        .replace(/ \(\d+\)$/, '');
}

function hasIdentifyingMarker(mod, modId, ref, fuzzyVersion, allowTag) {
    return (
        (ref.id !== undefined && modId !== undefined) ||
        (!fuzzyVersion && ref.fileMD5 !== undefined && mod.fileMD5 !== undefined) ||
        (ref.fileExpression !== undefined && (mod.fileName != null ? mod.fileName : mod.name) !== undefined) ||
        (ref.logicalFileName !== undefined && mod.logicalFileName !== undefined) ||
        (ref.repo !== undefined && mod.source !== undefined) ||
        (allowTag && ref.tag !== undefined && (mod.referenceTag !== undefined || (mod.referenceTags && mod.referenceTags.length > 0)))
    );
}

function testRef(mod, modId, ref) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return false;

    // if an id is set, it has to match
    if (ref.id != null && (modId != null || idOnlyRef(ref)) && ref.id !== modId) return false;

    const fuzzyVersion = isFuzzyVersion(ref.versionMatch);

    if (!hasIdentifyingMarker(mod, modId, ref, fuzzyVersion, true)) {
        // the reference doesn't have any marker that _could_ match this mod -- refuse rather than
        // matching any random mod that also has no matching marker.
        return false;
    }

    if (ref.tag != null) {
        // an archive shared between collections carries a tag per rule, so any of them is a hit
        if (mod.referenceTag === ref.tag || (mod.referenceTags && mod.referenceTags.includes(ref.tag))) {
            return true;
        }
        // tags differ. if the mod has no stricter attribute we have to refuse here, otherwise
        // we'd match any kind of crap.
        if (!hasIdentifyingMarker(mod, modId, ref, fuzzyVersion, false)) return false;
    }

    // if reference is by file hash and the match is not fuzzy, require the md5 to match
    if (truthy(ref.fileMD5) && !fuzzyVersion && mod.fileMD5 !== ref.fileMD5) return false;

    if (ref.repo != null) {
        if (ref.repo.repository !== mod.source || ref.repo.modId !== String(mod.modId || -1)) return false;
        if (!fuzzyVersion) {
            // same repo and modId; same fileId too means this is definitively the same file
            return ref.repo.fileId === String(mod.fileId || -1);
        }
    } else if (ref.fileMD5 && ref.fileMD5 === mod.fileMD5) {
        // no repo info means this is an external reference -- a matching MD5 identifies the file,
        // that's good enough.
        return true;
    }

    // right file?
    if (ref.logicalFileName != null) {
        if (mod.additionalLogicalFileNames != null) {
            if (!mod.additionalLogicalFileNames.includes(ref.logicalFileName)
                && ![mod.logicalFileName, mod.customFileName].includes(ref.logicalFileName)
                && ref.fileExpression == null) {
                return false;
            }
        } else if (![mod.logicalFileName, mod.customFileName].includes(ref.logicalFileName) && ref.fileExpression == null) {
            return false;
        }
    }

    if (ref.fileExpression != null) {
        // file expression is either an exact match against the mod name or a glob match against
        // the archive name (without file extension)
        if (mod.fileName == null) {
            if (mod.name !== ref.fileExpression) return false;
        } else {
            const baseName = sanitizeExpression(mod.fileName);
            if (baseName !== ref.fileExpression && !minimatch(baseName, ref.fileExpression)) return false;
        }
    }

    // right version?
    if (truthy(ref.versionMatch) && ref.versionMatch !== '*' && truthy(mod.version)) {
        const versionMatch = ref.versionMatch.split('+')[0];
        const doesMatch = mod.version === ref.versionMatch
            || ref.fileMD5 === mod.fileMD5
            || safeCoerce(mod.version) === safeCoerce(versionMatch);
        if (!doesMatch) {
            const versionCoerced = coerceToSemver(mod.version);
            if (semver.valid(versionCoerced)) {
                if (!semver.satisfies(versionCoerced, versionMatch, { loose: true, includePrerelease: true })) return false;
            } else {
                // the version number can't be interpreted -- only an exact match counts
                return false;
            }
        }
    }

    // right game?
    if (ref.gameId !== undefined && mod.game !== undefined && mod.game.indexOf(ref.gameId) === -1) return false;

    return true;
}

// testModReference's own public entry (mod is always a raw Vortex mod record here).
function testModReference(mod, reference) {
    if (mod == null || typeof mod !== 'object' || Array.isArray(mod)) return false;
    if (reference == null || typeof reference !== 'object' || Array.isArray(reference)) return false;
    return testRef(modAttributesToLookupInfo(mod), mod.id, reference);
}

// findRuleByRef, ported -- which of a collection's own rules identifies this mod.
function findRuleByRef(rules, mod) {
    if (!Array.isArray(rules) || mod == null) return undefined;
    const lookup = modAttributesToLookupInfo(mod);
    return rules.find((rule) => testRef(lookup, mod.id, rule.reference));
}

module.exports = {
    testModReference, findRuleByRef, modAttributesToLookupInfo, sanitizeExpression, idOnlyRef,
    isFuzzyVersion, coerceToSemver, safeCoerce,
};
