'use strict';
// Only included by test entries, never imported by the production bundle.
function stream(output) {
    const base = { id: 'resp_fixture', object: 'response', created_at: 1, model: 'gpt-fixture', status: 'in_progress', output: [] };
    const events = [{ type: 'response.created', response: base }];
    output.forEach((item, index) => {
        events.push({ type: 'response.output_item.added', output_index: index, item: item.type === 'message' ? { ...item, content: [] } : item });
        if (item.type === 'message') events.push({ type: 'response.content_part.added', output_index: index, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } }, { type: 'response.output_text.delta', output_index: index, content_index: 0, item_id: item.id, delta: item.content[0].text });
        events.push({ type: 'response.output_item.done', output_index: index, item });
    });
    events.push({ type: 'response.completed', response: { ...base, status: 'completed', output } });
    return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ sequence_number, ...event })}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}
const call = (name, args) => ({ id: 'fc_' + name, type: 'function_call', call_id: 'call_' + name, name, arguments: JSON.stringify(args), status: 'completed' });
const reply = value => stream([{ id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: value, annotations: [] }] }]);
async function fetcher(url, init) {
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'gpt-fixture' }] });
    if (!String(url).endsWith('/responses')) throw new Error('Fixture forbids external network requests');
    const body = JSON.parse(init.body);
    const latest = body.input.filter(item => item.role === 'user' && !item.content.startsWith('Reference context')).at(-1)?.content || '';
    if (latest === 'wait') return new Promise((_resolve, reject) => { if (init.signal.aborted) reject(new Error('Aborted')); else init.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }); });
    if (latest === 'fail') return Response.json({ error: { type: 'authentication_error', message: 'PRIVATE_FIXTURE_SECRET' } }, { status: 401 });
    const output = name => body.input.find(item => item.type === 'function_call_output' && item.call_id === 'call_' + name)?.output;
    if (body.instructions.includes('Current mode: build') && latest.startsWith('Please change')) {
        if (!output('read_file')) return stream([call('read_file', { path: 'sample.txt', offset: null, limit: null })]);
        if (!output('edit_file')) return stream([call('edit_file', { path: 'sample.txt', old_string: 'Unsaved user draft.', new_string: 'Agent edited draft.', replace_all: null })]);
        if (!output('write_file')) return stream([call('write_file', { path: 'notes/created.txt', content: 'Created by agent.\n' })]);
        if (!output('run_command')) return stream([call('run_command', { command: 'printf "fixture test output\\n"; cat notes/created.txt', workdir: null, timeout_seconds: null, escalate: null, justification: null })]);
        return reply('Agent work complete. ' + output('run_command'));
    }
    if (body.instructions.includes('Current mode: plan') && !output('plan_propose')) return stream([call('plan_propose', { text: 'Migrated planning brief.', reason: 'Review this plan.' })]);
    if (body.instructions.includes('Current mode: research') && !output('research_sources')) return stream([call('research_sources', {})]);
    if (latest === 'forbidden' && !output('read_file')) return stream([call('read_file', { path: 'sample.txt', offset: null, limit: null })]);
    return reply('Fixture reply. ' + (output('research_sources') || output('read_file') || body.input.filter(item => item.role === 'user' && item.content.startsWith('Reference context')).map(item => item.content).join('\n')));
}
exports.dependencies = () => {
    const remote = require('../main/remote-models.ts');
    return { remote: { ...remote, remoteModels: (provider, key) => remote.remoteModels(provider, key, fetcher), remoteChat: (provider, key, request, signal, emit, tools) => remote.remoteChat(provider, key, request, signal, emit, tools, fetcher) },
        ollama: { listModels: async () => [] }, claude: { findClaude: async () => null, claudeStatus: async () => ({ installed: false, connected: false }) } };
};
exports.fetcher = fetcher;
