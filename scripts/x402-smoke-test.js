import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import {
  API_SERVICES,
  LEGACY_PATHS,
  SERVICE_BY_ID,
  feeToMinimal,
} from "../src/intelligence/catalog.js";

const startedHere = !process.env.A2MCP_BASE_URL;
const port = process.env.PORT || "18788";
const baseUrl = process.env.A2MCP_BASE_URL || `http://localhost:${port}`;
const tokenBody = {
  chain: "solana",
  token_address: "So11111111111111111111111111111111111111112",
};
const mcpFee = process.env.MCP_FEE_USDT || "0.03";
let child;

const endpointBodies = [
  ...API_SERVICES.map((service) => [service.path, tokenBody, service.fee]),
  ...Object.entries(LEGACY_PATHS).map(([path, serviceId]) => [
    path,
    tokenBody,
    SERVICE_BY_ID.get(serviceId).fee,
  ]),
  ["/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, mcpFee],
];

function decodePaymentRequired(header) {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Wait for the local test server to start.
    }
    await delay(500);
  }
  throw new Error("Timed out waiting for test server.");
}

async function main() {
  if (startedHere) {
    child = spawn(process.execPath, ["src/server.js"], {
      env: {
        ...process.env,
        PORT: port,
        PAYMENT_MODE: "mock-x402",
        PUBLIC_BASE_URL: baseUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  }

  await waitForHealth();

  for (const [path, body, fee] of endpointBodies) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const paymentRequired = response.headers.get("payment-required");
    console.log(`POST ${path}`, response.status);
    if (response.status !== 402 || !paymentRequired) {
      throw new Error(`Expected HTTP 402 with PAYMENT-REQUIRED header for ${path}.`);
    }

    const decoded = decodePaymentRequired(paymentRequired);
    const [requirement] = decoded.accepts || [];
    if (requirement?.asset !== "0x779ded0c9e1022225f8e0630b35a9b54be713736") {
      throw new Error(`Unexpected x402 asset for ${path}.`);
    }
    if (requirement?.amount !== feeToMinimal(fee, 6)) {
      throw new Error(`Expected ${fee} USDT for ${path}, got ${requirement?.amount}.`);
    }
    if (requirement?.extra?.decimals !== 6) {
      throw new Error(`Expected six token decimals for ${path}.`);
    }
    if (decoded.resource?.url !== `${baseUrl}${path}`) {
      throw new Error(`Expected an absolute resource URL for ${path}, got ${decoded.resource?.url}.`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  if (child) child.kill("SIGTERM");
});
