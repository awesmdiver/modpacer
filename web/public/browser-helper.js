// ModPacer 2.0, part 4: the Settings box for the browser helper (the small extension that lets ModPacer read LoversLab pages in the person's own browser),
// and the first-time pop-up that explains it when LoversLab is chosen in Add a mod. Both draw the same steps, buttons and status line (one pairing path).
// The status line comes first, then five short steps. Everything shown is plain text (textContent), never HTML. Nothing here installs anything: the person loads the folder in their browser.
(function () {
    'use strict';
    const $ = (id) => document.getElementById(id);
    const el = (tag, attrs, ...kids) => {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) { if (v === undefined || v === null || v === false) continue; if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v); }
        for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
        return e;
    };
    let last = null, busy = false, timer = null, disc = null;
    // After the update pop-up closes while the helper is still old, the page asks again every VERIFY.everyMs for up to VERIFY.forMs (the extension needs a few seconds to check in after a reload).
    // While it does, a quiet "Checking the helper..." strip stands in place of the notice; past the time, the notice comes back with the "still says" line.
    const VERIFY = { everyMs: 2000, forMs: 40000 };
    let verify = null, stillOld = null, verifyTimer = null;
    const verifying = () => !!verify;
    function checkingEl() {
        return el('div', { class: 'status-strip', id: 'helperChecking', role: 'status', 'aria-live': 'polite' }, el('span', { class: 'status-spin', 'aria-hidden': 'true' }), el('span', { text: CHECKING_WORDS }));
    }
    function stillOldEl() { return stillOld ? el('p', { class: 'bh-still muted', id: 'helperStillOld', text: stillOldLine(stillOld) }) : null; }
    function endVerify() { verify = null; if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; } }
    async function verifyStep() {
        verifyTimer = null;
        if (!verify) return;
        await refresh();
        if (!verify) return;
        if (!last || !last.paired || !last.outdated) { endVerify(); stillOld = null; draw(); return; } // current: the notice and the strip are both gone
        if (Date.now() - verify.start >= VERIFY.forMs) { stillOld = last.helperVersion || verify.old; endVerify(); draw(); return; }
        verifyTimer = setTimeout(verifyStep, VERIFY.everyMs);
    }
    // Called when the update pop-up closes while the helper was old: read it again at once, then keep checking.
    function beginVerify() {
        endVerify(); stillOld = null;
        verify = { start: Date.now(), old: last && last.helperVersion };
        draw();
        verifyStep();
    }

    // The words (quoted in the handoff for the Gemini pass).
    // Where Reload is: on the browser's Extensions page, on the helper's card (the helper's own small window has Check now, not Reload).
    const RELOAD_WORDS = 'Open your browser\u2019s Extensions page and click the Reload icon (\u21BB) on the ModPacer browser helper.';
    const CHECKING_WORDS = 'Checking the helper...';
    const stillOldLine = (v) => `The helper still says version ${v}. Make sure you clicked the Reload icon (↻) on the ModPacer browser helper, and that it loaded from the folder shown in Settings.`;
    const oldHeadline = (s) => `Browser helper update available (v${s.helperVersion} \u2192 v${s.bundledVersion})`;
    const STATUS = {
        not_set_up: 'Not connected.',
        waiting_for_code: 'Waiting for the code. It works for 30 minutes.',
        browser_closed: 'Your browser is closed. ModPacer will check LoversLab again when you open it.',
        signed_out: 'LoversLab wants you to sign in again. Open it in your browser, sign in, and ModPacer will check again.',
    };
    const statusLine = (s) => {
        if (s.state === 'connected') return `Connected${s.browser ? ` (${s.browser})` : ''}.`;
        if (s.state === 'old') return oldHeadline(s);
        return STATUS[s.state] || STATUS.not_set_up;
    };
    async function act(method, url) { if (busy) return; busy = true; try { last = await api(method, url, method === 'POST' ? {} : undefined); } catch (e) { say(e.message); } busy = false; draw(); }
    let msg = '';
    function say(t) { msg = t || ''; for (const id of ['browserHelperMsg', 'bhpMsg']) { const m = $(id); if (m) m.textContent = msg; } }

    // The pieces both the Settings box and the pop-up draw. `p` is an id prefix so the two never share an id ('bh' for Settings, 'bhp' for the pop-up).
    const isBad = (s) => s.state === 'signed_out' || s.state === 'old' || s.state === 'browser_closed';
    function statusEl(s, p) {
        const bad = isBad(s);
        return el('p', { class: s.state === 'connected' ? 'ok-t' : bad ? 'req-warn' : 'muted', id: `${p}Status` }, el('span', { class: `sdot ${s.state === 'connected' ? 'ok' : bad ? 'warn' : 'off'}` }), el('span', { text: (s.state === 'signed_out' || s.state === 'old' ? '\u26A0\uFE0F ' : '') + statusLine(s) }));
    }
    // The two browser addresses with their copy buttons (a web page cannot open an edge:// or chrome:// address, so the person pastes it).
    function addrsEl() { return el('ul', { class: 'bh-addrs' }, ...['edge://extensions', 'chrome://extensions'].map((a) => el('li', {}, el('code', { text: a }), copyBtn(a)))); }
    // The notice that the paired helper is older than the one that comes with this ModPacer: the amber warning line (the warning icon and amber words, no box), the two addresses under it.
    // `lead` is what comes before the Reload words; `how` adds a How link that opens the helper pop-up steps.
    // Two parts: the amber headline (the warning line) and the instruction in the normal text colour; `how` adds a How link at the end of the instruction.
    function instructionEl(how) {
        const line = el('p', { class: 'bh-old-how-line' }, el('span', { text: RELOAD_WORDS }));
        if (how) line.append(document.createTextNode(' '), el('a', { href: '#', class: 'bh-how', text: 'How', onclick: (e) => { e.preventDefault(); openPopup(); } }));
        return line;
    }
    function outdatedEl(s, p, { how = false } = {}) {
        if (verify) return checkingEl();
        const line = el('div', { class: 'req-warn bh-old-line', id: `${p}Old` }, el('span', { text: '\u26A0\uFE0F ' + oldHeadline(s) }));
        return el('div', { class: 'bh-old' }, line, stillOldEl(), instructionEl(how), addrsEl());
    }
    // A small icon-only copy button (a web page cannot open an edge:// or chrome:// address, so the person pastes it). Shows "Copied" for a moment.
    function copyBtn(value) {
        const svg = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5"/></svg>';
        const note = el('span', { class: 'copied-t', role: 'status' });
        const b = el('button', { type: 'button', class: 'copy-ic', title: 'Copy', 'aria-label': 'Copy', 'data-copy': value, onclick: () => {
            try { navigator.clipboard.writeText(value); note.textContent = 'Copied'; setTimeout(() => { note.textContent = ''; }, 1500); } catch (e) { say("That couldn't be copied. Select it and copy it by hand."); }
        } });
        b.innerHTML = svg; // a fixed icon, no page data in it
        const wrap = document.createDocumentFragment(); wrap.append(b, note);
        return wrap;
    }
    // A folder location that wraps after its backslashes (never inside a folder name); the text stays exactly the path.
    function folderCode(id, path) {
        const c = el('code', { id });
        path.split(/(?<=\\)/).forEach((part) => { c.append(document.createTextNode(part), document.createElement('wbr')); });
        return c;
    }
    // The text Copy button beside the pairing code: says "Copied" for a moment after the click.
    function codeCopyBtn(id, code) {
        const b = el('button', { type: 'button', id, text: 'Copy', onclick: () => {
            try { navigator.clipboard.writeText(code); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1500); } catch (e) { say("The code couldn't be copied. Select it and copy it by hand."); }
        } });
        return b;
    }
    // `codeInHeader` (the Settings box): the one pairing-code button is in the box's header, so step 4 only shows the code once there is one.
    function stepsEl(s, p, codeInHeader) {
        const code = s.code && s.code.code ? s.code.code : null;
        const steps = [
            [el('span', { text: 'In your browser, open Extensions: paste one of these addresses into the address bar, and turn on ' }), el('b', { text: 'Developer mode' }), el('span', { text: '.' }),
                addrsEl()],
            [el('span', { text: 'Copy the helper folder location:' }),
                s.folder ? el('div', { class: 'bh-path' }, folderCode(`${p}Folder`, s.folder), copyBtn(s.folder)) : null],
            [el('span', { text: 'Press ' }), el('b', { text: 'Load unpacked' }), el('span', { text: '. In the window that opens, click the address bar at the top, paste the location you copied (Ctrl+V), press Enter, then press ' }), el('b', { text: 'Select Folder' }), el('span', { text: '.' })],
            [el('span', { text: "Click the helper's icon in your browser, paste this code once (" }), el('b', { text: 'Copy' }), el('span', { text: ' is beside it), press ' }), el('b', { text: 'Connect' }), el('span', { text: ', then press ' }), el('b', { text: 'Allow LoversLab' }), el('span', { text: ' and say yes when the browser asks.' }),
                el('div', { class: 'bh-code' },
                    code ? el('code', { id: `${p}Code`, text: code }) : codeInHeader ? el('span', { class: 'muted', id: `${p}NoCode`, text: 'Press Generate pairing code above to get your code.' }) : el('button', { type: 'button', id: `${p}Make`, text: 'Make a code', onclick: () => act('POST', '/api/browser-helper/code') }),
                    code ? codeCopyBtn(`${p}Copy`, code) : null)],
            [el('span', { text: 'Make sure you are signed in to LoversLab in this browser.' })],
            [el('span', { text: 'Back here, press ' }), el('b', { text: 'Check again' }), el('span', { text: '. ' }), el('button', { type: 'button', id: `${p}Check`, text: 'Check again', onclick: () => act('POST', '/api/browser-helper/check') })],
        ];
        return el('ol', { class: 'bh-steps' }, ...steps.map((parts) => el('li', {}, ...parts)));
    }

    // Whoever shows the helper's state elsewhere (the line in Add a mod) listens here: it is told every time the status is read or drawn. -> a function that stops listening
    const listeners = new Set();
    function onStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
    // The one quiet line on the Mods page: only for a person whose paired helper is older and who follows a LoversLab mod; it goes the moment the helper reports the current version.
    function paintModsLine() {
        const host = $('helperOldLine');
        if (!host) return;
        host.textContent = '';
        const s = last;
        if (!s || !s.paired || !s.outdated || !s.followsLoversLab) return;
        if (verify) { host.append(checkingEl()); return; }
        if (stillOld) host.append(stillOldEl());
        host.append(el('div', { class: 'req-warn bh-old-line', id: 'helperOldNote' }, el('span', { text: '\u26A0\uFE0F ' + oldHeadline(s) + '.' }), document.createTextNode(' '), el('a', { href: '#', class: 'bh-how', id: 'helperOldHow', text: 'How', onclick: (e) => { e.preventDefault(); openPopup(); } })));
    }
    function draw() {
        if (!last || !last.outdated) stillOld = null; // current again: the "still says" line goes with the notice
        paintModsLine();
        for (const fn of [...listeners]) { try { fn(last); } catch (e) { /* a listener never breaks the box */ } }
        drawPopup();
        const box = $('browserHelperBox');
        if (!box) return;
        box.textContent = '';
        const s = last;
        if (!s) return;
        const titleEl = el('h3', { class: 'set-card-t', text: 'Browser helper for LoversLab' });
        if (!s.bundled) { box.append(titleEl, el('p', { class: 'muted', text: 'ModPacer is missing the browser helper folder.' })); return; }
        // The header: title and the one status row on the left (a dot and the words, the version muted after them); the pairing-code buttons on the right.
        const status = statusEl(s, 'bh');
        if (s.state === 'connected' && s.helperVersion) status.append(document.createTextNode(' '), el('span', { class: 'muted', text: `Helper version ${s.helperVersion}.` }));
        const code = s.code && s.code.code ? s.code.code : null;
        const btns = el('div', { class: 'set-btns' });
        btns.append(el('button', { type: 'button', id: 'bhNew', text: s.paired || code ? 'New pairing code' : 'Generate pairing code', onclick: () => act('POST', '/api/browser-helper/code') }));
        if (s.paired) btns.append(el('button', { type: 'button', id: 'bhRevoke', class: 'btn-muted', text: 'Disconnect helper', onclick: () => act('POST', '/api/browser-helper/revoke') }));
        box.append(el('div', { class: 'set-row' }, el('div', { class: 'set-main' }, titleEl, status), btns));
        if (s.state === 'old') { if (verify) box.append(checkingEl()); else box.append(stillOldEl(), instructionEl(false), addrsEl()); } // the instruction in the normal colour, then the same two copy buttons
        // The setup steps and the security notes: folded away once the helper is connected, open while it is not (the person's own click is kept while the state stays the same).
        const connected = s.state === 'connected';
        if (!disc || disc.connected !== connected) disc = { connected, open: !connected };
        const panel = el('div', { class: 'set-disc-body', id: 'bhDiscBody' },
            el('p', { class: 'muted', text: "ModPacer can't read LoversLab by itself (it needs your sign-in). A small helper in your own browser reads the page for you, only for sites you add." }),
            stepsEl(s, 'bh', true),
            el('p', { class: 'muted', text: 'Your browser may say it is "running extensions in developer mode". That is expected. The helper reads only the sites you add. ModPacer talks to it only on this PC.' }),
            el('p', { class: 'muted', text: 'Anyone using this browser profile can use the helper and your LoversLab sign-in.' }),
            el('p', { class: 'muted', text: 'The pairing code expires if unused. You can make a new one or disconnect the helper.' }));
        panel.hidden = !disc.open;
        const toggle = el('button', { type: 'button', class: 'set-disc', id: 'bhDisc', 'aria-expanded': String(disc.open), 'aria-controls': 'bhDiscBody', onclick: () => { disc.open = !disc.open; toggle.setAttribute('aria-expanded', String(disc.open)); panel.hidden = !disc.open; arrow.textContent = disc.open ? '▾' : '▸'; } });
        const arrow = el('span', { class: 'set-disc-ar', 'aria-hidden': 'true', text: disc.open ? '▾' : '▸' });
        toggle.append(arrow, document.createTextNode(' Setup steps and security notes'));
        box.append(toggle, panel);
        box.append(el('p', { class: 'req-warn', id: 'browserHelperMsg', text: msg }));
    }

    // ---- The pop-up: opened from Add a mod when LoversLab is chosen and no helper is connected. The Add a mod pop-up stays underneath, untouched,
    // so closing this one (or the helper connecting) returns the person exactly where they were.
    let pop = false, popTimer = null;
    // The footer button: "Not now" until the helper is connected, then the one solid button, "Continue" (it closes the pop-up and returns to Add a mod as it was).
    function footButton(connected) {
        const b = $('bhpClose');
        if (!b) return;
        b.textContent = connected ? 'Continue' : 'Not now';
        b.className = connected ? 'primary' : 'btn-muted';
    }
    function drawPopup() {
        if (!pop) return;
        const body = $('bhpBody');
        if (!body) return;
        body.textContent = '';
        const s = last;
        if (!s) return;
        footButton(s.bundled && (s.state === 'connected' || s.outdated));
        if (s.bundled && s.outdated) { body.append(outdatedEl(s, 'bhp')); return; } // an older helper: only how to reload it (it is already set up)
        // Connected: the pop-up stays until the person presses Continue (it never closes by itself); only the green status is left, the steps and the code buttons no longer matter.
        if (s.bundled && s.state === 'connected') {
            body.append(statusEl(s, 'bhp'));
            // Opened from Add a mod (the link box is on screen): say what to do next. Opened from Settings, Continue just closes it.
            if ($('addModAddress')) body.append(el('ol', { class: 'bh-next', id: 'bhpNext' }, el('li', { text: 'Open the LoversLab page of the mod you want ModPacer to follow.' }), el('li', { text: 'Copy its address from the address bar.' }), el('li', {}, 'Press ', el('strong', { text: 'Continue' }), ' and paste it into the link box.')));
            return;
        }
        if (!s.bundled) { body.append(el('p', { class: 'muted', text: 'ModPacer is missing the browser helper folder.' })); return; }
        body.append(
            el('div', { class: 'bhp-h', text: 'Why' }),
            el('p', { text: "LoversLab pages sit behind your sign-in, so ModPacer can't read them itself. A small helper in your browser reads them for you." }),
            el('div', { class: 'bhp-box' }, el('div', { class: 'bhp-h', text: 'What it does' }),
                el('ul', { class: 'bh-steps' }, ...['It reads only the LoversLab pages you add.', 'It uses your own browser and your own sign-in.', 'It talks only to ModPacer on this PC.', 'It never downloads anything for you.'].map((t) => el('li', { text: t })))),
            el('div', { class: 'bhp-h', text: 'How to set it up' }),
            stepsEl(s, 'bhp'), statusEl(s, 'bhp'),
            el('p', { class: 'bhp-ok', text: 'Your browser may say it is running extensions in developer mode. That is expected.' }),
            el('p', { class: 'req-warn', text: '⚠️ Anyone using this browser profile can use the helper and your LoversLab sign-in.' }),
            el('p', { class: 'req-warn', id: 'bhpMsg', text: msg }),
        );
    }
    function openPopup() {
        const ov = $('bhPopOverlay');
        if (!ov || pop) return;
        pop = true; msg = '';
        ov.style.display = 'flex';
        const b = $('bhpClose'); if (b) b.onclick = closePopup;
        drawPopup();
        refresh();
        popTimer = setInterval(() => { if (!busy) refresh(); }, 3000);
    }
    function closePopup() {
        if (popTimer) { clearInterval(popTimer); popTimer = null; }
        const wasOld = pop && last && last.paired && last.outdated;
        pop = false;
        const ov = $('bhPopOverlay'); if (ov) ov.style.display = 'none';
        const b = $('bhpBody'); if (b) b.textContent = '';
        footButton(false);
        if (wasOld) beginVerify(); // Continue (or any close) after the update notice: read the helper again at once and keep checking
        else refresh();
    }
    const popupOpen = () => pop;
    // Opens by itself only once (the person can always reopen it from the line in Add a mod).
    const SEEN_KEY = 'modpacer.browserHelperPopupSeen';
    let seenMemory = false;
    function firstTime() {
        try { if (window.localStorage.getItem(SEEN_KEY)) return false; window.localStorage.setItem(SEEN_KEY, '1'); return true; }
        catch { if (seenMemory) return false; seenMemory = true; return true; }
    }

    async function refresh() { try { last = await api('GET', '/api/browser-helper'); } catch { return; } draw(); }
    function watch() { // while Settings is open, the line follows the helper (it asks about every half minute)
        if (timer) clearInterval(timer);
        // ...and so does the line in Add a mod while that pop-up is open
        // (a plain read: it never waits for a button's own request, so a stale notice cannot outlive the helper's update)
        timer = setInterval(() => { const s = $('settings'), a = $('addModOverlay'), m = $('main'); if ((s && s.style.display !== 'none') || (a && a.style.display === 'flex') || (m && m.style.display !== 'none' && last && last.outdated && last.followsLoversLab)) refresh(); }, 5000);
    }
    document.addEventListener('DOMContentLoaded', () => {
        const tab = document.querySelector('.tab[data-tab="settings"]');
        if (tab) tab.addEventListener('click', () => refresh());
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pop) closePopup(); });
        window.addEventListener('focus', () => refresh()); // back from the browser window: read it again at once
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); }); // back from the browser: the answer may have changed meanwhile
        watch();
        refresh();
    });
    window.browserHelperUi = { VERIFY, verifying, checkingEl, outdatedEl, onStatus, current: () => last, refresh, statusLine, openPopup, closePopup, popupOpen, firstTime };
})();
