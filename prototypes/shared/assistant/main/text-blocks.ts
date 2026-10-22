// Providers stream each text block (split by tool calls or new messages) without the
// whitespace a reader expects between them, so "done.Since" would run together.
// Mark a boundary at each new block; its first text then starts a new paragraph.
export function textBlocks(emit: (text: string) => void) {
    let tail = '',
        boundary = false;
    return {
        boundary() {
            boundary = true;
        },
        text(value: string) {
            if (!value) return;
            if (boundary && tail && !(tail + value.slice(0, 2)).includes('\n\n')) value = `\n\n${value}`;
            boundary = false;
            tail = (tail + value).slice(-2);
            emit(value);
        },
    };
}
