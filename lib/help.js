'use strict';
// The Help tab's guide (queue: help-tab-with-the-guide-and-a-section-for-mod-authors). The text lives in ONE file, release/HELP.md (the design
// side owns it, it ships in the package as HELP.md), and this turns it into the page's sections when the tab asks for it, so a later edit of that
// one file changes the tab. A small, safe Markdown renderer for exactly what HELP.md uses: headings, paragraphs, bold, inline code, ordered and
// bullet lists, and links. EVERYTHING else is escaped, never passed through (raw HTML in the file shows as text). Only http(s) links become
// links (they open in the browser); any other link, such as a relative README.md, is shown as its plain text, because the page has nowhere to take it.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// In the package the guide sits next to server.js; in the dev repo it is release/HELP.md. HELP_FILE (tests only) points somewhere else.
function helpPath() {
    if (process.env.MODPACER_HELP_FILE) return process.env.MODPACER_HELP_FILE;
    const packaged = path.join(ROOT, 'HELP.md');
    return fs.existsSync(packaged) ? packaged : path.join(ROOT, 'release', 'HELP.md');
}

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Inline: `code`, **bold**, [text](http-link). Escaped first, so nothing in the file can become markup of its own.
function inline(text) {
    const codes = [];
    let s = esc(text).replace(/`([^`]+)`/g, (m, c) => { codes.push(`<code>${c}</code>`); return `\u0000${codes.length - 1}\u0000`; });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
        const raw = url.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        return /^https?:\/\//i.test(raw) ? `<a href="${esc(raw)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    });
    return s.replace(/\u0000(\d+)\u0000/g, (m, i) => codes[Number(i)]);
}

function slug(title) {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
}

// Markdown block text -> { blocks: [{ type: 'p'|'ol'|'ul', items|text }] }
function parseBlocks(lines) {
    const blocks = [];
    let cur = null;
    const flush = () => { if (cur) { blocks.push(cur); cur = null; } };
    for (const line of lines) {
        const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
        const ul = /^\s*[-*]\s+(.*)$/.exec(line);
        if (!line.trim()) { flush(); continue; }
        if (ol) { if (!cur || cur.type !== 'ol') { flush(); cur = { type: 'ol', items: [] }; } cur.items.push(ol[1]); continue; }
        if (ul) { if (!cur || cur.type !== 'ul') { flush(); cur = { type: 'ul', items: [] }; } cur.items.push(ul[1]); continue; }
        if (cur && (cur.type === 'ol' || cur.type === 'ul') && /^\s+\S/.test(line)) { cur.items[cur.items.length - 1] += ` ${line.trim()}`; continue; } // a wrapped list item
        if (cur && cur.type === 'p') { cur.text += ` ${line.trim()}`; continue; }
        flush();
        cur = { type: 'p', text: line.trim() };
    }
    flush();
    return blocks;
}

// The four example tiles of "The page at a glance": a bullet list whose items all start with a bold label that is one of the page's real tiles.
const TILES = { 'updates ready': { cls: 'upd', n: 3 }, 'download from nexus': { cls: 'nx', n: 1 }, 'up to date': { cls: 'ok', n: 15 }, 'not installed': { cls: 'ni', n: 12 } };
function tilesHtml(items) {
    const parsed = items.map((t) => /^\*\*([^*]+?):?\*\*:?\s*(.*)$/.exec(t));
    if (parsed.length === 0 || !parsed.every((m) => m && TILES[m[1].trim().toLowerCase()])) return null;
    return `<div class="help-tiles">${parsed.map((m) => {
        const t = TILES[m[1].trim().toLowerCase()];
        return `<div class="stat ${t.cls} help-tile"><span class="n">${t.n}</span><span class="help-tile-text"><span class="l help-tile-name">${esc(m[1].trim())}</span><span class="help-tile-d">${inline(m[2])}</span></span></div>`;
    }).join('')}</div>`;
}

function blocksHtml(blocks) {
    return blocks.map((b) => {
        if (b.type === 'ol') return `<ol>${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ol>`;
        if (b.type === 'ul') return tilesHtml(b.items) || `<ul>${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`;
        // A note about the old "Vortex Collection Helper" name, if the guide has one, is the page's yellow notice (DESIGN.md severities).
        if (/^\*\*[^*]*Vortex Collection Helper/.test(b.text)) return `<div class="callout callout--warning callout--plain"><div class="callout__body" style="padding-left:0">${inline(b.text)}</div></div>`;
        return `<p>${inline(b.text)}</p>`;
    }).join('');
}

// -> { lead: html, sections: [{ id, title, html }] }
function render(markdown) {
    const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
    const lead = [];
    const sections = [];
    let current = null;
    for (const line of lines) {
        const h2 = /^##\s+(.*?)\s*#*\s*$/.exec(line);
        if (h2 && !/^###/.test(line)) {
            current = { title: h2[1], lines: [] };
            sections.push(current);
            continue;
        }
        if (/^#\s/.test(line)) continue; // the file's own title: the tab has its own
        (current ? current.lines : lead).push(line);
    }
    const used = new Set();
    return {
        lead: blocksHtml(parseBlocks(lead)),
        sections: sections.map((s) => {
            let id = slug(s.title);
            for (let n = 2; used.has(id); n++) id = `${slug(s.title)}-${n}`;
            used.add(id);
            return { id, title: s.title, html: blocksHtml(parseBlocks(s.lines)) };
        }),
    };
}

// What GET /api/help answers: { ok: true, lead, sections } or { ok: false } when the guide is missing or empty.
function load() {
    try {
        const out = render(fs.readFileSync(helpPath(), 'utf8'));
        return out.sections.length > 0 ? { ok: true, ...out } : { ok: false };
    } catch {
        return { ok: false };
    }
}

module.exports = { load, render, inline, helpPath };
