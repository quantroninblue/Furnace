// Ubuntu 24.04 amd64 fallback: extract development packages locally, never install
// system packages. A C/C++ toolchain, pkg-config and GLib headers are prerequisites.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { environment, root } from './environment.mjs';

if (
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    !/^VERSION_ID="24\.04"$/m.test(readFileSync('/etc/os-release', 'utf8'))
) {
    throw new Error('This local prerequisite helper supports Ubuntu 24.04 amd64 only. See README.');
}
const cache = path.join(root, '.cache');
mkdirSync(cache, { recursive: true });
const downloads = mkdtempSync(path.join(cache, 'debs-'));
const packages = [
    'libxkbfile-dev',
    'libxkbfile1',
    'libsecret-1-dev',
    'libsecret-1-0',
    'libgcrypt20-dev',
    'libgcrypt20',
    'libgpg-error-dev',
    'libgpg-error0',
];
execFileSync('apt-get', ['download', ...packages], { cwd: downloads, stdio: 'inherit' });
const sysroot = path.join(cache, 'sysroot');
for (const file of readdirSync(downloads).filter(file => file.endsWith('.deb'))) {
    execFileSync('dpkg-deb', ['-x', path.join(downloads, file), sysroot], { stdio: 'inherit' });
}
const metadata = path.join(sysroot, 'usr/lib/x86_64-linux-gnu/pkgconfig');
for (const file of readdirSync(metadata).filter(file => file.endsWith('.pc'))) {
    const target = path.join(metadata, file);
    writeFileSync(target, readFileSync(target, 'utf8').replace(/^prefix=\/usr$/m, `prefix=${sysroot}/usr`));
}
execFileSync('pkg-config', ['--cflags', '--libs', 'xkbfile', 'libsecret-1'], { env: environment(), stdio: 'inherit' });
console.log('Local native prerequisites ready. No system packages were installed.');
