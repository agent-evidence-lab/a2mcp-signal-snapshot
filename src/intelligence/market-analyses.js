import { randomUUID } from "node:crypto";
import { SERVICE_BY_ID } from "./catalog.js";

const VERSION = "0.3.0";
const WINDOWS = Object.freeze(["m5", "h1", "h6", "h24"]);
const HOUR_MS = 60 * 60 * 1_000;
const SEVERITY = Object.freeze(["low", "medium", "high", "critical"]);

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function addWarning(warnings, warning) {
  if (!warnings.includes(warning)) warnings.push(warning);
}

function analysisOptions(options = {}) {
  const nowValue = typeof options.now === "function" ? options.now() : Date.now();
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const requestId = typeof options.requestId === "function" ? options.requestId() : randomUUID();
  return { now, requestId };
}

function providerWarnings(market) {
  const warnings = market?.data_quality?.warnings;
  return Array.isArray(warnings) ? [...warnings] : [];
}

function dataQuality(market, warnings) {
  const providerQuality = market?.data_quality
    && typeof market.data_quality === "object"
    && !Array.isArray(market.data_quality)
    ? market.data_quality
    : {};
  const sources = Array.isArray(market?.sources) ? market.sources : [];
  const pairs = Array.isArray(market?.pairs) ? market.pairs : [];

  return {
    ...providerQuality,
    status: market?.primaryPair ? (warnings.length > 0 ? "partial" : "complete") : "unavailable",
    pair_count: pairs.length,
    source_count: sources.length,
    warnings: [...new Set(warnings)],
  };
}

function envelope(serviceId, input, market, options, warnings) {
  const service = SERVICE_BY_ID.get(serviceId);
  if (!service) throw new Error(`Unknown market service: ${serviceId}`);
  const { now, requestId } = analysisOptions(options);

  return {
    ok: true,
    service: { id: service.id, version: VERSION },
    request_id: requestId,
    generated_at: now.toISOString(),
    input: { ...input },
    data_quality: dataQuality(market, warnings),
    sources: Array.isArray(market?.sources) ? market.sources.map((source) => ({ ...source })) : [],
  };
}

function pairsOf(market) {
  return Array.isArray(market?.pairs) ? market.pairs.filter(Boolean) : [];
}

function primaryPairOf(market) {
  return market?.primaryPair && typeof market.primaryPair === "object"
    ? market.primaryPair
    : null;
}

function observedLiquidity(pairs) {
  const values = pairs
    .map((pair) => numberOrNull(pair?.liquidity?.usd))
    .filter((value) => value !== null && value >= 0);
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
}

function primaryLiquidity(market) {
  const primary = numberOrNull(primaryPairOf(market)?.liquidity?.usd);
  if (primary !== null && primary >= 0) return primary;
  const candidates = pairsOf(market)
    .map((pair) => numberOrNull(pair?.liquidity?.usd))
    .filter((value) => value !== null && value >= 0);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function transactionWindow(pair, window) {
  const values = pair?.txns?.[window];
  const buys = numberOrNull(values?.buys);
  const sells = numberOrNull(values?.sells);
  const total = buys !== null && sells !== null ? buys + sells : null;
  return {
    buys,
    sells,
    total,
    buyRatio: total !== null && total > 0 ? buys / total : null,
    sellRatio: total !== null && total > 0 ? sells / total : null,
  };
}

function ageHours(pair, now, warnings) {
  const createdAt = numberOrNull(pair?.pairCreatedAt);
  if (createdAt === null) {
    addWarning(warnings, "pair_created_at_unavailable");
    return null;
  }
  const age = (now.getTime() - createdAt) / HOUR_MS;
  if (age < 0) {
    addWarning(warnings, "pair_created_at_in_future");
    return 0;
  }
  return age;
}

function nullableWindows(record) {
  return Object.fromEntries(WINDOWS.map((window) => [window, numberOrNull(record?.[window])]));
}

function poolSummary(pair) {
  return {
    pair_address: pair?.pairAddress ?? null,
    dex_id: pair?.dexId ?? null,
    base_symbol: pair?.baseToken?.symbol ?? null,
    quote_symbol: pair?.quoteToken?.symbol ?? null,
    liquidity_usd: numberOrNull(pair?.liquidity?.usd),
    url: pair?.url ?? null,
    source: pair?.source ?? null,
  };
}

function riskFromLiquidity(totalUsd) {
  if (totalUsd === null) return "unknown";
  if (totalUsd < 10_000) return "critical";
  if (totalUsd < 50_000) return "high";
  if (totalUsd < 200_000) return "medium";
  return "low";
}

function raiseSeverity(level) {
  const index = SEVERITY.indexOf(level);
  if (index < 0) return level;
  return SEVERITY[Math.min(index + 1, SEVERITY.length - 1)];
}

function riskFromAge(hours) {
  if (hours === null) return "unknown";
  if (hours < 6) return "critical";
  if (hours < 24) return "high";
  if (hours < 7 * 24) return "medium";
  return "low";
}

function selectedLookbackWindow(hours) {
  if (hours <= 1) return "h1";
  if (hours <= 6) return "h6";
  return "h24";
}

export function buildMarketSnapshot(input, market, options = {}) {
  const warnings = providerWarnings(market);
  const primary = primaryPairOf(market);
  if (!primary) addWarning(warnings, "primary_pair_unavailable");
  const { now } = analysisOptions(options);
  const pairs = pairsOf(market);
  const totalLiquidity = observedLiquidity(pairs);
  const pairAgeHours = ageHours(primary, now, warnings);
  if (totalLiquidity === null) addWarning(warnings, "liquidity_unavailable");

  const transactionWindows = Object.fromEntries(WINDOWS.map((window) => {
    const counts = transactionWindow(primary, window);
    return [window, { buys: counts.buys, sells: counts.sells, total: counts.total }];
  }));
  const topPools = pairs
    .map(poolSummary)
    .sort((left, right) => (right.liquidity_usd ?? -1) - (left.liquidity_usd ?? -1))
    .slice(0, 5);

  return {
    ...envelope("token-market-snapshot", input, market, options, warnings),
    identity: {
      chain: market?.chain ?? input?.chain ?? null,
      token_address: market?.tokenAddress ?? input?.token_address ?? null,
      name: primary?.baseToken?.name ?? null,
      symbol: primary?.baseToken?.symbol ?? null,
    },
    primary_pool: poolSummary(primary),
    price: {
      usd: numberOrNull(primary?.priceUsd),
      native: numberOrNull(primary?.priceNative),
    },
    valuation: {
      market_cap_usd: numberOrNull(primary?.marketCap),
      fdv_usd: numberOrNull(primary?.fdv),
    },
    liquidity: {
      primary_pool_usd: numberOrNull(primary?.liquidity?.usd),
      observed_total_usd: totalLiquidity,
    },
    price_changes: nullableWindows(primary?.priceChange),
    volume: nullableWindows(primary?.volume),
    transactions: transactionWindows,
    pair_age_hours: pairAgeHours,
    top_pools: topPools,
    coverage: {
      observed_pools: pairs.length,
      priced_pools: pairs.filter((pair) => numberOrNull(pair?.priceUsd) !== null).length,
      source_count: Array.isArray(market?.sources) ? market.sources.length : 0,
    },
  };
}

export function buildLiquidityRisk(input, market, options = {}) {
  const warnings = providerWarnings(market);
  const pairs = pairsOf(market);
  const totalUsd = observedLiquidity(pairs);
  const primaryUsd = primaryLiquidity(market);
  const primaryShare = totalUsd !== null && totalUsd > 0 && primaryUsd !== null
    ? primaryUsd / totalUsd
    : null;
  const marketCap = numberOrNull(primaryPairOf(market)?.marketCap);
  const minLiquidity = numberOrNull(input?.min_liquidity_usd);
  const flags = [];

  if (totalUsd === null) {
    flags.push("liquidity_unknown");
    addWarning(warnings, "liquidity_unavailable");
  } else if (totalUsd === 0) {
    flags.push("zero_liquidity");
  }
  if (primaryShare !== null && primaryShare >= 0.9) flags.push("primary_pool_concentration");
  if (minLiquidity !== null && totalUsd !== null && totalUsd < minLiquidity) {
    flags.push("below_requested_minimum");
  }
  if (marketCap === null || marketCap <= 0) addWarning(warnings, "market_cap_unavailable");

  return {
    ...envelope("liquidity-risk-scan", input, market, options, warnings),
    risk_level: riskFromLiquidity(totalUsd),
    flags,
    liquidity: {
      total_usd: totalUsd,
      primary_pool_usd: primaryUsd,
      pools_observed: pairs.length,
      primary_share: primaryShare,
      market_cap_usd: marketCap,
      liquidity_to_market_cap_ratio: totalUsd !== null && marketCap !== null && marketCap > 0
        ? totalUsd / marketCap
        : null,
      min_liquidity_usd: minLiquidity,
      meets_minimum: minLiquidity !== null && totalUsd !== null ? totalUsd >= minLiquidity : null,
    },
    pool_distribution: pairs
      .map(poolSummary)
      .sort((left, right) => (right.liquidity_usd ?? -1) - (left.liquidity_usd ?? -1)),
  };
}

export function buildTradingActivity(input, market, options = {}) {
  const warnings = providerWarnings(market);
  const primary = primaryPairOf(market);
  const windows = Object.fromEntries(WINDOWS.map((window) => {
    const counts = transactionWindow(primary, window);
    return [window, {
      volume_usd: numberOrNull(primary?.volume?.[window]),
      buy_count: counts.buys,
      sell_count: counts.sells,
      total_transactions: counts.total,
      buy_ratio: counts.buyRatio,
      sell_ratio: counts.sellRatio,
    }];
  }));
  const h24 = windows.h24;
  const flags = [];
  let classification = "active";

  if (h24.total_transactions === null) {
    classification = "unknown";
    addWarning(warnings, "activity_windows_incomplete");
  } else if (h24.total_transactions === 0) {
    classification = "inactive";
    flags.push("inactive_24h");
  } else if (h24.buy_ratio > 0.8) {
    classification = "one-sided";
    flags.push("one_sided_buying");
  } else if (h24.sell_ratio > 0.8) {
    classification = "one-sided";
    flags.push("one_sided_selling");
  }
  if (WINDOWS.some((window) => windows[window].volume_usd === null
    || windows[window].total_transactions === null)) {
    addWarning(warnings, "activity_windows_incomplete");
  }

  const requestedLookback = numberOrNull(input?.lookback_hours);
  return {
    ...envelope("trading-activity-scan", input, market, options, warnings),
    flags,
    activity: {
      classification,
      requested_lookback_hours: requestedLookback,
      selected_window: requestedLookback === null ? "h24" : selectedLookbackWindow(requestedLookback),
      windows,
    },
  };
}

export function buildNewPairRisk(input, market, options = {}) {
  const warnings = providerWarnings(market);
  const primary = primaryPairOf(market);
  const { now } = analysisOptions(options);
  const pairAgeHours = ageHours(primary, now, warnings);
  const liquidityUsd = numberOrNull(primary?.liquidity?.usd);
  const acceptedProfiles = new Set(["conservative", "balanced", "aggressive"]);
  const requestedProfile = input?.risk_profile;
  const riskProfile = acceptedProfiles.has(requestedProfile) ? requestedProfile : "balanced";
  if (requestedProfile !== undefined && !acceptedProfiles.has(requestedProfile)) {
    addWarning(warnings, "risk_profile_invalid_defaulted_to_balanced");
  }
  const profileLiquidityThreshold = riskProfile === "conservative" ? 100_000 : 50_000;
  const flags = [];
  let riskLevel = riskFromAge(pairAgeHours);

  if (pairAgeHours === null) flags.push("pair_age_unknown");
  if (liquidityUsd === null) {
    flags.push("launch_liquidity_unknown");
    addWarning(warnings, "launch_liquidity_unavailable");
  } else if (liquidityUsd < profileLiquidityThreshold) {
    if (liquidityUsd < 50_000) flags.push("low_launch_liquidity");
    if (riskProfile === "conservative" && liquidityUsd >= 50_000) {
      flags.push("below_profile_liquidity_threshold");
    }
    if (riskLevel !== "unknown") riskLevel = raiseSeverity(riskLevel);
  }

  return {
    ...envelope("new-pair-risk-check", input, market, options, warnings),
    risk_level: riskLevel,
    risk_profile: riskProfile,
    pair_age_hours: pairAgeHours,
    flags,
    launch_evidence: {
      liquidity_usd: liquidityUsd,
      profile_liquidity_threshold_usd: profileLiquidityThreshold,
      price_changes: nullableWindows(primary?.priceChange),
      volume: nullableWindows(primary?.volume),
    },
  };
}

function anomaly(code, window, value, threshold, direction = null) {
  return { code, window, value, threshold, direction };
}

export function buildMarketAnomaly(input, market, options = {}) {
  const warnings = providerWarnings(market);
  const primary = primaryPairOf(market);
  const h1Change = numberOrNull(primary?.priceChange?.h1);
  const h24Change = numberOrNull(primary?.priceChange?.h24);
  const h24Volume = numberOrNull(primary?.volume?.h24);
  const liquidityUsd = numberOrNull(primary?.liquidity?.usd);
  const h24Txns = transactionWindow(primary, "h24");
  const volumeLiquidityRatio = h24Volume !== null && liquidityUsd !== null && liquidityUsd > 0
    ? h24Volume / liquidityUsd
    : null;
  const anomalies = [];

  if (h1Change !== null && Math.abs(h1Change) >= 20) {
    anomalies.push(anomaly("price_change_h1", "h1", h1Change, 20, h1Change >= 0 ? "up" : "down"));
  }
  if (h24Change !== null && Math.abs(h24Change) >= 50) {
    anomalies.push(anomaly("price_change_h24", "h24", h24Change, 50, h24Change >= 0 ? "up" : "down"));
  }
  if (h24Txns.buyRatio !== null && h24Txns.buyRatio >= 0.85) {
    anomalies.push(anomaly("buy_ratio_h24", "h24", h24Txns.buyRatio, 0.85, "buy"));
  }
  if (h24Txns.sellRatio !== null && h24Txns.sellRatio >= 0.85) {
    anomalies.push(anomaly("sell_ratio_h24", "h24", h24Txns.sellRatio, 0.85, "sell"));
  }
  if (volumeLiquidityRatio !== null && volumeLiquidityRatio >= 5) {
    anomalies.push(anomaly("volume_liquidity_ratio_h24", "h24", volumeLiquidityRatio, 5));
  }

  const customThreshold = numberOrNull(input?.anomaly_threshold);
  const requestedLookback = numberOrNull(input?.lookback_hours);
  let customCheck = null;
  if (customThreshold !== null) {
    const window = selectedLookbackWindow(requestedLookback ?? 24);
    const value = numberOrNull(primary?.priceChange?.[window]);
    const triggered = value === null ? null : Math.abs(value) >= customThreshold;
    customCheck = {
      window,
      threshold_percent: customThreshold,
      price_change_percent: value,
      triggered,
    };
    if (triggered) {
      anomalies.push(anomaly(
        `custom_price_change_${window}`,
        window,
        value,
        customThreshold,
        value >= 0 ? "up" : "down",
      ));
    }
    if (value === null) addWarning(warnings, "custom_anomaly_window_unavailable");
  }

  if (h24Txns.buyRatio === null || h24Txns.sellRatio === null || volumeLiquidityRatio === null) {
    addWarning(warnings, "anomaly_ratio_inputs_unavailable");
  }

  const riskLevel = anomalies.length >= 4
    ? "critical"
    : anomalies.length >= 2 ? "high" : anomalies.length === 1 ? "medium" : "low";
  return {
    ...envelope("market-anomaly-scan", input, market, options, warnings),
    risk_level: riskLevel,
    flags: anomalies.map((item) => item.code),
    metrics: {
      price_change_h1_percent: h1Change,
      price_change_h24_percent: h24Change,
      buy_ratio_h24: h24Txns.buyRatio,
      sell_ratio_h24: h24Txns.sellRatio,
      volume_h24_usd: h24Volume,
      liquidity_usd: liquidityUsd,
      volume_liquidity_ratio_h24: volumeLiquidityRatio,
    },
    custom_check: customCheck,
    anomalies,
  };
}
