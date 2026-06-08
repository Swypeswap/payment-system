import { env } from "./env.js";

const PASSWORD_FUNCTION = "verify-dashboard-password";
const VERIFY_TIMEOUT_MS = 10_000;

export async function verifyDashboardPassword(password: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${env.SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/${PASSWORD_FUNCTION}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ password }),
        signal: controller.signal
      }
    );
    if (!response.ok) {
      throw new Error(`Supabase password verifier returned HTTP ${response.status}`);
    }
    const result = await response.json() as { valid?: unknown };
    return result.valid === true;
  } catch (error) {
    throw new Error(
      `Dashboard password verification is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } finally {
    clearTimeout(timeout);
  }
}
