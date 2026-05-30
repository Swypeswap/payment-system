import { db } from "./db.js";

export async function audit(
  action: string,
  entityType: string,
  entityId?: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const { error } = await db.from("audit_logs").insert({
    actor_type: "dashboard",
    actor_id: "shared-staff-account",
    action,
    entity_type: entityType,
    entity_id: entityId,
    metadata
  });
  if (error) {
    throw new Error(error.message);
  }
}
