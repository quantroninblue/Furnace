// Windows release build (run by .github/workflows/release.yml on a Windows runner).
//   node scripts/package-windows.mjs prepare            pinned upstream: all patches, Furnace product.json
//   (then, in upstream: npm ci && npm run gulp vscode-win32-x64-min; then npm run build)
//   node scripts/package-windows.mjs assemble [arch]    built-in extension and app entry
//   (then, in upstream: npm run gulp vscode-win32-x64-inno-updater vscode-win32-x64-user-setup)
//   node scripts/package-windows.mjs collect [arch]     installer and tester note into .cache/dist
// Not code-signed: SmartScreen warns until testers choose More info → Run anyway.
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { installFurnace, prepare, root, upstream } from './release.mjs';

const dist = path.join(root, '.cache/dist');

async function assemble(arch = 'x64') {
    const output = path.join(path.dirname(upstream), `VSCode-win32-${arch}`);
    const executables = (await readdir(output)).filter(name => name.endsWith('.exe'));
    if (!executables.includes('Furnace.exe')) throw new Error(`Expected Furnace.exe in ${output}, found: ${executables.join(', ') || 'none'}`);
    await installFurnace(path.join(output, 'resources/app'), 'win32');
    console.log(`Assembled ${output}`);
}

async function collect(arch = 'x64') {
    // Upstream's Inno Setup user installer: no administrator rights, installs per user.
    const setup = path.join(upstream, `.build/win32-${arch}/user-setup`);
    const installers = (await readdir(setup)).filter(name => name.endsWith('.exe'));
    if (installers.length !== 1) throw new Error(`Expected one installer in ${setup}, found: ${installers.join(', ') || 'none'}`);
    await mkdir(dist, { recursive: true });
    await cp(path.join(setup, installers[0]), path.join(dist, `FurnaceUserSetup-${arch}.exe`));
    await cp(path.join(root, 'release/READ-ME-FIRST-windows.txt'), path.join(dist, 'READ ME FIRST.txt'));
    console.log(`Installer: ${path.join(dist, `FurnaceUserSetup-${arch}.exe`)}`);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'prepare') await prepare();
else if (command === 'assemble') await assemble(...args);
else if (command === 'collect') await collect(...args);
else throw new Error('Usage: node scripts/package-windows.mjs prepare | assemble [arch] | collect [arch]');
