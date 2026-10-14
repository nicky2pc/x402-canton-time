# x402-canton-time

A minimal [x402](https://x402.org) example on **Canton**: an Express server that
gates `GET /time` behind a Canton Coin payment. Call it with no payment and you
get a `402` challenge; pay **0.01 CC** and you get the current Unix time.

It uses the published Canton x402 stack:

- [`@ftptech/x402-canton-express`](https://www.npmjs.com/package/@ftptech/x402-canton-express) — the merchant middleware that gates the route
- [`@ftptech/x402-canton-core`](https://www.npmjs.com/package/@ftptech/x402-canton-core) — the `exact` scheme wire types
- a live facilitator at `https://facilitator.ftptech.xyz`

The whole server is ~40 lines in [`src/server.ts`](src/server.ts): build the
`PaymentRequirements`, hand them to `cantonPaymentMiddleware`, and write the
`/time` handler. The middleware does the 402 challenge and the verify/settle
relay. (For Next.js, see `@ftptech/x402-canton-next`.)

## How it works

```
client ──GET /time──────────────▶ server
client ◀──402 + PAYMENT-REQUIRED── server         (challenge: price, payTo, network, ...)

client signs a TransferFactory_Transfer off-ledger, resends with PAYMENT-SIGNATURE

client ──GET /time (+signature)─▶ server ──/verify──▶ facilitator
                                  server ──/settle──▶ facilitator ──▶ 1 on-ledger tx
client ◀──200 {unix,iso} + ──────  server            (payment settled)
          PAYMENT-RESPONSE
```

Settlement is **transfer-factory** (CIP-56 Token Standard, "V3"): the payer signs
a facilitator-prepared `TransferFactory_Transfer` but never submits it; the
facilitator relays it in a **single** transaction, sponsors the Global
Synchronizer traffic fee, and never takes custody. Because the merchant holds a
standing `TransferPreapproval`, it resolves directly and settles in one tx — the
payer pays no gas.

## Run it

```bash
npm install
cp .env.example .env      # fill CANTON_X402_PAYTO with your merchant party
npm start
```

The merchant party in `CANTON_X402_PAYTO` must hold a live `TransferPreapproval`
(one-time setup, otherwise `/settle` fails closed); `--status` checks it:

```bash
npx @ftptech/canton-agent-wallet preapproval
npx @ftptech/canton-agent-wallet preapproval --status
```

`CANTON_X402_FACILITATOR` must be the party the facilitator relays as (its
`/supported` lists it under `signers`); a stale value is refused at verify with
`invalid_exact_canton_fee_payer_mismatch`.

The payment arrives in one request header of ~8-10 KiB. `npm start` raises
Node's header limit to 32 KiB; a proxy in front of the server must accept
headers of at least 16 KiB too (nginx: `large_client_header_buffers 4 16k;`).

## Test it

**1. The challenge (no wallet needed)** — any caller can see the 402:

```bash
curl -i http://localhost:3402/time
# → HTTP/1.1 402 Payment Required
#   payment-required: <base64 challenge with price, payTo, network, extra>
```

Decode the challenge:

```bash
curl -s -i http://localhost:3402/time \
  | grep -i '^payment-required:' | cut -d' ' -f2 | tr -d '\r' \
  | base64 -d | python3 -m json.tool
```

**2. The full paid round-trip** — from a funded Canton wallet, using the wallet CLI:

```bash
npx @ftptech/canton-agent-wallet pay --relay-url https://facilitator.ftptech.xyz --max 0.01 http://localhost:3402/time
# → { "unix": 1751960000, "iso": "2026-07-08T...Z", "paid": "0.01 CC" }
```

`pay` needs a relay (`--relay-url` or `CANTON_AGENT_RELAY_URL`); `--max` caps
what one payment may cost.

`pay` handles the whole flow: it reads the 402 challenge, signs the
`TransferFactory_Transfer`, and re-requests with the `PAYMENT-SIGNATURE` header.

## License

Apache-2.0
