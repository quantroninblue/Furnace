'use strict';
// Slight window translucency (aiGui.window.opacity). Code OSS has no opacity setting, so on
// Linux/X11 this sets _NET_WM_WINDOW_OPACITY on this app's windows and the compositor applies
// it to the whole window. Elsewhere (Wayland, macOS, no xprop) nothing happens.
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const xprop = args => new Promise(resolve => execFile('xprop', args, { timeout: 3000 }, (error, stdout) => resolve(error ? '' : stdout)));

/**
 * The app's own processes: this one and the parents running the same executable (the
 * extension host and the main process, which owns the windows). Stops at the first other
 * program, such as the terminal that ran `npm start`, so its windows are never touched.
 */
function appProcesses(pid = process.pid, executable = process.execPath) {
    const found = new Set(), target = fs.realpathSync(executable);
    while (pid > 1 && !found.has(pid)) {
        try { if (fs.realpathSync(`/proc/${pid}/exe`) !== target) break; } catch { break; }
        found.add(pid);
        try { pid = Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ')[1]); } catch { break; }
    }
    return found;
}

/** Applies `opacity` (0.5–1) to the app's X11 windows; returns how many windows were set. */
async function applyOpacity(opacity) {
    if (process.platform !== 'linux' || !process.env.DISPLAY) return 0;
    const value = Math.min(1, Math.max(0.5, Number(opacity) || 1)), owners = appProcesses();
    let count = 0;
    for (const id of (await xprop(['-root', '_NET_CLIENT_LIST'])).match(/0x[0-9a-f]+/gi) || []) {
        const pid = Number((await xprop(['-id', id, '_NET_WM_PID'])).match(/= (\d+)/)?.[1]);
        if (!owners.has(pid)) continue;
        await xprop(value >= 1 ? ['-id', id, '-remove', '_NET_WM_WINDOW_OPACITY']
            : ['-id', id, '-f', '_NET_WM_WINDOW_OPACITY', '32c', '-set', '_NET_WM_WINDOW_OPACITY', String(Math.round(value * 0xffffffff))]);
        count++;
    }
    return count;
}

function createWindowOpacity(context) {
    const vscode = require('vscode');
    // The Display menu's slider changes the setting while dragging: run one update at a time
    // and finish with the latest value.
    let running = null, again = false;
    const apply = () => {
        if (running) { again = true; return running; }
        running = applyOpacity(vscode.workspace.getConfiguration('aiGui').get('window.opacity', 0.96))
            .finally(() => { running = null; if (again) { again = false; void apply(); } });
        return running;
    };
    // The window can still be mapping when the extension starts; try again shortly after.
    void apply().then(count => { if (!count) setTimeout(apply, 3000); });
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('aiGui.window.opacity')) void apply(); }));
}

module.exports = { createWindowOpacity, applyOpacity, appProcesses };
