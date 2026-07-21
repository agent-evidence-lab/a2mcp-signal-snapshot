import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLiquidityRisk,
  buildMarketAnomaly,
  buildMarketSnapshot,
  buildNewPairRisk,
  buildTradingActivity,
} from "../src/intelligence/market-analyses.js";

const input = Object.freeze({
  chain: "ethereum",
  token_address: "0x1111111111111111111111111111111111111111",
  language: "zh-CN",
});

const FIXED_NOW = Date.parse("2026-07-19T08:00:00.000Z");
const FIXED_UUID = "11111111-1111-4111-8111-111111111111";
const HOUR_MS = 60 * 60 * 1_000;
const deterministic = Object.freeze({
  now: () => FIXED_NOW,
  requestId: () => FIXED_UUID,
});

function pair(overrides = {}) {
  return {
    chainId: "ethereum",
    dexId: "uniswap",
    pairAddress: "0xpair-primary",
    labels: ["v3"],
    baseToken: {
      address: input.token_address,
      name: "Evidence Token",
      symbol: "EVD",
    },
    quoteToken: {
      address: "0x2222222222222222222222222222222222222222",
      name: "USD Coin",
      symbol: "USDC",
    },
    priceNative: 0.0004,
    priceUsd: 1.25,
    priceChange: { m5: 1, h1: 5, h6: 9, h24: 15 },
    volume: { m5: 100, h1: 1_000, h6: 6_000, h24: 25_000 },
    txns: {
      m5: { buys: 4, sells: 2 },
      h1: { buys: 30, sells: 20 },
      h6: { buys: 120, sells: 80 },
      h24: { buys: 400, sells: 300 },
    },
    liquidity: { usd: 250_000, base: 100_000, quote: 125_000 },
    marketCap: 1_000_000,
    fdv: 1_250_000,
    pairCreatedAt: FIXED_NOW - (14 * 24 * 60 * 60 * 1_000),
    url: "https://dexscreener.com/ethereum/0xpair-primary",
    source: "dexscreener",
    sourceUrl: "https://api.dexscreener.com/token-pairs/v1/ethereum/token",
    accessedAt: "2026-07-19T07:59:30.000Z",
    ...overrides,
  };
}

function market(primary = pair(), additionalPairs = []) {
  const pairs = primary ? [primary, ...additionalPairs] : [...additionalPairs];
  return {
    chain: "ethereum",
    tokenAddress: input.token_address,
    source: "dexscreener",
    sourceUrl: "https://api.dexscreener.com/token-pairs/v1/ethereum/token",
    accessedAt: "2026-07-19T07:59:30.000Z",
    pairs,
    primaryPair: primary,
    sources: [{
      source: "dexscreener",
      url: "https://api.dexscreener.com/token-pairs/v1/ethereum/token",
      accessedAt: "2026-07-19T07:59:30.000Z",
      status: primary ? "ok" : "empty",
      pairCount: pairs.length,
      usablePairCount: primary ? pairs.length : 0,
    }],
    data_quality: {
      provider_status: "ok",
      warnings: ["provider supplied normalized market data"],
    },
  };
}

function withLiquidity(totalUsd) {
  return market(pair({ liquidity: { usd: totalUsd, base: null, quote: null } }));
}

function withoutProviderWarnings(value = market()) {
  const copy = structuredClone(value);
  delete copy.data_quality;
  return copy;
}

function assertAllNumbersFinite(value, path = "result") {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${path} must be finite`);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertAllNumbersFinite(item, `${path}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    assertAllNumbersFinite(item, `${path}.${key}`);
  }
}

test("all five builders return the exact shared envelope and unique catalog service ids", () => {
  const results = [
    buildMarketSnapshot(input, market(), deterministic),
    buildLiquidityRisk(input, market(), deterministic),
    buildTradingActivity(input, market(), deterministic),
    buildNewPairRisk(input, market(), deterministic),
    buildMarketAnomaly(input, market(), deterministic),
  ];

  assert.deepEqual(results.map((result) => result.service.id), [
    "token-market-snapshot",
    "liquidity-risk-scan",
    "trading-activity-scan",
    "new-pair-risk-check",
    "market-anomaly-scan",
  ]);
  assert.equal(new Set(results.map((result) => result.service.id)).size, 5);

  for (const result of results) {
    assert.equal(result.ok, true);
    assert.equal(result.service.version, "0.3.0");
    assert.equal(result.request_id, FIXED_UUID);
    assert.equal(result.generated_at, "2026-07-19T08:00:00.000Z");
    assert.deepEqual(result.input, input);
    assert.deepEqual(result.sources, market().sources);
    assert.equal(result.data_quality.provider_status, "ok");
    assert.ok(result.data_quality.warnings.includes("provider supplied normalized market data"));
  }
});

test("market snapshot reports informational classification with identity, valuation, windows, age, and pools", () => {
  const secondary = pair({
    pairAddress: "0xpair-secondary",
    dexId: "sushiswap",
    liquidity: { usd: 50_000, base: null, quote: null },
    url: "https://dexscreener.com/ethereum/0xpair-secondary",
  });
  const result = buildMarketSnapshot(input, market(pair(), [secondary]), deterministic);

  assert.deepEqual(result.identity, {
    chain: "ethereum",
    token_address: input.token_address,
    name: "Evidence Token",
    symbol: "EVD",
  });
  assert.equal(result.price.usd, 1.25);
  assert.equal(result.valuation.market_cap_usd, 1_000_000);
  assert.equal(result.valuation.fdv_usd, 1_250_000);
  assert.equal(result.primary_pool.pair_address, "0xpair-primary");
  assert.equal(result.liquidity.primary_pool_usd, 250_000);
  assert.equal(result.liquidity.observed_total_usd, 300_000);
  assert.equal(result.price_changes.h1, 5);
  assert.equal(result.volume.h24, 25_000);
  assert.deepEqual(result.transactions.h24, { buys: 400, sells: 300, total: 700 });
  assert.equal(result.pair_age_hours, 336);
  assert.deepEqual(result.top_pools.map((pool) => pool.pair_address), [
    "0xpair-primary",
    "0xpair-secondary",
  ]);
  assert.equal(result.classification, "informational");
  assert.deepEqual(result.flags, []);
  assert.equal("anomalies" in result, false);
});

test("market snapshot preserves unknown values and warns when the primary pair is unavailable", () => {
  const result = buildMarketSnapshot(input, market(null), deterministic);

  assert.equal(result.identity.name, null);
  assert.equal(result.price.usd, null);
  assert.equal(result.liquidity.primary_pool_usd, null);
  assert.equal(result.pair_age_hours, null);
  assert.deepEqual(result.top_pools, []);
  assert.ok(result.data_quality.warnings.includes("primary_pair_unavailable"));
  assert.ok(result.data_quality.warnings.includes("pair_created_at_unavailable"));
});

test("data quality is complete only when primary data and every source are healthy without warnings", () => {
  const result = buildMarketSnapshot(input, withoutProviderWarnings(), deterministic);

  assert.equal(result.data_quality.status, "complete");
  assert.deepEqual(result.data_quality.warnings, []);
  assert.deepEqual(result.data_quality.source_statuses, [{
    source: "dexscreener",
    status: "ok",
    url: "https://api.dexscreener.com/token-pairs/v1/ethereum/token",
  }]);
  assert.deepEqual(result.data_quality.fallback, { used: false, reason: null });
});

test("data quality marks successful fallback as partial with explicit source provenance", () => {
  const fallbackMarket = withoutProviderWarnings();
  fallbackMarket.source = "geckoterminal";
  fallbackMarket.sources = [
    {
      source: "dexscreener",
      status: "empty",
      url: "https://api.dexscreener.com/token-pairs/v1/ethereum/token",
      pairCount: 0,
      usablePairCount: 0,
    },
    {
      source: "geckoterminal",
      status: "ok",
      url: "https://api.geckoterminal.com/api/v2/networks/eth/tokens/token/pools",
      pairCount: 1,
      usablePairCount: 1,
    },
  ];
  fallbackMarket.fallback = { reason: "dexscreener_empty", attemptedPairs: [] };

  const result = buildMarketSnapshot(input, fallbackMarket, deterministic);

  assert.equal(result.data_quality.status, "partial");
  assert.deepEqual(result.data_quality.fallback, {
    used: true,
    reason: "dexscreener_empty",
  });
  assert.ok(result.data_quality.warnings.includes("market_fallback_used:dexscreener_empty"));
  assert.ok(result.data_quality.warnings.includes("source_degraded:dexscreener:empty"));
  assert.deepEqual(result.data_quality.source_statuses.map(({ source, status }) => ({ source, status })), [
    { source: "dexscreener", status: "empty" },
    { source: "geckoterminal", status: "ok" },
  ]);
  assert.deepEqual(result.sources, fallbackMarket.sources);
});

test("liquidity risk uses exact 10k, 50k, and 200k boundaries", () => {
  const cases = [
    [9_999.99, "critical"],
    [10_000, "high"],
    [49_999.99, "high"],
    [50_000, "medium"],
    [199_999.99, "medium"],
    [200_000, "low"],
  ];

  for (const [liquidity, expected] of cases) {
    assert.equal(buildLiquidityRisk(input, withLiquidity(liquidity), deterministic).risk_level, expected);
  }
});

test("liquidity risk distinguishes observed zero from missing liquidity", () => {
  const zero = buildLiquidityRisk(input, withLiquidity(0), deterministic);
  const missing = buildLiquidityRisk(
    input,
    market(pair({ liquidity: { usd: null, base: null, quote: null } })),
    deterministic,
  );

  assert.equal(zero.liquidity.total_usd, 0);
  assert.equal(zero.risk_level, "critical");
  assert.equal(zero.liquidity.primary_share, null);
  assert.equal(missing.liquidity.total_usd, null);
  assert.equal(missing.risk_level, "unknown");
  assert.ok(missing.flags.includes("liquidity_unknown"));
});

test("liquidity risk flags primary-pool concentration at exactly 90 percent", () => {
  const primary = pair({ liquidity: { usd: 90_000, base: null, quote: null } });
  const secondary = pair({
    pairAddress: "0xpair-secondary",
    liquidity: { usd: 10_000, base: null, quote: null },
  });
  const concentrated = buildLiquidityRisk(input, market(primary, [secondary]), deterministic);
  const diversified = buildLiquidityRisk(
    input,
    market(
      pair({ liquidity: { usd: 89_999, base: null, quote: null } }),
      [pair({ pairAddress: "0xpair-secondary", liquidity: { usd: 10_001, base: null, quote: null } })],
    ),
    deterministic,
  );

  assert.equal(concentrated.liquidity.primary_share, 0.9);
  assert.ok(concentrated.flags.includes("primary_pool_concentration"));
  assert.ok(!diversified.flags.includes("primary_pool_concentration"));
});

test("liquidity risk respects the optional minimum-liquidity threshold", () => {
  const result = buildLiquidityRisk(
    { ...input, min_liquidity_usd: 300_000 },
    withLiquidity(250_000),
    deterministic,
  );

  assert.equal(result.liquidity.min_liquidity_usd, 300_000);
  assert.equal(result.liquidity.meets_minimum, false);
  assert.ok(result.flags.includes("below_requested_minimum"));
});

test("liquidity risk treats exact requested minimum liquidity as meeting the threshold", () => {
  const result = buildLiquidityRisk(
    { ...input, min_liquidity_usd: 250_000 },
    withLiquidity(250_000),
    deterministic,
  );

  assert.equal(result.liquidity.meets_minimum, true);
  assert.ok(!result.flags.includes("below_requested_minimum"));
});

test("trading activity exposes all required windows and classifies zero 24h transactions as inactive", () => {
  const primary = pair({
    volume: { m5: 0, h1: 0, h6: 0, h24: 0 },
    txns: {
      m5: { buys: 0, sells: 0 },
      h1: { buys: 0, sells: 0 },
      h6: { buys: 0, sells: 0 },
      h24: { buys: 0, sells: 0 },
    },
  });
  const result = buildTradingActivity(input, market(primary), deterministic);

  assert.deepEqual(Object.keys(result.activity.windows), ["m5", "h1", "h6", "h24"]);
  assert.deepEqual(result.activity.windows.h24, {
    volume_usd: 0,
    buy_count: 0,
    sell_count: 0,
    total_transactions: 0,
    buy_ratio: null,
    sell_ratio: null,
  });
  assert.equal(result.activity.classification, "inactive");
  assert.ok(result.flags.includes("inactive_24h"));
});

test("trading activity does not mark exactly 80 percent as one-sided but flags values above it", () => {
  const exact = buildTradingActivity(
    input,
    market(pair({ txns: { h24: { buys: 80, sells: 20 } } })),
    deterministic,
  );
  const above = buildTradingActivity(
    input,
    market(pair({ txns: { h24: { buys: 81, sells: 19 } } })),
    deterministic,
  );

  assert.equal(exact.activity.windows.h24.buy_ratio, 0.8);
  assert.equal(exact.activity.classification, "active");
  assert.ok(!exact.flags.includes("one_sided_buying"));
  assert.equal(above.activity.windows.h24.buy_ratio, 0.81);
  assert.equal(above.activity.classification, "one-sided");
  assert.ok(above.flags.includes("one_sided_buying"));
});

test("trading activity does not mark exactly 80 percent selling as one-sided but flags values above it", () => {
  const exact = buildTradingActivity(
    input,
    market(pair({ txns: { h24: { buys: 20, sells: 80 } } })),
    deterministic,
  );
  const above = buildTradingActivity(
    input,
    market(pair({ txns: { h24: { buys: 19, sells: 81 } } })),
    deterministic,
  );

  assert.equal(exact.activity.windows.h24.sell_ratio, 0.8);
  assert.equal(exact.activity.classification, "active");
  assert.ok(!exact.flags.includes("one_sided_selling"));
  assert.equal(above.activity.windows.h24.sell_ratio, 0.81);
  assert.equal(above.activity.classification, "one-sided");
  assert.ok(above.flags.includes("one_sided_selling"));
});

test("trading activity keeps missing windows and partial counts unknown", () => {
  const result = buildTradingActivity(
    input,
    market(pair({ volume: { h24: 1_000 }, txns: { h24: { buys: 5 } } })),
    deterministic,
  );

  assert.equal(result.activity.windows.m5.volume_usd, null);
  assert.equal(result.activity.windows.m5.total_transactions, null);
  assert.equal(result.activity.windows.h24.buy_count, 5);
  assert.equal(result.activity.windows.h24.sell_count, null);
  assert.equal(result.activity.windows.h24.total_transactions, null);
  assert.equal(result.activity.classification, "unknown");
  assert.ok(result.data_quality.warnings.includes("activity_windows_incomplete"));
});

test("new-pair risk uses exact 6h, 24h, and 7d boundaries", () => {
  const cases = [
    [5.999, "critical"],
    [6, "high"],
    [23.999, "high"],
    [24, "medium"],
    [167.999, "medium"],
    [168, "low"],
  ];

  for (const [ageHours, expected] of cases) {
    const createdAt = FIXED_NOW - (ageHours * 60 * 60 * 1_000);
    const result = buildNewPairRisk(
      input,
      market(pair({ pairCreatedAt: createdAt, liquidity: { usd: 100_000 } })),
      deterministic,
    );
    assert.equal(result.risk_level, expected, `${ageHours}h should be ${expected}`);
  }
});

test("new-pair risk raises severity once below 50k liquidity and caps at critical", () => {
  const oldPair = pair({
    pairCreatedAt: FIXED_NOW - (14 * 24 * 60 * 60 * 1_000),
    liquidity: { usd: 49_999.99 },
  });
  const youngPair = pair({
    pairCreatedAt: FIXED_NOW - (2 * 60 * 60 * 1_000),
    liquidity: { usd: 49_999.99 },
  });

  assert.equal(buildNewPairRisk(input, market(oldPair), deterministic).risk_level, "medium");
  assert.equal(buildNewPairRisk(input, market(youngPair), deterministic).risk_level, "critical");
});

test("new-pair risk does not escalate at exactly 50k liquidity", () => {
  const oldPair = pair({
    pairCreatedAt: FIXED_NOW - (14 * 24 * 60 * 60 * 1_000),
    liquidity: { usd: 50_000 },
  });
  const result = buildNewPairRisk(input, market(oldPair), deterministic);

  assert.equal(result.risk_level, "low");
  assert.ok(!result.flags.includes("low_launch_liquidity"));
});

test("new-pair risk considers the conservative profile without weakening the mandatory 50k rule", () => {
  const primary = pair({
    pairCreatedAt: FIXED_NOW - (14 * 24 * 60 * 60 * 1_000),
    liquidity: { usd: 75_000 },
  });
  const balanced = buildNewPairRisk(input, market(primary), deterministic);
  const conservative = buildNewPairRisk(
    { ...input, risk_profile: "conservative" },
    market(primary),
    deterministic,
  );

  assert.equal(balanced.risk_profile, "balanced");
  assert.equal(balanced.risk_level, "low");
  assert.equal(conservative.risk_profile, "conservative");
  assert.equal(conservative.risk_level, "medium");
  assert.ok(conservative.flags.includes("below_profile_liquidity_threshold"));
});

test("new-pair risk keeps missing creation time unknown instead of inferring safety", () => {
  const result = buildNewPairRisk(
    input,
    market(pair({ pairCreatedAt: null })),
    deterministic,
  );

  assert.equal(result.pair_age_hours, null);
  assert.equal(result.risk_level, "unknown");
  assert.ok(result.flags.includes("pair_age_unknown"));
});

test("new-pair risk does not infer low risk from old age when all critical launch evidence is missing", () => {
  const sparsePair = pair({
    pairCreatedAt: FIXED_NOW - (30 * 24 * 60 * 60 * 1_000),
    priceUsd: null,
    priceNative: null,
    priceChange: {},
    volume: {},
    txns: {},
    liquidity: { usd: null, base: null, quote: null },
  });
  const result = buildNewPairRisk(input, market(sparsePair), deterministic);

  assert.equal(result.pair_age_hours, 720);
  assert.equal(result.risk_level, "unknown");
  assert.ok(result.flags.includes("insufficient_launch_data"));
  assert.ok(result.data_quality.warnings.includes("launch_critical_inputs_unavailable"));
});

test("new-pair risk keeps an old pair unknown when static price is the only market evidence", () => {
  const sparsePair = pair({
    pairCreatedAt: FIXED_NOW - (30 * 24 * HOUR_MS),
    priceUsd: 1.25,
    priceNative: null,
    priceChange: {},
    volume: {},
    txns: {},
    liquidity: { usd: null, base: null, quote: null },
  });
  const result = buildNewPairRisk(input, market(sparsePair), deterministic);

  assert.equal(result.pair_age_hours, 720);
  assert.equal(result.risk_level, "unknown");
  assert.equal(result.coverage.price, true);
  assert.equal(result.coverage.trading, false);
  assert.equal(result.coverage.liquidity, false);
  assert.ok(result.flags.includes("insufficient_launch_data"));
});

test("market anomaly flags inclusive price, direction, and volume-liquidity thresholds", () => {
  const primary = pair({
    priceChange: { h1: -20, h24: 50 },
    volume: { h24: 500_000 },
    txns: { h24: { buys: 85, sells: 15 } },
    liquidity: { usd: 100_000 },
  });
  const result = buildMarketAnomaly(input, market(primary), deterministic);

  assert.deepEqual(result.anomalies.map((item) => item.code), [
    "price_change_h1",
    "price_change_h24",
    "buy_ratio_h24",
    "volume_liquidity_ratio_h24",
  ]);
  assert.equal(result.metrics.buy_ratio_h24, 0.85);
  assert.equal(result.metrics.volume_liquidity_ratio_h24, 5);
});

test("market anomaly flags the inclusive sell ratio boundary", () => {
  const result = buildMarketAnomaly(
    input,
    market(pair({ txns: { h24: { buys: 15, sells: 85 } } })),
    deterministic,
  );

  assert.ok(result.anomalies.some((item) => item.code === "sell_ratio_h24"));
});

test("market anomaly respects custom threshold and lookback without replacing core checks", () => {
  const result = buildMarketAnomaly(
    { ...input, lookback_hours: 6, anomaly_threshold: 10 },
    market(pair({ priceChange: { h1: 20, h6: 10, h24: 5 } })),
    deterministic,
  );

  assert.equal(result.custom_check.window, "h6");
  assert.equal(result.custom_check.threshold_percent, 10);
  assert.equal(result.custom_check.triggered, true);
  assert.ok(result.anomalies.some((item) => item.code === "price_change_h1"));
  assert.ok(result.anomalies.some((item) => item.code === "custom_price_change_h6"));
});

test("market anomaly does not flag values immediately below every core threshold", () => {
  const buySide = buildMarketAnomaly(
    input,
    market(pair({
      priceChange: { h1: 19.999, h24: 49.999 },
      volume: { h24: 499_900 },
      txns: { h24: { buys: 84_999, sells: 15_001 } },
      liquidity: { usd: 100_000 },
    })),
    deterministic,
  );
  const sellSide = buildMarketAnomaly(
    input,
    market(pair({
      priceChange: { h1: -19.999, h24: -49.999 },
      volume: { h24: 499_900 },
      txns: { h24: { buys: 15_001, sells: 84_999 } },
      liquidity: { usd: 100_000 },
    })),
    deterministic,
  );

  for (const result of [buySide, sellSide]) {
    assert.equal(result.metrics.volume_liquidity_ratio_h24, 4.999);
    assert.deepEqual(result.anomalies, []);
    assert.deepEqual(result.flags, []);
    assert.equal(result.risk_level, "low");
  }
});

test("market anomaly reports unknown when every core input is unavailable", () => {
  const result = buildMarketAnomaly(input, market(null), deterministic);

  assert.equal(result.data_quality.status, "unavailable");
  assert.equal(result.risk_level, "unknown");
  assert.deepEqual(result.anomalies, []);
  assert.ok(result.flags.includes("insufficient_market_data"));
  assert.ok(result.data_quality.warnings.includes("core_anomaly_inputs_unavailable"));
});

test("market anomaly treats one executable zero-change check as sparse rather than low risk", () => {
  const sparsePair = pair({
    priceChange: { h1: 0 },
    volume: {},
    txns: {},
    liquidity: { usd: null },
  });
  const result = buildMarketAnomaly(input, market(sparsePair), deterministic);

  assert.equal(result.risk_level, "unknown");
  assert.equal(result.confidence, "low");
  assert.deepEqual(result.coverage, {
    executable_checks: 1,
    total_checks: 5,
    ratio: 0.2,
    complete: false,
  });
  assert.deepEqual(result.anomalies, []);
  assert.ok(result.flags.includes("insufficient_market_data"));
  assert.ok(result.data_quality.warnings.includes("anomaly_check_coverage_incomplete"));
});

test("market anomaly honors a triggering custom-only check when default windows are unavailable", () => {
  const customOnlyPair = pair({
    priceChange: { h6: -12 },
    volume: {},
    txns: {},
    liquidity: { usd: null },
  });
  const result = buildMarketAnomaly(
    { ...input, lookback_hours: 6, anomaly_threshold: 10 },
    market(customOnlyPair),
    deterministic,
  );

  assert.equal(result.custom_check.triggered, true);
  assert.equal(result.risk_level, "medium");
  assert.equal(result.confidence, "low");
  assert.ok(result.flags.includes("custom_price_change_h6"));
  assert.ok(!result.flags.includes("insufficient_market_data"));
  assert.deepEqual(result.coverage, {
    executable_checks: 1,
    total_checks: 6,
    ratio: 1 / 6,
    complete: false,
  });
});

test("market anomaly replaces the default threshold for the same custom lookback window", () => {
  const result = buildMarketAnomaly(
    { ...input, lookback_hours: 1, anomaly_threshold: 20 },
    market(pair({
      priceChange: { h1: 25, h24: 5 },
      volume: { h24: 100_000 },
      txns: { h24: { buys: 50, sells: 50 } },
      liquidity: { usd: 100_000 },
    })),
    deterministic,
  );

  assert.equal(result.custom_check.window, "h1");
  assert.equal(result.custom_check.triggered, true);
  assert.equal(result.anomalies.length, 1);
  assert.deepEqual(result.anomalies.map((item) => item.code), ["custom_price_change_h1"]);
  assert.equal(result.risk_level, "medium");
  assert.equal(result.coverage.executable_checks, 5);
  assert.equal(result.coverage.total_checks, 5);
});

test("market anomaly still escalates genuinely independent anomaly signals", () => {
  const result = buildMarketAnomaly(
    { ...input, lookback_hours: 6, anomaly_threshold: 10 },
    market(pair({
      priceChange: { h1: 5, h6: 12, h24: 55 },
      volume: { h24: 100_000 },
      txns: { h24: { buys: 50, sells: 50 } },
      liquidity: { usd: 100_000 },
    })),
    deterministic,
  );

  assert.deepEqual(result.anomalies.map((item) => item.code), [
    "price_change_h24",
    "custom_price_change_h6",
  ]);
  assert.equal(result.risk_level, "high");
  assert.equal(result.coverage.executable_checks, 6);
  assert.equal(result.coverage.total_checks, 6);
});

test("market anomaly never fabricates ratios for zero or missing liquidity and transactions", () => {
  const zeroLiquidity = buildMarketAnomaly(
    input,
    market(pair({ liquidity: { usd: 0 }, volume: { h24: 500_000 }, txns: {} })),
    deterministic,
  );
  const missingLiquidity = buildMarketAnomaly(
    input,
    market(pair({ liquidity: { usd: null }, volume: { h24: 500_000 }, txns: {} })),
    deterministic,
  );

  for (const result of [zeroLiquidity, missingLiquidity]) {
    assert.equal(result.metrics.volume_liquidity_ratio_h24, null);
    assert.equal(result.metrics.buy_ratio_h24, null);
    assert.equal(result.metrics.sell_ratio_h24, null);
    assert.ok(!result.anomalies.some((item) => item.code === "volume_liquidity_ratio_h24"));
    assert.ok(result.data_quality.warnings.includes("anomaly_ratio_inputs_unavailable"));
  }
});

test("numeric hardening rejects negative market values and never classifies negative transactions as active", () => {
  const invalidPair = pair({
    priceUsd: -1,
    priceNative: -0.1,
    marketCap: -10,
    fdv: -20,
    liquidity: { usd: -100, base: -10, quote: -20 },
    volume: { m5: -1, h1: -2, h6: -3, h24: -4 },
    txns: { h24: { buys: -3, sells: -2 } },
  });
  const invalidMarket = market(invalidPair);
  const snapshot = buildMarketSnapshot(input, invalidMarket, deterministic);
  const activity = buildTradingActivity(input, invalidMarket, deterministic);
  const anomalyResult = buildMarketAnomaly(input, invalidMarket, deterministic);

  assert.equal(snapshot.price.usd, null);
  assert.equal(snapshot.price.native, null);
  assert.equal(snapshot.valuation.market_cap_usd, null);
  assert.equal(snapshot.valuation.fdv_usd, null);
  assert.equal(snapshot.liquidity.primary_pool_usd, null);
  assert.equal(snapshot.volume.h24, null);
  assert.equal(snapshot.transactions.h24.total, null);
  assert.equal(activity.activity.windows.h24.volume_usd, null);
  assert.equal(activity.activity.windows.h24.buy_count, null);
  assert.equal(activity.activity.windows.h24.sell_count, null);
  assert.equal(activity.activity.classification, "unknown");
  assert.equal(anomalyResult.metrics.volume_h24_usd, null);
  assert.equal(anomalyResult.metrics.liquidity_usd, null);
  assert.equal(anomalyResult.risk_level, "unknown");
  for (const result of [snapshot, activity, anomalyResult]) {
    assert.ok(result.data_quality.warnings.includes("invalid_negative_numeric"));
    assertAllNumbersFinite(result);
  }
});

test("numeric hardening detects overflow in liquidity, transaction sums, and derived ratios", () => {
  const primary = pair({
    liquidity: { usd: Number.MAX_VALUE, base: null, quote: null },
    volume: { h24: Number.MAX_VALUE },
    txns: { h24: { buys: Number.MAX_VALUE, sells: Number.MAX_VALUE } },
  });
  const secondary = pair({
    pairAddress: "0xpair-overflow",
    liquidity: { usd: Number.MAX_VALUE, base: null, quote: null },
  });
  const overflowMarket = market(primary, [secondary]);
  const liquidity = buildLiquidityRisk(input, overflowMarket, deterministic);
  const activity = buildTradingActivity(input, overflowMarket, deterministic);
  const anomalyResult = buildMarketAnomaly(input, overflowMarket, deterministic);

  assert.equal(liquidity.liquidity.total_usd, null);
  assert.equal(liquidity.risk_level, "unknown");
  assert.equal(activity.activity.windows.h24.total_transactions, null);
  assert.equal(activity.activity.classification, "unknown");
  assert.equal(anomalyResult.metrics.buy_ratio_h24, null);
  assert.equal(anomalyResult.metrics.sell_ratio_h24, null);
  for (const result of [liquidity, activity, anomalyResult]) {
    assert.ok(result.data_quality.warnings.includes("numeric_overflow"));
    assertAllNumbersFinite(result);
  }

  const ratioOverflow = buildMarketAnomaly(
    input,
    market(pair({ volume: { h24: Number.MAX_VALUE }, liquidity: { usd: Number.MIN_VALUE }, txns: {} })),
    deterministic,
  );
  assert.equal(ratioOverflow.metrics.volume_liquidity_ratio_h24, null);
  assert.ok(ratioOverflow.data_quality.warnings.includes("numeric_overflow"));
  assertAllNumbersFinite(ratioOverflow);
});

test("numeric hardening sanitizes non-finite input and source metadata before output", () => {
  const malformedMarket = withoutProviderWarnings();
  malformedMarket.sources[0].pairCount = Number.POSITIVE_INFINITY;
  const result = buildMarketAnomaly(
    { ...input, anomaly_threshold: Number.NaN, lookback_hours: Number.POSITIVE_INFINITY },
    malformedMarket,
    deterministic,
  );

  assert.equal(result.input.anomaly_threshold, null);
  assert.equal(result.input.lookback_hours, null);
  assert.equal(result.sources[0].pairCount, null);
  assert.ok(result.data_quality.warnings.includes("invalid_non_finite_numeric"));
  assertAllNumbersFinite(result);
});

test("data quality sanitizes malformed provider warnings before returning or serializing", () => {
  const malformedMarket = market();
  malformedMarket.data_quality.warnings = [
    "provider warning",
    Number.POSITIVE_INFINITY,
    { nested: Number.NaN },
  ];

  const result = buildMarketSnapshot(input, malformedMarket, deterministic);
  const serialized = JSON.parse(JSON.stringify(result));

  assert.ok(result.data_quality.warnings.every((warning) => typeof warning === "string"));
  assert.ok(result.data_quality.warnings.includes("provider warning"));
  assert.ok(result.data_quality.warnings.includes("invalid_non_finite_numeric"));
  assert.ok(result.data_quality.warnings.includes("invalid_provider_warning"));
  assert.ok(!result.data_quality.warnings.includes(Number.POSITIVE_INFINITY));
  assert.ok(!serialized.data_quality.warnings.includes(null));
  assertAllNumbersFinite(result);
});

test("every builder parses the execution clock and request context exactly once", () => {
  const builders = [
    buildMarketSnapshot,
    buildLiquidityRisk,
    buildTradingActivity,
    buildNewPairRisk,
    buildMarketAnomaly,
  ];

  for (const builder of builders) {
    let clockCalls = 0;
    let requestIdCalls = 0;
    const result = builder(input, market(), {
      now: () => {
        clockCalls += 1;
        return FIXED_NOW + ((clockCalls - 1) * HOUR_MS);
      },
      requestId: () => {
        requestIdCalls += 1;
        return FIXED_UUID;
      },
    });

    assert.equal(clockCalls, 1, `${result.service.id} must parse its clock once`);
    assert.equal(requestIdCalls, 1, `${result.service.id} must create one request id`);
    assert.equal(result.generated_at, "2026-07-19T08:00:00.000Z");
    if ("pair_age_hours" in result) assert.equal(result.pair_age_hours, 336);
  }
});
