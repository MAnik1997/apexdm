const token = document.getElementById('token');
const port = document.getElementById('port');
const mode = document.getElementById('mode');
const large = document.getElementById('large');
const extensions = document.getElementById('extensions');
const note = document.getElementById('note');

const DEFAULT_EXTENSIONS = 'zip, rar, 7z, exe, msi, apk, mp4, mkv, webm, mp3, flac, pdf, doc, docx, iso, jpg, png';
const defaults = {
  port: 17633,
  token: '',
  captureMode: 'smart',
  largeFileBytes: 2 * 1024 * 1024,
  extensions: [],
};

async function load() {
  const stored = await chrome.storage.local.get(defaults);
  token.value = stored.token || '';
  port.value = stored.port || 17633;
  mode.value = stored.captureMode || 'smart';
  large.value = Math.max(1, Math.round((stored.largeFileBytes || defaults.largeFileBytes) / (1024 * 1024)));
  extensions.value = (stored.extensions || []).join(', ') || DEFAULT_EXTENSIONS;
}

async function save() {
  const list = extensions.value.split(/[\s,]+/).map((item) => item.trim().replace(/^\./, '').toLowerCase()).filter(Boolean);
  await chrome.storage.local.set({
    token: token.value.trim(),
    port: Math.min(65535, Math.max(1024, Number(port.value) || 17633)),
    captureMode: mode.value,
    largeFileBytes: Math.max(1, Number(large.value) || 2) * 1024 * 1024,
    extensions: list,
  });
  note.textContent = 'Saved';
}

document.getElementById('save').addEventListener('click', save);
document.getElementById('test').addEventListener('click', async () => {
  await save();
  const result = await chrome.runtime.sendMessage({ type: 'status' });
  if (result?.ok) note.textContent = 'Connected to ApexDM.';
  else if (!result?.paired) note.textContent = 'Paste the token from the ApexDM window first.';
  else note.textContent = result?.error || 'ApexDM is not running.';
});

load();
