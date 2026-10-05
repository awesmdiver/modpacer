/**
 * Vortex Bridge -- proof-of-concept companion extension for Vortex Collection Tools.
 *
 * WHY THIS EXISTS: vortex-collection-tools reads Vortex's on-disk state.v2 (a LevelDB) through a
 * safe temp-copy, because reading its live WAL directly has a documented, confirmed native crash
 * risk (see vortex-collection-tools' own TECHNICAL.md). That safe-copy approach has a real gap: a
 * rule edit made in Vortex's own UI can sit ONLY in the WAL for a while, invisible to the copy, so a
 * scan/apply run right after can silently use stale data. Vortex has to be fully closed to guarantee
 * a clean read. (Note, 2026-10-05: that was written for a LevelDB-backed state.v2. The newest Vortex
 * source stores its state in DuckDB, and which Vortex version the director runs is not recorded, so
 * the state.v2 fallback in the calling tools may not work on every Vortex. The Bridge reads live Redux
 * state and does not depend on the storage engine.)
 *
 * This extension sidesteps the whole problem: it runs INSIDE Vortex's own process and reads
 * `context.api.store.getState()` directly -- Vortex's actual live in-memory state, not a disk
 * snapshot. There is no WAL, no staleness window, no crash risk, and Vortex never has to close. It
 * exposes that state over a small local-only HTTP server that vortex-collection-tools (a separate
 * Node process) can call.
 *
 * SCOPE (as of v0.14.1; the addenda below add later routes, and docs/USING-THE-BRIDGE.md has the
 * current table of every route and the version it first shipped in): six read-only endpoints
 * (/health, /rules/:modId, /mods, /downloads,
 * /plugins/:pluginName, /profiles -- all confirmed working against a real running Vortex) plus NINE write
 * endpoints, the ninth being POST /plugins/:pluginName/set-enabled -- CONFIRMED live 2026-08-21
 * (see setPluginEnabledAction's own header comment for the full verification writeup: this dispatches
 * a plain {type: 'SET_PLUGIN_ENABLED', payload} object, not an imported action creator, and was
 * live-tested round-trip against the director's own real Vortex -- disable, re-enable, both
 * confirmed instantly visible in Vortex's own Plugins tab, no deploy needed for the in-memory flip):
 * POST /rules/apply
 * (rule edits, via `addModRule`/`removeModRule`), POST /mods/set-attributes (metadata refresh, via
 * `setModAttributes`), POST /mods/create (register a BRAND NEW mod, via the real `create-mod` event
 * -- Update Collection v2's own Phase 3, installing a collection revision's newly-Added mods for
 * real), POST /mods/deploy (re-link one mod's current staging content into the Data folder, via the
 * real `deploy-single-mod` event), POST /mods/set-enabled (profile-level Enabled/Disabled toggle,
 * via the real `SET_MOD_ENABLED` action), POST /mods/remove (full uninstall of one or more mods, via
 * the real `remove-mods` event), POST /mods/deploy-all (the REAL, full Vortex deploy pipeline, via
 * the real `deploy-mods` event -- same one the actual "Deploy Mods" button dispatches), and GET
 * /mods/deploy-all/progress (best-effort live status while a deploy-all is in flight -- see
 * deployModsAction's own header comment for a real, confirmed limitation on how reliable this
 * polling is during a large deploy). Every write here dispatches/emits Vortex's own real action
 * creators or events (confirmed exported in Vortex's own public API manifest, etc/vortex.api.md, or
 * confirmed registered in its own real source) -- the SAME mechanisms Vortex's own UI uses for the
 * equivalent action, never a direct database write. Vortex's own reducer, deployment machinery, and
 * persistor handle the rest.
 *
 * SCOPE ADDENDUM (v0.17.0): POST /mods/remove-record-only added -- see removeModRecordOnly's own
 * header comment for the full real reasoning (deletes a mod's own tracked record directly, via the
 * real `removeMod` action, WITHOUT Vortex's real undeploy attempt -- specifically to avoid Vortex's
 * own real, blocking "Mod not found" dialog for a mod already known to have no staging content left).
 *
 * SCOPE ADDENDUM (v0.17.0): POST /downloads/register-local added -- see registerLocalDownload's own
 * header comment for the full real reasoning (registers a self-downloaded archive into Vortex's own
 * real downloads database via the real ADD_LOCAL_DOWNLOAD action, giving it a real archiveId -- root
 * cause fix for spurious Version-column "variant" duplicates on freshly self-downloaded mods).
 *
 * /mods/deploy vs /mods/deploy-all -- deliberately two DIFFERENT real Vortex events, not one
 * generalized over the other. /mods/deploy (deploy-single-mod) re-links ONE mod's files and stops --
 * fast, but it never fires Vortex's own `did-deploy` event, so plugins.txt/loadorder.txt never get
 * refreshed or LOOT-resorted (confirmed via vortex-collection-tools' own docs/
 * VORTEX-DEPLOY-REFERENCE.md, sourced by reading Vortex's real deploy pipeline directly). /mods/
 * deploy-all (deploy-mods) runs the FULL real pipeline across every enabled mod and DOES fire
 * `did-deploy`, which is what actually reconciles plugins.txt. History: vortex-collection-tools' Update
 * Collection v2 first used deploy-single-mod per updated mod (fast, avoids the multi-hour-hang risk
 * a full deploy can carry on a huge collection -- see this file's own AND vortex-collection-tools'
 * lib/vortex-bridge-client.js's real, confirmed investigation of that risk). Since 2026-08-27 it no
 * longer deploys per mod at all: only its single-mod retry path still calls /mods/deploy, and one
 * /mods/deploy-all runs from the Done screen's Deploy step. ModPacer does not use /mods/deploy
 * either (a one-mod deploy left Vortex's own "deploy needed" flag set).
 *
 * /mods/deploy vs /mods/set-enabled -- confirmed live 2026-08-18, a real, easy-to-miss distinction:
 * `deploy-single-mod`'s own `enable` argument (mod_management/index.ts's onDeploySingleMod) ONLY
 * calls activator.activate/deactivate -- the DEPLOYMENT/file-linking layer. It never touches a mod's
 * PROFILE-level Enabled/Disabled flag (persistent.profiles[profileId].modState[modId].enabled, what
 * the Mods table checkbox and this extension's own `enabledModKeys` actually reflect) -- confirmed by
 * calling /mods/deploy with enable:false against a real live mod twice and observing enabledModKeys
 * never changed. Preserving a user's real "Disabled" choice needs BOTH: /mods/set-enabled to fix the
 * profile flag itself, and /mods/deploy(enable:false) to un-link the files so the mod's content isn't
 * still active in Data despite the checkbox -- neither alone is sufficient.
 *
 * GET /plugins/:pluginName (v0.9.0) -- reads ONE plugin's real live enabled/loadOrder state straight
 * from `state.loadOrder`, a SEPARATE Redux slice from state.persistent.mods entirely, registered by
 * gamebryo-plugin-management itself (confirmed via that extension's real source:
 * `context.registerReducer(['loadOrder'], loadOrderReducer)`, extensions/gamebryo-plugin-management/
 * src/index.ts). This exists because a mod's PROFILE-level enabled flag (persistent.profiles[...]
 * .modState[modId].enabled, what /mods/set-enabled writes) and a PLUGIN's own load-order-tab enabled
 * flag (state.loadOrder[pluginId].enabled) are two genuinely different things, and plugins.txt -- the
 * on-disk file vortex-collection-tools used to read for "is this plugin active" -- is only a
 * serialized snapshot Vortex writes out at deploy time; it can lag behind this live Redux state by a
 * beat, or by a whole pending deploy. Reading state.loadOrder directly is the true, immediate source.
 * This read endpoint has a write counterpart, POST /plugins/:pluginName/set-enabled (v0.11.0): the
 * real setPluginEnabled action creator is private to gamebryo-plugin-management and not in vortex-api's
 * public surface, so that route dispatches a plain {type: 'SET_PLUGIN_ENABLED', payload} object instead
 * (see setPluginEnabledAction). The plugin flag reaches plugins.txt about 200 ms later with no deploy,
 * as long as the plugin's file stays deployed (vortex-collection-tools' docs/
 * VORTEX-PLUGIN-ENABLE-DISABLE-REFERENCE.md, live re-verified 2026-08-21).
 *
 * POST /mods/create-batch, POST /mods/set-enabled-batch, POST /rules/apply-batch (v0.14.1) --
 * batch forms of /mods/create, /mods/set-enabled, /rules/apply. Added after a real, director-caught
 * excess-call-count finding: Update Collection v2's own Added-mod loop was making up to 4 separate
 * HTTP round trips PER newly-Added mod (create, set-attributes, set-enabled, rules/apply), where
 * real Vortex's own native collection-install code NEVER makes N separate dispatches for N mods --
 * every real call site that touches collection membership rules (collections/index.ts,
 * collectionCreate.ts, InstallDriver.ts, confirmed via source) uses ONE `batchDispatch(store,
 * rules.map(addModRule))` call for the whole set. /rules/apply-batch and /mods/set-enabled-batch
 * were ORIGINALLY meant to mirror that via vortex-api's own `batchDispatch` -- confirmed listed in
 * etc/vortex.api.md's public surface, but NOT actually present on what `require('vortex-api')`
 * returns at runtime (a real live apply threw "batchDispatch is not a function" the same day this
 * shipped; fixed same day by looping plain individual `api.store.dispatch()` calls instead -- still
 * ONE HTTP request for the whole array, just N separate dispatches server-side rather than one
 * atomic batch action). /mods/create-batch stays on the real per-mod `create-mod` EVENT (never used
 * batchDispatch to begin with) since that's Vortex's own actual registration entry point and its
 * onAddMod handler has a real side effect (fs.ensureDirAsync) beyond the plain Redux dispatch --
 * looped server-side, in-process, across the whole array in one HTTP request instead of one request
 * per mod. None of these three REPLACE their singular counterparts -- both forms stay, the caller
 * picks whichever fits (one mod vs. a whole apply's worth).
 *
 * GET /profiles (first shipped in v0.14.1) -- every real Vortex profile for this game (`{profileId, gameId, name}`),
 * plus which one is currently active. Added for Save Cleaner's own per-profile save separation
 * support: a save's folder is often named after the raw Vortex profile ID Vortex itself assigned, and
 * this is what turns that ID into a real display name -- live, with Vortex open, instead of falling
 * back to reading state.v2's own persistent###profiles###* keys (which needs Vortex fully closed).
 * Read-only, tiny payload, same short timeout budget as /health.
 *
 * SCOPE ADDENDUM (v0.17.0) -- GET /mods/deploy-all/progress now also carries `externalChangesPending`
 * and `blockingDialogs`, so vortex-collection-tools' own deploy screen can tell "Vortex is genuinely
 * still working" apart from "Vortex is sitting on a blocking popup no one has clicked" as a REAL fact
 * instead of guessing from a stalled-poll timer. Full design + the exact Vortex source lines these two
 * read from: vortex-collection-tools' own diagnostics/2026-08-28-helper-live-vortex-events-spec.md.
 * See getSessionSignals' own header comment for the exact state paths and why content/defaultAction/
 * actions are deliberately dropped from each dialog entry (observe only, never answer on the user's
 * behalf). A separate 1s timer (started in startServer, independent of whether anything is polling
 * /mods/deploy-all/progress) logs a line the instant either signal transitions -- see
 * checkSessionSignalTransition's own header comment. (A temporary one-time raw-shape dev log in
 * getSessionSignals was removed 2026-10-05, after the live dialog shape matched the source reading.)
 *
 * SCOPE ADDENDUM (v0.23.3) -- GET /mods/deploy-all/progress also carries `needToDeploy`: true / false
 * when Vortex's own state says a deploy is / is not still needed for this game, null when unknown
 * (see getNeedToDeploy's own header comment for the exact Vortex source it reads). Older callers
 * ignore it.
 *
 * SCOPE ADDENDUM (v0.18.0) -- also carries `deployBlockedByCycles`, a real boolean fact (2026-08-31,
 * vortex-collection-tools' own diagnostics/2026-08-30-real-apply-marathon-findings.md finding #1):
 * Vortex's own deploy call can return/resolve normally even when it actually aborted because of a
 * rule cycle, so a caller trusting "the deploy call returned" alone reports a false "Deploy complete."
 * See getSessionSignals' own header comment for the exact real Vortex source lines this reads
 * against and why it's cycle-specific, not a generic "deploy was interrupted for any reason" signal.
 *
 * SCOPE ADDENDUM (v0.19.0, 2026-09-01) -- POST /downloads/remove added (removeDownloadAndFile): a
 * download's record AND its real archive file, via the real api.removeDownload() -- built for
 * vortex-collection-tools' own Duplicate Version Cleanup tool, see removeDownloadAndFile's own
 * header comment for the full real reasoning (removeDownloadRecordOnly, just above it, was
 * confirmed live NOT to reliably survive a Vortex restart; this is the confirmed-persisting
 * mechanism instead). The same release added an explicit synchronous persist flush
 * (window.api.persist.sendDiffSync) to removeDownloadRecordOnly, see that function's own header
 * comment. That flush did NOT fix anything (corrected 2026-10-05): a record-only removal still does
 * not survive a Vortex restart.
 *
 * SCOPE ADDENDUM (v0.20.0, 2026-09-30) -- supports a new sibling tool, ModPacer
 * (the ModPacer folder), which reuses Vortex Bridge
 * for all its Vortex work rather than shipping its own extension. Three additions:
 * (1) a 'gamemode-activated' listener (main()) that runs ModPacer's own `node server.js --check`
 * in the background once Vortex has loaded Skyrim SE, if ModPacer is installed and its own
 * "Check when Vortex starts" setting is on -- see triggerPluginModPacerCheck's own header comment
 * for how Vortex Bridge locates an install it was never told the path to;
 * (2) POST /notify (generic {title, lines, action?}) and POST /plugin-updater/notify (that
 * project's own already-shipped {title, message, items, action?} call shape, converted) -- both
 * show ONE api.sendNotification toast with an optional button that opens a URL via Electron's
 * shell.openExternal;
 * (3) GET /paths, returning the current game's real, fully-resolved staging and download folder
 * paths -- ModPacer no longer needs the player to type its own "Vortex mods folder" setting
 * once it switches to this. Every existing write endpoint ModPacer's own swap flow needs
 * (create a mod, move a collection's rule, remove the old mod's record without touching its
 * archive, deploy) was already here (/mods/create, /rules/apply, /mods/remove-record-only,
 * /mods/deploy) and needed no changes.
 *
 * SCOPE ADDENDUM (v0.20.1, 2026-09-30) -- two real, live-confirmed bugs in GET /paths above, both
 * caught the first time it actually ran inside the director's own real Vortex (never caught by the
 * original test suite, which only proved the call SHAPE was right against a fake stand-in module,
 * never that the real functions it called actually existed at runtime):
 * (1) it called `require('vortex-api').installPathForGame`/`downloadPathForGame` on the strength of
 * both names appearing in etc/vortex.api.md's own export list -- neither is actually callable at
 * runtime (confirmed live: "installPathForGame is not a function"), the SAME class of gap this file
 * already documents once before for `batchDispatch`. Fixed by reimplementing the real resolution
 * directly against Vortex's own source (getInstallPath.ts/getDownloadPath.ts) instead -- see
 * getVortexPaths' own header comment for the full story;
 * (2) that failure then crashed the WHOLE renderer process (an "unrecoverable error", forcing a
 * Vortex restart) via a second, independent bug: the route wrote a real 200 response's headers
 * BEFORE computing the body that could throw, so its own catch block's attempted 500 response hit
 * Node's ERR_HTTP_HEADERS_SENT. Fixed by computing the full response body first, in its own
 * try/catch, and calling res.writeHead/res.end exactly once -- a mechanical fix worth applying to
 * any future route with the same shape, not just this one.
 * Also: sendBridgeNotification's message now joins lines with ' · ' instead of '\n' (Vortex's own
 * Notification.tsx renders each newline-split line as a separate <span> with NO separator between
 * them, confirmed by reading its real source -- multi-line notifications ran together with zero
 * visible space in the real UI until this changed), and its action button no longer calls
 * dismiss() (a real director report: clicking "Open ModPacer" used to close the whole
 * notification immediately even when the destination page wasn't actually running yet -- only the
 * player's own dismiss button should ever close it now).
 *
 * SCOPE ADDENDUM (v0.21.0, 2026-10-01) -- POST /downloads/set-installed added, for
 * ModPacer's own real reported "two rows" bug: a mod it creates for a self-downloaded archive
 * can have a real archiveId pointing at a real download, but until the DOWNLOAD's own `installed`
 * back-reference is also set, Vortex's Mods table still shows that download as a second, separate,
 * never-installed row. See setDownloadInstalled's own header comment for the real source this is
 * confirmed against (mod_management/InstallContext.ts's mSetDownloadInstalled, called by every
 * genuine Vortex install right after create-mod -- something createMod()/create-mod alone never
 * replicates on its own).
 *
 * SCOPE ADDENDUM (v0.22.0, 2026-10-03) -- ModPacer's startup check now runs with the
 * runtime ModPacer records as nodePath in its pointer file (its own bundled node.exe), falling
 * back to 'node' on the PATH. See findModPacerNodePath.
 *
 * SCOPE ADDENDUM (v0.24.0, 2026-10-04) -- the extension is renamed from "Vortex Collection Helper" to
 * Vortex Bridge, inside and out (id/folder `vortex-bridge`). Its companion program is now ModPacer, whose
 * pointer file is %APPDATA%\ModPacer\install-info.json; every per-program detail sits in the COMPANIONS
 * table (ModPacer is its only entry). An old copy still installed beside this one is detected at start-up
 * (its folder, or the port already in use) and shown as one notification. The port number and the HTTP
 * endpoint paths (including POST /plugin-updater/notify) are unchanged: other programs call them.
 *
 * SCOPE ADDENDUM (v0.25.0, 2026-10-05) -- POST /downloads/remove works again: removeDownloadAndFile
 * emits Vortex's own `remove-download` event (the Downloads page's Remove button) instead of the
 * non-existent `api.removeDownload`, reports success only when the record is really gone, and
 * answers `fileRemoved` per id. See removeDownloadAndFile.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.VB_TEST_PORT) || 59595; // arbitrary, unlikely to collide -- vortex-collection-tools' own server uses 4321. VB_TEST_PORT is for tests only (a real Vortex may be holding 59595)
const GAME_ID = 'skyrimse'; // matches info.json's own gameId scope; hardcoded for this POC, can generalize later
// info.json (not package.json) is the authoritative version -- it's what Vortex itself reads for this
// extension's own Extensions page, so reporting it here guarantees /health never drifts from what
// Vortex already shows the user is actually installed.
const VERSION = require('./info.json').version;

// Where ModPacer (a separate, standalone sibling tool) records its own install
// folder every time it starts -- see findModPacerInstallPath's own header comment below for the full
// reasoning. A fixed OS-level location (not inside either tool's own install folder) is the only
// thing that works without a chicken-and-egg problem: Vortex Bridge has no other way to learn where
// the player put ModPacer.
// Everything that is specific to one companion program lives in its own entry here, so adding another
// program later means adding an entry, not editing scattered constants. ModPacer is the only one today.
// (The tab, the notifications and the start-on-demand code below all read from MODPACER, below.)
const COMPANIONS = {
    modpacer: {
        displayName: 'ModPacer',
        exeName: 'ModPacer.exe',
        infoPath: path.join(process.env.APPDATA || '', 'ModPacer', 'install-info.json'),
        settingsKey: 'modPacer', // state.settings.modPacer
        setExeAction: 'VORTEX_BRIDGE_SET_MODPACER_EXE',
        defaultAddress: 'http://127.0.0.1:47821/',
        openButton: 'Open ModPacer',
        notSetUp: {
            id: 'modpacer-not-set-up',
            message: "ModPacer isn't set up yet. Open it and choose your Skyrim folder.",
        },
        startFailed: {
            id: 'modpacer-start-failed',
            message: "Couldn't start ModPacer. Open Settings > ModPacer and select ModPacer.exe.",
        },
        settingsDescription: 'Select "ModPacer.exe" from the location where it is installed, so "Open ModPacer" can start it when it isn\'t running.',
        notAProgramWarning: "That isn't ModPacer.exe. Choose the program file itself, not its folder.",
        notRunYetNote: "ModPacer hasn't been run yet. Open it once, or choose its program above.",
    },
};
const MODPACER = COMPANIONS.modpacer;
const MODPACER_INFO_PATH = MODPACER.infoPath;

// The extension used to be called "Vortex Collection Helper" (folder id `vortex-collection-helper`). An
// old copy left installed beside this one would hold the same port, so we look for it at start-up.
const OLD_EXTENSION_ID = 'vortex-collection-helper';
const OLD_EXTENSION_NAME = 'Vortex Collection Helper';
const OLD_COPY_MESSAGE = `The old "${OLD_EXTENSION_NAME}" extension is still installed. Remove it in Vortex > Extensions: Vortex Bridge replaces it.`;

let server = null;

function log(level, message, data) {
    try {
        // vortex-api's own logger, same as every other real extension (see crash-analyzer's own
        // index.js) -- falls back to console if vortex-api isn't resolvable for some reason (should
        // always be, inside a running Vortex, but never let a logging failure break the extension).
        const { log: vortexLog } = require('vortex-api');
        vortexLog(level, message, data);
    } catch {
        console.log(`[vortex-bridge] ${level}: ${message}`, data || '');
    }
}

// Reads a mod's current `rules` array straight from Vortex's own live Redux state -- the exact same
// shape vortex-collection-tools' own state.v2 reads already expect (confirmed against
// lib/cycle-detector.js's own LevelDB key: `persistent###mods###${GAME_ID}###${modKey}###rules` --
// LevelDB's `###`-joined keys mirror this same state tree path segment-for-segment).
function getModRules(api, modId) {
    const state = api.store.getState();
    const mod = state.persistent && state.persistent.mods && state.persistent.mods[GAME_ID]
        ? state.persistent.mods[GAME_ID][modId]
        : undefined;
    if (!mod) return null;
    return mod.rules || [];
}

// needToDeploy (v0.23.3) -- does Vortex ITSELF still say a deploy is needed for this game? Read from
// state.persistent.deployment.needToDeploy[GAME_ID], checked against Vortex's own source
// (Nexus-Mods/Vortex @ 826298d): src/renderer/src/extensions/mod_management/selectors.ts line 16
// (allNeedToDeploy = state.persistent.deployment.needToDeploy) and lines 70-73 (needToDeployForGame
// indexes it by game id); reducers/deployment.ts line 16 writes it per game id
// (setSafe(state, ["needToDeploy", gameId], required)); views/ActivationButton.tsx line 115 (the
// Deploy button's flashing state) reads the same map via selectors.needToDeploy. Returns true/false
// ONLY when the state holds a real boolean; a missing slice, missing game id, or any error is null
// (unknown) -- never a thrown error and never a made-up false.
function getNeedToDeploy(api) {
    try {
        const state = api.store.getState();
        const map = state && state.persistent && state.persistent.deployment
            ? state.persistent.deployment.needToDeploy
            : undefined;
        const value = map ? map[GAME_ID] : undefined;
        return typeof value === 'boolean' ? value : null;
    } catch (err) {
        return null;
    }
}

// Full `state.persistent.mods[GAME_ID]` object, live -- the SAME data vortex-collection-tools' own
// `buildModIndex(db)` builds by iterating every `persistent###mods###${GAME_ID}###*` LevelDB key
// (lib/rules-generator.js). This is the whole subtree, not reshaped/filtered -- vortex-collection-tools'
// own client-side code already knows how to read this exact shape (type/installationPath/rules/
// attributes.modId/attributes.fileId/etc per mod), so no translation happens here.
function getAllMods(api) {
    const state = api.store.getState();
    return (state.persistent && state.persistent.mods && state.persistent.mods[GAME_ID]) || {};
}

// Full `state.persistent.downloads.files` object, live -- the SAME data vortex-collection-tools' own
// Clean Up report (lib/cleanup-scan.js's readModsAndDownloads) builds by iterating every
// `persistent###downloads###files###*` LevelDB key (localPath/state/game per download). Whole
// subtree, not filtered/reshaped -- same "dumb relay, no logic here" design as getAllMods above.
function getAllDownloads(api) {
    const state = api.store.getState();
    return (state.persistent && state.persistent.downloads && state.persistent.downloads.files) || {};
}

// Every modKey enabled in the CURRENTLY ACTIVE profile for this game -- confirmed against
// vortex-sync/lib.js's own two real state.v2 reads this mirrors exactly:
//   settings###profiles###lastActiveProfile###${GAME_ID}  ->  state.settings.profiles.lastActiveProfile[GAME_ID]
//   persistent###profiles###${profileId}###modState###${modKey}###enabled
//     ->  state.persistent.profiles[profileId].modState[modKey].enabled
function getEnabledModKeys(api) {
    const state = api.store.getState();
    const profileId = state.settings && state.settings.profiles && state.settings.profiles.lastActiveProfile
        ? state.settings.profiles.lastActiveProfile[GAME_ID]
        : undefined;
    if (!profileId) return { profileId: null, enabledModKeys: [] };
    const profile = state.persistent && state.persistent.profiles ? state.persistent.profiles[profileId] : undefined;
    const modState = (profile && profile.modState) || {};
    const enabledModKeys = Object.keys(modState).filter((modKey) => modState[modKey] && modState[modKey].enabled === true);
    return { profileId, enabledModKeys };
}

// Live "is Vortex genuinely blocked on a popup right now" signal -- see vortex-collection-tools' own
// diagnostics/2026-08-28-helper-live-vortex-events-spec.md for the full design and the exact Vortex
// source lines these two reads are confirmed against. Read fresh on every call, never cached -- small
// in-memory Redux reads, nothing like the ~46MB /mods payload getAllMods returns.
//   - state.session.mods.changes -- the External Changes dialog's own DEDICATED slice
//     (mod_management/reducers/session.ts's sessionReducer, registered at ["session", "mods"] in
//     that extension's own index.ts). Non-empty exactly while that dialog is genuinely open;
//     confirmExternalChanges() resets it to [] on both Confirm and Cancel
//     (mod_management/actions/session.ts).
//   - state.session.notifications.dialogs -- the GENERIC api.showDialog() queue every other real
//     Vortex confirmation goes through, including the "Mod not found" dialog removeModRecordOnly's
//     own header comment above already works around (reducers/notifications.ts, registered at
//     ["session", "notifications"] in reducers/index.ts's own buildReducerTree). Each entry is
//     {id, type, title, content, defaultAction, actions} (actions/notifications.ts's addDialog) --
//     only id/type/title kept below; content/defaultAction/actions are deliberately dropped, since
//     this stays observe-only, same "dumb relay, no logic" discipline as every write in this file --
//     never enough to answer a dialog on the user's behalf.
// (A one-time dev log of the raw first dialog entry used to sit here. It confirmed live that the
// entry shape matches the source reading above, and was removed 2026-10-05; nothing read it.)

// deployBlockedByCycles (2026-08-31, diagnostics/2026-08-30-real-apply-marathon-findings.md finding
// #1) -- same sibling-path pattern blockingDialogs above already established, one slice over:
// state.session.notifications.notifications (NOT .dialogs -- a plain toast, not a blocking modal),
// same ["session","notifications"] reducer registration, confirmed via Vortex's own real source
// (reducers/notifications.ts's own defaultState: {notifications, global_notifications, dialogs}).
// Vortex dispatches this via a plain api.sendNotification({type:"warning", title:"Deployment
// interrupted", message: err.message}) from TWO real call sites (extensions/mod_management/index.ts,
// confirmed lines ~894-899 and ~1294-1299) -- both fire on ANY ProcessCanceled during deploy, not
// cycles specifically (a CycleError gets wrapped into a ProcessCanceled with a distinctive message
// upstream, ~line 465: "Deployment is not possible when you have cyclical mod rules. " + the
// CycleError's own message), so matching on title alone would be a false positive for some other,
// unrelated deploy cancellation. Requiring the message to also mention "cyclical mod rules" is what
// actually narrows this to the cycle case specifically, matching the tool side's own
// deployBlockedByCycles naming, not a generic "deploy was interrupted for any reason" signal.
// A plain snapshot read, same as every other signal here -- not time-windowed/latched. This warning
// notification type ("warning", not a quick "info" toast) is expected to persist until the user (or
// this tool's own eventual consumer) acts on it, same real persistence characteristic blockingDialogs
// already relies on -- if that assumption turns out wrong (a fast auto-dismiss racing the tool's own
// poll interval), the fix is a latch here, not a redesign of the read itself.
function getSessionSignals(api) {
    const state = api.store.getState();
    const externalChangesPending = !!(
        state.session && state.session.mods && Array.isArray(state.session.mods.changes)
        && state.session.mods.changes.length > 0
    );
    const rawDialogs = (state.session && state.session.notifications && Array.isArray(state.session.notifications.dialogs))
        ? state.session.notifications.dialogs
        : [];
    const blockingDialogs = rawDialogs.map((d) => ({ id: d.id, type: d.type, title: d.title }));
    const rawNotifications = (state.session && state.session.notifications && Array.isArray(state.session.notifications.notifications))
        ? state.session.notifications.notifications
        : [];
    const deployBlockedByCycles = rawNotifications.some((n) => n.title === 'Deployment interrupted'
        && typeof n.message === 'string' && n.message.toLowerCase().includes('cyclical mod rules'));
    return { externalChangesPending, blockingDialogs, deployBlockedByCycles };
}

// Debugging aid (the director's own ask, alongside the UI fix itself) -- logs a line the instant
// either signal above TRANSITIONS (a dialog/External-Changes prompt appearing or fully clearing),
// never on every tick, so the log stays a real event trail, not noise. Runs on its own 1s interval
// (started in startServer, below) rather than only inside the GET /mods/deploy-all/progress handler,
// so this fires even when nothing is polling that endpoint -- e.g. mid-review, before Deploy is even
// pressed. Same timestamped, labeled log-line convention this file's own log() wrapper already uses
// everywhere else (mirrors vortex-collection-tools' own lib/update-collection-v2-runner.js
// timedGetAllMods, applied here via this repo's own logger instead of console.log).
let lastSessionSignals = { externalChangesPending: false, dialogKey: '', deployBlockedByCycles: false };
function checkSessionSignalTransition(api) {
    const { externalChangesPending, blockingDialogs, deployBlockedByCycles } = getSessionSignals(api);
    const dialogKey = blockingDialogs.map((d) => `${d.id}:${d.title}`).join('|');
    if (externalChangesPending === lastSessionSignals.externalChangesPending && dialogKey === lastSessionSignals.dialogKey
        && deployBlockedByCycles === lastSessionSignals.deployBlockedByCycles) {
        return; // no change since last check -- nothing to log
    }
    const now = new Date().toISOString();
    if (externalChangesPending !== lastSessionSignals.externalChangesPending) {
        log('info', `[vortex-bridge] externalChangesPending ${lastSessionSignals.externalChangesPending} -> ${externalChangesPending} (${now})`);
    }
    if (dialogKey !== lastSessionSignals.dialogKey) {
        const prevCount = lastSessionSignals.dialogKey ? lastSessionSignals.dialogKey.split('|').length : 0;
        const titles = blockingDialogs.map((d) => d.title).join(', ');
        log('info', `[vortex-bridge] blockingDialogs ${prevCount} -> ${blockingDialogs.length}${titles ? ` (${titles})` : ''} (${now})`);
    }
    if (deployBlockedByCycles !== lastSessionSignals.deployBlockedByCycles) {
        log('info', `[vortex-bridge] deployBlockedByCycles ${lastSessionSignals.deployBlockedByCycles} -> ${deployBlockedByCycles} (${now})`);
    }
    lastSessionSignals = { externalChangesPending, dialogKey, deployBlockedByCycles };
}

// Every Vortex profile for THIS game, live -- mirrors vortex-collection-tools' own
// lib/vortex-sync/lib.js listProfiles(db) exactly (same state shape, same GAME_ID filter: Vortex's
// state.v2 is shared across every game it manages, not just this one, so an unfiltered read would
// leak profiles for whatever other games happen to be installed). Whole `{profileId, gameId, name}`
// per profile, not just the active one -- getEnabledModKeys() above already covers "which profile is
// active right now"; this is for "what are ALL of them called," e.g. resolving a per-profile save
// folder's own raw ID (Vortex's own save-separation feature names it after the real profile ID) to
// its real display name without ever touching state.v2 at all.
function getAllProfiles(api) {
    const state = api.store.getState();
    const profiles = (state.persistent && state.persistent.profiles) || {};
    return Object.keys(profiles)
        .filter((id) => profiles[id] && profiles[id].gameId === GAME_ID)
        .map((id) => ({ profileId: id, gameId: GAME_ID, name: profiles[id].name || id }));
}

// Mirrors gamebryo-plugin-management's own toPluginId (extensions/gamebryo-plugin-management/src/
// util/toPluginId.ts) exactly -- lowercased, basename-only, trailing ".ghost" stripped (Vortex's own
// mechanism for a plugin file renamed to hide it from the game without deleting it). state.loadOrder
// is keyed by this exact transform, confirmed against that real source file. Reimplemented here
// (rather than requiring gamebryo-plugin-management's own module) since this is a separate extension
// with no access to that other extension's internal, non-exported source tree -- only its OWN
// registered Redux state (state.loadOrder) is actually shared/readable, not its util functions.
const GHOST_EXT = '.ghost';
function toPluginIdLike(pluginName) {
    let name = String(pluginName).toLowerCase();
    const lastSlash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
    if (lastSlash !== -1) name = name.slice(lastSlash + 1);
    if (name.endsWith(GHOST_EXT)) name = name.slice(0, -GHOST_EXT.length);
    return name;
}

// See GET /plugins/:pluginName's own header comment above for the full "why this exists" writeup.
// Returns { found: false, id } when Vortex has no live loadOrder entry for this plugin at all (never
// seen it / it was never active this session) -- a real, valid state, not an error.
function getPluginLoadOrder(api, pluginName) {
    const state = api.store.getState();
    const loadOrder = state.loadOrder || {};
    const id = toPluginIdLike(pluginName);
    const entry = loadOrder[id];
    if (!entry) return { found: false, id };
    return { found: true, id, name: entry.name, enabled: entry.enabled, loadOrder: entry.loadOrder };
}

// CONFIRMED live 2026-08-21 -- see GET /plugins/:pluginName's own header comment for why no
// vortex-api-exported write path exists for a single plugin's own enabled flag. This is what makes
// one anyway: Vortex's own real "Enable all" button (shown when a re-enabled mod "contains multiple
// plugins") does EXACTLY this -- `plugins.forEach(p => api.store.dispatch(setPluginEnabled(p, true)))`
// (gamebryo-plugin-management/src/index.ts's notifyMultiplePlugins) -- and `setPluginEnabled` itself
// is `redux-act`'s `createAction("SET_PLUGIN_ENABLED", (pluginName, enabled) => ({pluginName,
// enabled}))` (gamebryo-plugin-management/src/actions/loadOrder.ts). redux-act uses a createAction's
// description string AS the action's real dispatched `type`, unless that exact description is reused
// elsewhere in the app (then it gets a disambiguating suffix) -- confirmed via a full-repo grep of
// Vortex's own source that "SET_PLUGIN_ENABLED" is registered by exactly one createAction, so no
// collision. (It also appears as a plain {type, payload} object dispatch in collections/util/
// gameSupport/gamebryo.tsx -- the same pattern this function uses, so a plain object is valid and
// Vortex does it itself; harmless.) This function
// dispatches a PLAIN object with that same {type, payload} shape directly -- no import of gamebryo-
// plugin-management's own private module (not reachable from a separate extension anyway).
//
// LIVE-VERIFIED, not just reasoned through: round-tripped against the director's own real, running
// Vortex (2026-08-21) -- disabled DynDOLOD.esp (before.enabled:true -> after.enabled:false,
// changed:true), re-enabled it (changed:true back to true), BOTH confirmed instantly visible in
// Vortex's own Plugins tab checkbox with no deploy in between. CORRECTED 2026-10-05: no deploy is
// needed for the on-disk plugins.txt either -- Vortex's own persistor rewrites it about 200 ms after
// the flag changes (vortex-collection-tools' docs/VORTEX-PLUGIN-ENABLE-DISABLE-REFERENCE.md, live
// re-verified), provided the plugin's FILE is still deployed. (A mod-level change is different: see
// /mods/set-enabled vs. /mods/deploy above.)
function setPluginEnabledAction(api, pluginName, enabled) {
    api.store.dispatch({ type: 'SET_PLUGIN_ENABLED', payload: { pluginName, enabled } });
}

// Dispatches Vortex's own real ADD_MOD_RULE / REMOVE_MOD_RULE actions -- the exact action creators
// Vortex's own built-in Conflict Editor dispatches (confirmed against its real source,
// extensions/mod-dependency-manager/src/views/ConflictEditor.tsx's buildRuleActions: it removes the
// old rule then adds the new one as two separate dispatches, no batching needed for correctness).
// `remove`/`add` are each `{ type, reference } | undefined` -- exactly Vortex's own IModRule shape.
// The caller (vortex-collection-tools) is responsible for deciding WHAT to remove/add; this function
// is deliberately a dumb relay, no rule-resolution logic of its own.
function applyRuleChange(api, modId, remove, add) {
    const { actions } = require('vortex-api');
    if (remove) api.store.dispatch(actions.removeModRule(GAME_ID, modId, remove));
    if (add) api.store.dispatch(actions.addModRule(GAME_ID, modId, add));
}

// Batch form (2026-08-27) -- vortex-collection-tools' own Update Collection v2 was calling
// POST /rules/apply once per newly-Added mod (23 separate HTTP round trips on a 23-new-mod apply),
// where real Vortex's OWN native code NEVER does that: every real call site that adds collection
// membership rules (collections/index.ts, collectionCreate.ts, InstallDriver.ts -- confirmed via
// source, all of them) dispatches `batchDispatch(store, rules.map(rule => addModRule(...)))`, one
// Redux batch action carrying every rule at once.
//
// CORRECTED 2026-08-27, same day, after a real live failure: `batchDispatch` is listed in
// etc/vortex.api.md's DESIGN-TIME public surface, but is NOT actually present on the object
// `require('vortex-api')` returns to an external extension at runtime -- confirmed live, a real
// apply against the director's own Vortex threw "batchDispatch is not a function" from inside this
// function. The doc and the real runtime shim disagree; trust the runtime, not the doc. Falls back
// to a plain loop of individual `api.store.dispatch()` calls instead -- still ONE HTTP request for
// the whole array (the actual round-trip cost this batch form exists to cut), just N separate Redux
// dispatches server-side rather than one atomic batch action. `items`: [{modId, remove?, add?}, ...].
// Per-item results reflect input-shape validity, not a per-dispatch Vortex-side outcome (each
// dispatch here is a plain, well-tested action creator that doesn't itself fail).
function applyRuleChangesBatch(api, items) {
    const { actions } = require('vortex-api');
    const results = items.map((item) => {
        if (!item || !item.modId || (!item.remove && !item.add)) {
            return { modId: item && item.modId, ok: false, error: 'must include modId and at least one of remove/add' };
        }
        if (item.remove) api.store.dispatch(actions.removeModRule(GAME_ID, item.modId, item.remove));
        if (item.add) api.store.dispatch(actions.addModRule(GAME_ID, item.modId, item.add));
        return { modId: item.modId, ok: true };
    });
    return results;
}

// Dispatches Vortex's own real SET_MOD_ATTRIBUTES action (confirmed exported in Vortex's own public
// API manifest, etc/vortex.api.md) -- sets one or more attributes on an already-registered mod's own
// state.v2 record (e.g. version/fileMD5/fileId/fileSize/source/archiveId after
// vortex-collection-tools re-extracts a newer archive into that mod's EXISTING staging folder --
// deliberately NOT going through Vortex's own slow InstallManager reinstall, which is the multi-hour
// hang this whole mechanism exists to route around; this just refreshes the metadata InstallManager
// would otherwise have set, after the caller's own faster extraction already did the real work).
// Deliberately a dumb relay, same as applyRuleChange above -- the caller supplies the exact
// attributes object, no resolution logic here.
function setModAttributes(api, modId, attributes) {
    const { actions } = require('vortex-api');
    api.store.dispatch(actions.setModAttributes(GAME_ID, modId, attributes));
}

// Dispatches Vortex's own real SET_MOD_ENABLED action (profile_management/actions/profiles.ts's
// `setModEnabled`, confirmed exported in Vortex's own public API manifest, etc/vortex.api.md) --
// flips a mod's profile-level Enabled/Disabled flag, the SAME thing the Mods table's own checkbox
// controls. Deliberately the raw action creator, not the higher-level setModsEnabled helper (which
// also emits a 'mods-enabled' analytics event and wraps a withPrePost hook) -- same "dispatch exactly
// what Vortex's own UI dispatches, no extra machinery" precedent applyRuleChange/setModAttributes
// above already established. See this file's own header comment for why this is a SEPARATE concern
// from /mods/deploy's enable flag, not a duplicate of it.
function setModEnabledAction(api, profileId, modId, enable) {
    const { actions } = require('vortex-api');
    api.store.dispatch(actions.setModEnabled(profileId, modId, enable));
}

// Batch form (2026-08-27) -- same excess-round-trip finding as applyRuleChangesBatch above.
// `items`: [{modId, enable}, ...], all against the SAME active profile (resolved once by the
// caller, same as the singular endpoint). See applyRuleChangesBatch's own header comment (CORRECTED
// 2026-08-27) for why this loops plain individual dispatches rather than a single batchDispatch --
// `batchDispatch` is not actually present on vortex-api's real runtime export, confirmed live.
function setModsEnabledBatch(api, profileId, items) {
    const { actions } = require('vortex-api');
    const results = items.map((item) => {
        if (!item || !item.modId || typeof item.enable !== 'boolean') {
            return { modId: item && item.modId, ok: false, error: 'must include modId and a boolean enable' };
        }
        api.store.dispatch(actions.setModEnabled(profileId, item.modId, item.enable));
        return { modId: item.modId, ok: true };
    });
    return results;
}

// Dispatches Vortex's own real deploy-single-mod event (confirmed real and registered in
// mod_management/index.ts, paired with api.onAsync -- NOT the callback-style deploy-mods; this one
// is Promise-based via emitAndAwait). Deploys/links (or un-links, if enable===false) exactly ONE
// mod's current staging folder into the game's Data folder -- always re-reads that mod's CURRENT
// on-disk content fresh (never assumes/caches what was there before), so it correctly picks up a
// staging folder vortex-collection-tools just re-extracted new files into. Deliberately scoped to
// ONE mod, not the whole active mod list -- confirmed via real source (modActivation.ts,
// mod_management/index.ts's onDeploySingleMod) this is the right, narrower operation for
// "redeploy just the mod(s) that changed," not the broader deploy-mods (which would re-link
// everything, and is the slow, whole-collection operation this mechanism exists to avoid).
function deploySingleMod(api, gameId, modId, enable) {
    return api.emitAndAwait('deploy-single-mod', gameId, modId, enable !== false);
}

// Dispatches Vortex's own real ADD_LOCAL_DOWNLOAD action (confirmed real, download_management's
// own actions/state.ts: "add a file that has been found on disk but where we weren't involved in
// the download" -- exactly vortex-collection-tools' own situation, since its Added-mod loop
// downloads archives directly via the Nexus API, bypassing Vortex's own download manager entirely).
// Registers the file into Vortex's own real state.persistent.downloads.files[id], giving it a real,
// Vortex-recognized archiveId. Root-cause fix (2026-08-28, live catch): without this, a mod created
// via createMod() below for a self-downloaded archive has NO archiveId at all on its own record
// (vortex-collection-tools' own resolveDownloadIdForArchive can only match archives VORTEX ITSELF
// already knows about) -- and Vortex's real Version-column grouping (InstallManager.ts's own
// checkModVariantsExist: `mods.filter(mod => mod.archiveId === archiveId)`) then incorrectly groups
// EVERY mod sharing that same missing/undefined archiveId together as if they were "variants" of
// one another, even though they're completely unrelated real mods -- confirmed live: 10 of 11
// freshly-self-downloaded mods in one real apply all showed spurious version-dropdown duplicates,
// the one exception being the single mod that already had a real live record (and therefore a real
// archiveId) from before. `id` is caller-supplied (a fresh crypto.randomUUID(), matching the shape
// Vortex's own real code generates via shortid() at the exact same call sites) rather than
// generated here, so the caller can use the SAME id it's about to put in the mod's own attributes
// without a second round trip to ask what id got assigned. Deliberately does NOT also emit
// 'did-import-downloads' (the real event Vortex's own native local-import flow fires) -- that event
// exists to trigger Vortex's own "ready to install" notification/UI side effects, which this
// project's own architecture deliberately never wants (it always handles registration/install
// itself, never hands off to Vortex's own InstallManager) -- see this file's own header comment on
// why every write here stays a "dumb relay," never a second install path.
function registerLocalDownload(api, gameId, { id, fileName, fileSize }) {
    const { actions } = require('vortex-api');
    api.store.dispatch(actions.addLocalDownload(id, gameId, fileName, fileSize));
}

// Dispatches Vortex's own real SET_DOWNLOAD_INSTALLED action (confirmed real, download_management's
// own actions/state.ts: setDownloadInstalled(id, gameId, modId) -> {id, gameId, modId} on
// state.persistent.downloads.files[id].installed). Root-cause fix (v0.21.0, 2026-10-01) for a
// SECOND real "two rows" bug, sibling to registerLocalDownload's own: a mod created via createMod()
// below for a self-downloaded archive can have a perfectly real archiveId pointing AT a real
// download record, but Vortex's own Mods table still shows that SAME download as a separate, un-
// installed row until the DOWNLOAD's own side of the link is also set -- confirmed via real source
// read (mod_management/InstallContext.ts's mSetDownloadInstalled, which every genuine Vortex
// install calls right after a successful create-mod, something createMod()/create-mod alone never
// replicates since it's a dumb relay to the create-mod event only, not Vortex's own InstallManager).
// `id` here is the DOWNLOAD's own id (the mod's `archiveId`), not the mod's id.
function setDownloadInstalled(api, gameId, { id, modId }) {
    const { actions } = require('vortex-api');
    api.store.dispatch(actions.setDownloadInstalled(id, gameId, modId));
}

// Removes ONLY a download's own tracked record from state.persistent.downloads.files -- never the
// real archive file on disk. Built for vortex-collection-tools' own duplicate-version cleanup work
// (2026-08-30): a mod's Version dropdown can show phantom "duplicate" entries for orphaned download
// registrations Vortex itself synthesizes phantom mod rows for (ModList.tsx's own real grouping --
// see that project's own diagnostics/2026-08-30-duplicate-version-cleanup-utility-scoping.md for the
// full mechanism). Confirmed LIVE, the same session this was caught: deleting an orphan's archive
// through Vortex's own "Delete Archive" UI checkbox deleted the physical file a DIFFERENT, still-
// legitimately-installed mod's own download record ALSO pointed at (same localPath, two separate
// registrations of the identical file) -- the installed mod kept working (already extracted) but
// permanently lost "Open Archive"/re-verify ability. A safe cleanup can never touch the file itself.
//
// Deliberately dispatches the RAW REDUX ACTION (`actions.removeDownloadSilent`), NOT
// `api.removeDownload()` (the higher-level extension-API method download_management's own
// extendApi.ts exposes) -- confirmed via direct source read (IPCDownloadAdapter.ts's real
// `#handleRemoveDownload`) that `api.removeDownload()` ALWAYS deletes the real file on disk
// (`await rm(path.join(dlPath, download.localPath), {force: true})`) whenever the record has a
// `localPath`, with NO way to opt out -- its own `options` parameter (silent/confirmed) is accepted
// by the wrapper but never actually read by the real IPC handler underneath, so passing `{silent:
// true}` changes nothing. The raw `removeDownload`/`removeDownloadSilent` Redux actions, by contrast,
// are confirmed pure state removals in every one of Vortex's OWN real call sites (download_management/
// index.ts) -- none of them pairs the dispatch with any filesystem call. Same "dumb relay, dispatch
// Vortex's own real action creator directly" pattern every other write in this file already follows
// (see registerLocalDownload's own header comment just above, addModRule/setModAttributes, etc.).
// KNOWN BUG, NOT FIXED (diagnosed 2026-09-01; this paragraph corrected 2026-10-05): the plain dispatch below is a genuine, correct
// in-memory removal (confirmed live -- Vortex's own UI and a fresh GET /downloads both reflect it
// immediately), but it does NOT reliably survive a Vortex restart -- confirmed live, repeatedly:
// closing and reopening Vortex brings the "removed" download record back under the SAME id and the
// SAME original fileTime (not a fresh re-scan of the file on disk -- ruled that out directly: Vortex's
// own download_management/index.ts refreshDownloads() only re-registers a file when NO existing
// record's own localPath already covers it, and here the real, still-claimed sibling download record
// for the same file DOES already cover that exact localPath, so the rescan path was directly ruled
// out by source-reading). diagnostics/2026-08-30-duplicate-version-cleanup-utility-scoping.md has the
// full investigation trail this closes: read through Vortex's own real persistence pipeline
// (persistDiffMiddleware.ts -> ReduxPersistorIPC.ts -> LevelPersist.ts; NOTE: in the newest Vortex
// source, read 2026-10-05, LevelPersist.ts is DuckDB-backed, not LevelDB, and which Vortex version the
// director actually runs is unknown) end to end and it reads as
// structurally correct for ANY dispatch origin -- no divergent code path found between this and
// Vortex's own native "Remove" (IPCDownloadAdapter.ts's #handleRemoveDownload, which dispatches the
// exact same reducer via actions.removeDownload -- confirmed byte-identical to removeDownloadSilent's
// own reducer, download_management/reducers/state.ts) that would explain native removal persisting
// reliably (confirmed live by the director -- but only when it ALSO deletes the real file, which is
// NOT safe here since another download record can share that exact same file) while this one doesn't.
//
// The attempted mitigation, kept but known NOT to work: force an EXPLICIT synchronous persist right
// after the dispatch, via the exact same IPC call Vortex's own quit-time beforeunload handler uses
// (persistDiffMiddleware.ts's flushPendingDiffsSync -> window.api.persist.sendDiffSync) instead of
// relying on the normal 100ms-debounced automatic flush. The theory was a gap between "the debounced
// middleware queues this diff" and "it reaches disk before Vortex later closes". The diagnostics
// (vortex-collection-tools' diagnostics/2026-09-01-duplicate-download-persistence-investigation.md)
// show the flush changed nothing: the record still comes back after a restart, root cause unknown.
// It is left in because it is harmless. Not part of vortex-api's own public surface (confirmed via
// etc/vortex.api.md -- no flush/persist-trigger export exists there), so this reaches through
// `window.api.persist` directly; guarded so a Vortex build that removes/renames this internal
// surface degrades to a log warning, not a hard failure.
function removeDownloadRecordOnly(api, downloadId) {
    const { actions } = require('vortex-api');
    api.store.dispatch(actions.removeDownloadSilent(downloadId));
    try {
        const persistApi = (typeof window !== 'undefined') && window.api && window.api.persist;
        if (persistApi && typeof persistApi.sendDiffSync === 'function') {
            persistApi.sendDiffSync('persistent', [{ type: 'remove', path: ['downloads', 'files', downloadId] }]);
        } else {
            log('warn', '[vortex-bridge] removeDownloadRecordOnly: window.api.persist.sendDiffSync unavailable -- removal may not survive a Vortex restart.');
        }
    } catch (err) {
        log('warn', '[vortex-bridge] removeDownloadRecordOnly: forced sendDiffSync failed', err.message);
    }
}

// Removes a download's record AND its real archive file on disk -- the deliberate OPPOSITE of
// removeDownloadRecordOnly just above. Built for vortex-collection-tools' own Duplicate Version
// Cleanup tool (2026-09-01): the diagnostics investigation this closes (see that project's own
// diagnostics/2026-09-01-duplicate-download-persistence-investigation.md) confirmed LIVE that a
// plain state-only removal (removeDownloadRecordOnly, above) does NOT reliably survive a Vortex
// restart, while removing a download through Vortex's own native UI -- which always deletes the
// real file too -- DOES persist correctly every time. This is that same real mechanism
// (the `remove-download` event, NOT the raw Redux action), exposed for that tool's own orphan-cleanup
// step. The caller MUST have already confirmed (before calling this) that no OTHER, surviving
// download record shares this same archive file -- the event has no way to protect a
// shared file, and vortex-collection-tools' own shared-archive check exists specifically to gate
// this call, not to be a redundant safety net inside this "dumb relay."
//
// v0.25.0 (2026-10-05): this used to call `api.removeDownload(id)`, which does not exist on the
// extension API object (Vortex assigns it to `api.ext`, never `api`) -- "api.removeDownload is not
// a function" on the director's Vortex, so nothing was removed. It now emits Vortex's own
// `remove-download` event, the exact thing the Downloads page's Remove button emits
// (IPCDownloadAdapter.ts #handleRemoveDownload deletes the file, then dispatches the record removal).
// Success is only reported when the record is really gone from state afterwards.
const REMOVE_DOWNLOAD_TIMEOUT_MS = 10000;

function downloadFilePath(state, record) {
    if (!record || !record.localPath) return null;
    const pattern = state.settings && state.settings.downloads ? state.settings.downloads.path : undefined;
    const gameId = (Array.isArray(record.game) && record.game[0]) || GAME_ID;
    return path.join(_resolveDownloadPath(pattern, gameId), record.localPath);
}

async function removeDownloadAndFile(api, downloadId, timeoutMs) {
    if (!api || !api.events || typeof api.events.emit !== 'function') {
        throw new Error("Vortex's event system (api.events.emit) is missing, so a download cannot be removed.");
    }
    if (typeof api.events.listenerCount === 'function' && api.events.listenerCount('remove-download') === 0) {
        throw new Error("Vortex has no 'remove-download' handler on this version, so a download cannot be removed.");
    }
    const before = api.store.getState();
    const record = before.persistent && before.persistent.downloads && before.persistent.downloads.files
        ? before.persistent.downloads.files[downloadId] : undefined;
    const filePath = downloadFilePath(before, record);

    await new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`Vortex did not answer the remove request within ${(timeoutMs || REMOVE_DOWNLOAD_TIMEOUT_MS) / 1000} seconds.`)),
            timeoutMs || REMOVE_DOWNLOAD_TIMEOUT_MS);
        api.events.emit('remove-download', downloadId, (err) => {
            clearTimeout(timer);
            if (err) reject(err); else resolve();
        });
    });

    const after = api.store.getState();
    const stillThere = after.persistent && after.persistent.downloads && after.persistent.downloads.files
        && after.persistent.downloads.files[downloadId];
    if (stillThere) throw new Error("Vortex reported the removal as done, but the download is still in its list.");
    return { fileRemoved: filePath ? !fs.existsSync(filePath) : false };
}

// Dispatches Vortex's own real create-mod event (confirmed real and registered in
// mod_management/index.ts: `api.events.on('create-mod', (gameMode, mod, callback) =>
// onAddMod(api, gameMode, mod, callback))`) -- registers a BRAND NEW mod with Vortex's own live
// state.persistent.mods[gameId] (onAddMod's own `store.dispatch(addMod(gameId, mod))`) and ensures
// its staging folder exists (`fs.ensureDirAsync`, a no-op if it's already there). `mod` is Vortex's
// own real IMod shape (id/state/type/installationPath/attributes), already fully built by the
// caller (vortex-collection-tools) -- same "dumb relay" design as every other write endpoint here,
// no mod-shape resolution logic in this extension. Real Vortex's own native "Add Mods" drag-and-
// drop flow (confirmed via the same source) calls THIS event BEFORE copying any files in;
// vortex-collection-tools calls it AFTER its own classify/extract/verify engine has already
// produced a real, verified staging folder -- registering only once the caller KNOWS extraction
// succeeded, never a possibly-broken empty entry. Idempotent in practice (re-registering the same
// modId just overwrites the same Redux entry, and ensureDirAsync on an existing folder is a no-op),
// so this is safe to retry on a network failure, same as setModAttributes/setModEnabled/deployMod.
function createMod(api, gameId, mod) {
    return new Promise((resolve, reject) => {
        api.events.emit('create-mod', gameId, mod, (err) => (err ? reject(err) : resolve()));
    });
}

// Batch form (2026-08-27) -- same excess-round-trip finding as the two batch functions above, for
// mod REGISTRATION specifically. Deliberately still loops the real per-mod `create-mod` EVENT
// (same createMod() above, same onAddMod side effects: the addMod dispatch AND its
// fs.ensureDirAsync) rather than switching to a raw batchDispatch(mods.map(addMod)) -- `create-mod`
// is Vortex's own real registration entry point (mod_management/index.ts's own
// `api.events.on('create-mod', ...)`), and staying on it keeps this endpoint's behavior identical
// to the singular /mods/create it's replacing N calls of, not a new, less-tested code path. The win
// here is purely eliminating the N HTTP round trips between mods -- each ensureDirAsync/dispatch
// pair is already a fast in-process operation once inside this one request. Sequential (not
// Promise.all) so one mod's failure can't race a folder-creation side effect against another's.
async function createModsBatch(api, gameId, mods) {
    const results = [];
    for (const item of mods) {
        if (!item || !item.modId || !item.mod || typeof item.mod !== 'object') {
            results.push({ modId: item && item.modId, ok: false, error: 'must include modId and a mod object' });
            continue;
        }
        try {
            await createMod(api, gameId, item.mod);
            results.push({ modId: item.modId, ok: true });
        } catch (err) {
            results.push({ modId: item.modId, ok: false, error: err.message });
        }
    }
    return results;
}

// Dispatches Vortex's own real remove-mods event (confirmed real and registered in
// mod_management/index.ts) -- a REAL, full uninstall per mod: purges its deployed/linked files,
// deletes its staging folder, and removes its own state.v2 record. Used for a collection update's
// "Remove All" choice on mods the new revision dropped -- the caller resolves which LIVE Vortex
// modId(s) correspond to the dropped collection.json entries; this endpoint doesn't do that
// resolution itself, same "dumb relay" design as every other write endpoint here. Callback-style
// (not emitAndAwait, unlike deploy-single-mod above) -- wrapped in a Promise so the HTTP handler can
// await it uniformly.
function removeMods(api, gameId, modIds) {
    return new Promise((resolve, reject) => {
        api.events.emit('remove-mods', gameId, modIds, (err) => (err ? reject(err) : resolve()), {
            // Matches Vortex's own real collection-update flow's own options (collections/eventHandlers.ts)
            // -- incomplete: true tolerates a mod whose files are already partially gone; ignoreInstalling
            // avoids a false "still installing" block for a mod this project's own extraction just touched.
            incomplete: true,
            ignoreInstalling: true,
            reason: 'collection_update',
        });
    });
}

// Deletes ONLY a mod's own tracked Vortex record -- deliberately NOT the real 'remove-mods' event
// above. Confirmed real via Vortex's own source (mod_management/eventHandlers.ts's undeployMods):
// when a mod's staging folder is already gone on disk, the real undeploy attempt throws ENOENT, and
// Vortex's OWN code catches that by showing a real, BLOCKING "Mod not found" dialog ("Ignore"/
// "Deploy") -- there is no option on the real event that suppresses this; it's Vortex's own hard-
// coded response to that specific error, confirmed by reading the handler directly, not guessed.
// Live-confirmed 2026-08-28 (director's own real Vortex, a real collection-update apply): this dialog
// genuinely blocks the whole remove-mods call until a person clicks it, which is exactly what
// vortex-collection-tools' own caller needs to never trigger for a mod it already knows has no real
// staging content left to undeploy in the first place (nothing to undeploy is not an error).
//
// Mirrors the real flow's own two-step sequence (mod_management/eventHandlers.ts's onRemoveMods:
// setModsEnabled(false) THEN dispatch the low-level removeMod action), just skipping the undeploy
// attempt in between -- `actions.removeMod` (mod_management/actions/mods.ts, confirmed listed in
// Vortex's own public API manifest) is a real, PLAIN action creator whose own reducer does exactly
// one thing (deleteOrNop on state.persistent.mods[gameId][modId], confirmed by reading
// reducers/mods.ts directly) -- no undeploy, no dialog risk. Any stale symlink/hardlink this mod's
// own now-missing staging folder left behind in Data/ gets cleaned up by the next real Vortex deploy
// pass, same as the dialog's own "Deploy" option would have done anyway.
function removeModRecordOnly(api, gameId, profileId, modId) {
    const { actions } = require('vortex-api');
    if (profileId) {
        api.store.dispatch(actions.setModEnabled(profileId, modId, false));
    }
    api.store.dispatch(actions.removeMod(gameId, modId));
}

// Live progress snapshot for the most recent/current deploy-mods call -- read via
// GET /mods/deploy-all/progress while POST /mods/deploy-all is in flight. KNOWN LIMITATION,
// confirmed via vortex-collection-tools' own real, prior live investigation (see that project's
// lib/vortex-helper-client.js header comment, "A DIFFERENT, now-CONFIRMED case"): a real deploy-mods
// call can make THIS WHOLE EXTENSION'S OWN HTTP server unresponsive for extended periods (a real
// ~83s block was observed in that investigation), because mod_management's own saveActivation does
// synchronous full-mod-type serialization on Vortex's single JS thread -- the same thread this
// server's own request handling runs on. That means a poll of THIS endpoint made WHILE a large
// deploy is genuinely mid-flight can itself time out or stall, not just be briefly delayed. This
// state is still written correctly by progressCB as real events arrive, so a poll that DOES succeed
// always reflects real, current progress -- it just isn't guaranteed to succeed on every attempt
// during a big deploy. Callers should treat a failed/timed-out poll as "still working, no fresh
// update available right now", never as a real error, and should always show SOME honest static
// "this can take a while" message regardless of whether any poll ever lands.
let deployAllProgress = { active: false, text: '', percent: 0, done: false, error: null };

// Dispatches Vortex's own real deploy-mods event -- the SAME event the real "Deploy Mods" button
// emits (confirmed via source, mod_management/index.ts ~1417-1434:
// `api.events.emit('deploy-mods', callback, profileId, progressCB, deployOptions)`), running the
// full real genUpdateModDeployment pipeline (sort/merge/incompatibility-check/finalize across every
// enabled mod, then the real did-deploy reaction chain that refreshes plugins.txt/loadorder.txt).
// `manual: true` matches the real Deploy Mods button's own deployOptions (skips userGate(), which
// only applies to an automatic/unattended trigger -- irrelevant here, this IS the user's own
// deliberate action, just triggered through vortex-collection-tools instead of Vortex's own UI).
function deployModsAction(api) {
    const { profileId } = getEnabledModKeys(api);
    if (!profileId) {
        return Promise.reject(new Error(`No active profile found for game "${GAME_ID}".`));
    }
    deployAllProgress = { active: true, text: 'Starting deploy...', percent: 0, done: false, error: null };
    return new Promise((resolve, reject) => {
        api.events.emit(
            'deploy-mods',
            (err) => {
                deployAllProgress = {
                    active: false, text: deployAllProgress.text, percent: deployAllProgress.percent,
                    done: true, error: err ? err.message : null,
                };
                if (err) reject(err);
                else resolve();
            },
            profileId,
            (text, percent) => {
                deployAllProgress = { active: true, text, percent, done: false, error: null };
            },
            { manual: true },
        );
    });
}

// --- ModPacer startup integration (v0.20.0) -----------------------------------
// "Run ModPacer's own check when Vortex opens" -- see this feature's own build task
// ("Vortex Bridge: start ModPacer when Vortex opens") for the full
// spec. ModPacer is a separate, standalone Node app (in its own folder)
// that Vortex Bridge has no built-in way to locate -- it records its own
// install folder into MODPACER_INFO_PATH every time it starts (interactive or --check), so this
// works without the player ever typing a path anywhere, and keeps working if they move/reinstall
// it (the file is just overwritten fresh on its next run).

// Never throws. A missing/corrupt file just means "ModPacer isn't installed, or has never run
// even once yet" -- an entirely ordinary, expected outcome, not an error. Also confirms the folder
// it points at still looks like a real install (has its own server.js) -- an install-info.json left
// behind after an uninstall/move should never cause a spawn against a folder that no longer has
// anything to run.
function findModPacerInstallPath() {
    try {
        const { installPath } = JSON.parse(fs.readFileSync(MODPACER_INFO_PATH, 'utf8'));
        if (!installPath || typeof installPath !== 'string') return null;
        if (!fs.existsSync(path.join(installPath, 'server.js'))) return null;
        return installPath;
    } catch {
        return null;
    }
}

// Which Node to run ModPacer with. ModPacer's public release brings its own runtime and
// records it as nodePath in the same pointer file; use it only if that file still exists, else fall
// back to whatever 'node' is on the PATH (the original behaviour). Never throws.
function findModPacerNodePath() {
    try {
        const { nodePath } = JSON.parse(fs.readFileSync(MODPACER_INFO_PATH, 'utf8'));
        if (nodePath && typeof nodePath === 'string' && fs.existsSync(nodePath)) return nodePath;
    } catch { /* no pointer, or unreadable: fall back */ }
    return 'node';
}

// Reads ModPacer's own "Check when Vortex starts" toggle straight from ITS OWN config.json --
// Vortex Bridge deliberately never duplicates that setting anywhere, so there is exactly one place
// it can ever be wrong. Returns true/false, or null for "genuinely unknown" (config.json exists
// but failed to parse) so the caller can skip and log rather than silently guess either way.
// Defaults to true when config.json doesn't exist yet or doesn't have the key at all, matching the
// ModPacer's own fresh-install default (that project's app-config.js DEFAULTS) -- a player who has
// never opened its Settings tab still gets the behavior its own defaults already promise.
function shouldRunModPacerCheck(installPath) {
    const configPath = path.join(installPath, 'config.json');
    if (!fs.existsSync(configPath)) return true;
    try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return cfg.checkOnVortexStart !== false;
    } catch {
        return null;
    }
}

// Runs ModPacer's own real headless check -- `node server.js --check`, the exact same command
// its own package.json "check" script and README document, in its own install folder. Fire-and-
// forget from Vortex's own point of view: this is called from a 'gamemode-activated' event handler,
// well after Vortex has already finished starting up, and the spawn itself is async -- there is
// nothing here for Vortex's own startup to wait on. The 5-minute kill is a safety net only, not an
// expected path: a real check against the real Hub catalog plus a few GitHub downloads takes
// seconds, not minutes.
//
// Exit code 2 = ModPacer isn't set up yet (v0.23.2): one Vortex notification per session with the
// "Open ModPacer" button. Other failures stay a log line, now with ModPacer's own reason line
// from check-last.txt. Older ModPacers exit 1 for the same thing; their check-last.txt says
// "not-set-up", which is treated as 2. `api` and `deps` (spawn, readReason) are optional.
const MODPACER_NOT_SET_UP_MESSAGE = MODPACER.notSetUp.message;
const modPacerSetUpState = { notified: false, opened: false };

// Never throws; '' when the file is missing or unreadable.
function readModPacerCheckReason(installPath) {
    try {
        // ModPacer writes "<ISO time> not-set-up: <what is missing>" or "<ISO time> failed: <reason>".
        // Keep the "not-set-up" marker (the caller tests for it) but drop the time and "failed:" noise.
        const line = fs.readFileSync(path.join(installPath, 'check-last.txt'), 'utf8').trim().split(/\r?\n/)[0] || '';
        return line.replace(/^\d{4}-\d\d-\d\dT\S+\s+/, '').replace(/^failed:\s*/, '');
    } catch {
        return '';
    }
}

function notifyModPacerNotSetUp(api, reason, deps = {}) {
    if (!api || modPacerSetUpState.notified || modPacerSetUpState.opened) return;
    modPacerSetUpState.notified = true;
    // "not-set-up: <what is missing>" -> show just the part after the marker; a bare marker shows nothing.
    const reasonLine = (reason || '').replace(/^not-set-up:?\s*/i, '').trim();
    try {
        api.sendNotification({
            id: MODPACER.notSetUp.id,
            type: 'warning',
            title: MODPACER.displayName,
            message: reasonLine ? `${MODPACER_NOT_SET_UP_MESSAGE} · ${reasonLine}` : MODPACER_NOT_SET_UP_MESSAGE,
            actions: [{
                title: MODPACER.openButton,
                action: () => {
                    modPacerSetUpState.opened = true;
                    openModPacerOnDemand(api, undefined, deps.open || {});
                },
            }],
        });
    } catch (err) {
        log('warn', '[vortex-bridge] could not show ModPacer not-set-up notification', err.message);
    }
}

function runModPacerCheck(installPath, api, deps = {}) {
    let child;
    try {
        child = (deps.spawn || spawn)(findModPacerNodePath(),['server.js', '--check'], { cwd: installPath, windowsHide: true, stdio: 'ignore' });
    } catch (err) {
        log('warn', "[vortex-bridge] couldn't start ModPacer's check", err.message);
        return;
    }
    const killTimer = setTimeout(() => {
        log('warn', '[vortex-bridge] ModPacer check ran past 5 minutes -- killing it');
        try { child.kill(); } catch { /* already gone */ }
    }, 5 * 60 * 1000);
    child.on('error', (err) => {
        clearTimeout(killTimer);
        log('warn', "[vortex-bridge] ModPacer check failed to start", err.message);
    });
    child.on('exit', (code) => {
        clearTimeout(killTimer);
        if (code === 0) log('info', '[vortex-bridge] ModPacer check finished');
        else {
            const reason = readModPacerCheckReason(installPath);
            if (code === 2 || (code === 1 && /not-set-up/i.test(reason))) {
                log('warn', `[vortex-bridge] ModPacer isn't set up yet${reason ? ': ' + reason : ''}`);
                notifyModPacerNotSetUp(api, reason, deps);
            } else {
                log('warn', `[vortex-bridge] ModPacer check exited with code ${code}${reason ? ': ' + reason : ''}`);
            }
        }
    });
}

// The whole feature's entry point, called from the 'gamemode-activated' handler in main() below.
// Every step is optional and silent on the ordinary "nothing to do" outcomes (not installed, or its
// own setting is off) -- only a genuinely unexpected failure (corrupt config.json, a spawn error)
// gets logged, at 'warn', and even that can never throw back up into Vortex's own event dispatch.
function triggerPluginModPacerCheck(api) {
    try {
        const installPath = findModPacerInstallPath();
        if (!installPath) return;
        const shouldRun = shouldRunModPacerCheck(installPath);
        if (shouldRun === false) return;
        if (shouldRun === null) {
            log('warn', "[vortex-bridge] ModPacer's config.json exists but couldn't be read -- skipping its startup check");
            return;
        }
        log('info', "[vortex-bridge] starting ModPacer's check");
        runModPacerCheck(installPath, api);
    } catch (err) {
        log('warn', '[vortex-bridge] ModPacer startup check failed', err.message);
    }
}

// --- ModPacer settings + "Open ModPacer" starts it on demand (v0.23.0) ------------------
// Problem (director, 2026-10-03): the notification's "Open ModPacer" opened a page that only
// exists while ModPacer's tray program is running -- not running meant a browser "This site can't
// be reached". Now the click pings ModPacer first and starts it if it isn't answering.
// The program path comes from a Vortex setting (state.settings.modPacer.exePath, set by hand on
// ModPacer settings tab) or, failing that, `exePath` in ModPacer's own install-info.json.
// The address always comes from install-info.json (`url`, or `port`), default below.
// No enable/disable setting on purpose (director, 2026-10-03): Vortex Bridge is shared with Vortex
// Collection Tools, so a switch needs more thought first.
const MODPACER_DEFAULT_ADDRESS = MODPACER.defaultAddress;
const MODPACER_START_FAILED_MESSAGE = MODPACER.startFailed.message;
const MODPACER_SETTINGS_DESCRIPTION = MODPACER.settingsDescription;
const MODPACER_NOT_A_PROGRAM_WARNING = MODPACER.notAProgramWarning;
const MODPACER_EXE_NAME = MODPACER.exeName;

// What's typed in the program box: {warning, suggestion}. Empty box = nothing to say. A file ending
// in .exe that exists = fine. Anything else warns; a folder holding the exe (directly, or in one
// subfolder) also suggests it. Never throws, never blocks saving.
function checkModPacerExePath(value) {
    const p = typeof value === 'string' ? value.trim() : '';
    if (!p) return { warning: null, suggestion: null };
    try {
        if (/\.exe$/i.test(p) && fs.existsSync(p) && fs.statSync(p).isFile()) return { warning: null, suggestion: null };
    } catch { /* fall through to the warning */ }
    let suggestion = null;
    try {
        if (fs.statSync(p).isDirectory()) {
            const direct = path.join(p, MODPACER_EXE_NAME);
            if (fs.existsSync(direct)) suggestion = direct;
            else {
                const subs = fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory());
                const hits = subs.map((d) => path.join(p, d.name, MODPACER_EXE_NAME)).filter((f) => fs.existsSync(f));
                if (subs.length === 1 && hits.length === 1) suggestion = hits[0];
            }
        }
    } catch { /* not a folder we can read */ }
    return { warning: MODPACER_NOT_A_PROGRAM_WARNING, suggestion };
}
const MODPACER_NOT_RUN_YET_NOTE = MODPACER.notRunYetNote;
const MODPACER_PING_TIMEOUT_MS = 2000;
const MODPACER_START_WAIT_MS = 10000;
const MODPACER_START_POLL_MS = 500;

// Never throws; {} when the file is missing or unreadable.
function readModPacerInfo() {
    try {
        const info = JSON.parse(fs.readFileSync(MODPACER_INFO_PATH, 'utf8'));
        return info && typeof info === 'object' ? info : {};
    } catch {
        return {};
    }
}

function getModPacerAddress() {
    const info = readModPacerInfo();
    let address = typeof info.url === 'string' && info.url ? info.url : null;
    if (!address && Number.isInteger(info.port)) address = `http://127.0.0.1:${info.port}/`;
    if (!address) address = MODPACER_DEFAULT_ADDRESS;
    return address.endsWith('/') ? address : address + '/';
}

// A path chosen by hand in Vortex Settings beats the one ModPacer recorded about itself.
function resolveModPacerExe(manualExe) {
    if (typeof manualExe === 'string' && manualExe.trim()) return manualExe.trim();
    const info = readModPacerInfo();
    return typeof info.exePath === 'string' && info.exePath ? info.exePath : null;
}

function getManualModPacerExe(api) {
    try {
        const s = api.store.getState();
        return (((s.settings || {})[MODPACER.settingsKey] || {}).exePath) || '';
    } catch {
        return '';
    }
}

// True only when GET <address>api/ping answers 200 inside the timeout. `httpGet` is injectable for tests.
function pingModPacer(address, timeoutMs = MODPACER_PING_TIMEOUT_MS, httpGet = http.get) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        try {
            const req = httpGet(new URL('api/ping', address), (res) => {
                res.resume();
                finish(res.statusCode === 200);
            });
            req.on('error', () => finish(false));
            req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch { /* gone */ } finish(false); });
        } catch {
            finish(false);
        }
    });
}

function startModPacerProgram(exePath, spawnFn = spawn) {
    return new Promise((resolve) => {
        try {
            const child = spawnFn(exePath, [], { cwd: path.dirname(exePath), detached: true, stdio: 'ignore', windowsHide: true });
            child.on('error', (err) => {
                log('warn', "[vortex-bridge] couldn't start the ModPacer program", err.message);
                resolve(false);
            });
            if (typeof child.unref === 'function') child.unref();
            // spawn reports a missing file asynchronously; give that one tick before calling it started.
            setImmediate(() => resolve(true));
        } catch (err) {
            log('warn', "[vortex-bridge] couldn't start the ModPacer program", err.message);
            resolve(false);
        }
    });
}

// Resolves true when ModPacer is answering (already was, or we started it), false otherwise.
// deps (all optional, for tests): ping, spawn, sleep, exePath, address, waitMs, pollMs.
async function ensureModPacerRunning(deps = {}) {
    const address = deps.address || getModPacerAddress();
    const ping = deps.ping || ((a) => pingModPacer(a));
    if (await ping(address)) return true;
    const exe = deps.exePath !== undefined ? deps.exePath : resolveModPacerExe('');
    if (!exe) return false;
    if (!(await startModPacerProgram(exe, deps.spawn || spawn))) return false;
    const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const pollMs = deps.pollMs || MODPACER_START_POLL_MS;
    const waitMs = deps.waitMs || MODPACER_START_WAIT_MS;
    for (let waited = 0; waited < waitMs; waited += pollMs) {
        await sleep(pollMs);
        if (await ping(address)) return true;
    }
    return false;
}

// Start it if needed, then open `url` (default: ModPacer's address); else one Vortex notification.
async function openModPacerOnDemand(api, url, deps = {}) {
    const openUrl = deps.openUrl || ((u) => require('electron').shell.openExternal(u));
    const address = deps.address || getModPacerAddress();
    const exePath = deps.exePath !== undefined ? deps.exePath : resolveModPacerExe(getManualModPacerExe(api));
    let up = false;
    try {
        up = await ensureModPacerRunning({ ...deps, address, exePath });
    } catch (err) {
        log('warn', '[vortex-bridge] starting ModPacer on demand failed', err.message);
    }
    if (!up) {
        api.sendNotification({ id: MODPACER.startFailed.id, type: 'warning', title: MODPACER.displayName, message: MODPACER_START_FAILED_MESSAGE });
        return false;
    }
    try {
        openUrl(url || address);
        return true;
    } catch (err) {
        log('warn', '[vortex-bridge] could not open ModPacer page', err.message);
        return false;
    }
}

// A notification action's URL: ModPacer's own pages go through start-on-demand, anything else opens as before.
function openNotificationUrl(api, url, deps = {}) {
    let isModPacerPage = false;
    try {
        isModPacerPage = new URL(url).origin === new URL(deps.address || getModPacerAddress()).origin;
    } catch { /* not a URL we can compare */ }
    if (isModPacerPage) return openModPacerOnDemand(api, url, deps);
    try {
        (deps.openUrl || ((u) => require('electron').shell.openExternal(u)))(url);
    } catch (err) {
        log('warn', '[vortex-bridge] could not open a notification action URL', err.message);
    }
    return Promise.resolve(false);
}

const MODPACER_SET_EXE = MODPACER.setExeAction;

// The "ModPacer" tab in Vortex Settings. Built with React.createElement (no JSX build step here).
function registerModPacerSettings(context) {
    try {
        context.registerReducer(['settings', MODPACER.settingsKey], {
            defaults: { exePath: '' },
            reducers: { [MODPACER_SET_EXE]: (state, payload) => ({ ...state, exePath: payload || '' }) },
        });
        const React = require('react');
        const h = React.createElement;
        const api = context.api;

        function ModPacerSettings() {
            const [exe, setExe] = React.useState(getManualModPacerExe(api));
            const info = readModPacerInfo();
            const effective = resolveModPacerExe(exe);
            const check = checkModPacerExePath(exe);
            const save = (value) => {
                setExe(value);
                api.store.dispatch({ type: MODPACER_SET_EXE, payload: value });
            };
            const browse = () => {
                Promise.resolve(api.selectFile({ title: 'Choose the ModPacer program', filters: [{ name: 'Program', extensions: ['exe'] }] }))
                    .then((chosen) => { if (chosen) save(chosen); })
                    .catch(() => { /* cancelled */ });
            };
            return h('div', null,
                h('h3', null, MODPACER.displayName),
                h('p', null, MODPACER_SETTINGS_DESCRIPTION),
                h('div', { style: { marginBottom: 12 } },
                    h('label', { style: { display: 'block', fontWeight: 'bold' } }, 'ModPacer program'),
                    h('div', { style: { display: 'flex', gap: 8 } },
                        h('input', {
                            type: 'text', className: 'form-control', style: { flex: 1 },
                            value: exe, placeholder: info.exePath || '', onChange: (e) => save(e.target.value),
                        }),
                        h('button', { type: 'button', className: 'btn btn-default', onClick: browse }, 'Browse')),
                    check.warning ? h('div', { style: { color: '#d9a400', marginTop: 4 } }, check.warning) : null,
                    check.suggestion ? h('div', { style: { marginTop: 4 } },
                        h('button', { type: 'button', className: 'btn btn-default btn-sm', onClick: () => save(check.suggestion) }, 'Use ' + check.suggestion)) : null,
                    h('small', { style: { display: 'block' } }, 'Usually found by itself. Change it only if you moved ModPacer.')),
                h('div', { style: { marginBottom: 12 } },
                    h('label', { style: { display: 'block', fontWeight: 'bold' } }, 'Address'),
                    h('input', { type: 'text', className: 'form-control', readOnly: true, value: getModPacerAddress() })),
                effective ? null : h('p', null, MODPACER_NOT_RUN_YET_NOTE));
        }

        context.registerSettings(MODPACER.displayName, ModPacerSettings, undefined, undefined, 150);
    } catch (err) {
        log('warn', '[vortex-bridge] could not register ModPacer settings tab', err.message);
    }
}

// --- Old "Vortex Collection Helper" still installed (v0.24.0) ----------------------------------
// The extension's id changed with its name, so a beta tester's old copy stays installed beside this
// one and would fight for the same port. Shown at most once per start, never removes anything.
let oldCopyNoticeShown = false;

function oldCopyFolderExists() {
    try {
        // Vortex loads every extension from one plugins folder; this extension's own folder is one level down.
        return fs.existsSync(path.join(path.resolve(__dirname, '..'), OLD_EXTENSION_ID));
    } catch {
        return false;
    }
}

function notifyOldCopyInstalled(api, reason) {
    if (oldCopyNoticeShown) return;
    oldCopyNoticeShown = true;
    log('warn', `[vortex-bridge] the old "${OLD_EXTENSION_NAME}" extension is still installed (${reason})`);
    try {
        api.sendNotification({ id: 'vortex-bridge-old-copy', type: 'warning', title: 'Vortex Bridge', message: OLD_COPY_MESSAGE });
    } catch (err) {
        log('warn', '[vortex-bridge] could not show the old-copy notification', err.message);
    }
}

// --- Notifications (v0.20.0) ------------------------------------------------------------------
// One Vortex notification (api.sendNotification, confirmed public in etc/vortex.api.md -- the same
// call a REAL extension's own toast uses, e.g. the cycle-blocked-deploy warning this file's own
// getSessionSignals reads back) built from a generic {title, lines, action} shape. A stable id
// means a second call (e.g. Check now finding more updates a minute later) replaces the existing
// toast instead of stacking a new one on top of it.
function sendBridgeNotification(api, { title, lines, action }) {
    // Deliberately does NOT call dismiss() (2026-09-30, real director report): clicking the action
    // used to close the whole notification immediately, whether or not the URL actually opened
    // somewhere useful -- confirmed live as confusing the one time the destination page happened
    // not to be running. The notification should only ever go away because the player closed it
    // themselves, same as every other real Vortex notification's own dismiss button already works.
    const actions = action && action.label && action.url
        ? [{
            title: action.label,
            action: () => {
                openNotificationUrl(api, action.url);
            },
        }]
        : undefined;
    api.sendNotification({
        id: 'modpacer-notify',
        type: 'info',
        title: title || 'Notification',
        // REAL, LIVE-CONFIRMED FINDING (2026-09-30): joining with '\n' looked right in every test
        // here, but Vortex's own real Notification.tsx splits `message` on '\n' into separate plain
        // <span> elements with NO separator and no line-break between them (confirmed by reading
        // its real source) -- so multiple lines run together with literally zero space in the real
        // UI ("4 updates downloading• BioForge• iActions..."), confirmed live in the director's own
        // Vortex. ' · ' (this whole ecosystem's own established separator, e.g. this project's row
        // meta lines) survives that rendering because the separator itself is real, visible
        // whitespace-bearing text, not a newline Vortex's own component silently drops.
        message: (lines || []).join(' · '),
        actions,
    });
}

// Converts ModPacer's own original call shape -- guessed by that project
// before this endpoint existed (see its own TECHNICAL.md / server.js's notifyHelperBestEffort) --
// into the generic {title, lines, action} shape above. Kept as its own real route
// (POST /plugin-updater/notify, not just an alias) rather than asking that already-shipped project
// to change its own call.
function notifyBodyFromCompatShape({ title, message, items, action }) {
    // No per-item bullet prefix (dropped 2026-09-30) -- sendBridgeNotification's own ' \u00b7 ' join is
    // what actually separates these visually now; a leading "\u2022 " on top of that read as
    // "4 updates downloading \u00b7 \u2022 BioForge \u00b7 \u2022 iActions...", a doubled-up separator.
    const lines = [];
    if (message) lines.push(message);
    for (const item of items || []) lines.push(item);
    return { title, lines, action };
}

// --- Vortex's own real folder paths for this game (v0.20.0, fixed in v0.20.1) -------------------
// REAL BUG, confirmed live in the director's own running Vortex (2026-09-30): this used to call
// `require('vortex-api').installPathForGame`/`downloadPathForGame`, on the strength of both names
// appearing in etc/vortex.api.md's own export list. They are NOT actually callable at runtime --
// confirmed via the real error this produced live, `"installPathForGame is not a function"` --
// the SAME class of gap this file's own header comment already documents for `batchDispatch`
// (listed in that same manifest, also not actually present on what `require('vortex-api')` returns
// at runtime). Lesson generalized, not just patched around this one case: a name appearing in
// etc/vortex.api.md is NOT proof it's a real, callable runtime export -- only a live call against a
// real running Vortex is.
//
// Fixed by reimplementing the resolution directly against real Vortex source (confirmed by
// reading it, not guessed): mod_management/util/getInstallPath.ts and
// download_management/util/getDownloadPath.ts. Both resolve a stored pattern (state.settings.
// mods.installPath[gameId] / state.settings.downloads.path) through the SAME real default-pattern-
// then-{USERDATA}/{GAME}/{USERNAME}-substitution-then-absolute-path-fallback logic -- replicated
// here using state reads this file's own getAllMods/getEnabledModKeys above already prove work
// (raw state.* indexing, never an imported selector), and `userData` derived from this extension's
// OWN install location (`%APPDATA%\Vortex\plugins\vortex-bridge`, two levels up from
// __dirname) rather than any Electron app.getPath() call -- that call only exists on Electron's
// MAIN process object (confirmed via real Vortex source, src/main/src/getVortexPath.ts), and this
// extension runs in the RENDERER (this file's own top header comment), where `require('electron').
// app` is undefined. Since every Vortex plugin is required to load from inside userData/plugins,
// this derivation is structurally guaranteed correct, not a machine-specific guess.
function _formatPathTemplate(pattern, gameId) {
    const userData = path.resolve(__dirname, '..', '..');
    const username = (require('os').userInfo() || {}).username || '';
    return pattern.replace(/\{userdata\}/gi, userData).replace(/\{game\}/gi, gameId || '').replace(/\{username\}/gi, username);
}
function _resolveAbsolute(result) {
    const userData = path.resolve(__dirname, '..', '..');
    // Real Vortex quirk both source files above independently guard against: on Windows, a path of
    // the form \foo\bar looks "absolute" to path.isAbsolute but is actually relative to the CURRENT
    // DRIVE, not a real root -- re-resolved against userData just like the real source does.
    if (!path.isAbsolute(result) || (process.platform === 'win32' && result[0] === '\\' && result[1] !== '\\')) {
        return path.resolve(userData, result);
    }
    return result;
}
function _resolveInstallPath(rawPattern, gameId) {
    const pattern = rawPattern || path.join('{USERDATA}', '{GAME}', 'mods');
    return _resolveAbsolute(_formatPathTemplate(pattern, gameId));
}
function _resolveDownloadPath(rawPattern, gameId) {
    const pattern = rawPattern || path.join('{USERDATA}', 'downloads');
    const formatted = gameId ? path.join(_formatPathTemplate(pattern, gameId), gameId) : _formatPathTemplate(pattern, gameId);
    return _resolveAbsolute(formatted);
}

// The current game's real, fully-resolved staging (install) and download folder paths -- built so
// ModPacer no longer has to ask the player to type its own "Vortex mods
// folder" setting (GET /mods already returns a mod's folder NAME, never where it actually lives on
// disk).
function getVortexPaths(api) {
    const state = api.store.getState();
    const installPattern = state.settings && state.settings.mods && state.settings.mods.installPath
        ? state.settings.mods.installPath[GAME_ID]
        : undefined;
    const downloadPattern = state.settings && state.settings.downloads ? state.settings.downloads.path : undefined;
    return {
        gameId: GAME_ID,
        stagingFolder: _resolveInstallPath(installPattern, GAME_ID) || null,
        downloadFolder: _resolveDownloadPath(downloadPattern, GAME_ID) || null,
    };
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            try { resolve(raw ? JSON.parse(raw) : {}); }
            catch (err) { reject(err); }
        });
        req.on('error', reject);
    });
}

// Test-only counterpart to startServer -- Vortex itself never calls this (an extension's server
// runs for the lifetime of the whole Vortex process), but a test suite needs to release port 59595
// between test files so it isn't left bound after the process exits.
function stopServer() {
    if (server) { server.close(); server = null; }
}

function startServer(api) {
    if (server) return; // already running (e.g. extension re-init) -- don't double-bind

    server = http.createServer((req, res) => {
        // Localhost-only by construction (bound to 127.0.0.1 below, never 0.0.0.0) -- this is a
        // local IPC channel between two processes on the same machine, not a network service.
        res.setHeader('Access-Control-Allow-Origin', '*'); // convenience for local dev tools only

        if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, gameId: GAME_ID, version: VERSION }));
            return;
        }

        const rulesMatch = req.url.match(/^\/rules\/([^/]+)$/);
        if (req.method === 'GET' && rulesMatch) {
            const modId = decodeURIComponent(rulesMatch[1]);
            const rules = getModRules(api, modId);
            if (rules === null) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `No mod "${modId}" found in live state for ${GAME_ID}` }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ modId, rules }));
            return;
        }

        // See GET /plugins/:pluginName's own header comment for why this exists (state.loadOrder is
        // the TRUE live source of truth, plugins.txt is only a snapshot). pluginName is the raw
        // filename (e.g. "DynDOLOD.esp") -- case/basename/.ghost handling all happen inside
        // getPluginLoadOrder itself, so the caller can pass it exactly as it appears in plugins.txt.
        const pluginMatch = req.url.match(/^\/plugins\/([^/]+)$/);
        if (req.method === 'GET' && pluginMatch) {
            const pluginName = decodeURIComponent(pluginMatch[1]);
            const result = getPluginLoadOrder(api, pluginName);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ pluginName, ...result }));
            return;
        }

        // See setPluginEnabledAction's own header comment -- CONFIRMED live 2026-08-21, not the
        // untested hypothesis this endpoint started life as. Body: { enabled: boolean }. Returns the
        // real before/after GET /plugins/:pluginName readback in the SAME response, so a caller can
        // tell immediately whether the dispatch actually took effect -- no separate follow-up GET
        // needed. Unlike /mods/set-enabled, no deploy is needed for plugins.txt (see
        // setPluginEnabledAction's CORRECTED note), as long as the plugin's file is still deployed.
        const setPluginEnabledMatch = req.url.match(/^\/plugins\/([^/]+)\/set-enabled$/);
        if (req.method === 'POST' && setPluginEnabledMatch) {
            const pluginName = decodeURIComponent(setPluginEnabledMatch[1]);
            readJsonBody(req).then((body) => {
                const { enabled } = body || {};
                if (typeof enabled !== 'boolean') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Body must include a boolean enabled.' }));
                    return;
                }
                try {
                    const before = getPluginLoadOrder(api, pluginName);
                    setPluginEnabledAction(api, pluginName, enabled);
                    const after = getPluginLoadOrder(api, pluginName);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ pluginName, requestedEnabled: enabled, before, after, changed: before.enabled !== after.enabled }));
                } catch (err) {
                    log('error', '[vortex-bridge] /plugins/:pluginName/set-enabled dispatch failed', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            }).catch((err) => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
            });
            return;
        }

        // Everything a full Scan needs in one call: the whole mods subtree (same data
        // buildModIndex(db) builds from a state.v2 iteration) plus which of those mods are enabled
        // in the active profile right now -- lets vortex-collection-tools reconstruct its own
        // modIndex live, with Vortex open, instead of reading state.v2 at all.
        if (req.method === 'GET' && req.url === '/mods') {
            const mods = getAllMods(api);
            const { profileId, enabledModKeys } = getEnabledModKeys(api);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ gameId: GAME_ID, profileId, enabledModKeys, mods }));
            return;
        }

        // Every profile for this game, live -- see getAllProfiles' own header comment for why this
        // is a separate call from /mods' own single active-profileId. Read-only, tiny payload (a
        // handful of profiles at most), so it gets the same short timeout budget as /health.
        if (req.method === 'GET' && req.url === '/profiles') {
            const profiles = getAllProfiles(api);
            const { profileId: activeProfileId } = getEnabledModKeys(api);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ gameId: GAME_ID, profiles, activeProfileId }));
            return;
        }

        // Metadata refresh after a real (fast, in-place) re-extraction -- see setModAttributes' own
        // header comment above. Body: { modId, attributes: {...} }.
        //
        // null -> undefined normalization (2026-08-23): JSON has no `undefined` -- an HTTP body can
        // only ever carry `null` for "clear this field," but Vortex's own real reducer treats the two
        // very differently. setModAttributes (plural, what this route dispatches) merges the payload
        // via a plain object spread (storeHelper.ts's own merge(): `{...existing, ...value}`), which
        // stores a literal `null` forever if that's what's sent -- confirmed against real Vortex
        // source that at least one real caller (mod_management's own CollectionTile "Update
        // available" condition, and modUpdateState.ts's updateState()) would then be reading a raw
        // `null` where real Vortex's own clearing path (checkModsVersion.ts's setNoUpdateAttributes)
        // always sends genuine JS `undefined` via the SINGULAR setModAttribute action, whose own
        // reducer explicitly deletes the key on `undefined` (deleteOrNop). Converting any top-level
        // `null` in the incoming attributes object to a real `undefined` here, before dispatch, makes
        // what this route actually sends match what Vortex's own real clearing code sends -- a small,
        // general fix that benefits every future caller wanting to clear a field, not a special case
        // bolted on for one feature. Confirmed no existing caller in vortex-collection-tools' own
        // lib/ ever intentionally sends a literal null today (grepped every setModAttributes call
        // site), so this changes no existing behavior.
        if (req.method === 'POST' && req.url === '/mods/set-attributes') {
            readJsonBody(req).then((body) => {
                const { modId, attributes } = body || {};
                if (!modId || !attributes || typeof attributes !== 'object') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Body must include modId and an attributes object.' }));
                    return;
                }
                for (const key of Object.keys(attributes)) {
                    if (attributes[key] === null) attributes[key] = undefined;
                }
                try {
                    setModAttributes(api, modId, attributes);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } catch (err) {
                    log('error', '[vortex-bridge] /mods/set-attributes dispatch failed', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            }).catch((err) => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
            });
            return;
        }

        // Re-link one mod's current staging content into the Data folder -- see deploySingleMod's own
        // header comment above. Body: { modId, enable? } (enable defaults true).
        if (req.method === 'POST' && req.url === '/mods/deploy') {
            readJsonBody(req).then(async (body) => {
                const { modId, enable } = body || {};
                if (!modId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Body must include modId.' }));
                    return;
                }
                try {
                    await deploySingleMod(api, GAME_ID, modId, enable);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } catch (err) {
                    log('error', '[vortex-bridge] /mods/deploy dispatch failed', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            }).catch((err) => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
            });
            return;
        }

        // Flip a mod's profile-level Enabled/Disabled flag -- see setModEnabledAction's own header
        // comment above for why this is a SEPARATE call from /mods/deploy. Body: { modId, enable }.
        // profileId is resolved server-side (same lastActiveProfile lookup /mods already uses) rather
        // than trusted from the caller, so a stale client-held profileId can never target the wrong
        // profile.
        if (req.method === 'POST' && req.url === '/mods/set-enabled') {
            readJsonBody(req).then((body) => {
                const { modId, enable } = body || {};
                if (!modId || typeof enable !== 'boolean') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Body must include modId and a boolean enable.' }));
                    return;
                }
                try {
                    const { profileId } = getEnabledModKeys(api);
                    if (!profileId) {
                        res.writeHead(409, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: `No active profile found for game "${GAME_ID}".` }));
                        return;
                    }
                    setModEnabledAction(api, profileId, modId, enable);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, profileId }));
                } catch (err) {
                    log('error', '[vortex-bridge] /mods/set-enabled dispatch failed', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            }).catch((err) => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
            });
            return;
        }

        // Batch form of /mods/set-enabled (2026-08-27) -- see setModsEnabledBatch's own header
        // comment. Body: { items: [{modId, enable}, ...] }. profileId resolved ONCE, server-side,
        // same as the singular endpoint.
        if (req.method === 'POST' && req.url === '/mods/set-enabled-batch') {
            readJsonBody(req).then((body) => {
                const { items } = body || {};
                if (!Array.isArray(items) || items.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Body must include a non-empty items array.' }));
                    return;
                }
                try {
                    const { profileId } = getEnabledModKeys(api);
                    if (!profileId) {
                        res.writeHead(409, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: `No active profile found for game "${GAME_ID}".` }));
                        return;
                    }
                    const results = setModsEnabledBatch(api, profileId, items);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, profileId, results }));
                } catch (err) {
                    log('error', '[vortex-bridge] /mods/set-enabled-batch dispatch failed', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            }).catch((err) => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
            });
            return;
        }

        // Registers a BRAND NEW mod with Vortex -- see createMod's own header comment above. Body:
        // { modId, mod } where `mod` is Vortex's own real IMod shape (id/state/type/
        // installationPath/attributes). modId is only used for the response/log context here (`mod`
        // already carries its own `id`, which is the one Vortex's own reducer actually reads).
        if (req.method === 'POST' && req.url === '/mods/create') {
            readJsonBody(req).then(async (body) => {
                const { modId, mod } = body || {};
                if (!modId || !mod || typeof mod !== 'object') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Body must include modId and a mod object.' }));
                    return;
                }
                try {
                    await createMod(api, GAME_ID, mod);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } catch (err) {
                    log('error', '[vortex-bridge] /mods/create dispatch failed', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            }).catch((err) => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
            });
            return;
        }

        // Registers a self-downloaded archive into Vortex's own real downloads database -- see
        // registerLocalDownload's own header comment above for the full real reasoning (root-cause
        // fix for spurious Version-column duplicates on mods vortex-collection-tools downloaded
        // itself, bypassing Vortex's download manager). Body: { id, fileName, fileSize } -- `id` is
        // caller-generated (a fresh UUID) so the caller can reuse it directly as the new mod's own
        // archiveId without a second round trip.
        if (req.method === 'POST' && req.url === '/downloads/register-local') {
            readJsonBody(req).then((body) => {
                const { id, fileName, fileSize } = body || {};
                if (!id || !fileName || typeof fileSize !== 'number') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Body must include id, fileName, and a numeric fileSize.' }));
                    return;
                }
                try {
                    registerLocalDownload(api, GAME_ID, { id, fileName, fileSize });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, archiveId: id }));
                } catch (err) {
                    log('error', '[vortex-bridge] /downloads/register-local dispatch failed', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            }).catch((err) => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
            });
            return;
        }

        // Links a download record to the mod it was installed as -- see setDownloadInstalled's own
        // header comment above for the full real reasoning. Body: { id, modId } -- `id` is the
        // DOWNLOAD's own id (the mod's archiveId).
        if (req.method === 'POST' && req.url === '/downloads/set-installed') {
            readJsonBody(req).then((body) => {
                const { id, modId } = body || {};
                if (!id || !modId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Body must include id and modId.' }));
                    return;
                }
                try {
                    setDownloadInstalled(api, GAME_ID, { id, modId });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } catch (err) {
                    log('error', '[vortex-bridge] /downloads/set-installed dispatch failed', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            }).catch((err) => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
            });
            return;
        }

        // Removes ONLY a download's own tracked record -- see removeDownloadRecordOnly's own header
        // comment above for the full real reasoning (the file on disk is NEVER touched, unlike
        // Vortex's own real api.removeDownload() extension method, confirmed to always delete it).
        // Body: { downloadIds: [...] }. Batched (one dispatch per id, same "loop + individual
        // dispatch" shape /mods/remove-record-only already uses) rather than a single-id endpoint --
        // a real cleanup pass naturally touches several orphans from the same scan at once.
        if (req.method === 'POST' && req.url === '/downloads/remove-record-only') {
            readJsonBody(req).then((body) => {
                const { downloadIds } = body || {};
                if (!Array.isArray(downloadIds) || downloadIds.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Body must include a non-empty downloadIds array.' }));
                    return;
                }
                try {
                    downloadIds.forEach((downloadId) => removeDownloadRecordOnly(api, downloadId));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, removed: downloadIds }));
                } catch (err) {
                    log('error', '[vortex-bridge] /downloads/remove-record-only dispatch failed', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            }).catch((err) => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
            });
            return;
        }

        // Removes a download's record AND its real archive file -- see removeDownloadAndFile's own
        // header comment above. Body: { downloadIds: [...] }. Each id is awaited and reported
        // independently (unlike remove-record-only's synchronous loop, this is a real async
        // per-item operation with its own filesystem side effect -- one id failing must not abort
        // the rest) -- same "per-item results array" shape /mods/create-batch already uses.
        if (req.method === 'POST' && req.url === '/downloads/remove') {
            readJsonBody(req).then(async (body) => {
                const { downloadIds } = body || {};
                if (!Array.isArray(downloadIds) || downloadIds.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Body must include a non-empty downloadIds array.' }));
                    return;
                }
                const results = [];
                for (const downloadId of downloadIds) {
                    try {
                        const { fileRemoved } = await removeDownloadAndFile(api, downloadId);
                        results.push({ downloadId, ok: true, fileRemoved });
                    } catch (err) {
                        log('error', '[vortex-bridge] /downloads/remove failed for', downloadId, err.message);
                        results.push({ downloadId, ok: false, error: err.message });
                    }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, results }));
            }).catch((err) => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
            });
            return;
        }

        // Batch form of /mods/create (2026-08-27) -- see createModsBatch's own header comment. Body:
        // { mods: [{modId, mod}, ...] }. Returns per-item results (a batch can partially fail --
        // unlike the two Redux-only batch endpoints below, this one drives real async event handlers
        // with real filesystem side effects, so one item's failure is genuinely independent of the
        // others', not a single all-or-nothing dispatch).
        if (req.method === 'POST' && req.url === '/mods/create-batch') {
            readJsonBody(req).then(async (body) => {
                const { mods } = body || {};
                if (!Array.isArray(mods) || mods.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Body must include a non-empty mods array.' }));
                    return;
                }
                try {
                    const results = await createModsBatch(api, GAME_ID, mods);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, results }));
                } catch (err) {
                    log('error', '[vortex-bridge] /mods/create-batch dispatch failed', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            }).catch((err) => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
            });
            return;
        }

        // Deletes ONLY a mod's own tracked record, WITHOUT Vortex's real undeploy attempt -- see
        // removeModRecordOnly's own header comment above for the full real reasoning (this exists
        // specifically to avoid Vortex's own real, blocking "Mod not found" dialog for a mod the
        // caller already knows has no staging content left to undeploy). Body: { modIds: [...] }.
        // profileId resolved server-side, same convention /mods/set-enabled already uses.
        if (req.method === 'POST' && req.url === '/mods/remove-record-only') {
            readJsonBody(req).then((body) => {
                const { modIds } = body || {};
                if (!Array.isArray(modIds) || modIds.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Body must include a non-empty modIds array.' }));
                    return;
                }
                try {
                    const { profileId } = getEnabledModKeys(api);
                    modIds.forEach((modId) => removeModRecordOnly(api, GAME_ID, profileId, modId));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, profileId }));
                } catch (err) {
                    log('error', '[vortex-bridge] /mods/remove-record-only dispatch failed', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            }).catch((err) => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
            });
            return;
        }

        // Fully uninstall one or more mods -- see removeMods' own header comment above. Body:
        // { modIds: [...] }.
        if (req.method === 'POST' && req.url === '/mods/remove') {
            readJsonBody(req).then(async (body) => {
                const { modIds } = body || {};
                if (!Array.isArray(modIds) || modIds.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Body must include a non-empty modIds array.' }));
                    return;
                }
                try {
                    await removeMods(api, GAME_ID, modIds);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } catch (err) {
                    log('error', '[vortex-bridge] /mods/remove dispatch failed', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            }).catch((err) => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
            });
            return;
        }

        // The REAL, full deploy pipeline -- see deployModsAction's own header comment. No body needed
        // (always targets the active profile, resolved server-side, same reasoning as
        // /mods/set-enabled's own profileId resolution). This call genuinely can take a while (real
        // file I/O across every enabled mod, plus a LOOT plugin sort that can run 20s+ on a large
        // load order) -- callers should poll GET /mods/deploy-all/progress for live status rather
        // than assume this resolves quickly.
        if (req.method === 'POST' && req.url === '/mods/deploy-all') {
            deployModsAction(api).then(() => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            }).catch((err) => {
                log('error', '[vortex-bridge] /mods/deploy-all dispatch failed', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            });
            return;
        }

        // Best-effort live status for an in-flight /mods/deploy-all -- see deployAllProgress's own
        // header comment for the real limitation on how reliably this responds during a large
        // deploy. Always responds with whatever the current snapshot is (never blocks/waits).
        // externalChangesPending/blockingDialogs (see getSessionSignals' own header comment) are
        // folded in fresh on every request -- this turns the caller's old stall-TIMER guessing ("no
        // progress for ~15s, maybe a popup?") into a real fact read straight from Vortex's own live
        // state: if Vortex is genuinely sitting on a blocking dialog, the caller knows immediately,
        // not after waiting out a tick count.
        if (req.method === 'GET' && req.url === '/mods/deploy-all/progress') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ...deployAllProgress, ...getSessionSignals(api), needToDeploy: getNeedToDeploy(api) }));
            return;
        }

        // Everything a Clean Up scan needs for the "downloads" half -- the whole downloads.files
        // subtree, live, matching cleanup-scan.js's own state.v2 iteration field for field
        // (localPath/state/game per download). Deliberately a separate endpoint from /mods rather
        // than folded into it -- these are two structurally different Redux subtrees
        // (state.persistent.downloads vs state.persistent.mods), and Clean Up's own Scan Staging
        // doesn't need this half at all, so a mods-only caller shouldn't pay for it.
        if (req.method === 'GET' && req.url === '/downloads') {
            const files = getAllDownloads(api);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ gameId: GAME_ID, files }));
            return;
        }

        // See getVortexPaths' own header comment -- the current game's real staging/download
        // folders, fully resolved, so a caller never has to ask the player to type either one in.
        if (req.method === 'GET' && req.url === '/paths') {
            // REAL, LIVE-CONFIRMED BUG (2026-09-30), fixed here: this used to call
            // res.writeHead(200, ...) BEFORE computing the JSON body, so a throw from
            // getVortexPaths() while building it (the real installPathForGame bug above) tried a
            // SECOND res.writeHead(500, ...) after headers were already sent -- crashing the whole
            // renderer process with an unrecoverable ERR_HTTP_HEADERS_SENT error, confirmed live in
            // the director's own running Vortex. The fix is mechanical and applies to any route,
            // not just this one: compute the full response body FIRST, in its own try/catch, and
            // only ever call res.writeHead/res.end ONCE, after that's already succeeded.
            let body;
            let statusCode = 200;
            try {
                body = JSON.stringify(getVortexPaths(api));
            } catch (err) {
                log('error', '[vortex-bridge] /paths failed', err.message);
                statusCode = 500;
                body = JSON.stringify({ error: err.message });
            }
            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
            res.end(body);
            return;
        }

        // One generic write primitive covers apply-fix (remove old + add flipped, or remove-only) AND
        // revert (add back the original, with or without removing a current one first) -- same two
        // dispatches either way, just which of remove/add is present and what's in them differs.
        if (req.method === 'POST' && req.url === '/rules/apply') {
            readJsonBody(req).then((body) => {
                const { modId, remove, add } = body || {};
                if (!modId || (!remove && !add)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Body must include modId and at least one of remove/add.' }));
                    return;
                }
                try {
                    applyRuleChange(api, modId, remove, add);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } catch (err) {
                    log('error', '[vortex-bridge] /rules/apply dispatch failed', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            }).catch((err) => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
            });
            return;
        }

        // Batch form of /rules/apply (2026-08-27) -- see applyRuleChangesBatch's own header comment.
        // Body: { items: [{modId, remove?, add?}, ...] }.
        if (req.method === 'POST' && req.url === '/rules/apply-batch') {
            readJsonBody(req).then((body) => {
                const { items } = body || {};
                if (!Array.isArray(items) || items.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Body must include a non-empty items array.' }));
                    return;
                }
                try {
                    const results = applyRuleChangesBatch(api, items);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, results }));
                } catch (err) {
                    log('error', '[vortex-bridge] /rules/apply-batch dispatch failed', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            }).catch((err) => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
            });
            return;
        }

        // Generic: {title, lines: string[], action?: {label, url}}. Shows ONE Vortex notification
        // (see sendBridgeNotification's own header comment) with each line of `lines` on its own
        // line in the toast, and -- if `action` is given -- a button that opens `action.url` in
        // the player's default browser. Kept general enough for vortex-collection-tools to reuse
        // later, per this feature's own build task.
        if (req.method === 'POST' && req.url === '/notify') {
            readJsonBody(req).then((body) => {
                const { title, lines, action } = body || {};
                if (!title || !Array.isArray(lines)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Body must include a title and a lines array.' }));
                    return;
                }
                try {
                    sendBridgeNotification(api, { title, lines, action });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } catch (err) {
                    log('error', '[vortex-bridge] /notify failed', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            }).catch((err) => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
            });
            return;
        }

        // Compatibility path for ModPacer's own already-shipped call --
        // {title, message, items: string[], action?}. See notifyBodyFromCompatShape's own header
        // comment for the conversion; this is the exact route + body shape that project's
        // server.js already calls on every check that finds something new.
        if (req.method === 'POST' && req.url === '/plugin-updater/notify') {
            readJsonBody(req).then((body) => {
                const { title, message, items, action } = body || {};
                if (!title || (!message && !Array.isArray(items))) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Body must include a title and a message and/or an items array.' }));
                    return;
                }
                try {
                    sendBridgeNotification(api, notifyBodyFromCompatShape({ title, message, items, action }));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } catch (err) {
                    log('error', '[vortex-bridge] /plugin-updater/notify failed', err.message);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                }
            }).catch((err) => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
            });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unknown route. Try GET /health, GET /rules/:modId, GET /mods, GET /downloads, GET /paths, GET /profiles, GET /plugins/:pluginName, POST /plugins/:pluginName/set-enabled, POST /rules/apply, POST /rules/apply-batch, POST /mods/set-attributes, POST /mods/deploy, POST /mods/deploy-all, GET /mods/deploy-all/progress, POST /mods/set-enabled, POST /mods/set-enabled-batch, POST /mods/remove, POST /mods/remove-record-only, POST /mods/create, POST /mods/create-batch, POST /downloads/register-local, POST /downloads/set-installed, POST /downloads/remove-record-only, POST /downloads/remove, POST /notify, or POST /plugin-updater/notify' }));
    });

    server.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE') notifyOldCopyInstalled(api, `port ${PORT} is already in use`);
        log('error', `[vortex-bridge] server error (port ${PORT} may already be in use)`, err.message);
    });

    server.listen(PORT, '127.0.0.1', () => {
        log('info', `[vortex-bridge] listening on http://127.0.0.1:${PORT}`);
    });

    // Runs independent of whether GET /mods/deploy-all/progress is being polled -- see
    // checkSessionSignalTransition's own header comment for why this needs its own timer rather than
    // only piggybacking on that one endpoint.
    setInterval(() => checkSessionSignalTransition(api), 1000);
}

function main(context) {
    registerModPacerSettings(context);
    context.once(() => {
        startServer(context.api);
        if (oldCopyFolderExists()) notifyOldCopyInstalled(context.api, 'its folder is in the plugins folder');

        // 'gamemode-activated' (confirmed real, packages/vortex-api/docs/EVENTS.md: "User switched
        // to a different game mode") fires once Vortex has genuinely finished loading a game --
        // including at Vortex's own startup, when it loads whichever game was last active
        // (confirmed via real source, gamemode_management/GameModeManager.ts: only fires after the
        // game's own discovery/tool-validation chain resolves and the profile has switched) -- not
        // merely "Vortex's own window opened". Filtered to this extension's own GAME_ID scope; a
        // player who isn't even managing Skyrim SE right now should never have anything of this
        // extension's spawned in the background.
        context.api.events.on('gamemode-activated', (gameId) => {
            if (gameId !== GAME_ID) return;
            triggerPluginModPacerCheck(context.api);
        });
    });

    return true;
}

// Exposed for tests only (see tests/README or the test files themselves) -- Vortex itself only
// ever calls this module as a plain function, and never looks at any property on it, so attaching
// these doesn't change how Vortex loads or runs the extension at all.
main.__testables = {
    findModPacerInstallPath, findModPacerNodePath, shouldRunModPacerCheck, runModPacerCheck, triggerPluginModPacerCheck,
    modPacerSetUpState, MODPACER_NOT_SET_UP_MESSAGE, readModPacerCheckReason,
    notifyBodyFromCompatShape, sendBridgeNotification, getVortexPaths, MODPACER_INFO_PATH, getNeedToDeploy,
    readModPacerInfo, getModPacerAddress, resolveModPacerExe, pingModPacer, ensureModPacerRunning, openModPacerOnDemand,
    openNotificationUrl, MODPACER_START_FAILED_MESSAGE, MODPACER_NOT_RUN_YET_NOTE,
    checkModPacerExePath, MODPACER_SETTINGS_DESCRIPTION, MODPACER_NOT_A_PROGRAM_WARNING,
    startServer, stopServer, PORT,
    COMPANIONS, OLD_COPY_MESSAGE, OLD_EXTENSION_ID, notifyOldCopyInstalled, oldCopyFolderExists,
    resetOldCopyNotice: () => { oldCopyNoticeShown = false; },
    _resolveInstallPath, _resolveDownloadPath, _formatPathTemplate, removeDownloadAndFile,
};

module.exports = main;
