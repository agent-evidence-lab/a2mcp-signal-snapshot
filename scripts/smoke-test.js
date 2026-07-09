import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const startedHere = !process.env.A2MCP_BASE_URL;
const port = process.env.PORT || "18787";
const baseUrl = process.env.A2MCP_BASE_URL || `http://localhost:${port}`;
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
  console.log(`POST ${path}`, response.status, payload);
  if (!response.ok) {
    throw new Error(`Expected POST ${path} to succeed.`);
  }
  return payload;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  if (startedHere) {
    child = spawn(process.execPath, ["src/server.js"], {
      env: {
        ...process.env,
        PORT: port,
        PAYMENT_MODE: "demo",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  }

  await waitForHealth();

  const health = await fetch(`${baseUrl}/health`);
  const healthBody = await health.json();
  console.log("GET /health", health.status, healthBody);
  assert(Array.isArray(healthBody.services), "Health should list services.");

  const metadata = await fetch(`${baseUrl}/metadata`);
  const metadataBody = await metadata.json();
  console.log("GET /metadata", metadata.status, metadataBody);
  assert(metadataBody.services?.length >= 3, "Metadata should expose multiple A2MCP services.");
  assert(metadataBody.suite?.mcpEndpointPath === "/mcp", "Metadata should expose the MCP endpoint.");

  const mcpInfo = await fetch(`${baseUrl}/mcp`);
  const mcpInfoBody = await mcpInfo.json();
  console.log("GET /mcp", mcpInfo.status, mcpInfoBody);
  assert(mcpInfoBody.tools?.length >= 3, "MCP endpoint should expose tools.");

  const tokenBody = {
    chain: "solana",
    token_address: "So11111111111111111111111111111111111111112",
    language: "zh-CN",
  };

  const tokenRisk = await postJson("/api/token-risk-scan", tokenBody);
  assert(typeof tokenRisk.risk_score === "number", "Token Risk Guard should return risk_score.");
  assert(tokenRisk.risk_level, "Token Risk Guard should return risk_level.");
  assert(tokenRisk.data_quality, "Token Risk Guard should return data_quality.");

  const mcpToolCall = await postJson("/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "token_risk_scan",
      arguments: tokenBody,
    },
  });
  assert(mcpToolCall.result?.structuredContent?.risk_score !== undefined, "MCP tools/call should return structuredContent.");

  const apeGuard = await postJson("/api/ape-pretrade-check", {
    ...tokenBody,
    mode: "quick",
  });
  assert(typeof apeGuard.ape_score === "number", "ApeGuard should return ape_score.");
  assert(apeGuard.decision_hint, "ApeGuard should return decision_hint.");

  const snapshot = await postJson("/api/signal-snapshot", {
    chain: "solana",
    address: "So11111111111111111111111111111111111111112",
    mode: "token",
    question: "给我一个代币风险和市场信号快照",
    lookbackHours: 24,
    language: "zh-CN",
  });
  assert(snapshot.observations?.length > 0, "Signal Snapshot should return observations.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  if (child) child.kill("SIGTERM");
});
