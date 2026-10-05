'use strict';
// Where the app keeps its own data: config.json, state.json, vortex-info-cache.json, cache/, logs/ and (when
// this is set) the install-info.json pointer. MODPACER_DATA_DIR moves all of it; unset (every
// player, always) it is the app's own folder, exactly where these files have always been, so nothing moves.
// The test suite points it at a fresh scratch folder BEFORE any app module loads (tests/_isolate-helper.js),
// so no test can ever read or write the real settings (queue: tests-never-touch-real-data, 2026-10-01).
// Read when a module loads, so set it first.

const path = require('path');

function dataDir() {
    return process.env.MODPACER_DATA_DIR || path.join(__dirname, '..');
}

function dataPath(...parts) {
    return path.join(dataDir(), ...parts);
}

module.exports = { dataDir, dataPath };
