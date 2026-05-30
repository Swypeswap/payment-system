import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

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
