const media = document.getElementById('media');
const sendLinks = document.getElementById('send-links');
const status = document.getElementById('status');
let page = null;
let tabUrl = '';

function shorten(url) {
  try {
    const parsed = new URL(url);
    const name = decodeURIComponent(parsed.pathname.split('/').pop() || parsed.host);
    return name || parsed.host;
  } catch {
    return url;
  }
}

function renderMedia() {
  const items = page?.media || [];
  if (!items.length) {
    media.innerHTML = '<div class="empty">No direct media found. Refresh the page if a video just started playing.</div>';
    return;
  }
  media.innerHTML = '';
  for (const url of items) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('span');
    label.textContent = shorten(url);
    label.title = url;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Send';
    button.addEventListener('click', async () => {
      button.disabled = true;
      const result = await chrome.runtime.sendMessage({ type: 'send', url, pageUrl: tabUrl, referrer: tabUrl, source: 'user' });
      button.textContent = result?.ok ? 'Sent' : 'Failed';
      if (!result?.ok) status.textContent = result?.error || 'Could not send';
    });
    row.append(label, button);
    media.append(row);
  }
}

sendLinks.addEventListener('click', async () => {
  sendLinks.disabled = true;
  const result = await chrome.runtime.sendMessage({
    type: 'batch',
    items: page?.files || [],
    pageUrl: tabUrl,
  });
  status.textContent = result?.ok ? `Sent ${result.added} file link${result.added === 1 ? '' : 's'}` : (result?.error || 'Could not send');
  sendLinks.disabled = false;
});

document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

async function init() {
  const reported = await chrome.runtime.sendMessage({ type: 'status' });
  if (reported?.ok) status.textContent = reported.status.active ? `${reported.status.active} downloading` : 'Connected';
  else if (!reported?.paired) status.textContent = 'Paste the pairing token';
  else status.textContent = 'Open the ApexDM app';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  tabUrl = tab.url || '';
  try {
    page = await chrome.tabs.sendMessage(tab.id, { type: 'collect' });
  } catch {
    page = { media: [], files: [] };
  }
  const count = page.files?.length || 0;
  sendLinks.disabled = count === 0;
  sendLinks.textContent = count ? `Send ${count} file link${count === 1 ? '' : 's'}` : 'No file links on this page';
  renderMedia();
}

init();
