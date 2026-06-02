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
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction
} from "discord.js";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import {
  encryptSecret,
  validateSolanaWalletAddress
} from "@payment/shared";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { db, unwrap } from "./db.js";
import { env } from "./env.js";
import {
  sendManagerMessage,
  sendOwnersMessage,
  sendRoute,
  setDiscordClient
} from "./notifications.js";

const connection = new Connection(env.SOLANA_RPC_URL, "confirmed");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

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
      .select("discord_manager_role_ids,discord_staff_role_ids,owners_discord_guild_id")
      .eq("id", true)
      .single()
  ) as {
    discord_manager_role_ids: string[];
    discord_staff_role_ids: string[];
    owners_discord_guild_id: string | null;
  };
}

async function loadOwner(discordUserId: string) {
  return unwrap(
    await db
      .from("owner_profiles")
      .select("*")
      .eq("discord_user_id", discordUserId)
      .eq("active", true)
      .single()
  ) as {
    id: string;
    display_name: string;
    discord_user_id: string;
    solana_wallet_address: string | null;
  };
}

async function requireOwner(interaction: { guildId: string | null; user: { id: string } }) {
  const settings = await loadSettings();
  if (!settings.owners_discord_guild_id || interaction.guildId !== settings.owners_discord_guild_id) {
    throw new Error("This owner command is only available in the configured owners server");
  }
  return loadOwner(interaction.user.id);
}

function hashActionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function walletIsEmpty(address: string) {
  const publicKey = new PublicKey(address);
  const [solBalance, classic, token2022] = await Promise.all([
    connection.getBalance(publicKey, "confirmed"),
    connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_2022_PROGRAM_ID })
  ]);
  const tokenBalances = [...classic.value, ...token2022.value].filter(({ account }) =>
    BigInt(account.data.parsed.info.tokenAmount.amount as string) > 0n
  );
  return solBalance === 0 && tokenBalances.length === 0;
}

async function completeLifecycleRequest(requestId: string, status: "completed" | "failed", error?: string) {
  unwrap(
    await db
      .from("wallet_lifecycle_requests")
      .update({
        status,
        error: error ?? null,
        completed_at: status === "completed" ? new Date().toISOString() : null
      })
      .eq("id", requestId)
      .select("id")
      .single()
  );
}

async function handleCompanyRotation(interaction: ButtonInteraction, owner: { id: string; discord_user_id: string }, request: {
  id: string;
  company_wallet_id: string;
}) {
  try {
    const keypair = Keypair.generate();
    const privateKey = bs58.encode(keypair.secretKey);
    const encrypted = encryptSecret(privateKey, env.MASTER_ENCRYPTION_KEY);
    const oldWallet = unwrap(
      await db.from("company_wallets").select("*").eq("id", request.company_wallet_id).single()
    ) as { id: string; address: string; status: string };
    if (oldWallet.status !== "active") {
      throw new Error("The original company wallet is no longer active");
    }
    const newWallet = unwrap(
      await db.rpc("rotate_company_wallet", {
        requested_old_wallet_id: oldWallet.id,
        generated_address: keypair.publicKey.toBase58(),
        generated_encrypted_private_key: encrypted.ciphertext,
        generated_encryption_nonce: encrypted.nonce,
        generated_encryption_auth_tag: encrypted.authTag,
        generated_encryption_key_version: encrypted.keyVersion
      })
    );
    await completeLifecycleRequest(request.id, "completed");
    unwrap(
      await db.from("audit_logs").insert({
        actor_type: "discord",
        actor_id: owner.discord_user_id,
        action: "company_wallet.rotated",
        entity_type: "company_wallet",
        entity_id: newWallet.id,
        metadata: { old_wallet_id: oldWallet.id }
      }).select("id").single()
    );
    await sendRoute("company_wallet_rotated", {
      embeds: [{
        title: "Company wallet rotated",
        color: 0x64f5b5,
        fields: [
          { name: "Old wallet", value: oldWallet.address },
          { name: "New wallet", value: newWallet.address },
          { name: "Approved by", value: `<@${owner.discord_user_id}>` }
        ]
      }]
    });
    await interaction.reply({
      content: `Company wallet generated. New active wallet: ${newWallet.address}`,
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await completeLifecycleRequest(request.id, "failed", message);
    await sendRoute("company_wallet_generation_failed", { content: `Company wallet rotation failed: ${message}` });
    throw error;
  }
}

async function handleKeyErasure(interaction: ButtonInteraction, owner: { id: string; discord_user_id: string }, request: {
  id: string;
  action: "revenue_key_erasure" | "company_key_erasure";
  external_revenue_wallet_id: string | null;
  company_wallet_id: string | null;
}) {
  if (request.action === "revenue_key_erasure") {
    const wallet = unwrap(
      await db.from("external_revenue_wallets").select("*").eq("id", request.external_revenue_wallet_id).single()
    ) as { id: string; domain: string; address: string; mirror_status: string };
    if (wallet.mirror_status !== "retired") throw new Error("Revenue wallet is no longer eligible for key deletion");
    if (!(await walletIsEmpty(wallet.address))) throw new Error("Revenue wallet is not empty anymore");
    unwrap(
      await db
        .from("external_revenue_wallets")
        .update({
          mirror_status: "key_erased",
          encrypted_private_key_blob: null,
          key_erased_at: new Date().toISOString()
        })
        .eq("id", wallet.id)
        .eq("mirror_status", "retired")
        .select("id")
        .single()
    );
    await completeLifecycleRequest(request.id, "completed");
    await sendRoute("retired_revenue_wallet_deleted", {
      embeds: [{
        title: "Retired revenue-wallet key erased",
        color: 0x64f5b5,
        fields: [
          { name: "Domain", value: wallet.domain },
          { name: "Public wallet", value: wallet.address },
          { name: "Approved by", value: `<@${owner.discord_user_id}>` }
        ]
      }]
    });
    await interaction.reply({ content: "Retired revenue-wallet key erased permanently.", flags: MessageFlags.Ephemeral });
    return;
  }

  const wallet = unwrap(
    await db.from("company_wallets").select("*").eq("id", request.company_wallet_id).single()
  ) as { id: string; address: string; status: string };
  if (wallet.status !== "archived") throw new Error("Company wallet is no longer eligible for key deletion");
  if (!(await walletIsEmpty(wallet.address))) throw new Error("Company wallet is not empty anymore");
  unwrap(
    await db
      .from("company_wallets")
      .update({
        status: "key_erased",
        encrypted_private_key: null,
        encryption_nonce: null,
        encryption_auth_tag: null,
        key_erased_at: new Date().toISOString()
      })
      .eq("id", wallet.id)
      .eq("status", "archived")
      .select("id")
      .single()
  );
  await completeLifecycleRequest(request.id, "completed");
  await sendRoute("archived_company_wallet_deleted", {
    embeds: [{
      title: "Archived company-wallet key erased",
      color: 0x64f5b5,
      fields: [
        { name: "Public wallet", value: wallet.address },
        { name: "Approved by", value: `<@${owner.discord_user_id}>` }
      ]
    }]
  });
  await interaction.reply({ content: "Archived company-wallet key erased permanently.", flags: MessageFlags.Ephemeral });
}

async function handleWalletActionButton(interaction: ButtonInteraction) {
  const owner = await requireOwner(interaction);
  const token = interaction.customId.slice("wallet-action:".length);
  const request = unwrap(
    await db.rpc("claim_wallet_lifecycle_request", {
      requested_token_hash: hashActionToken(token),
      requested_owner_profile_id: owner.id
    })
  ) as {
    id: string;
    action: "company_rotation" | "revenue_key_erasure" | "company_key_erasure";
    external_revenue_wallet_id: string | null;
    company_wallet_id: string | null;
  };
  if (request.action === "company_rotation") {
    return handleCompanyRotation(interaction, owner, {
      id: request.id,
      company_wallet_id: request.company_wallet_id ?? ""
    });
  }
  return handleKeyErasure(interaction, owner, {
    id: request.id,
    action: request.action,
    external_revenue_wallet_id: request.external_revenue_wallet_id,
    company_wallet_id: request.company_wallet_id
  });
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
  if (["approve-manager-wallet", "reject-manager-wallet"].includes(interaction.commandName)) {
    await requireOwner(interaction);
    const focused = interaction.options.getFocused().toLowerCase();
    const requests = unwrap(
      await db
        .from("manager_wallet_change_requests")
        .select("id,teams(name)")
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(25)
    ) as unknown as Array<{ id: string; teams: { name: string } }>;
    await interaction.respond(
      requests
        .filter((request) => request.teams.name.toLowerCase().includes(focused))
        .map((request) => ({ name: request.teams.name, value: request.id }))
    );
    return;
  }
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

async function handleOwnerWalletUpdate(interaction: ChatInputCommandInteraction) {
  await requireOwner(interaction);
  const modal = new ModalBuilder()
    .setCustomId("owner-wallet-update")
    .setTitle("Update your owner payout wallet");
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

async function loadPendingManagerWalletRequest(requestId: string) {
  return unwrap(
    await db
      .from("manager_wallet_change_requests")
      .select("*,teams(id,name,payout_discord_channel_id,team_managers(managers(discord_user_id,active)))")
      .eq("id", requestId)
      .eq("status", "pending")
      .single()
  ) as {
    id: string;
    team_id: string;
    old_wallet_address: string | null;
    new_wallet_address: string;
    requested_by_actor_id: string;
    teams: {
      id: string;
      name: string;
      payout_discord_channel_id: string | null;
      team_managers: Array<{ managers: { discord_user_id: string; active: boolean } | null }>;
    };
  };
}

async function reviewManagerWalletRequest(
  interaction: ChatInputCommandInteraction,
  status: "approved" | "rejected"
) {
  const owner = await requireOwner(interaction);
  const requestId = interaction.options.getString("request", true);
  const request = await loadPendingManagerWalletRequest(requestId);
  if (status === "approved") {
    unwrap(
      await db
        .from("teams")
        .update({
          manager_wallet_address: request.new_wallet_address,
          manager_wallet_updated_at: new Date().toISOString()
        })
        .eq("id", request.team_id)
        .select("id")
        .single()
    );
    unwrap(
      await db
        .from("wallet_update_history")
        .insert({
          team_id: request.team_id,
          old_wallet_address: request.old_wallet_address,
          new_wallet_address: request.new_wallet_address,
          actor_type: "discord",
          actor_id: owner.discord_user_id
        })
        .select("id")
        .single()
    );
  }
  unwrap(
    await db
      .from("manager_wallet_change_requests")
      .update({
        status,
        reviewed_by_owner_profile_id: owner.id,
        reviewed_at: new Date().toISOString()
      })
      .eq("id", request.id)
      .eq("status", "pending")
      .select("id")
      .single()
  );
  unwrap(
    await db
      .from("audit_logs")
      .insert({
        actor_type: "discord",
        actor_id: owner.discord_user_id,
        action: `team.wallet_change_${status}`,
        entity_type: "manager_wallet_change_request",
        entity_id: request.id,
        metadata: { team_id: request.team_id }
      })
      .select("id")
      .single()
  );
  const managerIds = request.teams.team_managers
    .filter((row) => row.managers?.active)
    .map((row) => row.managers?.discord_user_id)
    .filter((id): id is string => Boolean(id));
  await sendOwnersMessage(
    `Manager payout wallet request for ${request.teams.name} was ${status} by <@${owner.discord_user_id}>.`
  );
  await sendManagerMessage(
    request.teams,
    managerIds,
    `${managerIds.map((id) => `<@${id}>`).join(" ")} Your payout wallet request for ${request.teams.name} was ${status}.`
  );
  await interaction.reply({
    content: `The manager payout wallet request for ${request.teams.name} was ${status}.`,
    flags: MessageFlags.Ephemeral
  });
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
  const pending = await db
    .from("manager_wallet_change_requests")
    .select("id")
    .eq("team_id", team.id)
    .eq("status", "pending")
    .maybeSingle();
  if (pending.error) throw new Error(pending.error.message);
  const values = {
    team_id: team.id,
    old_wallet_address: team.manager_wallet_address,
    new_wallet_address: wallet,
    requested_by_actor_type: "discord",
    requested_by_actor_id: interaction.user.id,
    status: "pending"
  };
  const request = pending.data
    ? unwrap(
        await db
          .from("manager_wallet_change_requests")
          .update(values)
          .eq("id", pending.data.id)
          .select("id")
          .single()
      )
    : unwrap(
        await db
          .from("manager_wallet_change_requests")
          .insert(values)
          .select("id")
          .single()
      );
  unwrap(
    await db
      .from("audit_logs")
      .insert({
        actor_type: "discord",
        actor_id: interaction.user.id,
        action: "team.wallet_change_requested",
        entity_type: "manager_wallet_change_request",
        entity_id: request.id,
        metadata: { old_wallet_address: team.manager_wallet_address, new_wallet_address: wallet }
      })
      .select("id")
      .single()
  );
  await sendOwnersMessage(
    `@everyone <@${interaction.user.id}> requested a manager payout wallet update for ${team.name}. Review it with /approve-manager-wallet or /reject-manager-wallet.`,
    true
  );
  await interaction.reply({
    content: `Your payout wallet request for ${team.name} is waiting for owner approval. Payouts continue to the previously approved wallet until then.`,
    flags: MessageFlags.Ephemeral
  });
}

async function submitOwnerWalletUpdate(interaction: ModalSubmitInteraction) {
  const owner = await requireOwner(interaction);
  const address = interaction.fields.getTextInputValue("wallet").trim();
  const confirmation = interaction.fields.getTextInputValue("wallet-confirm").trim();
  if (address !== confirmation) throw new Error("The wallet addresses do not match");
  const wallet = validateSolanaWalletAddress(address);
  unwrap(
    await db
      .from("owner_profiles")
      .update({ solana_wallet_address: wallet, wallet_updated_at: new Date().toISOString() })
      .eq("id", owner.id)
      .select("id")
      .single()
  );
  unwrap(
    await db
      .from("owner_wallet_update_history")
      .insert({
        owner_profile_id: owner.id,
        old_wallet_address: owner.solana_wallet_address,
        new_wallet_address: wallet,
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
        action: "owner.wallet_updated",
        entity_type: "owner_profile",
        entity_id: owner.id,
        metadata: { old_wallet_address: owner.solana_wallet_address, new_wallet_address: wallet }
      })
      .select("id")
      .single()
  );
  await sendOwnersMessage(`<@${owner.discord_user_id}> updated their owner payout wallet.`);
  await interaction.reply({
    content: "Your owner payout wallet has been updated. Future payout batches will use the new address.",
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
      if (interaction.isButton() && interaction.customId.startsWith("wallet-action:")) {
        return await handleWalletActionButton(interaction);
      }
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "request-website") return await handleRequestWebsite(interaction);
        if (interaction.commandName === "wallet-update") return await handleWalletUpdate(interaction);
        if (interaction.commandName === "owner-wallet-update") return await handleOwnerWalletUpdate(interaction);
        if (interaction.commandName === "approve-manager-wallet") {
          return await reviewManagerWalletRequest(interaction, "approved");
        }
        if (interaction.commandName === "reject-manager-wallet") {
          return await reviewManagerWalletRequest(interaction, "rejected");
        }
      }
      if (interaction.isModalSubmit()) {
        if (interaction.customId === "owner-wallet-update") return await submitOwnerWalletUpdate(interaction);
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
