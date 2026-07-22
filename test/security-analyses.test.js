import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContractTaxCheck,
  buildHolderConcentration,
  buildPretradeReport,
} from "../src/intelligence/security-analyses.js";

const FIXED_NOW = Date.parse("2026-07-22T08:00:00.000Z");
const FIXED_UUID = "22222222-2222-4222-8222-222222222222";
const HOUR_MS = 60 * 60 * 1_000;
const options = Object.freeze({
  now: () => FIXED_NOW,
  requestId: () => FIXED_UUID,
});

const input = Object.freeze({
  chain: "ethereum",
  token_address: "0x1111111111111111111111111111111111111111",
  language: "zh-CN",
});

function holder(percent, overrides = {}) {
  return {
    address: `0xholder${String(percent).replace(".", "")}`,
    tag: null,
    isContract: false,
    balance: "100",
    percent,
    isLocked: false,
    ...overrides,
  };
}

function security(overrides = {}) {
  return {
    chain: "ethereum",
    tokenAddress: input.token_address,
    source: "goplus",
    sourceUrl: "https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=0x1111",
    accessedAt: "2026-07-22T07:59:30.000Z",
    tokenName: "Evidence Token",
    tokenSymbol: "EVD",
    totalSupply: "1000000",
    isOpenSource: true,
    isProxy: false,
    isMintable: false,
    canTakeBackOwnership: false,
    ownerChangeBalance: false,
    hiddenOwner: false,
    selfDestruct: false,
    externalCall: false,
    gasAbuse: false,
    buyTax: 0.035,
    sellTax: 0.04,
    cannotBuy: false,
    cannotSellAll: false,
    slippageModifiable: false,
    personalSlippageModifiable: false,
    transferPausable: false,
    tradingCooldown: false,
    isHoneypot: false,
    isBlacklisted: false,
    antiWhale: false,
    antiWhaleModifiable: false,
    holderCount: 187,
    holders: [holder(0.25), holder(0.17)],
    lpHolderCount: 2,
    lpHolders: [holder(0.9, { address: "0xlp1", isLocked: true }), holder(0.1, { address: "0xlp2" })],
    ownerAddress: "0xowner",
    ownerBalance: "125000",
    ownerPercent: 0.125,
    creatorAddress: "0xcreator",
    creatorBalance: "50000",
    creatorPercent: 0.05,
    ...overrides,
  };
}

function pair(overrides = {}) {
  return {
    chainId: "ethereum",
    dexId: "uniswap",
    pairAddress: "0xpair",
    baseToken: { address: input.token_address, name: "Evidence Token", symbol: "EVD" },
    quoteToken: { address: "0xquote", name: "USD Coin", symbol: "USDC" },
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
    pairCreatedAt: FIXED_NOW - (14 * 24 * HOUR_MS),
    url: "https://dexscreener.com/ethereum/0xpair",
    source: "dexscreener",
    ...overrides,
  };
}

function market(primary = pair()) {
  return {
    chain: "ethereum",
    tokenAddress: input.token_address,
    pairs: primary ? [primary] : [],
    primaryPair: primary,
    sources: [{
      source: "dexscreener",
      status: primary ? "ok" : "empty",
      url: "https://api.dexscreener.com/token-pairs/v1/ethereum/token",
    }],
  };
}

function assertEnvelope(result, serviceId) {
  assert.equal(result.ok, true);
  assert.deepEqual(result.service, { id: serviceId, version: "0.3.0" });
  assert.equal(result.request_id, FIXED_UUID);
  assert.equal(result.generated_at, "2026-07-22T08:00:00.000Z");
  assert.deepEqual(result.input, input);
  assert.ok(result.data_quality);
  assert.ok(Array.isArray(result.sources));
}

test("contract and holder services expose known evidence in stable envelopes", () => {
  const contract = buildContractTaxCheck(input, security(), options);
  const holders = buildHolderConcentration(input, security(), options);

  assertEnvelope(contract, "contract-tax-check");
  assertEnvelope(holders, "holder-concentration-check");
  assert.deepEqual(contract.contract.isOpenSource, { status: "known", value: true });
  assert.deepEqual(contract.trading.isHoneypot, { status: "known", value: false });
  assert.deepEqual(contract.taxes.buy, { status: "known", value: 0.035, percent: 3.5 });
  assert.deepEqual(holders.concentration.top10Percent, { status: "known", value: 0.42 });
  assert.equal(holders.concentration.level, "medium");
});

test("contract check flags every required dangerous permission and trading state", () => {
  const result = buildContractTaxCheck(input, security({
    isOpenSource: false,
    isProxy: true,
    isMintable: true,
    transferPausable: true,
    isBlacklisted: true,
    slippageModifiable: true,
    isHoneypot: true,
    cannotBuy: true,
    cannotSellAll: true,
  }), options);

  assert.deepEqual(new Set(result.flags), new Set([
    "closed_source",
    "proxy_contract",
    "mintable_supply",
    "transfers_pausable",
    "blacklist_enabled",
    "tax_modifiable",
    "honeypot_detected",
    "cannot_buy",
    "cannot_sell_all",
  ]));
  assert.equal(result.risk_level, "critical");
});

test("contract tax thresholds are medium at 5 percent and high at 10 percent", () => {
  const medium = buildContractTaxCheck(input, security({ buyTax: 0.05, sellTax: 0 }), options);
  const high = buildContractTaxCheck(input, security({ buyTax: 0, sellTax: 0.10 }), options);

  assert.ok(medium.flags.includes("medium_buy_tax"));
  assert.equal(medium.risk_level, "medium");
  assert.ok(high.flags.includes("high_sell_tax"));
  assert.equal(high.risk_level, "high");
});

test("missing contract fields remain unknown instead of being inferred safe", () => {
  const result = buildContractTaxCheck(input, null, options);

  assert.equal(result.risk_level, "unknown");
  assert.deepEqual(result.contract.isOpenSource, { status: "unknown", value: null });
  assert.deepEqual(result.trading.isHoneypot, { status: "unknown", value: null });
  assert.deepEqual(result.taxes.sell, { status: "unknown", value: null, percent: null });
  assert.ok(result.flags.includes("security_data_unavailable"));
  assert.equal(result.data_quality.status, "unavailable");
});

test("holder concentration uses inclusive 40, 60, and 80 percent boundaries", () => {
  const cases = [
    [0.3999, "low"],
    [0.4, "medium"],
    [0.6, "high"],
    [0.8, "critical"],
  ];

  for (const [percent, expected] of cases) {
    const result = buildHolderConcentration(input, security({ holders: [holder(percent)] }), options);
    assert.equal(result.concentration.top10Percent.value, percent);
    assert.equal(result.concentration.level, expected);
    assert.equal(result.risk_level, expected);
  }
});

test("missing or partially unknown holder percentages do not become low concentration", () => {
  const missing = buildHolderConcentration(input, security({ holders: null }), options);
  const partial = buildHolderConcentration(
    input,
    security({ holders: [holder(0.25), holder(null)] }),
    options,
  );

  for (const result of [missing, partial]) {
    assert.equal(result.concentration.top10Percent.status, "unknown");
    assert.equal(result.concentration.level, "unknown");
    assert.equal(result.risk_level, "unknown");
    assert.ok(result.flags.includes("holder_concentration_unknown"));
  }
});

test("a nonzero holder count with an empty holder list remains unknown", () => {
  const result = buildHolderConcentration(
    input,
    security({ holderCount: 187, holders: [] }),
    options,
  );

  assert.equal(result.concentration.top10Percent.status, "unknown");
  assert.equal(result.concentration.level, "unknown");
  assert.equal(result.risk_level, "unknown");
  assert.ok(result.data_quality.warnings.includes("holder_list_inconsistent"));
});

test("holder report preserves owner, creator, and liquidity-holder evidence", () => {
  const result = buildHolderConcentration(input, security(), options);

  assert.deepEqual(result.holderCount, { status: "known", value: 187 });
  assert.deepEqual(result.owner.percent, { status: "known", value: 0.125 });
  assert.deepEqual(result.creator.percent, { status: "known", value: 0.05 });
  assert.deepEqual(result.liquidityHolders.count, { status: "known", value: 2 });
  assert.deepEqual(result.liquidityHolders.top10Percent, { status: "known", value: 1 });
  assert.deepEqual(result.liquidityHolders.lockedPercent, { status: "known", value: 0.9 });
});

test("pretrade report combines all sections with the approved weights", () => {
  const report = buildPretradeReport(input, market(), security(), options);

  assertEnvelope(report, "pretrade-risk-report");
  assert.equal(report.coverage, "full");
  assert.deepEqual(report.weights, {
    market: 0.35,
    liquidity: 0.20,
    activity_anomaly: 0.15,
    contract_tax: 0.20,
    holders: 0.10,
  });
  assert.equal(typeof report.risk_score, "number");
  assert.ok(report.risk_score >= 0 && report.risk_score <= 100);
  assert.ok(report.sections.market.snapshot);
  assert.ok(report.sections.market.new_pair);
  assert.ok(report.sections.liquidity);
  assert.ok(report.sections.activity_anomaly.activity);
  assert.ok(report.sections.activity_anomaly.anomaly);
  assert.ok(report.sections.contract_tax);
  assert.ok(report.sections.holders);
});

test("pretrade report applies every approved weight to the corresponding section score", () => {
  const riskyPair = pair({
    pairCreatedAt: FIXED_NOW - (2 * HOUR_MS),
    liquidity: { usd: 20_000, base: 10_000, quote: 10_000 },
    priceChange: { m5: 1, h1: 25, h6: 30, h24: 55 },
    volume: { m5: 100, h1: 1_000, h6: 6_000, h24: 20_000 },
    txns: {
      m5: { buys: 4, sells: 2 },
      h1: { buys: 30, sells: 20 },
      h6: { buys: 120, sells: 80 },
      h24: { buys: 400, sells: 300 },
    },
  });
  const report = buildPretradeReport(
    input,
    market(riskyPair),
    security({ isMintable: true }),
    options,
  );

  assert.deepEqual(Object.fromEntries(Object.entries(report.score_breakdown).map(([key, item]) => (
    [key, item.score]
  ))), {
    market: 100,
    liquidity: 70,
    activity_anomaly: 70,
    contract_tax: 40,
    holders: 40,
  });
  assert.equal(report.risk_score, 71.5);
  assert.equal(report.risk_level, "high");
});

test("pretrade report labels non-EVM security coverage as market-only without treating it as safe", () => {
  const solanaInput = { ...input, chain: "solana", token_address: "So11111111111111111111111111111111111111112" };
  const solanaMarket = market();
  solanaMarket.chain = "solana";
  solanaMarket.tokenAddress = solanaInput.token_address;
  const report = buildPretradeReport(solanaInput, solanaMarket, null, options);

  assert.equal(report.coverage, "market-only");
  assert.equal(report.sections.contract_tax.risk_level, "unknown");
  assert.equal(report.sections.holders.risk_level, "unknown");
  assert.ok(report.flags.includes("security_coverage_unavailable"));
  assert.equal(report.score_breakdown.contract_tax.included, false);
  assert.equal(report.score_breakdown.holders.included, false);
});

test("pretrade report ignores accidentally supplied security data on unsupported chains", () => {
  const solanaInput = { ...input, chain: "solana", token_address: "So11111111111111111111111111111111111111112" };
  const solanaMarket = market();
  solanaMarket.chain = "solana";
  solanaMarket.tokenAddress = solanaInput.token_address;
  const report = buildPretradeReport(solanaInput, solanaMarket, security(), options);

  assert.equal(report.coverage, "market-only");
  assert.equal(report.sections.contract_tax.risk_level, "unknown");
  assert.equal(report.sections.holders.risk_level, "unknown");
  assert.equal(report.score_breakdown.contract_tax.included, false);
  assert.equal(report.score_breakdown.holders.included, false);
});

test("pretrade report marks supported EVM security outages as partial", () => {
  const report = buildPretradeReport(input, market(), null, options);

  assert.equal(report.coverage, "partial");
  assert.ok(report.flags.includes("security_data_unavailable"));
  assert.equal(report.data_quality.status, "partial");
});

test("security builders reject non-finite percentages without emitting invalid JSON numbers", () => {
  const malformed = security({
    buyTax: Number.POSITIVE_INFINITY,
    holders: [holder(Number.NaN, { address: "0xholderbad" })],
  });
  const contract = buildContractTaxCheck(input, malformed, options);
  const holders = buildHolderConcentration(input, malformed, options);

  assert.deepEqual(contract.taxes.buy, { status: "unknown", value: null, percent: null });
  assert.equal(holders.concentration.level, "unknown");
  assert.ok(!JSON.stringify(contract).includes("Infinity"));
  assert.ok(!JSON.stringify(holders).includes("NaN"));
});
