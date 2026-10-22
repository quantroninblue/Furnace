import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Estimated API spend by Furnace on this device, per day and provider (US dollars), so the user
// sees today's and this month's total across conversations and can set a monthly budget.
type Days = Record<string, Record<string, number>>;
const day = (time = Date.now()) => new Date(time).toISOString().slice(0, 10);
export class SpendLedger {
    private days: Days = {};
    private loaded?: Promise<void>;
    private queue = Promise.resolve();
    constructor(private file: string) {}
    load() {
        return (this.loaded ??= fs.readFile(this.file, 'utf8').then(
            text => {
                const value = JSON.parse(text);
                if (value && typeof value === 'object') this.days = value;
            },
            () => {},
        ));
    }
    async add(provider: string, dollars: number, time = Date.now()) {
        if (!(dollars > 0) || !Number.isFinite(dollars)) return;
        await this.load();
        const key = day(time);
        this.days[key] = { ...this.days[key], [provider]: (this.days[key]?.[provider] ?? 0) + dollars };
        // Keep about 13 months.
        for (const old of Object.keys(this.days).sort().slice(0, -400)) delete this.days[old];
        const content = JSON.stringify(this.days);
        this.queue = this.queue
            .then(async () => {
                await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
                const temp = `${this.file}.${randomUUID()}.tmp`;
                try {
                    await fs.writeFile(temp, content, { mode: 0o600 });
                    await fs.rename(temp, this.file);
                } finally {
                    await fs.rm(temp, { force: true });
                }
            })
            .catch(() => {});
        await this.queue;
    }
    /** Resolves when pending writes are done. */
    async idle(): Promise<void> {
        await this.queue;
    }
    /** Today's and this month's totals (UTC days), by provider. */
    summary(time = Date.now()) {
        const today = day(time),
            month = today.slice(0, 7);
        const sum = (keys: string[]) => {
            const byProvider: Record<string, number> = {};
            for (const key of keys)
                for (const [provider, value] of Object.entries(this.days[key] ?? {}))
                    byProvider[provider] = (byProvider[provider] ?? 0) + value;
            return { total: Object.values(byProvider).reduce((a, b) => a + b, 0), byProvider };
        };
        return { today: sum([today]), month: sum(Object.keys(this.days).filter(key => key.startsWith(month))) };
    }
}
