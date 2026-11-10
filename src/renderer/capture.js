const { formatBytes } = ApexFormat;
const list = document.getElementById('list');
const note = document.getElementById('note');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

function render(state) {
  const seconds = state.settings?.captureTimeoutSec || 90;
  const waiting = (state.items || []).filter((item) => item.status === 'awaiting');
  note.textContent = waiting.length
    ? `The browser download stays paused until you choose. After ${seconds}s it continues in the browser.`
    : '';
  list.innerHTML = waiting.map((item) => `
    <article class="card" data-id="${esc(item.id)}">
      <div class="name">${esc(item.filename)}</div>
      <div class="meta">${esc(hostOf(item.url))}${item.size ? ` · ${esc(formatBytes(item.size))}` : ''}</div>
      <div class="actions">
        <button type="button" class="primary" data-act="accept">Download</button>
        <button type="button" data-act="reject">Leave in browser</button>
      </div>
    </article>
  `).join('');
}

list.addEventListener('click', (event) => {
  const button = event.target.closest('[data-act]');
  const card = event.target.closest('[data-id]');
  if (!button || !card) return;
  apex.action(button.dataset.act, card.dataset.id);
});

document.getElementById('hide').addEventListener('click', () => apex.action('hideCapture'));
apex.onState(render);
apex.getState().then(render);
