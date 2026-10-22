'use strict';
// Migrated from the original isolated research preload. Runs only on explicit
// capture, in an isolated world; never installs an API on the remote page.
function extract(kind) {
    const excluded =
        "script,style,noscript,template,input,textarea,select,option,button,form,[contenteditable],[hidden],[aria-hidden='true']";
    const visible = element => {
        if (element.closest(excluded)) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
    };
    const limit = kind === 'selection' ? 16000 : 8000;
    const selection = window.getSelection();
    if (
        kind === 'selection' &&
        (!selection?.rangeCount || selection.isCollapsed || document.activeElement?.closest(excluded))
    ) {
        throw new Error('Select text outside forms and editable fields first.');
    }
    const range = kind === 'selection' ? selection.getRangeAt(0) : null;
    const parts = [];
    let size = 0,
        visited = 0;
    if (document.body) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode()) && size < limit && visited++ < 30000) {
            if (!node.parentElement || !visible(node.parentElement) || (range && !range.intersectsNode(node))) continue;
            let value = node.textContent || '';
            if (range)
                value = value.slice(
                    node === range.startContainer ? range.startOffset : 0,
                    node === range.endContainer ? range.endOffset : undefined,
                );
            value = value.replace(/\s+/g, ' ').trim();
            if (value) {
                parts.push(value);
                size += value.length + 1;
            }
        }
    }
    const references = (selector, image, max) => {
        const values = [],
            seen = new Set();
        for (const element of Array.from(document.querySelectorAll(selector)).slice(0, 3000)) {
            if (!visible(element)) continue;
            const value = image ? element.currentSrc || element.src : element.href;
            let url;
            try {
                url = new URL(value);
            } catch {
                continue;
            }
            if (
                !['http:', 'https:'].includes(url.protocol) ||
                url.username ||
                url.password ||
                url.href.length > 8192 ||
                seen.has(url.href)
            )
                continue;
            seen.add(url.href);
            values.push({
                url: url.href,
                label: (image ? element.alt : element.textContent || '').trim().slice(0, 200),
            });
            if (values.length >= max) break;
        }
        return values;
    };
    return {
        title: document.title.slice(0, 300),
        text: parts.join('\n').slice(0, limit),
        truncated: size >= limit || visited >= 30000,
        links: kind === 'page' ? references('a[href]', false, 20) : [],
        images: kind === 'page' ? references('img', true, 12) : [],
    };
}
exports.extractionScript = kind => `(${extract.toString()})(${JSON.stringify(kind)})`;
