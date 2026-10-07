'use strict';
const vscode = require('vscode');
const crypto = require('node:crypto');

// Each webview surface is a React app (product/webview/, bundled by build-product.mjs).
exports.content = (webview, extensionUri, surface) => {
    const media = file => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', file));
    const nonce = crypto.randomBytes(16).toString('hex');
    const script = surface === 'conversation' ? 'conversation.js' : 'home.js';
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${media('workspace.css')}"></head><body data-surface="${surface}"><div id="root"></div><script nonce="${nonce}" src="${media(script)}"></script></body></html>`;
};
