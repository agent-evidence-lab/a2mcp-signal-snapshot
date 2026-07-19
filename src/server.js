import { randomUUID } from "node:crypto";
import express from "express";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";

const PORT = Number(process.env.PORT || 8787);
const SUITE_NAME = process.env.SUITE_NAME || "Codex Evidence Lab A2MCP Suite";
const SERVICE_VERSION = "0.2.2";
const PAYMENT_MODE = process.env.PAYMENT_MODE || "demo";
const X402_NETWORK = process.env.X402_NETWORK || "eip155:196";
const X402_PRICE = process.env.X402_PRICE || "$0.01";
const X402_PAY_TO = process.env.X402_PAY_TO || "0x0000000000000000000000000000000000000001";
const X402_ASSET = process.env.X402_ASSET || "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const X402_AMOUNT_MINIMAL = process.env.X402_AMOUNT_MINIMAL || "10000";
const X402_TOKEN_NAME = process.env.X402_TOKEN_NAME || "USD\u20ae0";
const X402_TOKEN_SYMBOL = process.env.X402_TOKEN_SYMBOL || "USDT0";
const X402_TOKEN_VERSION = process.env.X402_TOKEN_VERSION || "1";
const PLACEHOLDER_PAY_TO = "0x0000000000000000000000000000000000000001";

function normalizePublicBaseUrl(value) {
  const normalized = String(value || "").trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(normalized) ? normalized : "";
}

const PUBLIC_BASE_URL = normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL);

function publicUrl(path) {
  return PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}${path}` : undefined;
}

function paymentResource(path) {
  return publicUrl(path) || path;
}

function normalizeDecimals(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 6;
}

const X402_TOKEN_DECIMALS = normalizeDecimals(process.env.X402_TOKEN_DECIMALS || 6);
const X402_SUGGESTED_FEE_USDT = X402_PRICE.replace(/^\$/, "");

const SUPPORTED_CHAINS = new Set([
  "solana",
  "ethereum",
  "xlayer",
  "base",
  "bsc",
  "arbitrum",
  "polygon",
]);

const SIGNAL_MODES = new Set(["token", "wallet", "project", "risk"]);
const APE_MODES = new Set(["quick", "deep"]);

const tokenInputSchema = {
  type: "object",
  required: ["chain", "token_address"],
  properties: {
    chain: { type: "string", enum: Array.from(SUPPORTED_CHAINS) },
    token_address: { type: "string", description: "Token contract address or Solana mint address." },
    language: { type: "string", default: "zh-CN" },
  },
};

const apeInputSchema = {
  type: "object",
  required: ["chain", "token_address"],
  properties: {
    chain: { type: "string", enum: Array.from(SUPPORTED_CHAINS) },
    token_address: { type: "string", description: "Token contract address or Solana mint address." },
    mode: { type: "string", enum: Array.from(APE_MODES), default: "quick" },
    language: { type: "string", default: "zh-CN" },
  },
};

const signalInputSchema = {
  type: "object",
  required: ["chain", "address"],
  properties: {
    chain: { type: "string", enum: Array.from(SUPPORTED_CHAINS) },
    address: { type: "string", description: "Token, wallet, contract address, or project slug." },
    mode: { type: "string", enum: Array.from(SIGNAL_MODES), default: "token" },
    question: { type: "string", description: "Optional analysis focus." },
    lookbackHours: { type: "number", minimum: 1, maximum: 720, default: 24 },
    language: { type: "string", default: "zh-CN" },
  },
};

const SERVICE_CATALOG = {
  tokenRisk: {
    id: "token-risk-guard",
    name: "Token Risk Guard",
    path: "/api/token-risk-scan",
    endpoint: "token_risk_scan",
    description: "DexScreener-based token scan for liquidity, price, volume, pair age, and transaction activity. Holder concentration, contract permissions, and honeypot checks are reported as unavailable.",
    suggestedFeeUsdt: X402_SUGGESTED_FEE_USDT,
    inputSchema: tokenInputSchema,
    outputGuarantees: [
      "risk_score and risk_level",
      "flags, liquidity, market activity, and suggested_action",
      "holders and contract fields explicitly marked unavailable until dedicated providers are connected",
      "data_quality and source URLs",
    ],
  },
  apeGuard: {
    id: "apeguard",
    name: "ApeGuard",
    path: "/api/ape-pretrade-check",
    endpoint: "ape_pretrade_check",
    description: "DexScreener-based pre-trade meme or new-token check using liquidity, price, volume, pair age, and transaction activity.",
    suggestedFeeUsdt: X402_SUGGESTED_FEE_USDT,
    inputSchema: apeInputSchema,
    outputGuarantees: [
      "ape_score and risk_level",
      "one_line, red_flags, market_status, decision_hint",
      "data_quality and source URLs",
    ],
  },
  signalSnapshot: {
    id: "web3-signal-snapshot",
    name: "Web3 Signal Snapshot",
    path: "/api/signal-snapshot",
    endpoint: "signal_snapshot",
    description: "Lightweight DexScreener-backed signal snapshot. Token mode has market data; wallet and project modes disclose that chain-native data is not connected.",
    suggestedFeeUsdt: X402_SUGGESTED_FEE_USDT,
    inputSchema: signalInputSchema,
    outputGuarantees: [
      "Structured JSON response",
      "Request id and timestamp",
      "Observations, risk flags, suggested next steps, and sources",
    ],
  },
};

const MCP_SERVICE = {
  id: "mcp-tool-router",
  name: "A2MCP Tool Router",
  path: "/mcp",
  endpoint: "mcp_tools",
  description: "MCP-compatible JSON-RPC tool router for the A2MCP intelligence suite.",
};

function jsonResponse(res, status, body) {
  return res.status(status).json(body);
}

function notFound(res) {
  return jsonResponse(res, 404, {
    ok: false,
    error: {
      code: "not_found",
      message: `Unknown endpoint. Try GET /health, GET /metadata, GET /openapi.json, or POST ${Object.values(SERVICE_CATALOG).map((service) => service.path).join(", POST ")}.`,
    },
  });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeChain(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeTokenAddress(input) {
  return normalizeString(input.token_address || input.tokenAddress || input.address || input.subject);
}

function validateTokenInput(body, { allowMode = false } = {}) {
  const chain = normalizeChain(body.chain);
  const tokenAddress = normalizeTokenAddress(body);
  const language = normalizeString(body.language || "zh-CN");
  const mode = normalizeString(body.mode || "quick").toLowerCase();
  const errors = [];

  if (!SUPPORTED_CHAINS.has(chain)) {
    errors.push({
      field: "chain",
      message: `Unsupported chain. Use one of: ${Array.from(SUPPORTED_CHAINS).join(", ")}.`,
    });
  }

  if (!tokenAddress || tokenAddress.length < 3) {
    errors.push({
      field: "token_address",
      message: "Provide a token contract address or Solana mint address.",
    });
  }

  if (allowMode && !APE_MODES.has(mode)) {
    errors.push({
      field: "mode",
      message: `Unsupported mode. Use one of: ${Array.from(APE_MODES).join(", ")}.`,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    value: {
      chain,
      token_address: tokenAddress,
      mode,
      language,
    },
  };
}

function normalizeSignalInput(input) {
  const chain = normalizeChain(input.chain);
  const mode = normalizeString(input.mode || "token").toLowerCase();
  const subject = normalizeString(input.address || input.subject || input.token_address || input.tokenAddress);
  const question = normalizeString(input.question);
  const language = normalizeString(input.language || "zh-CN");
  const lookbackHours = Number.isFinite(Number(input.lookbackHours)) ? Number(input.lookbackHours) : 24;
  const errors = [];

  if (!SUPPORTED_CHAINS.has(chain)) {
    errors.push({
      field: "chain",
      message: `Unsupported chain. Use one of: ${Array.from(SUPPORTED_CHAINS).join(", ")}.`,
    });
  }

  if (!SIGNAL_MODES.has(mode)) {
    errors.push({
      field: "mode",
      message: `Unsupported mode. Use one of: ${Array.from(SIGNAL_MODES).join(", ")}.`,
    });
  }

  if (!subject || subject.length < 3) {
    errors.push({
      field: "address",
      message: "Provide a token address, wallet address, contract address, or project slug.",
    });
  }

  if (lookbackHours < 1 || lookbackHours > 720) {
    errors.push({
      field: "lookbackHours",
      message: "lookbackHours must be between 1 and 720.",
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    value: {
      chain,
      mode,
      subject,
      question,
      language,
      lookbackHours,
    },
  };
}

function dexScreenerChainIds(chain) {
  const aliases = {
    ethereum: ["ethereum", "ether"],
    bsc: ["bsc", "binance-smart-chain"],
    base: ["base"],
    polygon: ["polygon", "polygon-pos"],
    arbitrum: ["arbitrum", "arbitrum-one"],
    solana: ["solana"],
    xlayer: ["xlayer"],
  };
  return aliases[chain] || [chain];
}

async function fetchDexScreenerToken(chain, tokenAddress) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(tokenAddress)}`;

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": `${SUITE_NAME}/${SERVICE_VERSION}`,
      },
    });

    if (!response.ok) {
      return {
        ok: false,
        source: url,
        error: `DexScreener returned HTTP ${response.status}.`,
        pairs: [],
      };
    }

    const payload = await response.json();
    const allPairs = Array.isArray(payload.pairs) ? payload.pairs : [];
    const allowed = new Set(dexScreenerChainIds(chain));
    const chainPairs = allPairs.filter((pair) => allowed.has(String(pair.chainId || "").toLowerCase()));
    const pairs = chainPairs.length > 0 ? chainPairs : allPairs;

    return {
      ok: true,
      source: url,
      pairs,
      matchedRequestedChain: chainPairs.length > 0,
    };
  } catch (error) {
    return {
      ok: false,
      source: url,
      error: error.name === "AbortError" ? "DexScreener request timed out." : error.message,
      pairs: [],
    };
  } finally {
    clearTimeout(timer);
  }
}

function selectPrimaryPair(pairs) {
  return [...pairs].sort((left, right) => {
    return safeNumber(right.liquidity?.usd) - safeNumber(left.liquidity?.usd);
  })[0];
}

function pairAgeHours(pair) {
  const createdAt = safeNumber(pair?.pairCreatedAt);
  if (!createdAt) return null;
  return Math.max(0, (Date.now() - createdAt) / 36e5);
}

function classifyRisk(score) {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 35) return "medium";
  return "low";
}

function suggestedAction(level) {
  return {
    critical: "avoid_or_manual_review",
    high: "manual_review_required",
    medium: "proceed_only_with_caution",
    low: "standard_review_passed",
  }[level];
}

function addFlag(flags, code, severity, detail) {
  flags.push({ code, severity, detail });
}

function assessTokenRisk(input, market) {
  const pair = selectPrimaryPair(market.pairs);
  const flags = [];
  let score = 10;

  if (!market.ok) {
    score += 55;
    addFlag(flags, "data_source_error", "high", market.error || "Primary market data source failed.");
  }

  if (!pair) {
    score += 45;
    addFlag(flags, "market_pair_not_found", "high", "No DEX pair was found for this token in the current data source.");
  }

  const liquidityUsd = safeNumber(pair?.liquidity?.usd);
  if (pair) {
    if (liquidityUsd <= 0) {
      score += 35;
      addFlag(flags, "liquidity_unavailable", "high", "Liquidity is missing or zero in the selected DEX pair.");
    } else if (liquidityUsd < 10000) {
      score += 35;
      addFlag(flags, "liquidity_too_low", "high", "Pool liquidity is below 10k USD.");
    } else if (liquidityUsd < 50000) {
      score += 25;
      addFlag(flags, "liquidity_low", "medium", "Pool liquidity is below 50k USD.");
    } else if (liquidityUsd < 100000) {
      score += 15;
      addFlag(flags, "liquidity_thin", "medium", "Pool liquidity is below 100k USD.");
    }

    const ageHours = pairAgeHours(pair);
    if (ageHours !== null && ageHours < 24) {
      score += 20;
      addFlag(flags, "fresh_pair", "medium", "The selected pair appears to be less than 24 hours old.");
    } else if (ageHours !== null && ageHours < 168) {
      score += 10;
      addFlag(flags, "young_pair", "low", "The selected pair appears to be less than 7 days old.");
    }

    const change1h = safeNumber(pair.priceChange?.h1);
    const change24h = safeNumber(pair.priceChange?.h24);
    if (Math.abs(change1h) >= 50 || Math.abs(change24h) >= 150) {
      score += 15;
      addFlag(flags, "extreme_price_move", "medium", "Recent price movement is extreme and may imply high volatility.");
    }

    const volume24h = safeNumber(pair.volume?.h24);
    if (liquidityUsd > 0 && volume24h / liquidityUsd > 20) {
      score += 10;
      addFlag(flags, "volume_liquidity_churn_high", "medium", "24h volume is very high relative to pool liquidity.");
    }

    const buys1h = safeNumber(pair.txns?.h1?.buys);
    const sells1h = safeNumber(pair.txns?.h1?.sells);
    if (sells1h >= buys1h * 2 && sells1h >= 10) {
      score += 10;
      addFlag(flags, "sell_pressure_1h", "medium", "1h sell count is materially higher than buy count.");
    }
  }

  addFlag(flags, "holder_data_unavailable", "info", "Holder concentration is not available from this MVP data source.");
  addFlag(flags, "contract_permission_data_unavailable", "info", "Contract permissions and honeypot checks are not available from this MVP data source.");

  const riskScore = clamp(Math.round(score), 0, 100);
  const riskLevel = classifyRisk(riskScore);
  const dataQuality = pair ? (market.matchedRequestedChain ? "medium" : "low") : "low";

  return {
    riskScore,
    riskLevel,
    dataQuality,
    flags,
    pair,
    suggestedAction: suggestedAction(riskLevel),
  };
}

function liquidityPayload(pair) {
  return {
    available: Boolean(pair),
    dex: pair?.dexId || null,
    chain: pair?.chainId || null,
    pair_address: pair?.pairAddress || null,
    pair_url: pair?.url || null,
    pool_liquidity_usd: pair ? safeNumber(pair.liquidity?.usd, null) : null,
    base_token: pair?.baseToken ? {
      address: pair.baseToken.address,
      symbol: pair.baseToken.symbol,
      name: pair.baseToken.name,
    } : null,
    quote_token: pair?.quoteToken ? {
      address: pair.quoteToken.address,
      symbol: pair.quoteToken.symbol,
      name: pair.quoteToken.name,
    } : null,
    market_cap_usd: pair ? safeNumber(pair.marketCap, null) : null,
    fdv_usd: pair ? safeNumber(pair.fdv, null) : null,
    pair_age_hours: pair ? pairAgeHours(pair) : null,
  };
}

function marketStatus(pair) {
  return {
    available: Boolean(pair),
    price_usd: pair?.priceUsd || null,
    price_change_1h: pair ? safeNumber(pair.priceChange?.h1, null) : null,
    price_change_6h: pair ? safeNumber(pair.priceChange?.h6, null) : null,
    price_change_24h: pair ? safeNumber(pair.priceChange?.h24, null) : null,
    volume_1h_usd: pair ? safeNumber(pair.volume?.h1, null) : null,
    volume_6h_usd: pair ? safeNumber(pair.volume?.h6, null) : null,
    volume_24h_usd: pair ? safeNumber(pair.volume?.h24, null) : null,
    liquidity_usd: pair ? safeNumber(pair.liquidity?.usd, null) : null,
    txns_1h: pair ? {
      buys: safeNumber(pair.txns?.h1?.buys, null),
      sells: safeNumber(pair.txns?.h1?.sells, null),
    } : null,
  };
}

function summarizeTokenRisk(input, assessment) {
  const pair = assessment.pair;
  const symbol = pair?.baseToken?.symbol || input.token_address.slice(0, 8);
  if (!pair) {
    return `${symbol} 暂未在当前公开 DEX 数据源中找到可用交易对，风险评分偏高，建议人工复核。`;
  }

  return `${symbol} 当前风险等级为 ${assessment.riskLevel}，主要基于流动性、交易波动、交易对年龄和可用数据完整度评分；holder 与合约权限数据在本 MVP 中标记为未覆盖。`;
}

async function buildTokenRiskScan(input) {
  const generatedAt = new Date().toISOString();
  const market = await fetchDexScreenerToken(input.chain, input.token_address);
  const assessment = assessTokenRisk(input, market);

  return {
    ok: true,
    service: {
      name: SERVICE_CATALOG.tokenRisk.name,
      version: SERVICE_VERSION,
      serviceType: "A2MCP",
      paymentMode: PAYMENT_MODE,
    },
    requestId: randomUUID(),
    generatedAt,
    input,
    risk_score: assessment.riskScore,
    risk_level: assessment.riskLevel,
    summary: summarizeTokenRisk(input, assessment),
    flags: assessment.flags,
    liquidity: liquidityPayload(assessment.pair),
    market_status: marketStatus(assessment.pair),
    holders: {
      available: false,
      top_10_percent: null,
      holder_count: null,
      reason: "Holder concentration requires an explorer, indexer, or chain-specific data provider and is not inferred here.",
    },
    contract: {
      available: false,
      verified: null,
      mintable: null,
      blacklist_function: null,
      owner_can_change_tax: null,
      reason: "Contract permission checks require explorer or security API integration and are not inferred here.",
    },
    suggested_action: assessment.suggestedAction,
    data_quality: assessment.dataQuality,
    sources: [
      {
        name: "DexScreener Token Pairs",
        url: market.source,
        accessedAt: generatedAt,
        status: market.ok ? "ok" : "error",
      },
    ],
    disclaimer: "Informational risk scan only. It is not financial advice and does not execute trades.",
  };
}

function apeDecisionHint(riskLevel, apeScore) {
  if (riskLevel === "critical" || apeScore < 25) return "avoid_or_manual_review";
  if (riskLevel === "high" || apeScore < 45) return "manual_review_required";
  if (riskLevel === "medium" || apeScore < 70) return "small_size_or_wait_for_more_data";
  return "standard_review_passed";
}

function buildApeLine(riskLevel, apeScore, dataQuality) {
  if (dataQuality === "low") return "公开数据不足，别急着冲，先人工复核。";
  if (riskLevel === "critical") return "这个币当前看起来很危险，不适合直接开冲。";
  if (riskLevel === "high") return "风险偏高，建议先人工复核再考虑。";
  if (riskLevel === "medium") return "有一些风险点，小仓或继续观察更稳妥。";
  return `基础风险较低，Ape Score ${apeScore}，但仍需自己确认交易风险。`;
}

async function buildApeGuard(input) {
  const risk = await buildTokenRiskScan(input);
  const redFlags = risk.flags
    .filter((flag) => flag.severity !== "info")
    .map((flag) => flag.code);

  const apeScore = clamp(Math.round(100 - risk.risk_score), 0, 100);
  const decisionHint = apeDecisionHint(risk.risk_level, apeScore);

  return {
    ok: true,
    service: {
      name: SERVICE_CATALOG.apeGuard.name,
      version: SERVICE_VERSION,
      serviceType: "A2MCP",
      paymentMode: PAYMENT_MODE,
    },
    requestId: randomUUID(),
    generatedAt: new Date().toISOString(),
    input,
    ape_score: apeScore,
    risk_level: risk.risk_level,
    one_line: buildApeLine(risk.risk_level, apeScore, risk.data_quality),
    red_flags: redFlags,
    market_status: {
      ...risk.market_status,
      pair_age_hours: risk.liquidity.pair_age_hours,
      pair_url: risk.liquidity.pair_url,
      note: "First MVP exposes the most reliable fields from the shared token risk engine. More trade-flow fields can be added after an indexer is connected.",
    },
    decision_hint: decisionHint,
    token_risk_ref: {
      risk_score: risk.risk_score,
      suggested_action: risk.suggested_action,
      data_quality: risk.data_quality,
    },
    sources: risk.sources,
    disclaimer: "Risk check only. This is not a buy/sell recommendation and does not execute trades.",
  };
}

function buildSnapshot(input) {
  const generatedAt = new Date().toISOString();
  const shortSubject = input.subject.length > 18
    ? `${input.subject.slice(0, 8)}...${input.subject.slice(-6)}`
    : input.subject;

  const modeCopy = {
    token: "代币/合约",
    wallet: "钱包地址",
    project: "项目",
    risk: "风险对象",
  }[input.mode];

  return {
    ok: true,
    service: {
      name: SERVICE_CATALOG.signalSnapshot.name,
      version: SERVICE_VERSION,
      serviceType: "A2MCP",
      dataStatus: "demo",
      paymentMode: PAYMENT_MODE,
    },
    requestId: randomUUID(),
    generatedAt,
    input,
    summary: `${modeCopy} ${shortSubject} 的 ${input.lookbackHours} 小时信号快照已生成。当前 endpoint 用于通用研究任务包装；Token 风控请优先调用 /api/token-risk-scan，土狗交易前体检请调用 /api/ape-pretrade-check。`,
    observations: [
      {
        label: "对象识别",
        level: "info",
        detail: `已识别 chain=${input.chain}, mode=${input.mode}, subject=${input.subject}.`,
      },
      {
        label: "分析范围",
        level: "info",
        detail: input.question || "用户未指定具体问题，默认输出基础动态、风险线索和下一步观察项。",
      },
      {
        label: "数据接入状态",
        level: "warning",
        detail: "当前通用信号快照为轻量包装；更强的实时风控能力已拆分到 Token Risk Guard 和 ApeGuard。",
      },
    ],
    riskFlags: [
      {
        severity: "medium",
        title: "未接入完整实时数据",
        detail: "正式上架前需要按服务方向补充可验证数据源，避免返回过期或不可复核的信息。",
      },
      {
        severity: "low",
        title: "输入语义可能不足",
        detail: "建议调用方提供关注问题、时间范围和验收口径，以提升输出可用性。",
      },
    ],
    suggestedNextSteps: [
      "需要交易前风控时调用 /api/token-risk-scan。",
      "需要 meme/token 开冲前体检时调用 /api/ape-pretrade-check。",
      "接入更多只读链上、市场、社媒和事件数据源。",
      "切换到 okx-x402 模式并配置真实收款地址后再注册为付费 A2MCP 服务。",
    ],
    sources: [
      {
        name: "Local A2MCP Suite",
        url: publicUrl("/metadata") || `http://localhost:${PORT}/metadata`,
        accessedAt: generatedAt,
      },
    ],
    disclaimer: "This endpoint is informational only and is not financial advice.",
  };
}

function paymentAssetExtra() {
  return {
    name: X402_TOKEN_NAME,
    version: X402_TOKEN_VERSION,
    decimals: X402_TOKEN_DECIMALS,
    symbol: X402_TOKEN_SYMBOL,
  };
}

function paymentPrice() {
  return {
    asset: X402_ASSET,
    amount: X402_AMOUNT_MINIMAL,
    extra: paymentAssetExtra(),
  };
}

function pricing() {
  return {
    scheme: "exact",
    network: X402_NETWORK,
    price: X402_PRICE,
    amountMinimal: X402_AMOUNT_MINIMAL,
    asset: X402_ASSET,
    token: {
      name: X402_TOKEN_NAME,
      symbol: X402_TOKEN_SYMBOL,
      decimals: X402_TOKEN_DECIMALS,
      version: X402_TOKEN_VERSION,
    },
    payTo: X402_PAY_TO,
  };
}

function serviceMetadata(service) {
  return {
    id: service.id,
    name: service.name,
    endpoint: service.endpoint,
    endpointPath: service.path,
    ...(publicUrl(service.path) ? { endpointUrl: publicUrl(service.path) } : {}),
    description: service.description,
    pricingReady: PAYMENT_MODE !== "demo",
    paymentIntegration: PAYMENT_MODE,
    suggestedFeeUsdt: service.suggestedFeeUsdt,
    x402: pricing(),
    inputSchema: service.inputSchema,
    outputGuarantees: service.outputGuarantees,
  };
}

function metadata() {
  return {
    ok: true,
    suite: {
      name: SUITE_NAME,
      version: SERVICE_VERSION,
      serviceType: "A2MCP",
      paymentMode: PAYMENT_MODE,
      ...(PUBLIC_BASE_URL ? { publicBaseUrl: PUBLIC_BASE_URL } : {}),
      mcpEndpointPath: MCP_SERVICE.path,
      ...(publicUrl(MCP_SERVICE.path) ? { mcpEndpointUrl: publicUrl(MCP_SERVICE.path) } : {}),
      strategy: "One shared data/payment layer with multiple separately listable A2MCP endpoints.",
    },
    services: Object.values(SERVICE_CATALOG).map(serviceMetadata),
    defaultService: SERVICE_CATALOG.tokenRisk.id,
    inputSchema: SERVICE_CATALOG.tokenRisk.inputSchema,
  };
}

function openapi(baseUrl) {
  const paths = {
    "/health": {
      get: {
        summary: "Health check",
        responses: { "200": { description: "Service is healthy." } },
      },
    },
    "/metadata": {
      get: {
        summary: "Suite metadata and service schemas",
        responses: { "200": { description: "A2MCP suite metadata." } },
      },
    },
  };

  for (const service of Object.values(SERVICE_CATALOG)) {
    paths[service.path] = {
      post: {
        summary: service.description,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: service.inputSchema,
            },
          },
        },
        responses: {
          "200": { description: `Structured response from ${service.name}.` },
          "400": { description: "Invalid input." },
          "402": { description: "Payment required in x402 modes." },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: SUITE_NAME,
      version: SERVICE_VERSION,
      description: "A2MCP-style Web3 intelligence suite with token risk and pre-trade endpoints.",
    },
    servers: [{ url: baseUrl }],
    paths,
  };
}

function createMockFacilitator() {
  return {
    async getSupported() {
      return {
        kinds: [
          {
            x402Version: 2,
            scheme: "exact",
            network: X402_NETWORK,
            extra: paymentAssetExtra(),
          },
        ],
        extensions: [],
        signers: {
          eip155: [X402_PAY_TO],
        },
      };
    },
    async verify() {
      return {
        isValid: false,
        invalidReason: "mock_facilitator",
        invalidMessage: "mock-x402 mode does not settle real payments.",
      };
    },
    async settle() {
      return {
        success: false,
        status: "timeout",
        errorReason: "mock_facilitator",
        errorMessage: "mock-x402 mode does not settle real payments.",
        transaction: "",
        network: X402_NETWORK,
      };
    },
    async getSettleStatus() {
      return {
        success: false,
        status: "failed",
        errorReason: "mock_facilitator",
        errorMessage: "mock-x402 mode does not settle real payments.",
      };
    },
  };
}

function createFacilitator() {
  if (PAYMENT_MODE === "mock-x402") {
    return createMockFacilitator();
  }

  if (PAYMENT_MODE === "okx-x402") {
    const required = ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE"];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) {
      throw new Error(`PAYMENT_MODE=okx-x402 requires env vars: ${missing.join(", ")}`);
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(X402_PAY_TO) || X402_PAY_TO === PLACEHOLDER_PAY_TO) {
      throw new Error("PAYMENT_MODE=okx-x402 requires a real EVM receiving address in X402_PAY_TO.");
    }
    if (!/^[1-9][0-9]*$/.test(X402_AMOUNT_MINIMAL)) {
      throw new Error("PAYMENT_MODE=okx-x402 requires a positive integer X402_AMOUNT_MINIMAL.");
    }

    const facilitatorConfig = {
      apiKey: process.env.OKX_API_KEY,
      secretKey: process.env.OKX_SECRET_KEY,
      passphrase: process.env.OKX_PASSPHRASE,
      syncSettle: process.env.X402_SYNC_SETTLE === "1",
    };
    if (process.env.OKX_FACILITATOR_BASE_URL) {
      facilitatorConfig.baseUrl = process.env.OKX_FACILITATOR_BASE_URL;
    }

    return new OKXFacilitatorClient(facilitatorConfig);
  }

  throw new Error(`Unsupported PAYMENT_MODE: ${PAYMENT_MODE}`);
}

function unpaidResponse(service) {
  return () => ({
    contentType: "application/json",
    body: {
      ok: false,
      error: {
        code: "payment_required",
        message: "Payment is required. Decode the PAYMENT-REQUIRED header and retry with a valid x402 payment payload.",
      },
      service: {
        id: service.id,
        name: service.name,
        version: SERVICE_VERSION,
        serviceType: "A2MCP",
        paymentMode: PAYMENT_MODE,
      },
      pricing: pricing(),
    },
  });
}

function createPaymentGuard() {
  const resourceServer = new x402ResourceServer(createFacilitator()).register(
    X402_NETWORK,
    new ExactEvmScheme(),
  );

  const routes = {};
  for (const service of Object.values(SERVICE_CATALOG)) {
    routes[`POST ${service.path}`] = {
      accepts: {
        scheme: "exact",
        network: X402_NETWORK,
        payTo: X402_PAY_TO,
        price: paymentPrice(),
        maxTimeoutSeconds: 300,
      },
      resource: paymentResource(service.path),
      description: service.description,
      mimeType: "application/json",
      unpaidResponseBody: unpaidResponse(service),
    };
  }
  routes[`POST ${MCP_SERVICE.path}`] = {
    accepts: {
      scheme: "exact",
      network: X402_NETWORK,
      payTo: X402_PAY_TO,
      price: paymentPrice(),
      maxTimeoutSeconds: 300,
    },
    resource: paymentResource(MCP_SERVICE.path),
    description: MCP_SERVICE.description,
    mimeType: "application/json",
    unpaidResponseBody: unpaidResponse(MCP_SERVICE),
  };

  return paymentMiddleware(routes, resourceServer, {
    appName: SUITE_NAME,
    testnet: false,
  });
}

function invalidInput(res, details) {
  return jsonResponse(res, 400, {
    ok: false,
    error: {
      code: "invalid_input",
      message: "Input did not satisfy the service schema.",
      details,
    },
  });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function mcpTools() {
  return Object.values(SERVICE_CATALOG).map((service) => ({
    name: service.endpoint,
    title: service.name,
    description: service.description,
    inputSchema: service.inputSchema,
    outputSchema: {
      type: "object",
      description: `${service.name} structured JSON response.`,
    },
  }));
}

function findMcpService(name) {
  const normalized = normalizeString(name);
  return Object.values(SERVICE_CATALOG).find(
    (service) => service.endpoint === normalized || service.id === normalized || service.name === normalized,
  );
}

function mcpError(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data ? { data } : {}),
    },
  };
}

async function executeMcpTool(service, args) {
  if (service.id === SERVICE_CATALOG.tokenRisk.id) {
    const normalized = validateTokenInput(args || {});
    if (!normalized.ok) {
      const error = new Error("Invalid input for token_risk_scan.");
      error.data = normalized.errors;
      throw error;
    }
    return buildTokenRiskScan(normalized.value);
  }

  if (service.id === SERVICE_CATALOG.apeGuard.id) {
    const normalized = validateTokenInput(args || {}, { allowMode: true });
    if (!normalized.ok) {
      const error = new Error("Invalid input for ape_pretrade_check.");
      error.data = normalized.errors;
      throw error;
    }
    return buildApeGuard(normalized.value);
  }

  if (service.id === SERVICE_CATALOG.signalSnapshot.id) {
    const normalized = normalizeSignalInput(args || {});
    if (!normalized.ok) {
      const error = new Error("Invalid input for signal_snapshot.");
      error.data = normalized.errors;
      throw error;
    }
    return buildSnapshot(normalized.value);
  }

  throw new Error(`Unsupported MCP service: ${service.id}`);
}

async function handleMcpRequest(message) {
  const id = message?.id ?? null;
  const method = normalizeString(message?.method);

  if (!message || message.jsonrpc !== "2.0" || !method) {
    return mcpError(id, -32600, "Invalid JSON-RPC request.");
  }

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: SUITE_NAME,
          version: SERVICE_VERSION,
        },
      },
    };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: mcpTools(),
      },
    };
  }

  if (method === "tools/call") {
    const service = findMcpService(message.params?.name);
    if (!service) {
      return mcpError(id, -32602, "Unknown tool.", {
        availableTools: mcpTools().map((tool) => tool.name),
      });
    }

    try {
      const result = await executeMcpTool(service, message.params?.arguments || {});
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
          structuredContent: result,
        },
      };
    } catch (error) {
      return mcpError(id, -32602, error.message, error.data);
    }
  }

  return mcpError(id, -32601, "Method not found.");
}

const app = express();

app.use((req, res, next) => {
  res.setHeader("cache-control", "no-store");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,authorization,x-payment,payment,payment-signature");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
});

app.use(express.json({ limit: "128kb" }));

if (PAYMENT_MODE !== "demo") {
  app.use(createPaymentGuard());
}

app.get("/health", (req, res) => jsonResponse(res, 200, {
  ok: true,
  suite: SUITE_NAME,
  status: "healthy",
  time: new Date().toISOString(),
  paymentMode: PAYMENT_MODE,
  services: Object.values(SERVICE_CATALOG).map((service) => service.id),
}));

app.get("/metadata", (req, res) => jsonResponse(res, 200, metadata()));

app.get("/mcp", (req, res) => jsonResponse(res, 200, {
  ok: true,
  service: {
    id: MCP_SERVICE.id,
    name: MCP_SERVICE.name,
    version: SERVICE_VERSION,
    serviceType: "A2MCP",
    paymentMode: PAYMENT_MODE,
  },
  endpointPath: MCP_SERVICE.path,
  ...(publicUrl(MCP_SERVICE.path) ? { endpointUrl: publicUrl(MCP_SERVICE.path) } : {}),
  tools: mcpTools(),
  jsonRpcMethods: ["initialize", "tools/list", "tools/call"],
}));

app.get("/openapi.json", (req, res) => {
  const protocol = req.protocol;
  const host = req.get("host") || `localhost:${PORT}`;
  return jsonResponse(res, 200, openapi(`${protocol}://${host}`));
});

app.post("/mcp", asyncRoute(async (req, res) => {
  const messages = Array.isArray(req.body) ? req.body : [req.body];
  const responses = await Promise.all(messages.map(handleMcpRequest));
  return jsonResponse(res, 200, Array.isArray(req.body) ? responses : responses[0]);
}));

app.post(SERVICE_CATALOG.tokenRisk.path, asyncRoute(async (req, res) => {
  const normalized = validateTokenInput(req.body || {});
  if (!normalized.ok) return invalidInput(res, normalized.errors);
  return jsonResponse(res, 200, await buildTokenRiskScan(normalized.value));
}));

app.post(SERVICE_CATALOG.apeGuard.path, asyncRoute(async (req, res) => {
  const normalized = validateTokenInput(req.body || {}, { allowMode: true });
  if (!normalized.ok) return invalidInput(res, normalized.errors);
  return jsonResponse(res, 200, await buildApeGuard(normalized.value));
}));

app.post(SERVICE_CATALOG.signalSnapshot.path, (req, res) => {
  const normalized = normalizeSignalInput(req.body || {});
  if (!normalized.ok) return invalidInput(res, normalized.errors);
  return jsonResponse(res, 200, buildSnapshot(normalized.value));
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  jsonResponse(res, error.status || 500, {
    ok: false,
    error: {
      code: error.code || "internal_error",
      message: error.message || "Unexpected error.",
    },
  });
});

app.use((req, res) => notFound(res));

app.listen(PORT, () => {
  console.log(`${SUITE_NAME} listening on http://localhost:${PORT} (paymentMode=${PAYMENT_MODE})`);
});
