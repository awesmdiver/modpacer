'use strict';
// lib/platform.js as the WINDOWS package has it (release/platform-build.js copies this file over lib/platform.js while staging).
// The Windows package never asks which system it is on: there is only one answer.

const current = () => 'win32';
const isWindows = () => true;

module.exports = { current, isWindows };
