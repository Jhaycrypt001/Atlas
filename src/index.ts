import { Ledger } from './kernel/ledger';
import { Safety } from './kernel/safety';
import { Settlement } from './kernel/settlement';
import { XLayerSettlement } from './kernel/xlayer';
import { Planner } from './kernel/planner';
import { llmPlanner } from './kernel/llm';
import { Scheduler } from './kernel/scheduler';
import { AspAdapter, AspSig, buildManifest } from './kernel/asp';
import { Capability } from './kernel/types';
import { PayCapability } from './capabilities/pay';
import { GetPaidCapability } from './capabilities/getPaid';
import { SplitCapability } from './capabilities/split';
import { VerifyCapability } from './capabilities/verify';

export interface BuildOpts {
  settlement?: Settlement;
  llm?: (text: string) => Promise<any>;
  sig?: AspSig;
}

/**
 * Refuse to run the real money path with TLS certificate verification disabled.
 * NODE_TLS_REJECT_UNAUTHORIZED=0 makes every HTTPS call (RPC, LLM API,x402
 * settlement) trust any certificate — unacceptable for an agent that moves
 * funds. This is fail-closed: set ALLOW_INSECURE_TLS=1 to override on a throwaway
 * testnet only. It is never safe on mainnet.
 */
function assertTlsSecure(): void {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' && process.env.ALLOW_INSECURE_TLS !== '1') {
    throw new Error(
      'Refusing to start: NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS certificate ' +
        'verification for all HTTPS (RPC, LLM API,settlement). Unset it, or set ' +
        'ALLOW_INSECURE_TLS=1 to override on a disposable testnet only.',
    );
  }
}

/**
 * Mainnet footguns are fatal. On X Layer mainnet (196) refuse to start if the
 * config still points at the testnet mintable TestUSDC, or if the insecure-TLS
 * or agent-funded demo overrides are on — all of which are safe on testnet but
 * dangerous with real funds.
 */
const TESTNET_USDC = '0x732cec1df06a48c596408ab1d95ee109a3179364';
/** Canonical USDC on X Layer mainnet (okx/xlayer-tokenlist; EIP-3009 capable). */
const MAINNET_USDC = '0x74b7f16337b8972027f6196a17a631ac6de26d22';
function assertMainnetSafe(): void {
  if (Number(process.env.XLAYER_CHAIN_ID || 1952) !== 196) return; // testnet — skip
  const usdc = (process.env.XLAYER_USDC || '').toLowerCase();
  if (usdc === TESTNET_USDC) {
    throw new Error('Refusing to start on mainnet with the testnet TestUSDC address. Set XLAYER_USDC to the canonical USDC on X Layer mainnet.');
  }
  if (process.env.ALLOW_INSECURE_TLS === '1') {
    throw new Error('ALLOW_INSECURE_TLS must be off on mainnet — serve over real HTTPS.');
  }
  if (process.env.DEMO_MODE === '1' || process.env.DEMO_MODE === 'true') {
    throw new Error('DEMO_MODE (agent-funded, unauthenticated /intent) must be off on mainnet.');
  }
  // The x402 EIP-3009 domain is the TOKEN's own EIP-712 domain. If name/version
  // don't match the deployed contract the domain separator differs and EVERY
  // payment signature silently fails to verify — fail loudly at boot instead.
  // Canonical USDC on X Layer mainnet reports name="USD Coin", version="2".
  if (usdc === MAINNET_USDC) {
    const name = process.env.XLAYER_USDC_NAME || 'USD Coin';
    const version = process.env.XLAYER_USDC_VERSION || '2';
    if (name !== 'USD Coin' || version !== '2') {
      throw new Error(
        `x402 token EIP-712 domain mismatch: canonical USDC on X Layer mainnet is ` +
          `name="USD Coin" version="2", but config says name="${name}" version="${version}". ` +
          `Every payment signature would be rejected. Fix XLAYER_USDC_NAME / XLAYER_USDC_VERSION.`,
      );
    }
  }
}

/**
 * Wires the minimal kernel + capability plugins into one ASP.
 * Add a capability by appending to `caps` — core untouched.
 * Settlement is real X Layer only: requires PK + XLAYER_* in .env.
 */
export function buildAgent(opts: BuildOpts = {}) {
  assertTlsSecure();
  assertMainnetSafe();
  const ledger = new Ledger();
  const safety = new Safety();
  const settlement = opts.settlement ?? new XLayerSettlement();
  const caps: Capability[] = [
    PayCapability,
    GetPaidCapability,
    SplitCapability,
    VerifyCapability,
  ];
  const capMap = new Map(caps.map((c) => [c.name, c]));
  const planner = new Planner(caps, opts.llm ?? ((process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY) ? llmPlanner : undefined));
  const scheduler = new Scheduler(ledger, safety, settlement, planner, capMap, 4);

  // asp/1.0 identity: Ed25519 signer (ASP-Sig) + discoverable manifest.
  const sig = opts.sig ?? AspSig.loadOrCreateKey();
  const manifest = buildManifest({
    name: 'Atlas',
    tagline:
      'Concurrent on-chain operations agent. Pay, Get Paid, Split, and Verify, verifiably.',
    category: 'Finance Copilot / Software Services',
    services: caps.map((c) => ({
      name: c.name,
      description: c.description,
      risk: c.risk,
      examples: c.examples,
    })),
    handle: process.env.ASP_HANDLE || 'atlas',
    baseUrl: process.env.ASP_BASE_URL || `http://localhost:${process.env.UI_PORT || 4173}`,
    publicKey: sig.publicKeyB64,
  });

  const asp = new AspAdapter(manifest, async (input: any) =>
    scheduler.submit(input?.intent ?? input?.text ?? ''),
  );

  return { ledger, scheduler, asp, settlement, caps: capMap, sig, planner };
}
