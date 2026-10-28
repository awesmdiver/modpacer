'use strict';
// "Keep every downloaded version. Never delete an old download... Name files so versions don't
// overwrite each other." A GitHub release asset's own filename usually does NOT carry the plugin
// version (e.g. "SeverActions.7z" -- confirmed against every real example this session), so this
// inserts it before the extension. A Nexus download doesn't need this: Nexus's own file_name
// already bakes in "-<modId>-<version>-<uploadedTimestamp>" (see lib/nexus.js's header comment),
// so two different versions never collide on their own.
//
// Rewritten (queue: updates-keep-rules-clean-old-version, 2026-10-01) -- the old version always
// injected the NEW version into the name, which reads fine when the asset's own name carries no
// version at all ("SeverActions.7z" -> "SeverActions-3.10.0.7z") but produces nonsense when the
// author's own asset name already carries a DIFFERENT (older, or just differently-formatted)
// version string: a real update (iActions 0.6.6 -> 0.6.7) downloaded an asset literally named
// "iActions-0.6.6.zip" -- the author's own release-asset naming lagging the version bump inside the
// archive -- and the old code's own "already versioned, leave it alone" check only looked for the
// NEW version's string inside the name, so it appended the new one anyway: "iActions-0.6.6-0.6.7.zip",
// a file that reads like it's FROM the old version. Vortex's own real downloads never do this --
// it saves a download under the file name it was actually given.
//
// The fix: trust the release's own asset file name as-is (same as Vortex itself), and only
// synthesize a name when the asset's own name is empty or one of GitHub's own generic auto-names
// ("Source code.zip" and similar) that carries no real plugin identity at all. "Never overwrite an
// old download" is still honored, just moved to where it actually matters: uniqueFileName() below
// checks the real destination folder at save time and only disambiguates if something's already
// there under that exact name -- the common case (first time downloading this release) gets the
// clean name, and an actual collision still never overwrites anything.

const fs = require('fs');
const path = require('path');

const GENERIC_ASSET_NAMES = /^(source[ _-]?code|release|latest|download|archive|main|master)$/i;

function sanitizeForFileName(value) {
    return String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

// Why a release's own file name cannot be used as a path part (null when it is fine). Only a plain single name passes:
// no separators, "..", drive letter, trailing dot or space, Windows reserved name, control character or length over 150.
function unsafeNameReason(name) {
    if (typeof name !== 'string' || !name.trim()) return 'empty';
    if (name.length > 150) return 'too long';
    if (/[\x00-\x1f]/.test(name)) return 'control character';
    if (/[\\/]/.test(name)) return 'path separator';
    if (name.includes('..')) return 'dot-dot';
    if (/^[A-Za-z]:/.test(name)) return 'drive letter';
    if (/[<>:"|?*]/.test(name)) return 'character Windows refuses';
    if (/[. ]$/.test(name)) return 'trailing dot or space';
    if (WINDOWS_RESERVED.test(name)) return 'Windows reserved name';
    return null;
}

// The release asset's own name, unless it carries no real identity -- then <title>-<version>.<ext>,
// exactly the fallback format the task asked for. A name that is not a safe plain file name is never used: it becomes
// <mod id><ext> (onUnsafe(name, reason, used) says so, for the log).
function chooseDownloadFileName(rawAssetName, { pluginTitle, newVersion, pluginId, onUnsafe } = {}) {
    const assetName = String(rawAssetName || '');
    const reason = unsafeNameReason(assetName);
    if (reason) {
        const e = path.extname(assetName.split(/[\\/]/).pop()).toLowerCase();
        const ext = /^\.[a-z0-9]{1,5}$/.test(e) ? e : '.zip';
        const safeId = sanitizeForFileName(pluginId || pluginTitle || 'plugin').replace(/\.\.+/g, '_').replace(/[. ]+$/, '') || 'plugin';
        const used = `${safeId.slice(0, 100)}${ext}`;
        if (typeof onUnsafe === 'function') onUnsafe(assetName, reason, used);
        return used;
    }
    const ext = path.extname(assetName) || '.zip';
    const base = assetName.slice(0, assetName.length - ext.length).trim();
    if (base && !GENERIC_ASSET_NAMES.test(base)) return assetName;
    const safeName = sanitizeForFileName(pluginTitle || 'plugin') || 'plugin';
    const safeVersion = sanitizeForFileName(newVersion || 'unknown') || 'unknown';
    return `${safeName}-${safeVersion}${ext}`;
}

// Windows-Explorer-style "(1)", "(2)", ... suffix -- same convention this project already uses in
// lib/vortex-update.js's own resolveAvailableModId, for the same reason: there's no headless
// equivalent of Vortex's own "replace / keep both" prompt to fall back to.
function uniqueFileName(destDir, candidate) {
    if (!fs.existsSync(path.join(destDir, candidate))) return candidate;
    const ext = path.extname(candidate);
    const base = candidate.slice(0, candidate.length - ext.length);
    for (let n = 1; ; n++) {
        const next = `${base} (${n})${ext}`;
        if (!fs.existsSync(path.join(destDir, next))) return next;
    }
}

module.exports = { unsafeNameReason, chooseDownloadFileName, uniqueFileName, sanitizeForFileName };
