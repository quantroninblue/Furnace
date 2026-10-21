'use strict';
// In-place updates for packaged Furnace builds (no VS Code API here, so CI can drive it too).
//
// A release publishes latest.json and latest.json.sig: the feed lists one download per platform with
// its size and SHA-256, and the signature (Ed25519, private key only in the release workflow) covers
// the feed's exact bytes. Furnace checks the signature with the public key baked into the build, then
// the download's size and hash, so a tampered feed or file is never installed.
//
// Installing: the download is staged next to Furnace's data, and a small detached script waits for
// Furnace's main process to exit, then puts the new version in place:
//   macOS   swaps the .app bundle (the old one is kept until the new one is in place, then removed);
//   Windows runs the Inno Setup user installer silently over the existing install;
//   Linux   installs the new .deb or .rpm with the system's package manager, through pkexec, which
//           asks for the user's password (installing a package needs root).
// A "relaunch" flag file, written by Restart Now, decides whether Furnace opens again afterwards.
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const MAX_DOWNLOAD = 2 * 1024 ** 3;

/** Compares dotted versions ("0.10.2" > "0.9"); non-numeric parts count as 0. */
function newer(candidate, current) {
    const parts = value => String(value).replace(/^v/, '').split(/[.+-]/).slice(0, 3).map(part => Number.parseInt(part, 10) || 0);
    const [a, b] = [parts(candidate), parts(current)];
    for (let index = 0; index < 3; index++) if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0);
    return false;
}

/** The feed key for this machine's download, for example "darwin-arm64" or "win32-x64". */
const platformKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;
/** The feed key for an install target: Linux adds its package type ("linux-x64-deb"). */
const assetKey = (target, arch = process.arch) => target.package ? `${platformKey(target.platform, arch)}-${target.package}` : platformKey(target.platform, arch);

/**
 * Validates an update feed: { version, url, notes?, assets? } with an https release page. Each asset
 * is { file, url, size, sha256 } under its platform key.
 */
function readFeed(value) {
    if (!value || typeof value.version !== 'string' || !/^v?\d+(\.\d+){0,2}$/.test(value.version)) throw new Error('The update feed has no version.');
    const url = new URL(String(value.url || ''));
    if (url.protocol !== 'https:') throw new Error('The update feed must link to an https page.');
    const assets = {};
    for (const [key, asset] of Object.entries(value.assets && typeof value.assets === 'object' ? value.assets : {})) {
        if (!/^[a-z0-9]+(-[a-z0-9]+){1,2}$/.test(key) || !asset || typeof asset !== 'object') throw new Error(`The update feed has a malformed download (${key}).`);
        const download = new URL(String(asset.url || ''));
        if (download.protocol !== 'https:') throw new Error(`The ${key} download must use https.`);
        if (typeof asset.file !== 'string' || !/^[\w.-]{1,128}$/.test(asset.file) || asset.file.startsWith('.')) throw new Error(`The ${key} download has a malformed file name.`);
        if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_DOWNLOAD) throw new Error(`The ${key} download has a malformed size.`);
        if (typeof asset.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(asset.sha256)) throw new Error(`The ${key} download has a malformed SHA-256.`);
        assets[key] = { file: asset.file, url: download.toString(), size: asset.size, sha256: asset.sha256 };
    }
    return { version: value.version.replace(/^v/, ''), url: url.toString(), notes: typeof value.notes === 'string' ? value.notes.slice(0, 300) : '', assets };
}

/** Checks the feed's Ed25519 signature (base64, over the exact bytes) before reading it. */
function verifyFeed(bytes, signature, publicKey) {
    let valid = false;
    try { valid = crypto.verify(null, bytes, publicKey, Buffer.from(String(signature).trim(), 'base64')); } catch { /* Malformed key or signature. */ }
    if (!valid) throw new Error('The update feed signature is not valid.');
    return readFeed(JSON.parse(Buffer.from(bytes).toString('utf8')));
}

/** Fetches the feed and, when the build carries a public key, its signature. */
async function fetchFeed({ feed, publicKey }, fetcher = globalThis.fetch) {
    const get = async url => {
        const response = await fetcher(url, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json, text/plain' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
    };
    const bytes = await get(feed);
    if (!publicKey) return readFeed(JSON.parse(bytes.toString('utf8')));
    return verifyFeed(bytes, (await get(`${feed}.sig`)).toString('utf8'), publicKey);
}

/**
 * Where this copy of Furnace is installed and whether it can replace itself, or why not:
 * { ok: true, platform, bundle | installDir } or { ok: false, reason }.
 */
function installTarget({ platform = process.platform, appRoot, execPath = process.execPath, exists = fs.existsSync, writable = isWritable, owner = packageOwner } = {}) {
    if (platform === 'darwin') {
        const bundle = path.posix.resolve(appRoot || '/', '../../..');
        if (!bundle.endsWith('.app')) return { ok: false, reason: 'Furnace is not running from an app bundle.' };
        if (bundle.startsWith('/Volumes/')) return { ok: false, reason: 'Furnace is running from the disk image. Drag it to Applications first.' };
        if (bundle.includes('/AppTranslocation/')) return { ok: false, reason: 'macOS is running Furnace from a temporary copy. Move Furnace to Applications and open it from there.' };
        if (!writable(path.posix.dirname(bundle)) || !writable(bundle)) return { ok: false, reason: `Furnace can't replace itself in ${path.posix.dirname(bundle)} (no write permission).` };
        return { ok: true, platform, bundle };
    }
    if (platform === 'win32') {
        const installDir = path.win32.dirname(execPath);
        if (!exists(path.win32.join(installDir, 'unins000.exe'))) return { ok: false, reason: 'This copy of Furnace was not installed with the Furnace installer.' };
        return { ok: true, platform, installDir };
    }
    if (platform === 'linux') {
        const installDir = path.posix.resolve(appRoot || '/', '../..');
        const kind = installDir.startsWith('/usr/share/') ? owner(installDir, exists) : null;
        if (!kind) return { ok: false, reason: 'This copy of Furnace was not installed from the Furnace .deb or .rpm package.' };
        if (!exists('/usr/bin/pkexec')) return { ok: false, reason: 'Installing the update needs pkexec (PolicyKit), which is not installed.' };
        return { ok: true, platform, package: kind, installDir };
    }
    return { ok: false, reason: 'In-app updates are available on macOS, Windows and Linux.' };
}
/** Which package manager installed `installDir`: "deb", "rpm" or null. */
function packageOwner(installDir, exists = fs.existsSync, run = require('node:child_process').execFileSync) {
    const name = path.posix.basename(installDir);
    if (exists(`/var/lib/dpkg/info/${name}.list`)) return 'deb';
    try { run('rpm', ['-q', '--quiet', name], { stdio: 'ignore', timeout: 10000 }); return 'rpm'; } catch { return null; }
}
function isWritable(file) {
    try { fs.accessSync(file, fs.constants.W_OK); return true; } catch { return false; }
}

/** Streams a download to `file`, checking its size and SHA-256 (removes it on any mismatch). */
async function download(asset, file, { fetcher = globalThis.fetch, signal, onProgress } = {}) {
    const partial = `${file}.partial`;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const hash = crypto.createHash('sha256');
    let received = 0;
    const out = fs.createWriteStream(partial);
    try {
        const response = await fetcher(asset.url, { signal, redirect: 'follow' });
        if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
        for await (const chunk of response.body) {
            received += chunk.length;
            if (received > asset.size) throw new Error('The download is larger than the update feed says.');
            hash.update(chunk);
            if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
            onProgress?.(received, asset.size);
        }
        await new Promise((resolve, reject) => out.end(error => error ? reject(error) : resolve()));
        if (received !== asset.size) throw new Error('The download is incomplete.');
        if (hash.digest('hex') !== asset.sha256) throw new Error("The download doesn't match the update feed (SHA-256).");
        await fsp.rename(partial, file);
        return file;
    } catch (error) {
        // Wait for the file to close (or finish opening) before removing it, or the open can
        // land after the removal and leave the partial file behind (seen on Windows).
        await new Promise(resolve => { if (out.closed) return resolve(); out.once('close', resolve); out.destroy(); });
        await fsp.rm(partial, { force: true });
        throw error;
    }
}

/** Already downloaded and complete: the file matches the feed's size and SHA-256. */
async function verified(asset, file) {
    try {
        if ((await fsp.stat(file)).size !== asset.size) return false;
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
        return hash.digest('hex') === asset.sha256;
    } catch { return false; }
}

/**
 * Turns a verified download into what the install script puts in place: on macOS the .app extracted
 * from the zip (with its code signature checked); on Windows the installer itself.
 */
async function stage(target, file, dir, { run = promisify(execFile) } = {}) {
    if (target.platform === 'win32' || target.platform === 'linux') return file;
    const extracted = path.join(dir, 'extracted');
    await fsp.rm(extracted, { recursive: true, force: true });
    await run('/usr/bin/ditto', ['-x', '-k', file, extracted]);
    const apps = (await fsp.readdir(extracted)).filter(name => name.endsWith('.app'));
    if (apps.length !== 1) throw new Error('The macOS update does not contain one app.');
    const app = path.join(extracted, apps[0]);
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    return app;
}

const sh = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
const ps = value => `'${String(value).replace(/'/g, "''")}'`;

/** POSIX sh script (macOS): wait for Furnace to exit, swap the bundle, reopen when asked to. */
function darwinScript({ pid, bundle, app, dir, flag, log, opener = '/usr/bin/open' }) {
    return `#!/bin/sh
# Furnace update: installs ${sh(app)} in place of ${sh(bundle)} once process ${pid} has exited.
bundle=${sh(bundle)}; app=${sh(app)}; previous=${sh(path.join(dir, 'previous.app'))}; flag=${sh(flag)}
exec >>${sh(log)} 2>&1
echo "$(date '+%F %T') waiting for Furnace (process ${pid}) to quit"
while kill -0 ${pid} 2>/dev/null; do sleep 1; done
sleep 1
rm -rf "$previous"
if ! mv "$bundle" "$previous"; then echo "could not move the current app aside"; exit 1; fi
if ! mv "$app" "$bundle"; then echo "could not move the new app in place; restoring"; mv "$previous" "$bundle"; exit 1; fi
rm -rf "$previous"
echo "$(date '+%F %T') installed"
if [ -e "$flag" ]; then rm -f "$flag"; ${sh(opener)} "$bundle"; fi
exit 0
`;
}

/**
 * POSIX sh script (Linux): wait for Furnace to exit, install the package as root through `elevate`
 * (pkexec: the system asks for the user's password), then reopen Furnace when asked to, also when
 * the install was cancelled, so Restart Now always brings Furnace back.
 */
function linuxScript({ pid, file, kind, flag, log, elevate = ['/usr/bin/pkexec'], launcher = '/usr/bin/furnace' }) {
    const install = kind === 'deb'
        ? `${elevate.map(sh).join(' ')} /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get install -y --reinstall --allow-downgrades ${sh(file)}`
        : `if command -v dnf >/dev/null 2>&1; then ${elevate.map(sh).join(' ')} dnf install -y ${sh(file)}; `
            + `elif command -v zypper >/dev/null 2>&1; then ${elevate.map(sh).join(' ')} zypper --non-interactive install --allow-unsigned-rpm ${sh(file)}; `
            + `else ${elevate.map(sh).join(' ')} rpm -U --replacepkgs ${sh(file)}; fi`;
    return `#!/bin/sh
# Furnace update: installs ${sh(file)} once process ${pid} has exited.
flag=${sh(flag)}
exec >>${sh(log)} 2>&1
echo "$(date '+%F %T') waiting for Furnace (process ${pid}) to quit"
while kill -0 ${pid} 2>/dev/null; do sleep 1; done
sleep 1
${install}
status=$?
echo "$(date '+%F %T') package install exited with $status"
if [ -e "$flag" ]; then rm -f "$flag"; setsid ${sh(launcher)} >/dev/null 2>&1 < /dev/null & fi
exit $status
`;
}

/**
 * Windows PowerShell script: wait for Furnace to exit, then run the installer silently over the
 * existing install (Inno Setup keeps the user's earlier choices; runcode reopens Furnace).
 */
function windowsScript({ pid, setup, flag, log }) {
    return `$ErrorActionPreference = 'Continue'
# Furnace update: runs the installer once process ${pid} has exited.
$log = ${ps(log)}
Add-Content -Path $log -Value "$(Get-Date -Format s) waiting for Furnace (process ${pid}) to quit"
Wait-Process -Id ${pid} -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$tasks = if (Test-Path -LiteralPath ${ps(flag)}) { 'runcode' } else { '!runcode' }
Remove-Item -LiteralPath ${ps(flag)} -ErrorAction SilentlyContinue
$setup = Start-Process -FilePath ${ps(setup)} -ArgumentList @('/verysilent', '/suppressmsgboxes', '/norestart', "/mergetasks=$tasks", ('/log="' + ${ps(`${log}.setup.txt`)} + '"')) -Wait -PassThru
Add-Content -Path $log -Value "$(Get-Date -Format s) installer exited with $($setup.ExitCode)"
exit $setup.ExitCode
`;
}

/**
 * Writes the install script into `dir` and starts it detached, waiting for process `pid` (Furnace's
 * main process). On Windows it is started through WMI, so it is not a child of Furnace and outlives
 * Furnace's process tree and job objects. Returns the script and log paths.
 */
async function startInstaller({ target, staged, dir, pid, spawner = spawn, elevate }) {
    const flag = relaunchFlag(dir), log = path.join(dir, 'install.log');
    await fsp.rm(flag, { force: true });
    if (target.platform === 'darwin' || target.platform === 'linux') {
        const script = path.join(dir, 'install.sh');
        await fsp.writeFile(script, target.platform === 'darwin'
            ? darwinScript({ pid, bundle: target.bundle, app: staged, dir, flag, log })
            : linuxScript({ pid, file: staged, kind: target.package, flag, log, ...(elevate ? { elevate } : {}) }), { mode: 0o700 });
        spawner('/bin/sh', [script], { detached: true, stdio: 'ignore', env: cleanEnvironment() }).unref();
        return { script, log };
    }
    const script = path.join(dir, 'install.ps1');
    await fsp.writeFile(script, windowsScript({ pid, setup: staged, flag, log }));
    const command = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`;
    const launcher = `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; `
        + `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${ps(command)}; ProcessStartupInformation = $si }; `
        + `if ($r.ReturnValue -ne 0) { exit 1 }`;
    await new Promise((resolve, reject) => {
        const child = spawner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launcher], { stdio: 'ignore', windowsHide: true });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Could not start the installer (code ${code}).`)));
    });
    return { script, log };
}

// The extension host's environment marks Electron to run as Node (ELECTRON_RUN_AS_NODE) and carries
// VS Code's process handles; Furnace reopened with it would not start as the app.
const cleanEnvironment = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([key]) => !/^(ELECTRON_|VSCODE_)/.test(key)));

const relaunchFlag = dir => path.join(dir, 'relaunch');
/** Restart Now: Furnace opens again once the update is installed. */
const requestRelaunch = dir => fsp.writeFile(relaunchFlag(dir), 'yes');

module.exports = { newer, platformKey, assetKey, readFeed, verifyFeed, fetchFeed, installTarget, packageOwner, download, verified, stage, darwinScript, linuxScript, windowsScript, startInstaller, cleanEnvironment, requestRelaunch, relaunchFlag };
