'use strict';
// Each mod's cover picture and description from the Plugin Hub (queue: show-each-mods-cover-picture-and-description-from-the-hub;
// approved mockup design/mockup-mod-cover-pictures.html, layout A).
//
//   * A 128 x 72 frame at the left of every mod row, in every list. No cover, or one that cannot load: the same-size empty dashed frame.
//   * The page never loads a picture from the internet: every picture is /api/hub-cover/<id>, ModPacer's own saved small copy (the page's
//     img-src is 'self'). The server fetches and shrinks it only when asked, so the page asks only for frames that are on screen.
//   * The description is two lines then Show more. It arrives from /api/hub-description/<id> as already-plain lines (no links, images or
//     HTML); this file only ever puts it in as text nodes, with <b> for bold runs, <li> for bullets and <div> for the rest (never innerHTML).
//   * "Show mod pictures" off: no frames, no picture requests (the description is not covered by the switch).
// A plain script in the browser (sets window.modCovers), a module in Node (tests).
(function (root) {
    const COVER_URL = '/api/hub-cover/';
    const DESC_URL = '/api/hub-description/';
    const RETRY_AFTER_MS = 5 * 60 * 1000;
    const MAX_LINES = 400;

    const cfg = { show: true, adult: false };
    const picLoaded = new Set();   // ids whose picture has loaded this visit: drawn straight away next time
    const picFailed = new Set();   // ids that could not load this visit: the empty frame, not asked again
    const picAsking = new Set();
    const descLines = new Map();   // id -> the cleaned lines, or null when the mod has no description
    const descFailedAt = new Map();
    const descAsking = new Set();
    const descOpen = new Set();    // ids whose description is open ("Show less")
    let io = null;

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const idOk = (id) => /^[a-z0-9_-]{1,64}\.[a-z0-9_-]{1,64}$/.test(String(id || ''));

    function configure(c) {
        cfg.show = !c || c.show !== false;
        cfg.adult = !!(c && c.adult);
    }
    const showing = () => cfg.show;
    function pictureWanted(row) {
        return !!(row && idOk(row.hubId) && row.hasCover && (!row.coverAdult || cfg.adult));
    }

    // ---- the picture frame -------------------------------------------------------------------------------------------------------

    function thumbHtml(row) {
        if (!cfg.show) return '';
        if (!pictureWanted(row) || picFailed.has(row.hubId)) return '<div class="thumb empty"></div>';
        const id = esc(row.hubId);
        if (picLoaded.has(row.hubId)) return `<div class="thumb" data-cover-id="${id}" data-action="zoom-cover" role="button" tabindex="0"><img src="${COVER_URL}${id}" alt=""></div>`;
        return `<div class="thumb load" data-cover-id="${id}"></div>`;
    }
    const rowClass = () => (cfg.show ? ' has-cover' : '');

    function framesOf(id) { return root.document ? Array.from(root.document.querySelectorAll('[data-cover-id]')).filter((e) => e.dataset.coverId === id) : []; }

    function paintLoaded(id) {
        for (const f of framesOf(id)) {
            f.classList.remove('load', 'empty');
            f.setAttribute('data-action', 'zoom-cover');
            f.setAttribute('role', 'button');
            f.setAttribute('tabindex', '0');
            f.textContent = '';
            const img = root.document.createElement('img');
            img.alt = '';
            img.src = COVER_URL + id;
            f.appendChild(img);
        }
    }
    function paintFailed(id) {
        for (const f of framesOf(id)) {
            f.classList.remove('load');
            f.classList.add('empty');
            f.removeAttribute('data-action');
            f.removeAttribute('role');
            f.removeAttribute('tabindex');
            f.textContent = '';
        }
    }
    function askPicture(id) {
        if (!cfg.show || picLoaded.has(id) || picFailed.has(id) || picAsking.has(id) || !idOk(id)) return;
        picAsking.add(id);
        const probe = new root.Image();
        probe.onload = () => { picAsking.delete(id); picLoaded.add(id); paintLoaded(id); };
        probe.onerror = () => { picAsking.delete(id); picFailed.add(id); paintFailed(id); };
        probe.src = COVER_URL + id;
    }

    // ---- the description ---------------------------------------------------------------------------------------------------------

    // The server's lines ([[{t, b}]]; an empty array is a blank line) -> the same shape with anything unexpected dropped; null when nothing is left.
    function cleanLines(lines) {
        if (!Array.isArray(lines)) return null;
        const out = lines.slice(0, MAX_LINES).map((runs) => (Array.isArray(runs) ? runs : []).filter((r) => r && typeof r.t === 'string' && r.t).map((r) => ({ t: r.t, b: !!r.b })));
        return out.some((l) => l.length) ? out : null;
    }
    const BULLET = '\u2022 ';
    const textOf = (runs) => runs.map((r) => r.t).join('');
    // The lines -> a <div class="desc"> built from elements and text nodes only (the author's text is never parsed as HTML, so no tag, link or image can come out of it):
    //   a bullet line (starts with the server's dot)      -> <li> in a <ul> (consecutive ones share one list; the same hanging indent as What's new)
    //   a line that is only bold, or a plain line ending in a colon that leads into a bullet -> a heading line with a little space above it
    //   a blank line                                       -> a gap above whatever comes next
    //   any other line                                     -> a plain line
    function buildDescription(doc, lines) {
        const body = doc.createElement('div');
        body.className = 'desc';
        const fill = (el, runs) => {
            for (const r of runs) {
                if (r.b) { const b = doc.createElement('b'); b.textContent = r.t; el.appendChild(b); } else el.appendChild(doc.createTextNode(r.t));
            }
        };
        const all = (cleanLines(lines) || []);
        let list = null, gap = false;
        all.forEach((runs, i) => {
            if (!runs.length) { gap = true; list = null; return; }
            if (runs[0].t.startsWith(BULLET) && !runs[0].b) {
                const rest = runs.slice();
                rest[0] = { t: runs[0].t.slice(BULLET.length), b: false };
                const item = rest.filter((r) => r.t);
                if (!item.length) return;
                if (!list) { list = doc.createElement('ul'); if (gap) list.className = 'gap'; body.appendChild(list); gap = false; }
                const li = doc.createElement('li');
                fill(li, item);
                list.appendChild(li);
                return;
            }
            list = null;
            const next = all[i + 1];
            const bold = runs.every((r) => r.b);
            const lead = !bold && /:$/.test(textOf(runs).trim()) && next && next.length && next[0].t.startsWith(BULLET);
            const el = doc.createElement('div');
            el.className = bold ? 'ch-heading' : lead ? 'desc-lead' : 'desc-p';
            if (gap || (i > 0 && (bold || lead))) el.classList.add('gap');
            gap = false;
            fill(el, runs);
            body.appendChild(el);
        });
        return body;
    }

    // The empty place for a description, under the tagline. Filled in later, when the row is on screen.
    function descSlot(row) {
        return row && idOk(row.hubId) ? `<div class="desc-slot" data-desc-id="${esc(row.hubId)}"></div>` : '';
    }
    function slotsOf(id) { return root.document ? Array.from(root.document.querySelectorAll('.desc-slot')).filter((e) => e.dataset.descId === id) : []; }

    // Shows the button only when the text really is longer than two lines (measured once the row is visible).
    function measureSlot(slot) {
        const body = slot.querySelector('.desc');
        const btn = slot.querySelector('[data-action="toggle-desc"]');
        if (!body || !btn) return;
        if (descOpen.has(slot.dataset.descId)) { btn.hidden = false; return; }
        if (body.offsetParent === null) { slot.setAttribute('data-measure', '1'); return; } // hidden (its list is closed): measured when it opens
        slot.removeAttribute('data-measure');
        btn.hidden = !(body.scrollHeight > body.clientHeight + 1);
    }
    function fillSlot(slot) {
        const id = slot.dataset.descId;
        const lines = descLines.get(id);
        slot.textContent = '';
        if (!lines) return;
        const open = descOpen.has(id);
        const doc = root.document;
        const body = buildDescription(doc, lines);
        if (!open) body.classList.add('clamp');
        const btn = doc.createElement('a');
        btn.href = '#';
        btn.className = 'ch-toggle';
        btn.setAttribute('data-action', 'toggle-desc');
        btn.setAttribute('data-id', id);
        btn.hidden = true;
        btn.textContent = open ? 'Show less' : 'Show more';
        slot.appendChild(body);
        slot.appendChild(btn);
        measureSlot(slot);
    }
    async function askDescription(id) {
        if (descLines.has(id) || descAsking.has(id) || !idOk(id)) return;
        const failed = descFailedAt.get(id);
        if (failed != null && Date.now() - failed < RETRY_AFTER_MS) return;
        descAsking.add(id);
        try {
            const r = await root.api('GET', DESC_URL + encodeURIComponent(id));
            descLines.set(id, r && Array.isArray(r.lines) ? cleanLines(r.lines) : null);
            descFailedAt.delete(id);
        } catch {
            descFailedAt.set(id, Date.now()); // nothing shown, asked again no sooner than a few minutes from now
        } finally {
            descAsking.delete(id);
        }
        slotsOf(id).forEach(fillSlot);
    }
    function toggleDescription(id) {
        if (descOpen.has(id)) descOpen.delete(id); else descOpen.add(id);
        slotsOf(id).forEach(fillSlot);
    }

    // ---- watching what is on screen ---------------------------------------------------------------------------------------------

    function onSeen(entries) {
        for (const en of entries) {
            if (!en.isIntersecting) continue;
            const el = en.target;
            if (el.dataset.coverId !== undefined && el.classList.contains('load')) askPicture(el.dataset.coverId);
            if (el.dataset.descId !== undefined) {
                if (descLines.has(el.dataset.descId)) { if (el.hasAttribute('data-measure')) measureSlot(el); } else askDescription(el.dataset.descId);
            }
        }
    }
    // Called after the list is drawn: fills what is already known and starts watching the rest. Nothing is asked for here directly.
    function afterPaint(container) {
        if (!container) return;
        if (!io && typeof root.IntersectionObserver === 'function') io = new root.IntersectionObserver(onSeen, { rootMargin: '120px' });
        for (const slot of container.querySelectorAll('.desc-slot')) {
            if (descLines.has(slot.dataset.descId)) fillSlot(slot);
            if (io) io.observe(slot);
        }
        if (!cfg.show || !io) return;
        for (const f of container.querySelectorAll('.thumb.load[data-cover-id]')) io.observe(f);
    }

    // ---- click a picture to see it bigger ---------------------------------------------------------------------------------------

    function zoom(id) {
        if (!idOk(id) || !root.document || root.document.getElementById('coverZoom')) return;
        const doc = root.document;
        const back = doc.createElement('div');
        back.className = 'overlay';
        back.id = 'coverZoom';
        const img = doc.createElement('img');
        img.className = 'cover-zoom';
        img.alt = '';
        img.src = COVER_URL + id;
        back.appendChild(img);
        const close = () => { doc.removeEventListener('keydown', onKey, true); back.remove(); };
        const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
        back.addEventListener('click', close);
        doc.addEventListener('keydown', onKey, true);
        doc.body.appendChild(back);
    }

    // The page's one click handler calls this for the actions it does not know. -> true when it handled the click.
    function handleAction(action, el) {
        if (action === 'toggle-desc') { toggleDescription(el.dataset.id); return true; }
        if (action === 'zoom-cover') { zoom(el.dataset.coverId); return true; }
        return false;
    }

    // Enter or Space on a focused picture opens it, like a click.
    if (root.document) {
        root.document.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const t = e.target && e.target.closest ? e.target.closest('.thumb[data-action="zoom-cover"]') : null;
            if (t && e.target === t) { e.preventDefault(); zoom(t.dataset.coverId); }
        });
    }

    const exported = { configure, showing, rowClass, thumbHtml, descSlot, afterPaint, handleAction, buildDescription, pictureWanted, _state: { picLoaded, picFailed, descLines, descOpen } };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    else root.modCovers = exported;
}(typeof window !== 'undefined' ? window : globalThis));
