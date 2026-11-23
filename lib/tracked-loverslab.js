'use strict';
// ModPacer 2.0, part 4: the LoversLab side of a tracked mod. ModPacer itself NEVER fetches a LoversLab page (the person's own browser does, through the browser helper, with
// the person's own sign-in); this file only (1) checks the address the person pasted and (2) cleans what the helper reports back. Everything read from a page is plain text and
// is only ever shown as text.

const tg = require('./tracked-github');
const { compareVersions } = require('./version-compare');

const HOSTS = new Set(['www.loverslab.com', 'loverslab.com']);
const SOURCES = new Set(['title', 'whatsnew', 'whatsnew-several', 'fileinfo']);
const KINDS = new Set(['page', 'signin', 'challenge', 'age']);

// The one kind of page ModPacer follows: https://www.loverslab.com/files/file/<id>-<name>/ . Anything after the file is dropped (a "?do=download" or a comment link is never kept),
// loverslab.com is written www.loverslab.com, and there is no sign-in, port or odd character. -> { ok: true, url } | { ok: false, reason }
function parseAddress(input) {
    const raw = typeof input === 'string' ? input.trim() : '';
    const bad = (reason) => ({ ok: false, reason });
    if (!raw) return bad('empty');
    if (raw.length > 600) return bad('too_long');
    if (/[\u0000-\u001f\u007f\s\\]/.test(raw)) return bad('bad_characters');
    if (/%2f|%5c|%2e%2e|%00/i.test(raw)) return bad('encoded_path');
    let u;
    try { u = new URL(raw); } catch { return bad('not_an_address'); }
    if (u.protocol !== 'https:') return bad('not_https');
    if (!HOSTS.has(u.hostname.toLowerCase())) return bad('not_loverslab');
    if (u.username || u.password) return bad('has_user_info');
    if (u.port) return bad('has_port');
    const parts = u.pathname.split('/').filter((p) => p !== '');
    if (parts.length < 3 || parts[0].toLowerCase() !== 'files' || parts[1].toLowerCase() !== 'file') return bad('not_a_file_page');
    const m = /^(\d{1,9})(?:-(.+))?$/.exec(parts[2]);
    if (!m) return bad('not_a_file_page');
    let slug = m[1];
    if (m[2] !== undefined) {
        const name = cleanName(m[2]);
        if (!name) return bad('not_a_file_page');
        slug += `-${name}`;
    }
    return { ok: true, url: `https://www.loverslab.com/files/file/${slug}/`, id: m[1] };
}

// The name part of the address after the number. It may hold letters of any language and a long dash, written as the browser writes them (%E2%80%94), and nothing else:
// every %XX must decode to valid UTF-8, and the decoded text may hold only letters, numbers, marks, dashes and . _ ~ (so no control character, space, slash, backslash, % or
// ".." can get in by being encoded). The result is the SAME spelling with the hex digits in capitals (the page's own address, never a cleaned-up name: the helper does not
// follow a redirect), at most 240 characters. -> the name part, or null.
const NAME_OK = /^[\p{L}\p{N}\p{M}\p{Pd}._~-]+$/u;
function cleanName(encoded) {
    if (encoded.length > 240 * 3) return null; // far over the limit: not worth decoding
    if (/%(?![0-9A-Fa-f]{2})/.test(encoded) || /%2E/i.test(encoded)) return null; // (a dot is never written as %2E)
    let decoded;
    try { decoded = decodeURIComponent(encoded); } catch { return null; } // not valid UTF-8
    if (!decoded || decoded.includes('..') || !NAME_OK.test(decoded)) return null;
    const out = encoded.replace(/%[0-9A-Fa-f]{2}/g, (h) => h.toUpperCase());
    // a raw (unencoded) letter or dash is written the way the browser would send it
    const spelled = out.replace(/[^A-Za-z0-9._~%-]+/g, (run) => encodeURIComponent(run));
    return spelled.length <= 240 ? spelled : null;
}

// The same page written another way (hex in lower case, a raw dash, www or not) gives the same text; an address with anything after the file (a path, a query) is not that page. -> the address, or null.
function canonicalPage(s) {
    const r = parseAddress(s);
    if (!r.ok) return null;
    try { const u = new URL(String(s).trim()); if (u.search || u.hash || u.pathname.split('/').filter((p) => p !== '').length !== 3) return null; } catch { return null; }
    return r.url;
}

const clean = (s, n) => tg.cleanText(s, n);
const cleanList = (a, n, each) => (Array.isArray(a) ? a : []).slice(0, n).map((x) => clean(x, each)).filter(Boolean);

// What a helper's report means for ModPacer. `report` is untrusted JSON from the person's own browser (still checked: any program on this PC could be the sender).
//   -> { ok: true, observation }                     a version was read
//    | { ok: false, code, retry }                     code: 'gone' (404/410), 'signin' (a sign-in, a bot check, an age question), 'layout' (a page without a version),
//                                                      'network' (the browser could not reach the site), 'rate_limited'; `retry`: false for what only the person can fix
function cleanReport(report, { page, now = Date.now(), prev = null } = {}) {
    const r = report && typeof report === 'object' ? report : {};
    const status = Number.isInteger(r.status) ? r.status : 0;
    if (r.error || status === 0) return { ok: false, code: 'network', retry: true };
    if (status === 404 || status === 410) return { ok: false, code: 'gone', retry: false };
    if (status === 429) return { ok: false, code: 'rate_limited', retry: true };
    if (status >= 500) return { ok: false, code: 'network', retry: true };
    // a redirect away from the page (to a sign-in page, usually): the page was not the one asked for
    let finalHost = '', finalPath = '';
    try { const u = new URL(String(r.finalUrl || page)); finalHost = u.hostname.toLowerCase(); finalPath = u.pathname; } catch { /* no final address: judged by the rest */ }
    const kind = KINDS.has(r.kind) ? r.kind : 'page';
    if (status === 401 || status === 403 || kind !== 'page' || (finalHost && !HOSTS.has(finalHost)) || /\/login|\/register/i.test(finalPath)) return { ok: false, code: 'signin', retry: false };
    if (status < 200 || status >= 300) return { ok: false, code: 'layout', retry: false };
    const version = r.layout === true ? null : tg.cleanTypedVersion(r.version);
    if (!version) return { ok: false, code: 'layout', retry: false };
    const t = Date.parse(String(r.readAt || ''));
    const readAt = Number.isFinite(t) && Math.abs(t - now) < 24 * 60 * 60 * 1000 ? new Date(t).toISOString() : new Date(now).toISOString(); // the helper's own clock, if sane
    const obs = {
        version, source: SOURCES.has(r.source) ? r.source : null, alsoListed: cleanList(r.alsoListed, 8, 40).filter((v) => tg.cleanTypedVersion(v)),
        dates: cleanList(r.dates, 8, 80), title: clean(r.title, 120) || null, url: page, readAt, how: 'helper',
        prev: prev && prev.version && prev.version !== version ? prev.version : (prev && prev.prev) || null,
    };
    return { ok: true, observation: obs };
}

// A version that cannot be told apart in order from another (a date against a counter) is for the person to confirm: the same rule as every other source.
const sameKind = (a, b) => compareVersions(a, b) !== 'unknown';

module.exports = { canonicalPage, parseAddress, cleanReport, sameKind, HOSTS, SOURCES };
