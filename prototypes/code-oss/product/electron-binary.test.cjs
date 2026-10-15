const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { electronBinary } = require('./electron-binary.cjs');

// The bundle is simulated with this machine's paths; on Windows those can't be macOS bundle paths.
test('macOS hosts start from the bundle\'s main binary, not the extension host helper', { skip: process.platform === 'win32' && 'macOS bundle paths cannot be simulated with Windows paths' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-binary-'));
    try {
        const bundle = path.join(dir, 'Furnace.app'), helper = path.join(bundle, 'Contents/Frameworks/Furnace Helper (Plugin).app/Contents/MacOS/Furnace Helper (Plugin)');
        fs.mkdirSync(path.join(bundle, 'Contents/MacOS'), { recursive: true });
        fs.writeFileSync(path.join(bundle, 'Contents/MacOS/Furnace'), '');
        assert.equal(electronBinary(helper, 'darwin'), path.join(bundle, 'Contents/MacOS/Furnace'));
        assert.equal(electronBinary(helper, 'linux'), helper);
        assert.equal(electronBinary('/opt/furnace/furnace', 'darwin'), '/opt/furnace/furnace');
        fs.writeFileSync(path.join(bundle, 'Contents/MacOS/Other'), '');
        assert.equal(electronBinary(helper, 'darwin'), helper, 'ambiguous bundles keep the current binary');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
