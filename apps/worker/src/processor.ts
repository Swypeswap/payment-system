import { createHash, randomInt, randomUUID } from "node:crypto";
import {
  LAMPORTS_PER_SOL,
  PAYOUT_FEE_BUFFER_LAMPORTS,
  WRAPPED_SOL_MINT,
  decryptSecret,
  effectiveWebsiteSettings,
  grossUpPrivacyCashWithdrawal,
  parseSecretKey,
  planPrivacyCashDistribution,
  validateSolanaWalletAddress
} from "@payment/shared";
import {
  Connection,
  PublicKey,
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
  sendManagerMessage,
  sendOwnersMessage,
  sendRoute,
  sendTeamPayoutMessage
} from "./notifications.js";
import {
  createPrivacyCashClient,
  loadPrivacyCashFeeConfig,
  type PrivacyCashAsset,
  withPrivacyCashLease
} from "./privacy-cash.js";

const connection = new Connection(env.SOLANA_RPC_URL, "confirmed");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

interface TokenBalance {
  mint: string;
  tokenAccount: string;
  amountRaw: string;
  decimals: number;
  amount: number;
  isNative: boolean;
}

interface WebsiteRow {
  id: string;
  domain_id: string;
  team_id: string;
  revenue_wallet_id: string;
  company_wallet_address: string | null;
  hosted: boolean;
  active: boolean;
  threshold_usd: number | string | null;
  manager_percent: number | string | null;
  company_percent: number | string | null;
  sol_reserve: number | string | null;
  domains: { domain: string };
  teams: {
    id: string;
    name: string;
    manager_wallet_address: string | null;
    payout_discord_channel_id: string | null;
    payout_message: string | null;
  };
  revenue_wallets: {
    id: string;
    address: string;
    encrypted_private_key: string;
    encryption_nonce: string;
    encryption_auth_tag: string;
    encryption_key_version: number;
  };
}

function toSafeLamports(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Lamport amount exceeds JavaScript safe integer range");
  }
  return Number(value);
}

function getSigner(website: WebsiteRow): Keypair {
  const wallet = website.revenue_wallets;
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
    throw new Error("Encrypted private key does not match the revenue wallet address");
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

async function loadWebsite(id: string): Promise<WebsiteRow> {
  return unwrap(
    await db
      .from("websites")
      .select("*,domains(domain),teams(*),revenue_wallets(*)")
      .eq("id", id)
      .single()
  ) as WebsiteRow;
}

async function loadSettings() {
  return unwrap(await db.from("app_settings").select("*").eq("id", true).single());
}

async function recordSwap(
  website: WebsiteRow,
  values: Record<string, unknown>
) {
  const { error } = await db.from("swap_attempts").insert({
    website_id: website.id,
    revenue_wallet_id: website.revenue_wallet_id,
    ...values
  });
  if (error) throw new Error(error.message);
}

async function quarantineToken(
  website: WebsiteRow,
  token: TokenBalance,
  reason: string,
  estimatedUsdValue?: number
) {
  await recordSwap(website, {
    input_mint: token.mint,
    input_amount_raw: token.amountRaw,
    estimated_usd_value: estimatedUsdValue,
    status: "quarantined",
    reason
  });
  await sendRoute("security_alert", {
    embeds: [{
      title: "Token quarantined",
      color: 0xff7b8b,
      fields: [
        { name: "Website", value: website.domains.domain },
        { name: "Mint", value: token.mint },
        { name: "Reason", value: reason }
      ]
    }]
  }, website.team_id);
}

async function sendLegacyPayoutNotifications(website: WebsiteRow, payout: Record<string, unknown>) {
  try {
    await sendRoute("payout", {
      embeds: [{
        title: "Legacy website payout sent",
        color: 0x64f5b5,
        fields: [
          { name: "Website", value: website.domains.domain },
          { name: "Team", value: website.teams.name },
          { name: "Signature", value: String(payout.signature ?? "-") }
        ]
      }]
    }, website.team_id);
    await sendTeamPayoutMessage(website.teams);
  } catch (error) {
    await workerAudit("payout.notification_failed", "website", website.id, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function hasRecentTokenAttempt(website: WebsiteRow, token: TokenBalance) {
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const result = await db
    .from("swap_attempts")
    .select("id")
    .eq("website_id", website.id)
    .eq("input_mint", token.mint)
    .eq("input_amount_raw", token.amountRaw)
    .gte("created_at", sixHoursAgo)
    .in("status", ["skipped", "quarantined", "failed"])
    .limit(1);
  if (result.error) throw new Error(result.error.message);
  return result.data.length > 0;
}

async function unwrapWrappedSol(
  website: WebsiteRow,
  token: TokenBalance,
  signer: Keypair
) {
  if (env.DRY_RUN) {
    return recordSwap(website, {
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
        // SPL Token instruction 9 closes the wrapped-SOL account and returns its lamports.
        data: Buffer.from([9])
      })
    ),
    [signer],
    { commitment: "confirmed" }
  );
  await recordSwap(website, {
    input_mint: token.mint,
    input_amount_raw: token.amountRaw,
    actual_output_lamports: token.amountRaw,
    status: "succeeded",
    reason: "Wrapped SOL unwrapped to native SOL",
    signature
  });
}

async function swapToken(
  website: WebsiteRow,
  token: TokenBalance,
  signer: Keypair,
  settings: ReturnType<typeof effectiveWebsiteSettings>
) {
  if (await hasRecentTokenAttempt(website, token)) return;
  if (token.mint === WRAPPED_SOL_MINT && token.isNative) {
    return unwrapWrappedSol(website, token, signer);
  }
  const info = await getTokenInfo(token.mint);
  if (!info) {
    return quarantineToken(website, token, "Jupiter returned no trustworthy token metadata");
  }
  if (info.verification?.toLowerCase() === "banned" || info.audit?.isSus) {
    return quarantineToken(website, token, "Jupiter flagged this token as suspicious");
  }
  const organicScore = Number(info.organicScore ?? 0);
  if (organicScore < settings.minOrganicScore) {
    return quarantineToken(
      website,
      token,
      `Organic score ${organicScore} is below the configured minimum`
    );
  }
  const usdPrice = Number(info.usdPrice);
  if (!Number.isFinite(usdPrice) || usdPrice <= 0) {
    return quarantineToken(website, token, "No reliable USD price is available");
  }
  const estimatedUsdValue = token.amount * usdPrice;
  if (estimatedUsdValue < settings.minSwapUsd) {
    return recordSwap(website, {
      input_mint: token.mint,
      input_amount_raw: token.amountRaw,
      estimated_usd_value: estimatedUsdValue,
      status: "skipped",
      reason: "Below minimum swap value"
    });
  }
  const order = await getSwapOrder(token.mint, token.amountRaw, signer.publicKey.toBase58());
  const outputLamports = getOrderOutputLamports(order);
  const priceImpactPct = getOrderPriceImpactPercent(order);
  if (priceImpactPct > settings.maxPriceImpactPct) {
    return quarantineToken(
      website,
      token,
      `Estimated price impact ${priceImpactPct.toFixed(4)}% exceeds the configured maximum`,
      estimatedUsdValue
    );
  }
  if (env.DRY_RUN) {
    return recordSwap(website, {
      input_mint: token.mint,
      input_amount_raw: token.amountRaw,
      estimated_usd_value: estimatedUsdValue,
      estimated_output_lamports: outputLamports.toString(),
      status: "skipped",
      reason: "DRY_RUN is enabled"
    });
  }

  const result = await signAndExecuteSwap(order, signer);
  await recordSwap(website, {
    input_mint: token.mint,
    input_amount_raw: token.amountRaw,
    estimated_usd_value: estimatedUsdValue,
    estimated_output_lamports: outputLamports.toString(),
    actual_output_lamports: result.outputAmount ?? result.outAmount ?? null,
    status: "succeeded",
    signature: result.signature
  });
  await workerAudit("swap.succeeded", "website", website.id, {
    signature: result.signature,
    input_mint: token.mint,
    estimated_usd_value: estimatedUsdValue
  });
}

interface OwnerProfile {
  id: string;
  display_name: string;
  discord_user_id: string;
  solana_wallet_address: string | null;
}

interface ShieldJob {
  id: string;
  website_id: string;
  asset_key: PrivacyCashAsset;
  shield_raw: string | number;
  status?: "pending" | "processing";
  private_balance_before_raw?: string | number | null;
}

interface PrivacyCashWithdrawalJob {
  id: string;
  payout_batch_id: string;
  website_id: string;
  asset_key: PrivacyCashAsset;
  recipient_kind: "owner_1" | "owner_2" | "owner_3" | "manager";
  recipient_wallet_address: string;
  net_raw: string | number;
}

function displaySolAmount(raw: unknown) {
  return `${Number(raw) / LAMPORTS_PER_SOL} SOL`;
}

function randomReleaseTime(minimumHours: number, maximumHours: number) {
  const minimumSeconds = Math.ceil(minimumHours * 60 * 60);
  const maximumSeconds = Math.floor(maximumHours * 60 * 60);
  return new Date(Date.now() + randomInt(minimumSeconds, maximumSeconds + 1) * 1000).toISOString();
}

function randomLegWeights() {
  return Array.from({ length: randomInt(2, 5) }, () => randomInt(80, 121));
}

async function loadOwnerProfiles() {
  const owners = unwrap(
    await db.from("owner_profiles").select("*").eq("active", true).order("created_at")
  ) as OwnerProfile[];
  if (owners.length !== 3 || owners.some((owner) => !owner.solana_wallet_address)) {
    throw new Error("Configure exactly three active owner profiles with Solana wallets");
  }
  return owners.map((owner) => ({
    ...owner,
    solana_wallet_address: validateSolanaWalletAddress(owner.solana_wallet_address ?? "")
  }));
}

async function planShieldedPayout(
  website: WebsiteRow,
  shieldJob: ShieldJob,
  status: "dry_run" | "pending",
  settings: ReturnType<typeof effectiveWebsiteSettings>
) {
  if (!website.teams.manager_wallet_address) {
    throw new Error("Team manager payout wallet is not configured");
  }
  const managerWallet = validateSolanaWalletAddress(website.teams.manager_wallet_address);
  const owners = await loadOwnerProfiles();
  const feeConfig = await loadPrivacyCashFeeConfig();
  let plan;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    plan = planPrivacyCashDistribution(
      BigInt(shieldJob.shield_raw),
      feeConfig,
      [randomLegWeights(), randomLegWeights(), randomLegWeights(), randomLegWeights()]
    );
    if (plan.withdrawals.every((withdrawal) =>
      withdrawal.netLamports >= BigInt(feeConfig.minimumWithdrawalRaw)
    )) {
      break;
    }
    plan = undefined;
  }
  if (!plan) {
    throw new Error(`Shielded ${shieldJob.asset_key.toUpperCase()} balance is too small for randomized payout legs`);
  }
  const batch = unwrap(
    await db
      .from("privacy_cash_payout_batches")
      .upsert({
        shield_job_id: shieldJob.id,
        website_id: website.id,
        revenue_wallet_id: website.revenue_wallet_id,
        team_id: website.team_id,
        asset_key: shieldJob.asset_key,
        manager_wallet_address: managerWallet,
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
  const recipientFor = (kind: PrivacyCashWithdrawalJob["recipient_kind"]) => {
    if (kind === "manager") {
      return { key: `manager:${website.team_id}`, wallet: managerWallet, ownerId: null };
    }
    const ownerIndex = Number(kind.slice(-1)) - 1;
    const owner = owners[ownerIndex];
    if (!owner) throw new Error(`Owner profile missing for ${kind}`);
    return { key: `owner:${owner.id}`, wallet: owner.solana_wallet_address, ownerId: owner.id };
  };
  const solUsd = await getSolUsdPrice();
  const rows = plan.withdrawals.map((withdrawal) => {
    const recipient = recipientFor(withdrawal.recipientKind);
    return {
      payout_batch_id: batch.id,
      website_id: website.id,
      team_id: website.team_id,
      asset_key: shieldJob.asset_key,
      recipient_kind: withdrawal.recipientKind,
      recipient_key: recipient.key,
      owner_profile_id: recipient.ownerId,
      leg_index: withdrawal.legIndex,
      recipient_wallet_address: recipient.wallet,
      net_raw: withdrawal.netLamports.toString(),
      gross_raw: withdrawal.grossLamports.toString(),
      estimated_fee_raw: withdrawal.estimatedFeeLamports.toString(),
      estimated_usd:
        Number(withdrawal.netLamports) / LAMPORTS_PER_SOL * solUsd,
      scheduled_for: randomReleaseTime(settings.privacyMinDelayHours, settings.privacyMaxDelayHours),
      status
    };
  });
  const { error } = await db
    .from("privacy_cash_withdrawal_jobs")
    .upsert(rows, { onConflict: "payout_batch_id,recipient_key,leg_index", ignoreDuplicates: true });
  if (error) throw new Error(error.message);
  await workerAudit("privacy_cash.payout_planned", "privacy_cash_payout_batch", batch.id, {
    shield_job_id: shieldJob.id,
    asset_key: shieldJob.asset_key,
    net_distribution_raw: plan.netDistributionLamports.toString(),
    estimated_fee_raw: plan.estimatedFeeLamports.toString(),
    dust_raw: plan.dustLamports.toString(),
    withdrawal_leg_count: rows.length,
    status
  });
}

async function privateBalanceRaw(signer: Keypair) {
  const client = createPrivacyCashClient(signer);
  return (await client.getPrivateBalance()).lamports;
}

async function executeShieldJob(signer: Keypair, shieldJob: ShieldJob) {
  if (env.SOLANA_CLUSTER !== "mainnet-beta") {
    throw new Error("Privacy Cash live transfers require SOLANA_CLUSTER=mainnet-beta");
  }
  return withPrivacyCashLease(async () => {
    const client = createPrivacyCashClient(signer);
    const balance = (await client.getPrivateBalance()).lamports;
    unwrap(
      await db
        .from("privacy_cash_shield_jobs")
        .update({ status: "processing", private_balance_before_raw: String(balance), error: null })
        .eq("id", shieldJob.id)
        .select("id")
        .single()
    );
    try {
      const amount = toSafeLamports(BigInt(shieldJob.shield_raw));
      const deposit = await client.deposit({ lamports: amount });
      return unwrap(
        await db
          .from("privacy_cash_shield_jobs")
          .update({ status: "succeeded", signature: deposit.tx, error: null })
          .eq("id", shieldJob.id)
          .select("*")
          .single()
      ) as ShieldJob;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      unwrap(
        await db
          .from("privacy_cash_shield_jobs")
          .update({ status: "review_required", error: message })
          .eq("id", shieldJob.id)
          .select("id")
          .single()
      );
      throw error;
    }
  });
}

async function shieldAssetIfEligible(
  website: WebsiteRow,
  signer: Keypair,
  sourceBalanceRaw: bigint,
  reserveRaw: bigint,
  settings: ReturnType<typeof effectiveWebsiteSettings>
) {
  if (!settings.privacyCashEnabled) return;
  const available = sourceBalanceRaw - reserveRaw;
  if (available <= 0n) return;
  const usd = Number(available) / LAMPORTS_PER_SOL * await getSolUsdPrice();
  if (usd < settings.thresholdUsd) return;
  if (!website.teams.manager_wallet_address) {
    throw new Error("Team manager payout wallet is not configured");
  }
  const managerWallet = validateSolanaWalletAddress(website.teams.manager_wallet_address);
  const owners = await loadOwnerProfiles();
  const isDryRun = !settings.livePayoutsEnabled || env.DRY_RUN;
  if (!isDryRun) {
    const unresolved = await db
      .from("privacy_cash_shield_jobs")
      .select("id,status")
      .eq("website_id", website.id)
      .in("status", ["pending", "processing", "review_required"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (unresolved.error) throw new Error(unresolved.error.message);
    if (unresolved.data?.status === "review_required") {
      throw new Error("Resolve the previous Privacy Cash shield job under manual review before shielding more funds");
    }
    if (unresolved.data) return;
  }
  const idempotencyKey = createHash("sha256")
    .update(
      isDryRun
        ? `privacy-cash:dry-run:sol:${website.id}:${sourceBalanceRaw}:${managerWallet}:${owners.map((owner) => owner.solana_wallet_address).join(":")}`
        : `privacy-cash:live:sol:${website.id}:${randomUUID()}`
    )
    .digest("hex");
  const existing = await db
    .from("privacy_cash_shield_jobs")
    .select("id")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (existing.data) return;

  const shieldJob = unwrap(
    await db
      .from("privacy_cash_shield_jobs")
      .insert({
        website_id: website.id,
        revenue_wallet_id: website.revenue_wallet_id,
        idempotency_key: idempotencyKey,
        asset_key: "sol",
        source_balance_raw: sourceBalanceRaw.toString(),
        reserve_raw: reserveRaw.toString(),
        shield_raw: available.toString(),
        status: isDryRun ? "dry_run" : "pending",
        error: isDryRun
          ? env.DRY_RUN
            ? "DRY_RUN environment kill switch is enabled"
            : "Live payouts are disabled"
          : null
      })
      .select("*")
      .single()
  ) as ShieldJob;
  if (isDryRun) {
    await planShieldedPayout(website, shieldJob, "dry_run", settings);
    return;
  }
  const completed = await executeShieldJob(signer, shieldJob);
  if (!completed) return;
  await planShieldedPayout(website, completed, "pending", settings);
}

export async function processWebsite(websiteId: string) {
  const lock = unwrap(
    await db.rpc("acquire_website_lock", {
      requested_website_id: websiteId,
      requested_lock_owner: env.WORKER_ID,
      lease_seconds: 180
    })
  );
  if (!lock) return;
  try {
    const website = await loadWebsite(websiteId);
    if (!website.active || !website.hosted) return;
    const global = await loadSettings();
    const settings = effectiveWebsiteSettings(global, website);
    const signer = getSigner(website);
    let tokenBalances = await getTokenBalances(signer.publicKey);
    let solLamports = BigInt(await connection.getBalance(signer.publicKey, "confirmed"));
    unwrap(
      await db
        .from("wallet_balance_snapshots")
        .insert({
          website_id: website.id,
          revenue_wallet_id: website.revenue_wallet_id,
          sol_lamports: solLamports.toString(),
          token_balances: tokenBalances
        })
        .select("id")
        .single()
    );
    if (settings.emergencyPaused) return;
    if (settings.swapsEnabled) {
      for (const token of tokenBalances) {
        try {
          await swapToken(website, token, signer, settings);
        } catch (error) {
          await recordSwap(website, {
            input_mint: token.mint,
            input_amount_raw: token.amountRaw,
            status: "failed",
            reason: error instanceof Error ? error.message : String(error)
          });
        }
      }
      tokenBalances = await getTokenBalances(signer.publicKey);
      solLamports = BigInt(await connection.getBalance(signer.publicKey, "confirmed"));
    }
    const reserveLamports =
      BigInt(Math.ceil(settings.solReserve * LAMPORTS_PER_SOL)) +
      BigInt(PAYOUT_FEE_BUFFER_LAMPORTS);
    await shieldAssetIfEligible(website, signer, solLamports, reserveLamports, settings);
  } catch (error) {
    await workerAudit("website.processing_failed", "website", websiteId, {
      error: error instanceof Error ? error.message : String(error)
    });
    try {
      await sendRoute("worker_error", {
        content: `Website processing failed for ${websiteId}: ${error instanceof Error ? error.message : String(error)}`
      });
    } catch {
      // Audit logging is the durable fallback when a Discord webhook is also unavailable.
    }
  } finally {
    await db.rpc("release_website_lock", {
      requested_website_id: websiteId,
      requested_lock_owner: env.WORKER_ID
    });
  }
}

export async function reconcileAllWebsites() {
  const websites = unwrap(
    await db.from("websites").select("id").eq("active", true).eq("hosted", true)
  ) as Array<{ id: string }>;
  for (const website of websites) await processWebsite(website.id);
}

async function sendPrivacyCashPayoutNotifications(
  website: WebsiteRow,
  batch: Record<string, unknown>,
  jobs: Array<Record<string, unknown>>
) {
  const ownerJobs = jobs.filter((job) => String(job.recipient_kind).startsWith("owner_"));
  const managerJobs = jobs.filter((job) => job.recipient_kind === "manager");
  const sum = (rows: Array<Record<string, unknown>>) =>
    rows.reduce((total, row) => total + Number(row.net_raw), 0);
  try {
    await sendRoute("payout", {
      embeds: [{
        title: "Website payout sent",
        color: 0x64f5b5,
        fields: [
          { name: "Website", value: website.domains.domain },
          { name: "Team", value: website.teams.name },
          { name: "Owners total", value: displaySolAmount(sum(ownerJobs)) },
          { name: "Manager total", value: displaySolAmount(sum(managerJobs)) },
          { name: "Privacy Cash expense", value: displaySolAmount(batch.estimated_fee_raw) },
          { name: "Randomized legs", value: String(jobs.length) }
        ]
      }]
    }, website.team_id);
    await sendTeamPayoutMessage(website.teams);
    await sendOwnersMessage(
      `Privacy Cash payout completed for ${website.domains.domain}: ${displaySolAmount(batch.net_distribution_raw)} net across ${jobs.length} delayed randomized legs.`
    );
  } catch (error) {
    await workerAudit("payout.notification_failed", "website", website.id, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function finalizePrivacyCashPayout(batchId: string) {
  const batch = unwrap(
    await db.from("privacy_cash_payout_batches").select("*").eq("id", batchId).single()
  );
  const jobs = unwrap(
    await db.from("privacy_cash_withdrawal_jobs").select("*").eq("payout_batch_id", batchId)
  ) as Array<Record<string, unknown>>;
  if (jobs.some((job) => job.status === "review_required")) {
    unwrap(
      await db.from("privacy_cash_payout_batches").update({ status: "review_required" }).eq("id", batchId).select("id").single()
    );
    return;
  }
  if (!jobs.length || jobs.some((job) => job.status !== "succeeded")) return;
  const completed = unwrap(
    await db.from("privacy_cash_payout_batches").update({ status: "succeeded" }).eq("id", batchId).select("*").single()
  );
  if (completed.notification_sent_at) return;
  await sendPrivacyCashPayoutNotifications(await loadWebsite(batch.website_id), completed, jobs);
  unwrap(
    await db.from("privacy_cash_payout_batches").update({ notification_sent_at: new Date().toISOString() }).eq("id", batchId).select("id").single()
  );
}

async function processPrivacyCashWithdrawal(job: PrivacyCashWithdrawalJob) {
  const website = await loadWebsite(job.website_id);
  const global = await loadSettings();
  const settings = effectiveWebsiteSettings(global, website);
  if (env.DRY_RUN || settings.emergencyPaused || !settings.livePayoutsEnabled || !settings.privacyCashEnabled) {
    unwrap(
      await db.from("privacy_cash_withdrawal_jobs").update({ status: "pending" }).eq("id", job.id).select("id").single()
    );
    return;
  }
  if (env.SOLANA_CLUSTER !== "mainnet-beta") {
    throw new Error("Privacy Cash live transfers require SOLANA_CLUSTER=mainnet-beta");
  }
  const netRaw = BigInt(job.net_raw);
  const grossRaw = grossUpPrivacyCashWithdrawal(netRaw, await loadPrivacyCashFeeConfig());
  const result = await withPrivacyCashLease(async () => {
    const client = createPrivacyCashClient(getSigner(website));
    const amount = toSafeLamports(grossRaw);
    const recipientAddress = validateSolanaWalletAddress(job.recipient_wallet_address);
    const withdrawal = await client.withdraw({ lamports: amount, recipientAddress });
    return {
      tx: withdrawal.tx,
      actualNetRaw: withdrawal.amount_in_lamports,
      actualFeeRaw: withdrawal.fee_in_lamports
    };
  });
  if (!result) {
    unwrap(
      await db.from("privacy_cash_withdrawal_jobs").update({ status: "pending" }).eq("id", job.id).select("id").single()
    );
    return;
  }
  const actualNet = BigInt(result.actualNetRaw);
  const actualFee = BigInt(result.actualFeeRaw);
  const exact = actualNet === netRaw;
  unwrap(
    await db
      .from("privacy_cash_withdrawal_jobs")
      .update({
        gross_raw: grossRaw.toString(),
        estimated_fee_raw: (grossRaw - netRaw).toString(),
        actual_net_raw: actualNet.toString(),
        actual_fee_raw: actualFee.toString(),
        signature: result.tx,
        status: exact ? "succeeded" : "review_required",
        error: exact ? null : `Expected ${netRaw} net units but received ${actualNet}`
      })
      .eq("id", job.id)
      .select("id")
      .single()
  );
  await finalizePrivacyCashPayout(job.payout_batch_id);
}

export async function processPendingPrivacyCashWithdrawals() {
  const global = await loadSettings();
  if (env.DRY_RUN || global.emergency_paused || !global.live_payouts_enabled || !global.privacy_cash_enabled) return;
  const jobs = unwrap(
    await db.rpc("claim_privacy_cash_withdrawal_jobs", { batch_size: 4 })
  ) as PrivacyCashWithdrawalJob[];
  for (const job of jobs) {
    try {
      await processPrivacyCashWithdrawal(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      unwrap(
        await db.from("privacy_cash_withdrawal_jobs").update({ status: "review_required", error: message }).eq("id", job.id).select("id").single()
      );
      await finalizePrivacyCashPayout(job.payout_batch_id);
    }
  }
}

export async function recoverPrivacyCashShields() {
  const jobs = unwrap(
    await db.from("privacy_cash_shield_jobs").select("*").in("status", ["pending", "processing"]).order("created_at")
  ) as ShieldJob[];
  for (const job of jobs) {
    const website = await loadWebsite(job.website_id);
    const global = await loadSettings();
    const settings = effectiveWebsiteSettings(global, website);
    if (env.DRY_RUN || settings.emergencyPaused || !settings.livePayoutsEnabled || !settings.privacyCashEnabled) continue;
    const signer = getSigner(website);
    if (job.status === "pending") {
      const completed = await executeShieldJob(signer, job);
      if (completed) await planShieldedPayout(website, completed, "pending", settings);
      continue;
    }
    const recovered = await withPrivacyCashLease(async () => {
      const balance = await privateBalanceRaw(signer);
      return BigInt(balance) >= BigInt(job.private_balance_before_raw ?? 0) + BigInt(job.shield_raw);
    });
    if (recovered === null) continue;
    if (!recovered) {
      unwrap(
        await db.from("privacy_cash_shield_jobs").update({
          status: "review_required",
          error: "Could not confirm whether the interrupted Privacy Cash deposit succeeded"
        }).eq("id", job.id).select("id").single()
      );
      continue;
    }
    const completed = unwrap(
      await db.from("privacy_cash_shield_jobs").update({
        status: "succeeded",
        error: "Recovered from private balance after an interrupted deposit; signature unavailable"
      }).eq("id", job.id).select("*").single()
    ) as ShieldJob;
    await planShieldedPayout(website, completed, "pending", settings);
  }
}

export async function recoverInterruptedPrivacyCashWithdrawals() {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const interrupted = unwrap(
    await db
      .from("privacy_cash_withdrawal_jobs")
      .select("id,payout_batch_id")
      .eq("status", "processing")
      .lt("updated_at", cutoff)
  ) as Array<{ id: string; payout_batch_id: string }>;
  for (const job of interrupted) {
    unwrap(
      await db
        .from("privacy_cash_withdrawal_jobs")
        .update({
          status: "review_required",
          error: "Worker stopped during withdrawal. Verify the recipient transaction manually; automatic retry is disabled."
        })
        .eq("id", job.id)
        .select("id")
        .single()
    );
    await finalizePrivacyCashPayout(job.payout_batch_id);
  }
}

interface RotationSettings {
  rotation_warn_after_days: number | string;
  rotation_warn_after_legs: number | string;
  rotation_warn_after_usd: number | string;
  rotation_warn_after_weekly_legs: number | string;
}

async function rotationReasons(walletAddress: string, activeSince: string, settings: RotationSettings) {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [allJobs, recentJobs] = await Promise.all([
    db
      .from("privacy_cash_withdrawal_jobs")
      .select("estimated_usd")
      .eq("recipient_wallet_address", walletAddress)
      .eq("status", "succeeded"),
    db
      .from("privacy_cash_withdrawal_jobs")
      .select("id")
      .eq("recipient_wallet_address", walletAddress)
      .eq("status", "succeeded")
      .gte("updated_at", weekAgo)
  ]);
  if (allJobs.error) throw new Error(allJobs.error.message);
  if (recentJobs.error) throw new Error(recentJobs.error.message);
  const ageDays = (Date.now() - new Date(activeSince).getTime()) / (24 * 60 * 60 * 1000);
  const totalUsd = allJobs.data.reduce((sum, job) => sum + Number(job.estimated_usd ?? 0), 0);
  const reasons: string[] = [];
  if (ageDays >= Number(settings.rotation_warn_after_days)) reasons.push("wallet age");
  if (allJobs.data.length >= Number(settings.rotation_warn_after_legs)) reasons.push("payout-leg count");
  if (totalUsd >= Number(settings.rotation_warn_after_usd)) reasons.push("received value");
  if (recentJobs.data.length >= Number(settings.rotation_warn_after_weekly_legs)) reasons.push("recent payout frequency");
  return reasons;
}

async function recordRotationNotification(values: {
  wallet_kind: "owner" | "manager";
  owner_profile_id?: string;
  team_id?: string;
  wallet_address: string;
  reason_key: string;
}) {
  const result = await db
    .from("wallet_rotation_notifications")
    .insert(values)
    .select("id")
    .maybeSingle();
  if (result.error?.code === "23505") return false;
  if (result.error) throw new Error(result.error.message);
  return Boolean(result.data);
}

export async function evaluateWalletRotationRecommendations() {
  const settings = unwrap(
    await db
      .from("app_settings")
      .select("rotation_warn_after_days,rotation_warn_after_legs,rotation_warn_after_usd,rotation_warn_after_weekly_legs")
      .eq("id", true)
      .single()
  ) as RotationSettings;
  const owners = unwrap(
    await db.from("owner_profiles").select("*").eq("active", true)
  ) as Array<OwnerProfile & { wallet_updated_at: string | null; created_at: string }>;
  for (const owner of owners) {
    if (!owner.solana_wallet_address) continue;
    const reasons = await rotationReasons(
      owner.solana_wallet_address,
      owner.wallet_updated_at ?? owner.created_at,
      settings
    );
    if (!reasons.length) continue;
    const reasonKey = reasons.sort().join(",");
    if (await recordRotationNotification({
      wallet_kind: "owner",
      owner_profile_id: owner.id,
      wallet_address: owner.solana_wallet_address,
      reason_key: reasonKey
    })) {
      await sendOwnersMessage(
        `@everyone Wallet rotation recommended for <@${owner.discord_user_id}> (${owner.display_name}). Reason: ${reasons.join(", ")}. Use /owner-wallet-update when ready. Payouts continue to the current wallet until it is changed.`,
        true
      );
    }
  }
  const teams = unwrap(
    await db
      .from("teams")
      .select("id,name,manager_wallet_address,payout_discord_channel_id,manager_wallet_updated_at,created_at,team_managers(managers(discord_user_id,active))")
      .eq("active", true)
  ) as unknown as Array<{
    id: string;
    name: string;
    manager_wallet_address: string | null;
    payout_discord_channel_id: string | null;
    manager_wallet_updated_at: string | null;
    created_at: string;
    team_managers: Array<{ managers: { discord_user_id: string; active: boolean } | null }>;
  }>;
  for (const team of teams) {
    if (!team.manager_wallet_address) continue;
    const reasons = await rotationReasons(
      team.manager_wallet_address,
      team.manager_wallet_updated_at ?? team.created_at,
      settings
    );
    if (!reasons.length) continue;
    const reasonKey = reasons.sort().join(",");
    if (await recordRotationNotification({
      wallet_kind: "manager",
      team_id: team.id,
      wallet_address: team.manager_wallet_address,
      reason_key: reasonKey
    })) {
      const managerIds = team.team_managers
        .filter((row) => row.managers?.active)
        .map((row) => row.managers?.discord_user_id)
        .filter((id): id is string => Boolean(id));
      await sendManagerMessage(
        team,
        managerIds,
        `${managerIds.map((id) => `<@${id}>`).join(" ")} Wallet rotation is recommended for ${team.name}. Reason: ${reasons.join(", ")}. Use /wallet-update when ready. Payouts continue to the current wallet until an owner approves the replacement.`
      );
    }
  }
}

function getEventSignature(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.signature === "string") return payload.signature;
  const events = payload.events as Record<string, { signature?: string }> | undefined;
  for (const event of Object.values(events ?? {})) {
    if (event.signature) return event.signature;
  }
  return undefined;
}

async function isInternalSignature(signature: string): Promise<boolean> {
  const [swaps, payouts, shields, privateWithdrawals] = await Promise.all([
    db.from("swap_attempts").select("id").eq("signature", signature).limit(1),
    db.from("payout_attempts").select("id").eq("signature", signature).limit(1),
    db.from("privacy_cash_shield_jobs").select("id").eq("signature", signature).limit(1),
    db.from("privacy_cash_withdrawal_jobs").select("id").eq("signature", signature).limit(1)
  ]);
  if (swaps.error) throw new Error(swaps.error.message);
  if (payouts.error) throw new Error(payouts.error.message);
  if (shields.error) throw new Error(shields.error.message);
  if (privateWithdrawals.error) throw new Error(privateWithdrawals.error.message);
  return Boolean(swaps.data.length || payouts.data.length || shields.data.length || privateWithdrawals.data.length);
}

async function recordDeposit(
  eventId: string,
  website: WebsiteRow,
  signature: string,
  assetKey: string,
  assetMint: string | null,
  rawAmount: bigint,
  decimals: number
) {
  if (rawAmount <= 0n) return;
  const amount = Number(rawAmount) / 10 ** decimals;
  const result = await db
    .from("deposits")
    .insert({
      chain_event_id: eventId,
      website_id: website.id,
      revenue_wallet_id: website.revenue_wallet_id,
      signature,
      asset_key: assetKey,
      asset_mint: assetMint,
      raw_amount: rawAmount.toString(),
      decimals,
      amount
    })
    .select("id")
    .maybeSingle();
  if (result.error?.code === "23505") return;
  if (result.error) throw new Error(result.error.message);
  if (!result.data) return;
  await sendRoute("deposit", {
    embeds: [{
      title: "Revenue wallet deposit detected",
      color: 0x64f5b5,
      fields: [
        { name: "Website", value: website.domains.domain },
        { name: "Team", value: website.teams.name },
        { name: "Asset", value: assetMint ?? "Native SOL" },
        { name: "Amount", value: String(amount) },
        { name: "Signature", value: signature }
      ]
    }]
  }, website.team_id);
}

async function processChainEvent(event: { id: string; payload: Record<string, unknown> }) {
  const signature = getEventSignature(event.payload);
  if (!signature || await isInternalSignature(signature)) return;
  const websites = unwrap(
    await db
      .from("websites")
      .select("*,domains(domain),teams(*),revenue_wallets(*)")
      .eq("active", true)
  ) as WebsiteRow[];
  const byAddress = new Map(websites.map((website) => [website.revenue_wallets.address, website]));
  const affected = new Set<string>();
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
    const nativeWebsite = account.account ? byAddress.get(account.account) : undefined;
    if (nativeWebsite && Number(account.nativeBalanceChange) > 0) {
      affected.add(nativeWebsite.id);
      await recordDeposit(
        event.id,
        nativeWebsite,
        signature,
        "native-sol",
        null,
        BigInt(account.nativeBalanceChange ?? 0),
        9
      );
    }
    for (const change of account.tokenBalanceChanges ?? []) {
      const website = change.userAccount ? byAddress.get(change.userAccount) : undefined;
      const amount = change.rawTokenAmount?.tokenAmount;
      if (!website || !change.mint || !amount || BigInt(amount) <= 0n) continue;
      affected.add(website.id);
      await recordDeposit(
        event.id,
        website,
        signature,
        change.mint,
        change.mint,
        BigInt(amount),
        change.rawTokenAmount?.decimals ?? 0
      );
    }
  }
  for (const websiteId of affected) {
    await processWebsite(websiteId);
  }
}

export async function processPendingChainEvents() {
  const events = unwrap(
    await db.rpc("claim_chain_events", { batch_size: 20 })
  ) as Array<{ id: string; payload: Record<string, unknown> }>;
  for (const event of events) {
    try {
      await processChainEvent(event);
      unwrap(
        await db
          .from("chain_events")
          .update({ status: "processed", processed_at: new Date().toISOString(), error: null })
          .eq("id", event.id)
          .select("id")
          .single()
      );
    } catch (error) {
      unwrap(
        await db
          .from("chain_events")
          .update({ status: "failed", error: error instanceof Error ? error.message : String(error) })
          .eq("id", event.id)
          .select("id")
          .single()
      );
    }
  }
}

export async function recoverSubmittedPayouts() {
  const attempts = unwrap(
    await db.from("payout_attempts").select("*").eq("status", "submitted")
  ) as Array<{
    id: string;
    website_id: string;
    signature: string;
    raw_transaction_base64: string;
    last_valid_block_height: number;
  }>;
  if (!attempts.length) return;
  const blockHeight = await connection.getBlockHeight("confirmed");
  for (const attempt of attempts) {
    const status = (await connection.getSignatureStatuses([attempt.signature])).value[0];
    if (status?.err) {
      unwrap(
        await db.from("payout_attempts").update({ status: "failed", error: JSON.stringify(status.err) }).eq("id", attempt.id).select("id").single()
      );
      continue;
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      const payout = unwrap(
        await db.from("payout_attempts").update({ status: "succeeded", error: null }).eq("id", attempt.id).select("*").single()
      );
      await sendLegacyPayoutNotifications(await loadWebsite(attempt.website_id), payout);
      continue;
    }
    if (blockHeight > attempt.last_valid_block_height) {
      unwrap(
        await db.from("payout_attempts").update({ status: "expired", error: "Transaction blockhash expired before confirmation" }).eq("id", attempt.id).select("id").single()
      );
      continue;
    }
    await connection.sendRawTransaction(Buffer.from(attempt.raw_transaction_base64, "base64"), {
      skipPreflight: false,
      maxRetries: 3
    });
  }
}
