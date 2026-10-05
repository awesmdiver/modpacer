'use strict';
// Server side of the FOMOD picker screen (web/public/fomod-picker.js): the preview images and the picks -> recorded
// choices step. Ported from vortex-collection-tools' own lib/fomod-picker-data.js (same author); keep the two in step
// (see TECHNICAL.md). What is NOT ported: its detectFomodChoiceNeed (this app's own install-archive.js already finds and
// parses the FOMOD) and the XSD validation gate (disclosed scope trim, see install-archive.js).
//
// Preview images: every image a plugin names is extracted up front into one scratch folder per mod, and the page reads
// them through GET /api/fomod-image -- a plain <img src>, the way Vortex's own wizard shows a file already on disk.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { extractMany } = require('./sevenzip');

// modId (here: the plugin id) -> { dir, rootPrefix, token }. One live entry per mod: a newer one replaces (and deletes) the old scratch folder.
const fomodImageCache = new Map();

// Every plugin's own <image path="..."/> across every step and group, deduped.
function collectFomodImagePaths(parsedFomod) {
    const paths = new Set();
    for (const step of parsedFomod.installSteps) {
        for (const group of step.groups) {
            for (const plugin of group.plugins) {
                if (plugin.image) paths.add(plugin.image);
            }
        }
    }
    return [...paths];
}

// Windows semantics: an archive's casing rarely matches ModuleConfig.xml's, and '/' and '\' get mixed.
function normalizePathForMatch(p) {
    return p.replace(/\//g, '\\').toLowerCase();
}

// Returns a fresh opaque token stored with the entry. The page hands it back on cleanup, so a cleanup for an OLD
// registration can never delete the folder of a newer one for the same mod.
function registerFomodImages(modId, dir, rootPrefix) {
    const key = String(modId);
    const prior = fomodImageCache.get(key);
    if (prior && prior.dir !== dir) fs.rmSync(prior.dir, { recursive: true, force: true });
    const token = crypto.randomUUID();
    fomodImageCache.set(key, { dir, rootPrefix: rootPrefix || '', token });
    return token;
}

// Best-effort: a no-op unless `token` is the CURRENT registration for this mod; never throws.
function releaseFomodImages(modId, token) {
    const key = String(modId);
    const entry = fomodImageCache.get(key);
    if (!entry || !token || entry.token !== token) return;
    fomodImageCache.delete(key);
    try { fs.rmSync(entry.dir, { recursive: true, force: true }); } catch { /* disk hygiene only */ }
}

// A requested image (the FOMOD's own path, relative to the mod root) -> the extracted file, or null when nothing is
// registered, the file is missing, or the path would climb out of the scratch folder.
function serveFomodImage(modId, imagePath) {
    const entry = fomodImageCache.get(String(modId));
    if (!entry || !imagePath) return null;
    const resolved = path.normalize(path.join(entry.dir, entry.rootPrefix, imagePath));
    const base = path.normalize(entry.dir + path.sep);
    if (!resolved.startsWith(base)) return null;
    return fs.existsSync(resolved) ? resolved : null;
}

// Extracts exactly the images the FOMOD's plugins reference (matched to the real archive listing case-insensitively;
// one an author mislabelled is simply skipped) and registers them. Returns the cache token, or undefined when there is
// nothing to show. Best-effort: a failure never blocks the screen, the picture just isn't there.
async function extractAndRegisterFomodImages(sevenZipExe, archivePath, entries, parsedFomod, rootPrefix, modId) {
    const entryPathByNormalized = new Map(entries.filter((e) => !e.isDir).map((e) => [normalizePathForMatch(e.path), e.path]));
    const wanted = [];
    for (const imagePath of collectFomodImagePaths(parsedFomod)) {
        const fullPath = rootPrefix ? `${rootPrefix}\\${imagePath}` : imagePath;
        const realPath = entryPathByNormalized.get(normalizePathForMatch(fullPath));
        if (realPath && !wanted.includes(realPath)) wanted.push(realPath);
    }
    if (wanted.length === 0) return undefined;
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fomod-picker-images-'));
    try {
        await extractMany(sevenZipExe, archivePath, wanted, scratchDir);
        return registerFomodImages(modId, scratchDir, rootPrefix);
    } catch {
        fs.rmSync(scratchDir, { recursive: true, force: true });
        return undefined;
    }
}

// The player's picks -> the recorded-choices shape ({type:'fomod', options}) the install path already consumes. One
// entry per raw step in document order and EVERY group (an empty one as `choices: []`), so resolveChoices never logs a
// spurious "no recorded choices". A SelectAll group always includes every plugin.
// `picks`: { [stepIdx]: { [groupIdx]: number[] } }.
function buildFomodChoicesFromPicks(parsedFomod, picks) {
    const options = parsedFomod.installSteps.map((step, stepIdx) => ({
        name: step.name,
        groups: step.groups.map((group, groupIdx) => {
            const selectedIndices = group.type === 'SelectAll'
                ? group.plugins.map((_, idx) => idx)
                : (picks && picks[stepIdx] && picks[stepIdx][groupIdx]) || [];
            return {
                name: group.name,
                choices: selectedIndices
                    .filter((idx) => group.plugins[idx])
                    .map((idx) => ({ idx, name: group.plugins[idx].name })),
            };
        }),
    }));
    return { type: 'fomod', options };
}

module.exports = { collectFomodImagePaths, registerFomodImages, releaseFomodImages, serveFomodImage, extractAndRegisterFomodImages, buildFomodChoicesFromPicks };
