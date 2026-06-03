import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});
const startedAt = new Date().toISOString();

export function unwrap<T>(result: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null) throw new Error("Expected database result");
  return result.data as NonNullable<T>;
}

export async function workerAudit(
  action: string,
  entityType: string,
  entityId?: string,
  metadata: Record<string, unknown> = {}
) {
  const { error } = await db.from("audit_logs").insert({
    actor_type: "worker",
    actor_id: env.WORKER_ID,
    action,
    entity_type: entityType,
    entity_id: entityId,
    metadata
  });
  if (error) console.error("Could not write audit record:", error.message);
}

export async function reportWorkerHeartbeat() {
  const { error } = await db
    .from("worker_heartbeats")
    .upsert({
      worker_id: env.WORKER_ID,
      started_at: startedAt,
      last_seen_at: new Date().toISOString(),
      metadata: {
        solana_cluster: env.SOLANA_CLUSTER,
        dry_run: env.DRY_RUN,
        reconcile_interval_ms: env.RECONCILE_INTERVAL_MS,
        event_interval_ms: env.EVENT_INTERVAL_MS,
        privacy_cash_interval_ms: env.PRIVACY_CASH_INTERVAL_MS,
        source_database_configured: Boolean(env.SOURCE_DATABASE_URL),
        source_intermediate_key_configured: Boolean(env.SOURCE_INTERMEDIATE_WALLET_ENCRYPTION_KEY),
        source_sync_interval_ms: env.SOURCE_SYNC_INTERVAL_MS
      }
    }, { onConflict: "worker_id" });
  if (error) throw new Error(error.message);
}
