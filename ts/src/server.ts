// GET /time costs 0.01 CC, GET /health is free. Payments settle through FTP's facilitator.
import express from "express";
import { cantonPaymentMiddleware } from "@ftptech/x402-canton-express";

const payTo = process.env.CANTON_X402_PAYTO;
if (!payTo) throw new Error("set CANTON_X402_PAYTO to the party you are paid to");

// FTP MainNet values, copy as is (current ones: https://facilitator.ftptech.xyz/supported)
const DSO = "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";
const price = {
  scheme: "exact",
  network: "canton:mainnet",
  asset: "CC",
  amount: "100000000", // 0.01 CC (1 CC = 10^10)
  payTo,
  maxTimeoutSeconds: 120,
  extra: {
    assetTransferMethod: "transfer-factory",
    feePayer: "ftp-x402-infrastructure::1220da867ceb28e1531ebfbea9ca9b25f75be06755999f48f0ec4b96f4174e3cd133",
    synchronizerId: "global-domain::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc",
    instrumentId: { admin: DSO, id: "Amulet" },
    executeBeforeSeconds: 120,
  },
} as const;

const app = express();
app.use(
  cantonPaymentMiddleware({
    facilitatorUrl: process.env.FACILITATOR_URL ?? "https://facilitator.ftptech.xyz",
    routes: { "GET /time": { accepts: [price], description: "Current time" } },
  }),
);
app.get("/time", (_req, res) => {
  const now = new Date();
  res.json({ unix: Math.floor(now.getTime() / 1000), iso: now.toISOString() });
});
app.get("/health", (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT ?? 3402);
app.listen(port, () => console.log(`x402-canton-time (TypeScript) on :${port}`));
