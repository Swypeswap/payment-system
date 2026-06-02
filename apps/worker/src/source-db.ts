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
  commission_pct: string | number | null;
  approved_at: string | null;
}

interface CurrentPerformerConfig {
  telegramUserId: string;
  telegramUsername: string | null;
  payoutWallet: string | null;
  commissionPct: number | null;
  approved: boolean;
  sourceUpdatedAt: string | null;
}

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
      max: 2,
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
  const rows = await querySource<SourcePerformer & { approved_username: string | null }>(
    `select
       p.telegram_user_id,
       p.telegram_username,
       p.payout_wallet,
       p.created_at,
       p.updated_at,
       a.telegram_username as approved_username,
       a.commission_pct,
       a.approved_at
     from public.performers p
     left join public.approved_performers a
       on a.telegram_user_id = p.telegram_user_id
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
    commissionPct: row.commission_pct === null ? null : Number(row.commission_pct),
    approved: row.commission_pct !== null,
    sourceUpdatedAt: row.updated_at ?? null
  };
}

export async function syncExternalSource() {
  if (!sourceSyncConfigured()) return;
  const [sites, performers] = await Promise.all([
    querySource<SourceSite>(
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
    ),
    querySource<SourcePerformer>(
      `select
         p.telegram_user_id,
         p.telegram_username,
         p.payout_wallet,
         p.created_at,
         p.updated_at,
         a.commission_pct,
         a.approved_at
       from public.performers p
       left join public.approved_performers a
         on a.telegram_user_id = p.telegram_user_id`
    )
  ]);

  const seenSiteIds = sites.map((site) => site.id);
  const now = new Date().toISOString();

  if (performers.length) {
    const { error } = await db.from("source_performer_snapshots").upsert(
      performers.map((performer) => ({
        telegram_user_id: sourceId(performer.telegram_user_id),
        telegram_username: performer.telegram_username,
        payout_wallet: performer.payout_wallet,
        commission_pct: performer.commission_pct,
        approved: performer.commission_pct !== null,
        source_updated_at: performer.updated_at,
        synced_at: now
      })),
      { onConflict: "telegram_user_id" }
    );
    if (error) throw new Error(error.message);
  }

  if (sites.length) {
    const { error } = await db.from("external_revenue_wallets").upsert(
      sites.map((site) => ({
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
      })),
      { onConflict: "external_site_id" }
    );
    if (error) throw new Error(error.message);
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
