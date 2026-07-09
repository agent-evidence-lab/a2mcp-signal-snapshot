# Mario A2MCP Intelligence Suite

Multi-endpoint A2MCP-style Web3 intelligence service for OKX.AI listing experiments.

The current suite exposes three separately listable services on one shared runtime:

| Service | Endpoint | Positioning |
|---|---|---|
| Token Risk Guard | `POST /api/token-risk-scan` | Professional token risk scan for liquidity, volatility, data availability, and review hints. |
| ApeGuard | `POST /api/ape-pretrade-check` | Short pre-trade meme/new-token check with an `ape_score` and decision hint. |
| Web3 Signal Snapshot | `POST /api/signal-snapshot` | Generic Web3 signal snapshot for tokens, wallets, projects, or risk objects. |

The first production direction is Token Risk Guard plus ApeGuard. They share the same data, scoring, and x402 payment layer, so more A2MCP endpoints can be added without rebuilding payment and deployment from scratch.

## Current Data Sources

- DexScreener token pairs API for public DEX liquidity, price, volume, pair age, and transaction-count fields.
- Holder concentration and contract-permission fields are explicitly returned as unavailable in this MVP. The service does not infer or fabricate them.

## Run Locally

```bash
npm start
```

Then call:

```bash
curl -s http://localhost:8787/health
curl -s http://localhost:8787/metadata
curl -s http://localhost:8787/openapi.json
```

Token Risk Guard:

```bash
curl -s -X POST http://localhost:8787/api/token-risk-scan \
  -H 'content-type: application/json' \
  -d '{
    "chain": "solana",
    "token_address": "So11111111111111111111111111111111111111112",
    "language": "zh-CN"
  }'
```

ApeGuard:

```bash
curl -s -X POST http://localhost:8787/api/ape-pretrade-check \
  -H 'content-type: application/json' \
  -d '{
    "chain": "solana",
    "token_address": "So11111111111111111111111111111111111111112",
    "mode": "quick",
    "language": "zh-CN"
  }'
```

Signal Snapshot:

```bash
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

## One-command Tests

The smoke tests start and stop a local server automatically.

```bash
npm test
npm run test:x402
```

## Run Mock x402 Mode

This mode does not settle real payments. It verifies that unpaid requests return HTTP 402 plus a `PAYMENT-REQUIRED` header.

```bash
PORT=8788 PAYMENT_MODE=mock-x402 npm start
```

Then test any endpoint:

```bash
onchainos agent x402-check \
  --endpoint http://localhost:8788/api/token-risk-scan \
  --body '{"chain":"solana","token_address":"So11111111111111111111111111111111111111112"}'
```

## Production x402 Mode

Production payment mode requires OKX facilitator credentials and a real receiving address. Do not enable this until the receiving wallet and OKX payment setup are confirmed.

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
X402_TOKEN_NAME='USDt0' \
X402_TOKEN_SYMBOL=USDT0 \
X402_TOKEN_DECIMALS=6 \
npm start
```

`X402_PRICE` is kept for listing/metadata display. The actual payment challenge uses the explicit asset amount fields so validators can read token decimals without guessing.

## Deployment Shape

This folder includes deployment starters:

- `.env.example`: local and production environment variables.
- `Dockerfile`: container build for Node 22.14.
- `deploy/systemd/a2mcp-signal-snapshot.service`: Linux service template.
- `deploy/nginx/a2mcp-signal-snapshot.conf`: reverse proxy template before adding HTTPS.

For OKX.AI A2MCP listing, the endpoint should be a stable public HTTPS URL. Localhost and temporary tunnels are only useful for development checks.

## Candidate OKX.AI A2MCP Listings

Token Risk Guard:

```text
面向交易 Agent、研究 Agent 和钱包风控场景，按次返回结构化 Token 风险扫描结果，包括 risk_score、risk_level、flags、liquidity、holders、contract、suggested_action、data_quality 和 source URLs。第一版接入公开 DEX 数据源；未覆盖的数据会明确标记 unavailable，不编造。
```

Endpoint:

```text
https://<your-domain>/api/token-risk-scan
```

ApeGuard:

```text
面向 meme / 新币交易前体检场景，输入 chain 和 token_address，返回 ape_score、risk_level、one_line、red_flags、market_status 和 decision_hint。输出只做风险提示，不构成买卖建议，也不执行交易。
```

Endpoint:

```text
https://<your-domain>/api/ape-pretrade-check
```

Suggested fee:

```text
0.02 USDT / call
```

## Production Checklist

- Deploy to a stable public HTTPS endpoint.
- Add more verifiable read-only data sources: explorer/security API for contract checks, holder distribution, and optional GoPlus/Honeypot providers.
- Keep missing-data fields explicit with `data_quality`, `available`, `reason`, and source status.
- Switch from `mock-x402` to `okx-x402` with real OKX facilitator credentials and receiving address.
- Add request logging without storing user secrets.
- Add rate limiting and timeout controls.
- Test with a real agent client before registering on OKX.AI.
