import { useEffect, useMemo, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { HelpDoc } from '../protocol';
import { Icon } from '../icons';
import { Logo } from '../logo';
import { post, useStore } from '../store';

// Furnace Help (Furnace → Help, /help): the user guide (GUIDE.md) and data usage page
// (DATA_USAGE.md) bundled with the app, split into their sections, with search.

type Section = { id: string; title: string; body: string };
const slug = (title: string) =>
    title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

/** A document's ## sections; the title, the ASCII logo and the contents list are left out (the page has its own). */
export function sections(markdown: string): Section[] {
    const parts = markdown.replace(/\r\n/g, '\n').split(/^## /m);
    const intro = parts
        .shift()!
        .replace(/^# .*\n/, '')
        .replace(/```[\s\S]*?```\n?/, '')
        .trim();
    const result = intro ? [{ id: 'overview', title: 'Overview', body: intro }] : [];
    for (const part of parts) {
        const title = part.slice(0, part.indexOf('\n')).trim(),
            body = part.slice(part.indexOf('\n') + 1).trim();
        if (title && title !== 'Contents') result.push({ id: slug(title), title, body });
    }
    return result;
}

export function HelpPage() {
    const help = useStore(value => value.help);
    const [docId, setDocId] = useState('guide'),
        [query, setQuery] = useState('');
    const doc: HelpDoc | undefined = help?.docs.find(item => item.id === docId) || help?.docs[0];
    const all = useMemo(() => (doc ? sections(doc.markdown) : []), [doc]);
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const shown = terms.length
        ? all.filter(section => terms.every(term => `${section.title}\n${section.body}`.toLowerCase().includes(term)))
        : all;
    const jump = (id: string) => document.getElementById(`help-${id}`)?.scrollIntoView({ block: 'start' });
    // Furnace → Help can open a section directly.
    useEffect(() => {
        if (help?.section) {
            setQuery('');
            setTimeout(() => jump(help.section!), 50);
        }
    }, [help]);
    const components: Components = {
        a: ({ href = '', children }) => (
            <a
                href={href}
                title={href}
                onClick={event => {
                    event.preventDefault();
                    if (href.startsWith('#')) {
                        setQuery('');
                        setTimeout(() => jump(href.slice(1)), 0);
                    } else if (/^DATA_USAGE\.md/.test(href)) {
                        setDocId('data');
                        setQuery('');
                    } else if (/^(GUIDE|README)\.md/.test(href)) {
                        setDocId('guide');
                        setQuery('');
                    } else if (/^https?:\/\//.test(href)) post({ type: 'openLink', url: href });
                }}
            >
                {children}
            </a>
        ),
        img: ({ alt }) => <span>{alt}</span>,
        table: ({ children }) => (
            <div className="table-wrap">
                <table>{children}</table>
            </div>
        ),
    };
    if (!help) return <main className="help" />;
    return (
        <main className="help">
            <header className="help-head">
                <Logo small />
                <div className="help-title">
                    <h1>Furnace Help</h1>
                    <nav className="page-tabs" role="tablist" aria-label="Help documents">
                        {help.docs.map(item => (
                            <button
                                key={item.id}
                                role="tab"
                                aria-selected={item.id === doc?.id}
                                onClick={() => {
                                    setDocId(item.id);
                                    setQuery('');
                                }}
                            >
                                {item.title}
                            </button>
                        ))}
                    </nav>
                </div>
                <div className="row help-tools">
                    <label className="history-search">
                        <Icon name="search" size={13} />
                        <input
                            id="help-search"
                            type="search"
                            aria-label="Search help"
                            placeholder="Search help"
                            value={query}
                            onChange={event => setQuery(event.target.value)}
                        />
                    </label>
                    <button className="ghost small" onClick={() => post({ type: 'tutorial' })}>
                        Begin Tutorial
                    </button>
                </div>
            </header>
            <div className="help-body">
                <nav className="help-contents" aria-label="Contents">
                    {shown.map(section => (
                        <button key={section.id} onClick={() => jump(section.id)}>
                            {section.title}
                        </button>
                    ))}
                </nav>
                <div className="help-sections">
                    {!shown.length && (
                        <p id="help-empty" className="muted">
                            Nothing in {doc?.title} matches “{query}”.
                        </p>
                    )}
                    {shown.map(section => (
                        <section key={section.id} id={`help-${section.id}`} className="help-section markdown">
                            <h2>{section.title}</h2>
                            <Markdown remarkPlugins={[remarkGfm]} components={components}>
                                {section.body}
                            </Markdown>
                        </section>
                    ))}
                </div>
            </div>
        </main>
    );
}
