import { randomUUID } from "node:crypto";
import express from "express";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";

const PORT = Number(process.env.PORT || 8787);
const SERVICE_NAME = "Web3 Signal Snapshot";
const SERVICE_VERSION = "0.1.0";
const PAYMENT_MODE = process.env.PAYMENT_MODE || "demo";
const X402_NETWORK = process.env.X402_NETWORK || "eip155:196";
const X402_PRICE = process.env.X402_PRICE || "$0.02";
const X402_PAY_TO = process.env.X402_PAY_TO || "0x0000000000000000000000000000000000000001";
const X402_ASSET = process.env.X402_ASSET || "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const X402_AMOUNT_MINIMAL = process.env.X402_AMOUNT_MINIMAL || "20000";
const X402_TOKEN_NAME = process.env.X402_TOKEN_NAME || "USD\u20ae0";
const X402_TOKEN_SYMBOL = process.env.X402_TOKEN_SYMBOL || "USDT0";
const X402_TOKEN_VERSION = process.env.X402_TOKEN_VERSION || "1";

function normalizeDecimals(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 6;
}

const X402_TOKEN_DECIMALS = normalizeDecimals(process.env.X402_TOKEN_DECIMALS || 6);

const SUPPORTED_CHAINS = new Set([
  "solana",
  "ethereum",
  "xlayer",
  "base",
  "bsc",
  "arbitrum",
  "polygon",
]);

const SUPPORTED_MODES = new Set(["token", "wallet", "project", "risk"]);

function jsonResponse(res, status, body) {
  return res.status(status).json(body);
}

function notFound(res) {
  return jsonResponse(res, 404, {
    ok: false,
    error: {
      code: "not_found",
      message: "Unknown endpoint. Try GET /health, GET /metadata, GET /openapi.json, or POST /api/signal-snapshot.",
    },
  });
}

function normalizeInput(input) {
  const chain = String(input.chain || "").trim().toLowerCase();
  const mode = String(input.mode || "token").trim().toLowerCase();
  const subject = String(input.address || input.subject || "").trim();
  const question = String(input.question || "").trim();
  const language = String(input.language || "zh-CN").trim();
  const lookbackHours = Number.isFinite(Number(input.lookbackHours)) ? Number(input.lookbackHours) : 24;

  const errors = [];

  if (!SUPPORTED_CHAINS.has(chain)) {
    errors.push({
      field: "chain",
      message: `Unsupported chain. Use one of: ${Array.from(SUPPORTED_CHAINS).join(", ")}.`,
    });
  }

  if (!SUPPORTED_MODES.has(mode)) {
    errors.push({
      field: "mode",
      message: `Unsupported mode. Use one of: ${Array.from(SUPPORTED_MODES).join(", ")}.`,
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
      name: SERVICE_NAME,
      version: SERVICE_VERSION,
      serviceType: "A2MCP",
      dataStatus: "demo",
      paymentMode: PAYMENT_MODE,
    },
    requestId: randomUUID(),
    generatedAt,
    input,
    summary: `${modeCopy} ${shortSubject} 的 ${input.lookbackHours} 小时信号快照已生成。当前 MVP 返回结构化分析框架，正式版会接入实时链上/市场/社媒数据源。`,
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
        detail: "当前为本地 A2MCP endpoint 形态验证；mock-x402 模式只验证 402 付费墙，不结算真实付款。",
      },
    ],
    riskFlags: [
      {
        severity: "medium",
        title: "未接入实时数据",
        detail: "正式上架前需要接入可验证数据源，避免返回过期或不可复核的信息。",
      },
      {
        severity: "low",
        title: "输入语义可能不足",
        detail: "建议调用方提供关注问题、时间范围和验收口径，以提升输出可用性。",
      },
    ],
    suggestedNextSteps: [
      "接入 OKX / OnchainOS / 第三方只读数据源。",
      "增加来源链接、时间戳、置信度和失败原因字段。",
      "部署到公网 HTTPS endpoint。",
      "切换到 okx-x402 模式并配置真实 OKX facilitator 凭证后再注册为付费 A2MCP 服务。",
    ],
    sources: [
      {
        name: "Local A2MCP MVP",
        url: `http://localhost:${PORT}/metadata`,
        accessedAt: generatedAt,
      },
    ],
    disclaimer: "This demo is for endpoint validation only and is not financial advice.",
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

function metadata() {
  return {
    ok: true,
    service: {
      name: SERVICE_NAME,
      version: SERVICE_VERSION,
      serviceType: "A2MCP",
      pricingReady: PAYMENT_MODE !== "demo",
      paymentIntegration: PAYMENT_MODE,
      suggestedFeeUsdt: X402_PRICE.replace(/^\$/, ""),
      endpointPath: "/api/signal-snapshot",
      x402: pricing(),
    },
    inputSchema: {
      type: "object",
      required: ["chain", "address"],
      properties: {
        chain: { type: "string", enum: Array.from(SUPPORTED_CHAINS) },
        address: { type: "string", description: "Token, wallet, contract address, or project slug." },
        mode: { type: "string", enum: Array.from(SUPPORTED_MODES), default: "token" },
        question: { type: "string", description: "Optional analysis focus." },
        lookbackHours: { type: "number", minimum: 1, maximum: 720, default: 24 },
        language: { type: "string", default: "zh-CN" },
      },
    },
    outputGuarantees: [
      "Structured JSON response",
      "Request id and timestamp",
      "Observations, risk flags, suggested next steps, and sources",
    ],
  };
}

function openapi(baseUrl) {
  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE_NAME,
      version: SERVICE_VERSION,
      description: "A2MCP-style Web3 signal snapshot endpoint.",
    },
    servers: [{ url: baseUrl }],
    paths: {
      "/health": {
        get: {
          summary: "Health check",
          responses: { "200": { description: "Service is healthy." } },
        },
      },
      "/metadata": {
        get: {
          summary: "Service metadata and schema",
          responses: { "200": { description: "A2MCP service metadata." } },
        },
      },
      "/api/signal-snapshot": {
        post: {
          summary: "Create a Web3 signal snapshot",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: metadata().inputSchema,
              },
            },
          },
          responses: {
            "200": { description: "Structured signal snapshot after payment or in demo mode." },
            "400": { description: "Invalid input." },
            "402": { description: "Payment required in x402 modes." },
          },
        },
      },
    },
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

    return new OKXFacilitatorClient({
      apiKey: process.env.OKX_API_KEY,
      secretKey: process.env.OKX_SECRET_KEY,
      passphrase: process.env.OKX_PASSPHRASE,
      baseUrl: process.env.OKX_FACILITATOR_BASE_URL,
      syncSettle: process.env.X402_SYNC_SETTLE === "1",
    });
  }

  throw new Error(`Unsupported PAYMENT_MODE: ${PAYMENT_MODE}`);
}

function createPaymentGuard() {
  const resourceServer = new x402ResourceServer(createFacilitator()).register(
    X402_NETWORK,
    new ExactEvmScheme(),
  );

  const routes = {
    "POST /api/signal-snapshot": {
      accepts: {
        scheme: "exact",
        network: X402_NETWORK,
        payTo: X402_PAY_TO,
        price: paymentPrice(),
        maxTimeoutSeconds: 300,
      },
      resource: "/api/signal-snapshot",
      description: "Structured Web3 signal snapshot with observations, risk flags, next steps, and sources.",
      mimeType: "application/json",
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: {
          ok: false,
          error: {
            code: "payment_required",
            message: "Payment is required. Decode the PAYMENT-REQUIRED header and retry with a valid x402 payment payload.",
          },
          service: {
            name: SERVICE_NAME,
            version: SERVICE_VERSION,
            serviceType: "A2MCP",
            paymentMode: PAYMENT_MODE,
          },
          pricing: pricing(),
        },
      }),
    },
  };

  return paymentMiddleware(routes, resourceServer, {
    appName: SERVICE_NAME,
    testnet: false,
  });
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
  service: SERVICE_NAME,
  status: "healthy",
  time: new Date().toISOString(),
  paymentMode: PAYMENT_MODE,
}));

app.get("/metadata", (req, res) => jsonResponse(res, 200, metadata()));

app.get("/openapi.json", (req, res) => {
  const protocol = req.protocol;
  const host = req.get("host") || `localhost:${PORT}`;
  return jsonResponse(res, 200, openapi(`${protocol}://${host}`));
});

app.post("/api/signal-snapshot", (req, res) => {
  const normalized = normalizeInput(req.body || {});
  if (!normalized.ok) {
    return jsonResponse(res, 400, {
      ok: false,
      error: {
        code: "invalid_input",
        message: "Input did not satisfy the service schema.",
        details: normalized.errors,
      },
    });
  }

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
  console.log(`${SERVICE_NAME} listening on http://localhost:${PORT} (paymentMode=${PAYMENT_MODE})`);
});
