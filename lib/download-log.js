'use strict';
// The [download] lines in logs/update.log (queue: the update log records every download, 2026-10-21): what was fetched, from which kind
// of place, where it was saved and how it ended. Under Mod Organizer 2 a download is the player's whole update (they install the zip
// themselves), so this is the only trace of it; under Vortex it is the first half of an install.
// This file only DESCRIBES what the engine does; it never changes what is downloaded or how. Privacy is the log's own (redact() in
// update-log.js adds the profile folder / key / query-string removal on the way in); on top of that a line carries the HOST only,
// never a link, and a failure reason is plain words, never the raw error text.

const { logArea } = require('./update-log');
const { compareVersions } = require('./version-compare');
const downloadState = require('./download-state');

const FOLLOW_UP_DAYS = 30;
const FOLLOW_UP_MAX = 200;

// What the page may say about how a download was asked for (anything else is "button").
const HOWS = { button: 'button', 'download-all': 'Download all', install: 'Install', 'install-all': 'Install all', 'update-all': 'Update all', automatic: 'automatic' };
const howWords = (how) => HOWS[how] || HOWS.button;

const id = (row) => row.hubId || row.id;
const ver = (row) => row.latestVersion || 'unknown version';
const line = (row, text) => logArea('download', `${id(row)} ${ver(row)}: ${text}`);

function hostOf(url) { try { return new URL(String(url)).hostname || null; } catch { return null; } }

// -> "GitHub release github.com" | "Nexus nexusmods.com" | "a direct link <host>" | "the Hub"
function sourceWords(row, assetUrl) {
    if (row.urlKind === 'github') return `GitHub release ${hostOf(assetUrl) || hostOf(row.externalUrl) || 'github.com'}`;
    if (row.urlKind === 'nexus') return 'Nexus nexusmods.com';
    const h = hostOf(row.externalUrl);
    return h ? `a direct link ${h}` : 'the Hub';
}

function started(row, how, assetUrl) {
    line(row, `started (${howWords(how)}); from ${sourceWords(row, assetUrl)}`);
    return Date.now();
}

function saved(row, { fileName, bytes, folder, startedAt, mo2 }) {
    const mb = Number.isFinite(Number(bytes)) ? `${(Number(bytes) / (1024 * 1024)).toFixed(1)} MB` : 'size unknown';
    const secs = startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0;
    line(row, `saved as '${fileName}' (${mb}) in ${folder} in ${secs} s; ${mo2 ? 'install it in Mod Organizer 2' : 'handing it to Vortex'}`);
    if (mo2 && row.latestVersion) addFollowUp({ id: id(row), version: String(row.latestVersion), was: row.installedVersion ? String(row.installedVersion) : null, at: new Date().toISOString() });
}

// The real reason in plain words, never the raw error (it can carry a path with the user name or a link with a query).
function plainReason(e) {
    const code = e && e.code ? String(e.code) : '';
    const msg = String((e && e.message) || e || '');
    if (code === 'ENOSPC' || /no space|not enough (disk )?space/i.test(msg)) return 'not enough disk space';
    if (/Premium/i.test(msg)) return 'the Nexus key is not Premium';
    if (/API key/i.test(msg)) return 'the Nexus key was refused';
    if (/HTTP (401|403)/.test(msg)) return 'refused by the site';
    const http = msg.match(/HTTP (\d{3})/);
    if (http) return `the site answered HTTP ${http[1]}`;
    if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'ENOTFOUND' || /prematurely|took too long|timed out|socket hang up|network/i.test(msg)) return 'connection lost';
    if (/No downloadable archive/i.test(msg)) return 'no zip, 7z or rar attached to the release';
    if (/zip/i.test(msg) && /not|invalid|corrupt/i.test(msg)) return 'the file is not a zip';
    if (/Too many redirects|not valid/i.test(msg)) return 'the download address was not usable';
    const plain = msg.split('\n')[0].replace(/https?:\/\/\S+/gi, '').replace(/[A-Za-z]:[\\/]\S*/g, '').replace(/\s+/g, ' ').trim();
    return plain ? plain.slice(0, 100) : 'unknown error';
}

function failed(row, e) { line(row, `failed (${e && e.plainReason ? e.plainReason : plainReason(e)})`); }

// A downloaded file that is not complete (cut off): one plain line; 7-Zip's own text only as a short debug line. `again`: a new try follows.
function incomplete(row, text, detail, again = true) {
    line(row, `${text}; ${again ? 'downloading it again' : 'giving up after the second try'}`);
    if (detail) logArea('debug', `${id(row)} ${ver(row)}: 7-Zip said: ${detail}`);
}

// Once per reason per add-on per version per session, so a repeating automatic pass never spams.
const skippedBefore = new Set();
function skipped(row, reason) {
    const key = `${id(row)}\u0000${ver(row)}\u0000${reason}`;
    if (skippedBefore.has(key)) return;
    skippedBefore.add(key);
    line(row, `not downloaded (${reason})`);
}

// ---- Mod Organizer 2: closing the loop on the next check ----
// A download under Mod Organizer 2 ends with the player's own install, often after ModPacer was closed and started again, so what is
// waiting is kept in the saved state (download-state.js: a short list of ids and versions, nothing else): dropped once "now installed" is
// written, when the add-on is gone from the player's mods or the Hub, after 30 days, and never more than 200.
const lastInstalled = new Map(); // hub id -> the installed version the last check saw (this run only)
const lastStill = new Map();     // hub id -> the "still" line last written (this run only)

function addFollowUp(entry) {
    try {
        const list = downloadState.getFollowUps().filter((e) => e.id !== entry.id);
        list.push(entry);
        downloadState.setFollowUps(list.slice(-FOLLOW_UP_MAX));
    } catch { /* the log is best effort */ }
}

// Called by every check with the finished rows. `force` (Check now / start-up) writes a "still" line again even if it is unchanged.
function noteChecked(rows, { isMo2, force = false, now = Date.now() } = {}) {
    if (!isMo2) return;
    let list = [];
    try { list = downloadState.getFollowUps(); } catch { /* ignored */ }
    const before = list.length;
    const byId = new Map(rows.map((r) => [id(r), r]));
    const hubReadable = rows.some((r) => r.status && r.status !== 'not_on_hub');
    const keep = [];
    for (const e of list) {
        const row = byId.get(e.id);
        if (now - Date.parse(e.at) > FOLLOW_UP_DAYS * 86400000) continue;        // too old
        if (!row || row.notInstalled || (hubReadable && row.status === 'not_on_hub')) continue; // no longer in the player's mods / on the Hub
        const seen = row.installedVersion ? String(row.installedVersion) : null;
        const arrived = seen && compareVersions(seen, e.version) !== 'newer';     // installed version has reached what was downloaded
        if (arrived && seen !== e.was) {
            logArea('download', `${e.id}: now installed as ${seen} (was ${e.was || 'none'})`);
            lastInstalled.set(e.id, seen);
            lastStill.delete(e.id);
            continue;                                                              // done: dropped
        }
        if (arrived) continue;                                                     // installed by another route before the download: nothing waits
        const text = `${e.id}: downloaded ${e.version} but the installed version is still ${seen || 'unknown'}`;
        if (force || lastStill.get(e.id) !== text) { lastStill.set(e.id, text); logArea('download', text); }
        keep.push(e);
    }
    if (keep.length !== before) { try { downloadState.setFollowUps(keep); } catch { /* ignored */ } }
    for (const row of rows) {
        if (row.notInstalled || !row.installedVersion) continue;
        const key = id(row), seen = String(row.installedVersion), prev = lastInstalled.get(key);
        lastInstalled.set(key, seen);
        if (prev !== undefined && prev !== seen && !list.some((e) => e.id === key)) logArea('download', `${key}: now installed as ${seen} (was ${prev})`);
    }
}

// `forget` is what a restart does to this run's memory (the saved list stays); `forgetSaved` also empties the saved list (tests).
function forget() { skippedBefore.clear(); lastInstalled.clear(); lastStill.clear(); }
function forgetSaved() { forget(); try { downloadState.setFollowUps([]); } catch { /* ignored */ } }

module.exports = { started, saved, failed, incomplete, skipped, noteChecked, plainReason, sourceWords, HOWS, forget, forgetSaved, FOLLOW_UP_DAYS, FOLLOW_UP_MAX };
