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
const { logUpdate, logArea, logAreaOnce, noteSecret, logFile } = require('./lib/update-log');
const os = require('os');
const platform = require('./lib/platform');
// The "Browse..." folder chooser: the one this system has.
function pickFolderAsync(opts) {
    return require('./lib/vortex-sync/win-dialog').pickFolderAsync(opts);
}
// false when there is no chooser to draw on this system: the page then shows a box to type the folder in.
function canBrowse() {
    return true;
}
const nexus = require('./lib/nexus');
const { openDownloadFolder } = require('./lib/open-download-folder');
const { readTheme } = require('./lib/skyrimnet-theme');
const { writeInstallPointer } = require('./lib/helper-pointer');
const vortexHelperClient = require('./lib/vortex-helper-client');
const modManager = require('./lib/mod-manager');
const mo2Instance = require('./lib/mo2-instance');
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
        // The page leaves out what this system does not have, and lets the person type a folder when there is no chooser.
        platform: platform.current(),
        canBrowse: canBrowse(),
        // MO2 only: a plain-words problem with the MO2 folder the player picked (nothing usable in it), else null.
        mo2Problem: manager === 'mo2' && cfg.mo2Folder ? mo2Instance.resolveInstance(cfg.mo2Folder).problem : null,
    };
}

// Security round two, S3: what the page may load and do. No inline script anywhere (every script is one of ModPacer's own files), so
// scripts are 'self' only. The page and its scripts write style="..." attributes in many places: that is the one narrow allowance
// (style attributes only, never a style block or a script). Nothing loads from another site, and nothing may frame the page.
const PAGE_CSP = [
    "default-src 'none'", "script-src 'self'", "style-src 'self'", "style-src-attr 'unsafe-inline'", "img-src 'self' data:",
    "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');
function pageSecurityHeaders(req, res, next) {
    res.setHeader('Content-Security-Policy', PAGE_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
}

const FOMOD_IMAGE_EXT_RE = /\.(png|jpe?g|gif|bmp|webp)$/i;
const REQUEST_ERROR_MESSAGE = "ModPacer couldn't read that request.";
const SERVER_ERROR_MESSAGE = 'Something went wrong inside ModPacer. Try again.';

const bridgeStatus = require('./lib/bridge-status');
const LISTEN_HOST = '127.0.0.1';

function buildApp() {
    const app = express();
    app.disable('x-powered-by');
    app.use(require('./lib/local-guard').localGuard(logUpdate)); // first of all: only ModPacer's own page may talk to this server
    app.use(pageSecurityHeaders);
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

    // "Open log folder": Explorer on the folder that holds update.log. Always exactly that folder, never a path from the page.
    app.post('/api/open-log-folder', (req, res) => {
        try {
            const dir = path.dirname(logFile());
            fs.mkdirSync(dir, { recursive: true });
            openDownloadFolder(dir);
            res.json({ ok: true });
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // The setup pop-up tells the log every error or warning it shows, word for word (the page makes some of them itself). Plain
    // text only, one line, short; it goes through the same secret-removal as every other line.
    app.post('/api/log-shown', (req, res) => {
        const text = req.body && typeof req.body.text === 'string' ? req.body.text.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 400) : '';
        if (text) logArea('setup', `shown to the player: ${text}`);
        res.json({ ok: true });
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
        if (!resolved || !FOMOD_IMAGE_EXT_RE.test(resolved)) return res.status(404).end(); // pictures only, whatever the archive named
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
        const cfg = appConfig.loadConfig();
        res.json(readTheme(cfg.skyrimInstallPath, { skyrimNetFolder: cfg.skyrimNetFolder, modsFolder: cfg.vortexStagingFolder, downloadFolder: cfg.downloadFolder, mo2Folder: modManager.isMo2(cfg) ? cfg.mo2Folder : null }));
    });

    app.get('/api/settings', async (req, res) => {
        let cfg = appConfig.loadConfig();
        // "Mod Staging Folder": filled in from Vortex the first time it's ever empty (director,
        // 2026-09-30 -- Vortex's own name for it) -- still editable afterward (Browse... saves a
        // player's own choice over this, permanently; MO2 users, who have no Vortex staging folder
        // to read, just keep picking their own). Best-effort: an older Helper (no /paths yet) or the
        // Helper simply not running both fall through to leaving this empty, same as before this
        // feature existed.
        // Only once the player has chosen Vortex: before that (a clean install on step 1) or with Mod Organizer 2 it asks Vortex nothing,
        // so a Vortex folder can never land in the settings of someone who then picks Mod Organizer 2 (1.1.1, the director's clean install).
        if (!cfg.vortexStagingFolder && modManager.getModManager(cfg) === 'vortex') {
            const paths = await vortexHelperClient.getPaths();
            if (paths && paths.stagingFolder) {
                cfg = appConfig.saveConfig({ vortexStagingFolder: paths.stagingFolder, stagingFolderFromVortex: true });
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
        if (typeof patch.nexusApiKey === 'string') noteSecret(patch.nexusApiKey); // so the log can never carry it, even by accident
        const checked = appConfig.validateSettingsPatch(req.body === undefined ? {} : req.body); // only the settings the page really has, each with the right kind of value
        if (!checked.ok) {
            logArea('settings', `not saved (valid: no): ${checked.error}; names: ${Object.keys(patch).join(', ') || '(none)'}`);
            return res.status(400).json({ error: checked.error });
        }
        // The key is write-only from the browser's own point of view -- never echoed back.
        // MO2: one folder is enough -- fill what is not set from ModOrganizer.ini (read only), and turn a program or base
        // folder given as the staging or Skyrim folder into the real folder.
        const toSave = { ...checked.patch };
        if ('vortexStagingFolder' in toSave) toSave.stagingFolderFromVortex = false; // the person's own folder from now on
        if (modManager.isMo2(appConfig.loadConfig())) Object.assign(toSave, mo2Instance.derivePatch(appConfig.loadConfig(), toSave));
        // The switch's own two lines: "turned off" is written BEFORE it stops (so a later report shows why the log is quiet), "turned on" after it starts.
        const wasKeeping = appConfig.loadConfig().keepLog !== false;
        if ('keepLog' in toSave && wasKeeping && toSave.keepLog === false) logArea('settings', 'logging turned off');
        const next = appConfig.saveConfig(toSave);
        if ('keepLog' in toSave && !wasKeeping && toSave.keepLog !== false) logArea('settings', 'logging turned on');
        logArea('settings', `saved (valid: yes): ${describeSettingsChange(toSave)}`);
        if (modManager.isMo2(next) && 'mo2Folder' in toSave && next.mo2Folder) {
            const problem = mo2Instance.resolveInstance(next.mo2Folder).problem;
            logArea('setup', `MO2 folder: ${problem ? `no settings file read (${problem})` : 'read ok'}`);
        }
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

    // What a settings save changed, for the log: the names, the folders and switches by value, and for the Nexus key only whether
    // it was set or cleared. Never the key itself.
    function describeSettingsChange(patch) {
        return Object.keys(patch).map((name) => {
            if (name === 'nexusApiKey') return patch[name] ? 'nexusApiKey (set)' : 'nexusApiKey (cleared)';
            const v = patch[name];
            return `${name}=${typeof v === 'string' ? (v || '(empty)') : JSON.stringify(v)}`;
        }).join(', ') || '(nothing)';
    }

    app.post('/api/settings/browse-folder', async (req, res) => {
        try {
            if (!canBrowse()) return res.json({ path: null, noChooser: true }); // no chooser on this system: the page shows a typing box instead
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
    // same answer is accepted. Changing it means a fresh install (delete ModPacer's data folder).
    app.post('/api/setup/mod-manager', (req, res) => {
        const choice = req.body && req.body.modManager;
        if (choice !== 'vortex' && choice !== 'mo2') return res.status(400).json({ error: 'Pick Vortex or Mod Organizer 2.' });
        const current = modManager.getModManager(appConfig.loadConfig());
        if (current && current !== choice) { logArea('setup', `mod manager: kept ${current} (a change to ${choice} was refused)`); return res.status(409).json({ error: MOD_MANAGER_LOCKED }); }
        logArea('setup', `mod manager: ${choice}`);
        const patch = { modManager: choice };
        const before = appConfig.loadConfig();
        // A staging folder ModPacer itself filled in from Vortex is not an MO2 folder: clear it (one the person typed or browsed to stays).
        if (choice === 'mo2' && before.stagingFolderFromVortex && before.vortexStagingFolder) {
            patch.vortexStagingFolder = null;
            patch.stagingFolderFromVortex = false;
            logArea('setup', 'Mods folder: cleared (it had been filled in from Vortex)');
        }
        res.json(settingsPayload(appConfig.saveConfig(patch)));
    });

    // Step 2: the saved Skyrim folder, or the auto-detected one, and whether it really holds SkyrimSE.exe.
    app.get('/api/setup/skyrim', (req, res) => {
        const saved = appConfig.loadConfig().skyrimInstallPath;
        const found = saved || detectSkyrimInstallPath();
        const skyrimState = firstRunSetup.skyrimState(found);
        logAreaOnce('setup-skyrim', 'setup', `Skyrim folder: ${found ? `${skyrimState} (${saved ? 'saved' : 'detected'}) ${found}` : 'not found'}`);
        res.json({ path: found || null, state: skyrimState, detected: !saved && !!found });
    });
    app.post('/api/setup/skyrim-check', (req, res) => {
        const p = req.body && req.body.path;
        const skyrimState = firstRunSetup.skyrimState(p);
        logArea('setup', `Skyrim folder checked: ${skyrimState}${typeof p === 'string' && p ? ' ' + p : ''}`);
        res.json({ state: skyrimState });
    });

    // Step 3: can this folder be used? kind = 'downloads' | 'mods'. problem: null | 'empty' | 'missing' | 'skyrim-folder' | 'data-folder'.
    app.post('/api/setup/folder-check', (req, res) => {
        const body = req.body || {};
        const skyrim = appConfig.loadConfig().skyrimInstallPath;
        const kind = body.kind === 'mods' ? 'mods' : 'downloads';
        const problem = firstRunSetup.folderProblem(body.path, kind, skyrim);
        const word = problem === 'missing' ? 'missing' : problem ? `not usable (${problem})` : 'exists';
        logArea('setup', `${kind === 'mods' ? 'Mods' : 'Downloads'} folder: ${word}${typeof body.path === 'string' && body.path ? ' ' + body.path : ''}`);
        res.json({ problem });
    });

    // Step 4 (Vortex; the Bridge step comes first): the downloads and staging folders, read from Vortex through the Bridge (its /paths
    // answer). The page asks again every few seconds while a box is empty. read = false when Vortex/the Bridge can't be asked right now
    // (Vortex closed, no Bridge, an older Bridge) -- the page then shows empty fields, with `reason` choosing the one plain line:
    // 'vortex-closed' (Vortex is not running) | 'no-bridge' (Vortex is open but the Bridge does not answer). Only the current game's
    // folders count (anything but Skyrim SE is ignored), and only a folder that really exists is handed back.
    app.get('/api/setup/vortex-folders', async (req, res) => {
        if (modManager.getModManager() !== 'vortex') return res.json({ read: false, reason: null, downloadFolder: null, stagingFolder: null });
        const paths = await vortexHelperClient.getPaths();
        const usable = paths && (!paths.gameId || paths.gameId === 'skyrimse');
        const existing = (p) => (typeof p === 'string' && p && firstRunSetup.folderProblem(p, 'downloads', null) === null ? p : null);
        const downloadFolder = usable ? existing(paths.downloadFolder) : null;
        const stagingFolder = usable ? existing(paths.stagingFolder) : null;
        const read = !!(downloadFolder || stagingFolder);
        const reason = read ? null : (vortexHelperClient.isVortexRunning() === false ? 'vortex-closed' : 'no-bridge');
        logAreaOnce('setup-vortex-folders', 'setup', `Vortex folders: ${read ? 'read from Vortex' : `not read (${reason === 'vortex-closed' ? 'Vortex closed' : 'no Bridge answering, an older Bridge, or another game'})`}`);
        res.json({ read, reason, downloadFolder, stagingFolder });
    });

    // Step 5 (Vortex): what the updater can see of the Helper right now -- the same checks the rest of the app uses.
    app.get('/api/setup/helper-status', async (req, res) => {
        // One shared answer (lib/bridge-status.js): asks the Bridge itself first; the folder on disk is only the fallback.
        const bridge = await bridgeStatus.get(() => vortexUpdate.getHelperConnectionState());
        logAreaOnce('setup-bridge', 'setup', `Vortex Bridge: installed=${!!bridge.installed}, state=${bridge.connectionState || 'unknown'}`);
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
        logArea('setup', value ? `reached step ${value}` : 'setup finished');
        res.json(settingsPayload(appConfig.saveConfig({ setupStep: value })));
    });

    // The Nexus key's Check. Sends nothing back but the result: { ok, isPremium } or { error, kind } with a FIXED sentence per kind, never Nexus's own text and never the key.
    //   kind: 'rejected' (Nexus said 401/403: not a valid key), 'busy' (429), 'unreachable' (no connection, a Nexus error, anything else).
    app.post('/api/settings/check-nexus-key', async (req, res) => {
        const key = (req.body && req.body.key) || appConfig.loadConfig().nexusApiKey;
        if (!key) return res.status(400).json({ error: 'No key to check.', kind: 'empty' });
        noteSecret(key);
        try {
            const result = await nexus.checkApiKey(key);
            logArea('setup', `Nexus key check: accepted (Premium: ${result.isPremium ? 'yes' : 'no'})`);
            res.json({ ok: true, isPremium: !!result.isPremium });
        } catch (e) {
            const code = e && e.statusCode;
            logArea('setup', `Nexus key check: ${code === 401 || code === 403 ? 'not accepted' : code === 429 ? 'Nexus busy' : 'could not reach Nexus'}`);
            if (code === 401 || code === 403) return res.status(401).json({ error: "Nexus didn't accept that key.", kind: 'rejected' });
            if (code === 429) return res.status(429).json({ error: 'Nexus is busy. Try again in a minute.', kind: 'busy' });
            res.status(502).json({ error: "Couldn't reach Nexus. Check your internet and try again.", kind: 'unreachable' });
        }
    });

    // Last of all (security round two, S4): any error that reaches here gets a short plain answer, never Express's page with the
    // stack and this PC's folders. The detail goes to logs/update.log only.
    app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
        const status = err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
        // A body that was not valid JSON: only that fact, never the parser's message (it can quote the body, keys included). Everything
        // else keeps its stack; update-log removes any secret from it on the way in.
        const detail = err && err.type === 'entity.parse.failed' ? 'the request body was not valid JSON' : (err && err.stack ? err.stack : err);
        try { logArea('error', `error on ${req.method} ${String(req.url).split('?')[0]}: ${detail}`); } catch { /* the log is never a reason to fail */ }
        if (res.headersSent) return;
        res.status(status).json({ error: status === 500 ? SERVER_ERROR_MESSAGE : REQUEST_ERROR_MESSAGE });
    });

    return app;
}

// The first lines of every run: versions and where the data lives. Never a key, never a path outside this app's own data folder choice.
function systemName() {
    return 'Windows';
}
function logStart(mode, port) {
    try {
        logArea('start', `ModPacer ${APP_VERSION} (${mode}); Node ${process.versions.node}; ${systemName()} ${os.release()} (${os.arch()}); data folder: ${process.env.MODPACER_DATA_DIR ? 'moved' : 'default'}; mod manager: ${modManager.getModManager() || 'not chosen yet'}${port ? `; port ${port}` : ''}`);
    } catch { /* the log is never a reason to fail */ }
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
    if (platform.isWindows()) writeInstallPointer(__dirname, PORT); // only the Vortex Bridge reads it
    if (process.argv.includes('--check')) {
        logStart('background check');
        printStartupNotice();
        runHeadlessCheck().catch((e) => {
            recordCheckResult('failed', e && e.message ? e.message : String(e));
            console.error(`[modpacer] ${e && e.message ? e.message : e}`);
            process.exitCode = 1;
        }).then(() => process.exit(process.exitCode || 0));
    } else {
        logStart('window', PORT);
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
            logArea('error', `the server could not start: ${err.code || err.message}`);
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
                // (the Windows launcher only pauses on a nonzero exit code -- see its own comment).
                setTimeout(() => process.exit(0), 3000);
            } else {
                process.exitCode = outcome.exitCode;
            }
        });
    }
}

module.exports = { logStart, LISTEN_HOST, buildApp, waitForVortexReady, runHeadlessCheck, settingsPayload, startupNoticeLine, notifyHelperBestEffort, updateRowsToReport, updateNotificationMessage, pingExistingServer, describePortConflict };
