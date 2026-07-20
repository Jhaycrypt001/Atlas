# Atlas — Concurrent On-Chain Operations Agent

**An OKX.AI agent-native service (ASP) that moves real money on X Layer, non-custodially, in parallel.**

Atlas takes a plain-English instruction like *"pay this freelancer 200 USDC once the work is verified"* and executes it as a real on-chain settlement — escrow deployed, funds released to the payee, a 0.5% fee skimmed to the treasury, every step provable on the X Layer block explorer. It runs many such tasks concurrently and never holds your funds itself.

---

## 60-second demo

```bash
npm install
node scripts/compile.mjs      # compile contracts -> artifacts/
npm run asp                   # starts the full ASP server + live UI  ->  :4173
```

Then open **http://localhost:4173/app**:

1. **Connect wallet** (MetaMask / OKX Wallet) — it switches you to X Layer testnet.
2. Type an instruction — e.g. `Pay 0x7099… 5 USDC for the logo`.
3. Sign the two prompts (approve + lock). The agent verifies and releases. **Funds move from *your* wallet, non-custodially — the agent never holds them.**

Each ledger row links to the real transaction on the X Layer explorer. Every transaction is real testnet settlement — there is no simulation mode.

> **Two paths:** the **connected-wallet** flow above is user-funded and always on. There is also an agent-funded **demo** path (`POST /intent`) that spends the agent's own key — it is **disabled by default** and must be explicitly enabled with `DEMO_MODE=1` for a trusted local demo. See [Security](#security).

---

## What makes it real

| Claim | Where to verify |
|---|---|
| Funds settle on-chain, non-custodially | `contracts/Escrow.sol` — `lock()` pulls funds, `release()` pays payee `amount − fee` and treasury the fee, `refund()` returns funds. Every capability routes through it. |
| Deployed and exercised on X Layer testnet | `deployments/testnet-1952.json` — live contract addresses + transaction hashes on chain `1952`. |
| The agent understands real language | `src/kernel/llm.ts` — an LLM extracts intent, amount, recipient, and capability from free text. |
| Payments are billable per call | `src/kernel/x402.ts` — OKX **x402**: a `402` challenge, an EIP-3009-style signed authorization, a `PAYMENT-RESPONSE` settlement proof. |
| Revenue is provable | A 0.5% fee (`FEE_BPS`) is skimmed on every settlement and accrues on-chain. |

---

## The four capabilities

| Capability | What it does |
|---|---|
| **Pay** | Send a payment to a recipient, held in escrow until conditions are met. |
| **Get paid** | Issue an invoice and collect into escrow. |
| **Split** | Divide an amount across several recipients in one flow. |
| **Verify** | Release escrowed funds only after a proof passes (receipt, signed webhook, or on-chain attestation). |

Capabilities are plugins. The kernel (`src/kernel/`) stays untouched when you add one — you append to the capability list and it inherits settlement, safety, the ledger, and the ASP surface for free.

---

## OKX.AI ASP surface

Atlas speaks the open **Agent Social Protocol (`asp/1.0`)** that OKX.AI discovers, plus OKX **x402** pay-per-call billing.

| Method | Path | Purpose |
|---|---|---|
| GET | `/.well-known/asp.yaml` | `asp/1.0` identity manifest (JSON, or YAML via `Accept: application/yaml`). How OKX.AI discovers Atlas. Carries the Ed25519 public key. |
| GET | `/asp/feed` | Capability feed (ASP-Sig authenticated). |
| POST | `/asp/inbox` | Accept an instruction message (ASP-Sig authenticated), schedules a task. |
| POST | `/asp/run` | The `run()` surface. Free by default; with `ASP_PAID=1` it returns a `402` challenge, then executes after a valid payment signature. |

- **ASP-Sig** — `Authorization: ASP-Sig {handle}:{ts}:{sig}`, signing `{handle}:{ts}:{method}:{path}` with Ed25519, inside a ±5 minute replay window. The signing key is stable across restarts (`ASP_PRIVATE_KEY` in `.env`), so Atlas keeps one identity.
- **x402** — the `402` body advertises `eip155:1952`, the token, the amount, and the treasury recipient. The client signs an EIP-3009-style authorization and replays it. The server verifies the signature, settles through the non-custodial escrow, and returns a `PAYMENT-RESPONSE` proof.

---

## Architecture

```
kernel/         ledger · safety · planner · llm · scheduler
                settlement(interface) · xlayer(real settlement) · asp · x402
capabilities/   pay · getPaid · split · verify
contracts/      Escrow.sol (non-custodial)  ·  Attestation.sol  ·  TestUSDC.sol
public/         index.html (landing)  ·  app.html (live console)
```

A minimal kernel, extended entirely through plugins. Settlement is an interface with one production implementation: `XLayerSettlement`, which deploys and drives the real Escrow contract on X Layer. There is no in-memory or simulated settlement path — the agent requires a funded key and settles for real.

---

## Setup

Create `.env`:

```bash
XLAYER_RPC=https://testrpc.xlayer.tech
XLAYER_CHAIN_ID=1952
PK=0x...                    # funded X Layer testnet key (agent's wallet)
XLAYER_USDC=0x...           # TestUSDC address (see deployments/testnet-1952.json)
XLAYER_TREASURY=0x...       # where the 0.5% fee accrues
XLAYER_ATTESTATION=0x...    # deployed Attestation contract
LLM_API_KEY=...             # LLM planner
ASP_PRIVATE_KEY=.keys/asp-ed25519.pem   # stable ASP identity
```

Get testnet OKB (gas) and tokens from the X Layer faucet. Each pay-and-verify flow is roughly three transactions, so keep a small gas buffer.

## Commands

```bash
npm run asp            # full ASP server (manifest + ASP-Sig + x402) with the live UI  ->  :4173
ASP_PAID=1 npm run asp # same, with x402 pay-per-call enabled on /asp/run
npm run ui             # just the live dashboard  ->  :4173
npm run demo           # concurrent real on-chain run, printed to the terminal

# contracts
node scripts/compile.mjs             # compile contracts/ -> artifacts/
node scripts/deploy.mjs xlayerTestnet  # deploy + exercise the escrow on X Layer testnet
```

---

## Design notes

- **Non-custodial by construction.** The agent's key deploys the escrow and triggers `release`/`refund`, but the contract, not the agent, holds the funds and enforces who gets paid. A compromised agent key cannot redirect escrowed money.
- **Concurrent, not scripted.** Tasks run in parallel through a scheduler with a manual nonce counter, so overlapping transactions from one wallet don't collide. The live ledger shows several tasks progressing at once.
- **Real language in, real settlement out.** An LLM turns free text into a typed intent; the intent drives a real contract call. Amounts are normalized to base units regardless of how they're phrased.
- **Mainnet path.** `TestUSDC` is the demo stablecoin on testnet. Moving to mainnet is an address swap — point `XLAYER_USDC` at the canonical stablecoin; no code changes, since everything speaks the standard ERC-20 interface.

---

## Security

Atlas moves real money, so the defaults are chosen to fail closed.

| Control | Behavior |
|---|---|
| **User-funded settlement** | The connected-wallet flow (`/wallet/*`) funds escrow from the **user's** signature. The agent orchestrates (deploy + release) but never custodies user funds. `release()` is gated to the agent on-chain; `refund()` returns to the original funder. |
| **Agent-funded path disabled by default** | `POST /intent` spends the agent's own key and is **unauthenticated**, so it is off unless `DEMO_MODE=1`. Never enable it on a public host. |
| **Proof-gated release** | `verify` will not release without **real, distinct** proof evidence (receipt / webhook / on-chain attestation). Self-referential "proof" is rejected. |
| **Spend cap** | Every value-moving task is checked against `MAX_VALUE_USDC` (default 10,000) and blocked if it exceeds it. |
| **Rate limiting** | Money/gas-spending routes are throttled per IP (`RATE_MAX` per `RATE_WINDOW_MS`). Each `prepare` deploys a contract, so this protects agent gas from anonymous drain. |
| **TLS fail-closed** | The server refuses to start with TLS verification disabled unless `ALLOW_INSECURE_TLS=1` (testnet only). |
| **No secret leakage** | Client errors are generic; details are logged server-side. `.env` and `.keys/` are git-ignored. The ASP identity key lives in `.keys/asp-ed25519.pem`. |
| **Bounded memory** | The in-memory ledger evicts oldest tasks beyond `LEDGER_MAX` (default 500). |

**Before a public deploy:** rotate `PK` if it has ever been shared, keep `DEMO_MODE=0`, serve over HTTPS (unset `ALLOW_INSECURE_TLS`), and put a gateway/WAF rate limiter in front for multi-instance. Secrets must be delivered out-of-band — never commit `.env`.

All tunables live in [`.env.example`](.env.example).
