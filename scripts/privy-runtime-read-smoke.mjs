/** Run inside the backend container: real provider/RPC reads; isolated test JWT verifier; no wallet mutations. */
import { generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
const { PRIVY_APP_ID: appId, PRIVY_APP_SECRET: appSecret } = process.env;
if (!appId || !appSecret)
 throw new Error("PRIVY_APP_ID and PRIVY_APP_SECRET required");
const headers = {
 "privy-app-id": appId,
 authorization:
  "Basic " + Buffer.from(appId + ":" + appSecret).toString("base64"),
};
async function provider(path) {
 const response = await fetch("https://api.privy.io/v1" + path, {
  headers,
  signal: AbortSignal.timeout(15000),
 });
 if (!response.ok)
  throw new Error("Read-only Privy request failed: HTTP " + response.status);
 return response.json();
}
const users = await provider("/users?limit=100");
const user = users.data?.[0];
if (!user?.id)
 throw new Error("No Privy user available for read-only validation");
const walletRecords = new Map();
let cursor;
const seenCursors = new Set();
for (let page = 0; page < 20; page++) {
 const owned = await provider(
  "/wallets?user_id=" +
   encodeURIComponent(user.id) +
   "&limit=100" +
   (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
 );
 for (const wallet of owned.data ?? []) walletRecords.set(wallet.id, wallet);
 if (!owned.next_cursor || !(owned.data ?? []).length) break;
 if (seenCursors.has(owned.next_cursor) || page === 19)
  throw new Error("Wallet pagination did not terminate");
 seenCursors.add(owned.next_cursor);
 cursor = owned.next_cursor;
}
const eligible = [...walletRecords.values()].filter(
 (w) => w.chain_type === "ethereum" && !w.archived_at,
);
const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
// This override applies only to the isolated smoke process; the running API keeps real Privy verification.
process.env.PRIVY_VERIFICATION_KEY = key.publicKey.export({
 type: "spki",
 format: "pem",
});
process.env.AGENT_RUNTIME = "deterministic";
const { buildServer } = await import("./dist/server.js");
const app = buildServer();
try {
 const token = await new SignJWT({})
  .setProtectedHeader({ alg: "ES256" })
  .setIssuer("privy.io")
  .setAudience(appId)
  .setSubject(user.id)
  .setIssuedAt()
  .setExpirationTime("5m")
  .sign(key.privateKey);
 for (const url of [
  "/v1/wallet/address",
  "/v1/wallet/balance?network=solana-devnet&token=SOL",
  "/v1/wallet/history?network=solana-devnet&token=SOL",
 ]) {
  const response = await app.inject({
   method: "GET",
   url,
   headers: { authorization: "Bearer " + token },
  });
  const body = response.json();
  if (!eligible.length) {
   if (response.statusCode < 400 || response.statusCode >= 500)
    throw new Error(
     url +
      " must explicitly report unavailable wallet; got HTTP " +
      response.statusCode,
    );
   console.log(
    "PASS no-wallet readiness: " + url + " HTTP " + response.statusCode,
   );
  } else if (eligible.length === 1) {
   if (url.includes("/history")) {
    if (response.statusCode !== 200 && response.statusCode !== 501)
     throw new Error("Unexpected history response");
    console.log(
     "History HTTP " +
      response.statusCode +
      " (unsupported indexing must be explicit)",
    );
   } else {
    if (
     response.statusCode !== 200 ||
     body.address?.toLowerCase() !== eligible[0].address.toLowerCase()
    )
     throw new Error("Owned wallet read mismatch");
    console.log("PASS real owned wallet read: " + url);
   }
  } else
   throw new Error(
    "Multiple wallets or pagination needs manual account-specific verification",
   );
 }
 console.log(
  "PRIVY_RUNTIME_READ_SMOKE_PASS; no transfers or wallet creation requested",
 );
} catch (error) {
 console.error(error.message);
 process.exitCode = 1;
} finally {
 await app.close();
}
process.exit(process.exitCode ?? 0);
