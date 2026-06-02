import {
  CONFETTI_WEBHOOK_AVATAR_URL,
  CONFETTI_WEBHOOK_NAMES,
  decryptSecret,
  type NotificationKind
} from "@payment/shared";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client } from "discord.js";
import { db } from "./db.js";
import { env } from "./env.js";

let discordClient: Client | null = null;

export function setDiscordClient(client: Client) {
  discordClient = client;
}

function contentWithEveryone(payload: Record<string, unknown>, mentionEveryone: boolean): string | undefined {
  const content = typeof payload.content === "string" ? payload.content : "";
  if (!mentionEveryone) return content || undefined;
  if (content.includes("@everyone")) return content;
  return content ? `@everyone\n${content}` : "@everyone";
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
  const mentionEveryone = Boolean(row.mention_everyone);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...payload,
      content: contentWithEveryone(payload, mentionEveryone),
      username: CONFETTI_WEBHOOK_NAMES[kind],
      avatar_url: CONFETTI_WEBHOOK_AVATAR_URL,
      allowed_mentions: { parse: mentionEveryone ? ["everyone"] : [] }
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

async function sendDiscordChannelMessage(
  channelId: string | null | undefined,
  content: string,
  allowedMentions: { parse?: Array<"everyone">; users?: string[] } = {}
) {
  if (!discordClient || !channelId) return false;
  const channel = await discordClient.channels.fetch(channelId);
  if (!channel?.isTextBased() || !("send" in channel)) {
    throw new Error("Configured Discord notification channel is not a text channel");
  }
  await channel.send({ content, allowedMentions });
  return true;
}

export async function sendOwnersMessage(content: string, mentionEveryone = false) {
  const settings = await db
    .from("app_settings")
    .select("owners_notifications_channel_id")
    .eq("id", true)
    .single();
  if (settings.error) throw new Error(settings.error.message);
  return sendDiscordChannelMessage(
    settings.data.owners_notifications_channel_id,
    content,
    mentionEveryone ? { parse: ["everyone"] } : {}
  );
}

export async function sendOwnersActionMessage(values: {
  content: string;
  buttonCustomId: string;
  buttonLabel: string;
  buttonStyle?: ButtonStyle;
  mentionEveryone?: boolean;
}) {
  if (!discordClient) return false;
  const settings = await db
    .from("app_settings")
    .select("owners_notifications_channel_id")
    .eq("id", true)
    .single();
  if (settings.error) throw new Error(settings.error.message);
  if (!settings.data.owners_notifications_channel_id) return false;
  const channel = await discordClient.channels.fetch(settings.data.owners_notifications_channel_id);
  if (!channel?.isTextBased() || !("send" in channel)) {
    throw new Error("Configured Discord notification channel is not a text channel");
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(values.buttonCustomId)
      .setLabel(values.buttonLabel)
      .setStyle(values.buttonStyle ?? ButtonStyle.Primary)
  );
  await channel.send({
    content: values.content,
    components: [row],
    allowedMentions: values.mentionEveryone ? { parse: ["everyone"] } : {}
  });
  return true;
}

export async function sendManagerMessage(
  team: { payout_discord_channel_id?: string | null },
  managerDiscordUserIds: string[],
  content: string
) {
  return sendDiscordChannelMessage(team.payout_discord_channel_id, content, {
    users: managerDiscordUserIds
  });
}
