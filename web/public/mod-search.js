'use strict';
// The search box on the Sort by line: which mods match what the person typed.
// Every typed word must appear somewhere in the mod's title, author and tagline, in any order; case, punctuation and extra spaces are ignored.
// A plain script in the browser (sets window.modSearch), a module in Node so a test can check it.
(function (root) {
    function words(text) {
        return String(text == null ? '' : text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(Boolean);
    }
    function matches(row, terms) {
        if (!terms || terms.length === 0) return true;
        const hay = ` ${words(`${row.title || ''} ${row.author || ''} ${row.tagline || ''}`).join(' ')} `;
        return terms.every((t) => hay.includes(t));
    }
    const api = { words, matches, filter: (rows, terms) => (terms && terms.length ? rows.filter((r) => matches(r, terms)) : rows) };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.modSearch = api;
})(typeof window !== 'undefined' ? window : globalThis);
