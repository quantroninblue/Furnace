import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProviderKeys } from '../main/provider-keys';

test('keys default to memory and cannot fall back to insecure persistence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-gui-keys-'));
    try {
        const keys = new ProviderKeys(root, {
            available: () => false,
            encrypt: () => {
                throw new Error('Must not encrypt');
            },
            decrypt: () => {
                throw new Error('Must not decrypt');
            },
        });
        await keys.set('openai', 'test-only-key', false);
        assert.equal(keys.get('openai')?.storage, 'session');
        assert.deepEqual(await fs.readdir(root), []);
        await assert.rejects(keys.set('anthropic', 'test-other-key', true), /Secure storage/);
        await keys.remove('openai');
        assert.equal(keys.get('openai'), undefined);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('remembered keys use the injected OS cipher; session replacement and disconnect remove disk copies', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-gui-cipher-'));
    try {
        const cipher = {
            available: () => true,
            encrypt: (_key: string) => Buffer.from('ciphertext-fixture'),
            decrypt: (_data: Buffer) => 'test-only-key',
        };
        const keys = new ProviderKeys(root, cipher);
        await keys.set('openai', 'test-only-key', true);
        assert.equal(await fs.readFile(path.join(root, 'openai.bin'), 'utf8'), 'ciphertext-fixture');
        const restored = new ProviderKeys(root, cipher);
        await restored.load();
        assert.equal(restored.get('openai')?.key, 'test-only-key');
        await restored.set('openai', 'replacement-key', false);
        assert.deepEqual(await fs.readdir(root), []);
        await restored.set('anthropic', 'test-other-key', true);
        await restored.remove('anthropic');
        assert.deepEqual(await fs.readdir(root), []);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
