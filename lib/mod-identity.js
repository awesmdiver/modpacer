'use strict';
// Adapted from vortex-collection-tools' own lib/build-mod-from-vortex-state.js (2026-09-30,
// credited in TECHNICAL.md) -- only the LIVE-HELPER path (buildModFromLiveData/shapeMod) is
// needed here; this app never reads Vortex's state.v2 database directly (that requires Vortex
// closed, which this feature explicitly does not), so the state.v2-backed half of that file
// (buildModFromVortexState/readModFromOpenDb) was left out rather than copied unused.
//
// Turns one live Vortex mod record (from vortex-helper-client.js's getAllMods()) into
// {name, source, choices} -- source.md5/modId/fileId/fileSize/version is this mod's own recorded
// identity (used both to find its Collection membership rule and, for a FOMOD, `choices` is
// exactly what it chose during its own install, replayed onto the new version).

function shapeMod(record, vortexModId) {
    const {
        customFileName, logicalFileName, source, modId, fileId, fileSize, fileMD5, version,
        installerChoicesType, installerChoicesOptions,
    } = record;
    const name = customFileName || logicalFileName || vortexModId;
    const choices = installerChoicesType === 'fomod'
        ? { type: installerChoicesType, options: installerChoicesOptions }
        : undefined;
    return {
        name,
        source: {
            type: source === 'nexus' ? 'nexus' : 'offsite',
            modId, fileId, fileSize, md5: fileMD5, version, logicalFilename: logicalFileName,
        },
        choices,
    };
}

// `mods`: the raw `data.mods` object from getAllMods(). Returns null (not a throw -- this app's
// own callers already treat "mod not found" as a normal, expected outcome, unlike VCT's own
// stricter contract) when vortexModId isn't a real live mod.
function buildModFromLiveData(mods, vortexModId) {
    const raw = mods[vortexModId];
    if (!raw) return null;
    const attrs = raw.attributes || {};
    return shapeMod({
        customFileName: attrs.customFileName,
        logicalFileName: attrs.logicalFileName,
        source: attrs.source,
        modId: attrs.modId,
        fileId: attrs.fileId,
        fileSize: attrs.fileSize,
        fileMD5: attrs.fileMD5,
        version: attrs.version,
        installerChoicesType: attrs.installerChoices ? attrs.installerChoices.type : undefined,
        installerChoicesOptions: attrs.installerChoices ? attrs.installerChoices.options : undefined,
    }, vortexModId);
}

module.exports = { buildModFromLiveData, shapeMod };
