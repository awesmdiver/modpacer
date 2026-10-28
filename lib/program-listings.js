'use strict';
// Hub listings that are programs, not mods (queue: programs-that-are-not-mods-get-a-download-page-link-only-never-an-install). The Hub has no field
// that says "program", so the list is ModPacer's own (program-listings.json: add an id there, no code change). A listed row never installs, updates or
// downloads anything; it only opens the listing's download page.
const fs = require('fs');
const path = require('path');

function load() {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'program-listings.json'), 'utf8'));
        return new Set((Array.isArray(raw.programs) ? raw.programs : []).filter((s) => typeof s === 'string').map((s) => s.trim().toLowerCase()));
    } catch { return new Set(); }
}
let ids = load();

function isProgram(entryOrId) {
    const id = typeof entryOrId === 'string' ? entryOrId : entryOrId && (entryOrId.plugin_id || entryOrId.id);
    return !!id && ids.has(String(id).toLowerCase());
}
function _setForTests(list) { ids = new Set(list.map((s) => s.toLowerCase())); }
function _reload() { ids = load(); }

// One short line on the row (draft wording; the design side sends it through a Gemini pass).
const PROGRAM_LINE = 'A standalone program, not a mod. Download it from its page and set it up yourself.';

module.exports = { isProgram, PROGRAM_LINE, _setForTests, _reload };
