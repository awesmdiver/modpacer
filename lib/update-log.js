'use strict';
// A plain, append-only record of what ModPacer did and why a step was skipped -- logs/update.log in the app's data folder
// (queue: update-delete-old-and-deploy-ask, 2026-10-01; widened by "ModPacer keeps a log from the first start", 2026-10-06 so a
// player who cannot even finish setup has something to send us). Never shown in the player's window. Lines are prefixed by area:
// [start] [setup] [settings] [check] [error]. Only this tool's own mods are ever named in it (plugin ids and the Vortex ids of those
// mods), never another mod or collection, and never any file contents. Best-effort: logging can never break anything.
//
// SECRETS NEVER REACH THE FILE: every line goes through redact() on its way in -- the Nexus key (any value ever saved or handed to us),
// the value after apikey/authorization/token/password/secret, Bearer/Basic values, and the query string and any user:password of
// every web address. Callers should still never pass a secret in; this is the second lock, not the first.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { dataPath } = require('./data-dir');

const MAX_BYTES = 1_000_000;

function logFile() {
    return dataPath('logs', 'update.log');
}

// Keys seen this run (typed in Settings, handed to a Check). Exact text is blanked wherever it shows up.
const knownSecrets = new Set();
function noteSecret(value) {
    if (typeof value === 'string' && value.trim().length >= 4) knownSecrets.add(value.trim());
}
function savedSecrets() {
    try {
        const cfg = JSON.parse(fs.readFileSync(dataPath('config.json'), 'utf8'));
        return typeof cfg.nexusApiKey === 'string' ? [cfg.nexusApiKey] : [];
    } catch { return []; }
}

const SECRET_NAME = '(?:\\w*api[-_ ]?key|\\w*token|authorization|password|passwd|secret)';
const NAMED_VALUE_RE = new RegExp(`(${SECRET_NAME}[\\\\"']*\\s*[:=]\\s*[\\\\"']*)(?:(?:Bearer|Basic|token)\\s+)?[^\\s"',}&\\\\]+`, 'gi');
const SCHEME_VALUE_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{6,}/g;
const URL_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s"'<>\\]*)/gi;

// The person's profile folder (and the Windows user name under C:\Users) never reaches the file: players paste logs into public bug reports.
function profileFolderRe() {
    try {
        const home = os.homedir();
        if (!home) return null;
        return new RegExp(home.split(/[\\/]+/).filter(Boolean).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]+') + '(?=[\\\\/\\s"\'<>]|$)', 'gi');
    } catch { return null; }
}
function userNameRe() {
    try {
        const name = os.userInfo().username;
        if (!name) return null;
        return new RegExp(`([A-Za-z]:[\\\\/]+Users[\\\\/]+)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\\\/\\s"'<>]|$)`, 'gi');
    } catch { return null; }
}

function redact(text) {
    let s = String(text);
    const home = profileFolderRe();
    if (home) s = s.replace(home, () => '%USERPROFILE%');
    const user = userNameRe();
    if (user) s = s.replace(user, () => '%USERPROFILE%');
    for (const secret of [...knownSecrets, ...savedSecrets()]) {
        if (secret.trim().length >= 4) s = s.split(secret.trim()).join('[key]');
    }
    s = s.replace(URL_RE, (all, scheme, rest) => {
        let r = rest.replace(/^[^/@?#]*@/, ''); // user:password@
        const q = r.search(/[?#]/);
        if (q !== -1) r = r.slice(0, q) + (r[q] === '?' ? '?[removed]' : '');
        return scheme + r;
    });
    s = s.replace(SCHEME_VALUE_RE, '$1 [hidden]');
    s = s.replace(NAMED_VALUE_RE, '$1[hidden]');
    return s;
}

// The "Keep a log" setting (config.json keepLog; missing = on). Every writer checks it: this file's and the Vortex helper's.
function loggingOn() {
    try { return JSON.parse(fs.readFileSync(dataPath('config.json'), 'utf8')).keepLog !== false; } catch { return true; }
}

function logUpdate(line) {
    if (!loggingOn()) return;
    try {
        const file = logFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1'); } catch { /* no file yet */ }
        fs.appendFileSync(file, `${new Date().toISOString()} ${redact(line)}\n`);
    } catch { /* never worth failing an update over */ }
}

// One line under an area: start | setup | settings | check | error.
function logArea(area, ...parts) {
    logUpdate(`[${area}] ${parts.filter(Boolean).join(' ')}`);
}

// Same, but a line identical to the last one under the same key is skipped -- for answers the page asks again and again.
const lastByKey = new Map();
function logAreaOnce(key, area, line) {
    if (lastByKey.get(key) === line) return;
    lastByKey.set(key, line);
    logArea(area, line);
}

// A failed web request: the host and the HTTP status (or a short word), never the path, query, headers or body.
function logRequestFailure(host, what) {
    logArea('check', `request failed: ${host} ${what}`);
}

module.exports = { loggingOn, logUpdate, logFile, logArea, logAreaOnce, logRequestFailure, redact, noteSecret };
