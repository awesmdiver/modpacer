'use strict';
// The one version number: package.json's "version". Shown on the page (small, next to the title)
// and read by the release build script (release/build-release.ps1) -- never typed in a second place.

const pkg = require('../package.json');

module.exports = { APP_VERSION: pkg.version };
