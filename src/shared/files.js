const path = require('path');

const CATEGORIES = [
  ['archives', 'Archives', ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'iso']],
  ['programs', 'Programs', ['exe', 'msi', 'msix', 'apk', 'dmg', 'deb', 'rpm']],
  ['video', 'Video', ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts']],
  ['music', 'Music', ['mp3', 'flac', 'wav', 'aac', 'ogg', 'm4a', 'wma', 'opus']],
  ['documents', 'Documents', ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'epub', 'rtf']],
  ['images', 'Images', ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'avif', 'psd']],
];

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

function clamp(n, min, max) {
  const value = Number(n);
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function sanitizeFilename(name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  let base = path.posix.basename(normalized);
  base = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  base = base.replace(/[\u202A-\u202E\u2066-\u2069]/g, '');
  base = base.replace(/[. ]+$/g, '').trim();
  if (!base || base === '.' || base === '..') base = 'download';
  if (RESERVED.test(base)) base = `_${base}`;
  return base.slice(0, 180);
}

function filenameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const hinted = parsed.searchParams.get('filename') || parsed.searchParams.get('file') || '';
    if (hinted && /\.[a-z0-9]{1,8}$/i.test(hinted)) return sanitizeFilename(hinted);
    let base = path.posix.basename(parsed.pathname);
    if (!base || base === '/' || base === '.') return 'download';
    try { base = decodeURIComponent(base); } catch { /* keep the raw name */ }
    return sanitizeFilename(base);
  } catch {
    return 'download';
  }
}

function filenameFromDisposition(header) {
  if (!header) return '';
  const star = /filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;]+)/i.exec(header);
  if (star) {
    const raw = star[1].trim().replace(/^"(.*)"$/, '$1');
    try { return sanitizeFilename(decodeURIComponent(raw)); } catch { return sanitizeFilename(raw); }
  }
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(header);
  if (quoted) return sanitizeFilename(quoted[1]);
  const plain = /filename\s*=\s*([^;]+)/i.exec(header);
  if (plain) return sanitizeFilename(plain[1].trim().replace(/^"(.*)"$/, '$1'));
  return '';
}

function categoryFor(filename) {
  const ext = path.extname(String(filename || '')).slice(1).toLowerCase();
  for (const [id, , list] of CATEGORIES) {
    if (list.includes(ext)) return id;
  }
  return 'other';
}

function planSegments(size, connections, minSegment) {
  const total = Math.max(0, Number(size) || 0);
  if (total <= 1) {
    return [{ id: 1, start: 0, end: Math.max(0, total - 1), received: 0, done: total === 0 }];
  }
  const min = Math.max(1, minSegment || 1024 * 1024);
  let count = Math.max(1, connections | 0);
  count = Math.min(count, Math.max(1, Math.floor(total / min)));
  const base = Math.floor(total / count);
  const segments = [];
  let start = 0;
  for (let i = 0; i < count; i += 1) {
    const end = i === count - 1 ? total - 1 : start + base - 1;
    segments.push({ id: i + 1, start, end, received: 0, done: false });
    start = end + 1;
  }
  return segments;
}

function segmentRemaining(seg) {
  return seg.end - seg.start + 1 - (seg.received || 0);
}

function totalFromContentRange(header) {
  if (!header) return null;
  const match = /\/(\d+)\s*$/.exec(header);
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isFinite(total) ? total : null;
}

function assertHttpUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Enter a link.');
  if (raw.length > 8000) throw new Error('That link is too long.');
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('Enter a valid http or https link.'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https links can be downloaded.');
  }
  return parsed.toString();
}

module.exports = {
  CATEGORIES,
  clamp,
  sanitizeFilename,
  filenameFromUrl,
  filenameFromDisposition,
  categoryFor,
  planSegments,
  segmentRemaining,
  totalFromContentRange,
  assertHttpUrl,
};
