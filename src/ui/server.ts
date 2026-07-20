/**
 * Atlas demo UI server.
 * Serves the landing page + live console (public/) streaming the agent's
 * concurrent on-chain activity via SSE. Settles on real X Layer (PK in .env).
 * Built for the 90s #OKXAI walkthrough.
 *
 *   npm run ui          # then open http://localhost:4173
 */
import 'dotenv/config';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildAgent } from '../index';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', '..', 'public');

if (!process.env.PK || process.env.PK.includes('PASTE')) {
  console.error('[atlas] PK missing in .env — Atlas settles on real X Layer and needs a funded agent key.');
  process.exit(1);
}
const { ledger, scheduler, asp, settlement } = buildAgent();

const EXPLORER = process.env.XLAYER_EXPLORER || 'https://www.okx.com/web3/explorer/xlayer-test/tx/';
const PORT = Number(process.env.UI_PORT || 4173);

// Top up test tokens once so the live demo doesn't drain the agent balance.
settlement.faucet?.(2_000_000_000n).catch(() => {});

const clients = new Set<http.ServerResponse>();
const ser = (t: any) =>
  JSON.stringify({ ...t, explorer: EXPLORER }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
function broadcast() {
  for (const t of ledger.list()) {
    const payload = ser(t);
    for (const res of clients) res.write(`data: ${payload}\n\n`);
  }
}
ledger.on(() => broadcast());

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(readFileSync(join(publicDir, 'index.html'), 'utf8'));
  }
  if (req.method === 'GET' && (req.url === '/app' || req.url === '/app.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(readFileSync(join(publicDir, 'app.html'), 'utf8'));
  }
  if (req.method === 'GET' && req.url === '/manifest') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(asp.describe()));
  }
  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    clients.add(res);
    broadcast();
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'POST' && req.url === '/intent') {
    let body = '';
    for await (const c of req) body += c;
    const { intent } = JSON.parse(body || '{}');
    if (intent) scheduler.submit(intent);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, mode: 'xlayer' }));
  }
  res.writeHead(404);
  res.end();
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n[atlas] port ${PORT} is already in use — another Atlas server is likely still running.\n` +
        `  • pick a different port:  UI_PORT=4174 npm run ui\n` +
        `  • or stop the stale one:  npx kill-port ${PORT}   (or kill the node process on ${PORT})\n`,
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`Atlas UI  ->  http://localhost:${PORT}   settling on REAL X Layer`);
});
