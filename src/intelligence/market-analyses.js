import { randomUUID } from "node:crypto";
import { SERVICE_BY_ID } from "./catalog.js";

const VERSION = "0.3.0";
const WINDOWS = Object.freeze(["m5", "h1", "h6", "h24"]);
const HOUR_MS = 60 * 60 * 1_000;
const SEVERITY = Object.freeze(["low", "medium", "high", "critical"]);

function addWarning(warnings, warning) {
  if (!warnings.includes(warning)) warnings.push(warning);
}

function sanitizeOutput(value, warnings) {
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    addWarning(warnings, "invalid_non_finite_numeric");
    return null;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeOutput(item, warnings));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeOutput(item, warnings)]),
  );
}

function numberOrNull(value, warnings = null, { nonNegative = false } = {}) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    if (warnings) addWarning(warnings, "invalid_non_finite_numeric");
    return null;
  }
  if (nonNegative && value < 0) {
    if (warnings) addWarning(warnings, "invalid_negative_numeric");
    return null;
  }
  return value;
}

function safeSum(values, warnings) {
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isFinite(total)) {
      addWarning(warnings, "numeric_overflow");
      return null;
    }
  }
  return total;
}

function safeRatio(numerator, denominator, warnings) {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  const ratio = numerator / denominator;
  if (!Number.isFinite(ratio)) {
    addWarning(warnings, "numeric_overflow");
    return null;
  }
  return ratio;
}

function analysisContext(options = {}) {
  const nowValue = typeof options.now === "function" ? options.now() : Date.now();
  const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
  if (!Number.isFinite(now.getTime())) throw new RangeError("analysis clock must be a valid date");
  const requestId = typeof options.requestId === "function" ? options.requestId() : randomUUID();
  return { now, requestId };
}

function providerWarnings(market) {
  const warnings = market?.data_quality?.warnings;
  return Array.isArray(warnings) ? [...warnings] : [];
}

function dataQuality(market, warnings, sources) {
  const rawProviderQuality = market?.data_quality
    && typeof market.data_quality === "object"
    && !Array.isArray(market.data_quality)
    ? market.data_quality
    : {};
  const providerQuality = sanitizeOutput(rawProviderQuality, warnings);
  const pairs = Array.isArray(market?.pairs) ? market.pairs : [];
  const sourceStatuses = sources.map((source) => ({
    source: source?.source ?? "unknown",
    status: typeof source?.status === "string" ? source.status : "unknown",
    url: source?.url ?? null,
  }));
  for (const source of sourceStatuses) {
    if (source.status !== "ok") {
      addWarning(warnings, `source_degraded:${source.source}:${source.status}`);
    }
  }
  if (sourceStatuses.length === 0) addWarning(warnings, "source_provenance_unavailable");

  const fallbackReason = typeof market?.fallback?.reason === "string"
    ? market.fallback.reason
    : null;
  if (market?.fallback) addWarning(warnings, `market_fallback_used:${fallbackReason ?? "unspecified"}`);

  const providerStatus = providerQuality.status ?? providerQuality.provider_status ?? null;
  const providerDegraded = providerStatus !== null && !["ok", "complete"].includes(providerStatus);
  const sourceDegraded = sourceStatuses.some((source) => source.status !== "ok");
  const degraded = warnings.length > 0 || providerDegraded || sourceDegraded || Boolean(market?.fallback);

  return {
    ...providerQuality,
    status: market?.primaryPair ? (degraded ? "partial" : "complete") : "unavailable",
    pair_count: pairs.length,
    source_count: sources.length,
    source_statuses: sourceStatuses,
    fallback: { used: Boolean(market?.fallback), reason: fallbackReason },
    warnings: [...new Set(warnings)],
  };
}

function envelope(serviceId, input, market, context, warnings) {
  const service = SERVICE_BY_ID.get(serviceId);
  if (!service) throw new Error(`Unknown market service: ${serviceId}`);
  const sanitizedInput = sanitizeOutput(input, warnings);
  const sanitizedSources = sanitizeOutput(
    Array.isArray(market?.sources) ? market.sources : [],
    warnings,
  );

  return {
    ok: true,
    service: { id: service.id, version: VERSION },
    request_id: context.requestId,
    generated_at: context.now.toISOString(),
    input: sanitizedInput,
    data_quality: dataQuality(market, warnings, sanitizedSources),
    sources: sanitizedSources,
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

function observedLiquidity(pairs, warnings) {
  const values = pairs
    .map((pair) => numberOrNull(pair?.liquidity?.usd, warnings, { nonNegative: true }))
    .filter((value) => value !== null);
  return safeSum(values, warnings);
}

function primaryLiquidity(market, warnings) {
  const primary = numberOrNull(
    primaryPairOf(market)?.liquidity?.usd,
    warnings,
    { nonNegative: true },
  );
  if (primary !== null) return primary;
  const candidates = pairsOf(market)
    .map((pair) => numberOrNull(pair?.liquidity?.usd, warnings, { nonNegative: true }))
    .filter((value) => value !== null);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function transactionWindow(pair, window, warnings) {
  const values = pair?.txns?.[window];
  const buys = numberOrNull(values?.buys, warnings, { nonNegative: true });
  const sells = numberOrNull(values?.sells, warnings, { nonNegative: true });
  const total = buys !== null && sells !== null ? safeSum([buys, sells], warnings) : null;
  return {
    buys,
    sells,
    total,
    buyRatio: safeRatio(buys, total, warnings),
    sellRatio: safeRatio(sells, total, warnings),
  };
}

function ageHours(pair, now, warnings) {
  const createdAt = numberOrNull(pair?.pairCreatedAt, warnings, { nonNegative: true });
  if (createdAt === null) {
    addWarning(warnings, "pair_created_at_unavailable");
    return null;
  }
  const age = (now.getTime() - createdAt) / HOUR_MS;
  if (!Number.isFinite(age)) {
    addWarning(warnings, "numeric_overflow");
    return null;
  }
  if (age < 0) {
    addWarning(warnings, "pair_created_at_in_future");
    return 0;
  }
  return age;
}

function nullableWindows(record, warnings, { nonNegative = false } = {}) {
  return Object.fromEntries(WINDOWS.map((window) => [
    window,
    numberOrNull(record?.[window], warnings, { nonNegative }),
  ]));
}

function poolSummary(pair, warnings) {
  return {
    pair_address: pair?.pairAddress ?? null,
    dex_id: pair?.dexId ?? null,
    base_symbol: pair?.baseToken?.symbol ?? null,
    quote_symbol: pair?.quoteToken?.symbol ?? null,
    liquidity_usd: numberOrNull(pair?.liquidity?.usd, warnings, { nonNegative: true }),
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
  const context = analysisContext(options);
  const warnings = providerWarnings(market);
  const primary = primaryPairOf(market);
  if (!primary) addWarning(warnings, "primary_pair_unavailable");
  const pairs = pairsOf(market);
  const totalLiquidity = observedLiquidity(pairs, warnings);
  const pairAgeHours = ageHours(primary, context.now, warnings);
  if (totalLiquidity === null) addWarning(warnings, "liquidity_unavailable");

  const transactionWindows = Object.fromEntries(WINDOWS.map((window) => {
    const counts = transactionWindow(primary, window, warnings);
    return [window, { buys: counts.buys, sells: counts.sells, total: counts.total }];
  }));
  const topPools = pairs
    .map((pair) => poolSummary(pair, warnings))
    .sort((left, right) => (right.liquidity_usd ?? -1) - (left.liquidity_usd ?? -1))
    .slice(0, 5);
  const primaryPool = poolSummary(primary, warnings);
  const price = {
    usd: numberOrNull(primary?.priceUsd, warnings, { nonNegative: true }),
    native: numberOrNull(primary?.priceNative, warnings, { nonNegative: true }),
  };
  const valuation = {
    market_cap_usd: numberOrNull(primary?.marketCap, warnings, { nonNegative: true }),
    fdv_usd: numberOrNull(primary?.fdv, warnings, { nonNegative: true }),
  };
  const liquidity = {
    primary_pool_usd: numberOrNull(primary?.liquidity?.usd, warnings, { nonNegative: true }),
    observed_total_usd: totalLiquidity,
  };
  const priceChanges = nullableWindows(primary?.priceChange, warnings);
  const volume = nullableWindows(primary?.volume, warnings, { nonNegative: true });
  const pricedPools = pairs.filter((pair) => (
    numberOrNull(pair?.priceUsd, warnings, { nonNegative: true }) !== null
  )).length;

  return {
    ...envelope("token-market-snapshot", input, market, context, warnings),
    classification: "informational",
    flags: [],
    identity: {
      chain: market?.chain ?? input?.chain ?? null,
      token_address: market?.tokenAddress ?? input?.token_address ?? null,
      name: primary?.baseToken?.name ?? null,
      symbol: primary?.baseToken?.symbol ?? null,
    },
    primary_pool: primaryPool,
    price,
    valuation,
    liquidity,
    price_changes: priceChanges,
    volume,
    transactions: transactionWindows,
    pair_age_hours: pairAgeHours,
    top_pools: topPools,
    coverage: {
      observed_pools: pairs.length,
      priced_pools: pricedPools,
      source_count: Array.isArray(market?.sources) ? market.sources.length : 0,
    },
  };
}

export function buildLiquidityRisk(input, market, options = {}) {
  const context = analysisContext(options);
  const warnings = providerWarnings(market);
  const pairs = pairsOf(market);
  const totalUsd = observedLiquidity(pairs, warnings);
  const primaryUsd = primaryLiquidity(market, warnings);
  const primaryShare = safeRatio(primaryUsd, totalUsd, warnings);
  const marketCap = numberOrNull(
    primaryPairOf(market)?.marketCap,
    warnings,
    { nonNegative: true },
  );
  const minLiquidity = numberOrNull(input?.min_liquidity_usd, warnings, { nonNegative: true });
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
  const liquidityMarketCapRatio = safeRatio(totalUsd, marketCap, warnings);
  const poolDistribution = pairs
    .map((pair) => poolSummary(pair, warnings))
    .sort((left, right) => (right.liquidity_usd ?? -1) - (left.liquidity_usd ?? -1));

  return {
    ...envelope("liquidity-risk-scan", input, market, context, warnings),
    risk_level: riskFromLiquidity(totalUsd),
    flags,
    liquidity: {
      total_usd: totalUsd,
      primary_pool_usd: primaryUsd,
      pools_observed: pairs.length,
      primary_share: primaryShare,
      market_cap_usd: marketCap,
      liquidity_to_market_cap_ratio: liquidityMarketCapRatio,
      min_liquidity_usd: minLiquidity,
      meets_minimum: minLiquidity !== null && totalUsd !== null ? totalUsd >= minLiquidity : null,
    },
    pool_distribution: poolDistribution,
  };
}

export function buildTradingActivity(input, market, options = {}) {
  const context = analysisContext(options);
  const warnings = providerWarnings(market);
  const primary = primaryPairOf(market);
  const windows = Object.fromEntries(WINDOWS.map((window) => {
    const counts = transactionWindow(primary, window, warnings);
    return [window, {
      volume_usd: numberOrNull(primary?.volume?.[window], warnings, { nonNegative: true }),
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

  const requestedLookback = numberOrNull(input?.lookback_hours, warnings, { nonNegative: true });
  return {
    ...envelope("trading-activity-scan", input, market, context, warnings),
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
  const context = analysisContext(options);
  const warnings = providerWarnings(market);
  const primary = primaryPairOf(market);
  const pairAgeHours = ageHours(primary, context.now, warnings);
  const liquidityUsd = numberOrNull(
    primary?.liquidity?.usd,
    warnings,
    { nonNegative: true },
  );
  const priceUsd = numberOrNull(primary?.priceUsd, warnings, { nonNegative: true });
  const priceNative = numberOrNull(primary?.priceNative, warnings, { nonNegative: true });
  const priceChanges = nullableWindows(primary?.priceChange, warnings);
  const volume = nullableWindows(primary?.volume, warnings, { nonNegative: true });
  const transactions = Object.fromEntries(WINDOWS.map((window) => {
    const counts = transactionWindow(primary, window, warnings);
    return [window, { buys: counts.buys, sells: counts.sells, total: counts.total }];
  }));
  const hasPriceEvidence = priceUsd !== null
    || priceNative !== null
    || Object.values(priceChanges).some((value) => value !== null);
  const hasTradingEvidence = Object.values(volume).some((value) => value !== null)
    || Object.values(transactions).some((counts) => counts.buys !== null || counts.sells !== null);
  const hasCriticalEvidence = liquidityUsd !== null || hasPriceEvidence || hasTradingEvidence;
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
  if (!hasCriticalEvidence) {
    riskLevel = "unknown";
    flags.push("insufficient_launch_data");
    addWarning(warnings, "launch_critical_inputs_unavailable");
  }

  return {
    ...envelope("new-pair-risk-check", input, market, context, warnings),
    risk_level: riskLevel,
    risk_profile: riskProfile,
    pair_age_hours: pairAgeHours,
    flags,
    launch_evidence: {
      liquidity_usd: liquidityUsd,
      profile_liquidity_threshold_usd: profileLiquidityThreshold,
      price_usd: priceUsd,
      price_native: priceNative,
      price_changes: priceChanges,
      volume,
      transactions,
    },
    coverage: {
      pair_age: pairAgeHours !== null,
      liquidity: liquidityUsd !== null,
      price: hasPriceEvidence,
      trading: hasTradingEvidence,
    },
  };
}

function anomaly(code, window, value, threshold, direction = null) {
  return { code, window, value, threshold, direction };
}

export function buildMarketAnomaly(input, market, options = {}) {
  const context = analysisContext(options);
  const warnings = providerWarnings(market);
  const primary = primaryPairOf(market);
  const h1Change = numberOrNull(primary?.priceChange?.h1, warnings);
  const h24Change = numberOrNull(primary?.priceChange?.h24, warnings);
  const h24Volume = numberOrNull(primary?.volume?.h24, warnings, { nonNegative: true });
  const liquidityUsd = numberOrNull(
    primary?.liquidity?.usd,
    warnings,
    { nonNegative: true },
  );
  const h24Txns = transactionWindow(primary, "h24", warnings);
  const volumeLiquidityRatio = safeRatio(h24Volume, liquidityUsd, warnings);
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

  const customThreshold = numberOrNull(
    input?.anomaly_threshold,
    warnings,
    { nonNegative: true },
  );
  const requestedLookback = numberOrNull(input?.lookback_hours, warnings, { nonNegative: true });
  let customCheck = null;
  if (customThreshold !== null) {
    const window = selectedLookbackWindow(requestedLookback ?? 24);
    const value = numberOrNull(primary?.priceChange?.[window], warnings);
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

  const defaultExecutableChecks = [
    h1Change,
    h24Change,
    h24Txns.buyRatio,
    h24Txns.sellRatio,
    volumeLiquidityRatio,
  ].filter((value) => value !== null).length;
  const customExecutableChecks = customCheck?.triggered !== null && customCheck !== null ? 1 : 0;
  const totalChecks = 5 + (customThreshold !== null ? 1 : 0);
  const executableChecks = defaultExecutableChecks + customExecutableChecks;
  const coverageRatio = safeRatio(executableChecks, totalChecks, warnings);
  const completeCoverage = executableChecks === totalChecks;
  if (defaultExecutableChecks === 0) addWarning(warnings, "core_anomaly_inputs_unavailable");
  if (!completeCoverage) addWarning(warnings, "anomaly_check_coverage_incomplete");

  const confidence = executableChecks === 0
    ? "none"
    : coverageRatio < 0.5 ? "low" : coverageRatio < 1 ? "medium" : "high";
  const riskLevel = anomalies.length >= 4
    ? "critical"
    : anomalies.length >= 2
      ? "high"
      : anomalies.length === 1 ? "medium" : completeCoverage ? "low" : "unknown";
  const flags = anomalies.map((item) => item.code);
  if (anomalies.length === 0 && !completeCoverage) flags.push("insufficient_market_data");
  if (anomalies.length > 0 && !completeCoverage) flags.push("partial_check_coverage");
  return {
    ...envelope("market-anomaly-scan", input, market, context, warnings),
    risk_level: riskLevel,
    confidence,
    flags,
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
    coverage: {
      executable_checks: executableChecks,
      total_checks: totalChecks,
      ratio: coverageRatio,
      complete: completeCoverage,
    },
    anomalies,
  };
}
