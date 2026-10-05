'use strict';
// Picks the singular or plural word for a count: 1 is singular, everything else (0 included) is plural.
// A plain script in the browser (sets window.plural), a module in Node so a test can check it.
(function (root) {
    function plural(n, one, many) { return n === 1 ? one : many; }
    if (typeof module !== 'undefined' && module.exports) module.exports = plural;
    else root.plural = plural;
})(typeof window !== 'undefined' ? window : globalThis);
