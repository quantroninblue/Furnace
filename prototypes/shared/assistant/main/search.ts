import path from 'node:path';
import { promises as fs, constants } from 'node:fs';
import { spawn } from 'node:child_process';

/** A path as shown to the model and the user, and as saved rules match it: always with "/" (Windows uses "\\"). */
export const slash = (file: string) => file.split(path.sep).join('/');

// glob/grep for agent tools. ripgrep is used when installed; otherwise a bounded
// JavaScript walker. Both skip VCS metadata and dependency folders by default.
const SKIP = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.venv', 'dist', 'out', '.cache']);
const MAX_VISITS = 200000;

export function globToRegExp(pattern: string) {
    let source = '',
        index = 0;
    const glob = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
    while (index < glob.length) {
        const char = glob[index];
        if (char === '*') {
            if (glob[index + 1] === '*') {
                index += 2;
                if (glob[index] === '/') {
                    index++;
                    source += '(?:.*/)?';
                } else source += '.*';
                continue;
            }
            source += '[^/]*';
        } else if (char === '?') source += '[^/]';
        else if (char === '{') {
            const end = glob.indexOf('}', index);
            if (end > index) {
                source += `(?:${glob
                    .slice(index + 1, end)
                    .split(',')
                    .map(part => part.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
                    .join('|')})`;
                index = end;
            } else source += '\\{';
        } else if (char === '[') {
            const end = glob.indexOf(']', index);
            if (end > index) {
                source += glob.slice(index, end + 1).replace(/^\[!/, '[^');
                index = end;
            } else source += '\\[';
        } else source += /[.+^$()|\\]/.test(char) ? `\\${char}` : char;
        index++;
    }
    // Patterns without a slash match at any depth, like ripgrep/gitignore globs.
    return new RegExp(`^${glob.includes('/') ? '' : '(?:.*/)?'}${source}$`);
}

async function* walk(base: string, signal: AbortSignal, includeSkipped: boolean) {
    const queue = [''];
    let visits = 0;
    while (queue.length) {
        signal.throwIfAborted();
        const relative = queue.shift()!;
        let entries;
        try {
            entries = await fs.readdir(path.join(base, relative), { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (++visits > MAX_VISITS) return;
            const child = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (includeSkipped || !SKIP.has(entry.name)) queue.push(child);
            } else if (entry.isFile()) yield child;
        }
    }
}

export async function findFiles(base: string, pattern: string, signal: AbortSignal) {
    if ((await fs.stat(base)).isFile())
        return globToRegExp(pattern).test(path.basename(base)) ? [path.basename(base)] : [];
    const regex = globToRegExp(pattern),
        includeSkipped = [...SKIP].some(name => pattern.includes(name));
    const found: string[] = [];
    for await (const file of walk(base, signal, includeSkipped))
        if (regex.test(file) && found.push(file) >= 2000) break;
    return found.sort();
}

let ripgrep: Promise<string | null> | undefined;
const findRipgrep = () =>
    (ripgrep ??= (async () => {
        for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
            const file = path.join(directory, process.platform === 'win32' ? 'rg.exe' : 'rg');
            try {
                await fs.access(file, constants.X_OK);
                return file;
            } catch {
                /* Next. */
            }
        }
        return null;
    })());

export async function searchFiles(
    target: string,
    pattern: string,
    options: { glob?: string; ignoreCase: boolean; base: string },
    signal: AbortSignal,
) {
    const limit = 300,
        lines: string[] = [];
    const show = (file: string) =>
        file.startsWith(options.base + path.sep) ? slash(path.relative(options.base, file)) : file;
    const rg = await findRipgrep();
    if (rg) {
        const args = [
            '--line-number',
            '--no-heading',
            '--color=never',
            '--max-columns=400',
            '--max-columns-preview',
            '--max-count=100',
            '--glob=!.git',
            ...(options.ignoreCase ? ['-i'] : []),
            ...(options.glob ? [`--glob=${options.glob}`] : []),
            '-e',
            pattern,
            '--',
            target,
        ];
        const output = await new Promise<string>((resolve, reject) => {
            const child = spawn(rg, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
            let out = '',
                err = '';
            child.stdout.setEncoding('utf8').on('data', chunk => {
                if (out.length < 2_000_000) out += chunk;
                else child.kill();
            });
            child.stderr.setEncoding('utf8').on('data', chunk => {
                err += chunk;
            });
            child.once('error', reject);
            child.once('close', code =>
                code === 2 && !out ? reject(new Error(err.trim().split('\n')[0] || 'Search failed.')) : resolve(out),
            );
        });
        for (const line of output.split('\n'))
            if (line) {
                lines.push(
                    line.startsWith(target)
                        ? show(line.slice(0, line.indexOf(':', target.length))) +
                              line.slice(line.indexOf(':', target.length))
                        : line,
                );
            }
    } else {
        let regex: RegExp;
        try {
            regex = new RegExp(pattern, options.ignoreCase ? 'i' : '');
        } catch (error) {
            throw new Error(`Invalid regular expression: ${(error as Error).message}`);
        }
        const filter = options.glob ? globToRegExp(options.glob) : null;
        const isFile = (await fs.stat(target)).isFile();
        const files = isFile ? [''] : walk(target, signal, false);
        for await (const relative of files) {
            if (filter && !filter.test(relative || path.basename(target))) continue;
            const file = relative ? path.join(target, relative) : target;
            let data: Buffer;
            try {
                const info = await fs.stat(file);
                if (info.size > 2 * 1024 * 1024) continue;
                data = await fs.readFile(file);
            } catch {
                continue;
            }
            if (data.includes(0)) continue;
            data.toString('utf8')
                .split('\n')
                .forEach((text, index) => {
                    if (lines.length < 5000 && regex.test(text))
                        lines.push(`${show(file)}:${index + 1}:${text.slice(0, 400)}`);
                });
        }
    }
    const count = lines.length;
    return {
        count,
        text:
            lines.slice(0, limit).join('\n') +
            (count > limit ? `\n… ${count - limit} more matches; narrow the search.` : ''),
    };
}
