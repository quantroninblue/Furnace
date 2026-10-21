// Furnace entry for packaged builds. scripts/release.mjs installs it as the app's main script
// (…/resources/app/out/furnace-main.js), next to furnace-settings.json.
//
// A packaged Electron app always runs its own app code, whatever script path it is given, so
// the Furnace extension's assistant and research hosts, started as
// `<app binary> <entry> --assistant-service|--research-host …`, arrive here. Run those entries,
// only from this app's own extensions folder; otherwise seed first-run settings and start the
// editor.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const host = process.argv.findIndex(arg => arg === '--assistant-service' || arg === '--research-host');

if (host >= 0) {
    const extensions = fs.realpathSync(path.join(here, '../extensions')) + path.sep;
    let entry = '';
    try { entry = host === 2 ? fs.realpathSync(process.argv[1]) : ''; } catch { /* Missing file. */ }
    if (!entry.startsWith(extensions) || !entry.endsWith('.cjs')) {
        console.error('Furnace: refusing to run a host entry outside the built-in extensions.');
        process.exit(1);
    }
    require(entry);
} else {
    // First launch only, and only for the default profile location (as getUserDataPath).
    try {
        const product = require('../product.json');
        const custom = process.env.VSCODE_PORTABLE || process.env.VSCODE_APPDATA || process.argv.some(arg => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='));
        const appData = process.platform === 'darwin' ? process.env.HOME && path.join(process.env.HOME, 'Library/Application Support')
            : process.platform === 'win32' ? process.env.APPDATA
            : process.env.XDG_CONFIG_HOME || (process.env.HOME && path.join(process.env.HOME, '.config'));
        if (!custom && appData) {
            const settings = path.join(appData, product.nameShort, 'User/settings.json');
            if (!fs.existsSync(settings)) {
                fs.mkdirSync(path.dirname(settings), { recursive: true });
                fs.writeFileSync(settings, fs.readFileSync(path.join(here, 'furnace-settings.json')), { flag: 'wx' });
            }
        }
    } catch (error) { console.error(`Furnace: first-run settings skipped: ${error.message}`); }
    await import('./main.js');
}
