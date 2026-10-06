'use strict';
// The Nexus key's Check: a dot and one word (Verified / Failed), one short line under a Failed saying why. The SAME words and markup in the setup step and the Settings tab, so the two
// places look identical (queue: a-check-button-next-to-the-nexus-key-with-a-dot-and-verified-or-failed, 2026-10-05). The page sends the key as typed (or nothing, to check the saved
// one) to POST /api/settings/check-nexus-key; the answer carries only the result and a kind, never the key. Loaded as a plain script (window.nexusKeyCheck) and as a module in Node.
(function (root) {
    // Why a check failed, by the kind the server answers with (lib: server.js check-nexus-key).
    const REASONS = {
        rejected: "Nexus didn't accept that key.",
        unreachable: "Couldn't reach Nexus. Check your internet and try again.",
        busy: 'Nexus is busy. Try again in a minute.',
    };
    // Settings only: what that tab already said about Premium after a good check (nothing new added; the setup step says nothing about it).
    const PREMIUM_YES = 'Premium active.';
    const PREMIUM_NO = "This account doesn't have Premium. You'll get links to the Nexus page instead of automatic downloads.";

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // state: null/idle | { phase: 'checking' } | { phase: 'verified', premium } | { phase: 'failed', kind }
    // The area keeps a FIXED height (a dot line plus one small line) so nothing below it moves when the answer arrives.
    function statusHtml(state, opts) {
        const withPremium = !!(opts && opts.premium);
        const inline = !!(opts && opts.inline); // the setup step: one line, so it needs less room (a failure reads "Failed. <reason>" on the same line)
        let inner = '';
        const small = (t) => `<div class="muted" style="font-size:0.8rem;margin:2px 0 0 17px">${esc(t)}</div>`;
        if (state && state.phase === 'checking') inner = '<div class="su-status"><span class="su-dot info"></span><span>Checking&hellip;</span></div>';
        else if (state && state.phase === 'verified') {
            inner = '<div class="su-status"><span class="su-dot ok"></span><span>Verified</span></div>'
                + (withPremium ? small(state.premium ? PREMIUM_YES : PREMIUM_NO) : '');
        } else if (state && state.phase === 'failed') {
            inner = inline
                ? '<div class="su-status"><span class="su-dot err"></span><span>Failed. ' + esc(REASONS[state.kind] || REASONS.unreachable) + '</span></div>'
                : '<div class="su-status"><span class="su-dot err"></span><span>Failed</span></div>' + small(REASONS[state.kind] || REASONS.unreachable);
        }
        return `<div class="nexus-check-status" data-nexus-check-status style="height:${inline ? '1.9em' : '3.1em'};overflow:hidden">${inner}</div>`;
    }

    // Runs one check through `request(method, url, body)` (the page's api function, which throws an Error carrying `.kind` for a non-2xx answer).
    // `key`: the key as typed, or '' / null to check the saved one. Never throws; resolves with a state for statusHtml.
    async function run(request, key) {
        try {
            const result = await request('POST', '/api/settings/check-nexus-key', key ? { key } : {});
            return { phase: 'verified', premium: !!(result && result.isPremium) };
        } catch (e) {
            return { phase: 'failed', kind: e && REASONS[e.kind] ? e.kind : 'unreachable' };
        }
    }

    const api = { REASONS, PREMIUM_YES, PREMIUM_NO, statusHtml, run };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.nexusKeyCheck = api;
})(typeof window !== 'undefined' ? window : globalThis);
