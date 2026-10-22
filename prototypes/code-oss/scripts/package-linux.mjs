// Linux release build (run by .github/workflows/release.yml on an Ubuntu runner).
//   node scripts/package-linux.mjs prepare             pinned upstream: all patches, Furnace product.json and icons
//   (then, in upstream: npm ci && npm run gulp vscode-linux-x64-min; then npm run build)
//   node scripts/package-linux.mjs assemble [arch]     built-in extension and app entry
//   (then, in upstream: npm run gulp vscode-linux-x64-prepare-deb vscode-linux-x64-prepare-rpm)
//   node scripts/package-linux.mjs packaging [arch]    Furnace's package metadata and install scripts
//   (then, in upstream: npm run gulp vscode-linux-x64-build-deb vscode-linux-x64-build-rpm)
//   node scripts/package-linux.mjs collect [arch]      the .deb and .rpm into .cache/dist
// Upstream's packages are Visual Studio Code's: the .deb asks to add Microsoft's apt repository and
// signing key and registers itself as the system editor. `packaging` replaces those parts with
// Furnace's own, and makes Chromium's sandbox helper setuid in the .deb as the .rpm already does.
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installFurnace, prepare, root, upstream } from './release.mjs';

const dist = path.join(root, '.cache/dist');
const debArch = arch => ({ x64: 'amd64', arm64: 'arm64' })[arch];
const rpmArch = arch => ({ x64: 'x86_64', arm64: 'aarch64' })[arch];
const summary = 'The AI coding workspace where you stay in charge';
const description =
    'Furnace is an AI coding workspace built on Code OSS. Use ChatGPT, Claude Code, API keys or local Ollama models in one conversation, with checkpoints, plans that prove themselves and permissions you control.';
const homepage = 'https://quantroninblue.github.io/Furnace/';
const maintainer = 'Furnace <quantroninblue@users.noreply.github.com>';

async function assemble(arch = 'x64') {
    const output = path.join(path.dirname(upstream), `VSCode-linux-${arch}`);
    const entries = await readdir(output);
    if (!entries.includes('furnace'))
        throw new Error(`Expected the furnace binary in ${output}, found: ${entries.join(', ') || 'nothing'}`);
    await installFurnace(path.join(output, 'resources/app'), 'linux');
    console.log(`Assembled ${output}`);
}

/** Rewrites the prepared .deb and .rpm (after the prepare-* gulp tasks, before build-*). */
async function packaging(arch = 'x64') {
    // .deb: Furnace's control fields; Furnace's maintainer scripts; no debconf question.
    const deb = path.join(upstream, `.build/linux/deb/${debArch(arch)}/furnace-${debArch(arch)}/DEBIAN`);
    const control = (await readFile(path.join(deb, 'control'), 'utf8'))
        .split('\n')
        .filter(line => !/^(Provides|Conflicts|Replaces):/.test(line))
        .map(line =>
            line
                .replace(/^Maintainer:.*/, `Maintainer: ${maintainer}`)
                .replace(/^Homepage:.*/, `Homepage: ${homepage}`),
        )
        .join('\n')
        .replace(/^Description:[\s\S]*$/m, `Description: ${summary}\n ${description}\n`);
    await writeFile(path.join(deb, 'control'), control);
    for (const script of ['postinst', 'prerm', 'postrm'])
        await cp(path.join(root, 'release/linux', script), path.join(deb, script));
    await rm(path.join(deb, 'templates'), { force: true });

    // .rpm: Furnace's vendor, packager, summary and description (its scripts add no repository).
    const spec = path.join(upstream, `.build/linux/rpm/${rpmArch(arch)}/rpmbuild/SPECS/furnace.spec`);
    const text = (await readFile(spec, 'utf8'))
        .replace(/^Summary:.*$/m, `Summary:  ${summary}`)
        .replace(/^Vendor:.*$/m, 'Vendor:   Furnace')
        .replace(/^Packager:.*$/m, `Packager: ${maintainer}`)
        .replace(/^URL:.*$/m, `URL:      ${homepage}`)
        .replace(/%description\n[^\n]*\n/, `%description\n${description}\n`);
    if (text.split('\n').some(line => !line.trimStart().startsWith('#') && line.includes('yum.repos.d')))
        throw new Error('The .rpm spec would add a repository.');
    await writeFile(spec, text);
    console.log(`Packaging metadata: ${deb}, ${spec}`);
}

async function collect(arch = 'x64') {
    await mkdir(dist, { recursive: true });
    const one = async (dir, extension) => {
        const files = (await readdir(dir)).filter(name => name.endsWith(extension));
        if (files.length !== 1)
            throw new Error(`Expected one ${extension} in ${dir}, found: ${files.join(', ') || 'none'}`);
        return path.join(dir, files[0]);
    };
    const deb = await one(path.join(upstream, `.build/linux/deb/${debArch(arch)}/deb`), '.deb');
    const rpm = await one(path.join(upstream, `.build/linux/rpm/${rpmArch(arch)}`), '.rpm');
    await cp(deb, path.join(dist, `Furnace-linux-${arch}.deb`));
    await cp(rpm, path.join(dist, `Furnace-linux-${arch}.rpm`));
    console.log(
        `Packages: ${path.join(dist, `Furnace-linux-${arch}.deb`)}, ${path.join(dist, `Furnace-linux-${arch}.rpm`)}`,
    );
}

const [command, ...args] = process.argv.slice(2);
if (command === 'prepare') await prepare();
else if (command === 'assemble') await assemble(...args);
else if (command === 'packaging') await packaging(...args);
else if (command === 'collect') await collect(...args);
else
    throw new Error(
        'Usage: node scripts/package-linux.mjs prepare | assemble [arch] | packaging [arch] | collect [arch]',
    );
