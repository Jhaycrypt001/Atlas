// Deploy + EXERCISE the real Escrow on a live EVM.
//   node scripts/deploy.mjs localhost        # against `npx hardhat node`
//   node scripts/deploy.mjs xlayerTestnet     # reads .env (PK, XLAYER_RPC, ...)
//
// ⚠ TESTNET / LOCAL ONLY — NEVER point this at X Layer mainnet (196).
// It deploys a counterfeit TestUSDC and mints to itself, and it hardcodes
// Hardhat test account #1 as treasury (line ~42) whose private key is public,
// so every fee sent there is stealable. For mainnet use scripts/deploy-mainnet.mjs,
// which deploys only Attestation and refuses known test accounts.
import 'dotenv/config';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';

const NETWORKS = {
  localhost: {
    url: 'http://127.0.0.1:8545',
    chainId: 31337,
    key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  },
  xlayerTestnet: {
    url: process.env.XLAYER_RPC || 'https://testrpc.xlayer.tech',
    chainId: Number(process.env.XLAYER_CHAIN_ID || 1952),
    key: process.env.PK,
  },
};

const which = process.argv[2] || 'localhost';
const net = NETWORKS[which];
if (!net) throw new Error(`unknown network ${which}`);
if (which === 'xlayerTestnet' && !net.key) throw new Error('set PK env for xlayerTestnet');

// Hard stop: this script deploys a fake USDC and pays fees to a public test key.
// Running it against mainnet would deploy a counterfeit token under your address
// and leak every fee. Use scripts/deploy-mainnet.mjs there.
if (net.chainId === 196) {
  console.error(
    '\nRefusing to run: this is the TESTNET exercise script (deploys counterfeit TestUSDC,\n' +
      'mints to itself, and uses a publicly-known Hardhat key as treasury).\n' +
      'For X Layer mainnet use:  node scripts/deploy-mainnet.mjs\n',
  );
  process.exit(1);
}

const chain = {
  id: net.chainId,
  name: which,
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: [net.url] } },
};
const artifact = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url)));
const erc20 = artifact('TestUSDC');
const escrow = artifact('Escrow');

const account = privateKeyToAccount(net.key);
const account1 = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const publicClient = createPublicClient({ chain, transport: http(net.url) });
const wallet = createWalletClient({ chain, transport: http(net.url), account });

const wait = async (h) => publicClient.waitForTransactionReceipt({ hash: h });
const balance = (token, who) =>
  publicClient.readContract({ address: token, abi: erc20.abi, functionName: 'balanceOf', args: [who] });

async function main() {
  console.log(`\n=== Atlas escrow exercise on ${which} (chain ${net.chainId}) ===`);
  console.log('agent   :', account.address);
  console.log('treasury:', account1.address);

  // 1) deploy test USDC
  const usdcHash = await wallet.deployContract({
    abi: erc20.abi,
    bytecode: erc20.bytecode,
    args: [],
    account,
    chain,
  });
  const usdcR = await wait(usdcHash);
  const usdc = usdcR.contractAddress;
  console.log('TestUSDC deployed:', usdc, '| tx', usdcHash);

  const AMOUNT = 200_000_000n; // 200 USDC (6dp)
  const FEE_BPS = 50n; // 0.5%

  // 2) mint + approve
  await wait(await wallet.writeContract({ address: usdc, abi: erc20.abi, functionName: 'mint', args: [account.address, AMOUNT * 2n], account, chain }));
  console.log('minted', AMOUNT * 2n, 'to agent');

  // 3) deploy escrow (payee = agent, treasury = account1)
  const escHash = await wallet.deployContract({
    abi: escrow.abi,
    bytecode: escrow.bytecode,
    args: [account.address, usdc, AMOUNT, FEE_BPS, account1.address],
    account,
    chain,
  });
  const esc = (await wait(escHash)).contractAddress;
  console.log('Escrow deployed  :', esc, '| tx', escHash);

  // 4) lock: agent approves + escrow pulls funds
  await wait(await wallet.writeContract({ address: usdc, abi: erc20.abi, functionName: 'approve', args: [esc, AMOUNT], account, chain }));
  const lockHash = await wallet.writeContract({ address: esc, abi: escrow.abi, functionName: 'lock', args: [], account, chain });
  await wait(lockHash);
  console.log('lock() tx        :', lockHash, '(agent -> escrow, non-custodial)');

  // 5) release: payee gets amount-fee, treasury gets fee
  const beforePayee = await balance(usdc, account.address);
  const beforeTreas = await balance(usdc, account1.address);
  const relHash = await wallet.writeContract({ address: esc, abi: escrow.abi, functionName: 'release', args: [], account, chain });
  await wait(relHash);
  const afterPayee = await balance(usdc, account.address);
  const afterTreas = await balance(usdc, account1.address);
  console.log('release() tx     :', relHash);
  console.log(`  payee   +${afterPayee - beforePayee} (expect ${AMOUNT - (AMOUNT * FEE_BPS) / 10000n})`);
  console.log(`  treasury+${afterTreas - beforeTreas} (expect ${(AMOUNT * FEE_BPS) / 10000n})`);

  // 6) refund path on a second escrow
  const esc2 = (await wait(await wallet.deployContract({ abi: escrow.abi, bytecode: escrow.bytecode, args: [account.address, usdc, AMOUNT, FEE_BPS, account1.address], account, chain }))).contractAddress;
  await wait(await wallet.writeContract({ address: usdc, abi: erc20.abi, functionName: 'approve', args: [esc2, AMOUNT], account, chain }));
  await wait(await wallet.writeContract({ address: esc2, abi: escrow.abi, functionName: 'lock', args: [], account, chain }));
  const balBefore = await balance(usdc, account.address);
  const refHash = await wallet.writeContract({ address: esc2, abi: escrow.abi, functionName: 'refund', args: [], account, chain });
  await wait(refHash);
  const balAfter = await balance(usdc, account.address);
  console.log('refund() tx      :', refHash, '| agent recovered', balAfter - balBefore);

  console.log('\nDONE — real non-custodial escrow verified on EVM.');
}

main().catch((e) => {
  console.error('FAILED:', e.shortMessage || e.message);
  process.exit(1);
});
