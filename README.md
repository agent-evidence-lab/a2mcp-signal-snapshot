# Codex Evidence Lab A2MCP Suite

Eight separately listable Web3 intelligence services on one shared HTTP, MCP, data, and x402 runtime. The suite is designed for the OKX.AI `Codex Evidence Lab` Agent and returns structured evidence instead of trading promises.

## Service Catalog

| Service | Canonical endpoint | Fee | Coverage |
|---|---|---:|---|
| 代币市场快照 | `POST /api/token-market-snapshot` | 0.01 USDT | Seven market chains |
| 流动性风险扫描 | `POST /api/liquidity-risk-scan` | 0.01 USDT | Seven market chains |
| 成交活跃度分析 | `POST /api/trading-activity-scan` | 0.01 USDT | Seven market chains |
| 新币启动风险检查 | `POST /api/new-pair-risk-check` | 0.01 USDT | Seven market chains |
| 价格成交异常扫描 | `POST /api/market-anomaly-scan` | 0.01 USDT | Seven market chains |
| 合约权限与交易税检查 | `POST /api/contract-tax-check` | 0.02 USDT | EVM only |
| 持仓集中度检查 | `POST /api/holder-concentration-check` | 0.02 USDT | EVM only |
| 综合交易前风险报告 | `POST /api/pretrade-risk-report` | 0.03 USDT | Market on seven chains; full security on EVM |

Market chains: `solana`, `ethereum`, `xlayer`, `base`, `bsc`, `arbitrum`, and `polygon`.

EVM security chains: `ethereum`, `xlayer`, `base`, `bsc`, `arbitrum`, and `polygon`. Solana contract and holder security fields stay explicitly unavailable until a separately tested Solana security provider is connected.

Legacy callers remain compatible:

| Legacy endpoint | Canonical service |
|---|---|
| `/api/token-risk-scan` | `pretrade-risk-report` |
| `/api/ape-pretrade-check` | `new-pair-risk-check` |
| `/api/signal-snapshot` | `token-market-snapshot` |

## Data and Output

- DexScreener is the primary public market source.
- GeckoTerminal is the market fallback.
- GoPlus supplies EVM contract, tax, holder, owner, creator, and liquidity-holder fields.
- Provider failures return a structured partial or unavailable result before the request budget expires.
- Unknown fields remain `unknown`; they are never inferred as safe.
- Every successful service response includes `service.id`, `request_id`, `generated_at`, `data_quality`, and `sources`.

Default cache durations are 30 seconds for market data and 300 seconds for security data. The default upstream request timeout is 4 seconds and the total provider budget per service call is 4.5 seconds.

## Run Locally

Requires Node.js 22.14 or newer.

```bash
npm ci
npm start
```

Discovery endpoints:

```bash
curl -fsS http://localhost:8787/health
curl -fsS http://localhost:8787/metadata
curl -fsS http://localhost:8787/mcp
curl -fsS http://localhost:8787/openapi.json
```

Call the composite report:

```bash
curl -fsS -X POST http://localhost:8787/api/pretrade-risk-report \
  -H 'content-type: application/json' \
  -d '{
    "chain": "ethereum",
    "token_address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    "language": "zh-CN"
  }'
```

Call the same tool over MCP JSON-RPC:

```bash
curl -fsS -X POST http://localhost:8787/mcp \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "pretrade_risk_report",
      "arguments": {
        "chain": "ethereum",
        "token_address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
      }
    }
  }'
```

## Tests

```bash
npm test
npm run test:x402
npm run test:facilitator-config
```

`npm test` runs unit tests and a live demo-mode smoke test across all eight canonical routes, all three aliases, and MCP. `test:x402` verifies the exact payment amount and resource URL for every paid route.

## x402 Modes

`PAYMENT_MODE=demo` executes services without a payment challenge. `mock-x402` returns test HTTP 402 challenges but never settles money. `okx-x402` uses the OKX facilitator and requires real credentials.

Each canonical or legacy HTTP route uses its catalog fee. `/mcp` has a fixed default fee of 0.03 USDT because x402 issues the challenge before the server reads which MCP tool was selected.

Production environment shape:

```dotenv
PAYMENT_MODE=okx-x402
PUBLIC_BASE_URL=https://your-domain.example
OKX_API_KEY=...
OKX_SECRET_KEY=...
OKX_PASSPHRASE=...
X402_PAY_TO=0xYourReceivingAddress
X402_NETWORK=eip155:196
X402_ASSET=0x779ded0c9e1022225f8e0630b35a9b54be713736
X402_TOKEN_NAME=USDt0
X402_TOKEN_SYMBOL=USDT0
X402_TOKEN_DECIMALS=6
MCP_FEE_USDT=0.03
```

The code derives each minimal token amount from the service catalog and `X402_TOKEN_DECIMALS`; there is no global per-service amount to keep in sync manually.

## Zeabur Deployment

The included `Dockerfile` is sufficient for a GitHub-backed Zeabur service. Configure the variables from `.env.example` in Zeabur, set `PUBLIC_BASE_URL` to the provisioned HTTPS origin, and keep `.env` out of Git.

Against a public demo/staging deployment, run the full response smoke test. Against a paid production deployment, run the x402 challenge test:

```bash
A2MCP_BASE_URL=https://your-staging-domain.example npm run test:smoke
A2MCP_BASE_URL=https://your-domain.example npm run test:x402
```

Production verification should confirm:

- `/health` reports version `0.3.0` and eight services.
- `/metadata` exposes eight distinct service descriptions and fees.
- `/openapi.json` contains every canonical path.
- `GET /mcp` exposes eight tools.
- Unpaid production calls return HTTP 402 with the correct absolute resource URL and fee.
- A valid paid call settles through the OKX facilitator before the result is used for marketplace review.

## Safety Boundary

The suite is read-only. It does not sign transactions, execute swaps, guarantee outcomes, or present results as financial advice. Risk scores summarize available evidence and always retain source and coverage information.
