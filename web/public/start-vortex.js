'use strict';
// The "Start Vortex" flow (queue: ask-to-start-vortex, 2026-10-01), kept free of any page/DOM code
// so tests/test-start-vortex.js can drive it in Node with a fake screen. The page (app.js) supplies
// the real pieces. Loaded as a plain script in the browser (sets window.createStartVortexFlow) and
// as a module in Node.
//
// deps:
//   getStatus()  -> { needsStart, helperAnswering, canOpen }   (GET /api/vortex-status)
//   openVortex() -> launches Vortex                            (POST /api/open-vortex)
//   ui.showAsk({ canOpen }) -> Promise<'continue' | 'open' | 'cancel'>
//   ui.showWaiting()        -> Promise that resolves when Cancel is clicked while waiting
//   ui.showSlowNote(), ui.close()
//   sleep(ms), now()  (optional; real timers by default), pollMs, slowAfterMs
(function (root) {
    function createStartVortexFlow(deps) {
        const { getStatus, openVortex, ui } = deps;
        const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
        const now = deps.now || (() => Date.now());
        const pollMs = deps.pollMs != null ? deps.pollMs : 1500;
        const slowAfterMs = deps.slowAfterMs != null ? deps.slowAfterMs : 60000;
        let dismissed = false; // Cancel pressed: no more popups until a reload or Check now (rearm)
        let busy = false;

        // Resolves to: 'not-needed' (nothing to ask), 'skipped' (dismissed earlier / another popup is
        // up / already showing), 'started' (the Helper answered), or 'cancelled'.
        async function prompt({ rearm = false, blocked = false } = {}) {
            if (rearm) dismissed = false;
            if (dismissed || busy || blocked) return 'skipped';
            let status;
            try { status = await getStatus(); } catch { return 'not-needed'; }
            if (!status || !status.needsStart) return 'not-needed';

            busy = true;
            try {
                const choice = await ui.showAsk({ canOpen: !!status.canOpen });
                if (choice === 'cancel') { dismissed = true; ui.close(); return 'cancelled'; }
                if (choice === 'open') { try { await openVortex(); } catch { /* keep waiting; the player can open it by hand */ } }

                let cancelled = false;
                const waiting = ui.showWaiting();
                waiting.then(() => { cancelled = true; });
                const startedAt = now();
                let slowShown = false;
                while (!cancelled) {
                    await Promise.race([sleep(pollMs), waiting]);
                    if (cancelled) break;
                    let s;
                    try { s = await getStatus(); } catch { s = null; }
                    if (s && s.helperAnswering) { ui.close(); return 'started'; }
                    if (!slowShown && now() - startedAt >= slowAfterMs) { slowShown = true; ui.showSlowNote(); }
                }
                dismissed = true;
                ui.close();
                return 'cancelled';
            } finally {
                busy = false;
            }
        }

        return { prompt };
    }

    if (typeof module !== 'undefined' && module.exports) module.exports = { createStartVortexFlow };
    else root.createStartVortexFlow = createStartVortexFlow;
})(typeof window !== 'undefined' ? window : globalThis);
