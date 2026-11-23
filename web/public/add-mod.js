'use strict';
// ModPacer 2.0, part 1: the "Add a mod" pop-up (the + button) and the three small row actions of a tracked mod (Stop tracking, Update the link, I checked it).
// The server does every check (the address, the version, the mod manager's list); this file only asks and shows. Text from the server (a repository name, a
// mod's name) is always put on the page as text, never as HTML.
//
// Steps: 1 name, link and the version the person has; 2 what ModPacer found on GitHub ("Is that the version?"); 3 "Which mod in your mod manager is this?"
// (only when the mod manager lists mods). Only GitHub works in this part, so there is no "where does it live" choice to draw yet (parts 2 to 4 add the others).

(function () {
    const $ = (id) => document.getElementById(id);
    const enc = encodeURIComponent;
    function el(tag, attrs, ...kids) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v === undefined || v === null || v === false) continue;
            if (k === 'class') e.className = v;
            else if (k === 'text') e.textContent = v;
            else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
            else e.setAttribute(k, v === true ? '' : String(v));
        }
        for (const kid of kids) if (kid) e.append(kid);
        return e;
    }

    let ui = null; // the pop-up's state while it is open
    let busy = false;

    function setMsg(text) { const m = $('addModMsg'); m.textContent = text || ''; m.className = `add-mod-msg${text ? ' req-warn' : ''}`; }
    function button(label, onClick, { primary = false, muted = false, disabled = false } = {}) {
        return el('button', { type: 'button', class: primary ? 'primary' : (muted ? 'btn-muted' : ''), disabled, onclick: onClick }, document.createTextNode(label));
    }
    function field(label, id, { value = '', placeholder = '', hint = '' } = {}) {
        const input = el('input', { type: 'text', id, value, placeholder, autocomplete: 'off', spellcheck: 'false', maxlength: '300' });
        input.value = value;
        return el('div', { class: 'field' }, el('label', { for: id, text: label }), input, hint ? el('div', { class: 'muted add-mod-hint', text: hint }) : null);
    }
    const valueOf = (id) => ($(id) ? $(id).value.trim() : '');

    // `addTo`: { id, types: [kinds this mod already has] } when the pop-up is adding ANOTHER source to a mod that is already followed ("Add another source").
    function open(opts) {
        if (busy) return;
        const addTo = opts && opts.addTo ? opts.addTo : null;
        ui = { addTo, readSeq: 0, read: null, step: 1, source: ['github', 'loverslab', 'folder'].find((k) => !(addTo && addTo.types.includes(k))) || 'github', name: '', address: '', version: '', folder: '', pattern: '{name}-{version}-{variant}', exclude: '', variant: '', helpOpen: false, preview: null, linkKey: undefined, askAnswered: false, filter: '' };
        $('addModOverlay').style.display = 'flex';
        render();
    }
    function close() {
        $('addModOverlay').style.display = 'none';
        if (ui && ui.stopHelperWatch) ui.stopHelperWatch();
        if (ui) { clearTimeout(ui.readTimer); ui.readSeq++; }
        if (window.browserHelperUi) window.browserHelperUi.closePopup();
        ui = null; busy = false;
        $('addModBody').textContent = '';
    }
    function isOpen() { return !!ui; }

    function render() {
        const body = $('addModBody'), buttons = $('addModButtons');
        body.textContent = ''; buttons.textContent = '';
        setMsg('');
        $('addModTitle').textContent = ui.addTo ? 'Add another source' : 'Add a mod';
        if (ui.step === 1) renderLink(body, buttons);
        else if (ui.step === 2) renderFound(body, buttons);
        else renderWhich(body, buttons);
        const first = body.querySelector('input[type=text]');
        if (first) first.focus();
    }

    // ---- step 1
    // The two places a mod can live so far. (Parts 3 and 4 add more; only what exists is drawn.)
    function sourceChoice() {
        const choice = (key, title, sub) => {
            const b = el('button', { type: 'button', class: `add-mod-source${ui.source === key ? ' on' : ''}`, role: 'radio', 'aria-checked': ui.source === key ? 'true' : 'false', 'data-source': key, onclick: () => { takeStep1(); ui.source = key; render(); } },
                el('span', { class: 'add-mod-source-t', text: title }), el('span', { class: 'muted add-mod-source-s', text: sub }));
            return b;
        };
        const have = ui.addTo ? ui.addTo.types : [];
        return el('div', { class: 'add-mod-sources', role: 'radiogroup', 'aria-label': 'Where it lives' }, ...[have.includes('github') ? null : choice('github', 'GitHub', "A project's releases page"), have.includes('loverslab') ? null : choice('loverslab', 'LoversLab', 'A file page there'), have.includes('folder') ? null : choice('folder', 'A folder on this PC', 'Where your builds land')].filter(Boolean));
    }
    // "How the files are named" help, in place (the same kind of small pop-over the Settings tab uses).
    function patternHelp() {
        const row = (a, b, c) => el('tr', {}, el('td', { class: 'add-mod-code', text: a }), el('td', c === undefined ? { class: 'add-mod-code', text: b } : { text: b }), c === undefined ? null : el('td', { class: 'muted', text: c }));
        const pieces = el('table', { class: 'add-mod-table' }, el('tbody', {},
            row('{name}', "The mod's name", 'MyMod'), row('{version}', 'The version number (1.4.2, 2.0, v3)', '1.4.2'), row('{variant}', 'A label such as release, beta or a language', 'release'),
            row('{build}', 'A build number, when there is one', '217'), row('{date}', 'A date in the name (2026-11-20 or 20261120)', '2026-11-20'), row('{skip}', 'Part of the name you want ModPacer to ignore', 'final')));
        const examples = el('table', { class: 'add-mod-table' }, el('tbody', {},
            row('MyMod-1.4.2-release.zip', '{name}-{version}-{variant}'), row('MyMod_v1.4.2.7z', '{name}_v{version}'), row('MyMod 1.4.2 (build 217).zip', '{name} {version} (build {build})'), row('MyMod-2026-11-20-beta.zip', '{name}-{date}-{variant}')));
        return el('div', { class: 'add-mod-help', id: 'addModHelp' },
            el('div', { class: 'add-mod-help-t', text: 'How the files are named' }),
            el('p', { text: 'Type the pattern your files follow. Each piece in curly brackets stands for a part of the name. Everything else (dashes, dots, underscores) must match exactly.' }),
            pieces, el('div', { class: 'add-mod-help-t', text: 'Examples' }), examples,
            el('p', { class: 'muted', text: "Leave out the parts your files don't have. Only one of {version}, {build} or {date} is needed. ModPacer shows what it read from your newest file before you save, so you can fix the pattern right there." }));
    }
    async function browse() {
        try {
            const r = await api('POST', '/api/settings/browse-folder', { title: 'Choose the folder where your builds land', initialDir: valueOf('addModFolder') || undefined });
            if (r.noChooser) { $('addModFolder').readOnly = false; $('addModFolder').focus(); return; } // no chooser on this system: the folder is typed
            if (r.path) $('addModFolder').value = r.path;
        } catch (e) { setMsg(e.message); }
    }
    // An older helper than the one that comes with ModPacer: the amber status strip at the top of the form, before any read is tried (Next stays usable: an old helper may still work).
    function oldStrip(body) {
        const hu = window.browserHelperUi;
        const host = document.createElement('div'); host.id = 'addModOldHost';
        body.prepend(host);
        if (!hu || !hu.onStatus) return;
        const paint = (s) => {
            if (!ui || !host.isConnected) return;
            host.textContent = '';
            if (!s || !s.paired || !s.outdated) return;
            if (hu.verifying && hu.verifying()) { host.append(hu.checkingEl()); return; }
            const strip = document.createElement('div'); strip.className = 'status-strip warn'; strip.id = 'addModOld'; strip.setAttribute('role', 'status');
            strip.append(hu.outdatedEl(s, 'am', { how: true }));
            host.append(strip);
        };
        if (ui.stopOldWatch) ui.stopOldWatch();
        ui.stopOldWatch = hu.onStatus(paint);
        hu.refresh(); // the version is read again as the form opens, so the strip is gone after a reload without restarting ModPacer
        paint(hu.current());
    }
    // A LoversLab page is read by the person's own browser through the browser helper: say at once if it is not set up.
    function helperLine(body) {
        const line = el('p', { class: 'muted add-mod-hint', id: 'addModHelperLine' });
        body.append(line);
        const hu = window.browserHelperUi;
        // The line follows the helper: it is there while the helper is not connected and gone when it is (a success gets no note), and it comes back if the helper goes away.
        const paint = (s) => {
            if (!ui || !line.isConnected || !s) return;
            if (s.state === 'connected' || s.state === 'old' || s.state === 'signed_out') { line.textContent = ''; return; }
            if ($('addModHelperLink')) return;
            line.textContent = "The browser helper isn't connected yet. ";
            line.append(el('a', { href: '#', id: 'addModHelperLink', text: 'How to set up the helper', onclick: (e) => { e.preventDefault(); if (hu) hu.openPopup(); } }));
        };
        if (ui.stopHelperWatch) ui.stopHelperWatch();
        if (hu && hu.onStatus) ui.stopHelperWatch = hu.onStatus(paint);
        api('GET', '/api/browser-helper').then((s) => {
            if (!ui || !$('addModHelperLine')) return;
            if (s.state === 'connected' || s.state === 'old' || s.state === 'signed_out') { paint(s); return; }
            paint(s);
            // the first time LoversLab is chosen with no helper at all: explain it in a pop-up (the pop-up on top, this one untouched underneath)
            if (hu && (s.state === 'not_set_up' || s.state === 'waiting_for_code') && hu.firstTime()) hu.openPopup();
        }).catch(() => {});
    }
    // A progress line (something is happening): the status strip, a spinner and the words at full text colour, inside the reserved space of the message line.
    function setNote(text) {
        const m = $('addModMsg'); m.textContent = ''; m.className = 'add-mod-msg';
        if (!text) return;
        const strip = document.createElement('div');
        strip.className = 'status-strip'; strip.setAttribute('role', 'status'); strip.setAttribute('aria-live', 'polite');
        const spin = document.createElement('span'); spin.className = 'status-spin'; spin.setAttribute('aria-hidden', 'true');
        const words = document.createElement('span'); words.textContent = text;
        strip.append(spin, words); m.append(strip);
    }
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // Step 1 for a LoversLab page: ask ModPacer to have the browser read it once, then wait for the answer (it comes within about half a minute).
    async function readPage(address, stale) {
        const first = await api('POST', '/api/tracked/read-page', { address });
        if (stale()) return null;
        setNote('Asking your browser to read the page\u2026');
        for (let i = 0; i < 70; i++) {
            await wait(1000);
            if (stale()) return null;
            const r = await api('GET', `/api/tracked/read-page/${enc(first.requestId)}`);
            if (stale()) return null;
            if (r.state === 'waiting') continue;
            if (r.state === 'silent' || r.code === 'network') throw readFailure(r.error);
            if (r.ok === false) throw new Error(r.error);
            return r;
        }
        throw readFailure('Your browser didn\u2019t answer. Is it open? Try again in a moment.');
    }
    // A read that failed for a reason on the browser's side: while the helper is older than the one that comes with ModPacer, that is the likely reason, so say so instead of the vague line.
    const OLD_FAILURE = 'This may be because your helper is out of date. Reload it, then try again.';
    function readFailure(message) {
        const hu = window.browserHelperUi, s = hu && hu.current && hu.current();
        return new Error(s && s.paired && s.outdated ? OLD_FAILURE : message);
    }
    // The LoversLab page is read as soon as the link is in (not when Next is pressed); the person stays on this step, the Name is filled in, and Next is theirs to press.
    const reading = () => !!(ui && ui.source === 'loverslab' && ui.read && ui.read.state === 'reading');
    function paintNext() { const b = $('addModNext'); if (b) b.disabled = reading(); }
    function dropRead() { if (ui) { ui.readSeq = (ui.readSeq || 0) + 1; ui.read = null; clearTimeout(ui.readTimer); ui.readTimer = null; } }
    function startRead(proceed) {
        const mine = ui, address = mine.address, seq = ++mine.readSeq;
        clearTimeout(mine.readTimer); mine.readTimer = null;
        mine.read = { address, state: 'reading', proceed: !!proceed };
        paintNext(); setNote('Asking your browser to read the page\u2026');
        const stale = () => ui !== mine || mine.readSeq !== seq;
        readPage(address, stale).then((r) => {
            if (!r || stale()) return;
            mine.read = { address, state: 'done', result: r };
            mine.preview = r; mine.nameHint = r.nameHint || '';
            const hint = r.nameHint || '';
            const nowName = $('addModName') ? valueOf('addModName') : mine.name;
            if (hint && (!nowName || nowName === mine.autoName)) { mine.name = hint; mine.autoName = hint; if ($('addModName')) $('addModName').value = hint; }
            if (mine.read.proceed && mine.source === 'loverslab' && mine.step === 1) { setMsg(''); mine.step = 2; render(); return; }
            setMsg(''); paintNext();
        }, (e) => {
            if (stale()) return;
            mine.read = { address, state: 'failed' };
            paintNext(); setMsg(e.message);
        });
    }
    function onAddressInput() {
        if (!ui || ui.source !== 'loverslab') return;
        const a = valueOf('addModAddress');
        if (ui.read && ui.read.address === a) return;
        dropRead(); paintNext(); setMsg('');
        if (!a) return;
        ui.address = a;
        const mine = ui;
        mine.readTimer = setTimeout(() => { if (ui === mine && mine.source === 'loverslab' && mine.step === 1 && $('addModAddress')) { mine.address = valueOf('addModAddress'); if (mine.address) startRead(false); } }, 500);
    }
    function renderLink(body, buttons) {
        body.append(el('p', { class: 'muted', text: ui.addTo ? 'Another place to look for the same mod.' : 'ModPacer will keep an eye on it for you, like the mods from the Plugin Hub.' }), sourceChoice());
        if (ui.source === 'folder') {
            const canType = typeof canBrowseFolders !== 'undefined' && !canBrowseFolders;
            const folderInput = el('input', { type: 'text', id: 'addModFolder', placeholder: canType ? 'Type or paste the folder' : 'Choose the folder', autocomplete: 'off', spellcheck: 'false', maxlength: '400', readonly: !canType });
            folderInput.value = ui.folder;
            const q = el('span', { class: 'help', tabindex: '0', role: 'button', 'aria-label': 'Help with file names', 'aria-expanded': ui.helpOpen ? 'true' : 'false', text: '?', onclick: () => { takeStep1(); ui.helpOpen = !ui.helpOpen; render(); } });
            const patternInput = el('input', { type: 'text', id: 'addModPattern', autocomplete: 'off', spellcheck: 'false', maxlength: '120' });
            patternInput.value = ui.pattern;
            body.append(
                ...(ui.addTo ? [] : [field('Name', 'addModName', { value: ui.name, placeholder: 'Taken from the file name if you leave it empty' })]),
                el('div', { class: 'field' }, el('label', { for: 'addModFolder', text: 'The folder' }), el('div', { class: 'add-mod-folder' }, folderInput, button('Choose\u2026', browse))),
                el('div', { class: 'field' }, el('label', { for: 'addModPattern' }, document.createTextNode('How the files are named '), q), patternInput),
            );
            if (ui.helpOpen) body.append(patternHelp());
            body.append(
                field('Leave out builds with these words', 'addModExclude', { value: ui.exclude, placeholder: 'beta, wip', hint: 'Optional.' }),
                ...(ui.addTo ? [] : [field('The version you have now', 'addModVersion', { value: ui.version, hint: "Leave it empty if it isn't installed yet." })]),
                el('p', { class: 'muted add-mod-hint', text: 'ModPacer only reads this folder. It never changes or deletes anything in it.' }),
            );
            for (const id of ['addModName', 'addModPattern', 'addModExclude', 'addModVersion']) (body.querySelector(`#${id}`) || document.createElement('i')).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); goNext(); } });
        } else {
            const page = ui.source === 'loverslab';
            body.append(
                ...(ui.addTo ? [] : [field('Name', 'addModName', { value: ui.name, placeholder: page ? 'Taken from the page if you leave it empty' : 'Taken from GitHub if you leave it empty' })]),
                field(page ? 'Link to the LoversLab page' : 'Link to the GitHub page', 'addModAddress', { value: ui.address, placeholder: page ? 'https://www.loverslab.com/files/file/12345-some-mod/' : 'https://github.com/owner/mod' }),
                ...(ui.addTo ? [] : [field('The version you have now', 'addModVersion', { value: ui.version, hint: "Leave it empty if it isn't installed yet." })]),
            );
            if (page) { oldStrip(body); helperLine(body); }
            for (const id of ['addModName', 'addModAddress', 'addModVersion']) (body.querySelector(`#${id}`) || document.createElement('i')).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); goNext(); } });
            if (page) { $('addModAddress').addEventListener('input', onAddressInput); $('addModAddress').addEventListener('change', () => { if (ui && ui.source === 'loverslab' && !ui.read && valueOf('addModAddress')) { ui.address = valueOf('addModAddress'); startRead(false); } }); }
        }
        const nextBtn = button('Next', goNext, { primary: true }); nextBtn.id = 'addModNext';
        buttons.append(button('Cancel', close), nextBtn);
        if (reading()) { nextBtn.disabled = true; setNote('Asking your browser to read the page\u2026'); }
    }
    function takeStep1() {
        if ($('addModName')) ui.name = valueOf('addModName');
        if ($('addModVersion')) ui.version = valueOf('addModVersion');
        if ($('addModAddress')) ui.address = valueOf('addModAddress');
        if ($('addModFolder')) { ui.folder = valueOf('addModFolder'); ui.pattern = valueOf('addModPattern'); ui.exclude = valueOf('addModExclude'); }
    }

    // ---- step 2
    // What ModPacer read from the newest file, with the pattern; the person confirms before anything is saved.
    function renderFolderFound(body, buttons) {
        const p = ui.preview, n = p.newest;
        const bits = [];
        if (n.name) bits.push(`name ${n.name}`);
        bits.push(`version ${n.version}`);
        if (n.variant) bits.push(`variant ${n.variant}`);
        if (n.build) bits.push(`build ${n.build}`);
        if (n.date) bits.push(`date ${n.date}`);
        body.append(el('p', { class: 'add-mod-found', text: `The newest file is ${n.fileName}. Read as: ${bits.join(', ')}. Right?` }));
        if (p.needsVariant && p.variants.length > 1) {
            if (!ui.variant) ui.variant = p.variants[0].variant || '';
            body.append(el('p', { class: 'muted', text: 'Your folder holds more than one variant. Which one should ModPacer follow?' }));
            const list = el('div', { class: 'add-mod-list add-mod-variants', role: 'radiogroup', 'aria-label': 'Variants' });
            for (const v of p.variants.slice(0, 20)) {
                const id = `addModVariant-${(v.variant || 'none')}`.replace(/[^A-Za-z0-9_-]/g, '_');
                const radio = el('input', { type: 'radio', name: 'addModVariant', id });
                radio.checked = (v.variant || '') === ui.variant;
                radio.addEventListener('change', () => { ui.variant = v.variant || ''; });
                list.append(el('label', { for: id, class: 'add-mod-pick', title: v.fileName }, radio, el('span', { class: 'add-mod-pick-name', text: v.variant || 'No variant' }), el('span', { class: 'muted add-mod-pick-ver', text: `newest ${v.version}` })));
            }
            body.append(list);
        }
        buttons.append(button('Back', () => { ui.step = 1; render(); }, { muted: true }), ui.addTo ? button('Add it', save, { primary: true }) : button("Yes, that's right", afterVersion, { primary: true }));
    }
    // What the browser read from the LoversLab page; the person confirms before anything is saved.
    function renderPageFound(body, buttons) {
        const p = ui.preview;
        const NOTES = { signin: "LoversLab asked for a sign-in, so ModPacer couldn't read a version. You can still add the mod; ModPacer will keep trying.", layout: "ModPacer couldn't find a version on this page. You can still add the mod and type in the version you have." };
        const also = p.found && p.found.alsoListed && p.found.alsoListed.length ? ` The page also lists ${p.found.alsoListed.join(', ')}.` : '';
        if (ui.addTo) {
            body.append(el('p', { class: 'add-mod-found', text: p.found ? `Found version ${p.found.version} on this page.${also}` : (NOTES[p.note] || NOTES.layout) }));
            buttons.append(button('Back', () => { ui.step = 1; render(); }, { muted: true }), button('Add it', save, { primary: true }));
            return;
        }
        body.append(
            el('p', { class: 'add-mod-found', text: p.found ? `Found version ${p.found.version} on this page. Is that the version you have?${also}` : (NOTES[p.note] || NOTES.layout) }),
            field('The version you have now', 'addModVersion', { value: ui.version, hint: "Leave it empty if it isn't installed yet." }),
        );
        if (p.found && p.found.dates && p.found.dates.length) body.append(el('p', { class: 'muted add-mod-hint', text: p.found.dates.slice(0, 3).join(' \u00b7 ') }));
        buttons.append(button('Back', () => { takeStep2(); ui.step = 1; render(); }, { muted: true }), ...(p.found ? [button('Yes, Next', () => { ui.version = p.found.version; afterVersion(); }, { primary: true })] : []), button('Next', goNext, p.found ? {} : { primary: true }));
        body.querySelector('#addModVersion').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); goNext(); } });
    }
    function renderFound(body, buttons) {
        const p = ui.preview;
        if (ui.source === 'folder') return renderFolderFound(body, buttons);
        if (ui.source === 'loverslab') return renderPageFound(body, buttons);
        if (ui.addTo) { // another place for a mod that is already followed: nothing to ask about the version
            body.append(el('p', { class: 'add-mod-found', text: p.found ? `Found version ${p.found.version}, the newest release on GitHub.` : 'This repository has no releases yet. ModPacer will keep looking.' }));
            buttons.append(button('Back', () => { ui.step = 1; render(); }, { muted: true }), button('Add it', save, { primary: true }));
            return;
        }
        if (p.found) {
            body.append(
                el('p', { class: 'add-mod-found', text: `Found version ${p.found.version}, the newest release on GitHub. Is that the version you have?` }),
                field('The version you have now', 'addModVersion', { value: ui.version, hint: "Leave it empty if it isn't installed yet." }),
            );
            buttons.append(button('Back', () => { takeStep2(); ui.step = 1; render(); }, { muted: true }), button('Yes, Next', () => { ui.version = p.found.version; afterVersion(); }, { primary: true }), button('Next', goNext));
        } else {
            body.append(
                el('p', { class: 'add-mod-found', text: 'This repository has no releases yet. ModPacer will keep looking.' }),
                field('The version you have now', 'addModVersion', { value: ui.version, hint: "Leave it empty if it isn't installed yet." }),
            );
            buttons.append(button('Back', () => { takeStep2(); ui.step = 1; render(); }, { muted: true }), button('Next', goNext, { primary: true }));
        }
        body.querySelector('#addModVersion').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); goNext(); } });
    }
    function takeStep2() { ui.version = valueOf('addModVersion'); }

    // ---- step 3
    function renderWhich(body, buttons) {
        const p = ui.preview;
        const manager = p.manager === 'mo2' ? 'Mod Organizer 2' : 'Vortex';
        const sg = p.suggestion || {};
        const ask = sg.ask;
        const lc = (v) => String(v || '').trim().toLowerCase();
        // The copies that share the suggested mod's name, and the one the person most likely has: the copy whose Variant is the variant the folder step read (when exactly
        // one is), else what the server found (the only enabled copy).
        const bestKey = (serverKey) => {
            const name = lc((sg.sure && sg.sure.name) || (ask && ask.name) || sg.name);
            const hint = lc(ui.source === 'folder' ? (ui.variant || (p.newest && p.newest.variant)) : '');
            if (name && hint) { const same = (p.choices || []).filter((c) => lc(c.name) === name && c.variant && lc(c.variant) === hint); if (same.length === 1) return same[0].key; }
            return serverKey || null;
        };
        if (ask && !ui.askAnswered) {
            body.append(el('p', { class: 'add-mod-found', text: `Is this the same as “${ask.name}”, which you already have in ${manager}?` }));
            buttons.append(
                button('Back', () => { ui.step = 2; render(); }, { muted: true }),
                button('No, different', () => { ui.askAnswered = true; render(); }, { muted: true }),
                button('Yes, same mod', () => { ui.askAnswered = true; const k = bestKey(ask.key); if (k) ui.linkKey = k; else ui.mustChoose = true; render(); }, { primary: true }),
            );
            return;
        }
        // A version was given, so the person has it installed: nothing is chosen for them and there is no "Not installed yet" row. A mod whose name matches goes first.
        const addedName = lc(ui.name || ui.nameHint || p.repoName || '');
        const likelyKey = bestKey(sg.sure ? sg.sure.key : (ask ? ask.key : null));
        const isLikely = (c) => (likelyKey ? c.key === likelyKey : !!addedName && lc(c.name) === addedName);
        body.append(
            el('p', { class: 'add-mod-found', text: 'Which mod in your mod manager is this?' }),
            el('p', { class: 'muted', text: 'So ModPacer knows which version you really have.' }),
            el('input', { type: 'text', id: 'addModFilter', placeholder: 'Search your mods', value: ui.filter, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Search your mods' }),
        );
        const list = el('div', { class: 'add-mod-list', role: 'radiogroup', 'aria-label': 'Your mods' });
        const chooseLine = el('p', { class: 'muted add-mod-hint', id: 'addModChoose', text: 'Choose which one you have.' });
        const addBtn = button('Add it', save, { primary: true });
        const refreshAdd = () => { const undecided = ui.linkKey === undefined && (p.choices || []).length > 0; // a manager that lists no mods leaves nothing to pick: Add it stays on
             addBtn.disabled = undecided; chooseLine.style.display = undecided ? '' : 'none'; };
        body.append(list, chooseLine);
        const paintList = () => {
            list.textContent = '';
            const q = ui.filter.toLowerCase();
            const all = p.choices || [];
            const hasEnabled = new Set(all.filter((c) => c.enabled !== false).map((c) => lc(c.name)));
            const matches = all.filter((c) => !q || c.name.toLowerCase().includes(q) || lc(c.variant).includes(q) || c.key === ui.linkKey);
            // Disabled copies of a mod that has an enabled copy wait behind one line (the copy that is picked always stays visible).
            const hidden = ui.showDisabled || q ? [] : matches.filter((c) => c.enabled === false && hasEnabled.has(lc(c.name)) && c.key !== ui.linkKey && c.key !== likelyKey);
            const facts = (c) => [manager, c.version ? `version ${c.version}` : null, c.variant ? `variant ${c.variant}` : null].filter(Boolean).join(', ');
            const seen = new Map();
            for (const c of matches) { const k = lc(c.name) + '|' + facts(c); seen.set(k, (seen.get(k) || 0) + 1); }
            const shown = matches.filter((c) => !hidden.includes(c));
            const rows = [{ key: '__app', name: "It's not a mod: just tell me when there's a new version" }].concat(shown.filter(isLikely), shown.filter((c) => !isLikely(c))).slice(0, 80);
            for (const c of rows) {
                const id = `addModPick-${c.key === null ? 'none' : c.key === '__app' ? 'application' : c.key}`.replace(/[^A-Za-z0-9_-]/g, '_');
                const radio = el('input', { type: 'radio', name: 'addModPick', id, checked: ui.linkKey === c.key });
                radio.checked = ui.linkKey === c.key;
                radio.addEventListener('change', () => { ui.linkKey = c.key; refreshAdd(); });
                const real = c.key !== null && c.key !== '__app';
                let text = real ? facts(c) : '';
                if (real && seen.get(lc(c.name) + '|' + facts(c)) > 1 && c.installedAt) text += `, installed ${String(c.installedAt).slice(0, 10)}`;
                const state = real && c.enabled !== null && c.enabled !== undefined ? el('span', { class: 'add-mod-pick-state' }, el('span', { class: `sdot ${c.enabled ? 'ok' : 'off'}` }), document.createTextNode(c.enabled ? 'Enabled' : 'Disabled')) : null;
                const label = el('label', { for: id, class: 'add-mod-pick' + (real && c.enabled === false ? ' add-mod-off' : ''), title: real ? `${c.name}: ${text}` : c.name }, radio, el('span', { class: 'add-mod-pick-name', text: c.name }), text ? el('span', { class: 'muted add-mod-pick-ver', text }) : null, state);
                list.append(label);
            }
            if (hidden.length) list.append(el('button', { type: 'button', class: 'add-mod-more', id: 'addModShowDisabled', text: `Show disabled copies (${hidden.length})`, onclick: () => { ui.showDisabled = true; paintList(); } }));
        };
        paintList();
        refreshAdd();
        body.querySelector('#addModFilter').addEventListener('input', (e) => { ui.filter = e.target.value; paintList(); });
        buttons.append(button('Back', () => { ui.step = 2; render(); }, { muted: true }), addBtn);
    }

    // ---- moving on
    async function goNext() {
        if (busy || !ui) return;
        if (ui.step === 1) {
            takeStep1();
            if (ui.source === 'folder') {
                if (!ui.folder) { setMsg('Choose the folder where your builds land.'); return; }
                busy = true; setMsg('');
                try { ui.preview = await api('POST', '/api/tracked/read-folder', { folder: ui.folder, pattern: ui.pattern, exclude: ui.exclude, variant: ui.variant }); ui.step = 2; busy = false; render(); }
                catch (e) { busy = false; setMsg(e.message); }
                return;
            }
            if (ui.source === 'loverslab') {
                if (!ui.address) { setMsg('Paste the link to the mod’s LoversLab page.'); return; }
                clearTimeout(ui.readTimer); ui.readTimer = null;
                const rd = ui.read;
                if (rd && rd.address === ui.address && rd.state === 'done') { ui.preview = rd.result; ui.nameHint = rd.result.nameHint || ''; ui.step = 2; setMsg(''); render(); return; } // already read: no second read
                if (rd && rd.address === ui.address && rd.state === 'reading') return;
                setMsg(''); startRead(true); // nothing read for this link yet (or the last read failed): read it, then move on
                return;
            }
            if (!ui.address) { setMsg('Paste the link to the mod’s GitHub page.'); return; }
            busy = true; setMsg('');
            try { ui.preview = await api('POST', '/api/tracked/read', { address: ui.address }); ui.step = 2; if (ui.preview.repoName && !ui.name) ui.nameHint = ui.preview.repoName; busy = false; render(); }
            catch (e) { busy = false; setMsg(e.message); }
            return;
        }
        if (ui.step === 2) { if (!ui.addTo) takeStep2(); afterVersion(); }
    }
    function afterVersion() {
        const p = ui.preview;
        if (ui.addTo) { save(); return; }
        // No version = not installed: there is nothing to match, so the "Which mod in your mod manager" screen is skipped and the mod is added as not installed.
        const has = !!ui.version;
        if (ui.hadVersion !== undefined && ui.hadVersion !== has) { ui.linkKey = undefined; ui.askAnswered = false; ui.mustChoose = false; } // Back and changed: an earlier choice no longer applies
        ui.hadVersion = has;
        if (!has) { ui.linkKey = null; save(); return; }
        ui.step = 3; render(); // the list may be empty, but "It's not a mod" is always there to choose
    }
    async function save() {
        if (busy || !ui) return;
        busy = true; setMsg('');
        try {
            const application = ui.linkKey === '__app'; // "It's not a mod": an application that is only tracked
            const link = ui.linkKey && !application ? { key: ui.linkKey } : null;
            if (ui.addTo) {
                const body = ui.source === 'folder' ? { source: 'folder', folder: ui.folder, pattern: ui.pattern, exclude: ui.exclude, variant: ui.variant } : { source: ui.source === 'loverslab' ? 'loverslab' : 'github', address: ui.address };
                const st = await api('POST', `/api/tracked/${enc(ui.addTo.id)}/add-source`, body);
                busy = false; close();
                if (typeof renderPlugins === 'function') renderPlugins(st);
                return;
            }
            const state = ui.source === 'folder'
                ? await api('POST', '/api/tracked', { source: 'folder', name: ui.name, folder: ui.folder, pattern: ui.pattern, exclude: ui.exclude, variant: ui.variant, version: ui.version, link, application })
                : ui.source === 'loverslab'
                    ? await api('POST', '/api/tracked', { source: 'loverslab', name: ui.name, address: ui.address, version: ui.version, link, application, requestId: ui.preview && ui.preview.requestId })
                    : await api('POST', '/api/tracked', { name: ui.name, address: ui.address, version: ui.version, link, application });
            busy = false;
            close();
            if (typeof renderPlugins === 'function') renderPlugins(state);
        } catch (e) {
            busy = false;
            setMsg(e.message);
        }
    }

    // ---- the row menu's three actions
    let askUi = null;
    function ask({ title, label, value = '', okText = 'Save', placeholder = '' }, onSave) {
        askUi = { onSave };
        $('trackedAskTitle').textContent = title;
        $('trackedAskLabel').textContent = label;
        $('trackedAskInput').value = value;
        $('trackedAskInput').placeholder = placeholder;
        $('trackedAskOk').textContent = okText;
        $('trackedAskMsg').textContent = ''; $('trackedAskMsg').className = 'add-mod-msg';
        $('trackedAskOverlay').style.display = 'flex';
        $('trackedAskInput').focus();
    }
    function closeAsk() { $('trackedAskOverlay').style.display = 'none'; askUi = null; }
    async function submitAsk() {
        if (!askUi || askUi.busy) return;
        askUi.busy = true;
        try { await askUi.onSave($('trackedAskInput').value.trim()); closeAsk(); }
        catch (e) { if (askUi) { askUi.busy = false; $('trackedAskMsg').textContent = e.message; $('trackedAskMsg').className = 'add-mod-msg req-warn'; } }
    }
    async function post(path, body) {
        let state = null;
        try { state = await api('POST', path, body); } catch (e) { throw e; }
        if (typeof renderPlugins === 'function') renderPlugins(state);
    }
    async function stopTracking(id) {
        try { await post(`/api/tracked/${enc(id)}/stop`); } catch { if (typeof refreshState === 'function') refreshState(); }
    }
    // ---- An application (ModPacer 2.0): Download asks which file and where to save, every time; "I've updated it"; Open folder on the saved file.
    let appUi = null;
    const appMsg = (t) => { const m = $('appDownloadMsg'); m.textContent = t || ''; m.className = `add-mod-msg${t ? ' req-warn' : ''}`; };
    function appClose() { $('appDownloadOverlay').style.display = 'none'; appUi = null; }
    function appRender() {
        const body = $('appDownloadBody'), btns = $('appDownloadButtons');
        body.textContent = ''; btns.textContent = '';
        $('appDownloadTitle').textContent = appUi.row.title;
        if (appUi.exists) { // a file with that name is already there: never over it without asking
            body.append(el('p', { class: 'add-mod-found', text: `A file called ${appUi.exists} is already in that folder.` }));
            btns.append(button('Cancel', appClose, { muted: true }), button('Keep both', () => appGo('both')), button('Replace it', () => appGo('replace'), { primary: true }));
            return;
        }
        const files = appUi.row.tracked.appFiles || [];
        const size = (n) => (typeof fileSizeText === 'function' ? fileSizeText(n) : `${n} bytes`);
        if (files.length === 1) body.append(el('p', { class: 'add-mod-found', text: `${files[0].name} (${size(files[0].size)})` }));
        else {
            body.append(el('p', { class: 'add-mod-found', text: 'Which file?' }));
            const list = el('div', { class: 'add-mod-list add-mod-variants', role: 'radiogroup', 'aria-label': 'Files' });
            files.forEach((f, i) => {
                const id = `appFile-${i}`;
                const radio = el('input', { type: 'radio', name: 'appFile', id });
                radio.checked = f.name === appUi.file;
                radio.addEventListener('change', () => { appUi.file = f.name; });
                list.append(el('label', { for: id, class: 'add-mod-pick', title: f.name }, radio, el('span', { class: 'add-mod-pick-name', text: f.name }), el('span', { class: 'muted add-mod-pick-ver', text: size(f.size) })));
            });
            body.append(list);
        }
        if (typeof canBrowseFolders !== 'undefined' && !canBrowseFolders) body.append(field('The folder', 'appDownloadFolder', { value: appUi.folder || '', placeholder: 'Type or paste the folder' })); // no folder window on this system
        body.append(el('p', { class: 'muted add-mod-hint', text: 'ModPacer only saves the file where you choose. It never runs it.' }));
        btns.append(button('Cancel', appClose, { muted: true }), button(appUi.refused ? 'Choose another folder' : 'Choose where to save', () => appGo(null), { primary: true }));
    }
    async function appGo(onExisting) {
        if (!appUi || appUi.busy) return;
        appUi.busy = true; appMsg('');
        try {
            if (!onExisting) { // the folder is asked for every time, in the app's own folder window; nothing is assumed
                if ($('appDownloadFolder')) appUi.folder = valueOf('appDownloadFolder');
                else {
                    const r = await api('POST', '/api/settings/browse-folder', { title: 'Choose where to save the file', initialDir: appUi.row.tracked.lastAppFolder || undefined });
                    if (!r.path) { appUi.busy = false; return; } // the window was closed: nothing happens
                    appUi.folder = r.path;
                }
            }
            const state = await api('POST', `/api/tracked/${enc(appUi.row.id)}/app-download`, { asset: appUi.file, folder: appUi.folder, onExisting: onExisting || undefined });
            appClose();
            if (typeof renderPlugins === 'function') renderPlugins(state);
        } catch (e) {
            if (!appUi) return;
            appUi.busy = false;
            if (e.kind === 'exists') { appUi.exists = e.fileName || 'that name'; appRender(); return; }
            appUi.refused = e.kind === 'folder_refused' || e.kind === 'folder_missing' || e.kind === 'bad_path';
            appRender(); appMsg(e.message);
        }
    }
    function appDownload(row) {
        const files = (row.tracked && row.tracked.appFiles) || [];
        if (files.length === 0) return;
        appUi = { row, file: files[0].name, folder: '', exists: null, refused: false, busy: false };
        $('appDownloadOverlay').style.display = 'flex';
        appRender();
    }
    const appUpdated = (id) => act(`/api/tracked/${enc(id)}/updated`);
    async function openSaved(id) { try { await api('POST', `/api/tracked/${enc(id)}/open-saved`); } catch { /* nothing to show */ } }
    // A folder row: pick another folder for the same builds (the file-name pattern stays), and open the folder in the file manager.
    async function chooseAnotherFolder(row) {
        let picked = null;
        try { const r = await api('POST', '/api/settings/browse-folder', { title: 'Choose the folder where your builds land' }); picked = r.noChooser ? 'typed' : r.path; } catch { return; }
        if (!picked) return;
        if (picked === 'typed') { ask({ title: 'Choose another folder', label: 'The folder', placeholder: 'Type or paste the folder', okText: 'Save' }, (v) => post(`/api/tracked/${enc(row.id)}/update-folder`, { folder: v })); return; }
        try { await post(`/api/tracked/${enc(row.id)}/update-folder`, { folder: picked }); } catch (e) { ask({ title: 'Choose another folder', label: 'The folder', value: picked, okText: 'Save' }, (v) => post(`/api/tracked/${enc(row.id)}/update-folder`, { folder: v })); $('trackedAskMsg').textContent = e.message; $('trackedAskMsg').className = 'add-mod-msg req-warn'; }
    }
    async function openFolder(id, sourceId) { try { await api('POST', `/api/tracked/${enc(id)}/open-folder`, sourceId ? { sourceId } : undefined); } catch { /* nothing to open */ } }
    // Several sources, the pin and the question (ModPacer 2.0, part 3). Each answer redraws the page from the new state.
    const act = async (path, body) => { try { await post(path, body); } catch (e) { if (typeof refreshState === 'function') refreshState(); } };
    const pin = (id, sourceId) => act(`/api/tracked/${enc(id)}/pin`, { sourceId: sourceId || null });
    const removeSource = (id, sourceId) => act(`/api/tracked/${enc(id)}/remove-source`, { sourceId });
    const chooseSource = (id, sourceId) => act(`/api/tracked/${enc(id)}/choose-source`, { sourceId });
    const addSource = (row) => open({ addTo: { id: row.id, types: (row.tracked.sources || []).map((x) => x.type) } });
    function updateLink(row) {
        const onlyPage = (row.tracked.sources || []).length > 0 && (row.tracked.sources || []).every((s) => s.type === 'loverslab');
        const one = ((row.tracked && row.tracked.sources) || []).find((s) => s.type === (onlyPage ? 'loverslab' : 'github')); // the one the server changes
        ask({ title: 'Update the link', label: onlyPage ? 'Link to the LoversLab page' : 'Link to the GitHub page', value: (one && one.url) || '', placeholder: onlyPage ? 'https://www.loverslab.com/files/file/12345-some-mod/' : 'https://github.com/owner/mod', okText: 'Save' }, (v) => post(`/api/tracked/${enc(row.id)}/update-link`, { address: v }));
        $('trackedAskInput').select();
    }
    async function iChecked(row) {
        if (row.tracked && row.tracked.linked) { // the mod manager already says which version is installed: one click
            try { await post(`/api/tracked/${enc(row.id)}/checked`, {}); } catch { if (typeof refreshState === 'function') refreshState(); }
            return;
        }
        ask({ title: 'Update version', label: 'The version you have now', value: row.tracked && row.tracked.observed ? row.tracked.observed : (row.installedVersion || ''), okText: 'Save' }, (v) => post(`/api/tracked/${enc(row.id)}/checked`, { version: v }));
    }

    document.addEventListener('DOMContentLoaded', () => {
        if ($('addModBtn')) $('addModBtn').addEventListener('click', open);
        if ($('trackedAskCancel')) $('trackedAskCancel').addEventListener('click', closeAsk);
        if ($('trackedAskOk')) $('trackedAskOk').addEventListener('click', submitAsk);
        if ($('trackedAskInput')) $('trackedAskInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitAsk(); } });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (window.browserHelperUi && window.browserHelperUi.popupOpen()) return; // the helper pop-up on top closes first
            if (askUi) closeAsk(); else if (appUi) appClose(); else if (ui && !busy) close();
        });
    });
    window.addModUi = { open, close, isOpen, stopTracking, updateLink, iChecked, chooseAnotherFolder, openFolder, pin, removeSource, chooseSource, addSource, appDownload, appUpdated, openSaved };
})();
