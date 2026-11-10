const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { DownloadEngine } = require('../src/main/engine');
const { Library } = require('../src/main/library');
const { createNodeTransport } = require('../src/main/transport');
const {
  planSegments,
  filenameFromDisposition,
  sanitizeFilename,
  assertHttpUrl,
} = require('../src/shared/files');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function waitUntil(fn, ms, label) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await sleep(40);
  }
  throw new Error(`Timed out: ${label}`);
}

function explain(item) {
  return JSON.stringify({
    status: item.status,
    error: item.error,
    downloaded: item.downloaded,
    size: item.size,
    mode: item.mode,
    file: item.filename,
    segments: item.segments,
  }, null, 2);
}

function testParsers() {
  const segments = planSegments(10, 4, 1);
  assert.strictEqual(segments.length, 4);
  const covered = segments.reduce((sum, seg) => sum + (seg.end - seg.start + 1), 0);
  assert.strictEqual(covered, 10);
  assert.strictEqual(filenameFromDisposition('attachment; filename="a.zip"'), 'a.zip');
  assert.strictEqual(filenameFromDisposition("attachment; filename*=UTF-8''na%C3%AFve.bin"), 'naïve.bin');
  assert.strictEqual(sanitizeFilename('..\\evil.exe'), 'evil.exe');
  assert.strictEqual(sanitizeFilename('con.txt').startsWith('_'), true);
  assert.throws(() => assertHttpUrl('file:///c/secret'), /http/);
  const tiny = planSegments(1000, 8, 256 * 1024);
  assert.strictEqual(tiny.length, 1);
}

function startServer() {
  const files = {
    '/fast': { body: crypto.randomBytes(2 * 1024 * 1024), name: 'range.bin', ranges: true },
    '/plain': { body: crypto.randomBytes(1024 * 1024), name: 'plain.bin', ranges: false },
    '/liar': { body: crypto.randomBytes(1536 * 1024), name: 'liar.bin', ranges: 'lie' },
    '/slow': { body: crypto.randomBytes(8 * 1024 * 1024), name: 'slow.bin', ranges: true, slow: true },
  };
  const server = http.createServer((req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
    res.setMaxListeners(30);
    const route = req.url.split('?')[0];
    const file = files[route];
    if (!file) {
      res.writeHead(404);
      res.end();
      return;
    }
    const size = file.body.length;
    const headers = {
      'Content-Disposition': `attachment; filename="${file.name}"`,
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': file.ranges ? 'bytes' : 'none',
    };
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...headers, 'Content-Length': size });
      res.end();
      return;
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const honorRange = file.ranges === true && match;
    if (req.headers.range && file.ranges === true && match) {
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : size - 1;
      if (start >= size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      const slice = file.body.subarray(start, Math.min(end, size - 1) + 1);
      res.writeHead(206, {
        ...headers,
        'Content-Length': slice.length,
        'Content-Range': `bytes ${start}-${start + slice.length - 1}/${size}`,
      });
      sendSlice(req, res, slice, Boolean(file.slow && start < size / 2));
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': size, 'Accept-Ranges': honorRange ? 'bytes' : 'none' });
    sendSlice(req, res, file.body, false);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, files, port: server.address().port }));
  });
}

async function sendSlice(req, res, slice, slow) {
  try {
    const step = 32 * 1024;
    for (let offset = 0; offset < slice.length; offset += step) {
      if (res.destroyed || req.destroyed) return;
      if (slow) await sleep(60);
      const chunk = slice.subarray(offset, Math.min(slice.length, offset + step));
      if (!res.write(chunk)) {
        await Promise.race([
          once(res, 'drain'),
          once(res, 'close'),
        ]);
      }
    }
    if (!res.destroyed && !res.writableEnded) res.end();
  } catch { /* the client stopped */ }
}

async function download({ port, route, directory, connections, dynamicSplit, slow }) {
  const file = path.join(os.tmpdir(), `apex-lib-${crypto.randomBytes(4).toString('hex')}.json`);
  const library = new Library(file);
  library.settings.downloadDir = directory;
  library.settings.maxActive = 2;
  library.settings.connections = connections;
  library.settings.minSegmentBytes = 256 * 1024;
  library.settings.dynamicSplit = dynamicSplit;
  library.settings.speedLimitBps = 0;
  library.settings.schedule.enabled = false;
  const transport = createNodeTransport();
  const engine = new DownloadEngine({ library, transport });
  engine.start(40);
  const item = engine.add({ url: `http://127.0.0.1:${port}${route}`, directory, connections });
  try {
    if (slow) {
      await waitUntil(() => item.downloaded > 500000 || ['completed', 'error'].includes(item.status), 20000, 'progress');
      if (item.status === 'error') throw new Error(explain(item));
      if (item.status !== 'completed') {
        await engine.pause(item.id);
        assert.strictEqual(item.status, 'paused');
        assert.ok(item.downloaded > 0);
        engine.resume(item.id);
      }
    }
    await waitUntil(() => item.status === 'completed' || item.status === 'error', slow ? 40000 : 20000, route);
    if (item.status !== 'completed') throw new Error(explain(item));
    return item;
  } finally {
    await engine.shutdown();
    transport.destroy();
    fs.rmSync(file, { force: true });
  }
}

async function main() {
  testParsers();
  const { server, files, port } = await startServer();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apexdm-'));
  try {
    const fast = await download({ port, route: '/fast', directory, connections: 4, dynamicSplit: false });
    assert.strictEqual(fast.filename, 'range.bin');
    assert.strictEqual(sha(fast.finalPath), shaBuffer(files['/fast'].body));
    assert.ok(fast.segments.length >= 2, 'expected multiple connections');

    const plain = await download({ port, route: '/plain', directory, connections: 4, dynamicSplit: true });
    assert.strictEqual(plain.filename, 'plain.bin');
    assert.strictEqual(plain.mode, 'stream');
    assert.strictEqual(sha(plain.finalPath), shaBuffer(files['/plain'].body));

    const liar = await download({ port, route: '/liar', directory, connections: 4, dynamicSplit: true });
    assert.strictEqual(sha(liar.finalPath), shaBuffer(files['/liar'].body));

    const slow = await download({ port, route: '/slow', directory, connections: 4, dynamicSplit: true, slow: true });
    assert.strictEqual(sha(slow.finalPath), shaBuffer(files['/slow'].body));
    assert.strictEqual(fs.statSync(slow.finalPath).size, files['/slow'].body.length);
    console.log('All download tests passed.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function shaBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
