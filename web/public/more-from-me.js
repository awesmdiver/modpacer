'use strict';
// The "I make QOL mods to make things easier." section at the bottom of Settings (queue: more-from-me,
// 2026-10-01; approved mockup: Option A, cards). The same section goes into all three of the author's
// tools, so the list lives in ONE small data structure: adding a fourth tool is one new entry in TOOLS.
// A plain script in the browser (sets window.moreFromMe), a module in Node (tests/test-more-from-me.js).
(function (root) {
    const HEADING = 'I make QOL mods to make things easier.';
    const LEAD = "Free tools for a smoother modded Skyrim. Here's the set.";
    const THIS_TOOL = 'modpacer'; // the card with this id gets the accent border and the "You're here" tag

    // `url: null` would show a card with no link (for a tool whose page isn't public yet). `linkLabel` is the link's words (no label: "GitHub").
    // The two SkyrimNet tools link to their plugins page so the author gets the credit there; Vortex Collection Tools is not a SkyrimNet plugin.
    const TOOLS = [
        {
            id: 'vortex-collection-tools',
            name: 'Vortex Collection Tools',
            description: 'Everything you need to run massive Vortex collections without the friction.',
            url: 'https://github.com/awesmdiver/vortex-collection-tools',
        },
        {
            id: 'skyrimnet-multiproxy',
            name: 'SkyrimNet MultiProxy',
            description: 'Cloud or Local. Paid or Free. Any AI, Straight to SkyrimNet.',
            url: 'https://fateless.ai/plugins/awesmdiver/skyrimnet-multiproxy',
            linkLabel: 'Plugins page',
        },
        {
            id: 'modpacer',
            name: 'ModPacer',
            description: 'Automatic version checking and downloads for SkyrimNet Hub add-ons.',
            url: 'https://fateless.ai/plugins/awesmdiver/modpacer',
            linkLabel: 'Plugins page',
        },
    ];

    const SUPPORT = {
        lead: 'Enjoying these?',
        text: "They're free and always will be. A tip keeps the coffee flowing.",
        buttons: [
            { id: 'paypal', label: 'PayPal', url: 'https://paypal.me/awesmdiver', color: '#00457C' },
            { id: 'venmo', label: 'Venmo', url: 'https://www.venmo.com/u/awesmdiver', color: '#3D95CE' },
        ],
    };

    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // The section's HTML. Every external link opens in a new tab with rel="noopener noreferrer".
    function render() {
        const cards = TOOLS.map((t) => {
            const here = t.id === THIS_TOOL;
            const link = t.url ? `<a class="mfm-gh" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">${esc(t.linkLabel || 'GitHub')} ↗</a>` : '<span></span>';
            return `<div class="mfm-tool${here ? ' mfm-here' : ''}" data-tool="${esc(t.id)}">`
                + `<div class="mfm-name">${esc(t.name)}</div>`
                + `<div class="mfm-desc">${esc(t.description)}</div>`
                + `<div class="mfm-foot">${link}${here ? `<span class="mfm-here-tag">You're here</span>` : ''}</div>`
                + '</div>';
        }).join('');
        const buttons = SUPPORT.buttons.map((b) => `<a class="mfm-btn" style="background:${esc(b.color)}" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer" data-support="${esc(b.id)}">${esc(b.label)}</a>`).join('');
        return `<h2>${esc(HEADING)}</h2>`
            + `<p class="mfm-lead">${esc(LEAD)}</p>`
            + `<div class="mfm-tools">${cards}</div>`
            + `<div class="mfm-support"><div class="mfm-txt"><b>${esc(SUPPORT.lead)}</b> <span class="muted">${esc(SUPPORT.text)}</span></div>${buttons}</div>`;
    }

    const api = { HEADING, LEAD, THIS_TOOL, TOOLS, SUPPORT, render };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.moreFromMe = api;
})(typeof window !== 'undefined' ? window : globalThis);
