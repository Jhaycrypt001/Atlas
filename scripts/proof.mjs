// Deploy (if needed) the on-chain Attestation contract and record a sample
// attestation, proving the attestation proof path on X Layer.
//   node scripts/proof.mjs
import 'dotenv/config';
import { createPublicClient, createWalletClient, http, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';

const RPC = process.env.XLAYER_RPC || 'https://testrpc.xlayer.tech';
const CHAIN = Number(process.env.XLAYER_CHAIN_ID || 1952);
const PK = process.env.PK;
if (!PK || PK.includes('PASTE')) {
  console.log('NO VALID PK IN .env');
  process.exit(1);
}
const account = privateKeyToAccount(PK);
const chain = { id: CHAIN, name: 'X Layer', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const client = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ chain, transport: http(RPC), account });

const artifact = JSON.parse(readFileSync(new URL('../artifacts/Attestation.json', import.meta.url)));

let addr = process.env.XLAYER_ATTESTATION;
if (!addr || addr === '0x0000000000000000000000000000000000000000') {
  const h = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [], account, chain });
  const r = await client.waitForTransactionReceipt({ hash: h });
  addr = r.contractAddress;
  console.log('Attestation deployed:', addr, '| tx', h);
} else {
  console.log('Attestation (existing):', addr);
}

const proofHash = keccak256(toHex('delivery confirmed: logo v1'));
const ah = await wallet.writeContract({ address: addr, abi: artifact.abi, functionName: 'attest', args: [account.address, proofHash], account, chain });
await client.waitForTransactionReceipt({ hash: ah });
console.log('Sample attestation recorded on-chain:', ah);
console.log(`\nSet XLAYER_ATTESTATION=${addr} in .env to enable the attestation proof adapter.`);
