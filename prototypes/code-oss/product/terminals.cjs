'use strict';
const vscode = require('vscode');

// Shows agent commands in IDE terminals (read-only mirrors of the real process, which the
// agent runner owns and sandboxes). Foreground commands share one "AI Agent" terminal;
// each background process gets its own. Ctrl+C in a terminal interrupts its command, and
// closing a background process's terminal stops it.
class Mirror {
    constructor(name, onClose) {
        this.write$ = new vscode.EventEmitter();
        this.close$ = new vscode.EventEmitter();
        this.opened = false;
        this.buffer = '';
        this.interrupt = () => {};
        this.closed = false;
        const pty = {
            onDidWrite: this.write$.event,
            onDidClose: this.close$.event,
            open: () => {
                this.opened = true;
                if (this.buffer) this.write$.fire(this.buffer);
                this.buffer = '';
            },
            close: () => {
                this.closed = true;
                onClose?.();
            },
            handleInput: data => {
                if (data === '\x03') this.interrupt();
            },
        };
        this.terminal = vscode.window.createTerminal({
            name,
            pty,
            iconPath: new vscode.ThemeIcon('sparkle'),
            isTransient: true,
        });
    }
    out(text) {
        const value = text.replace(/\r?\n/g, '\r\n');
        if (this.opened) this.write$.fire(value);
        else this.buffer = (this.buffer + value).slice(-200000);
    }
    dispose() {
        this.terminal.dispose();
    }
}

class CommandTerminals {
    constructor(enabled) {
        this.enabled = enabled;
        this.shared = undefined;
        this.mirrors = new Set();
    }
    open(command, cwd, background) {
        if (!this.enabled()) return null;
        let mirror;
        if (background) {
            let handle;
            mirror = new Mirror(`AI: ${command.split('\n')[0].slice(0, 40)}`, () => handle?.stopOnClose?.());
            this.mirrors.add(mirror);
            handle = this.handle(mirror, command, cwd, true);
            handle.stopOnClose = () => mirror.interrupt();
            mirror.terminal.show(true);
            return handle;
        }
        if (!this.shared || this.shared.closed) {
            this.shared = new Mirror('AI Agent', () => {
                this.shared = undefined;
            });
            this.mirrors.add(this.shared);
        }
        mirror = this.shared;
        mirror.terminal.show(true);
        return this.handle(mirror, command, cwd, false);
    }
    handle(mirror, command, cwd, background) {
        mirror.out(`\x1b[2m${cwd}${background ? ' · background' : ''}\x1b[0m\n\x1b[1m$ ${command}\x1b[0m\n`);
        let done = false;
        return {
            write: text => {
                if (!done) mirror.out(text);
            },
            exit: code => {
                if (done) return;
                done = true;
                mirror.interrupt = () => {};
                mirror.out(`\n\x1b[2m[${code === null ? 'stopped' : `exit code ${code}`}]\x1b[0m\n\n`);
            },
            onInterrupt: listener => {
                mirror.interrupt = () => {
                    if (!done) {
                        mirror.out('^C\n');
                        listener();
                    }
                };
            },
            show: () => mirror.terminal.show(false),
        };
    }
    dispose() {
        for (const mirror of this.mirrors) mirror.dispose();
        this.mirrors.clear();
    }
}
module.exports = { CommandTerminals };
