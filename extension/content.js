const MEDIA = /\.(mp4|mkv|webm|mov|m4v|mp3|m4a|flac|wav|aac|ogg)(?:$|[?#])/i;
const FILES = /\.(zip|rar|7z|tar|gz|bz2|xz|tgz|iso|exe|msi|msix|apk|dmg|mp4|mkv|avi|mov|webm|flv|wmv|m4v|mp3|flac|wav|aac|pdf|docx?|xlsx?|pptx?|epub)(?:$|[?#])/i;

function collect() {
  const media = new Set();
  const files = [];
  const seen = new Set();
  const addMedia = (url) => {
    if (url && /^https?:/i.test(url)) media.add(url);
  };
  for (const el of document.querySelectorAll('video, audio, source')) addMedia(el.currentSrc || el.src);
  for (const entry of performance.getEntriesByType('resource')) {
    if (MEDIA.test(entry.name)) addMedia(entry.name);
  }
  for (const link of document.querySelectorAll('a[href]')) {
    const href = link.href;
    if (!/^https?:/i.test(href)) continue;
    if (MEDIA.test(href)) addMedia(href);
    if (FILES.test(href) && !seen.has(href)) {
      seen.add(href);
      files.push({ url: href, text: (link.textContent || '').trim().slice(0, 140) });
    }
  }
  return {
    media: [...media].slice(0, 40),
    files: files.slice(0, 200),
    page: location.href,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'collect') sendResponse(collect());
});
