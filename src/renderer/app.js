const { formatBytes, formatSpeed, formatEta } = ApexFormat;

const STATUS = {
  awaiting: 'Waiting',
  downloading: 'Downloading',
  queued: 'Queued',
  paused: 'Paused',
  completed: 'Finished',
  error: 'Failed',
  cancelled: 'Cancelled',
};

const CATEGORY = {
  archives: 'Archives',
  programs: 'Programs',
  video: 'Video',
  music: 'Music',
  documents: 'Documents',
  images: 'Images',
  other: 'Other',
};

let state = null;
let view = 'all';
let selectedId = null;
let query = '';
let drawerSig = '';
let addDirectory = '';
let seenComplete = null;
let toastTimer = 0;
let dragDepth = 0;
let settingsNote = '';

const list = document.getElementById('list');
const drawer = document.getElementById('drawer');
const toolbar = document.getElementById('toolbar');
const viewLibrary = document.getElementById('view-library');
const viewBrowser = document.getElementById('view-browser');
const viewSettings = document.getElementById('view-settings');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

function sourceLabel(source) {
  if (source === 'clipboard') return 'Clipboard';
  if (source === 'batch') return 'Page grab';
  if (source === 'browser' || source === 'user') return 'Browser';
  return 'Added here';
}

function isLibrary(name) {
  return ['all', 'active', 'queued', 'done', 'failed'].includes(name) || String(name).startsWith('cat:');
}

function sizeLabel(item) {
  if (item.size) return `${formatBytes(item.downloaded)} / ${formatBytes(item.size)}`;
  if (item.downloaded) return formatBytes(item.downloaded);
  return 'Size unknown';
}

function percent(item) {
  if (item.status === 'completed') return '100%';
  if (!item.size) return '';
  const value = Math.max(0, Math.min(100, (item.downloaded / item.size) * 100));
  if (value > 0 && value < 10) return `${value.toFixed(1)}%`;
  return `${Math.floor(value)}%`;
}

function segBar(item) {
  if (!item.segments || !item.segments.length) {
    if (!item.size && item.status === 'downloading') return '<div class="segbar indet"></div>';
    const width = item.size ? Math.max(0, Math.min(100, (item.downloaded / item.size) * 100)) : 0;
    return `<div class="segbar"><div class="seg"><div class="seg-fill${width >= 100 ? ' done' : ''}" style="width:${width}%"></div></div></div>`;
  }
  const total = item.segments.reduce((sum, seg) => sum + Math.max(1, seg.end - seg.start + 1), 0) || 1;
  return `<div class="segbar">${item.segments.map((seg) => {
    const len = Math.max(1, seg.end - seg.start + 1);
    const fill = Math.max(0, Math.min(100, (seg.received / len) * 100));
    return `<div class="seg" style="width:${(len / total) * 100}%"><div class="seg-fill${fill >= 100 ? ' done' : ''}" style="width:${fill}%"></div></div>`;
  }).join('')}</div>`;
}

function counts(items) {
  const tally = { all: 0, active: 0, queued: 0, done: 0, failed: 0, cats: {} };
  for (const item of items) {
    if (item.status !== 'cancelled') tally.all += 1;
    if (['downloading', 'paused', 'awaiting'].includes(item.status)) tally.active += 1;
    if (item.status === 'queued') tally.queued += 1;
    if (item.status === 'completed') tally.done += 1;
    if (item.status === 'error' || item.status === 'cancelled') tally.failed += 1;
    if (item.status !== 'cancelled') tally.cats[item.category] = (tally.cats[item.category] || 0) + 1;
  }
  return tally;
}

function filteredItems() {
  const rank = { awaiting: 0, downloading: 1, queued: 2, paused: 3, error: 4, completed: 5, cancelled: 6 };
  return state.items.filter((item) => {
    if (view === 'all') return item.status !== 'cancelled';
    if (view === 'active') return ['downloading', 'paused', 'awaiting'].includes(item.status);
    if (view === 'queued') return item.status === 'queued';
    if (view === 'done') return item.status === 'completed';
    if (view === 'failed') return item.status === 'error' || item.status === 'cancelled';
    if (view.startsWith('cat:')) return item.category === view.slice(4) && item.status !== 'cancelled';
    return false;
  }).filter((item) => {
    if (!query) return true;
    const hay = `${item.filename} ${item.url}`.toLowerCase();
    return hay.includes(query.toLowerCase());
  }).sort((a, b) => {
    if (a.status === 'queued' && b.status === 'queued') return (b.priority - a.priority) || (a.createdAt - b.createdAt);
    return (rank[a.status] - rank[b.status]) || (b.createdAt - a.createdAt);
  });
}

function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3600);
}

function chime() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.04, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.24);
  } catch { /* sound can stay silent */ }
}

function watchComplete(items) {
  const done = new Set(items.filter((item) => item.status === 'completed').map((item) => item.id));
  if (!seenComplete) {
    seenComplete = done;
    return;
  }
  if (state.settings.sound) {
    for (const id of done) if (!seenComplete.has(id)) chime();
  }
  seenComplete = done;
}

function drawSpark(samples) {
  const canvas = document.getElementById('spark');
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  const series = samples.length ? samples : [0];
  const max = Math.max(1, ...series);
  ctx.beginPath();
  series.forEach((value, index) => {
    const x = series.length === 1 ? width / 2 : (index / (series.length - 1)) * (width - 4) + 2;
    const y = height - 4 - (value / max) * (height - 10);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#ffb020';
  ctx.lineWidth = 1.6;
  ctx.stroke();
}

function applyVisibility() {
  const libraryView = isLibrary(view);
  viewLibrary.hidden = !libraryView;
  toolbar.hidden = !libraryView;
  viewBrowser.hidden = view !== 'browser';
  viewSettings.hidden = view !== 'settings';
}

function renderChrome() {
  document.getElementById('speed').textContent = formatSpeed(state.speed);
  drawSpark(state.samples || []);
  const tally = counts(state.items);
  document.querySelectorAll('#nav [data-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view);
    const span = button.querySelector('span');
    if (!span || !button.dataset.count) return;
    const key = button.dataset.count;
    const value = key.startsWith('cat:') ? (tally.cats[key.slice(4)] || 0) : (tally[key] || 0);
    span.textContent = value ? String(value) : '';
  });
  const active = state.items.filter((item) => item.status === 'downloading').length;
  const bits = [];
  if (state.holding) bits.push('Schedule is holding the queue');
  bits.push(`${active} active`);
  bits.push(formatSpeed(state.speed));
  if (state.diskFree != null) bits.push(`${formatBytes(state.diskFree)} free`);
  document.getElementById('foot-left').textContent = bits.join('   ·   ');
  const seen = state.extensionLastSeen;
  let extension = 'Extension not connected';
  if (seen && Date.now() - seen < 20000) extension = 'Extension connected';
  else if (seen && Date.now() - seen < 120000) extension = 'Extension seen recently';
  document.getElementById('foot-right').textContent = `Port ${state.port}   ·   ${extension}`;
  const shown = isLibrary(view) ? filteredItems().length : 0;
  document.getElementById('summary').textContent = isLibrary(view) ? `${shown} shown` : '';
}

function renderList(items) {
  if (!items.length) {
    list.innerHTML = `<div class="empty">
      <svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#ffb020"/><path d="M16 7v12M11 15l5 6 5-6M9 25h14" fill="none" stroke="#1a1203" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <h2>Nothing in this view</h2>
      <p>Add a link, drop one here, or let the browser extension send the file across.</p>
    </div>`;
    return;
  }
  const rows = items.map((item) => {
    const wait = item.status === 'awaiting'
      ? `<div class="row-actions"><button type="button" data-act="accept">Download</button><button type="button" data-act="reject">Ignore</button></div>`
      : `<span class="pill ${esc(item.status)}">${STATUS[item.status] || esc(item.status)}</span>`;
    return `<div class="row item${item.id === selectedId ? ' selected' : ''}" data-id="${esc(item.id)}" data-status="${esc(item.status)}" role="button" tabindex="0">
      <span class="cell-name">
        <span class="name-row"><span class="fname">${esc(item.filename)}</span><span class="pct">${esc(percent(item))}</span></span>
        <span class="meta">${esc(CATEGORY[item.category] || 'Other')} · ${esc(sourceLabel(item.source))} · ${esc(hostOf(item.url))}</span>
        ${segBar(item)}
      </span>
      <span class="mono col-size">${esc(sizeLabel(item))}</span>
      <span class="mono col-speed">${item.status === 'downloading' ? esc(formatSpeed(item.speed)) : '—'}</span>
      <span class="mono col-eta">${esc(formatEta(item))}</span>
      <span class="col-status">${wait}</span>
    </div>`;
  }).join('');
  list.innerHTML = `<div class="row head"><span>File</span><span class="col-size">Size</span><span class="col-speed">Speed</span><span class="col-eta">Left</span><span>Status</span></div>${rows}`;
}

function drawerSignature(item) {
  return [item.status, item.error, item.finalPath, item.scan, item.connections, item.priority, item.filename].join('|');
}

function drawerActions(item) {
  const map = {
    awaiting: [['accept', 'Download', 'primary'], ['reject', 'Ignore', '']],
    downloading: [['pause', 'Pause', ''], ['cancel', 'Cancel', 'danger']],
    queued: [['pause', 'Hold', ''], ['priority', 'Higher', '', 1], ['priority', 'Lower', '', -1], ['cancel', 'Cancel', 'danger']],
    paused: [['resume', 'Resume', 'primary'], ['priority', 'Higher', '', 1], ['priority', 'Lower', '', -1], ['cancel', 'Cancel', 'danger']],
    error: [['retry', 'Retry', 'primary'], ['remove', 'Remove', '']],
    completed: [['open', 'Open', 'primary'], ['reveal', 'Show in folder', ''], ['scan', 'Scan with Defender', ''], ['remove', 'Remove from list', ''], ['deleteFile', 'Delete file', 'danger']],
    cancelled: [['retry', 'Try again', 'primary'], ['remove', 'Remove', '']],
  };
  return (map[item.status] || map.cancelled).map(([act, label, kind, extra]) => (
    `<button type="button" class="${kind}" data-act="${act}" ${extra != null ? `data-extra="${extra}"` : ''}>${label}</button>`
  )).join('');
}

function scanLine(item) {
  if (item.scan === 'clean') return '<p class="clean">Defender found nothing.</p>';
  if (item.scan === 'threat') return '<p class="threat">Defender found a threat. Leave this file unopened.</p>';
  if (item.scan === 'scanning') return '<p>Scanning with Defender…</p>';
  if (item.scan === 'skipped') return '<p>Defender scan did not run.</p>';
  return '';
}

function renderDrawer(item) {
  const editable = ['error', 'paused', 'cancelled', 'queued', 'awaiting'].includes(item.status);
  drawer.innerHTML = `
    <h3>${esc(item.filename)}</h3>
    <div id="drawer-bar">${segBar(item)}</div>
    <div class="kv">
      <span>Status</span><strong>${esc(STATUS[item.status] || item.status)}</strong>
      <span>Progress</span><strong data-live="done">${esc(sizeLabel(item))}</strong>
      <span>Speed</span><strong data-live="speed">${esc(formatSpeed(item.speed))}</strong>
      <span>Left</span><strong data-live="eta">${esc(formatEta(item))}</strong>
      <span>Saved to</span><strong>${esc(item.directory)}</strong>
    </div>
    ${item.error ? `<p class="error-text">${esc(item.error)}</p>` : ''}
    ${scanLine(item)}
    <p class="url">${esc(item.url)}</p>
    ${item.hasCookies ? '<p>Browser session included.</p>' : ''}
    <div class="stepper">
      <button type="button" data-act="connections" data-extra="${Math.max(1, item.connections - 1)}">−</button>
      <span>${item.connections} connections</span>
      <button type="button" data-act="connections" data-extra="${Math.min(32, item.connections + 1)}">+</button>
    </div>
    <div class="drawer-actions">${drawerActions(item)}</div>
    ${editable ? `<label class="field">Replace link
      <input id="link-edit" type="url" value="${esc(item.url)}" />
    </label>
    <button type="button" data-act="save-url">Update link</button>` : ''}
    <p><button type="button" class="ghost" data-act="copy-url">Copy link</button>
    <button type="button" class="ghost" data-act="reveal">Show folder</button></p>
  `;
}

function patchDrawer(item) {
  const done = drawer.querySelector('[data-live="done"]');
  const speed = drawer.querySelector('[data-live="speed"]');
  const eta = drawer.querySelector('[data-live="eta"]');
  const bar = drawer.querySelector('#drawer-bar');
  if (done) done.textContent = sizeLabel(item);
  if (speed) speed.textContent = formatSpeed(item.speed);
  if (eta) eta.textContent = formatEta(item);
  if (bar) bar.innerHTML = segBar(item);
}

function renderLibrary() {
  const items = filteredItems();
  const selected = state.items.find((item) => item.id === selectedId);
  const visible = Boolean(selected && items.some((item) => item.id === selected.id));
  drawer.hidden = !visible;
  renderList(items);
  if (!visible) return;
  const sig = drawerSignature(selected);
  const editing = drawer.contains(document.activeElement);
  if (sig !== drawerSig && !editing) {
    drawerSig = sig;
    renderDrawer(selected);
  } else patchDrawer(selected);
}

function extensionSentence() {
  const seen = state.extensionLastSeen;
  if (!seen) return 'The extension has not connected yet.';
  const age = Date.now() - seen;
  if (age < 20000) return 'The extension is connected.';
  if (age < 120000) return 'The extension connected recently.';
  return 'The extension has been quiet. Open it once to refresh the link.';
}

function buildBrowser() {
  const settings = state.settings;
  viewBrowser.innerHTML = `
    <h2>Browser integration</h2>
    <p class="lead" id="ext-status">${esc(extensionSentence())}</p>
    <p class="lead">ApexDM takes the real file behind a normal download: the link, the site cookie, and the browser’s own identity. Streaming sites that wrap video in a private player stay in the browser.</p>
    <div class="token">
      <code id="token-value">${esc(settings.token)}</code>
      <button type="button" id="copy-token">Copy token</button>
    </div>
    <p>Port <strong id="port-value">${esc(String(state.port))}</strong>. The token pairs this app with the extension. Keep it on this computer.</p>
    <p>
      <button type="button" id="open-ext">Open extension folder</button>
      <button type="button" id="regen-token">Regenerate token</button>
    </p>
    <h3>Install the extension</h3>
    <ol class="steps">
      <li>Open <strong>chrome://extensions</strong> or <strong>edge://extensions</strong>.</li>
      <li>Turn on Developer mode.</li>
      <li>Choose Load unpacked and select the ApexDM extension folder.</li>
      <li>Open the extension’s options and paste the token.</li>
      <li>Use Test connection. After that, file downloads can be caught and sent here.</li>
    </ol>
  `;
  viewBrowser.querySelector('#copy-token').addEventListener('click', async () => {
    await apex.copy(state.settings.token);
    toast('Pairing token copied');
  });
  viewBrowser.querySelector('#open-ext').addEventListener('click', () => apex.action('openExtension'));
  viewBrowser.querySelector('#regen-token').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (button.dataset.armed !== '1') {
      button.dataset.armed = '1';
      button.textContent = 'Confirm regenerate';
      return;
    }
    const result = await apex.action('regenerateToken');
    if (!result.ok) toast(result.error);
    else toast('New token ready. Paste it into the extension.');
  });
  viewBrowser.dataset.built = '1';
}

function patchBrowser() {
  if (viewBrowser.dataset.built !== '1') return;
  const status = viewBrowser.querySelector('#ext-status');
  const token = viewBrowser.querySelector('#token-value');
  const port = viewBrowser.querySelector('#port-value');
  if (status) status.textContent = extensionSentence();
  if (token && token.textContent !== state.settings.token) token.textContent = state.settings.token;
  if (port) port.textContent = String(state.port);
}

function buildSettings() {
  const settings = state.settings;
  const schedule = settings.schedule || {};
  const days = new Set(schedule.days || []);
  const limits = [0, 262144, 524288, 1048576, 2097152, 5242880, 10485760];
  const labels = ['Unlimited', '256 KB/s', '512 KB/s', '1 MB/s', '2 MB/s', '5 MB/s', '10 MB/s'];
  const current = Number(settings.speedLimitBps) || 0;
  if (!limits.includes(current)) {
    limits.push(current);
    labels.push(`${formatSpeed(current)} custom`);
  }
  const dayNames = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  viewSettings.innerHTML = `
    <h2>Settings</h2>
    <div class="settings-grid">
      <label class="field">Download folder
        <span class="inline"><input id="set-dir" type="text" value="${esc(settings.downloadDir)}" /><button type="button" id="set-browse">Browse</button></span>
      </label>
      <label class="field">Active downloads at once
        <input id="set-active" type="number" min="1" max="8" value="${esc(settings.maxActive)}" />
      </label>
      <label class="field">Connections per file
        <input id="set-conn" type="number" min="1" max="32" value="${esc(settings.connections)}" />
      </label>
      <label class="field">Speed limit
        <select id="set-limit">${limits.map((value, index) => `<option value="${value}" ${value === current ? 'selected' : ''}>${labels[index]}</option>`).join('')}</select>
      </label>
      <label class="checkline"><input id="set-dynamic" type="checkbox" ${settings.dynamicSplit ? 'checked' : ''}/> Give finished connections more of a slow file</label>
      <label class="checkline"><input id="set-resume" type="checkbox" ${settings.resumeOnLaunch ? 'checked' : ''}/> Continue unfinished downloads when ApexDM opens</label>
      <label class="checkline"><input id="set-ask" type="checkbox" ${settings.confirmCapture ? 'checked' : ''}/> Ask before taking a browser download</label>
      <label class="field">If nobody answers, after
        <span class="inline"><input id="set-timeout" type="number" min="15" max="600" value="${esc(settings.captureTimeoutSec)}" /> seconds
          <select id="set-timeout-action">
            <option value="browser" ${settings.captureTimeoutAction !== 'download' ? 'selected' : ''}>leave it in the browser</option>
            <option value="download" ${settings.captureTimeoutAction === 'download' ? 'selected' : ''}>download it here</option>
          </select>
        </span>
      </label>
      <label class="checkline"><input id="set-clip" type="checkbox" ${settings.clipboardWatch ? 'checked' : ''}/> Watch the clipboard for file links</label>
      <label class="checkline"><input id="set-clip-files" type="checkbox" ${settings.clipboardFilesOnly ? 'checked' : ''}/> Only clipboard links that look like files</label>
      <label class="checkline"><input id="set-clip-ask" type="checkbox" ${settings.clipboardConfirm ? 'checked' : ''}/> Ask before a clipboard download starts</label>
      <label class="checkline"><input id="set-notify" type="checkbox" ${settings.notify ? 'checked' : ''}/> Notify when a download finishes</label>
      <label class="checkline"><input id="set-sound" type="checkbox" ${settings.sound ? 'checked' : ''}/> Play a short tone when a download finishes</label>
      <label class="checkline"><input id="set-scan" type="checkbox" ${settings.scanPrograms ? 'checked' : ''}/> Scan finished programs with Microsoft Defender</label>
      <h3>Schedule</h3>
      <label class="checkline"><input id="set-sched" type="checkbox" ${schedule.enabled ? 'checked' : ''}/> Only download during this window</label>
      <div class="inline">
        <input id="set-start" type="time" value="${esc(schedule.start || '01:00')}" />
        <span>to</span>
        <input id="set-end" type="time" value="${esc(schedule.end || '07:00')}" />
      </div>
      <div class="days">${dayNames.map((name, index) => `<label>${name}<input data-day="${index}" type="checkbox" ${days.has(index) ? 'checked' : ''}/></label>`).join('')}</div>
      <label class="field">Integration port
        <input id="set-port" type="number" min="1024" max="65535" value="${esc(settings.port)}" />
      </label>
      <p id="set-note">${esc(settingsNote)}</p>
      <p><button type="button" id="set-export">Export list</button></p>
      <p class="lead">Closing the window keeps ApexDM in the tray. Quit from the tray icon, or press Ctrl+Q.</p>
    </div>
  `;
  viewSettings.querySelector('#set-browse').addEventListener('click', async () => {
    const folder = await apex.chooseFolder();
    if (!folder) return;
    viewSettings.querySelector('#set-dir').value = folder;
    commitSettings();
  });
  viewSettings.querySelector('#set-export').addEventListener('click', () => apex.action('export'));
  viewSettings.querySelector('.settings-grid').addEventListener('change', commitSettings);
}

async function commitSettings() {
  const root = viewSettings;
  const days = [...root.querySelectorAll('[data-day]')].filter((box) => box.checked).map((box) => Number(box.dataset.day));
  const result = await apex.saveSettings({
    downloadDir: root.querySelector('#set-dir').value,
    maxActive: Number(root.querySelector('#set-active').value),
    connections: Number(root.querySelector('#set-conn').value),
    speedLimitBps: Number(root.querySelector('#set-limit').value),
    dynamicSplit: root.querySelector('#set-dynamic').checked,
    resumeOnLaunch: root.querySelector('#set-resume').checked,
    confirmCapture: root.querySelector('#set-ask').checked,
    captureTimeoutSec: Number(root.querySelector('#set-timeout').value),
    captureTimeoutAction: root.querySelector('#set-timeout-action').value,
    clipboardWatch: root.querySelector('#set-clip').checked,
    clipboardFilesOnly: root.querySelector('#set-clip-files').checked,
    clipboardConfirm: root.querySelector('#set-clip-ask').checked,
    notify: root.querySelector('#set-notify').checked,
    sound: root.querySelector('#set-sound').checked,
    scanPrograms: root.querySelector('#set-scan').checked,
    port: Number(root.querySelector('#set-port').value),
    schedule: {
      enabled: root.querySelector('#set-sched').checked,
      start: root.querySelector('#set-start').value,
      end: root.querySelector('#set-end').value,
      days,
    },
  });
  settingsNote = result.ok ? 'Saved' : result.error;
  const note = root.querySelector('#set-note');
  if (note) note.textContent = settingsNote;
}

function setView(next) {
  view = next;
  applyVisibility();
  if (view === 'settings') buildSettings();
  if (view === 'browser') buildBrowser();
  renderChrome();
  if (isLibrary(view)) renderLibrary();
}

function openModal(text) {
  const backdrop = document.getElementById('backdrop');
  backdrop.hidden = false;
  addDirectory = state.settings.downloadDir;
  document.getElementById('add-dir').textContent = addDirectory;
  document.getElementById('add-conn').value = state.settings.connections;
  document.getElementById('add-error').hidden = true;
  if (text) document.getElementById('add-urls').value = text;
  document.getElementById('add-urls').focus();
}

function closeModal() {
  document.getElementById('backdrop').hidden = true;
}

function render() {
  watchComplete(state.items);
  renderChrome();
  if (isLibrary(view)) renderLibrary();
  else if (view === 'browser') patchBrowser();
}

document.getElementById('nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (!button) return;
  setView(button.dataset.view);
});

document.getElementById('search').addEventListener('input', (event) => {
  query = event.target.value.trim();
  if (isLibrary(view)) renderLibrary();
  renderChrome();
});

document.getElementById('add-open').addEventListener('click', () => openModal());
document.getElementById('add-cancel').addEventListener('click', closeModal);
document.getElementById('backdrop').addEventListener('click', (event) => {
  if (event.target.id === 'backdrop') closeModal();
});
document.getElementById('pause-all').addEventListener('click', () => apex.action('pauseAll'));
document.getElementById('resume-all').addEventListener('click', () => apex.action('resumeAll'));
document.getElementById('add-browse').addEventListener('click', async () => {
  const folder = await apex.chooseFolder();
  if (!folder) return;
  addDirectory = folder;
  document.getElementById('add-dir').textContent = folder;
});

document.getElementById('add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.getElementById('add-error');
  const result = await apex.add({
    urls: document.getElementById('add-urls').value,
    filename: document.getElementById('add-name').value,
    category: document.getElementById('add-cat').value,
    connections: Number(document.getElementById('add-conn').value),
    startNow: document.getElementById('add-now').checked,
    directory: addDirectory,
  });
  if (!result.ok) {
    error.hidden = false;
    error.textContent = result.error;
    return;
  }
  closeModal();
  document.getElementById('add-urls').value = '';
  document.getElementById('add-name').value = '';
  if (result.errors && result.errors.length) toast(result.errors[0]);
  else toast(result.count === 1 ? 'Download added' : `${result.count} downloads added`);
  if (!isLibrary(view)) setView('all');
});

list.addEventListener('click', (event) => {
  const button = event.target.closest('[data-act]');
  const row = event.target.closest('[data-id]');
  if (!row) return;
  selectedId = row.dataset.id;
  if (button) {
    event.stopPropagation();
    apex.action(button.dataset.act, row.dataset.id);
  }
  renderLibrary();
});

list.addEventListener('dblclick', (event) => {
  const row = event.target.closest('[data-id]');
  if (!row) return;
  const item = state.items.find((entry) => entry.id === row.dataset.id);
  if (item && item.status === 'completed') apex.action('open', item.id);
});

drawer.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-act]');
  if (!button || !selectedId) return;
  const act = button.dataset.act;
  if (act === 'copy-url') {
    const item = state.items.find((entry) => entry.id === selectedId);
    if (item) {
      await apex.copy(item.url);
      toast('Link copied');
    }
    return;
  }
  if (act === 'save-url') {
    const input = drawer.querySelector('#link-edit');
    const result = await apex.action('updateUrl', selectedId, input ? input.value : '');
    if (!result.ok) toast(result.error);
    return;
  }
  if ((act === 'deleteFile' || act === 'remove') && button.dataset.armed !== '1') {
    button.dataset.armed = '1';
    button.textContent = act === 'deleteFile' ? 'Confirm delete' : 'Confirm remove';
    return;
  }
  const extra = button.dataset.extra != null ? Number(button.dataset.extra) : undefined;
  const result = await apex.action(act, selectedId, extra);
  if (!result.ok) toast(result.error);
});

document.addEventListener('keydown', (event) => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    openModal();
  } else if (event.key === 'Escape') closeModal();
  else if (event.key === 'Delete' && selectedId && !typing) {
    apex.action('remove', selectedId);
  }
});

document.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth += 1;
  document.body.classList.add('drag');
});
document.addEventListener('dragleave', () => {
  dragDepth -= 1;
  if (dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('drag');
  }
});
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('drag');
  const text = `${event.dataTransfer.getData('text/uri-list')}\n${event.dataTransfer.getData('text/plain')}`;
  const links = text.split(/\s+/).filter((line) => /^https?:\/\//i.test(line));
  if (links.length) openModal(links.join('\n'));
});

apex.onShortcut((name) => {
  if (name === 'add') openModal();
});

apex.onState((next) => {
  state = next;
  render();
});

apex.getState().then((next) => {
  state = next;
  setView('all');
});
