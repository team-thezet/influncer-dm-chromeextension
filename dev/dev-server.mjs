// Dev server (Node, zero deps). Two jobs:
//  1. Serve the project statically — lets you open the side panel as a web page
//     (harness mode) at http://127.0.0.1:8137/src/sidepanel/sidepanel.html
//  2. Expose GET /__version__ → file mtimes, which the unpacked extension polls
//     to hot-reload (see src/lib/dev-reload.js).
//
// Not part of the shipped extension — it's a local dev tool. Run from anywhere:
//   node dev/dev-server.mjs

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8137;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// Files that require a FULL extension reload when changed (vs. just a panel reload).
const CRITICAL = ['manifest.json', 'src/background/service-worker.js'];

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

async function versions() {
  const files = await walk(path.join(ROOT, 'src'));
  files.push(path.join(ROOT, 'manifest.json'));
  let criticalMtime = 0;
  let uiMtime = 0;
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    let st;
    try {
      st = await fs.stat(f);
    } catch {
      continue;
    }
    if (CRITICAL.includes(rel)) criticalMtime = Math.max(criticalMtime, st.mtimeMs);
    else uiMtime = Math.max(uiMtime, st.mtimeMs);
  }
  return { criticalMtime, uiMtime };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // let the extension page fetch /__version__

  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (u.pathname === '/__version__') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(await versions()));
    return;
  }

  let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  if (rel === '') rel = 'src/sidepanel/sidepanel.html';
  const fp = path.resolve(ROOT, rel);
  if (!fp.startsWith(ROOT)) {
    res.statusCode = 403;
    res.end('forbidden');
    return;
  }
  try {
    const data = await fs.readFile(fp);
    res.setHeader('Content-Type', MIME[path.extname(fp)] || 'application/octet-stream');
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`dev server: http://127.0.0.1:${PORT}  (static + /__version__ hot-reload)`);
});
