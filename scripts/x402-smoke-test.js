const baseUrl = process.env.A2MCP_BASE_URL || "http://localhost:8788";

function decodePaymentRequired(header) {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

async function main() {
  const response = await fetch(`${baseUrl}/api/signal-snapshot`, {
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

  const paymentRequired = response.headers.get("payment-required");
  console.log("POST /api/signal-snapshot", response.status);
  console.log("PAYMENT-REQUIRED header present:", Boolean(paymentRequired));
  console.log(await response.json());

  if (response.status !== 402 || !paymentRequired) {
    throw new Error("Expected HTTP 402 with PAYMENT-REQUIRED header.");
  }

  const decoded = decodePaymentRequired(paymentRequired);
  const [requirement] = decoded.accepts || [];
  console.log("Decoded accepts[0]", requirement);

  if (!requirement?.asset || !requirement?.amount || !requirement?.extra?.decimals) {
    throw new Error("Expected decoded payment requirements to include asset, amount, and token decimals.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
