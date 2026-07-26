/**
 * x402 pay-per-call billing for the Atlas ASP (OKX Onchain OS model).
 *
 * A paid endpoint answers an unpaid call with `402 Payment Required` carrying a
 * `PaymentRequirementsResponse` (x402Version + error + accepts[]). The client
 * signs an EIP-3009 `TransferWithAuthorization` and replays the request with a
 * base64 `X-PAYMENT` header; the server recovers the payer, checks
 * amount/recipient/network/deadline, then executes and answers with a base64
 * `X-PAYMENT-RESPONSE` settlement header.
 *
 * Wire format follows the x402 v1 HTTP transport (specs/transports-v1/http.md)
 * and the `exact` scheme on EVM (specs/schemes/exact/scheme_exact_evm.md):
 *   - accepts[] keys are `maxAmountRequired` / `asset` / `payTo` (NOT
 *     amount/token/recipient), plus resource/description/mimeType/
 *     outputSchema/maxTimeoutSeconds/extra.
 *   - EIP-712 domain for EIP-3009 is the TOKEN's own domain: {name, version}
 *     from `extra`, chainId, verifyingContract = the token address.
 *
 * Free mode (no `ASP_PAID`) skips the 402 entirely — OKX allows free endpoints.
 */
import crypto from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData, type Hex } from 'viem';

// Chain the x402 payment layer advertises. Defaults to X Layer mainnet (196),
// which OKX.AI requires (eip155:196) for listing. Env-overridable for testnet.
export const X402_CHAIN_ID = Number(process.env.XLAYER_CHAIN_ID || 196);

/** CAIP-2 network id, e.g. `eip155:196` for X Layer mainnet. */
export const X402_NETWORK = `eip155:${X402_CHAIN_ID}` as const;

/** How long a signed authorization stays valid (seconds). */
export const MAX_TIMEOUT_SECONDS = Number(process.env.ASP_PAY_TIMEOUT || 60);

/**
 * EIP-712 domain metadata for the payment token, surfaced in `accepts[].extra`
 * so the client can rebuild the exact domain it must sign over. These MUST equal
 * the token contract's own EIP-712 `name`/`version` — a mismatch changes the
 * domain separator and every payment signature is rejected.
 *
 * Canonical USDC on X Layer mainnet reports name="USD Coin", version="2"
 * (read from 0x74b7F163…6d22; its DOMAIN_SEPARATOR matches a domain built from
 * these values). The testnet TestUSDC reports name="USDC". Default per chain and
 * let XLAYER_USDC_NAME / _VERSION override for any other token.
 */
export const TOKEN_EIP712 = {
  name: process.env.XLAYER_USDC_NAME || (X402_CHAIN_ID === 196 ? 'USD Coin' : 'USDC'),
  version: process.env.XLAYER_USDC_VERSION || '2',
};

export interface PaymentRequirements {
  scheme: 'exact';
  network: string; // CAIP-2, e.g. eip155:196
  maxAmountRequired: string; // base units, string for JSON safety
  asset: string; // token contract address
  payTo: string; // treasury / agent fee wallet
  resource: string;
  description: string;
  mimeType: string;
  outputSchema: unknown | null;
  maxTimeoutSeconds: number;
  extra: { assetTransferMethod: 'eip3009'; name: string; version: string };
}

/** The 402 response body. */
export interface X402Challenge {
  x402Version: 1;
  error: string;
  accepts: PaymentRequirements[];
}

/** EIP-3009 typed-data types — canonical, per the EIP. */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/**
 * The EIP-712 domain a payer signs under for EIP-3009. This is the TOKEN's
 * domain — not an app-specific one — so `verifyingContract` is the asset.
 */
export function tokenDomain(asset: string, chainId = X402_CHAIN_ID) {
  return {
    name: TOKEN_EIP712.name,
    version: TOKEN_EIP712.version,
    chainId,
    verifyingContract: asset as Hex,
  } as const;
}

export function challenge(
  resource: string,
  o: {
    token: { address: string; symbol: string; decimals: number };
    amount: string;
    recipient: string;
    description?: string;
  },
): X402Challenge {
  return {
    x402Version: 1,
    error: 'Payment required to access this resource',
    accepts: [
      {
        scheme: 'exact',
        network: X402_NETWORK,
        maxAmountRequired: o.amount,
        asset: o.token.address,
        payTo: o.recipient,
        resource,
        description: o.description ?? 'Atlas on-chain payment settlement (per call)',
        mimeType: 'application/json',
        outputSchema: null,
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
        extra: {
          assetTransferMethod: 'eip3009',
          name: TOKEN_EIP712.name,
          version: TOKEN_EIP712.version,
        },
      },
    ],
  };
}

export interface VerifiedPayment {
  payer: string;
  authorization: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
  };
}

/** Decode a base64 (or raw-JSON, for tolerance) `X-PAYMENT` header. */
function decodePaymentHeader(header: string): any {
  const raw = header.trim();
  // Spec form is base64-encoded JSON. Accept bare JSON too so a hand-rolled
  // client (or curl in a terminal) still works.
  if (raw.startsWith('{')) return JSON.parse(raw);
  const decoded = Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(decoded);
}

/**
 * Verify an `X-PAYMENT` header against what we demanded.
 *
 * Checks: envelope shape, scheme/network match, EIP-3009 signature over the
 * token's own EIP-712 domain, recipient, amount, and the validAfter/validBefore
 * time window.
 */
export async function verifyPayment(
  header: string | undefined,
  expected: { recipient: string; amount: string; token: string; resource: string },
): Promise<VerifiedPayment> {
  if (!header) throw new Error('missing X-PAYMENT');

  let envelope: any;
  try {
    envelope = decodePaymentHeader(header);
  } catch {
    throw new Error('bad X-PAYMENT (not base64 JSON)');
  }

  const { scheme, network, payload } = envelope ?? {};
  if (scheme && scheme !== 'exact') throw new Error(`unsupported scheme: ${scheme}`);
  if (network && network !== X402_NETWORK)
    throw new Error(`wrong network: expected ${X402_NETWORK}, got ${network}`);

  const signature = payload?.signature;
  const auth = payload?.authorization;
  if (!signature || !auth) throw new Error('incomplete X-PAYMENT (need payload.signature + payload.authorization)');
  const { from, to, value, validAfter, validBefore, nonce } = auth;
  if (!from || !to || value === undefined || !nonce)
    throw new Error('incomplete authorization (need from/to/value/nonce)');

  const valid = await verifyTypedData({
    address: from as Hex,
    domain: tokenDomain(expected.token),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: from as Hex,
      to: to as Hex,
      value: BigInt(value),
      validAfter: BigInt(validAfter ?? 0),
      validBefore: BigInt(validBefore ?? 0),
      nonce: nonce as Hex,
    },
    signature: signature as Hex,
  });
  if (!valid) throw new Error('invalid payment signature');

  if (String(to).toLowerCase() !== expected.recipient.toLowerCase())
    throw new Error('payment recipient mismatch');
  if (String(value) !== expected.amount) throw new Error('payment amount mismatch');

  // Authorization time window (EIP-3009 semantics; seconds since epoch).
  const now = Math.floor(Date.now() / 1000);
  if (validAfter !== undefined && now < Number(validAfter))
    throw new Error('payment authorization not yet valid');
  if (validBefore !== undefined && Number(validBefore) !== 0 && now >= Number(validBefore))
    throw new Error('payment authorization expired');

  return {
    payer: from,
    authorization: {
      from,
      to,
      value: String(value),
      validAfter: String(validAfter ?? 0),
      validBefore: String(validBefore ?? 0),
      nonce,
    },
  };
}

/**
 * Offline demo/x402 client: sign a challenge to produce a valid base64
 * `X-PAYMENT` header. Used by the conformance test + walkthrough.
 */
export async function signChallenge(
  c: X402Challenge,
  pk: Hex,
): Promise<{ header: string; payload: unknown }> {
  const req = c.accepts[0];
  const account = privateKeyToAccount(pk);
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: req.payTo as Hex,
    value: BigInt(req.maxAmountRequired),
    validAfter: BigInt(now - 60), // small backdate for clock skew
    validBefore: BigInt(now + (req.maxTimeoutSeconds || MAX_TIMEOUT_SECONDS)),
    nonce: ('0x' + crypto.randomBytes(32).toString('hex')) as Hex,
  };

  const signature = await account.signTypedData({
    domain: {
      name: req.extra?.name ?? TOKEN_EIP712.name,
      version: req.extra?.version ?? TOKEN_EIP712.version,
      chainId: X402_CHAIN_ID,
      verifyingContract: req.asset as Hex,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  });

  const envelope = {
    x402Version: 1,
    scheme: 'exact',
    network: req.network,
    payload: {
      signature,
      // All numerics travel as strings; verifyPayment re-hydrates them.
      authorization: {
        from: authorization.from,
        to: authorization.to,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
        nonce: authorization.nonce,
      },
    },
  };

  return {
    header: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64'),
    payload: envelope,
  };
}

/**
 * Settlement proof for the `X-PAYMENT-RESPONSE` header after a paid run.
 * Returns base64-encoded JSON per the HTTP transport spec.
 */
export function paymentResponseHeader(ref: {
  payer: string;
  amount: string;
  token: string;
  txHash?: string;
}): string {
  const body = {
    success: true,
    transaction: ref.txHash ?? '',
    network: X402_NETWORK,
    payer: ref.payer,
  };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
}

/** Failure counterpart of the settlement header (also base64). */
export function paymentErrorHeader(errorReason: string, payer = ''): string {
  const body = { success: false, errorReason, transaction: '', network: X402_NETWORK, payer };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64');
}
