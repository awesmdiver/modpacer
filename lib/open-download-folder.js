'use strict';
// Opens Windows Explorer AT the player's own configured download folder -- replaces the earlier
// per-row "Show in folder" link (queue: open-download-folder-button, 2026-09-30; director, from a
// live screenshot: it rendered in the browser's own default blue/underlined link style, not the
// theme, and said the same thing on every single downloaded row once several updates shared one
// folder). One button, next to Check now, opens the whole folder instead.
//
// No path-safety check needed the way the old per-file version (`isInsideFolder`) needed one: this
// always opens EXACTLY the player's own configured download folder, read straight from config by
// the caller -- never an arbitrary path.

const { spawn } = require('child_process');
const platform = require('./platform');

function openDownloadFolder(folderPath) {
    if (!folderPath) throw new Error('No download folder set yet.');
    spawn('explorer.exe', [folderPath], { windowsHide: false });
}

module.exports = { openDownloadFolder };
