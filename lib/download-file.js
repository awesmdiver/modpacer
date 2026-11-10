'use strict';
// Generic HTTPS download-to-file with REAL progress (bytes received vs. the response's own
// content-length) -- shared by github.js and nexus.js. Modeled on vortex-collection-tools' own
// lib/nexus-collection-download.js downloadToFile (credited in TECHNICAL.md), extended with a
// real onProgress callback -- that original only ever exposed onHeaders, never a running byte
// count, which this app's own "Downloading... 62%" pill needs.
//
// Cleanup-on-failure (queue: no-duplicate-downloads, 2026-10-01) -- the real root cause behind a
// stray partial file ever looking "already downloaded" on a later run: this writes straight to
// destPath (no temp-file-then-rename), so ANY failure mid-download used to leave whatever bytes
// had already landed sitting right at the real destination, indistinguishable from a genuinely
// finished file by existence alone. Every failure path now best-effort deletes destPath before
// rejecting, so a caller catching the rejection never finds debris left behind at all -- the ONLY
// way a file ends up at destPath going forward is a fully successful download.

const fs = require('fs');
const https = require('https');

const MAX_REDIRECTS = 5;

// 'github.com' matches that host only; '*.github.com' matches any sub-host (never the bare name).
function hostAllowed(host, allowedHosts) {
    if (!allowedHosts) return true;
    const h = String(host || '').toLowerCase();
    return allowedHosts.some((p) => {
        const pat = String(p).toLowerCase();
        return pat.startsWith('*.') ? h.endsWith(pat.slice(1)) && h.length > pat.length - 1 : h === pat;
    });
}

// Every hop (the first address and each redirect) must be https, and, when a list is given, on one of
// those hosts. Returns null when fine, else a short plain reason (never the address itself).
function refusal(u, allowedHosts) {
    let parsed;
    try { parsed = new URL(u); } catch { return 'The download address was not valid.'; }
    if (parsed.protocol !== 'https:') return 'The download was sent to an address that is not secure (not https), so ModPacer stopped.';
    if (!hostAllowed(parsed.hostname, allowedHosts)) return 'The download was sent to a website ModPacer does not expect for this download, so it stopped.';
    return null;
}

// The file is written as `<destPath>.part` and renamed to destPath only when the whole body arrived (and, when the caller knows the size,
// matches it), so a download that is cut off (a closed program, a dropped connection) never sits under its final name.
// expectedSize: the size the source promises (GitHub's asset size); null = only the server's own Content-Length is checked.
// A failed answer is one plain sentence by its code; nothing the website said ever reaches the screen (a 504 page used to show its HTML tags).
// The code and the start of the reply (tags removed) go to the update log only.
const BUSY_TEXT = "The download site didn't answer in time. Try again in a few minutes.";
const GONE_TEXT = 'The download site no longer has the file. The author may have taken it down.';
const REFUSED_TEXT = "The download site wouldn't let ModPacer download the file.";
function statusText(code) {
    if ([502, 503, 504, 429].includes(code)) return BUSY_TEXT;
    if (code === 404 || code === 410) return GONE_TEXT;
    if (code === 401 || code === 403) return REFUSED_TEXT;
    return `The download site couldn't send the file (error ${code}).`;
}
function statusError(code, body, retryAfter) {
    const err = new Error(statusText(code));
    err.statusCode = code;
    err.plainReason = code === 401 || code === 403 ? 'refused by the site' : `the site answered HTTP ${code}`;
    err.retryable = code === 502 || code === 503 || code === 504;
    const secs = Number(retryAfter);
    if (code === 429 && Number.isFinite(secs) && secs >= 0 && secs <= 30) { err.retryable = true; err.retryAfterMs = Math.round(secs * 1000); err.retryOnce = true; }
    try {
        const seen = String(body || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
        require('./update-log').logUpdate(`download: the site answered HTTP ${code}${seen ? ` (${seen})` : ''}`);
    } catch { /* logging never fails a download */ }
    return err;
}
const RETRY_WAITS_MS = [3000, 8000]; // a busy site (502, 503, 504) or a timeout is tried again up to two more times, quietly

function sleepOrStop(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) return reject(new Error('The download was stopped.'));
        const onAbort = () => { clearTimeout(timer); reject(new Error('The download was stopped.')); };
        const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
}

// signal: an AbortSignal; aborting it ends a wait between tries at once. retryWaitsMs: tests pass [0, 0].
async function downloadToFile(url, destPath, opts = {}) {
    const waits = Array.isArray(opts.retryWaitsMs) ? opts.retryWaitsMs : RETRY_WAITS_MS;
    let retried429 = false;
    for (let attempt = 0; ; attempt++) {
        try {
            return await downloadOnce(url, destPath, opts);
        } catch (e) {
            const busy = e && (e.retryable || e.timedOut);
            if (!busy || (opts.signal && opts.signal.aborted)) throw e;
            let wait;
            if (e.retryOnce) { if (retried429) throw e; retried429 = true; wait = e.retryAfterMs; }
            else if (attempt < waits.length) wait = waits[attempt];
            else throw e;
            await sleepOrStop(wait, opts.signal);
        }
    }
}

function downloadOnce(url, destPath, { headers, onProgress, onHeaders, timeoutMs = 30000, allowedHosts, expectedSize = null } = {}) {
    const partPath = destPath + '.part';
    return new Promise((resolve, reject) => {
        const failWithCleanup = (err) => {
            fs.rm(partPath, { force: true }, () => reject(err)); // best-effort; the original error is what matters, not whether cleanup itself succeeded
        };
        // Redirects are followed by hand and the Location is re-checked each time: the headers (a Nexus
        // key, if one is ever sent) only go to the hosts allowed, and an http: hop is a plain failure.
        const doGet = (u, redirectsLeft) => {
            const why = refusal(u, allowedHosts);
            if (why) return failWithCleanup(new Error(why));
            let req;
            try {
                req = https.get(u, { headers }, onResponse);
            } catch (e) {
                return failWithCleanup(e);
            }
            req.on('error', failWithCleanup);
            req.setTimeout(timeoutMs, () => { const te = new Error('The download took too long to answer.'); te.timedOut = true; req.destroy(te); });
            function onResponse(res) {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    if (redirectsLeft <= 0) return failWithCleanup(new Error('Too many redirects.'));
                    res.resume();
                    let next;
                    try { next = new URL(res.headers.location, u).href; } catch { return failWithCleanup(new Error('The download was sent to an address that was not valid.')); }
                    doGet(next, redirectsLeft - 1);
                    return;
                }
                if (res.statusCode !== 200) {
                    // Only the first 2,000 bytes of an error page are ever used: read that much, then drop the connection (a hostile site cannot make this read grow).
                    const chunks = [];
                    let got = 0, finished = false;
                    const finish = () => { if (finished) return; finished = true; failWithCleanup(statusError(res.statusCode, Buffer.concat(chunks).toString('utf8').slice(0, 2000), res.headers['retry-after'])); };
                    res.on('data', (d) => {
                        if (finished) return;
                        chunks.push(d); got += d.length;
                        if (got >= 2000) { finish(); res.destroy(); }
                    });
                    res.on('end', finish);
                    res.on('error', finish);
                    res.on('close', finish);
                    return;
                }
                if (onHeaders) onHeaders(res.headers);
                const total = Number(res.headers['content-length']) || null;
                let received = 0;
                res.on('data', (d) => {
                    received += d.length;
                    if (onProgress) onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : null });
                });
                const file = fs.createWriteStream(partPath);
                res.pipe(file);
                file.on('finish', () => {
                    file.close(() => {
                        if (!res.complete) failWithCleanup(new Error(`Response ended prematurely -- received ${received} bytes.`));
                        else if (total && received !== total) failWithCleanup(new Error(`Response ended prematurely -- received ${received} of ${total} bytes.`));
                        else if (expectedSize && received !== expectedSize) failWithCleanup(new Error(`Response ended prematurely -- received ${received} of the expected ${expectedSize} bytes.`));
                        else fs.rename(partPath, destPath, (e) => (e ? failWithCleanup(e) : resolve({ bytes: received, headers: res.headers })));
                    });
                });
                file.on('error', failWithCleanup);
                res.on('aborted', () => failWithCleanup(new Error(`Response aborted after ${received} bytes.`)));
            }
        };
        doGet(url, MAX_REDIRECTS);
    });
}

module.exports = { statusText, downloadToFile, hostAllowed, refusal };
