'use strict';
// First-run setup (queue: first-run-setup-steps, 2026-10-03): the rules behind the step-by-step pop-up that opens
// when the updater isn't set up yet. Pure decisions over the saved settings -- the page (web/public/setup.js) draws
// the steps, server.js serves these answers.
//
// Setup is COMPLETE when a mod manager is chosen, the Skyrim folder really holds SkyrimSE.exe, a downloads folder is
// saved, and no unfinished setup is saved. The saved key is `setupStep` in config.json: the step the player reached
// (1-based) while setup was still unfinished; cleared the moment the final check is done. Someone already set up
// has no `setupStep`, so they never see the pop-up.

const fs = require('fs');
const path = require('path');
const { looksLikeSkyrimFolder } = require('./skyrim-detect');

const VORTEX_STEPS = ['Mod manager', 'Skyrim', 'Folders', 'Options', 'Bridge', 'Check'];
const MO2_STEPS = ['Mod manager', 'Skyrim', 'Folders', 'Options', 'Check'];

// Not chosen yet counts as Vortex (the longer list), same as the rest of the app.
function stepNames(manager) {
    return manager === 'mo2' ? MO2_STEPS : VORTEX_STEPS;
}

// 'empty' (nothing chosen) | 'wrong' (a folder, but no SkyrimSE.exe in it) | 'found'
function skyrimState(p) {
    if (!p || typeof p !== 'string') return 'empty';
    return looksLikeSkyrimFolder(p) ? 'found' : 'wrong';
}

function isFolder(p) {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function sameFolder(a, b) {
    if (!a || !b) return false;
    return path.resolve(a).replace(/[\\/]+$/, '').toLowerCase() === path.resolve(b).replace(/[\\/]+$/, '').toLowerCase();
}

// Why a folder can't be used, or null when it can. kind: 'downloads' | 'mods'. The mods (staging) folder must never be
// the Skyrim folder or its Data folder.
function folderProblem(p, kind, skyrimPath) {
    if (!p || typeof p !== 'string') return 'empty';
    if (!isFolder(p)) return 'missing';
    if (kind === 'mods') {
        if (looksLikeSkyrimFolder(p) || sameFolder(p, skyrimPath)) return 'skyrim-folder';
        if (path.basename(path.resolve(p)).toLowerCase() === 'data' && (looksLikeSkyrimFolder(path.dirname(path.resolve(p))) || sameFolder(path.dirname(path.resolve(p)), skyrimPath))) return 'data-folder';
    }
    return null;
}

// The three things the rule asks for, plus the setting that says the pop-up was left unfinished.
function configOk(cfg) {
    const manager = cfg && (cfg.modManager === 'vortex' || cfg.modManager === 'mo2');
    return !!manager && skyrimState(cfg.skyrimInstallPath) === 'found' && !!cfg.downloadFolder;
}

function isSetupComplete(cfg) {
    return configOk(cfg) && !cfg.setupStep;
}

// The first step that isn't satisfied by what's saved. Options, Helper and Check have nothing to be unsatisfied, so
// everything saved means the last step.
function firstUnsatisfiedStep(cfg) {
    if (!(cfg.modManager === 'vortex' || cfg.modManager === 'mo2')) return 1;
    if (skyrimState(cfg.skyrimInstallPath) !== 'found') return 2;
    if (!cfg.downloadFolder || !cfg.vortexStagingFolder) return 3;
    return stepNames(cfg.modManager).length;
}

// The step the pop-up reopens at: the one the player reached, but never past a step whose answer is missing.
// null when setup is complete.
function nextStep(cfg) {
    if (isSetupComplete(cfg)) return null;
    const first = firstUnsatisfiedStep(cfg);
    if (Number.isInteger(cfg.setupStep) && cfg.setupStep >= 1) return Math.min(cfg.setupStep, first);
    return first;
}

// What the page needs to know. `started` = the pop-up has been used before (progress saved) -- the page then shows the
// "Finish setup" line instead of opening the pop-up by itself.
function setupSummary(cfg) {
    const complete = isSetupComplete(cfg);
    const total = stepNames(cfg.modManager).length;
    return {
        complete,
        step: complete ? null : nextStep(cfg),
        total,
        started: !complete && Number.isInteger(cfg.setupStep) && cfg.setupStep >= 1,
        manager: cfg.modManager === 'vortex' || cfg.modManager === 'mo2' ? cfg.modManager : null,
    };
}

module.exports = { VORTEX_STEPS, MO2_STEPS, stepNames, skyrimState, folderProblem, configOk, isSetupComplete, nextStep, setupSummary };
