import { spawn } from 'node:child_process';
import { launchOptions } from './launch.mjs';
// The Furnace wordmark (also in product/webview/logo.tsx; keep in sync), in ember orange on a terminal.
const wordmark = `
███████╗██╗   ██╗██████╗ ███╗   ██╗ █████╗  ██████╗███████╗
██╔════╝██║   ██║██╔══██╗████╗  ██║██╔══██╗██╔════╝██╔════╝
█████╗  ██║   ██║██████╔╝██╔██╗ ██║███████║██║     █████╗
██╔══╝  ██║   ██║██╔══██╗██║╚██╗██║██╔══██║██║     ██╔══╝
██║     ╚██████╔╝██║  ██║██║ ╚████║██║  ██║╚██████╗███████╗
╚═╝      ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝ ╚═════╝╚══════╝
`;
if (process.stdout.isTTY) console.log(process.env.NO_COLOR ? wordmark : `\x1b[38;2;255;122;26m${wordmark}\x1b[0m`);
const options = await launchOptions();
const child = spawn(options.executablePath, [...options.args, ...process.argv.slice(2)], {
    cwd: options.cwd, env: options.env, stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
