'use strict';
// Best-effort auto-detect of the Skyrim SE/AE install folder, for Settings' "auto-detected, with
// Browse..." field -- never the only way in; Browse... always works if this finds nothing or
// finds the wrong install (multiple Skyrim installs on one machine is common).

const runHidden = require('./run-hidden');
const fs = require('fs');
const os = require('os');
const path = require('path');
const platform = require('./platform');
const skyrimEdition = require('./skyrim-edition');

// The usual Steam folder names under steamapps\common, and the Bethesda registry keys, for each edition.
const STEAM_FOLDER_NAMES = ['Skyrim Special Edition', 'SkyrimVR'];
const REGISTRY_KEYS = ['Skyrim Special Edition', 'Skyrim VR'];

function tryRegistry(key) {
    try {
        const out = runHidden.execFileSync('reg', [
            'query', 'HKLM\\SOFTWARE\\WOW6432Node\\Bethesda Softworks\\' + key,
            '/v', 'Installed Path',
        ], { encoding: 'utf8' });
        const m = /Installed Path\s+REG_SZ\s+(.+)/.exec(out);
        return m ? m[1].trim() : null;
    } catch {
        return null;
    }
}

function looksLikeSkyrimFolder(p) {
    try {
        return skyrimEdition.editionOfFolder(p) !== null;
    } catch {
        return false;
    }
}


function detectSkyrimInstallPath() {
    for (const key of REGISTRY_KEYS) {
        const fromRegistry = tryRegistry(key);
        if (fromRegistry && looksLikeSkyrimFolder(fromRegistry)) return fromRegistry;
    }
    return null;
}

module.exports = { detectSkyrimInstallPath, looksLikeSkyrimFolder, STEAM_FOLDER_NAMES };
