import {
  ActionRowBuilder,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction
} from "discord.js";
import { validateSolanaWalletAddress } from "@payment/shared";
import { db, unwrap } from "./db.js";
import { env } from "./env.js";
import { sendRoute, setDiscordClient } from "./notifications.js";

interface Team {
  id: string;
  name: string;
  manager_wallet_address: string | null;
  team_managers: Array<{ managers: { discord_user_id: string; active: boolean } | null }>;
}

async function loadSettings() {
  return unwrap(
    await db
      .from("app_settings")
      .select("discord_manager_role_ids,discord_staff_role_ids")
      .eq("id", true)
      .single()
  ) as { discord_manager_role_ids: string[]; discord_staff_role_ids: string[] };
}

async function loadTeams(): Promise<Team[]> {
  return unwrap(
    await db
      .from("teams")
      .select("id,name,manager_wallet_address,team_managers(managers(discord_user_id,active))")
      .eq("active", true)
      .order("name")
  ) as unknown as Team[];
}

function roleIds(interaction: { member: unknown }): string[] {
  const member = interaction.member as
    | { roles?: string[] | { cache?: Map<string, unknown> } }
    | null;
  if (!member?.roles) return [];
  if (Array.isArray(member.roles)) return member.roles;
  return member.roles.cache ? [...member.roles.cache.keys()] : [];
}

function hasAnyRole(interaction: { member: unknown }, expected: string[]): boolean {
  const actual = new Set(roleIds(interaction));
  return expected.some((id) => actual.has(id));
}

function assignedTo(team: Team, discordUserId: string): boolean {
  return team.team_managers.some(
    (row) => row.managers?.active && row.managers.discord_user_id === discordUserId
  );
}

async function allowedTeams(
  interaction: { member: unknown; user: { id: string } },
  command: "request-website" | "wallet-update"
) {
  const [settings, teams] = await Promise.all([loadSettings(), loadTeams()]);
  const isManager = hasAnyRole(interaction, settings.discord_manager_role_ids);
  const isStaff = hasAnyRole(interaction, settings.discord_staff_role_ids);
  if (command === "wallet-update") {
    return isManager ? teams.filter((team) => assignedTo(team, interaction.user.id)) : [];
  }
  if (isStaff) return teams;
  return isManager ? teams.filter((team) => assignedTo(team, interaction.user.id)) : [];
}

async function teamForCommand(
  interaction: { member: unknown; user: { id: string } },
  command: "request-website" | "wallet-update",
  teamId: string
) {
  const teams = await allowedTeams(interaction, command);
  const team = teams.find((item) => item.id === teamId);
  if (!team) throw new Error("You are not allowed to use this command for that team");
  return team;
}

async function handleAutocomplete(interaction: AutocompleteInteraction) {
  const command = interaction.commandName as "request-website" | "wallet-update";
  if (!["request-website", "wallet-update"].includes(command)) return;
  const focused = interaction.options.getFocused().toLowerCase();
  const teams = await allowedTeams(interaction, command);
  await interaction.respond(
    teams
      .filter((team) => team.name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((team) => ({ name: team.name, value: team.id }))
  );
}

async function handleRequestWebsite(interaction: ChatInputCommandInteraction) {
  const teamId = interaction.options.getString("team", true);
  await teamForCommand(interaction, "request-website", teamId);
  const modal = new ModalBuilder()
    .setCustomId(`request-website:${teamId}`)
    .setTitle("Request websites");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("ideas")
        .setLabel("Ideas or inspiration")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("preferences")
        .setLabel("Preferences or requirements")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("website-count")
        .setLabel("Number of websites requested")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("For example: 3")
        .setRequired(true)
    )
  );
  await interaction.showModal(modal);
}

async function handleWalletUpdate(interaction: ChatInputCommandInteraction) {
  const teamId = interaction.options.getString("team", true);
  await teamForCommand(interaction, "wallet-update", teamId);
  const modal = new ModalBuilder()
    .setCustomId(`wallet-update:${teamId}`)
    .setTitle("Update team payout wallet");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("wallet")
        .setLabel("New Solana payout wallet")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("wallet-confirm")
        .setLabel("Confirm the new wallet address")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    )
  );
  await interaction.showModal(modal);
}

async function submitWebsiteRequest(interaction: ModalSubmitInteraction, teamId: string) {
  const team = await teamForCommand(interaction, "request-website", teamId);
  const ideas = interaction.fields.getTextInputValue("ideas").trim();
  const preferences = interaction.fields.getTextInputValue("preferences").trim();
  const websiteCount = Number(interaction.fields.getTextInputValue("website-count"));
  if (!Number.isInteger(websiteCount) || websiteCount < 1 || websiteCount > 100) {
    throw new Error("Number of websites must be a whole number between 1 and 100");
  }
  const request = unwrap(
    await db
      .from("website_requests")
      .insert({
        team_id: team.id,
        requested_by_discord_user_id: interaction.user.id,
        requested_by_username: interaction.user.username,
        ideas,
        preferences,
        website_count: websiteCount
      })
      .select("id")
      .single()
  );
  unwrap(
    await db
      .from("audit_logs")
      .insert({
        actor_type: "discord",
        actor_id: interaction.user.id,
        action: "website.requested",
        entity_type: "website_request",
        entity_id: request.id,
        metadata: { team_id: team.id, website_count: websiteCount }
      })
      .select("id")
      .single()
  );
  await sendRoute("website_request", {
    embeds: [{
      title: "New website request",
      color: 0x64f5b5,
      fields: [
        { name: "Team", value: team.name },
        { name: "Requested by", value: `${interaction.user.username} (${interaction.user.id})` },
        { name: "Number of websites", value: String(websiteCount) },
        { name: "Ideas or inspiration", value: ideas || "None provided" },
        { name: "Preferences or requirements", value: preferences || "None provided" }
      ]
    }]
  }, team.id);
  await interaction.reply({
    content: "Your website request has been sent.",
    flags: MessageFlags.Ephemeral
  });
}

async function submitWalletUpdate(interaction: ModalSubmitInteraction, teamId: string) {
  const team = await teamForCommand(interaction, "wallet-update", teamId);
  const address = interaction.fields.getTextInputValue("wallet").trim();
  const confirmation = interaction.fields.getTextInputValue("wallet-confirm").trim();
  if (address !== confirmation) throw new Error("The wallet addresses do not match");
  const wallet = validateSolanaWalletAddress(address);
  unwrap(
    await db
      .from("teams")
      .update({ manager_wallet_address: wallet })
      .eq("id", team.id)
      .select("id")
      .single()
  );
  unwrap(
    await db
      .from("wallet_update_history")
      .insert({
        team_id: team.id,
        old_wallet_address: team.manager_wallet_address,
        new_wallet_address: wallet,
        actor_type: "discord",
        actor_id: interaction.user.id
      })
      .select("id")
      .single()
  );
  unwrap(
    await db
      .from("audit_logs")
      .insert({
        actor_type: "discord",
        actor_id: interaction.user.id,
        action: "team.wallet_updated",
        entity_type: "team",
        entity_id: team.id,
        metadata: { old_wallet_address: team.manager_wallet_address, new_wallet_address: wallet }
      })
      .select("id")
      .single()
  );
  await interaction.reply({
    content: `The payout wallet for ${team.name} has been updated. Future payouts will use the new address.`,
    flags: MessageFlags.Ephemeral
  });
}

export async function startDiscordBot() {
  if (!env.DISCORD_BOT_TOKEN) {
    console.warn("Discord bot disabled: DISCORD_BOT_TOKEN is missing");
    return null;
  }
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isAutocomplete()) return await handleAutocomplete(interaction);
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "request-website") return await handleRequestWebsite(interaction);
        if (interaction.commandName === "wallet-update") return await handleWalletUpdate(interaction);
      }
      if (interaction.isModalSubmit()) {
        const [command, teamId] = interaction.customId.split(":");
        if (!teamId) return;
        if (command === "request-website") return await submitWebsiteRequest(interaction, teamId);
        if (command === "wallet-update") return await submitWalletUpdate(interaction, teamId);
      }
    } catch (error) {
      const content = error instanceof Error ? error.message : String(error);
      if (interaction.isRepliable()) {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
        } else {
          await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }
      }
    }
  });
  await client.login(env.DISCORD_BOT_TOKEN);
  setDiscordClient(client);
  console.log(`Discord bot logged in as ${client.user?.tag}`);
  return client;
}
