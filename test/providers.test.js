import test from "node:test";
import assert from "node:assert/strict";
import { createTtlCache } from "../src/intelligence/cache.js";
import {
  GECKOTERMINAL_NETWORK_IDS,
  GOPLUS_CHAIN_IDS,
  MARKET_CHAINS,
  createProviders,
  isSecurityChainSupported,
} from "../src/intelligence/providers.js";
import {
  dexPairs,
  dexPairsWithoutUsableLiquidity,
  evmTokenAddress,
  evmTokenAddressLower,
  geckoAdditionalQuoteTokenAddress,
  geckoAdditionalQuoteTokenAddressLower,
  geckoMultiTokenPools,
  geckoPools,
  geckoQuoteTokenAddress,
  geckoQuoteTokenAddressLower,
  geckoQuoteTokenPools,
  goPlusToken,
  solanaCaseVariantAddress,
  solanaTokenAddress,
} from "./fixtures.js";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("ttl cache reuses a value before expiry", async () => {
  let currentTime = 1_000;
  let calls = 0;
  const cache = createTtlCache({ maxEntries: 4, now: () => currentTime });

  const first = await cache.getOrLoad("token", 1_000, async () => ++calls);
  currentTime = 1_999;
  const second = await cache.getOrLoad("token", 1_000, async () => ++calls);

  assert.equal(first, 1);
  assert.equal(second, 1);
  assert.equal(calls, 1);
});

test("ttl cache reloads a value at expiry", async () => {
  let currentTime = 1_000;
  let calls = 0;
  const cache = createTtlCache({ now: () => currentTime });

  assert.equal(await cache.getOrLoad("token", 1_000, async () => ++calls), 1);
  currentTime = 2_000;
  assert.equal(await cache.getOrLoad("token", 1_000, async () => ++calls), 2);
  assert.equal(calls, 2);
});

test("ttl cache evicts the oldest entry when bounded", async () => {
  const calls = new Map();
  const cache = createTtlCache({ maxEntries: 2 });
  const load = (key) => cache.getOrLoad(key, 1_000, async () => {
    const count = (calls.get(key) ?? 0) + 1;
    calls.set(key, count);
    return `${key}-${count}`;
  });

  assert.equal(await load("oldest"), "oldest-1");
  assert.equal(await load("middle"), "middle-1");
  assert.equal(await load("newest"), "newest-1");
  assert.equal(await load("middle"), "middle-1");
  assert.equal(await load("oldest"), "oldest-2");
});

test("ttl cache does not retain failed loads", async () => {
  let calls = 0;
  const cache = createTtlCache();

  await assert.rejects(
    cache.getOrLoad("token", 1_000, async () => {
      calls += 1;
      throw new Error("temporary failure");
    }),
    /temporary failure/,
  );

  assert.equal(await cache.getOrLoad("token", 1_000, async () => ++calls), 2);
  assert.equal(calls, 2);
});

test("ttl cache preserves a cached value when a full-capacity miss rejects", async () => {
  let stableLoads = 0;
  const cache = createTtlCache({ maxEntries: 1 });
  const loadStable = () => cache.getOrLoad("stable", 10_000, async () => {
    stableLoads += 1;
    return `stable-${stableLoads}`;
  });

  assert.equal(await loadStable(), "stable-1");
  await assert.rejects(
    cache.getOrLoad("failing", 10_000, async () => {
      throw new Error("temporary failure");
    }),
    /temporary failure/,
  );

  assert.equal(await loadStable(), "stable-1");
  assert.equal(stableLoads, 1);
});

test("ttl cache de-duplicates concurrent loads for one key", async () => {
  let calls = 0;
  let release;
  const pendingValue = new Promise((resolve) => {
    release = resolve;
  });
  const cache = createTtlCache();
  const loader = async () => {
    calls += 1;
    return pendingValue;
  };

  const first = cache.getOrLoad("token", 1_000, loader);
  const second = cache.getOrLoad("token", 1_000, loader);
  await Promise.resolve();

  assert.equal(calls, 1);
  release({ value: 42 });
  const [firstValue, secondValue] = await Promise.all([first, second]);
  assert.equal(firstValue, secondValue);
  assert.deepEqual(firstValue, { value: 42 });
});

test("ttl cache bounds concurrent unique loads by maxEntries", async () => {
  const starts = [];
  const releases = new Map();
  let markThirdStarted;
  const thirdStarted = new Promise((resolve) => {
    markThirdStarted = resolve;
  });
  const cache = createTtlCache({ maxEntries: 2 });
  const load = (key) => cache.getOrLoad(key, 1_000, async () => {
    starts.push(key);
    if (key === "third") markThirdStarted();
    return new Promise((resolve) => releases.set(key, resolve));
  });

  const first = load("first");
  const second = load("second");
  const third = load("third");
  const thirdDuplicate = load("third");
  await Promise.resolve();

  assert.deepEqual(starts, ["first", "second"]);
  releases.get("first")("first-value");
  assert.equal(await first, "first-value");
  await thirdStarted;
  assert.deepEqual(starts, ["first", "second", "third"]);

  releases.get("second")("second-value");
  releases.get("third")("third-value");
  assert.deepEqual(
    await Promise.all([second, third, thirdDuplicate]),
    ["second-value", "third-value", "third-value"],
  );
  assert.equal(starts.filter((key) => key === "third").length, 1);
});

test("ttl cache purges expired entries before evicting live entries", async () => {
  let currentTime = 0;
  const calls = new Map();
  const cache = createTtlCache({ maxEntries: 2, now: () => currentTime });
  const load = (key, ttlMs) => cache.getOrLoad(key, ttlMs, async () => {
    const count = (calls.get(key) ?? 0) + 1;
    calls.set(key, count);
    return `${key}-${count}`;
  });

  assert.equal(await load("live", 100), "live-1");
  assert.equal(await load("expired", 10), "expired-1");
  currentTime = 20;
  assert.equal(await load("new", 100), "new-1");
  assert.equal(await load("live", 100), "live-1");
  assert.equal(await load("expired", 10), "expired-2");
});

test("providers expose the exact market and upstream chain maps", () => {
  assert.deepEqual(MARKET_CHAINS, [
    "solana",
    "ethereum",
    "xlayer",
    "base",
    "bsc",
    "arbitrum",
    "polygon",
  ]);
  assert.deepEqual(GOPLUS_CHAIN_IDS, {
    ethereum: 1,
    bsc: 56,
    polygon: 137,
    arbitrum: 42161,
    base: 8453,
    xlayer: 196,
  });
  assert.deepEqual(GECKOTERMINAL_NETWORK_IDS, {
    solana: "solana",
    ethereum: "eth",
    xlayer: "x-layer",
    base: "base",
    bsc: "bsc",
    arbitrum: "arbitrum",
    polygon: "polygon_pos",
  });
  assert.equal(isSecurityChainSupported("ethereum"), true);
  assert.equal(isSecurityChainSupported(" Ethereum "), true);
  assert.equal(isSecurityChainSupported("solana"), false);
});

test("market rejects invalid chains and empty addresses before fetch", async () => {
  let fetchCalls = 0;
  const providers = createProviders({
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    },
  });

  await assert.rejects(providers.market("avalanche", evmTokenAddress), { code: "INVALID_INPUT" });
  await assert.rejects(providers.market("ethereum", "  "), { code: "INVALID_INPUT" });
  assert.equal(fetchCalls, 0);
});

test("market validates chain-specific address formats and length bounds before fetch", async () => {
  let fetchCalls = 0;
  const providers = createProviders({
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    },
  });

  for (const address of [
    `0x${"1".repeat(39)}`,
    `0x${"1".repeat(41)}`,
    `0x${"g".repeat(40)}`,
  ]) {
    await assert.rejects(providers.market("ethereum", address), { code: "INVALID_INPUT" });
  }
  for (const address of ["1".repeat(31), "1".repeat(45), `O${"1".repeat(31)}`]) {
    await assert.rejects(providers.market("solana", address), { code: "INVALID_INPUT" });
  }
  assert.equal(fetchCalls, 0);
});

test("security rejects unsupported chains before fetch", async () => {
  let fetchCalls = 0;
  const providers = createProviders({
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    },
  });

  await assert.rejects(providers.security("solana", solanaTokenAddress), {
    code: "SECURITY_CHAIN_UNSUPPORTED",
  });
  await assert.rejects(providers.security("avalanche", evmTokenAddress), {
    code: "SECURITY_CHAIN_UNSUPPORTED",
  });
  assert.equal(fetchCalls, 0);
});

test("market normalizes every DexScreener pair and selects numeric peak liquidity", async () => {
  const calls = [];
  const providers = createProviders({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      assert.equal(String(url).includes("geckoterminal"), false, "fallback must stay unused");
      return jsonResponse(dexPairs);
    },
    marketCacheMs: 30_000,
  });

  const market = await providers.market(" Ethereum ", ` ${evmTokenAddress} `);
  const cached = await providers.market("ethereum", evmTokenAddressLower);

  assert.equal(cached, market);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `https://api.dexscreener.com/token-pairs/v1/ethereum/${evmTokenAddress}`,
  );
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(market.chain, "ethereum");
  assert.equal(market.tokenAddress, evmTokenAddress);
  assert.equal(market.source, "dexscreener");
  assert.equal(market.sourceUrl, calls[0].url);
  assert.ok(Number.isFinite(Date.parse(market.accessedAt)));
  assert.equal(market.pairs.length, 3);
  assert.equal(market.primaryPair.pairAddress, "0xpair-primary");
  assert.equal(market.primaryPair.chainId, "ethereum");
  assert.equal(market.primaryPair.dexId, "uniswap");
  assert.deepEqual(market.primaryPair.labels, ["v3"]);
  assert.deepEqual(market.primaryPair.baseToken, {
    address: evmTokenAddress,
    name: "Alpha Token",
    symbol: "ALP",
  });
  assert.deepEqual(market.primaryPair.quoteToken, {
    address: "0xWeth",
    name: "Wrapped Ether",
    symbol: "WETH",
  });
  assert.equal(market.primaryPair.priceNative, 0.00051);
  assert.equal(market.primaryPair.priceUsd, 1.275);
  assert.deepEqual(market.primaryPair.priceChange, { m5: 0.4, h1: 2.1, h6: 3.7, h24: 8.2 });
  assert.deepEqual(market.primaryPair.volume, { m5: 850, h1: 7_500, h6: 42_000, h24: 125_000 });
  assert.deepEqual(market.primaryPair.txns.h1, { buys: 35, sells: 20 });
  assert.deepEqual(market.primaryPair.liquidity, { usd: 250_000.5, base: 98_039.41, quote: 50 });
  assert.equal(market.primaryPair.marketCap, 1_020_000);
  assert.equal(market.primaryPair.fdv, 1_275_000);
  assert.equal(market.primaryPair.pairCreatedAt, 1_710_000_000_000);
  assert.equal(market.primaryPair.url, "https://dexscreener.com/ethereum/0xpair-primary");
  assert.equal(market.primaryPair.accessedAt, market.accessedAt);
  assert.equal(market.primaryPair.sourceUrl, market.sourceUrl);
  assert.equal(market.pairs[2].liquidity.usd, null);
  assert.deepEqual(
    market.sources.map(({ source, url, status, pairCount, usablePairCount }) => ({
      source,
      url,
      status,
      pairCount,
      usablePairCount,
    })),
    [{
      source: "dexscreener",
      url: calls[0].url,
      status: "ok",
      pairCount: 3,
      usablePairCount: 2,
    }],
  );
});

test("market cache preserves case-sensitive Solana mint identities", async () => {
  let fetchCalls = 0;
  const providers = createProviders({
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse(dexPairs);
    },
  });

  await providers.market("solana", solanaTokenAddress);
  await providers.market("solana", solanaCaseVariantAddress);

  assert.equal(fetchCalls, 2);
});

test("market uses GeckoTerminal once when DexScreener is empty", async () => {
  const calls = [];
  const providers = createProviders({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return String(url).includes("dexscreener") ? jsonResponse([]) : jsonResponse(geckoPools);
    },
  });

  const market = await providers.market("ethereum", evmTokenAddressLower);

  assert.equal(calls.length, 2);
  assert.equal(calls.filter(({ url }) => url.includes("geckoterminal")).length, 1);
  assert.equal(
    calls[1].url,
    `https://api.geckoterminal.com/api/v2/networks/eth/tokens/${evmTokenAddressLower}/pools?include=base_token,quote_token`,
  );
  assert.equal(calls[1].options.headers.Accept, "application/json;version=20230302");
  assert.ok(calls[1].options.signal instanceof AbortSignal);
  assert.equal(market.source, "geckoterminal");
  assert.equal(market.pairs.length, 2);
  assert.equal(market.primaryPair.pairAddress, "0xpool-primary");
  assert.equal(market.primaryPair.dexId, "uniswap-v3");
  assert.equal(market.primaryPair.priceUsd, 1.27);
  assert.deepEqual(market.primaryPair.priceChange, { m5: 0.2, h1: 0.8, h6: 2.4, h24: 4.8 });
  assert.deepEqual(market.primaryPair.volume, { m5: 120, h1: 1_200, h6: 7_200, h24: 28_800 });
  assert.deepEqual(market.primaryPair.txns.h1, { buys: 18, sells: 12, buyers: 15, sellers: 10 });
  assert.deepEqual(market.primaryPair.liquidity, { usd: 90_000, base: null, quote: null });
  assert.equal(market.primaryPair.marketCap, 1_016_000);
  assert.equal(market.primaryPair.fdv, 1_270_000);
  assert.equal(market.primaryPair.pairCreatedAt, Date.parse("2024-02-01T00:00:00Z"));
  assert.equal(
    market.primaryPair.url,
    "https://www.geckoterminal.com/eth/pools/0xpool-primary",
  );
  assert.equal(market.primaryPair.sourceUrl, market.sourceUrl);
  assert.deepEqual(
    market.sources.map(({ source, url, status, pairCount, usablePairCount }) => ({
      source,
      url,
      status,
      pairCount,
      usablePairCount,
    })),
    [
      {
        source: "dexscreener",
        url: calls[0].url,
        status: "empty",
        pairCount: 0,
        usablePairCount: 0,
      },
      {
        source: "geckoterminal",
        url: calls[1].url,
        status: "ok",
        pairCount: 2,
        usablePairCount: 2,
      },
    ],
  );
  assert.equal(market.fallback.reason, "dexscreener_empty");
  assert.deepEqual(market.fallback.attemptedPairs, []);
});

test("market uses fallback when DexScreener pairs have no numeric liquidity", async () => {
  let dexCalls = 0;
  let geckoCalls = 0;
  const providers = createProviders({
    fetchImpl: async (url) => {
      if (String(url).includes("dexscreener")) {
        dexCalls += 1;
        return jsonResponse(dexPairsWithoutUsableLiquidity);
      }
      geckoCalls += 1;
      return jsonResponse(geckoPools);
    },
  });

  const market = await providers.market("ethereum", evmTokenAddressLower);

  assert.equal(market.source, "geckoterminal");
  assert.equal(dexCalls, 1);
  assert.equal(geckoCalls, 1);
  assert.deepEqual(market.sources.map(({ source, status }) => ({ source, status })), [
    { source: "dexscreener", status: "unusable" },
    { source: "geckoterminal", status: "ok" },
  ]);
  assert.equal(market.fallback.reason, "dexscreener_no_usable_pair");
  assert.equal(market.fallback.attemptedPairs[0].pairAddress, "0xpair-no-liquidity");
});

test("market treats zero and negative liquidity as unusable fallback evidence", async () => {
  const nonPositivePairs = [
    { ...dexPairs[0], pairAddress: "0xpair-zero", liquidity: { usd: "0" } },
    { ...dexPairs[1], pairAddress: "0xpair-negative", liquidity: { usd: "-1" } },
  ];
  const providers = createProviders({
    fetchImpl: async (url) => (
      String(url).includes("dexscreener")
        ? jsonResponse(nonPositivePairs)
        : jsonResponse(geckoPools)
    ),
  });

  const market = await providers.market("ethereum", evmTokenAddressLower);

  assert.equal(market.source, "geckoterminal");
  assert.equal(market.sources[0].status, "unusable");
  assert.equal(market.sources[0].usablePairCount, 0);
  assert.deepEqual(
    market.fallback.attemptedPairs.map((pair) => pair.liquidity.usd),
    [0, -1],
  );
});

test("market treats a pair without identity as unusable", async () => {
  const anonymousPair = {
    ...dexPairs[0],
    pairAddress: "",
    liquidity: { ...dexPairs[0].liquidity, usd: "999999" },
  };
  const providers = createProviders({
    fetchImpl: async (url) => (
      String(url).includes("dexscreener")
        ? jsonResponse([anonymousPair])
        : jsonResponse(geckoPools)
    ),
  });

  const market = await providers.market("ethereum", evmTokenAddressLower);

  assert.equal(market.source, "geckoterminal");
  assert.equal(market.primaryPair.pairAddress, "0xpool-primary");
});

test("marketFallback is directly testable with official GeckoTerminal network ids", async () => {
  const calls = [];
  const providers = createProviders({
    geckoApiBase: "https://gecko.test/api/v2/",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse(geckoPools);
    },
  });

  const market = await providers.marketFallback("xlayer", evmTokenAddress);

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `https://gecko.test/api/v2/networks/x-layer/tokens/${evmTokenAddress}/pools?include=base_token,quote_token`,
  );
  assert.equal(calls[0].options.headers.Accept, "application/json;version=20230302");
  assert.equal(market.chain, "xlayer");
  assert.equal(market.tokenAddress, evmTokenAddress);
  assert.equal(market.source, "geckoterminal");
});

test("marketFallback orients quote-side GeckoTerminal metadata to the requested token", async () => {
  let requestedUrl;
  const providers = createProviders({
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return jsonResponse(geckoQuoteTokenPools);
    },
  });

  const market = await providers.marketFallback("ethereum", geckoQuoteTokenAddressLower);

  assert.equal(
    requestedUrl,
    `https://api.geckoterminal.com/api/v2/networks/eth/tokens/${geckoQuoteTokenAddressLower}/pools?include=base_token,quote_token`,
  );
  assert.deepEqual(market.primaryPair.baseToken, {
    address: geckoQuoteTokenAddress,
    name: "USD Coin",
    symbol: "USDC",
  });
  assert.deepEqual(market.primaryPair.quoteToken, {
    address: evmTokenAddress,
    name: "Alpha Token",
    symbol: "ALP",
  });
  assert.equal(market.primaryPair.priceUsd, 1.01);
  assert.equal(market.primaryPair.priceNative, 0.0004);
  assert.equal(market.primaryPair.fdv, 50_000_000);
  assert.equal(market.primaryPair.marketCap, 49_000_000);
});

test("marketFallback orients an additional GeckoTerminal quote token and target metrics", async () => {
  let requestedUrl;
  const providers = createProviders({
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return jsonResponse(geckoMultiTokenPools);
    },
  });

  const market = await providers.marketFallback(
    "ethereum",
    geckoAdditionalQuoteTokenAddressLower,
  );

  assert.equal(
    requestedUrl,
    `https://api.geckoterminal.com/api/v2/networks/eth/tokens/${geckoAdditionalQuoteTokenAddressLower}/pools?include=base_token,quote_token`,
  );
  assert.deepEqual(market.primaryPair.baseToken, {
    address: geckoAdditionalQuoteTokenAddress,
    name: "Tether USD",
    symbol: "USDT",
  });
  assert.deepEqual(market.primaryPair.quoteToken, {
    address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    name: "Dai Stablecoin",
    symbol: "DAI",
  });
  assert.equal(market.primaryPair.priceUsd, 0.9987);
  assert.equal(market.primaryPair.priceNative, null);
  assert.equal(market.primaryPair.fdv, 140_000_000_000);
  assert.equal(market.primaryPair.marketCap, 137_000_000_000);
});

test("security normalizes GoPlus contract, trading, holder, and unknown fields", async () => {
  const calls = [];
  const providers = createProviders({
    goPlusAccessToken: "",
    securityCacheMs: 300_000,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse(goPlusToken);
    },
  });

  const security = await providers.security(" Ethereum ", evmTokenAddressLower);
  const cached = await providers.security("ethereum", evmTokenAddress.toUpperCase());

  assert.equal(cached, security);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=${evmTokenAddressLower}`,
  );
  assert.equal(Object.hasOwn(calls[0].options.headers, "Authorization"), false);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(security.chain, "ethereum");
  assert.equal(security.tokenAddress, evmTokenAddressLower);
  assert.equal(security.source, "goplus");
  assert.equal(security.sourceUrl, calls[0].url);
  assert.ok(Number.isFinite(Date.parse(security.accessedAt)));
  assert.equal(security.tokenName, "Alpha Token");
  assert.equal(security.tokenSymbol, "ALP");
  assert.equal(security.totalSupply, "1000000");
  assert.equal(security.isOpenSource, true);
  assert.equal(security.isProxy, false);
  assert.equal(security.isMintable, null);
  assert.equal(security.canTakeBackOwnership, false);
  assert.equal(security.ownerChangeBalance, null);
  assert.equal(security.hiddenOwner, null);
  assert.equal(security.selfDestruct, false);
  assert.equal(security.externalCall, true);
  assert.equal(security.gasAbuse, false);
  assert.equal(security.buyTax, 0.035);
  assert.equal(security.sellTax, null);
  assert.equal(security.cannotBuy, false);
  assert.equal(security.cannotSellAll, true);
  assert.equal(security.slippageModifiable, true);
  assert.equal(security.personalSlippageModifiable, null);
  assert.equal(security.transferPausable, null);
  assert.equal(security.tradingCooldown, false);
  assert.equal(security.isHoneypot, false);
  assert.equal(security.isBlacklisted, true);
  assert.equal(security.antiWhale, true);
  assert.equal(security.antiWhaleModifiable, false);
  assert.equal(security.holderCount, 187);
  assert.deepEqual(security.holders, [
    {
      address: "0xholder1",
      tag: "creator",
      isContract: false,
      balance: "250000",
      percent: 0.25,
      isLocked: false,
    },
    {
      address: "0xholder2",
      tag: null,
      isContract: true,
      balance: "170000",
      percent: 0.17,
      isLocked: null,
    },
  ]);
  assert.equal(security.lpHolderCount, 2);
  assert.equal(security.lpHolders.length, 2);
  assert.deepEqual(security.lpHolders[0], {
    address: "0xlp1",
    tag: "locker",
    isContract: true,
    balance: "900",
    percent: 0.9,
    isLocked: true,
  });
  assert.equal(security.lpHolders[1].isLocked, null);
  assert.equal(security.ownerAddress, "0xowner");
  assert.equal(security.ownerBalance, "12345678901234567890.123");
  assert.equal(security.ownerPercent, 0.125);
  assert.equal(security.creatorAddress, "0xcreator");
  assert.equal(security.creatorBalance, null);
  assert.equal(security.creatorPercent, null);
});

test("security includes optional GoPlus authorization without exposing it in the URL", async () => {
  let request;
  const providers = createProviders({
    goPlusAccessToken: "top-secret-token",
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return jsonResponse(goPlusToken);
    },
  });

  await providers.security("bsc", evmTokenAddressLower);

  assert.equal(request.options.headers.Authorization, "Bearer top-secret-token");
  assert.equal(request.url.includes("top-secret-token"), false);
  assert.equal(request.url.includes("token_security/56"), true);
});

test("security maps GoPlus body-level rate limits", async () => {
  const providers = createProviders({
    fetchImpl: async () => jsonResponse({ code: 4029, message: "Request limit reached" }),
  });

  await assert.rejects(providers.security("ethereum", evmTokenAddressLower), {
    code: "UPSTREAM_RATE_LIMITED",
  });
});

test("security rejects partial GoPlus envelopes as incomplete", async () => {
  const providers = createProviders({
    fetchImpl: async () => jsonResponse({
      ...goPlusToken,
      code: 2,
      message: "Partial data obtained",
    }),
  });

  await assert.rejects(providers.security("ethereum", evmTokenAddressLower), (error) => {
    assert.equal(error.code, "UPSTREAM_FAILURE");
    assert.match(error.message, /incomplete/i);
    return true;
  });
});

test("security rejects other non-success GoPlus envelope codes", async () => {
  const providers = createProviders({
    fetchImpl: async () => jsonResponse({ code: 5000, message: "System error" }),
  });

  await assert.rejects(providers.security("ethereum", evmTokenAddressLower), (error) => {
    assert.equal(error.code, "UPSTREAM_FAILURE");
    assert.equal(error.message, "Upstream security request failed");
    assert.equal(error.cause?.providerCode, 5000);
    return true;
  });
});

test("security preserves missing and malformed holder collections as unknown", async () => {
  const response = structuredClone(goPlusToken);
  delete response.result[evmTokenAddress].holders;
  response.result[evmTokenAddress].lp_holders = [null];
  const providers = createProviders({
    fetchImpl: async () => jsonResponse(response),
  });

  const security = await providers.security("ethereum", evmTokenAddressLower);

  assert.equal(security.holders, null);
  assert.equal(security.lpHolders, null);
});

test("security treats a null matching address entry as an upstream failure", async () => {
  const providers = createProviders({
    fetchImpl: async () => jsonResponse({
      code: 1,
      result: { [evmTokenAddress]: null },
    }),
  });

  await assert.rejects(providers.security("ethereum", evmTokenAddressLower), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.code, "UPSTREAM_FAILURE");
    return true;
  });
});

test("security rejects an empty address before fetch", async () => {
  let fetchCalls = 0;
  const providers = createProviders({
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse(goPlusToken);
    },
  });

  await assert.rejects(providers.security("ethereum", ""), { code: "INVALID_INPUT" });
  assert.equal(fetchCalls, 0);
});

test("providers normalize 429 responses and retry failed loads", async () => {
  let calls = 0;
  const providers = createProviders({
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({ message: "slow down" }, 429) : jsonResponse(dexPairs);
    },
  });

  await assert.rejects(providers.market("ethereum", evmTokenAddressLower), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.code, "UPSTREAM_RATE_LIMITED");
    return true;
  });
  const market = await providers.market("ethereum", evmTokenAddressLower);

  assert.equal(market.primaryPair.pairAddress, "0xpair-primary");
  assert.equal(calls, 2);
});

test("providers normalize AbortSignal timeouts", async () => {
  const providers = createProviders({
    timeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }),
  });

  await assert.rejects(providers.market("ethereum", evmTokenAddressLower), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.code, "UPSTREAM_TIMEOUT");
    return true;
  });
});

test("providers normalize other HTTP failures without credential leakage", async () => {
  const credential = "top-secret-token";
  const providers = createProviders({
    goPlusAccessToken: credential,
    fetchImpl: async () => jsonResponse({ message: credential }, 503),
  });

  await assert.rejects(providers.security("ethereum", evmTokenAddressLower), (error) => {
    assert.equal(error.code, "UPSTREAM_FAILURE");
    assert.equal(error.message.includes(credential), false);
    return true;
  });
});

test("providers normalize malformed JSON and thrown transport errors", async () => {
  const parseFailure = new SyntaxError("Unexpected token");
  const invalidJsonProviders = createProviders({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw parseFailure;
      },
    }),
  });
  await assert.rejects(invalidJsonProviders.market("ethereum", evmTokenAddressLower), (error) => {
    assert.equal(error.code, "UPSTREAM_FAILURE");
    assert.equal(error.cause, parseFailure);
    return true;
  });

  const credential = "transport-secret";
  const transportFailure = new Error(`socket failed: ${credential}`);
  const failedTransportProviders = createProviders({
    goPlusAccessToken: credential,
    fetchImpl: async () => {
      throw transportFailure;
    },
  });
  await assert.rejects(failedTransportProviders.security("ethereum", evmTokenAddressLower), (error) => {
    assert.equal(error.code, "UPSTREAM_FAILURE");
    assert.equal(error.message.includes(credential), false);
    assert.equal(error.cause, transportFailure);
    assert.equal(Object.prototype.propertyIsEnumerable.call(error, "cause"), false);
    assert.equal(JSON.stringify(error).includes(credential), false);
    return true;
  });
});

test("security treats a missing address result as an upstream failure", async () => {
  const providers = createProviders({
    fetchImpl: async () => jsonResponse({
      code: 1,
      result: { "0x0000000000000000000000000000000000000001": {} },
    }),
  });

  await assert.rejects(providers.security("ethereum", evmTokenAddressLower), {
    code: "UPSTREAM_FAILURE",
  });
});
