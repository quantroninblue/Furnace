'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * The Electron binary that runs the assistant and research hosts. On macOS the extension host
 * runs in a helper app inside the bundle (Contents/Frameworks/… Helper (Plugin).app), which is
 * not meant to start apps, so use the bundle's main binary; in a packaged build the app's entry
 * (release/furnace-main.mjs) hands the host entry over. Elsewhere it is this process's binary.
 */
function electronBinary(execPath = process.execPath, platform = process.platform) {
    const bundle = platform === 'darwin' && /^(.*?\.app)\/Contents\/Frameworks\//.exec(execPath)?.[1];
    if (!bundle) return execPath;
    try {
        const binaries = fs.readdirSync(path.join(bundle, 'Contents/MacOS'));
        return binaries.length === 1 ? path.join(bundle, 'Contents/MacOS', binaries[0]) : execPath;
    } catch {
        return execPath;
    }
}

module.exports = { electronBinary };
