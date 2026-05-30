import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { env } from "./env.js";

if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_APPLICATION_ID || !env.DISCORD_GUILD_ID) {
  throw new Error("DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, and DISCORD_GUILD_ID are required");
}

const commands = [
  new SlashCommandBuilder()
    .setName("request-website")
    .setDescription("Request one or more websites for your team")
    .setDefaultMemberPermissions(0n)
    .addStringOption((option) =>
      option
        .setName("team")
        .setDescription("The team requesting the websites")
        .setAutocomplete(true)
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("wallet-update")
    .setDescription("Update the manager payout wallet for one of your teams")
    .setDefaultMemberPermissions(0n)
    .addStringOption((option) =>
      option
        .setName("team")
        .setDescription("The team whose payout wallet should change")
        .setAutocomplete(true)
        .setRequired(true)
    )
].map((command) => command.toJSON());

const rest = new REST({ version: "10" }).setToken(env.DISCORD_BOT_TOKEN);
await rest.put(
  Routes.applicationGuildCommands(env.DISCORD_APPLICATION_ID, env.DISCORD_GUILD_ID),
  { body: commands }
);
console.log("Registered Discord guild commands.");
