import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { environment, root, upstream } from './environment.mjs';

// Explicit stages keep the upstream recursive postinstall and parallel builds out
// of this laptop-sized comparison. Run only the stages that need refreshing.
const stages = process.argv.slice(2);
const allowed = ['build-tools', 'headers', 'electron', 'native', 'transpile', 'extensions', 'extensions-startup', 'extensions-json', 'extensions-markdown', 'extensions-debug', 'builtin-extensions'];
if (!stages.length || stages.some(stage => !allowed.includes(stage))) {
    throw new Error(`Usage: node scripts/setup.mjs <${allowed.join('|')}> [...]`);
}
const env = environment();
const npmrc = await readFile(path.join(upstream, '.npmrc'), 'utf8');
const target = /^target="([^"]+)"/m.exec(npmrc)?.[1];
if (!target) throw new Error('Missing pinned Electron target');
const headerCache = path.join(root, '.cache/node-gyp');
const gyp = path.join(upstream, 'build/npm/gyp/node_modules/node-gyp/bin/node-gyp.js');
env.npm_config_node_gyp = gyp;
env.npm_config_devdir = headerCache;
env.npm_config_target = target;
env.npm_config_runtime = 'electron';
env.npm_config_disturl = 'https://electronjs.org/headers';
env.npm_config_build_from_source = 'true';

async function run(command, args, cwd = upstream) {
    console.log(`Running in ${path.relative(upstream, cwd) || '.'}: ${command} ${args.join(' ')}`);
    await new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
        const stop = signal => child.kill(signal);
        const interrupt = () => stop('SIGINT');
        const terminate = () => stop('SIGTERM');
        process.on('SIGINT', interrupt);
        process.on('SIGTERM', terminate);
        child.once('error', reject);
        child.once('close', code => {
            process.off('SIGINT', interrupt);
            process.off('SIGTERM', terminate);
            code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`));
        });
    });
}

// Product patches (patches/*.patch except release-*.patch, which only release builds apply).
// Applied once; an already-applied patch is detected and skipped.
async function applyProductPatches() {
    const quiet = args => new Promise(resolve => spawn('git', args, { cwd: upstream, stdio: 'ignore' }).once('close', code => resolve(code === 0)));
    for (const name of (await readdir(path.join(root, 'patches'))).filter(name => name.endsWith('.patch') && !name.startsWith('release-')).sort()) {
        const file = path.join(root, 'patches', name);
        if (await quiet(['apply', '--reverse', '--check', file])) continue;
        await run('git', ['apply', file]);
    }
}

for (const stage of stages) {
    console.log(`Setup stage: ${stage}`);
    if (stage === 'builtin-extensions') {
        // Upstream's own downloader: the JavaScript debugger and companions pinned in
        // product.json, fetched from their GitHub releases and checked against SHA-256.
        await run('node', ['build/lib/builtInExtensions.ts']);
    } else if (stage === 'build-tools') {
        await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], path.join(upstream, 'build'));
    } else if (stage === 'headers') {
        await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], path.join(upstream, 'build/npm/gyp'));
        await mkdir(headerCache, { recursive: true });
        await run('node', [gyp, 'install', '--ensure', '--devdir', headerCache, '--dist-url', env.npm_config_disturl, target]);
        await cp(path.join(upstream, 'build/npm/gyp/custom-headers'), path.join(headerCache, target, 'include/node'), { recursive: true });
        await run('node', ['build/npm/electronTypes.ts']);
    } else if (stage === 'electron') {
        await run('node', ['build/lib/electron.ts']);
    } else if (stage === 'native') {
        for (const name of ['@parcel/watcher', '@vscode/deviceid', '@vscode/fs-copyfile', '@vscode/native-watchdog', '@vscode/policy-watcher', '@vscode/spdlog', '@vscode/sqlite3', 'native-is-elevated', 'native-keymap', 'node-pty', 'kerberos']) {
            await run('npm', ['rebuild', name, '--foreground-scripts']);
        }
    } else if (stage === 'transpile') {
        await applyProductPatches();
        await run('node', ['build/next/index.ts', 'transpile', '--exclude-tests']);
        const fontDir = path.join(upstream, 'out/vs/base/browser/ui/codicons/codicon');
        await mkdir(fontDir, { recursive: true });
        await cp(path.join(upstream, 'node_modules/@vscode/codicons/dist/codicon.ttf'), path.join(fontDir, 'codicon.ttf'));
    } else if (stage === 'extensions-json') {
        // Workspace configuration changes activate JSON support on demand.
        for (const directory of ['json-language-features', 'json-language-features/server']) {
            await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], path.join(upstream, 'extensions', directory));
        }
        for (const part of ['client', 'server']) {
            await run('node', ['node_modules/@typescript/native/lib/tsc.js', '--project', `extensions/json-language-features/${part}/tsconfig.json`]);
        }
    } else if (stage === 'extensions' || stage === 'extensions-startup' || stage === 'extensions-markdown' || stage === 'extensions-debug') {
        if (stage === 'extensions') await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], path.join(upstream, 'extensions'));
        const names = stage === 'extensions'
            ? ['configuration-editing', 'merge-conflict', 'git-base', 'git', 'typescript-language-features']
            : stage === 'extensions-startup' ? ['debug-auto-launch', 'github', 'emmet', 'github-authentication']
            : stage === 'extensions-debug' ? ['debug-server-ready', 'npm'] : ['extension-editing', 'markdown-language-features'];
        for (const name of names) {
            const directory = path.join(upstream, 'extensions', name);
            await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], directory);
            if (name === 'git') await run('npm', ['rebuild', '@vscode/fs-copyfile', '--foreground-scripts'], directory);
            await run('node', ['node_modules/@typescript/native/lib/tsc.js', '--project', `extensions/${name}/tsconfig.json`]);
            // tsc emits code; copy the non-TypeScript runtime assets too.
            async function copyAssets(source, destination) {
                for (const entry of await readdir(source, { withFileTypes: true })) {
                    if (entry.isDirectory()) await copyAssets(path.join(source, entry.name), path.join(destination, entry.name));
                    else if (!entry.name.endsWith('.ts')) {
                        await mkdir(destination, { recursive: true });
                        await cp(path.join(source, entry.name), path.join(destination, entry.name));
                    }
                }
            }
            await copyAssets(path.join(directory, 'src'), path.join(directory, 'out'));
            if (name === 'markdown-language-features') for (const script of ['esbuild.webview.mts', 'esbuild.notebook.mts', 'esbuild.markdownEditor.mts']) await run('node', [script], directory);
        }
    }
}
