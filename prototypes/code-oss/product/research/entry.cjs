const { app } = require('electron');
const { Socket } = require('node:net');
const { startHost } = require('./host.cjs');
// Electron's default loader imports the entry; require.main is not this module.
const offset = process.argv.indexOf('--research-host');
const [host, scope, page, profile] = process.argv.slice(offset + 1);
if (offset < 0 || !profile) process.exit(1);
const pipe = new Socket({ fd: 3, readable: true, writable: true });
void startHost({ pipe, host, scope, page, profile }).catch(() => app.exit(1));
