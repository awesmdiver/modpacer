// ModPacer browser helper: the reader for a LoversLab file page. One narrow job, no framework.
// It runs in the helper (the person's own browser) on the page's own text, and the same file is tested in Node against saved copies of real pages.
//
// Where the version comes from, in this order, and nothing else (it fails closed: no guess from description text, no file name):
//   1. a version at the END of the page's own big heading, or of the page title
//   2. the HIGHEST "What's New in Version X" heading (the page may list several, in any order), with its Released date
//   3. a File Information row labelled "Version" (many real pages have none)
// If none of them gives a version the answer is `layout: true`: the page could not be read (the site may have changed, or wants a sign-in).
// Dates are extra text for the person. They never decide anything. A date with no year is this year at the moment the helper read the page
// (LoversLab leaves the year off in the current year); a relative date ("Tuesday at 05:13 AM") means "within the last week of that moment".
(function (root) {
    'use strict';
    var V = '(\\d+(?:\\.\\d+)*(?:[a-z](?![a-z]))?)'; // 1.4, 2.3.1, 8.5.6f (a trailing letter is part of the version)

    function lineList(text) { return String(text || '').split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(Boolean); }

    // Versions compared as versions: 1.4 above 1.3.5 above 1.3.4; a trailing letter is above none (8.5.6f above 8.5.6).
    function cmpVer(a, b) {
        var pa = /^(\d+(?:\.\d+)*)([a-z]?)$/i.exec(a), pb = /^(\d+(?:\.\d+)*)([a-z]?)$/i.exec(b), x = pa[1].split('.'), y = pb[1].split('.'), k;
        for (k = 0; k < Math.max(x.length, y.length); k++) { var d = (+x[k] || 0) - (+y[k] || 0); if (d) return d < 0 ? -1 : 1; }
        return pa[2].toLowerCase() < pb[2].toLowerCase() ? -1 : (pa[2].toLowerCase() > pb[2].toLowerCase() ? 1 : 0);
    }

    // A version at the end of a title or heading: needs a dot or a leading v ("Skyrim 2" is not a version). The site name after " - " or " | " is dropped first.
    function versionAtEnd(title) {
        var parts = String(title || '').split(/\s+[-|–—]\s+/), i, m;
        for (i = 0; i < parts.length; i++) {
            m = new RegExp('\\s(v' + V + '|(?=\\d+\\.)' + V + ')$', 'i').exec(parts[i].trim());
            if (m) return m[2] || m[3];
        }
        return null;
    }

    var MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
    var NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    function monthIndex(s) { return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(s.slice(0, 3).toLowerCase()); }

    // -> { rel: true } | { mi, d, y (or null) } | null
    function parseDate(s) {
        var x;
        s = s.trim();
        if ((x = new RegExp('^' + MON + '\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b', 'i').exec(s))) return { mi: monthIndex(x[1]), d: +x[2], y: x[3] ? +x[3] : null };
        if ((x = new RegExp('^(\\d{1,2})(?:st|nd|rd|th)?\\s+' + MON + '(?:,?\\s+(\\d{4}))?\\b', 'i').exec(s))) return { mi: monthIndex(x[2]), d: +x[1], y: x[3] ? +x[3] : null };
        if ((x = /^(\d{4})-(\d{2})-(\d{2})\b/.exec(s))) return { mi: +x[2] - 1, d: +x[3], y: +x[1] };
        if (/^(today|yesterday|(mon|tues|wednes|thurs|fri|satur|sun)day)\b.*\bat\s+\d{1,2}:\d{2}/i.test(s) || /^\d+\s+(second|minute|hour|day)s?\s+ago\b/i.test(s) || /^(a|an)\s+(minute|hour|day)\s+ago\b/i.test(s)) return { rel: true };
        return null;
    }

    // readPage(title, text, nowMs, heading) -> { version, source, alsoListed, dates, layout, readAt }
    //   source: 'title' | 'whatsnew' | 'whatsnew-several' | 'fileinfo' | null
    function readPage(title, text, nowMs, heading) {
        var lines = lineList(text), i, m;
        var now = new Date(nowMs || Date.now());
        var version = null, source = null;
        // 1: the page's own big heading, then the page title
        var t = versionAtEnd(heading) || versionAtEnd(title);
        if (t) { version = t; source = 'title'; }
        // 2: every "What's New in Version X" heading; the HIGHEST one is the answer
        var heads = [], alsoListed = [];
        for (i = 0; i < lines.length; i++) {
            m = new RegExp('^what.?s new in version\\s+v?' + V, 'i').exec(lines[i]);
            if (m) heads.push({ ver: m[1], at: i });
        }
        heads.sort(function (a, b) { return cmpVer(b.ver, a.ver); });
        if (heads.length) {
            heads.slice(1).forEach(function (h) { if (alsoListed.indexOf(h.ver) < 0 && h.ver !== heads[0].ver) alsoListed.push(h.ver); });
            if (!version) { version = heads[0].ver; source = heads.length > 1 ? 'whatsnew-several' : 'whatsnew'; }
        }
        // 3: a File Information row labelled Version (the whole line, or the label alone with the value on the next line)
        if (!version) {
            for (i = 0; i < lines.length && !version; i++) {
                m = new RegExp('^version\\s*:?\\s*v?' + V + '$', 'i').exec(lines[i]);
                if (m) { version = m[1]; source = 'fileinfo'; }
                else if (/^version\s*:?$/i.test(lines[i]) && lines[i + 1] && (m = new RegExp('^v?' + V + '$', 'i').exec(lines[i + 1]))) { version = m[1]; source = 'fileinfo'; }
            }
        }
        // Dates, each with its label, for the person to read. A label with no value is nothing.
        function fmt(mi, d, y, note) { return NAMES[mi] + ' ' + d + ', ' + y + (note ? ' (' + note + ')' : ''); }
        // The year of a date written without one: this year; last year if that would be in the future, or later than `cap` (a newer entry: a change log's dates never
        // increase as the versions go down).
        function resolve(p, cap) {
            if (p.rel) return { text: 'relative, within the last week', ts: null };
            if (p.y) return { text: fmt(p.mi, p.d, p.y), ts: new Date(p.y, p.mi, p.d).getTime() };
            var yr = now.getFullYear(), note = 'this year';
            if (new Date(yr, p.mi, p.d).getTime() > now.getTime()) { yr -= 1; note = 'last year'; }
            if (cap && new Date(yr, p.mi, p.d).getTime() > cap) { yr -= 1; note = 'year guessed'; }
            return { text: fmt(p.mi, p.d, yr, note), ts: new Date(yr, p.mi, p.d).getTime() };
        }
        function labelAt(k) {
            var mm = /^(Submitted|Published|Updated|Released|Edited)\b\s*:?\s*(.*)$/i.exec(lines[k]);
            if (!mm) return null;
            var rest = mm[2] || (lines[k + 1] || '');
            var p = rest ? parseDate(rest) : null;
            return p ? { label: mm[1].charAt(0).toUpperCase() + mm[1].slice(1).toLowerCase(), p: p } : null;
        }
        var dates = [], seen = {}, cap = null, found, k;
        for (i = 0; i < lines.length; i++) {
            found = labelAt(i);
            if (found && (found.label === 'Updated' || found.label === 'Published')) { var rr = resolve(found.p, null); if (rr.ts && (!cap || rr.ts > cap)) cap = rr.ts; }
        }
        var releasedFromHeading = null;
        if (heads.length) { // each heading's own Released date, newest version first; dates must not increase as the versions go down
            var sortedAt = heads.map(function (h) { return h.at; }).sort(function (a, b) { return a - b; });
            var run = cap;
            heads.forEach(function (h, n) {
                var next = sortedAt[sortedAt.indexOf(h.at) + 1], end = next === undefined ? lines.length : next, f;
                for (k = h.at + 1; k < end && k < h.at + 8; k++) {
                    f = labelAt(k);
                    if (f && f.label === 'Released') { var r2 = resolve(f.p, run); if (r2.ts) run = r2.ts; if (n === 0) releasedFromHeading = 'Released: ' + r2.text; break; }
                }
            });
        }
        if (releasedFromHeading) { dates.push(releasedFromHeading); seen.Released = true; }
        else if (heads.length) seen.Released = true; // headings but no Released under the newest: say nothing rather than take another version's date
        for (i = 0; i < lines.length; i++) {
            found = labelAt(i);
            if (!found || seen[found.label]) continue;
            seen[found.label] = true;
            dates.push(found.label + ': ' + resolve(found.p, found.label === 'Released' ? cap : null).text);
        }
        return { version: version, source: source, alsoListed: alsoListed, dates: dates, layout: !version, readAt: now.toISOString() };
    }

    // What kind of page came back. We only NAME a sign-in, a bot check or an age question; nothing tries to get past one.
    function classify(o) {
        var title = String(o.title || ''), text = String(o.text || ''), html = String(o.html || '');
        var all = title + '\n' + text.slice(0, 4000);
        if (/just a moment|checking your browser|verify(ing)? you are (a )?human|captcha|attention required|access denied|are you a robot|security check/i.test(all) || /cf-challenge|challenge-platform/i.test(html.slice(0, 20000))) return 'challenge';
        if (/are you (over|at least) 18|age (verification|confirmation|check)|i am (over )?18|confirm (that )?you are (over )?18/i.test(all)) return 'age';
        if (/type=["']?password/i.test(html) || (/\b(sign in|log in|login)\b/i.test(title) && !/\b(version|download)\b/i.test(text.slice(0, 3000)))) return 'signin';
        return 'page';
    }
    function decode(s) {
        return String(s).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    }
    function htmlToText(html) {
        return decode(String(html || '').replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|section|article|dd|dt)>/gi, '\n').replace(/<[^>]+>/g, ' '));
    }
    function htmlTitle(html) { var m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || '')); return m ? decode(m[1]).replace(/\s+/g, ' ').trim() : ''; }
    // The page's own big heading (the first h1): on LoversLab file pages it carries the version when the browser tab title does not.
    function htmlHeading(html) { var m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(String(html || '')); return m ? decode(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : ''; }

    // What goes back to ModPacer is cut to what ModPacer keeps (its own cleaning stays): a page with a huge heading or thousands of version headings must not make the
    // report too big for ModPacer to accept (it takes 100 KB), which would make that page's check fail for good.
    function cut(s, n) { return String(s == null ? '' : s).slice(0, n); }
    function cutList(a, n, each) { return (Array.isArray(a) ? a : []).slice(0, n).map(function (x) { return cut(x, each); }); }
    // The whole job for one fetched page: -> { kind, title, version, source, alsoListed, dates, layout, readAt } (all plain text; nothing here is HTML)
    function readHtml(html, nowMs) {
        var text = htmlToText(html), title = htmlTitle(html), heading = htmlHeading(html);
        var kind = classify({ title: title, text: text, html: html });
        var page = readPage(title, text, nowMs, heading);
        return { kind: kind, title: cut(heading || title, 120), version: page.version === null ? null : cut(page.version, 40), source: page.source, alsoListed: cutList(page.alsoListed, 8, 40), dates: cutList(page.dates, 8, 80), layout: page.layout, readAt: page.readAt };
    }

    var api = { readPage: readPage, readHtml: readHtml, classify: classify, htmlToText: htmlToText, htmlTitle: htmlTitle, htmlHeading: htmlHeading, cmpVer: cmpVer };
    if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ModPacerReader = api;
})(typeof self !== 'undefined' ? self : this);
