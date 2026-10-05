'use strict';
// The page's words about old downloads (queue: finish-by-checking-old-downloads-are-gone, 2026-10-04). Free of page code so a test can
// check them in Node. A plain script in the browser (sets window.oldDownloadNote), a module in Node.
(function (root) {
    // '' when there is nothing to say.
    function text({ cleaning, pending }) {
        if (cleaning) return 'Cleaning up old downloads...';
        if (pending > 0) return `${pending} old download${pending === 1 ? '' : 's'} still to remove. They'll be removed when Vortex answers.`;
        return '';
    }
    const api = { text };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.oldDownloadNote = api;
})(typeof window !== 'undefined' ? window : globalThis);
