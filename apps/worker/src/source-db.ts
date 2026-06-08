import { Pool, type QueryResultRow } from "pg";
import { db, unwrap, workerAudit } from "./db.js";
import { env } from "./env.js";

interface SourceSite {
  id: string;
  domain: string;
  intermediate_wallet: string;
  created_at: string;
  updated_at: string;
  status: string;
  performer_id: string | number | null;
  is_promo_site: boolean;
  wallet_auto_generated: boolean;
  intermediate_private_key_encrypted: string | null;
  intermediate_key_encrypted_at: string | null;
}

interface SourcePerformer {
  telegram_user_id: string | number;
  telegram_username: string | null;
  payout_wallet: string | null;
  created_at: string;
  updated_at: string;
  customer_id: string | null;
  referral_code: string | null;
  referred_by_performer_id: string | number | null;
  referral_code_used: string | null;
  lifetime_volume_usd: string | number | null;
  lifetime_connects: string | number | null;
  lifetime_hits: string | number | null;
  approved_performer_id: string | number | null;
  referral_commission_pct: string | number | null;
  referrer_username: string | null;
  referrer_payout_wallet: string | null;
  referrer_approved_id: string | number | null;
}

export interface CurrentPerformerConfig {
  telegramUserId: string;
  telegramUsername: string | null;
  payoutWallet: string | null;
  commissionPct: number | null;
  approved: boolean;
  sourceUpdatedAt: string | null;
  customerId: string | null;
  referralCode: string | null;
  referredByPerformerId: string | null;
  referralCodeUsed: string | null;
  referralCommissionPct: number | null;
  referrerUsername: string | null;
  referrerPayoutWallet: string | null;
  referrerApproved: boolean;
  lifetimeVolumeUsd: number | null;
  lifetimeConnects: number | null;
  lifetimeHits: number | null;
}

const PERFORMER_COMMISSION_PCT = 75;

let pool: Pool | null = null;

function sourcePool() {
  if (!env.SOURCE_DATABASE_URL) {
    throw new Error("SOURCE_DATABASE_URL is required for external revenue-wallet sync");
  }
  if (!pool) {
    const connection = new URL(env.SOURCE_DATABASE_URL);
    connection.search = "";
    pool = new Pool({
      connectionString: connection.toString(),
      max: 1,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      ssl: { rejectUnauthorized: env.SOURCE_DATABASE_SSL_REJECT_UNAUTHORIZED }
    });
  }
  return pool;
}

export function sourceSyncConfigured() {
  return Boolean(env.SOURCE_DATABASE_URL);
}

async function querySource<T extends QueryResultRow>(sql: string, values: unknown[] = []) {
  const result = await sourcePool().query<T>(sql, values);
  return result.rows;
}

function sourceId(value: string | number | null | undefined) {
  return value === null || value === undefined ? null : String(value);
}

export async function loadCurrentPerformerConfig(
  performerId: string | number | null
): Promise<CurrentPerformerConfig | null> {
  if (!performerId) return null;
  const rows = await querySource<SourcePerformer>(
    `select
       p.telegram_user_id,
       p.telegram_username,
       p.payout_wallet,
       p.created_at,
       p.updated_at,
       p.customer_id,
       p.referral_code,
       coalesce(r.referrer_performer_id, p.referred_by_performer_id) as referred_by_performer_id,
       coalesce(r.referral_code_used, p.referral_code_used) as referral_code_used,
       p.lifetime_volume_usd,
       p.lifetime_connects,
       p.lifetime_hits,
       a.telegram_user_id as approved_performer_id,
       r.referral_commission_pct,
       coalesce(r.referrer_username_at_launch, referrer.telegram_username) as referrer_username,
       referrer.payout_wallet as referrer_payout_wallet,
       referrer_approval.telegram_user_id as referrer_approved_id
     from public.performers p
     left join public.approved_performers a
       on a.telegram_user_id = p.telegram_user_id
     left join public.performer_referrals r
       on r.referred_performer_id = p.telegram_user_id
     left join public.performers referrer
       on referrer.telegram_user_id = coalesce(r.referrer_performer_id, p.referred_by_performer_id)
     left join public.approved_performers referrer_approval
       on referrer_approval.telegram_user_id = referrer.telegram_user_id
     where p.telegram_user_id = $1
     limit 1`,
    [performerId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    telegramUserId: String(row.telegram_user_id),
    telegramUsername: row.telegram_username,
    payoutWallet: row.payout_wallet,
    commissionPct: row.approved_performer_id === null ? null : PERFORMER_COMMISSION_PCT,
    approved: row.approved_performer_id !== null,
    sourceUpdatedAt: row.updated_at ?? null,
    customerId: row.customer_id,
    referralCode: row.referral_code,
    referredByPerformerId: sourceId(row.referred_by_performer_id),
    referralCodeUsed: row.referral_code_used,
    referralCommissionPct:
      row.referral_commission_pct === null ? null : Number(row.referral_commission_pct),
    referrerUsername: row.referrer_username,
    referrerPayoutWallet: row.referrer_payout_wallet,
    referrerApproved: row.referrer_approved_id !== null,
    lifetimeVolumeUsd: row.lifetime_volume_usd === null ? null : Number(row.lifetime_volume_usd),
    lifetimeConnects: row.lifetime_connects === null ? null : Number(row.lifetime_connects),
    lifetimeHits: row.lifetime_hits === null ? null : Number(row.lifetime_hits)
  };
}

export async function syncExternalSource() {
  if (!sourceSyncConfigured()) return;
  const sites = await querySource<SourceSite>(
    `select
       id,
       domain,
       intermediate_wallet,
       created_at,
       updated_at,
       status,
       performer_id,
       is_promo_site,
       wallet_auto_generated,
       intermediate_private_key_encrypted,
       intermediate_key_encrypted_at
     from public.sites
     where intermediate_wallet is not null
       and intermediate_private_key_encrypted is not null`
  );
  const performers = await querySource<SourcePerformer>(
    `select
       p.telegram_user_id,
       p.telegram_username,
       p.payout_wallet,
       p.created_at,
       p.updated_at,
       p.customer_id,
       p.referral_code,
       coalesce(r.referrer_performer_id, p.referred_by_performer_id) as referred_by_performer_id,
       coalesce(r.referral_code_used, p.referral_code_used) as referral_code_used,
       p.lifetime_volume_usd,
       p.lifetime_connects,
       p.lifetime_hits,
       a.telegram_user_id as approved_performer_id,
       r.referral_commission_pct,
       coalesce(r.referrer_username_at_launch, referrer.telegram_username) as referrer_username,
       referrer.payout_wallet as referrer_payout_wallet,
       referrer_approval.telegram_user_id as referrer_approved_id
     from public.performers p
     left join public.approved_performers a
       on a.telegram_user_id = p.telegram_user_id
     left join public.performer_referrals r
       on r.referred_performer_id = p.telegram_user_id
     left join public.performers referrer
       on referrer.telegram_user_id = coalesce(r.referrer_performer_id, p.referred_by_performer_id)
     left join public.approved_performers referrer_approval
       on referrer_approval.telegram_user_id = referrer.telegram_user_id`
  );

  const seenSiteIds = sites.map((site) => site.id);
  const now = new Date().toISOString();

  if (performers.length) {
    const { error } = await db.from("source_performer_snapshots").upsert(
      performers.map((performer) => ({
        telegram_user_id: sourceId(performer.telegram_user_id),
        telegram_username: performer.telegram_username,
        payout_wallet: performer.payout_wallet,
        commission_pct:
          performer.approved_performer_id === null ? null : PERFORMER_COMMISSION_PCT,
        approved: performer.approved_performer_id !== null,
        source_updated_at: performer.updated_at,
        customer_id: performer.customer_id,
        referral_code: performer.referral_code,
        referred_by_performer_id: sourceId(performer.referred_by_performer_id),
        referral_code_used: performer.referral_code_used,
        referral_commission_pct: performer.referral_commission_pct,
        referrer_username: performer.referrer_username,
        referrer_payout_wallet: performer.referrer_payout_wallet,
        referrer_approved: performer.referrer_approved_id !== null,
        lifetime_volume_usd: performer.lifetime_volume_usd,
        lifetime_connects: performer.lifetime_connects,
        lifetime_hits: performer.lifetime_hits,
        synced_at: now
      })),
      { onConflict: "telegram_user_id" }
    );
    if (error) throw new Error(error.message);
  }

  if (sites.length) {
    const current = unwrap(
      await db.from("external_revenue_wallets").select("id,external_site_id,address")
    ) as Array<{ id: string; external_site_id: string; address: string }>;
    const bySiteId = new Map(current.map((wallet) => [wallet.external_site_id, wallet]));
    const byAddress = new Map(current.map((wallet) => [wallet.address, wallet]));
    for (const site of sites) {
      const existing = bySiteId.get(site.id) ?? byAddress.get(site.intermediate_wallet);
      const values = {
        external_site_id: site.id,
        domain: site.domain,
        address: site.intermediate_wallet,
        encrypted_private_key_blob: site.intermediate_private_key_encrypted,
        external_status: site.status,
        mirror_status: "active",
        external_performer_id: sourceId(site.performer_id),
        source_created_at: site.created_at,
        source_updated_at: site.updated_at,
        last_seen_at: now,
        retired_at: null,
        empty_since: null,
        key_erased_at: null
      };
      const result = existing
        ? await db.from("external_revenue_wallets").update(values).eq("id", existing.id).select("id").single()
        : await db.from("external_revenue_wallets").insert(values).select("id").single();
      if (result.error) throw new Error(result.error.message);
    }
  }

  let retired = 0;
  if (seenSiteIds.length) {
    const result = await db
      .from("external_revenue_wallets")
      .update({ mirror_status: "retired", retired_at: now })
      .eq("mirror_status", "active")
      .not("external_site_id", "in", `(${seenSiteIds.join(",")})`)
      .select("id");
    if (result.error) throw new Error(result.error.message);
    retired = result.data.length;
  } else {
    const result = await db
      .from("external_revenue_wallets")
      .update({ mirror_status: "retired", retired_at: now })
      .eq("mirror_status", "active")
      .select("id");
    if (result.error) throw new Error(result.error.message);
    retired = result.data.length;
  }

  await workerAudit("source.sync_completed", "source_sync", undefined, {
    site_count: sites.length,
    performer_count: performers.length,
    newly_retired_count: retired
  });
}

export async function closeSourcePool() {
  if (!pool) return;
  await pool.end();
  pool = null;
}
