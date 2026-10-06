import { spawn } from 'node:child_process';
import { launchOptions } from './launch.mjs';
const options = await launchOptions();
const child = spawn(options.executablePath, [...options.args, ...process.argv.slice(2)], {
    cwd: options.cwd, env: options.env, stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
