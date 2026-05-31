import { hostname } from "node:os";
import { z } from "zod";

const optionalSecret = z.string().min(1).optional();

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  MASTER_ENCRYPTION_KEY: z.string().min(40),
  SOLANA_RPC_URL: z.string().url(),
  SOLANA_CLUSTER: z.enum(["mainnet-beta", "devnet"]).default("devnet"),
  JUPITER_API_KEY: optionalSecret,
  HELIUS_API_KEY: optionalSecret,
  HELIUS_WEBHOOK_URL: z.string().url().optional(),
  HELIUS_WEBHOOK_AUTH: optionalSecret,
  DISCORD_BOT_TOKEN: optionalSecret,
  DISCORD_APPLICATION_ID: optionalSecret,
  DISCORD_GUILD_ID: optionalSecret,
  DISCORD_OWNERS_GUILD_ID: optionalSecret,
  DRY_RUN: z
    .string()
    .default("true")
    .transform((value) => value.toLowerCase() !== "false"),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  EVENT_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  PRIVACY_CASH_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  ROTATION_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(21_600_000),
  HELIUS_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(600_000),
  WORKER_ID: z.string().default(`${hostname()}-${process.pid}`)
});

export const env = envSchema.parse(process.env);
