'use strict';
const { httpURL, limits } = require('./research-contract.cjs');
function browserURL(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > limits.url)
        throw new Error('Enter a website or search query.');
    const input = value.trim();
    const host = /^(?:localhost|(?:[a-z0-9-]+\.)+[a-z0-9-]+|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#]|$)/i.test(input);
    const scheme = /^[a-z][a-z0-9+.-]*:/i.test(input);
    let url = input;
    if (!scheme && (!host || /\s/.test(input))) url = `https://duckduckgo.com/?q=${encodeURIComponent(input)}`;
    else if (host) url = `http${/^(?:localhost|127\.[0-9.]+|\[::1\])(?::|[/?#]|$)/i.test(input) ? '' : 's'}://${input}`;
    try {
        return httpURL(url);
    } catch {
        throw new Error('Use an HTTP or HTTPS address without embedded credentials, or a shorter search query.');
    }
}
module.exports = { browserURL };
