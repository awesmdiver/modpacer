'use strict';
// Which Skyrim the person has: Special Edition ('se', game file SkyrimSE.exe) or VR ('vr', game file SkyrimVR.exe).
// Vortex calls them the games `skyrimse` and `skyrimvr`. Kept free of other requires so any module can use it.

const fs = require('fs');
const path = require('path');

const EDITIONS = { se: { exe: 'SkyrimSE.exe', gameId: 'skyrimse' }, vr: { exe: 'SkyrimVR.exe', gameId: 'skyrimvr' } };
const GAME_IDS = ['skyrimse', 'skyrimvr'];

function hasFile(folder, name) {
    try { return fs.statSync(path.join(folder, name)).isFile(); } catch { return false; }
}

// A folder -> 'se' | 'vr' | null. Both exes in one folder: `prefer` (an edition) breaks the tie, else 'se'.
function editionOfFolder(folder, prefer) {
    if (!folder || typeof folder !== 'string') return null;
    const se = hasFile(folder, EDITIONS.se.exe);
    const vr = hasFile(folder, EDITIONS.vr.exe);
    if (se && vr) return prefer === 'vr' ? 'vr' : 'se';
    return se ? 'se' : vr ? 'vr' : null;
}

const gameIdOf = (edition) => (edition === 'vr' ? 'skyrimvr' : 'skyrimse');
const editionOfGameId = (gameId) => (gameId === 'skyrimvr' ? 'vr' : gameId === 'skyrimse' ? 'se' : null);

// The Vortex game id to ask the Bridge about: Vortex's active game as the Bridge last reported it when that is a Skyrim, else the
// edition found in the settings, else Special Edition. (cfg = the saved settings; reportedGameId = the Bridge's /health gameId.)
function gameIdFor(cfg, reportedGameId) {
    if (GAME_IDS.includes(reportedGameId)) return reportedGameId;
    const edition = (cfg && cfg.skyrimEdition) || editionOfFolder(cfg && cfg.skyrimInstallPath);
    return gameIdOf(edition);
}

module.exports = { EDITIONS, GAME_IDS, editionOfFolder, gameIdOf, editionOfGameId, gameIdFor };
