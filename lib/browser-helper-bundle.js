'use strict';
// The browser helper (an extension for the person's own browser) comes inside the ModPacer download as a plain folder, browser-helper\, beside server.js. The person loads
// that folder in their browser's Extensions page (developer mode); ModPacer never installs it and never writes into a browser's folders. This file only says where the folder is,
// whether this copy carries it, and which version it is (to tell a person whose loaded helper is older to press Reload). A dev checkout carries it too: it is a normal folder.

const fs = require('fs');
const path = require('path');

const FOLDER_NAME = 'browser-helper';
const REQUIRED = ['manifest.json', 'background.js', 'reader.js', 'popup.html', 'popup.js', 'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'icons/icon-128.png'];
// Overridable so a test can use a scratch folder.
function folder() { return process.env.BROWSER_HELPER_DIR || path.join(__dirname, '..', FOLDER_NAME); }
function isBundled() { try { return REQUIRED.every((f) => fs.statSync(path.join(folder(), f)).isFile()); } catch { return false; } }
function bundledVersion() {
    try { const v = JSON.parse(fs.readFileSync(path.join(folder(), 'manifest.json'), 'utf8')).version; return typeof v === 'string' && /^\d+(\.\d+){0,3}$/.test(v) ? v : null; } catch { return null; }
}
module.exports = { FOLDER_NAME, REQUIRED, folder, isBundled, bundledVersion };
