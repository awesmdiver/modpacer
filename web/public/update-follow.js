'use strict';
// The page's rules for "Update all" (queue: update-all-follows-along-and-deploys-at-the-end, 2026-10-04), free of any page code
// so tests/test-update-follow.js can check them in Node. A plain script in the browser (sets window.updateFollow), a module in Node.
(function (root) {
    // Which row to bring into view: the one updating right now, or null when none is (or it isn't in the list).
    // `following` is false once the player has scrolled away on their own: that stays false until the next Update all.
    function followTarget({ updatingId, rowIds, following }) {
        if (!following || !updatingId) return null;
        return (rowIds || []).includes(updatingId) ? updatingId : null;
    }

    // The player scrolling (wheel, touch, keys) while a batch runs turns following off for the rest of that batch.
    function nextFollowing(following, playerScrolled) {
        return following && !playerScrolled;
    }

    // How to scroll: centred (room above and below), smooth unless the player asked for reduced motion.
    function scrollOptions(reducedMotion) {
        return { block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' };
    }

    // What the "waiting to deploy" area shows. -> 'none' | 'line' | 'banner-clean' | 'banner-partial'
    //   inFlight: an Update all or a single update is running; pendingCount: mods waiting to be deployed;
    //   outcome: { attempted, updated } of the last finished Update all (null if none / already used); dismissed: "Not yet" pressed;
    //   mo2: Mod Organizer 2 has no deploy step; deployBusy: the Deploy pop-up is open.
    //   rows: the page's current rows. The banner is decided from the SAME row states the list shows, so it can never disagree with it:
    //   'banner-clean' only when every mod in the batch ended cleanly; 'banner-problem' when a mod installed but with a problem (a
    //   "Try again" / "didn't carry over" row); 'banner-partial' when some mods simply did not update.
    function batchHealth(outcome, rows) {
        const ids = outcome && Array.isArray(outcome.ids) ? outcome.ids : null;
        if (!ids) return outcome && outcome.updated >= outcome.attempted ? 'clean' : 'failed'; // an outcome with no mod list: counts only
        const byId = new Map((rows || []).map((r) => [r.id, r]));
        let failed = false;
        const skipped = new Set(Array.isArray(outcome.skippedIds) ? outcome.skippedIds : []); // FOMOD mods the player skipped: they need a look
        for (const id of ids) {
            const row = byId.get(id);
            const done = !!row && (row.status === 'updated' || row.status === 'deployed');
            if (done && (row.carryOver || row.error)) return 'problem';
            if (!done) failed = true;
        }
        if (skipped.size > 0) return 'problem';
        return failed ? 'failed' : 'clean';
    }
    // A mod updated or installed in this run that is not completely finished: its rules not confirmed (didn't carry over / couldn't be checked) or its old copy still there.
    // While any exists the Deploy offer is not shown at all.
    function hasUnfinished(rows) {
        return (rows || []).some((r) => !!r && (!!r.carryOver || !!r.oldCopyLeft));
    }
    function deployArea({ inFlight, pendingCount, outcome, dismissed, mo2, deployBusy, rows, unfinished }) {
        if (inFlight || deployBusy || unfinished || !(pendingCount > 0)) return 'none';
        if (mo2 || !outcome || dismissed || !(outcome.updated > 0)) return 'line';
        const health = batchHealth(outcome, rows);
        return health === 'clean' ? 'banner-clean' : health === 'problem' ? 'banner-problem' : 'banner-partial';
    }

    // After the helper stopped answering mid-update: which mods to carry on with (queue: helper-not-answering-says-retry-and-finishes-the-update).
    //   leftover: { ids: [the one that was in flight first, then the rest, in order] } or null; rows: the page's current rows.
    // A mod that turns out to be already updated/deployed (it finished after all) or is gone is skipped, and no mod appears twice.
    function resumeIds(leftover, rows) {
        if (!leftover || !Array.isArray(leftover.ids)) return [];
        const byId = new Map((rows || []).map((r) => [r.id, r]));
        const seen = new Set();
        return leftover.ids.filter((id) => {
            if (seen.has(id)) return false;
            seen.add(id);
            const row = byId.get(id);
            return !!row && row.status !== 'updated' && row.status !== 'deployed';
        });
    }

    const api = { followTarget, nextFollowing, scrollOptions, deployArea, batchHealth, resumeIds, hasUnfinished };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.updateFollow = api;
})(typeof window !== 'undefined' ? window : globalThis);
