#!/usr/bin/env node
// Standalone decryption utility for Telegram intermediate-wallet private keys.
//
// Usage:
//   ENCRYPTION_KEY="<base64-32-byte-master-key>" node scripts/decrypt-source-key.mjs "v1:<base64-iv>:<base64-ciphertext>"
//
// Or pipe the encrypted blob via stdin:
//   echo "v1:..." | ENCRYPTION_KEY="<base64-key>" node scripts/decrypt-source-key.mjs
//
// Output: the original Solana private key string. Do not paste this output into Discord.

import { webcrypto } from "node:crypto";

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) {
  console.error("Missing ENCRYPTION_KEY env var.");
  process.exit(1);
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
  });
}

const encrypted = (process.argv[2] && process.argv[2].trim()) || (await readStdin());
if (!encrypted) {
  console.error("No encrypted blob provided.");
  process.exit(1);
}

const parts = encrypted.split(":");
if (parts.length !== 3) {
  console.error(`Malformed blob - expected "v1:<iv>:<ciphertext>", got ${parts.length} parts`);
  process.exit(1);
}

const [version, ivB64, ctB64] = parts;
if (version !== "v1") {
  console.error(`Unsupported encryption version: ${version} (this script handles v1)`);
  process.exit(1);
}

const b64ToBytes = (b64) => new Uint8Array(Buffer.from(b64, "base64"));
const keyBytes = b64ToBytes(ENCRYPTION_KEY);
if (keyBytes.length !== 32) {
  console.error(`ENCRYPTION_KEY must decode to 32 bytes (got ${keyBytes.length})`);
  process.exit(1);
}

try {
  const key = await webcrypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const plaintext = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(ivB64) },
    key,
    b64ToBytes(ctB64)
  );
  process.stdout.write(Buffer.from(plaintext).toString("utf8") + "\n");
} catch (error) {
  console.error(`Decryption failed: ${error.message || error}`);
  console.error("Most likely: ENCRYPTION_KEY does not match the key that encrypted this blob.");
  process.exit(1);
}
