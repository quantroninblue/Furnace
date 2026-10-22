import { useEffect, useRef, useState } from 'react';
import type { Theme, ThemeEditorState, ThemePart } from '../protocol';
import { post, useStore } from '../store';

// Create a Custom Theme: every change previews in the window at once; Save keeps it, Cancel
// (or closing the tab) puts the previous theme back. The extension validates every value.

const HEX = /^#[0-9a-f]{6}$/i;

function ColorField({
    id,
    label,
    value,
    onChange,
}: {
    id: string;
    label: string;
    value: string;
    onChange: (value: string) => void;
}) {
    const [text, setText] = useState(value);
    useEffect(() => setText(value), [value]);
    return (
        <>
            <label htmlFor={id}>{label}</label>
            <div className="color-field">
                <input
                    type="color"
                    aria-label={`${label} picker`}
                    value={value}
                    onChange={event => onChange(event.target.value)}
                />
                <input
                    id={id}
                    type="text"
                    value={text}
                    spellCheck={false}
                    maxLength={7}
                    onChange={event => {
                        setText(event.target.value);
                        if (HEX.test(event.target.value)) onChange(event.target.value.toLowerCase());
                    }}
                    onBlur={() => setText(value)}
                />
            </div>
        </>
    );
}

function Segmented<T extends string>({
    label,
    value,
    options,
    onChange,
}: {
    label: string;
    value: T;
    options: [T, string][];
    onChange: (value: T) => void;
}) {
    return (
        <div className="segmented" role="group" aria-label={label}>
            {options.map(([key, text]) => (
                <button key={key} type="button" aria-pressed={value === key} onClick={() => onChange(key)}>
                    {text}
                </button>
            ))}
        </div>
    );
}

function Part({
    part,
    title,
    hint,
    editor,
    children,
}: {
    part: ThemePart;
    title: string;
    hint: string;
    editor: ThemeEditorState;
    children: React.ReactNode;
}) {
    return (
        <section className="theme-part" aria-label={title} data-part={part}>
            <h2>
                {title}
                <select
                    aria-label={`Use ${title.toLowerCase()} from another theme`}
                    value=""
                    onChange={event => {
                        if (event.target.value) post({ type: 'themeTake', part, from: event.target.value });
                    }}
                >
                    <option value="">Use from theme…</option>
                    {editor.sources.map(source => (
                        <option key={source.id} value={source.id}>
                            {source.name}
                        </option>
                    ))}
                </select>
            </h2>
            <p className="hint">{hint}</p>
            {children}
        </section>
    );
}

export function ThemePage() {
    const editor = useStore(value => value.themeEditor);
    const [draft, setDraft] = useState<Theme | null>(null);
    const sent = useRef('');
    // Changes made by the extension (Use from theme, Fix, a new picture) replace the draft; echoes of our own don't.
    useEffect(() => {
        if (!editor) return;
        const json = JSON.stringify(editor.theme);
        if (json !== sent.current) {
            sent.current = json;
            setDraft(editor.theme);
        }
    }, [editor]);
    if (!editor || !draft)
        return (
            <div className="theme-editor">
                <p className="muted">Loading…</p>
            </div>
        );

    const update = (change: (theme: Theme) => Theme) => {
        const next = change(structuredClone(draft));
        setDraft(next);
        sent.current = JSON.stringify(next);
        post({ type: 'themeDraft', theme: next });
    };
    const bg = draft.background;
    const stops = bg.gradient?.stops || [bg.color, '#000000'];
    const isUser = draft.id.startsWith('user-') || draft.id === 'surprise';
    const autoPercent = editor.opacity === null ? '' : `${Math.round(editor.opacity * 100)}%`;

    return (
        <div className="theme-editor">
            <h1>{isUser ? 'Edit Theme' : 'Create a Custom Theme'}</h1>
            <p>Changes show in the window as you make them. Each part can also be taken from another theme.</p>
            {!editor.windowPart && (
                <p className="theme-note">
                    This build can only theme Furnace's own panels: the editor's theme support
                    (patches/themes-menu.patch) isn't installed. Run <code>node scripts/setup.mjs transpile</code> in
                    prototypes/code-oss.
                </p>
            )}
            <div className="theme-top">
                <div className="name">
                    <label htmlFor="theme-name">Name</label>
                    <input
                        id="theme-name"
                        value={draft.name}
                        maxLength={60}
                        onChange={event => update(theme => ({ ...theme, name: event.target.value }))}
                    />
                </div>
            </div>
            <div className="theme-grid">
                <Part
                    part="background"
                    title="Background"
                    hint="Behind the side bars, the panel area, the status bar and the menus. The code editor stays solid."
                    editor={editor}
                >
                    <Segmented
                        label="Background kind"
                        value={bg.kind}
                        options={[
                            ['solid', 'Solid'],
                            ['gradient', 'Gradient'],
                            ['picture', 'Picture'],
                        ]}
                        onChange={kind =>
                            update(theme => ({
                                ...theme,
                                background: {
                                    ...theme.background,
                                    kind,
                                    gradient:
                                        kind === 'gradient' && !theme.background.gradient
                                            ? { stops, angle: 160 }
                                            : theme.background.gradient,
                                    picture:
                                        kind === 'picture' && !theme.background.picture && editor.pictures[0]
                                            ? {
                                                  source: editor.pictures[0].source,
                                                  name: editor.pictures[0].name,
                                                  fit: 'cover',
                                              }
                                            : theme.background.picture,
                                },
                            }))
                        }
                    />
                    <ColorField
                        id="theme-panel"
                        label={bg.kind === 'solid' ? 'Colour' : 'Panel colour (over the backdrop)'}
                        value={bg.color}
                        onChange={color => update(theme => ({ ...theme, background: { ...theme.background, color } }))}
                    />
                    {bg.kind === 'gradient' && (
                        <>
                            <div className="stops">
                                {stops.map((stop, index) => (
                                    <ColorField
                                        key={index}
                                        id={`theme-stop-${index}`}
                                        label={`Gradient colour ${index + 1}`}
                                        value={stop}
                                        onChange={color =>
                                            update(theme => ({
                                                ...theme,
                                                background: {
                                                    ...theme.background,
                                                    gradient: {
                                                        angle: theme.background.gradient?.angle ?? 160,
                                                        stops: stops.map((item, at) => (at === index ? color : item)),
                                                    },
                                                },
                                            }))
                                        }
                                    />
                                ))}
                            </div>
                            <div className="row" style={{ marginTop: 8 }}>
                                {stops.length < 4 && (
                                    <button
                                        type="button"
                                        className="ghost small"
                                        onClick={() =>
                                            update(theme => ({
                                                ...theme,
                                                background: {
                                                    ...theme.background,
                                                    gradient: {
                                                        angle: theme.background.gradient?.angle ?? 160,
                                                        stops: [...stops, stops[stops.length - 1]],
                                                    },
                                                },
                                            }))
                                        }
                                    >
                                        Add Colour
                                    </button>
                                )}
                                {stops.length > 2 && (
                                    <button
                                        type="button"
                                        className="ghost small"
                                        onClick={() =>
                                            update(theme => ({
                                                ...theme,
                                                background: {
                                                    ...theme.background,
                                                    gradient: {
                                                        angle: theme.background.gradient?.angle ?? 160,
                                                        stops: stops.slice(0, -1),
                                                    },
                                                },
                                            }))
                                        }
                                    >
                                        Remove Colour
                                    </button>
                                )}
                            </div>
                            <label htmlFor="theme-angle">Direction</label>
                            <div className="range-row">
                                <input
                                    id="theme-angle"
                                    type="range"
                                    min={0}
                                    max={360}
                                    step={5}
                                    value={bg.gradient?.angle ?? 160}
                                    onChange={event =>
                                        update(theme => ({
                                            ...theme,
                                            background: {
                                                ...theme.background,
                                                gradient: { stops, angle: Number(event.target.value) },
                                            },
                                        }))
                                    }
                                />
                                <span>{bg.gradient?.angle ?? 160}°</span>
                            </div>
                        </>
                    )}
                    {bg.kind === 'picture' && (
                        <>
                            <label>Picture</label>
                            <div className="pictures">
                                {editor.pictures.map(picture => (
                                    <button
                                        key={`${picture.source}/${picture.name}`}
                                        type="button"
                                        title={picture.label}
                                        aria-label={picture.label}
                                        aria-pressed={
                                            bg.picture?.source === picture.source && bg.picture?.name === picture.name
                                        }
                                        style={{ backgroundImage: `url("${picture.url}")` }}
                                        onClick={() =>
                                            update(theme => ({
                                                ...theme,
                                                background: {
                                                    ...theme.background,
                                                    picture: {
                                                        source: picture.source,
                                                        name: picture.name,
                                                        fit: theme.background.picture?.fit || 'cover',
                                                    },
                                                },
                                            }))
                                        }
                                    />
                                ))}
                                <button type="button" className="add" onClick={() => post({ type: 'themePicture' })}>
                                    Your Picture…
                                </button>
                            </div>
                            <label>Fit</label>
                            <Segmented
                                label="Picture fit"
                                value={bg.picture?.fit || 'cover'}
                                options={[
                                    ['cover', 'Fill'],
                                    ['center', 'Fit'],
                                    ['tile', 'Tile'],
                                ]}
                                onChange={fit =>
                                    update(theme => ({
                                        ...theme,
                                        background: {
                                            ...theme.background,
                                            picture: theme.background.picture
                                                ? { ...theme.background.picture, fit }
                                                : null,
                                        },
                                    }))
                                }
                            />
                        </>
                    )}
                    {(bg.kind !== 'solid' || bg.ember !== 'off') && (
                        <>
                            <label className="check">
                                <input
                                    type="checkbox"
                                    checked={bg.dim === 'auto'}
                                    onChange={event =>
                                        update(theme => ({
                                            ...theme,
                                            background: {
                                                ...theme.background,
                                                dim: event.target.checked ? 'auto' : (editor.opacity ?? 0.8),
                                            },
                                        }))
                                    }
                                />
                                Dim panels automatically so text stays readable
                                {bg.dim === 'auto' && autoPercent ? ` (now ${autoPercent})` : ''}
                            </label>
                            {bg.dim !== 'auto' && (
                                <div className="range-row">
                                    <input
                                        aria-label="Panel opacity"
                                        type="range"
                                        min={0}
                                        max={0.95}
                                        step={0.01}
                                        value={bg.dim}
                                        onChange={event =>
                                            update(theme => ({
                                                ...theme,
                                                background: { ...theme.background, dim: Number(event.target.value) },
                                            }))
                                        }
                                    />
                                    <span>{Math.round(Number(bg.dim) * 100)}%</span>
                                </div>
                            )}
                            <label className="check">
                                <input
                                    type="checkbox"
                                    checked={bg.glass}
                                    onChange={event =>
                                        update(theme => ({
                                            ...theme,
                                            background: { ...theme.background, glass: event.target.checked },
                                        }))
                                    }
                                />
                                Glass panels (blur the backdrop behind them)
                            </label>
                        </>
                    )}
                    <label>Ember effect</label>
                    <Segmented
                        label="Ember effect"
                        value={bg.ember}
                        options={[
                            ['off', 'Off'],
                            ['sparks', 'Sparks'],
                            ['glow', 'Glow'],
                        ]}
                        onChange={ember => update(theme => ({ ...theme, background: { ...theme.background, ember } }))}
                    />
                    {bg.ember !== 'off' && (
                        <div className="range-row">
                            <input
                                aria-label="Ember intensity"
                                type="range"
                                min={0.1}
                                max={1}
                                step={0.05}
                                value={bg.emberIntensity}
                                onChange={event =>
                                    update(theme => ({
                                        ...theme,
                                        background: { ...theme.background, emberIntensity: Number(event.target.value) },
                                    }))
                                }
                            />
                            <span>{Math.round(bg.emberIntensity * 100)}%</span>
                        </div>
                    )}
                </Part>

                <Part
                    part="font"
                    title="Font"
                    hint="Text outside the code: menus, side bars, the chat, Workspace and Help. The code editor keeps its own font."
                    editor={editor}
                >
                    <label htmlFor="theme-font">Font</label>
                    <select
                        id="theme-font"
                        value={draft.font.family}
                        onChange={event => update(theme => ({ ...theme, font: { family: event.target.value } }))}
                    >
                        <option value="">System default</option>
                        <optgroup label="Included with Furnace">
                            {editor.fonts.bundled.map(name => (
                                <option key={name} value={name}>
                                    {name}
                                </option>
                            ))}
                        </optgroup>
                        {editor.fonts.installed.length > 0 && (
                            <optgroup label="Installed on this computer">
                                {editor.fonts.installed
                                    .filter(name => !editor.fonts.bundled.includes(name))
                                    .map(name => (
                                        <option key={name} value={name}>
                                            {name}
                                        </option>
                                    ))}
                            </optgroup>
                        )}
                    </select>
                </Part>

                <Part part="text" title="Font Colour" hint="Colours of that text." editor={editor}>
                    <ColorField
                        id="theme-text"
                        label="Main text"
                        value={draft.text.main}
                        onChange={main => update(theme => ({ ...theme, text: { ...theme.text, main } }))}
                    />
                    <ColorField
                        id="theme-muted"
                        label="Secondary text"
                        value={draft.text.muted}
                        onChange={muted => update(theme => ({ ...theme, text: { ...theme.text, muted } }))}
                    />
                </Part>

                <Part
                    part="code"
                    title="Editor Font Colour"
                    hint="Syntax colours of the code: Furnace's own presets or a colour theme you installed."
                    editor={editor}
                >
                    <label htmlFor="theme-code">Code colours</label>
                    <select
                        id="theme-code"
                        value={draft.code}
                        onChange={event => update(theme => ({ ...theme, code: event.target.value }))}
                    >
                        {editor.codes.map(code => (
                            <option key={code.id} value={code.id}>
                                {code.name}
                            </option>
                        ))}
                    </select>
                </Part>

                <Part
                    part="editor"
                    title="Editor Colour"
                    hint="The code editor's background, with the tabs above it. Solid colours only."
                    editor={editor}
                >
                    <ColorField
                        id="theme-editor-bg"
                        label="Editor background"
                        value={draft.editor.background}
                        onChange={background => update(theme => ({ ...theme, editor: { background } }))}
                    />
                </Part>

                <Part
                    part="accent"
                    title="Accent"
                    hint="Buttons, focus rings, links, tutorial bubbles and the agent glow while it works."
                    editor={editor}
                >
                    <ColorField
                        id="theme-accent"
                        label="Accent colour"
                        value={draft.accent}
                        onChange={accent => update(theme => ({ ...theme, accent }))}
                    />
                </Part>
            </div>

            <section className="readability" aria-label="Readability">
                <h2>Readability</h2>
                {editor.checks.map(check => (
                    <div key={check.id} className={`check-row ${check.ok ? 'ok' : 'bad'}`} data-check={check.id}>
                        <span className="mark">{check.ok ? '✓' : '⚠'}</span>
                        <span>{check.label}</span>
                        <span className="ratio">
                            {check.ratio}:1 (needs {check.need}:1)
                        </span>
                        {!check.ok && (
                            <button
                                type="button"
                                className="ghost small"
                                onClick={() => post({ type: 'themeFix', id: check.id })}
                            >
                                Fix
                            </button>
                        )}
                    </div>
                ))}
                {bg.kind === 'picture' && bg.dim !== 'auto' && (
                    <p className="theme-note">
                        With a hand-set dim, text over a busy picture may be hard to read. Automatic dimming keeps it
                        readable.
                    </p>
                )}
            </section>

            <div className="theme-actions">
                {isUser && (
                    <button type="button" className="ghost" onClick={() => post({ type: 'themeDelete', id: draft.id })}>
                        Delete Theme
                    </button>
                )}
                <span className="spacer" />
                <button type="button" className="ghost" onClick={() => post({ type: 'themeCancel' })}>
                    Cancel
                </button>
                {isUser && (
                    <button
                        type="button"
                        className="ghost"
                        onClick={() => post({ type: 'themeSave', theme: draft, asNew: true })}
                    >
                        Save as New
                    </button>
                )}
                <button
                    type="button"
                    className="primary"
                    onClick={() => post({ type: 'themeSave', theme: draft, asNew: false })}
                >
                    Save Theme
                </button>
            </div>
        </div>
    );
}
