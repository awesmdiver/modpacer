'use strict';
// Remembers each plugin's last known Vortex-reported identity (version/source/Nexus id) across a
// moment when the Helper genuinely can't be reached (queue: helper-down-message-and-version-
// fallback, 2026-10-01). Real reported bug: when the Helper went unreachable, the Plugins tab
// silently fell back to showing the plugin's OWN inner manifest version as if it were just as
// good -- which it isn't (confirmed real: OStimNet showed 2.5.0, Lover's Ledger showed 1.0.2, both
// stale inner-manifest numbers, while Vortex itself genuinely has 2.5.2/1.1.0 recorded). The fix:
// once Vortex has ever spoken for a plugin, trust that -- live if reachable, remembered if not --
// and never silently fall back to the manifest for that plugin again, even temporarily.
//
// A separate file from download-state.js's own state.json -- a different KIND of remembered fact
// (what Vortex itself last reported, not what this app already downloaded) -- so neither can ever
// collide on the same top-level plugin-id keys.

const fs = require('fs');
const path = require('path');

const CACHE_FILE = require('./data-dir').dataPath('vortex-info-cache.json');

function loadAll() {
    try {
        const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch {
        return {};
    }
}

function saveAll(all) {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(all, null, 2), 'utf8');
}

// { vortexModId, version, source, nexusModId, rememberedAt } | null
function hasAny() { return Object.keys(loadAll()).length > 0; }

function get(pluginId) {
    return loadAll()[pluginId] || null;
}

// `paired`: the entry is a Hub listing recognised in Vortex by NAME (lib/vortex-name-match.js), not an installed SkyrimNet plugin: it is
// remembered the same way so a moment without Vortex does not send the mod back to "Mods not installed".
function record(pluginId, { vortexModId, version, source, nexusModId, paired }) {
    const all = loadAll();
    all[pluginId] = { vortexModId, version, source, nexusModId, ...(paired ? { paired: true } : {}), rememberedAt: new Date().toISOString() };
    saveAll(all);
}

// A name pairing that Vortex no longer shows (the mod was removed there): forgotten, so the listing goes back to "Mods not installed".
function forget(pluginId) {
    const all = loadAll();
    if (!(pluginId in all)) return;
    delete all[pluginId];
    saveAll(all);
}

module.exports = { get, record, forget, loadAll, hasAny, CACHE_FILE };
