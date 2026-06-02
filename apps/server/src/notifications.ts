import {
  CONFETTI_WEBHOOK_AVATAR_URL,
  CONFETTI_WEBHOOK_NAMES,
  decryptSecret,
  encryptSecret,
  type NotificationKind
} from "@payment/shared";
import { db, unwrap } from "./db.js";
import { env } from "./env.js";

interface RouteRow {
  encrypted_webhook_url: string;
  encryption_nonce: string;
  encryption_auth_tag: string;
  encryption_key_version: number;
  mention_everyone?: boolean;
}

function contentWithEveryone(payload: Record<string, unknown>, mentionEveryone: boolean): string | undefined {
  const content = typeof payload.content === "string" ? payload.content : "";
  if (!mentionEveryone) return content || undefined;
  if (content.includes("@everyone")) return content;
  return content ? `@everyone\n${content}` : "@everyone";
}

export function encryptWebhookUrl(url: string) {
  const parsed = new URL(url);
  const allowedHosts = new Set(["discord.com", "discordapp.com"]);
  if (
    parsed.protocol !== "https:" ||
    !allowedHosts.has(parsed.hostname) ||
    !parsed.pathname.startsWith("/api/webhooks/")
  ) {
    throw new Error("Webhook must be a Discord HTTPS webhook URL");
  }
  return encryptSecret(url, env.MASTER_ENCRYPTION_KEY);
}

async function getRoute(kind: NotificationKind, teamId?: string): Promise<RouteRow | null> {
  if (teamId) {
    const teamResult = await db
      .from("notification_routes")
      .select("encrypted_webhook_url,encryption_nonce,encryption_auth_tag,encryption_key_version,mention_everyone")
      .eq("kind", kind)
      .eq("team_id", teamId)
      .eq("enabled", true)
      .maybeSingle();
    if (teamResult.error) {
      throw new Error(teamResult.error.message);
    }
    if (teamResult.data) {
      return teamResult.data;
    }
  }

  const globalResult = await db
    .from("notification_routes")
    .select("encrypted_webhook_url,encryption_nonce,encryption_auth_tag,encryption_key_version,mention_everyone")
    .eq("kind", kind)
    .is("team_id", null)
    .eq("enabled", true)
    .maybeSingle();
  if (globalResult.error) {
    throw new Error(globalResult.error.message);
  }
  return globalResult.data;
}

export async function sendWebhook(
  kind: NotificationKind,
  payload: Record<string, unknown>,
  options: { teamId?: string; mentionEveryone?: boolean } = {}
): Promise<boolean> {
  const row = await getRoute(kind, options.teamId);
  if (!row) {
    return false;
  }
  const webhookUrl = decryptSecret(
    {
      ciphertext: row.encrypted_webhook_url,
      nonce: row.encryption_nonce,
      authTag: row.encryption_auth_tag,
      keyVersion: row.encryption_key_version
    },
    env.MASTER_ENCRYPTION_KEY
  );
  const deliveryUrl = new URL(webhookUrl);
  if (Array.isArray(payload.components) && payload.components.length > 0) {
    deliveryUrl.searchParams.set("with_components", "true");
  }
  const mentionEveryone = Boolean(options.mentionEveryone || row.mention_everyone);
  const response = await fetch(deliveryUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...payload,
      content: contentWithEveryone(payload, mentionEveryone),
      username: CONFETTI_WEBHOOK_NAMES[kind],
      avatar_url: CONFETTI_WEBHOOK_AVATAR_URL,
      allowed_mentions: {
        parse: mentionEveryone ? ["everyone"] : []
      }
    })
  });
  if (!response.ok) {
    throw new Error(`Discord webhook failed with HTTP ${response.status}`);
  }
  return true;
}

export async function listRedactedRoutes() {
  return unwrap(
    await db
      .from("notification_routes")
      .select("id,kind,team_id,name,enabled,mention_everyone,updated_at")
      .order("kind")
  );
}
