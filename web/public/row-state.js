'use strict';
// What a row says while it is queued / downloading / waiting on Vortex (queue: no-fake-downloading,
// 2026-10-01). Free of any page code so tests/test-no-fake-downloading.js can check the rules in Node.
// A plain script in the browser (sets window.rowState), a module in Node.
(function (root) {
    // null when the row is neither queued nor downloading. Otherwise { label, bar }: `bar` is a 0-100
    // number only when real bytes are arriving AND the real size is known -- never an empty bar.
    function inProgressView(row) {
        if (row.status === 'queued') return { label: 'Waiting to download…', bar: null };
        if (row.status === 'downloading') {
            const pct = row.downloadProgress && row.downloadProgress.percent != null ? row.downloadProgress.percent : null;
            return { label: pct != null ? `Downloading… ${pct}%` : 'Downloading…', bar: pct };
        }
        return null;
    }

    // The line under a downloaded row that can't be installed yet. While the player has the Start
    // Vortex popup waiting, the lines that are really just "Vortex isn't up yet" read "Waiting for
    // Vortex..." (the server says the same itself during Vortex's own start-up window).
    function waitingLine(reasonText, startedByPlayer) {
        if (startedByPlayer && /^Open Vortex to install\.$|answering/.test(reasonText)) return 'Waiting for Vortex…';
        return reasonText;
    }

    // The order of each group on the page (queue: mod-list-sorted-updated-first-then-newest, 2026-10-04).
    // Only keys that never change during a batch (release date, name, and the group itself) are used -- NOT the
    // status -- so rows hold still while "Update all" runs. 'updated' / 'deployed' ("Updated ✓") only exist in the
    // Up to date group, where they come first.
    function dateValue(row) {
        const t = row && row.releaseDate ? new Date(row.releaseDate).getTime() : NaN;
        return Number.isNaN(t) ? null : t;
    }
    function byName(a, b) {
        const x = String(a.title || a.id || '').toLowerCase();
        const y = String(b.title || b.id || '').toLowerCase();
        return x < y ? -1 : x > y ? 1 : 0;
    }
    function byNewestThenName(a, b) {
        const x = dateValue(a), y = dateValue(b);
        if (x !== y) {
            if (x === null) return 1;
            if (y === null) return -1;
            return y - x;
        }
        return byName(a, b);
    }
    function justUpdated(row) { return row.status === 'updated' || row.status === 'deployed'; }
    // When the updater updated this mod (a real recorded time), or null (an old saved state, or never recorded).
    function updatedValue(row) {
        const t = row && row.updatedAt ? new Date(row.updatedAt).getTime() : NaN;
        return Number.isNaN(t) ? null : t;
    }
    // group: 'updates' | 'needsYou' | 'upToDate' | 'notOnHub'. Returns a new array.
    function sortGroup(rows, group) {
        const copy = rows.slice();
        if (group === 'updates') return copy.sort(byNewestThenName);
        if (group === 'upToDate') {
            return copy.sort((a, b) => {
                const ua = justUpdated(a), ub = justUpdated(b);
                if (ua !== ub) return ua ? -1 : 1;
                if (ua && ub) {
                    // Updated mods: by the time they were updated, newest first; one with no recorded time falls back to its
                    // release date and sorts after every mod that has a real time.
                    const x = updatedValue(a), y = updatedValue(b);
                    if (x !== null && y !== null && x !== y) return y - x;
                    if ((x === null) !== (y === null)) return x === null ? 1 : -1;
                }
                return byNewestThenName(a, b);
            });
        }
        return copy.sort(byName);
    }

    const api = { inProgressView, waitingLine, sortGroup };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.rowState = api;
})(typeof window !== 'undefined' ? window : globalThis);
