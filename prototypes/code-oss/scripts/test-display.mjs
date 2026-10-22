// Run desktop automation away from the user's keyboard and pointer.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { root } from './environment.mjs';

const localXvfb = path.join(root, '.cache/sysroot/usr/bin/Xvfb');
const command = process.argv[2];
if (!command) throw new Error('Usage: node scripts/test-display.mjs <script>');
let display;
let child;
const stop = signal => {
    child?.kill(signal);
    display?.kill(signal);
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
try {
    const env = { ...process.env };
    if (process.platform === 'linux' && env.AI_GUI_TEST_LIVE_DISPLAY !== '1') {
        display = spawn(
            env.AI_GUI_XVFB ?? (existsSync(localXvfb) ? localXvfb : 'Xvfb'),
            ['-displayfd', '3', '-screen', '0', '1440x900x24', '-nolisten', 'tcp'],
            { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] },
        );
        let diagnostics = '';
        display.stderr.on('data', data => {
            diagnostics += data;
        });
        const number = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Virtual display startup timed out')), 10000);
            let buffer = '';
            const finish = (error, value) => {
                clearTimeout(timer);
                error ? reject(error) : resolve(value);
            };
            display.once('error', error =>
                finish(new Error(`Xvfb is required for isolated smoke tests: ${error.message}. See README.`)),
            );
            display.once('exit', code => finish(new Error(`Xvfb exited (${code}): ${diagnostics}`)));
            display.stdio[3].on('data', data => {
                buffer += data;
                if (/^\d+\n/.test(buffer)) finish(undefined, buffer.trim());
            });
        });
        env.DISPLAY = `:${number}`;
        delete env.WAYLAND_DISPLAY;
        env.XDG_SESSION_TYPE = 'x11';
        env.AI_GUI_TEST_DISPLAY = env.DISPLAY;
        console.log(`Isolated test display: ${env.DISPLAY}`);
    }
    child = spawn(process.execPath, [path.resolve(command), ...process.argv.slice(3)], { env, stdio: 'inherit' });
    const [code, signal] = await once(child, 'exit');
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
} finally {
    if (display?.pid && display.exitCode === null && display.signalCode === null) {
        const closed = once(display, 'exit');
        display.kill();
        await closed;
    }
}
