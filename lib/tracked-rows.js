'use strict';
// ModPacer 2.0, part 1: turns one saved tracked mod (lib/tracked-mods.js) plus what the mod manager says about it into the three honest states and a normal page row.
// Pure functions (no files, no network), so every rule is tested on its own.
//
// The three states (ChatGPT's review, taken; the director said yes, 2026-11-21):
//   read     a version was read and it can be compared with the installed one: an ordinary row (Update, or Up to date, or Not installed)
//   confirm  "Version needs confirmation": the version read is LOWER than the one saved, or of a different shape (a date against a counter), or cannot be compared at
//            all. Never discarded silently, never offered as an update; the person looks (Open page) and answers (I checked it)
//   cannot   "Can't read": no release, the link is dead, the release has no version. A warning line and no Update button
// "Never invent an order": a comparison that cannot be made is `confirm`, never a guess.
// A temporary failure (no connection, GitHub limiting requests) keeps the last result and adds one short line.

const { compareVersions } = require('./version-compare');

const HOUR = 60 * 60 * 1000;
const CHECK_EVERY_MS = 4 * HOUR; // a few hours between two looks at the same repository
const LOCAL_EVERY_MS = 2 * 60 * 1000;
const BACKOFF_FIRST_MS = 30 * 60 * 1000;
const BACKOFF_MAX_MS = 24 * HOUR;
const RATE_LIMIT_WAIT_MS = 15 * 60 * 1000;

// The first number of a version, for telling a counter (4.2) from a date (2026.11.17).
function firstNumber(v) { const m = /\d+/.exec(String(v || '')); return m ? Number(m[0]) : NaN; }
function sameScheme(a, b) {
    const x = firstNumber(a), y = firstNumber(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    return (x >= 1000) === (y >= 1000);
}

// The words on the page. (Quoted in the handoff for the Gemini pass.)
const WORDS = {
    noRelease: 'This repository has no releases yet.',
    gone: 'This link no longer works.',
    unreadable: "ModPacer couldn't read a version from the newest release.",
    temporary: "Couldn't read GitHub just now. ModPacer will try again.",
    needsConfirmation: 'Version needs confirmation',
    cannotRead: "Can't read the page",
    lower: (seen, have) => `GitHub now lists version ${seen}, lower than the ${have} you have. Please check it.`,
    noCompare: (seen, have) => `GitHub lists version ${seen}, which ModPacer can't compare with ${have}. Please check it.`,
    // a folder on this PC (ModPacer 2.0, part 2)
    folderMissing: "ModPacer can't find that folder.",
    folderUnreadable: "ModPacer can't read that folder.",
    folderRefused: "That folder belongs to ModPacer or your mod manager, so ModPacer isn't watching it.",
    noBuild: "ModPacer found no build in that folder that matches the file name.",
    variantMissing: 'ModPacer found no build of that variant in the folder.',
    folderLower: (seen, have) => `The newest build in the folder is version ${seen}, lower than the ${have} you have. Please check it.`,
    folderNoCompare: (seen, have) => `The newest build in the folder is version ${seen}, which ModPacer can't compare with ${have}. Please check it.`,
    // several sources for one mod (ModPacer 2.0, part 3)
    chooseSource: 'Choose a source',
    asking: (says) => `${says.join(' and ')}. ModPacer can't tell which is newer. Which one should it follow?`,
    pinnedFailed: (label) => `${label} is pinned, and ModPacer can't read it right now. It isn't switching to another place. Check another place by hand, or unpin it.`,
    leftOutConfirm: (label) => `${label} needs confirmation, so it was left out.`,
    leftOutCannot: (label) => `${label} can't be read right now, so it was left out.`,
    following: (label) => `Following ${label}`,
    followingNewest: (label) => `Following ${label} (newest)`,
    followingChosen: (label) => `Following ${label} (your choice)`,
    followingPinned: (label) => `Following ${label} (pinned)`,
    // a LoversLab page, read by the person's own browser through the browser helper (ModPacer 2.0, part 4)
    llNoHelper: "The browser helper isn't connected, so ModPacer can't read this page yet.",
    llWaiting: 'Waiting for your browser to read this page.',
    llSignedOut: 'LoversLab wants you to sign in again. Open it in your browser, sign in, and ModPacer will check again.',
    llCannot: "ModPacer couldn't read this page. LoversLab might have changed it, or you need to sign in again.",
    llTemporary: "Your browser couldn't reach LoversLab just now. ModPacer will try again.",
    pageLower: (seen, have) => `The page now says version ${seen}, lower than the ${have} you have. Please check it.`,
    pageNoCompare: (seen, have) => `The page says version ${seen}, which ModPacer can't compare with ${have}. Please check it.`,
};
// The one plain line for each reason a source cannot be read (never the system's own words).
function errorLine(code) {
    switch (code) {
    case 'gone': return WORDS.gone;
    case 'unreadable': return WORDS.unreadable;
    case 'folder_missing': return WORDS.folderMissing;
    case 'folder_unreadable': return WORDS.folderUnreadable;
    case 'folder_refused': return WORDS.folderRefused;
    case 'folder_empty': case 'pattern': return WORDS.noBuild;
    case 'variant_missing': return WORDS.variantMissing;
    case 'no_helper': return WORDS.llNoHelper;
    case 'signin': return WORDS.llSignedOut;
    case 'layout': return WORDS.llCannot;
    default: return WORDS.noRelease;
    }
}

// ---- the sources of one mod (ModPacer 2.0, part 3) ----
// A mod keeps ONE installed-version record and one list of sources; each source has its own observation, error and back-off. The error and the back-off of the FIRST source also
// live on the mod itself (where parts 1 and 2 saved them), so an older file is read as it was: a source with no error of its own uses the mod's, if it is the first.
const hasOwn = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
function errOf(rec, src) {
    if (!src) return null;
    if (hasOwn(src, 'lastError')) return src.lastError || null;
    return (rec.sources || [])[0] === src ? (rec.lastError || null) : null;
}
function retryOf(rec, src) {
    if (!src) return null;
    if (hasOwn(src, 'retry') && src.retry) return src.retry;
    return (rec.sources || [])[0] === src ? (rec.retry || null) : null;
}
const LABELS = { github: 'GitHub', folder: 'the folder', loverslab: 'LoversLab' };
const labelOf = (s) => (s && LABELS[s.type]) || 'another place';
const capital = (t) => t.charAt(0).toUpperCase() + t.slice(1);

// One source on its own: -> { state: 'read' | 'confirm' | 'cannot' | null, line, temp, observed, installed }
function decideSource(rec, source, installed) {
    const obs = source ? (rec.observation || {})[source.id] : null;
    const have = installed && installed.version ? installed.version : null;
    const err = errOf(rec, source);
    const page = !!(source && source.type === 'loverslab');
    const temp = err && (err.code === 'network' || err.code === 'rate_limited') ? (page ? WORDS.llTemporary : WORDS.temporary) : null;
    const out = (state, line) => ({ state, line: line || null, temp, observed: obs && obs.version ? obs.version : null, installed: have });
    if (source && source.stopped) return out('cannot', WORDS.gone);
    const folder = !!(source && source.type === 'folder');
    const lowerLine = (seen, had) => (folder ? WORDS.folderLower(seen, had) : page ? WORDS.pageLower(seen, had) : WORDS.lower(seen, had));
    const noCompareLine = (seen, had) => (folder ? WORDS.folderNoCompare(seen, had) : page ? WORDS.pageNoCompare(seen, had) : WORDS.noCompare(seen, had));
    if (err && !temp && !(obs && obs.version)) return out('cannot', errorLine(err.code));
    if (!obs || !obs.version) {
        if (temp) return { ...out(null, null), temp };
        if (page && !err) return out(null, WORDS.llWaiting); // asked, and the browser has not answered yet
        return out(err ? 'cannot' : null, err ? errorLine(err.code) : null);
    }
    if (err && !temp) return out('cannot', errorLine(err.code)); // the newest read failed in a way only the person can fix; the last good version is kept but not offered
    const seen = obs.version;
    if (rec.baseline && rec.baseline.version === seen) return out('read', null); // the person already looked at exactly this version and said it is right
    if (have) {
        const c = compareVersions(have, seen); // 'newer' = the version read is newer than the one the person has
        if (c === 'unknown' || !sameScheme(have, seen)) return out('confirm', noCompareLine(seen, have));
        if (c === 'older') return out('confirm', lowerLine(seen, have));
    }
    if (obs.prev && !(rec.baseline && rec.baseline.version === obs.prev)) {
        const c = compareVersions(obs.prev, seen);
        if (c === 'unknown' || !sameScheme(obs.prev, seen)) return out('confirm', noCompareLine(seen, obs.prev));
        if (c === 'older') return out('confirm', lowerLine(seen, obs.prev));
    }
    return out('read', null);
}

// Can two read versions be put in order? (Never an invented order: different shapes, or numbers that cannot be read, cannot.)
function comparable(a, b) { return compareVersions(a, b) !== 'unknown' && sameScheme(a, b); }

// The ONE selection step over every source's observation (not competing loops). A pin selects exactly that source and nothing else, with no silent fallback; without a pin the
// newest wins, but only among versions that can be compared; when they cannot, the person's remembered choice decides, and with none the answer is a question.
// -> { ...the followed source's decision, source, following: { id, label, how: 'only' | 'pinned' | 'newest' | 'chosen' } | null, notes: [lines], others: [{ id, label, version }], ask }
function decide(rec, installed, sourceId = null) {
    const sources = rec.sources || [];
    const plain = (d, source) => ({ ...d, source, following: null, notes: [], others: [], ask: null });
    if (sourceId) { const s = sources.find((x) => x.id === sourceId) || sources[0] || null; return plain(decideSource(rec, s, installed), s); }
    if (sources.length <= 1) return plain(decideSource(rec, sources[0] || null, installed), sources[0] || null);
    const per = sources.map((s) => ({ s, d: decideSource(rec, s, installed), label: labelOf(s) }));
    const otherInfo = (win) => per.filter((p) => p !== win && p.d.observed).map((p) => ({ id: p.s.id, label: p.label, version: p.d.observed, state: p.d.state }));
    const result = (win, how, extra = {}) => ({ ...win.d, source: win.s, following: { id: win.s.id, label: win.label, how }, notes: [], others: otherInfo(win), ask: null, ...extra });
    const pinned = rec.pin ? per.find((p) => p.s.id === rec.pin) : null;
    if (pinned) {
        // exactly that source: if it cannot be read the row says so (and offers the others by hand); it never quietly follows another
        if (pinned.d.state === 'cannot') return result(pinned, 'pinned', { line: WORDS.pinnedFailed(capital(pinned.label)) });
        return result(pinned, 'pinned');
    }
    const reads = per.filter((p) => p.d.state === 'read' && p.d.observed);
    const held = per.filter((p) => p.d.state === 'confirm' || p.d.state === 'cannot');
    const heldNotes = held.map((p) => (p.d.state === 'confirm' ? WORDS.leftOutConfirm(capital(p.label)) : WORDS.leftOutCannot(capital(p.label))));
    if (reads.length === 0) {
        const first = held.find((p) => p.d.state === 'confirm') || held[0] || per[0];
        return result(first, 'only', { following: null, others: otherInfo(first) });
    }
    let win = null, how = 'only';
    if (reads.length === 1) win = reads[0];
    else if (reads.every((a) => reads.every((b) => a === b || comparable(a.d.observed, b.d.observed)))) {
        win = reads.reduce((best, p) => (compareVersions(best.d.observed, p.d.observed) === 'newer' ? p : best)); // the first of equals wins, so the answer never flips
        how = 'newest';
    } else {
        const picked = rec.choice && reads.find((p) => p.s.id === rec.choice.sourceId);
        if (picked) { win = picked; how = 'chosen'; } else {
            const first = reads[0];
            return {
                ...first.d, state: 'ask', line: WORDS.asking(reads.map((p) => `${p.label} says ${p.d.observed}`)), observed: null,
                source: first.s, following: null, notes: heldNotes, others: [], ask: { sources: reads.map((p) => ({ id: p.s.id, label: p.label, version: p.d.observed })) },
            };
        }
    }
    return result(win, how, { notes: heldNotes });
}

// The words that say which source a row follows, shown on the row itself (not only in the menu).
function followLine(d) {
    if (!d.following) return null;
    if (d.following.how === 'pinned') return WORDS.followingPinned(d.following.label);
    if (d.following.how === 'newest') return WORDS.followingNewest(d.following.label);
    if (d.following.how === 'chosen') return WORDS.followingChosen(d.following.label);
    return WORDS.following(d.following.label);
}

// ---- an application (ModPacer 2.0): a program that is only tracked, never installed by ModPacer ----
// The files of a release that could be a download for an application: installers and archives only, those that work on this machine first (the rest are not offered).
// (each package keeps only its own system's list: the platform markers cut the other)
const APP_FILE_ORDER = {
    win32: ['exe', 'msi', 'msix', 'zip', '7z', 'rar'],
};
function usableAppFiles(assets, platform = process.platform) {
    const order = APP_FILE_ORDER[platform] || [];
    const out = [];
    for (const a of Array.isArray(assets) ? assets : []) {
        const ext = (/\.([A-Za-z0-9]+)$/.exec(a && a.name || '') || [])[1];
        const rank = ext ? order.indexOf(ext.toLowerCase()) : -1;
        if (rank >= 0) out.push({ name: a.name, size: a.size || 0, rank });
    }
    return out.sort((x, y) => x.rank - y.rank || x.name.localeCompare(y.name)).map(({ name, size }) => ({ name, size }));
}

// The page row for a tracked mod. `installed`: { version, fromManager }.
function buildRow(rec, installed, decision, opts = {}) {
    const d = decision || decide(rec, installed);
    const source = d.source || (rec.sources || [])[0] || {};
    const have = installed && installed.version ? installed.version : null;
    const obs = (rec.observation || {})[source.id] || null;
    const isFolder = source.type === 'folder';
    const isPage = source.type === 'loverslab'; // a web page read through the browser helper: its only action is to open the page
    const releasesUrl = !isFolder && !isPage && source.url ? `${source.url}/releases` : null;
    const multi = (rec.sources || []).length > 1;
    const asking = d.state === 'ask';
    const base = {
        id: rec.id, title: rec.name, author: isFolder ? null : (source.owner || null),
        installedVersion: have, installedVersionUnknown: false, manifestVersionNote: null, manifestError: null,
        matchedBy: null, ambiguousMatch: false, downloadProgress: null, downloadedArchivePath: null, downloadedFileName: null,
        updatePreview: null, updateUnavailableReason: null, releaseDate: null, updatedAt: null, error: null, nsfw: false,
        hubUrl: null, hubId: null, stats: null, listingUrl: null, hasCover: false, coverAdult: false,
        ghCover: (rec.sources || []).some((s) => s && s.type === 'github'), // the page may ask for a GitHub picture (only used when the row has no Hub cover)
        noDownload: isPage || undefined, latestVersion: d.observed || null, externalUrl: isPage ? (source.url || null) : releasesUrl, urlKind: isFolder ? 'folder' : isPage ? 'loverslab' : 'github', changelog: null,
        notInstalled: !have && rec.kind !== 'application', // an application's installed version is only what the person said: it is never "not installed"
        tracked: {
            from: isFolder ? 'a folder' : isPage ? 'LoversLab' : 'GitHub', kind: isFolder ? 'folder' : isPage ? 'loverslab' : 'github', state: d.state, line: d.line, temp: d.temp, sourceId: source.id || null, observed: d.observed || null,
            openUrl: isFolder ? null : isPage ? (source.url || null) : ((obs && obs.url) || releasesUrl), also: isPage && obs ? { alsoListed: obs.alsoListed || [], dates: obs.dates || [] } : null, linked: !!(installed && installed.fromManager), stopped: !!source.stopped,
            word: d.state === 'confirm' ? WORDS.needsConfirmation : d.state === 'cannot' ? WORDS.cannotRead : asking ? WORDS.chooseSource : null,
            // several sources (part 3): which one the row follows, said on the row itself; the others' versions; the sources for the menu; a question when they cannot be compared
            follow: multi ? followLine(d) : null,
            others: (d.others || []).map((o) => ({ label: o.label, version: o.version })),
            notes: d.notes || [],
            pin: rec.pin || null,
            sources: (rec.sources || []).map((s) => ({ id: s.id, type: s.type, label: labelOf(s), url: s.type === 'github' ? (s.url || null) : null, pinned: rec.pin === s.id, following: !!(d.following && d.following.id === s.id) })),
            ask: d.ask || null,
        },
    };
    if (rec.kind === 'application') {
        // Never the mod Download behaviour (and so never the "no archive" error): the row offers Download-and-ask-where (only when the followed GitHub release carries an installer or
        // an archive that works here), the release page, and "I've updated it". isProgram keeps every bulk action (Download all, Update all, automatic download) away from it.
        const files = isFolder ? [] : usableAppFiles(obs && obs.assets, opts.platform);
        const known = !!(obs && Array.isArray(obs.assets));
        Object.assign(base, { isApplication: true, isProgram: true, externalUrl: isFolder ? null : ((obs && obs.url) || releasesUrl) });
        Object.assign(base.tracked, { app: true, appFiles: files, appNone: !isFolder && known && files.length === 0, lastAppFolder: null });
        if (d.state === 'read' && d.observed) { const c = have ? compareVersions(have, d.observed) : 'same'; return { ...base, status: c === 'newer' ? 'update_available' : 'up_to_date', versionCompare: c }; }
        return { ...base, status: 'unknown_version', latestVersion: d.state === 'read' ? d.observed : (d.observed || null) };
    }
    if (d.state === 'read' && d.observed) {
        const c = have ? compareVersions(have, d.observed) : 'newer';
        return { ...base, status: c === 'newer' ? 'update_available' : 'up_to_date', versionCompare: c };
    }
    // Needs confirmation / Can't read / a question / nothing read yet: never an Update button, never an "update available".
    return { ...base, status: 'unknown_version', latestVersion: d.state === 'read' ? d.observed : (d.observed || null) };
}

// When the next automatic look at one source is due, after a read that worked or failed. -> that source's new `retry`
function afterRead(rec, result, now = Date.now()) {
    if (result.page) return { fails: 0, nextAt: now + 30 * 60 * 1000 }; // a page asked for through the browser helper: asked again if no answer comes within half an hour
    if (result.local) return { fails: 0, nextAt: now + LOCAL_EVERY_MS }; // a folder on this PC: a quick look, no network, so no back-off and no waiting
    if (result.ok) return { fails: 0, nextAt: now + CHECK_EVERY_MS };
    if (result.code === 'rate_limited') return { fails: (rec.retry && rec.retry.fails) || 0, nextAt: Math.max(now + RATE_LIMIT_WAIT_MS, Number(result.resetAt) || 0) };
    if (result.code === 'gone') return { fails: 0, nextAt: 0 }; // the source is stopped: nothing is due until the person acts
    const fails = ((rec.retry && rec.retry.fails) || 0) + 1;
    const wait = result.code === 'network' ? Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (fails - 1)) : CHECK_EVERY_MS;
    return { fails, nextAt: now + wait };
}
function sourceDue(rec, source, now = Date.now()) {
    if (!source || source.stopped) return false;
    const r = retryOf(rec, source);
    return !r || !r.nextAt || r.nextAt <= now;
}
// Is any of the mod's sources due?
function isDue(rec, now = Date.now()) { return (rec.sources || []).some((s) => sourceDue(rec, s, now)); }

module.exports = { usableAppFiles, decide, decideSource, buildRow, afterRead, isDue, sourceDue, errOf, retryOf, labelOf, comparable, sameScheme, errorLine, WORDS, CHECK_EVERY_MS, LOCAL_EVERY_MS, BACKOFF_FIRST_MS, BACKOFF_MAX_MS };
