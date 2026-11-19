# x402-canton-time

The same minimal [x402](https://x402.org) server in TypeScript, Go and Python: `GET /time` costs 0.01 CC, `GET /health` is free. FTP's facilitator settles the payments on Canton MainNet.

| Folder | Stack | Run |
| --- | --- | --- |
| [`ts/`](ts/src/server.ts) | Express + [`@ftptech/x402-canton-express`](https://www.npmjs.com/package/@ftptech/x402-canton-express) | `cd ts && npm install && CANTON_X402_PAYTO=<party> npm start` |
| [`go/`](go/main.go) | net/http + [x402-canton-merchant/go](https://github.com/FTP-Tech-LLC/x402-canton-merchant/tree/main/go) | `cd go && CANTON_X402_PAYTO=<party> go run .` |
| [`python/`](python/app.py) | FastAPI + [`ftptech-x402-canton`](https://pypi.org/project/ftptech-x402-canton/) | `cd python && pip install -r requirements.txt && CANTON_X402_PAYTO=<party> uvicorn app:app --port 3402` |

All three listen on port 3402 and answer `{"unix": ..., "iso": "..."}`.

## Before you start

`CANTON_X402_PAYTO` is the party you are paid to. It needs a live `TransferPreapproval`:

```bash
npx @ftptech/canton-agent-wallet create --relay-url https://facilitator.ftptech.xyz
npx @ftptech/canton-agent-wallet address       # your party id
# send it a few CC, then
npx @ftptech/canton-agent-wallet claim
npx @ftptech/canton-agent-wallet preapproval   # lasts 30 days
```

## Try it

```bash
curl -i http://localhost:3402/time   # 402 with a PAYMENT-REQUIRED header
```

Pay from a second wallet (paying your own party is refused):

```bash
npx @ftptech/canton-agent-wallet pay --max 0.01 http://localhost:3402/time
```

## License

Apache-2.0
