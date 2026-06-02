import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import {
  decryptSecret,
  decryptVersionedSourceSecret,
  CONFETTI_WEBHOOK_AVATAR_URL,
  CONFETTI_WEBHOOK_NAMES,
  effectiveWebsiteSettings,
  encryptSecret,
  grossUpPrivacyCashWithdrawal,
  parseDomain,
  parseSecretKey,
  planPrivacyCashDistribution,
  planOwnerPrivacyCashDistribution,
  privacyCashNetFromGross,
  toHttpsWebsiteUrl,
  validateSolanaWalletAddress
} from "./index.js";

test("encrypts and decrypts secrets with AES-256-GCM", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const encrypted = encryptSecret("secret-value", key);
  assert.notEqual(encrypted.ciphertext, "secret-value");
  assert.equal(decryptSecret(encrypted, key), "secret-value");
});

test("decrypts Telegram source-wallet v1 AES-GCM blobs", () => {
  const key = Buffer.alloc(32, 9);
  const nonce = Buffer.alloc(12, 4);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update("base58-private-key", "utf8"),
    cipher.final(),
    cipher.getAuthTag()
  ]);
  assert.equal(
    decryptVersionedSourceSecret(
      `v1:${nonce.toString("base64")}:${ciphertext.toString("base64")}`,
      key.toString("base64")
    ),
    "base58-private-key"
  );
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
      privacy_cash_enabled: false,
      privacy_min_delay_hours: 24,
      privacy_max_delay_hours: 72,
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

test("grosses up Privacy Cash fees while preserving an exact recipient net amount", () => {
  const fees = { withdrawFeeRate: 0.0035, withdrawBaseFeeLamports: 6_000_000 };
  const net = 100_000_000n;
  const gross = grossUpPrivacyCashWithdrawal(net, fees);
  assert.equal(privacyCashNetFromGross(gross, fees), net);
  assert.ok(gross > net);
});

test("plans the largest exact 30/30/30/10 Privacy Cash distribution within a shield budget", () => {
  const fees = { withdrawFeeRate: 0.0035, withdrawBaseFeeLamports: 6_000_000 };
  const plan = planPrivacyCashDistribution(1_000_000_000n, fees);
  const [owner1, owner2, owner3, manager] = plan.withdrawals;
  assert.equal(owner1?.netLamports, owner2?.netLamports);
  assert.equal(owner2?.netLamports, owner3?.netLamports);
  assert.equal(owner1?.netLamports, (manager?.netLamports ?? 0n) * 3n);
  assert.equal(
    plan.grossDistributionLamports + plan.dustLamports,
    1_000_000_000n
  );
  assert.ok(plan.dustLamports < 10n);
});

test("splits each Privacy Cash entitlement into weighted legs without changing its exact share", () => {
  const fees = { withdrawFeeRate: 0.0035, withdrawBaseFeeLamports: 6_000_000 };
  const plan = planPrivacyCashDistribution(
    2_000_000_000n,
    fees,
    [[8, 12], [10, 9, 11], [11, 9], [8, 12]]
  );
  const sum = (kind: string) =>
    plan.withdrawals
      .filter((item) => item.recipientKind === kind)
      .reduce((total, item) => total + item.netLamports, 0n);
  assert.equal(sum("owner_1"), sum("manager") * 3n);
  assert.equal(sum("owner_2"), sum("manager") * 3n);
  assert.equal(sum("owner_3"), sum("manager") * 3n);
  assert.equal(plan.withdrawals.length, 9);
});

test("plans exact 33/33/34 owner-only Privacy Cash payouts with randomized legs", () => {
  const fees = { withdrawFeeRate: 0.0035, withdrawBaseFeeLamports: 6_000_000 };
  const plan = planOwnerPrivacyCashDistribution(
    2_000_000_000n,
    fees,
    [[8, 12], [10, 9, 11], [11, 9]]
  );
  const sum = (kind: string) =>
    plan.withdrawals
      .filter((item) => item.recipientKind === kind)
      .reduce((total, item) => total + item.netLamports, 0n);
  assert.equal(sum("owner_1"), sum("owner_2"));
  assert.equal(sum("owner_3") * 33n, sum("owner_1") * 34n);
  assert.equal(plan.withdrawals.length, 7);
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
