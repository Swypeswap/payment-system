import { createSecretKey, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { db, unwrap } from "./db.js";
import { env } from "./env.js";
import { dashboardNetworkKey, describeDevice } from "./security.js";

const key = createSecretKey(Buffer.from(env.SESSION_SECRET, "utf8"));
const cookieName = "payment_dashboard_session";
const SESSION_MS = 12 * 60 * 60 * 1000;

interface SessionContext {
  ip: string;
  userAgent?: string;
}

async function verifiedSession(token?: string) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key);
    return payload.role === "dashboard" &&
      payload.sub === "shared-staff-account" &&
      typeof payload.jti === "string" &&
      typeof payload.generation === "number"
      ? { id: payload.jti, generation: payload.generation }
      : null;
  } catch {
    return null;
  }
}

export async function createSessionToken(context: SessionContext): Promise<string> {
  const id = randomUUID();
  const generation = unwrap(
    await db.from("dashboard_session_control").select("generation").eq("id", true).single()
  ).generation;
  const expiresAt = new Date(Date.now() + SESSION_MS).toISOString();
  unwrap(
    await db
      .from("dashboard_sessions")
      .insert({
        id,
        generation,
        ip_address: context.ip,
        network_key: dashboardNetworkKey(context.ip),
        device: describeDevice(context.userAgent),
        user_agent: context.userAgent,
        expires_at: expiresAt
      })
      .select("id")
      .single()
  );

  return new SignJWT({ role: "dashboard", generation })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("shared-staff-account")
    .setJti(id)
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(key);
}

export async function isValidSession(token?: string): Promise<boolean> {
  const session = await verifiedSession(token);
  if (!session) return false;
  const result = await db
    .from("dashboard_sessions")
    .select("id")
    .eq("id", session.id)
    .eq("generation", session.generation)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) return false;
  void db
    .from("dashboard_sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", session.id)
    .then(({ error }) => {
      if (error) console.error("Could not refresh dashboard session timestamp", error.message);
    });
  return true;
}

export async function revokeSession(token?: string) {
  const session = await verifiedSession(token);
  if (!session) return;
  const { error } = await db
    .from("dashboard_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", session.id)
    .is("revoked_at", null);
  if (error) throw new Error(error.message);
}

export async function listActiveSessions() {
  return unwrap(
    await db
      .from("dashboard_sessions")
      .select("id,ip_address,network_key,device,created_at,last_seen_at,expires_at")
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
  );
}

export async function revokeAllSessions() {
  const { error } = await db.rpc("revoke_all_dashboard_sessions");
  if (error) throw new Error(error.message);
}

export const dashboardCookie = {
  name: cookieName,
  options: {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
    maxAge: SESSION_MS / 1000
  }
};
