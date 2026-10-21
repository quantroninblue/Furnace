'use strict';
// Furnace themes: the theme format, presets, validation, readability checks and how a theme
// becomes editor colour overrides (applied per window by patches/themes-menu.patch) and the
// colour tokens of Furnace's own panels. Pure functions, no vscode dependency.
//
// A theme has six parts that can be mixed and matched: background, font, text (font colour),
// code (editor font colour), editor (editor colour) and accent.

const HEX = /^#[0-9a-f]{6}$/i;
const FONT = /^[\w .,'-]{1,60}$/;

// ---------- colour maths ----------
const parse = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const toHex = rgb => `#${rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
/** a + (b − a) × amount */
const mix = (a, b, amount) => { const x = parse(a), y = parse(b); return toHex(x.map((v, i) => v + (y[i] - v) * amount)); };
const alpha = (hex, value) => `${hex}${Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, '0')}`;
function luminance(hex) {
    const [r, g, b] = parse(hex).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const isLight = hex => luminance(hex) > 0.4;
/** Black or white, whichever reads better on the colour. */
const onColor = hex => contrast(hex, '#000000') >= contrast(hex, '#ffffff') ? '#000000' : '#ffffff';
/** A shade a few steps away from the colour (lighter on dark colours, darker on light ones). */
const shift = (hex, amount) => mix(hex, isLight(hex) ? '#000000' : '#ffffff', amount);
/** Moves `color` towards black or white until it reaches `ratio` against `background`. */
function readable(color, background, ratio) {
    if (contrast(color, background) >= ratio) return color;
    const target = isLight(background) ? '#000000' : '#ffffff';
    for (let step = 1; step <= 20; step++) { const next = mix(color, target, step / 20); if (contrast(next, background) >= ratio) return next; }
    return target;
}

// ---------- code colour presets (syntax colours) ----------
// Furnace's own, so presets look the same everywhere; installed colour themes are listed too.
const CODE = {
    charcoal: { name: 'Charcoal', fg: '#dadada', base: true },
    'midnight-purple': { name: 'Midnight Purple', fg: '#f8f8f2', bg: '#282a36', comment: '#6272a4', keyword: '#ff79c6', string: '#f1fa8c', number: '#bd93f9',
        func: '#50fa7b', type: '#8be9fd', variable: '#f8f8f2', property: '#f8f8f2', tag: '#ff79c6', attribute: '#50fa7b', operator: '#ff79c6' },
    arctic: { name: 'Arctic', fg: '#d8dee9', bg: '#2e3440', comment: '#7b88a1', keyword: '#81a1c1', string: '#a3be8c', number: '#b48ead',
        func: '#88c0d0', type: '#8fbcbb', variable: '#d8dee9', property: '#d8dee9', tag: '#81a1c1', attribute: '#8fbcbb', operator: '#81a1c1' },
    daylight: { name: 'Daylight', fg: '#24292f', bg: '#ffffff', comment: '#6e7781', keyword: '#cf222e', string: '#0a3069', number: '#0550ae',
        func: '#8250df', type: '#953800', variable: '#24292f', property: '#0550ae', tag: '#116329', attribute: '#0550ae', operator: '#cf222e' },
};
const SCOPES = {
    comment: ['comment', 'punctuation.definition.comment'],
    string: ['string', 'punctuation.definition.string', 'string.template'],
    number: ['constant.numeric', 'constant.language', 'constant.character', 'support.constant', 'variable.other.constant'],
    keyword: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.control'],
    func: ['entity.name.function', 'support.function', 'meta.function-call.generic'],
    type: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class', 'entity.other.inherited-class', 'entity.name.namespace'],
    variable: ['variable', 'variable.other.readwrite', 'variable.parameter', 'meta.definition.variable.name'],
    property: ['variable.other.property', 'variable.other.object.property', 'meta.object-literal.key', 'support.type.property-name'],
    tag: ['entity.name.tag'], attribute: ['entity.other.attribute-name'], operator: ['keyword.operator'],
};
/** TextMate rules for a bundled code preset (null for Charcoal, which keeps the base theme's colours). */
function codeRules(id) {
    const preset = CODE[id];
    if (!preset || preset.base) return null;
    return Object.entries(SCOPES).map(([key, scope]) => ({ scope, settings: { foreground: preset[key], ...(key === 'comment' ? { fontStyle: 'italic' } : {}) } }));
}

// ---------- pictures and fonts that ship with Furnace ----------
const PICTURES = { ember: 'Ember', forge: 'Forge', 'night-sky': 'Night Sky', aurora: 'Aurora' };
const FONTS = { inter: 'Inter', nunito: 'Nunito', 'atkinson-hyperlegible-next': 'Atkinson Hyperlegible Next' };

// ---------- presets ----------
const theme = (id, name, parts) => ({ version: 1, id, name, preset: true, ...parts });
const solid = color => ({ kind: 'solid', color, gradient: null, picture: null, dim: 'auto', glass: false, ember: 'off', emberIntensity: 0.4 });
const gradient = (color, stops, angle, extra = {}) => ({ ...solid(color), kind: 'gradient', gradient: { stops, angle }, ...extra });
const PRESETS = [
    theme('charcoal', 'Furnace Charcoal', { background: solid('#101010'), font: { family: '' }, text: { main: '#dadada', muted: '#9c9c9c' }, code: 'charcoal', editor: { background: '#141414' }, accent: '#c6c6c6', base: true }),
    theme('ember', 'Ember', { background: gradient('#140e0b', ['#3a1a0c', '#140c09', '#0b0807'], 160, { ember: 'glow', emberIntensity: 0.35 }), font: { family: '' }, text: { main: '#ece0d4', muted: '#ab998c' }, code: 'charcoal', editor: { background: '#15110f' }, accent: '#f08a4b' }),
    theme('forge', 'Forge', { background: gradient('#120808', ['#3b0d0b', '#170807', '#090404'], 170), font: { family: '' }, text: { main: '#efdede', muted: '#b59d9d' }, code: 'charcoal', editor: { background: '#130c0c' }, accent: '#e5533d' }),
    theme('midnight', 'Midnight', { background: gradient('#0a1020', ['#122452', '#0a1328', '#05080f'], 160), font: { family: 'Inter' }, text: { main: '#dde6f5', muted: '#95a6c3' }, code: 'arctic', editor: { background: '#0d1424' }, accent: '#6ea8ff' }),
    theme('synthwave', 'Synthwave', { background: gradient('#170b26', ['#3d1063', '#5a1248', '#14081f'], 155), font: { family: 'Nunito' }, text: { main: '#f5e9ff', muted: '#bea8d4' }, code: 'midnight-purple', editor: { background: '#1b1129' }, accent: '#ff5fc8' }),
    theme('forest', 'Forest', { background: gradient('#0e1712', ['#173a26', '#0d1d14', '#060c09'], 165), font: { family: '' }, text: { main: '#e0ebe2', muted: '#9fb5a6' }, code: 'arctic', editor: { background: '#0f1813' }, accent: '#7fc58b' }),
    theme('paper', 'Paper', { background: solid('#f2efe8'), font: { family: 'Inter' }, text: { main: '#2b2a27', muted: '#66625b' }, code: 'daylight', editor: { background: '#fbfaf7' }, accent: '#b4561f' }),
    theme('high-contrast', 'High Contrast', { background: solid('#000000'), font: { family: 'Atkinson Hyperlegible Next' }, text: { main: '#ffffff', muted: '#d6d6d6' }, code: 'midnight-purple', editor: { background: '#000000' }, accent: '#ffd400' }),
];
const presetById = id => PRESETS.find(item => item.id === id);
const PARTS = ['background', 'font', 'text', 'code', 'editor', 'accent'];

// ---------- validation (themes are imported from files, so every field is checked) ----------
const color = (value, fallback) => typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : fallback;
const number = (value, low, high, fallback) => typeof value === 'number' && Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : fallback;
const oneOf = (value, list, fallback) => list.includes(value) ? value : fallback;
/** A safe, complete theme from untrusted input (unknown fields dropped, bad values replaced by Charcoal's). */
function sanitize(input, { pictureOk = () => true } = {}) {
    const base = PRESETS[0], value = input && typeof input === 'object' ? input : {};
    const bg = value.background && typeof value.background === 'object' ? value.background : {};
    const stops = Array.isArray(bg.gradient?.stops) ? bg.gradient.stops.slice(0, 4).map(stop => color(stop, null)).filter(Boolean) : [];
    const picture = bg.picture && typeof bg.picture === 'object' && ['bundled', 'user'].includes(bg.picture.source) && typeof bg.picture.name === 'string'
        && /^[\w.-]{1,80}$/.test(bg.picture.name) && (bg.picture.source !== 'bundled' || Object.hasOwn(PICTURES, bg.picture.name)) && pictureOk(bg.picture)
        ? { source: bg.picture.source, name: bg.picture.name, fit: oneOf(bg.picture.fit, ['cover', 'tile', 'center'], 'cover') } : null;
    let kind = oneOf(bg.kind, ['solid', 'gradient', 'picture'], 'solid');
    if (kind === 'gradient' && stops.length < 2) kind = 'solid';
    if (kind === 'picture' && !picture) kind = 'solid';
    const family = typeof value.font?.family === 'string' && FONT.test(value.font.family.trim()) ? value.font.family.trim() : '';
    const code = typeof value.code === 'string' && (Object.hasOwn(CODE, value.code) || /^installed:[^\n]{1,200}$/.test(value.code)) ? value.code : 'charcoal';
    return {
        version: 1,
        id: typeof value.id === 'string' && /^[\w-]{1,60}$/.test(value.id) ? value.id : 'custom',
        name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 60) : 'Custom Theme',
        background: {
            kind, color: color(bg.color, base.background.color),
            gradient: stops.length >= 2 ? { stops, angle: number(bg.gradient.angle, 0, 360, 160) } : null,
            picture, dim: bg.dim === 'auto' ? 'auto' : number(bg.dim, 0, 0.95, 'auto'),
            glass: bg.glass === true, ember: oneOf(bg.ember, ['off', 'sparks', 'glow'], 'off'), emberIntensity: number(bg.emberIntensity, 0.1, 1, 0.4),
        },
        font: { family },
        text: { main: color(value.text?.main, base.text.main), muted: color(value.text?.muted, base.text.muted) },
        code,
        editor: { background: color(value.editor?.background, base.editor.background) },
        accent: color(value.accent, base.accent),
    };
}
/** A copy of `theme` with one part taken from `source` ("Use from theme…"). */
function takePart(target, source, part) {
    if (!PARTS.includes(part)) throw new Error('Unknown theme part.');
    return sanitize({ ...target, [part]: structuredClone(source[part]) });
}

// ---------- readability ----------
/**
 * Contrast checks for a theme (WCAG ratios: 4.5 for text, 3 for secondary text, focus rings and comments).
 * Picture and gradient backgrounds are checked against the panel colour here; the window dims the
 * backdrop until text passes (see patches/themes-menu.patch) unless the dim is set by hand.
 */
function checks(input, codeFg = null) {
    const t = sanitize(input), panel = t.background.color, editor = t.editor.background;
    const preset = CODE[t.code];
    const fg = codeFg || (preset && !preset.base ? preset.fg : '#dadada');
    const result = [
        { id: 'text', label: 'Text on the background', ratio: contrast(t.text.main, panel), need: 4.5, part: 'text', field: 'main', against: panel },
        { id: 'muted', label: 'Secondary text on the background', ratio: contrast(t.text.muted, panel), need: 3, part: 'text', field: 'muted', against: panel },
        { id: 'accent', label: 'Accent (focus rings, links) on the background', ratio: contrast(t.accent, panel), need: 3, part: 'accent', against: panel },
        { id: 'code', label: 'Code on the editor colour', ratio: contrast(fg, editor), need: 4.5, part: 'editor', field: 'background', against: fg },
    ];
    if (preset?.comment) result.push({ id: 'comment', label: 'Comments on the editor colour', ratio: contrast(preset.comment, editor), need: 3, part: 'editor', field: 'background', against: preset.comment });
    return result.map(check => ({ ...check, ratio: Math.round(check.ratio * 10) / 10, ok: check.ratio >= check.need }));
}
/** Fixes one failing check by moving the part's colour towards black or white. */
function fix(input, id, codeFg = null) {
    const t = sanitize(input), check = checks(t, codeFg).find(item => item.id === id);
    if (!check || check.ok) return t;
    if (check.part === 'text') t.text[check.field] = readable(t.text[check.field], check.against, check.need + 0.1);
    else if (check.part === 'accent') t.accent = readable(t.accent, check.against, check.need + 0.1);
    else if (check.part === 'editor') {
        // Move the editor background away from the code colour until code and comments both read.
        const editorChecks = () => checks(t, codeFg).filter(item => item.part === 'editor');
        const code = editorChecks().find(item => item.id === 'code').against;
        const target = isLight(code) ? '#000000' : '#ffffff';
        for (let step = 1; step <= 30 && editorChecks().some(item => item.ratio < item.need + 0.1); step++) t.editor.background = mix(t.editor.background, target, 0.1);
    }
    return t;
}

// ---------- applying a theme ----------
/** Colour override keys drawn over the backdrop; the window makes them see-through when one shows. */
const PANEL_KEYS = ['sideBar.background', 'sideBarSectionHeader.background', 'sideBarStickyScroll.background', 'activityBar.background', 'statusBar.background',
    'statusBar.noFolderBackground', 'panel.background', 'panelStickyScroll.background', 'titleBar.activeBackground', 'titleBar.inactiveBackground', 'banner.background'];
const hasBackdrop = t => t.background.kind !== 'solid' || t.background.ember !== 'off';
/**
 * The window-side form of a theme: workbench colour overrides, syntax rules and the backdrop.
 * The Charcoal preset (base) changes nothing, so the window shows the Furnace Charcoal theme as is.
 * `installed` holds token rules and the foreground of an installed colour theme, when chosen.
 */
function resolve(input, { installed = null, pictureFile = () => null } = {}) {
    const t = sanitize(input);
    const plain = presetById(input?.id)?.base && input?.preset;
    const panel = t.background.color, text = t.text.main, muted = t.text.muted, accent = t.accent, editor = t.editor.background;
    const light = isLight(panel), onAccent = onColor(accent);
    const preset = CODE[t.code];
    const codeFg = installed?.foreground || (preset && !preset.base ? preset.fg : null);
    const tabText = contrast(text, editor) >= 4.5 ? text : readable(codeFg || text, editor, 4.5);
    const surface = shift(panel, 0.04), line = alpha(text, 0.1);
    const colors = plain ? {} : {
        // Background (panels around the editor) and font colour.
        ...Object.fromEntries(PANEL_KEYS.map(key => [key, panel])),
        foreground: text, descriptionForeground: muted, 'icon.foreground': text, disabledForeground: alpha(muted, 0.6),
        'sideBar.foreground': text, 'sideBarTitle.foreground': text, 'sideBarSectionHeader.foreground': text, 'sideBar.border': line, 'sideBarSectionHeader.border': line,
        'activityBar.foreground': text, 'activityBar.inactiveForeground': muted, 'activityBar.border': line,
        'statusBar.foreground': text, 'statusBar.noFolderForeground': text, 'statusBar.border': line, 'statusBarItem.hoverBackground': alpha(text, 0.1),
        'panel.border': line, 'panelTitle.activeForeground': text, 'panelTitle.inactiveForeground': muted, 'panelSectionHeader.background': surface,
        'titleBar.activeForeground': text, 'titleBar.inactiveForeground': muted, 'titleBar.border': line,
        'menu.background': surface, 'menu.foreground': text, 'menu.selectionBackground': alpha(accent, 0.25), 'menu.selectionForeground': text,
        'menu.separatorBackground': line, 'menu.border': line, 'menubar.selectionBackground': alpha(text, 0.1), 'menubar.selectionForeground': text,
        'quickInput.background': surface, 'quickInput.foreground': text, 'quickInputTitle.background': shift(panel, 0.07), 'pickerGroup.foreground': accent,
        'input.background': shift(panel, 0.06), 'input.foreground': text, 'input.placeholderForeground': alpha(muted, 0.8), 'input.border': alpha(text, 0.14),
        'dropdown.background': shift(panel, 0.06), 'dropdown.foreground': text, 'dropdown.border': alpha(text, 0.14),
        'list.hoverBackground': alpha(text, 0.07), 'list.activeSelectionBackground': alpha(accent, 0.24), 'list.activeSelectionForeground': text,
        'list.inactiveSelectionBackground': alpha(text, 0.1), 'list.inactiveSelectionForeground': text, 'list.focusOutline': accent, 'list.highlightForeground': accent,
        'scrollbarSlider.background': alpha(text, 0.14), 'scrollbarSlider.hoverBackground': alpha(text, 0.22), 'scrollbarSlider.activeBackground': alpha(text, 0.3),
        'widget.shadow': light ? '#00000026' : '#0000008c', 'terminal.background': panel, 'terminal.foreground': text,
        // Accent.
        focusBorder: accent, 'button.background': accent, 'button.foreground': onAccent, 'button.hoverBackground': mix(accent, onAccent, 0.15),
        'button.secondaryBackground': alpha(text, 0.1), 'button.secondaryForeground': text, 'button.secondaryHoverBackground': alpha(text, 0.16),
        'progressBar.background': accent, 'activityBar.activeBorder': accent, 'activityBarBadge.background': accent, 'activityBarBadge.foreground': onAccent,
        'badge.background': alpha(accent, 0.3), 'badge.foreground': text, 'panelTitle.activeBorder': accent, 'textLink.foreground': readable(accent, panel, 4.5),
        'textLink.activeForeground': readable(accent, panel, 4.5), 'inputOption.activeBorder': accent, 'checkbox.border': alpha(text, 0.2), 'sash.hoverBorder': accent,
        'statusBarItem.remoteBackground': accent, 'statusBarItem.remoteForeground': onAccent, 'tab.activeBorderTop': accent, 'editorCursor.foreground': accent,
        // Editor colour (solid): the editor, its gutter and the tab strip above it.
        'editor.background': editor, 'editorGutter.background': editor, 'minimap.background': editor, 'breadcrumb.background': editor, 'editorStickyScroll.background': editor,
        'editorGroupHeader.tabsBackground': shift(editor, 0.03), 'editorGroupHeader.noTabsBackground': editor, 'editorGroup.border': shift(editor, 0.08),
        'tab.activeBackground': editor, 'tab.unfocusedActiveBackground': editor, 'tab.inactiveBackground': shift(editor, 0.03), 'tab.border': shift(editor, 0.06),
        'tab.activeForeground': tabText, 'tab.inactiveForeground': mix(tabText, editor, 0.4), 'tab.unfocusedActiveForeground': mix(tabText, editor, 0.2),
        'breadcrumb.foreground': mix(tabText, editor, 0.3), 'editorLineNumber.foreground': mix(codeFg || tabText, editor, 0.55), 'editorLineNumber.activeForeground': codeFg || tabText,
        ...(codeFg ? { 'editor.foreground': codeFg } : {}),
    };
    const rules = installed?.rules || codeRules(t.code);
    const picture = t.background.kind === 'picture' ? pictureFile(t.background.picture) : null;
    return {
        colors,
        tokenColors: rules ? { textMateRules: rules } : null,
        // Light themes sit on a light base so the colours they don't set (hovers, widgets) are light too.
        colorTheme: plain ? null : light ? 'Default Light Modern' : 'Furnace Charcoal',
        panelKeys: PANEL_KEYS,
        layer: plain || !hasBackdrop(t) ? null : {
            kind: picture ? 'picture' : t.background.kind === 'gradient' ? 'gradient' : 'solid',
            stops: t.background.gradient?.stops || [panel], angle: t.background.gradient?.angle ?? 160, picture, fit: t.background.picture?.fit || 'cover',
            dim: t.background.dim, glass: t.background.glass, ember: t.background.ember, emberIntensity: t.background.emberIntensity, panel, text,
        },
        font: t.font.family || null,
        light,
    };
}
/** Furnace's action colour (the icon's ember), as in media/workspace.css. */
const EMBER = '#ff7a2a';
/** Colour tokens for Furnace's panels (media/workspace.css); null keeps the stylesheet's Charcoal values. */
function panelTokens(input) {
    const t = sanitize(input);
    if (presetById(input?.id)?.base && input?.preset) return null;
    const panel = t.background.color, text = t.text.main, muted = t.text.muted, accent = t.accent, light = isLight(panel);
    const action = accent.toLowerCase() === '#c6c6c6' ? (light ? '#c2410c' : EMBER) : accent;
    const status = light
        ? { ok: '#3f7a3a', pass: '#2f7d32', add: '#2f7d32', bad: '#b3412e', danger: '#b3412e', warn: '#8f6310', info: '#3d5a8a', yellow: '#806400', 'ok-text': '#355e33' }
        : { ok: '#a9b8a0', pass: '#a9c79a', add: '#b5cf9e', bad: '#e0a99b', danger: '#dbafa5', warn: '#d5b483', info: '#8f9fb8', yellow: '#e3cf96', 'ok-text': '#c9d1c4' };
    return {
        text, soft: mix(text, muted, 0.5), muted, faint: mix(muted, panel, 0.2), ink: text,
        accent, 'accent-strong': accent, 'accent-hover': shift(accent, 0.12), 'on-accent': onColor(accent),
        // Primary actions (Send, Approve, focus rings, the working state): the theme's accent, or Furnace's
        // ember where the accent is Charcoal's neutral silver.
        action, 'action-hover': shift(action, 0.12), 'on-action': onColor(action),
        line: alpha(text, 0.06), 'line-strong': alpha(text, 0.1), raised: alpha(text, 0.025),
        panel, surface: shift(panel, 0.04), 'raised-solid': shift(panel, 0.07), scroll: shift(panel, 0.15),
        well: light ? shift(panel, 0.04) : mix(panel, '#000000', 0.35), 'code-bg': light ? '#1e1f22' : mix(t.editor.background, '#000000', 0.4),
        font: t.font.family ? `"${t.font.family}"` : '', scheme: light ? 'light' : 'dark', ...status,
    };
}

// ---------- surprise me ----------
/** A random, readable theme. `random` is injectable for tests. */
function surprise(random = Math.random) {
    const hsl = (h, s, l) => {
        const a = s * Math.min(l, 1 - l), f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
        return toHex([f(0), f(8), f(4)].map(v => v * 255));
    };
    const hue = Math.floor(random() * 360), light = random() < 0.2, accentHue = (hue + 150 + Math.floor(random() * 60)) % 360;
    const panel = light ? hsl(hue, 0.25, 0.94) : hsl(hue, 0.35, 0.07);
    const draft = {
        id: 'surprise', name: 'Surprise',
        background: random() < 0.75 ? { kind: 'gradient', color: panel, gradient: { stops: light ? [hsl(hue, 0.4, 0.9), hsl((hue + 40) % 360, 0.35, 0.96)] : [hsl(hue, 0.55, 0.2), hsl((hue + 40) % 360, 0.45, 0.08), hsl(hue, 0.3, 0.03)], angle: Math.floor(random() * 360) } } : { kind: 'solid', color: panel },
        font: { family: ['', 'Inter', 'Nunito', 'Atkinson Hyperlegible Next'][Math.floor(random() * 4)] },
        text: { main: light ? hsl(hue, 0.15, 0.15) : hsl(hue, 0.25, 0.9), muted: light ? hsl(hue, 0.1, 0.38) : hsl(hue, 0.15, 0.66) },
        code: light ? 'daylight' : ['charcoal', 'midnight-purple', 'arctic'][Math.floor(random() * 3)],
        editor: { background: light ? hsl(hue, 0.2, 0.98) : hsl(hue, 0.3, 0.08) },
        accent: hsl(accentHue, 0.75, light ? 0.4 : 0.65),
    };
    let result = sanitize(draft);
    for (const check of checks(result)) if (!check.ok) result = fix(result, check.id);
    return result;
}

module.exports = { PRESETS, PARTS, CODE, PICTURES, FONTS, presetById, sanitize, takePart, checks, fix, resolve, panelTokens, codeRules, surprise, contrast, mix, isLight, hasBackdrop };
