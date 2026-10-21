const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const updater = require('./updater.cjs');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'furnace-updater-'));
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const sign = bytes => crypto.sign(null, bytes, privateKey).toString('base64');
const payload = Buffer.from('Furnace 0.2.0 for macOS');
const feed = {
    version: '0.2.0', url: 'https://github.com/quantroninblue/Furnace/releases/tag/v0.2.0', notes: 'Updates install in place.',
    assets: { 'darwin-arm64': { file: 'Furnace-darwin-arm64.zip', url: 'https://github.com/quantroninblue/Furnace/releases/download/v0.2.0/Furnace-darwin-arm64.zip', size: payload.length, sha256: sha256(payload) } },
};
const response = (body, status = 200) => ({ ok: status < 400, status, body: [body], arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) });

test('the feed lists each platform download with its size and SHA-256; malformed entries are refused', () => {
    const read = updater.readFeed(feed);
    assert.equal(read.version, '0.2.0');
    assert.deepEqual(Object.keys(read.assets), ['darwin-arm64']);
    const bad = changes => () => updater.readFeed({ ...feed, assets: { 'darwin-arm64': { ...feed.assets['darwin-arm64'], ...changes } } });
    assert.throws(bad({ url: 'http://example.com/a.zip' }), /https/);
    assert.throws(bad({ file: '../evil.app' }), /file name/);
    assert.throws(bad({ size: -1 }), /size/);
    assert.throws(bad({ sha256: 'abc' }), /SHA-256/);
    assert.throws(() => updater.readFeed({ ...feed, version: '0.2.0-beta' }), /version/);
    assert.deepEqual(updater.readFeed({ version: '1.0', url: 'https://example.com' }).assets, {});
});

test('a feed is read only when its signature matches the build\'s public key', async () => {
    const bytes = Buffer.from(JSON.stringify(feed));
    assert.equal(updater.verifyFeed(bytes, sign(bytes), publicPem).version, '0.2.0');
    const tampered = Buffer.from(JSON.stringify({ ...feed, version: '9.9.9' }));
    assert.throws(() => updater.verifyFeed(tampered, sign(bytes), publicPem), /signature is not valid/);
    const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
    assert.throws(() => updater.verifyFeed(bytes, sign(bytes), other), /signature is not valid/);
    assert.throws(() => updater.verifyFeed(bytes, 'not base64 at all', publicPem), /signature is not valid/);

    const served = { 'https://feed/latest.json': bytes, 'https://feed/latest.json.sig': Buffer.from(sign(bytes)) };
    const fetcher = async url => served[url] ? response(served[url]) : response(Buffer.alloc(0), 404);
    assert.equal((await updater.fetchFeed({ feed: 'https://feed/latest.json', publicKey: publicPem }, fetcher)).version, '0.2.0');
    delete served['https://feed/latest.json.sig'];
    await assert.rejects(updater.fetchFeed({ feed: 'https://feed/latest.json', publicKey: publicPem }, fetcher), /HTTP 404/);
});

test('Furnace replaces itself only from an installed, writable location', () => {
    const appRoot = '/Applications/Furnace.app/Contents/Resources/app';
    assert.deepEqual(updater.installTarget({ platform: 'darwin', appRoot, writable: () => true }), { ok: true, platform: 'darwin', bundle: '/Applications/Furnace.app' });
    assert.match(updater.installTarget({ platform: 'darwin', appRoot: '/Volumes/Furnace/Furnace.app/Contents/Resources/app', writable: () => true }).reason, /disk image/);
    assert.match(updater.installTarget({ platform: 'darwin', appRoot: '/private/var/folders/x/AppTranslocation/1/d/Furnace.app/Contents/Resources/app', writable: () => true }).reason, /temporary copy/);
    assert.match(updater.installTarget({ platform: 'darwin', appRoot, writable: () => false }).reason, /write permission/);
    assert.match(updater.installTarget({ platform: 'darwin', appRoot: '/opt/furnace/resources/app', writable: () => true }).reason, /app bundle/);
    const execPath = 'C:\\Users\\a\\AppData\\Local\\Programs\\Furnace\\Furnace.exe';
    assert.deepEqual(updater.installTarget({ platform: 'win32', execPath, exists: file => file.endsWith('unins000.exe') }), { ok: true, platform: 'win32', installDir: 'C:\\Users\\a\\AppData\\Local\\Programs\\Furnace' });
    assert.match(updater.installTarget({ platform: 'win32', execPath, exists: () => false }).reason, /installer/);
    assert.match(updater.installTarget({ platform: 'freebsd', appRoot }).reason, /macOS, Windows and Linux/);
});

test('downloads are kept only when their size and SHA-256 match the feed', async () => {
    const dir = temp(), file = path.join(dir, 'update.zip'), asset = feed.assets['darwin-arm64'];
    const progress = [];
    await updater.download(asset, file, { fetcher: async () => response(payload), onProgress: received => progress.push(received) });
    assert.deepEqual(fs.readFileSync(file), payload);
    assert.deepEqual(progress, [payload.length]);
    assert.equal(await updater.verified(asset, file), true);

    for (const [body, message] of [[Buffer.from('Furnace 0.2.0 for macOX'), /SHA-256/], [Buffer.concat([payload, payload]), /larger/], [payload.subarray(0, 4), /incomplete/]]) {
        const other = path.join(dir, 'other.zip');
        await assert.rejects(updater.download(asset, other, { fetcher: async () => response(body) }), message);
        assert.equal(fs.existsSync(other) || fs.existsSync(`${other}.partial`), false);
    }
    await assert.rejects(updater.download(asset, path.join(dir, 'x.zip'), { fetcher: async () => response(Buffer.alloc(0), 404) }), /HTTP 404/);
    fs.writeFileSync(file, 'changed!changed!changed!');
    assert.equal(await updater.verified(asset, file), false);
});

test('the macOS install script swaps the app once Furnace exits, and reopens it only after Restart Now', { skip: process.platform === 'win32' }, async () => {
    for (const relaunch of [false, true]) {
        const dir = temp(), bundle = path.join(dir, 'Applications/Furnace.app'), app = path.join(dir, 'updates/extracted/Furnace.app');
        fs.mkdirSync(bundle, { recursive: true }); fs.writeFileSync(path.join(bundle, 'version'), '0.1.0');
        fs.mkdirSync(app, { recursive: true }); fs.writeFileSync(path.join(app, 'version'), '0.2.0');
        const opener = path.join(dir, 'open.sh'), opened = path.join(dir, 'opened');
        fs.writeFileSync(opener, `#!/bin/sh\necho "$1" > '${opened}'\n`, { mode: 0o755 });
        // A stand-in for Furnace that lives a second; a grandchild, so init reaps it (a child of this
        // test would stay a zombie while the script runs, and still answer kill -0).
        const furnace = { pid: Number(execFileSync('/bin/sh', ['-c', 'sleep 1 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' })) };
        const work = path.join(dir, 'updates'), flag = updater.relaunchFlag(work), log = path.join(work, 'install.log');
        if (relaunch) await updater.requestRelaunch(work);
        fs.writeFileSync(path.join(work, 'install.sh'), updater.darwinScript({ pid: furnace.pid, bundle, app, dir: work, flag, log, opener }));
        const started = Date.now();
        execFileSync('/bin/sh', [path.join(work, 'install.sh')]);
        assert.ok(Date.now() - started >= 900, 'waited for Furnace to exit');
        assert.equal(fs.readFileSync(path.join(bundle, 'version'), 'utf8'), '0.2.0');
        assert.equal(fs.existsSync(path.join(work, 'previous.app')), false);
        assert.match(fs.readFileSync(log, 'utf8'), /installed/);
        assert.equal(fs.existsSync(opened), relaunch);
        if (relaunch) assert.equal(fs.readFileSync(opened, 'utf8').trim(), bundle);
    }
});

test('the macOS install script puts the old app back when the new one can\'t be moved in', { skip: process.platform === 'win32' }, () => {
    const dir = temp(), bundle = path.join(dir, 'Furnace.app');
    fs.mkdirSync(bundle); fs.writeFileSync(path.join(bundle, 'version'), '0.1.0');
    const script = updater.darwinScript({ pid: 2 ** 22 + 1, bundle, app: path.join(dir, 'missing.app'), dir, flag: path.join(dir, 'relaunch'), log: path.join(dir, 'log') });
    assert.throws(() => execFileSync('/bin/sh', ['-c', script]));
    assert.equal(fs.readFileSync(path.join(bundle, 'version'), 'utf8'), '0.1.0');
    assert.match(fs.readFileSync(path.join(dir, 'log'), 'utf8'), /restoring/);
});

test('scripts quote paths with spaces and apostrophes', { skip: process.platform === 'win32' }, () => {
    const dir = temp(), odd = path.join(dir, "Neel's Apps"), bundle = path.join(odd, 'Furnace.app'), app = path.join(odd, 'new $HOME `x`.app');
    fs.mkdirSync(bundle, { recursive: true }); fs.mkdirSync(app); fs.writeFileSync(path.join(app, 'version'), 'new');
    execFileSync('/bin/sh', ['-c', updater.darwinScript({ pid: 2 ** 22 + 1, bundle, app, dir: odd, flag: path.join(odd, 'relaunch'), log: path.join(odd, 'log') })]);
    assert.equal(fs.readFileSync(path.join(bundle, 'version'), 'utf8'), 'new');
    const windows = updater.windowsScript({ pid: 42, setup: "C:\\Users\\O'Brien\\setup.exe", flag: 'C:\\f', log: 'C:\\l' });
    assert.match(windows, /Wait-Process -Id 42/);
    assert.match(windows, /'C:\\Users\\O''Brien\\setup\.exe'/);
    assert.match(windows, /\/verysilent/);
    assert.match(windows, /'runcode' \} else \{ '!runcode'/);
});

test('the installer starts detached: through sh on macOS, through WMI on Windows', async () => {
    const calls = [], child = () => Object.assign(new EventEmitter(), { unref() {} });
    const spawner = (file, args, options) => { calls.push({ file, args, options }); const proc = child(); setImmediate(() => proc.emit('exit', 0)); return proc; };
    const dir = temp();
    const mac = await updater.startInstaller({ target: { platform: 'darwin', bundle: '/Applications/Furnace.app' }, staged: path.join(dir, 'Furnace.app'), dir, pid: 7, spawner });
    assert.equal(calls[0].file, '/bin/sh');
    assert.equal(calls[0].options.detached, true);
    assert.match(fs.readFileSync(mac.script, 'utf8'), /kill -0 7/);
    const win = await updater.startInstaller({ target: { platform: 'win32', installDir: 'C:\\F' }, staged: 'C:\\setup.exe', dir, pid: 8, spawner });
    assert.equal(calls[1].file, 'powershell.exe');
    assert.match(calls[1].args.at(-1), /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/);
    assert.match(calls[1].args.at(-1), /install\.ps1/);
    assert.match(fs.readFileSync(win.script, 'utf8'), /Wait-Process -Id 8/);
    const failing = (file, args) => { const proc = child(); setImmediate(() => proc.emit('exit', 1)); return proc; };
    await assert.rejects(updater.startInstaller({ target: { platform: 'win32' }, staged: 'C:\\s.exe', dir, pid: 8, spawner: failing }), /Could not start the installer/);
});

test('Linux: only a Furnace .deb or .rpm install updates itself, through pkexec', () => {
    const appRoot = '/usr/share/furnace/resources/app';
    const exists = file => file === '/usr/bin/pkexec';
    assert.deepEqual(updater.installTarget({ platform: 'linux', appRoot, exists, owner: () => 'deb' }), { ok: true, platform: 'linux', package: 'deb', installDir: '/usr/share/furnace' });
    assert.equal(updater.installTarget({ platform: 'linux', appRoot, exists, owner: () => 'rpm' }).package, 'rpm');
    assert.match(updater.installTarget({ platform: 'linux', appRoot, exists, owner: () => null }).reason, /\.deb or \.rpm/);
    assert.match(updater.installTarget({ platform: 'linux', appRoot: '/home/a/furnace/resources/app', exists, owner: () => 'deb' }).reason, /\.deb or \.rpm/);
    assert.match(updater.installTarget({ platform: 'linux', appRoot, exists: () => false, owner: () => 'deb' }).reason, /pkexec/);
    assert.equal(updater.packageOwner('/usr/share/furnace', file => file === '/var/lib/dpkg/info/furnace.list'), 'deb');
    assert.equal(updater.packageOwner('/usr/share/furnace', () => false, () => {}), 'rpm');
    assert.equal(updater.packageOwner('/usr/share/furnace', () => false, () => { throw new Error('not installed'); }), null);
    assert.equal(updater.assetKey({ platform: 'linux', package: 'deb' }, 'x64'), 'linux-x64-deb');
    assert.equal(updater.assetKey({ platform: 'darwin' }, 'arm64'), 'darwin-arm64');
    const asset = feed.assets['darwin-arm64'];
    assert.deepEqual(Object.keys(updater.readFeed({ ...feed, assets: { 'linux-x64-deb': asset, 'linux-x64-rpm': asset } }).assets), ['linux-x64-deb', 'linux-x64-rpm']);
});

test('the Linux install script installs the package as root once Furnace exits, then reopens it after Restart Now', { skip: process.platform !== 'linux' }, async () => {
    for (const [kind, relaunch] of [['deb', true], ['rpm', false]]) {
        const dir = temp(), calls = path.join(dir, 'calls'), opened = path.join(dir, 'opened');
        const elevate = path.join(dir, 'pkexec'), launcher = path.join(dir, 'furnace');
        fs.writeFileSync(elevate, `#!/bin/sh\necho "$@" >> '${calls}'\nexit 0\n`, { mode: 0o755 });
        fs.writeFileSync(launcher, `#!/bin/sh\necho launched > '${opened}'\n`, { mode: 0o755 });
        const pid = Number(execFileSync('/bin/sh', ['-c', 'sleep 1 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }));
        const flag = updater.relaunchFlag(dir), log = path.join(dir, 'install.log');
        if (relaunch) await updater.requestRelaunch(dir);
        const file = path.join(dir, `Furnace linux.${kind}`);
        execFileSync('/bin/sh', ['-c', updater.linuxScript({ pid, file, kind, flag, log, elevate: [elevate], launcher })]);
        const call = fs.readFileSync(calls, 'utf8');
        if (kind === 'deb') assert.match(call, new RegExp(`apt-get install -y --reinstall --allow-downgrades ${file}`));
        else assert.match(call, /(dnf install -y|zypper|rpm -U)/);
        assert.match(fs.readFileSync(log, 'utf8'), /package install exited with 0/);
        for (let i = 0; i < 20 && relaunch && !fs.existsSync(opened); i++) await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(fs.existsSync(opened), relaunch);
    }
});

test('install scripts start without the extension host\'s Electron and VS Code variables', () => {
    assert.deepEqual(updater.cleanEnvironment({ PATH: '/bin', DISPLAY: ':0', ELECTRON_RUN_AS_NODE: '1', VSCODE_PID: '9', HOME: '/h' }), { PATH: '/bin', DISPLAY: ':0', HOME: '/h' });
});
