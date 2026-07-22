import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { API_SERVICES, LEGACY_PATHS } from "../src/intelligence/catalog.js";

const startedHere = !process.env.A2MCP_BASE_URL;
const port = process.env.PORT || "18787";
const baseUrl = process.env.A2MCP_BASE_URL || `http://localhost:${port}`;
const tokenBody = {
  chain: "solana",
  token_address: "So11111111111111111111111111111111111111112",
  language: "zh-CN",
};
const evmTokenBody = {
  chain: "ethereum",
  token_address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  language: "zh-CN",
};
let child;

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

async function postJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  console.log(`POST ${path}`, response.status, payload.service?.id || payload.error?.code);
  if (!response.ok) throw new Error(`Expected POST ${path} to succeed: ${JSON.stringify(payload)}`);
  return payload;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEnvelope(payload, serviceId, path) {
  assert(payload.ok === true, `${path} should return ok=true.`);
  assert(payload.service?.id === serviceId, `${path} should identify ${serviceId}.`);
  assert(typeof payload.request_id === "string", `${path} should return request_id.`);
  assert(Number.isFinite(Date.parse(payload.generated_at)), `${path} should return generated_at.`);
  assert(payload.data_quality && typeof payload.data_quality === "object", `${path} should return data_quality.`);
  assert(Array.isArray(payload.sources), `${path} should return sources.`);
}

async function main() {
  if (startedHere) {
    child = spawn(process.execPath, ["src/server.js"], {
      env: { ...process.env, PORT: port, PAYMENT_MODE: "demo" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  }

  await waitForHealth();

  const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
  assert(health.services?.length === 8, "Health should expose exactly eight canonical services.");

  const metadata = await fetch(`${baseUrl}/metadata`).then((response) => response.json());
  assert(metadata.services?.length === 8, "Metadata should expose eight A2MCP services.");
  assert(metadata.suite?.mcpEndpointPath === "/mcp", "Metadata should expose the MCP endpoint.");
  assert(metadata.suite?.name === "Codex Evidence Lab A2MCP Suite", "Suite identity should remain stable.");
  for (const service of API_SERVICES) {
    const exposed = metadata.services.find((entry) => entry.id === service.id);
    assert(exposed?.suggestedFeeUsdt === service.fee, `${service.id} should expose its catalog fee.`);
    assert(exposed?.endpointPath === service.path, `${service.id} should expose its canonical path.`);
  }

  const openapi = await fetch(`${baseUrl}/openapi.json`).then((response) => response.json());
  for (const service of API_SERVICES) {
    assert(openapi.paths?.[service.path]?.post, `OpenAPI should expose ${service.path}.`);
  }

  const mcpInfo = await fetch(`${baseUrl}/mcp`).then((response) => response.json());
  assert(mcpInfo.tools?.length === 8, "MCP endpoint should expose eight tools.");

  for (const service of API_SERVICES) {
    const input = service.supportedSecurityChains ? evmTokenBody : tokenBody;
    const payload = await postJson(service.path, input);
    assertEnvelope(payload, service.id, service.path);
  }

  for (const [legacyPath, serviceId] of Object.entries(LEGACY_PATHS)) {
    const payload = await postJson(legacyPath, tokenBody);
    assertEnvelope(payload, serviceId, legacyPath);
  }

  const invalidAddressResponse = await fetch(`${baseUrl}/api/contract-tax-check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chain: "ethereum", token_address: "0x1234" }),
  });
  const invalidAddress = await invalidAddressResponse.json();
  assert(invalidAddressResponse.status === 400, "Malformed chain addresses should return HTTP 400.");
  assert(invalidAddress.error?.code === "INVALID_INPUT", "Provider validation should remain visible.");

  const mcpToolCall = await postJson("/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "pretrade_risk_report",
      arguments: tokenBody,
    },
  });
  assert(
    mcpToolCall.result?.structuredContent?.service?.id === "pretrade-risk-report",
    "MCP tools/call should dispatch to the requested service.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  if (child) child.kill("SIGTERM");
});
