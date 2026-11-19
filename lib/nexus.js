'use strict';
// Nexus API key validation + Premium-gated download -- adapted from vortex-collection-tools' own
// lib/nexus-mod-download.js / lib/nexus-collection-download.js (credited in TECHNICAL.md). Real
// differences from that project's version: no per-domain downloads-folder split (this app has one
// flat folder the player picked) and no pre-known md5 to verify against (VCT always has a
// collection curator's recorded hash to check a download against; this app has never seen the
// file before, so it trusts a successful download the same way VCT's own code already does for
// its one real "no known hash yet" case -- see downloadMod's own comment below).
//
// Same real policy Vortex itself enforces client-side: Nexus's API refuses to hand a free
// (non-Premium) account a direct download link at all ("nexusmods can't let users download files
// directly from client, without showing ads") -- this never attempts to work around that; a
// non-Premium account always gets a plain link instead (see plugin-updater-engine.js).

const https = require('https');
const { downloadToFile } = require('./download-file');

const APP_NAME = 'modpacer';
const { APP_VERSION } = require('./app-version'); // the one version number (package.json)

// Nexus's own file servers (the link comes from Nexus's API; a redirect elsewhere is refused).
const NEXUS_DOWNLOAD_HOSTS = ['*.nexusmods.com', '*.nexus-cdn.com'];

// What Nexus said, as one short plain line: its JSON "message", or the first line of a non-JSON body (never the whole body).
function nexusMessageOf(text) {
    let m = '';
    try { const j = JSON.parse(text); if (j && typeof j.message === 'string') m = j.message; } catch { m = String(text || '').split(/\r?\n/).find((l) => l.trim()) || ''; }
    return m.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
}

// Nexus's API says only "Mod not available: <id>" for a removed or hidden mod; it never says who removed it or why, so neither do we.
function plainNexusError(status, message) {
    if ((status === 403 || status === 404) && /^Mod not available/i.test(message)) return 'Nexus says this mod is not available. It may have been removed or hidden. Open its Nexus page to see why.';
    return message ? `Nexus said: ${message}` : `Nexus did not accept the request (HTTP ${status}).`;
}

function nexusRequest(apiPath, apiKey) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.nexusmods.com', path: apiPath, method: 'GET',
            headers: { apikey: apiKey, 'Application-Name': APP_NAME, 'Application-Version': APP_VERSION },
        }, (res) => {
            const chunks = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode !== 200) {
                    require('./update-log').logRequestFailure('api.nexusmods.com', `HTTP ${res.statusCode}`); // host and status only
                    const nexusMessage = nexusMessageOf(text);
                    const err = new Error(res.statusCode === 401
                        ? "That Nexus API key doesn't look valid."
                        : plainNexusError(res.statusCode, nexusMessage));
                    err.statusCode = res.statusCode;
                    err.nexusMessage = nexusMessage;
                    return reject(err);
                }
                try {
                    resolve(JSON.parse(text));
                } catch (e) {
                    reject(new Error(`Nexus returned unparseable JSON: ${e.message}`));
                }
            });
        });
        req.on('error', (e) => { require('./update-log').logRequestFailure('api.nexusmods.com', `no answer (${e && e.code ? e.code : 'network error'})`); reject(e); });
        req.end();
    });
}

// GET /v1/users/validate.json -- the same real endpoint Vortex itself uses to know isPremium.
async function checkApiKey(apiKey) {
    const data = await nexusRequest('/v1/users/validate.json', apiKey);
    return { isPremium: !!data.is_premium, name: data.name };
}

// Parses a Nexus mod page URL into {gameDomain, modId}, or null if unrecognized.
function parseNexusUrl(url) {
    const m = /^https?:\/\/(?:www\.)?nexusmods\.com\/([a-z0-9]+)\/mods\/(\d+)/i.exec(url || '');
    if (!m) return null;
    return { gameDomain: m[1], modId: Number(m[2]) };
}

// The mod's "MAIN" category file, newest first -- the file a player would get by just clicking
// the big Download button on the mod page. Falls back to the newest file of ANY category if the
// mod has no file explicitly marked MAIN (seen on a few real, simple one-file mods).
async function resolveMainFile(apiKey, gameDomain, modId) {
    const data = await nexusRequest(`/v1/games/${encodeURIComponent(gameDomain)}/mods/${modId}/files.json`, apiKey);
    const files = data.files || [];
    const byNewest = (a, b) => (b.uploaded_timestamp || 0) - (a.uploaded_timestamp || 0);
    const mainFiles = files.filter((f) => f.category_name === 'MAIN').sort(byNewest);
    if (mainFiles.length > 0) return mainFiles[0];
    const anyFiles = [...files].sort(byNewest);
    return anyFiles[0] || null;
}

async function resolveDownloadLink(apiKey, gameDomain, modId, fileId) {
    const data = await nexusRequest(`/v1/games/${encodeURIComponent(gameDomain)}/mods/${modId}/files/${fileId}/download_link.json`, apiKey);
    const first = (Array.isArray(data) ? data : [data])[0];
    const uri = first && (first.URI || first.uri);
    if (!uri) throw new Error('Nexus did not return a download URL for this file.');
    return uri;
}

// The mod's own details (GET /v1/games/<game>/mods/<id>.json): name, author, category_id, picture_url ... Used to give Vortex the details its own
// installer would have stored (see vortex-update.js nexusAttributes). Read only.
function getModInfo(apiKey, gameDomain, modId) {
    return nexusRequest(`/v1/games/${encodeURIComponent(gameDomain)}/mods/${modId}.json`, apiKey);
}

// The file of this mod that has this exact file name (the archive ModPacer installed), or null. Nexus's file id is what Vortex's identification hangs on.
async function findFileByName(apiKey, gameDomain, modId, fileName) {
    const data = await nexusRequest(`/v1/games/${encodeURIComponent(gameDomain)}/mods/${modId}/files.json`, apiKey);
    const want = String(fileName || '').toLowerCase();
    const hit = (data.files || []).filter((f) => String(f.file_name || '').toLowerCase() === want).sort((a, b) => (b.uploaded_timestamp || 0) - (a.uploaded_timestamp || 0))[0];
    return hit || null;
}

// Downloads the mod's current main file. Trusts the download once it completes -- there is no
// pre-known hash to check it against (see header comment); `fileName` is Nexus's own real
// uploaded name (files.json's `file_name`), so the saved file always matches what Nexus itself
// calls it.
async function downloadMod({ apiKey, gameDomain, modId, destDir, onProgress }) {
    const file = await resolveMainFile(apiKey, gameDomain, modId);
    if (!file) throw new Error('This Nexus mod has no downloadable files.');
    const url = await resolveDownloadLink(apiKey, gameDomain, modId, file.file_id);
    const fs = require('fs');
    const path = require('path');
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, file.file_name);
    const result = await downloadToFile(url, destPath, { onProgress, allowedHosts: NEXUS_DOWNLOAD_HOSTS });
    return { archivePath: destPath, fileName: file.file_name, version: file.version, bytes: result.bytes };
}

module.exports = { plainNexusError, nexusMessageOf, checkApiKey, parseNexusUrl, resolveMainFile, resolveDownloadLink, downloadMod, getModInfo, findFileByName };
