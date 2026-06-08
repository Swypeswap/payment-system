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
  secretKeyToBase58,
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

test("normalizes JSON Solana private keys to base58", () => {
  const keypair = Keypair.generate();
  const base58 = secretKeyToBase58(JSON.stringify(Array.from(keypair.secretKey)));
  const parsed = parseSecretKey(base58);
  assert.equal(parsed.publicKey.toBase58(), keypair.publicKey.toBase58());
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

test("plans the largest exact owner-pool and manager Privacy Cash distribution within a shield budget", () => {
  const fees = { withdrawFeeRate: 0.0035, withdrawBaseFeeLamports: 6_000_000 };
  const plan = planPrivacyCashDistribution(1_000_000_000n, fees);
  const [owner1, owner2, owner3, manager] = plan.withdrawals;
  const ownerPool =
    (owner1?.netLamports ?? 0n) +
    (owner2?.netLamports ?? 0n) +
    (owner3?.netLamports ?? 0n);
  assert.equal(ownerPool, (manager?.netLamports ?? 0n) * 9n);
  assert.equal(owner1?.netLamports, ownerPool * 33n / 100n);
  assert.equal(owner2?.netLamports, ownerPool * 33n / 100n);
  assert.equal(
    owner3?.netLamports,
    ownerPool - (owner1?.netLamports ?? 0n) - (owner2?.netLamports ?? 0n)
  );
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
  const ownerPool = sum("owner_1") + sum("owner_2") + sum("owner_3");
  assert.equal(ownerPool, sum("manager") * 9n);
  assert.equal(sum("owner_1"), ownerPool * 33n / 100n);
  assert.equal(sum("owner_2"), ownerPool * 33n / 100n);
  assert.equal(sum("owner_3"), ownerPool - sum("owner_1") - sum("owner_2"));
  assert.equal(plan.withdrawals.length, 9);
});

test("plans configurable owner-only Privacy Cash payouts with randomized legs", () => {
  const fees = { withdrawFeeRate: 0.0035, withdrawBaseFeeLamports: 6_000_000 };
  const plan = planOwnerPrivacyCashDistribution(
    2_000_000_000n,
    fees,
    [40, 25, 20, 15],
    [[8, 12], [10, 9, 11], [11, 9], [9, 10]]
  );
  const sum = (kind: string) =>
    plan.withdrawals
      .filter((item) => item.recipientKind === kind)
      .reduce((total, item) => total + item.netLamports, 0n);
  const difference = (left: bigint, right: bigint) => left >= right ? left - right : right - left;
  assert.ok(difference(sum("owner_1") * 25n, sum("owner_2") * 40n) <= 40n);
  assert.ok(difference(sum("owner_2") * 20n, sum("owner_3") * 25n) <= 25n);
  assert.ok(difference(sum("owner_3") * 15n, sum("owner_4") * 20n) <= 20n);
  assert.equal(plan.withdrawals.length, 9);
  assert.equal(
    plan.withdrawals.reduce((total, item) => total + item.netLamports, 0n),
    plan.netDistributionLamports
  );
});

test("rejects owner Privacy Cash percentages that do not total 100", () => {
  assert.throws(() =>
    planOwnerPrivacyCashDistribution(
      2_000_000_000n,
      { withdrawFeeRate: 0.0035, withdrawBaseFeeLamports: 6_000_000 },
      [50, 40],
      [[1], [1]]
    )
  );
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
