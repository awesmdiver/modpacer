'use strict';
// Single source of truth for this app's persisted, user-editable settings -- same "one JSON file
// next to the app, gitignored" convention as vortex-collection-tools' own lib/app-config.js.
// Never stores the Nexus API key anywhere else, and CONFIG_FILE itself is gitignored.

const fs = require('fs');
const path = require('path');

const { dataPath } = require('./data-dir');

const CONFIG_FILE = dataPath('config.json');

const DEFAULTS = {
    downloadFolder: null, // never a silent default -- the player picks this via Browse...
    skyrimInstallPath: null,
    vortexStagingFolder: null, // see TECHNICAL.md's "Finding the owning mod" -- needed to map a
    // deployed SkyrimNet plugin folder back to the Vortex mod that owns it; not in the mockup,
    // flagged as a deliberate addition in the handoff.
    // Which mod manager the player uses: 'vortex' | 'mo2' | null (not asked yet -- the page asks on
    // first run; until then the app behaves as it always did, i.e. like 'vortex', so an existing
    // install and the headless --check keep working). With 'mo2' the Vortex Helper is never contacted.
    modManager: null,
    nexusApiKey: null,
    autoDownload: true,
    checkOnVortexStart: true,
    // "Old versions" (Settings, queue: install-updates-like-vortex, 2026-10-01) -- off (keep)
    // by default, matching this app's own established "never delete anything without being
    // asked" stance elsewhere (the download folder itself, the Nexus key). On, the OLD archive +
    // its Vortex download record are removed, but only once a real Update has actually finished
    // installing and deploying the new version successfully.
    deleteOldDownloadAfterUpdate: false,
    // First-run setup (queue: first-run-setup-steps): the step the player reached while setup was still unfinished
    // (1-based). null = not in the middle of setup. Cleared when the final check is done. See lib/first-run-setup.js.
    setupStep: null,
    // "Mods not installed" (queue: mods-not-installed-section): adult (NSFW) Hub listings are not listed (or counted) unless this is on.
    // adultConfirmed: the player said "Yes, I am 18 or older" once on this PC, so turning the switch off and on again does not ask again.
    showAdultNotInstalled: false,
    adultConfirmed: false,
    // "Plugins page" (queue: plugin-hub-api-counts-and-the-official-catalog): tell fateless.ai when the person installs, updates or visits a Hub mod,
    // so its author's counts are right. On by default; off means no call is ever made. Sends only the mod's id (see lib/hub-api.js).
    tellHubOnInstall: true,
    // "Is this the same mod?" (queue: a-mod-already-in-vortex-is-recognised-even-when-its-name-differs): what the person answered when ModPacer
    // was not sure a Vortex mod and a Hub listing are one. [{ catalogId, vortexModId, vortexName, key, answer: 'yes' | 'no', answeredAt }].
    // `key` is the cleaned Vortex name (lib/vortex-name-match.js), so an answer still holds after an update renamed the mod's archive.
    modPairs: [],
};

function loadConfig() {
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        return { ...DEFAULTS, ...raw };
    } catch {
        return { ...DEFAULTS };
    }
}

function saveConfig(partial) {
    const current = loadConfig();
    const next = { ...current, ...partial };
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
    return next;
}

// For logging, and for the page itself -- never sends or logs the real key. `nexusApiKeyLast4`
// (queue: nexus-key-saved-status, 2026-10-01) is the one piece of the real key this ever exposes
// -- just enough for the Settings tab to show "Saved (ends ...a1b2)" without ever revealing or
// re-sending the saved key itself.
function redactConfig(cfg) {
    return {
        ...cfg,
        nexusApiKey: cfg.nexusApiKey ? '***REDACTED***' : null,
        nexusApiKeyLast4: cfg.nexusApiKey ? cfg.nexusApiKey.slice(-4) : null,
    };
}

module.exports = { CONFIG_FILE, DEFAULTS, loadConfig, saveConfig, redactConfig };
