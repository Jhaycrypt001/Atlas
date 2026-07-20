// Compile all contracts in contracts/ with solc 0.8.24 -> artifacts/<Name>.json
import solc from 'solc';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const contractsDir = join(root, 'contracts');
const outDir = join(root, 'artifacts');
mkdirSync(outDir, { recursive: true });

const sources = {};
for (const f of readdirSync(contractsDir)) {
  if (f.endsWith('.sol')) sources[f] = { content: readFileSync(join(contractsDir, f), 'utf8') };
}

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
if (out.errors) {
  const fatal = out.errors.filter((e) => e.severity === 'error');
  out.errors.forEach((e) => console.log(e.formattedMessage));
  if (fatal.length) process.exit(1);
}

let count = 0;
for (const file of Object.keys(out.contracts)) {
  for (const name of Object.keys(out.contracts[file])) {
    const c = out.contracts[file][name];
    writeFileSync(
      join(outDir, `${name}.json`),
      JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2),
    );
    console.log(`compiled ${name} -> artifacts/${name}.json`);
    count++;
  }
}
console.log(`OK: ${count} contract(s) compiled.`);
