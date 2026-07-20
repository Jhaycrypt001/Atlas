/**
 * OKX.AI ASP conformance module.
 *
 * OKX.AI's Agent Service Provider surface is built on the open
 * Agent Social Protocol (`asp/1.0`): a discoverable identity manifest served
 * at `/.well-known/asp.yaml`, Ed25519 request auth via the `ASP-Sig` scheme,
 * and `feed`/`inbox` core endpoints. OKX layers x402 pay-per-call billing on
 * top (see kernel/x402.ts). This module owns the manifest shape + ASP-Sig
 * crypto so the kernel and the HTTP server stay spec-conformant without
 * touching capability code.
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// asp/1.0 identity manifest (subset that matters for OKX.AI discovery)
// ---------------------------------------------------------------------------

export interface AspServiceInfo {
  name: string;
  description: string;
  risk: string;
  examples: string[];
}

export interface AspEntity {
  id: string; // HTTPS URL of the manifest
  type: string; // 'agent' | 'service' | ...
  name: string;
  handle: string;
  bio: string;
  languages: string[];
  created_at: string; // ISO date
}

export interface AspManifest {
  protocol: 'asp/1.0';
  entity: AspEntity;
  capabilities: string[]; // asp core: ['feed','inbox']
  endpoints: { feed: string; inbox: string; run: string; manifest: string };
  verification: { public_key: string }; // ed25519:<base64 SPKI DER>
  // Atlas-specific business capabilities (the actual service offerings).
  agent: {
    name: string;
    tagline: string;
    category: string;
    services: AspServiceInfo[];
  };
}

export function buildManifest(o: {
  name: string;
  tagline: string;
  category: string;
  services: AspServiceInfo[];
  handle: string;
  baseUrl: string;
  publicKey: string;
}): AspManifest {
  const base = o.baseUrl.replace(/\/+$/, '');
  return {
    protocol: 'asp/1.0',
    entity: {
      id: `${base}/.well-known/asp.yaml`,
      type: 'agent',
      name: o.name,
      handle: o.handle,
      bio: o.tagline,
      languages: ['en'],
      created_at: '2026-07-17',
    },
    capabilities: ['feed', 'inbox'],
    endpoints: {
      feed: `${base}/asp/feed`,
      inbox: `${base}/asp/inbox`,
      run: `${base}/asp/run`,
      manifest: `${base}/.well-known/asp.yaml`,
    },
    verification: { public_key: o.publicKey },
    agent: { name: o.name, tagline: o.tagline, category: o.category, services: o.services },
  };
}

// ---------------------------------------------------------------------------
// ASP-Sig — Ed25519 request auth (Authorization: ASP-Sig handle:ts:sig)
// ---------------------------------------------------------------------------

export class AspSig {
  readonly publicKeyB64: string; // ed25519:<base64 SPKI DER>
  private readonly pub: crypto.KeyObject;
  private readonly priv: crypto.KeyObject;

  private constructor(priv: crypto.KeyObject) {
    this.priv = priv;
    this.pub = crypto.createPublicKey(priv as any);
    const spki = this.pub.export({ type: 'spki', format: 'der' }) as Buffer;
    this.publicKeyB64 = 'ed25519:' + spki.toString('base64');
  }

  /** Load a persisted key from ASP_PRIVATE_KEY (PEM or a path to a PEM file),
   *  else generate an ephemeral one. */
  static loadOrCreateKey(): AspSig {
    const env = (process.env.ASP_PRIVATE_KEY || '').replace(/\r/g, '').trim();
    if (env) {
      try {
        // If the value points at an existing file, read the PEM from there
        // (avoids shell/multiline-env mangling of inline PEMs).
        let pem = env;
        if (!env.includes('-----BEGIN')) {
          try {
            pem = readFileSync(env, 'utf8').replace(/\r/g, '');
          } catch {
            /* not a path — treat env as the PEM itself */
          }
        }
        return new AspSig(crypto.createPrivateKey(pem));
      } catch {
        console.warn('[asp] ASP_PRIVATE_KEY unreadable — generating ephemeral key.');
      }
    }
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    console.log(
      '[asp] generated ephemeral Ed25519 key. To keep a stable identity across restarts, set ASP_PRIVATE_KEY to a PEM or a path to a PEM file.',
    );
    return new AspSig(privateKey);
  }

  /** Produce the full `Authorization` header value for a request. */
  authHeader(handle: string, method: string, path: string): string {
    const ts = Math.floor(Date.now() / 1000);
    const payload = `${handle}:${ts}:${method}:${path}`;
    const sig = crypto.sign(null, Buffer.from(payload), this.priv as any);
    return `ASP-Sig ${handle}:${ts}:${sig.toString('base64')}`;
  }

  /** Verify an incoming `Authorization: ASP-Sig ...` header (handle + ±5min + sig). */
  verify(header: string | undefined, method: string, path: string): boolean {
    if (!header || !header.startsWith('ASP-Sig ')) return false;
    const rest = header.slice('ASP-Sig '.length);
    const [handle, ts, sigB64] = rest.split(':');
    if (!handle || !ts || !sigB64) return false;
    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
    if (!Number.isFinite(age) || age > 300) return false;
    const payload = `${handle}:${ts}:${method}:${path}`;
    try {
      const ok = crypto.verify(null, Buffer.from(payload), this.pub, Buffer.from(sigB64, 'base64'));
      return ok;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// AspAdapter — in-process run() surface (unchanged contract, richer manifest)
// ---------------------------------------------------------------------------

export class AspAdapter {
  constructor(
    private manifest: AspManifest,
    private runInput: (input: any) => Promise<any>,
  ) {}

  describe(): AspManifest {
    return this.manifest;
  }

  async run(input: any): Promise<any> {
    return this.runInput(input);
  }
}
