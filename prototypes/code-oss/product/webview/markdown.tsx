import { memo, useState, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Element, ElementContent } from 'hast';
import { Icon } from './icons';
import { post, setPrefs, useStore } from './store';

// Model output is rendered as React elements (never raw HTML). Remote images stay links:
// the webview's content policy blocks network loads, and replies must not phone home.
const text = (node: ElementContent | Element): string =>
    node.type === 'text'
        ? node.value
        : 'children' in node
          ? node.children.map(child => text(child as ElementContent)).join('')
          : '';

function CodeBlock({ node, children }: { node?: Element; children?: ReactNode }) {
    const code = node?.children.find((child): child is Element => child.type === 'element' && child.tagName === 'code');
    const source = code ? text(code).replace(/\n$/, '') : '';
    const language =
        (code?.properties.className as string[] | undefined)?.find(name => name.startsWith('language-'))?.slice(9) ||
        '';
    const [copied, setCopied] = useState(false);
    const wrap = useStore(value => value.prefs.wrapCode);
    return (
        <div className={`code-block${wrap ? ' wrap' : ''}`}>
            <div className="code-head">
                <span>{language || 'text'}</span>
                <button
                    className="code-action"
                    aria-pressed={wrap}
                    title={
                        wrap
                            ? 'Long lines wrap. Click to scroll them instead.'
                            : 'Long lines scroll. Click to wrap them.'
                    }
                    onClick={() => setPrefs({ wrapCode: !wrap })}
                >
                    Wrap
                </button>
                <button
                    className="code-action"
                    title="Copy code"
                    onClick={() => {
                        post({ type: 'copy', text: source });
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                    }}
                >
                    <Icon name="copy" size={12} />
                    {copied ? 'Copied' : 'Copy'}
                </button>
                <button
                    className="code-action"
                    title="Insert at the cursor in the active editor (Undo reverses it)"
                    onClick={() => post({ type: 'insertSnippet', text: source })}
                >
                    <Icon name="insert" size={12} />
                    Insert
                </button>
            </div>
            <pre>{children}</pre>
        </div>
    );
}
const components: Components = {
    pre: CodeBlock,
    img: ({ src, alt }) => <a href={typeof src === 'string' ? src : undefined}>{alt || 'image'}</a>,
    a: ({ href, children }) => (
        <a href={href} title={href}>
            {children}
        </a>
    ),
    table: ({ children }) => (
        <div className="table-wrap">
            <table>{children}</table>
        </div>
    ),
};
const remark = [remarkGfm],
    rehype = [[rehypeHighlight, { detect: false }]] as never;

export const MarkdownText = memo(function MarkdownText({ text: value }: { text: string }) {
    return (
        <div className="markdown">
            <Markdown remarkPlugins={remark} rehypePlugins={rehype} components={components}>
                {value}
            </Markdown>
        </div>
    );
});
