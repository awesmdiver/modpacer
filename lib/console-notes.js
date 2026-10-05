'use strict';
// The plain lines the black window shows while Vortex comes up (queue: vortex-ready-quiet-window,
// 2026-10-01). Told every connection state (after the start-up window is applied), it prints each of
// these ONCE per change, and nothing else -- no request paths, no mod or collection names:
//   Vortex is starting. Waiting for it to be ready...
//   Vortex is ready.
//   (only if it never gets ready) one sentence saying what to do.
// Quiet states (Vortex closed, MO2, helper not installed) print nothing here: the start-up line covers them.

const STARTING = 'Vortex is starting. Waiting for it to be ready…';
const READY = 'Vortex is ready.';
const STUCK = "Vortex is open, but the Vortex Bridge isn't answering. Vortex may be busy. Press Retry on the ModPacer page to try again.";

function createVortexConsoleNotes(print = (line) => console.log(line)) {
    let phase = 'idle'; // idle | starting | stuck | ready
    return function onState(state) {
        if (state === 'vortex_starting') {
            if (phase !== 'starting') { phase = 'starting'; print(STARTING); }
        } else if (state === 'vortex_running_helper_unreachable') {
            if (phase !== 'stuck') { phase = 'stuck'; print(STUCK); }
        } else if (state === 'connected') {
            if (phase === 'starting' || phase === 'stuck') print(READY);
            phase = 'ready';
        } else {
            phase = 'idle'; // closed / MO2 / not installed: nothing to say, and the next start-up starts fresh
        }
    };
}

module.exports = { createVortexConsoleNotes, STARTING, READY, STUCK };
