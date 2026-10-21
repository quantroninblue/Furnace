// Shared steps of the release builds (scripts/package-macos.mjs, scripts/package-windows.mjs).
import { execFileSync } from 'node:child_process';
import { cp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { root, upstream as devUpstream } from './environment.mjs';

// A separate, clean upstream checkout: prepare rewrites product.json and applies release patches,
// which would break the development checkout. FURNACE_UPSTREAM points elsewhere (for local trials).
export const upstream = process.env.FURNACE_UPSTREAM ? path.resolve(process.env.FURNACE_UPSTREAM) : devUpstream;
export { root };
const require = createRequire(import.meta.url);
const { settingsDefaults } = require('../product/settings-defaults.cjs');
const git = (...args) => execFileSync('git', args, { cwd: upstream, encoding: 'utf8' }).trim();

// Release identity: a separate app, data folder and installer identity that never touch a VS Code
// install. The Windows GUIDs identify Furnace's installers; never reuse them for another product.
const releaseProduct = {
    nameShort: 'Furnace', nameLong: 'Furnace', applicationName: 'furnace',
    dataFolderName: '.furnace', sharedDataFolderName: '.furnace-shared', serverDataFolderName: '.furnace-server',
    serverApplicationName: 'furnace-server', tunnelApplicationName: 'furnace-tunnel', urlProtocol: 'furnace',
    darwinBundleIdentifier: 'io.github.quantroninblue.furnace',
    darwinProfileUUID: 'BD243F3C-D13A-440C-9349-4FF90F59A869', darwinProfilePayloadUUID: 'B68D4BC2-AEA8-47C9-A864-6F1F8F18E9EE',
    win32DirName: 'Furnace', win32NameVersion: 'Furnace', win32RegValueName: 'Furnace', win32ShellNameShort: '&Furnace',
    win32AppUserModelId: 'quantroninblue.Furnace', win32MutexName: 'furnace',
    win32TunnelMutex: 'furnace-tunnel', win32TunnelServiceMutex: 'furnace-tunnelservice',
    // Inno Setup ids: "{{" escapes the opening brace.
    win32x64AppId: '{{830E830C-B06D-4B72-A536-7AB2675C5FC9}', win32arm64AppId: '{{E4BA9874-8A7E-4FA2-AFD1-CF6A49EE5993}',
    win32x64UserAppId: '{{1D1316E5-469A-4FEB-9CE4-89CBBBD83BA7}', win32arm64UserAppId: '{{89876165-7F44-4A92-BD7F-56CEBB1BEADD}',
};

// The app icon for each platform: the app and installer (.icns, .ico), Windows Start tiles and Linux.
export const releaseIcons = [
    ['furnace.icns', 'darwin/code.icns'], ['furnace.ico', 'win32/code.ico'],
    ['furnace_70x70.png', 'win32/code_70x70.png'], ['furnace_150x150.png', 'win32/code_150x150.png'],
    ['furnace.png', 'linux/code.png'],
];

/** Pinned upstream: product patches, then release-only ones; Furnace product.json and icons. */
export async function prepare() {
    const pin = JSON.parse(await readFile(path.join(root, 'upstream-pin.json'), 'utf8'));
    if (git('rev-parse', 'HEAD') !== pin.commit) throw new Error(`upstream is not at the pinned ${pin.tag} (${pin.commit})`);
    if (git('status', '--porcelain')) throw new Error(`${upstream} has changes; prepare needs a fresh checkout of the pinned source.`);
    const patches = (await readdir(path.join(root, 'patches'))).filter(name => name.endsWith('.patch'))
        .sort((a, b) => Number(a.startsWith('release-')) - Number(b.startsWith('release-')) || a.localeCompare(b));
    for (const name of patches) {
        git('apply', path.join(root, 'patches', name));
        console.log(`Applied: ${name}`);
    }
    const productFile = path.join(upstream, 'product.json');
    const overrides = JSON.parse(await readFile(path.join(root, 'product.overrides.json'), 'utf8'));
    const product = { ...JSON.parse(await readFile(productFile, 'utf8')), ...overrides, ...releaseProduct };
    await writeFile(productFile, JSON.stringify(product, null, '\t') + '\n');
    console.log(`product.json: ${product.nameLong} (${product.darwinBundleIdentifier}), gallery ${product.extensionsGallery?.serviceUrl}`);
    // Furnace's icons in place of Code OSS's (made by scripts/make-icons.mjs).
    for (const [from, to] of releaseIcons) await cp(path.join(root, 'release/icon', from), path.join(upstream, 'resources', to));
    console.log(`Icons: ${releaseIcons.map(([, to]) => to).join(', ')}`);
}

// Where releases live: the feed every build checks, and its public key (release-feed.mjs signs with
// the matching private key, the FURNACE_UPDATE_KEY secret).
export const updateRepository = process.env.FURNACE_RELEASE_REPOSITORY || 'quantroninblue/Furnace';
export const updateFeed = `https://github.com/${updateRepository}/releases/latest/download/latest.json`;

/**
 * Adds Furnace to a packaged app folder (`…/resources/app`): the extension, built in rather than a
 * development extension and without source maps, and the app entry that routes the extension's
 * host processes and seeds first-run settings, and the update feed with its public key.
 */
export async function installFurnace(app, platform) {
    const extension = path.join(app, 'extensions/furnace-workspace');
    await rm(extension, { recursive: true, force: true });
    await cp(path.join(root, '.cache/product'), extension, { recursive: true, filter: source => !source.endsWith('.map') });
    // Release builds check for updates (development builds have no feed, so never do).
    const manifestFile = path.join(extension, 'package.json'), manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    manifest.updates = { feed: updateFeed, publicKey: await readFile(path.join(root, 'release/update-key.pem'), 'utf8') };
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    await cp(path.join(root, 'release/furnace-main.mjs'), path.join(app, 'out/furnace-main.js'));
    await writeFile(path.join(app, 'out/furnace-settings.json'), JSON.stringify(settingsDefaults(platform), null, 2) + '\n');
    const packageFile = path.join(app, 'package.json');
    const packageJson = JSON.parse(await readFile(packageFile, 'utf8'));
    if (packageJson.type !== 'module') throw new Error('Expected an ES module app package.');
    await writeFile(packageFile, JSON.stringify({ ...packageJson, main: './out/furnace-main.js' }, null, '\t') + '\n');
}
