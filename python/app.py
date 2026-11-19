"""GET /time costs 0.01 CC, GET /health is free. Payments settle through FTP's facilitator."""

import os
from datetime import datetime, timezone

from fastapi import FastAPI
from ftptech_x402_canton import CantonPaymentMiddleware, CantonServer, Config, Route, cc

pay_to = os.environ.get("CANTON_X402_PAYTO")
if not pay_to:
    raise SystemExit("set CANTON_X402_PAYTO to the party you are paid to")

config = Config(
    routes={"GET /time": Route(pay_to=pay_to, price=cc("0.01"), description="Current time")},
    facilitator_url=os.environ.get("FACILITATOR_URL", "https://facilitator.ftptech.xyz"),
)
server = CantonServer(config)
app = FastAPI(lifespan=server.lifespan)
app.add_middleware(CantonPaymentMiddleware, server=server)


@app.get("/time")
def current_time() -> dict:
    now = datetime.now(timezone.utc)
    return {"unix": int(now.timestamp()), "iso": now.isoformat(timespec="milliseconds").replace("+00:00", "Z")}


@app.get("/health")
def health() -> dict:
    return {"ok": True}
