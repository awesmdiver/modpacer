'use strict';
// The update log's story of a wait for a busy Vortex (queue: the-update-log-tells-the-whole-story-of-every-wait-for-a-busy-vortex). LOGGING ONLY: nothing here
// changes what is asked, when, or how often. One line when a wait begins, one per try, one when it ends; the reason for each failed ask comes from the notes
// lib/vortex-helper-client.js keeps (the detail of every request stays in logs/helper.log, never repeated here).
const updateLog = require('./update-log');
const helperClient = require('./vortex-helper-client');

const dur = (ms) => updateLog.formatDuration(ms);
const plural = (n, w) => `${n} ${n === 1 ? w : w === 'try' ? 'tries' : w + 's'}`;

function askText(label, note) {
    if (!note) return `${label} not asked`;
    return `${label} ${note.outcome}${note.attempts > 1 ? ` (${plural(note.attempts, 'attempt')})` : ''}${note.ok && note.ms > 1000 ? ` in ${dur(note.ms)}` : ''}`;
}

// Which ask failed and how: "ping /health timed out after 4 s (2 attempts), mod list not asked".
// `extra` = { listBackingOff, listEmpty } from the mod-list reader, for the cases where no ask was made this time.
function askedText(rawState, extra = {}) {
    const ping = helperClient.askNote('/health');
    const list = helperClient.askNote('/mods');
    const parts = [askText('ping /health', ping), askText('mod list', list)];
    let tail = '';
    if (list && list.pairing) tail = `; ${list.pairing}`;
    else if (!list && extra.listBackingOff) tail = '; the mod list is not asked again yet (a failed read is being waited out)';
    else if (!list && ping && ping.ok && rawState === 'vortex_starting') tail = '; Vortex answered the ping but its readiness answer from a moment ago was "not ready yet"';
    else if (extra.listEmpty) tail = '; the mod list came back empty (Vortex has not loaded its mods yet)';
    return `${parts.join(', ')}${tail}`;
}

function windowText(rawState, shownState) {
    if (rawState === 'vortex_running_helper_unreachable' && shownState === 'vortex_starting') return 'inside the start-up window';
    if (rawState === 'vortex_running_helper_unreachable') return 'past the start-up window';
    return '';
}

function runningText() {
    let running = null;
    try { running = helperClient.isVortexRunning(); } catch { /* the line still reads */ }
    return running === null ? 'unknown' : running ? 'yes' : 'no';
}

// The line that opens a wait.
function beginLine(rawState, shownState) {
    const w = windowText(rawState, shownState);
    return `Vortex is busy or starting: waiting begins; Vortex's own program is running: ${runningText()}; state: ${shownState || rawState}${w ? ` (${w})` : ''}`;
}

// "Vortex answered the mod list slowly": written once when a read that worked took longer than the limit (10 s by default).
function noteSlowList() {
    const n = helperClient.askNote('/mods');
    if (!n || !n.ok || n.ms <= helperClient.slowAskLimitMs()) return false;
    updateLog.logArea('vortex', `Vortex answered, the mod list took ${dur(n.ms)}${n.attempts > 1 ? ` (${plural(n.attempts, 'attempt')})` : ''}`);
    return true;
}

module.exports = { askedText, beginLine, noteSlowList, dur, plural };
