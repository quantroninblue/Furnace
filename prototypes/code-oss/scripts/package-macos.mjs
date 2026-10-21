// macOS test build (mac branch; run by .github/workflows/macos-build.yml on a macOS runner).
//   node scripts/package-macos.mjs prepare            pinned upstream: all patches, Furnace product.json
//   (then, in upstream: npm ci && npm run gulp vscode-darwin-arm64-min; then npm run build)
//   node scripts/package-macos.mjs assemble [arch]    built-in extension, app entry, ad-hoc signing, .dmg
// Steps that need macOS tools (codesign, hdiutil) are skipped elsewhere, so the file layout can be
// checked on Linux.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { installFurnace, prepare, root, upstream } from './release.mjs';

async function assemble(arch = process.arch) {
    const output = path.join(path.dirname(upstream), `VSCode-darwin-${arch}`);
    const apps = (await readdir(output)).filter(name => name.endsWith('.app'));
    if (apps.length !== 1) throw new Error(`Expected one .app in ${output}, found: ${apps.join(', ') || 'none'}`);
    const bundle = path.join(output, apps[0]);
    await installFurnace(path.join(bundle, 'Contents/Resources/app'), 'darwin');
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
