'use strict';
// The one way ModPacer starts a program for its own work (queue: every-helper-program-modpacer-starts-runs-hidden-and-is-logged-by-name..., 2026-10-22).
//
// Why: ModPacer sits in the tray and its server runs with no window of its own. A console program started by a program with no window, without the "no window"
// flag, makes the system open a console window for it for a moment: a small window that flashes up and goes away too fast to read. So every program started here is
// hidden by default and gets no console to inherit. A call that MUST show a window (Explorer, launching Vortex, a folder chooser, the system's opener) says so with
// `visible: 'the reason in one line'`; a visible call without a reason is a mistake and throws. tests/test-run-hidden.js reads the source and fails if any
// child_process call in lib/ or server.js bypasses this file without such a reason, so a new call cannot bring the flash back.
//
// Every program started is written to update.log by NAME ONLY (no arguments, no paths, no user name), area [process], at most once a minute per name:
//   [process] started reg (hidden)
//   [process] started cmd.exe (visible: opens the page in the browser)
// so a flash can be lined up with a time in the log.

const cp = require('child_process');
const path = require('path');
const updateLog = require('./update-log');

const LOG_EVERY_MS = 60 * 1000;
const lastLogged = new Map(); // program name -> time of the last log line

function nameOf(exe) {
    const base = path.basename(String(exe || '')).trim();
    return base || 'unknown';
}

function note(exe, visible) {
    const name = nameOf(exe).toLowerCase();
    const now = Date.now();
    const key = `${name}|${visible ? 'v' : 'h'}`;
    if (now - (lastLogged.get(key) || 0) < LOG_EVERY_MS) return;
    lastLogged.set(key, now);
    try { updateLog.logArea('process', `started ${name} (${visible ? `visible: ${visible}` : 'hidden'})`); } catch { /* the log must never stop a program from starting */ }
}

// The options a call really gets: hidden unless a reason says otherwise, and no console inherited unless the caller chose its own stdio.
function withDefaults(opts, defaultStdio) {
    const { visible, ...rest } = opts || {};
    if (visible !== undefined && (typeof visible !== 'string' || !visible.trim())) throw new Error('A program that shows a window must say why: visible: "the reason".');
    const out = { ...rest };
    if (out.stdio === undefined) out.stdio = defaultStdio;
    out.windowsHide = !visible;
    return { options: out, visible: visible ? visible.trim() : null };
}

function spawn(exe, args, opts) {
    const { options, visible } = withDefaults(opts, 'ignore');
    note(exe, visible);
    return cp.spawn(exe, args || [], options);
}
function spawnSync(exe, args, opts) {
    const { options, visible } = withDefaults(opts, ['ignore', 'pipe', 'ignore']);
    note(exe, visible);
    return cp.spawnSync(exe, args || [], options);
}
function execFileSync(exe, args, opts) {
    const { options, visible } = withDefaults(opts, ['ignore', 'pipe', 'ignore']);
    note(exe, visible);
    return cp.execFileSync(exe, args || [], options);
}

function resetLogLimit() { lastLogged.clear(); } // for tests

module.exports = { spawn, spawnSync, execFileSync, nameOf, resetLogLimit };
