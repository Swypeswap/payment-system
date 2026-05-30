import { createSecretKey } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { env } from "./env.js";

const key = createSecretKey(Buffer.from(env.SESSION_SECRET, "utf8"));
const cookieName = "payment_dashboard_session";

export async function createSessionToken(): Promise<string> {
  return new SignJWT({ role: "dashboard" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("shared-staff-account")
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(key);
}

export async function isValidSession(token?: string): Promise<boolean> {
  if (!token) {
    return false;
  }
  try {
    const { payload } = await jwtVerify(token, key);
    return payload.role === "dashboard" && payload.sub === "shared-staff-account";
  } catch {
    return false;
  }
}

export const dashboardCookie = {
  name: cookieName,
  options: {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
    maxAge: 60 * 60 * 12
  }
};
