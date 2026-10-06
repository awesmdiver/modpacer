'use strict';
// ModPacer checks itself on the Plugin Hub like any other plugin (queue: modpacer-checks-itself-on-the-plugin-hub-like-any-other-plugin).
// ModPacer is listed on the Hub as `awesmdiver.modpacer`; its entry in the catalog the page already loads says which version is newest.
// This only READS that entry: no request of its own, no timer, and ModPacer never downloads or replaces itself.
// The listed version is what this reads, so it must be updated on the Hub at every release (design/release-checklist-*.md).

const { compareVersions } = require('./version-compare');

const OWN_PLUGIN_ID = 'awesmdiver.modpacer';

// Only a plain https link on github.com is offered (the same host rule the downloads use); anything else means "no link", never a bad one.
function githubLinkOrNull(u) {
    if (typeof u !== 'string') return null;
    try {
        const url = new URL(u.trim());
        const host = url.hostname.toLowerCase();
        return url.protocol === 'https:' && (host === 'github.com' || host === 'www.github.com') ? url.href : null;
    } catch { return null; }
}

// -> { available: { version, url } | null, reason: string | null }
// `reason` is set only when the check could not be made (entry missing, version unreadable): the caller logs it. Up to date, or a
// listing that is older than this copy, is a plain `available: null` with no reason: the green state is silence.
function inspectOwnListing(catalogPlugins, appVersion) {
    const entry = (Array.isArray(catalogPlugins) ? catalogPlugins : []).find((e) => e && e.plugin_id === OWN_PLUGIN_ID);
    if (!entry) return { available: null, reason: 'no listing found in the Plugin Hub catalog' };
    const listed = typeof entry.version === 'string' ? entry.version.trim() : '';
    const cmp = listed ? compareVersions(appVersion, listed) : 'unknown';
    if (cmp === 'unknown') return { available: null, reason: 'the listed version could not be read' };
    if (cmp !== 'newer') return { available: null, reason: null };
    return { available: { version: listed, url: githubLinkOrNull(entry.external_url) }, reason: null };
}

module.exports = { inspectOwnListing, githubLinkOrNull, OWN_PLUGIN_ID };
