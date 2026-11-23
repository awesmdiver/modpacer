// ModPacer browser helper: the background worker. It has NO content scripts and answers NO messages from web pages (only its own popup can talk to it), so a page, or an ad on a
// page, cannot make it do anything. What it does:
//   1. every half minute it asks ModPacer (127.0.0.1, this PC only) which page to read;
//   2. it reads ONLY that exact page, with the person's own sign-in (the browser's own cookies; the helper never sees or stores them), never a link found on the page;
//   3. it reports the version and date lines it found (plain text) back to ModPacer, tied to the request ModPacer made.
// Paired once with a code from ModPacer's Settings; the secret it gets back stays in this browser's local storage only (never synced).
importScripts('reader.js');

const PORT = 47821; // ModPacer's own port
const PAGE = /^https:\/\/www\.loverslab\.com\/files\/file\/\d{1,9}(?:-(?:[A-Za-z0-9._~-]|%[0-9A-F]{2}){1,240})?\/$/; // the one kind of page the helper will ever fetch (a name with a long dash arrives written %E2%80%94)
const PAGE_REFUSED = /%2F|%5C|%00|%2E|%25|\.\./i; // however it is written, never a slash, a backslash, a dot, a percent or ".." hidden in the name
function isPage(p) { p = String(p || ''); return p.length <= 600 && PAGE.test(p) && !PAGE_REFUSED.test(p); }
const MAX_PAGE_CHARS = 3000000;
const VERSION = chrome.runtime.getManifest().version;

function browserName() {
    const ua = (self.navigator && self.navigator.userAgent) || '';
    if (/Edg\//.test(ua)) return 'Microsoft Edge';
    if (/Chrome\//.test(ua)) return 'Chrome';
    return 'Browser';
}

// Is what answers on ModPacer's port really ModPacer? Asked before the token (or a pairing code) is sent anywhere, so an unrelated program that holds the port gets neither.
// (It cannot stop a program that copies ModPacer's answer; it stops everything else.)
async function modPacerAnswers() {
    try {
        const res = await fetch('http://127.0.0.1:' + PORT + '/api/ping', { cache: 'no-store' });
        const j = await res.json();
        return res.status === 200 && !!j && j.app === 'modpacer' && j.ok === true;
    } catch (e) { return false; }
}

async function call(path, body, token) {
    if (!(await modPacerAnswers())) throw new Error('not modpacer');
    const headers = { 'content-type': 'application/json', 'x-modpacer': '1' };
    if (token) headers.authorization = 'Bearer ' + token;
    const res = await fetch('http://127.0.0.1:' + PORT + path, { method: 'POST', headers: headers, body: JSON.stringify(Object.assign({ helperVersion: VERSION, browser: browserName() }, body || {})) });
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    return { status: res.status, json: json };
}

// Reads one page the way the person's own browser would, with their cookies, and reports it.
async function readOne(token, request) {
    const report = { id: request.id, page: request.page };
    if (!isPage(request.page)) { report.status = 0; report.error = 'refused'; return call('/api/helper-link/report', report, token); } // never anything but a LoversLab file page
    try {
        // A redirect is never followed: a hidden or removed file sends the browser to a sign-in or error page, and reading that would report a made-up answer. It is reported as "could not read the page".
        const res = await fetch(request.page, { credentials: 'include', redirect: 'manual', cache: 'no-store' });
        if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) { report.status = 0; report.error = 'redirect'; return call('/api/helper-link/report', report, token); }
        const html = (await res.text()).slice(0, MAX_PAGE_CHARS);
        report.status = res.status;
        report.finalUrl = res.url;
        const r = self.ModPacerReader.readHtml(html, Date.now());
        Object.assign(report, { kind: r.kind, title: r.title, version: r.version, source: r.source, alsoListed: r.alsoListed, dates: r.dates, layout: r.layout, readAt: r.readAt });
    } catch (e) { report.status = 0; report.error = 'network'; }
    return call('/api/helper-link/report', report, token);
}

let running = false;
async function tick() {
    if (running) return { ok: false, reason: 'busy' };
    running = true;
    try {
        const cfg = await chrome.storage.local.get(['token']);
        if (!cfg.token) return { ok: false, reason: 'not_paired' };
        let polled;
        try { polled = await call('/api/helper-link/poll', {}, cfg.token); } catch (e) { return { ok: false, reason: 'no_modpacer' }; }
        if (polled.status === 401) { await chrome.storage.local.remove('token'); return { ok: false, reason: 'not_paired' }; } // ModPacer no longer knows this helper
        const list = polled.json && Array.isArray(polled.json.requests) ? polled.json.requests.slice(0, 10) : [];
        for (const request of list) {
            try { await readOne(cfg.token, request); } catch (e) { /* ModPacer went away mid-way: the next tick asks again */ }
            await new Promise((r) => setTimeout(r, 2000)); // one page at a time, spaced out
        }
        return { ok: true, read: list.length };
    } finally { running = false; }
}

async function pair(code) {
    let r;
    try { r = await call('/api/helper-link/pair', { code: String(code || '').slice(0, 20) }); } catch (e) { return { ok: false, reason: 'no_modpacer' }; }
    if (r.status === 200 && r.json && r.json.token) { await chrome.storage.local.set({ token: r.json.token }); tick(); return { ok: true }; }
    return { ok: false, reason: 'refused' };
}

function arm() { chrome.alarms.create('modpacer-ask', { periodInMinutes: 0.5 }); }
chrome.runtime.onInstalled.addListener(arm);
chrome.runtime.onStartup.addListener(() => { arm(); tick(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'modpacer-ask') tick(); });
// Only this extension's own popup sends messages. (There is no content script and no external connection, so nothing else can.)
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (sender.id !== chrome.runtime.id || !msg) return false;
    if (msg.type === 'pair') { pair(msg.code).then(reply); return true; }
    if (msg.type === 'status') {
        chrome.storage.local.get(['token']).then(async (c) => {
            const allowed = await chrome.permissions.contains({ origins: ['https://www.loverslab.com/*'] });
            reply({ paired: !!c.token, allowed: allowed, version: VERSION });
        });
        return true;
    }
    if (msg.type === 'check') { tick().then(reply); return true; }
    return false;
});
arm();
