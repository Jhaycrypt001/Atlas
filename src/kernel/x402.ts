/**
 * x402 pay-per-call billing for the Atlas ASP (OKX Onchain OS model).
 *
 * A paid endpoint answers an unauthenticated-by-payment call with
 * `402 Payment Required` carrying a payment challenge (network, token, amount,
 * recipient). The client signs an EIP-3009-style authorization and replays the
 * request with a `PAYMENT-SIGNATURE` header; the server recovers the payer,
 * checks amount/recipient/network, then executes. Settlement on X Layer sits in
 * escrow and is released after confirmation (mirrored by the kernel's fee skim).
 *
 * Free mode (no `ASP_PAID`) skips the 402 entirely — OKX allows free endpoints.
 */
import crypto from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData, type Hex } from 'viem';

// Chain the x402 payment layer advertises. Env-driven so the same code serves
// X Layer testnet (1952) or mainnet (196) — OKX.AI requires eip155:196 for
// listing. Set XLAYER_CHAIN_ID=196 in .env to go to mainnet.
export const X402_CHAIN_ID = Number(process.env.XLAYER_CHAIN_ID || 1952);

export interface PaymentRequirements {
  scheme: 'exact';
  network: `eip155:${number}`;
  token: { address: string; symbol: string; decimals: number };
  amount: string; // base units (string to stay JSON-safe)
  recipient: string; // treasury / agent fee wallet
  payer?: string;
}

export interface X402Challenge {
  x402Version: 1 | 2;
  resource: string;
  accepts: PaymentRequirements[];
}

// EIP-3009 / x402 'exact' typed data. The buyer authorizes a one-time transfer
// to the recipient (treasury); the agent settles against X Layer escrow.
const X402_DOMAIN = { name: 'X402', version: '1', chainId: X402_CHAIN_ID } as const;
const X402_TYPES = {
  Transfer: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export function challenge(
  resource: string,
  o: { token: PaymentRequirements['token']; amount: string; recipient: string },
): X402Challenge {
  return {
    x402Version: 1,
    resource,
    accepts: [
      {
        scheme: 'exact',
        network: `eip155:${X402_CHAIN_ID}`,
        token: o.token,
        amount: o.amount,
        recipient: o.recipient,
      },
    ],
  };
}

export interface VerifiedPayment {
  payer: string;
}

/** Recover + validate a `PAYMENT-SIGNATURE` header against the challenge. */
export async function verifyPayment(
  header: string | undefined,
  expected: { recipient: string; amount: string; token: string; resource: string },
): Promise<VerifiedPayment> {
  if (!header) throw new Error('missing PAYMENT-SIGNATURE');
  let proof: any;
  try {
    proof = JSON.parse(header);
  } catch {
    throw new Error('bad PAYMENT-SIGNATURE (not JSON)');
  }
  const { from, signature, message, domain, types, primaryType } = proof;
  if (!from || !signature || !message) throw new Error('incomplete PAYMENT-SIGNATURE');

  const valid = await verifyTypedData({
    address: from as Hex,
    domain: domain ?? X402_DOMAIN,
    types: types ?? X402_TYPES,
    primaryType: primaryType ?? 'Transfer',
    message: {
      ...message,
      value: BigInt(message.value),
      validAfter: BigInt(message.validAfter ?? 0),
      validBefore: BigInt(message.validBefore ?? 0),
    },
    signature: signature as Hex,
  });
  if (!valid) throw new Error('invalid PAYMENT-SIGNATURE');

  if (String(message.to).toLowerCase() !== expected.recipient.toLowerCase())
    throw new Error('payment recipient mismatch');
  if (String(message.value) !== expected.amount) throw new Error('payment amount mismatch');
  if ((message as any).__resource && (message as any).__resource !== expected.resource)
    throw new Error('payment resource mismatch');

  return { payer: from };
}

/**
 * Offline demo/x402 client: sign a challenge to produce a valid
 * `PAYMENT-SIGNATURE` header. Used by the conformance test + walkthrough.
 */
export async function signChallenge(
  c: X402Challenge,
  pk: Hex,
): Promise<{ header: string; proof: unknown }> {
  const req = c.accepts[0];
  const account = privateKeyToAccount(pk);
  const message = {
    to: req.recipient,
    value: BigInt(req.amount),
    validAfter: 0n,
    validBefore: (2n ** 64n - 1n) as bigint,
    nonce: ('0x' + crypto.randomBytes(32).toString('hex')) as Hex,
    __resource: c.resource,
  };
  const signature = await account.signTypedData({
    domain: X402_DOMAIN,
    types: X402_TYPES,
    primaryType: 'Transfer',
    message: message as any,
  });
  const proof = {
    from: account.address,
    signature,
    domain: X402_DOMAIN,
    types: X402_TYPES,
    primaryType: 'Transfer',
    // value/validBefore must be JSON-safe strings; verifyPayment re-hydrates them.
    message: { ...message, value: message.value.toString(), validAfter: '0', validBefore: message.validBefore.toString() },
  };
  return { header: JSON.stringify(proof), proof };
}

/** Settlement proof returned in the `PAYMENT-RESPONSE` header after a paid run. */
export function paymentResponseHeader(ref: {
  payer: string;
  amount: string;
  token: string;
  txHash?: string;
}): string {
  return JSON.stringify({
    x402Version: 1,
    network: `eip155:${X402_CHAIN_ID}`,
    payer: ref.payer,
    amount: ref.amount,
    token: ref.token,
    transaction: ref.txHash ?? null,
    settled: ref.txHash ? 'xlayer-escrow' : 'offline',
  });
}
