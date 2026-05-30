import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

export function unwrap<T>(result: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (result.error) {
    throw new Error(result.error.message);
  }
  if (result.data === null) {
    throw new Error("Expected database result");
  }
  return result.data as NonNullable<T>;
}
