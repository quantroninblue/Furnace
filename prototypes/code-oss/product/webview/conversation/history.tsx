import { useEffect, useRef, useState } from 'react';
import type { HistoryItem } from '../protocol';
import { Icon } from '../icons';
import { post, setHistoryOpen, useStore } from '../store';

const when = (value: string) => {
    const date = new Date(value),
        days = Math.floor((Date.now() - date.getTime()) / 86400000);
    return days < 1
        ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : days < 7
          ? date.toLocaleDateString([], { weekday: 'short' })
          : date.toLocaleDateString();
};

function Row({ item, current }: { item: HistoryItem; current: boolean }) {
    const [editing, setEditing] = useState(false),
        [title, setTitle] = useState(item.title);
    useEffect(() => setTitle(item.title), [item.title]);
    const save = () => {
        setEditing(false);
        if (title.trim() && title !== item.title) post({ type: 'historyRename', id: item.id, title: title.trim() });
    };
    return (
        <li className={`history-item${current ? ' current' : ''}`}>
            {editing ? (
                <input
                    aria-label="Conversation name"
                    autoFocus
                    maxLength={90}
                    value={title}
                    onChange={event => setTitle(event.target.value)}
                    onBlur={save}
                    onKeyDown={event => {
                        if (event.key === 'Enter') save();
                        if (event.key === 'Escape') {
                            event.stopPropagation();
                            setTitle(item.title);
                            setEditing(false);
                        }
                    }}
                />
            ) : (
                <button
                    className="history-open"
                    title={current ? 'This conversation' : 'Open this conversation'}
                    onClick={() => {
                        post({ type: 'historyOpen', id: item.id });
                        setHistoryOpen(false);
                    }}
                >
                    <strong>{item.title}</strong>
                    <small>
                        {when(item.updatedAt)} · {item.messageCount} message{item.messageCount === 1 ? '' : 's'}
                        {current ? ' · open' : ''}
                    </small>
                    {item.snippet && <span className="history-snippet">{item.snippet}</span>}
                </button>
            )}
            <span className="history-actions">
                <button
                    className="icon-button"
                    aria-label={`Rename ${item.title}`}
                    title="Rename"
                    onClick={() => setEditing(true)}
                >
                    <Icon name="pencil" size={13} />
                </button>
                <button
                    className="icon-button"
                    aria-label={`Delete ${item.title}`}
                    title="Delete"
                    onClick={() => post({ type: 'historyDelete', id: item.id })}
                >
                    <Icon name="trash" size={13} />
                </button>
            </span>
        </li>
    );
}

// Saved conversations for this project: search titles and messages, open, rename, delete.
export function HistoryPane() {
    const history = useStore(value => value.history),
        chatId = useStore(value => value.data?.chat?.id);
    const [query, setQuery] = useState('');
    const field = useRef<HTMLInputElement>(null);
    useEffect(() => {
        field.current?.focus();
    }, []);
    // Searches as the user types, and refreshes when the open conversation changes (rename, delete, new chat).
    useEffect(() => {
        const timer = setTimeout(() => post({ type: 'historyList', value: query }), query ? 200 : 0);
        return () => clearTimeout(timer);
    }, [query, chatId]);
    return (
        <section
            className="history"
            aria-label="Chat history"
            onKeyDown={event => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    setHistoryOpen(false);
                }
            }}
        >
            <div className="history-head">
                <strong>Chat history</strong>
                <button
                    className="icon-button"
                    aria-label="Close history"
                    title="Close (Escape)"
                    onClick={() => setHistoryOpen(false)}
                >
                    <Icon name="close" size={14} />
                </button>
            </div>
            <label className="history-search">
                <Icon name="search" size={13} />
                <input
                    ref={field}
                    aria-label="Search conversations"
                    placeholder="Search titles and messages"
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                />
            </label>
            <ul className="history-list">
                {(history?.items || []).map(item => (
                    <Row key={item.id} item={item} current={item.id === history?.current} />
                ))}
            </ul>
            {history && !history.items.length && (
                <p className="empty-note">
                    {query ? 'No conversations match.' : 'No saved conversations for this project yet.'}
                </p>
            )}
            <button
                className="ghost small history-new"
                onClick={() => {
                    post({ type: 'newChat' });
                    setHistoryOpen(false);
                }}
            >
                <Icon name="plus" size={13} />
                New chat
            </button>
        </section>
    );
}
