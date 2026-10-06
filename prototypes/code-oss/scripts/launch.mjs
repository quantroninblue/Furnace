import { lstat, mkdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { environment, root, upstream } from './environment.mjs';

export async function launchOptions(profile = process.env.AI_GUI_CODE_OSS_PROFILE ?? path.join(root, '.profile')) {
    const product = JSON.parse(await readFile(path.join(upstream, 'product.json'), 'utf8'));
    const env = { ...environment(), NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1' };
    // Use the existing OS-installed helper where Ubuntu restricts user namespaces.
    // Preserve the bundled helper; change only this prototype's local link.
    if (process.platform === 'linux') {
        for (const helper of ['/opt/google/chrome/chrome-sandbox', '/usr/lib/chromium/chrome-sandbox', '/usr/lib/chromium-browser/chrome-sandbox']) {
            const info = await stat(helper).catch(() => undefined);
            if (info?.isFile() && info.uid === 0 && (info.mode & 0o4000) && !(info.mode & 0o022)) {
                const target = path.join(upstream, '.build/electron/chrome-sandbox');
                const current = await stat(target).catch(() => undefined);
                if (!(current?.uid === 0 && (current.mode & 0o4000) && !(current.mode & 0o022))) {
                    const backup = `${target}.bundled`;
                    if (await lstat(backup).catch(() => undefined)) {
                        throw new Error(`Sandbox helper needs inspection: ${target}`);
                    }
                    await rename(target, backup);
                    try {
                        await symlink(helper, target);
                    } catch (error) {
                        await rename(backup, target);
                        throw error;
                    }
                }
                break;
            }
        }
    }
    // Product overrides (Open VSX extension gallery). Development builds merge
    // upstream/product.overrides.json, which upstream's .gitignore already excludes.
    const overrides = await readFile(path.join(root, 'product.overrides.json'), 'utf8');
    const target = path.join(upstream, 'product.overrides.json');
    if (await readFile(target, 'utf8').catch(() => '') !== overrides) await writeFile(target, overrides);
    delete env.VSCODE_IPC_HOOK_CLI;
    delete env.VSCODE_PORTABLE;
    const absoluteProfile = path.resolve(profile);
    await mkdir(absoluteProfile, { recursive: true });
    const settingsDirectory = path.join(absoluteProfile, 'user-data/User');
    await mkdir(settingsDirectory, { recursive: true });
    // Application-scoped product defaults. Extensions cannot default these, so add
    // any missing keys; never override a value already present in the profile.
    const defaults = {
        'workbench.colorTheme': 'AI GUI Charcoal', 'chat.disableAIFeatures': true,
        'workbench.startupEditor': 'none', 'workbench.secondarySideBar.defaultVisibility': 'visible',
        'telemetry.telemetryLevel': 'off', 'extensions.autoUpdate': false,
        'extensions.autoCheckUpdates': false, 'window.commandCenter': false,
        // 120%: readable on dense laptop screens; users change it with Text size or Ctrl+=/-.
        'window.zoomLevel': 1,
    };
    const settingsFile = path.join(settingsDirectory, 'settings.json');
    let settings;
    try { settings = JSON.parse(await readFile(settingsFile, 'utf8')); }
    catch (error) { settings = error.code === 'ENOENT' ? {} : undefined; } // Leave hand-edited JSONC untouched.
    if (settings && typeof settings === 'object' && Object.keys(defaults).some(key => !(key in settings))) {
        await writeFile(settingsFile, JSON.stringify({ ...defaults, ...settings }, null, 2));
    }
    return {
        executablePath: path.join(upstream, '.build/electron', product.applicationName),
        cwd: upstream,
        env,
        args: [`${upstream}${path.sep}`, '--user-data-dir', path.join(absoluteProfile, 'user-data'),
            '--shared-data-dir', path.join(absoluteProfile, 'shared-data'),
            '--extensions-dir', path.join(absoluteProfile, 'extensions'),
            '--extensionDevelopmentPath', path.join(root, '.cache/product'),
            '--disable-extension=vscode.vscode-api-tests', '--disable-extension=vscode.vscode-colorize-tests', '--disable-extension=vscode.vscode-colorize-perf-tests', '--skip-welcome', '--skip-release-notes',
            '--disable-telemetry', '--disable-updates'],
    };
}
