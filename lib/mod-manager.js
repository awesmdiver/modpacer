'use strict';
// Which mod manager the player uses (queue: ask-which-mod-manager, 2026-10-01) and what follows
// from it. 'mo2' means the Vortex Helper is never contacted at all; 'vortex' (or not chosen yet --
// null, an existing install that hasn't been asked) keeps every behavior this app always had.
//
// Also answers "is the Vortex Bridge INSTALLED" -- separate from "is it answering right
// now" (that's vortex-helper-client's checkHelperAvailable): a closed Vortex can't answer, but that
// says nothing about whether the extension is there.

const fs = require('fs');
const path = require('path');
const appConfig = require('./app-config');
const vortexInfoCache = require('./vortex-info-cache');

// The Helper's own repository -- the only page that exists for it today (no Nexus page, no public
// release yet; the repo itself is private right now). Swap this one constant when a real public
// download page exists.
const HELPER_DOWNLOAD_URL = 'https://github.com/awesmdiver/vortex-bridge';
const HELPER_FOLDER_NAME = 'vortex-bridge';
// The Vortex extension's old name ("Vortex Collection Helper"): its folder is only ever NOTICED, never removed or counted as the Bridge.
const OLD_HELPER_FOLDER_NAME = 'vortex-collection-helper';

function getModManager(cfg = appConfig.loadConfig()) {
    return cfg && (cfg.modManager === 'vortex' || cfg.modManager === 'mo2') ? cfg.modManager : null;
}
function isMo2(cfg) {
    return getModManager(cfg) === 'mo2';
}

// Vortex's own extensions folder. VORTEX_PLUGINS_DIR overrides it (tests, a relocated Vortex data
// folder). null when it can't be worked out at all.
function vortexPluginsDir() {
    if (process.env.VORTEX_PLUGINS_DIR) return process.env.VORTEX_PLUGINS_DIR;
    return process.env.APPDATA ? path.join(process.env.APPDATA, 'Vortex', 'plugins') : null;
}

// Vortex names an extension's folder from its name when it is dropped onto the Extensions page, so the Bridge's folder may be `vortex-bridge` or `Vortex Bridge` (2026-10-05,
// the director's PC). Names are compared ignoring case, spaces, hyphens and underscores; a folder whose own info.json says it is the Bridge counts too. Read only.
const squash = (t) => String(t || '').toLowerCase().replace(/[\s_-]+/g, '');
function folderIs(dir, entry, squashedName) {
    if (squash(entry) === squashedName) return true;
    try {
        const info = JSON.parse(fs.readFileSync(path.join(dir, entry, 'info.json'), 'utf8'));
        return squash(info && info.name) === squashedName;
    } catch { return false; }
}
function pluginsHave(squashedName) {
    const dir = vortexPluginsDir();
    if (!dir) return false;
    try { return fs.readdirSync(dir).some((n) => folderIs(dir, n, squashedName)); } catch { return false; }
}

// True if the Helper's folder sits under Vortex's plugins folder, OR it has ever answered here (a
// real answer is remembered by vortex-info-cache.js -- evidence it's installed even if Vortex keeps
// its extensions somewhere unusual). Never throws.
function isHelperInstalled() {
    try {
        if (pluginsHave(squash(HELPER_FOLDER_NAME))) return true;
    } catch { /* no such folder -- fall through */ }
    try {
        return Object.keys(vortexInfoCache.loadAll()).length > 0;
    } catch {
        return false;
    }
}

// True if the old "Vortex Collection Helper" folder is still in Vortex's plugins folder (the player removes it in Vortex > Extensions). Never throws.
function isOldHelperInstalled() {
    try {
        return pluginsHave(squash(OLD_HELPER_FOLDER_NAME));
    } catch { return false; }
}

module.exports = { getModManager, isMo2, isHelperInstalled, isOldHelperInstalled, OLD_HELPER_FOLDER_NAME, vortexPluginsDir, HELPER_DOWNLOAD_URL, HELPER_FOLDER_NAME };
