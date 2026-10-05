'use strict';
// Finds Vortex's own program on this PC and starts it (queue: ask-to-start-vortex, 2026-10-01) --
// only for the "Open Vortex for me" button. NEVER guesses a path: the only sources are the entries
// Vortex's own installer writes into Windows' uninstall list (an entry whose display name is exactly
// "Vortex", and its icon path, which is the installed Vortex.exe). A path that doesn't end in
// Vortex.exe or doesn't exist is rejected, so when nothing reliable turns up this returns null and
// the page leaves the button out.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const UNINSTALL_ROOTS = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

// `reg query ...` -> its text output; '' on any failure (no such key, not Windows). No shell.
function defaultRegQuery(args) {
    try {
        return execFileSync('reg', ['query', ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
        return '';
    }
}

// `reg query` prints a header line per key, then indented "Name    REG_SZ    value" lines.
function parseValues(output) {
    const blocks = [];
    let current = null;
    for (const raw of String(output).split(/\r?\n/)) {
        if (/^HKEY_/i.test(raw.trim())) { current = { key: raw.trim(), values: {} }; blocks.push(current); continue; }
        const m = /^\s+(\S.*?)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(raw);
        if (m && current) current.values[m[1]] = m[2].trim();
    }
    return blocks;
}

// '"E:\Vortex\Vortex.exe",0' or 'E:\Vortex\Vortex.exe,0' -> 'E:\Vortex\Vortex.exe'
function iconToPath(value) {
    if (!value) return null;
    let v = value.trim().replace(/,\s*-?\d+$/, '');
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    return v || null;
}

function findVortexExe({ regQuery = defaultRegQuery, exists = fs.existsSync } = {}) {
    for (const root of UNINSTALL_ROOTS) {
        // Every subkey with a value mentioning "Vortex" (a quick narrowing), then an exact check.
        for (const block of parseValues(regQuery([root, '/s', '/f', 'Vortex', '/d']))) {
            if (block.values.DisplayName !== 'Vortex') continue;
            const iconBlocks = parseValues(regQuery([block.key, '/v', 'DisplayIcon']));
            const icon = iconBlocks.length ? iconToPath(iconBlocks[0].values.DisplayIcon) : null;
            if (icon && path.basename(icon).toLowerCase() === 'vortex.exe' && exists(icon)) return icon;
        }
    }
    return null;
}

// A few seconds of memory: the page asks every second or two while it waits for Vortex to come up.
let memo = null;
function findVortexExeCached(options) {
    if (memo && Date.now() - memo.at < 30_000) return memo.exe;
    const exe = findVortexExe(options);
    memo = { exe, at: Date.now() };
    return exe;
}

// Starts Vortex detached, so it outlives this app. Returns the path started, or null if none was found.
function openVortex({ exe = findVortexExeCached(), spawnFn = spawn } = {}) {
    if (!exe) return null;
    const child = spawnFn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
    if (child && child.unref) child.unref();
    return exe;
}

module.exports = { findVortexExe, findVortexExeCached, openVortex, parseValues, iconToPath };
