import { useEffect, useState, type ReactNode } from 'react';
import type { AuditEntry, BackgroundTask, ChatState, OrgSpend, Page, PlanStep, Rule, State } from '../protocol';
import { Icon, type IconName } from '../icons';
import { choosePage, closeConnections, post, setPrefs, useStore, useSyncedText } from '../store';
import { TutorialLayer } from '../tutorial';
import { Logo } from '../logo';

type Tab = 'chatgpt' | 'claude' | 'local' | 'api';
function ConnectionCard({
    tab,
    icon,
    title,
    subtitle,
    state,
    ready,
    children,
}: {
    tab: Tab;
    icon: IconName;
    title: string;
    subtitle: string;
    state: string;
    ready: boolean;
    children: ReactNode;
}) {
    return (
        <div className="connection-card" data-panel={tab}>
            <div className="connection-card-title">
                <div className="provider-icon">
                    <Icon name={icon} size={17} />
                </div>
                <div>
                    <strong>{title}</strong>
                    <span>{subtitle}</span>
                </div>
                <em className={`connection-state${ready ? ' ready' : ''}`}>{state}</em>
            </div>
            {children}
        </div>
    );
}
function Connections({ chat }: { chat: ChatState }) {
    const tab = useStore(value => value.prefs.tab);
    const c = chat.connections,
        by = (provider: string) => c.connections?.find(item => item.provider === provider);
    const account = c.chatgpt?.accounts.find(item => item.id === c.chatgpt?.activeId);
    const [accountId, setAccountId] = useState(c.chatgpt?.activeId || '');
    useEffect(() => setAccountId(c.chatgpt?.activeId || ''), [c.chatgpt?.activeId]);
    const [provider, setProvider] = useState('openai'),
        [key, setKey] = useState(''),
        [remember, setRemember] = useState(false);
    const busy = chat.connecting;
    const claude = by('claude-code'),
        keys = ['openai', 'anthropic']
            .filter(name => by(name)?.connected)
            .map(name => (name === 'openai' ? 'OpenAI' : 'Anthropic'))
            .join(' · ');
    const notes = (c.connections || [])
        .filter(item => item.error && item.provider !== 'ollama')
        .map(item => `${item.provider}: ${item.error}`);
    const tabs: [Tab, string][] = [
        ['chatgpt', 'ChatGPT'],
        ['claude', 'Claude'],
        ['local', 'Local'],
        ['api', 'API keys'],
    ];
    return (
        <section id="connections" className="connections">
            <div className="connection-modal settings-panel">
                <div className="modal-heading">
                    <div className="welcome-symbol small">
                        <Icon name="plug" size={18} />
                    </div>
                </div>
                <div className="eyebrow">Your tools, one workspace</div>
                <h2>Connect a model.</h2>
                <p className="lede">
                    Choose a connection, then pick an Active model in the conversation panel. API keys use provider
                    billing; ChatGPT uses your plan; Claude Code owns its sign-in and billing. Nothing falls back to
                    another account automatically.
                </p>
                <div className="provider-tabs" role="tablist" aria-label="Connection type">
                    {tabs.map(([id, label]) => (
                        <button key={id} role="tab" aria-selected={tab === id} onClick={() => setPrefs({ tab: id })}>
                            {label}
                        </button>
                    ))}
                </div>
                <div id="connection-status" role="status" className="connection-status">
                    {busy && <p>Connecting… Complete sign-in in your browser, or cancel it here.</p>}
                    {notes.map(text => (
                        <p key={text} className="muted">
                            {text}
                        </p>
                    ))}
                    {c.error && <p className="error">{c.error}</p>}
                </div>
                {tab === 'chatgpt' && (
                    <ConnectionCard
                        tab="chatgpt"
                        icon="shield"
                        title="ChatGPT"
                        subtitle="Your account · your plan"
                        state={account?.signedIn ? account.label || 'Signed in' : 'Not connected'}
                        ready={!!account?.signedIn}
                    >
                        <p className="connection-detail">
                            Use your ChatGPT plan for eligible requests. OpenAI checks your account’s models and limits.
                            This connection never switches to paid API billing.
                        </p>
                        <label htmlFor="account">Saved account</label>
                        <select id="account" value={accountId} onChange={event => setAccountId(event.target.value)}>
                            <option value="">Add account</option>
                            {(c.chatgpt?.accounts || []).map(item => (
                                <option key={item.id} value={item.id}>
                                    {item.label}
                                </option>
                            ))}
                        </select>
                        <div className="row">
                            <button
                                className="primary"
                                disabled={busy}
                                onClick={() =>
                                    post({
                                        type: 'connection',
                                        value: { action: 'signIn', accountId: accountId || null, remember },
                                    })
                                }
                            >
                                Continue with ChatGPT
                            </button>
                            <button
                                className="ghost"
                                onClick={() => post({ type: 'connection', value: { action: 'cancel' } })}
                            >
                                Cancel Sign-in
                            </button>
                        </div>
                        <div className="row">
                            <button
                                className="ghost"
                                disabled={busy}
                                onClick={() =>
                                    post({ type: 'connection', value: { action: 'selectAccount', accountId } })
                                }
                            >
                                Use Account
                            </button>
                            <button
                                className="ghost"
                                disabled={busy}
                                onClick={() => post({ type: 'connection', value: { action: 'signOut', accountId } })}
                            >
                                Sign Out
                            </button>
                            <button className="ghost" disabled={busy} onClick={() => post({ type: 'chatgptUsage' })}>
                                Manage Usage
                            </button>
                        </div>
                        {c.chatgpt?.welcome && (
                            <div id="chatgpt-welcome" className="chatgpt-welcome">
                                <strong>ChatGPT plan usage is enabled.</strong>
                                <p>
                                    Requests use this app’s allowance; availability and limits depend on your account.
                                    There is no automatic API fallback.
                                </p>
                                <button
                                    className="ghost"
                                    disabled={busy}
                                    onClick={() => post({ type: 'connection', value: { action: 'acknowledge' } })}
                                >
                                    Got it
                                </button>
                            </div>
                        )}
                    </ConnectionCard>
                )}
                {tab === 'claude' && (
                    <ConnectionCard
                        tab="claude"
                        icon="sparkle"
                        title="Claude Code"
                        subtitle="Your installed CLI · its account"
                        state={
                            claude?.connected
                                ? claude.account || 'Connected'
                                : claude?.installed === false
                                  ? 'Not installed'
                                  : 'Not connected'
                        }
                        ready={!!claude?.connected}
                    >
                        <p className="connection-detail">
                            Sign-in opens an IDE terminal running Claude Code. Finish there (paste any browser code into
                            the terminal); connections refresh when it closes.
                        </p>
                        <div className="row">
                            <button className="primary" disabled={busy} onClick={() => post({ type: 'claudeLogin' })}>
                                Sign In with Claude Code
                            </button>
                            <button className="ghost" disabled={busy} onClick={() => post({ type: 'claudeConsole' })}>
                                Use Console Account
                            </button>
                        </div>
                    </ConnectionCard>
                )}
                {tab === 'local' && (
                    <ConnectionCard
                        tab="local"
                        icon="layers"
                        title="Ollama"
                        subtitle="Local models · this machine"
                        state={by('ollama')?.connected ? 'Running' : 'Not running'}
                        ready={!!by('ollama')?.connected}
                    >
                        <p className="connection-detail">
                            Start Ollama separately and install a model, then refresh. Models run only when you send;
                            nothing is downloaded automatically.
                        </p>
                    </ConnectionCard>
                )}
                {tab === 'api' && (
                    <ConnectionCard
                        tab="api"
                        icon="code"
                        title="API keys"
                        subtitle="Provider billing"
                        state={keys || 'No keys'}
                        ready={!!keys}
                    >
                        <p className="connection-detail">
                            Keys stay in the separate connection service and are cleared from this field after
                            connecting. A verified key confirms model-list access, not credit.
                        </p>
                        <label htmlFor="provider">API provider</label>
                        <select id="provider" value={provider} onChange={event => setProvider(event.target.value)}>
                            <option value="openai">OpenAI API</option>
                            <option value="anthropic">Anthropic API</option>
                        </select>
                        <label htmlFor="api-key">API key</label>
                        <input
                            id="api-key"
                            type="password"
                            autoComplete="off"
                            maxLength={4096}
                            placeholder="Paste a key"
                            value={key}
                            onChange={event => setKey(event.target.value)}
                        />
                        <div className="row">
                            <button
                                className="primary"
                                disabled={busy}
                                onClick={() => {
                                    post({ type: 'connection', value: { action: 'connect', provider, key, remember } });
                                    setKey('');
                                }}
                            >
                                Connect API Key
                            </button>
                            <button
                                className="ghost"
                                disabled={busy}
                                onClick={() => post({ type: 'connection', value: { action: 'disconnect', provider } })}
                            >
                                Disconnect API Key
                            </button>
                        </div>
                        <SpendPanel chat={chat} remember={remember} />
                    </ConnectionCard>
                )}
                <label
                    className="check remember"
                    title={c.secureStorage ? '' : 'Secure storage is unavailable; sign-ins last for this session.'}
                >
                    <input
                        id="remember"
                        type="checkbox"
                        checked={remember && !!c.secureStorage}
                        disabled={!c.secureStorage}
                        onChange={event => setRemember(event.target.checked)}
                    />
                    Remember sign-ins and keys securely on this device
                </label>
                <div className="modal-actions">
                    <button
                        className="ghost"
                        disabled={busy}
                        onClick={() => post({ type: 'connection', value: { action: 'discover' } })}
                    >
                        Refresh Connections
                    </button>
                    <button className="primary" onClick={closeConnections}>
                        Done
                    </button>
                </div>
            </div>
        </section>
    );
}

const usd = (value: number) => `$${value.toFixed(value >= 100 ? 0 : 2)}`;
const providerName = (id: string) =>
    (({ openai: 'OpenAI', anthropic: 'Anthropic', chatgpt: 'ChatGPT' }) as Record<string, string>)[id] || id;
// Spend: replies made here with API keys (local estimate) and, with an admin key, the
// organization's month-to-date cost as the provider reports it. Normal keys cannot read credit.
function SpendPanel({ chat, remember }: { chat: ChatState; remember: boolean }) {
    const org: OrgSpend | null = useStore(value => value.orgSpend);
    const admin = chat.connections.admin,
        [provider, setProvider] = useState<'openai' | 'anthropic'>('openai'),
        [key, setKey] = useState('');
    const anyAdmin = !!(admin?.openai || admin?.anthropic);
    useEffect(() => {
        if (anyAdmin) post({ type: 'spendRefresh' });
    }, [anyAdmin]);
    const month = chat.spend?.month,
        today = chat.spend?.today;
    return (
        <div id="spend-panel" className="spend-panel">
            <h4>Spend</h4>
            <p className="connection-detail">
                From replies in Furnace on this device (estimated at list prices): today <b>{usd(today?.total || 0)}</b>
                , this month <b>{usd(month?.total || 0)}</b>
                {month && Object.keys(month.byProvider).length
                    ? ` (${Object.entries(month.byProvider)
                          .map(([name, value]) => `${providerName(name)} ${usd(value)}`)
                          .join(', ')})`
                    : ''}
                .
                {chat.budget
                    ? ` Monthly budget ${usd(chat.budget)}.`
                    : ' Set aiGui.budget.monthlyUsd to be warned near a budget.'}
            </p>
            {Object.entries(chat.limits || {}).map(([name, limits]) =>
                limits.tokens?.remaining !== undefined || limits.plan?.length ? (
                    <p key={name} className="muted small">
                        {providerName(name)}:{' '}
                        {limits.plan?.length
                            ? limits.plan
                                  .map(
                                      item =>
                                          `${Math.round(item.usedPercent)}% of the ${item.windowMinutes ? `${Math.round(item.windowMinutes / 60)}h` : item.window} window used`,
                                  )
                                  .join(', ')
                            : `${limits.tokens?.remaining?.toLocaleString()} of ${limits.tokens?.limit?.toLocaleString()} tokens left this minute`}
                    </p>
                ) : null,
            )}
            {anyAdmin && (
                <div className="org-spend">
                    {(['openai', 'anthropic'] as const)
                        .filter(name => admin?.[name])
                        .map(name => {
                            const item = org?.[name];
                            return (
                                <p key={name}>
                                    <b>{providerName(name)} organization</b>:{' '}
                                    {!item ? (
                                        'Loading…'
                                    ) : item.error ? (
                                        <span className="error">{item.error}</span>
                                    ) : (
                                        `${usd(item.amount || 0)} since ${new Date(item.since!).toLocaleDateString()}`
                                    )}
                                </p>
                            );
                        })}
                    <button className="ghost small" onClick={() => post({ type: 'spendRefresh' })}>
                        <Icon name="refresh" size={12} />
                        Refresh
                    </button>
                </div>
            )}
            <details className="admin-keys">
                <summary>Organization spend with an admin key</summary>
                <p className="connection-detail">
                    API keys cannot read your credit balance. An admin key (OpenAI <code>sk-admin-…</code>, Anthropic{' '}
                    <code>sk-ant-admin…</code>) can read the organization’s cost report; Furnace uses it only for that.
                </p>
                <select
                    aria-label="Admin key provider"
                    value={provider}
                    onChange={event => setProvider(event.target.value as 'openai' | 'anthropic')}
                >
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                </select>
                <input
                    aria-label="Admin key"
                    type="password"
                    autoComplete="off"
                    maxLength={4096}
                    placeholder={provider === 'openai' ? 'sk-admin-…' : 'sk-ant-admin…'}
                    value={key}
                    onChange={event => setKey(event.target.value)}
                />
                <div className="row">
                    <button
                        className="primary"
                        disabled={chat.connecting || !key.trim()}
                        onClick={() => {
                            post({ type: 'connection', value: { action: 'adminConnect', provider, key, remember } });
                            setKey('');
                        }}
                    >
                        Connect Admin Key
                    </button>
                    {admin?.[provider] && (
                        <button
                            className="ghost"
                            disabled={chat.connecting}
                            onClick={() => post({ type: 'connection', value: { action: 'adminDisconnect', provider } })}
                        >
                            Remove Admin Key
                        </button>
                    )}
                </div>
            </details>
        </div>
    );
}

// Plan steps with acceptance checks: run a check, or confirm a manual one; the result is kept as evidence.
function PlanChecks({ steps, checking, busy }: { steps: PlanStep[]; checking: string | null; busy: boolean }) {
    if (!steps.some(step => step.check))
        return steps.length ? (
            <p className="muted small plan-check-hint">
                Add a check to a step to prove it: <code>- [ ] Parse dates (check: `npm test`)</code> or{' '}
                <code>(check: manual: open the page)</code>. Plan mode adds them for you.
            </p>
        ) : null;
    return (
        <ol id="plan-steps" className="plan-steps" aria-label="Plan steps and checks">
            {steps.map(step => {
                const evidence = step.evidence,
                    status = evidence?.status || (step.done ? 'done' : 'open');
                return (
                    <li key={step.key} className={`plan-step ${status}`}>
                        <div className="plan-step-head">
                            <span className="step-icon">
                                {evidence?.status === 'passed'
                                    ? '✓'
                                    : evidence?.status === 'failed'
                                      ? '✕'
                                      : step.done
                                        ? '✓'
                                        : '○'}
                            </span>
                            <strong>{step.text}</strong>
                        </div>
                        {step.check && (
                            <small className="plan-step-check">
                                {step.check.kind === 'command' ? (
                                    <>
                                        Check: <code>{step.check.text}</code>
                                    </>
                                ) : (
                                    <>Check: {step.check.text.replace(/^manual:\s*/, '')}</>
                                )}
                            </small>
                        )}
                        {evidence && (
                            <details className="plan-evidence">
                                <summary>
                                    {evidence.status === 'passed' ? 'Passed' : 'Failed'} ·{' '}
                                    {evidence.by === 'you' ? 'by you' : 'by the agent'} ·{' '}
                                    {new Date(evidence.at).toLocaleTimeString([], {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                    })}
                                    {evidence.exitCode !== undefined && evidence.exitCode !== null
                                        ? ` · exit ${evidence.exitCode}`
                                        : ''}
                                </summary>
                                {evidence.output ? (
                                    <pre className="command-output">{evidence.output}</pre>
                                ) : (
                                    <p className="muted small">{evidence.check}</p>
                                )}
                            </details>
                        )}
                        {step.check && (
                            <div className="row">
                                {step.check.kind === 'command' ? (
                                    <button
                                        className="ghost small"
                                        disabled={busy || !!checking}
                                        onClick={() => post({ type: 'checkStep', key: step.key })}
                                    >
                                        <Icon name="play" size={11} />
                                        {checking === step.key ? 'Running…' : 'Run Check'}
                                    </button>
                                ) : (
                                    <>
                                        <button
                                            className="ghost small"
                                            disabled={busy}
                                            onClick={() => post({ type: 'confirmStep', key: step.key, passed: true })}
                                        >
                                            <Icon name="check" size={11} />
                                            Mark Passed
                                        </button>
                                        <button
                                            className="ghost small"
                                            disabled={busy}
                                            onClick={() => post({ type: 'confirmStep', key: step.key, passed: false })}
                                        >
                                            Mark Failed
                                        </button>
                                    </>
                                )}
                            </div>
                        )}
                    </li>
                );
            })}
        </ol>
    );
}

const taskState: Record<BackgroundTask['state'], string> = {
    running: 'Working',
    stopping: 'Stopping',
    done: 'Ready to review',
    failed: 'Failed',
    stopped: 'Stopped',
    interrupted: 'Interrupted',
    applied: 'Applied',
    discarded: 'Discarded',
};
// Background tasks: Build work in separate Git worktrees, reviewed and applied when done.
function BackgroundTasks({ tasks, chat }: { tasks: BackgroundTask[]; chat: ChatState }) {
    const [prompt, setPrompt] = useState(''),
        [follow, setFollow] = useState<Record<string, string>>({});
    const shown = tasks.filter(task => !task.removed || task.state === 'applied').slice(0, 12);
    const project = chat.agent?.project;
    return (
        <section id="background" className="background-tasks" aria-label="Background tasks">
            <h3 className="section-title">Background tasks</h3>
            <p className="muted small">
                The agent works in a separate Git worktree (a copy of the project as it is now, including uncommitted
                files) while you keep editing. You are notified when it needs an approval or finishes; then review the
                changes and apply them, or discard them.
            </p>
            <form
                className="background-form"
                onSubmit={event => {
                    event.preventDefault();
                    if (prompt.trim()) {
                        post({ type: 'backgroundStart', value: prompt });
                        setPrompt('');
                    }
                }}
            >
                <textarea
                    aria-label="Describe a background task"
                    rows={2}
                    maxLength={20000}
                    placeholder={
                        project
                            ? 'For example: add tests for the date parser'
                            : 'Open a Git project to start background tasks'
                    }
                    disabled={!project?.trusted}
                    value={prompt}
                    onChange={event => setPrompt(event.target.value)}
                />
                <button className="primary" type="submit" disabled={!prompt.trim() || !project?.trusted || !chat.model}>
                    Start in Background
                </button>
            </form>
            <ul className="task-list">
                {shown.map(task => (
                    <li key={task.id} className={`task ${task.state}`}>
                        <div className="task-head">
                            <strong title={task.prompt}>{task.title}</strong>
                            <span className={`task-state ${task.state}`}>{taskState[task.state]}</span>
                        </div>
                        <small className="muted">
                            {[
                                task.model.slice(task.model.indexOf('/') + 1),
                                task.files.length
                                    ? `${task.files.length} file${task.files.length === 1 ? '' : 's'} changed`
                                    : '',
                                typeof task.cost === 'number' ? `$${task.cost.toFixed(3)}` : '',
                                task.state === 'running' ? task.activity : '',
                            ]
                                .filter(Boolean)
                                .join(' · ')}
                        </small>
                        {task.error && <p className="error">{task.error}</p>}
                        {task.conflicted?.length ? (
                            <p className="warn small">Resolve conflict markers in {task.conflicted.join(', ')}.</p>
                        ) : null}
                        {task.approvals.map(item => (
                            <div key={item.id} className="approval">
                                <strong>Needs approval: {item.title}</strong>
                                <div className="row">
                                    <button
                                        className="primary small"
                                        onClick={() =>
                                            post({ type: 'backgroundDecide', stepId: item.id, decision: 'approve' })
                                        }
                                    >
                                        Approve
                                    </button>
                                    <button
                                        className="ghost small"
                                        onClick={() =>
                                            post({ type: 'backgroundDecide', stepId: item.id, decision: 'deny' })
                                        }
                                    >
                                        Deny
                                    </button>
                                </div>
                            </div>
                        ))}
                        {task.summary && task.state !== 'running' && (
                            <details>
                                <summary>Summary</summary>
                                <p className="task-summary">{task.summary}</p>
                            </details>
                        )}
                        <div className="row">
                            {task.state === 'running' && (
                                <button
                                    className="ghost small"
                                    onClick={() => post({ type: 'backgroundStop', id: task.id })}
                                >
                                    <Icon name="stop" size={11} />
                                    Stop
                                </button>
                            )}
                            {task.state !== 'running' &&
                                task.state !== 'stopping' &&
                                !task.removed &&
                                task.files.length > 0 && (
                                    <>
                                        <button
                                            className="ghost small"
                                            onClick={() => post({ type: 'backgroundReview', id: task.id })}
                                        >
                                            <Icon name="diff" size={11} />
                                            Review
                                        </button>
                                        {task.state !== 'applied' && (
                                            <button
                                                className="primary small"
                                                onClick={() => post({ type: 'backgroundApply', id: task.id })}
                                            >
                                                Apply to Project
                                            </button>
                                        )}
                                    </>
                                )}
                            {task.state !== 'running' && task.state !== 'stopping' && !task.removed && (
                                <button
                                    className="ghost small"
                                    onClick={() => post({ type: 'backgroundDiscard', id: task.id })}
                                >
                                    <Icon name="trash" size={11} />
                                    {task.state === 'applied' ? 'Remove Worktree' : 'Discard'}
                                </button>
                            )}
                        </div>
                        {['done', 'stopped', 'failed', 'interrupted'].includes(task.state) && !task.removed && (
                            <form
                                className="row"
                                onSubmit={event => {
                                    event.preventDefault();
                                    const value = follow[task.id]?.trim();
                                    if (value) {
                                        post({ type: 'backgroundFollowUp', id: task.id, value });
                                        setFollow({ ...follow, [task.id]: '' });
                                    }
                                }}
                            >
                                <input
                                    aria-label={`Follow-up for ${task.title}`}
                                    placeholder="Ask for more changes in this worktree"
                                    value={follow[task.id] || ''}
                                    onChange={event => setFollow({ ...follow, [task.id]: event.target.value })}
                                />
                                <button className="ghost small" type="submit">
                                    Send
                                </button>
                            </form>
                        )}
                    </li>
                ))}
                {!shown.length && (
                    <li className="empty-note">
                        No background tasks yet. Start one here or type <code>/background</code> and the task in the
                        conversation.
                    </li>
                )}
            </ul>
        </section>
    );
}

function WelcomeCard({
    icon,
    title,
    detail,
    onClick,
}: {
    icon: IconName;
    title: string;
    detail: string;
    onClick: () => void;
}) {
    return (
        <button onClick={onClick}>
            <Icon name={icon} size={17} />
            <strong>{title}</strong>
            <span>{detail}</span>
            <Icon name="chevron" size={13} />
        </button>
    );
}
// Checklist lines ("- [ ] step") in the brief are the task list Build works through.
const checklist = (brief: string) =>
    brief
        .split('\n')
        .map(line => /^\s*[-*+]\s+\[([ xX])\]\s+\S/.exec(line))
        .filter(Boolean)
        .map(match => match![1] !== ' ');
function Brief({ value, busy }: { value: string; busy: boolean }) {
    const [brief, setBrief] = useSyncedText(value, text => post({ type: 'brief', value: text }));
    const steps = checklist(brief),
        done = steps.filter(Boolean).length;
    return (
        <>
            <div className="plan-toolbar">
                <Icon name="book" size={14} />
                <span>Project brief</span>
                {steps.length > 0 && (
                    <span id="plan-progress" className="plan-progress">
                        {done} of {steps.length} steps done
                    </span>
                )}
                <small>Saved on this device</small>
            </div>
            <textarea
                id="brief"
                className="plan-editor"
                maxLength={40000}
                aria-label="Planning brief"
                value={brief}
                onChange={event => setBrief(event.target.value)}
                placeholder={
                    'What are we building?\n\nGoals\nConstraints\n\nSteps\n- [ ] First step\n- [ ] Second step'
                }
            />
            <div className="row plan-actions">
                <button
                    id="build-plan"
                    className="primary"
                    disabled={busy || !brief.trim()}
                    onClick={() => post({ type: 'buildPlan' })}
                    title="Switch to Build, share this brief and work through its unchecked steps; each one is ticked here when the agent completes it"
                >
                    Build from Plan
                </button>
                <span className="muted small">
                    Write steps as a checklist (- [ ] step). Build ticks them off as it completes them.
                </span>
            </div>
        </>
    );
}
// Shows the click at once; the extension's next update confirms (or corrects) it.
function ShareCheck({ id, shared }: { id: string; shared: boolean }) {
    const [on, setOn] = useState(shared);
    useEffect(() => setOn(shared), [shared]);
    return (
        <label className="check">
            <input
                type="checkbox"
                checked={on}
                onChange={event => {
                    setOn(event.target.checked);
                    post({ type: 'sourceShare', id, enabled: event.target.checked });
                }}
            />
            Share with next reply
        </label>
    );
}
function Research({ data }: { data: State }) {
    const research = data.research;
    const [address, setAddress] = useState('');
    return (
        <section>
            <div className="page-heading">
                <h2>Research desk</h2>
                <p className="lede">
                    Browse references in a separate, sandboxed window while your code stays here. Capturing saves a
                    source; only sharing includes it in a reply.
                </p>
            </div>
            <form
                id="research-form"
                className="browser-address"
                onSubmit={event => {
                    event.preventDefault();
                    post({ type: 'researchOpen', value: address });
                }}
            >
                <Icon name="globe" size={15} />
                <input
                    id="research-address"
                    maxLength={8192}
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="Website or search query"
                    placeholder="Website or search query"
                    value={address}
                    onChange={event => setAddress(event.target.value)}
                />
                <button id="research-open" className="primary" type="submit" disabled={research.busy}>
                    {research.busy ? 'Opening…' : research.opened ? 'Open Address in Browser' : 'Open Research Browser'}
                </button>
                {(research.opened || research.busy) && (
                    <button
                        type="button"
                        className="ghost"
                        id="research-close"
                        onClick={() => post({ type: 'researchClose' })}
                    >
                        Close Browser
                    </button>
                )}
            </form>
            <p id="research-state" role="status" className="muted">
                {research.error ||
                    (research.loading
                        ? 'Loading…'
                        : research.opened
                          ? research.title || research.url
                          : 'Enter a website or search query to begin.')}
            </p>
            <div className="sources-heading">
                <span className="section-label">
                    Collected sources · <b id="source-count">{research.sources.length}</b>/6
                </span>
                <div className="row">
                    <button
                        className="ghost"
                        disabled={!research.opened || research.loading}
                        onClick={() => post({ type: 'captureSelection' })}
                    >
                        Capture Selection
                    </button>
                    <button
                        className="ghost"
                        disabled={!research.opened || research.loading}
                        onClick={() => post({ type: 'capturePage' })}
                    >
                        Capture Page
                    </button>
                </div>
            </div>
            <p className="muted small">
                Select text in the browser, then Capture Selection. Keep up to six sources; share up to three.
            </p>
            <div id="sources">
                {research.sources.map(source => (
                    <article key={source.id} className="source-card">
                        <div className="source-title">
                            <h3>{source.title || source.url}</h3>
                            <ShareCheck id={source.id} shared={source.shared} />
                        </div>
                        <small>{source.url}</small>
                        <details>
                            <summary>{source.kind === 'selection' ? 'Captured selection' : 'Captured page'}</summary>
                            <pre>{source.text}</pre>
                        </details>
                        <button className="ghost small" onClick={() => post({ type: 'sourceRemove', id: source.id })}>
                            Remove Source
                        </button>
                    </article>
                ))}
                {!research.sources.length && (
                    <p className="empty-note">No sources yet. Open the browser, then capture a selection or page.</p>
                )}
            </div>
            <div className="note">
                <Icon name="shield" size={13} />
                <p>
                    The research browser has no terminal or filesystem bridge. Captured text reaches a model only when
                    you share it.
                </p>
            </div>
        </section>
    );
}

const kinds: Record<Rule['effect'], { value: Rule['kind']; label: string; placeholder: string }[]> = {
    allow: [
        { value: 'command', label: 'Command', placeholder: 'npm test' },
        { value: 'network', label: 'Website', placeholder: 'docs.python.org or *.example.com' },
        { value: 'edit', label: 'File edits', placeholder: '*' },
    ],
    deny: [
        { value: 'path', label: 'Path', placeholder: 'infra/ or **/*.pem' },
        { value: 'command', label: 'Command', placeholder: 'git push' },
    ],
};
const ruleText = (rule: Rule) =>
    rule.effect === 'allow'
        ? rule.kind === 'command'
            ? `Run “${rule.pattern}” without asking`
            : rule.kind === 'network'
              ? `Fetch ${rule.pattern} without asking`
              : 'Edit project files without asking'
        : rule.kind === 'path'
          ? `Never read or change ${rule.pattern}`
          : `Never run “${rule.pattern}”`;
function Rules({ chat }: { chat: ChatState }) {
    const [effect, setEffect] = useState<Rule['effect']>('allow'),
        [kind, setKind] = useState<Rule['kind']>('command'),
        [pattern, setPattern] = useState('');
    const options = kinds[effect],
        current = options.find(item => item.value === kind) ?? options[0];
    const project = chat.agent?.project;
    return (
        <section>
            <div className="page-heading">
                <h2>Saved permissions</h2>
                <p className="lede">
                    Rules for {project ? <b>{project.name}</b> : 'chats without a project'}, kept in this app (never in
                    the project, so a repository cannot grant itself access). Allow rules skip the approval question;
                    deny rules apply in every mode, including Full access.
                </p>
            </div>
            <ul id="rules" className="rule-list">
                {chat.rules.map(rule => (
                    <li key={rule.id} className={`rule ${rule.effect}`}>
                        <span className="rule-effect">{rule.effect === 'allow' ? 'Allow' : 'Deny'}</span>
                        <span className="rule-text">{ruleText(rule)}</span>
                        <button
                            className="icon-button"
                            aria-label={`Remove rule: ${ruleText(rule)}`}
                            title="Remove"
                            onClick={() => post({ type: 'ruleRemove', id: rule.id })}
                        >
                            <Icon name="trash" size={13} />
                        </button>
                    </li>
                ))}
                {!chat.rules.length && (
                    <li className="empty-note">
                        No saved rules. Choose “Always allow … in this project” on an approval, or add one below.
                    </li>
                )}
            </ul>
            <form
                className="rule-form"
                onSubmit={event => {
                    event.preventDefault();
                    post({
                        type: 'ruleAdd',
                        effect,
                        kind: current.value,
                        pattern: current.value === 'edit' ? '*' : pattern,
                    });
                    setPattern('');
                }}
            >
                <div className="row">
                    <select
                        aria-label="Rule effect"
                        value={effect}
                        onChange={event => {
                            const next = event.target.value as Rule['effect'];
                            setEffect(next);
                            setKind(kinds[next][0].value);
                        }}
                    >
                        <option value="allow">Allow</option>
                        <option value="deny">Deny</option>
                    </select>
                    <select
                        aria-label="Rule type"
                        value={current.value}
                        onChange={event => setKind(event.target.value as Rule['kind'])}
                    >
                        {options.map(item => (
                            <option key={item.value} value={item.value}>
                                {item.label}
                            </option>
                        ))}
                    </select>
                </div>
                {current.value !== 'edit' && (
                    <input
                        aria-label="Rule pattern"
                        placeholder={current.placeholder}
                        maxLength={500}
                        value={pattern}
                        onChange={event => setPattern(event.target.value)}
                    />
                )}
                <button className="primary" type="submit" disabled={current.value !== 'edit' && !pattern.trim()}>
                    Add Rule
                </button>
            </form>
            <div className="note">
                <Icon name="shield" size={13} />
                <p>
                    A command rule covers that command with any extra arguments (“npm test” also allows “npm test --
                    --watch”), but never commands joined with ; &amp;&amp; | or redirections. Paths are relative to the
                    project; “infra/” covers everything inside it.
                </p>
            </div>
        </section>
    );
}
const time = (value: string) =>
    new Date(value).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
function Activity() {
    const entries = useStore(value => value.audit),
        [filter, setFilter] = useState('');
    useEffect(() => {
        post({ type: 'auditLoad' });
    }, []);
    const needle = filter.toLowerCase();
    const shown = (entries || []).filter(
        (entry: AuditEntry) =>
            !needle || `${entry.title} ${entry.decision || ''} ${entry.detail || ''}`.toLowerCase().includes(needle),
    );
    return (
        <section>
            <div className="page-heading">
                <h2>Activity log</h2>
                <p className="lede">
                    Everything the agent did in this project: each tool step and how it was allowed, your approvals,
                    reverts, rewinds, rules and background processes. Stored on this device only.
                </p>
            </div>
            <div className="row activity-tools">
                <input
                    aria-label="Filter activity"
                    placeholder="Filter"
                    value={filter}
                    onChange={event => setFilter(event.target.value)}
                />
                <button className="ghost small" onClick={() => post({ type: 'auditLoad' })}>
                    <Icon name="refresh" size={12} />
                    Refresh
                </button>
                <button className="ghost small" onClick={() => post({ type: 'auditOpen' })}>
                    Open Log File
                </button>
                <button className="ghost small" onClick={() => post({ type: 'auditClear' })}>
                    Clear
                </button>
            </div>
            <ol id="activity" className="activity-list">
                {shown.map((entry, index) => (
                    <li key={`${entry.time}-${index}`} className={`activity ${entry.status || entry.event}`}>
                        <time>{time(entry.time)}</time>
                        <span className="activity-title">{entry.title}</span>
                        {(entry.decision || entry.detail) && (
                            <small>{[entry.decision, entry.detail].filter(Boolean).join(' · ')}</small>
                        )}
                    </li>
                ))}
            </ol>
            {entries && !shown.length && (
                <p className="empty-note">{filter ? 'Nothing matches.' : 'Nothing recorded for this project yet.'}</p>
            )}
        </section>
    );
}
const shortcuts: [string, string][] = [
    ['Ctrl+Alt+I', 'Focus the conversation'],
    ['Ctrl+Alt+N', 'New chat'],
    ['Ctrl+Alt+H', 'Chat history'],
    ['Ctrl+Alt+M or Alt+1…4', 'Switch mode'],
    ['Ctrl+Alt+W', 'This workspace view'],
    ['Enter / Shift+Enter', 'Send (queues while busy) / new line'],
    ['Escape or Ctrl+Alt+.', 'Stop the reply'],
    ['Ctrl+Alt+Enter / Ctrl+Alt+Backspace', 'Approve / deny the waiting action'],
    ['Ctrl+Alt+E', 'Inline edit the selection (Ctrl+Enter accepts, Escape rejects)'],
    ['@ and /', 'Add files or folders / commands'],
];
const modeTitles: Partial<Record<Page, string>> = {
    start: 'Start · Discuss mode: the chat uses only the context you share (Alt+1)',
    plan: 'Plan mode: reads and searches the project, proposes a brief (Alt+2)',
    build: 'Build mode: reads, edits and creates files, runs commands (Alt+3)',
    research: 'Research mode: uses shared sources, suggests pages (Alt+4)',
};
const pages: [Page, string][] = [
    ['start', 'Start'],
    ['plan', 'Plan'],
    ['build', 'Build'],
    ['research', 'Research'],
];
// Settings: everything that is not a mode page.
const settings: [Page, string, IconName][] = [
    ['connections', 'Connections', 'plug'],
    ['rules', 'Rules', 'shield'],
    ['activity', 'Activity', 'list'],
    ['shortcuts', 'Shortcuts', 'terminal'],
    ['about', 'About & support', 'sparkle'],
];
const isSettings = (page: Page) => settings.some(([id]) => id === page);

function Shortcuts() {
    return (
        <section>
            <div className="page-heading">
                <h2>Keyboard shortcuts</h2>
                <p className="lede">
                    The main actions, without leaving the keyboard. Type <code>/</code> in the message box for every
                    command.
                </p>
            </div>
            <dl className="shortcuts">
                {shortcuts.map(([keys, action]) => (
                    <div key={keys}>
                        <dt>
                            <kbd>{keys}</kbd>
                        </dt>
                        <dd>{action}</dd>
                    </div>
                ))}
            </dl>
            <div className="row">
                <button className="ghost small" onClick={() => post({ type: 'keys' })}>
                    Change Shortcuts
                </button>
            </div>
        </section>
    );
}
function About() {
    return (
        <section>
            <div className="page-heading">
                <h2>About &amp; support</h2>
                <p className="lede">Help, the tutorial, themes, and what to send when something goes wrong.</p>
            </div>
            <div className="settings-actions">
                <button className="ghost" onClick={() => post({ type: 'help' })}>
                    <Icon name="book" size={14} />
                    Help
                </button>
                <button className="ghost" onClick={() => post({ type: 'tutorial' })}>
                    <Icon name="sparkle" size={14} />
                    Begin Tutorial
                </button>
                <button className="ghost" onClick={() => post({ type: 'themeCommand', value: '' })}>
                    <Icon name="layout" size={14} />
                    Themes
                </button>
                <button className="ghost" onClick={() => post({ type: 'checkUpdates' })}>
                    <Icon name="refresh" size={14} />
                    Check for Updates
                </button>
                <button
                    className="ghost"
                    onClick={() => post({ type: 'diagnostics' })}
                    title="Copies versions, settings and recent errors (no conversation text or keys) for a bug report"
                >
                    <Icon name="copy" size={14} />
                    Copy Diagnostics
                </button>
                <button className="ghost" onClick={() => post({ type: 'feedback' })}>
                    <Icon name="pencil" size={14} />
                    Send Feedback
                </button>
            </div>
            <section id="privacy" className="privacy" aria-label="Privacy">
                <h3 className="section-title">
                    <Icon name="shield" size={14} /> Your data stays yours
                </h3>
                <ul>
                    <li>
                        <b>No Furnace account, no telemetry.</b> Conversations, the activity log, saved rules and
                        checkpoints stay on this device.
                    </li>
                    <li>
                        <b>Only what you send leaves.</b> A message goes to the model you chose, with the context you
                        shared (chips, @files, pasted images) and what the agent reads to do the task.
                    </li>
                    <li>
                        <b>Your accounts, your billing.</b> ChatGPT, Claude Code, API keys or local Ollama; nothing
                        switches accounts or falls back to paid billing on its own.
                    </li>
                    <li>
                        <b>Keys stay in a separate service</b> and in your system’s secure storage only when you choose
                        “Remember”.
                    </li>
                    <li>
                        <b>Local models keep everything on this machine.</b> With Ollama, nothing leaves it.
                    </li>
                </ul>
            </section>
        </section>
    );
}

export function HomePage() {
    const data = useStore(value => value.data),
        page = useStore(value => value.page),
        note = useStore(value => value.note);
    if (!data) return <main className="workspace" />;
    const review = data.review,
        busy = review.busy || !!data.chat?.busy,
        inSettings = isSettings(page);
    return (
        <main className="workspace">
            <header className="page-top">
                <span className="eyebrow">
                    <i className="dot" />A shared place to think &amp; build
                </span>
                <div className="page-tools">
                    <span className="text-size" role="group" aria-label="Text size">
                        Text size
                        <button
                            className="ghost small"
                            aria-label="Smaller text"
                            title="Smaller text (Ctrl+-)"
                            onClick={() => post({ type: 'textSmaller' })}
                        >
                            A−
                        </button>
                        <button
                            className="ghost small"
                            aria-label="Larger text"
                            title="Larger text (Ctrl+=)"
                            onClick={() => post({ type: 'textLarger' })}
                        >
                            A+
                        </button>
                    </span>
                    <span id="scope" className="scope-pill">
                        {data.scope}
                    </span>
                </div>
            </header>
            <nav className="page-tabs" role="tablist" aria-label="Workspace pages">
                {pages.map(([id, label]) => (
                    <button
                        key={id}
                        role="tab"
                        aria-selected={page === id}
                        title={modeTitles[id]}
                        onClick={() => choosePage(id)}
                    >
                        {label}
                    </button>
                ))}
                <button
                    role="tab"
                    className="settings-tab"
                    aria-selected={inSettings}
                    title="Connections, rules, activity, shortcuts and support"
                    onClick={() => !inSettings && post({ type: 'connections' })}
                >
                    <Icon name="settings" size={13} />
                    Settings
                </button>
            </nav>
            <div id="workspace-pages">
                {inSettings && (
                    <div className="settings">
                        <nav className="settings-nav" aria-label="Settings">
                            {settings.map(([id, label, icon]) => (
                                <button
                                    key={id}
                                    aria-current={page === id ? 'page' : undefined}
                                    onClick={() =>
                                        id === 'connections' ? post({ type: 'connections' }) : choosePage(id)
                                    }
                                >
                                    <Icon name={icon} size={13} />
                                    {label}
                                </button>
                            ))}
                        </nav>
                        <div className="settings-body">
                            {page === 'connections' && data.chat && <Connections chat={data.chat} />}
                            {page === 'rules' && data.chat && <Rules chat={data.chat} />}
                            {page === 'activity' && <Activity />}
                            {page === 'shortcuts' && <Shortcuts />}
                            {page === 'about' && <About />}
                        </div>
                    </div>
                )}
                {page === 'start' && (
                    <section className="welcome">
                        <Logo />
                        <h1>
                            Your ideas.
                            <br />
                            <span>A little more possibility.</span>
                        </h1>
                        <p className="lede">
                            A workspace for you and your agents.
                            <br />
                            Explore the plan, work in the code, stay in control.
                        </p>
                        <button className="primary large" onClick={() => post({ type: 'openFolder' })}>
                            <Icon name="folder" size={15} /> Open a project <Icon name="chevron" size={13} />
                        </button>
                        <div className="welcome-cards">
                            <WelcomeCard
                                icon="book"
                                title="Think it through"
                                detail="Shape a brief together"
                                onClick={() => post({ type: 'mode', value: 'Plan' })}
                            />
                            <WelcomeCard
                                icon="globe"
                                title="Bring the context"
                                detail="Research without losing place"
                                onClick={() => post({ type: 'mode', value: 'Research' })}
                            />
                            <WelcomeCard
                                icon="plug"
                                title="Connect a model"
                                detail="ChatGPT, Claude, API keys or Ollama"
                                onClick={() => post({ type: 'connections' })}
                            />
                        </div>
                        <div id="learn" className="learn-card">
                            <div>
                                <strong>New to Furnace?</strong>
                                <span>
                                    The tutorial points out each part of Furnace and opens it for you, one step at a
                                    time. Help has the full guide.
                                </span>
                            </div>
                            <div className="row">
                                <button className="primary" onClick={() => post({ type: 'tutorial' })}>
                                    Begin Tutorial
                                </button>
                                <button className="ghost" onClick={() => post({ type: 'help' })}>
                                    Help
                                </button>
                            </div>
                        </div>
                        <p className="footnote">
                            <Icon name="shield" size={12} /> Built for collaboration. You keep the controls.{' '}
                            <button className="link" onClick={() => choosePage('shortcuts')}>
                                Keyboard shortcuts
                            </button>{' '}
                            ·{' '}
                            <button className="link" onClick={() => choosePage('about')}>
                                Privacy and support
                            </button>
                        </p>
                    </section>
                )}
                {page === 'plan' && (
                    <section>
                        <div className="page-heading">
                            <h2>Make the next step clear.</h2>
                            <p className="lede">
                                An editable brief saved with this conversation. Share it from the message box’s + menu
                                to include it in replies, or build it step by step.
                            </p>
                        </div>
                        <Brief value={data.state.brief} busy={busy} />
                        {data.chat && (
                            <PlanChecks steps={data.chat.planSteps || []} checking={data.chat.checking} busy={busy} />
                        )}
                    </section>
                )}
                {page === 'build' && (
                    <section>
                        <div className="page-heading">
                            <h2>Your code. Your decisions.</h2>
                            <p className="lede">
                                Ask for a change in the conversation. The agent explores, edits and creates files and
                                runs commands within your permission mode (Ask first, Auto or Full access), showing each
                                step and its diff. Every reply lists the files it changed so you can review them, revert
                                one or all, or rewind the chat.
                            </p>
                        </div>
                        <div className="row">
                            <button className="ghost" onClick={() => post({ type: 'openFile' })}>
                                <Icon name="code" size={14} /> Open File
                            </button>
                            <button className="ghost" disabled={busy} onClick={() => post({ type: 'propose' })}>
                                Propose Example Edit
                            </button>
                        </div>
                        {review.pending && (
                            <div className="row">
                                <button
                                    className="primary"
                                    disabled={busy}
                                    onClick={() => post({ type: 'apply', generation: review.generation })}
                                >
                                    Apply Reviewed Changes
                                </button>
                                <button
                                    className="ghost"
                                    disabled={busy}
                                    onClick={() => post({ type: 'discard', generation: review.generation })}
                                >
                                    Discard Proposal
                                </button>
                            </div>
                        )}
                        <div className="row">
                            <button className="ghost" onClick={() => post({ type: 'openScm' })}>
                                <Icon name="git" size={14} /> Source Control
                            </button>
                            <button
                                className="ghost"
                                title="Select code in an editor, then describe the change (Ctrl+Alt+E)"
                                onClick={() => post({ type: 'inlineEdit' })}
                            >
                                <Icon name="pencil" size={14} /> Inline Edit
                            </button>
                        </div>
                        {data.chat && <BackgroundTasks tasks={data.background || []} chat={data.chat} />}
                        <div className="note">
                            <Icon name="terminal" size={13} />
                            <p>
                                The agent’s commands show live in the <b>AI Agent</b> terminal (Ctrl+C there interrupts
                                one). Dev servers and watchers run in the background in their own terminals and appear
                                above the message box with Stop. Every file the agent changes is listed in Source
                                Control under <b>AI Agent</b>, next to Git’s own changes.
                            </p>
                        </div>
                        <div className="note">
                            <Icon name="shield" size={13} />
                            <p>
                                To run a command yourself, choose <b>Run a command yourself</b> in the message box’s +
                                menu or type <code>/run npm test</code>. Commands run with your user permissions in the
                                project folder; output appears in the conversation and Stop cancels it. Example Edit is
                                a deterministic demo.
                            </p>
                        </div>
                    </section>
                )}
                {page === 'research' && <Research data={data} />}
            </div>
            <div id="status" role="status" className="status-line">
                {data.chat?.error || data.status || note}
            </div>
            <TutorialLayer />
        </main>
    );
}
