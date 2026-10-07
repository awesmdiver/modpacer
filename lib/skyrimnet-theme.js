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

const HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i;

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
            const { accent_color: accent, bg_color: bg, text_color: text } = parsed;
            if (HEX_COLOR_RE.test(accent) && HEX_COLOR_RE.test(bg) && HEX_COLOR_RE.test(text)) {
                colors = { preset: parsed.theme_preset || 'custom', accent, bg, text };
            }
        }
    } catch {
        // Missing file, unreadable, or genuinely unparseable -- Dragonborn either way, never an
        // error surfaced to the player over a cosmetic feature.
    }
    const dark = isDarkBackground(colors.bg);
    return { ...colors, isDark: dark, status: dark ? STATUS_COLORS.dark : STATUS_COLORS.light };
}

module.exports = {
    readTheme, isDarkBackground, relativeLuminance, parseSimpleYamlColors, DRAGONBORN, STATUS_COLORS,
};
