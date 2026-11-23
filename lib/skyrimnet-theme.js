'use strict';
// Reads the player's chosen SkyrimNet theme colors straight out of SkyrimNet's own dashboard
// settings, so this app always matches whatever they picked over there (queue: skyrimnet-themes,
// 2026-09-30) -- no theme picker of its own, per the director's own decision.
//
// Verified live against the director's real Dashboard.yaml: flat `key: value` pairs, values
// sometimes double-quoted, no real YAML nesting or lists anywhere in this file -- a tiny
// line-based parser is the honest tool here, not a shortcut; pulling in a real YAML library for
// one three-key flat file would be the wrong tradeoff.

const fs = require('fs');
const path = require('path');
const { joinCI } = require('./ci-path');
const { findSkyrimNet } = require('./skyrimnet-install');

// SkyrimNet's own built-in "Dragonborn" preset -- the fallback whenever the real settings file
// can't be found, can't be read, or doesn't contain three genuinely valid colors.
const DRAGONBORN = { preset: 'dragonborn', accent: '#d4a855', bg: '#18181c', text: '#e8e6e1' };

// SkyrimNet's own status colors (success/warning/error/info), separately for its dark and light
// presets -- fixed values from SkyrimNet's own dashboard, not derived from the three theme colors.
const STATUS_COLORS = {
    dark: { success: '#7cefab', warning: '#e8941a', error: '#f26060', info: '#60a5fa' },
    light: { success: '#136b33', warning: '#8a4a06', error: '#ab1d1d', info: '#1d50b0' },
};

// SkyrimNet's six built-in themes. The current SkyrimNet writes only `theme_preset` for these and leaves the three
// color fields at whatever they held before, so the preset name decides, from our own table. The values are facts read
// from SkyrimNet's dashboard (assets\web-new\main.*.js, the object beside "label":"Dragonborn"), re-checked 2026-11-22.
const BUILT_IN_PRESETS = {
    dragonborn: { accent: '#c9a84c', bg: '#18181c', text: '#e8e6e1' },
    parchment: { accent: '#a07218', bg: '#eae6df', text: '#1c1a16' },
    stormcloak: { accent: '#5b9bf5', bg: '#0a0c0f', text: '#d8dce6' },
    silverblood: { accent: '#46627e', bg: '#d3d8df', text: '#1a1c20' },
    imperial: { accent: '#c44040', bg: '#141112', text: '#cfb488' },
    terminal: { accent: '#4ade80', bg: '#0b0f1a', text: '#4ade80' },
};

const HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i;

// A player's own themes: SkyrimNet stores `custom_themes` as one line holding a JSON list ({id, accent, bg, text, ...})
// and `active_custom_theme` as the id in use (the first theme when it is missing or unknown). Only valid entries count.
function parseCustomThemes(raw) {
    if (!raw || typeof raw !== 'string') return [];
    let list = null;
    for (const candidate of [raw, raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\')]) {
        try { list = JSON.parse(candidate); break; } catch { /* try the next reading */ }
    }
    if (!Array.isArray(list)) return [];
    const strictHex = /^#[0-9a-f]{6}$/i;
    return list.filter((t) => t && typeof t === 'object' && typeof t.id === 'string'
        && strictHex.test(t.accent || '') && strictHex.test(t.bg || '') && strictHex.test(t.text || ''));
}

// The colors a parsed Dashboard.yaml asks for, or null when it does not say (the caller then falls back to Dragonborn).
function resolveColors(parsed) {
    const preset = String(parsed.theme_preset || '').trim().toLowerCase();
    if (BUILT_IN_PRESETS[preset]) return { preset, ...BUILT_IN_PRESETS[preset] };
    if (preset === 'custom') {
        const themes = parseCustomThemes(parsed.custom_themes);
        if (themes.length) {
            const t = themes.find((x) => x.id === parsed.active_custom_theme) || themes[0];
            return { preset: 'custom', accent: t.accent, bg: t.bg, text: t.text };
        }
    }
    const { accent_color: accent, bg_color: bg, text_color: text } = parsed;
    if (HEX_COLOR_RE.test(accent) && HEX_COLOR_RE.test(bg) && HEX_COLOR_RE.test(text)) {
        return { preset: parsed.theme_preset || 'custom', accent, bg, text };
    }
    return null;
}

// Only what this app needs out of the file: flat `key: value` lines, optionally quoted, comments
// and blank lines skipped. Anything genuinely nested (a real YAML list/map) simply doesn't match
// the line pattern and is ignored, which is fine -- Dashboard.yaml never has any.
function parseSimpleYamlColors(text) {
    const result = {};
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
        if (!m) continue;
        let value = m[2].trim();
        if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
            value = value.slice(1, -1);
        }
        result[m[1]] = value;
    }
    return result;
}

function hexToRgb(hex) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const num = parseInt(h.slice(0, 6), 16);
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

// Relative luminance (sRGB, gamma-corrected) -- the standard perceptual formula, not a naive
// (R+G+B)/3 average, so a saturated color (Terminal's near-pure green on near-black) still gets
// classified by how bright it actually looks, not by its raw channel sum.
function relativeLuminance(hex) {
    const { r, g, b } = hexToRgb(hex);
    const lin = (c) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function toHex({ r, g, b }) { return '#' + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join(''); }
function contrastRatio(a, b) {
    const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}
// The card colour the page draws (style.css: --panel = the text colour 6% over the background).
function panelColor(bg, text) {
    const a = hexToRgb(bg), t = hexToRgb(text);
    return toHex({ r: a.r * 0.94 + t.r * 0.06, g: a.g * 0.94 + t.g * 0.06, b: a.b * 0.94 + t.b * 0.06 });
}
// A status colour as text on a light theme: SkyrimNet's own value when it already reaches 4.5:1 on the page AND on the card (Parchment),
// otherwise the same colour, a little darker each step, until it does (Silver-Blood's card is darker than its page).
function readableOn(hex, backgrounds, min = 4.5) {
    let c = hexToRgb(hex), out = hex;
    for (let i = 0; i < 40 && backgrounds.some((b) => contrastRatio(out, b) < min); i++) {
        c = { r: c.r * 0.97, g: c.g * 0.97, b: c.b * 0.97 };
        out = toHex(c);
    }
    return out;
}
function statusFor(colors, dark) {
    if (dark) return STATUS_COLORS.dark;
    const on = [colors.bg, panelColor(colors.bg, colors.text)];
    return Object.fromEntries(Object.entries(STATUS_COLORS.light).map(([k, v]) => [k, readableOn(v, on)]));
}

function isDarkBackground(bgHex) {
    return relativeLuminance(bgHex) < 0.5;
}

// Always returns a real, fully-valid theme -- never throws, never returns a partial color set.
// Re-reads the real file fresh on every call (no caching): the whole point is that changing the
// theme in SkyrimNet takes effect the next time this app's page loads, with no restart needed.
function readTheme(skyrimInstallPath, opts) {
    let colors = DRAGONBORN;
    try {
        const found = skyrimInstallPath ? findSkyrimNet(skyrimInstallPath, opts) : null;
        const skyrimNetDir = found && found.dir;
        if (skyrimNetDir) {
            // Mod Organizer 2: the game rewrites its settings in Overwrite, so that copy (the live one) is read first.
            const yamlPath = [found.liveDir, ...(found.validCopies || []).map((c) => c.dir), skyrimNetDir].filter(Boolean).map((d) => joinCI(d, 'config', 'Dashboard.yaml')).find((p) => fs.existsSync(p)) || joinCI(skyrimNetDir, 'config', 'Dashboard.yaml');
            const parsed = parseSimpleYamlColors(fs.readFileSync(yamlPath, 'utf8'));
            colors = resolveColors(parsed) || DRAGONBORN;
        }
    } catch {
        // Missing file, unreadable, or genuinely unparseable -- Dragonborn either way, never an
        // error surfaced to the player over a cosmetic feature.
    }
    const dark = isDarkBackground(colors.bg);
    return { ...colors, isDark: dark, status: statusFor(colors, dark) };
}

module.exports = {
    readTheme, resolveColors, parseCustomThemes, BUILT_IN_PRESETS, isDarkBackground, relativeLuminance, contrastRatio, readableOn, panelColor, parseSimpleYamlColors, DRAGONBORN, STATUS_COLORS,
};
