const MARKET_CHAINS = Object.freeze([
  "solana",
  "ethereum",
  "xlayer",
  "base",
  "bsc",
  "arbitrum",
  "polygon",
]);

const EVM_SECURITY_CHAINS = Object.freeze([
  "ethereum",
  "bsc",
  "polygon",
  "arbitrum",
  "base",
  "xlayer",
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function createInputSchema(properties = {}, chains = MARKET_CHAINS) {
  return deepFreeze({
    type: "object",
    required: ["chain", "token_address"],
    properties: {
      chain: { type: "string", enum: [...chains] },
      token_address: {
        type: "string",
        minLength: 3,
        description: "Token contract address or Solana mint address.",
      },
      language: { type: "string", default: "zh-CN" },
      ...properties,
    },
  });
}

const commonOutputGuarantees = [
  "stable service envelope with request_id and generated_at",
  "risk_level, flags, data_quality, and verifiable sources",
];

const definitions = [
  {
    id: "token-market-snapshot",
    name: "代币市场快照",
    path: "/api/token-market-snapshot",
    endpoint: "token_market_snapshot",
    fee: "0.01",
    description: "汇总代币价格、市值、FDV、主要交易池、流动性与多周期涨跌，返回结构化市场快照、数据完整度和来源。",
    userProvides: "网络和代币合约或铸币地址，可选输出语言。",
    inputSchema: createInputSchema(),
    outputGuarantees: [
      "price, market_cap, fdv, primary_pair, liquidity, and multi-period price changes",
      ...commonOutputGuarantees,
    ],
  },
  {
    id: "liquidity-risk-scan",
    name: "流动性风险扫描",
    path: "/api/liquidity-risk-scan",
    endpoint: "liquidity_risk_scan",
    fee: "0.01",
    description: "比较主要交易池流动性、池间分布、流动性与市值比例，返回流动性风险等级、异常标记和来源。",
    userProvides: "网络和代币合约或铸币地址，可选最低流动性阈值。",
    inputSchema: createInputSchema({
      min_liquidity_usd: { type: "number", minimum: 0 },
    }),
    outputGuarantees: [
      "total liquidity, pool distribution, liquidity-to-market-cap ratio, and threshold comparison",
      ...commonOutputGuarantees,
    ],
  },
  {
    id: "trading-activity-scan",
    name: "成交活跃度分析",
    path: "/api/trading-activity-scan",
    endpoint: "trading_activity_scan",
    fee: "0.01",
    description: "分析多周期成交量、买卖次数、买卖方向和活跃度变化，返回成交活跃度等级与异常信号。",
    userProvides: "网络和代币合约或铸币地址，可选观察周期。",
    inputSchema: createInputSchema({
      lookback_hours: { type: "number", minimum: 1, maximum: 720 },
    }),
    outputGuarantees: [
      "multi-period volume, buy and sell counts, direction balance, and activity classification",
      ...commonOutputGuarantees,
    ],
  },
  {
    id: "new-pair-risk-check",
    name: "新币启动风险检查",
    path: "/api/new-pair-risk-check",
    endpoint: "new_pair_risk_check",
    fee: "0.01",
    description: "结合交易对年龄、初始流动性、成交与价格变化，识别新币启动阶段的流动性和量价风险。",
    userProvides: "网络和代币合约或铸币地址，可选风险偏好。",
    inputSchema: createInputSchema({
      risk_profile: {
        type: "string",
        enum: ["conservative", "balanced", "aggressive"],
        default: "balanced",
      },
    }),
    outputGuarantees: [
      "pair age, launch liquidity, price and volume movement, and launch-stage risk evidence",
      ...commonOutputGuarantees,
    ],
  },
  {
    id: "market-anomaly-scan",
    name: "价格成交异常扫描",
    path: "/api/market-anomaly-scan",
    endpoint: "market_anomaly_scan",
    fee: "0.01",
    description: "检测多周期价格、成交量和买卖次数变化，标记急涨急跌、量价背离和交易活动异常。",
    userProvides: "网络和代币合约或铸币地址，可选观察周期与异常阈值。",
    inputSchema: createInputSchema({
      lookback_hours: { type: "number", minimum: 1, maximum: 720 },
      anomaly_threshold: { type: "number", minimum: 0 },
    }),
    outputGuarantees: [
      "multi-period anomaly checks for price, volume, buy and sell counts, and price-volume divergence",
      ...commonOutputGuarantees,
    ],
  },
  {
    id: "contract-tax-check",
    name: "合约权限与交易税检查",
    path: "/api/contract-tax-check",
    endpoint: "contract_tax_check",
    fee: "0.02",
    description: "检查合约开源、代理、增发、暂停、黑名单、蜜罐及买卖税等安全项，返回字段状态和风险分级。",
    userProvides: "受支持的 EVM 网络和代币合约地址。",
    inputSchema: createInputSchema({}, EVM_SECURITY_CHAINS),
    outputGuarantees: [
      "explicit open-source, proxy, mint, pause, blacklist, honeypot, buy-tax, and sell-tax states",
      "unavailable provider fields remain unknown rather than inferred",
      ...commonOutputGuarantees,
    ],
    securityCoverage: "EVM-only",
    supportedSecurityChains: EVM_SECURITY_CHAINS,
  },
  {
    id: "holder-concentration-check",
    name: "持仓集中度检查",
    path: "/api/holder-concentration-check",
    endpoint: "holder_concentration_check",
    fee: "0.02",
    description: "分析持有人数量、前十大持仓比例、创建者与所有者持仓及流动性持有情况，返回集中度风险。",
    userProvides: "受支持的 EVM 网络和代币合约地址。",
    inputSchema: createInputSchema({}, EVM_SECURITY_CHAINS),
    outputGuarantees: [
      "holder count, top-ten concentration, creator and owner shares, and liquidity-holder evidence",
      "unavailable provider fields remain unknown rather than inferred",
      ...commonOutputGuarantees,
    ],
    securityCoverage: "EVM-only",
    supportedSecurityChains: EVM_SECURITY_CHAINS,
  },
  {
    id: "pretrade-risk-report",
    name: "综合交易前风险报告",
    path: "/api/pretrade-risk-report",
    endpoint: "pretrade_risk_report",
    fee: "0.03",
    description: "整合市场、流动性、成交、新币阶段、量价异常、合约权限、交易税与持仓风险，返回综合评分和分项证据。",
    userProvides: "网络和代币地址；EVM 返回完整安全项，其他网络按可用数据返回并标记覆盖范围。",
    inputSchema: createInputSchema(),
    outputGuarantees: [
      "composite risk score with market, liquidity, activity, anomaly, contract-tax, and holder evidence",
      "full EVM security coverage or an explicit market-only coverage marker on other networks",
      ...commonOutputGuarantees,
    ],
    securityCoverage: "EVM-only; market coverage is multi-chain",
    supportedSecurityChains: EVM_SECURITY_CHAINS,
  },
];

export const API_SERVICES = Object.freeze(definitions.map((definition) => deepFreeze({
  ...definition,
  marketplaceDescription: `核心能力：${definition.description}\n用户需提供：${definition.userProvides}`,
})));

export const LEGACY_PATHS = deepFreeze({
  "/api/token-risk-scan": "pretrade-risk-report",
  "/api/ape-pretrade-check": "new-pair-risk-check",
  "/api/signal-snapshot": "token-market-snapshot",
});

export const SERVICE_BY_ID = new Map(API_SERVICES.map((service) => [service.id, service]));

export const SERVICE_BY_PATH = new Map(API_SERVICES.map((service) => [service.path, service]));
for (const [path, id] of Object.entries(LEGACY_PATHS)) {
  SERVICE_BY_PATH.set(path, SERVICE_BY_ID.get(id));
}

export function feeToMinimal(fee, decimals) {
  if (typeof fee !== "string" || !/^\d+(?:\.\d+)?$/.test(fee)) {
    throw new TypeError("fee must be a non-negative decimal string");
  }
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError("decimals must be an integer between 0 and 255");
  }

  const [whole, fraction = ""] = fee.split(".");
  if (fraction.length > decimals) {
    throw new RangeError(`fee has more than ${decimals} decimal places`);
  }

  const scale = 10n ** BigInt(decimals);
  const fractionalMinimal = fraction.length > 0
    ? BigInt(fraction.padEnd(decimals, "0"))
    : 0n;
  return (BigInt(whole) * scale + fractionalMinimal).toString();
}
