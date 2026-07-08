/**
 * x402-canton-time — a minimal Canton x402 example.
 *
 * Gates GET /time behind a Canton x402 payment. A caller with no payment gets a
 * 402 challenge; a caller that pays (0.01 CC by default) gets the current Unix
 * time back. The whole x402 protocol is spelled out here against the published
 * `@ftptech/x402-canton-core` wire types and a live facilitator — no framework.
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
 * Per-request flow:
 *   1. GET /time with no PAYMENT-SIGNATURE  → 402 + PAYMENT-REQUIRED (the challenge).
 *   2. Client signs a TransferFactory_Transfer and re-requests with PAYMENT-SIGNATURE.
 *   3. Server POSTs the envelope to facilitator /verify, then /settle.
 *   4. settle.success === true → 200 with the Unix time + PAYMENT-RESPONSE header.
 *
 * Configure via environment (see .env.example).
 */

import "dotenv/config";
import * as http from "node:http";
import {
  HEADER_PAYMENT_REQUIRED_V2 as HEADER_REQUIRED,
  HEADER_PAYMENT_SIGNATURE_V2 as HEADER_SIGNATURE,
  HEADER_PAYMENT_RESPONSE_V2 as HEADER_RESPONSE,
  encodeBase64Json,
  decodeBase64Json,
  selectServerRequirements,
  type PaymentRequirements,
  type CantonNetwork,
} from "@ftptech/x402-canton-core";

const PORT = Number(process.env.PORT ?? 3402);
const NETWORK = (process.env.NETWORK ?? "canton:mainnet") as CantonNetwork;
const FACILITATOR_URL = required("FACILITATOR_URL").replace(/\/$/, "");
const PUBLIC_URL = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");

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
// "<admin>::Amulet" form so it stays consistent with extra.instrumentId.
function requirementsList(): PaymentRequirements[] {
  return [
    {
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
    },
  ];
}

function respond402(res: http.ServerResponse, resourceUrl: string, error?: string): void {
  const header = encodeBase64Json({
    x402Version: 2,
    error: error ?? "payment required",
    resource: { url: resourceUrl, description: "Current Unix time", mimeType: "application/json" },
    accepts: requirementsList(),
    extensions: {},
  });
  res.writeHead(402, { "Content-Type": "application/json", [HEADER_REQUIRED]: header });
  res.end("{}");
}

async function facilitatorCall(path: string, body: string): Promise<Response> {
  return fetch(`${FACILITATOR_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // Free health check — not gated.
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method !== "GET" || url.pathname !== "/time") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  // The resource URL the payer signs over. Must match on both the challenge and
  // the paid retry, so we derive it the same way each time.
  const resourceUrl = PUBLIC_URL ? `${PUBLIC_URL}/time` : `http://${req.headers.host}/time`;

  const sigHeader = req.headers[HEADER_SIGNATURE.toLowerCase()];
  if (!sigHeader || typeof sigHeader !== "string") {
    respond402(res, resourceUrl);
    return;
  }

  let envelope: Record<string, unknown>;
  try {
    envelope = decodeBase64Json(sigHeader);
  } catch {
    respond402(res, resourceUrl, "malformed payment signature");
    return;
  }

  // The payer must have signed over THIS resource URL.
  const envelopeUrl = (envelope.resource as { url?: unknown } | undefined)?.url;
  if (typeof envelopeUrl !== "string" || envelopeUrl !== resourceUrl) {
    respond402(res, resourceUrl, "resource URL mismatch");
    return;
  }

  // SECURITY: never trust the client's `accepted` block as the price. Pin to
  // THIS server's requirements; on no match, re-challenge and never call the
  // facilitator with the client's numbers.
  const reqs = selectServerRequirements(requirementsList(), envelope.accepted);
  if (!reqs) {
    respond402(res, resourceUrl, "payment requirements mismatch");
    return;
  }

  const body = JSON.stringify({ x402Version: 2, paymentPayload: envelope, paymentRequirements: reqs });

  // POST /verify
  const verifyR = await facilitatorCall("/verify", body);
  if (!verifyR.ok) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "facilitator verify failed" }));
    return;
  }
  const verifyRes = (await verifyR.json()) as { isValid: boolean; invalidReason?: string };
  if (!verifyRes.isValid) {
    respond402(res, resourceUrl, verifyRes.invalidReason);
    return;
  }

  // POST /settle — settles on-ledger in one tx.
  const settleR = await facilitatorCall("/settle", body);
  if (!settleR.ok) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "facilitator settle failed" }));
    return;
  }
  const settleRes = (await settleR.json()) as { success: boolean; errorReason?: string };
  if (settleRes.success !== true) {
    respond402(res, resourceUrl, settleRes.errorReason ?? "settle failed");
    return;
  }

  // Paid — deliver the resource.
  const now = Date.now();
  res.writeHead(200, {
    "Content-Type": "application/json",
    [HEADER_RESPONSE]: encodeBase64Json(settleRes),
  });
  res.end(JSON.stringify({
    unix: Math.floor(now / 1000),
    iso: new Date(now).toISOString(),
    paid: `${Number(AMOUNT) / 1e10} CC`,
  }));
});

server.listen(PORT, () => {
  console.log(`[x402-canton-time] listening on :${PORT}`);
  console.log(`  facilitator=${FACILITATOR_URL}  price=${AMOUNT} atomic CC (${Number(AMOUNT) / 1e10} CC)  method=transfer-factory`);
  console.log(`  GET /time    — paid (x402)`);
  console.log(`  GET /health  — free`);
});
