import { chmod, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { root, upstream } from './environment.mjs';
const require = createRequire(path.join(upstream, 'package.json'));
const { build } = require('esbuild');
const output = path.join(root, '.cache/product');
await mkdir(output, { recursive: true });
await build({
    entryPoints: [path.join(root, 'product/extension.cjs')],
    outfile: path.join(output, 'extension.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
    sourcemap: true,
});
await mkdir(path.join(output, 'assistant'), { recursive: true });
await build({
    entryPoints: [path.join(root, 'product/assistant/entry.cjs')],
    outfile: path.join(output, 'assistant/entry.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    sourcemap: true,
});
await mkdir(path.join(output, 'research'), { recursive: true });
for (const entry of ['host', 'entry', 'controls-preload'])
    await build({
        entryPoints: [path.join(root, `product/research/${entry}.cjs`)],
        outfile: path.join(output, `research/${entry}.cjs`),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
        sourcemap: true,
    });
for (const file of ['controls.html', 'controls.css', 'controls.js'])
    await cp(path.join(root, 'product/research', file), path.join(output, 'research', file));
await rm(path.join(output, 'media'), { recursive: true, force: true });
for (const file of ['package.json', 'media', 'themes'])
    await cp(path.join(root, 'product', file), path.join(output, file), { recursive: true });
// Conversation panel and workspace page (React), one bundle per webview surface.
await build({
    entryPoints: ['conversation', 'home', 'help', 'themes'].map(name => path.join(root, `product/webview/${name}.tsx`)),
    outdir: path.join(output, 'media'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    jsx: 'automatic',
    minify: true,
    sourcemap: true,
    legalComments: 'linked',
    define: { 'process.env.NODE_ENV': '"production"' },
});
// Furnace Help shows the user guide and data usage page that ship with the app.
await mkdir(path.join(output, 'help'), { recursive: true });
for (const [from, to] of [
    ['GUIDE.md', 'guide.md'],
    ['DATA_USAGE.md', 'data.md'],
])
    await cp(path.join(root, '../..', from), path.join(output, 'help', to));
// Agent command sandbox (Landlock on Linux, Seatbelt on macOS): optional; without it Auto
// mode asks before commands.
await rm(path.join(output, 'sandbox'), { recursive: true, force: true });
if (process.platform === 'linux') {
    await mkdir(path.join(output, 'sandbox'), { recursive: true });
    try {
        execFileSync(
            process.env.CC || 'cc',
            [
                '-O2',
                '-Wall',
                '-o',
                path.join(output, 'sandbox/ai-gui-sandbox'),
                path.join(root, 'product/sandbox/ai-gui-sandbox.c'),
            ],
            { stdio: 'pipe' },
        );
    } catch (error) {
        console.warn(
            `Command sandbox not built (${
                String(error.stderr || error.message)
                    .trim()
                    .split('\n')[0]
            }); Auto mode will ask before commands.`,
        );
    }
} else if (process.platform === 'darwin') {
    await mkdir(path.join(output, 'sandbox'), { recursive: true });
    await cp(path.join(root, 'product/sandbox/ai-gui-sandbox-macos.sh'), path.join(output, 'sandbox/ai-gui-sandbox'));
    await chmod(path.join(output, 'sandbox/ai-gui-sandbox'), 0o755);
}
console.log(`Built ${JSON.parse(await readFile(path.join(output, 'package.json'))).displayName}: ${output}`);
