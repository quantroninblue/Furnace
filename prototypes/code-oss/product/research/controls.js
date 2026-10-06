const api = window.researchControls;
const address = document.getElementById('address');
const reload = document.getElementById('reload');
const status = document.getElementById('status');
let loading = false, dirty = false, current;
const show = state => {
    current = state; loading = state.loading;
    if (!dirty) address.value = state.url;
    document.querySelector('[data-action="back"]').disabled = !state.back;
    document.querySelector('[data-action="forward"]').disabled = !state.forward;
    reload.textContent = loading ? '■' : '↻';
    reload.setAttribute('aria-label', loading ? 'Stop' : 'Reload');
    reload.title = loading ? 'Stop loading' : 'Reload (Ctrl+R)';
    reload.disabled = !state.url;
    status.textContent = state.error || (loading ? 'Loading…' : state.title || 'Enter a website or search query.');
    status.classList.toggle('error', !!state.error);
    status.title = status.textContent;
};
const act = async (action, value) => {
    try { const state = await api.action(action, value); if (state) show(state); }
    catch { status.textContent = 'The browser controls disconnected. Close and reopen Research.'; }
};
address.addEventListener('input', () => { dirty = true; });
address.addEventListener('keydown', event => {
    if (event.key === 'Escape') { dirty = false; if (current) show(current); address.blur(); }
});
document.getElementById('navigation').addEventListener('submit', event => {
    event.preventDefault(); const value = address.value; dirty = false; void act('navigate', value);
});
for (const button of document.querySelectorAll('[data-action]')) button.onclick = () => { dirty = false; void act(button.dataset.action); };
reload.onclick = () => { dirty = false; void act(loading ? 'stop' : 'reload'); };
api.onState(show);
api.onFocusAddress(() => { address.focus(); address.select(); });
void act('state');
