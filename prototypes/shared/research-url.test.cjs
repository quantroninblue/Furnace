const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browserURL } = require('./research-url.cjs');
test('address input supports websites, loopback, IPv6 and encoded searches', () => {
    assert.equal(browserURL(' example.com/path '), 'https://example.com/path');
    assert.equal(browserURL('localhost:8090'), 'http://localhost:8090/');
    assert.equal(browserURL('127.0.0.1:8090'), 'http://127.0.0.1:8090/');
    assert.equal(browserURL('[::1]:8090'), 'http://[::1]:8090/');
    assert.equal(browserURL('a & b'), 'https://duckduckgo.com/?q=a%20%26%20b');
    assert.equal(browserURL('https://example.com/?q=hello%20world'), 'https://example.com/?q=hello%20world');
    for (const value of [
        '',
        ' ',
        null,
        'file:///etc/passwd',
        'javascript:alert(1)',
        'https://user:pass@example.com',
        'x'.repeat(8193),
        '界'.repeat(2000),
    ])
        assert.throws(() => browserURL(value));
});
