'use strict';
// "An installed mod that ModPacer cannot verify is a real mod can be excluded" (2026-11-19). A hand-made stand-in (two empty 66-byte plugins in a zip called
// "MARAS.Stub.zip") never matches its Hub listing by name, yet the listing reads as installed and is offered an Update the person does not want. Such a row
// gets the Exclude link; an ordinary installed mod never does. This file only READS and decides; nothing here touches Vortex, Mod Organizer 2 or any file.
//
// A row counts as UNVERIFIED only on weak evidence, by one of three checks (the first that holds names the reason):
//   1. 'placeholder': every plugin the mod-manager record behind the row holds is header-only (lib/dummy-master.js `headerOnlyFolder`), and the record's name
//      is not a name match for the listing.
//   2. 'registry-only': the row is installed only because SkyrimNet's own list says so: no mod-manager record behind it (no Vortex owner, no pairing by name,
//      no Mod Organizer 2 folder), and no mod record anywhere in the (fully read) mod list whose name matches the listing.
//   3. 'no-version': the record behind the row has no version at all (not recorded, not in the archive's name) and its name is not a name match for the listing.
// A missing answer is never weak evidence: no listing, a remembered (not live) read, a mod list that could not be read, a folder that cannot be read, a
// Vortex that has not answered -> verified (null). The link must not appear on a normal mod because something was unavailable.
//
// "Name match" is the project's own matcher (lib/vortex-name-match.js): the record's cleaned names against the listing's name forms, or the same Nexus mod id,
// or the same GitHub repository.

const path = require('path');
const nameMatch = require('./vortex-name-match');
const dummyMaster = require('./dummy-master');

// Does this mod-manager record look like the listing? `mods` entries are shaped like Vortex's ({ attributes, installationPath }).
function recordMatchesListing(modId, record, listing) {
    const prepared = nameMatch.prepareVortexMods({ [modId]: record })[0];
    const entry = nameMatch.prepareCatalog([listing])[0];
    if (!prepared || !entry) return false;
    for (const n of prepared.names) {
        if (entry.exact.has(n.compact)) return true;
        if (entry.closeForms.some((f) => f.compact === n.compact)) return true;
    }
    if (entry.nexusId && prepared.nexusId && entry.nexusId === prepared.nexusId) return true;
    if (entry.repo && prepared.repos && prepared.repos.has(entry.repo)) return true;
    return false;
}

// -> { reason: 'placeholder' | 'registry-only' | 'no-version', text } | null (verified, or cannot tell)
// in: { row, listing, plugin, info, mods, stagingFolder, pairedByName }
//   listing: the Hub entry the row was matched to; plugin: the SkyrimNet registry entry (or a stand-in); info: the live mod-manager facts for the row (vortexInfo[id]);
//   mods: every mod record of the manager's list ({ id: { attributes, installationPath } }), or null when it could not be read; stagingFolder: where the mod folders are.
function judge({ row, listing, plugin = null, info = null, mods = null, stagingFolder = null, pairedByName = false } = {}) {
    if (!row || row.notInstalled || row.isProgram || !listing) return null;
    if (!mods || typeof mods !== 'object' || Object.keys(mods).length === 0) return null; // no read of the mod list: nothing can be said
    if (info && info.fromCache) return null; // remembered, not live
    const modId = info && (info.vortexModId || info.mo2ModFolder) ? (info.vortexModId || info.mo2ModFolder) : null; // Vortex's mod id, or Mod Organizer 2's mod folder
    const record = modId ? mods[modId] : null;
    if (modId && !record) return null; // the manager's own list does not hold the record we were told about: cannot tell
    if (record) {
        if (recordMatchesListing(modId, record, listing)) return null; // an honest name match: a real mod
        const base = record.modsDir || stagingFolder;
        const dir = base ? path.join(base, record.installationPath || modId) : null;
        if (dir && dummyMaster.headerOnlyFolder(dir) === true) return { reason: 'placeholder', text: `every plugin in the mod "${modId}" is an empty placeholder and its name does not match the Hub listing` };
        if (!info.version && !info.recordedVersion && !info.archiveVersion) return { reason: 'no-version', text: `the mod "${modId}" has no version at all and its name does not match the Hub listing` };
        return null;
    }
    // No record behind the row: installed only on SkyrimNet's word, unless the plugin itself came from a mod folder or a name pairing.
    if (pairedByName || (plugin && (plugin.evidence || plugin.nameHit || plugin.where))) return null;
    for (const [id, rec] of Object.entries(mods)) if (recordMatchesListing(id, rec, listing)) return null; // some record is named like it: the row is simply not paired yet
    return { reason: 'registry-only', text: 'only SkyrimNet\'s own list says it is installed; no mod in the mod manager is named like it' };
}

module.exports = { judge, recordMatchesListing };
