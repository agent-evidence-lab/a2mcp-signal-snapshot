import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

process.env.PORT = "18789";
process.env.PAYMENT_MODE = "okx-x402";
process.env.X402_PAY_TO = "0x1111111111111111111111111111111111111111";
process.env.OKX_API_KEY = "test-api-key";
process.env.OKX_SECRET_KEY = "test-secret-key";
process.env.OKX_PASSPHRASE = "test-passphrase";
delete process.env.OKX_FACILITATOR_BASE_URL;

const facilitatorUrls = [];
globalThis.fetch = async (input) => {
  facilitatorUrls.push(String(input));
  return new Promise(() => {});
};

await import("../src/server.js");

for (let attempt = 0; attempt < 20 && facilitatorUrls.length === 0; attempt += 1) {
  await delay(25);
}

assert.equal(
  facilitatorUrls[0],
  "https://web3.okx.com/api/v6/pay/x402/supported",
  "The OKX SDK default base URL must be preserved when no override is configured.",
);

console.log("Facilitator default URL preserved.");
process.exit(0);
