const http = require('http');
const crypto = require('crypto');

const MAX_BODY = 1024 * 1024;

function isLocal(req) {
  const address = req.socket.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function hostOk(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return host.startsWith('127.0.0.1:') || host.startsWith('localhost:');
}

function tokenOk(got, expected) {
  const left = Buffer.from(String(got || ''));
  const right = Buffer.from(String(expected || ''));
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request is too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Request was not valid JSON.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Apex-Token',
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

class IntegrationServer {
  constructor({ engine, library, version }) {
    this.engine = engine;
    this.library = library;
    this.version = version;
    this.lastSeen = 0;
    this.http = null;
    this.port = 0;
  }

  touch() {
    this.lastSeen = Date.now();
  }

  create() {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        if (res.headersSent || res.writableEnded) return;
        send(res, error.status || 500, { ok: false, error: error.message || 'Request failed.' });
      });
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    return server;
  }

  listen(port) {
    this.http = this.create();
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        this.http.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.http.removeListener('error', onError);
        this.port = this.http.address().port;
        resolve(this.port);
      };
      this.http.once('error', onError);
      this.http.listen(port, '127.0.0.1', onListening);
    });
  }

  close() {
    return new Promise((resolve) => {
      if (!this.http) return resolve();
      const server = this.http;
      this.http = null;
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(() => resolve());
    });
  }

  async handle(req, res) {
    if (!isLocal(req) || !hostOk(req)) {
      send(res, 403, { ok: false, error: 'ApexDM only accepts connections from this computer.' });
      return;
    }
    if (req.method === 'OPTIONS') {
      send(res, 204, { ok: true });
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      this.touch();
      send(res, 200, { ok: true, name: 'ApexDM', version: this.version });
      return;
    }
    const expected = this.library.settings.token;
    if (!tokenOk(req.headers['x-apex-token'], expected)) {
      send(res, 401, { ok: false, error: 'Pairing token does not match. Copy the token from ApexDM again.' });
      return;
    }
    this.touch();
    if (req.method === 'GET' && url.pathname === '/v1/status') {
      const items = this.library.items;
      send(res, 200, {
        ok: true,
        active: items.filter((item) => item.status === 'downloading').length,
        queued: items.filter((item) => item.status === 'queued').length,
        awaiting: items.filter((item) => item.status === 'awaiting').length,
        speed: Math.round(this.engine.globalSpeed || 0),
      });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/v1/capture/')) {
      const id = decodeURIComponent(url.pathname.slice('/v1/capture/'.length));
      send(res, 200, { ok: true, decision: this.decisionFor(id) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/capture') {
      const body = await readBody(req);
      send(res, 200, this.capture(body));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/batch') {
      const body = await readBody(req);
      send(res, 200, this.batch(body));
      return;
    }
    send(res, 404, { ok: false, error: 'Unknown request.' });
  }

  decisionFor(id) {
    const item = this.library.items.find((entry) => entry.id === id);
    if (!item || item.status === 'cancelled') return 'reject';
    if (item.status === 'awaiting') return 'pending';
    return 'accept';
  }

  existing(url) {
    return this.library.items.find((item) => item.url === url && ['awaiting', 'queued', 'downloading', 'paused'].includes(item.status));
  }

  capture(body) {
    const source = String(body.source || 'browser').slice(0, 24);
    const active = this.existing(body.url);
    if (active) {
      return {
        ok: true,
        id: active.id,
        decision: active.status === 'awaiting' ? 'pending' : 'accept',
        duplicate: true,
      };
    }
    const confirm = this.library.settings.confirmCapture && source !== 'user' && source !== 'batch';
    const item = this.engine.add({
      url: body.url,
      filename: body.filename || '',
      referrer: body.referrer || body.pageUrl || '',
      cookies: typeof body.cookies === 'string' ? body.cookies.slice(0, 80000) : '',
      userAgent: body.userAgent || '',
      mime: body.mime || '',
      source,
      status: confirm ? 'awaiting' : 'queued',
    });
    return { ok: true, id: item.id, decision: confirm ? 'pending' : 'accept' };
  }

  batch(body) {
    const list = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
    const errors = [];
    let added = 0;
    for (const entry of list) {
      try {
        if (this.existing(entry.url)) continue;
        this.engine.add({
          url: entry.url,
          filename: entry.filename || '',
          referrer: entry.referrer || body.referrer || body.pageUrl || '',
          cookies: typeof entry.cookies === 'string' ? entry.cookies.slice(0, 80000) : '',
          userAgent: entry.userAgent || body.userAgent || '',
          source: 'batch',
          status: 'queued',
        });
        added += 1;
      } catch (error) {
        errors.push(error.message);
      }
    }
    return { ok: true, added, errors: errors.slice(0, 8) };
  }
}

module.exports = { IntegrationServer };
