/**
 * Local development server: runs the same `api/` functions Vercel runs, and
 * serves the dashboard from `public/`. No dependencies.
 *
 *   npm run dev            → http://localhost:4000
 *   PORT=5000 npm run dev  → another port
 *
 * Mirrors Vercel's routing: `api/foo/bar.js` handles `/api/foo/bar`, with the
 * function chosen by the exported HTTP method name (GET, POST, …).
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve('.');
const PUBLIC_DIR = join(ROOT, 'public');
const API_DIR = join(ROOT, 'api');
const DEFAULT_PORT = 4000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

/** Loads KEY=value lines from .env.local into process.env (existing variables win). */
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(eq + 1).trim();
  }
}

/** Resolves a path inside `base`, or null if it would escape it (e.g. `../`). */
function safeJoin(base, relative) {
  const full = normalize(join(base, relative));
  return full === base || full.startsWith(base + sep) ? full : null;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function handleApi(req, res, url) {
  const file = safeJoin(API_DIR, url.pathname.slice('/api/'.length) + '.js');
  if (file === null || !existsSync(file)) return send(res, 404, { error: { code: 'not_found', message: 'No such endpoint' } });

  const module = await import(pathToFileURL(file).href);
  const fn = module[req.method];
  if (typeof fn !== 'function') return send(res, 405, { error: { code: 'method_not_allowed', message: `${req.method} not supported` } });

  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
  const request = new Request(url, { method: req.method, headers: req.headers, body });
  const response = await fn(request);

  const headers = {};
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') headers[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

function serveStatic(res, url) {
  let file = safeJoin(PUBLIC_DIR, decodeURIComponent(url.pathname));
  if (file === null) return send(res, 400, 'Bad path');
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(PUBLIC_DIR, 'index.html'); // single-page app fallback
  res.writeHead(200, { 'Content-Type': MIME_TYPES[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}

function send(res, status, data) {
  const isJson = typeof data !== 'string';
  res.writeHead(status, { 'Content-Type': isJson ? 'application/json' : 'text/plain' });
  res.end(isJson ? JSON.stringify(data) : data);
}

/** The headers vercel.json applies to every route, so local runs hit the same CSP as production. */
function globalHeaders() {
  const config = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  const rule = (config.headers || []).find((h) => h.source === '/(.*)');
  // HSTS is meaningless (and sticky) on http://localhost.
  return rule ? rule.headers.filter((h) => h.key !== 'Strict-Transport-Security') : [];
}

loadEnvFile(join(ROOT, '.env.local'));
const port = Number(process.env.PORT) || DEFAULT_PORT;
const SECURITY_HEADERS = globalHeaders();

createServer(async (req, res) => {
  for (const { key, value } of SECURITY_HEADERS) res.setHeader(key, value);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(res, url);
  } catch (error) {
    console.error('[dev-server]', error);
    if (!res.headersSent) send(res, 500, { error: { code: 'internal_error', message: error.message } });
  }
}).listen(port, () => {
  console.log(`Error tracker backend running at http://localhost:${port}`);
});
