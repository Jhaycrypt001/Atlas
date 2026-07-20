import { createPublicClient, http } from 'viem';
const cands = [
  ['rpc.xlayer.tech', 'https://rpc.xlayer.tech'],
  ['testrpc.xlayer.tech', 'https://testrpc.xlayer.tech'],
  ['xlayertestrpc.okx.com', 'https://xlayertestrpc.okx.com'],
  ['testnet-rpc.xlayer.tech', 'https://testnet-rpc.xlayer.tech'],
  ['rpc.xlayer.dev', 'https://rpc.xlayer.dev'],
];
for (const [name, url] of cands) {
  try {
    const c = createPublicClient({ chain:{id:1,name:'x',nativeCurrency:{name:'OKB',symbol:'OKB',decimals:18},rpcUrls:{default:{http:[url]}}}, transport: http(url, { timeout: 5000 }) });
    const id = await c.getChainId();
    console.log(name.padEnd(22), '-> chainId', id);
  } catch (e) { console.log(name.padEnd(22), '-> ERR', String(e.message).slice(0,50)); }
}
