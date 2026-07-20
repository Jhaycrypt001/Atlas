import 'dotenv/config';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.XLAYER_RPC || 'https://rpc.xlayer.tech';
const CHAIN_ID = Number(process.env.XLAYER_CHAIN_ID || 195);
const pk = process.env.PK;

if (!pk || pk.includes('PASTE')) {
  console.log('NO VALID PK IN .env');
  process.exit(1);
}

const client = createPublicClient({
  chain: { id: CHAIN_ID, name: 'x', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } },
  transport: http(RPC),
});

const acct = privateKeyToAccount(pk);
const chainId = await client.getChainId();
const bal = await client.getBalance({ address: acct.address });
console.log('RPC              :', RPC);
console.log('expected chainId :', CHAIN_ID);
console.log('actual chainId   :', chainId, chainId === CHAIN_ID ? 'OK' : '*** MISMATCH ***');
console.log('agent address    :', acct.address);
console.log('native balance   :', bal.toString(), 'wei');
