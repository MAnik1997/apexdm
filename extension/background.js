const EXT_DEFAULTS = {
  port: 17633,
  token: '',
  captureMode: 'smart',
  largeFileBytes: 2 * 1024 * 1024,
  extensions: [
    'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'iso',
    'exe', 'msi', 'msix', 'apk', 'dmg', 'deb', 'rpm',
    'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg',
    'mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a', 'wma', 'opus',
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'epub',
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'psd', 'bin',
  ],
};

const handled = new Set();

function loadSettings() {
  return chrome.storage.local.get(EXT_DEFAULTS).then((stored) => ({
    ...EXT_DEFAULTS,
    ...stored,
    extensions: Array.isArray(stored.extensions) && stored.extensions.length ? stored.extensions : EXT_DEFAULTS.extensions,
  }));
}

function baseName(filename) {
  if (!filename) return '';
  const parts = String(filename).split(/[/\\]/);
  return parts[parts.length - 1];
}

function extensionOf(item) {
  const name = baseName(item.filename || '');
  const fromName = name.match(/\.([a-z0-9]{1,8})$/i);
  if (fromName) return fromName[1].toLowerCase();
  try {
    const match = new URL(item.finalUrl || item.url).pathname.match(/\.([a-z0-9]{1,8})$/i);
    return match ? match[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

function shouldAutoCapture(item, settings) {
  if (!settings.token || settings.captureMode === 'off') return false;
  const url = item.finalUrl || item.url || '';
  if (!/^https?:/i.test(url)) return false;
  const mime = String(item.mime || '').toLowerCase();
  if (mime.startsWith('text/html') || mime.includes('javascript') || mime === 'text/css') return false;
  if (settings.captureMode === 'all') return true;
  const ext = extensionOf(item);
  if (ext && settings.extensions.includes(ext)) return true;
  return Number(item.totalBytes) >= Number(settings.largeFileBytes) && Number(item.totalBytes) > 0;
}

async function cookieHeader(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  } catch {
    return '';
  }
}

async function api(settings, pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${settings.port}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Apex-Token': settings.token || '',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeout || 8000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `ApexDM returned ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function appUp(settings) {
  try {
    const response = await fetch(`http://127.0.0.1:${settings.port}/v1/health`, { signal: AbortSignal.timeout(700) });
    return response.ok;
  } catch {
    return false;
  }
}

function notify(message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/128.png',
    title: 'ApexDM',
    message,
  });
}

async function remember(downloadId, captureId) {
  const { pending = {} } = await chrome.storage.session.get('pending');
  pending[downloadId] = { captureId, at: Date.now() };
  await chrome.storage.session.set({ pending });
}

async function forget(downloadId) {
  const { pending = {} } = await chrome.storage.session.get('pending');
  delete pending[downloadId];
  await chrome.storage.session.set({ pending });
}

async function cancelBrowser(id) {
  try { await chrome.downloads.cancel(id); } catch { /* already finished */ }
  try { await chrome.downloads.erase({ id }); } catch { /* already gone */ }
}

async function resumeBrowser(id) {
  try {
    const [item] = await chrome.downloads.search({ id });
    if (item && item.state === 'in_progress' && item.paused) await chrome.downloads.resume(id);
  } catch { /* the browser kept it */ }
}

async function pollDecision(settings, id) {
  for (let i = 0; i < 220; i += 1) {
    const data = await api(settings, `/v1/capture/${encodeURIComponent(id)}`, { timeout: 4000 });
    if (data.decision && data.decision !== 'pending') return data.decision;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return 'reject';
}

async function payloadFor(url, extra) {
  return {
    url,
    filename: extra.filename || '',
    referrer: extra.referrer || extra.pageUrl || '',
    pageUrl: extra.pageUrl || '',
    cookies: await cookieHeader(url),
    userAgent: navigator.userAgent,
    mime: extra.mime || '',
    totalBytes: extra.totalBytes || 0,
    source: extra.source || 'user',
  };
}

async function sendUser(url, extra) {
  const settings = await loadSettings();
  if (!settings.token) throw new Error('Paste the ApexDM pairing token in the extension options.');
  if (!await appUp(settings)) throw new Error('ApexDM is not running.');
  const body = await payloadFor(url, extra);
  const data = await api(settings, '/v1/capture', { method: 'POST', body });
  if (data.decision === 'pending') return pollDecision(settings, data.id);
  return data.decision;
}

async function queueCapture(item) {
  const settings = await loadSettings();
  if (!shouldAutoCapture(item, settings)) {
    handled.delete(item.id);
    return;
  }
  let paused = false;
  try {
    if (!await appUp(settings)) {
      handled.delete(item.id);
      return;
    }
    await chrome.downloads.pause(item.id);
    paused = true;
    const [fresh] = await chrome.downloads.search({ id: item.id });
    if (!fresh || fresh.state !== 'in_progress') {
      handled.delete(item.id);
      return;
    }
    const body = await payloadFor(fresh.finalUrl || fresh.url, {
      filename: baseName(fresh.filename),
      referrer: fresh.referrer,
      mime: fresh.mime,
      totalBytes: fresh.totalBytes,
      source: 'browser',
    });
    const data = await api(settings, '/v1/capture', { method: 'POST', body });
    await remember(item.id, data.id);
    const decision = data.decision === 'pending' ? await pollDecision(settings, data.id) : data.decision;
    if (decision === 'accept') await cancelBrowser(item.id);
    else if (paused) await resumeBrowser(item.id);
    await forget(item.id);
  } catch {
    if (paused) await resumeBrowser(item.id);
    await forget(item.id);
    handled.delete(item.id);
  }
}

function consider(item) {
  if (!item || item.byExtensionId || handled.has(item.id)) return;
  handled.add(item.id);
  queueCapture(item);
}

async function recover() {
  const { pending = {} } = await chrome.storage.session.get('pending');
  const settings = await loadSettings();
  if (!settings.token) return;
  for (const [downloadId, info] of Object.entries(pending)) {
    try {
      const data = await api(settings, `/v1/capture/${encodeURIComponent(info.captureId)}`, { timeout: 4000 });
      const id = Number(downloadId);
      if (data.decision === 'accept') {
        await cancelBrowser(id);
        await forget(id);
      } else if (data.decision === 'reject' || Date.now() - info.at > 120000) {
        await resumeBrowser(id);
        await forget(id);
      }
    } catch {
      await resumeBrowser(Number(downloadId));
      await forget(downloadId);
    }
  }
}

async function refreshBadge() {
  const settings = await loadSettings();
  if (!settings.token) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#ff5d6c' });
    await chrome.action.setTitle({ title: 'ApexDM — paste the pairing token in extension options' });
    return;
  }
  try {
    const status = await api(settings, '/v1/status', { timeout: 2500 });
    const text = status.active ? String(status.active) : '';
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: '#ffb020' });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#1a1203' });
    await chrome.action.setTitle({ title: status.active ? `ApexDM — ${status.active} downloading` : 'ApexDM' });
  } catch {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'ApexDM — open the desktop app' });
  }
}

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'apex-link', title: 'Download link with ApexDM', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'apex-media', title: 'Download media with ApexDM', contexts: ['video', 'audio', 'image'] });
    chrome.contextMenus.create({ id: 'apex-page', title: 'Send file links on this page to ApexDM', contexts: ['page'] });
  });
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  suggest();
  consider(item);
});

chrome.downloads.onCreated.addListener((item) => consider(item));

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === 'apex-link' && info.linkUrl) {
      await sendUser(info.linkUrl, { referrer: info.pageUrl, pageUrl: info.pageUrl, source: 'user' });
      return;
    }
    if (info.menuItemId === 'apex-media' && info.srcUrl) {
      await sendUser(info.srcUrl, { referrer: info.pageUrl, pageUrl: info.pageUrl, source: 'user' });
      return;
    }
    if (info.menuItemId === 'apex-page' && tab?.id) {
      const collected = await chrome.tabs.sendMessage(tab.id, { type: 'collect' });
      const settings = await loadSettings();
      const items = [];
      for (const file of collected?.files || []) {
        items.push({ ...(await payloadFor(file.url, { referrer: tab.url, pageUrl: tab.url })), source: 'batch' });
      }
      if (!items.length) {
        notify('No file links were found on this page. Refresh the page and try again.');
        return;
      }
      const result = await api(settings, '/v1/batch', { method: 'POST', body: { items }, timeout: 20000 });
      notify(`Sent ${result.added} link${result.added === 1 ? '' : 's'} to ApexDM.`);
    }
  } catch (error) {
    notify(error.message || 'ApexDM could not take that download.');
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return undefined;
  if (message.type === 'send') {
    sendUser(message.url, message).then((decision) => sendResponse({ ok: true, decision })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'batch') {
    (async () => {
      const settings = await loadSettings();
      const items = [];
      for (const entry of message.items || []) {
        items.push(await payloadFor(entry.url, { ...entry, source: 'batch', pageUrl: message.pageUrl, referrer: message.pageUrl }));
      }
      const result = await api(settings, '/v1/batch', { method: 'POST', body: { items }, timeout: 20000 });
      return result;
    })().then((result) => sendResponse({ ok: true, ...result })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'status') {
    refreshBadge().then(async () => {
      const settings = await loadSettings();
      try {
        const status = await api(settings, '/v1/status', { timeout: 2500 });
        sendResponse({ ok: true, status, paired: true });
      } catch (error) {
        sendResponse({ ok: false, error: error.message, paired: Boolean(settings.token), code: error.status || 0 });
      }
    });
    return true;
  }
  return undefined;
});

chrome.runtime.onInstalled.addListener(() => {
  setupMenus();
  chrome.alarms.create('apex', { periodInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener(() => {
  recover();
  refreshBadge();
});
setupMenus();
chrome.alarms.create('apex', { periodInMinutes: 1 });
recover();
refreshBadge();
