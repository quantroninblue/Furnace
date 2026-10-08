const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const helper = path.join(__dirname, 'sandbox/ai-gui-sandbox-macos.sh');

test('macOS sandbox helper builds a Seatbelt profile from the Linux helper\'s arguments', { skip: process.platform === 'win32' }, () => {
    // Off macOS, stand in for sandbox-exec with a script that prints what it was given.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-macos-test-'));
    try {
        const fake = path.join(dir, 'sandbox-exec'), script = path.join(dir, 'helper.sh');
        fs.writeFileSync(fake, '#!/bin/sh\n[ "$1" = -p ] || exit 9\nprintf "%s\\n" "$2" > "$(dirname "$0")/profile"\nshift 2\nexec "$@"\n', { mode: 0o755 });
        fs.writeFileSync(script, fs.readFileSync(helper, 'utf8').replace('SANDBOX_EXEC=/usr/bin/sandbox-exec', `SANDBOX_EXEC=${fake}`), { mode: 0o755 });
        const project = fs.mkdirSync(path.join(dir, 'my "project"'), { recursive: true }) && path.join(dir, 'my "project"');
        fs.symlinkSync(project, path.join(dir, 'link'));
        const output = execFileSync(script, ['--write', path.join(dir, 'link'), '--write', path.join(dir, 'missing'), '--', '/bin/sh', '-c', 'echo "ran $1"', 'sh', 'ok'], { encoding: 'utf8' });
        assert.equal(output, 'ran ok\n');
        const profile = fs.readFileSync(path.join(dir, 'profile'), 'utf8'), real = fs.realpathSync(project);
        assert.match(profile, /^\(version 1\)\n\(allow default\)\n\(deny file-write\*\)/);
        assert.ok(profile.includes(`(subpath "${real.replace(/"/g, '\\"')}")`), 'symlinks resolved and quotes escaped');
        assert.ok(!profile.includes('missing'), 'absent paths are skipped');
        assert.match(profile, /\(deny network\*\)\n\(allow network\* \(remote unix-socket\)\)/);
        execFileSync(script, ['--allow-network', '--', '/usr/bin/env', 'true']);
        assert.ok(!fs.readFileSync(path.join(dir, 'profile'), 'utf8').includes('deny network'));
        for (const args of [['--bogus'], ['--write'], []]) assert.equal(spawnSync(script, args).status, 125, `rejects ${JSON.stringify(args)}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('macOS sandbox helper confines writes and network on a real Mac', { skip: process.platform !== 'darwin' }, () => {
    assert.match(execFileSync(helper, ['--probe'], { encoding: 'utf8' }), /^ok seatbelt network=denied/);
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-macos-real-')));
    const inside = path.join(dir, 'inside'), outside = path.join(dir, 'outside');
    fs.mkdirSync(inside); fs.mkdirSync(outside);
    try {
        const run = (command) => spawnSync(helper, ['--write', inside, '--', '/bin/bash', '-c', command], { encoding: 'utf8' });
        assert.equal(run(`echo hi > "${inside}/file" && rm "${inside}/file"`).status, 0, 'writes inside the allowed folder');
        assert.notEqual(run(`echo hi > "${outside}/file"`).status, 0, 'writes elsewhere are denied');
        assert.notEqual(run('/usr/bin/curl -sS --max-time 5 https://example.com -o /dev/null').status, 0, 'network is denied');
        assert.equal(run('echo hi | cat > /dev/null').status, 0, 'pipes and /dev/null work');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
