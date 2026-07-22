import { randomUUID } from "node:crypto";
import { SERVICE_BY_ID } from "./catalog.js";
import { isSecurityChainSupported } from "./providers.js";
import {
  buildLiquidityRisk,
  buildMarketAnomaly,
  buildMarketSnapshot,
  buildNewPairRisk,
  buildTradingActivity,
} from "./market-analyses.js";

const VERSION = "0.3.0";
const SEVERITY = Object.freeze(["low", "medium", "high", "critical"]);
const WEIGHTS = Object.freeze({
  market: 0.35,
  liquidity: 0.20,
  activity_anomaly: 0.15,
  contract_tax: 0.20,
  holders: 0.10,
});

function addWarning(warnings, warning) {
  if (typeof warning === "string" && !warnings.includes(warning)) warnings.push(warning);
}

function round(value, digits = 12) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function finiteNumber(value, warnings, { min = -Infinity, max = Infinity } = {}) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    addWarning(warnings, "invalid_security_numeric");
    return null;
  }
  return value;
}

function sanitize(value, warnings) {
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    addWarning(warnings, "invalid_security_numeric");
    return null;
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, warnings));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item, warnings)]));
}

function analysisContext(options = {}) {
  const value = typeof options.now === "function" ? options.now() : Date.now();
  const now = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(now.getTime())) throw new RangeError("analysis clock must be a valid date");
  const requestId = typeof options.requestId === "function" ? options.requestId() : randomUUID();
  return { now, requestId };
}

function unknownState() {
  return { status: "unknown", value: null };
}

function booleanState(value) {
  return typeof value === "boolean" ? { status: "known", value } : unknownState();
}

function stringState(value) {
  return typeof value === "string" && value.length > 0
    ? { status: "known", value }
    : unknownState();
}

function numberState(value, warnings, options = {}) {
  const normalized = finiteNumber(value, warnings, options);
  return normalized === null ? unknownState() : { status: "known", value: normalized };
}

function taxState(value, warnings) {
  const normalized = finiteNumber(value, warnings, { min: 0 });
  if (normalized === null) return { status: "unknown", value: null, percent: null };
  const percent = round(normalized * 100, 6);
  if (percent === null) {
    addWarning(warnings, "invalid_security_numeric");
    return { status: "unknown", value: null, percent: null };
  }
  return { status: "known", value: normalized, percent };
}

function percentState(value, warnings) {
  return numberState(value, warnings, { min: 0, max: 1 });
}

function sourceEvidence(security) {
  if (!security || typeof security !== "object") return [];
  return [{
    source: typeof security.source === "string" ? security.source : "goplus",
    url: typeof security.sourceUrl === "string" ? security.sourceUrl : null,
    accessed_at: typeof security.accessedAt === "string" ? security.accessedAt : null,
    status: "ok",
  }];
}

function securityEnvelope(serviceId, input, security, context, warnings, qualityStates = []) {
  const service = SERVICE_BY_ID.get(serviceId);
  if (!service) throw new Error(`Unknown security service: ${serviceId}`);
  const sources = sourceEvidence(security);
  const unknownFields = qualityStates.filter((state) => state?.status !== "known").length;
  const status = security
    ? (unknownFields > 0 ? "partial" : "complete")
    : "unavailable";
  if (!security) addWarning(warnings, "security_provider_unavailable");

  return {
    ok: true,
    service: { id: service.id, version: VERSION },
    request_id: context.requestId,
    generated_at: context.now.toISOString(),
    input: sanitize(input, warnings),
    data_quality: {
      status,
      known_fields: qualityStates.length - unknownFields,
      unknown_fields: unknownFields,
      warnings: [...warnings],
    },
    sources,
  };
}

function pushFinding(findings, flags, code, severity, detail) {
  flags.push(code);
  findings.push({ code, severity, detail });
}

function highestSeverity(findings, unknownFields) {
  if (findings.length === 0) return unknownFields > 0 ? "unknown" : "low";
  return findings.reduce((highest, finding) => (
    SEVERITY.indexOf(finding.severity) > SEVERITY.indexOf(highest)
      ? finding.severity
      : highest
  ), "low");
}

export function buildContractTaxCheck(input, security, options = {}) {
  const context = analysisContext(options);
  const warnings = [];
  const contract = {
    isOpenSource: booleanState(security?.isOpenSource),
    isProxy: booleanState(security?.isProxy),
    isMintable: booleanState(security?.isMintable),
    transferPausable: booleanState(security?.transferPausable),
    isBlacklisted: booleanState(security?.isBlacklisted),
  };
  const ownership = {
    canTakeBackOwnership: booleanState(security?.canTakeBackOwnership),
    ownerChangeBalance: booleanState(security?.ownerChangeBalance),
    hiddenOwner: booleanState(security?.hiddenOwner),
    selfDestruct: booleanState(security?.selfDestruct),
    externalCall: booleanState(security?.externalCall),
    gasAbuse: booleanState(security?.gasAbuse),
  };
  const trading = {
    isHoneypot: booleanState(security?.isHoneypot),
    cannotBuy: booleanState(security?.cannotBuy),
    cannotSellAll: booleanState(security?.cannotSellAll),
    slippageModifiable: booleanState(security?.slippageModifiable),
    personalSlippageModifiable: booleanState(security?.personalSlippageModifiable),
    tradingCooldown: booleanState(security?.tradingCooldown),
  };
  const taxes = {
    buy: taxState(security?.buyTax, warnings),
    sell: taxState(security?.sellTax, warnings),
  };
  const flags = [];
  const findings = [];

  if (!security) flags.push("security_data_unavailable");
  if (contract.isOpenSource.value === false) {
    pushFinding(findings, flags, "closed_source", "high", "Contract source is not open.");
  }
  if (contract.isProxy.value === true) {
    pushFinding(findings, flags, "proxy_contract", "medium", "Contract uses proxy logic.");
  }
  if (contract.isMintable.value === true) {
    pushFinding(findings, flags, "mintable_supply", "medium", "Token supply can be increased.");
  }
  if (contract.transferPausable.value === true) {
    pushFinding(findings, flags, "transfers_pausable", "medium", "Token transfers can be paused.");
  }
  if (contract.isBlacklisted.value === true) {
    pushFinding(findings, flags, "blacklist_enabled", "high", "Contract can blacklist addresses.");
  }
  if (trading.slippageModifiable.value === true
    || trading.personalSlippageModifiable.value === true) {
    pushFinding(findings, flags, "tax_modifiable", "medium", "Trading tax or slippage can be changed.");
  }
  if (trading.isHoneypot.value === true) {
    pushFinding(findings, flags, "honeypot_detected", "critical", "Provider identifies honeypot behavior.");
  }
  if (trading.cannotBuy.value === true) {
    pushFinding(findings, flags, "cannot_buy", "critical", "Token cannot be bought normally.");
  }
  if (trading.cannotSellAll.value === true) {
    pushFinding(findings, flags, "cannot_sell_all", "critical", "A holder cannot sell the full balance.");
  }

  for (const [side, tax] of Object.entries(taxes)) {
    if (tax.status !== "known") continue;
    if (tax.value >= 0.10) {
      pushFinding(findings, flags, `high_${side}_tax`, "high", `${side} tax is at least 10%.`);
    } else if (tax.value >= 0.05) {
      pushFinding(findings, flags, `medium_${side}_tax`, "medium", `${side} tax is at least 5%.`);
    }
  }

  const qualityStates = [
    ...Object.values(contract),
    ...Object.values(ownership),
    ...Object.values(trading),
    taxes.buy,
    taxes.sell,
  ];
  const unknownFields = qualityStates.filter((state) => state.status !== "known").length;
  return {
    ...securityEnvelope("contract-tax-check", input, security, context, warnings, qualityStates),
    risk_level: highestSeverity(findings, unknownFields),
    flags,
    contract,
    ownership,
    trading,
    taxes,
    findings,
  };
}

function normalizeHolder(holder, warnings) {
  return {
    address: stringState(holder?.address),
    tag: stringState(holder?.tag),
    isContract: booleanState(holder?.isContract),
    balance: stringState(holder?.balance),
    percent: percentState(holder?.percent, warnings),
    isLocked: booleanState(holder?.isLocked),
  };
}

function holderListState(holders, warnings) {
  if (!Array.isArray(holders)) return unknownState();
  return { status: "known", value: holders.map((item) => normalizeHolder(item, warnings)) };
}

function sumTopPercent(holders, warnings, expectedCount = null) {
  if (!Array.isArray(holders)) return unknownState();
  if (holders.length === 0 && expectedCount > 0) {
    addWarning(warnings, "holder_list_inconsistent");
    return unknownState();
  }
  const values = holders.slice(0, 10).map((item) => finiteNumber(item?.percent, warnings, {
    min: 0,
    max: 1,
  }));
  if (values.some((value) => value === null)) return unknownState();
  const total = values.reduce((sum, value) => sum + value, 0);
  const normalized = round(total);
  if (normalized === null || normalized > 1) {
    addWarning(warnings, "invalid_holder_concentration");
    return unknownState();
  }
  return { status: "known", value: normalized };
}

function lockedPercent(lpHolders, warnings) {
  if (!Array.isArray(lpHolders)) return unknownState();
  let total = 0;
  for (const holder of lpHolders.slice(0, 10)) {
    const percent = finiteNumber(holder?.percent, warnings, { min: 0, max: 1 });
    if (percent === null || typeof holder?.isLocked !== "boolean") return unknownState();
    if (holder.isLocked) total += percent;
  }
  const normalized = round(total);
  if (normalized === null || normalized > 1) return unknownState();
  return { status: "known", value: normalized };
}

function concentrationLevel(percentStateValue) {
  if (percentStateValue.status !== "known") return "unknown";
  const value = percentStateValue.value;
  if (value >= 0.8) return "critical";
  if (value >= 0.6) return "high";
  if (value >= 0.4) return "medium";
  return "low";
}

export function buildHolderConcentration(input, security, options = {}) {
  const context = analysisContext(options);
  const warnings = [];
  const holders = holderListState(security?.holders, warnings);
  const holderCount = numberState(security?.holderCount, warnings, { min: 0 });
  const top10Percent = sumTopPercent(
    security?.holders,
    warnings,
    holderCount.status === "known" ? holderCount.value : null,
  );
  const level = concentrationLevel(top10Percent);
  const owner = {
    address: stringState(security?.ownerAddress),
    balance: stringState(security?.ownerBalance),
    percent: percentState(security?.ownerPercent, warnings),
  };
  const creator = {
    address: stringState(security?.creatorAddress),
    balance: stringState(security?.creatorBalance),
    percent: percentState(security?.creatorPercent, warnings),
  };
  const lpHolders = holderListState(security?.lpHolders, warnings);
  const lpHolderCount = numberState(security?.lpHolderCount, warnings, { min: 0 });
  const liquidityHolders = {
    count: lpHolderCount,
    holders: lpHolders,
    top10Percent: sumTopPercent(
      security?.lpHolders,
      warnings,
      lpHolderCount.status === "known" ? lpHolderCount.value : null,
    ),
    lockedPercent: lockedPercent(security?.lpHolders, warnings),
  };
  const flags = [];
  if (!security) flags.push("security_data_unavailable");
  if (level === "unknown") flags.push("holder_concentration_unknown");
  if (level !== "unknown" && level !== "low") flags.push(`top10_concentration_${level}`);
  if (owner.percent.status === "known" && owner.percent.value >= 0.1) flags.push("elevated_owner_share");
  if (creator.percent.status === "known" && creator.percent.value >= 0.1) {
    flags.push("elevated_creator_share");
  }

  const qualityStates = [
    holderCount,
    top10Percent,
    owner.percent,
    creator.percent,
    liquidityHolders.count,
    liquidityHolders.top10Percent,
    liquidityHolders.lockedPercent,
  ];
  return {
    ...securityEnvelope("holder-concentration-check", input, security, context, warnings, qualityStates),
    risk_level: level,
    flags,
    holderCount,
    holders,
    concentration: { top10Percent, level },
    owner,
    creator,
    liquidityHolders,
  };
}

function riskScore(level) {
  return ({ low: 0, medium: 40, high: 70, critical: 100 })[level] ?? null;
}

function activityRisk(activity) {
  const classification = activity?.activity?.classification;
  if (classification === "active") return "low";
  if (classification === "inactive" || classification === "one-sided") return "medium";
  return "unknown";
}

function maxRisk(...levels) {
  const known = levels.filter((level) => SEVERITY.includes(level));
  if (known.length === 0) return "unknown";
  return known.reduce((highest, level) => (
    SEVERITY.indexOf(level) > SEVERITY.indexOf(highest) ? level : highest
  ), "low");
}

function riskLevelFromScore(score) {
  if (score === null) return "unknown";
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 30) return "medium";
  return "low";
}

function dedupeSources(sources) {
  const unique = new Map();
  for (const source of sources.flat().filter(Boolean)) {
    const key = `${source.source ?? "unknown"}|${source.url ?? ""}`;
    if (!unique.has(key)) unique.set(key, source);
  }
  return [...unique.values()];
}

export function buildPretradeReport(input, market, security, options = {}) {
  const context = analysisContext(options);
  const securitySupported = isSecurityChainSupported(input?.chain);
  const reportSecurity = securitySupported ? security : null;
  const childOptions = {
    now: () => context.now,
    requestId: () => context.requestId,
  };
  const snapshot = buildMarketSnapshot(input, market, childOptions);
  const liquidity = buildLiquidityRisk(input, market, childOptions);
  const activity = buildTradingActivity(input, market, childOptions);
  const newPair = buildNewPairRisk(input, market, childOptions);
  const anomaly = buildMarketAnomaly(input, market, childOptions);
  const contractTax = buildContractTaxCheck(input, reportSecurity, childOptions);
  const holders = buildHolderConcentration(input, reportSecurity, childOptions);
  const sectionLevels = {
    market: newPair.risk_level,
    liquidity: liquidity.risk_level,
    activity_anomaly: maxRisk(activityRisk(activity), anomaly.risk_level),
    contract_tax: contractTax.risk_level,
    holders: holders.risk_level,
  };
  const scoreBreakdown = Object.fromEntries(Object.entries(WEIGHTS).map(([section, weight]) => {
    const score = riskScore(sectionLevels[section]);
    return [section, { weight, score, included: score !== null }];
  }));
  const included = Object.values(scoreBreakdown).filter((item) => item.included);
  const knownWeight = included.reduce((sum, item) => sum + item.weight, 0);
  const weightedRisk = included.reduce((sum, item) => sum + (item.score * item.weight), 0);
  const compositeScore = knownWeight > 0 ? round(weightedRisk / knownWeight, 2) : null;
  const coverage = reportSecurity
    ? "full"
    : securitySupported ? "partial" : "market-only";
  const flags = [];
  if (!securitySupported) flags.push("security_coverage_unavailable");
  if (securitySupported && !security) flags.push("security_data_unavailable");
  for (const [section, item] of Object.entries(scoreBreakdown)) {
    if (!item.included) flags.push(`section_unknown:${section}`);
  }
  const sources = dedupeSources([
    snapshot.sources,
    contractTax.sources,
    holders.sources,
  ]);
  const unknownSections = Object.entries(scoreBreakdown)
    .filter(([, item]) => !item.included)
    .map(([section]) => section);
  const service = SERVICE_BY_ID.get("pretrade-risk-report");

  return {
    ok: true,
    service: { id: service.id, version: VERSION },
    request_id: context.requestId,
    generated_at: context.now.toISOString(),
    input: sanitize(input, []),
    risk_score: compositeScore,
    risk_level: riskLevelFromScore(compositeScore),
    flags,
    coverage,
    weights: { ...WEIGHTS },
    score_breakdown: scoreBreakdown,
    sections: {
      market: { snapshot, new_pair: newPair },
      liquidity,
      activity_anomaly: { activity, anomaly },
      contract_tax: contractTax,
      holders,
    },
    data_quality: {
      status: coverage === "full" && unknownSections.length === 0 ? "complete" : "partial",
      coverage,
      known_weight: round(knownWeight),
      unknown_sections: unknownSections,
      warnings: flags.filter((flag) => flag.includes("unavailable") || flag.startsWith("section_unknown")),
    },
    sources,
  };
}
