import express from "express";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";

import {
  API_SERVICES,
  LEGACY_PATHS,
  SERVICE_BY_ID,
  SERVICE_BY_PATH,
  feeToMinimal,
} from "./intelligence/catalog.js";
import {
  buildLiquidityRisk,
  buildMarketAnomaly,
  buildMarketSnapshot,
  buildNewPairRisk,
  buildTradingActivity,
} from "./intelligence/market-analyses.js";
import { createProviders, isSecurityChainSupported } from "./intelligence/providers.js";
import {
  buildContractTaxCheck,
  buildHolderConcentration,
  buildPretradeReport,
} from "./intelligence/security-analyses.js";

const PORT = Number(process.env.PORT || 8787);
const SUITE_NAME = process.env.SUITE_NAME || "Codex Evidence Lab A2MCP Suite";
const SERVICE_VERSION = "0.3.0";
const PAYMENT_MODE = process.env.PAYMENT_MODE || "demo";
const MCP_FEE_USDT = process.env.MCP_FEE_USDT || "0.03";
const X402_NETWORK = process.env.X402_NETWORK || "eip155:196";
const X402_PAY_TO = process.env.X402_PAY_TO || "0x0000000000000000000000000000000000000001";
const X402_ASSET = process.env.X402_ASSET || "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const X402_TOKEN_NAME = process.env.X402_TOKEN_NAME || "USD₮0";
const X402_TOKEN_SYMBOL = process.env.X402_TOKEN_SYMBOL || "USDT0";
const X402_TOKEN_VERSION = process.env.X402_TOKEN_VERSION || "1";
const X402_TOKEN_DECIMALS = normalizeDecimals(process.env.X402_TOKEN_DECIMALS || 6);
const PLACEHOLDER_PAY_TO = "0x0000000000000000000000000000000000000001";
const PUBLIC_BASE_URL = normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL);
const PROVIDER_BUDGET_MS = environmentDuration(process.env.PROVIDER_BUDGET_MS, 4_500);
const providers = createProviders({
  timeoutMs: environmentDuration(process.env.PROVIDER_TIMEOUT_MS, 4_000),
});

const MCP_SERVICE = Object.freeze({
  id: "mcp-tool-router",
  name: "A2MCP Tool Router",
  path: "/mcp",
  fee: MCP_FEE_USDT,
  description: "MCP-compatible JSON-RPC tool router for the Codex Evidence Lab intelligence suite.",
});

const MARKET_BUILDERS = Object.freeze({
  "token-market-snapshot": buildMarketSnapshot,
  "liquidity-risk-scan": buildLiquidityRisk,
  "trading-activity-scan": buildTradingActivity,
  "new-pair-risk-check": buildNewPairRisk,
  "market-anomaly-scan": buildMarketAnomaly,
});

function environmentDuration(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeDecimals(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 6;
}

function normalizePublicBaseUrl(value) {
  const normalized = String(value || "").trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(normalized) ? normalized : "";
}

function publicUrl(path) {
  return PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}${path}` : undefined;
}

function paymentResource(path) {
  return publicUrl(path) || path;
}

function jsonResponse(res, status, body) {
  return res.status(status).json(body);
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeServiceInput(body, service) {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const chain = normalizeString(source.chain).toLowerCase();
  const tokenAddress = normalizeString(
    source.token_address || source.tokenAddress || source.address || source.subject,
  );
  const language = normalizeString(source.language || "zh-CN");
  const errors = [];
  const allowedChains = service.inputSchema.properties.chain.enum;

  if (!allowedChains.includes(chain)) {
    errors.push({ field: "chain", message: `Unsupported chain. Use one of: ${allowedChains.join(", ")}.` });
  }
  if (tokenAddress.length < 3) {
    errors.push({ field: "token_address", message: "Provide a token contract address or Solana mint address." });
  }

  const value = { chain, token_address: tokenAddress, language };
  const optionalNumbers = ["min_liquidity_usd", "lookback_hours", "anomaly_threshold"];
  for (const field of optionalNumbers) {
    if (source[field] === undefined) continue;
    const parsed = Number(source[field]);
    const schema = service.inputSchema.properties[field];
    if (!Number.isFinite(parsed)
      || (schema?.minimum !== undefined && parsed < schema.minimum)
      || (schema?.maximum !== undefined && parsed > schema.maximum)) {
      errors.push({ field, message: `${field} is outside the supported numeric range.` });
    } else {
      value[field] = parsed;
    }
  }

  if (source.risk_profile !== undefined) {
    const riskProfile = normalizeString(source.risk_profile).toLowerCase();
    const allowedProfiles = service.inputSchema.properties.risk_profile?.enum || [];
    if (!allowedProfiles.includes(riskProfile)) {
      errors.push({ field: "risk_profile", message: `Use one of: ${allowedProfiles.join(", ")}.` });
    } else {
      value.risk_profile = riskProfile;
    }
  }

  return { ok: errors.length === 0, errors, value };
}

function providerFailure(error) {
  return {
    code: error?.code || "UPSTREAM_FAILURE",
    message: error?.message || "Upstream provider failed.",
  };
}

async function withDeadline(promise, timeoutMs) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Upstream request budget expired.");
      error.code = "UPSTREAM_TIMEOUT";
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function unavailableMarket(input, error) {
  const failure = providerFailure(error);
  return {
    chain: input.chain,
    tokenAddress: input.token_address,
    pairs: [],
    primaryPair: null,
    sources: [{
      source: "market-providers",
      name: "Market data providers",
      url: null,
      accessedAt: new Date().toISOString(),
      status: "error",
      errorCode: failure.code,
    }],
    data_quality: {
      status: "unavailable",
      warnings: [`market_provider_error:${failure.code}`],
    },
  };
}

async function safeMarket(input) {
  try {
    return await withDeadline(
      providers.market(input.chain, input.token_address),
      PROVIDER_BUDGET_MS,
    );
  } catch (error) {
    if (error?.code === "INVALID_INPUT") throw error;
    return unavailableMarket(input, error);
  }
}

async function safeSecurity(input) {
  if (!isSecurityChainSupported(input.chain)) return { value: null, error: null };
  try {
    return {
      value: await withDeadline(
        providers.security(input.chain, input.token_address),
        PROVIDER_BUDGET_MS,
      ),
      error: null,
    };
  } catch (error) {
    if (error?.code === "INVALID_INPUT") throw error;
    return { value: null, error: providerFailure(error) };
  }
}

function addSecurityProviderWarning(payload, error) {
  if (!error) return payload;
  const warning = `security_provider_error:${error.code}`;
  const warnings = Array.isArray(payload.data_quality?.warnings)
    ? payload.data_quality.warnings
    : [];
  return {
    ...payload,
    data_quality: {
      ...payload.data_quality,
      warnings: [...new Set([...warnings, warning])],
    },
  };
}

async function executeService(service, input) {
  const marketBuilder = MARKET_BUILDERS[service.id];
  if (marketBuilder) return marketBuilder(input, await safeMarket(input));

  if (service.id === "contract-tax-check") {
    const security = await safeSecurity(input);
    return addSecurityProviderWarning(buildContractTaxCheck(input, security.value), security.error);
  }
  if (service.id === "holder-concentration-check") {
    const security = await safeSecurity(input);
    return addSecurityProviderWarning(buildHolderConcentration(input, security.value), security.error);
  }
  if (service.id === "pretrade-risk-report") {
    const [market, security] = await Promise.all([safeMarket(input), safeSecurity(input)]);
    return addSecurityProviderWarning(
      buildPretradeReport(input, market, security.value),
      security.error,
    );
  }

  const error = new Error(`Unsupported service: ${service.id}`);
  error.code = "SERVICE_NOT_FOUND";
  throw error;
}

function paymentAssetExtra() {
  return {
    name: X402_TOKEN_NAME,
    version: X402_TOKEN_VERSION,
    decimals: X402_TOKEN_DECIMALS,
    symbol: X402_TOKEN_SYMBOL,
  };
}

function paymentPrice(fee) {
  return {
    asset: X402_ASSET,
    amount: feeToMinimal(fee, X402_TOKEN_DECIMALS),
    extra: paymentAssetExtra(),
  };
}

function pricing(fee) {
  return {
    scheme: "exact",
    network: X402_NETWORK,
    price: `$${fee}`,
    amountMinimal: feeToMinimal(fee, X402_TOKEN_DECIMALS),
    asset: X402_ASSET,
    token: paymentAssetExtra(),
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
    marketplaceDescription: service.marketplaceDescription,
    pricingReady: PAYMENT_MODE !== "demo",
    paymentIntegration: PAYMENT_MODE,
    suggestedFeeUsdt: service.fee,
    x402: pricing(service.fee),
    inputSchema: service.inputSchema,
    outputGuarantees: service.outputGuarantees,
    ...(service.securityCoverage ? { securityCoverage: service.securityCoverage } : {}),
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
      mcpFeeUsdt: MCP_SERVICE.fee,
      strategy: "Eight separately listable intelligence services on one shared data and x402 layer.",
    },
    services: API_SERVICES.map(serviceMetadata),
    legacyPaths: LEGACY_PATHS,
    defaultService: "pretrade-risk-report",
  };
}

function openapi(baseUrl) {
  const paths = {
    "/health": {
      get: { summary: "Health check", responses: { "200": { description: "Service is healthy." } } },
    },
    "/metadata": {
      get: { summary: "Suite metadata", responses: { "200": { description: "Suite metadata." } } },
    },
    "/mcp": {
      get: { summary: "MCP tool discovery", responses: { "200": { description: "MCP tools." } } },
      post: {
        summary: "MCP JSON-RPC endpoint",
        responses: { "200": { description: "MCP response." }, "402": { description: "Payment required." } },
      },
    },
  };

  for (const service of API_SERVICES) {
    paths[service.path] = {
      post: {
        summary: service.name,
        description: service.description,
        requestBody: {
          required: true,
          content: { "application/json": { schema: service.inputSchema } },
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
      description: "Eight-service Web3 market, contract, holder, and pre-trade intelligence suite.",
    },
    servers: [{ url: baseUrl }],
    paths,
  };
}

function createMockFacilitator() {
  return {
    async getSupported() {
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: X402_NETWORK, extra: paymentAssetExtra() }],
        extensions: [],
        signers: { eip155: [X402_PAY_TO] },
      };
    },
    async verify() {
      return { isValid: false, invalidReason: "mock_facilitator", invalidMessage: "Mock mode does not settle." };
    },
    async settle() {
      return {
        success: false,
        status: "timeout",
        errorReason: "mock_facilitator",
        errorMessage: "Mock mode does not settle.",
        transaction: "",
        network: X402_NETWORK,
      };
    },
    async getSettleStatus() {
      return {
        success: false,
        status: "failed",
        errorReason: "mock_facilitator",
        errorMessage: "Mock mode does not settle.",
      };
    },
  };
}

function createFacilitator() {
  if (PAYMENT_MODE === "mock-x402") return createMockFacilitator();
  if (PAYMENT_MODE !== "okx-x402") throw new Error(`Unsupported PAYMENT_MODE: ${PAYMENT_MODE}`);

  const required = ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) throw new Error(`PAYMENT_MODE=okx-x402 requires env vars: ${missing.join(", ")}`);
  if (!/^0x[a-fA-F0-9]{40}$/.test(X402_PAY_TO) || X402_PAY_TO === PLACEHOLDER_PAY_TO) {
    throw new Error("PAYMENT_MODE=okx-x402 requires a real EVM receiving address in X402_PAY_TO.");
  }

  const config = {
    apiKey: process.env.OKX_API_KEY,
    secretKey: process.env.OKX_SECRET_KEY,
    passphrase: process.env.OKX_PASSPHRASE,
    syncSettle: process.env.X402_SYNC_SETTLE === "1",
  };
  if (process.env.OKX_FACILITATOR_BASE_URL) config.baseUrl = process.env.OKX_FACILITATOR_BASE_URL;
  return new OKXFacilitatorClient(config);
}

function unpaidResponse(service) {
  return () => ({
    contentType: "application/json",
    body: {
      ok: false,
      error: { code: "payment_required", message: "Payment is required before this service can run." },
      service: { id: service.id, name: service.name, version: SERVICE_VERSION },
      pricing: pricing(service.fee),
    },
  });
}

function paymentRoute(service, path = service.path) {
  return {
    accepts: {
      scheme: "exact",
      network: X402_NETWORK,
      payTo: X402_PAY_TO,
      price: paymentPrice(service.fee),
      maxTimeoutSeconds: 300,
    },
    resource: paymentResource(path),
    description: service.description,
    mimeType: "application/json",
    unpaidResponseBody: unpaidResponse(service),
  };
}

function createPaymentGuard() {
  const resourceServer = new x402ResourceServer(createFacilitator()).register(
    X402_NETWORK,
    new ExactEvmScheme(),
  );
  const routes = {};
  for (const service of API_SERVICES) routes[`POST ${service.path}`] = paymentRoute(service);
  for (const [path, serviceId] of Object.entries(LEGACY_PATHS)) {
    routes[`POST ${path}`] = paymentRoute(SERVICE_BY_ID.get(serviceId), path);
  }
  routes[`POST ${MCP_SERVICE.path}`] = paymentRoute(MCP_SERVICE);
  return paymentMiddleware(routes, resourceServer, { appName: SUITE_NAME, testnet: false });
}

function invalidInput(res, details) {
  return jsonResponse(res, 400, {
    ok: false,
    error: { code: "invalid_input", message: "Input did not satisfy the service schema.", details },
  });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function mcpTools() {
  return API_SERVICES.map((service) => ({
    name: service.endpoint,
    title: service.name,
    description: service.description,
    inputSchema: service.inputSchema,
    outputSchema: { type: "object", description: `${service.name} structured JSON response.` },
  }));
}

function findMcpService(name) {
  const normalized = normalizeString(name);
  return API_SERVICES.find(
    (service) => service.endpoint === normalized || service.id === normalized || service.name === normalized,
  );
}

function mcpError(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
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
        capabilities: { tools: {} },
        serverInfo: { name: SUITE_NAME, version: SERVICE_VERSION },
      },
    };
  }
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: mcpTools() } };
  if (method !== "tools/call") return mcpError(id, -32601, "Method not found.");

  const service = findMcpService(message.params?.name);
  if (!service) {
    return mcpError(id, -32602, "Unknown tool.", { availableTools: mcpTools().map((tool) => tool.name) });
  }
  const normalized = normalizeServiceInput(message.params?.arguments || {}, service);
  if (!normalized.ok) return mcpError(id, -32602, "Invalid tool input.", normalized.errors);
  const result = await executeService(service, normalized.value);
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    },
  };
}

function errorStatus(error) {
  if (error?.type === "entity.parse.failed") return 400;
  if (error?.code === "INVALID_INPUT") return 400;
  if (error?.code === "UPSTREAM_TIMEOUT") return 504;
  if (error?.code === "UPSTREAM_RATE_LIMITED") return 503;
  if (error?.code === "UPSTREAM_FAILURE") return 502;
  return error?.status || 500;
}

const app = express();

app.use((req, res, next) => {
  res.setHeader("cache-control", "no-store");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    "content-type,authorization,x-payment,payment,payment-signature",
  );
  if (req.method === "OPTIONS") return res.status(204).end();
  return next();
});

app.use(express.json({ limit: "128kb" }));
if (PAYMENT_MODE !== "demo") app.use(createPaymentGuard());

app.get("/health", (req, res) => jsonResponse(res, 200, {
  ok: true,
  suite: SUITE_NAME,
  version: SERVICE_VERSION,
  status: "healthy",
  time: new Date().toISOString(),
  paymentMode: PAYMENT_MODE,
  services: API_SERVICES.map((service) => service.id),
}));

app.get("/metadata", (req, res) => jsonResponse(res, 200, metadata()));

app.get("/mcp", (req, res) => jsonResponse(res, 200, {
  ok: true,
  service: { id: MCP_SERVICE.id, name: MCP_SERVICE.name, version: SERVICE_VERSION },
  endpointPath: MCP_SERVICE.path,
  ...(publicUrl(MCP_SERVICE.path) ? { endpointUrl: publicUrl(MCP_SERVICE.path) } : {}),
  suggestedFeeUsdt: MCP_SERVICE.fee,
  tools: mcpTools(),
  jsonRpcMethods: ["initialize", "tools/list", "tools/call"],
}));

app.get("/openapi.json", (req, res) => {
  const host = req.get("host") || `localhost:${PORT}`;
  return jsonResponse(res, 200, openapi(`${req.protocol}://${host}`));
});

app.post("/mcp", asyncRoute(async (req, res) => {
  const messages = Array.isArray(req.body) ? req.body : [req.body];
  const responses = await Promise.all(messages.map(handleMcpRequest));
  return jsonResponse(res, 200, Array.isArray(req.body) ? responses : responses[0]);
}));

for (const [path, service] of SERVICE_BY_PATH) {
  app.post(path, asyncRoute(async (req, res) => {
    const normalized = normalizeServiceInput(req.body, service);
    if (!normalized.ok) return invalidInput(res, normalized.errors);
    return jsonResponse(res, 200, await executeService(service, normalized.value));
  }));
}

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = errorStatus(error);
  return jsonResponse(res, status, {
    ok: false,
    error: {
      code: error?.type === "entity.parse.failed" ? "invalid_json" : error?.code || "internal_error",
      message: error?.type === "entity.parse.failed" ? "Request body is not valid JSON." : error?.message || "Unexpected error.",
    },
  });
});

app.use((req, res) => jsonResponse(res, 404, {
  ok: false,
  error: {
    code: "not_found",
    message: `Unknown endpoint. Try GET /health, /metadata, /openapi.json, or POST one of: ${API_SERVICES.map((service) => service.path).join(", ")}.`,
  },
}));

app.listen(PORT, () => {
  console.log(`${SUITE_NAME} listening on http://localhost:${PORT} (paymentMode=${PAYMENT_MODE})`);
});
