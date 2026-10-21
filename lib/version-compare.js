'use strict';
// Compares two add-on version strings. Real Hub add-ons use any number of parts ("0.4.3.0") and sometimes a pre-release tail ("3.9.14-beta25"),
// so every numeric part is compared as a number, left to right, with a missing part counting as 0 ("1.2" = "1.2.0" = "1.2.0.0"; "0.10.1" is newer
// than "0.9.2"). A leading "v" is ignored. A pre-release tail ("-beta", "-rc1", "-alpha2") sorts BELOW the same numbers without one; two tails compare by
// their own numbers and names (alpha < beta < rc, beta2 > beta1). Build metadata after "+" is ignored. (semver.coerce kept only major.minor.patch, which
// called 0.4.3.1 and 0.4.3.0 the same, and 2.0.0-beta and 2.0.0 the same.)

const TAIL_RANK = { dev: 0, alpha: 1, a: 1, beta: 2, b: 2, pre: 2, preview: 2, rc: 3, c: 3 };
const NO_TAIL = /^(?:release|final|stable|ga)$/i;

// -> { nums: [..], tail: [tokens] } or null when the text has no numeric part at all.
function parse(text) {
    if (text === null || text === undefined) return null;
    const s = String(text).trim().replace(/\+.*$/, '');
    const m = /(\d+(?:\.\d+)*)(.*)$/.exec(s);
    if (!m) return null;
    const rest = m[2].replace(/^[\s\-_.]+/, '');
    const tokens = NO_TAIL.test(rest) ? [] : (rest.match(/\d+|[a-z]+/gi) || []).map((t) => (/^\d+$/.test(t) ? Number(t) : t.toLowerCase()));
    return { nums: m[1].split('.').map(Number), tail: tokens };
}

const cmpNum = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function cmpTail(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i], y = b[i];
        if (x === undefined) return y === 0 ? 0 : -1; // "beta" is below "beta1"
        if (y === undefined) return x === 0 ? 0 : 1;
        if (typeof x === 'number' && typeof y === 'number') { const c = cmpNum(x, y); if (c) return c; continue; }
        if (typeof x === 'number') return 1;
        if (typeof y === 'number') return -1;
        const rx = TAIL_RANK[x], ry = TAIL_RANK[y];
        const c = rx !== undefined && ry !== undefined ? cmpNum(rx, ry) : x < y ? -1 : x > y ? 1 : 0;
        if (c) return c;
    }
    return 0;
}
// -1 / 0 / 1 for a < b / a = b / a > b, or null when either has no numeric part.
function order(a, b) {
    const x = parse(a), y = parse(b);
    if (!x || !y) return null;
    for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
        const c = cmpNum(x.nums[i] || 0, y.nums[i] || 0);
        if (c) return c;
    }
    if (!x.tail.length && !y.tail.length) return 0;
    if (!x.tail.length) return 1;  // 2.0.0 is above 2.0.0-beta
    if (!y.tail.length) return -1;
    return cmpTail(x.tail, y.tail);
}

// Returns 'newer' (latest is higher than installed) | 'same' | 'older' | 'unknown' -- 'unknown' (never guessed) whenever either side has no numeric part.
function compareVersions(installed, latest) {
    const c = order(installed, latest);
    if (c === null) return 'unknown';
    return c < 0 ? 'newer' : c > 0 ? 'older' : 'same';
}

module.exports = { compareVersions };
