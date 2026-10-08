// macOS test build (mac branch; run by .github/workflows/macos-build.yml on a macOS runner).
//   node scripts/package-macos.mjs prepare            pinned upstream: all patches, Furnace product.json
//   (then, in upstream: npm ci && npm run gulp vscode-darwin-arm64-min; then npm run build)
//   node scripts/package-macos.mjs assemble [arch]    built-in extension, app entry, ad-hoc signing, .dmg
// Steps that need macOS tools (codesign, hdiutil) are skipped elsewhere, so the file layout can be
// checked on Linux.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { root, upstream as devUpstream } from './environment.mjs';

// A separate, clean upstream checkout: prepare rewrites product.json and applies release patches,
// which would break the development checkout. FURNACE_UPSTREAM points elsewhere (for local trials).
const upstream = process.env.FURNACE_UPSTREAM ? path.resolve(process.env.FURNACE_UPSTREAM) : devUpstream;
const require = createRequire(import.meta.url);
const { settingsDefaults } = require('../product/settings-defaults.cjs');
const git = (...args) => execFileSync('git', args, { cwd: upstream, encoding: 'utf8' }).trim();

// Release identity: a separate app and data folder that never touches a VS Code install.
const releaseProduct = {
    nameShort: 'Furnace', nameLong: 'Furnace', applicationName: 'furnace',
    dataFolderName: '.furnace', sharedDataFolderName: '.furnace-shared', serverDataFolderName: '.furnace-server',
    serverApplicationName: 'furnace-server', tunnelApplicationName: 'furnace-tunnel', urlProtocol: 'furnace',
    darwinBundleIdentifier: 'io.github.quantroninblue.furnace',
    darwinProfileUUID: 'BD243F3C-D13A-440C-9349-4FF90F59A869', darwinProfilePayloadUUID: 'B68D4BC2-AEA8-47C9-A864-6F1F8F18E9EE',
};

async function prepare() {
    const pin = JSON.parse(await readFile(path.join(root, 'upstream-pin.json'), 'utf8'));
    if (git('rev-parse', 'HEAD') !== pin.commit) throw new Error(`upstream is not at the pinned ${pin.tag} (${pin.commit})`);
    if (git('status', '--porcelain')) throw new Error(`${upstream} has changes; prepare needs a fresh checkout of the pinned source.`);
    // Product patches, then release-only ones.
    const patches = (await readdir(path.join(root, 'patches'))).filter(name => name.endsWith('.patch'))
        .sort((a, b) => Number(a.startsWith('release-')) - Number(b.startsWith('release-')) || a.localeCompare(b));
    for (const name of patches) {
        const file = path.join(root, 'patches', name);
        git('apply', file);
        console.log(`Applied: ${name}`);
    }
    const productFile = path.join(upstream, 'product.json');
    const overrides = JSON.parse(await readFile(path.join(root, 'product.overrides.json'), 'utf8'));
    const product = { ...JSON.parse(await readFile(productFile, 'utf8')), ...overrides, ...releaseProduct };
    await writeFile(productFile, JSON.stringify(product, null, '\t') + '\n');
    console.log(`product.json: ${product.nameLong} (${product.darwinBundleIdentifier}), gallery ${product.extensionsGallery?.serviceUrl}`);
}

async function assemble(arch = process.arch) {
    const output = path.join(path.dirname(upstream), `VSCode-darwin-${arch}`);
    const apps = (await readdir(output)).filter(name => name.endsWith('.app'));
    if (apps.length !== 1) throw new Error(`Expected one .app in ${output}, found: ${apps.join(', ') || 'none'}`);
    const bundle = path.join(output, apps[0]), app = path.join(bundle, 'Contents/Resources/app');

    // The Furnace extension, built in (not a development extension); no source maps.
    const extension = path.join(app, 'extensions/furnace-workspace');
    await rm(extension, { recursive: true, force: true });
    await cp(path.join(root, '.cache/product'), extension, { recursive: true, filter: source => !source.endsWith('.map') });

    // The app entry routes the extension's host processes and seeds first-run settings.
    await cp(path.join(root, 'release/furnace-main.mjs'), path.join(app, 'out/furnace-main.js'));
    await writeFile(path.join(app, 'out/furnace-settings.json'), JSON.stringify(settingsDefaults('darwin'), null, 2) + '\n');
    const packageFile = path.join(app, 'package.json');
    const packageJson = JSON.parse(await readFile(packageFile, 'utf8'));
    if (packageJson.type !== 'module') throw new Error('Expected an ES module app package.');
    await writeFile(packageFile, JSON.stringify({ ...packageJson, main: './out/furnace-main.js' }, null, '\t') + '\n');
    console.log(`Assembled ${bundle}`);

    if (process.platform !== 'darwin') { console.log('Not macOS: skipped signing and the .dmg.'); return; }
    // Ad-hoc signature: required to run on Apple Silicon; not notarized (testers use Open Anyway).
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });

    const dist = path.join(root, '.cache/dist'), staging = path.join(dist, 'dmg');
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    execFileSync('ditto', [bundle, path.join(staging, apps[0])]);
    await symlink('/Applications', path.join(staging, 'Applications'));
    await cp(path.join(root, 'release/READ-ME-FIRST.txt'), path.join(staging, 'READ ME FIRST.txt'));
    const dmg = path.join(dist, `Furnace-darwin-${arch}.dmg`);
    execFileSync('hdiutil', ['create', '-volname', 'Furnace', '-srcfolder', staging, '-ov', '-format', 'UDZO', dmg], { stdio: 'inherit' });
    console.log(`Disk image: ${dmg}`);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'prepare') await prepare();
else if (command === 'assemble') await assemble(...args);
else throw new Error('Usage: node scripts/package-macos.mjs prepare | assemble [arch]');
