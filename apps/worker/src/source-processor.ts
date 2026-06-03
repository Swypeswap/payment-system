import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  LAMPORTS_PER_SOL,
  PAYOUT_FEE_BUFFER_LAMPORTS,
  WRAPPED_SOL_MINT,
  decryptSecret,
  decryptVersionedSourceSecret,
  encryptSecret,
  grossUpPrivacyCashWithdrawal,
  parseSecretKey,
  planOwnerPrivacyCashDistribution,
  validateSolanaWalletAddress
} from "@payment/shared";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  type Keypair
} from "@solana/web3.js";
import { db, unwrap, workerAudit } from "./db.js";
import { env } from "./env.js";
import {
  getOrderOutputLamports,
  getOrderPriceImpactPercent,
  getSolUsdPrice,
  getSwapOrder,
  getTokenInfo,
  signAndExecuteSwap
} from "./jupiter.js";
import {
  sendOwnersActionMessage,
  sendOwnersMessage,
  sendRoute
} from "./notifications.js";
import {
  createPrivacyCashClient,
  loadPrivacyCashFeeConfig,
  withPrivacyCashLease
} from "./privacy-cash.js";
import {
  loadCurrentPerformerConfig,
  sourceSyncConfigured,
  syncExternalSource
} from "./source-db.js";

const connection = new Connection(env.SOLANA_RPC_URL, "confirmed");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qeqBBwE72Gf9c5TxhVJ2p8Cpb";
const SOURCE_SYNC_AUDIT_THROTTLE_MS = 10 * 60 * 1000;
let lastSourceSyncIssueKey: string | null = null;
let lastSourceSyncIssueAt = 0;

interface TokenBalance {
  mint: string;
  tokenAccount: string;
  amountRaw: string;
  decimals: number;
  amount: number;
  isNative: boolean;
}

interface ExternalRevenueWallet {
  id: string;
  domain: string;
  address: string;
  encrypted_private_key_blob: string | null;
  mirror_status: "active" | "retired" | "key_erased";
  external_performer_id: string | number | null;
  empty_since: string | null;
}

interface CompanyWallet {
  id: string;
  address: string;
  encrypted_private_key: string | null;
  encryption_nonce: string | null;
  encryption_auth_tag: string | null;
  encryption_key_version: number | null;
  status: "active" | "archived" | "key_erased";
  activated_at: string;
  archived_at: string | null;
  empty_since: string | null;
  received_volume_usd: string | number;
}

interface CompanyShieldJob {
  id: string;
  company_wallet_id: string;
  shield_raw: string | number;
  status?: "pending" | "processing";
  private_balance_before_raw?: string | number | null;
}

interface CompanyWithdrawalJob {
  id: string;
  payout_batch_id: string;
  company_wallet_id: string;
  recipient_kind: "owner_1" | "owner_2" | "owner_3";
  recipient_wallet_address: string;
  net_raw: string | number;
}

function sol(raw: bigint | number | string) {
  return `${Number(raw) / LAMPORTS_PER_SOL} SOL`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function auditSourceSyncIssue(action: "source.sync_skipped" | "source.sync_failed", metadata: Record<string, unknown>) {
  const key = `${action}:${metadata.reason ?? metadata.error ?? ""}`;
  const now = Date.now();
  if (lastSourceSyncIssueKey === key && now - lastSourceSyncIssueAt < SOURCE_SYNC_AUDIT_THROTTLE_MS) {
    return;
  }
  lastSourceSyncIssueKey = key;
  lastSourceSyncIssueAt = now;
  await workerAudit(action, "source_sync", undefined, metadata);
}

function decimalAmount(raw: string | number | bigint, decimals: number) {
  const value = BigInt(raw);
  if (decimals <= 0) return value.toString();
  const text = value.toString().padStart(decimals + 1, "0");
  const whole = text.slice(0, -decimals);
  const fraction = text.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function displayAsset(asset: Record<string, unknown>) {
  const mint = String(asset.asset ?? "");
  const name = mint === "SOL"
    ? "SOL"
    : mint === MAINNET_USDC_MINT
      ? "USDC"
      : `SPL ${mint.slice(0, 6)}...${mint.slice(-4)}`;
  return `${name}: ${decimalAmount(String(asset.rawAmount ?? 0), Number(asset.decimals ?? 0))}`;
}

function toSafeLamports(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Lamport amount exceeds JavaScript safe integer range");
  }
  return Number(value);
}

function percentLamports(total: bigint, percent: number) {
  return total * BigInt(Math.floor(percent * 10_000)) / 1_000_000n;
}

function randomReleaseTime(minimumHours: number, maximumHours: number) {
  const minimumSeconds = Math.ceil(minimumHours * 60 * 60);
  const maximumSeconds = Math.floor(maximumHours * 60 * 60);
  return new Date(Date.now() + randomInt(minimumSeconds, maximumSeconds + 1) * 1000).toISOString();
}

function randomLegWeights() {
  return Array.from({ length: randomInt(2, 5) }, () => randomInt(80, 121));
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function lifecycleToken() {
  return randomBytes(24).toString("base64url");
}

function getSourceSigner(wallet: ExternalRevenueWallet): Keypair {
  if (!env.SOURCE_INTERMEDIATE_WALLET_ENCRYPTION_KEY) {
    throw new Error("SOURCE_INTERMEDIATE_WALLET_ENCRYPTION_KEY is required to sign revenue-wallet transfers");
  }
  if (!wallet.encrypted_private_key_blob) {
    throw new Error("Revenue-wallet encrypted private key has been erased");
  }
  const secret = decryptVersionedSourceSecret(
    wallet.encrypted_private_key_blob,
    env.SOURCE_INTERMEDIATE_WALLET_ENCRYPTION_KEY
  );
  const signer = parseSecretKey(secret);
  if (signer.publicKey.toBase58() !== wallet.address) {
    throw new Error("Source private key does not match the mirrored revenue wallet address");
  }
  return signer;
}

function getCompanySigner(wallet: CompanyWallet): Keypair {
  if (!wallet.encrypted_private_key || !wallet.encryption_nonce || !wallet.encryption_auth_tag || !wallet.encryption_key_version) {
    throw new Error("Company wallet private key has been erased");
  }
  const secret = decryptSecret(
    {
      ciphertext: wallet.encrypted_private_key,
      nonce: wallet.encryption_nonce,
      authTag: wallet.encryption_auth_tag,
      keyVersion: wallet.encryption_key_version
    },
    env.MASTER_ENCRYPTION_KEY
  );
  const signer = parseSecretKey(secret);
  if (signer.publicKey.toBase58() !== wallet.address) {
    throw new Error("Company private key does not match the company wallet address");
  }
  return signer;
}

async function getTokenBalances(owner: PublicKey): Promise<TokenBalance[]> {
  const [classic, token2022] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID })
  ]);
  return [...classic.value, ...token2022.value]
    .map(({ account, pubkey }) => {
      const info = account.data.parsed.info;
      const amount = info.tokenAmount;
      return {
        mint: info.mint as string,
        tokenAccount: pubkey.toBase58(),
        amountRaw: amount.amount as string,
        decimals: amount.decimals as number,
        amount: Number(amount.uiAmountString),
        isNative: Boolean(info.isNative)
      };
    })
    .filter((balance) => BigInt(balance.amountRaw) > 0n);
}

async function loadSettings() {
  return unwrap(await db.from("app_settings").select("*").eq("id", true).single());
}

async function activeCompanyWallet(): Promise<CompanyWallet | null> {
  const result = await db
    .from("company_wallets")
    .select("*")
    .eq("status", "active")
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  return result.data as CompanyWallet | null;
}

async function loadCompanyWallet(id: string) {
  return unwrap(await db.from("company_wallets").select("*").eq("id", id).single()) as CompanyWallet;
}

async function createReviewItem(values: {
  wallet: ExternalRevenueWallet | CompanyWallet;
  walletKind: "external_revenue" | "company";
  reasonKey: string;
  message: string;
  severity?: "warning" | "high" | "critical";
  metadata?: Record<string, unknown>;
  routeKind:
    | "unsafe_spl_detected"
    | "awaiting_sol_for_fees"
    | "performer_configuration_invalid"
    | "swap_failed"
    | "worker_error";
}) {
  const row = {
    reason_key: values.reasonKey,
    wallet_kind: values.walletKind,
    external_revenue_wallet_id: values.walletKind === "external_revenue" ? values.wallet.id : null,
    company_wallet_id: values.walletKind === "company" ? values.wallet.id : null,
    severity: values.severity ?? "warning",
    message: values.message,
    metadata: values.metadata ?? {}
  };
  const result = await db.from("review_required_items").insert(row).select("id").maybeSingle();
  if (result.error?.code === "23505") return false;
  if (result.error) throw new Error(result.error.message);
  await sendRoute(values.routeKind, {
    content: values.severity === "critical" ? "@everyone" : undefined,
    embeds: [{
      title: "Review required",
      color: values.severity === "critical" ? 0xff315f : 0xffb15e,
      fields: [
        { name: "Wallet", value: values.wallet.address },
        { name: "Reason", value: values.message }
      ]
    }]
  });
  await db.from("review_required_items").update({ notified_at: new Date().toISOString() }).eq("id", result.data?.id);
  return true;
}

async function recordExternalBalance(wallet: ExternalRevenueWallet, solLamports: bigint, tokenBalances: TokenBalance[]) {
  let solUsdPrice: number | null = null;
  try {
    solUsdPrice = await getSolUsdPrice();
  } catch {
    // Keep the balance snapshot even when pricing is temporarily unavailable.
  }
  const now = new Date().toISOString();
  unwrap(
    await db
      .from("external_revenue_balance_snapshots")
      .insert({
        external_revenue_wallet_id: wallet.id,
        sol_lamports: solLamports.toString(),
        token_balances: tokenBalances,
        sol_usd_price: solUsdPrice,
        estimated_sol_value_usd: solUsdPrice === null ? null : Number(solLamports) / LAMPORTS_PER_SOL * solUsdPrice
      })
      .select("id")
      .single()
  );
  unwrap(
    await db
      .from("external_revenue_wallets")
      .update({
        current_sol_lamports: solLamports.toString(),
        current_token_balances: tokenBalances,
        last_balance_checked_at: now,
        empty_since: solLamports === 0n && tokenBalances.length === 0
          ? wallet.empty_since ?? now
          : null
      })
      .eq("id", wallet.id)
      .select("id")
      .single()
  );
  return solUsdPrice;
}

async function recordCompanyBalance(wallet: CompanyWallet, solLamports: bigint, tokenBalances: TokenBalance[]) {
  const now = new Date().toISOString();
  unwrap(
    await db
      .from("company_wallets")
      .update({
        current_sol_lamports: solLamports.toString(),
        current_token_balances: tokenBalances,
        last_balance_checked_at: now,
        empty_since: solLamports === 0n && tokenBalances.length === 0
          ? wallet.empty_since ?? now
          : null
      })
      .eq("id", wallet.id)
      .select("id")
      .single()
  );
}

async function recordRevenueSwap(wallet: ExternalRevenueWallet, values: Record<string, unknown>) {
  const { error } = await db.from("external_revenue_swap_attempts").insert({
    external_revenue_wallet_id: wallet.id,
    ...values
  });
  if (error) throw new Error(error.message);
}

async function hasRecentTokenAttempt(wallet: ExternalRevenueWallet, token: TokenBalance) {
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const result = await db
    .from("external_revenue_swap_attempts")
    .select("id")
    .eq("external_revenue_wallet_id", wallet.id)
    .eq("input_mint", token.mint)
    .eq("input_amount_raw", token.amountRaw)
    .gte("created_at", sixHoursAgo)
    .in("status", ["waiting", "skipped", "review_required", "failed"])
    .limit(1);
  if (result.error) throw new Error(result.error.message);
  return result.data.length > 0;
}

async function unwrapWrappedSol(wallet: ExternalRevenueWallet, token: TokenBalance, signer: Keypair) {
  if (env.DRY_RUN) {
    return recordRevenueSwap(wallet, {
      input_mint: token.mint,
      input_amount_raw: token.amountRaw,
      estimated_output_lamports: token.amountRaw,
      status: "skipped",
      reason: "DRY_RUN is enabled; wrapped SOL would be unwrapped"
    });
  }
  const signature = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      new TransactionInstruction({
        programId: TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: new PublicKey(token.tokenAccount), isSigner: false, isWritable: true },
          { pubkey: signer.publicKey, isSigner: false, isWritable: true },
          { pubkey: signer.publicKey, isSigner: true, isWritable: false }
        ],
        data: Buffer.from([9])
      })
    ),
    [signer],
    { commitment: "confirmed" }
  );
  await recordRevenueSwap(wallet, {
    input_mint: token.mint,
    input_amount_raw: token.amountRaw,
    actual_output_lamports: token.amountRaw,
    status: "succeeded",
    reason: "Wrapped SOL unwrapped to native SOL",
    signature
  });
}

async function swapRevenueToken(
  wallet: ExternalRevenueWallet,
  token: TokenBalance,
  signer: Keypair,
  settings: Record<string, any>
) {
  if (await hasRecentTokenAttempt(wallet, token)) return;
  if (token.mint === WRAPPED_SOL_MINT && token.isNative) {
    return unwrapWrappedSol(wallet, token, signer);
  }
  const info = await getTokenInfo(token.mint);
  if (!info) {
    await recordRevenueSwap(wallet, {
      input_mint: token.mint,
      input_amount_raw: token.amountRaw,
      status: "review_required",
      reason: "Jupiter returned no trustworthy token metadata"
    });
    return createReviewItem({
      wallet,
      walletKind: "external_revenue",
      reasonKey: `unsafe-token:${token.mint}`,
      message: "Jupiter returned no trustworthy token metadata",
      metadata: { mint: token.mint },
      routeKind: "unsafe_spl_detected"
    });
  }
  if (info.verification?.toLowerCase() === "banned" || info.audit?.isSus) {
    await recordRevenueSwap(wallet, {
      input_mint: token.mint,
      input_amount_raw: token.amountRaw,
      status: "review_required",
      reason: "Jupiter flagged this token as suspicious"
    });
    return createReviewItem({
      wallet,
      walletKind: "external_revenue",
      reasonKey: `unsafe-token:${token.mint}`,
      message: "Jupiter flagged this token as suspicious",
      metadata: { mint: token.mint },
      routeKind: "unsafe_spl_detected"
    });
  }
  const usdPrice = Number(info.usdPrice);
  if (!Number.isFinite(usdPrice) || usdPrice <= 0) {
    await recordRevenueSwap(wallet, {
      input_mint: token.mint,
      input_amount_raw: token.amountRaw,
      status: "review_required",
      reason: "No reliable USD price is available"
    });
    return createReviewItem({
      wallet,
      walletKind: "external_revenue",
      reasonKey: `unsafe-token:${token.mint}`,
      message: "No reliable USD price is available",
      metadata: { mint: token.mint },
      routeKind: "unsafe_spl_detected"
    });
  }
  const estimatedUsdValue = token.amount * usdPrice;
  if (estimatedUsdValue < Number(settings.revenue_dust_threshold_usd)) {
    return recordRevenueSwap(wallet, {
      input_mint: token.mint,
      input_amount_raw: token.amountRaw,
      estimated_usd_value: estimatedUsdValue,
      status: "skipped",
      reason: "Below revenue dust threshold"
    });
  }
  const organicScore = Number(info.organicScore ?? 0);
  if (organicScore < Number(settings.min_organic_score ?? 0)) {
    await recordRevenueSwap(wallet, {
      input_mint: token.mint,
      input_amount_raw: token.amountRaw,
      estimated_usd_value: estimatedUsdValue,
      status: "review_required",
      reason: `Organic score ${organicScore} is below the configured minimum`
    });
    return createReviewItem({
      wallet,
      walletKind: "external_revenue",
      reasonKey: `unsafe-token:${token.mint}`,
      message: `Organic score ${organicScore} is below the configured minimum`,
      metadata: { mint: token.mint, estimatedUsdValue },
      routeKind: "unsafe_spl_detected"
    });
  }
  const order = await getSwapOrder(token.mint, token.amountRaw, signer.publicKey.toBase58());
  const outputLamports = getOrderOutputLamports(order);
  const priceImpactPct = getOrderPriceImpactPercent(order);
  if (priceImpactPct > Number(settings.max_price_impact_pct)) {
    await recordRevenueSwap(wallet, {
      input_mint: token.mint,
      input_amount_raw: token.amountRaw,
      estimated_usd_value: estimatedUsdValue,
      estimated_output_lamports: outputLamports.toString(),
      status: "review_required",
      reason: `Estimated price impact ${priceImpactPct.toFixed(4)}% exceeds the configured maximum`
    });
    return createReviewItem({
      wallet,
      walletKind: "external_revenue",
      reasonKey: `unsafe-token:${token.mint}`,
      message: `Estimated price impact ${priceImpactPct.toFixed(4)}% exceeds the configured maximum`,
      metadata: { mint: token.mint, estimatedUsdValue },
      routeKind: "unsafe_spl_detected"
    });
  }
  if (env.DRY_RUN || !settings.live_payouts_enabled) {
    return recordRevenueSwap(wallet, {
      input_mint: token.mint,
      input_amount_raw: token.amountRaw,
      estimated_usd_value: estimatedUsdValue,
      estimated_output_lamports: outputLamports.toString(),
      status: "skipped",
      reason: env.DRY_RUN ? "DRY_RUN is enabled" : "Live payouts are disabled"
    });
  }
  const result = await signAndExecuteSwap(order, signer);
  await recordRevenueSwap(wallet, {
    input_mint: token.mint,
    input_amount_raw: token.amountRaw,
    estimated_usd_value: estimatedUsdValue,
    estimated_output_lamports: outputLamports.toString(),
    actual_output_lamports: result.outputAmount ?? result.outAmount ?? null,
    status: "succeeded",
    signature: result.signature
  });
  await sendRoute("revenue_swap_completed", {
    embeds: [{
      title: "Revenue token swapped to SOL",
      color: 0x64f5b5,
      fields: [
        { name: "Domain", value: wallet.domain },
        { name: "Mint", value: token.mint },
        { name: "Estimated output", value: sol(outputLamports) },
        { name: "Signature", value: result.signature }
      ]
    }]
  });
}

async function splitRevenueSol(
  wallet: ExternalRevenueWallet,
  signer: Keypair,
  settings: Record<string, any>,
  sourceBalanceLamports: bigint,
  solUsdPrice: number | null
) {
  const performer = await loadCurrentPerformerConfig(wallet.external_performer_id);
  if (!performer?.approved || !performer.payoutWallet || performer.commissionPct === null) {
    return createReviewItem({
      wallet,
      walletKind: "external_revenue",
      reasonKey: `performer-invalid:${wallet.external_performer_id ?? "missing"}`,
      message: "Performer approval, payout wallet, or commission is missing",
      metadata: { performerId: wallet.external_performer_id },
      routeKind: "performer_configuration_invalid",
      severity: "high"
    });
  }
  const performerWallet = validateSolanaWalletAddress(performer.payoutWallet);
  const companyWallet = await activeCompanyWallet();
  if (!companyWallet) {
    return createReviewItem({
      wallet,
      walletKind: "external_revenue",
      reasonKey: "company-wallet-missing",
      message: "No active company wallet is configured",
      routeKind: "performer_configuration_invalid",
      severity: "high"
    });
  }
  const reserveLamports =
    BigInt(Math.ceil(Number(settings.revenue_wallet_sol_reserve) * LAMPORTS_PER_SOL));
  const spendable = sourceBalanceLamports - reserveLamports;
  if (spendable <= BigInt(PAYOUT_FEE_BUFFER_LAMPORTS)) return;
  const spendableUsd = solUsdPrice === null ? null : Number(spendable) / LAMPORTS_PER_SOL * solUsdPrice;
  if (spendableUsd !== null && spendableUsd < Number(settings.revenue_dust_threshold_usd)) return;

  const performerLamports = percentLamports(spendable, performer.commissionPct);
  if (performerLamports <= 0n) return;
  const transaction = new Transaction();
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: new PublicKey(performerWallet),
      lamports: toSafeLamports(performerLamports)
    })
  );
  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = latest.blockhash;
  transaction.feePayer = signer.publicKey;
  const fee = BigInt((await connection.getFeeForMessage(transaction.compileMessage(), "confirmed")).value ?? PAYOUT_FEE_BUFFER_LAMPORTS);
  const companyLamports = sourceBalanceLamports - reserveLamports - performerLamports - fee;
  if (companyLamports <= 0n) return;
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: new PublicKey(companyWallet.address),
      lamports: toSafeLamports(companyLamports)
    })
  );
  const finalFee = BigInt((await connection.getFeeForMessage(transaction.compileMessage(), "confirmed")).value ?? Number(fee));
  const finalCompanyLamports = sourceBalanceLamports - reserveLamports - performerLamports - finalFee;
  if (finalCompanyLamports <= 0n) return;
  transaction.instructions.pop();
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: new PublicKey(companyWallet.address),
      lamports: toSafeLamports(finalCompanyLamports)
    })
  );
  transaction.sign(signer);
  const signature = transaction.signature?.toString("base64")
    ? transaction.signatures[0]?.signature?.toString("hex") ?? randomUUID()
    : randomUUID();
  const idempotencyKey = createHash("sha256")
    .update(`source-split:${wallet.id}:${sourceBalanceLamports}:${performerWallet}:${performer.commissionPct}:${companyWallet.id}`)
    .digest("hex");
  const estimatedCompanyUsd = solUsdPrice === null ? null : Number(finalCompanyLamports) / LAMPORTS_PER_SOL * solUsdPrice;
  const attempt = unwrap(
    await db
      .from("external_revenue_split_attempts")
      .upsert({
        external_revenue_wallet_id: wallet.id,
        company_wallet_id: companyWallet.id,
        idempotency_key: idempotencyKey,
        performer_telegram_user_id: performer.telegramUserId,
        performer_wallet_address: performerWallet,
        commission_pct: performer.commissionPct,
        source_balance_lamports: sourceBalanceLamports.toString(),
        reserve_lamports: reserveLamports.toString(),
        fee_lamports: finalFee.toString(),
        performer_lamports: performerLamports.toString(),
        company_lamports: finalCompanyLamports.toString(),
        estimated_company_usd: estimatedCompanyUsd,
        raw_transaction_base64: Buffer.from(transaction.serialize()).toString("base64"),
        last_valid_block_height: latest.lastValidBlockHeight,
        status: env.DRY_RUN || !settings.live_payouts_enabled ? "dry_run" : "submitted",
        error: env.DRY_RUN ? "DRY_RUN is enabled" : !settings.live_payouts_enabled ? "Live payouts are disabled" : null
      }, { onConflict: "idempotency_key" })
      .select("*")
      .single()
  );
  if (attempt.signature || attempt.status === "dry_run") return;
  if (env.DRY_RUN || !settings.live_payouts_enabled) return;

  const txSignature = await connection.sendRawTransaction(Buffer.from(attempt.raw_transaction_base64, "base64"), {
    skipPreflight: false,
    maxRetries: 3
  });
  unwrap(
    await db
      .from("external_revenue_split_attempts")
      .update({ signature: txSignature })
      .eq("id", attempt.id)
      .select("id")
      .single()
  );
  const confirmation = await connection.confirmTransaction({
    signature: txSignature,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight
  }, "confirmed");
  const succeeded = !confirmation.value.err;
  unwrap(
    await db
      .from("external_revenue_split_attempts")
      .update({
        status: succeeded ? "succeeded" : "failed",
        error: succeeded ? null : JSON.stringify(confirmation.value.err)
      })
      .eq("id", attempt.id)
      .select("id")
      .single()
  );
  if (!succeeded) return;
  unwrap(
    await db
      .from("company_wallet_receipts")
      .insert({
        company_wallet_id: companyWallet.id,
        external_revenue_split_attempt_id: attempt.id,
        amount_lamports: finalCompanyLamports.toString(),
        estimated_usd: estimatedCompanyUsd
      })
      .select("id")
      .single()
  );
  const receipts = unwrap(
    await db.from("company_wallet_receipts").select("estimated_usd").eq("company_wallet_id", companyWallet.id)
  ) as Array<{ estimated_usd: string | number | null }>;
  const receivedVolumeUsd = receipts.reduce((total, receipt) => total + Number(receipt.estimated_usd ?? 0), 0);
  unwrap(
    await db
      .from("company_wallets")
      .update({ received_volume_usd: receivedVolumeUsd })
      .eq("id", companyWallet.id)
      .select("id")
      .single()
  );
  await sendRoute("revenue_split_completed", {
    embeds: [{
      title: "Revenue split completed",
      color: 0x64f5b5,
      fields: [
        { name: "Domain", value: wallet.domain },
        { name: "Performer", value: `${sol(performerLamports)} (${performer.commissionPct}%)` },
        { name: "Company", value: sol(finalCompanyLamports) },
        { name: "Signature", value: txSignature }
      ]
    }]
  });
}

export async function processExternalRevenueWallet(walletId: string) {
  const lock = unwrap(
    await db.rpc("acquire_external_revenue_wallet_lock", {
      requested_wallet_id: walletId,
      requested_lock_owner: env.WORKER_ID,
      lease_seconds: 180
    })
  );
  if (!lock) return;
  try {
    const wallet = unwrap(
      await db.from("external_revenue_wallets").select("*").eq("id", walletId).single()
    ) as ExternalRevenueWallet;
    if (wallet.mirror_status === "key_erased") return;
    const settings = await loadSettings();
    if (!settings.source_sync_enabled) return;
    const signer = getSourceSigner(wallet);
    let tokenBalances = await getTokenBalances(signer.publicKey);
    let solLamports = BigInt(await connection.getBalance(signer.publicKey, "confirmed"));
    let solUsdPrice = await recordExternalBalance(wallet, solLamports, tokenBalances);
    if (settings.emergency_paused) return;

    const reserveLamports =
      BigInt(Math.ceil(Number(settings.revenue_wallet_sol_reserve) * LAMPORTS_PER_SOL));
    if (tokenBalances.length && solLamports <= reserveLamports + BigInt(PAYOUT_FEE_BUFFER_LAMPORTS)) {
      await createReviewItem({
        wallet,
        walletKind: "external_revenue",
        reasonKey: "awaiting-sol-fees",
        message: "SPL tokens are waiting for enough SOL to pay swap fees",
        metadata: { tokenCount: tokenBalances.length },
        routeKind: "awaiting_sol_for_fees"
      });
      return;
    }
    if (settings.swaps_enabled) {
      for (const token of tokenBalances) {
        try {
          await swapRevenueToken(wallet, token, signer, settings);
        } catch (error) {
          await recordRevenueSwap(wallet, {
            input_mint: token.mint,
            input_amount_raw: token.amountRaw,
            status: "failed",
            reason: error instanceof Error ? error.message : String(error)
          });
          await createReviewItem({
            wallet,
            walletKind: "external_revenue",
            reasonKey: `swap-failed:${token.mint}`,
            message: error instanceof Error ? error.message : String(error),
            metadata: { mint: token.mint },
            routeKind: "swap_failed"
          });
        }
      }
      tokenBalances = await getTokenBalances(signer.publicKey);
      solLamports = BigInt(await connection.getBalance(signer.publicKey, "confirmed"));
      solUsdPrice = await recordExternalBalance(wallet, solLamports, tokenBalances);
    }
    await splitRevenueSol(wallet, signer, settings, solLamports, solUsdPrice);
  } catch (error) {
    await workerAudit("external_revenue.processing_failed", "external_revenue_wallet", walletId, {
      error: error instanceof Error ? error.message : String(error)
    });
    await sendRoute("worker_error", {
      content: `External revenue wallet processing failed for ${walletId}: ${error instanceof Error ? error.message : String(error)}`
    });
  } finally {
    await db.rpc("release_external_revenue_wallet_lock", {
      requested_wallet_id: walletId,
      requested_lock_owner: env.WORKER_ID
    });
  }
}

export async function reconcileExternalRevenueWallets() {
  const wallets = unwrap(
    await db
      .from("external_revenue_wallets")
      .select("id")
      .in("mirror_status", ["active", "retired"])
      .not("encrypted_private_key_blob", "is", null)
  ) as Array<{ id: string }>;
  for (const wallet of wallets) await processExternalRevenueWallet(wallet.id);
}

function getEventSignature(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.signature === "string") return payload.signature;
  const events = payload.events as Record<string, { signature?: string }> | undefined;
  for (const event of Object.values(events ?? {})) {
    if (event.signature) return event.signature;
  }
  return undefined;
}

async function isSourceInternalSignature(signature: string) {
  const [swaps, splits, shields, withdrawals] = await Promise.all([
    db.from("external_revenue_swap_attempts").select("id").eq("signature", signature).limit(1),
    db.from("external_revenue_split_attempts").select("id").eq("signature", signature).limit(1),
    db.from("company_privacy_cash_shield_jobs").select("id").eq("signature", signature).limit(1),
    db.from("company_privacy_cash_withdrawal_jobs").select("id").eq("signature", signature).limit(1)
  ]);
  if (swaps.error) throw new Error(swaps.error.message);
  if (splits.error) throw new Error(splits.error.message);
  if (shields.error) throw new Error(shields.error.message);
  if (withdrawals.error) throw new Error(withdrawals.error.message);
  return Boolean(swaps.data.length || splits.data.length || shields.data.length || withdrawals.data.length);
}

export async function processSourceChainEvent(event: { id: string; payload: Record<string, unknown> }) {
  const settings = await loadSettings();
  if (!settings.source_sync_enabled) return;
  const signature = getEventSignature(event.payload);
  if (!signature || await isSourceInternalSignature(signature)) return;
  const [wallets, companies] = await Promise.all([
    db.from("external_revenue_wallets").select("id,domain,address,mirror_status").in("mirror_status", ["active", "retired", "key_erased"]),
    db.from("company_wallets").select("id,address,status").in("status", ["active", "archived"])
  ]);
  if (wallets.error) throw new Error(wallets.error.message);
  if (companies.error) throw new Error(companies.error.message);
  const revenueByAddress = new Map(wallets.data.map((wallet) => [wallet.address, wallet]));
  const companyByAddress = new Map(companies.data.map((wallet) => [wallet.address, wallet]));
  const affectedRevenue = new Map<string, Array<Record<string, unknown>>>();
  let companyTouched = false;
  const accountData = Array.isArray(event.payload.accountData) ? event.payload.accountData : [];

  for (const rawAccount of accountData) {
    const account = rawAccount as {
      account?: string;
      nativeBalanceChange?: number;
      tokenBalanceChanges?: Array<{
        mint?: string;
        userAccount?: string;
        rawTokenAmount?: { tokenAmount?: string; decimals?: number };
      }>;
    };
    const nativeWallet = account.account ? revenueByAddress.get(account.account) : undefined;
    if (nativeWallet && Number(account.nativeBalanceChange) > 0) {
      const assets = affectedRevenue.get(nativeWallet.id) ?? [];
      assets.push({ asset: "SOL", rawAmount: String(account.nativeBalanceChange), decimals: 9 });
      affectedRevenue.set(nativeWallet.id, assets);
    }
    if (account.account && companyByAddress.has(account.account) && Number(account.nativeBalanceChange) > 0) {
      companyTouched = true;
    }
    for (const change of account.tokenBalanceChanges ?? []) {
      const wallet = change.userAccount ? revenueByAddress.get(change.userAccount) : undefined;
      const amount = change.rawTokenAmount?.tokenAmount;
      if (!wallet || !change.mint || !amount || BigInt(amount) <= 0n) continue;
      const assets = affectedRevenue.get(wallet.id) ?? [];
      assets.push({ asset: change.mint, rawAmount: amount, decimals: change.rawTokenAmount?.decimals ?? 0 });
      affectedRevenue.set(wallet.id, assets);
    }
  }

  for (const [walletId, assets] of affectedRevenue) {
    const wallet = wallets.data.find((item) => item.id === walletId);
    if (!wallet) continue;
    if (wallet.mirror_status === "key_erased") {
      await sendRoute("erased_revenue_wallet_received_funds", {
        content: "@everyone",
        embeds: [{
          title: "Funds arrived after irreversible key erasure",
          color: 0xff315f,
          fields: [
            { name: "Domain", value: wallet.domain },
            { name: "Address", value: wallet.address },
            { name: "Signature", value: signature }
          ]
        }]
      });
      continue;
    }
    const insert = await db
      .from("external_revenue_deposits")
      .insert({
        chain_event_id: event.id,
        external_revenue_wallet_id: walletId,
        signature,
        assets
      })
      .select("id")
      .maybeSingle();
    if (insert.error?.code !== "23505" && insert.error) throw new Error(insert.error.message);
    if (insert.data) {
      await sendRoute("revenue_deposit_received", {
        embeds: [{
          title: "Revenue wallet received funds",
          color: 0x64f5b5,
          fields: [
            { name: "Domain", value: wallet.domain },
            { name: "SOL / USDC / SPL received", value: assets.map(displayAsset).join("\n") },
            { name: "Signature", value: signature }
          ]
        }]
      });
    }
    await processExternalRevenueWallet(walletId);
  }
  if (companyTouched) await reconcileCompanyWallets();
}

async function loadOwners() {
  const owners = unwrap(
    await db.from("owner_profiles").select("*").eq("active", true).order("created_at")
  ) as Array<{ id: string; display_name: string; discord_user_id: string; solana_wallet_address: string | null }>;
  if (owners.length !== 3 || owners.some((owner) => !owner.solana_wallet_address)) {
    throw new Error("Configure exactly three active owner profiles with Solana wallets");
  }
  return owners.map((owner) => ({
    ...owner,
    solana_wallet_address: validateSolanaWalletAddress(owner.solana_wallet_address ?? "")
  }));
}

async function executeCompanyShieldJob(signer: Keypair, shieldJob: CompanyShieldJob) {
  if (env.SOLANA_CLUSTER !== "mainnet-beta") {
    throw new Error("Privacy Cash live transfers require SOLANA_CLUSTER=mainnet-beta");
  }
  return withPrivacyCashLease(async () => {
    const client = createPrivacyCashClient(signer);
    const balance = (await client.getPrivateBalance()).lamports;
    unwrap(
      await db
        .from("company_privacy_cash_shield_jobs")
        .update({ status: "processing", private_balance_before_raw: String(balance), error: null })
        .eq("id", shieldJob.id)
        .select("id")
        .single()
    );
    try {
      const deposit = await client.deposit({ lamports: toSafeLamports(BigInt(shieldJob.shield_raw)) });
      return unwrap(
        await db
          .from("company_privacy_cash_shield_jobs")
          .update({ status: "succeeded", signature: deposit.tx, error: null })
          .eq("id", shieldJob.id)
          .select("*")
          .single()
      ) as CompanyShieldJob;
    } catch (error) {
      unwrap(
        await db
          .from("company_privacy_cash_shield_jobs")
          .update({ status: "review_required", error: error instanceof Error ? error.message : String(error) })
          .eq("id", shieldJob.id)
          .select("id")
          .single()
      );
      throw error;
    }
  });
}

async function planCompanyOwnerPayout(
  wallet: CompanyWallet,
  shieldJob: CompanyShieldJob,
  status: "dry_run" | "pending",
  settings: Record<string, any>
) {
  const owners = await loadOwners();
  const feeConfig = await loadPrivacyCashFeeConfig();
  let plan;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    plan = planOwnerPrivacyCashDistribution(
      BigInt(shieldJob.shield_raw),
      feeConfig,
      [randomLegWeights(), randomLegWeights(), randomLegWeights()]
    );
    if (plan.withdrawals.every((withdrawal) =>
      withdrawal.netLamports >= BigInt(feeConfig.minimumWithdrawalRaw)
    )) {
      break;
    }
    plan = undefined;
  }
  if (!plan) throw new Error("Shielded company balance is too small for randomized owner payout legs");
  const batch = unwrap(
    await db
      .from("company_privacy_cash_payout_batches")
      .upsert({
        shield_job_id: shieldJob.id,
        company_wallet_id: wallet.id,
        owner_wallet_addresses: owners.map((owner) => owner.solana_wallet_address),
        shield_raw: String(shieldJob.shield_raw),
        net_distribution_raw: plan.netDistributionLamports.toString(),
        estimated_fee_raw: plan.estimatedFeeLamports.toString(),
        dust_raw: plan.dustLamports.toString(),
        status
      }, { onConflict: "shield_job_id" })
      .select("*")
      .single()
  );
  const solUsd = await getSolUsdPrice();
  const rows = plan.withdrawals.map((withdrawal) => {
    const ownerIndex = Number(withdrawal.recipientKind.slice(-1)) - 1;
    const owner = owners[ownerIndex];
    if (!owner) {
      throw new Error(`Owner payout plan referenced missing owner index ${ownerIndex + 1}`);
    }
    return {
      payout_batch_id: batch.id,
      company_wallet_id: wallet.id,
      recipient_kind: withdrawal.recipientKind,
      recipient_key: `owner:${owner.id}`,
      owner_profile_id: owner.id,
      leg_index: withdrawal.legIndex,
      recipient_wallet_address: owner.solana_wallet_address,
      net_raw: withdrawal.netLamports.toString(),
      gross_raw: withdrawal.grossLamports.toString(),
      estimated_fee_raw: withdrawal.estimatedFeeLamports.toString(),
      estimated_usd: Number(withdrawal.netLamports) / LAMPORTS_PER_SOL * solUsd,
      scheduled_for: randomReleaseTime(settings.privacy_min_delay_hours, settings.privacy_max_delay_hours),
      status
    };
  });
  const { error } = await db
    .from("company_privacy_cash_withdrawal_jobs")
    .upsert(rows, { onConflict: "payout_batch_id,recipient_key,leg_index", ignoreDuplicates: true });
  if (error) throw new Error(error.message);
  await sendRoute("company_privacy_cash_deposited", {
    embeds: [{
      title: "Company funds deposited into Privacy Cash",
      color: 0x64f5b5,
      fields: [
        { name: "Company wallet", value: wallet.address },
        { name: "Shielded", value: sol(shieldJob.shield_raw) },
        { name: "Randomized owner legs", value: String(rows.length) }
      ]
    }]
  });
}

async function shieldCompanyIfEligible(
  wallet: CompanyWallet,
  signer: Keypair,
  solLamports: bigint,
  settings: Record<string, any>
) {
  if (!settings.privacy_cash_enabled || settings.emergency_paused) return;
  const reserveLamports =
    BigInt(Math.ceil(Number(settings.company_wallet_sol_reserve) * LAMPORTS_PER_SOL)) +
    BigInt(PAYOUT_FEE_BUFFER_LAMPORTS);
  const available = solLamports - reserveLamports;
  if (available <= 0n) return;
  const solUsdPrice = await getSolUsdPrice();
  const availableUsd = Number(available) / LAMPORTS_PER_SOL * solUsdPrice;
  if (availableUsd < Number(settings.company_privacy_cash_threshold_usd)) return;
  await sendRoute("company_threshold_reached", {
    embeds: [{
      title: "Company wallet threshold reached",
      color: 0xffb15e,
      fields: [
        { name: "Wallet", value: wallet.address },
        { name: "Available", value: `${sol(available)} (~$${availableUsd.toFixed(2)})` }
      ]
    }]
  });
  const unresolved = await db
    .from("company_privacy_cash_shield_jobs")
    .select("id,status")
    .eq("company_wallet_id", wallet.id)
    .in("status", ["pending", "processing", "review_required"])
    .limit(1)
    .maybeSingle();
  if (unresolved.error) throw new Error(unresolved.error.message);
  if (unresolved.data) return;
  const isDryRun = env.DRY_RUN || !settings.live_payouts_enabled;
  const shieldJob = unwrap(
    await db
      .from("company_privacy_cash_shield_jobs")
      .insert({
        company_wallet_id: wallet.id,
        idempotency_key: createHash("sha256").update(`company-shield:${wallet.id}:${isDryRun ? solLamports : randomUUID()}`).digest("hex"),
        source_balance_raw: solLamports.toString(),
        reserve_raw: reserveLamports.toString(),
        shield_raw: available.toString(),
        status: isDryRun ? "dry_run" : "pending",
        error: isDryRun ? env.DRY_RUN ? "DRY_RUN is enabled" : "Live payouts are disabled" : null
      })
      .select("*")
      .single()
  ) as CompanyShieldJob;
  if (isDryRun) return planCompanyOwnerPayout(wallet, shieldJob, "dry_run", settings);
  const completed = await executeCompanyShieldJob(signer, shieldJob);
  if (completed) await planCompanyOwnerPayout(wallet, completed, "pending", settings);
}

async function processCompanyWallet(wallet: CompanyWallet) {
  if (wallet.status === "key_erased") return;
  const signer = getCompanySigner(wallet);
  const tokenBalances = await getTokenBalances(signer.publicKey);
  const solLamports = BigInt(await connection.getBalance(signer.publicKey, "confirmed"));
  await recordCompanyBalance(wallet, solLamports, tokenBalances);
  const settings = await loadSettings();
  if (wallet.status === "active") {
    await shieldCompanyIfEligible(wallet, signer, solLamports, settings);
  }
}

export async function reconcileCompanyWallets() {
  const wallets = unwrap(
    await db.from("company_wallets").select("*").in("status", ["active", "archived"])
  ) as CompanyWallet[];
  for (const wallet of wallets) {
    try {
      await processCompanyWallet(wallet);
    } catch (error) {
      await workerAudit("company_wallet.processing_failed", "company_wallet", wallet.id, {
        error: error instanceof Error ? error.message : String(error)
      });
      await sendRoute("worker_error", {
        content: `Company wallet processing failed for ${wallet.address}: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }
}

async function privateBalanceRaw(signer: Keypair) {
  return (await createPrivacyCashClient(signer).getPrivateBalance()).lamports;
}

export async function recoverCompanyPrivacyCashShields() {
  const jobs = unwrap(
    await db.from("company_privacy_cash_shield_jobs").select("*").in("status", ["pending", "processing"]).order("created_at")
  ) as CompanyShieldJob[];
  const settings = await loadSettings();
  for (const job of jobs) {
    const wallet = await loadCompanyWallet(job.company_wallet_id);
    if (env.DRY_RUN || settings.emergency_paused || !settings.live_payouts_enabled || !settings.privacy_cash_enabled) continue;
    const signer = getCompanySigner(wallet);
    if (job.status === "pending") {
      const completed = await executeCompanyShieldJob(signer, job);
      if (completed) await planCompanyOwnerPayout(wallet, completed, "pending", settings);
      continue;
    }
    const recovered = await withPrivacyCashLease(async () => {
      const balance = await privateBalanceRaw(signer);
      return BigInt(balance) >= BigInt(job.private_balance_before_raw ?? 0) + BigInt(job.shield_raw);
    });
    if (recovered === null) continue;
    if (!recovered) {
      unwrap(
        await db.from("company_privacy_cash_shield_jobs").update({
          status: "review_required",
          error: "Could not confirm whether interrupted company Privacy Cash deposit succeeded"
        }).eq("id", job.id).select("id").single()
      );
      continue;
    }
    const completed = unwrap(
      await db.from("company_privacy_cash_shield_jobs").update({
        status: "succeeded",
        error: "Recovered from private balance after an interrupted deposit; signature unavailable"
      }).eq("id", job.id).select("*").single()
    ) as CompanyShieldJob;
    await planCompanyOwnerPayout(wallet, completed, "pending", settings);
  }
}

async function finalizeCompanyPrivacyCashPayout(batchId: string) {
  const batch = unwrap(
    await db.from("company_privacy_cash_payout_batches").select("*").eq("id", batchId).single()
  );
  const jobs = unwrap(
    await db.from("company_privacy_cash_withdrawal_jobs").select("*").eq("payout_batch_id", batchId)
  ) as Array<Record<string, unknown>>;
  if (jobs.some((job) => job.status === "review_required")) {
    unwrap(
      await db.from("company_privacy_cash_payout_batches").update({ status: "review_required" }).eq("id", batchId).select("id").single()
    );
    return;
  }
  if (!jobs.length || jobs.some((job) => job.status !== "succeeded")) return;
  const completed = unwrap(
    await db.from("company_privacy_cash_payout_batches").update({ status: "succeeded" }).eq("id", batchId).select("*").single()
  );
  if (completed.notification_sent_at) return;
  await sendRoute("company_privacy_cash_payout_released", {
    embeds: [{
      title: "Owner Privacy Cash payout completed",
      color: 0x64f5b5,
      fields: [
        { name: "Company wallet", value: batch.company_wallet_id },
        { name: "Net distribution", value: sol(batch.net_distribution_raw) },
        { name: "Randomized legs", value: String(jobs.length) }
      ]
    }]
  });
  unwrap(
    await db.from("company_privacy_cash_payout_batches").update({ notification_sent_at: new Date().toISOString() }).eq("id", batchId).select("id").single()
  );
}

async function processCompanyPrivacyCashWithdrawal(job: CompanyWithdrawalJob) {
  const wallet = await loadCompanyWallet(job.company_wallet_id);
  const settings = await loadSettings();
  if (env.DRY_RUN || settings.emergency_paused || !settings.live_payouts_enabled || !settings.privacy_cash_enabled) {
    unwrap(await db.from("company_privacy_cash_withdrawal_jobs").update({ status: "pending" }).eq("id", job.id).select("id").single());
    return;
  }
  if (env.SOLANA_CLUSTER !== "mainnet-beta") throw new Error("Privacy Cash live transfers require SOLANA_CLUSTER=mainnet-beta");
  const netRaw = BigInt(job.net_raw);
  const grossRaw = grossUpPrivacyCashWithdrawal(netRaw, await loadPrivacyCashFeeConfig());
  const result = await withPrivacyCashLease(async () => {
    const client = createPrivacyCashClient(getCompanySigner(wallet));
    const withdrawal = await client.withdraw({
      lamports: toSafeLamports(grossRaw),
      recipientAddress: validateSolanaWalletAddress(job.recipient_wallet_address)
    });
    return {
      tx: withdrawal.tx,
      actualNetRaw: withdrawal.amount_in_lamports,
      actualFeeRaw: withdrawal.fee_in_lamports
    };
  });
  if (!result) {
    unwrap(await db.from("company_privacy_cash_withdrawal_jobs").update({ status: "pending" }).eq("id", job.id).select("id").single());
    return;
  }
  const actualNet = BigInt(result.actualNetRaw);
  const exact = actualNet === netRaw;
  unwrap(
    await db.from("company_privacy_cash_withdrawal_jobs").update({
      gross_raw: grossRaw.toString(),
      estimated_fee_raw: (grossRaw - netRaw).toString(),
      actual_net_raw: actualNet.toString(),
      actual_fee_raw: String(result.actualFeeRaw),
      signature: result.tx,
      status: exact ? "succeeded" : "review_required",
      error: exact ? null : `Expected ${netRaw} net units but received ${actualNet}`
    }).eq("id", job.id).select("id").single()
  );
  await finalizeCompanyPrivacyCashPayout(job.payout_batch_id);
}

export async function processPendingCompanyPrivacyCashWithdrawals() {
  const settings = await loadSettings();
  if (env.DRY_RUN || settings.emergency_paused || !settings.live_payouts_enabled || !settings.privacy_cash_enabled) return;
  const jobs = unwrap(
    await db.rpc("claim_company_privacy_cash_withdrawal_jobs", { batch_size: 4 })
  ) as CompanyWithdrawalJob[];
  for (const job of jobs) {
    try {
      await processCompanyPrivacyCashWithdrawal(job);
    } catch (error) {
      unwrap(
        await db.from("company_privacy_cash_withdrawal_jobs").update({
          status: "review_required",
          error: error instanceof Error ? error.message : String(error)
        }).eq("id", job.id).select("id").single()
      );
      await finalizeCompanyPrivacyCashPayout(job.payout_batch_id);
    }
  }
}

export async function recoverInterruptedCompanyPrivacyCashWithdrawals() {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const interrupted = unwrap(
    await db
      .from("company_privacy_cash_withdrawal_jobs")
      .select("id,payout_batch_id")
      .eq("status", "processing")
      .lt("updated_at", cutoff)
  ) as Array<{ id: string; payout_batch_id: string }>;
  for (const job of interrupted) {
    unwrap(
      await db.from("company_privacy_cash_withdrawal_jobs").update({
        status: "review_required",
        error: "Worker stopped during withdrawal. Verify the recipient transaction manually; automatic retry is disabled."
      }).eq("id", job.id).select("id").single()
    );
    await finalizeCompanyPrivacyCashPayout(job.payout_batch_id);
  }
}

async function issueLifecycleRequest(values: {
  action: "company_rotation" | "revenue_key_erasure" | "company_key_erasure";
  walletId: string;
  content: string;
  buttonLabel: string;
  routeKind:
    | "company_wallet_rotation_due"
    | "retired_revenue_wallet_deletion_due"
    | "archived_company_wallet_deletion_due";
  expiresAt?: string;
}) {
  const token = lifecycleToken();
  const row = {
    action: values.action,
    external_revenue_wallet_id: values.action === "revenue_key_erasure" ? values.walletId : null,
    company_wallet_id: values.action !== "revenue_key_erasure" ? values.walletId : null,
    action_token_hash: hashToken(token),
    expires_at: values.expiresAt ?? null
  };
  const result = await db.from("wallet_lifecycle_requests").insert(row).select("id").maybeSingle();
  if (result.error?.code === "23505") return false;
  if (result.error) throw new Error(result.error.message);
  await sendRoute(values.routeKind, {
    content: "@everyone",
    embeds: [{ title: values.buttonLabel, description: values.content, color: 0xffb15e }]
  });
  await sendOwnersActionMessage({
    content: `@everyone ${values.content}`,
    buttonCustomId: `wallet-action:${token}`,
    buttonLabel: values.buttonLabel,
    mentionEveryone: true
  });
  return true;
}

async function maybeIssueDeletionRequests() {
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const retiredRevenue = unwrap(
    await db
      .from("external_revenue_wallets")
      .select("id,domain,address")
      .eq("mirror_status", "retired")
      .not("empty_since", "is", null)
      .lte("empty_since", threeDaysAgo)
  ) as Array<{ id: string; domain: string; address: string }>;
  for (const wallet of retiredRevenue) {
    await issueLifecycleRequest({
      action: "revenue_key_erasure",
      walletId: wallet.id,
      expiresAt,
      content: `Retired revenue wallet ${wallet.domain} has been empty for 3 days. Confirm key deletion only if this wallet should become permanently unrecoverable.`,
      buttonLabel: "Confirm revenue key deletion",
      routeKind: "retired_revenue_wallet_deletion_due"
    });
  }
  const archivedCompanies = unwrap(
    await db
      .from("company_wallets")
      .select("id,address")
      .eq("status", "archived")
      .not("empty_since", "is", null)
      .lte("empty_since", threeDaysAgo)
  ) as Array<{ id: string; address: string }>;
  for (const wallet of archivedCompanies) {
    await issueLifecycleRequest({
      action: "company_key_erasure",
      walletId: wallet.id,
      expiresAt,
      content: `Archived company wallet ${wallet.address} has been empty for 3 days. Confirm key deletion only after verifying it is clear.`,
      buttonLabel: "Confirm company key deletion",
      routeKind: "archived_company_wallet_deletion_due"
    });
  }
}

async function maybeIssueCompanyRotationRequest() {
  const settings = await loadSettings();
  const wallet = await activeCompanyWallet();
  if (!wallet) return;
  const ageDays = (Date.now() - new Date(wallet.activated_at).getTime()) / (24 * 60 * 60 * 1000);
  const volumeUsd = Number(wallet.received_volume_usd ?? 0);
  const due =
    ageDays >= Number(settings.company_rotation_long_days) ||
    volumeUsd >= Number(settings.company_rotation_high_volume_usd) ||
    (
      ageDays >= Number(settings.company_rotation_short_days) &&
      volumeUsd >= Number(settings.company_rotation_lower_volume_usd)
    );
  if (!due) return;
  await issueLifecycleRequest({
    action: "company_rotation",
    walletId: wallet.id,
    content: `Company wallet rotation is due. Current wallet: ${wallet.address}. The first owner who presses the button will generate the new company wallet.`,
    buttonLabel: "Generate company wallet",
    routeKind: "company_wallet_rotation_due"
  });
}

export async function evaluateCompanyWalletLifecycle() {
  await reconcileCompanyWallets();
  await maybeIssueDeletionRequests();
  await maybeIssueCompanyRotationRequest();
}

export async function expireWalletLifecycleRequests() {
  const expired = unwrap(
    await db
      .from("wallet_lifecycle_requests")
      .update({ status: "expired" })
      .eq("status", "pending")
      .not("expires_at", "is", null)
      .lte("expires_at", new Date().toISOString())
      .select("*")
  ) as Array<{ id: string; action: string }>;
  for (const request of expired) {
    await sendRoute(
      request.action === "revenue_key_erasure"
        ? "retired_revenue_wallet_deletion_expired"
        : "archived_company_wallet_deletion_expired",
      { embeds: [{ title: "Wallet lifecycle request expired", description: request.action, color: 0xffb15e }] }
    );
  }
}

export async function syncExternalSourceAndReconcile() {
  if (!sourceSyncConfigured()) {
    await auditSourceSyncIssue("source.sync_skipped", {
      reason: "SOURCE_DATABASE_URL is not configured for the worker"
    });
    return;
  }
  const settings = await loadSettings();
  if (!settings.source_sync_enabled) {
    await auditSourceSyncIssue("source.sync_skipped", {
      reason: "External Telegram sync is disabled in dashboard settings"
    });
    return;
  }
  try {
    await syncExternalSource();
    await reconcileExternalRevenueWallets();
  } catch (error) {
    await auditSourceSyncIssue("source.sync_failed", {
      error: errorMessage(error)
    });
    throw error;
  }
}
