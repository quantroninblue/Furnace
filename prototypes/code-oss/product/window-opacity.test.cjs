const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { appProcesses } = require('./window-opacity.cjs');

test('window opacity only targets the app\'s own process chain, not the program that started it', { skip: process.platform !== 'linux' }, () => {
    // A node process started by a shell: the chain is node itself; the shell (another program) ends it.
    const script = `console.log(JSON.stringify({ pid: process.pid, ppid: process.ppid, found: [...require(${JSON.stringify(require.resolve('./window-opacity.cjs'))}).appProcesses()] }))`;
    const result = JSON.parse(execFileSync('/bin/sh', ['-c', `"${process.execPath}" -e '${script}'; true`], { encoding: 'utf8' }));
    assert.deepEqual(result.found, [result.pid]);
    assert.ok(!result.found.includes(result.ppid), 'the shell that started it is excluded');
});
