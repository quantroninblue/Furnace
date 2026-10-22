import { spawn } from 'node:child_process';
import { environment, upstream } from './environment.mjs';
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Usage: node scripts/run.mjs <command> [args]');
const child = spawn(command, args, { cwd: upstream, env: environment(), stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => {
    console.error(error.message);
    process.exitCode = 1;
});
child.on('exit', code => {
    process.exitCode = code ?? 1;
});
