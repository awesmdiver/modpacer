'use strict';
// The one real Vortex deploy (queue: deploy-really-deploys-with-live-progress, 2026-10-04). Ported from Vortex Collection Tools'
// web/deploy-routes.js + web/public/deploy-panel.js: fire Vortex's full deploy (helperClient.deployAllMods) and poll what the Helper
// really reports (getDeployAllProgress) until it ends. There is no lighter, single-mod deploy: Vortex itself redeploys everything
// whenever anything changes, and a single-mod deploy left Vortex's own "deploy needed" flag set.
//
// ONE deploy at a time app-wide (a second start gets { busy: true }). In memory only; the page polls snapshot().
//
// The ending is never assumed:
//   confirmed     the deploy ran to its end with no error and Vortex does not say it still needs one
//   still_needed  the deploy ran, but Vortex still says a deploy is needed (the Helper's `needToDeploy` fact)
//   failed        Vortex or the Helper reported an error (a rule cycle gets its own message and code)
//   not_confirmed the Helper stopped answering, so nobody can say how it ended
// A deploy that is only waiting on a Vortex dialog (External Changes ...) is NOT stuck and is never timed out for it: the Helper
// reports the dialog by name, the elapsed time keeps counting, and the deploy carries on once the person has answered.
//
// `needToDeploy`: the Bridge's progress read has carried it since v0.23.3 (true / false, or null when Vortex cannot say). `needToDeploy: true` after the
// deploy turns the result amber (still_needed). Against an older Bridge, or when Vortex cannot say (the field is missing or not a boolean), an error-free deploy that
// ran to its end counts as confirmed.

const helperClient = require('./vortex-helper-client');
const updateProgress = require('./update-progress');
const { logUpdate } = require('./update-log');

const DEPLOY_BLOCKED_BY_CYCLES_CODE = 'deploy-blocked-by-cycles';
const DEPLOY_BLOCKED_BY_CYCLES_MESSAGE = "Deployment failed. Vortex couldn't deploy your mods because a rule cycle was detected. Resolve the cycle in Vortex, then deploy again.";

// Tunable so tests need not wait minutes. staleAnsweredMs: the deploy call is still open but nothing has answered for this long;
// settledGraceMs: the deploy call already ended (not ok) and the Helper still gives no clear ending; neverStartedMs: the call
// failed and the Helper never showed a deploy running (nothing started).
// readyWaitMs: how long starting the deploy is patient when Vortex is not answering yet (just after an install, while it scans plugins, during a
// deploy: the Bridge is silent while Vortex is busy), checked quickly at first, then every few seconds (readyPollsMs, the last one repeats);
// recheckMs: before a RE-send, the progress read must answer "nothing is running" twice this far apart (a deploy is never started twice).
const WAITING_TEXT = 'Waiting for Vortex to be ready\u2026';
const timing = { readyWaitMs: 3 * 60 * 1000, readyPollsMs: [500, 1000, 2000, 3000, 5000], recheckMs: 1000, firstPollMs: 1000, pollMs: 1000, pollMaxMs: 15000, staleAnsweredMs: 5 * 60 * 1000, settledGraceMs: 2 * 60 * 1000, neverStartedMs: 5000, verifyTries: 3, verifyWaitMs: 1000 };

const SOFT_STATES = ['vortex_starting', 'vortex_running_helper_unreachable'];
let job = null; // null = nothing has run yet this session

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function snapshot() {
    if (!job) return { state: 'idle' };
    const out = {
        state: job.running ? 'running' : 'done', startedAt: job.startedAt, elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
        text: job.text, percent: job.percent, blockedBy: job.blockedBy,
    };
    if (!job.running) { out.outcome = job.outcome; out.error = job.error || null; out.code = job.code || null; }
    return out;
}

function isRunning() { return !!job && job.running; }

function finish(outcome, extra) {
    Object.assign(job, { running: false, outcome, finishedAt: Date.now(), blockedBy: null }, extra || {});
}

// Starts the deploy in the background. Returns { started: true } | { busy: true } | { ok: false, reason }.
//   isConnected: async () => 'connected' | <why not>;  onConfirmed: called once, only for a confirmed deploy;
//   beforeDeploy: called once just before Vortex's deploy starts (never blocks it).
async function start({ isConnected, onConfirmed, beforeDeploy }) {
    if (isRunning()) return { busy: true };
    job = { running: true, startedAt: Date.now(), text: '', percent: null, blockedBy: null, outcome: null, error: null, code: null, finishedAt: null }; // set before any await: a second press can never slip past
    const state = isConnected ? await isConnected() : 'connected';
    // Not answering YET (Vortex still loading or busy) is waited out by the job itself; anything else (Vortex closed, the Bridge not installed,
    // Mod Organizer 2) is a real reason and stops here, as before.
    if (state !== 'connected' && !SOFT_STATES.includes(state)) { job = null; return { ok: false, reason: state }; }
    if (state !== 'connected') job.text = WAITING_TEXT;
    run(onConfirmed, beforeDeploy, isConnected).catch((e) => { if (job && job.running) finish('failed', { error: e && e.message ? e.message : 'The deploy stopped unexpectedly.' }); });
    return { started: true };
}

// Waits (bounded) until Vortex answers properly, saying so in the pop-up's status line. true = ready, false = gave up.
async function waitReady(isConnected, deadline) {
    if (!isConnected) return true;
    let i = 0;
    for (;;) {
        const s = await isConnected();
        if (s === 'connected') return true;
        if (Date.now() >= deadline) return false;
        job.text = WAITING_TEXT; job.percent = null; job.blockedBy = null;
        await sleep(timing.readyPollsMs[Math.min(i++, timing.readyPollsMs.length - 1)]);
    }
}

async function run(onConfirmed, beforeDeploy, isConnected) {
    const began = Date.now();
    if (!(await waitReady(isConnected, began + timing.readyWaitMs))) { logUpdate(`deploy start: Vortex not answering, gave up after ${Date.now() - began} ms`); return finish('not_answering'); }
    // The plugin-switching step keeps Vortex busy: after it, wait until Vortex answers again before the deploy is sent into that busy moment.
    if (beforeDeploy) {
        try { await beforeDeploy(); } catch { /* a helping step: the deploy goes ahead without it */ }
        const settleBegan = Date.now();
        if (!(await waitReady(isConnected, settleBegan + timing.readyWaitMs))) { logUpdate(`deploy start: Vortex not answering after the plugin step, gave up after ${Date.now() - settleBegan} ms`); return finish('not_answering'); }
    }
    const attemptsDeadline = Date.now() + timing.readyWaitMs;
    for (let attempt = 1; ; attempt++) {
        const r = await attemptDeploy(attempt, attemptsDeadline, onConfirmed);
        if (r !== 'retry') return r;
        job.text = WAITING_TEXT; job.percent = null; job.blockedBy = null;
        await sleep(timing.readyPollsMs[Math.min(attempt, timing.readyPollsMs.length) - 1]);
    }
}

// One go at starting the deploy and following it. Returns 'retry' only when the start never got through (Vortex not answering); every
// other ending finishes the job itself. The first send happens at once (nothing was sent before); a RE-send first has to see the progress
// read answer "nothing is running" twice, so a deploy Vortex already started is followed, never started a second time.
async function attemptDeploy(attempt, attemptsDeadline, onConfirmed) {
    const t0 = Date.now();
    const note = (how) => logUpdate(`deploy start: attempt ${attempt}, ${how}, ${Date.now() - t0} ms`);
    let sawActive = false; // the Helper's snapshot persists after a deploy: a "done" seen before THIS deploy was running is stale
    let settled = null; // { ok, at } once the full-deploy call has returned
    const p0 = attempt > 1 ? await helperClient.getDeployAllProgress() : null; // the first send goes at once (nothing was sent before; this app runs one deploy at a time)
    if (p0 && p0.active) { sawActive = true; note('a deploy is already running in Vortex, not sent again'); }
    else if (attempt > 1) {
        if (!p0) { if (Date.now() >= attemptsDeadline) { note('Vortex not answering, gave up'); return finish('not_answering'); } return 'retry'; }
        await sleep(timing.recheckMs);
        const p1 = await helperClient.getDeployAllProgress();
        if (!p1) { if (Date.now() >= attemptsDeadline) { note('Vortex not answering, gave up'); return finish('not_answering'); } return 'retry'; }
        if (p1.active) { sawActive = true; note('a deploy is already running in Vortex, not sent again'); }
    }
    if (!sawActive) {
        if (helperClient.clearLastDeployAllResult) helperClient.clearLastDeployAllResult();
        helperClient.deployAllMods().then((ok) => { settled = { ok: !!ok, at: Date.now() }; }, () => { settled = { ok: false, at: Date.now() }; });
    }
    const sentAt = Date.now();
    let lastAnswer = Date.now();
    let last = null;       // the newest snapshot the Helper answered
    let delay = timing.firstPollMs;
    let noted = sawActive;
    for (;;) {
        await sleep(delay);
        const t = Date.now();
        const p = await helperClient.getDeployAllProgress();
        if (p) {
            lastAnswer = Date.now(); last = p;
            if (p.active) sawActive = true;
            if (sawActive && !noted) { noted = true; note('started (Vortex reports it running)'); }
            job.text = typeof p.text === 'string' ? p.text : job.text;
            job.percent = typeof p.percent === 'number' && p.percent > 0 ? p.percent : null;
            job.blockedBy = updateProgress.blockedByFrom(p);
        } else {
            job.blockedBy = null;
        }
        delay = (!p || Date.now() - t > 3000) ? Math.min(delay * 2, timing.pollMaxMs) : timing.pollMs;

        if (settled && settled.ok) break;                                  // the call itself says it ran to its end
        if (p && p.done && sawActive) break;                               // seen running, now done (never trust a "done" from before)
        if (settled && !settled.ok && !sawActive && Date.now() - settled.at > timing.neverStartedMs) {
            // It never started. Not answering (timeout, refused, reset) is waited out and tried again; a real refusal (an answer with a reason) stops here.
            const detail = helperClient.lastDeployAllResult ? helperClient.lastDeployAllResult() : null;
            if (detail && detail.networkFailure) {
                if (Date.now() >= attemptsDeadline) { note('Vortex not answering, gave up'); return finish('not_answering'); }
                note('Vortex did not answer the start, will try again');
                return 'retry';
            }
            note(`refused${detail && detail.errorDetail ? `: ${detail.errorDetail}` : ''}`);
            return finish('failed', { error: (p && p.error) || (detail && detail.errorDetail) || null });
        }
        const quiet = Date.now() - (settled ? Math.max(lastAnswer, settled.at) : lastAnswer);
        if (!p && quiet > (settled ? timing.settledGraceMs : timing.staleAnsweredMs)) return finish('not_confirmed');
        // The start call is still open and nothing has shown a deploy running for the whole patience time: Vortex is not answering.
        if (!sawActive && !settled && !p && Date.now() - sentAt > timing.readyWaitMs) { note('no answer to the start, gave up'); return finish('not_answering'); }
    }

    if (!noted) note('started and finished');
    // It ended. Ask once more, fresh: the verdict (and any cycle) is read now, not from a snapshot taken mid-run.
    const fresh = (await helperClient.getDeployAllProgress()) || last || {};
    const error = fresh.error || (last && last.error) || null;
    if (error) return finish('failed', { error });
    if (fresh.deployBlockedByCycles || (last && last.deployBlockedByCycles)) return finish('failed', { error: DEPLOY_BLOCKED_BY_CYCLES_MESSAGE, code: DEPLOY_BLOCKED_BY_CYCLES_CODE });
    let needs = fresh.needToDeploy;
    for (let i = 0; needs === true && i < timing.verifyTries; i++) { // Vortex clears its own flag just after it finishes: look a few times before saying no
        await sleep(timing.verifyWaitMs);
        const again = await helperClient.getDeployAllProgress();
        if (again && typeof again.needToDeploy === 'boolean') needs = again.needToDeploy;
    }
    if (needs === true) return finish('still_needed');
    try { if (onConfirmed) await onConfirmed(); } catch { /* bookkeeping only: the deploy itself is confirmed */ }
    finish('confirmed');
}

function reset() { job = null; }

module.exports = { start, snapshot, isRunning, reset, timing, WAITING_TEXT, DEPLOY_BLOCKED_BY_CYCLES_CODE, DEPLOY_BLOCKED_BY_CYCLES_MESSAGE };
