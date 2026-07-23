/**
 * Atlas — X Layer MAINNET (chain 196) deployment.
 *
 *   node scripts/deploy-mainnet.mjs           # dry run: preflight only, no tx
 *   node scripts/deploy-mainnet.mjs --execute # actually deploy (spends real OKB)
 *
 * Deploys ONLY the Attestation registry — the one persistent singleton Atlas
 * needs on-chain. It deliberately does NOT:
 *   - deploy TestUSDC (that is a counterfeit token; mainnet uses canonical USDC)
 *   - mint anything
 *   - deploy an Escrow (Escrow is per-task: its constructor bakes in
 *     funder/payee/amount, and the agent deploys a fresh one per settlement at
 *     runtime — see src/kernel/xlayer.ts deployUserEscrow)
 *   - run a lock/release/refund "exercise" with real funds
 *
 * scripts/deploy.mjs is the TESTNET exercise script and must never be pointed at
 * mainnet: it deploys a fake USDC, mints to itself, and hardcodes a well-known
 * Hardhat test account as treasury (its private key is public).
 */
import 'dotenv/config';
import { createPublicClient, createWalletClient, http, formatEther, formatUnits, isAddress, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const EXECUTE = process.argv.includes('--execute');

const CHAIN_ID = 196;
const RPC = process.env.XLAYER_RPC || 'https://rpc.xlayer.tech';
/** Canonical USDC on X Layer mainnet (okx/xlayer-tokenlist; EIP-3009 capable). */
const CANONICAL_USDC = '0x74b7F16337b8972027F6196A17a631aC6dE26d22';

/**
 * Publicly-known test private keys (Hardhat / Anvil default accounts). Anyone
 * can spend from these, so a treasury set to one of them leaks every fee.
 * Lowercased for comparison.
 */
const KNOWN_TEST_ACCOUNTS = new Set([
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', // hardhat #0
  '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', // hardhat #1  <- current testnet treasury
  '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc', // hardhat #2
  '0x90f79bf6eb2c4f870365e785982e1f101e93b906', // hardhat #3
  '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65', // hardhat #4
  '0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc', // hardhat #5
]);

const chain = {
  id: CHAIN_ID,
  name: 'X Layer Mainnet',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: 'OKLink', url: 'https://www.oklink.com/xlayer' } },
};

const artifact = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url)));

const fail = (msg) => {
  console.error(`\n  \x1b[31mBLOCKED\x1b[0m ${msg}\n`);
  process.exit(1);
};
const ok = (label, detail = '') => console.log(`  \x1b[32mOK\x1b[0m   ${label}${detail ? ` — ${detail}` : ''}`);
const warn = (label) => console.log(`  \x1b[33mWARN\x1b[0m ${label}`);

console.log(`\n=== Atlas mainnet deployment — X Layer (chain ${CHAIN_ID}) ===`);
console.log(EXECUTE ? '\x1b[33mMODE: EXECUTE — this will spend real OKB\x1b[0m\n' : 'MODE: dry run (preflight only; pass --execute to deploy)\n');

// A local .env still holding testnet values is the easiest way to ship the wrong
// config to mainnet: dotenv fills in blanks you thought were unset. Say so.
if (existsSync(new URL('../.env', import.meta.url))) {
  const envChain = process.env.XLAYER_CHAIN_ID;
  if (envChain && Number(envChain) !== CHAIN_ID) {
    warn(`.env has XLAYER_CHAIN_ID=${envChain} (not ${CHAIN_ID}) — its values are loaded here.`);
    warn('Every unset variable below is being filled from that testnet .env. Check each one.');
  }
}

// ---- preflight -------------------------------------------------------------
console.log('preflight');

if (!process.env.PK) fail('PK is not set. Export the funded mainnet deployer key.');
let account;
try {
  account = privateKeyToAccount(process.env.PK);
} catch {
  fail('PK is not a valid private key.');
}
ok('deployer key parsed', account.address);

// Treasury: where the 0.5% fee lands on every release. Must be real and owned.
const treasuryRaw = process.env.XLAYER_TREASURY;
if (!treasuryRaw) fail('XLAYER_TREASURY is not set. This is where your fees are paid — set it to a wallet you control.');
if (!isAddress(treasuryRaw)) fail(`XLAYER_TREASURY is not a valid address: ${treasuryRaw}`);
const treasury = getAddress(treasuryRaw);
if (KNOWN_TEST_ACCOUNTS.has(treasury.toLowerCase())) {
  fail(
    `XLAYER_TREASURY (${treasury}) is a PUBLICLY-KNOWN test account.\n` +
      `           Its private key ships in Hardhat/Anvil docs — anyone could take every fee\n` +
      `           sent there. Set it to a wallet whose key only you hold.`,
  );
}
if (treasury === '0x0000000000000000000000000000000000000000') fail('XLAYER_TREASURY is the zero address.');
ok('treasury is a real, non-test address', treasury);
if (treasury.toLowerCase() === account.address.toLowerCase()) {
  warn('treasury == deployer. Valid, but fees and the hot agent key share one wallet.');
}

// Token sanity: mainnet must use canonical USDC, never the counterfeit TestUSDC.
const usdc = process.env.XLAYER_USDC;
if (!usdc) fail(`XLAYER_USDC is not set. On mainnet it must be ${CANONICAL_USDC}`);
if (getAddress(usdc) !== getAddress(CANONICAL_USDC)) {
  fail(
    `XLAYER_USDC is ${usdc}, expected canonical USDC ${CANONICAL_USDC}.\n` +
      `           Deploying against a non-canonical token means your agent settles in a\n` +
      `           token buyers do not hold. If this is deliberate, edit CANONICAL_USDC.`,
  );
}
ok('XLAYER_USDC is canonical USDC', CANONICAL_USDC);

// Safety switches that must be off with real funds.
if (process.env.ALLOW_INSECURE_TLS === '1') fail('ALLOW_INSECURE_TLS=1 — TLS verification must be on for mainnet.');
if (process.env.DEMO_MODE === '1' || process.env.DEMO_MODE === 'true') {
  fail('DEMO_MODE=1 — the unauthenticated agent-funded path must be off on mainnet.');
}
ok('safety switches off', 'ALLOW_INSECURE_TLS=0, DEMO_MODE=0');

const publicClient = createPublicClient({ chain, transport: http(RPC) });

// Chain identity — never deploy to the wrong network.
const liveChainId = await publicClient.getChainId();
if (liveChainId !== CHAIN_ID) fail(`RPC ${RPC} reports chain ${liveChainId}, expected ${CHAIN_ID}.`);
ok('RPC reachable and on chain 196', RPC);

// The token must actually exist and support EIP-3009 (x402 'exact' needs it).
const usdcCode = await publicClient.getBytecode({ address: CANONICAL_USDC });
if (!usdcCode || usdcCode === '0x') fail(`No contract at ${CANONICAL_USDC} on chain ${CHAIN_ID}.`);
try {
  const [tName, tVersion] = await Promise.all([
    publicClient.readContract({ address: CANONICAL_USDC, abi: [{ name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }], functionName: 'name' }),
    publicClient.readContract({ address: CANONICAL_USDC, abi: [{ name: 'version', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }], functionName: 'version' }),
  ]);
  await publicClient.readContract({
    address: CANONICAL_USDC,
    abi: [{ name: 'TRANSFER_WITH_AUTHORIZATION_TYPEHASH', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] }],
    functionName: 'TRANSFER_WITH_AUTHORIZATION_TYPEHASH',
  });
  ok('USDC supports EIP-3009', `name="${tName}" version="${tVersion}"`);

  // The x402 EIP-712 domain must match the token exactly or every payment fails.
  const cfgName = process.env.XLAYER_USDC_NAME || 'USD Coin';
  const cfgVersion = process.env.XLAYER_USDC_VERSION || '2';
  if (cfgName !== tName || cfgVersion !== tVersion) {
    fail(
      `x402 token domain mismatch: contract says name="${tName}" version="${tVersion}",\n` +
        `           config says name="${cfgName}" version="${cfgVersion}". Every payment\n` +
        `           signature would be rejected. Fix XLAYER_USDC_NAME / XLAYER_USDC_VERSION.`,
    );
  }
  ok('x402 EIP-712 domain matches the token', `name="${cfgName}" version="${cfgVersion}"`);
} catch (e) {
  fail(`USDC at ${CANONICAL_USDC} failed EIP-3009 checks: ${e.shortMessage || e.message}`);
}

// Gas.
const att = artifact('Attestation');
const balance = await publicClient.getBalance({ address: account.address });
const gasPrice = await publicClient.getGasPrice();
let gasEstimate;
try {
  gasEstimate = await publicClient.estimateGas({
    account,
    data: att.bytecode.startsWith('0x') ? att.bytecode : `0x${att.bytecode}`,
  });
} catch {
  gasEstimate = 700_000n; // conservative fallback if estimation is unavailable
}
const cost = gasEstimate * gasPrice;
console.log(`  ..   balance ${formatEther(balance)} OKB · gas ${gasEstimate} @ ${formatUnits(gasPrice, 9)} gwei · est. cost ${formatEther(cost)} OKB`);
if (balance === 0n) {
  fail(`Deployer ${account.address} has 0 OKB on chain ${CHAIN_ID}. Bridge OKB for gas before deploying.`);
}
// Require a 2x buffer so a gas-price bump mid-flight can't strand the deploy.
if (balance < cost * 2n) {
  fail(`Insufficient OKB: have ${formatEther(balance)}, want >= ${formatEther(cost * 2n)} (2x est. cost as buffer).`);
}
ok('deployer funded', `${formatEther(balance)} OKB`);

// Don't silently redeploy over a good existing registry.
const outPath = new URL('../deployments/mainnet-196.json', import.meta.url);
if (existsSync(outPath)) {
  const prev = JSON.parse(readFileSync(outPath, 'utf8'));
  const prevAddr = prev?.contracts?.Attestation?.address;
  if (prevAddr) {
    const code = await publicClient.getBytecode({ address: prevAddr });
    if (code && code !== '0x') {
      warn(`Attestation already deployed at ${prevAddr} (deployments/mainnet-196.json).`);
      warn('Redeploying creates a SECOND registry; prior attestations stay at the old address.');
      if (!process.argv.includes('--force')) {
        fail('Refusing to redeploy. Pass --force if a fresh registry is genuinely intended.');
      }
    }
  }
}

console.log('\n  all preflight checks passed');

if (!EXECUTE) {
  console.log('\nDry run complete — nothing was sent.');
  console.log('Re-run with --execute to deploy Attestation to X Layer mainnet.\n');
  process.exit(0);
}

// ---- deploy ----------------------------------------------------------------
console.log('\ndeploy');
const wallet = createWalletClient({ chain, transport: http(RPC), account });

const hash = await wallet.deployContract({ abi: att.abi, bytecode: att.bytecode, args: [], account, chain });
console.log(`  ..   Attestation tx ${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== 'success') fail(`Deployment reverted (tx ${hash}).`);
const attestation = receipt.contractAddress;
ok('Attestation deployed', attestation);
console.log(`  ..   gas used ${receipt.gasUsed} · block ${receipt.blockNumber}`);

// Verify it answers a read call before declaring success.
const count = await publicClient.readContract({ address: attestation, abi: att.abi, functionName: 'count' });
ok('registry responds to count()', String(count));

const record = {
  network: 'X Layer Mainnet',
  chainId: CHAIN_ID,
  rpc: RPC,
  deployedAt: new Date().toISOString().slice(0, 10),
  agent: account.address,
  treasury,
  usdc: CANONICAL_USDC,
  contracts: {
    Attestation: { address: attestation, deployTx: hash, block: Number(receipt.blockNumber), gasUsed: String(receipt.gasUsed) },
  },
  note: 'Escrow is deployed per-settlement at runtime (constructor binds funder/payee/amount), so it has no singleton address. USDC is canonical X Layer USDC, not deployed by us.',
};
writeFileSync(outPath, JSON.stringify(record, null, 2) + '\n');
ok('wrote deployments/mainnet-196.json');

console.log(`\n\x1b[32mDONE\x1b[0m — set this in your environment (e.g. Render):\n`);
console.log(`  XLAYER_ATTESTATION=${attestation}\n`);
console.log(`  explorer: https://www.oklink.com/xlayer/address/${attestation}\n`);
