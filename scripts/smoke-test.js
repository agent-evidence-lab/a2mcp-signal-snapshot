const baseUrl = process.env.A2MCP_BASE_URL || "http://localhost:8787";

async function main() {
  const health = await fetch(`${baseUrl}/health`);
  console.log("GET /health", health.status, await health.json());

  const metadata = await fetch(`${baseUrl}/metadata`);
  console.log("GET /metadata", metadata.status, await metadata.json());

  const snapshot = await fetch(`${baseUrl}/api/signal-snapshot`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chain: "solana",
      address: "So11111111111111111111111111111111111111112",
      mode: "token",
      question: "给我一个代币风险和市场信号快照",
      lookbackHours: 24,
      language: "zh-CN",
    }),
  });
  console.log("POST /api/signal-snapshot", snapshot.status, await snapshot.json());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
