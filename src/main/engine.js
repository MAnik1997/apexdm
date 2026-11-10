const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  clamp,
  sanitizeFilename,
  filenameFromUrl,
  filenameFromDisposition,
  categoryFor,
  planSegments,
  segmentRemaining,
  totalFromContentRange,
  assertHttpUrl,
} = require('../shared/files');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMutex() {
  let chain = Promise.resolve();
  return function run(fn) {
    const next = chain.then(() => fn());
    chain = next.then(() => {}, () => {});
    return next;
  };
}

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

function lengthOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function cleanEtag(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text || text.startsWith('W/')) return null;
  return text;
}

function httpError(code) {
  const messages = {
    401: 'Sign-in required (401). Capture the file from the browser so the session is included.',
    403: 'Access denied (403). The link may have expired.',
    404: 'File not found (404).',
    407: 'The proxy asked for a username and password (407).',
    416: 'The server rejected the resume range (416).',
    429: 'The server asked to slow down (429).',
  };
  const error = new Error(messages[code] || `The server returned HTTP ${code}.`);
  error.statusCode = code;
  error.fatal = code >= 400 && code < 500 && code !== 408 && code !== 429;
  return error;
}

function isRetryable(error) {
  if (!error || error.fatal || error.fallback || error.name === 'AbortError') return false;
  if ([408, 429, 500, 502, 503, 504].includes(error.statusCode)) return true;
  if (['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'ECONNABORTED', 'ENOTFOUND'].includes(error.code)) return true;
  return /stalled|closed early|socket hang up/i.test(error.message || '');
}

async function writeAt(fh, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await fh.write(buffer, offset, buffer.length - offset, position + offset);
    if (bytesWritten <= 0) throw Object.assign(new Error('Could not write the file to disk.'), { code: 'EIO' });
    offset += bytesWritten;
  }
}

async function exists(file) {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

async function drain(body) {
  if (!body) return;
  for await (const _chunk of body) { /* discard the probe byte */ }
}

function inWindow(schedule, date) {
  const days = schedule.days || [];
  if (days.length && !days.includes(date.getDay())) return false;
  const [startHour, startMinute] = String(schedule.start || '00:00').split(':').map(Number);
  const [endHour, endMinute] = String(schedule.end || '00:00').split(':').map(Number);
  const current = date.getHours() * 60 + date.getMinutes();
  const start = (startHour * 60) + startMinute;
  const end = (endHour * 60) + endMinute;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return true;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

class DownloadEngine {
  constructor({ library, transport, onChange, onComplete, onLog }) {
    this.library = library;
    this.transport = transport;
    this.onChange = onChange;
    this.onComplete = onComplete;
    this.onLog = onLog;
    this.runtime = new Map();
    this.timer = null;
    this.stopped = false;
    this.holding = false;
    this.dirty = false;
    this.progressDirty = false;
    this.globalSpeed = 0;
    this.samples = [];
    this.bytesSinceSample = 0;
    this.sampleAt = Date.now();
    this.lastPersist = 0;
    this.tokens = 0;
    this.tokensAt = Date.now();
    this.limitLock = createMutex();
  }

  settings() {
    return this.library.settings;
  }

  start(ms = 200) {
    clearInterval(this.timer);
    this.stopped = false;
    this.timer = setInterval(() => this.tick(), ms);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  mark() {
    this.dirty = true;
    this.persistNow();
    if (this.onChange) this.onChange();
  }

  persistNow() {
    this.library.save();
    this.lastPersist = Date.now();
  }

  takeDirty() {
    const dirty = this.dirty || this.progressDirty;
    this.dirty = false;
    this.progressDirty = false;
    return dirty;
  }

  hasActive() {
    return this.library.items.some((item) => item.status === 'downloading');
  }

  must(id) {
    const item = this.library.items.find((entry) => entry.id === id);
    if (!item) throw new Error('That download is no longer in the list.');
    return item;
  }

  createRuntime() {
    let finish = () => {};
    const runtime = {
      abort: new AbortController(),
      fh: null,
      lock: createMutex(),
      active: new Set(),
      workerPromises: [],
      running: true,
      bucket: 0,
      bucketAt: Date.now(),
      usedFallback: false,
      restartSingle: false,
      done: null,
      finish: null,
    };
    runtime.done = new Promise((resolve) => { finish = resolve; });
    runtime.finish = finish;
    return runtime;
  }

  log(error) {
    if (this.onLog && error) this.onLog(error);
  }

  allocatePath(directory, filename, exceptId) {
    const root = path.resolve(directory);
    const safe = sanitizeFilename(filename);
    const ext = path.extname(safe);
    const stem = safe.slice(0, safe.length - ext.length) || 'download';
    const taken = new Set();
    for (const item of this.library.items) {
      if (item.id === exceptId) continue;
      if (item.finalPath) taken.add(path.normalize(item.finalPath).toLowerCase());
    }
    for (let i = 0; i < 10000; i += 1) {
      const name = i === 0 ? `${stem}${ext}` : `${stem} (${i})${ext}`;
      const candidate = path.resolve(root, name);
      const prefix = root.toLowerCase() + path.sep;
      if (!candidate.toLowerCase().startsWith(prefix)) throw new Error('That file name is not allowed.');
      if (taken.has(candidate.toLowerCase())) continue;
      if (fs.existsSync(candidate) || fs.existsSync(`${candidate}.apexpart`)) continue;
      return candidate;
    }
    throw new Error('Could not find a free file name.');
  }

  add(input) {
    const url = assertHttpUrl(input.url);
    const directory = input.directory || this.settings().downloadDir;
    if (!directory) throw new Error('Choose a download folder in Settings.');
    const nameLocked = Boolean(input.filename && String(input.filename).trim());
    const filename = nameLocked ? sanitizeFilename(input.filename) : filenameFromUrl(url);
    const finalPath = this.allocatePath(directory, filename, null);
    let status = 'queued';
    let pausedByUser = false;
    if (input.status === 'awaiting') status = 'awaiting';
    else if (input.startNow === false) {
      status = 'paused';
      pausedByUser = true;
    }
    const item = {
      id: uid(),
      url,
      finalUrl: null,
      filename: path.basename(finalPath),
      directory: path.resolve(directory),
      finalPath,
      partialPath: `${finalPath}.apexpart`,
      category: input.category && input.category !== 'auto' ? input.category : categoryFor(filename),
      categoryLocked: Boolean(input.category && input.category !== 'auto'),
      status,
      error: null,
      size: null,
      downloaded: 0,
      connections: clamp(input.connections ?? this.settings().connections, 1, 32),
      segments: [],
      nextSegId: 1,
      mode: null,
      etag: null,
      lastModified: null,
      mime: input.mime ? String(input.mime).slice(0, 120) : null,
      referrer: input.referrer ? String(input.referrer).slice(0, 2000) : null,
      cookies: input.cookies ? String(input.cookies).slice(0, 80000) : null,
      userAgent: input.userAgent ? String(input.userAgent).slice(0, 400) : null,
      source: String(input.source || 'manual').slice(0, 24),
      priority: clamp(input.priority || 0, -5, 5),
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      pausedByUser,
      pausedByScheduler: false,
      speed: 0,
      forceSingle: false,
      nameLocked,
      scan: null,
    };
    this.library.items.push(item);
    this.mark();
    return item;
  }

  addMany(input) {
    const lines = String(input.urls || input.url || '').split(/\s+/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) throw new Error('Paste at least one link.');
    const items = [];
    const errors = [];
    lines.forEach((url, index) => {
      try {
        items.push(this.add({
          url,
          filename: lines.length === 1 ? input.filename : '',
          directory: input.directory,
          category: input.category,
          connections: input.connections,
          startNow: input.startNow,
          source: input.source || 'manual',
        }));
      } catch (error) {
        errors.push(`Link ${index + 1}: ${error.message}`);
      }
    });
    if (!items.length) throw new Error(errors.join(' '));
    return { items, errors };
  }

  baseHeaders(item) {
    const headers = {
      'User-Agent': item.userAgent || DEFAULT_UA,
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    if (item.referrer) headers.Referer = item.referrer;
    if (item.cookies) headers.Cookie = item.cookies;
    return headers;
  }

  noteBytes(item, count) {
    this.bytesSinceSample += count;
    this.progressDirty = true;
    const runtime = this.runtime.get(item.id);
    if (!runtime) return;
    const now = Date.now();
    runtime.bucket += count;
    const elapsed = now - runtime.bucketAt;
    if (elapsed >= 400) {
      const instant = (runtime.bucket / elapsed) * 1000;
      item.speed = item.speed ? item.speed * 0.55 + instant * 0.45 : instant;
      runtime.bucket = 0;
      runtime.bucketAt = now;
    }
  }

  async throttle(count) {
    if (!this.settings().speedLimitBps || count <= 0) return;
    await this.limitLock(() => this.takeTokens(count));
  }

  async takeTokens(count) {
    let left = count;
    while (left > 0) {
      const rate = this.settings().speedLimitBps;
      if (!rate) return;
      const now = Date.now();
      const elapsed = (now - this.tokensAt) / 1000;
      this.tokens = Math.min(rate * 2, this.tokens + elapsed * rate);
      this.tokensAt = now;
      if (this.tokens >= left) {
        this.tokens -= left;
        return;
      }
      if (this.tokens > 0) {
        left -= this.tokens;
        this.tokens = 0;
      }
      await sleep(Math.min(100, Math.max(20, (left / rate) * 1000)));
    }
  }

  tick() {
    if (this.stopped) return;
    this.sampleSpeed();
    this.applySchedule();
    this.expireAwaiting();
    this.promoteQueue();
    if ((this.dirty || this.progressDirty) && Date.now() - this.lastPersist > 700) this.persistNow();
  }

  sampleSpeed() {
    const now = Date.now();
    const elapsed = now - this.sampleAt;
    if (elapsed < 1000) return;
    const instant = (this.bytesSinceSample / elapsed) * 1000;
    this.globalSpeed = this.hasActive() ? (this.globalSpeed ? this.globalSpeed * 0.45 + instant * 0.55 : instant) : 0;
    this.samples.push(Math.round(this.globalSpeed));
    if (this.samples.length > 60) this.samples.shift();
    this.bytesSinceSample = 0;
    this.sampleAt = now;
    for (const item of this.library.items) {
      if (item.status !== 'downloading') {
        item.speed = 0;
        continue;
      }
      const runtime = this.runtime.get(item.id);
      if (runtime && now - runtime.bucketAt > 1500 && !runtime.bucket) {
        item.speed *= 0.5;
        if (item.speed < 8) item.speed = 0;
      }
    }
    this.progressDirty = true;
  }

  applySchedule() {
    const schedule = this.settings().schedule;
    if (!schedule?.enabled) {
      this.holding = false;
      return;
    }
    const inside = inWindow(schedule, new Date());
    this.holding = !inside;
    if (!inside) {
      for (const item of this.library.items) this.holdItem(item);
    } else {
      for (const item of this.library.items) this.releaseItem(item);
    }
  }

  holdItem(item) {
    if (item.pausedByUser) return;
    if (item.status !== 'queued' && item.status !== 'downloading') return;
    item.pausedByScheduler = true;
    item.speed = 0;
    if (item.status === 'downloading') this.runtime.get(item.id)?.abort.abort();
    item.status = 'paused';
    this.dirty = true;
  }

  releaseItem(item) {
    if (item.status !== 'paused' || !item.pausedByScheduler || item.pausedByUser) return;
    if (this.runtime.get(item.id)?.running) return;
    item.pausedByScheduler = false;
    item.status = 'queued';
    this.dirty = true;
  }

  expireAwaiting() {
    const seconds = this.settings().captureTimeoutSec || 90;
    const action = this.settings().captureTimeoutAction || 'browser';
    const now = Date.now();
    let changed = false;
    for (const item of this.library.items) {
      if (item.status !== 'awaiting') continue;
      if (now - item.createdAt < seconds * 1000) continue;
      item.status = action === 'download' ? 'queued' : 'cancelled';
      changed = true;
    }
    if (changed) this.mark();
  }

  promoteQueue() {
    if (this.stopped || this.holding) return;
    const max = clamp(this.settings().maxActive, 1, 8);
    let active = this.library.items.filter((item) => item.status === 'downloading').length;
    const queued = this.library.items
      .filter((item) => item.status === 'queued')
      .sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt));
    for (const item of queued) {
      if (active >= max) break;
      this.begin(item);
      active += 1;
    }
  }

  begin(item) {
    if (item.status === 'downloading') return;
    if (this.runtime.get(item.id)?.running) return;
    item.status = 'downloading';
    item.error = null;
    item.startedAt = item.startedAt || Date.now();
    const runtime = this.createRuntime();
    this.runtime.set(item.id, runtime);
    this.mark();
    this.run(item, runtime);
  }

  async shutdown() {
    this.stopped = true;
    this.stop();
    for (const item of this.library.items) {
      if (item.status === 'downloading') this.runtime.get(item.id)?.abort.abort();
    }
    await Promise.allSettled([...this.runtime.values()].map((runtime) => runtime.done || Promise.resolve()));
    this.library.save();
  }

  async closeFh(runtime) {
    if (!runtime?.fh) return;
    const handle = runtime.fh;
    runtime.fh = null;
    try { await handle.sync(); } catch { /* the close still matters */ }
    try { await handle.close(); } catch { /* already closed */ }
  }

  fail(item, error) {
    if (['paused', 'cancelled', 'completed', 'error'].includes(item.status)) return;
    item.status = 'error';
    item.error = error?.message || 'The download failed.';
    item.speed = 0;
    this.log(error);
    this.mark();
  }

  async run(item, runtime) {
    try {
      await this.runOnce(item, runtime);
      if (runtime.restartSingle && item.status === 'downloading') {
        runtime.restartSingle = false;
        await this.closeFh(runtime);
        await fs.promises.rm(item.partialPath, { force: true }).catch(() => {});
        item.segments = [];
        item.downloaded = 0;
        item.mode = null;
        item.size = null;
        runtime.abort = new AbortController();
        runtime.active.clear();
        runtime.workerPromises = [];
        await this.runOnce(item, runtime);
      }
      if (item.status === 'downloading' && this.isComplete(item)) await this.finalize(item, runtime);
      else if (item.status === 'downloading' && !runtime.restartSingle) {
        this.fail(item, new Error('The download stopped before the file was complete.'));
      }
    } catch (error) {
      if (!['paused', 'cancelled'].includes(item.status) && error?.name !== 'AbortError') this.fail(item, error);
    } finally {
      await this.closeFh(runtime);
      runtime.running = false;
      runtime.finish?.();
    }
  }

  isComplete(item) {
    if (item.mode === 'empty') return true;
    if (item.mode === 'range') return item.segments.length > 0 && item.segments.every((seg) => segmentRemaining(seg) <= 0);
    if (item.mode === 'stream') return item.size != null && item.downloaded === item.size;
    return false;
  }

  async runOnce(item, runtime) {
    if (item.status !== 'downloading') return;
    const resumable = await exists(item.partialPath)
      && (item.segments.length > 0 || (item.mode === 'stream' && item.downloaded > 0));
    if (!resumable) {
      item.segments = [];
      item.downloaded = 0;
      const probe = await this.probe(item, runtime);
      if (item.status !== 'downloading') {
        probe.response?.abort?.();
        return;
      }
      if (probe.mode === 'empty') {
        await this.prepareEmpty(item, runtime, probe);
      } else if (probe.mode === 'stream') {
        await this.prepareStream(item, runtime, probe);
        await this.writeStream(item, runtime, probe.response, 0);
      } else {
        await this.prepareRange(item, runtime, probe);
        await this.runSegments(item, runtime);
      }
      return;
    }
    await this.reopen(item, runtime);
    if (item.mode === 'stream') await this.resumeStream(item, runtime);
    else await this.runSegments(item, runtime);
  }

  async probe(item, runtime) {
    const headers = this.baseHeaders(item);
    if (item.forceSingle) {
      const response = await this.transport({ url: item.url, method: 'GET', headers, signal: runtime.abort.signal });
      return this.meta(response, 'stream', lengthOrNull(response.headers['content-length']));
    }
    let head = null;
    try {
      head = await this.transport({ url: item.url, method: 'HEAD', headers, signal: runtime.abort.signal });
    } catch (error) {
      if (error.name === 'AbortError' || item.status !== 'downloading') throw error;
      head = null;
    }
    const headOk = head && head.statusCode >= 200 && head.statusCode < 300;
    const headSize = headOk ? lengthOrNull(head.headers['content-length']) : null;
    const headRanges = headOk && /bytes/i.test(head.headers['accept-ranges'] || '');
    if (headOk && headRanges && headSize > 0) return this.meta(head, 'range', headSize);
    if (headOk && headSize === 0) return this.meta(head, 'empty', 0);

    const ranged = await this.transport({
      url: item.url,
      method: 'GET',
      headers: { ...headers, Range: 'bytes=0-0' },
      signal: runtime.abort.signal,
    });
    if (ranged.statusCode === 206) {
      const total = totalFromContentRange(ranged.headers['content-range']);
      await drain(ranged.body);
      if (total === 0) return this.meta(ranged, 'empty', 0);
      if (total > 0) return this.meta(ranged, 'range', total);
    }
    if (ranged.statusCode === 200) {
      item.forceSingle = true;
      return this.meta(ranged, 'stream', lengthOrNull(ranged.headers['content-length']));
    }
    ranged.abort?.();
    throw httpError(ranged.statusCode || 0);
  }

  meta(response, mode, size) {
    const encoding = (response.headers['content-encoding'] || '').toLowerCase();
    if (encoding && encoding !== 'identity') {
      response.abort?.();
      throw Object.assign(new Error('The server sent a compressed response, so the file was not saved.'), { fatal: true });
    }
    return {
      mode,
      size,
      response: mode === 'stream' ? response : null,
      filename: filenameFromDisposition(response.headers['content-disposition']),
      mime: response.headers['content-type'] || null,
      finalUrl: response.finalUrl || null,
      etag: cleanEtag(response.headers.etag),
      lastModified: response.headers['last-modified'] || null,
      statusCode: response.statusCode,
    };
  }

  applyName(item, probe) {
    const fromServer = probe.filename || '';
    if (fromServer && !item.nameLocked && item.downloaded === 0 && fromServer.toLowerCase() !== item.filename.toLowerCase()) {
      const finalPath = this.allocatePath(item.directory, fromServer, item.id);
      item.filename = path.basename(finalPath);
      item.finalPath = finalPath;
      item.partialPath = `${finalPath}.apexpart`;
      if (!item.categoryLocked) item.category = categoryFor(item.filename);
    }
    if (probe.mime) item.mime = probe.mime.split(';')[0].trim();
    if (probe.finalUrl) item.finalUrl = probe.finalUrl;
    if (probe.etag) item.etag = probe.etag;
    if (probe.lastModified) item.lastModified = probe.lastModified;
  }

  async prepareEmpty(item, runtime, probe) {
    this.applyName(item, probe);
    item.mode = 'empty';
    item.size = 0;
    item.downloaded = 0;
    await fs.promises.mkdir(item.directory, { recursive: true });
    runtime.fh = await fs.promises.open(item.partialPath, 'w');
  }

  async prepareStream(item, runtime, probe) {
    this.applyName(item, probe);
    item.mode = 'stream';
    item.size = probe.size;
    await fs.promises.mkdir(item.directory, { recursive: true });
    runtime.fh = await fs.promises.open(item.partialPath, 'w');
  }

  async prepareRange(item, runtime, probe) {
    this.applyName(item, probe);
    item.mode = 'range';
    item.size = probe.size;
    const connections = item.forceSingle ? 1 : item.connections;
    item.segments = planSegments(item.size, connections, this.settings().minSegmentBytes);
    item.nextSegId = item.segments.length + 1;
    await fs.promises.mkdir(item.directory, { recursive: true });
    runtime.fh = await fs.promises.open(item.partialPath, 'w+');
    await runtime.fh.truncate(item.size);
    this.persistNow();
  }

  async reopen(item, runtime) {
    await fs.promises.mkdir(item.directory, { recursive: true });
    runtime.fh = await fs.promises.open(item.partialPath, 'r+');
    if (item.mode === 'range' && item.size != null) {
      const stat = await runtime.fh.stat();
      if (stat.size < item.size) await runtime.fh.truncate(item.size);
    }
  }

  async writeStream(item, runtime, response, startPos) {
    if (response.statusCode >= 400) throw httpError(response.statusCode);
    if (startPos === 0) {
      const length = lengthOrNull(response.headers['content-length']);
      if (length != null) item.size = length;
    }
    let pos = startPos;
    try {
      for await (const chunk of response.body) {
        if (item.status !== 'downloading') {
          response.abort?.();
          return;
        }
        await runtime.lock(async () => {
          if (!runtime.fh || item.status !== 'downloading') return;
          await writeAt(runtime.fh, chunk, pos);
        });
        if (item.status !== 'downloading') {
          response.abort?.();
          return;
        }
        pos += chunk.length;
        item.downloaded = pos;
        this.noteBytes(item, chunk.length);
        await this.throttle(chunk.length);
      }
    } finally {
      response.abort?.();
    }
    if (item.status !== 'downloading') return;
    const bodyLength = lengthOrNull(response.headers['content-length']);
    if (bodyLength != null && pos - startPos !== bodyLength) {
      throw Object.assign(new Error('The connection closed early.'), { code: 'ECONNRESET' });
    }
    if (item.size == null) item.size = pos;
    item.mode = 'stream';
  }

  async resumeStream(item, runtime) {
    const response = await this.transport({
      url: item.url,
      method: 'GET',
      headers: { ...this.baseHeaders(item), Range: `bytes=${item.downloaded}-` },
      signal: runtime.abort.signal,
    });
    if (response.statusCode === 206) {
      await this.writeStream(item, runtime, response, item.downloaded);
      return;
    }
    if (response.statusCode === 200) {
      await runtime.fh.truncate(0);
      item.downloaded = 0;
      item.size = lengthOrNull(response.headers['content-length']);
      await this.writeStream(item, runtime, response, 0);
      return;
    }
    response.abort?.();
    throw httpError(response.statusCode || 0);
  }

  async runSegments(item, runtime) {
    while (item.status === 'downloading' && !runtime.abort.signal.aborted) {
      this.rebalance(item, runtime);
      for (const seg of item.segments) {
        if (segmentRemaining(seg) <= 0) {
          seg.done = true;
          continue;
        }
        if (runtime.active.has(seg.id)) continue;
        if (runtime.active.size >= item.connections) break;
        this.startWorker(item, runtime, seg);
      }
      if (item.segments.length && item.segments.every((seg) => seg.done) && runtime.active.size === 0) break;
      await sleep(runtime.active.size ? 280 : 40);
    }
    if (runtime.workerPromises.length) await Promise.allSettled(runtime.workerPromises);
  }

  startWorker(item, runtime, seg) {
    runtime.active.add(seg.id);
    const task = this.worker(item, runtime, seg).finally(() => runtime.active.delete(seg.id));
    runtime.workerPromises.push(task);
  }

  rebalance(item, runtime) {
    if (!this.settings().dynamicSplit || item.mode !== 'range' || item.forceSingle) return;
    if (item.segments.length >= item.connections * 4) return;
    const waiting = item.segments.filter((seg) => !seg.done && !runtime.active.has(seg.id)).length;
    let idle = item.connections - runtime.active.size - waiting;
    const floor = this.settings().minSegmentBytes * 2;
    while (idle > 0 && item.segments.length < item.connections * 4) {
      const victim = [...item.segments]
        .filter((seg) => !seg.done && segmentRemaining(seg) >= floor)
        .sort((a, b) => segmentRemaining(b) - segmentRemaining(a))[0];
      if (!victim || !this.split(item, victim)) break;
      idle -= 1;
    }
  }

  split(item, seg) {
    const next = seg.start + seg.received;
    const last = seg.end;
    if (last - next < this.settings().minSegmentBytes * 2) return false;
    const mid = next + Math.floor((last - next) / 2);
    if (mid <= next || mid >= last) return false;
    item.segments.push({ id: item.nextSegId++, start: mid + 1, end: last, received: 0, done: false });
    seg.end = mid;
    return true;
  }

  async worker(item, runtime, seg) {
    try {
      await this.downloadSegment(item, runtime, seg);
      if (segmentRemaining(seg) <= 0) seg.done = true;
    } catch (error) {
      if (error?.fallback || runtime.restartSingle || runtime.abort.signal.aborted || error?.name === 'AbortError') return;
      if (['paused', 'cancelled', 'error'].includes(item.status)) return;
      this.fail(item, error);
      runtime.abort.abort();
    }
  }

  async downloadSegment(item, runtime, seg) {
    let attempt = 0;
    while (item.status === 'downloading' && !runtime.abort.signal.aborted) {
      if (segmentRemaining(seg) <= 0) {
        seg.done = true;
        return;
      }
      try {
        const outcome = await this.fetchRange(item, runtime, seg);
        if (outcome === 'fallback' || outcome === 'stop') return;
        if (segmentRemaining(seg) <= 0) {
          seg.done = true;
          return;
        }
      } catch (error) {
        if (error?.fallback) throw error;
        if (runtime.abort.signal.aborted || item.status !== 'downloading' || error?.name === 'AbortError') return;
        attempt += 1;
        if (error?.fatal || !isRetryable(error) || attempt >= 4) throw error;
        await sleep(350 * attempt);
      }
    }
  }

  async fetchRange(item, runtime, seg) {
    let pos = seg.start + seg.received;
    if (pos > seg.end) return 'again';
    const headers = { ...this.baseHeaders(item), Range: `bytes=${pos}-${seg.end}` };
    if (item.etag) headers['If-Range'] = item.etag;
    else if (item.lastModified) headers['If-Range'] = item.lastModified;
    const response = await this.transport({
      url: item.url,
      method: 'GET',
      headers,
      signal: runtime.abort.signal,
    });
    try {
      if (response.statusCode === 416) {
        if (segmentRemaining(seg) <= 0) return 'again';
        throw httpError(416);
      }
      if (response.statusCode === 200) {
        if (!runtime.usedFallback) {
          runtime.usedFallback = true;
          runtime.restartSingle = true;
          item.forceSingle = true;
          runtime.abort.abort();
        }
        const error = new Error('fallback');
        error.fallback = true;
        throw error;
      }
      if (response.statusCode !== 206) throw httpError(response.statusCode || 0);
      for await (const chunk of response.body) {
        if (item.status !== 'downloading') return 'stop';
        let offset = 0;
        while (offset < chunk.length) {
          const written = await runtime.lock(async () => {
            if (item.status !== 'downloading' || runtime.abort.signal.aborted || !runtime.fh) return 0;
            const room = seg.end - pos + 1;
            if (room <= 0) return -1;
            const size = Math.min(room, chunk.length - offset);
            await writeAt(runtime.fh, chunk.subarray(offset, offset + size), pos);
            seg.received += size;
            item.downloaded = item.segments.reduce((sum, part) => sum + part.received, 0);
            return size;
          });
          if (written <= 0) return written === 0 ? 'stop' : 'again';
          pos += written;
          offset += written;
          this.noteBytes(item, written);
          await this.throttle(written);
        }
      }
      if (item.status === 'downloading' && segmentRemaining(seg) > 0) {
        throw Object.assign(new Error('The connection closed early.'), { code: 'ECONNRESET' });
      }
      return 'again';
    } catch (error) {
      if (runtime.restartSingle && !error.fallback) {
        const fallback = new Error('fallback');
        fallback.fallback = true;
        throw fallback;
      }
      throw error;
    } finally {
      response.abort?.();
    }
  }

  async finalize(item, runtime) {
    if (item.mode === 'range') {
      const got = item.segments.reduce((sum, seg) => sum + seg.received, 0);
      if (got !== item.size) throw new Error(`The file is incomplete (${got} of ${item.size} bytes).`);
    }
    await this.closeFh(runtime);
    await fs.promises.mkdir(item.directory, { recursive: true });
    let destination = item.finalPath;
    if (fs.existsSync(destination)) {
      destination = this.allocatePath(item.directory, item.filename, item.id);
      item.finalPath = destination;
      item.filename = path.basename(destination);
    }
    let moved = false;
    let lastError = null;
    for (let attempt = 0; attempt < 5 && !moved; attempt += 1) {
      try {
        await fs.promises.rename(item.partialPath, destination);
        moved = true;
      } catch (error) {
        lastError = error;
        await sleep(180 * (attempt + 1));
      }
    }
    if (!moved) {
      try {
        await fs.promises.copyFile(item.partialPath, destination);
        await fs.promises.rm(item.partialPath, { force: true });
      } catch {
        throw lastError || new Error('The finished file could not be saved.');
      }
    }
    item.status = 'completed';
    item.completedAt = Date.now();
    item.speed = 0;
    item.error = null;
    item.downloaded = item.size ?? item.downloaded;
    this.mark();
    if (this.onComplete) this.onComplete(item);
  }

  async pause(id) {
    const item = this.must(id);
    if (item.status !== 'downloading' && item.status !== 'queued') return;
    item.pausedByUser = true;
    item.pausedByScheduler = false;
    item.speed = 0;
    item.status = 'paused';
    this.mark();
    const runtime = this.runtime.get(id);
    if (runtime) {
      runtime.abort.abort();
      await runtime.done;
    }
    this.persistNow();
  }

  resume(id) {
    const item = this.must(id);
    if (item.status !== 'paused' && item.status !== 'error' && item.status !== 'cancelled') return;
    item.pausedByUser = false;
    item.pausedByScheduler = false;
    item.error = null;
    if (this.holding) {
      item.pausedByScheduler = true;
      item.status = 'paused';
    } else item.status = 'queued';
    this.mark();
  }

  retry(id) {
    const item = this.must(id);
    if (!['error', 'cancelled', 'paused'].includes(item.status)) return;
    if (item.forceSingle && item.mode === 'range') {
      item.segments = [];
      item.downloaded = 0;
      item.mode = null;
      item.size = null;
      fs.rmSync(item.partialPath, { force: true });
    }
    this.resume(id);
  }

  async cancel(id) {
    const item = this.must(id);
    item.status = 'cancelled';
    item.speed = 0;
    const runtime = this.runtime.get(id);
    if (runtime) {
      runtime.abort.abort();
      await runtime.done;
    }
    await fs.promises.rm(item.partialPath, { force: true }).catch(() => {});
    item.segments = [];
    item.downloaded = 0;
    item.mode = null;
    this.mark();
  }

  accept(id) {
    const item = this.must(id);
    if (item.status !== 'awaiting') return;
    item.status = 'queued';
    this.mark();
  }

  async reject(id) {
    const item = this.must(id);
    if (item.status !== 'awaiting') return;
    await this.cancel(id);
  }

  async remove(id, { deleteFile = false } = {}) {
    const item = this.must(id);
    item.status = 'cancelled';
    const runtime = this.runtime.get(id);
    if (runtime) {
      runtime.abort.abort();
      await runtime.done;
    }
    await fs.promises.rm(item.partialPath, { force: true }).catch(() => {});
    if (deleteFile) await fs.promises.rm(item.finalPath, { force: true }).catch(() => {});
    this.library.items = this.library.items.filter((entry) => entry.id !== id);
    this.runtime.delete(id);
    this.mark();
  }

  async pauseAll() {
    const ids = this.library.items.filter((item) => item.status === 'downloading' || item.status === 'queued').map((item) => item.id);
    for (const id of ids) await this.pause(id);
  }

  resumeAll() {
    for (const item of this.library.items) {
      if (item.status === 'paused') this.resume(item.id);
    }
  }

  nudge(id, delta) {
    const item = this.must(id);
    item.priority = clamp((item.priority || 0) + delta, -5, 5);
    this.mark();
  }

  updateUrl(id, url) {
    const item = this.must(id);
    if (item.status === 'downloading') throw new Error('Pause the download before changing the link.');
    item.url = assertHttpUrl(url);
    item.finalUrl = null;
    item.error = null;
    if (item.status === 'error' || item.status === 'cancelled') item.status = 'paused';
    this.mark();
  }

  setConnections(id, count) {
    const item = this.must(id);
    item.connections = clamp(count, 1, 32);
    if (item.downloaded === 0 && item.status !== 'downloading') item.segments = [];
    this.mark();
  }
}

module.exports = { DownloadEngine };
