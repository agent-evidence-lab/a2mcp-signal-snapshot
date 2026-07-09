# A2MCP Signal Snapshot

Local A2MCP-style demo endpoint for structured Web3 signal snapshots.

This MVP verifies the service shape that an OKX.AI A2MCP listing needs:

- Public HTTP endpoint shape
- Structured input parameters
- Structured JSON output
- Service metadata
- OpenAPI description

It does not yet include production data sources. It can run in `mock-x402` mode to validate the HTTP 402 payment-gated shape locally.

## Run Locally

```bash
npm start
```

Then call:

```bash
curl -s http://localhost:8787/health
curl -s http://localhost:8787/metadata
curl -s http://localhost:8787/openapi.json
curl -s -X POST http://localhost:8787/api/signal-snapshot \
  -H 'content-type: application/json' \
  -d '{
    "chain": "solana",
    "address": "So11111111111111111111111111111111111111112",
    "mode": "token",
    "question": "给我一个代币风险和市场信号快照",
    "lookbackHours": 24,
    "language": "zh-CN"
  }'
```

## Run Mock x402 Mode

This mode does not settle real payments. It verifies that unpaid requests return HTTP 402 plus a `PAYMENT-REQUIRED` header.

```bash
PORT=8788 PAYMENT_MODE=mock-x402 npm start
```

Then test:

```bash
A2MCP_BASE_URL=http://localhost:8788 npm run test:x402

onchainos agent x402-check \
  --endpoint http://localhost:8788/api/signal-snapshot \
  --body '{"chain":"solana","address":"So11111111111111111111111111111111111111112","mode":"token"}'
```

## Production x402 Mode

Production payment mode requires OKX facilitator credentials and a real receiving address:

```bash
PORT=8788 \
PAYMENT_MODE=okx-x402 \
OKX_API_KEY=... \
OKX_SECRET_KEY=... \
OKX_PASSPHRASE=... \
X402_PAY_TO=0xYourReceivingAddress \
X402_PRICE='$0.02' \
X402_NETWORK=eip155:196 \
X402_ASSET=0x779ded0c9e1022225f8e0630b35a9b54be713736 \
X402_AMOUNT_MINIMAL=20000 \
X402_TOKEN_NAME='USD₮0' \
X402_TOKEN_SYMBOL=USDT0 \
X402_TOKEN_DECIMALS=6 \
npm start
```

`X402_PRICE` is kept for listing/metadata display. The actual payment challenge uses the explicit asset amount fields so validators can read token decimals without guessing.

## Deploy Shape

This folder includes deployment starters:

- `.env.example`: local and production environment variables.
- `Dockerfile`: container build for Node 22.14.
- `deploy/systemd/a2mcp-signal-snapshot.service`: Linux service template.
- `deploy/nginx/a2mcp-signal-snapshot.conf`: reverse proxy template before adding HTTPS.

For OKX.AI A2MCP listing, the endpoint must be a stable public HTTPS URL. Localhost and temporary tunnels are only useful for development checks.

## Candidate OKX.AI A2MCP Listing

Agent/service name:

```text
Web3 Signal Snapshot
```

Service type:

```text
A2MCP
```

Description:

```text
核心能力摘要：面向 Web3 项目、代币、钱包地址或风险对象，按调用返回结构化信号快照，包括对象识别、近期动态、风险线索、来源字段、置信提示和下一步观察项。
入参要求：请提供 chain、address 或 subject、mode、question、lookbackHours 与 language。正式版将接入实时只读数据源与 OKX x402 支付中间件。
```

Fee:

```text
0.02 USDT / call
```

Endpoint:

```text
https://<your-domain>/api/signal-snapshot
```

## Production Checklist

- Deploy to a stable public HTTPS endpoint.
- Replace demo response with live, verifiable read-only data sources.
- Switch from `mock-x402` to `okx-x402` with real OKX facilitator credentials.
- Add request logging without storing user secrets.
- Add rate limiting and timeout controls.
- Test with a real agent client before registering on OKX.AI.
