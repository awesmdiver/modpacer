'use strict';
// Joins path pieces the way the file system will read them. Windows folders ignore letter case already, so there it is plain path.join.
// Reading only, never creates anything.

const fs = require('fs');
const path = require('path');
const platform = require('./platform');

function joinCI(base, ...parts) {
    if (platform.isWindows()) return path.join(base, ...parts);
}

module.exports = { joinCI };
