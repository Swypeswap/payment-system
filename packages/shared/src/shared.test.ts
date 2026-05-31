import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import {
  decryptSecret,
  CONFETTI_WEBHOOK_AVATAR_URL,
  CONFETTI_WEBHOOK_NAMES,
  effectiveWebsiteSettings,
  encryptSecret,
  parseDomain,
  parseSecretKey,
  toHttpsWebsiteUrl,
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

test("uses the configured Confetti identity for Discord webhook messages", () => {
  assert.equal(CONFETTI_WEBHOOK_NAMES.website_request, "Confetti Website Request");
  assert.equal(CONFETTI_WEBHOOK_NAMES.website_activation, "Confetti Website Activated");
  assert.equal(CONFETTI_WEBHOOK_NAMES.deposit, "Confetti Deposit");
  assert.equal(CONFETTI_WEBHOOK_NAMES.payout, "Confetti Payout");
  assert.equal(CONFETTI_WEBHOOK_NAMES.security_alert, "Confetti Security Alert");
  assert.equal(CONFETTI_WEBHOOK_NAMES.worker_error, "Confetti Worker Error");
  assert.equal(CONFETTI_WEBHOOK_AVATAR_URL, "https://files.catbox.moe/kxol69.png");
});

test("normalizes website domains and activation URLs", () => {
  assert.equal(parseDomain("Example.COM"), "example.com");
  assert.equal(parseDomain("https://Example.COM/launch"), "example.com");
  assert.equal(toHttpsWebsiteUrl("example.com"), "https://example.com");
  assert.equal(toHttpsWebsiteUrl("https://Example.COM/launch"), "https://example.com");
});
