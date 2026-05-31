import {
  CONFETTI_WEBHOOK_AVATAR_URL,
  CONFETTI_WEBHOOK_NAMES,
  decryptSecret,
  type NotificationKind
} from "@payment/shared";
import type { Client } from "discord.js";
import { db } from "./db.js";
import { env } from "./env.js";

let discordClient: Client | null = null;

export function setDiscordClient(client: Client) {
  discordClient = client;
}

async function getRoute(kind: NotificationKind, teamId?: string) {
  if (teamId) {
    const teamRoute = await db
      .from("notification_routes")
      .select("*")
      .eq("kind", kind)
      .eq("team_id", teamId)
      .eq("enabled", true)
      .maybeSingle();
    if (teamRoute.error) throw new Error(teamRoute.error.message);
    if (teamRoute.data) return teamRoute.data;
  }
  const globalRoute = await db
    .from("notification_routes")
    .select("*")
    .eq("kind", kind)
    .is("team_id", null)
    .eq("enabled", true)
    .maybeSingle();
  if (globalRoute.error) throw new Error(globalRoute.error.message);
  return globalRoute.data;
}

export async function sendRoute(
  kind: NotificationKind,
  payload: Record<string, unknown>,
  teamId?: string
) {
  const row = await getRoute(kind, teamId);
  if (!row) return false;
  const url = decryptSecret(
    {
      ciphertext: row.encrypted_webhook_url,
      nonce: row.encryption_nonce,
      authTag: row.encryption_auth_tag,
      keyVersion: row.encryption_key_version
    },
    env.MASTER_ENCRYPTION_KEY
  );
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...payload,
      username: CONFETTI_WEBHOOK_NAMES[kind],
      avatar_url: CONFETTI_WEBHOOK_AVATAR_URL,
      allowed_mentions: { parse: [] }
    })
  });
  if (!response.ok) throw new Error(`Discord webhook failed with HTTP ${response.status}`);
  return true;
}

export async function sendTeamPayoutMessage(team: {
  payout_discord_channel_id?: string | null;
  payout_message?: string | null;
}) {
  if (!discordClient || !team.payout_discord_channel_id) return false;
  const channel = await discordClient.channels.fetch(team.payout_discord_channel_id);
  if (!channel?.isTextBased() || !("send" in channel)) {
    throw new Error("Configured team payout channel is not a text channel");
  }
  await channel.send(team.payout_message || "New payout for the team. GG! 💸 🎉");
  return true;
}
