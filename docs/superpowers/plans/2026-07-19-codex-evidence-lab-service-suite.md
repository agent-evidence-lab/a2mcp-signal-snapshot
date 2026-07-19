# Codex Evidence Lab Service Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand OKX.AI Agent #3359 into eight independently callable x402 API services plus one A2A custom research service, deploy the suite to Zeabur, and resubmit the existing Agent for review.

**Architecture:** Keep Express, the OKX x402 middleware, and the current Zeabur deployment entry point. Extract the service catalog, upstream clients, and analysis functions from `src/server.js` into focused modules, then expose eight paid routes and compatibility aliases through the existing HTTP and MCP surfaces. Use DexScreener as the primary market source, GoPlus for EVM security and holder data, and GeckoTerminal only as a bounded fallback.

**Tech Stack:** Node.js 22, Express 5, built-in `node:test`, OKX x402 packages, DexScreener REST API, GoPlus Security API, GeckoTerminal API, Docker/Zeabur.

---

## File Map

- Create `src/intelligence/catalog.js`: service definitions, fees, schemas, endpoint paths, aliases.
- Create `src/intelligence/cache.js`: bounded TTL cache used by upstream clients.
- Create `src/intelligence/providers.js`: DexScreener, GoPlus, and GeckoTerminal clients plus chain maps.
- Create `src/intelligence/market-analyses.js`: five market-data service builders.
- Create `src/intelligence/security-analyses.js`: contract/tax, holder concentration, and comprehensive report builders.
- Create `test/fixtures.js`: deterministic upstream response fixtures.
- Create `test/catalog.test.js`: catalog, path, fee, and alias tests.
- Create `test/providers.test.js`: cache, chain support, timeout, and response normalization tests.
- Create `test/market-analyses.test.js`: market service output tests.
- Create `test/security-analyses.test.js`: security and composite service output tests.
- Modify `src/server.js`: import modules, wire routes/MCP/x402, retain old route aliases.
- Modify `scripts/smoke-test.js`: exercise all eight demo endpoints and compatibility paths.
- Modify `scripts/x402-smoke-test.js`: verify HTTP 402 and per-service amounts for all paid routes.
- Modify `package.json`: add unit-test scripts and run unit tests before smoke tests.
- Modify `.env.example`: add provider timeout/cache settings and optional GoPlus token.
- Modify `README.md`: document all services, inputs, prices, data coverage, and deployment checks.

### Task 1: Add the canonical service catalog

**Files:**
- Create: `src/intelligence/catalog.js`
- Create: `test/catalog.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write the failing catalog test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { API_SERVICES, SERVICE_BY_PATH, feeToMinimal } from "../src/intelligence/catalog.js";

test("catalog exposes eight unique paid API services", () => {
  assert.equal(API_SERVICES.length, 8);
  assert.equal(new Set(API_SERVICES.map((service) => service.id)).size, 8);
  assert.equal(new Set(API_SERVICES.map((service) => service.path)).size, 8);
  assert.deepEqual(API_SERVICES.map((service) => service.fee), [
    "0.01", "0.01", "0.01", "0.01", "0.01", "0.02", "0.02", "0.03",
  ]);
});

test("legacy paths resolve to canonical services", () => {
  assert.equal(SERVICE_BY_PATH.get("/api/token-risk-scan").id, "pretrade-risk-report");
  assert.equal(SERVICE_BY_PATH.get("/api/ape-pretrade-check").id, "new-pair-risk-check");
  assert.equal(SERVICE_BY_PATH.get("/api/signal-snapshot").id, "token-market-snapshot");
});

test("decimal service fees convert to exact six-decimal token amounts", () => {
  assert.equal(feeToMinimal("0.01", 6), "10000");
  assert.equal(feeToMinimal("0.02", 6), "20000");
  assert.equal(feeToMinimal("0.03", 6), "30000");
});
```

- [ ] **Step 2: Add the unit-test script and verify RED**

Change `package.json` scripts to include:

```json
"test:unit": "node --test test/*.test.js",
"test:smoke": "node scripts/smoke-test.js",
"test": "npm run test:unit && npm run test:smoke"
```

Run: `npm run test:unit`

Expected: FAIL because `src/intelligence/catalog.js` does not exist.

- [ ] **Step 3: Implement the catalog**

Create a frozen service list with these canonical values:

```js
const baseInput = {
  type: "object",
  required: ["chain", "token_address"],
  properties: {
    chain: { type: "string" },
    token_address: { type: "string", minLength: 3 },
    language: { type: "string", default: "zh-CN" },
  },
};

const definitions = [
  ["token-market-snapshot", "代币市场快照", "/api/token-market-snapshot", "token_market_snapshot", "0.01"],
  ["liquidity-risk-scan", "流动性风险扫描", "/api/liquidity-risk-scan", "liquidity_risk_scan", "0.01"],
  ["trading-activity-scan", "成交活跃度分析", "/api/trading-activity-scan", "trading_activity_scan", "0.01"],
  ["new-pair-risk-check", "新币启动风险检查", "/api/new-pair-risk-check", "new_pair_risk_check", "0.01"],
  ["market-anomaly-scan", "价格成交异常扫描", "/api/market-anomaly-scan", "market_anomaly_scan", "0.01"],
  ["contract-tax-check", "合约权限与交易税检查", "/api/contract-tax-check", "contract_tax_check", "0.02"],
  ["holder-concentration-check", "持仓集中度检查", "/api/holder-concentration-check", "holder_concentration_check", "0.02"],
  ["pretrade-risk-report", "综合交易前风险报告", "/api/pretrade-risk-report", "pretrade_risk_report", "0.03"],
];

export const API_SERVICES = Object.freeze(definitions.map(([id, name, path, endpoint, fee]) => ({
  id, name, path, endpoint, fee, inputSchema: structuredClone(baseInput),
})));

export const LEGACY_PATHS = Object.freeze({
  "/api/token-risk-scan": "pretrade-risk-report",
  "/api/ape-pretrade-check": "new-pair-risk-check",
  "/api/signal-snapshot": "token-market-snapshot",
});

export const SERVICE_BY_ID = new Map(API_SERVICES.map((service) => [service.id, service]));
export const SERVICE_BY_PATH = new Map(API_SERVICES.map((service) => [service.path, service]));
for (const [path, id] of Object.entries(LEGACY_PATHS)) SERVICE_BY_PATH.set(path, SERVICE_BY_ID.get(id));

export function feeToMinimal(fee, decimals) {
  const [whole = "0", fraction = ""] = String(fee).split(".");
  const padded = `${fraction}${"0".repeat(decimals)}`.slice(0, decimals);
  return (BigInt(whole || "0") * (10n ** BigInt(decimals)) + BigInt(padded || "0")).toString();
}
```

Add each approved two-part marketplace description and per-service optional fields to its catalog object; security services set `supportedSecurityChains` to the EVM chain list.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:unit`

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/intelligence/catalog.js test/catalog.test.js
git commit -m "Add eight-service intelligence catalog"
```

### Task 2: Add bounded provider clients and caching

**Files:**
- Create: `src/intelligence/cache.js`
- Create: `src/intelligence/providers.js`
- Create: `test/fixtures.js`
- Create: `test/providers.test.js`

- [ ] **Step 1: Write failing provider tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createTtlCache } from "../src/intelligence/cache.js";
import { createProviders, isSecurityChainSupported } from "../src/intelligence/providers.js";
import { dexPairs, goPlusToken } from "./fixtures.js";

test("ttl cache reuses a value before expiry", async () => {
  let calls = 0;
  const cache = createTtlCache({ maxEntries: 4 });
  const first = await cache.getOrLoad("token", 1_000, async () => ++calls);
  const second = await cache.getOrLoad("token", 1_000, async () => ++calls);
  assert.equal(first, 1);
  assert.equal(second, 1);
  assert.equal(calls, 1);
});

test("providers normalize market and EVM security data", async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => String(url).includes("goplus") ? goPlusToken : dexPairs,
  });
  const providers = createProviders({ fetchImpl, timeoutMs: 500 });
  const market = await providers.market("ethereum", "0xabc");
  const security = await providers.security("ethereum", "0xabc");
  assert.equal(market.primaryPair.pairAddress, "0xpair");
  assert.equal(security.isHoneypot, false);
  assert.equal(security.holders.length, 2);
});

test("security coverage is explicit", () => {
  assert.equal(isSecurityChainSupported("ethereum"), true);
  assert.equal(isSecurityChainSupported("solana"), false);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:unit`

Expected: FAIL because cache/provider modules do not exist.

- [ ] **Step 3: Implement the TTL cache**

```js
export function createTtlCache({ maxEntries = 256, now = () => Date.now() } = {}) {
  const entries = new Map();
  return {
    async getOrLoad(key, ttlMs, loader) {
      const hit = entries.get(key);
      if (hit && hit.expiresAt > now()) return hit.value;
      const value = await loader();
      entries.set(key, { value, expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      return value;
    },
  };
}
```

- [ ] **Step 4: Implement provider normalization**

Use these chain maps and contracts:

```js
const DEX_CHAIN = new Set(["solana", "ethereum", "xlayer", "base", "bsc", "arbitrum", "polygon"]);
const GOPLUS_CHAIN = new Map([
  ["ethereum", "1"], ["bsc", "56"], ["polygon", "137"],
  ["arbitrum", "42161"], ["base", "8453"], ["xlayer", "196"],
]);

export const isSecurityChainSupported = (chain) => GOPLUS_CHAIN.has(String(chain).toLowerCase());
```

`createProviders({ fetchImpl = fetch, timeoutMs = 5_000 })` must expose:

- `market(chain, tokenAddress)`: fetch DexScreener token pairs, select the highest-liquidity pair, and preserve all pairs and source URLs.
- `security(chain, tokenAddress)`: reject unsupported chains with `SECURITY_CHAIN_UNSUPPORTED`; fetch GoPlus and normalize booleans, tax decimals, holders, owner/creator percentages, and unknown fields.
- `marketFallback(chain, tokenAddress)`: fetch GeckoTerminal only after the market call has no usable pair.

Every request uses `AbortSignal.timeout(timeoutMs)`. HTTP 429 becomes `UPSTREAM_RATE_LIMITED`; timeout becomes `UPSTREAM_TIMEOUT`; other non-2xx responses become `UPSTREAM_FAILURE`. Market cache TTL is read from `MARKET_CACHE_MS` with default `30000`; security cache TTL is read from `SECURITY_CACHE_MS` with default `300000`.

- [ ] **Step 5: Verify GREEN**

Run: `npm run test:unit`

Expected: provider and cache tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/intelligence/cache.js src/intelligence/providers.js test/fixtures.js test/providers.test.js
git commit -m "Add cached market and security providers"
```

### Task 3: Implement five market analysis services

**Files:**
- Create: `src/intelligence/market-analyses.js`
- Create: `test/market-analyses.test.js`

- [ ] **Step 1: Write failing analysis tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMarketSnapshot, buildLiquidityRisk, buildTradingActivity,
  buildNewPairRisk, buildMarketAnomaly,
} from "../src/intelligence/market-analyses.js";
import { normalizedMarket } from "./fixtures.js";

const input = { chain: "ethereum", token_address: "0xabc", language: "zh-CN" };

test("market services produce distinct structured results", () => {
  assert.equal(buildMarketSnapshot(input, normalizedMarket).service.id, "token-market-snapshot");
  assert.ok(buildLiquidityRisk(input, normalizedMarket).liquidity.totalUsd > 0);
  assert.ok(buildTradingActivity(input, normalizedMarket).activity.windows.h24.volumeUsd > 0);
  assert.ok(buildNewPairRisk(input, normalizedMarket).pairAgeHours >= 0);
  assert.ok(Array.isArray(buildMarketAnomaly(input, normalizedMarket).anomalies));
});
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:unit`

Expected: FAIL because `market-analyses.js` does not exist.

- [ ] **Step 3: Implement shared response fields and five builders**

Each builder returns its own result object while sharing this envelope:

```js
function envelope(serviceId, input, sources, dataQuality) {
  return {
    ok: true,
    service: { id: serviceId, version: "0.3.0" },
    request_id: crypto.randomUUID(),
    generated_at: new Date().toISOString(),
    input,
    data_quality: dataQuality,
    sources,
  };
}
```

Implement deterministic scoring rules:

- Liquidity: critical below $10k, high below $50k, medium below $200k, low otherwise; add a concentration flag when one pool holds at least 90% of observed liquidity.
- Activity: return 5m/1h/6h/24h volume and buy/sell counts; classify inactive when 24h transactions are zero and one-sided when one side exceeds 80% of transactions.
- New pair: critical below 6h, high below 24h, medium below 7d, low otherwise, then raise one level for liquidity below $50k.
- Anomaly: flag absolute 1h price change at least 20%, absolute 24h change at least 50%, buy ratio at least 85%, sell ratio at least 85%, or 24h volume/liquidity at least 5.
- Snapshot: return identity, primary pool, price, market cap, FDV, liquidity, change windows, transaction windows, and sources without duplicating the risk reports.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:unit`

Expected: market analysis tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/intelligence/market-analyses.js test/market-analyses.test.js
git commit -m "Add five market intelligence services"
```

### Task 4: Implement security and comprehensive services

**Files:**
- Create: `src/intelligence/security-analyses.js`
- Create: `test/security-analyses.test.js`

- [ ] **Step 1: Write failing security tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContractTaxCheck, buildHolderConcentration, buildPretradeReport,
} from "../src/intelligence/security-analyses.js";
import { normalizedMarket, normalizedSecurity } from "./fixtures.js";

const input = { chain: "ethereum", token_address: "0xabc", language: "zh-CN" };

test("contract and holder services expose evidence", () => {
  const contract = buildContractTaxCheck(input, normalizedSecurity);
  const holders = buildHolderConcentration(input, normalizedSecurity);
  assert.equal(contract.contract.isOpenSource, true);
  assert.equal(contract.trading.isHoneypot, false);
  assert.equal(holders.concentration.top10Percent, 0.42);
});

test("comprehensive report labels partial non-EVM coverage", () => {
  const report = buildPretradeReport(input, normalizedMarket, normalizedSecurity);
  assert.equal(typeof report.risk_score, "number");
  assert.ok(report.sections.market);
  assert.ok(report.sections.contract);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:unit`

Expected: FAIL because `security-analyses.js` does not exist.

- [ ] **Step 3: Implement security reports**

Normalize every unknown upstream field to `{ status: "unknown", value: null }`; never treat missing as safe. Contract flags include closed source, proxy, mintable, pausable, blacklist, modifiable tax, honeypot, cannot buy, and cannot sell all. Tax flags use medium at 5% and high at 10%.

Holder concentration computes:

```js
const top10Percent = holders.slice(0, 10).reduce((sum, holder) => sum + holder.percent, 0);
const concentrationLevel = top10Percent >= 0.8 ? "critical"
  : top10Percent >= 0.6 ? "high"
    : top10Percent >= 0.4 ? "medium" : "low";
```

The comprehensive report calls the five market builders and two security builders with already-fetched data, combines section scores using market 35%, liquidity 20%, activity/anomaly 15%, contract/tax 20%, and holders 10%, and returns `coverage: "full"` for supported EVM security data or `coverage: "market-only"` elsewhere.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:unit`

Expected: security and comprehensive tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/intelligence/security-analyses.js test/security-analyses.test.js
git commit -m "Add contract holder and pretrade reports"
```

### Task 5: Wire HTTP, MCP, OpenAPI, aliases, and x402

**Files:**
- Modify: `src/server.js`
- Modify: `scripts/smoke-test.js`
- Modify: `scripts/x402-smoke-test.js`

- [ ] **Step 1: Expand smoke tests before route implementation**

Replace the three-endpoint assumptions with the eight canonical paths from the catalog. For demo mode, assert each response has `ok`, `service.id`, `request_id`, `generated_at`, `data_quality`, and `sources`. Keep explicit assertions for each service-specific section. Add alias assertions:

```js
assert.equal((await postJson("/api/token-risk-scan", tokenBody)).service.id, "pretrade-risk-report");
assert.equal((await postJson("/api/ape-pretrade-check", tokenBody)).service.id, "new-pair-risk-check");
assert.equal((await postJson("/api/signal-snapshot", tokenBody)).service.id, "token-market-snapshot");
```

For mock x402 mode, iterate all eight canonical paths plus `/mcp`. Decode `payment-required` and assert:

```js
assert.equal(decoded.resource.url, `${baseUrl}${path}`);
  assert.equal(requirement.amount, feeToMinimal(service.fee, 6));
assert.equal(requirement.asset.toLowerCase(), process.env.X402_ASSET.toLowerCase());
```

- [ ] **Step 2: Verify RED**

Run: `npm run test:smoke && npm run test:x402`

Expected: FAIL on the first new route with HTTP 404.

- [ ] **Step 3: Refactor server wiring**

Import catalog, providers, and builders. Replace the old `SERVICE_CATALOG` with `API_SERVICES`, and create one dispatcher:

```js
async function executeService(service, input) {
  const market = await providers.market(input.chain, input.token_address);
  if (service.id === "token-market-snapshot") return buildMarketSnapshot(input, market);
  if (service.id === "liquidity-risk-scan") return buildLiquidityRisk(input, market);
  if (service.id === "trading-activity-scan") return buildTradingActivity(input, market);
  if (service.id === "new-pair-risk-check") return buildNewPairRisk(input, market);
  if (service.id === "market-anomaly-scan") return buildMarketAnomaly(input, market);
  const security = isSecurityChainSupported(input.chain)
    ? await providers.security(input.chain, input.token_address)
    : null;
  if (service.id === "contract-tax-check") return buildContractTaxCheck(input, security);
  if (service.id === "holder-concentration-check") return buildHolderConcentration(input, security);
  if (service.id === "pretrade-risk-report") return buildPretradeReport(input, market, security);
  throw Object.assign(new Error("Unknown service"), { code: "SERVICE_NOT_FOUND" });
}
```

Register canonical routes and aliases through a shared handler. Replace the global `paymentPrice()` and `pricing()` helpers with service-aware versions:

```js
function paymentPrice(service) {
  return {
    asset: X402_ASSET,
    amount: feeToMinimal(service.fee, X402_TOKEN_DECIMALS),
    extra: paymentAssetExtra(),
  };
}

function pricing(service) {
  return {
    scheme: "exact",
    network: X402_NETWORK,
    price: `$${service.fee}`,
    amountMinimal: feeToMinimal(service.fee, X402_TOKEN_DECIMALS),
    asset: X402_ASSET,
    token: paymentAssetExtra(),
    payTo: X402_PAY_TO,
  };
}
```

The payment guard protects each canonical route and alias with `paymentPrice(service)`. The shared `/mcp` route uses `MCP_FEE_USDT` with default `0.03` because the payment challenge is issued before the selected tool is parsed. Generate MCP tools and OpenAPI paths from the same catalog. Preserve `/health`, `/metadata`, `/mcp`, and existing facilitator behavior.

- [ ] **Step 4: Verify GREEN**

Run: `npm test && npm run test:x402 && npm run test:facilitator-config`

Expected: all unit, demo smoke, x402, compatibility, and facilitator tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server.js scripts/smoke-test.js scripts/x402-smoke-test.js
git commit -m "Expose the full paid intelligence suite"
```

### Task 6: Update configuration and operator documentation

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Add configuration fields**

Append to `.env.example`:

```dotenv
UPSTREAM_TIMEOUT_MS=5000
MARKET_CACHE_MS=30000
SECURITY_CACHE_MS=300000
GOPLUS_ACCESS_TOKEN=
GECKOTERMINAL_API_BASE=https://api.geckoterminal.com/api/v2
MCP_FEE_USDT=0.03
```

Keep `.env` ignored and do not copy any live credential into the repository.

- [ ] **Step 2: Replace the README catalog**

Document the eight names, canonical paths, prices, inputs, network coverage, aliases, cache defaults, x402 behavior, local commands, and production verification. State that market services cover the configured seven chains and security/holder fields are EVM-only until a separately tested Solana provider is connected.

- [ ] **Step 3: Run documentation and test checks**

Run:

```bash
git diff --check
npm test
npm run test:x402
npm run test:facilitator-config
```

Expected: no whitespace errors and all tests pass.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "Document the expanded intelligence suite"
```

### Task 7: Deploy and verify Zeabur

**Files:**
- No repository files unless deployment diagnostics require a narrowly scoped fix.

- [ ] **Step 1: Push the tested branch**

Run: `git push origin main`

Expected: GitHub accepts all commits and Zeabur starts a deployment from the new commit.

- [ ] **Step 2: Verify deployment health**

Poll only the Zeabur deployment status until it reaches running or fails. Then call:

```bash
curl -fsS https://evidence-mcp.zeabur.app/health
curl -fsS https://evidence-mcp.zeabur.app/metadata
curl -fsS https://evidence-mcp.zeabur.app/openapi.json
```

Expected: version `0.3.0`, eight services, eight OpenAPI paths, and healthy status.

- [ ] **Step 3: Verify public x402 challenges**

For each canonical path, send one unpaid POST with a valid sample body. Expect HTTP 402, a `payment-required` header, the correct full HTTPS resource URL, and the per-service amount. This check does not authorize or settle payment.

- [ ] **Step 4: Verify A2A readiness**

On the Zeabur host, confirm the official A2A daemon reports ready, all identities are active, and the fast acknowledgement listener is running. Send a non-commercial test message from the test user to #3359 and verify receive-to-ACK latency in logs. Do not apply, quote, accept, pay, or deliver a task during this test.

### Task 8: Update #3359 and resubmit

**Files:**
- No repository files.

- [ ] **Step 1: Refresh the current Agent and service records**

Read #3359 and its service list immediately before mutation. Verify the owner address remains `0xa66f492f6f4a5a2b028f18355b63ce240940e0e5`, status remains rejected/not listed, and service IDs `33822`, `33823`, and `33824` still target the expected records.

- [ ] **Step 2: Run listing QA once**

Validate the final Agent description and all nine service descriptions exactly once. Resolve any validator findings before presenting the write confirmation; do not silently weaken capabilities or broaden coverage.

- [ ] **Step 3: Present the mutation confirmation card**

Show a three-column before/after/change card containing the Agent description, three updated service records, six created service records, fees, endpoints, and the explicit EVM-only boundary. Mark drafted wording for review. Stop until the user replies `1`.

- [ ] **Step 4: Save the confirmed update**

Update Agent #3359 only. Use existing service IDs for the three updates and create operations without IDs for the six new services. Verify the returned Agent ID and service count.

- [ ] **Step 5: Present the resubmission gate**

Because activation sends the rejected listing back to review, tell the user the deployment and A2A test results and ask for explicit confirmation before resubmitting.

- [ ] **Step 6: Reactivate and verify review state**

After confirmation, activate #3359 with preferred language `zh-CN`. Read the direct response once: expected outcome is submitted for review or under review. Do not poll repeatedly. Report Agent ID, name, review status, online status, communication address, and owner address.
