'use strict';
// Compares two plugin version strings. Real manifest `version` fields seen (director's install +
// the live Hub catalog, 2026-09-30) are already clean semver ("3.9.14", "0.11.1", "2.5.3") -- the
// "-beta25" style suffix the task warned about only showed up in a catalog entry's `external_url`
// git TAG (e.g. "v3.9.14-beta25"), never in a manifest's own `version` field in any real example
// found. `semver.coerce` still handles a version field that DOES carry a suffix/prefix
// (leading "v", a trailing qualifier) by pulling out the first real major.minor.patch it finds.

const semver = require('semver');

// Returns 'newer' | 'same' | 'older' | 'unknown' -- 'unknown' (never guessed) whenever either
// side can't be interpreted as a real version at all, per the task's own "if versions can't be
// compared, say so rather than guessing."
function compareVersions(installed, latest) {
    const a = semver.coerce(installed);
    const b = semver.coerce(latest);
    if (!a || !b) return 'unknown';
    if (semver.gt(b, a)) return 'newer';
    if (semver.lt(b, a)) return 'older';
    return 'same';
}

module.exports = { compareVersions };
