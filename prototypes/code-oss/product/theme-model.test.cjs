'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('./theme-model.cjs');

test('every preset is valid, and all but Paper/High Contrast are dark', () => {
    for (const preset of model.PRESETS) {
        const clean = model.sanitize(preset);
        assert.equal(clean.name, preset.name);
        assert.deepEqual(clean.text, preset.text);
        assert.ok(
            model
                .checks(preset)
                .filter(check => ['text', 'muted', 'code'].includes(check.id))
                .every(check => check.ok),
            `${preset.id} is readable`,
        );
    }
    assert.equal(model.isLight(model.presetById('paper').background.color), true);
});

test('the Charcoal preset changes nothing; a saved copy of it is a full theme', () => {
    const plain = model.resolve(model.presetById('charcoal'));
    assert.deepEqual(plain.colors, {});
    assert.equal(plain.layer, null);
    assert.equal(plain.colorTheme, null);
    assert.equal(plain.tokenColors, null);
    assert.equal(model.panelTokens(model.presetById('charcoal')), null);
    const copy = model.resolve({ ...model.sanitize(model.presetById('charcoal')), id: 'user-1' });
    assert.equal(copy.colors['sideBar.background'], '#101010');
    assert.equal(copy.colorTheme, 'Furnace Charcoal');
});

test('resolve maps the six parts to the window', () => {
    const theme = model.sanitize({
        ...model.presetById('midnight'),
        accent: '#ff0000',
        editor: { background: '#202020' },
    });
    const result = model.resolve(theme);
    assert.equal(result.colors.focusBorder, '#ff0000');
    assert.equal(result.colors['button.foreground'], '#000000');
    assert.equal(result.colors['editor.background'], '#202020');
    assert.equal(result.colors['tab.activeBackground'], '#202020'); // Tabs follow the editor colour.
    assert.equal(result.colors['sideBar.background'], '#0a1020');
    assert.equal(result.layer.kind, 'gradient');
    assert.deepEqual(result.layer.stops, ['#122452', '#0a1328', '#05080f']);
    assert.ok(result.tokenColors.textMateRules.some(rule => rule.scope.includes('comment')));
    assert.equal(result.font, 'Inter');
    // Light themes sit on a light base theme.
    assert.equal(model.resolve(model.presetById('paper')).colorTheme, 'Default Light Modern');
});

test('sanitize drops unsafe or unknown values from imported themes', () => {
    const clean = model.sanitize({
        id: '../../etc',
        name: 'x'.repeat(200),
        font: { family: 'Inter"; } body { display: none' },
        accent: 'red',
        background: {
            kind: 'picture',
            picture: { source: 'user', name: '../secret.png' },
            color: '#ABCDEF',
            dim: 7,
            ember: 'fireworks',
        },
        code: 'installed:\nevil',
        text: { main: '#fff' },
        extra: true,
    });
    assert.equal(clean.id, 'custom');
    assert.equal(clean.name.length, 60);
    assert.equal(clean.font.family, '');
    assert.equal(clean.accent, '#c6c6c6');
    assert.equal(clean.background.kind, 'solid'); // The picture name was rejected.
    assert.equal(clean.background.picture, null);
    assert.equal(clean.background.color, '#abcdef');
    assert.equal(clean.background.dim, 0.95);
    assert.equal(clean.background.ember, 'off');
    assert.equal(clean.code, 'charcoal');
    assert.equal(clean.text.main, '#dadada');
    assert.equal('extra' in clean, false);
    // A gradient needs two colours and bundled pictures must exist.
    assert.equal(
        model.sanitize({ background: { kind: 'gradient', gradient: { stops: ['#000000'] } } }).background.kind,
        'solid',
    );
    assert.equal(
        model.sanitize({ background: { kind: 'picture', picture: { source: 'bundled', name: 'nope' } } }).background
            .kind,
        'solid',
    );
    assert.equal(
        model.sanitize({ background: { kind: 'picture', picture: { source: 'bundled', name: 'night-sky' } } })
            .background.picture.name,
        'night-sky',
    );
});

test('Use from theme copies one part', () => {
    const mine = model.sanitize({ ...model.presetById('forest'), id: 'user-a', name: 'Mine' });
    const result = model.takePart(mine, model.presetById('synthwave'), 'background');
    assert.deepEqual(result.background.gradient.stops, model.presetById('synthwave').background.gradient.stops);
    assert.deepEqual(result.text, mine.text);
    assert.equal(result.name, 'Mine');
    assert.throws(() => model.takePart(mine, mine, 'nonsense'));
});

test('readability checks fail on low contrast and Fix repairs them', () => {
    let theme = model.sanitize({
        ...model.presetById('charcoal'),
        text: { main: '#333333', muted: '#222222' },
        accent: '#151515',
        code: 'daylight',
        editor: { background: '#202020' },
    });
    const failing = model
        .checks(theme)
        .filter(check => !check.ok)
        .map(check => check.id);
    assert.deepEqual(failing.sort(), ['accent', 'code', 'muted', 'text']);
    for (const id of failing) theme = model.fix(theme, id);
    assert.ok(
        model.checks(theme).every(check => check.ok),
        JSON.stringify(model.checks(theme)),
    );
});

test('Surprise Me makes readable themes', () => {
    let seed = 1;
    const random = () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
    };
    for (let i = 0; i < 40; i++) {
        const theme = model.surprise(random);
        assert.ok(
            model.checks(theme).every(check => check.ok),
            JSON.stringify(model.checks(theme)),
        );
    }
});

test('imported pictures are recognised by content, and theme files may have comments', () => {
    const { pictureType, parseJsonc } = loadManagerHelpers();
    assert.equal(pictureType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), 'png');
    assert.equal(pictureType(Buffer.from('GIF89a....')), 'gif');
    assert.equal(pictureType(Buffer.from('<!-- art --><svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'svg');
    assert.equal(pictureType(Buffer.from('#!/bin/sh\nrm -rf /')), null);
    assert.deepEqual(parseJsonc('{ // note\n "a": "http://x", /* b */ "c": [1, 2,], }'), { a: 'http://x', c: [1, 2] });
});

// theme-manager.cjs needs vscode; its pure helpers are loaded with a stub.
function loadManagerHelpers() {
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function (request, ...rest) {
        return request === 'vscode' ? {} : original.call(this, request, ...rest);
    };
    try {
        return require('./theme-manager.cjs');
    } finally {
        Module._load = original;
    }
}
