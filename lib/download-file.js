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

function downloadToFile(url, destPath, { headers, onProgress, onHeaders, timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
        const failWithCleanup = (err) => {
            fs.rm(destPath, { force: true }, () => reject(err)); // best-effort; the original error is what matters, not whether cleanup itself succeeded
        };
        const doGet = (u, redirectsLeft) => {
            const req = https.get(u, { headers }, (res) => {
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    if (redirectsLeft <= 0) return failWithCleanup(new Error('Too many redirects.'));
                    res.resume();
                    doGet(res.headers.location, redirectsLeft - 1);
                    return;
                }
                if (res.statusCode !== 200) {
                    const chunks = [];
                    res.on('data', (d) => chunks.push(d));
                    res.on('end', () => failWithCleanup(new Error(`Download failed: HTTP ${res.statusCode}\n${Buffer.concat(chunks).toString('utf8').slice(0, 500)}`)));
                    return;
                }
                if (onHeaders) onHeaders(res.headers);
                const total = Number(res.headers['content-length']) || null;
                let received = 0;
                res.on('data', (d) => {
                    received += d.length;
                    if (onProgress) onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : null });
                });
                const file = fs.createWriteStream(destPath);
                res.pipe(file);
                file.on('finish', () => {
                    file.close(() => {
                        if (!res.complete) failWithCleanup(new Error(`Response ended prematurely -- received ${received} bytes.`));
                        else resolve({ bytes: received, headers: res.headers });
                    });
                });
                file.on('error', failWithCleanup);
                res.on('aborted', () => failWithCleanup(new Error(`Response aborted after ${received} bytes.`)));
            });
            req.on('error', failWithCleanup);
            req.setTimeout(timeoutMs, () => req.destroy(new Error(`Download from ${u} timed out after ${timeoutMs}ms.`)));
        };
        doGet(url, 5);
    });
}

module.exports = { downloadToFile };
