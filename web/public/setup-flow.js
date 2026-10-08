'use strict';
// First-run setup (queue: first-run-setup-steps, 2026-10-03): the decisions behind the step-by-step pop-up, kept free of
// any page/DOM code so tests/test-first-run-setup.js can drive them in Node. The page (setup.js) draws the steps.
// Loaded as a plain script in the browser (sets window.setupFlow) and as a module in Node.
(function (root) {
    // Same lists as lib/first-run-setup.js (a test keeps the two equal). Not chosen yet counts as Vortex.
    const VORTEX_KINDS = ['manager', 'skyrim', 'helper', 'folders', 'options', 'check'];
    const MO2_KINDS = ['manager', 'skyrim', 'folders', 'options', 'check'];
    let platform = 'win32';
    function setPlatform(p) { platform = p || 'win32'; }
    const NAMES = { manager: 'Mod manager', skyrim: 'Skyrim', folders: 'Folders', options: 'Options', helper: 'Bridge', check: 'Check' };

    function stepKinds(manager) {
        return manager === 'mo2' ? MO2_KINDS : VORTEX_KINDS;
    }
    function stepNames(manager) { return stepKinds(manager).map((k) => NAMES[k]); }

    // The text on the Next button of each step ("Next: Skyrim", ...), named after the step it leads to.
    function nextLabel(manager, index) {
        const kinds = stepKinds(manager);
        const to = kinds[index + 1];
        if (!to) return null;
        return to === 'check' ? 'Next: Check my mods' : 'Next: ' + NAMES[to];
    }

    // The Helper step, on the way in: answering -> ready; installed on disk but not answering -> Vortex needs a restart
    // to load it; not there at all -> the "not installed" page. status = GET /api/setup/helper-status.
    // The Bridge's own answer comes first (a Bridge that answers is installed, whatever its folder is called); the folder on disk only decides when it does not answer:
    // answering -> older than ModPacer needs ('outdated') / an update comes with ModPacer ('newer') / ready ('installed'); not answering but its folder is there ->
    // Vortex closed: 'unreachable' (open Vortex, check again), Vortex running: 'restart'; nothing -> the "not installed" page.
    function helperEntryPane(status) {
        if (!status) return 'notinstalled';
        if (status.answering) return status.outdated ? 'outdated' : status.newerBundled ? 'newer' : 'installed';
        if (status.installed) return status.vortexRunning === false ? 'unreachable' : 'restart';
        return status.bundled ? 'bundled' : 'notinstalled';
    }

    // ModPacer never installs the Bridge: the person adds the .zip to Vortex themselves, then presses "Check again". What that finds:
    // answering -> ready; its folder is in Vortex's add-ons folder but it does not answer yet -> Vortex needs a restart to load it;
    // neither -> "not found yet" (with the way back to the file, and Check again).
    function helperCheckPane(status) {
        if (status && status.answering) return 'installed';
        if (status && status.installed) return status.vortexRunning === false ? 'unreachable' : 'restart';
        return 'notdetected';
    }

    // The same words on the setup step, the Mods-page banner and the Settings line (release/HELP.md says the same).
    // Buttons and tabs bold, the file in code style. `where` is 'page' for the banner and the Settings line, else the setup step.
    // The Bridge is installed but older than ModPacer needs: same banner, same button, same steps as "missing" (lib/plugin-updater-engine.js has the same words for the rows).
    const BRIDGE_OUTDATED = "Your Vortex Bridge is out of date. Drop the new zip file onto Vortex's Extensions page.";
    // Installed and answering, and the one that comes with ModPacer is newer: an update, never a problem (Skip stays allowed).
    function bridgeNewerText(installed, bundled) { return `Vortex Bridge ${installed} is installed. A newer one, ${bundled}, comes with ModPacer.`; }
    // Its folder is there but it does not answer, and Vortex is not open.
    const BRIDGE_UNREACHABLE = "Vortex Bridge is installed, but ModPacer can't reach it. Open Vortex and click Check again.";
    const BRIDGE_MISSING = "Vortex Bridge isn't installed. It's a Vortex extension that lets updates install seamlessly into Vortex, stay organized within your collections, and automatically check for updates whenever Vortex launches. It comes inside ModPacer, and you add it to Vortex yourself.";
    // The one builder of the numbered steps for every place (setup, banner, Settings). `installed`: the person already has a Bridge (a newer one comes with ModPacer, or theirs is
    // out of date): Vortex does not take a second copy on top of the old one, so the old extension goes first (step 2). Nothing installed: the original four steps.
    const BRIDGE_REMOVE_STEP = 'Remove the existing extension and restart Vortex.';
    function bridgeStepsHtml(where, installed) {
        const last = where === 'page' ? 'Click <b>Check now</b> on the Mods page.' : 'Click <b>Check again</b> here.';
        return '<ol class="su-list"><li>Open Vortex, then <b>Home</b>, then <b>Extensions</b>.</li>'
            + (installed ? `<li>${BRIDGE_REMOVE_STEP}</li>` : '')
            + (where === 'setup'
                ? '<li>Get the <button class="su-link" data-su="open-zip">Vortex Bridge</button>, then drag <code>vortex-bridge.zip</code> onto the <b>Drop File(s)</b> box.</li>' // the link opens the folder that holds the zip (the old footer button did)
                : '<li>Drag <code>vortex-bridge.zip</code> onto the <b>Drop File(s)</b> box.</li>')
            + '<li>Restart Vortex if it asks.</li>'
            + `<li>${last}</li></ol>`;
    }

    // Watches the "Restart Vortex" page. Each poll's status gives 'ready' (the Helper answers), 'notfound' (Vortex was
    // closed and is open again, yet the Helper still isn't there), or 'waiting'. A restart only counts once Vortex has been
    // seen closed, so a Vortex that simply stays open never produces a false "not found".
    function createRestartWatcher(initialStatus) {
        let sawClosed = !!(initialStatus && initialStatus.vortexRunning === false);
        return {
            next(status) {
                if (!status) return 'waiting';
                if (status.answering) return 'ready';
                if (!status.vortexRunning) { sawClosed = true; return 'waiting'; }
                const silent = status.connectionState === 'vortex_running_helper_unreachable' || status.connectionState === 'helper_not_installed';
                return sawClosed && silent ? 'notfound' : 'waiting';
            },
        };
    }

    // The last step's "ready" line.
    function summaryLine(manager) {
        return { manager: manager === 'mo2' ? 'Mod Organizer 2' : 'Vortex' };
    }

    // "Check complete: N updates are waiting."
    function completionText(count) {
        if (count === 0) return 'Check complete: no updates are waiting.';
        return count === 1 ? 'Check complete: 1 update is waiting.' : `Check complete: ${count} updates are waiting.`;
    }

    // "An update is waiting": a mod found in the SkyrimNet install (never a Hub listing under Mods not installed, which also carry the status
    // update_available) with one of these statuses. The Mods page's Updates section and tile use this same test, so the two numbers cannot drift.
    function isWaitingUpdate(r) {
        return !r.notInstalled && ['update_available', 'queued', 'downloading', 'downloaded'].includes(r.status);
    }
    function countWaitingUpdates(rows) {
        return (rows || []).filter(isWaitingUpdate).length;
    }

    // The main page's line when setup was left unfinished.
    function unfinishedText(step, total) {
        return `Setup isn't finished yet. Step ${step} of ${total} is next.`;
    }

    // Folder problems (from POST /api/setup/folder-check) in plain words.
    function folderProblemText(problem) {
        if (problem === 'missing') return "That folder doesn't exist.";
        if (problem === 'skyrim-folder') return "That's your Skyrim folder. Choose the folder your mod manager keeps installed mods in.";
        if (problem === 'data-folder') return "That's your Skyrim Data folder. Choose the folder your mod manager keeps installed mods in.";
        return '';
    }

    // Vortex's folders fill in by themselves once the Bridge answers (GET /api/setup/vortex-folders gives the reason it could not yet).
    // One plain line while a box is still empty; nothing at all once they are found (no news is good news).
    const FOLDERS_POLL_MS = 3000;
    const FOLDERS_NOTE = {
        'vortex-closed': 'Open Vortex and ModPacer fills these in. Or choose the folders yourself.',
        'no-bridge': 'Add the Bridge first and ModPacer fills these in. Or choose the folders yourself.',
    };
    function foldersNote(reason, dlPath, modsPath) {
        if (dlPath && modsPath) return '';
        return FOLDERS_NOTE[reason] || FOLDERS_NOTE['vortex-closed'];
    }
    // What one answer from the Bridge changes: only an EMPTY box that the person has not chosen a folder for is ever filled; a folder
    // the person typed, browsed to or already had saved is never replaced. `found` = { downloadFolder, stagingFolder } (folders that exist).
    function foldersFill(state, found) {
        const fill = {};
        if (!state.dl.path && !state.touched.dl && found.downloadFolder) fill.dl = found.downloadFolder;
        if (!state.mods.path && !state.touched.mods && found.stagingFolder) fill.mods = found.stagingFolder;
        return fill;
    }
    // Keep asking while a box is empty and the person has not taken it over themselves.
    function foldersPollWanted(state) {
        return (!state.dl.path && !state.touched.dl) || (!state.mods.path && !state.touched.mods);
    }

    const api = { setPlatform, FOLDERS_POLL_MS, foldersNote, foldersFill, foldersPollWanted, stepKinds, stepNames, nextLabel, helperEntryPane, helperCheckPane, BRIDGE_MISSING, BRIDGE_OUTDATED, BRIDGE_UNREACHABLE, bridgeNewerText, bridgeStepsHtml, createRestartWatcher, summaryLine, completionText, isWaitingUpdate, countWaitingUpdates, unfinishedText, folderProblemText };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.setupFlow = api;
})(typeof window !== 'undefined' ? window : globalThis);
