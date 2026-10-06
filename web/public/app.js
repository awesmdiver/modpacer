'use strict';

function $(id) { return document.getElementById(id); }

// The one place every call to ModPacer's server goes through. X-ModPacer is what tells the server the call came from this page
// (another website cannot send a custom header without a permission check ModPacer never grants).
function modpacerFetch(url, opts) {
    const o = opts || {};
    return fetch(url, { ...o, headers: { ...(o.headers || {}), 'X-ModPacer': '1' } });
}

async function api(method, url, body) {
    const res = await modpacerFetch(url, {
        method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(data.error || `Request failed (${res.status})`); if (data.kind) err.kind = data.kind; throw err; }
    return data;
}

// A link from outside text (a Hub listing) is only ever followed when it is a plain web address: never javascript:, data: and the like.
function webUrl(u) {
    return /^https?:\/\//i.test(String(u == null ? '' : u).trim()) ? String(u).trim() : '';
}

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// A small, SAFE Markdown subset for a catalog entry's own changelog text -- real ones seen live
// use headings, bold, and links (e.g. "## 🐛 Fixes", "**NPCs with non-English names**",
// "([#1](https://github.com/.../issues/1))"). Escapes the WHOLE input first, then only ever adds
// tags on top of the already-escaped text -- a raw "<script>" (or anything else) in a catalog
// entry can never come back out as a real tag, and a link's href is only ever kept if it's
// genuinely http(s) (never "javascript:"/"data:" etc.) -- anything else stays as plain escaped
// text instead of becoming a link. Everything not explicitly handled here (tables, images,
// blockquotes, code fences) is deliberately left as plain text, per "strip anything else".
function inlineMarkdown(escapedText) {
    let t = escapedText.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return t;
}
function renderMarkdownSafe(md) {
    if (!md) return '';
    const lines = escapeHtml(md).split(/\r?\n/);
    const out = [];
    let inList = false;
    const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
    for (const line of lines) {
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        const listItem = /^[-*]\s+(.*)$/.exec(line);
        if (heading) {
            closeList();
            out.push(`<div class="ch-heading">${inlineMarkdown(heading[1])}</div>`);
        } else if (listItem) {
            if (!inList) { out.push('<ul>'); inList = true; }
            out.push(`<li>${inlineMarkdown(listItem[1])}</li>`);
        } else if (line.trim() === '') {
            closeList();
        } else {
            closeList();
            out.push(`<div>${inlineMarkdown(line)}</div>`);
        }
    }
    closeList();
    return out.join('');
}

// --- Tabs ---
document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
        $('main').style.display = tab.dataset.tab === 'main' ? 'block' : 'none';
        $('settings').style.display = tab.dataset.tab === 'settings' ? 'block' : 'none';
        $('help').style.display = tab.dataset.tab === 'help' ? 'block' : 'none';
        if (tab.dataset.tab === 'help') loadHelp();
        // Re-fetch live state every time the Plugins tab is shown (queue:
        // plugins-tab-notice-saved-settings, 2026-09-30) -- a setting changed while looking at
        // Settings (a download folder, the Skyrim folder, Mod Staging Folder, the Nexus key) should
        // never need a Check now just to show up here; switching back is itself the signal to look
        // again. Cheap and idempotent even when nothing changed.
        if (tab.dataset.tab === 'main') refreshState();
    });
});

// --- Help tab (queue: help-tab-with-the-guide-and-a-section-for-mod-authors) ---
// The guide is release/HELP.md rendered by the server (GET /api/help): a contents list on the left, the sections on the right (the page's own
// openable-section pattern). "The page at a glance" and "For mod authors" start open. No icons.
const HELP_OPEN_AT_START = ['the-page-at-a-glance'];
const HELP_MISSING_TEXT = "The guide isn't here right now. Reinstalling ModPacer brings it back.";
let helpLoaded = false;
function reducedMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
async function loadHelp() {
    if (helpLoaded) return;
    let data;
    try { data = await api('GET', '/api/help'); } catch { data = { ok: false }; }
    const box = $('helpBody');
    if (!data || !data.ok) { box.innerHTML = `<p class="muted" id="helpMissing">${escapeHtml(HELP_MISSING_TEXT)}</p>`; return; }
    helpLoaded = true;
    const toc = data.sections.map((s) => `<a href="#help-${escapeHtml(s.id)}" data-action="help-goto" data-help-id="${escapeHtml(s.id)}">${escapeHtml(s.title)}</a>`).join('');
    const secs = data.sections.map((s) => {
        const open = HELP_OPEN_AT_START.includes(s.id);
        return `<div class="sec help-sec${open ? ' open' : ''}${s.id === 'for-mod-authors' ? ' help-authors' : ''}" id="help-${escapeHtml(s.id)}" data-help-sec="${escapeHtml(s.id)}"><div class="sec-h help-sec-h" data-action="help-toggle" role="button" tabindex="0" aria-expanded="${open}"><span class="sec-t"><span class="chev">&#9654;</span><span>${escapeHtml(s.title)}</span></span></div><div class="sec-body help-body">${s.html}</div></div>`;
    }).join('');
    box.innerHTML = `<h1>Help</h1><div class="help-lead">${data.lead}</div><div class="help-layout"><nav class="help-toc" aria-label="Contents">${toc}</nav><div class="help-main">${secs}</div></div>`;
    markHelpInView();
}
function setHelpOpen(sec, open) {
    sec.classList.toggle('open', open);
    const h = sec.querySelector('.help-sec-h');
    if (h) h.setAttribute('aria-expanded', String(open));
}
function markHelpOn(id) {
    document.querySelectorAll('.help-toc a').forEach((a) => a.classList.toggle('on', a.dataset.helpId === id));
}
// The contents entry for the section in view is marked: the last section whose top has passed the top of the window.
function markHelpInView() {
    const secs = [...document.querySelectorAll('.help-sec')];
    if (secs.length === 0 || $('help').style.display === 'none') return;
    let on = secs[0];
    for (const s of secs) if (s.getBoundingClientRect().top <= 90) on = s;
    markHelpOn(on.dataset.helpSec);
}
window.addEventListener('scroll', markHelpInView, { passive: true });
function helpGoto(id) {
    const sec = document.getElementById(`help-${id}`);
    if (!sec) return;
    setHelpOpen(sec, true);
    sec.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    markHelpOn(id);
}
document.addEventListener('click', (e) => {
    const el = e.target.closest ? e.target.closest('[data-action="help-goto"], [data-action="help-toggle"]') : null;
    if (!el) return;
    e.preventDefault();
    if (el.dataset.action === 'help-goto') helpGoto(el.dataset.helpId);
    else { const sec = el.closest('.help-sec'); setHelpOpen(sec, !sec.classList.contains('open')); }
});
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target && e.target.closest && e.target.closest('[data-action="help-toggle"]');
    if (el && e.target === el) { e.preventDefault(); el.click(); }
});

// --- Plugins tab ---
let pollTimer = null;
let autoCheckPending = true; // the page was just opened: a check starts by itself, so never show the empty "Not checked yet" card first
let vortexStartingByPlayer = false; // true while the Start Vortex popup is waiting (see startVortexUi)
let lastRenderedState = null;
// "Update all" batch (queue: fix-update-all, 2026-10-01): which row is being updated right now, whether a batch is
// running (locks every Update / Update all button), and whether it stopped because Vortex stopped answering.
let updatingId = null;
let batchRunning = false;
// Real steps of the updates running right now, from the server (state.updateProgress: { [id]: { label, waiting, blockedBy } }), and the
// rows of an Update all still waiting their turn.
let liveProgress = {};
let batchWaiting = new Set();
let vortexLostNotice = false;
let deployBusy = false; // the Deploy popup is open (hides the summary-line Deploy button meanwhile)
// How the last deploy ended when it needs saying on the page itself: 'still_needed' | 'not_confirmed' | null (cleared when a deploy starts).
let deployNotice = null;
const DEPLOY_STILL_NEEDED_TEXT = 'Vortex says it still needs to deploy. Open Vortex and press Deploy there.';
// The note after a good deploy: the usual reminder, or (when ModPacer switched every one of the new plugins on itself) a calmer one.
// A finished deploy says one warm line; the plugin reminder (#deployDoneNote) shows ONLY when something may need the person.
const DEPLOY_DONE_TEXT = 'Deployment is complete. Enjoy the game.';
const DEPLOY_NOT_CONFIRMED_TEXT = "Vortex didn't confirm the deploy, so it isn't marked as deployed. Press Retry to try again.";
const DEPLOY_FAILED_TEXT = 'Vortex could not complete the deployment. You can try again from here, or open Vortex and click Deploy Mods directly.';
// Update all follows along and finishes with a Deploy banner (queue: update-all-follows-along-and-deploys-at-the-end, 2026-10-04;
// the rules live in update-follow.js). followBatch: scroll to the mod being updated until the player scrolls away themselves.
let followBatch = false;
// The helper stopped answering mid-update (queue: helper-not-answering-says-retry-and-finishes-the-update, 2026-10-04):
// leftover = { ids } (the mod that was in flight first, then the rest, in order); retryStage = idle | busy | still;
// pickingUp = how many are left while the page carries on after a successful Retry (0 = not picking up).
let leftover = null;
let retryStage = 'idle';
let pickingUp = 0;
let singleUpdating = false; // one mod's own Update is in flight (Deploy isn't offered meanwhile either)
let cleaningOldDownloads = false; // the page is waiting on the old-download check (POST /api/cleanup-old-downloads)
let batchOutcome = null; // { attempted, updated } of the Update all that just finished; drives the banner
let deployBannerDismissed = false; // "Not yet" was pressed: the plain "Updated, not deployed yet" line shows instead
// Set once per renderPlugins() call, read by renderRow() -- avoids threading a second argument
// through the existing rows.map(renderRow) call (queue: fill-staging-folder-keep-changelogs,
// 2026-09-30).
let downloadFolderMissing = false;

// The top-right ↗ icon (queue: plugin-rows-revision-3-dates-icons-legend, 2026-10-01) -- replaces
// the old inline "GitHub release ↗"/"Nexus page ↗" text link, repeated on every single row.
// `role="img"` + `aria-label` so a screen reader gets "Mod page", not a bare glyph.
// A click through to the mod's own page counts as a visit on the plugins page (the arrow, Open on Nexus). Only rows the Hub knows carry the id.
function visitAttr(row) { return row.hubId ? ` data-visit-id="${escapeHtml(row.id)}"` : ''; }
// "<n> visits · <m> endorsed" under a row's title block, from the catalog's own counts. Nothing at all for a mod without counts.
function formatCount(n) { return Number(n).toLocaleString('en-US'); }
function countsLine(row) {
    const s = row.stats;
    if (!s) return '';
    const when = lastRenderedState && lastRenderedState.statsAsOf ? new Date(lastRenderedState.statsAsOf) : null;
    const title = when && !Number.isNaN(when.getTime()) ? ` title="Counts as of ${escapeHtml(when.toLocaleString())}"` : '';
    return `<div class="counts"${title}>${formatCount(s.downloads)} ${plural(s.downloads, 'visit', 'visits')} &middot; ${formatCount(s.endorsements)} endorsed</div>`;
}
function releaseIcon(row) {
    if (!webUrl(row.externalUrl)) return '';
    // On a row whose Hub link is out of date the icon is the way to the download, and its hover says so.
    const label = row.linkOutOfDate ? linkOutOfDateWords(row).hover : 'Mod page';
    return `<a href="${escapeHtml(webUrl(row.externalUrl))}"${visitAttr(row)} target="_blank" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" role="img">&#8599;</a>`;
}
// The words for a row whose Hub link points at an older release than the version the Hub lists (final wording by Gemini,
// design/gemini-link-out-of-date-line.md). The short line shows on a narrow window (style.css: .link-ood).
function linkOutOfDateWords(row) {
    const n = row.linkOutOfDate.newVersion;
    const o = row.linkOutOfDate.oldVersion;
    return {
        long: `The Hub lists ${n}, but its link only has ${o}. Use the mod page to download the update and install it manually in Vortex or MO2.`,
        short: `The Hub lists ${n} but links to ${o}. Use the mod page to download the update and install manually in Vortex or MO2.`,
        hover: `Open the mod page to download version ${n} manually.`,
    };
}
// The green ⬇ -- shows only once the archive is genuinely on disk (status downloaded), never for
// "downloading" or "updated". This is what replaces the old "Downloaded ✓" pill's own meaning.
function downloadedIcon(row) {
    if (row.status !== 'downloaded') return '';
    return `<span class="done" title="Downloaded" aria-label="Downloaded" role="img">&#11015;</span>`;
}
// The small "sliders" icon on a FOMOD mod's row: Update opens the options screen first. Same rule as the row's button.
const FOMOD_ICON_TEXT = 'Opens the FOMOD options screen first';
function showsFomodIcon(row) {
    return row.status === 'downloaded' && !!(row.fomodMismatch || (row.isFomod && row.updatePreview));
}
function fomodIcon(row) {
    if (!showsFomodIcon(row)) return '';
    return `<span class="fomod" tabindex="0" title="${FOMOD_ICON_TEXT}" aria-label="${FOMOD_ICON_TEXT}" role="img">${FOMOD_SVG}</span>`;
}
const FOMOD_SVG = '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2 4.5h12M2 11.5h12"/><circle cx="5.5" cy="4.5" r="1.7" fill="var(--bg, #000)"/><circle cx="10.5" cy="11.5" r="1.7" fill="var(--bg, #000)"/></svg>';
// The second small icon next to the Mod page arrow: the mod's own page on the plugins site. The fateless.ai icon (the cyan rune on a dark rounded
// square, used with Min's permission, 2026-10-04): a brand mark, so it keeps its own colours (web/public/fateless-icon.svg, drawn as plain paths).
const HUB_ICON_TEXT = 'See this mod on the plugins page';
const HUB_SVG = '<img src="fateless-icon.svg" width="16" height="16" alt="" aria-hidden="true">';
function hubIcon(row) {
    if (!row.hubUrl) return '';
    return `<a class="hub-ico" href="${escapeHtml(row.hubUrl)}" target="_blank" rel="noopener" title="${HUB_ICON_TEXT}" aria-label="${HUB_ICON_TEXT}" role="img">${HUB_SVG}</a>`;
}
// A small amber-outlined pill after the title of an adult (NSFW) listing, wherever it shows.
function nsfwPill(row) {
    return row.nsfw ? '<span class="nsfw-pill" title="Adult content">NSFW</span>' : '';
}
function rowIconsHtml(row) {
    const icons = [fomodIcon(row), releaseIcon(row), hubIcon(row), downloadedIcon(row)].filter(Boolean).join('');
    return icons ? `<div class="icons">${icons}</div>` : '';
}

// "Sep 26, 2026" -- a release date already resolved server-side (GitHub's own published_at, or a
// Nexus file's own upload date); never guessed here, an unparseable/missing value just renders no
// line at all, same as the server already deciding not to cache one.
function formatReleaseDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// The rows an "Update all" covers: downloaded, with a working update preview. A FOMOD mod is included: the batch pauses on
// it and shows its options screen (it never installs without one).
function updatableRows(rows) {
    return (rows || []).filter((r) => r.status === 'downloaded' && r.updatePreview && !r.oldCopyLeft);
}

function renderRow(row) {
    // Author only -- the release link moved into the top-right icon (queue:
    // plugin-rows-revision-3-dates-icons-legend, 2026-10-01; previously joined with releaseLink()
    // here, repeating "GitHub release ↗" as plain text on every single row).
    const metaBits = [row.author ? escapeHtml(row.author) : null].filter(Boolean);
    // Only show the old-→-new arrow when the versions actually differ -- an up-to-date row
    // has installedVersion === latestVersion, and showing "0.11.1→0.11.1" (real bug, live) is
    // never useful. Anything actually newer (update_available/downloading/downloaded/updated)
    // still gets the arrow even if, in principle, latestVersion could ever equal installedVersion
    // for some other reason -- the comparison is the honest signal, not the status string.
    // installedVersionUnknown (queue: helper-down-message-and-version-fallback, 2026-10-01): Vortex
    // HAS tracked this plugin, but its own version genuinely isn't known right now -- shown as a
    // real "?" on the left, never silently replaced by the latest version alone (which would read
    // like it's already up to date).
    const verHtml = row.installedVersionUnknown && row.vortexWaiting
        ? (row.latestVersion ? `&hellip;<span class="arrow">&rarr;</span><span class="new">${escapeHtml(row.latestVersion)}</span>` : '&hellip;')
        : row.installedVersionUnknown
        ? (row.latestVersion ? `?<span class="arrow">&rarr;</span><span class="new">${escapeHtml(row.latestVersion)}</span>` : '?')
        : row.latestVersion && row.installedVersion && row.latestVersion !== row.installedVersion
            ? `${escapeHtml(row.installedVersion)}<span class="arrow">&rarr;</span><span class="new">${escapeHtml(row.latestVersion)}</span>`
            : escapeHtml(row.installedVersion || row.latestVersion || '?');
    const dateText = formatReleaseDate(row.releaseDate);
    const dateHtml = dateText ? `<div class="dt">${escapeHtml(dateText)}</div>` : '';
    // Vortex's own version wins over the plugin's inner manifest.json (queue:
    // compare-against-vortex-version, 2026-10-01) -- the inner one, when it disagrees, goes in a
    // tooltip rather than just vanishing, so a real mismatch is still visible on request.
    // installedVersionUnknown gets its own short, plain explanation instead (queue:
    // helper-down-message-and-version-fallback, 2026-10-01) -- it isn't a mismatch, it's "Vortex
    // can't confirm this right now," a different situation worth its own wording, and the one
    // whose last known value is still being shown says so too.
    const verTitle = row.installedVersionUnknown
        ? ' title="Vortex can\'t confirm this mod\'s version right now. See the notice above."'
        : row.vortexInfoFromCache
            ? ' title="Showing the last version Vortex reported, from before it stopped answering."'
            : row.manifestVersionNote ? ` title="${escapeHtml(row.manifestVersionNote)}"` : '';

    let action = '';
    let changesHtml = '';
    const inProgress = rowState.inProgressView(row);
    // A row whose update is running (or waiting its turn in Update all) shows that, never the plain Update button.
    const updateWork = row.status === 'downloaded' ? updateWorkHtml(row) : '';
    if (inProgress) {
        // queued -> "Waiting to download..." with no bar; downloading -> real bytes, and a bar only when
        // the real size is known (rules live in row-state.js).
        action = `<span class="pill p-dl">${escapeHtml(inProgress.label)}</span>`
            + (inProgress.bar != null ? `<div class="bar"><i style="width:${inProgress.bar}%"></i></div>` : '');
    } else if (row.oldCopyLeft) {
        // The new version is in, but the old copy (its Vortex record, its archive, its staging folder) is not fully gone: never a tick. The error line under
        // the row says what is left; Try again removes it again through the Vortex Bridge and looks.
        // While Try again runs the row shows the usual working word, so the click is never silent; then it finishes, or says what is left.
        action = updateWorkHtml(row) || `<button data-action="retry-carry-over" data-id="${escapeHtml(row.id)}"${batchRunning ? ' disabled' : ''}>Try again</button>`;
    } else if (row.status === 'downloaded') {
        // No "Downloaded ✓" pill here anymore -- the ⬇ icon above now carries that same meaning
        // (director, from the live page: repeated with an Update button right next to it, the
        // pill was saying the same thing twice).
        if (updateWork) {
            action = updateWork;
        } else if (row.fomodMismatch || (row.isFomod && row.updatePreview)) {
            // A FOMOD always shows its options screen: this button IS its Update (the icon above says so).
            action = `<button class="primary" data-action="open-wizard" data-id="${escapeHtml(row.id)}"${batchRunning ? ' disabled' : ''}>${updateLabel(row)}</button>${notInVortexNote(row)}`;
        } else if (row.updatePreview) {
            action = `<button class="primary" data-action="update" data-id="${escapeHtml(row.id)}"${batchRunning ? ' disabled' : ''}>${updateLabel(row)}</button>${notInVortexNote(row)}`;
        } else if (row.updateUnavailableReason) {
            const text = rowState.waitingLine(row.updateUnavailableReason, vortexStartingByPlayer);
            action = `<div class="muted" style="font-size:0.75rem;text-align:right">${escapeHtml(text)}</div>`;
        }
    } else if ((row.status === 'updated' || row.status === 'deployed') && row.carryOver) {
        // Installed, but something didn't carry over: never a clean tick over a partial result. "Try again" redoes just that part.
        // While Try again runs the row shows the usual working word at once (never a button that seems to do nothing), then finishes or says what is left.
        // Two different sentences: Vortex was too busy to be asked (nothing known to be wrong) vs a read that succeeded and found a rule missing.
        const unchecked = Array.isArray(row.carryOver.partial) && row.carryOver.partial.length > 0 && row.carryOver.partial.every((p) => p === 'rules_unchecked');
        action = updateWorkHtml(row)
            || `<div class="muted" style="font-size:0.75rem;text-align:right">${unchecked ? "Installed. ModPacer couldn't check its rules because Vortex was busy." : "Installed, but some of its rules didn't carry over."}</div>`
            + `<button data-action="retry-carry-over" data-id="${escapeHtml(row.id)}"${batchRunning ? ' disabled' : ''}>Try again</button>`;
    } else if (row.status === 'deployed') {
        action = `<span class="pill p-done">Deployed &#10003;</span>` + pluginsNoteHtml(row);
    } else if (row.status === 'updated') {
        action = `<span class="pill p-done">${row.installedNew ? 'Installed' : 'Updated'} &#10003;</span>` + pluginsNoteHtml(row);
    } else if (row.status === 'update_available') {
        action = downloadFolderMissing
            ? `<button class="primary" disabled title="Pick a download folder in Settings first">Download</button>`
            : `<button class="primary" data-action="download" data-id="${escapeHtml(row.id)}">Download</button>`;
        if (row.vortexWaiting) action += `<div class="muted" style="font-size:0.75rem;text-align:right">Waiting for Vortex…</div>`;
        else if (row.notInVortex) action += notInVortexNote(row);
    } else if (row.status === 'needs_you' && row.linkOutOfDate) {
        // No button at all: this tool can't install the version the Hub lists. The release-page icon above is the way to it.
        const words = linkOutOfDateWords(row);
        changesHtml = `<div class="changes link-ood"><span class="link-ood-long">${escapeHtml(words.long)}</span><span class="link-ood-short">${escapeHtml(words.short)}</span></div>`;
    } else if (row.status === 'needs_you') {
        if (row.urlKind === 'nexus') {
            action = `<button data-action="open-link"${visitAttr(row)} data-url="${escapeHtml(webUrl(row.externalUrl))}">Open on Nexus</button>`;
            changesHtml = `<div class="changes">Nexus only allows automatic downloads for Premium members. Add your API key in <b>Settings</b>, or download it directly from Nexus.</div>`;
        } else {
            action = webUrl(row.externalUrl) ? `<button data-action="open-link"${visitAttr(row)} data-url="${escapeHtml(webUrl(row.externalUrl))}">View release</button>` : '';
        }
    } else if ((row.status === 'up_to_date' || row.status === 'unknown_version') && row.vortexWaiting) {
        // Vortex was still busy when this was checked: no "Up to date" until Vortex has really answered (checked again by itself).
        action = `<div class="muted" style="font-size:0.75rem;text-align:right">Waiting for Vortex…</div>`;
    } else if (row.installedVersionUnknown && row.status === 'unknown_version') {
        // Vortex answered fully, and its entry for this mod has no version: say what is true (nothing is waiting).
        action = `<div class="muted" style="font-size:0.75rem;text-align:right">Installed, but Vortex doesn't know its version</div>`;
    } else if (row.status === 'up_to_date' || row.status === 'unknown_version') {
        action = `<span class="pill p-ok">${row.status === 'unknown_version' ? "Can't check version" : 'Up to date'}</span>`;
    } else if (row.status === 'not_on_hub') {
        action = `<span class="pill p-ok">Not on the Hub</span>`;
    }
    const right = `<div class="right">${rowIconsHtml(row)}${action}</div>`;

    // A row never shows "Updating..." and a failure sentence together: the old line goes the moment a try starts, and a new one appears only if it ends badly.
    if (row.error && !updateWorkHtml(row)) {
        changesHtml += `<div class="changes" style="color:var(${row.errorWarn ? '--status-warning' : '--status-error'})">${escapeHtml(row.error)}</div>`;
    }
    // "What's new" stays visible once downloaded too, not just while still pending (director,
    // 2026-09-30: "the release notes he saw earlier are gone") -- it's still the same real
    // changelog either way, and losing it the moment a download finishes is never useful.
    if ((row.status === 'update_available' || row.status === 'queued' || row.status === 'downloading' || row.status === 'downloaded') && row.changelog) {
        const rendered = renderMarkdownSafe(row.changelog);
        const isLong = row.changelog.length > 220 || (row.changelog.match(/\r?\n/g) || []).length > 2;
        const collapseId = `changes-${row.id}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        changesHtml += `<div class="changes">
            <b>What's new:</b>
            <div class="${isLong ? 'ch-body ch-collapsed' : 'ch-body'}" id="${collapseId}">${rendered}</div>
            ${isLong ? `<a href="#" class="ch-toggle" data-action="toggle-changes" data-target="${collapseId}">Show more</a>` : ''}
        </div>`;
    }

    return `<div class="row" data-row-id="${escapeHtml(row.id)}">
        <div><div class="name">${escapeHtml(row.title)}${nsfwPill(row)}</div><div class="meta">${metaBits.join(' &middot; ') || '&nbsp;'}</div>${countsLine(row)}</div>
        <div><div class="ver"${verTitle}>${verHtml}</div>${dateHtml}</div>
        ${right}
        ${changesHtml}
    </div>`;
}

// The single "no download folder" banner (director, from a live screenshot: one banner at the top,
// not a red line repeated on every row) -- same critical-callout shape Vortex Collection Tools
// uses for a hard blocker (🛑, red). The Settings link just switches tabs -- it's the SAME .tab
// element the tab bar itself already wires up, not a separate code path.
function renderDownloadFolderBanner(missing) {
    $('downloadFolderBanner').innerHTML = missing ? `
        <div class="callout callout--critical">
            <div class="callout__title">🛑 No download folder set yet</div>
            <div class="callout__body">Updates can't download until you pick one in <a href="#" data-action="goto-settings">Settings</a>.</div>
        </div>
    ` : '';
}

// Vortex open but its own Helper extension not answering (queue:
// helper-down-message-and-version-fallback, 2026-10-01) -- a real reported case where Vortex's own
// log showed something else already holding the Helper's port at startup. ⚠️ not 🛑: nothing here
// is actually refused, versions just can't be freshly confirmed right now.
// Words: HELPER_BUSY_TEXT first; after a Retry that still gets no answer, HELPER_STILL_TEXT in the same place.
const HELPER_BUSY_TEXT = "Vortex is open, but the Vortex Bridge isn't answering. Vortex may be busy. Press Retry to try again.";
const HELPER_STILL_TEXT = 'Still no answer. Vortex may still be busy. Try again in a moment.';
function renderVortexHelperBanner(helperState) {
    if (helperState === 'vortex_running_helper_unreachable') {
        const busy = retryStage === 'busy';
        $('vortexHelperBanner').innerHTML = `
        <div class="callout callout--warning callout--plain">
            <div class="callout__title">&#9888;&#65039; ${retryStage === 'still' ? HELPER_STILL_TEXT : HELPER_BUSY_TEXT}</div>
            <div class="callout__actions"><button class="primary" data-action="retry-helper"${busy ? ' disabled' : ''}>${busy ? 'Retrying\u2026' : 'Retry'}</button></div>
        </div>`;
    } else if (pickingUp > 0) {
        $('vortexHelperBanner').innerHTML = `
        <div class="callout callout--notice callout--plain">
            <div class="callout__title">Picking up where it stopped: ${pickingUp} left.</div>
        </div>`;
    } else {
        $('vortexHelperBanner').innerHTML = '';
    }
}

// Retry: one quick status call. Answers -> the banner goes and the page carries on with only what was left (in order).
async function retryHelperClick() {
    if (retryStage === 'busy') return;
    retryStage = 'busy';
    if (lastRenderedState) renderPlugins(lastRenderedState);
    let status = null;
    try { status = await api('GET', '/api/vortex-status'); } catch { status = null; }
    if (!(status && status.connectionState === 'connected')) {
        retryStage = 'still';
        if (lastRenderedState) renderPlugins(lastRenderedState);
        return;
    }
    retryStage = 'idle';
    vortexLostNotice = false;
    const pending = leftover;
    leftover = null;
    if (!pending) {
        // The page gave up waiting on a busy Vortex: it answers now, so check again (the rows fill in) instead of just redrawing.
        if (lastRenderedState && lastRenderedState.vortexGaveUp) { try { renderPlugins(await api('POST', '/api/check', { force: false })); } catch { await refreshState(); } return; }
        await refreshState();
        return;
    }
    let state;
    try { state = await api('GET', '/api/state'); } catch { state = lastRenderedState; }
    const ids = updateFollow.resumeIds(pending, (state && state.rows) || []);
    if (ids.length === 0) { await refreshState(); return; }
    pickingUp = ids.length;
    renderPlugins(state);
    try {
        await runUpdateBatch(ids, { onStep: (left) => { pickingUp = left; renderVortexHelperBanner(null); } });
    } finally {
        pickingUp = 0;
        await refreshState();
    }
}
// Starting anything else drops the leftover list: it is never resumed silently later.
function dropLeftover() { leftover = null; pickingUp = 0; retryStage = 'idle'; }

// The bundled Vortex Bridge: the Mods-page banner and the Settings line share one small box. ModPacer never installs the Bridge (it never writes
// into Vortex's folders): the button only opens Explorer on `vortex-bridge.zip`, and the numbered lines say how to add it in Vortex. Same words as the
// setup pop-up's Bridge step (web/public/setup-flow.js) and release/HELP.md. stage: idle | opened. Not bundled (a dev checkout) -> the old link, unchanged.
const helperBox = { stage: 'idle', busy: false };
const HELPER_SENTENCE = window.setupFlow.BRIDGE_MISSING;
const HELPER_ZIP_OPENED = 'Explorer just opened with the Vortex Bridge in it. Add it to Vortex:';
// -> { title, body } (body is HTML) for the current stage; bundled case only
function bundledHelperParts(outdated, newerText) {
    if (helperBox.stage === 'opened') {
        return { title: HELPER_ZIP_OPENED, body: window.setupFlow.bridgeStepsHtml('page', !!(outdated || newerText)) + '<p class="hint" style="margin:6px 0 0">Can\'t see Explorer? Look for its flashing icon in your taskbar.</p>', actions: '' };
    }
    return { title: newerText || (outdated ? window.setupFlow.BRIDGE_OUTDATED : HELPER_SENTENCE), body: '', actions: '<button class="primary" data-action="open-helper-zip">Get the Vortex Bridge</button>' };
}
function refreshHelperBoxes() {
    renderHelperNotInstalledBanner(lastRenderedState);
    if (lastSettingsCfg) renderHelperSettingsLine(lastSettingsCfg);
}

// Shown once, at the top of the Mods tab, only when Vortex is the chosen mod manager and the
// Vortex Bridge isn't installed. (Never for MO2 -- nothing here concerns Vortex then.)
// It goes away by itself once Vortex has the Bridge (the add-ons folder is read, never written).
function renderHelperNotInstalledBanner(state) {
    const vortex = !!state && state.modManager !== 'mo2';
    const outdated = vortex && state.helperInstalled !== false && !!state.helperOutdated; // installed, but older than ModPacer needs
    const bridge = (state && state.bridge) || null;
    const newer = vortex && !outdated && state.helperBundled && !!(bridge && bridge.answering && bridge.newerBundled); // an update comes with ModPacer
    const show = vortex && (state.helperInstalled === false || outdated || newer);
    if (!show) { $('helperNotInstalledBanner').innerHTML = ''; return; }
    if (state.helperBundled) {
        const parts = bundledHelperParts(outdated, newer ? window.setupFlow.bridgeNewerText(bridge.version, bridge.bundledVersion) : null);
        const needsAttention = !newer; // missing / too old: a warning; a newer one coming with ModPacer is only a notice (the steps, once the folder is open, are part of it)
        $('helperNotInstalledBanner').innerHTML = `
        <div class="callout ${needsAttention ? 'callout--warning' : 'callout--notice'} callout--plain">
            <div class="callout__title">${needsAttention ? '&#9888;&#65039; ' : ''}${escapeHtml(parts.title)}</div>
            ${parts.body ? `<div class="callout__body">${parts.body}</div>` : ''}
            ${parts.actions ? `<div class="callout__actions">${parts.actions}</div>` : ''}
        </div>`;
        return;
    }
    $('helperNotInstalledBanner').innerHTML = outdated ? `
        <div class="callout callout--warning">
            <div class="callout__title">&#9888;&#65039; ${escapeHtml(window.setupFlow.BRIDGE_OUTDATED)}</div>
            <div class="callout__body"><a href="${escapeHtml(state.helperDownloadUrl)}" target="_blank" rel="noopener noreferrer">Get the Vortex Bridge</a></div>
        </div>
    ` : `
        <div class="callout callout--warning">
            <div class="callout__title">&#9888;&#65039; ModPacer works best with the Vortex Bridge&mdash;it can install updates directly into Vortex for you.</div>
            <div class="callout__body"><a href="${escapeHtml(state.helperDownloadUrl)}" target="_blank" rel="noopener noreferrer">Get the Vortex Bridge</a></div>
        </div>
    `;
}

async function openHelperZipClick() {
    try {
        const r = await api('POST', '/api/setup/helper-open-zip');
        if (r.ok) helperBox.stage = 'opened';
    } catch { /* the failed box stays up */ }
    refreshHelperBoxes();
}

// A group header's own legend only ever lists the icons its own rows actually use (queue:
// plugin-rows-revision-3-dates-icons-legend, 2026-10-01) -- Updates typically shows both (some
// rows downloaded, all of them linking out); Up to date only ever shows ↗ (nothing in that group
// was ever downloaded through this tool); Not on the Hub shows neither (no catalog match, no link).
function legendHtml(groupRows) {
    const legendBits = [];
    if (groupRows.some(showsFomodIcon)) legendBits.push(`<span><span class="fomod">${FOMOD_SVG}</span> FOMOD options</span>`);
    if (groupRows.some((r) => !!r.externalUrl)) legendBits.push(`<span><span style="color:var(--accent-text)">&#8599;</span> Mod page</span>`);
    if (groupRows.some((r) => !!r.hubUrl)) legendBits.push(`<span><span class="hub-ico">${HUB_SVG}</span> Plugins page</span>`);
    if (groupRows.some((r) => r.status === 'downloaded')) legendBits.push(`<span><span style="color:var(--status-success)">&#11015;</span> Downloaded</span>`);
    return legendBits.length > 0 ? `<span class="legend">${legendBits.join('')}</span>` : '';
}
function groupHeader(label, groupRows, key) {
    return `<div class="group-h"${key ? ` data-group="${key}"` : ''}><span>${label}</span></div>`;
}

// ---- Expandable sections (Updates open, Up to date and Mods not installed closed): a chevron, the name, the count in brackets and the
// section's own action right-justified. A click on the header opens or closes it; each section's choice is remembered in this browser.
const SECTION_DEFAULTS = { updates: true, uptodate: false, notinstalled: false };
let sectionState = { ...SECTION_DEFAULTS };
try { sectionState = { ...SECTION_DEFAULTS, ...JSON.parse(localStorage.getItem('sectionOpen') || '{}') }; } catch { /* the defaults */ }
function setSectionOpen(key, open) {
    sectionState[key] = !!open;
    try { localStorage.setItem('sectionOpen', JSON.stringify(sectionState)); } catch { /* remembered for this visit only */ }
    const sec = document.querySelector(`.sec[data-section="${key}"]`);
    if (sec) {
        sec.classList.toggle('open', !!open);
        const head = sec.querySelector('.sec-h');
        if (head) head.setAttribute('aria-expanded', String(!!open));
    }
}
function sectionHtml(key, label, countText, groupRows, actionHtml, bodyHtml) {
    const open = !!sectionState[key];
    return `<div class="sec${open ? ' open' : ''}" data-section="${key}"><div class="group-h sec-h" data-action="toggle-section" data-section="${key}" role="button" tabindex="0" aria-expanded="${open}"><span class="sec-t"><span class="chev">&#9654;</span><span>${label}${countText ? ` <span class="cnt">(${countText})</span>` : ''}</span></span><span class="grow"></span><span class="sec-act">${actionHtml || ''}</span></div><div class="sec-body">${bodyHtml}</div></div>`;
}

// The old-download check's own line: running, or how many are still to remove. '' when there is nothing to say.
function cleanupLineText(state) {
    return oldDownloadNote.text({ cleaning: cleaningOldDownloads || !!(state && state.oldDownloadsCleaning), pending: (state && state.oldDownloadsPending) || 0 });
}

// The amber result of a deploy Vortex did not agree to (never the green success): says so, with Retry when it could not be confirmed.
function deployNoticeHtml() {
    if (!deployNotice) return '';
    const notConfirmed = deployNotice === 'not_confirmed';
    return `<div class="callout callout--warning deploy-banner" data-deploy-notice style="margin-top:12px">
        <div class="deploy-banner__text"><div class="callout__title">&#9888;&#65039; ${notConfirmed ? DEPLOY_NOT_CONFIRMED_TEXT : DEPLOY_STILL_NEEDED_TEXT}</div></div>
        ${notConfirmed ? '<div class="callout__actions"><button class="primary" data-action="deploy-retry">Retry</button></div>' : ''}
    </div>`;
}

// One quiet line when the Plugin Hub lists a newer ModPacer (state.selfUpdate); nothing at all otherwise. The link is shown only for a plain https address.
function renderSelfUpdateLine(state) {
    const el = $('selfUpdateLine');
    const s = state && state.selfUpdate;
    if (!s || !s.version) { el.innerHTML = ''; return; }
    const link = /^https:\/\//i.test(String(s.url || '')) ? ` <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">Get it</a>` : '';
    el.innerHTML = `<div class="muted" data-self-update style="margin-top:12px">ModPacer ${escapeHtml(s.version)} is available.${link}</div>`;
}

function renderDeployLine(state) {
    renderSelfUpdateLine(state);
    renderDeployLineInner(state);
    if (deployNotice && !deployBusy) $('deployLine').insertAdjacentHTML('afterbegin', deployNoticeHtml());
}

function renderDeployLineInner(state) {
    const pending = (state && state.pendingDeploy) || [];
    const cleanupText = cleanupLineText(state);
    const cleanupHtml = cleanupText ? `<div class="callout__body" data-cleanup-line>${escapeHtml(cleanupText)}</div>` : '';
    const area = updateFollow.deployArea({
        inFlight: batchRunning || singleUpdating, unfinished: updateFollow.hasUnfinished((state && state.rows) || []), pendingCount: pending.length, outcome: batchOutcome,
        dismissed: deployBannerDismissed, mo2: !!state && state.modManager === 'mo2', deployBusy, rows: (state && state.rows) || [],
    });
    if (area === 'banner-clean' || area === 'banner-partial' || area === 'banner-problem') {
        const clean = area === 'banner-clean';
        const title = clean ? 'All your mods are updated' : (area === 'banner-problem' ? 'Some mods need a look' : 'Some mods are updated');
        // One compact row: dot + title + line on the left, the two buttons on the right of the same row (DESIGN.md, "Buttons sit on the right", exception).
        $('deployLine').innerHTML = `<div class="callout ${clean && !cleanupText ? 'callout--success' : 'callout--warning'} deploy-banner">
            <div class="deploy-banner__text">
                <div class="callout__title"><span class="su-dot ${clean && !cleanupText ? 'ok' : 'warn'}"></span> ${title}</div>
                <div class="callout__body">${clean ? 'Ready to deploy in Vortex?' : 'Deploy what worked, or fix the others first.'}</div>${cleanupHtml}
            </div>
            <div class="callout__actions"><button class="btn-muted" data-action="deploy-not-yet">Not yet</button><button class="primary" data-action="deploy-now">Deploy now</button></div>
        </div>`;
    } else if (area === 'line') {
        $('deployLine').innerHTML = (cleanupText ? `<div class="muted" data-cleanup-line style="margin-top:12px">${escapeHtml(cleanupText)}</div>` : '') + `<div class="inline" style="align-items:center;justify-content:space-between;gap:12px;margin-top:12px"><span class="muted">Updated, not deployed yet.</span><button data-action="deploy-pending">Deploy</button></div>`;
    } else {
        $('deployLine').innerHTML = cleanupText ? `<div class="muted" data-cleanup-line style="margin-top:12px">${escapeHtml(cleanupText)}</div>` : '';
    }
}

// Asks the updater to check that the old downloads of updated mods are really gone, and shows "Cleaning up old downloads..." meanwhile.
// A no-op on the server when the setting is off. Never throws.
async function checkOldDownloads() {
    if (cleaningOldDownloads) return;
    cleaningOldDownloads = true;
    if (lastRenderedState) renderDeployLine(lastRenderedState);
    try { await api('POST', '/api/cleanup-old-downloads'); } catch { /* the next pass tries again */ }
    cleaningOldDownloads = false;
    await refreshState();
}

// Bring the mod being updated into view (centred), unless the player has scrolled away on their own during this batch.
function followUpdating(ids) {
    const id = updateFollow.followTarget({ updatingId, rowIds: ids, following: followBatch });
    if (!id) return;
    const el = document.querySelector(`[data-row-id="${CSS.escape(id)}"]`);
    if (!el || !el.scrollIntoView) return;
    const reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    el.scrollIntoView(updateFollow.scrollOptions(reduced));
}
// The player's own scrolling (wheel, touch, scroll keys) during a batch ends the following. The page's own scrolling fires none of these.
function playerScrolled() { followBatch = updateFollow.nextFollowing(followBatch, true); }
window.addEventListener('wheel', playerScrolled, { passive: true });
window.addEventListener('touchmove', playerScrolled, { passive: true });
window.addEventListener('keydown', (e) => {
    if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) playerScrolled();
});

// Setup left unfinished: the pop-up's saved progress, with a way back in (replaces the old bare red line).
function renderSetupBanner(state) {
    const el = $('setupBanner');
    const setup = state && state.needsSetup && state.setup;
    if (!setup) { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.style.display = '';
    el.innerHTML = `<span class="su-dot warn"></span><span>${escapeHtml(setupFlow.unfinishedText(setup.step, setup.total))}</span><button class="primary" data-action="finish-setup">Finish setup</button>`;
}

// ---- "Mods not installed" (queue: mods-not-installed-section): the Hub's external mod listings this PC does not have yet.
let nexusKeySet = false;
let currentManager = null;
let installingIds = new Set(); // Install pressed (or Install all running): shown as Downloading... until the row has its own state
let installAllBusy = false;
let installSkipNote = []; // [{ title, why }] the last Install all skipped (a note at the top of the section until the next check)
// Whether the updater can fetch this listing by itself: a GitHub link, or a Nexus link with a Nexus key set.
function hasDownload(row) { return row.urlKind === 'github' || (row.urlKind === 'nexus' && nexusKeySet); }
function installableRows(rows) {
    return (rows || []).filter((r) => r.notInstalled && r.status === 'update_available' && hasDownload(r) && !r.sameAs); // a mod ModPacer is asking about is never part of a bulk install
}
// A Hub listing whose name is close to a mod already in Vortex (lib/vortex-name-match.js): asked once, under the description.
function sameAsLine(row) {
    if (!row.sameAs) return '';
    const off = batchRunning || installAllBusy || sameAsBusy.has(row.id) ? ' disabled' : '';
    return `<div class="ni-same"><span class="ni-same-q">Is this the same as &ldquo;${escapeHtml(row.sameAs.vortexName)}&rdquo;, which you already have in Vortex?</span>`
        + `<span class="ni-same-btns"><button class="btn-muted" data-action="same-no" data-id="${escapeHtml(row.id)}"${off}>No, different</button>`
        + `<button data-action="same-yes" data-id="${escapeHtml(row.id)}"${off}>Yes, same mod</button></span></div>`;
}
const sameAsBusy = new Set();
async function answerSameAs(id, answer) {
    if (sameAsBusy.has(id)) return;
    sameAsBusy.add(id);
    if (lastRenderedState) renderPlugins(lastRenderedState);
    let state = null;
    try { state = await api('POST', `/api/plugins/${encodeURIComponent(id)}/same-as`, { answer }); } catch { state = null; }
    sameAsBusy.delete(id);
    if (!state) { try { state = await api('GET', '/api/state'); } catch { state = null; } }
    if (state) renderPlugins(state);
}
function requiresLine(row) {
    const names = row.requires || [];
    if (names.length === 0) return '';
    const list = names.map((n) => `<b>${escapeHtml(n)}</b>`).join(', ');
    return `<div class="req-warn">&#9888;&#65039; Requires ${list}. Install ${names.length === 1 ? 'it' : 'them'} before this mod.</div>`;
}
function notInstalledAction(row) {
    const mo2 = currentManager === 'mo2';
    const idAttr = `data-id="${escapeHtml(row.id)}"`;
    const inProgress = rowState.inProgressView(row);
    if (inProgress) return `<span class="pill p-dl">${escapeHtml(inProgress.label)}</span>` + (inProgress.bar != null ? `<div class="bar"><i style="width:${inProgress.bar}%"></i></div>` : '');
    if (installingIds.has(row.id) && row.status === 'update_available') return `<span class="pill p-dl">Downloading\u2026</span><div class="bar busy"><i></i></div>`;
    if (row.status === 'downloaded') {
        const work = updateWorkHtml(row);
        if (work) return work;
        if (mo2) return `<span class="pill p-done">Downloaded &#10003;</span>`;
        if (row.fomodMismatch || (row.isFomod && row.updatePreview)) return `<button class="primary" data-action="open-wizard" ${idAttr}${batchRunning ? ' disabled' : ''}>Install</button>`;
        if (row.updatePreview) return `<button class="primary" data-action="update" ${idAttr}${batchRunning ? ' disabled' : ''}>Install</button>`;
        if (row.updateUnavailableReason) return `<div class="muted" style="font-size:0.75rem;text-align:right">${escapeHtml(rowState.waitingLine(row.updateUnavailableReason, vortexStartingByPlayer))}</div>`;
        return '';
    }
    if (row.status === 'needs_you' || (row.urlKind === 'nexus' && !nexusKeySet)) {
        return webUrl(row.externalUrl) ? `<button data-action="open-link"${visitAttr(row)} data-url="${escapeHtml(webUrl(row.externalUrl))}">Open on Nexus</button>` : '';
    }
    if (!hasDownload(row)) return ''; // neither GitHub nor Nexus: only the Mod page link
    const off = downloadFolderMissing || batchRunning || installAllBusy;
    const title = downloadFolderMissing ? ' title="Pick a download folder in Settings first"' : '';
    return mo2
        ? `<button class="primary" data-action="download" ${idAttr}${off ? ' disabled' : ''}${title}>Download</button>`
        : `<button class="primary" data-action="install-new" ${idAttr}${off ? ' disabled' : ''}${title}>Install</button>`;
}
function renderNotInstalledRow(row) {
    const metaBits = [row.author ? escapeHtml(row.author) : null].filter(Boolean);
    const err = row.error ? `<div class="changes" style="color:var(${row.errorWarn ? '--status-warning' : '--status-error'})">${escapeHtml(row.error)}</div>` : '';
    const tag = row.tagline ? `<div class="tagline">${escapeHtml(row.tagline)}</div>` : '';
    const req = requiresLine(row);
    const same = sameAsLine(row);
    const more = (tag || req || same) ? `<div class="ni-more">${tag}${req}${same}</div>` : '';
    return `<div class="row" data-row-id="${escapeHtml(row.id)}">
        <div><div class="name">${escapeHtml(row.title)}${nsfwPill(row)}</div><div class="meta">${metaBits.join(' &middot; ') || '&nbsp;'}</div>${countsLine(row)}</div>
        <div><div class="ver">${escapeHtml(row.latestVersion || '?')}</div></div>
        <div class="right">${rowIconsHtml(row)}${notInstalledAction(row)}</div>
        ${more}${err}
    </div>`;
}
function notInstalledSectionHtml(state, niRows) {
    if (state.notInstalledState === 'unreadable') {
        return sectionHtml('notinstalled', 'Mods not installed', '', [], '', `<div class="note">The Hub's list couldn't be read right now.</div>`);
    }
    const mo2 = state.modManager === 'mo2';
    const eligible = installableRows(niRows);
    const installAllHtml = eligible.length > 0
        ? `<button class="primary" id="installAllBtn" data-action="install-all"${downloadFolderMissing || batchRunning || installAllBusy ? ' disabled' : ''}${downloadFolderMissing ? ' title="Pick a download folder in Settings first"' : ''}>${mo2 ? 'Download all' : 'Install all'} (${eligible.length})</button>`
        : '';
    const skipNote = installSkipNote.length > 0
        ? `<div class="note">Not installed this time: ${installSkipNote.map((s) => `${escapeHtml(s.title)} (${escapeHtml(s.why)})`).join('; ')}.</div>`
        : '';
    let body;
    if (niRows.length === 0) body = `<div class="note">Every mod in the Hub that ModPacer handles is installed.</div>`;
    else body = skipNote + niRows.map(renderNotInstalledRow).join('');
    if (!state.showAdultNotInstalled && niRows.length > 0) body = `<div class="note">Adult (NSFW) listings are hidden. You can turn them on in Settings.</div>` + body;
    return sectionHtml('notinstalled', 'Mods not installed', String(niRows.length), niRows, installAllHtml, body);
}

// SkyrimNet could not be found: one warning line, what was looked at, what ModPacer needs, and a way to point at it by hand.
function renderSkyrimNetNotFound(search) {
    const box = $('skyrimNetNotFound');
    if (!search) { box.style.display = 'none'; box.innerHTML = ''; return; }
    const list = (search.places || []).slice(0, 8).map((p) => `<li><code>${escapeHtml(p)}</code></li>`).join('');
    const more = (search.places || []).length > 8 ? `<li>and ${(search.places || []).length - 8} more</li>` : '';
    box.innerHTML = `&#9888;&#65039; ModPacer couldn't find SkyrimNet.`
        + `<div>The folder you gave it: <code>${escapeHtml(search.given || '')}</code></div>`
        + (search.chosenProblem ? `<div>&#9888;&#65039; The SkyrimNet folder you chose, <code>${escapeHtml(search.chosenProblem.folder)}</code>, isn't SkyrimNet's: ${escapeHtml(search.chosenProblem.why)}.</div>` : '')
        + `<div>It looked in:</div><ul>${list}${more}</ul>`
        + `<div>It needs a folder named <code>SkyrimNet</code> with a <code>config</code> folder inside, and either <code>content-registry.json</code> or <code>config\\SkyrimNet.yaml</code>.</div>`
        + `<div><button data-action="pick-skyrimnet">Choose the SkyrimNet folder&hellip;</button></div>`;
    box.style.display = 'block';
}

function renderPlugins(state) {
    appliedSeq = ++stateSeq; // anything asked for before this paint is older than it
    lastRenderedState = state;
    liveProgress = state.updateProgress || {};
    renderDeployLine(state);
    downloadFolderMissing = !!state.downloadFolderMissing;
    // Check now waits for setup to finish (queue: first-run-setup-steps, 2026-10-03).
    $('checkNowBtn').disabled = !!state.needsSetup;
    renderSetupBanner(state);
    const notFound = !state.needsSetup && state.error && state.skyrimNetSearch ? state.skyrimNetSearch : null;
    renderSkyrimNetNotFound(notFound);
    if (state.error || state.needsSetup) {
        $('topError').style.display = state.needsSetup || notFound ? 'none' : 'block';
        $('topError').textContent = state.needsSetup || notFound ? '' : state.error;
        $('summary').innerHTML = '';
        $('pluginList').innerHTML = '';
        $('subtitle').textContent = '';
        renderDownloadFolderBanner(false);
        renderVortexHelperBanner(null);
        renderHelperNotInstalledBanner(null);
        return;
    }
    $('topError').style.display = 'none';
    renderDownloadFolderBanner(downloadFolderMissing);
    renderVortexHelperBanner(state.modManager !== 'vortex' ? null : (vortexLostNotice ? 'vortex_running_helper_unreachable' : state.vortexHelperState));
    renderHelperNotInstalledBanner(state);

    const allRows = state.rows || [];
    const rows = allRows.filter((r) => !r.notInstalled); // the mods found in the SkyrimNet install; the not-installed listings have their own section
    const niRows = allRows.filter((r) => r.notInstalled);
    nexusKeySet = !!state.nexusKeySet;
    currentManager = state.modManager;
    $('subtitle').textContent = state.lastCheckedAt
        ? `Last checked ${new Date(state.lastCheckedAt).toLocaleTimeString()} · ${rows.length} ${plural(rows.length, 'mod', 'mods')} found in your SkyrimNet install`
        : 'Not checked yet.';

    const updates = rowState.sortGroup(rows.filter((r) => r.status === 'update_available' || r.status === 'queued' || r.status === 'downloading' || r.status === 'downloaded'), 'updates');
    const needsYou = rowState.sortGroup(rows.filter((r) => r.status === 'needs_you'), 'needsYou');
    const upToDate = rowState.sortGroup(rows.filter((r) => r.status === 'up_to_date' || r.status === 'unknown_version' || r.status === 'updated' || r.status === 'deployed'), 'upToDate');
    const notOnHub = rowState.sortGroup(rows.filter((r) => r.status === 'not_on_hub'), 'notOnHub');

    // Every tile goes to its section (queue: every-summary-tile-goes-to-its-section); one with nothing to go to is plain, with no pointer or hover text.
    const tile = (cls, target, hint, n, label) => target
        ? `<div class="stat ${cls} go" data-action="goto-section" data-target="${target}" role="button" tabindex="0" title="${hint}"><div class="n">${n}</div><div class="l">${label}</div></div>`
        : `<div class="stat ${cls}"><div class="n">${n}</div><div class="l">${label}</div></div>`;
    const upToDateCount = upToDate.filter((r) => !r.vortexWaiting).length + notOnHub.length;
    $('summary').innerHTML = [
        tile('upd', updates.length > 0 ? 'updates' : '', 'Show the mods that have updates', updates.length, `${plural(updates.length, 'Update', 'Updates')} ready`),
        tile('nx', needsYou.length > 0 ? 'nexus' : '', 'Show the mods you need to download from Nexus', needsYou.filter((r) => !r.linkOutOfDate).length, 'Download from Nexus'),
        tile('ok', upToDate.length > 0 ? 'uptodate' : (notOnHub.length > 0 ? 'nothub' : ''), 'Show the mods that are up to date', upToDateCount, 'Up to date'),
        state.notInstalledState === 'unreadable' ? '' : tile('ni', 'notinstalled', 'Show the mods that are not installed', niRows.length, 'Not installed'),
    ].join('');

    // One legend for the whole page, under the summary tiles, so it is there even when every section is closed.
    $('legendLine').innerHTML = legendHtml(allRows);

    const pendingDownloadCount = rows.filter((r) => r.status === 'update_available').length;
    $('downloadAllBtn').style.display = pendingDownloadCount > 0 ? '' : 'none';
    $('downloadAllBtn').textContent = `Download all (${pendingDownloadCount})`;
    $('downloadAllBtn').disabled = downloadFolderMissing;
    $('downloadAllBtn').title = downloadFolderMissing ? 'Pick a download folder in Settings first' : '';
    $('openDownloadFolderBtn').disabled = downloadFolderMissing;
    $('openDownloadFolderBtn').title = downloadFolderMissing ? 'Pick a download folder in Settings first' : '';

    const updateAllCount = updatableRows(rows).length;

    let html = '';
    if (updates.length > 0) {
        let updateAllHtml = '';
        if (updateAllCount > 0) {
            const disabledAttr = downloadFolderMissing ? 'disabled title="Pick a download folder in Settings first"' : (batchRunning ? 'disabled' : '');
            updateAllHtml = `<button class="primary" id="updateAllBtn" data-action="update-all" ${disabledAttr}>Update all (${updateAllCount})</button>`;
        }
        html += sectionHtml('updates', 'Updates', String(updates.length), updates, updateAllHtml, updates.map(renderRow).join(''));
    }
    if (needsYou.length > 0) html += groupHeader('Download from Nexus', needsYou, 'nexus') + needsYou.map(renderRow).join('');
    if (upToDate.length > 0) html += sectionHtml('uptodate', 'Up to date', String(upToDate.length), upToDate, '', upToDate.map(renderRow).join(''));
    if (notOnHub.length > 0) html += groupHeader('Not on the Hub', notOnHub, 'nothub') + notOnHub.map(renderRow).join('');
    html += notInstalledSectionHtml(state, niRows);
    // Before the very first check, this card would otherwise just be an empty box (director, from
    // a live screenshot, 2026-09-30: "Not checked yet.", three zeros, and nothing underneath) --
    // a quiet nudge toward the one thing that actually fixes it. Never shown once a real check has
    // ever completed (state.lastCheckedAt set), including one that genuinely found zero plugins.
    if (rows.length === 0 && !state.lastCheckedAt) {
        html = (autoCheckPending || state.checking) ? `<p class="muted">Checking for updates&hellip;</p>` : `<p class="muted">Click <b>Check now</b> to look for mod updates.</p>`;
    }
    // The automatic repeat is running (Vortex was still filling things in): say so, so it never looks stuck.
    $('retryNote').style.display = state.vortexRetrying ? '' : 'none';
    $('pluginList').innerHTML = html;

    // Also keep looking while a row is waiting on a Vortex that is still starting, so it flips to Update by itself.
    const stillWorking = batchRunning || singleUpdating || installingIds.size > 0 || Object.keys(liveProgress).length > 0 || allRows.some((r) => r.status === 'queued' || r.status === 'downloading') || rows.some((r) => r.vortexWaiting) || state.vortexRetrying || state.vortexHelperState === 'vortex_running_helper_unreachable' || state.checking || rows.some((r) => r.status === 'queued' || r.status === 'downloading' || (r.status === 'downloaded' && !r.updatePreview && /^Waiting for Vortex/.test(r.updateUnavailableReason || '')));
    if (stillWorking && !pollTimer) pollTimer = setInterval(pollTick, 1000);
    if (!stillWorking && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

let stateSeq = 0, appliedSeq = 0, pollBusy = false;
async function refreshState({ ordered = false } = {}) { // ordered: the timer's poll, which must never paint over something newer
    const busyBefore = batchRunning || singleUpdating;
    const seq = ++stateSeq;
    const state = await api('GET', '/api/state');
    // A reply that was asked for while an update was running and arrives after it ended is out of date: whoever ended it refreshes itself.
    if (busyBefore !== (batchRunning || singleUpdating)) return;
    // Replies can arrive out of order when Vortex is slow: an older one never paints over a newer one that already did.
    if (ordered && seq < appliedSeq) return;
    renderPlugins(state);
}
// The timer's own refresh: never a second one while the last is still waiting.
function pollTick() {
    if (pollBusy) return;
    pollBusy = true;
    refreshState({ ordered: true }).catch(() => {}).finally(() => { pollBusy = false; });
}

$('checkNowBtn').addEventListener('click', async () => {
    $('checkNowBtn').disabled = true;
    vortexLostNotice = false;
    dropLeftover();
    // Vortex chosen, Helper installed, Vortex closed: ask to start it first (re-armed by this click).
    // Cancel just carries on with the normal check, exactly as when Vortex isn't open.
    await startVortexFlow.prompt({ rearm: true, blocked: modManagerPopupOpen() });
    // The "click Check now" hint disappears the moment a check actually starts, not only once
    // results land -- it would be a strange thing to still be telling the player to do right as
    // they're doing it.
    $('pluginList').innerHTML = `<p class="muted">Checking for updates&hellip;</p>`;
    try {
        const state = await api('POST', '/api/check', { force: true });
        renderPlugins(state);
    } catch (e) {
        $('topError').style.display = 'block';
        $('topError').textContent = e.message;
        // The check never actually completed -- show whatever's really true server-side (the
        // "Checking..." message above must not just sit there forever) rather than guessing.
        refreshState();
    } finally {
        $('checkNowBtn').disabled = false;
    }
});

$('downloadAllBtn').addEventListener('click', async () => {
    dropLeftover();
    const state = await api('GET', '/api/state');
    const pending = (state.rows || []).filter((r) => r.status === 'update_available' && !r.notInstalled); // the not-installed listings have their own Install
    await Promise.all(pending.map((r) => api('POST', `/api/plugins/${encodeURIComponent(r.id)}/download`)));
    refreshState();
});

// One button for the whole folder, replacing the earlier per-row "Show in folder" link (director,
// from a live screenshot: it rendered in the browser's own default blue/underlined style, not the
// theme, and repeated the same thing on every row once several updates shared one folder).
$('openDownloadFolderBtn').addEventListener('click', async () => {
    try {
        await api('POST', '/api/open-download-folder');
    } catch (err) {
        alert(err.message);
    }
});

// Opens the folder that holds the log (update.log) in Explorer, to send us when something goes wrong. Same pattern as the download folder.
$('openLogFolderBtn').addEventListener('click', async () => {
    try {
        await api('POST', '/api/open-log-folder');
    } catch (err) {
        alert(err.message);
    }
});

// Tells the plugins page a mod's own page was opened (the Mod page arrow, Open on Nexus). Fire and forget: never awaited, never shown, never blocks
// the link. The server ignores a second click on the same mod within 10 seconds, and does nothing when the Settings switch is off.
function sendVisit(id) {
    if (!id) return;
    try { modpacerFetch(`/api/plugins/${encodeURIComponent(id)}/visit`, { method: 'POST', keepalive: true }).catch(() => {}); } catch { /* the link still opens */ }
}
document.addEventListener('click', (e) => {
    const a = e.target.closest ? e.target.closest('a[data-visit-id]') : null;
    if (a) sendVisit(a.dataset.visitId); // no preventDefault: the browser opens the page itself
});

document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'download') {
        e.preventDefault();
        dropLeftover();
        await api('POST', `/api/plugins/${encodeURIComponent(el.dataset.id)}/download`);
        refreshState();
    } else if (action === 'open-link') {
        e.preventDefault();
        sendVisit(el.dataset.visitId); // the count goes out in the background; the page opens right now, from this click
        const target = webUrl(el.dataset.url);
        if (target) window.open(target, '_blank', 'noopener,noreferrer');
    } else if (action === 'open-helper-zip') {
        e.preventDefault();
        await openHelperZipClick();
    } else if (action === 'finish-setup') {
        e.preventDefault();
        const setup = lastRenderedState && lastRenderedState.setup;
        await setupUi.open({ step: setup && setup.step ? setup.step : 1 });
    } else if (action === 'pick-skyrimnet') {
        e.preventDefault();
        const { path } = await api('POST', '/api/settings/browse-folder', { title: 'Choose the SkyrimNet folder (the one with a config folder inside)' });
        if (!path) return;
        await api('POST', '/api/settings', { skyrimNetFolder: path });
        loadTheme();
        renderPlugins(await api('POST', '/api/check', { force: false }));
    } else if (action === 'goto-settings') {
        e.preventDefault();
        document.querySelector('.tab[data-tab="settings"]').click();
    } else if (action === 'toggle-changes') {
        e.preventDefault();
        const target = $(el.dataset.target);
        if (!target) return;
        const collapsed = target.classList.toggle('ch-collapsed');
        el.textContent = collapsed ? 'Show more' : 'Show less';
    } else if (action === 'toggle-section') {
        e.preventDefault();
        setSectionOpen(el.dataset.section, !sectionState[el.dataset.section]);
    } else if (action === 'goto-section') {
        e.preventDefault();
        const key = el.dataset.target;
        if (key in SECTION_DEFAULTS) setSectionOpen(key, true);
        const dest = document.querySelector(`.sec[data-section="${key}"], [data-group="${key}"]`);
        if (dest && dest.scrollIntoView) dest.scrollIntoView({ block: 'start', behavior: (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ? 'auto' : 'smooth' });
    } else if (action === 'same-yes' || action === 'same-no') {
        e.preventDefault();
        await answerSameAs(el.dataset.id, action === 'same-yes' ? 'yes' : 'no');
    } else if (action === 'install-new') {
        e.preventDefault();
        await installNewClick(el.dataset.id);
    } else if (action === 'install-all') {
        e.preventDefault();
        await openConfirmInstallAll();
    } else if (action === 'update') {
        e.preventDefault();
        const id = el.dataset.id;
        markWorking([id]); // the row changes at once, before anything is read from Vortex
        let gate = 'cancel', kept = false;
        try {
            gate = await disabledGate([id]);
            if (gate === 'chosen') { kept = true; workingDone([id], { render: false }); await runSingleUpdate(id); } // the question was the confirmation; it sets the working state itself, no flicker
            else if (gate === 'none') await openConfirm(id); // the confirm card is up when this returns
        } finally { if (!kept) workingDone([id]); }
    } else if (action === 'open-wizard') {
        e.preventDefault();
        const id = el.dataset.id;
        markWorking([id]);
        let gate = 'cancel';
        try { gate = await disabledGate([id]); } finally { workingDone([id], { render: gate === 'cancel' }); }
        if (gate === 'cancel') return;
        await pickOptionsClick(id);
    } else if (action === 'update-all') {
        e.preventDefault();
        await openConfirmAll();
    } else if (action === 'retry-carry-over') {
        e.preventDefault();
        const retryId = el.dataset.id;
        markWorking([retryId]); // the row says it is working while the old copy is removed again
        let reply = null;
        try { reply = await api('POST', `/api/plugins/${encodeURIComponent(retryId)}/retry-carry-over`); }
        finally { workingDone([retryId], { render: false }); }
        if (lostVortex(reply && reply.result)) vortexLostNotice = true;
        await refreshState();
        if (reply && reply.result && reply.result.ok) await checkOldDownloads();
    } else if (action === 'retry-helper') {
        e.preventDefault();
        await retryHelperClick();
    } else if (action === 'deploy-now') {
        e.preventDefault();
        const pending = ((lastRenderedState && lastRenderedState.pendingDeploy) || []);
        batchOutcome = null;
        await askDeploy({ ids: pending.map((p) => p.pluginId), titles: pending.map((p) => p.title), allOk: true, skipAsk: true });
    } else if (action === 'deploy-retry') {
        e.preventDefault();
        const pending = ((lastRenderedState && lastRenderedState.pendingDeploy) || []);
        await askDeploy({ ids: pending.map((p) => p.pluginId), titles: pending.map((p) => p.title), allOk: true, skipAsk: true });
    } else if (action === 'deploy-not-yet') {
        e.preventDefault();
        deployBannerDismissed = true;
        if (lastRenderedState) renderDeployLine(lastRenderedState);
    } else if (action === 'deploy-pending') {
        e.preventDefault();
        const pending = ((lastRenderedState && lastRenderedState.pendingDeploy) || []);
        await askDeploy({ ids: pending.map((p) => p.pluginId), titles: pending.map((p) => p.title), allOk: true });
    }
});

let confirmPluginId = null;
let confirmBatchIds = null; // set while the confirm box is for "Update all"
let confirmInstallAll = null; // set while the confirm box is for "Install all": { ids, skipped }
// What an updating row shows in place of its button: ONE word the whole time, with an honest moving bar (never a percentage): "Updating…" for a
// mod that replaces an installed one, "Installing…" for one that is new to Vortex (the same fact that decides the button's word). It appears the
// instant the button is pressed and stays until the update is done ("Updated ✓" / "Installed ✓") or fails; the fine steps live in logs/update.log
// only. If Vortex stopped answering it adds a "Waiting for Vortex…" note; if Vortex shows a dialog that blocks it, that is named. A row still
// waiting its turn in Update all says "Waiting…".
// workingIds: rows whose Update was just pressed, while the page reads Vortex (is the mod disabled?) or fetches what the confirm card needs.
const workingIds = new Set();
function workLabel(row) { return (row.updatePreview && row.updatePreview.notInVortex) || row.notInstalled ? 'Installing…' : 'Updating…'; }
function markWorking(ids) { for (const id of ids) workingIds.add(id); if (lastRenderedState) renderPlugins(lastRenderedState); }
function workingDone(ids, { render = true } = {}) { for (const id of ids) workingIds.delete(id); if (render && lastRenderedState) renderPlugins(lastRenderedState); }
function updateWorkHtml(row) {
    const prog = liveProgress[row.id];
    const note = (text) => `<div class="muted" style="font-size:0.75rem;text-align:right">${escapeHtml(text)}</div>`;
    if (prog && prog.waiting) return `<span class="pill p-dl">${escapeHtml(workLabel(row))}</span>` + note('Waiting for Vortex…');
    if (prog || row.id === updatingId || workingIds.has(row.id)) {
        const label = workLabel(row);
        const blocked = prog && prog.blockedBy ? note(`Vortex is waiting on you — check its window (${prog.blockedBy}) to continue.`) : '';
        return `<span class="pill p-dl" data-update-step>${escapeHtml(label)}</span><div class="bar busy"><i></i></div>${blocked}`;
    }
    if (batchWaiting.has(row.id)) return `<span class="pill p-dl">Waiting…</span>`;
    return '';
}
// A mod that is not in Vortex yet: the button says Install, and a short note says why.
function updateLabel(row) { return row.updatePreview && row.updatePreview.notInVortex ? 'Install' : 'Update'; }
function notInVortexNote(row) {
    return (row.updatePreview && row.updatePreview.notInVortex) || row.notInVortex ? `<div class="muted" style="font-size:0.75rem;text-align:right">Not in Vortex</div>` : '';
}
// Next to an installed mod: nothing when plugins were turned on (only trouble gets a line): one short amber line when none of them could be.
function pluginsNoteHtml(row) {
    return row.pluginsAllFailed ? `<div class="req-warn" data-plugins-note style="text-align:right">&#9888;&#65039; Couldn't turn on the plugins. Check Vortex's plugin list.</div>` : '';
}
function previousVersionText(cfg) { return cfg.deleteOldDownloadAfterUpdate ? 'Delete' : 'Keep'; }
function collectionLineHtml(row) {
    return row.updatePreview.collectionNames.length > 0 ? `<b>${escapeHtml(row.updatePreview.collectionNames.join(', '))}</b>` : 'None';
}
async function openConfirm(id) {
    const state = await api('GET', '/api/state');
    const row = (state.rows || []).find((r) => r.id === id);
    if (!row || !row.updatePreview) return;
    confirmPluginId = id;
    confirmBatchIds = null; confirmInstallAll = null;
    // Reads the live setting each time, so the Previous version line always matches Settings.
    const cfg = await api('GET', '/api/settings');
    setClamped($('confirmTitle'), row.title);
    $('confirmUpdateBtn').textContent = updateLabel(row);
    $('confirmBody').innerHTML = row.updatePreview.notInVortex ? `
        <div class="label">Install</div><div class="one-line" title="${escapeHtml(row.latestVersion)}">${escapeHtml(row.latestVersion)}</div>
        <div class="label">In Vortex</div><div class="clamp2" title="Not there yet, so it's added as a new mod">Not there yet, so it's added as a new mod</div>
    ` : `
        <div class="label">Update to</div><div class="one-line" title="${escapeHtml(row.latestVersion)}">${escapeHtml(row.latestVersion)}</div>
        <div class="label">Collection</div><div class="clamp2">${collectionLineHtml(row)}</div>
        <div class="label">Previous version</div><div>${previousVersionText(cfg)}</div>
    `;
    $('confirmOverlay').style.display = 'flex';
}

// "Update all": one short confirm for the whole batch -- just the question and the two buttons (director,
// 2026-10-01: listing every mod gets long with 5+ of them; the rows behind it already show what will update).
// "This mod is currently disabled. Do you want to enable it or keep it disabled?" Asked right before an update starts, from what Vortex says
// at that moment. Resolves 'none' (nothing to ask), 'cancel' (nothing starts) or 'chosen' (the answer is saved for every disabled mod in ids).
async function disabledGate(ids, { batch = false } = {}) {
    let disabled = [];
    try { disabled = (await api('POST', '/api/disabled-mods', { ids })).disabled || []; } catch { disabled = []; }
    if (disabled.length === 0) return 'none';
    const text = batch
        ? `These mods are currently disabled: ${disabled.map((d) => d.title).join(', ')}. Do you want to enable them or keep them disabled?`
        : 'This mod is currently disabled. Do you want to enable it or keep it disabled?';
    const choice = await new Promise((resolve) => {
        const overlay = $('disabledOverlay');
        const p = $('disabledText');
        p.textContent = text; p.title = text; // clamped to three lines: the full text is the tooltip
        overlay.style.display = 'flex';
        const done = (v) => {
            overlay.style.display = 'none';
            document.removeEventListener('keydown', onKey, true);
            overlay.onclick = $('disabledCancelBtn').onclick = $('disabledKeepBtn').onclick = $('disabledEnableBtn').onclick = null;
            resolve(v);
        };
        const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
        document.addEventListener('keydown', onKey, true);
        overlay.onclick = (e) => { if (e.target === overlay) done(null); };
        $('disabledCancelBtn').onclick = () => done(null);
        $('disabledKeepBtn').onclick = () => done('keep');
        $('disabledEnableBtn').onclick = () => done('enable');
        $('disabledEnableBtn').focus();
    });
    if (!choice) return 'cancel';
    try { await api('POST', '/api/disabled-choice', { ids: disabled.map((d) => d.id), choice }); } catch { return 'cancel'; }
    return 'chosen';
}

async function openConfirmAll() {
    if (batchRunning) return;
    // Every row that would update changes at once ("Checking Vortex…"), before the list is fetched or Vortex is read.
    const shownIds = updatableRows((lastRenderedState && lastRenderedState.rows) || []).map((r) => r.id);
    markWorking(shownIds);
    let ids = shownIds, started = false;
    try {
        const state = await api('GET', '/api/state');
        const rows = updatableRows(state.rows);
        ids = rows.map((r) => r.id);
        if (rows.length === 0) { workingDone(shownIds, { render: false }); renderPlugins(state); return; }
        const gate = await disabledGate(ids, { batch: true });
        if (gate === 'cancel') return;
        if (gate === 'chosen') { started = true; workingDone(shownIds.concat(ids), { render: false }); dropLeftover(); await runUpdateBatch(ids); return; } // the question was the confirmation; the batch paints each row itself
        confirmPluginId = null;
        confirmBatchIds = ids;
        $('confirmTitle').textContent = `Ready to update ${rows.length} ${plural(rows.length, 'mod', 'mods')}?`;
        $('confirmUpdateBtn').textContent = 'Update all';
        $('confirmBody').innerHTML = '';
        $('confirmOverlay').style.display = 'flex';
    } finally { workingDone(shownIds.concat(ids), { render: !started }); }
}

// The reasons that mean Vortex stopped answering (as opposed to this one mod failing).
const VORTEX_LOST_REASONS = ['vortex_not_running', 'vortex_running_helper_unreachable', 'vortex_starting', 'helper_unavailable', 'helper_not_installed'];
function lostVortex(result) {
    return !!(result && result.ok === false && VORTEX_LOST_REASONS.includes(result.reason));
}

// Runs the batch one mod at a time, in order. Each row shows "Updating..." in place of its button while it
// runs and ends as updated (or with its own error: one failure never stops the rest). If Vortex stops
// answering, it stops right there, leaves the remaining rows exactly as they were, and shows the
// "Vortex is open, but..." notice.
async function runUpdateBatch(ids, { onStep } = {}) {
    batchRunning = true;
    vortexLostNotice = false;
    followBatch = true;
    batchOutcome = null;
    deployBannerDismissed = false;
    const summary = { attempted: ids.length, updated: [], skipped: [], titles: [], lost: false };
    batchWaiting = new Set(ids);
    try {
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            if (onStep) onStep(ids.length - i);
            updatingId = id;
            batchWaiting.delete(id);
            if (lastRenderedState) renderPlugins(lastRenderedState);
            followUpdating(ids);
            let reply;
            let skippedThisOne = false;
            try {
                // A FOMOD mod pauses the batch on its options screen; confirming installs it, Skip leaves it for later.
                const rowNow = ((lastRenderedState && lastRenderedState.rows) || []).find((r) => r.id === id);
                let needsScreen = !!(rowNow && rowNow.isFomod);
                for (;;) {
                    if (needsScreen) {
                        const w = await openWizard(id, { batch: true });
                        if (w.outcome === 'skipped') { skippedThisOne = true; break; }
                        if (w.outcome === 'error') throw new Error(w.error);
                        if (w.outcome === 'finished' || w.outcome === 'lost') { reply = w.reply; break; }
                        needsScreen = false; // it turned out not to be a FOMOD: a plain update
                    }
                    reply = await api('POST', `/api/plugins/${encodeURIComponent(id)}/update`);
                    if (reply && reply.result && reply.result.reason === 'fomod_mismatch' && !needsScreen) { needsScreen = true; continue; }
                    break;
                }
            } catch (err) {
                $('topError').style.display = 'block';
                $('topError').textContent = err.message;
                break;
            }
            if (skippedThisOne) {
                summary.skipped.push(id);
                try { renderPlugins(await api('GET', '/api/state')); } catch { /* the final refresh below covers it */ }
                continue;
            }
            if (lostVortex(reply && reply.result)) {
                vortexLostNotice = true; summary.lost = true;
                retryStage = 'idle';
                leftover = { ids: ids.slice(i) }; // this one (in flight) first, then the rest, in order
                break;
            }
            if (reply && reply.result && reply.result.ok) { summary.updated.push(id); summary.titles.push((reply.row && reply.row.title) || id); }
            // Fresh rows (this one is now updated, or shows its own error) before the next one starts.
            try { renderPlugins(await api('GET', '/api/state')); } catch { /* the final refresh below covers it */ }
        }
        if (!summary.lost && summary.updated.length > 0) batchOutcome = { attempted: summary.attempted, updated: summary.updated.length, ids: ids.slice(), skippedIds: summary.skipped.slice() };
    } finally {
        batchRunning = false;
        followBatch = false;
        updatingId = null;
        batchWaiting = new Set();
        await refreshState();
    }
    if (summary.updated.length > 0) await checkOldDownloads();
    return summary;
}

$('confirmCancelBtn').addEventListener('click', () => { $('confirmOverlay').style.display = 'none'; confirmBatchIds = null; confirmInstallAll = null; });
$('confirmUpdateBtn').addEventListener('click', async () => {
    $('confirmOverlay').style.display = 'none';
    if (confirmInstallAll) {
        const plan = confirmInstallAll;
        confirmInstallAll = null;
        await runInstallAll(plan);
        return;
    }
    if (confirmBatchIds) {
        const ids = confirmBatchIds;
        confirmBatchIds = null;
        // Updates never deploy by themselves: when the whole batch is done the page shows the Deploy banner (renderDeployLine).
        dropLeftover();
        await runUpdateBatch(ids);
        return;
    }
    if (!confirmPluginId) return;
    await runSingleUpdate(confirmPluginId);
});

// One mod's own Update / Install, start to finish (the confirm card's button, and Install on a Mods-not-installed row, both end here).
async function runSingleUpdate(id) {
    dropLeftover();
    singleUpdating = true;
    // The button changes at once, before the request goes out.
    updatingId = id;
    if (lastRenderedState) renderPlugins(lastRenderedState);
    let reply;
    try {
        reply = await api('POST', `/api/plugins/${encodeURIComponent(id)}/update`);
    } finally {
        singleUpdating = false;
        updatingId = null;
    }
    if (reply && reply.result && reply.result.reason === 'fomod_mismatch') { await refreshState(); await pickOptionsClick(id); return; }
    if (lostVortex(reply && reply.result)) { vortexLostNotice = true; retryStage = 'idle'; leftover = { ids: [id] }; } else vortexLostNotice = false;
    await refreshState();
    if (reply && reply.result && reply.result.ok) {
        checkOldDownloads(); // in the background: the deploy question does not wait for Vortex
        // A mod that was left disabled has nothing to deploy: no question.
        if (reply.result.wasEnabled !== false) await askDeploy({ ids: [id], titles: [(reply.row && reply.row.title) || id], allOk: true });
    }
}

// Install on one Mods-not-installed row: download the latest release, then the same install an update does (a FOMOD still shows its
// options screen first, the deploy question follows). The row says Downloading... from the first moment.
async function installNewClick(id) {
    dropLeftover();
    installingIds.add(id);
    if (lastRenderedState) renderPlugins(lastRenderedState);
    try { await api('POST', `/api/plugins/${encodeURIComponent(id)}/download`); } catch { /* the row shows its own error */ }
    let state;
    try { state = await api('GET', '/api/state'); } catch { state = null; }
    installingIds.delete(id);
    if (state) renderPlugins(state);
    const row = state && (state.rows || []).find((r) => r.id === id);
    if (!row || row.status !== 'downloaded') return;
    await runSingleUpdate(id);
}

// Install all (Download all under Mod Organizer 2): asks first, then downloads each, then installs them one after another with the same
// machinery as Update all (pauses on each FOMOD screen, live steps, the finished banner and the deploy question at the end).
function installSkipWhy(row) {
    if (row.urlKind === 'nexus') return 'it is only on Nexus (no Premium key)';
    return 'it has no download ModPacer can use';
}
async function openConfirmInstallAll() {
    if (batchRunning || installAllBusy) return;
    const state = await api('GET', '/api/state');
    const ni = (state.rows || []).filter((r) => r.notInstalled && r.status === 'update_available' && !r.sameAs);
    const mo2 = state.modManager === 'mo2';
    const eligible = ni.filter(hasDownload);
    if (eligible.length === 0) { renderPlugins(state); return; }
    const skipped = ni.filter((r) => !hasDownload(r));
    const needs = eligible.filter((r) => (r.requires || []).length > 0);
    const n = eligible.length;
    confirmPluginId = null;
    confirmBatchIds = null; confirmInstallAll = null;
    confirmInstallAll = { ids: eligible.map((r) => r.id), skipped: skipped.map((r) => ({ id: r.id, title: r.title, why: installSkipWhy(r) })) };
    $('confirmTitle').textContent = `${mo2 ? 'Download' : 'Install'} ${n} ${plural(n, 'mod', 'mods')}?`;
    $('confirmUpdateBtn').textContent = `${mo2 ? 'Download' : 'Install'} ${n}`;
    const items = [];
    items.push(`<li>${eligible.map((r) => escapeHtml(r.title)).join(', ')}</li>`);
    for (const r of needs) items.push(`<li>${escapeHtml(r.title)} needs ${r.requires.map(escapeHtml).join(', ')}. Install ${r.requires.length === 1 ? 'it' : 'what they require'} first.</li>`);
    for (const s of confirmInstallAll.skipped) items.push(`<li>${escapeHtml(s.title)} will not be ${mo2 ? 'downloaded' : 'installed'}: ${escapeHtml(s.why)}.</li>`);
    $('confirmBody').innerHTML = `<div style="grid-column:1/-1"><div class="note">${mo2 ? 'They are downloaded to your downloads folder one after another. Adding them in Mod Organizer 2 is up to you.' : 'They are added to Vortex one after another. Mods with options show their options screen, and any that need a manual step are skipped and listed at the end.'}</div><ul class="confirm-list">${items.join('')}</ul></div>`;
    $('confirmOverlay').style.display = 'flex';
}
async function runInstallAll(plan) {
    dropLeftover();
    installAllBusy = true;
    installSkipNote = plan.skipped.map((s) => ({ title: s.title, why: s.why }));
    plan.ids.forEach((id) => installingIds.add(id));
    if (lastRenderedState) renderPlugins(lastRenderedState);
    try { await Promise.all(plan.ids.map((id) => api('POST', `/api/plugins/${encodeURIComponent(id)}/download`).catch(() => null))); } catch { /* each row shows its own error */ }
    let state;
    try { state = await api('GET', '/api/state'); } catch { state = null; }
    plan.ids.forEach((id) => installingIds.delete(id));
    installAllBusy = false;
    if (state) renderPlugins(state);
    const mo2 = !!state && state.modManager === 'mo2';
    if (mo2) return; // Mod Organizer 2: downloaded, nothing more for the updater to do
    const byId = new Map(((state && state.rows) || []).map((r) => [r.id, r]));
    const ready = plan.ids.filter((id) => byId.get(id) && byId.get(id).status === 'downloaded');
    const failedDownloads = plan.ids.filter((id) => !ready.includes(id));
    if (ready.length === 0) return;
    await runUpdateBatch(ready);
    // Anything skipped (a manual step) or not downloaded makes the finished banner amber, never a clean tick.
    if (batchOutcome && (plan.skipped.length > 0 || failedDownloads.length > 0)) {
        batchOutcome.attempted += plan.skipped.length + failedDownloads.length;
        batchOutcome.ids = batchOutcome.ids.concat(plan.skipped.map((s) => s.id), failedDownloads);
        if (lastRenderedState) renderDeployLine(lastRenderedState);
    }
}
// Keyboard: Enter / Space on a section header or a summary tile does what a click does.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target && e.target.closest && e.target.closest('[data-action="toggle-section"], [data-action="goto-section"]');
    if (el && e.target === el) { e.preventDefault(); el.click(); }
});

// --- Deploy popup (queue: deploy-really-deploys-with-live-progress, 2026-10-04; asking first: update-delete-old-and-deploy-ask) ---
// Updates don't deploy by themselves. After an update (or a whole Update all) the player is asked once; Cancel leaves the mods
// waiting (a small Deploy button stays on the summary line); Deploy runs Vortex's REAL full deploy through the Helper (one at a
// time -- there is no lighter one) and shows what the Helper really reports: its own words, its percentage only when it gives one
// (else the honest moving bar), the time passed, and -- when Vortex is stopped on a dialog -- which one. The rows turn Deployed only
// when Vortex agrees; otherwise an amber line says so (deployNotice) and the mods keep waiting.
function deployQuestion({ titles, allOk }) {
    if (titles.length === 1) return `${titles[0]} has been updated. Would you like to deploy it?`;
    return allOk ? 'All mods have been updated. Would you like to deploy them?' : `${titles.length} ${plural(titles.length, 'mod has', 'mods have')} been updated. Would you like to deploy them?`;
}
function showDeployStage(stage) {
    $('deployAsk').style.display = stage === 'ask' ? '' : 'none';
    $('deployBusy').style.display = stage === 'busy' ? '' : 'none';
    $('deployFailed').style.display = stage === 'failed' ? '' : 'none';
    $('deployDone').style.display = stage === 'done' ? '' : 'none';
    $('deployElapsed').style.display = stage === 'busy' ? '' : 'none';
}
// A long name or status never resizes a pop-up: the text is clamped (one or two lines, an ellipsis) and the full text is the hover and the focus tooltip.
function setClamped(el, text) { el.textContent = text; el.title = text; }
function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
// What the Deploying... box shows: snap = the server's latest report (null before the first), startedAt = when it began (page clock).
function paintDeployBusy(snap, startedAt) {
    $('deployElapsed').textContent = `Elapsed ${formatElapsed(Date.now() - startedAt)}`;
    setClamped($('deployLive'), (snap && snap.text) || '');
    const bar = $('deployBar');
    const percent = snap && typeof snap.percent === 'number' && snap.percent > 0 ? Math.min(100, snap.percent) : null;
    bar.classList.toggle('busy', percent === null);
    bar.firstElementChild.style.width = percent === null ? '' : `${percent}%`;
    const blocked = $('deployBlocked');
    if (snap && snap.blockedBy) {
        // Takes the place of the live text, inside the same two-line area, so the pop-up is the same size either way.
        setClamped(blocked, `Vortex is waiting on you — check its window (${snap.blockedBy}) to continue.`);
        blocked.style.display = '';
        $('deployLive').style.display = 'none';
    } else {
        blocked.style.display = 'none';
        $('deployLive').style.display = '';
    }
}
// Follows the one running deploy until it ends; resolves with the server's final report. A page that cannot reach the updater's own
// server for a long stretch (about a minute) gives up as "not confirmed".
async function followDeploy() {
    let snap = null;
    let startedAt = Date.now();
    let misses = 0;
    const clock = setInterval(() => paintDeployBusy(snap, startedAt), 1000);
    try {
        for (;;) {
            try {
                snap = await api('GET', '/api/deploy/progress');
                misses = 0;
                if (snap.elapsedMs != null) startedAt = Date.now() - snap.elapsedMs;
            } catch { misses++; }
            if (snap && snap.state === 'done') return snap;
            if (misses > 60 || (snap && snap.state === 'idle')) return { state: 'done', outcome: 'not_confirmed' };
            paintDeployBusy(snap, startedAt);
            await new Promise((r) => setTimeout(r, window.DEPLOY_POLL_MS || 1000)); // (window.DEPLOY_POLL_MS: tests only)
        }
    } finally { clearInterval(clock); }
}
// Resolves when the popup closes (deployed, ended with an amber note, or cancelled).
// skipAsk: the player already said "Deploy now" on the banner, so go straight to Deploying.
// follow: a deploy is already running (the page was reloaded), so just follow it.
function askDeploy({ ids, titles, allOk, skipAsk, follow }) {
    if (deployBusy || !ids || ids.length === 0) return Promise.resolve();
    // No Deploy offer while any update is unfinished (a row that says Try again): its own sentence is the only thing to act on.
    if (lastRenderedState && updateFollow.hasUnfinished(lastRenderedState.rows || [])) return Promise.resolve();
    deployBusy = true;
    deployNotice = null;
    if (lastRenderedState) renderDeployLine(lastRenderedState);
    setClamped($('deployText'), deployQuestion({ titles, allOk }));
    showDeployStage('ask');
    $('deployOverlay').style.display = 'flex';
    return new Promise((resolve) => {
        const close = async () => {
            $('deployOverlay').style.display = 'none';
            deployBusy = false;
            await refreshState();
            resolve();
        };
        const failed = (text) => { setClamped($('deployFailedText'), text); showDeployStage('failed'); };
        let following = !!follow;
        const run = async () => {
            deployNotice = null;
            showDeployStage('busy');
            paintDeployBusy(null, Date.now());
            if (!following) {
                let started;
                try { started = await api('POST', '/api/deploy'); } catch (e) { started = /already in progress/i.test(e.message) ? { busy: true } : { ok: false }; }
                if (started && started.ok === false) { failed(DEPLOY_FAILED_TEXT); return; }
            }
            following = false; // a Retry always starts a fresh deploy
            const end = await followDeploy();
            if (end.outcome === 'confirmed') {
                // Finished well: one friendly reminder (Vortex keeps new plugins off until they are enabled; the updater does not enable them).
                // The deploy is over, so the page carries on behind the note (rows turn Deployed, the next deploy can start); OK just closes it.
                $('deployDoneText').textContent = DEPLOY_DONE_TEXT;
                $('deployDoneNote').style.display = end.pluginsAllOn ? 'none' : '';
                showDeployStage('done');
                $('deployDoneBtn').onclick = () => { $('deployOverlay').style.display = 'none'; };
                deployBusy = false;
                await refreshState();
                resolve();
                return;
            }
            if (end.outcome === 'failed') { failed(end.code === 'deploy-blocked-by-cycles' && end.error ? end.error : DEPLOY_FAILED_TEXT); return; }
            if (end.outcome === 'not_answering') {
                // Vortex never answered the start within the patience time: the existing "Vortex isn't answering" banner (with Retry); the Deploy button stays.
                vortexLostNotice = true; retryStage = 'idle'; deployNotice = null;
                await close();
                return;
            }
            deployNotice = end.outcome === 'still_needed' ? 'still_needed' : 'not_confirmed';
            await close();
        };
        $('deployCancelBtn').onclick = close;
        $('deployFailCancelBtn').onclick = close;
        $('deployConfirmBtn').onclick = run;
        $('deployRetryBtn').onclick = run;
        if (skipAsk) run();
    });
}

// --- The FOMOD screen ---
// The picker itself (split view, image, description, step logic) is web/public/fomod-picker.js, ported from Vortex
// Collection Tools. This is only the glue: ask the server for the screen's data, show it, and on Finish send the picks.
let wizardPluginId = null;
let wizardNeed = null;

function releaseFomodImages(id, need) {
    if (!need || !need.imageCacheToken) return;
    modpacerFetch('/api/fomod-image-cleanup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modId: id, imageCacheToken: need.imageCacheToken }),
    }).catch(() => {});
}

// Opens the FOMOD screen for one mod: the new options with the old choices pre-filled, nothing installed yet. Finish
// installs what was confirmed. Resolves when the screen closes:
// { outcome: 'finished' | 'skipped' | 'cancelled' | 'none' | 'lost' | 'error', reply?, error? }.
//   none: the archive turned out not to be a FOMOD; lost: Vortex stopped answering.
async function openWizard(id, { batch = false } = {}) {
    let reply;
    try { reply = await api('POST', `/api/plugins/${encodeURIComponent(id)}/wizard`); } catch (err) { return { outcome: 'error', error: err.message }; }
    if (lostVortex(reply && reply.result)) return { outcome: 'lost', reply };
    const need = reply && reply.result && reply.result.picker;
    if (!need || !need.parsedFomod || need.parsedFomod.installSteps.length === 0) return { outcome: 'none', reply };
    wizardPluginId = id;
    wizardNeed = need;
    return new Promise((resolve) => {
        const settle = (result) => { releaseFomodImages(id, need); wizardPluginId = null; wizardNeed = null; resolve(result); };
        window.showFomodPicker(need, {
            title: `Install options — ${reply.row.title}`,
            batch,
            onCancel: () => settle({ outcome: 'cancelled' }),
            onSkip: () => settle({ outcome: 'skipped' }),
            onDone: async (picks) => {
                // Finish: install what the player confirmed.
                if (!batch) { singleUpdating = true; if (lastRenderedState) renderDeployLine(lastRenderedState); }
                let outcome;
                try {
                    const done = await api('POST', `/api/plugins/${encodeURIComponent(id)}/finish-wizard`, { picks });
                    outcome = { outcome: lostVortex(done && done.result) ? 'lost' : 'finished', reply: done };
                } catch (err) {
                    outcome = { outcome: 'error', error: err.message };
                } finally {
                    if (!batch) singleUpdating = false;
                }
                settle(outcome);
            },
        });
    });
}

// Pressing a FOMOD row's Update (its own button, with the FOMOD icon): the screen first, the install only on Finish.
async function pickOptionsClick(id) {
    dropLeftover();
    const w = await openWizard(id);
    if (w.outcome === 'none') { await openConfirm(id); return; } // not a FOMOD after all: the normal update
    if (w.outcome === 'error') { $('topError').style.display = 'block'; $('topError').textContent = w.error; await refreshState(); return; }
    if (w.outcome === 'cancelled') { await refreshState(); return; } // untouched
    if (w.outcome === 'lost') { vortexLostNotice = true; retryStage = 'idle'; leftover = { ids: [id] }; } else vortexLostNotice = false;
    await refreshState();
    if (w.outcome === 'finished' && w.reply && w.reply.result && w.reply.result.ok) {
        checkOldDownloads(); // in the background: the deploy question does not wait for Vortex
        if (w.reply.result.wasEnabled === false) return; // left disabled: nothing to deploy
        await askDeploy({ ids: [id], titles: [(w.reply.row && w.reply.row.title) || id], allOk: true });
    }
}

// --- Settings tab ---
async function loadSettings() {
    const cfg = await api('GET', '/api/settings');
    applyModManagerSettings(cfg);
    $('downloadFolderInput').value = cfg.downloadFolder || '';
    $('skyrimInstallPathInput').value = cfg.skyrimInstallPath || '';
    paintMo2Folder(cfg);
    $('skyrimNetFolderInput').value = cfg.skyrimNetFolder || '';
    $('vortexStagingFolderInput').value = cfg.vortexStagingFolder || '';
    $('checkOnVortexStartToggle').classList.toggle('off', !cfg.checkOnVortexStart);
    $('autoDownloadToggle').classList.toggle('off', !cfg.autoDownload);
    $('showAdultToggle').classList.toggle('off', !cfg.showAdultNotInstalled);
    $('tellHubToggle').classList.toggle('off', cfg.tellHubOnInstall === false);
    $('tellNewModPacerToggle').classList.toggle('off', cfg.tellNewModPacer === false);
    $('keepLogToggle').classList.toggle('off', cfg.keepLog === false);
    adultConfirmed = !!cfg.adultConfirmed;
    $('deleteOldDownloadToggle').classList.toggle('off', !cfg.deleteOldDownloadAfterUpdate);
    $('skyrimInstallStatus').textContent = cfg.skyrimInstallPath ? '' : '';
    renderNexusKeyField(cfg.nexusApiKeyLast4 || null);
    return cfg;
}

// Mod Organizer 2 only: the one folder that finds the rest. A problem with it (no settings in it, another game, several setups) is the one warning line.
function paintMo2Folder(cfg) {
    const isMo2 = cfg.modManager === 'mo2';
    $('mo2FolderField').style.display = isMo2 ? '' : 'none';
    $('mo2FolderInput').value = cfg.mo2Folder || '';
    const warn = $('mo2FolderProblem');
    warn.style.display = isMo2 && cfg.mo2Problem ? '' : 'none';
    warn.innerHTML = isMo2 && cfg.mo2Problem ? `&#9888;&#65039; ${escapeHtml(cfg.mo2Problem)}` : '';
}

// The Nexus key block in Settings. A dot and one word (Verified / Failed) from the shared nexus-key-check.js, the same as the setup step. A key already saved is checked once per
// page load (queue: nexus-key-saved-status, 2026-10-01) -- `nexusKeyChecked` is the "cached for the session" flag and `nexusKeyState` holds the result so switching away and back
// shows the same line. The saved key is never sent by the page: a check with no body makes the server check what it holds. Typing in the box clears the status.
let nexusKeyChecked = false;
let nexusKeyState = null;
let nexusKeyEditing = false; // true once "Change" is clicked, until a new key is saved or cancelled
let nexusKeyRemoving = false; // the short "Remove your Nexus key?" confirm step

function paintNexusKeyStatus() {
    const el = $('nexusKeyStatus');
    if (el) el.innerHTML = window.nexusKeyCheck.statusHtml(nexusKeyState, { premium: true });
}
// One check (typed key, or '' for the saved one): the button is disabled and the line says "Checking..." until the answer.
async function runNexusKeyCheck(typedKey) {
    const btn = $('nexusKeyCheckBtn');
    if (btn) btn.disabled = true;
    nexusKeyState = { phase: 'checking' };
    paintNexusKeyStatus();
    nexusKeyState = await window.nexusKeyCheck.run(api, typedKey);
    nexusKeyChecked = true;
    paintNexusKeyStatus();
    const again = $('nexusKeyCheckBtn');
    if (again) again.disabled = false;
}
async function checkSavedNexusKeyOnce() {
    if (nexusKeyChecked) { paintNexusKeyStatus(); return; }
    nexusKeyChecked = true;
    await runNexusKeyCheck('');
}

function renderNexusKeyField(last4) {
    const field = $('nexusKeyField');
    if (last4 && nexusKeyRemoving) {
        field.innerHTML = `
            <div class="inline" style="justify-content:space-between"><span class="muted" style="align-self:center">Remove your Nexus key?</span>
                <button id="nexusKeyRemoveCancelBtn">Cancel</button>
                <button id="nexusKeyRemoveConfirmBtn">Remove</button></div>
        `;
        $('nexusKeyRemoveCancelBtn').addEventListener('click', () => { nexusKeyRemoving = false; renderNexusKeyField(last4); });
        $('nexusKeyRemoveConfirmBtn').addEventListener('click', async () => {
            await api('POST', '/api/settings', { nexusApiKey: null });
            nexusKeyRemoving = false;
            nexusKeyChecked = false;
            nexusKeyState = null;
            refreshState();
            await loadSettings();
        });
        return;
    }
    if (last4 && !nexusKeyEditing) {
        field.innerHTML = `
            <div class="inline"><input type="text" value="Saved (ends &hellip;${escapeHtml(last4)})" readonly>
                <button id="nexusKeyCheckBtn">Check</button>
                <button id="nexusKeyChangeBtn">Change</button>
                <button id="nexusKeyRemoveBtn">Remove</button></div>
            <div id="nexusKeyStatus"></div>
        `;
        $('nexusKeyCheckBtn').addEventListener('click', () => runNexusKeyCheck(''));
        $('nexusKeyChangeBtn').addEventListener('click', () => { nexusKeyEditing = true; nexusKeyState = null; renderNexusKeyField(last4); });
        $('nexusKeyRemoveBtn').addEventListener('click', () => { nexusKeyRemoving = true; renderNexusKeyField(last4); });
        checkSavedNexusKeyOnce();
        return;
    }
    field.innerHTML = `
        <div class="inline"><input type="password" id="nexusApiKeyInput"><button id="nexusKeyCheckBtn" disabled>Check</button><button id="saveNexusKeyBtn">Save</button></div>
        <div id="nexusKeyStatus"></div>
    `;
    paintNexusKeyStatus();
    $('nexusApiKeyInput').addEventListener('input', () => {
        nexusKeyState = null; // the status no longer describes the box
        paintNexusKeyStatus();
        $('nexusKeyCheckBtn').disabled = !$('nexusApiKeyInput').value.trim();
    });
    $('nexusKeyCheckBtn').addEventListener('click', () => { const key = $('nexusApiKeyInput').value.trim(); if (key) runNexusKeyCheck(key); });
    $('saveNexusKeyBtn').addEventListener('click', async () => {
        const key = $('nexusApiKeyInput').value.trim();
        if (!key) return;
        await api('POST', '/api/settings', { nexusApiKey: key });
        nexusKeyEditing = false;
        // A Nexus row's own status can depend on this (queue: plugins-tab-notice-saved-settings,
        // 2026-09-30) -- refresh regardless of whether the key turns out to actually be valid below.
        refreshState();
        await runNexusKeyCheck(key);
        await loadSettings();
    });
}

document.querySelectorAll('[data-browse]').forEach((btn) => {
    btn.addEventListener('click', async () => {
        const input = $(btn.dataset.browse);
        const { path } = await api('POST', '/api/settings/browse-folder', { title: btn.dataset.title, initialDir: input.value || undefined });
        if (!path) return;
        input.value = path;
        const key = { downloadFolderInput: 'downloadFolder', skyrimInstallPathInput: 'skyrimInstallPath', skyrimNetFolderInput: 'skyrimNetFolder', mo2FolderInput: 'mo2Folder', vortexStagingFolderInput: 'vortexStagingFolder' }[input.id];
        const saved = await api('POST', '/api/settings', { [key]: path });
        if (key === 'mo2Folder' || key === 'skyrimInstallPath' || key === 'vortexStagingFolder') await loadSettings(); // the server may have filled in the other folders
        else if (saved) paintMo2Folder(saved);
        // Every one of these three folders is something a Plugins-tab row depends on (queue:
        // plugins-tab-notice-saved-settings, 2026-09-30) -- refresh unconditionally, not just for
        // the Skyrim folder as before.
        refreshState();
        if (key === 'skyrimInstallPath' || key === 'skyrimNetFolder' || key === 'mo2Folder') loadTheme();
        if (key === 'skyrimNetFolder' || key === 'mo2Folder') { try { renderPlugins(await api('POST', '/api/check', { force: false })); } catch { /* the next check shows it */ } }
    });
});

function wireToggle(el, settingKey) {
    el.addEventListener('click', async () => {
        const nowOff = !el.classList.contains('off');
        el.classList.toggle('off', nowOff);
        await api('POST', '/api/settings', { [settingKey]: !nowOff });
        // Turning "Download updates automatically" on can itself start real downloads immediately
        // (server-side, see maybeAutoDownloadNow) -- refresh so that shows up right away rather
        // than waiting for the next poll/Check now (queue: plugins-tab-notice-saved-settings,
        // 2026-09-30).
        refreshState();
    });
}
// The adult switch: turning it ON asks "Are you 18 or older?" the first time (the answer Yes is remembered on this PC); No leaves it off
// and asks again next time. Turning it off never asks. Only here: nothing else on the page can turn adult listings on.
let adultConfirmed = false;
$('showAdultToggle').addEventListener('click', async () => {
    const el = $('showAdultToggle');
    const turningOn = el.classList.contains('off');
    if (!turningOn) {
        el.classList.add('off');
        await api('POST', '/api/settings', { showAdultNotInstalled: false });
        refreshState();
        return;
    }
    if (!adultConfirmed) {
        const yes = await new Promise((resolve) => {
            $('adultOverlay').style.display = 'flex';
            const done = (v) => { $('adultOverlay').style.display = 'none'; $('adultYesBtn').onclick = $('adultNoBtn').onclick = null; resolve(v); };
            $('adultYesBtn').onclick = () => done(true);
            $('adultNoBtn').onclick = () => done(false);
        });
        if (!yes) return; // the switch stays off
        adultConfirmed = true;
        el.classList.remove('off');
        await api('POST', '/api/settings', { showAdultNotInstalled: true, adultConfirmed: true });
    } else {
        el.classList.remove('off');
        await api('POST', '/api/settings', { showAdultNotInstalled: true });
    }
    refreshState();
});
wireToggle($('checkOnVortexStartToggle'), 'checkOnVortexStart');
wireToggle($('autoDownloadToggle'), 'autoDownload');
wireToggle($('tellHubToggle'), 'tellHubOnInstall');
wireToggle($('tellNewModPacerToggle'), 'tellNewModPacer');
wireToggle($('keepLogToggle'), 'keepLog');
wireToggle($('deleteOldDownloadToggle'), 'deleteOldDownloadAfterUpdate');

// --- SkyrimNet theme ---
// Always matches whatever theme the player picked in SkyrimNet's own dashboard -- no theme picker
// here (queue: skyrimnet-themes, 2026-09-30). /api/theme re-reads SkyrimNet's real settings file
// fresh every time this loads, and style.css's own `:root` already has Dragonborn's colors as a
// safe default, so a slow or failed fetch never leaves the page looking broken -- just untouched.
async function loadTheme() {
    try {
        const theme = await api('GET', '/api/theme');
        const root = document.documentElement.style;
        root.setProperty('--accent', theme.accent);
        root.setProperty('--bg', theme.bg);
        root.setProperty('--text', theme.text);
        root.setProperty('--status-success', theme.status.success);
        root.setProperty('--status-warning', theme.status.warning);
        root.setProperty('--status-error', theme.status.error);
        root.setProperty('--status-info', theme.status.info);
    } catch {
        // Stay on style.css's own Dragonborn default -- never a broken/blank page over a cosmetic
        // feature.
    }
}

// --- Startup ---
// ---- Mod manager choice (queue: ask-which-mod-manager, 2026-10-01) ----

// Settings tab: the helper status line (Vortex only), and hiding what only makes sense
// for Vortex when MO2 is chosen. A mod manager not chosen yet shows as Vortex, the old behavior.
function applyModManagerSettings(cfg) {
    const manager = cfg.modManager === 'mo2' ? 'mo2' : 'vortex';
    const vortexOnly = manager === 'vortex';
    $('checkOnVortexStartLabel').style.display = vortexOnly ? '' : 'none';
    $('oldVersionsField').style.display = vortexOnly ? '' : 'none';
    lastSettingsCfg = vortexOnly ? cfg : null;
    renderHelperSettingsLine(cfg);
}

// The Bridge line at the top of Settings (Vortex only): installed, or not (with the way to get the bundled .zip).
let lastSettingsCfg = null;
function renderHelperSettingsLine(cfg) {
    const el = $('helperStatus');
    const vortexOnly = (cfg.modManager === 'mo2' ? 'mo2' : 'vortex') === 'vortex';
    if (!vortexOnly || cfg.helperInstalled === null || cfg.helperInstalled === undefined) { el.innerHTML = ''; return; }
    if (cfg.helperInstalled && cfg.bridge && cfg.bridge.outdated && cfg.helperBundled) {
        const parts = bundledHelperParts(true, null); // installed, but older than ModPacer needs: the same words as the banner
        el.innerHTML = `<span class="muted">&#9888;&#65039; ${escapeHtml(parts.title)}</span>${parts.body ? `<div style="margin-top:8px">${parts.body}</div>` : ''}${parts.actions ? `<div class="callout__actions">${parts.actions}</div>` : ''}`;
    } else if (cfg.helperInstalled) {
        const b = cfg.bridge || null;
        const ver = b && b.version ? ` ${escapeHtml(b.version)}` : '';
        el.innerHTML = `<span class="ok-t">&#10003; Vortex Bridge${ver} is installed</span>`
            + (b && b.answering && b.newerBundled && cfg.helperBundled ? `<div class="muted" style="margin-top:6px">${escapeHtml(window.setupFlow.bridgeNewerText(b.version, b.bundledVersion))}</div><div class="callout__actions"><button class="primary" data-action="open-helper-zip">Get the Vortex Bridge</button></div>` : '');
    } else if (cfg.helperBundled) {
        const parts = bundledHelperParts();
        el.innerHTML = `<span class="muted">&#9888;&#65039; ${escapeHtml(parts.title)}</span>${parts.body ? `<div style="margin-top:8px">${parts.body}</div>` : ''}${parts.actions ? `<div class="callout__actions">${parts.actions}</div>` : ''}`;
    } else {
        el.innerHTML = `<span class="muted">&#9888;&#65039; Vortex Bridge isn't installed. ModPacer works best with it: updates install directly into Vortex, stay in your collections, and check for updates when Vortex starts. <a href="${escapeHtml(cfg.helperDownloadUrl)}" target="_blank" rel="noopener noreferrer">Get the Vortex Bridge</a></span>`;
    }
}

$('runSetupAgainBtn').addEventListener('click', () => setupUi.open({ rerun: true }));

// Help bubbles: hover/focus shows one, click or tap pins it open, click-away closes it.
(function wireHelpBubbles() {
    const helps = Array.from(document.querySelectorAll('.help[data-help]'));
    const pop = (h) => $('help-' + h.dataset.help);
    const setOpen = (h, open) => { h.classList.toggle('open', open); pop(h).classList.toggle('open', open); };
    const closeAll = (except) => helps.forEach((h) => { if (h !== except) { h._pinned = false; setOpen(h, false); } });
    helps.forEach((h) => {
        h._pinned = false;
        h.addEventListener('mouseenter', () => { closeAll(h); setOpen(h, true); });
        h.addEventListener('mouseleave', () => { if (!h._pinned) setOpen(h, false); });
        h.addEventListener('focus', () => { closeAll(h); setOpen(h, true); });
        h.addEventListener('blur', () => { if (!h._pinned) setOpen(h, false); });
        h.addEventListener('click', (e) => { e.stopPropagation(); h._pinned = !h._pinned; closeAll(h); setOpen(h, h._pinned); });
        h.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); h.click(); }
            if (e.key === 'Escape') { h._pinned = false; setOpen(h, false); }
        });
    });
    document.addEventListener('click', (e) => {
        if (e.target.closest('.help-pop')) return;
        closeAll(null);
    });
})();

// ---- Start Vortex (queue: ask-to-start-vortex, 2026-10-01) ----
// The frame is this app's own modal (the same .overlay/.card the other popups use); the decisions
// live in start-vortex.js so they can be tested without a page.
function modManagerPopupOpen() {
    return $('modManagerOverlay').style.display !== 'none';
}
const startVortexUi = {
    showAsk({ canOpen }) {
        $('startVortexAsk').style.display = '';
        $('startVortexWait').style.display = 'none';
        $('startVortexSlow').style.display = 'none';
        $('startVortexOpenBtn').style.display = canOpen ? '' : 'none';
        $('startVortexOverlay').style.display = 'flex';
        return new Promise((resolve) => {
            const done = (choice) => {
                $('startVortexCancelBtn').onclick = $('startVortexContinueBtn').onclick = $('startVortexOpenBtn').onclick = null;
                resolve(choice);
            };
            $('startVortexCancelBtn').onclick = () => done('cancel');
            $('startVortexContinueBtn').onclick = () => done('continue');
            $('startVortexOpenBtn').onclick = () => done('open');
        });
    },
    showWaiting() {
        vortexStartingByPlayer = true;
        if (lastRenderedState) renderPlugins(lastRenderedState);
        $('startVortexAsk').style.display = 'none';
        $('startVortexWait').style.display = '';
        return new Promise((resolve) => { $('startVortexWaitCancelBtn').onclick = () => { $('startVortexWaitCancelBtn').onclick = null; resolve('cancel'); }; });
    },
    showSlowNote() { $('startVortexSlow').style.display = ''; },
    close() {
        $('startVortexOverlay').style.display = 'none';
        if (vortexStartingByPlayer) {
            vortexStartingByPlayer = false;
            if (lastRenderedState) renderPlugins(lastRenderedState);
        }
    },
};
const startVortexFlow = createStartVortexFlow({
    getStatus: () => api('GET', '/api/vortex-status'),
    openVortex: () => api('POST', '/api/open-vortex'),
    ui: startVortexUi,
});

// Page load: settings first (it may open the mod manager popup, which goes first), then the state,
// then -- only if Vortex needs starting -- the Start Vortex popup; once Vortex answers, run the check
// so the rows get their Update buttons.
(async function initialLoad() {
    $('moreFromMe').innerHTML = moreFromMe.render();
    loadTheme();
    api('GET', '/api/ping').then((p) => { if (p && p.version) $('appVersion').textContent = 'v' + p.version; }).catch(() => {});
    try { await loadSettings(); } catch { /* the page still works without it */ }
    await refreshState();
    // Setup not finished: the step-by-step pop-up opens by itself (queue: first-run-setup-steps, 2026-10-03) -- unless
    // the player already started it, then the page shows "Finish setup" and they come back when ready.
    const st = lastRenderedState;
    // A deploy that was already running when the page loaded (a reload): follow it instead of showing nothing.
    if (st && st.deploy && st.deploy.state === 'running' && !deployBusy) {
        const waiting = st.pendingDeploy || [];
        askDeploy({ ids: waiting.map((p) => p.pluginId), titles: waiting.map((p) => p.title), allOk: true, skipAsk: true, follow: true });
    }
    if (st && st.needsSetup && st.setup && !st.setup.started) await setupUi.open({ step: st.setup.step || 1 });
    const result = await startVortexFlow.prompt({ blocked: modManagerPopupOpen() || !!(st && st.needsSetup) });
    // Every time the updater is opened it checks by itself, however recently it last checked (Vortex closed: the Start Vortex
    // window came first; Cancel or "Continue" just carries on to the check, exactly as a manual Check now would).
    // Not while setup is unfinished or the mod manager question is still open: those come first and start their own check.
    // (window.__NO_AUTO_CHECK turns it off: a hook for the page tests, which set up their own rows first.)
    if (result !== 'skipped' && !(st && st.needsSetup) && !window.__NO_AUTO_CHECK) await autoCheckOnOpen(st);
    autoCheckPending = false;
    if (lastRenderedState) renderPlugins(lastRenderedState);
})();

// The automatic check when the page opens. If the headless check Vortex started is still running (another process), the page just shows
// "Checking..." until it is done and then does its own (by then Vortex is ready, so it is quick) -- never two at once.
async function autoCheckOnOpen(st) {
    $('checkNowBtn').disabled = true;
    try {
        if (st && st.checkingElsewhere) {
            for (let i = 0; i < 240; i++) {
                await new Promise((r) => setTimeout(r, 1500));
                let s; try { s = await api('GET', '/api/state'); } catch { break; }
                if (!s.checkingElsewhere) break;
            }
        }
        $('pluginList').innerHTML = `<p class="muted">Checking for updates&hellip;</p>`;
        renderPlugins(await api('POST', '/api/check', { force: false }));
    } catch { refreshState(); } finally { $('checkNowBtn').disabled = false; }
}
