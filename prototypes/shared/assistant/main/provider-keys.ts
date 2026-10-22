import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RemoteProvider } from '../shared/types';

/** API keys, plus optional admin keys that only read organization spend. */
export type KeyName = RemoteProvider | `${RemoteProvider}-admin`;

export interface KeyCipher {
    available(): boolean;
    encrypt(value: string): Buffer;
    decrypt(value: Buffer): string;
}
export class ProviderKeys {
    private memory = new Map<KeyName, { key: string; storage: 'encrypted' | 'session' }>();
    constructor(
        private directory: string,
        private cipher: KeyCipher,
    ) {}
    secureStorage() {
        return this.cipher.available();
    }
    private file(provider: KeyName) {
        return path.join(this.directory, `${provider}.bin`);
    }
    async load() {
        for (const provider of ['openai', 'anthropic', 'openai-admin', 'anthropic-admin'] as const) {
            if (!this.cipher.available()) continue;
            try {
                const file = this.file(provider);
                if ((await fs.stat(file)).size > 16384) continue;
                this.memory.set(provider, { key: this.cipher.decrypt(await fs.readFile(file)), storage: 'encrypted' });
            } catch {
                /* Locked keychain or missing key: reconnect from the UI. */
            }
        }
    }
    get(provider: KeyName) {
        return this.memory.get(provider);
    }
    async set(provider: KeyName, key: string, remember: boolean) {
        if (typeof key !== 'string' || key.trim().length < 8 || key.length > 4096 || /[\r\n\0]/.test(key))
            throw new Error('Enter a valid API key.');
        const storage = remember ? 'encrypted' : 'session';
        if (remember && !this.cipher.available())
            throw new Error('Secure storage is unavailable. Use a key for this app session instead.');
        if (remember) {
            const encrypted = this.cipher.encrypt(key.trim());
            await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
            const file = this.file(provider),
                temp = `${file}.${randomUUID()}.tmp`;
            try {
                await fs.writeFile(temp, encrypted, { mode: 0o600 });
                await fs.rename(temp, file);
            } finally {
                await fs.rm(temp, { force: true });
            }
        } else await fs.rm(this.file(provider), { force: true });
        this.memory.set(provider, { key: key.trim(), storage });
    }
    async remove(provider: KeyName) {
        await fs.rm(this.file(provider), { force: true });
        this.memory.delete(provider);
    }
}
