import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import {
  decryptSecret,
  effectiveWebsiteSettings,
  encryptSecret,
  parseSecretKey,
  validateSolanaWalletAddress
} from "./index.js";

test("encrypts and decrypts secrets with AES-256-GCM", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const encrypted = encryptSecret("secret-value", key);
  assert.notEqual(encrypted.ciphertext, "secret-value");
  assert.equal(decryptSecret(encrypted, key), "secret-value");
});

test("parses a JSON Solana private key and accepts its wallet address", () => {
  const keypair = Keypair.generate();
  const parsed = parseSecretKey(JSON.stringify(Array.from(keypair.secretKey)));
  assert.equal(parsed.publicKey.toBase58(), keypair.publicKey.toBase58());
  assert.equal(
    validateSolanaWalletAddress(keypair.publicKey.toBase58()),
    keypair.publicKey.toBase58()
  );
});

test("resolves website overrides and validates percentages", () => {
  const settings = effectiveWebsiteSettings(
    {
      global_threshold_usd: 100,
      global_manager_percent: 10,
      global_company_percent: 90,
      global_sol_reserve: 0.02,
      min_swap_usd: 1,
      max_price_impact_pct: 5,
      min_organic_score: 0,
      swaps_enabled: false,
      live_payouts_enabled: false,
      emergency_paused: true
    },
    {
      threshold_usd: 250,
      manager_percent: null,
      company_percent: null,
      sol_reserve: null
    }
  );
  assert.equal(settings.thresholdUsd, 250);
  assert.equal(settings.managerPercent, 10);
});
