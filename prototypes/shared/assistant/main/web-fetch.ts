// Bounded HTTP(S) fetch for the web_fetch tool. Approval happens in the tool layer.
const MAX_BYTES = 3 * 1024 * 1024;
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function htmlToText(html: string) {
    return html
        .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, '\n')
        .replace(/<li\b[^>]*>/gi, '\n• ')
        .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => `${label} (${href})`)
        .replace(/<[^>]+>/g, ' ')
        .replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, code: string) =>
            code[0] === '#'
                ? String.fromCodePoint(
                      parseInt(
                          code.slice(code[1] === 'x' || code[1] === 'X' ? 2 : 1),
                          code[1] === 'x' || code[1] === 'X' ? 16 : 10,
                      ) || 32,
                  )
                : (entities[code.toLowerCase()] ?? match),
        )
        .replace(/[ \t\f\v\r]+/g, ' ')
        .replace(/ *\n[ \n]*/g, '\n')
        .trim();
}

export async function fetchText(url: string, signal: AbortSignal) {
    const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        headers: {
            'User-Agent': 'Furnace/0.1 (+agent web_fetch)',
            Accept: 'text/html,text/plain,application/json,*/*;q=0.5',
        },
    });
    const final = new URL(response.url || url);
    if (!['http:', 'https:'].includes(final.protocol)) throw new Error('Redirected to a non-HTTP(S) URL.');
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > MAX_BYTES) {
                await reader.cancel();
                break;
            }
            chunks.push(value);
        }
    const contentType = response.headers.get('content-type') ?? '';
    if (/^(image|audio|video|font)\/|application\/(octet-stream|zip|pdf)/.test(contentType))
        return {
            url: final.href,
            status: response.status,
            contentType,
            text: `[${contentType} content, ${size} bytes; not shown as text]`,
        };
    const raw = new TextDecoder().decode(Buffer.concat(chunks));
    return {
        url: final.href,
        status: response.status,
        contentType,
        text: /html|xml/.test(contentType) || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : raw,
    };
}
