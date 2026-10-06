import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('..', import.meta.url));
export const upstream = path.join(root, 'upstream');
export const nodeBin = path.join(root, '.cache/node-v24.18.0-linux-x64/bin');
export function environment() {
    const lib = path.join(root, '.cache/sysroot/usr/lib/x86_64-linux-gnu');
    const env = { ...process.env, PATH: `${nodeBin}:${process.env.PATH}`,
        NODE_OPTIONS: '--max-old-space-size=2048', GOMAXPROCS: '2',
        npm_config_jobs: '2', MAKEFLAGS: '-j2', npm_config_audit: 'false', npm_config_fund: 'false',
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
        PKG_CONFIG_PATH: [path.join(lib, 'pkgconfig'), process.env.PKG_CONFIG_PATH].filter(Boolean).join(':'),
        LD_LIBRARY_PATH: [lib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
}
