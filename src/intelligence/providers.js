import { createTtlCache } from "./cache.js";

export const MARKET_CHAINS = Object.freeze([
  "solana",
  "ethereum",
  "xlayer",
  "base",
  "bsc",
  "arbitrum",
  "polygon",
]);

export const GOPLUS_CHAIN_IDS = Object.freeze({
  ethereum: 1,
  bsc: 56,
  polygon: 137,
  arbitrum: 42161,
  base: 8453,
  xlayer: 196,
});

export const GECKOTERMINAL_NETWORK_IDS = Object.freeze({
  solana: "solana",
  ethereum: "eth",
  xlayer: "x-layer",
  base: "base",
  bsc: "bsc",
  arbitrum: "arbitrum",
  polygon: "polygon_pos",
});

const marketChainSet = new Set(MARKET_CHAINS);
const DEXSCREENER_API_BASE = "https://api.dexscreener.com/token-pairs/v1";
const GECKOTERMINAL_ACCEPT = "application/json;version=20230302";
const GOPLUS_API_BASE = "https://api.gopluslabs.io/api/v1/token_security";
const EVM_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i;
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function codedError(message, code, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
}

function providerEnvelopeCause(providerCode, message) {
  const cause = new Error(message);
  cause.providerCode = providerCode;
  return cause;
}

function isTimeoutError(error) {
  const name = String(error?.name ?? "").toLowerCase();
  const code = String(error?.code ?? "").toUpperCase();
  const message = String(error?.message ?? "").toLowerCase();
  return name.includes("abort")
    || name.includes("timeout")
    || code === "ABORT_ERR"
    || code.includes("TIMEOUT")
    || message.includes("timed out")
    || message.includes("aborted");
}

function normalizeUpstreamError(error) {
  return isTimeoutError(error)
    ? codedError("Upstream request timed out", "UPSTREAM_TIMEOUT", error)
    : codedError("Upstream request failed", "UPSTREAM_FAILURE", error);
}

function normalizeChainName(chain) {
  const normalized = typeof chain === "string" ? chain.trim().toLowerCase() : "";
  if (!normalized) throw codedError("Chain is required", "INVALID_INPUT");
  return normalized;
}

function normalizeChain(chain) {
  const normalized = normalizeChainName(chain);
  if (!marketChainSet.has(normalized)) {
    throw codedError("Unsupported market chain", "INVALID_INPUT");
  }
  return normalized;
}

function normalizeAddress(chain, tokenAddress) {
  const normalized = typeof tokenAddress === "string" ? tokenAddress.trim() : "";
  if (!normalized) throw codedError("Token address is required", "INVALID_INPUT");
  const isValid = chain === "solana"
    ? SOLANA_ADDRESS_PATTERN.test(normalized)
    : EVM_ADDRESS_PATTERN.test(normalized);
  if (!isValid) throw codedError("Token address is invalid for this chain", "INVALID_INPUT");
  return normalized;
}

function cacheAddress(chain, tokenAddress) {
  return chain === "solana" ? tokenAddress : tokenAddress.toLowerCase();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = typeof value === "string" ? value.trim() : value;
  if (normalized === "") return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function stringOrNull(value) {
  if (typeof value !== "string") return value == null ? null : String(value);
  const normalized = value.trim();
  return normalized || null;
}

function booleanOrNull(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (normalized === true || normalized === 1 || normalized === "1" || normalized === "true") return true;
  if (normalized === false || normalized === 0 || normalized === "0" || normalized === "false") return false;
  return null;
}

function normalizeNumericRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return {};
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, numberOrNull(value)]),
  );
}

function normalizeTransactionWindows(windows) {
  if (!windows || typeof windows !== "object" || Array.isArray(windows)) return {};
  return Object.fromEntries(
    Object.entries(windows).map(([window, counts]) => [window, normalizeNumericRecord(counts)]),
  );
}

function normalizeToken(token) {
  const value = token && typeof token === "object" ? token : {};
  return {
    address: stringOrNull(value.address),
    name: stringOrNull(value.name),
    symbol: stringOrNull(value.symbol),
  };
}

function normalizePair(pair, { chain, source, sourceUrl, accessedAt, url }) {
  const value = pair && typeof pair === "object" ? pair : {};
  return {
    chainId: stringOrNull(value.chainId) ?? chain,
    dexId: stringOrNull(value.dexId),
    pairAddress: stringOrNull(value.pairAddress),
    labels: Array.isArray(value.labels) ? [...value.labels] : [],
    baseToken: normalizeToken(value.baseToken),
    quoteToken: normalizeToken(value.quoteToken),
    priceNative: numberOrNull(value.priceNative),
    priceUsd: numberOrNull(value.priceUsd),
    priceChange: normalizeNumericRecord(value.priceChange),
    volume: normalizeNumericRecord(value.volume),
    txns: normalizeTransactionWindows(value.txns),
    liquidity: {
      usd: numberOrNull(value.liquidity?.usd),
      base: numberOrNull(value.liquidity?.base),
      quote: numberOrNull(value.liquidity?.quote),
    },
    marketCap: numberOrNull(value.marketCap),
    fdv: numberOrNull(value.fdv),
    pairCreatedAt: numberOrNull(value.pairCreatedAt),
    url: stringOrNull(url ?? value.url),
    source,
    sourceUrl,
    accessedAt,
  };
}

function isUsablePair(pair) {
  return Boolean(pair.pairAddress)
    && Number.isFinite(pair.liquidity.usd)
    && pair.liquidity.usd > 0;
}

function selectPrimaryPair(pairs) {
  return pairs
    .filter(isUsablePair)
    .reduce((best, pair) => (
      best === null || pair.liquidity.usd > best.liquidity.usd ? pair : best
    ), null);
}

function sourceEvidence(source, sourceUrl, accessedAt, pairs) {
  const usablePairCount = pairs.filter(isUsablePair).length;
  const names = {
    dexscreener: "DexScreener Token Pairs",
    geckoterminal: "GeckoTerminal Top Pools",
  };
  return {
    source,
    name: names[source],
    url: sourceUrl,
    accessedAt,
    status: usablePairCount > 0 ? "ok" : pairs.length === 0 ? "empty" : "unusable",
    pairCount: pairs.length,
    usablePairCount,
  };
}

function normalizeDexMarket(payload, { chain, tokenAddress, sourceUrl, accessedAt }) {
  const rawPairs = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.pairs) ? payload.pairs : [];
  const pairs = rawPairs.map((pair) => normalizePair(pair, {
    chain,
    source: "dexscreener",
    sourceUrl,
    accessedAt,
  }));

  return {
    chain,
    tokenAddress,
    source: "dexscreener",
    sourceUrl,
    accessedAt,
    pairs,
    primaryPair: selectPrimaryPair(pairs),
    sources: [sourceEvidence("dexscreener", sourceUrl, accessedAt, pairs)],
  };
}

function includedResource(payload, relationship) {
  const id = relationship?.data?.id;
  if (!id || !Array.isArray(payload?.included)) return null;
  return payload.included.find((item) => item?.id === id) ?? null;
}

function relationshipAddress(relationship, networkId) {
  const id = stringOrNull(relationship?.data?.id);
  if (!id) return null;
  const prefix = `${networkId}_`;
  if (id.startsWith(prefix)) return id.slice(prefix.length);
  const separator = id.indexOf("_");
  return separator >= 0 ? id.slice(separator + 1) : null;
}

function geckoToken(payload, relationship, networkId) {
  const resource = includedResource(payload, relationship);
  return normalizeToken({
    ...resource?.attributes,
    address: resource?.attributes?.address ?? relationshipAddress(relationship, networkId),
  });
}

function addressesEqual(chain, first, second) {
  if (!first || !second) return false;
  return chain === "solana"
    ? first === second
    : first.toLowerCase() === second.toLowerCase();
}

function geckoPoolUrl(networkId, pairAddress) {
  if (!pairAddress) return null;
  return `https://www.geckoterminal.com/${encodeURIComponent(networkId)}/pools/${encodeURIComponent(pairAddress)}`;
}

function normalizeGeckoMarket(payload, {
  chain,
  networkId,
  tokenAddress,
  sourceUrl,
  accessedAt,
}) {
  const pools = Array.isArray(payload?.data) ? payload.data : [];
  const pairs = pools.map((pool) => {
    const attributes = pool?.attributes ?? {};
    const pairAddress = stringOrNull(attributes.address);
    const pairCreatedAt = Date.parse(attributes.pool_created_at);
    const poolBaseToken = geckoToken(payload, pool?.relationships?.base_token, networkId);
    const poolQuoteToken = geckoToken(payload, pool?.relationships?.quote_token, networkId);
    const requestedTokenIsQuote = addressesEqual(
      chain,
      poolQuoteToken.address,
      tokenAddress,
    );
    return normalizePair({
      chainId: chain,
      dexId: pool?.relationships?.dex?.data?.id,
      pairAddress,
      baseToken: requestedTokenIsQuote ? poolQuoteToken : poolBaseToken,
      quoteToken: requestedTokenIsQuote ? poolBaseToken : poolQuoteToken,
      priceNative: requestedTokenIsQuote
        ? attributes.quote_token_price_native_currency
        : attributes.base_token_price_native_currency,
      priceUsd: attributes.token_price_usd ?? (requestedTokenIsQuote
        ? attributes.quote_token_price_usd
        : attributes.base_token_price_usd),
      priceChange: attributes.price_change_percentage,
      volume: attributes.volume_usd,
      txns: attributes.transactions,
      liquidity: { usd: attributes.reserve_in_usd },
      marketCap: attributes.market_cap_usd,
      fdv: attributes.fdv_usd,
      pairCreatedAt: Number.isFinite(pairCreatedAt) ? pairCreatedAt : null,
    }, {
      chain,
      source: "geckoterminal",
      sourceUrl,
      accessedAt,
      url: geckoPoolUrl(networkId, pairAddress),
    });
  });

  return {
    chain,
    tokenAddress,
    source: "geckoterminal",
    sourceUrl,
    accessedAt,
    pairs,
    primaryPair: selectPrimaryPair(pairs),
    sources: [sourceEvidence("geckoterminal", sourceUrl, accessedAt, pairs)],
  };
}

function normalizeHolder(holder) {
  const value = holder && typeof holder === "object" ? holder : {};
  return {
    address: stringOrNull(value.address),
    tag: stringOrNull(value.tag),
    isContract: booleanOrNull(value.is_contract),
    balance: stringOrNull(value.balance),
    percent: numberOrNull(value.percent),
    isLocked: booleanOrNull(value.is_locked),
  };
}

function normalizeHolderArray(holders) {
  if (!Array.isArray(holders)) return null;
  if (holders.some((holder) => !holder || typeof holder !== "object" || Array.isArray(holder))) {
    return null;
  }
  return holders.map(normalizeHolder);
}

function validateGoPlusEnvelope(payload) {
  const providerCode = Number(payload?.code);
  if (providerCode === 4029) {
    throw codedError(
      "Upstream request was rate limited",
      "UPSTREAM_RATE_LIMITED",
      providerEnvelopeCause(providerCode, "GoPlus response code 4029"),
    );
  }
  if (providerCode === 2) {
    throw codedError(
      "Upstream security data is incomplete",
      "UPSTREAM_FAILURE",
      providerEnvelopeCause(providerCode, "GoPlus response code 2"),
    );
  }
  if (providerCode !== 1) {
    throw codedError(
      "Upstream security request failed",
      "UPSTREAM_FAILURE",
      providerEnvelopeCause(
        Number.isFinite(providerCode) ? providerCode : null,
        "GoPlus response did not report complete data",
      ),
    );
  }
  if (!payload.result || typeof payload.result !== "object" || Array.isArray(payload.result)) {
    throw codedError(
      "Upstream security result is invalid",
      "UPSTREAM_FAILURE",
      providerEnvelopeCause(providerCode, "GoPlus result is not an object"),
    );
  }
  return payload.result;
}

function normalizeGoPlusSecurity(value, { chain, tokenAddress, sourceUrl, accessedAt }) {
  return {
    chain,
    tokenAddress,
    source: "goplus",
    sourceUrl,
    accessedAt,
    tokenName: stringOrNull(value.token_name),
    tokenSymbol: stringOrNull(value.token_symbol),
    totalSupply: stringOrNull(value.total_supply),
    isOpenSource: booleanOrNull(value.is_open_source),
    isProxy: booleanOrNull(value.is_proxy),
    isMintable: booleanOrNull(value.is_mintable),
    canTakeBackOwnership: booleanOrNull(value.can_take_back_ownership),
    ownerChangeBalance: booleanOrNull(value.owner_change_balance),
    hiddenOwner: booleanOrNull(value.hidden_owner),
    selfDestruct: booleanOrNull(value.selfdestruct),
    externalCall: booleanOrNull(value.external_call),
    gasAbuse: booleanOrNull(value.gas_abuse),
    buyTax: numberOrNull(value.buy_tax),
    sellTax: numberOrNull(value.sell_tax),
    cannotBuy: booleanOrNull(value.cannot_buy),
    cannotSellAll: booleanOrNull(value.cannot_sell_all),
    slippageModifiable: booleanOrNull(value.slippage_modifiable),
    personalSlippageModifiable: booleanOrNull(value.personal_slippage_modifiable),
    transferPausable: booleanOrNull(value.transfer_pausable),
    tradingCooldown: booleanOrNull(value.trading_cooldown),
    isHoneypot: booleanOrNull(value.is_honeypot),
    isBlacklisted: booleanOrNull(value.is_blacklisted),
    antiWhale: booleanOrNull(value.is_anti_whale ?? value.anti_whale),
    antiWhaleModifiable: booleanOrNull(value.anti_whale_modifiable),
    holderCount: numberOrNull(value.holder_count),
    holders: normalizeHolderArray(value.holders),
    lpHolderCount: numberOrNull(value.lp_holder_count),
    lpHolders: normalizeHolderArray(value.lp_holders),
    ownerAddress: stringOrNull(value.owner_address),
    ownerBalance: stringOrNull(value.owner_balance),
    ownerPercent: numberOrNull(value.owner_percent),
    creatorAddress: stringOrNull(value.creator_address),
    creatorBalance: stringOrNull(value.creator_balance),
    creatorPercent: numberOrNull(value.creator_percent),
  };
}

export function isSecurityChainSupported(chain) {
  const normalized = typeof chain === "string" ? chain.trim().toLowerCase() : "";
  return Object.hasOwn(GOPLUS_CHAIN_IDS, normalized);
}

function environmentDuration(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function createProviders({
  fetchImpl = fetch,
  timeoutMs = 5_000,
  marketCacheMs = environmentDuration(process.env.MARKET_CACHE_MS, 30_000),
  securityCacheMs = environmentDuration(process.env.SECURITY_CACHE_MS, 300_000),
  geckoApiBase = process.env.GECKOTERMINAL_API_BASE
    || "https://api.geckoterminal.com/api/v2",
  goPlusAccessToken = process.env.GOPLUS_ACCESS_TOKEN,
} = {}) {
  const marketCache = createTtlCache();
  const securityCache = createTtlCache();
  const normalizedGeckoApiBase = geckoApiBase.replace(/\/+$/, "");

  async function fetchJson(url, headers) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw normalizeUpstreamError(error);
    }

    if (response?.status === 429) {
      throw codedError(
        "Upstream request was rate limited",
        "UPSTREAM_RATE_LIMITED",
        new Error("Upstream HTTP 429"),
      );
    }
    if (!response?.ok) {
      throw codedError(
        "Upstream request failed",
        "UPSTREAM_FAILURE",
        new Error(`Upstream HTTP ${response?.status ?? "unknown"}`),
      );
    }

    try {
      return await response.json();
    } catch (error) {
      throw normalizeUpstreamError(error);
    }
  }

  async function marketFallback(chain, tokenAddress) {
    const normalizedChain = normalizeChain(chain);
    const normalizedAddress = normalizeAddress(normalizedChain, tokenAddress);
    const networkId = GECKOTERMINAL_NETWORK_IDS[normalizedChain];
    const sourceUrl = `${normalizedGeckoApiBase}/networks/${encodeURIComponent(networkId)}`
      + `/tokens/${encodeURIComponent(normalizedAddress)}/pools`
      + "?include=base_token,quote_token";
    const payload = await fetchJson(sourceUrl, { Accept: GECKOTERMINAL_ACCEPT });
    return normalizeGeckoMarket(payload, {
      chain: normalizedChain,
      networkId,
      tokenAddress: normalizedAddress,
      sourceUrl,
      accessedAt: new Date().toISOString(),
    });
  }

  return {
    async market(chain, tokenAddress) {
      const normalizedChain = normalizeChain(chain);
      const normalizedAddress = normalizeAddress(normalizedChain, tokenAddress);
      const cacheKey = `${normalizedChain}:${cacheAddress(normalizedChain, normalizedAddress)}`;

      return marketCache.getOrLoad(cacheKey, marketCacheMs, async () => {
        const sourceUrl = `${DEXSCREENER_API_BASE}/${encodeURIComponent(normalizedChain)}`
          + `/${encodeURIComponent(normalizedAddress)}`;
        const payload = await fetchJson(sourceUrl);
        const market = normalizeDexMarket(payload, {
          chain: normalizedChain,
          tokenAddress: normalizedAddress,
          sourceUrl,
          accessedAt: new Date().toISOString(),
        });
        if (market.primaryPair) return market;

        const fallbackMarket = await marketFallback(normalizedChain, normalizedAddress);
        return {
          ...fallbackMarket,
          sources: [...market.sources, ...fallbackMarket.sources],
          fallback: {
            reason: market.pairs.length === 0
              ? "dexscreener_empty"
              : "dexscreener_no_usable_pair",
            attemptedPairs: market.pairs,
          },
        };
      });
    },

    marketFallback,

    async security(chain, tokenAddress) {
      const normalizedChain = normalizeChainName(chain);
      if (!isSecurityChainSupported(normalizedChain)) {
        throw codedError("Security data is unavailable for this chain", "SECURITY_CHAIN_UNSUPPORTED");
      }
      const normalizedAddress = normalizeAddress(normalizedChain, tokenAddress);
      const cacheKey = `${normalizedChain}:${cacheAddress(normalizedChain, normalizedAddress)}`;

      return securityCache.getOrLoad(cacheKey, securityCacheMs, async () => {
        const chainId = GOPLUS_CHAIN_IDS[normalizedChain];
        const sourceUrl = `${GOPLUS_API_BASE}/${chainId}`
          + `?contract_addresses=${encodeURIComponent(normalizedAddress)}`;
        const headers = {};
        if (goPlusAccessToken) headers.Authorization = `Bearer ${goPlusAccessToken}`;
        const payload = await fetchJson(sourceUrl, headers);
        const result = validateGoPlusEnvelope(payload);
        const entry = Object.entries(result).find(
          ([address]) => address.toLowerCase() === normalizedAddress.toLowerCase(),
        );
        if (!entry) {
          throw codedError(
            "Upstream security result is missing",
            "UPSTREAM_FAILURE",
            providerEnvelopeCause(1, "GoPlus result did not include the requested address"),
          );
        }
        if (!entry[1] || typeof entry[1] !== "object" || Array.isArray(entry[1])) {
          throw codedError(
            "Upstream security result is invalid",
            "UPSTREAM_FAILURE",
            providerEnvelopeCause(1, "GoPlus address result is not an object"),
          );
        }
        return normalizeGoPlusSecurity(entry[1], {
          chain: normalizedChain,
          tokenAddress: normalizedAddress,
          sourceUrl,
          accessedAt: new Date().toISOString(),
        });
      });
    },
  };
}
