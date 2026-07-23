/**
 * Atlas — OKX.AI-conformant ASP HTTP server (asp/1.0 + OKX x402).
 *
 * Serves the spec surface OKX.AI discovers and calls:
 *   GET  /.well-known/asp.yaml   discoverable identity manifest (asp/1.0)
 *   GET  /asp/feed               capability feed (ASP-Sig auth)
 *   POST /asp/inbox              accept an intent message (ASP-Sig auth)
 *   POST /asp/run                the run() surface — free, or x402 pay-per-call
 * Plus the live demo UI so the 90s walkthrough runs from one process:
 *   GET  /                       landing        GET /app     console
 *   GET  /manifest               legacy alias   GET /events  SSE
 *
 *   npm run asp                  # real X Layer settlement (PK in .env)
 *   ASP_PAID=1 npm run asp       # enable x402 402 challenge on /asp/run
 */
import 'dotenv/config';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildAgent } from './index';
import { challenge, verifyPayment, paymentResponseHeader, paymentErrorHeader } from './kernel/x402';
import { normalizeAmount, formatUsdc, usdcToBase } from './kernel/planner';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');

if (!process.env.PK || process.env.PK.includes('PASTE') || process.env.PK.includes('YOUR')) {
  console.error('[atlas] PK missing in .env — Atlas settles on real X Layer and needs a funded agent key.');
  process.exit(1);
}
const { ledger, scheduler, asp, sig, settlement, planner } = buildAgent();

// Cloud hosts inject the port via PORT; fall back to UI_PORT then 4173 for local.
const PORT = Number(process.env.PORT || process.env.UI_PORT || 4173);
const PAID = process.env.ASP_PAID === '1' || process.env.ASP_PAID === 'true';
const EXPLORER = process.env.XLAYER_EXPLORER || 'https://www.okx.com/web3/explorer/xlayer-test/tx/';
const HANDLE = process.env.ASP_HANDLE || 'atlas';
// DEMO_MODE enables the agent-FUNDED /intent path (agent spends its own funds
// on any request). OFF by default — it's unauthenticated, so on a public host
// it would let anyone drain the agent. The user-funded /wallet/* flow is always
// available and is the safe, non-custodial path.
const DEMO_MODE = process.env.DEMO_MODE === '1' || process.env.DEMO_MODE === 'true';

// x402 pricing (per call): default 0.01 USDC = 10000 base units (6dp).
const PRICE = process.env.ASP_PRICE || '10000';
const TREASURY = process.env.XLAYER_TREASURY || '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const USDC = process.env.XLAYER_USDC || '0x732cec1df06a48c596408ab1d95ee109a3179364';
const TOKEN = { address: USDC, symbol: 'USDC', decimals: 6 };

// ---- SSE (live dashboard) --------------------------------------------------
// Each client subscribes with an `owner` (its connected wallet address, or
// 'server' for the unauthenticated demo view). A client only receives tasks it
// owns, so one visitor never sees another's activity or addresses.
type Client = { res: http.ServerResponse; owner: string };
const clients = new Set<Client>();
const ser = (t: any) =>
  JSON.stringify({ ...t, explorer: EXPLORER }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

function sendTask(c: Client, t: any) {
  if (t.owner !== c.owner) return; // owner-scoped: only your own tasks
  c.res.write(`data: ${ser(t)}\n\n`);
}
function broadcast() {
  for (const t of ledger.list()) for (const c of clients) sendTask(c, t);
}
// On each ledger change, push just that task to the clients that own it.
ledger.on((t: any) => { for (const c of clients) sendTask(c, t); });

// Top up test tokens once so live demos never drain the agent balance.
settlement.faucet?.(2_000_000_000n).catch(() => {});

// ---- helpers ---------------------------------------------------------------
function json(res: http.ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

// Log the real error server-side; return a safe, generic message to the client
// so internal RPC/viem details and addresses aren't leaked (audit M1).
function serverError(res: http.ServerResponse, where: string, e: any) {
  console.error(`[atlas] ${where}:`, e?.message ?? e);
  return json(res, 500, { error: `${where} failed` });
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  let body = '';
  for await (const c of req) body += c;
  try {
    return JSON.parse(body || '{}');
  } catch {
    return {};
  }
}

/** Submit an intent and wait for the task to reach a terminal state. */
async function runIntent(intent: string, timeoutMs = 20000): Promise<any> {
  const id = scheduler.submit(intent);
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const t = ledger.get(id);
      if (t && (t.status === 'done' || t.status === 'failed')) return resolve(t);
      if (Date.now() - started > timeoutMs) return resolve(t ?? { id, status: 'failed' });
      setTimeout(tick, 60);
    };
    tick();
  });
}

function toYaml(m: any): string {
  // Minimal, dependency-free YAML for the manifest (best-effort; JSON is canonical).
  return JSON.stringify(m, null, 2)
    .replace(/[{}\[\],]/g, '')
    .split('\n')
    .map((l) => l.replace(/"/g, '').replace(/:\s*$/, ':'))
    .filter((l) => l.trim())
    .join('\n');
}

// ---- rate limiting ---------------------------------------------------------
// Simple in-memory sliding-window limiter keyed by client IP. Protects the
// gas/fund-spending routes (each /wallet/prepare deploys a contract = real agent
// gas) from anonymous abuse/DoS (audit C3). Not distributed — fine for a single
// instance; put a proper gateway limiter in front for multi-instance.
const RATE_MAX = Number(process.env.RATE_MAX || 20);      // requests
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60_000); // per minute
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_MAX;
}
// Periodically clear stale IP buckets so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    const live = arr.filter((t) => now - t < RATE_WINDOW_MS);
    if (live.length) hits.set(ip, live); else hits.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

const RATE_LIMITED_PATHS = new Set([
  '/wallet/prepare', '/wallet/prepare-split', '/wallet/release', '/wallet/release-split', '/wallet/refund', '/intent',
]);

// ---- server ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  const path = (req.url || '/').split('?')[0];

  // Throttle the money/gas-spending routes per client IP.
  if (method === 'POST' && RATE_LIMITED_PATHS.has(path)) {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    if (rateLimited(ip)) return json(res, 429, { error: 'rate limit exceeded; slow down' });
  }

  // Discoverable identity manifest (asp/1.0).
  if (method === 'GET' && path === '/.well-known/asp.yaml') {
    const m = asp.describe();
    const wantsYaml = (req.headers.accept || '').includes('yaml');
    if (wantsYaml) {
      res.writeHead(200, { 'Content-Type': 'application/yaml' });
      return res.end(toYaml(m));
    }
    return json(res, 200, m);
  }

  // ASP core: feed (ASP-Sig authenticated).
  if (method === 'GET' && path === '/asp/feed') {
    if (!sig.verify(req.headers.authorization, method, path))
      return json(res, 401, { error: 'ASP-Sig required' });
    const m = asp.describe();
    const entries = m.agent.services.map((s, i) => ({
      id: `atlas-${s.name}`,
      title: s.name,
      published: '2026-07-17',
      topics: [m.agent.category],
      summary: s.description,
      author: HANDLE,
      order: i,
    }));
    return json(res, 200, { entries });
  }

  // ASP core: inbox (ASP-Sig authenticated) — accept an intent message.
  if (method === 'POST' && path === '/asp/inbox') {
    if (!sig.verify(req.headers.authorization, method, path))
      return json(res, 401, { error: 'ASP-Sig required' });
    const body = await readBody(req);
    const intent = body?.body?.intent ?? body?.intent ?? body?.text ?? '';
    if (intent) scheduler.submit(String(intent));
    return json(res, 200, { status: 'received' });
  }

  // The run() surface — free, or x402 pay-per-call.
  if (method === 'POST' && path === '/asp/run') {
    const body = await readBody(req);
    const intent = String(body?.intent ?? body?.text ?? '');
    if (!intent) return json(res, 400, { error: 'intent required' });

    let paymentResp: string | undefined;
    if (PAID) {
      // Spec header is `X-PAYMENT` (base64 JSON). The legacy PAYMENT-SIGNATURE
      // names stay accepted so any already-integrated client keeps working.
      const paySig = (req.headers['x-payment'] ||
        req.headers['payment-signature'] ||
        req.headers['payment-sig']) as string | undefined;
      // Build the canonical resource URL. Prefer ASP_BASE_URL (set to the public
      // https:// origin); otherwise honor the proxy's forwarded scheme so we never
      // advertise http:// when served behind HTTPS (Render/any TLS proxy).
      const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0] || 'http';
      const origin = (process.env.ASP_BASE_URL || `${proto}://${req.headers.host || ''}`).replace(/\/+$/, '');
      const resource = `${origin}/asp/run`;
      if (!paySig) {
        return json(res, 402, challenge(resource, { token: TOKEN, amount: PRICE, recipient: TREASURY }), {
          'x-payment-required': '1',
        });
      }
      try {
        const { payer } = await verifyPayment(paySig, {
          recipient: TREASURY,
          amount: PRICE,
          token: USDC,
          resource,
        });
        paymentResp = paymentResponseHeader({ payer, amount: PRICE, token: 'USDC' });
      } catch (e: any) {
        // Per the HTTP transport spec, a failed payment re-serves the full
        // requirements body (x402Version + error + accepts[]) and reports the
        // reason in a base64 X-PAYMENT-RESPONSE header.
        const reason = String(e?.message ?? e);
        const body = challenge(resource, { token: TOKEN, amount: PRICE, recipient: TREASURY });
        return json(res, 402, { ...body, error: `Payment failed: ${reason}` }, {
          'X-PAYMENT-RESPONSE': paymentErrorHeader(reason),
        });
      }
    }

    const task = await runIntent(intent);
    const headers = paymentResp ? { 'X-PAYMENT-RESPONSE': paymentResp } : {};
    return json(
      res,
      200,
      {
        id: task?.id,
        status: task?.status,
        capability: task?.capability,
        result: task?.result,
        feesAccrued: task?.feesAccrued,
        mode: 'xlayer',
      },
      headers,
    );
  }

  // ---- Bring-your-own-wallet (non-custodial) flow --------------------------
  // The connected user funds + signs the escrow from their OWN wallet; the agent
  // only orchestrates (deploy + release after proof).

  // Config the browser needs to build + sign escrow transactions.
  if (method === 'GET' && path === '/wallet/config') {
    if (!settlement.clientConfig) return json(res, 501, { error: 'wallet flow unavailable on this settlement' });
    return json(res, 200, settlement.clientConfig());
  }

  // Step 1: plan the intent + deploy an escrow funded by the connected user.
  // Body: { intent, from }  ->  { taskId, escrow, token, amount, payee, capability }
  if (method === 'POST' && path === '/wallet/prepare') {
    if (!settlement.deployUserEscrow) return json(res, 501, { error: 'wallet flow unavailable' });
    const body = await readBody(req);
    const intent = String(body?.intent ?? '').trim();
    const from = String(body?.from ?? '').trim();
    if (!intent) return json(res, 400, { error: 'intent required' });
    if (!/^0x[a-fA-F0-9]{40}$/.test(from)) return json(res, 400, { error: 'valid connected address (from) required' });

    // Plan with the LLM (falls back to rules) to extract capability + payee + amount.
    const plan = await planner.plan(intent);
    const input: any = plan.input || {};
    // split needs N recipients and can't use this single-escrow endpoint (use /wallet/prepare-split).
    if (plan.capability === 'split') {
      return json(res, 422, { error: 'split requires multiple recipients — use the Split form (POST /wallet/prepare-split)' });
    }
    const payee = String(input.payee ?? input.client ?? '');
    if (!/^0x[a-fA-F0-9]{40}$/.test(payee)) {
      return json(res, 422, { error: `could not extract a valid recipient address from intent (got "${payee}")` });
    }
    const amount = BigInt(normalizeAmount(input.amount ?? input.total ?? '0'));
    if (amount <= 0n) return json(res, 422, { error: 'could not extract a positive amount from intent' });

    // Create a live ledger entry so the connected-wallet task appears in the UI.
    const task = ledger.create(intent, plan.capability, { ...input, payee, amount, funder: from }, ['plan', 'deploy-escrow'], from);
    ledger.update(task.id, { status: 'awaiting-approval' });

    try {
      const dep = await settlement.deployUserEscrow({ funder: from, payee, amount, token: 'USDC' });
      ledger.update(task.id, { plan: [`escrow ${dep.escrow} deployed (funder=${from}); awaiting your signature`] });
      return json(res, 200, {
        taskId: task.id,
        capability: plan.capability,
        escrow: dep.escrow,
        token: dep.token,
        amount: dep.amount,
        payee,
        chainId: dep.chainId,
      });
    } catch (e: any) {
      ledger.update(task.id, { status: 'failed', result: { ok: false, summary: 'escrow deploy failed' } });
      return serverError(res, 'prepare', e);
    }
  }

  // Split (user-funded): deploy ONE escrow per recipient, each funded by the
  // connected wallet. The browser then approves+locks each and releases each.
  // Body: { from, recipients:[0x..], total }  ->  { taskId, token, legs:[{escrow,payee,amount}] }
  if (method === 'POST' && path === '/wallet/prepare-split') {
    if (!settlement.deployUserEscrow) return json(res, 501, { error: 'wallet flow unavailable' });
    const body = await readBody(req);
    const from = String(body?.from ?? '').trim();
    const recipients: string[] = Array.isArray(body?.recipients) ? body.recipients.map((r: any) => String(r).trim()) : [];
    if (!/^0x[a-fA-F0-9]{40}$/.test(from)) return json(res, 400, { error: 'valid connected address (from) required' });
    if (recipients.length < 2) return json(res, 400, { error: 'split needs at least 2 recipients' });
    const bad = recipients.find((r) => !/^0x[a-fA-F0-9]{40}$/.test(r));
    if (bad) return json(res, 422, { error: `invalid recipient address: ${bad}` });
    // The split form's total is a HUMAN whole-USDC amount ("6" = 6 USDC), so scale
    // to base units. (This differs from planner-extracted amounts, which arrive
    // already normalized — hence usdcToBase here rather than normalizeAmount.)
    const total = usdcToBase(body?.total ?? '0');
    if (total <= 0n) return json(res, 422, { error: 'total must be a positive USDC amount' });

    // Even split; the remainder (from integer division) goes to the last recipient.
    const n = BigInt(recipients.length);
    const base = total / n;
    if (base <= 0n) return json(res, 422, { error: 'total too small to split across recipients' });
    const amounts = recipients.map((_, i) => (i === recipients.length - 1 ? base + (total - base * n) : base));

    const task = ledger.create(`Split ${formatUsdc(total)} USDC among ${recipients.length}`, 'split',
      { recipients, total, funder: from }, ['plan', 'deploy-escrows'], from);
    ledger.update(task.id, { status: 'awaiting-approval', plan: [`deploying ${recipients.length} escrows…`] });

    try {
      const legs = [];
      for (let i = 0; i < recipients.length; i++) {
        const dep = await settlement.deployUserEscrow({ funder: from, payee: recipients[i], amount: amounts[i], token: 'USDC' });
        legs.push({ escrow: dep.escrow, payee: recipients[i], amount: amounts[i].toString() });
      }
      ledger.update(task.id, { plan: [`${legs.length} escrows deployed; awaiting your signatures`] });
      return json(res, 200, { taskId: task.id, token: settlement.clientConfig?.().token, legs });
    } catch (e: any) {
      ledger.update(task.id, { status: 'failed', result: { ok: false, summary: 'split escrow deploy failed' } });
      return serverError(res, 'prepare-split', e);
    }
  }

  // Finalize a split leg after the user locked it: release + accrue fee, and
  // mark the whole split done once all legs are released.
  // Body: { taskId, escrow, amount, payee, legIndex, legCount }
  if (method === 'POST' && path === '/wallet/release-split') {
    if (!settlement.releaseUserEscrow) return json(res, 501, { error: 'wallet flow unavailable' });
    const body = await readBody(req);
    const taskId = String(body?.taskId ?? '');
    const escrow = String(body?.escrow ?? '');
    const amount = BigInt(normalizeAmount(body?.amount ?? '0'));
    const legIndex = Number(body?.legIndex ?? 0);
    const legCount = Number(body?.legCount ?? 0);
    if (!/^0x[a-fA-F0-9]{40}$/.test(escrow) || amount <= 0n) return json(res, 400, { error: 'escrow + amount required' });
    try {
      const rel = await settlement.releaseUserEscrow({ contract: escrow, amount, token: 'USDC' });
      if (taskId) {
        ledger.accrueFee(taskId, rel.fee);
        const last = legIndex + 1 >= legCount;
        ledger.update(taskId, last
          ? { status: 'done', result: { ok: true, summary: `Split settled across ${legCount} recipients (user-funded, non-custodial)`, txHash: rel.hash, fee: rel.fee } }
          : { status: 'running', plan: [`released leg ${legIndex + 1}/${legCount}`] });
      }
      return json(res, 200, { txHash: rel.hash, fee: rel.fee.toString() });
    } catch (e: any) {
      if (taskId) ledger.update(taskId, { status: 'failed', result: { ok: false, summary: 'split leg failed' } });
      return serverError(res, 'release-split', e);
    }
  }

  // Step 2: after the user has approved + locked from their wallet, release.
  // Body: { taskId, escrow, amount, payee }  ->  { txHash, status }
  if (method === 'POST' && path === '/wallet/release') {
    if (!settlement.releaseUserEscrow) return json(res, 501, { error: 'wallet flow unavailable' });
    const body = await readBody(req);
    const taskId = String(body?.taskId ?? '');
    const escrow = String(body?.escrow ?? '');
    const payee = String(body?.payee ?? '');
    const amount = BigInt(normalizeAmount(body?.amount ?? '0'));
    if (!/^0x[a-fA-F0-9]{40}$/.test(escrow) || amount <= 0n) return json(res, 400, { error: 'escrow + amount required' });

    if (taskId) ledger.update(taskId, { status: 'running', plan: ['funds locked; releasing after verification'] });
    try {
      const rel = await settlement.releaseUserEscrow({ contract: escrow, amount, token: 'USDC' });
      if (taskId) {
        ledger.accrueFee(taskId, rel.fee);
        ledger.update(taskId, {
          status: 'done',
          result: { ok: true, summary: `Settled ${formatUsdc(amount)} USDC to ${payee} (user-funded, non-custodial)`, txHash: rel.hash, fee: rel.fee },
        });
      }
      return json(res, 200, { txHash: rel.hash, status: 'done', fee: rel.fee.toString() });
    } catch (e: any) {
      if (taskId) ledger.update(taskId, { status: 'failed', result: { ok: false, summary: 'release failed' } });
      return serverError(res, 'release', e);
    }
  }

  // Recover a stuck/aborted escrow: agent calls refund(), funds return to funder.
  // Body: { escrow, taskId? }  ->  { txHash, refunded, funder }
  if (method === 'POST' && path === '/wallet/refund') {
    if (!settlement.refundUserEscrow) return json(res, 501, { error: 'wallet flow unavailable' });
    const body = await readBody(req);
    const escrow = String(body?.escrow ?? '');
    const taskId = String(body?.taskId ?? '');
    if (!/^0x[a-fA-F0-9]{40}$/.test(escrow)) return json(res, 400, { error: 'valid escrow address required' });
    try {
      const r = await settlement.refundUserEscrow({ contract: escrow, token: 'USDC' });
      if (taskId) ledger.update(taskId, { status: 'failed', result: { ok: false, summary: `Refunded ${r.refunded} to funder ${r.funder}`, txHash: r.hash } });
      return json(res, 200, { txHash: r.hash, refunded: r.refunded, funder: r.funder });
    } catch (e: any) {
      return serverError(res, 'refund', e);
    }
  }

  // ---- demo UI ----
  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(readFileSync(join(publicDir, 'index.html'), 'utf8'));
  }
  if (method === 'GET' && (path === '/app' || path === '/app.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(readFileSync(join(publicDir, 'app.html'), 'utf8'));
  }
  if (method === 'GET' && (path === '/docs' || path === '/docs.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(readFileSync(join(publicDir, 'docs.html'), 'utf8'));
  }
  // Human-friendly manifest viewer (the raw machine endpoint stays at /.well-known/asp.yaml).
  if (method === 'GET' && (path === '/identity' || path === '/manifest.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(readFileSync(join(publicDir, 'manifest.html'), 'utf8'));
  }
  // Pretty-printed, syntax-highlighted JSON view of the manifest (for developers).
  if (method === 'GET' && path === '/manifest.json.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(readFileSync(join(publicDir, 'manifest-json.html'), 'utf8'));
  }
  // Favicon — the coral Atlas mark. Browsers auto-request /favicon.ico too.
  if (method === 'GET' && (path === '/favicon.svg' || path === '/favicon.ico')) {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' });
    return res.end(readFileSync(join(publicDir, 'favicon.svg'), 'utf8'));
  }
  if (method === 'GET' && path === '/manifest') {
    return json(res, 200, asp.describe());
  }
  if (method === 'GET' && path === '/events') {
    // ?owner=0x… scopes the stream to that wallet; absent => the 'server' demo view.
    const q = new URL(req.url || '/', 'http://x').searchParams.get('owner') || 'server';
    const owner = /^0x[a-fA-F0-9]{40}$/.test(q) ? q.toLowerCase() : 'server';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    const client: Client = { res, owner };
    clients.add(client);
    for (const t of ledger.list()) sendTask(client, t); // backfill this owner's tasks
    req.on('close', () => clients.delete(client));
    return;
  }
  if (method === 'POST' && path === '/intent') {
    // Agent-funded path: gated behind DEMO_MODE. Without it, this route is closed
    // so an anonymous caller cannot spend the agent's funds (see audit C1). Users
    // spend their own funds through /wallet/* instead.
    if (!DEMO_MODE) {
      return json(res, 403, { error: 'agent-funded demo path disabled; connect a wallet to settle from your own funds' });
    }
    const { intent, owner } = await readBody(req);
    const who = typeof owner === 'string' && /^0x[a-fA-F0-9]{40}$/.test(owner) ? owner : 'server';
    if (intent) scheduler.submit(String(intent), who);
    return json(res, 202, { ok: true, mode: 'xlayer' });
  }

  res.writeHead(404);
  res.end();
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n[atlas] port ${PORT} is already in use — another Atlas server is likely still running.\n` +
        `  • pick a different port:  UI_PORT=4174 npm run asp\n` +
        `  • or stop the stale one:  npx kill-port ${PORT}   (or kill the node process on ${PORT})\n`,
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  const base = process.env.ASP_BASE_URL || `http://localhost:${PORT}`;
  console.log(`Atlas ASP  ->  ${base}`);
  console.log(`  manifest : ${base}/.well-known/asp.yaml`);
  console.log(`  run      : POST ${base}/asp/run   (${PAID ? 'x402 PAID' : 'free'})`);
  console.log(`  identity : ${HANDLE}  ${sig.publicKeyB64}`);
  console.log(`  mode     : REAL X Layer${PAID ? `  price: ${PRICE} ${TOKEN.symbol} base units` : ''}`);
});
