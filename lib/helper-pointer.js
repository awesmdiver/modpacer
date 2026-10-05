'use strict';
// Records this app's own install folder into a fixed, OS-level location so the Vortex Collection
// Helper (a separate Vortex extension -- queue: "Vortex Bridge: start the SkyrimNet
// ModPacer when Vortex opens", 2026-09-30) can find it without the player ever typing a path
// anywhere. The helper has no other way to learn where this app lives: it can't read a path out of
// THIS app's own config.json, because it doesn't know where that file is either -- a fixed app-data
// location is the only thing that works without a chicken-and-egg problem. Written fresh on every
// run (interactive or --check) so it can't go stale if the player ever moves or reinstalls this app.

const fs = require('fs');
const path = require('path');

// null (not a relative-path guess) when APPDATA genuinely isn't set -- writeInstallPointer skips
// entirely in that case rather than ever writing somewhere unexpected, like the current working
// directory.
function pointerPath() {
    // MODPACER_DATA_DIR set (the test suite): the pointer lives in that folder, never in the real %APPDATA%.
    if (process.env.MODPACER_DATA_DIR) return path.join(process.env.MODPACER_DATA_DIR, 'install-info.json');
    if (!process.env.APPDATA) return null;
    return path.join(process.env.APPDATA, 'ModPacer', 'install-info.json');
}

// The Node.js that should start this app: the bundled runtime\node.exe beside server.js when the release
// shipped one (a player with no Node installed), otherwise the Node that is running this process right
// now. Recorded as `nodePath` so the Vortex Bridge's start hook can launch the updater without
// relying on `node` being on the PATH (queue: bundle-node-runtime, 2026-10-01).
function resolveNodePath(installPath) {
    const bundled = path.join(installPath, 'runtime', 'node.exe');
    return fs.existsSync(bundled) ? bundled : process.execPath;
}

// Never throws -- this is a courtesy write for an optional integration, not something that should
// ever be able to break a normal run of this app (e.g. no APPDATA env var at all, or a permissions
// problem on a locked-down machine).
const EXE_NAME = 'ModPacer.exe';

// The tray program beside server.js, when this install has one (the dev repo has none, so exePath is null there).
// The Helper starts THIS when the player presses "Open ModPacer" and the service isn't running.
function resolveExePath(installPath) {
    const exe = path.join(installPath, EXE_NAME);
    return fs.existsSync(exe) ? exe : null;
}

// A throwaway copy must never become the updater's recorded home (queue: install-pointer-ignores-terminal-copies,
// 2026-10-03): the pointer is rewritten on every start, so whichever copy ran last owns it, and a builder's test copy
// once took it over -- the Vortex Bridge then ran its check there, with no settings, every Vortex start.
// Not recorded: (a) a folder inside one named "terminals" (the board's terminal copies), (b) a git worktree (a .git
// FILE at its root), (c) a copy with no config.json of its own when the pointer already names a folder that has one
// (checked only when the data folder is the default one, i.e. MODPACER_DATA_DIR is unset).
function shouldRecordInstall(installPath, existing) {
    const norm = path.resolve(installPath);
    if (norm.split(path.sep).some((s) => s.toLowerCase() === 'terminals')) return false;
    try { if (fs.statSync(path.join(norm, '.git')).isFile()) return false; } catch { /* no .git at all: a normal install */ }
    if (!process.env.MODPACER_DATA_DIR && !fs.existsSync(path.join(norm, 'config.json'))) {
        const other = existing && typeof existing.installPath === 'string' ? existing.installPath : null;
        if (other && path.resolve(other) !== norm && fs.existsSync(path.join(other, 'config.json'))) return false;
    }
    return true;
}

function writeInstallPointer(installPath, port) {
    try {
        const target = pointerPath();
        if (!target) return;
        let existing = null;
        try { existing = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { /* none yet, or unreadable: nothing to protect */ }
        if (!shouldRecordInstall(installPath, existing)) return;
        const p = Number(port) || 47821;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify({
            installPath, nodePath: resolveNodePath(installPath),
            exePath: resolveExePath(installPath), port: p, url: `http://127.0.0.1:${p}/`,
            updatedAt: new Date().toISOString(),
        }));
    } catch {
        // Cosmetic/optional integration only -- never worth surfacing as a real startup failure.
    }
}

module.exports = { writeInstallPointer, shouldRecordInstall, pointerPath, resolveNodePath, resolveExePath, EXE_NAME };
