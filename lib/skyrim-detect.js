'use strict';
// Best-effort auto-detect of the Skyrim SE/AE install folder, for Settings' "auto-detected, with
// Browse..." field -- never the only way in; Browse... always works if this finds nothing or
// finds the wrong install (multiple Skyrim installs on one machine is common).

const { execFileSync } = require('child_process');
const fs = require('fs');

function tryRegistry() {
    try {
        const out = execFileSync('reg', [
            'query', 'HKLM\\SOFTWARE\\WOW6432Node\\Bethesda Softworks\\Skyrim Special Edition',
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
        return fs.statSync(require('path').join(p, 'SkyrimSE.exe')).isFile();
    } catch {
        return false;
    }
}

function detectSkyrimInstallPath() {
    const fromRegistry = tryRegistry();
    if (fromRegistry && looksLikeSkyrimFolder(fromRegistry)) return fromRegistry;
    return null;
}

module.exports = { detectSkyrimInstallPath, looksLikeSkyrimFolder };
