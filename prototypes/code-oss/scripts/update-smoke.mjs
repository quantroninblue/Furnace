// End-to-end check of the in-app updater's install step on a real macOS or Windows runner
// (.github/workflows/release.yml), using the build just made as the "new" version:
//   node scripts/update-smoke.mjs darwin <Furnace.app> <Furnace-darwin-arm64.zip>
//   node scripts/update-smoke.mjs win32 <FurnaceUserSetup-x64.exe>
//   node scripts/update-smoke.mjs linux <Furnace-linux-x64.deb>   (under xvfb-run; sudo stands in for pkexec)
// Installs Furnace, starts it, stages the update and starts the install script exactly as Update →
// Restart Now does, then ends Furnace's whole process tree. Passes when the install script survives
// that, installs the update, and Furnace opens again.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const updater = require('../product/updater.cjs');
const [platform, ...args] = process.argv.slice(2);
const work = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'furnace-update-smoke');
const dir = path.join(work, 'update'),
    profile = path.join(work, 'profile');
await rm(work, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(what, check, seconds) {
    for (let i = 0; i < seconds; i++) {
        if (check()) return;
        await sleep(1000);
    }
    const log = path.join(dir, 'install.log');
    throw new Error(
        `Timed out waiting for ${what}.${existsSync(log) ? `\ninstall.log:\n${readFileSync(log, 'utf8')}` : ''}`,
    );
}
// Ends Furnace like a quit, then forcefully if it hasn't exited after a grace period (an app sent
// SIGTERM may take its time; the updater only needs the process gone).
async function end(pid) {
    const alive = () => {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    };
    try {
        process.kill(-pid, 'SIGTERM');
    } catch {
        /* Already gone. */
    }
    for (let i = 0; i < 10 && alive(); i++) await sleep(1000);
    if (alive()) {
        console.log(`Process ${pid} ignored SIGTERM for 10 s; sending SIGKILL.`);
        try {
            process.kill(-pid, 'SIGKILL');
        } catch {
            /* Already gone. */
        }
    }
}
const running = pattern => {
    try {
        return platform !== 'win32'
            ? execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim() !== ''
            : execFileSync('tasklist', ['/FI', `IMAGENAME eq ${pattern}`], { encoding: 'utf8' }).includes(pattern);
    } catch {
        return false;
    }
};

if (platform === 'darwin') {
    const [built, zip] = args;
    const bundle = path.join(work, 'Applications', path.basename(built));
    await mkdir(path.dirname(bundle), { recursive: true });
    execFileSync('ditto', [built, bundle]);
    const binary = path.join(
        bundle,
        'Contents/MacOS',
        execFileSync('ls', [path.join(bundle, 'Contents/MacOS')], { encoding: 'utf8' }).trim(),
    );
    const furnace = spawn(binary, ['--user-data-dir', profile, '--skip-welcome', '--disable-updates', '--new-window'], {
        detached: true,
        stdio: 'ignore',
    });
    await sleep(10000);
    // Marks the installed copy; the update must replace the whole bundle.
    writeFileSync(path.join(bundle, 'Contents/Resources/update-smoke-marker'), 'old');
    const target = updater.installTarget({ platform, appRoot: path.join(bundle, 'Contents/Resources/app') });
    if (!target.ok) throw new Error(target.reason);
    const staged = await updater.stage(target, zip, dir);
    await updater.startInstaller({ target, staged, dir, pid: furnace.pid });
    await updater.requestRelaunch(dir);
    await end(furnace.pid); // Furnace's whole process group, as quitting does.
    await waitFor(
        'the update to install',
        () =>
            existsSync(path.join(dir, 'install.log')) &&
            readFileSync(path.join(dir, 'install.log'), 'utf8').includes('installed'),
        120,
    );
    if (existsSync(path.join(bundle, 'Contents/Resources/update-smoke-marker')))
        throw new Error('The old app is still in place.');
    execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
    await waitFor('Furnace to open again', () => running(binary), 60);
    execFileSync('pkill', ['-f', binary]);
    console.log(`macOS update install PASS:\n${readFileSync(path.join(dir, 'install.log'), 'utf8')}`);
} else if (platform === 'win32') {
    const setup = path.resolve(args[0]); // The install script runs elsewhere (System32): use a full path, as real updates do.
    execFileSync(setup, ['/verysilent', '/suppressmsgboxes', '/norestart', '/mergetasks=!runcode'], {
        stdio: 'inherit',
    });
    const installDir = path.join(process.env.LOCALAPPDATA, 'Programs', 'Furnace'),
        exe = path.join(installDir, 'Furnace.exe');
    const target = updater.installTarget({ platform, execPath: exe });
    if (!target.ok) throw new Error(target.reason);
    // Marks the installed copy: a normal (not background) install deletes resources\app\out first.
    const appDir = [installDir, ...readdirSync(installDir).map(name => path.join(installDir, name))]
        .map(base => path.join(base, 'resources', 'app'))
        .find(app => existsSync(path.join(app, 'out')));
    if (!appDir) throw new Error(`No resources\\app\\out under ${installDir}`);
    const marker = path.join(appDir, 'out', 'update-smoke-marker');
    const furnace = spawn(exe, ['--user-data-dir', profile, '--skip-welcome', '--disable-updates', '--new-window'], {
        detached: true,
        stdio: 'ignore',
    });
    await sleep(15000);
    writeFileSync(marker, 'old');
    const staged = await updater.stage(target, setup, dir);
    await updater.startInstaller({ target, staged, dir, pid: furnace.pid });
    await updater.requestRelaunch(dir);
    // End Furnace's whole process tree: the install script, started through WMI, must survive it.
    // taskkill exits non-zero when a child ends on its own mid-kill, so check the result instead.
    try {
        execFileSync('taskkill', ['/PID', String(furnace.pid), '/T', '/F'], { stdio: 'inherit' });
    } catch {
        /* Checked below. */
    }
    await waitFor(
        'Furnace to end',
        () => {
            try {
                process.kill(furnace.pid, 0);
                return false;
            } catch {
                return true;
            }
        },
        30,
    );
    await waitFor(
        'the installer to finish',
        () =>
            existsSync(path.join(dir, 'install.log')) &&
            /installer exited with/.test(readFileSync(path.join(dir, 'install.log'), 'utf8')),
        300,
    );
    const log = readFileSync(path.join(dir, 'install.log'), 'utf8');
    if (!/installer exited with 0/.test(log))
        throw new Error(
            `The installer failed:\n${log}\n${existsSync(path.join(dir, 'install.log.setup.txt')) ? readFileSync(path.join(dir, 'install.log.setup.txt'), 'utf8').slice(-4000) : ''}`,
        );
    if (existsSync(marker)) throw new Error('Furnace was not reinstalled (the old files are still there).');
    await waitFor('Furnace to open again', () => running('Furnace.exe'), 60);
    try {
        execFileSync('taskkill', ['/IM', 'Furnace.exe', '/T', '/F'], { stdio: 'inherit' });
    } catch {
        /* Cleanup only. */
    }
    console.log(`Windows update install PASS:\n${log}`);
} else if (platform === 'linux') {
    const [deb] = args.map(file => path.resolve(file));
    execFileSync('sudo', ['apt-get', 'install', '-y', deb], { stdio: 'inherit' });
    const target = updater.installTarget({ platform, appRoot: '/usr/share/furnace/resources/app' });
    if (!target.ok || target.package !== 'deb')
        throw new Error(target.reason || `Expected a .deb install, found ${target.package}`);
    // A Furnace main process to quit (the test display comes from xvfb-run).
    const furnace = spawn(
        '/usr/share/furnace/furnace',
        ['--user-data-dir', profile, '--skip-welcome', '--disable-updates', '--new-window'],
        { detached: true, stdio: 'ignore', env: updater.cleanEnvironment() },
    );
    await sleep(15000);
    // Marks the installed copy: remove a packaged file, which reinstalling the package restores.
    const packaged = '/usr/share/furnace/resources/app/extensions/furnace-workspace/package.json';
    const marker = '/usr/share/furnace/resources/app/extensions/furnace-workspace/media/fonts/inter-LICENSE.txt';
    if (!existsSync(packaged) || !existsSync(marker))
        throw new Error('The installed package is missing Furnace files.');
    execFileSync('sudo', ['rm', marker]);
    const staged = await updater.stage(target, deb, dir);
    await updater.startInstaller({ target, staged, dir, pid: furnace.pid, elevate: ['sudo', '-n'] });
    await updater.requestRelaunch(dir);
    await end(furnace.pid);
    await waitFor(
        'the package to install',
        () =>
            existsSync(path.join(dir, 'install.log')) &&
            /package install exited with/.test(readFileSync(path.join(dir, 'install.log'), 'utf8')),
        300,
    );
    const log = readFileSync(path.join(dir, 'install.log'), 'utf8');
    if (!/package install exited with 0/.test(log)) throw new Error(`The package install failed:\n${log}`);
    if (!existsSync(marker)) throw new Error('The package was not reinstalled (a removed file is still missing).');
    await waitFor('Furnace to open again', () => running('/usr/share/furnace/furnace'), 60);
    execFileSync('pkill', ['-f', '/usr/share/furnace/furnace']);
    console.log(`Linux update install PASS:\n${log}`);
} else {
    throw new Error('Usage: node scripts/update-smoke.mjs darwin <app> <zip> | win32 <setup.exe> | linux <deb>');
}
