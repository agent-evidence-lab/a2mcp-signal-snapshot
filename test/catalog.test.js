import test from "node:test";
import assert from "node:assert/strict";
import {
  API_SERVICES,
  LEGACY_PATHS,
  SERVICE_BY_ID,
  SERVICE_BY_PATH,
  feeToMinimal,
} from "../src/intelligence/catalog.js";

const expectedServices = [
  ["token-market-snapshot", "代币市场快照", "/api/token-market-snapshot", "token_market_snapshot", "0.01"],
  ["liquidity-risk-scan", "流动性风险扫描", "/api/liquidity-risk-scan", "liquidity_risk_scan", "0.01"],
  ["trading-activity-scan", "成交活跃度分析", "/api/trading-activity-scan", "trading_activity_scan", "0.01"],
  ["new-pair-risk-check", "新币启动风险检查", "/api/new-pair-risk-check", "new_pair_risk_check", "0.01"],
  ["market-anomaly-scan", "价格成交异常扫描", "/api/market-anomaly-scan", "market_anomaly_scan", "0.01"],
  ["contract-tax-check", "合约权限与交易税检查", "/api/contract-tax-check", "contract_tax_check", "0.02"],
  ["holder-concentration-check", "持仓集中度检查", "/api/holder-concentration-check", "holder_concentration_check", "0.02"],
  ["pretrade-risk-report", "综合交易前风险报告", "/api/pretrade-risk-report", "pretrade_risk_report", "0.03"],
];

const expectedDescriptions = [
  [
    "汇总代币价格、市值、FDV、主要交易池、流动性与多周期涨跌，返回结构化市场快照、数据完整度和来源。",
    "网络和代币合约或铸币地址，可选输出语言。",
  ],
  [
    "比较主要交易池流动性、池间分布、流动性与市值比例，返回流动性风险等级、异常标记和来源。",
    "网络和代币合约或铸币地址，可选最低流动性阈值。",
  ],
  [
    "分析多周期成交量、买卖次数、买卖方向和活跃度变化，返回成交活跃度等级与异常信号。",
    "网络和代币合约或铸币地址，可选观察周期。",
  ],
  [
    "结合交易对年龄、初始流动性、成交与价格变化，识别新币启动阶段的流动性和量价风险。",
    "网络和代币合约或铸币地址，可选风险偏好。",
  ],
  [
    "检测多周期价格、成交量和买卖次数变化，标记急涨急跌、量价背离和交易活动异常。",
    "网络和代币合约或铸币地址，可选观察周期与异常阈值。",
  ],
  [
    "检查合约开源、代理、增发、暂停、黑名单、蜜罐及买卖税等安全项，返回字段状态和风险分级。",
    "受支持的 EVM 网络和代币合约地址。",
  ],
  [
    "分析持有人数量、前十大持仓比例、创建者与所有者持仓及流动性持有情况，返回集中度风险。",
    "受支持的 EVM 网络和代币合约地址。",
  ],
  [
    "整合市场、流动性、成交、新币阶段、量价异常、合约权限、交易税与持仓风险，返回综合评分和分项证据。",
    "网络和代币地址；EVM 返回完整安全项，其他网络按可用数据返回并标记覆盖范围。",
  ],
];

test("catalog exposes exactly eight unique canonical services in approved order", () => {
  assert.equal(API_SERVICES.length, 8);
  assert.deepEqual(
    API_SERVICES.map(({ id, name, path, endpoint, fee }) => [id, name, path, endpoint, fee]),
    expectedServices,
  );

  for (const key of ["id", "name", "path", "endpoint"]) {
    assert.equal(new Set(API_SERVICES.map((service) => service[key])).size, 8, `${key} must be unique`);
  }
});

test("catalog preserves the approved two-part Chinese marketplace descriptions", () => {
  assert.deepEqual(
    API_SERVICES.map(({ description, userProvides }) => [description, userProvides]),
    expectedDescriptions,
  );
});

test("every service declares the base input schema and output guarantees", () => {
  for (const service of API_SERVICES) {
    assert.equal(service.inputSchema.type, "object");
    assert.deepEqual(service.inputSchema.required, ["chain", "token_address"]);
    assert.equal(service.inputSchema.properties.chain.type, "string");
    assert.equal(service.inputSchema.properties.token_address.type, "string");
    assert.equal(service.inputSchema.properties.token_address.minLength, 3);
    assert.equal(service.inputSchema.properties.language.type, "string");
    assert.equal(service.inputSchema.properties.language.default, "zh-CN");
    assert.ok(!service.inputSchema.required.includes("language"));
    assert.ok(Array.isArray(service.outputGuarantees));
    assert.ok(service.outputGuarantees.length > 0);
    assert.ok(service.outputGuarantees.some((guarantee) => guarantee.includes("data_quality")));
    assert.ok(service.outputGuarantees.some((guarantee) => guarantee.includes("sources")));
  }
});

test("service-specific optional inputs are represented in their schemas", () => {
  assert.equal(SERVICE_BY_ID.get("liquidity-risk-scan").inputSchema.properties.min_liquidity_usd.type, "number");
  assert.equal(SERVICE_BY_ID.get("trading-activity-scan").inputSchema.properties.lookback_hours.type, "number");
  assert.equal(SERVICE_BY_ID.get("new-pair-risk-check").inputSchema.properties.risk_profile.type, "string");

  const anomalyProperties = SERVICE_BY_ID.get("market-anomaly-scan").inputSchema.properties;
  assert.equal(anomalyProperties.lookback_hours.type, "number");
  assert.equal(anomalyProperties.anomaly_threshold.type, "number");
});

test("security and holder services disclose EVM-only coverage", () => {
  for (const id of ["contract-tax-check", "holder-concentration-check"]) {
    const service = SERVICE_BY_ID.get(id);
    assert.equal(service.securityCoverage, "EVM-only");
    assert.ok(service.supportedSecurityChains.length > 0);
    assert.deepEqual(service.inputSchema.properties.chain.enum, service.supportedSecurityChains);
    assert.ok(!service.supportedSecurityChains.includes("solana"));
  }

  const pretrade = SERVICE_BY_ID.get("pretrade-risk-report");
  assert.equal(pretrade.securityCoverage, "EVM-only; market coverage is multi-chain");
  assert.ok(pretrade.supportedSecurityChains.length > 0);
});

test("canonical and legacy paths resolve to canonical service objects", () => {
  assert.deepEqual(LEGACY_PATHS, {
    "/api/token-risk-scan": "pretrade-risk-report",
    "/api/ape-pretrade-check": "new-pair-risk-check",
    "/api/signal-snapshot": "token-market-snapshot",
  });

  for (const service of API_SERVICES) {
    assert.equal(SERVICE_BY_ID.get(service.id), service);
    assert.equal(SERVICE_BY_PATH.get(service.path), service);
  }

  for (const [path, id] of Object.entries(LEGACY_PATHS)) {
    assert.equal(SERVICE_BY_PATH.get(path), SERVICE_BY_ID.get(id));
  }
});

test("decimal service fees convert to exact token amounts", () => {
  assert.equal(feeToMinimal("0.01", 6), "10000");
  assert.equal(feeToMinimal("0.02", 6), "20000");
  assert.equal(feeToMinimal("0.03", 6), "30000");
  assert.equal(feeToMinimal("12", 0), "12");
  assert.equal(feeToMinimal("12.340", 3), "12340");
});

test("fee conversion rejects invalid, negative, and over-precision inputs", () => {
  for (const fee of ["", ".01", "1.", "1.2.3", "not-a-fee", "-0.01", "+0.01", " 0.01 ", 0.01, null]) {
    assert.throws(() => feeToMinimal(fee, 6), { name: "TypeError" });
  }

  assert.throws(() => feeToMinimal("0.0000001", 6), { name: "RangeError" });
  assert.throws(() => feeToMinimal("1.20", 1), { name: "RangeError" });

  for (const decimals of [-1, 1.5, "6", Number.NaN]) {
    assert.throws(() => feeToMinimal("0.01", decimals), { name: "RangeError" });
  }
});
