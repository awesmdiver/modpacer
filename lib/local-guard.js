'use strict';
// Keeps other websites out of ModPacer's own local server (queue: lock-modpacer-s-own-local-server-against-other-websites, 2026-10-05).
// Binding to 127.0.0.1 does not stop a web page in the person's own browser from calling it, so every request is checked first:
//   1. Host must be exactly 127.0.0.1:<port> or localhost:<port> (blocks DNS rebinding: a foreign name pointed at 127.0.0.1).
//   2. An Origin header, when present, must be ModPacer's own page; Sec-Fetch-Site: cross-site is refused.
//   3. Anything that changes something (POST/PUT/PATCH/DELETE) must carry X-ModPacer: 1 -- a custom header cannot be sent cross-site
//      without a CORS preflight, and ModPacer never grants one -- and a request with a body must be application/json.
// The port is the one the connection actually arrived on, so it is right for any PORT and for tests that listen on port 0.
// No Access-Control-* header is ever sent anywhere.

const CUSTOM_HEADER = 'x-modpacer';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function refusal(req) {
    const port = req.socket && req.socket.localPort;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const host = String(req.headers.host || '').toLowerCase();
    if (!hosts.includes(host)) return { status: 403, error: 'ModPacer only answers its own page on this PC.', why: `foreign Host "${host}"` };

    const origin = req.headers.origin;
    if (origin !== undefined && !hosts.map((h) => `http://${h}`).includes(String(origin).toLowerCase())) {
        return { status: 403, error: 'ModPacer only answers its own page on this PC.', why: `foreign Origin "${origin}"` };
    }
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
        return { status: 403, error: 'ModPacer only answers its own page on this PC.', why: 'cross-site request' };
    }

    if (WRITE_METHODS.has(req.method)) {
        if (req.headers[CUSTOM_HEADER] !== '1') return { status: 403, error: 'ModPacer only answers its own page on this PC.', why: 'missing X-ModPacer header' };
        const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'] !== undefined;
        if (hasBody && !/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) {
            return { status: 415, error: 'ModPacer only accepts JSON.', why: 'body is not application/json' };
        }
    }
    return null;
}

// log: one-line sink (never given the body).
function localGuard(log) {
    return (req, res, next) => {
        const r = refusal(req);
        if (!r) return next();
        try { if (log) log(`refused ${req.method} ${String(req.url).split('?')[0]}: ${r.why}`); } catch { /* the log is never a reason to fail */ }
        res.status(r.status).json({ error: r.error });
    };
}

module.exports = { localGuard, refusal };
