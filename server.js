'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const { dataPath } = require('./lib/data-dir');
const http = require('http');

const appConfig = require('./lib/app-config');
const engine = require('./lib/plugin-updater-engine');
const checkLock = require('./lib/check-lock');
const { detectSkyrimInstallPath } = require('./lib/skyrim-detect');
const firstRunSetup = require('./lib/first-run-setup');
const helperBundle = require('./lib/helper-bundle');
const { logUpdate } = require('./lib/update-log');
const { pickFolderAsync } = require('./lib/vortex-sync/win-dialog');
const nexus = require('./lib/nexus');
const { openDownloadFolder } = require('./lib/open-download-folder');
const { readTheme } = require('./lib/skyrimnet-theme');
const { writeInstallPointer } = require('./lib/helper-pointer');
const vortexHelperClient = require('./lib/vortex-helper-client');
const modManager = require('./lib/mod-manager');
const { APP_VERSION } = require('./lib/app-version');
const vortexUpdate = require('./lib/vortex-update');
const vortexLaunch = require('./lib/vortex-launch');
const oldCleanup = require('./lib/old-download-cleanup');
const fomodPickerData = require('./lib/fomod-picker-data');
const { createVortexConsoleNotes } = require('./lib/console-notes');

const PORT = process.env.PORT || 47821;

const MOD_MANAGER_LOCKED = "Your mod manager can't be changed from here. To switch, start ModPacer fresh (see Help).";

// What the Settings tab (and the first-run popup) need: the saved settings, plus the mod-manager
// facts -- whether a choice still has to be made, and (Vortex only) whether the Vortex Collection
// Helper is installed. Nothing here talks to Vortex.
function settingsPayload(cfg) {
    const manager = modManager.getModManager(cfg);
    return {
        ...appConfig.redactConfig(cfg),
        modManager: manager,
        modManagerNeedsChoice: !manager,
        helperInstalled: manager === 'mo2' ? null : bridgeStatus.cached().installed,
        bridge: manager === 'mo2' ? null : bridgeStatus.cached(),
        helperDownloadUrl: modManager.HELPER_DOWNLOAD_URL,
        helperBundled: helperBundle.isBundled(),
        setup: firstRunSetup.setupSummary(cfg),
    };
}

const bridgeStatus = require('./lib/bridge-status');
const LISTEN_HOST = '127.0.0.1';

function buildApp() {
    const app = express();
    app.use(require('./lib/local-guard').localGuard(logUpdate)); // first of all: only ModPacer's own page may talk to this server
    app.use(express.json());
    app.use(express.static(path.join(__dirname, 'web', 'public')));

    // A tiny, fast identity check -- never touches engine/config/the Helper. The one thing a
    // second copy asks when it can't get the port: "is that actually the updater, or something
    // else entirely?" (queue: already-running-just-open-it, 2026-10-01).
    app.get('/api/ping', (req, res) => {
        res.json({ app: 'modpacer', ok: true, version: APP_VERSION });
    });

    // Does the page need to ask the player to start Vortex? Only for Vortex chosen + Helper installed
    // + Vortex not running (connection state 'vortex_not_running' -- already false for MO2, a missing
    // Helper, and Vortex-running-but-Helper-silent). helperAnswering is what the waiting popup polls.
    // canOpen: whether Vortex's own program could be found reliably (see lib/vortex-launch.js); only
    // looked up when it matters.
    // The Help tab's guide: release/HELP.md (HELP.md in the package) turned into sections; { ok: false } when the file is missing.
    app.get('/api/help', (req, res) => res.json(require('./lib/help').load()));

    app.get('/api/vortex-status', async (req, res) => {
        const connectionState = await vortexUpdate.getHelperConnectionState();
        const needsStart = modManager.getModManager() === 'vortex' && connectionState === 'vortex_not_running';
        res.json({
            connectionState,
            needsStart,
            helperAnswering: connectionState === 'connected',
            canOpen: needsStart ? !!vortexLaunch.findVortexExeCached() : false,
        });
    });

    app.post('/api/open-vortex', (req, res) => {
        if (modManager.getModManager() !== 'vortex') return res.status(400).json({ error: 'Vortex is not the chosen mod manager.' });
        const started = vortexLaunch.openVortex();
        if (!started) return res.status(404).json({ error: "Couldn't find Vortex on this PC." });
        res.json({ ok: true });
    });

    app.get('/api/state', async (req, res) => {
        // Recomputes every downloaded row's "can Update" status against Vortex's current live
        // state on every single call -- not only once, right after the download itself (queue:
        // fix-update-button-folder-layout, 2026-09-30).
        // The answer never waits long on Vortex: these reads (can Update, is a deploy still needed, is a stale "isn't answering" over) run in the
        // background, and the request is answered with what is known after at most a second. While an update runs they are not started at all, so
        // the row's live state is never held behind a Vortex that is busy installing.
        if (!engine.updateRunning()) {
            const background = Promise.all([
                engine.refreshUpdatePreviews(),
                engine.refreshDeployNeeded(), // a deploy the person did in Vortex themselves takes the offer away
                (async () => {
                    // A "helper isn't answering" state that is no longer true clears by itself (and one fresh check runs).
                    const s = engine.getState();
                    if (s.vortexGaveUp || s.vortexHelperState === 'vortex_running_helper_unreachable') {
                        try { if ((await vortexUpdate.getHelperConnectionState()) === 'connected') engine.clearStaleHelperTrouble(); } catch { /* still down */ }
                    }
                })(),
            ]).catch(() => {});
            let done = false;
            background.then(() => { done = true; });
            await Promise.race([background, new Promise((r) => setTimeout(r, 1000))]);
            if (!done) engine.markPreviewsPending();
        }
        const st = engine.getState();
        // A check the updater itself is running, or the headless one Vortex started (another process: seen through its note).
        const elsewhere = checkLock.heldByOther();
        res.json({ ...st, checking: st.checking || elsewhere, checkingElsewhere: elsewhere });
    });

    app.post('/api/check', async (req, res) => {
        try {
            await engine.check({ force: !!(req.body && req.body.force) });
            // Same live "can Update" refresh GET /api/state does -- the page renders THIS response
            // directly rather than polling state again right after Check now finishes.
            await engine.refreshUpdatePreviews();
            res.json(engine.getState());
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/plugins/:id/download', async (req, res) => {
        const row = await engine.downloadPlugin(req.params.id, { userAsked: true }); // only the auto-download omits this
        if (!row) return res.status(404).json({ error: 'Unknown mod id.' });
        res.json(row);
    });

    // "Is this the same as <a mod you already have in Vortex>?": the person's Yes or No for a Hub listing under Mods not installed. Saved, then a
    // fresh check moves the row (Yes) or drops the question for good (No). Answered here with the new state, as Check now does.
    app.post('/api/plugins/:id/same-as', async (req, res) => {
        const r = engine.answerPair(req.params.id, req.body && req.body.answer);
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        try {
            await engine.check({ force: false });
            await engine.refreshUpdatePreviews();
            res.json(engine.getState());
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // A click through to a mod's own page (the Mod page arrow, Open on Nexus): counted on the plugins page, in the background. The page has
    // already opened the link; this never delays or blocks anything.
    // "This mod is currently disabled. Do you want to enable it or keep it disabled?": which of these mods are off in Vortex right now, and the answer.
    app.post('/api/disabled-mods', async (req, res) => {
        try {
            const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.filter((i) => typeof i === 'string') : [];
            res.json({ disabled: await engine.findDisabled(ids) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    app.post('/api/disabled-choice', (req, res) => {
        const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.filter((i) => typeof i === 'string') : [];
        const r = engine.setDisabledChoice(ids, req.body && req.body.choice);
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        res.json({ ok: true });
    });

    app.post('/api/plugins/:id/visit', (req, res) => {
        engine.recordVisit(req.params.id);
        res.json({ ok: true });
    });

    app.post('/api/open-download-folder', (req, res) => {
        try {
            openDownloadFolder(appConfig.loadConfig().downloadFolder);
            res.json({ ok: true });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.post('/api/plugins/:id/update', async (req, res) => {
        const { row, result } = await engine.updatePlugin(req.params.id);
        if (!row) return res.status(404).json({ error: 'Unknown mod id, or not downloaded yet.' });
        res.json({ row, result });
    });

    // "Try again" for a mod that installed but whose rules didn't all carry over: re-applies just that part.
    app.post('/api/plugins/:id/retry-carry-over', async (req, res) => {
        const { row, result } = await engine.retryCarryOver(req.params.id);
        if (!row) return res.status(404).json({ error: 'Nothing to try again for this mod.' });
        res.json({ row, result });
    });

    // Checks the old downloads of updated mods are really gone (and finishes any that were left pending). Waits for the pass.
    app.post('/api/cleanup-old-downloads', async (req, res) => {
        const result = await oldCleanup.runCleanup();
        await engine.retryOldCopies(); // the old copies (mod, archive, folder) an update could not finish removing
        res.json({ ok: true, ...result });
    });

    // Deploy: Vortex's real full deploy through the Helper (one at a time). Answers at once; the page polls /api/deploy/progress.
    // 202 started; 409 one is already running (the page just follows that one); 200 { ok: false, reason } Vortex isn't answering.
    app.post('/api/deploy', async (req, res) => {
        try {
            const out = await engine.startDeploy();
            if (out.busy) return res.status(409).json({ error: 'A deploy is already in progress.' });
            if (out.ok === false) return res.json(out);
            res.status(202).json(out);
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.get('/api/deploy/progress', (req, res) => {
        res.json(engine.deployProgress());
    });

    // A FOMOD mod's options screen (the new options, old choices pre-filled). Installs nothing.
    app.post('/api/plugins/:id/wizard', async (req, res) => {
        const { row, result } = await engine.prepareWizard(req.params.id);
        if (!row) return res.status(404).json({ error: 'Unknown mod id, or not downloaded yet.' });
        res.json({ row, result });
    });

    app.post('/api/plugins/:id/finish-wizard', async (req, res) => {
        const { row, result } = await engine.finishWizard(req.params.id, (req.body && req.body.picks) || {});
        if (!row) return res.status(404).json({ error: "No install wizard pending for this mod." });
        res.json({ row, result });
    });

    // A FOMOD preview image the screen asked for (a plain <img src>): served from the scratch folder the images were
    // extracted into when the screen was prepared. Read-only; a path that climbs out of that folder is a 404.
    app.get('/api/fomod-image', (req, res) => {
        const { modId, imagePath } = req.query || {};
        if (!modId || !imagePath) return res.status(400).end();
        const resolved = fomodPickerData.serveFomodImage(String(modId), String(imagePath));
        if (!resolved) return res.status(404).end();
        res.sendFile(resolved);
    });

    // Best-effort cleanup once the screen closes (Finish, Skip or Cancel). Always answers ok: a failed cleanup of a scratch
    // folder is never something to show the player.
    app.post('/api/fomod-image-cleanup', (req, res) => {
        const { modId, imageCacheToken } = req.body || {};
        if (modId && imageCacheToken) {
            try { fomodPickerData.releaseFomodImages(String(modId), String(imageCacheToken)); } catch { /* disk hygiene only */ }
        }
        res.json({ ok: true });
    });

    app.get('/api/theme', (req, res) => {
        res.json(readTheme(appConfig.loadConfig().skyrimInstallPath));
    });

    app.get('/api/settings', async (req, res) => {
        let cfg = appConfig.loadConfig();
        // "Mod Staging Folder": filled in from Vortex the first time it's ever empty (director,
        // 2026-09-30 -- Vortex's own name for it) -- still editable afterward (Browse... saves a
        // player's own choice over this, permanently; MO2 users, who have no Vortex staging folder
        // to read, just keep picking their own). Best-effort: an older Helper (no /paths yet) or the
        // Helper simply not running both fall through to leaving this empty, same as before this
        // feature existed.
        if (!cfg.vortexStagingFolder && !modManager.isMo2(cfg)) { // never ask Vortex anything once MO2 is chosen
            const paths = await vortexHelperClient.getPaths();
            if (paths && paths.stagingFolder) {
                cfg = appConfig.saveConfig({ vortexStagingFolder: paths.stagingFolder });
            }
        }
        res.json(settingsPayload(cfg));
    });

    app.post('/api/settings', async (req, res) => {
        const patch = { ...req.body };
        // The mod manager is chosen once, in first-run setup (POST /api/setup/mod-manager) -- never from here.
        if ('modManager' in patch) {
            return res.status(400).json({ error: MOD_MANAGER_LOCKED });
        }
        // The key is write-only from the browser's own point of view -- never echoed back.
        const next = appConfig.saveConfig(patch);
        res.json(settingsPayload(next));
        // Saving a download folder (or turning auto-download on) starts whatever's ALREADY known
        // to be pending from the last check immediately -- same real downloads a check would start,
        // not delayed until the next one (queue: plugins-tab-notice-saved-settings, 2026-09-30).
        // Fire-and-forget, after the response: the player doesn't wait on a download to finish just
        // to see their settings save go through.
        if (('downloadFolder' in patch || 'autoDownload' in patch) && next.autoDownload && next.downloadFolder) {
            engine.maybeAutoDownloadNow().catch(() => {});
        }
    });

    app.post('/api/settings/browse-folder', async (req, res) => {
        try {
            const picked = await pickFolderAsync({ title: req.body && req.body.title, initialDir: req.body && req.body.initialDir });
            res.json({ path: picked });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/settings/detect-skyrim', (req, res) => {
        res.json({ path: detectSkyrimInstallPath() });
    });

    // ---- First-run setup (queue: first-run-setup-steps). The page's step-by-step pop-up asks these. ----

    // Step 1: the one place the mod manager is saved. Allowed while none is chosen yet; afterwards only a repeat of the
    // same answer is accepted. Changing it means a fresh install (delete %APPDATA%\ModPacer).
    app.post('/api/setup/mod-manager', (req, res) => {
        const choice = req.body && req.body.modManager;
        if (choice !== 'vortex' && choice !== 'mo2') return res.status(400).json({ error: 'Pick Vortex or Mod Organizer 2.' });
        const current = modManager.getModManager(appConfig.loadConfig());
        if (current && current !== choice) return res.status(409).json({ error: MOD_MANAGER_LOCKED });
        res.json(settingsPayload(appConfig.saveConfig({ modManager: choice })));
    });

    // Step 2: the saved Skyrim folder, or the auto-detected one, and whether it really holds SkyrimSE.exe.
    app.get('/api/setup/skyrim', (req, res) => {
        const saved = appConfig.loadConfig().skyrimInstallPath;
        const found = saved || detectSkyrimInstallPath();
        res.json({ path: found || null, state: firstRunSetup.skyrimState(found), detected: !saved && !!found });
    });
    app.post('/api/setup/skyrim-check', (req, res) => {
        const p = req.body && req.body.path;
        res.json({ state: firstRunSetup.skyrimState(p) });
    });

    // Step 3: can this folder be used? kind = 'downloads' | 'mods'. problem: null | 'empty' | 'missing' | 'skyrim-folder' | 'data-folder'.
    app.post('/api/setup/folder-check', (req, res) => {
        const body = req.body || {};
        const skyrim = appConfig.loadConfig().skyrimInstallPath;
        res.json({ problem: firstRunSetup.folderProblem(body.path, body.kind === 'mods' ? 'mods' : 'downloads', skyrim) });
    });

    // Step 3 (Vortex): the downloads and staging folders, read from Vortex through the Helper (its /paths answer). read =
    // false when Vortex/the Helper can't be asked right now (Vortex closed, an older Helper) -- the page then shows empty
    // fields. Only the current game's folders count: anything but Skyrim SE is ignored.
    app.get('/api/setup/vortex-folders', async (req, res) => {
        if (modManager.getModManager() !== 'vortex') return res.json({ read: false, downloadFolder: null, stagingFolder: null });
        const paths = await vortexHelperClient.getPaths();
        const usable = paths && (!paths.gameId || paths.gameId === 'skyrimse');
        const downloadFolder = usable && typeof paths.downloadFolder === 'string' ? paths.downloadFolder : null;
        const stagingFolder = usable && typeof paths.stagingFolder === 'string' ? paths.stagingFolder : null;
        res.json({ read: !!(downloadFolder || stagingFolder), downloadFolder, stagingFolder });
    });

    // Step 5 (Vortex): what the updater can see of the Helper right now -- the same checks the rest of the app uses.
    app.get('/api/setup/helper-status', async (req, res) => {
        // One shared answer (lib/bridge-status.js): asks the Bridge itself first; the folder on disk is only the fallback.
        const bridge = await bridgeStatus.get(() => vortexUpdate.getHelperConnectionState());
        res.json({
            ...bridge,
            answering: bridge.connectionState === 'connected' || bridge.answering, // a Bridge that answers /health is there (busy or not)
            canOpen: !!vortexLaunch.findVortexExeCached(),
            helperDownloadUrl: modManager.HELPER_DOWNLOAD_URL,
            bundled: helperBundle.isBundled(), // this copy of ModPacer carries the Bridge (a dev checkout doesn't)
        });
    });

    // "Get the Vortex Bridge": opens Explorer on the bundled Bridge's .zip (selected) and tries to bring that window to the front. ModPacer never
    // installs the Bridge itself (nothing here writes into Vortex's folders): the person drops the .zip onto Vortex's Extensions page.
    app.post('/api/setup/helper-open-zip', (req, res) => {
        const r = helperBundle.openZipFolder();
        r.front.then((how) => { if (how === 'notfound' || how === 'error') logUpdate(`explorer window with the Vortex Bridge's .zip was not brought to the front (${how})`); }); // the log only, never the player's window
        res.json({ ok: r.ok, reason: r.reason });
    });

    // Progress: the step the player reached (a whole number from 1), or null once setup is finished.
    app.post('/api/setup/step', (req, res) => {
        const step = req.body && req.body.step;
        const value = Number.isInteger(step) && step >= 1 && step <= 6 ? step : null;
        res.json(settingsPayload(appConfig.saveConfig({ setupStep: value })));
    });

    // The Nexus key's Check. Sends nothing back but the result: { ok, isPremium } or { error, kind } with a FIXED sentence per kind, never Nexus's own text and never the key.
    //   kind: 'rejected' (Nexus said 401/403: not a valid key), 'busy' (429), 'unreachable' (no connection, a Nexus error, anything else).
    app.post('/api/settings/check-nexus-key', async (req, res) => {
        const key = (req.body && req.body.key) || appConfig.loadConfig().nexusApiKey;
        if (!key) return res.status(400).json({ error: 'No key to check.', kind: 'empty' });
        try {
            const result = await nexus.checkApiKey(key);
            res.json({ ok: true, isPremium: !!result.isPremium });
        } catch (e) {
            const code = e && e.statusCode;
            if (code === 401 || code === 403) return res.status(401).json({ error: "Nexus didn't accept that key.", kind: 'rejected' });
            if (code === 429) return res.status(429).json({ error: 'Nexus is busy. Try again in a minute.', kind: 'busy' });
            res.status(502).json({ error: "Couldn't reach Nexus. Check your internet and try again.", kind: 'unreachable' });
        }
    });

    return app;
}

// Best-effort: ask the Vortex Bridge to show one notification listing what's new. The
// Helper doesn't have this endpoint yet (it's a separate, already-queued item in that project --
// see TECHNICAL.md) -- every failure here (connection refused, 404, timeout) is silently ignored,
// exactly the "skip the notification if the helper endpoint isn't there yet" the task asked for.
// The rows worth a notification: installed mods with a real update only (never a "Mods not installed" listing).
function updateRowsToReport(rows) {
    return (rows || []).filter((r) => !r.notInstalled && ['downloaded', 'queued', 'downloading', 'update_available'].includes(r.status));
}
// What is true about them: all downloaded, all downloaded-or-on-their-way, or (anything still waiting) just available.
function updateNotificationMessage(items) {
    const n = items.length;
    const what = `${n} update${n === 1 ? '' : 's'}`;
    if (items.every((r) => r.status === 'downloaded')) return `${what} downloaded`;
    if (items.every((r) => r.status !== 'update_available')) return `${what} downloading`;
    return `${what} available`;
}
function notifyHelperBestEffort(items) {
    return new Promise((resolve) => {
        if (modManager.isMo2()) return resolve(); // MO2 chosen: nothing is ever sent to Vortex
        if (!items || items.length === 0) return resolve(); // no installed mod has an update: no notification at all
        const body = JSON.stringify({
            title: 'SkyrimNet mods',
            message: updateNotificationMessage(items),
            items: items.map((i) => i.title),
            action: { label: 'Open ModPacer', url: `http://127.0.0.1:${PORT}/` },
        });
        const target = require('./lib/vortex-helper-client').getHelperTarget();
        const req = http.request({
            host: target.host, port: target.port, path: '/plugin-updater/notify', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 2000,
        }, (res) => { res.resume(); resolve(); });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve()); // not installed / no such route yet / Vortex not open -- fine, skip silently
        req.write(body);
        req.end();
    });
}

// The one plain line printed at start-up when Vortex simply isn't open (replaces the old
// "[helper] ... ECONNREFUSED" lines). null = print nothing: Mod Organizer 2 chosen, or Vortex is open.
// Pure -- the caller supplies the facts.
function startupNoticeLine({ modManager: manager, vortexRunning }) {
    if (manager === 'mo2' || vortexRunning) return null;
    return "Vortex isn't open, so updates will download and wait. Open Vortex to install them or install them manually in Vortex.";
}
function printStartupNotice() {
    const line = startupNoticeLine({
        modManager: modManager.getModManager(),
        vortexRunning: vortexHelperClient.isVortexRunning(),
    });
    if (line) console.log(line);
}

// One line in the data folder's check-last.txt after a headless check, so "check exited with code N" in Vortex's log
// can be explained without it. Exit 2: "<time> not-set-up: <what is missing>"; exit 1: "<time> failed: <reason>";
// a good check clears the file. Never holds a secret. Never throws.
function recordCheckResult(kind, reason) {
    try {
        const file = dataPath('check-last.txt');
        if (!kind) { fs.rmSync(file, { force: true }); return; }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${new Date().toISOString()} ${kind}: ${reason}
`);
    } catch { /* a diagnostic only */ }
}

// Waits (no output at all) while Vortex is open but still loading. true = go ahead: ready, or there is nothing to wait for
// (Mod Organizer 2, no Helper, Vortex closed -- the check then runs as it always has). false = still not ready at the limit.
async function waitForVortexReady({ limitMs = 150_000, pollMs = 2500 } = {}) {
    const waitStates = ['vortex_starting', 'vortex_running_helper_unreachable'];
    const until = Date.now() + limitMs;
    for (;;) {
        const state = await vortexUpdate.getHelperConnectionState();
        if (!waitStates.includes(state)) return true;
        if (Date.now() >= until) return false;
        await new Promise((r) => setTimeout(r, pollMs));
    }
}

// Exit codes (the Vortex Bridge reads these): 0 = checked fine, 1 = the check failed,
// 2 = the updater is not set up yet (no Skyrim folder chosen).
async function runHeadlessCheck(opts = {}) {
    checkLock.acquire();
    try { await runHeadlessCheckInner(opts); } finally { checkLock.release(); }
}
async function runHeadlessCheckInner({ waitLimitMs, waitPollMs, settleLimitMs } = {}) {
    // The Helper starts this check while Vortex is still loading: wait, quietly, until Vortex is really ready (the same
    // two-good-reads rule the page uses) before the first real read. Never ready in time -> a clean exit, nothing half-checked.
    // Nothing to wait for when the updater is not set up yet: the check just reports that.
    if (appConfig.loadConfig().skyrimInstallPath && !(await waitForVortexReady({ limitMs: waitLimitMs, pollMs: waitPollMs }))) {
        recordCheckResult('skipped', "Vortex wasn't ready in time, so no check was made.");
        console.log("[modpacer] Vortex wasn't ready in time, so no check was made.");
        return;
    }
    let state = await engine.check({ force: false });
    // An incomplete first result (Vortex had not filled everything in) repeats within its own limit before the summary is written.
    await engine.waitForSettled({ limitMs: settleLimitMs });
    if (!state.error) state = engine.getState();
    if (state.error) {
        const notSetUp = !!state.notSetUp;
        recordCheckResult(notSetUp ? 'not-set-up' : 'failed', state.error);
        console.error(`[modpacer] ${state.error}`);
        process.exitCode = notSetUp ? 2 : 1;
        return;
    }
    recordCheckResult(null);
    // Downloads already happen inside check() when autoDownload is on -- give them a moment to
    // land before reporting what's new, same "give async work started inside check a beat"
    // reasoning as the dashboard's own polling.
    await new Promise((r) => setTimeout(r, 1500));
    const allRows = engine.getState().rows;
    const newlyDownloaded = updateRowsToReport(allRows);
    console.log(`[modpacer] Checked ${allRows.filter((r) => !r.notInstalled).length} mod(s), ${newlyDownloaded.length} with an update.`);
    if (newlyDownloaded.length > 0) {
        await notifyHelperBestEffort(newlyDownloaded);
    }
}

// Asks whatever is already listening on `port` whether it's this same updater (queue:
// already-running-just-open-it, 2026-10-01; director's own real report: a second copy printed
// "running at..." and exited, which looked like a crash -- the real cause, confirmed by
// reproducing it directly, is that Express 5's app.listen(port, cb) reuses the SAME `cb` as both
// the success callback AND the error handler, so it fires -- wrongly claiming success -- on
// EADDRINUSE too). A short real HTTP request to the real new /api/ping route; any failure at all
// (refused, timed out, wrong shape -- some other program entirely) reports false, never a throw.
function pingExistingServer(port) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 2000 }, (res) => {
            let body = '';
            res.on('data', (d) => { body += d; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body).app === 'modpacer');
                } catch {
                    resolve(false);
                }
            });
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(false));
    });
}

// Pure decision, no I/O or process control of its own -- safe to call directly from a test. The
// real startup code below is the only thing that acts on what this returns.
function describePortConflict(port, isUpdater) {
    if (isUpdater) {
        return { message: 'ModPacer is already running. Opened it in your browser.', openUrl: `http://127.0.0.1:${port}/`, exitCode: 0 };
    }
    return {
        message: `Port ${port} is already being used by something else, not ModPacer -- close it, or set a different PORT, and try again.`,
        openUrl: null, exitCode: 1,
    };
}

// The one real side effect here (a genuine new OS process) -- deliberately its own tiny function,
// never exercised for real in tests, same reasoning as lib/open-download-folder.js's own spawn.
function openBrowser(url) {
    if (process.env.MODPACER_NO_BROWSER) return; // tests and release dry runs never pop a browser
    require('child_process').exec(`start "" "${url}"`);
}

if (require.main === module) {
    // Written on every real run, interactive or --check -- see helper-pointer.js's own header
    // comment for why this always happens up front, before branching into either mode below.
    writeInstallPointer(__dirname, PORT);
    if (process.argv.includes('--check')) {
        printStartupNotice();
        runHeadlessCheck().catch((e) => {
            recordCheckResult('failed', e && e.message ? e.message : String(e));
            console.error(`[modpacer] ${e && e.message ? e.message : e}`);
            process.exitCode = 1;
        }).then(() => process.exit(process.exitCode || 0));
    } else {
        engine.startFresh(); // start fresh: forget unfinished-update bookkeeping; start-up only reads, never cleans up or retries
        const app = buildApp();
        vortexUpdate.setConnectionListener(createVortexConsoleNotes());
        // This PC only (queue: modpacer-gets-a-real-windows-installer, 2026-10-05): listening on 127.0.0.1 means nothing else on the network can reach
        // ModPacer, and Windows Firewall never asks "allow Node.js JavaScript Runtime?" (it only asks for a program that listens on every address).
        const server = app.listen(PORT, LISTEN_HOST);
        // Deliberately NOT a callback passed to listen() itself -- see pingExistingServer's own
        // comment on why that silently lies about success on a port conflict. Two separate
        // listeners instead, one per real outcome.
        server.on('listening', () => {
            console.log(`ModPacer running at http://127.0.0.1:${PORT}`);
            printStartupNotice();
            openBrowser(`http://127.0.0.1:${PORT}/`);
        });
        server.on('error', async (err) => {
            if (err.code !== 'EADDRINUSE') {
                console.error(err.message);
                process.exitCode = 1;
                return;
            }
            const isUpdater = await pingExistingServer(PORT);
            const outcome = describePortConflict(PORT, isUpdater);
            console.log(outcome.message);
            if (outcome.openUrl) {
                openBrowser(outcome.openUrl);
                // A few seconds to actually read the message before the window closes on its own
                // (start.bat only pauses on a nonzero exit code -- see that file's own comment).
                setTimeout(() => process.exit(0), 3000);
            } else {
                process.exitCode = outcome.exitCode;
            }
        });
    }
}

module.exports = { LISTEN_HOST, buildApp, waitForVortexReady, runHeadlessCheck, settingsPayload, startupNoticeLine, notifyHelperBestEffort, updateRowsToReport, updateNotificationMessage, pingExistingServer, describePortConflict };
