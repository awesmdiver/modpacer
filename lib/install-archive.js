'use strict';
// Extracts a downloaded plugin archive into a real Vortex staging folder -- FOMOD-aware (reuses
// the player's LAST recorded choices when the wizard still structurally fits; reports a mismatch
// rather than guessing when it doesn't) or, for a plain archive, Vortex's own real "Basic mode"
// root-stripping (simple-installer.js). Reuses vortex-collection-tools' own real, verified engine
// pieces (fomod-parser/choice-resolver/mod-root/simple-installer/extract-resolved-files, all
// copied into this project -- see TECHNICAL.md's Credits section) rather than reimplementing
// FOMOD replay from scratch.
//
// Deliberately NOT ported: vortex-collection-tools' own FOMOD XSD schema validation
// (fomod-schema-validator.js) and script-extender detection (irrelevant for SkyrimNet plugin
// bundles, which are never script extenders) -- a genuinely malformed ModuleConfig.xml still
// fails here, just as a plain parse error rather than a separately-classified schema violation.
// Flagged as a deliberate v1 scope trim in the handoff, not a silent gap.

const fs = require('fs');
const path = require('path');

const { findSevenZip, listArchive, extractFile } = require('./sevenzip');
const { readXmlFile, parseModuleConfig, hasUnhandledFeatures } = require('./fomod-parser');
const { resolveChoices } = require('./choice-resolver');
const { findModRoot, hasFomodInstaller } = require('./mod-root');
const { resolveSimpleInstall } = require('./simple-installer');
const { extractResolvedFiles } = require('./extract-resolved-files');
const fomodPickerData = require('./fomod-picker-data');

// Peeks just fomod/ModuleConfig.xml (not the whole archive) and parses it. Shared by planInstall
// and planInstallWithChoices below -- both need the exact same real root-finding + parse step.
async function _peekAndParseFomod(sevenZipExe, archivePath, archiveEntries) {
    const { configPath, rootPrefix } = findModRoot(archiveEntries);
    const scratchRoot = path.join(path.dirname(archivePath), '.fomod-peek');
    fs.mkdirSync(scratchRoot, { recursive: true });
    const scratchDir = fs.mkdtempSync(path.join(scratchRoot, 'peek-'));
    let parsedFomod;
    try {
        const extractedConfigPath = await extractFile(sevenZipExe, archivePath, configPath, scratchDir);
        parsedFomod = parseModuleConfig(readXmlFile(extractedConfigPath));
    } finally {
        fs.rmSync(scratchDir, { recursive: true, force: true });
    }
    if (hasUnhandledFeatures(parsedFomod)) {
        throw new Error("This mod's FOMOD installer uses a feature this tool can't check yet "
            + '(a top-level always-installed <files> block outside <installSteps>).');
    }
    return { parsedFomod, rootPrefix };
}

// Runs choice-resolver.js's resolveChoices against ALREADY-PARSED FOMOD data, re-basing archive
// entries onto rootPrefix and re-applying it to the resulting file sources -- the one real mapping
// step shared by a first attempt (planInstall, replaying OLD choices) and a wizard's fresh pick
// (planInstallWithChoices, below).
function _resolveAgainstChoices(parsedFomod, rootPrefix, archiveEntries, choices) {
    const rootPrefixLower = rootPrefix.toLowerCase();
    const relativeEntries = rootPrefix
        ? archiveEntries
            .filter((e) => e.path.toLowerCase().startsWith(`${rootPrefixLower}\\`) || e.path.toLowerCase().startsWith(`${rootPrefixLower}/`))
            .map((e) => ({ ...e, path: e.path.slice(rootPrefix.length + 1) }))
        : archiveEntries;

    // No installedFileState/installedGameVersion wiring (2026-09-30 scope trim, disclosed): those
    // only affect conditionalFileInstalls patterns gated on ANOTHER mod's plugin state or the game
    // version, which no real SkyrimNet plugin FOMOD has been seen to use -- resolveChoices' own
    // honest fallback (treat as not-matching, report via conditionWarnings) applies either way, so
    // this never silently over-includes a file; it can only under-include one it would otherwise
    // have added, and reports that it couldn't check.
    const { files, warnings, conditionWarnings } = resolveChoices(parsedFomod, choices, relativeEntries, null, null);
    return {
        files: files.map((f) => ({ source: rootPrefix ? `${rootPrefix}\\${f.source}` : f.source, destination: f.destination })),
        warnings: [...warnings, ...conditionWarnings],
    };
}

// Is this archive a FOMOD (does it carry the FOMOD module config)? A cheap listing only, nothing is
// extracted. The page uses it to word a row's button before the player presses anything.
async function archiveIsFomod(archivePath) {
    const sevenZipExe = findSevenZip();
    return hasFomodInstaller(await listArchive(sevenZipExe, archivePath));
}

// oldChoices: {type:'fomod', options} from the OLD installed mod (mod-identity.js), or undefined.
// A FOMOD is always an open FOMOD (director, 2026-10-04): the player sees the options screen on EVERY
// update, and the old recorded choices only PRE-FILL it (web/public/fomod-picker.js). So by default a FOMOD
// archive never gets a ready plan here. `replayOldChoices: true` is the one explicit opt-out, for a
// caller that is NOT a player pressing Update (no such caller exists today; the page never sets it).
// Returns one of:
//   { kind: 'fomod', files, warnings } -- only with replayOldChoices: old choices replayed cleanly.
//   { kind: 'fomod-mismatch', parsedFomod, rootPrefix, archivePath, reason } -- show the wizard;
//     reason: 'always_ask' (the normal case), 'no_recorded_choices', or 'structure_changed'.
//   { kind: 'simple', files } -- no FOMOD, Vortex's own Basic-mode root stripping.
async function planInstall(archivePath, oldChoices, { replayOldChoices = false } = {}) {
    const sevenZipExe = findSevenZip();
    const archiveEntries = await listArchive(sevenZipExe, archivePath);
    const archiveHasFomod = hasFomodInstaller(archiveEntries);
    const hadFomodChoices = !!(oldChoices && oldChoices.type === 'fomod');

    if (!archiveHasFomod) {
        return { kind: 'simple', files: resolveSimpleInstall(archiveEntries) };
    }

    const { parsedFomod, rootPrefix } = await _peekAndParseFomod(sevenZipExe, archivePath, archiveEntries);

    if (!hadFomodChoices) {
        // A real FOMOD wizard, but nothing recorded to replay -- never guess a first-time choice.
        return { kind: 'fomod-mismatch', parsedFomod, rootPrefix, archivePath, reason: 'no_recorded_choices' };
    }
    if (!replayOldChoices) {
        // The old choices pre-fill the screen; they never install anything by themselves.
        return { kind: 'fomod-mismatch', parsedFomod, rootPrefix, archivePath, reason: 'always_ask' };
    }

    const { files, warnings } = _resolveAgainstChoices(parsedFomod, rootPrefix, archiveEntries, oldChoices);

    // "No recorded choices for installStep/group" is choice-resolver.js's own real signal that
    // the wizard's structure no longer matches what was recorded -- exactly the "show the wizard
    // again" case the task asked for, not a guess.
    const structuralMismatch = warnings.some((w) => w.startsWith('No recorded choices for'));
    if (structuralMismatch) {
        return { kind: 'fomod-mismatch', parsedFomod, rootPrefix, archivePath, reason: 'structure_changed', warnings };
    }

    return { kind: 'fomod', files, warnings };
}

// The wizard's own "Finish" step (queue: updater-v1-polish, 2026-09-30) -- takes the FRESH choices
// the player just made (see planInstallWithPicks) and resolves them the exact same way a clean
// old-choices replay would, skipping the mismatch check entirely (the player just chose against
// THIS archive's own current structure, by construction, so there is nothing left to mismatch
// against -- any leftover "No recorded choices" warning at this point would mean a real bug in
// how the wizard's own choices were built, not a stale recording, so it's surfaced as a thrown
// error rather than silently ignored).
async function planInstallWithChoices(archivePath, freshChoices) {
    const sevenZipExe = findSevenZip();
    const archiveEntries = await listArchive(sevenZipExe, archivePath);
    const { parsedFomod, rootPrefix } = await _peekAndParseFomod(sevenZipExe, archivePath, archiveEntries);
    const { files, warnings } = _resolveAgainstChoices(parsedFomod, rootPrefix, archiveEntries, freshChoices);
    const structuralMismatch = warnings.some((w) => w.startsWith('No recorded choices for'));
    if (structuralMismatch) {
        throw new Error("Couldn't match your choices to this installer's real structure -- this looks like a bug, not a stale recording.");
    }
    return { kind: 'fomod', files, warnings };
}

async function extractPlan(plan, archivePath, destDir) {
    if (plan.kind !== 'fomod' && plan.kind !== 'simple') {
        throw new Error(`Cannot extract a "${plan.kind}" plan directly -- resolve the mismatch first.`);
    }
    const sevenZipExe = findSevenZip();
    const scratchRoot = path.join(path.dirname(destDir), '.extract-scratch');
    const skipped = await extractResolvedFiles(sevenZipExe, archivePath, plan.files, destDir, scratchRoot);
    fs.rmSync(scratchRoot, { recursive: true, force: true });
    return { skipped };
}

// The picker's own answers ({[stepIdx]: {[groupIdx]: number[]}}, plugin indices) -> the install plan. Builds the recorded
// choices from the CURRENT archive's own parsed FOMOD, then resolves them like any other fresh choice. Returns the plan
// plus the choices (they are what gets recorded on the new mod).
async function planInstallWithPicks(archivePath, picks) {
    const sevenZipExe = findSevenZip();
    const archiveEntries = await listArchive(sevenZipExe, archivePath);
    const { parsedFomod, rootPrefix } = await _peekAndParseFomod(sevenZipExe, archivePath, archiveEntries);
    const choices = fomodPickerData.buildFomodChoicesFromPicks(parsedFomod, picks);
    const { files, warnings } = _resolveAgainstChoices(parsedFomod, rootPrefix, archiveEntries, choices);
    if (warnings.some((w) => w.startsWith('No recorded choices for'))) {
        throw new Error("Couldn't match your choices to this installer's real structure -- this looks like a bug, not a stale recording.");
    }
    return { plan: { kind: 'fomod', files, warnings }, choices };
}

// Everything the picker screen needs for one archive: the parsed FOMOD, and its preview images extracted and registered
// under `modId` (undefined token when it has none).
async function prepareFomodScreen(archivePath, modId) {
    const sevenZipExe = findSevenZip();
    const archiveEntries = await listArchive(sevenZipExe, archivePath);
    const { parsedFomod, rootPrefix } = await _peekAndParseFomod(sevenZipExe, archivePath, archiveEntries);
    const imageCacheToken = await fomodPickerData.extractAndRegisterFomodImages(sevenZipExe, archivePath, archiveEntries, parsedFomod, rootPrefix, modId);
    return { parsedFomod, imageCacheToken };
}

module.exports = { archiveIsFomod, planInstall, planInstallWithChoices, planInstallWithPicks, prepareFomodScreen, extractPlan };
