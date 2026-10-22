import { useMemo } from 'react';
import type { ChatMessage, ChatState, Mode, Step } from '../protocol';
import { Icon, type IconName } from '../icons';
import { post, setHistoryOpen, setTimelineOpen, useStore } from '../store';
import { TutorialLayer, demoMessages } from '../tutorial';
import { Logo } from '../logo';
import { Composer, modeNotes } from './composer';
import { TimelinePane } from './timeline';
import { MessageList } from './messages';
import { HistoryPane } from './history';

const modes: Mode[] = ['Discuss', 'Plan', 'Build', 'Research'];

type Suggestion = { text: string; share?: 'shareEditor' | 'shareProblems' | 'shareSelection' | 'sharePlan' };
// Starting points for the current mode and what is open: problems to fix, a selection, a project.
function suggestionsFor(mode: Mode, chat: ChatState): Suggestion[] {
    const info = chat.contextInfo,
        problems = info?.problems.count || 0,
        project = !!chat.agent?.project;
    const items: Record<Mode, Suggestion[]> = {
        Discuss: [
            { text: 'Talk through the tradeoffs with me.' },
            { text: 'Help me shape the project brief.' },
            { text: 'Explain the file I’m working on.', share: 'shareEditor' },
        ],
        Plan: [
            { text: 'Plan the next feature, with a check for each step.' },
            project
                ? { text: 'Find what’s unfinished in this project.' }
                : { text: 'Help me break this idea into steps.' },
            { text: 'Turn the brief into a step-by-step plan.', share: 'sharePlan' },
        ],
        Build: [
            ...(problems
                ? [
                      {
                          text: `Fix the ${problems} problem${problems === 1 ? '' : 's'} in the Problems panel.`,
                          share: 'shareProblems' as const,
                      },
                  ]
                : []),
            ...(info?.selection
                ? [
                      {
                          text: 'Refactor the selected code and keep behaviour the same.',
                          share: 'shareSelection' as const,
                      },
                  ]
                : []),
            { text: 'Add tests for the file I’m working on, then run them.', share: 'shareEditor' },
            { text: 'Run the tests and fix what fails.' },
        ],
        Research: [
            { text: 'Compare the options for this, with sources.' },
            { text: 'Summarise what the shared sources agree on.' },
            { text: 'Find the official docs for this and explain them.' },
        ],
    };
    return items[mode].slice(0, 3);
}

const approvalQuestion: Record<NonNullable<Step['approval']> | 'other', string> = {
    edit: 'Apply this change?',
    command: 'Run this command?',
    network: 'Fetch this page?',
    outside: 'Allow access outside the project?',
    other: 'Allow this action?',
};
// The agent is waiting for you: a bar above the message box, so the question can't scroll out of
// view. The step itself (in the reply) keeps the full choices, such as saved rules and Open Diff.
function ApprovalBar({ messages }: { messages: ChatMessage[] }) {
    const waiting: { message: string; step: Step }[] = [];
    for (const message of messages)
        for (const step of message.steps || [])
            if (step.status === 'waiting') waiting.push({ message: message.id, step });
    if (!waiting.length) return null;
    const { message, step } = waiting[0];
    const flags = [
        step.approval === 'outside' ? 'Outside the project' : '',
        step.approval === 'network' ? 'Web access' : '',
        step.untrusted ? 'Untrusted content in this chat' : '',
    ].filter(Boolean);
    return (
        <div
            id="approval-bar"
            className={`approval-bar${step.untrusted ? ' untrusted' : ''}`}
            role="alert"
            aria-label="The agent is waiting for you"
        >
            <div className="approval-bar-text">
                <strong>
                    {approvalQuestion[step.approval || 'other']}
                    {waiting.length > 1 ? <span className="approval-count"> · 1 of {waiting.length}</span> : null}
                </strong>
                <code title={step.title}>{step.title}</code>
                {flags.length > 0 && (
                    <span className="approval-flags">
                        {flags.map(flag => (
                            <span key={flag} className="approval-flag">
                                ⚠ {flag}
                            </span>
                        ))}
                    </span>
                )}
            </div>
            <div className="approval-bar-actions">
                <button
                    className="primary small"
                    title="Approve (Ctrl+Alt+Enter)"
                    onClick={() => post({ type: 'approval', id: step.id, decision: 'approve' })}
                >
                    Approve
                </button>
                <button
                    className="ghost small"
                    title="Deny (Ctrl+Alt+Backspace)"
                    onClick={() => post({ type: 'approval', id: step.id, decision: 'deny' })}
                >
                    Deny
                </button>
                <button
                    className="ghost small"
                    title="Show the step in the reply, with all choices"
                    onClick={() =>
                        document
                            .getElementById(`message-${message}`)
                            ?.querySelector('.step.waiting')
                            ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                    }
                >
                    Details
                </button>
            </div>
        </div>
    );
}

function Tool({ type, label, icon, title }: { type: 'newChat'; label: string; icon: IconName; title: string }) {
    return (
        <button className="icon-button" aria-label={label} title={title} onClick={() => post({ type })}>
            <Icon name={icon} />
        </button>
    );
}

export function ConversationPanel() {
    const data = useStore(value => value.data),
        messages = useStore(value => value.messages),
        note = useStore(value => value.note),
        historyOpen = useStore(value => value.historyOpen),
        timelineOpen = useStore(value => value.timelineOpen),
        demo = useStore(value => !!value.tutorial?.demo);
    const chat = data?.chat;
    // Model lists arrive with every update; keep one reference so message rows stay memoized.
    const modelsKey = JSON.stringify(chat?.connections.models || []);
    const models = useMemo(() => JSON.parse(modelsKey), [modelsKey]);
    if (!data || !chat) return <div className="conversation" />;
    const mode = data.state.mode;
    return (
        <div
            className="conversation"
            onKeyDown={event => {
                if (event.key === 'Escape' && chat.busy && !event.defaultPrevented && !historyOpen && !timelineOpen)
                    post({ type: 'stop' });
                // Alt+1…4 switch modes.
                if (event.altKey && !event.ctrlKey && !event.metaKey && /^Digit[1-4]$/.test(event.code)) {
                    event.preventDefault();
                    post({ type: 'mode', value: modes[Number(event.code.slice(5)) - 1] });
                }
            }}
        >
            {data.glow && data.glow !== 'off' && (
                <div id="agent-glow" className={`agent-glow ${data.glow}`} aria-hidden="true" />
            )}
            <header className="conversation-head">
                <div className="conversation-title">
                    <strong id="chat-title">{chat.title || 'New conversation'}</strong>
                    <span id="scope">
                        <span
                            id="mode-label"
                            className="mode-label"
                            title={`${modeNotes[mode]}. Choose Start, Plan, Build or Research in the Workspace view to change it (Alt+1…4, Ctrl+Alt+M).`}
                        >
                            {mode}
                        </span>
                        {data.scope}
                    </span>
                </div>
                <div className="tools">
                    <Tool type="newChat" label="New Chat" icon="plus" title="New chat (/new, Ctrl+Alt+N)" />
                    <button
                        className="icon-button"
                        aria-label="Timeline"
                        aria-pressed={timelineOpen}
                        title="Timeline: jump, compare or restore (/timeline)"
                        onClick={() => setTimelineOpen(!timelineOpen)}
                    >
                        <Icon name="timeline" />
                    </button>
                    <button
                        className="icon-button"
                        aria-label="Chat History"
                        aria-pressed={historyOpen}
                        title="Chat history (/history, Ctrl+Alt+H)"
                        onClick={() => setHistoryOpen(!historyOpen)}
                    >
                        <Icon name="history" />
                    </button>
                </div>
            </header>
            {data.review.pending && (
                <div className="review-bar">
                    <span>
                        <Icon name="shield" size={13} /> Reviewed edit ready
                    </span>
                    <div className="row">
                        <button
                            className="primary"
                            disabled={data.review.busy || chat.busy}
                            onClick={() => post({ type: 'apply', generation: data.review.generation })}
                        >
                            Apply Reviewed Changes
                        </button>
                        <button
                            className="ghost"
                            disabled={data.review.busy || chat.busy}
                            onClick={() => post({ type: 'discard', generation: data.review.generation })}
                        >
                            Discard Proposal
                        </button>
                    </div>
                </div>
            )}
            {demo ? (
                // The tutorial's sample reply: display only, its buttons do nothing.
                <div className="tutorial-demo" inert>
                    <MessageList messages={demoMessages} models={models} busy={false} />
                </div>
            ) : historyOpen ? (
                <HistoryPane />
            ) : timelineOpen ? (
                <TimelinePane busy={chat.busy} />
            ) : (
                <MessageList messages={messages} models={models} busy={chat.busy || chat.switching}>
                    {!messages.length && (
                        <div id="empty-chat" className="chat-empty">
                            <Logo small />
                            <h3>What are we thinking about?</h3>
                            <p>Bring a half-formed idea, a tricky function, or the question you haven’t asked yet.</p>
                            <div className="prompt-suggestions" aria-label={`Suggestions for ${mode}`}>
                                {suggestionsFor(mode, chat).map(item => (
                                    <button
                                        key={item.text}
                                        onClick={() => {
                                            if (item.share) post({ type: 'context', field: item.share, enabled: true });
                                            post({ type: 'draft', value: item.text });
                                        }}
                                    >
                                        {item.text.slice(0, -1)}
                                        <Icon name="arrow" size={12} />
                                    </button>
                                ))}
                            </div>
                            {!models.length && (
                                <button
                                    id="connect-hint"
                                    className="connect-hint"
                                    onClick={() => post({ type: 'connections' })}
                                >
                                    <Icon name="plug" size={13} /> Connect a model to start
                                </button>
                            )}
                            <p className="empty-chat-note">
                                <Icon name="shield" size={12} /> You choose the mode. You review the actions.
                            </p>
                        </div>
                    )}
                </MessageList>
            )}
            <div className="composer-area">
                {!demo && <ApprovalBar messages={messages} />}
                <div id="status" role="status" className="status-line">
                    {chat.compacting
                        ? 'Condensing earlier messages into a summary…'
                        : note || chat.error || data.status}
                </div>
                <Composer chat={chat} research={data.research} mode={mode} draft={data.state.draft} />
            </div>
            <TutorialLayer />
        </div>
    );
}
