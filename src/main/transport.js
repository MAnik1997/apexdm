const http = require('http');
const https = require('https');
const { URL } = require('url');

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function proxyFromEnv(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
  if (noProxy.split(',').some((entry) => {
    const host = entry.trim().replace(/^\./, '');
    return host && (parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
  })) return null;
  const raw = parsed.protocol === 'https:'
    ? (process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY)
    : (process.env.http_proxy || process.env.HTTP_PROXY);
  if (!raw) return null;
  try {
    const proxy = new URL(raw);
    return `${proxy.hostname}:${proxy.port || 80}`;
  } catch {
    return String(raw).replace(/^https?:\/\//i, '');
  }
}

async function resolveProxy(url, getProxy) {
  if (getProxy) return getProxy(url);
  return proxyFromEnv(url);
}

function splitHost(proxy) {
  const text = String(proxy || '');
  const idx = text.lastIndexOf(':');
  if (idx <= 0) return [text, 80];
  return [text.slice(0, idx), Number(text.slice(idx + 1)) || 80];
}

function cleanHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value != null && value !== '') out[key] = String(value);
  }
  return out;
}

function normalizeHeaders(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function createQueue() {
  const chunks = [];
  let waiter = null;
  let ended = false;
  let error = null;
  return {
    push(buffer) {
      if (ended || error) return;
      if (waiter) {
        const current = waiter;
        waiter = null;
        current.resolve(buffer);
      } else chunks.push(buffer);
    },
    end() {
      if (ended || error) return;
      ended = true;
      if (waiter) {
        const current = waiter;
        waiter = null;
        current.resolve(null);
      }
    },
    fail(err) {
      if (ended || error) return;
      error = err;
      if (waiter) {
        const current = waiter;
        waiter = null;
        current.reject(err);
      }
    },
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          if (chunks.length) {
            yield chunks.shift();
            continue;
          }
          if (error) throw error;
          if (ended) return;
          const next = await new Promise((resolve, reject) => {
            waiter = { resolve, reject };
          });
          if (next == null) return;
          yield next;
        }
      } finally {
        ended = true;
      }
    },
  };
}

function emptyBody() {
  return { async *[Symbol.asyncIterator]() {} };
}

function createNodeTransport(options = {}) {
  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

  function openRequest(target, method, headers, proxy) {
    if (!proxy) {
      const secure = target.protocol === 'https:';
      const lib = secure ? https : http;
      return lib.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (secure ? 443 : 80),
        method,
        path: `${target.pathname}${target.search}`,
        headers,
        agent: secure ? httpsAgent : httpAgent,
        rejectUnauthorized: true,
      });
    }
    const [host, port] = splitHost(proxy);
    if (target.protocol === 'http:') {
      return http.request({
        host,
        port,
        method,
        path: target.toString(),
        headers: { ...headers, Host: target.host },
        agent: false,
      });
    }
    return new Promise((resolve, reject) => {
      const connectReq = http.request({
        host,
        port,
        method: 'CONNECT',
        path: `${target.hostname}:${target.port || 443}`,
        headers: { Host: `${target.hostname}:${target.port || 443}` },
        agent: false,
      });
      connectReq.once('connect', (response, socket) => {
        if (response.statusCode !== 200) {
          socket.destroy();
          reject(new Error(`Proxy connection failed (${response.statusCode}).`));
          return;
        }
        resolve(https.request({
          host: target.hostname,
          port: target.port || 443,
          servername: target.hostname,
          method,
          path: `${target.pathname}${target.search}`,
          headers,
          agent: false,
          socket,
          rejectUnauthorized: true,
        }));
      });
      connectReq.once('error', reject);
      connectReq.setTimeout(45000, () => connectReq.destroy(Object.assign(new Error('Proxy connection stalled'), { code: 'ETIMEDOUT' })));
      connectReq.end();
    });
  }

  async function perform(opts, redirects) {
    if (opts.signal?.aborted) throw abortError();
    const target = new URL(opts.url);
    target.hash = '';
    const method = opts.method || 'GET';
    const headers = cleanHeaders(opts.headers);
    const proxy = await resolveProxy(target.toString(), options.getProxy);
    if (opts.signal?.aborted) throw abortError();

    const req = await openRequest(target, method, headers, proxy);
    const queue = createQueue();

    return new Promise((resolve, reject) => {
      let settled = false;
      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const resolveOnce = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const onAbort = () => {
        const error = abortError();
        try { req.destroy(error); } catch { /* already closed */ }
        queue.fail(error);
        rejectOnce(error);
      };
      if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });

      req.setTimeout(45000, () => {
        const error = Object.assign(new Error('Connection stalled'), { code: 'ETIMEDOUT' });
        req.destroy(error);
      });
      req.on('error', (error) => {
        if (opts.signal?.aborted) {
          queue.fail(abortError());
          rejectOnce(abortError());
          return;
        }
        queue.fail(error);
        rejectOnce(error);
      });
      req.on('response', (res) => {
        const responseHeaders = normalizeHeaders(res.headers);
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = responseHeaders.location;
          res.resume();
          opts.signal?.removeEventListener('abort', onAbort);
          if (!location || redirects >= 5) {
            rejectOnce(new Error('The server redirected too many times.'));
            return;
          }
          let nextUrl;
          try { nextUrl = new URL(location, target).toString(); } catch {
            rejectOnce(new Error('The server sent a broken redirect.'));
            return;
          }
          const nextHeaders = { ...headers };
          if (new URL(nextUrl).host !== target.host) {
            delete nextHeaders.Cookie;
            delete nextHeaders.cookie;
          }
          perform({
            ...opts,
            url: nextUrl,
            method: status === 303 ? 'GET' : method,
            headers: nextHeaders,
          }, redirects + 1).then(resolveOnce, rejectOnce);
          return;
        }

        res.on('data', (chunk) => queue.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          queue.end();
          opts.signal?.removeEventListener('abort', onAbort);
        });
        res.on('error', (error) => queue.fail(error));
        res.on('aborted', () => queue.fail(abortError()));

        if (method === 'HEAD') res.resume();
        resolveOnce({
          statusCode: status,
          headers: responseHeaders,
          finalUrl: target.toString(),
          body: method === 'HEAD' ? emptyBody() : queue,
          abort() {
            const error = abortError();
            try { req.destroy(error); } catch { /* already closed */ }
            queue.fail(error);
          },
        });
      });
      req.end();
    });
  }

  async function request(opts) {
    return perform(opts, 0);
  }

  request.destroy = () => {
    httpAgent.destroy();
    httpsAgent.destroy();
  };
  return request;
}

module.exports = { createNodeTransport, proxyFromEnv };
