/**
 * x402-canton-time — a minimal Canton x402 example.
 *
 * Gates GET /time behind a Canton x402 payment via `cantonPaymentMiddleware`.
 * A caller with no payment gets a 402 challenge; a caller that pays (0.01 CC by
 * default) gets the current Unix time back.
 *
 * Settlement uses the transfer-factory method (CIP-56 Token Standard, "V3"):
 * the payer signs a facilitator-prepared `TransferFactory_Transfer` off-ledger
 * and the facilitator relays it in ONE on-ledger transaction — it sponsors the
 * Global Synchronizer traffic fee and never takes custody. Because this merchant
 * holds a standing `TransferPreapproval`, the transfer resolves directly and
 * settles in a single tx.
 *
 * The merchant must set the preapproval up once (else the transfer Pends and
 * /settle fails closed):
 *   npx @ftptech/canton-agent-wallet preapproval
 *
 * The middleware handles the 402 challenge, then relays the client's payment to
 * the facilitator's /verify + /settle and only calls the /time handler once the
 * payment has settled. Configure via environment (see .env.example).
 *
 * The payment travels in one request header of ~8-10 KiB, so the server must
 * accept headers of at least 16 KiB: `npm start` runs Node with
 * --max-http-header-size=32768, and a proxy in front needs the same headroom
 * (nginx: `large_client_header_buffers 4 16k;`).
 */

import "dotenv/config";
import express from "express";
import { cantonPaymentMiddleware } from "@ftptech/x402-canton-express";
import type { PaymentRequirements } from "@ftptech/x402-canton-core";

const PORT = Number(process.env.PORT ?? 3402);
const NETWORK = (process.env.NETWORK ?? "canton:mainnet") as PaymentRequirements["network"];
const FACILITATOR_URL = (process.env.FACILITATOR_URL ?? "https://facilitator.ftptech.xyz").replace(/\/$/, "");

// Price per call in atomic CC units on the x402 "exact" wire (1 CC = 10^10). 0.01 CC.
const AMOUNT = process.env.X402_AMOUNT ?? "100000000";

const MERCHANT_PARTY = required("CANTON_X402_PAYTO");
const FACILITATOR_PARTY = required("CANTON_X402_FACILITATOR");
const SYNCHRONIZER_ID = required("CANTON_SYNCHRONIZER_ID");
const DSO_PARTY = required("CANTON_X402_DSO");
const EXECUTE_BEFORE_SECONDS = Number(process.env.EXECUTE_BEFORE_SECONDS ?? 120);

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name} — see .env.example`);
    process.exit(1);
  }
  return v;
}

// The 402 challenge: what the caller must pay and how. asset uses the symbolic
// "<admin>::Amulet" form so it stays consistent with extra.instrumentId (the
// middleware asserts the two agree at setup).
const timeRequirements: PaymentRequirements = {
  scheme: "exact",
  network: NETWORK,
  amount: AMOUNT,
  asset: `${DSO_PARTY}::Amulet`,
  payTo: MERCHANT_PARTY,
  maxTimeoutSeconds: 120,
  extra: {
    assetTransferMethod: "transfer-factory", // V3: one gasless tx
    feePayer: FACILITATOR_PARTY,             // facilitator sponsors gas
    synchronizerId: SYNCHRONIZER_ID,
    instrumentId: { admin: DSO_PARTY, id: "Amulet" },
    executeBeforeSeconds: EXECUTE_BEFORE_SECONDS,
  },
};

const app = express();
app.use(express.json());

// Gate GET /time. The middleware advertises `accepts[]` in the 402 and relays
// the payment to the facilitator; the /time handler below only runs after settle.
app.use(
  cantonPaymentMiddleware({
    routes: {
      "GET /time": {
        accepts: [timeRequirements],
        description: "Current Unix time",
        mimeType: "application/json",
      },
    },
    facilitatorUrl: FACILITATOR_URL,
  })
);

// Paid route — only reached after the middleware confirms settlement.
app.get("/time", (_req, res) => {
  const now = Date.now();
  res.json({
    unix: Math.floor(now / 1000),
    iso: new Date(now).toISOString(),
    paid: `${Number(AMOUNT) / 1e10} CC`,
  });
});

// Free health check — not gated.
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[x402-canton-time] listening on :${PORT}`);
  console.log(`  facilitator=${FACILITATOR_URL}  price=${AMOUNT} atomic CC (${Number(AMOUNT) / 1e10} CC)  method=transfer-factory`);
  console.log(`  GET /time    — paid (x402)`);
  console.log(`  GET /health  — free`);
});
