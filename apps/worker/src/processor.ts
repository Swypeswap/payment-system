import { createHash } from "node:crypto";
import bs58 from "bs58";
import {
  LAMPORTS_PER_SOL,
  PAYOUT_FEE_BUFFER_LAMPORTS,
  WRAPPED_SOL_MINT,
  decryptSecret,
  effectiveWebsiteSettings,
  parseSecretKey,
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
import { sendRoute, sendTeamPayoutMessage } from "./notifications.js";

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
  company_wallet_address: string;
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

async function sendPayoutNotifications(website: WebsiteRow, payout: Record<string, unknown>) {
  try {
    await sendRoute("payout", {
      embeds: [{
        title: "Website payout sent",
        color: 0x64f5b5,
        fields: [
          { name: "Website", value: website.domains.domain },
          { name: "Team", value: website.teams.name },
          { name: "Manager share", value: `${Number(payout.manager_lamports) / LAMPORTS_PER_SOL} SOL` },
          { name: "Company share", value: `${Number(payout.company_lamports) / LAMPORTS_PER_SOL} SOL` },
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

async function payoutIfEligible(
  website: WebsiteRow,
  signer: Keypair,
  balanceLamports: bigint,
  settings: ReturnType<typeof effectiveWebsiteSettings>
) {
  const reserveLamports = BigInt(Math.ceil(settings.solReserve * LAMPORTS_PER_SOL));
  const available = balanceLamports - reserveLamports - BigInt(PAYOUT_FEE_BUFFER_LAMPORTS);
  if (available <= 0n) return;

  const solUsd = await getSolUsdPrice();
  const availableUsd = Number(available) / LAMPORTS_PER_SOL * solUsd;
  if (availableUsd < settings.thresholdUsd) return;
  if (!website.teams.manager_wallet_address) {
    throw new Error("Team manager payout wallet is not configured");
  }
  const managerWallet = validateSolanaWalletAddress(website.teams.manager_wallet_address);
  const companyWallet = validateSolanaWalletAddress(website.company_wallet_address);
  const managerLamports = available * BigInt(Math.round(settings.managerPercent * 10_000)) / 1_000_000n;
  const companyLamports = available - managerLamports;
  const dryRunKey = createHash("sha256")
    .update(`dry:${website.id}:${balanceLamports}:${managerWallet}:${companyWallet}`)
    .digest("hex");

  if (!settings.livePayoutsEnabled || env.DRY_RUN) {
    const { error } = await db.from("payout_attempts").upsert({
      website_id: website.id,
      revenue_wallet_id: website.revenue_wallet_id,
      idempotency_key: dryRunKey,
      manager_wallet_address: managerWallet,
      company_wallet_address: companyWallet,
      source_balance_lamports: balanceLamports.toString(),
      reserve_lamports: reserveLamports.toString(),
      manager_lamports: managerLamports.toString(),
      company_lamports: companyLamports.toString(),
      status: "dry_run",
      error: env.DRY_RUN ? "DRY_RUN environment kill switch is enabled" : "Live payouts are disabled"
    }, { onConflict: "idempotency_key", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    return;
  }

  const latest = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({
    feePayer: signer.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight
  }).add(
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: new PublicKey(managerWallet),
      lamports: toSafeLamports(managerLamports)
    }),
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: new PublicKey(companyWallet),
      lamports: toSafeLamports(companyLamports)
    })
  );
  transaction.sign(signer);
  if (!transaction.signature) throw new Error("Payout transaction was not signed");
  const signature = bs58.encode(transaction.signature);
  const raw = transaction.serialize();
  unwrap(
    await db
      .from("payout_attempts")
      .insert({
        website_id: website.id,
        revenue_wallet_id: website.revenue_wallet_id,
        idempotency_key: signature,
        manager_wallet_address: managerWallet,
        company_wallet_address: companyWallet,
        source_balance_lamports: balanceLamports.toString(),
        reserve_lamports: reserveLamports.toString(),
        manager_lamports: managerLamports.toString(),
        company_lamports: companyLamports.toString(),
        signature,
        raw_transaction_base64: raw.toString("base64"),
        last_valid_block_height: latest.lastValidBlockHeight,
        status: "submitted"
      })
      .select("*")
      .single()
  );
  await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  const confirmation = await connection.confirmTransaction({
    signature,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight
  }, "confirmed");
  if (confirmation.value.err) {
    unwrap(
      await db
        .from("payout_attempts")
        .update({ status: "failed", error: JSON.stringify(confirmation.value.err) })
        .eq("signature", signature)
        .select("id")
        .single()
    );
    throw new Error(`Payout transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  const payout = unwrap(
    await db
      .from("payout_attempts")
      .update({ status: "succeeded", error: null })
      .eq("signature", signature)
      .select("*")
      .single()
  );
  await workerAudit("payout.succeeded", "website", website.id, { signature });
  await sendPayoutNotifications(website, payout);
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
    await payoutIfEligible(website, signer, solLamports, settings);
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
  for (const website of websites) {
    await processWebsite(website.id);
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
  const [swaps, payouts] = await Promise.all([
    db.from("swap_attempts").select("id").eq("signature", signature).limit(1),
    db.from("payout_attempts").select("id").eq("signature", signature).limit(1)
  ]);
  if (swaps.error) throw new Error(swaps.error.message);
  if (payouts.error) throw new Error(payouts.error.message);
  return Boolean(swaps.data.length || payouts.data.length);
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
      await sendPayoutNotifications(await loadWebsite(attempt.website_id), payout);
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
