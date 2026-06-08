import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  MASTER_ENCRYPTION_KEY: z.string().min(40),
  SESSION_SECRET: z.string().min(32),
  HELIUS_WEBHOOK_AUTH: z.string().min(20),
  SUPABASE_LOG_DRAIN_AUTH: z.string().min(20).optional(),
  IPINFO_TOKEN: z.string().min(1).optional(),
  PUBLIC_BASE_URL: z.string().url().optional()
});

export const env = envSchema.parse(process.env);
