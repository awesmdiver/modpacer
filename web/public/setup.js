'use strict';
// First-run setup pop-up (queue: first-run-setup-steps, 2026-10-03): the step-by-step version of the old "Which mod
// manager do you use?" question. The frame is #modManagerOverlay (this app's own overlay/card); the decisions live in
// setup-flow.js so they can be tested without a page. Loaded BEFORE app.js; everything from app.js ($, api, escapeHtml,
// refreshState, loadTheme, loadSettings) is only used when a step runs, never at load.
//
// Answers are saved as the player goes (each Next writes that step's settings), plus the step reached (`setupStep`,
// see lib/first-run-setup.js), so quitting partway loses nothing.

const setupUi = (function () {
    const $ = (id) => document.getElementById(id); // app.js is loaded after this file, so its own $ isn't there yet
    const flow = window.setupFlow;
    let S = null; // null = closed
    let timer = null;

    // Every error or warning the pop-up shows is also written to the log (word for word), once per distinct text.
    const reported = new Set();
    function reportShown(kind, html) {
        if (kind !== 'err' && kind !== 'warn') return;
        const holder = document.createElement('div');
        holder.innerHTML = html;
        const text = (holder.textContent || '').trim();
        if (!text || reported.has(text)) return;
        reported.add(text);
        fetch('/api/log-shown', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }).catch(() => {});
    }
    const dot = (kind, text, extra) => (reportShown(kind, text), `<div class="su-status${extra ? ' ' + extra : ''}"><span class="su-dot ${kind}"></span><span>${text}</span></div>`);
    const pathBox = (p) => (p ? `<div class="su-path" title="${escapeHtml(p)}">${escapeHtml(p)}</div>` : '<div class="su-path empty">No folder chosen yet</div>');
    const btn = (action, label, cls, disabled) => `<button${cls ? ` class="${cls}"` : ''} data-su="${action}"${disabled ? ' disabled' : ''}>${label}</button>`;
    const link = (action, label) => `<button class="su-link" data-su="${action}">${label}</button>`;
    const nav = (left, right) => `<div class="su-nav"><span>${left}</span><span class="su-nav-r">${right}</span></div>`;
    const back = () => link('back', 'Back');

    function kind() { return flow.stepKinds(S.manager)[S.index]; }
    function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

    // ---- frame ----
    function renderStepper() {
        const names = flow.stepNames(S.manager);
        const allDone = S.checkPane === 'done';
        $('suStepper').innerHTML = names.map((n, k) => {
            const done = k < S.index || (allDone && k === S.index);
            const cls = done ? 'done' : (k === S.index ? 'cur' : '');
            const clickable = done && !allDone && S.checkPane !== 'checking';
            return `<div class="su-stp ${cls}"${clickable ? ` data-su="goto" data-step="${k}" role="button" tabindex="0"` : ''}><span class="n">${done ? '&#10003;' : k + 1}</span><span class="t">${escapeHtml(n)}</span></div>`;
        }).join('');
        $('suCloseBtn').style.display = S.rerun && S.checkPane !== 'checking' ? '' : 'none';
    }

    function render() {
        if (!S) return;
        renderStepper();
        const k = kind();
        const html = ({ manager: viewManager, skyrim: viewSkyrim, folders: viewFolders, options: viewOptions, helper: viewHelper, check: viewCheck })[k]();
        $('suBody').innerHTML = html;
        const title = $('suBody').querySelector('h2');
        if (title) title.id = 'suTitle';
        const err = S.error ? dot('err', escapeHtml(S.error)) : '';
        if (err) $('suBody').querySelector('.su-nav') && $('suBody').querySelector('.su-nav').insertAdjacentHTML('beforebegin', err);
        // Something went wrong on this step: say where the log is (once per step view).
        if ($('suBody').querySelector('.su-dot.err') && $('suBody').querySelector('.su-nav')) {
            $('suBody').querySelector('.su-nav').insertAdjacentHTML('beforebegin', `<div class="su-note">There is a log you can send us: ${link('open-log', 'Open log folder')}</div>`);
        }
    }

    // ---- step 1: mod manager ----
    function viewManager() {
        const m = S.manager === 'mo2' ? 'mo2' : 'vortex';
        const lock = S.rerun ? ' disabled' : ''; // already chosen: a re-run shows the answer but can't change it
        return `<h2>Which mod manager do you use?</h2><p class="hint">This tells ModPacer where your mods live and how to update them.</p>
            <label class="choice"><input type="radio" name="suManager" value="vortex"${m === 'vortex' ? ' checked' : ''}${lock}><span><b>Vortex</b><br><span class="muted">Updates install automatically with the enclosed Vortex Bridge extension.</span></span></label>
            <label class="choice"><input type="radio" name="suManager" value="mo2"${m === 'mo2' ? ' checked' : ''}${lock}><span><b>Mod Organizer 2</b><br><span class="muted">Updates save to your downloads folder, ready to add yourself.</span></span></label>
            <p class="hint" style="margin:6px 0 0">${S.rerun ? 'To switch managers, start ModPacer fresh (see Help).' : 'This is a one-time choice. Switching later means reinstalling ModPacer fresh.'}</p>
            ${nav('', btn('next', flow.nextLabel(m, 0), 'primary'))}`;
    }

    // ---- step 2: Skyrim ----
    function viewSkyrim() {
        const sk = S.skyrim;
        let state = 'empty', statusHtml = '';
        if (!sk) {
            statusHtml = dot('info', 'Looking for Skyrim&hellip;');
        } else {
            state = sk.state;
            if (state === 'found') statusHtml = dot('ok', 'Found it! Press Browse if you need a different copy of Skyrim.');
            else if (state === 'wrong') statusHtml = dot('err', '<code>SkyrimSE.exe</code> isn\'t in that folder. Make sure you pick the main game folder.');
            else statusHtml = dot('warn', 'We couldn\'t find Skyrim. Please choose the folder containing <code>SkyrimSE.exe</code>.');
        }
        return `<h2>Where is Skyrim?</h2><p class="hint">We need your Skyrim folder to check which plugins you have.</p>
            <div class="su-row">${pathBox(sk && sk.path)}${btn('browse-skyrim', 'Browse&hellip;', state === 'found' || !sk ? '' : 'primary')}</div>
            ${statusHtml}
            ${nav(back(), btn('next', flow.nextLabel(S.manager, 1), 'primary', state !== 'found'))}`;
    }

    // ---- step 3: folders ----
    function folderField(label, which, noteHtml) {
        const f = S[which];
        const problem = f && f.problem && f.problem !== 'empty' ? dot('err', escapeHtml(flow.folderProblemText(f.problem))) : '';
        return `<div class="su-lbl">${label}</div>
            <div class="su-row">${pathBox(f && f.path)}${btn('browse-' + which, 'Browse&hellip;', f && f.path && !f.problem ? '' : 'primary')}</div>
            ${problem}<div class="su-note">${noteHtml}</div>`;
    }
    function viewFolders() {
        if (!S.foldersLoaded) return `<h2>Your folders</h2>${dot('info', 'One moment&hellip;')}${nav(back(), btn('next', flow.nextLabel(S.manager, S.index), 'primary', true))}`;
        const ok = S.dl.path && S.mods.path && !S.dl.problem && !S.mods.problem;
        const nextBtn = btn('next', flow.nextLabel(S.manager, S.index), 'primary', !ok);
        if (S.manager === 'mo2') {
            return `<h2>Your folders</h2><p class="hint">Choose the two folders your MO2 Skyrim instance uses.</p>
                ${folderField('Downloads folder (where updates save)', 'dl', 'Find this in MO2: Settings &rarr; Paths &rarr; Downloads')}
                ${folderField('Mods folder (where MO2 keeps installed mods)', 'mods', 'Find this in MO2: Settings &rarr; Paths &rarr; Mods. (Don\'t use your Skyrim or Data folder here.)')}
                ${nav(back(), nextBtn)}`;
        }
        // One plain line, only while a box is still empty (the page keeps asking the Bridge and fills them in by itself); nothing once they are found.
        const note = flow.foldersNote(S.vortexReason, S.dl.path, S.mods.path);
        return `<h2>Your folders</h2>${note ? `<div class="su-note">${escapeHtml(note)}</div>` : ''}
            ${folderField('Downloads folder (where updates save)', 'dl', 'Find this in Vortex: Settings &rarr; Download &rarr; Download Folder')}
            ${folderField('Mod staging folder (where Vortex keeps installed mods)', 'mods', 'Find this in Vortex: Settings &rarr; Mods &rarr; Mod Staging Folder')}
            ${nav(back(), nextBtn)}`;
    }

    // ---- step 4: options ----
    function viewOptions() {
        const keyField = S.keyLast4
            ? `<input type="password" class="su-input" id="suKeyInput" placeholder="Saved (ends &hellip;${escapeHtml(S.keyLast4)}). Paste a new key to replace it" autocomplete="off">`
            : '<input type="password" class="su-input" id="suKeyInput" placeholder="Paste your key here, or skip" autocomplete="off">';
        return `<h2>Final options</h2><p class="hint">These are fine as they are. You can change them later in Settings.</p>
            <label class="toggle"><span class="sw${S.autoDownload ? '' : ' off'}" data-su="toggle-auto"></span><span><b>Download updates automatically</b><br><span class="muted">Turn this on and ModPacer downloads updates by itself.</span></span></label>
            <div class="su-lbl" style="margin-top:20px">Nexus Premium key (optional)</div>
            <div class="su-row">${keyField}<button data-su="check-key" id="suKeyCheckBtn"${S.keyLast4 ? '' : ' disabled'}>Check</button></div>
            <div id="suKeyStatus">${window.nexusKeyCheck.statusHtml(S.keyState, { inline: true })}</div>
            <div class="su-note">Premium users get automatic downloads. Without it, you get a link to the mod page. Find your key on Nexus: Site preferences &rarr; API keys.</div>
            ${nav(back(), btn('next', flow.nextLabel(S.manager, S.index), 'primary'))}`;
    }

    // ---- step 3 (Vortex): Helper (Vortex only) ----
    // The old "Vortex Collection Helper" is still in Vortex's plugins folder: said once, under the step's heading (never removed for the player).
    const OLD_HELPER_NOTE = 'The old "Vortex Collection Helper" is still installed. Remove it in Vortex > Extensions: Vortex Bridge replaces it.';
    function viewHelper() {
        const html = viewHelperPane();
        if (!(S.helperStatus && S.helperStatus.oldHelperInstalled)) return html;
        const note = dot('warn', escapeHtml(OLD_HELPER_NOTE), 'su-gap-s');
        return html.includes('</h2>') ? html.replace('</h2>', () => `</h2>${note}`) : note + html;
    }
    function viewHelperPane() {
        const pane = S.helperPane;
        if (pane === 'loading') return `<h2>Vortex Bridge</h2>${dot('info', 'One moment&hellip;')}${nav(back(), '')}`;
        const skip = link('skip-helper', 'Skip');
        if (pane === 'bundled') {
            return `<h2>Vortex Bridge</h2>
                ${dot('warn', escapeHtml(flow.BRIDGE_MISSING), 'su-top')}
                ${nav(back(), skip + btn('open-zip', 'Get the Vortex Bridge', 'primary', S.busy))}`;
        }
        if (pane === 'outdated') {
            return `<h2>Vortex Bridge</h2>
                ${dot('warn', escapeHtml(flow.BRIDGE_OUTDATED), 'su-top')}
                ${flow.bridgeStepsHtml('setup', true)}
                ${nav(back(), skip + btn('open-zip', 'Get the Vortex Bridge', 'primary', S.busy))}`;
        }
        if (pane === 'newer') {
            const st = S.helperStatus || {};
            return `<h2>Vortex Bridge</h2>
                ${dot('info', escapeHtml(flow.bridgeNewerText(st.version, st.bundledVersion)), 'su-top')}
                ${flow.bridgeStepsHtml('setup', true)}
                ${nav(back(), link('skip-update', 'Skip') + btn('open-zip', 'Get the Vortex Bridge', 'primary', S.busy))}`;
        }
        if (pane === 'unreachable') {
            const open = S.helperStatus && S.helperStatus.canOpen ? btn('open-vortex', 'Open Vortex for me') : '';
            return `<h2>Vortex Bridge</h2>
                ${dot('warn', escapeHtml(flow.BRIDGE_UNREACHABLE), 'su-top')}
                ${nav(back(), skip + open + btn('check-again', 'Check again', 'primary', S.busy))}`;
        }
        if (pane === 'notinstalled') {
            return `<h2>Vortex Bridge</h2>
                ${dot('warn', 'Vortex Bridge isn\'t installed. ModPacer works best with it: updates install directly into Vortex, stay in your collections, and check for updates when Vortex starts.', 'su-top')}
                ${nav(back(), skip + btn('get-helper', 'Get the Vortex Bridge', 'primary'))}`;
        }
        if (pane === 'waiting') {
            if (S.helperVia === 'zip') {
                return `<h2>Vortex Bridge</h2>
                    ${dot('info', 'Explorer just opened with <code>vortex-bridge.zip</code> selected. Add it to Vortex:', 'su-top')}
                    ${flow.bridgeStepsHtml('setup', !!(S.helperStatus && (S.helperStatus.answering || S.helperStatus.installed)))}
                    <p class="hint" style="margin:6px 0 0">Can't see Explorer? Look for its flashing icon in your taskbar.</p>
                    ${nav(back(), skip + btn('check-again', 'Check again', 'primary', S.busy))}`;
            }
            return `<h2>Vortex Bridge</h2>
                ${dot('info', 'The download page just opened in your browser. Install the Vortex Bridge in Vortex, then come back here.', 'su-top')}
                ${nav(back(), skip + btn('check-again', 'Check again', 'primary', S.busy))}`;
        }
        if (pane === 'restart') {
            const open = S.helperStatus && !S.helperStatus.vortexRunning && S.helperStatus.canOpen ? btn('open-vortex', 'Open Vortex for me') : '';
            return `<h2>Restart Vortex</h2><p class="hint">Close and reopen Vortex so it can load the new Vortex Bridge.</p>
                ${dot('warn', 'Waiting for Vortex to restart...')}
                ${nav(back(), open + btn('next', flow.nextLabel(S.manager, S.index), 'primary', true))}`;
        }
        if (pane === 'notdetected') {
            return `<h2>Vortex Bridge not found yet</h2><p class="hint">Vortex restarted, but the Vortex Bridge did not load.</p>
                ${dot('err', 'We can\'t see the Vortex Bridge in Vortex. It may not be installed yet.')}
                ${nav(back(), skip + (S.helperStatus && S.helperStatus.bundled ? btn('open-zip', 'Get the Vortex Bridge') : btn('get-helper', 'Get the Vortex Bridge')) + btn('check-again', 'Check again', 'primary', S.busy))}`;
        }
        return `<h2>Vortex Bridge ready</h2><p class="hint">Vortex loaded the Vortex Bridge, and they are talking to each other.</p>
            ${dot('ok', S.helperStatus && S.helperStatus.version ? `Vortex Bridge ${escapeHtml(S.helperStatus.version)} installed and running.` : 'Vortex Bridge installed and running.', 'su-gap')}
            <label class="toggle"><span class="sw${S.checkOnStart ? '' : ' off'}" data-su="toggle-checkstart"></span><span><b>Check when Vortex starts</b><br><span class="muted">Runs quietly and alerts you to new updates.</span></span></label>
            ${nav(back(), btn('next', flow.nextLabel(S.manager, S.index), 'primary'))}`;
    }

    // ---- last step: check ----
    function viewCheck() {
        const pane = S.checkPane;
        const mgrName = flow.summaryLine(S.manager).manager;
        if (pane === 'checking') {
            return `<h2>Checking your mods</h2><p class="hint">This might take a minute.</p>
                <div class="su-bar"><i></i></div>${nav('', btn('cancel-check', 'Cancel'))}`;
        }
        if (pane === 'done') {
            return `<h2>You're all set!</h2><p class="hint">From now on, ModPacer opens straight to your mod list.</p>
                <p class="hint" id="suHelpLine">Need help? Open the Help tab any time.</p>
                ${dot('ok', escapeHtml(flow.completionText(S.updates)))}${nav('', btn('show-updates', 'Show my updates', 'primary'))}`;
        }
        if (pane === 'vortexclosed') {
            const open = S.vortexCanOpen ? btn('open-vortex', 'Open Vortex for me') : '';
            return `<h2>Open Vortex first</h2><p class="hint">Vortex must be running to install updates.</p>
                ${dot('warn', 'Vortex is not open right now.')}
                ${nav(back(), open + btn('run-check', 'Check my mods', 'primary', true))}`;
        }
        if (pane === 'loading') return `<h2>All set</h2>${dot('info', 'One moment&hellip;')}${nav(back(), '')}`;
        const hint = S.manager === 'mo2' ? 'Time to look for updates. They\'ll save to your downloads folder, ready to add in MO2.' : 'Time to look for updates to your SkyrimNet plugins.';
        return `<h2>All set</h2><p class="hint">${hint}</p>
            <p class="su-big">Skyrim: <b>found</b> &middot; Mod manager: <b>${mgrName}</b> &middot; Folders: <b>chosen</b></p>
            ${nav(back(), btn('run-check', 'Check my mods', 'primary'))}`;
    }

    // ---- moving between steps ----
    async function saveStep() {
        if (!S.persist) return;
        try { await api('POST', '/api/setup/step', { step: S.index + 1 }); } catch { /* progress is a convenience; never block the player on it */ }
    }

    async function go(index) {
        stopTimer();
        S.error = null;
        S.index = Math.max(0, Math.min(index, flow.stepKinds(S.manager).length - 1));
        S.checkPane = kind() === 'check' ? 'loading' : null;
        S.busy = false;
        const my = ++S.token;
        render();
        saveStep();
        try { await enter(my); } catch (e) { if (S && my === S.token) { S.error = e.message; render(); } }
    }

    async function enter(my) {
        const k = kind();
        if (k === 'skyrim') {
            if (!S.skyrim) { S.skyrim = await api('GET', '/api/setup/skyrim'); if (my !== S.token) return; render(); }
        } else if (k === 'folders') {
            await loadFolders(my);
        } else if (k === 'options') {
            S.keyState = null; // a status from an earlier visit no longer describes the (empty) box
            if (!S.optionsLoaded) {
                const cfg = await api('GET', '/api/settings');
                if (my !== S.token) return;
                S.autoDownload = !!cfg.autoDownload;
                S.keyLast4 = cfg.nexusApiKeyLast4 || null;
                S.optionsLoaded = true;
                render();
            }
        } else if (k === 'helper') {
            S.helperPane = 'loading';
            render();
            const status = await api('GET', '/api/setup/helper-status');
            if (my !== S.token) return;
            S.helperStatus = status;
            setHelperPane(flow.helperEntryPane(status));
        } else if (k === 'check') {
            await enterCheck(my);
        }
    }

    async function loadFolders(my) {
        S.foldersLoaded = false;
        render();
        if (!S.dl || !S.mods) {
            const cfg = await api('GET', '/api/settings');
            let vf = { read: false, reason: 'vortex-closed' };
            if (S.manager === 'vortex') { try { vf = await api('GET', '/api/setup/vortex-folders'); } catch { /* shown as the plain "open Vortex" line */ } }
            if (my !== S.token) return;
            S.vortexReason = vf.reason;
            S.touched = { dl: false, mods: false }; // a box the person chose a folder for is never filled in for them
            S.dl = { path: cfg.downloadFolder || vf.downloadFolder || null, problem: null };
            S.mods = { path: cfg.vortexStagingFolder || vf.stagingFolder || null, problem: null };
        }
        await checkFolder('dl', my);
        await checkFolder('mods', my);
        if (my !== S.token) return;
        S.foldersLoaded = true;
        render();
        if (S.manager === 'vortex') startFoldersWatch();
    }

    // While a Vortex box is empty, ask the Bridge again every few seconds and fill the box the moment it answers (the same quiet polling as
    // the other steps). Stops when both boxes have a folder, when the person chose one themselves, or when they leave the step (go() stops the timer).
    function startFoldersWatch() {
        stopTimer();
        if (!flow.foldersPollWanted(S)) return;
        const my = S.token;
        timer = setInterval(async () => {
            let vf = null;
            try { vf = await api('GET', '/api/setup/vortex-folders'); } catch { /* try again next tick */ }
            if (!S || my !== S.token || kind() !== 'folders' || !vf) return;
            const fill = flow.foldersFill(S, vf); // worked out after the answer came back: a folder chosen meanwhile wins
            const reasonChanged = vf.reason !== S.vortexReason;
            S.vortexReason = vf.reason;
            for (const which of Object.keys(fill)) { S[which] = { path: fill[which], problem: null }; await checkFolder(which, my); }
            if (my !== S.token) return;
            if (!flow.foldersPollWanted(S)) stopTimer();
            if (Object.keys(fill).length || reasonChanged) render();
        }, flow.FOLDERS_POLL_MS);
    }
    async function checkFolder(which, my) {
        const f = S[which];
        if (!f.path) { f.problem = null; return; }
        const r = await api('POST', '/api/setup/folder-check', { path: f.path, kind: which === 'mods' ? 'mods' : 'downloads' });
        if (my !== undefined && my !== S.token) return;
        f.problem = r.problem;
    }

    function setHelperPane(pane) {
        stopTimer();
        S.helperPane = pane;
        S.error = null;
        if (pane === 'restart') startRestartWatch();
        if (pane === 'installed') {
            // Default on: a player who skipped earlier and then installed the helper gets it back switched on.
            if (S.helperSkipped) { S.helperSkipped = false; S.checkOnStart = true; api('POST', '/api/settings', { checkOnVortexStart: true }).catch(() => {}); }
            else if (S.checkOnStart === undefined) api('GET', '/api/settings').then((c) => { S.checkOnStart = !!c.checkOnVortexStart; render(); }).catch(() => {});
        }
        render();
    }

    function startRestartWatch() {
        const my = S.token;
        const watcher = flow.createRestartWatcher(S.helperStatus);
        timer = setInterval(async () => {
            let status = null;
            try { status = await api('GET', '/api/setup/helper-status'); } catch { /* try again next tick */ }
            if (!S || my !== S.token || S.helperPane !== 'restart') return;
            if (status) S.helperStatus = status;
            const result = watcher.next(status);
            if (result === 'ready') setHelperPane('installed');
            else if (result === 'notfound') setHelperPane('notdetected');
            else render();
        }, 1500);
    }

    async function enterCheck(my) {
        if (S.manager === 'mo2') { S.checkPane = 'ready'; render(); return; }
        S.checkPane = 'loading';
        render();
        const status = await api('GET', '/api/vortex-status');
        if (my !== S.token) return;
        applyVortexStatus(status);
        if (S.checkPane === 'vortexclosed') {
            timer = setInterval(async () => {
                let s = null;
                try { s = await api('GET', '/api/vortex-status'); } catch { /* next tick */ }
                if (!S || my !== S.token || S.checkPane !== 'vortexclosed' || !s) return;
                applyVortexStatus(s);
                if (S.checkPane !== 'vortexclosed') stopTimer();
            }, 1500);
        }
    }
    function applyVortexStatus(status) {
        S.vortexCanOpen = !!(status && status.canOpen);
        const pane = status && status.needsStart ? 'vortexclosed' : 'ready';
        if (pane !== S.checkPane) { S.checkPane = pane; render(); }
    }

    async function runCheck() {
        const my = ++S.checkToken;
        S.error = null;
        S.checkPane = 'checking';
        render();
        try {
            const state = await api('POST', '/api/check', { force: true });
            if (!S || my !== S.checkToken) return; // Cancel was pressed: the check itself finishes on its own, we just stop waiting
            if (state.error) { S.checkPane = 'ready'; S.error = state.error; render(); return; }
            S.updates = flow.countWaitingUpdates(state.rows);
            await api('POST', '/api/setup/step', { step: null });
            S.checkPane = 'done';
            render();
            refreshState();
        } catch (e) {
            if (!S || my !== S.checkToken) return;
            S.checkPane = 'ready';
            S.error = e.message;
            render();
        }
    }

    // ---- saving what a step collected, then moving on ----
    async function next() {
        const k = kind();
        if (S.busy) return;
        S.busy = true;
        S.error = null;
        try {
            if (k === 'manager') {
                await api('POST', '/api/setup/mod-manager', { modManager: S.manager });
                S.dl = S.mods = null; // the other manager's folders would not fit; read them again
            } else if (k === 'skyrim') {
                await api('POST', '/api/settings', { skyrimInstallPath: S.skyrim.path });
                loadTheme();
            } else if (k === 'folders') {
                await api('POST', '/api/settings', { downloadFolder: S.dl.path, vortexStagingFolder: S.mods.path });
            } else if (k === 'options') {
                const patch = { autoDownload: S.autoDownload };
                const input = $('suKeyInput');
                const key = input ? input.value.trim() : '';
                if (key) patch.nexusApiKey = key;
                await api('POST', '/api/settings', patch);
                if (key) S.keyLast4 = key.slice(-4);
            }
        } catch (e) {
            S.busy = false;
            S.error = e.message;
            render();
            return;
        }
        S.busy = false;
        await go(S.index + 1);
    }

    async function browse(which) {
        const cur = which === 'skyrim' ? (S.skyrim && S.skyrim.path) : S[which].path;
        const title = which === 'skyrim' ? 'Choose your Skyrim install folder' : which === 'dl' ? 'Choose where to save mod updates' : (S.manager === 'mo2' ? 'Choose your MO2 mods folder' : 'Choose your Vortex mods staging folder');
        const { path } = await api('POST', '/api/settings/browse-folder', { title, initialDir: cur || undefined });
        if (!path || !S) return;
        S.error = null;
        if (which === 'skyrim') {
            const r = await api('POST', '/api/setup/skyrim-check', { path });
            S.skyrim = { path, state: r.state };
        } else {
            S[which] = { path, problem: null };
            S.touched[which] = true; // chosen by the person: never replaced by what the Bridge says
            await checkFolder(which);
            if (timer && !flow.foldersPollWanted(S)) stopTimer();
        }
        render();
    }

    // ---- open / close ----
    async function open({ rerun = false, step = 1 } = {}) {
        const cfg = await api('GET', '/api/settings');
        S = {
            rerun, persist: !rerun, manager: cfg.modManager === 'mo2' ? 'mo2' : 'vortex', index: 0, token: 0, checkToken: 0,
            skyrim: null, dl: null, mods: null, helperPane: 'loading', checkPane: null, updates: 0,
        };
        S.checkOnStart = !!cfg.checkOnVortexStart;
        $('modManagerOverlay').style.display = 'flex';
        await go(step - 1);
    }
    function close() {
        stopTimer();
        S = null;
        $('modManagerOverlay').style.display = 'none';
        refreshState();
    }

    // ---- events ----
    // The Nexus key's Check (the Options step): a dot and one word, the same markup as the Settings tab (web/public/nexus-key-check.js). Only the status area and the button are
    // touched, never a full render (that would wipe what was typed). Typing clears the status; an empty box with no saved key keeps Check disabled.
    function paintKeyStatus() { const el = $('suKeyStatus'); if (el) el.innerHTML = window.nexusKeyCheck.statusHtml(S && S.keyState, { inline: true }); }
    async function checkKey() {
        const input = $('suKeyInput');
        const key = input ? input.value.trim() : '';
        if (!key && !S.keyLast4) return;
        const my = S.token;
        const btn = $('suKeyCheckBtn');
        if (btn) btn.disabled = true;
        S.keyState = { phase: 'checking' };
        paintKeyStatus();
        const state = await window.nexusKeyCheck.run(api, key); // the typed key, or nothing: the saved one is checked by the server
        if (!S || my !== S.token) return;
        S.keyState = state;
        paintKeyStatus();
        const again = $('suKeyCheckBtn');
        if (again) again.disabled = false;
    }
    $('modManagerOverlay').addEventListener('input', (e) => {
        if (!S || !e.target || e.target.id !== 'suKeyInput') return;
        S.keyState = null; // the status no longer describes the box
        paintKeyStatus();
        const btn = $('suKeyCheckBtn');
        if (btn) btn.disabled = !(e.target.value.trim() || S.keyLast4);
    });
    $('modManagerOverlay').addEventListener('click', async (e) => {
        const el = e.target.closest('[data-su]');
        if (!el || !S || el.disabled) return;
        const action = el.dataset.su;
        try {
            if (action === 'next') await next();
            else if (action === 'back') await go(S.index - 1);
            else if (action === 'goto') await go(Number(el.dataset.step));
            else if (action === 'browse-skyrim') await browse('skyrim');
            else if (action === 'browse-dl') await browse('dl');
            else if (action === 'browse-mods') await browse('mods');
            else if (action === 'check-key') await checkKey();
            else if (action === 'toggle-auto') { S.autoDownload = !S.autoDownload; el.classList.toggle('off', !S.autoDownload); }
            else if (action === 'toggle-checkstart') {
                S.checkOnStart = !S.checkOnStart;
                el.classList.toggle('off', !S.checkOnStart);
                await api('POST', '/api/settings', { checkOnVortexStart: S.checkOnStart });
            } else if (action === 'open-zip') {
                const r = await api('POST', '/api/setup/helper-open-zip');
                if (!r.ok) { S.error = "Couldn't open the folder."; render(); } else { S.helperVia = 'zip'; setHelperPane('waiting'); }
            } else if (action === 'get-helper') {
                window.open(S.helperStatus && S.helperStatus.helperDownloadUrl ? S.helperStatus.helperDownloadUrl : (await api('GET', '/api/setup/helper-status')).helperDownloadUrl, '_blank');
                if (S.helperPane === 'notinstalled') { S.helperVia = 'link'; setHelperPane('waiting'); }
            } else if (action === 'check-again') {
                S.busy = true; render();
                const status = await api('GET', '/api/setup/helper-status');
                S.busy = false;
                S.helperStatus = status;
                // already told "not found yet" after a restart: only a Bridge that answers moves on (otherwise it would loop back to Restart Vortex)
                setHelperPane(S.helperPane === 'notdetected' && !status.answering ? 'notdetected' : flow.helperCheckPane(status));
            } else if (action === 'skip-update') {
                await go(S.index + 1); // the installed Bridge works: skipping an update leaves everything as it is
            } else if (action === 'skip-helper') {
                S.helperSkipped = true;
                S.checkOnStart = false;
                await api('POST', '/api/settings', { checkOnVortexStart: false });
                await go(S.index + 1);
            } else if (action === 'open-vortex') {
                try { await api('POST', '/api/open-vortex'); } catch (err) { S.error = err.message; render(); }
            } else if (action === 'open-log') await api('POST', '/api/open-log-folder');
            else if (action === 'run-check') await runCheck();
            else if (action === 'cancel-check') { S.checkToken++; S.checkPane = 'ready'; render(); }
            else if (action === 'show-updates') close();
        } catch (err) {
            if (S) { S.busy = false; S.error = err.message; render(); }
        }
    });
    $('modManagerOverlay').addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.su-stp[data-su]')) { e.preventDefault(); e.target.click(); }
    });
    $('modManagerOverlay').addEventListener('change', (e) => {
        if (S && e.target.name === 'suManager') { S.manager = e.target.value; renderStepper(); const n = $('suBody').querySelector('[data-su="next"]'); if (n) n.textContent = flow.nextLabel(S.manager, 0); }
    });
    $('suCloseBtn').addEventListener('click', close);

    return { open, close, isOpen: () => !!S };
})();
