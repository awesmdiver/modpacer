'use strict';
// What ModPacer knows about the Vortex Bridge, in ONE place (queue: setup-recognises-the-vortex-bridge-that-is-installed..., 2026-10-05), so the setup step,
// the Mods-page banner, the Settings line and the update path's "too old" check can never disagree. The truth comes from the Bridge itself (GET /health: its
// version, its game); the folder in Vortex's add-ons folder (lib/mod-manager.js) is only the fallback for the one case the Bridge cannot answer for itself.
// A Bridge that answers is installed, whatever its folder is called. Reading only; nothing here writes anywhere.
//
//   { installed, answering, version, vortexRunning, bundledVersion, newerBundled, outdated }  (+ connectionState, busy, oldHelperInstalled, bundled)
//     installed      the Bridge answered, or its folder is there (or it has answered here before)
//     answering      /health answered just now (so the version below is real)
//     version        the version /health reported (null when it did not answer, or reported none)
//     vortexRunning  Vortex's program is running (null in the cheap snapshot: it asks Windows, so only the full read does)
//     bundledVersion the version inside the Bridge that comes with this copy of ModPacer (null in a dev checkout)
//     newerBundled   the bundled one is newer than the installed one (an update, never a problem)
//     outdated       the installed one is older than MIN_HELPER_VERSION (ModPacer holds back what needs the newer routes)

const semver = require('semver');
const modManager = require('./mod-manager');
const helperClient = require('./vortex-helper-client');
const helperBundle = require('./helper-bundle');

function build(connectionState, vortexRunning) {
    const reported = helperClient.reportedBridge(); // null until /health answered
    const answering = !!reported;
    const version = answering && reported.version ? reported.version : null;
    const bundledVersion = helperBundle.bundledVersion();
    const cleanVersion = version ? semver.valid(semver.coerce(version)) : null;
    const cleanBundled = bundledVersion ? semver.valid(semver.coerce(bundledVersion)) : null;
    return {
        installed: answering || modManager.isHelperInstalled(),
        answering,
        version,
        vortexRunning: vortexRunning === undefined ? null : vortexRunning,
        bundledVersion: bundledVersion || null,
        newerBundled: !!(answering && cleanVersion && cleanBundled && semver.gt(cleanBundled, cleanVersion)),
        outdated: helperClient.bridgeIsTooOld(),
        connectionState: connectionState || null,
        busy: connectionState === 'vortex_starting',
        oldHelperInstalled: modManager.isOldHelperInstalled(),
        bundled: helperBundle.isBundled(),
    };
}

// The cheap read, from what the last connection check learned (no request, no Windows call): for the page's once-a-second state.
function cached() { return build(null, undefined); }

// The full read: asks the Bridge now (/health through the connection check), then adds whether Vortex is running.
async function get(getConnectionState) {
    const state = await getConnectionState();
    return build(state, helperClient.isVortexRunning());
}

module.exports = { build, cached, get };
