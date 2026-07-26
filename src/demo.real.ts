// REAL end-to-end agent run on X Layer testnet.
// Proves the agent (planner -> scheduler -> capability -> real escrow) executes
// concurrent on-chain transactions.
// Requires .env: PK (funded), XLAYER_RPC, XLAYER_CHAIN_ID=196, XLAYER_USDC.
import 'dotenv/config';
import { buildAgent } from './index';

const PAYEE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const { ledger, scheduler, asp, settlement } = buildAgent();

ledger.on((t) => {
  const tag = t.result?.ok === false ? 'FAIL' : t.status.toUpperCase();
  console.log(`[${tag}] ${t.id} :: ${t.capability} :: ${t.result?.summary ?? t.intent} :: tx ${t.result?.txHash ?? ''}`);
});

console.log(`\n=== Atlas REAL run on X Layer (mode=${settlement.mode}) ===`);
console.log('agent:', asp.describe().agent.name);

const intents = [
  `Pay ${PAYEE} 200 USDC for the logo`,
  `Verify deliverable, release 150 USDC to ${PAYEE}`,
  `Verify attestation release 150 USDC to ${PAYEE}`,
  `Invoice ${PAYEE} 500 USDC for consulting`,
];
console.log(`Submitting ${intents.length} CONCURRENT REAL tasks...\n`);
// Top up the agent's test tokens so repeatable demos don't drain its balance.
await settlement.faucet?.(2_000_000_000n);
intents.forEach((i) => scheduler.submit(i));

// Wait until every task reaches a terminal state (done/failed) before printing
// the summary — a fixed sleep would report fee=0 while transactions are still
// confirming on-chain. Capped by a timeout so a stuck task can't hang the demo.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(['done', 'failed']);
const deadline = Date.now() + 120_000; // 2-minute safety cap
while (Date.now() < deadline) {
  const tasks = ledger.list();
  if (tasks.length >= intents.length && tasks.every((t) => TERMINAL.has(t.status))) break;
  await sleep(1000);
}
const unfinished = ledger.list().filter((t) => !TERMINAL.has(t.status));
if (unfinished.length) {
  console.log(`\n! ${unfinished.length} task(s) did not finish within the timeout: ${unfinished.map((t) => t.id).join(', ')}`);
}

console.log('\n=== LIVE LEDGER (real on-chain) ===');
for (const t of ledger.list()) {
  console.log(`${t.id} | ${t.status.padEnd(7)} | ${t.capability.padEnd(9)} | fee=${t.feesAccrued} | tx=${t.result?.txHash ?? ''}`);
}
console.log('\nTOTAL FEES ACCRUED (provable revenue):', settlement.totalFees());
console.log('DONE — agent executed real X Layer transactions.');
