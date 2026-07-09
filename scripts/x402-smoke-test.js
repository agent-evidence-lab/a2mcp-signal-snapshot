import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const startedHere = !process.env.A2MCP_BASE_URL;
const port = process.env.PORT || "18788";
const baseUrl = process.env.A2MCP_BASE_URL || `http://localhost:${port}`;
let child;

const endpointBodies = [
  ["/api/token-risk-scan", {
    chain: "solana",
    token_address: "So11111111111111111111111111111111111111112",
  }],
  ["/api/ape-pretrade-check", {
    chain: "solana",
    token_address: "So11111111111111111111111111111111111111112",
    mode: "quick",
  }],
  ["/api/signal-snapshot", {
    chain: "solana",
    address: "So11111111111111111111111111111111111111112",
    mode: "token",
  }],
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
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  }

  await waitForHealth();

  for (const [path, body] of endpointBodies) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const paymentRequired = response.headers.get("payment-required");
    console.log(`POST ${path}`, response.status);
    console.log("PAYMENT-REQUIRED header present:", Boolean(paymentRequired));
    console.log(await response.json());

    if (response.status !== 402 || !paymentRequired) {
      throw new Error(`Expected HTTP 402 with PAYMENT-REQUIRED header for ${path}.`);
    }

    const decoded = decodePaymentRequired(paymentRequired);
    const [requirement] = decoded.accepts || [];
    console.log("Decoded accepts[0]", requirement);

    if (!requirement?.asset || !requirement?.amount || !requirement?.extra?.decimals) {
      throw new Error("Expected decoded payment requirements to include asset, amount, and token decimals.");
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  if (child) child.kill("SIGTERM");
});
