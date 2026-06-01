import type { FastifyRequest } from "fastify";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { isIP } from "node:net";
import { db } from "./db.js";
import { env } from "./env.js";
import { sendWebhook } from "./notifications.js";

interface PrivacySignals {
  vpn: boolean;
  proxy: boolean;
  tor: boolean;
  relay: boolean;
  hosting: boolean;
  service: string;
}

interface SecurityContext {
  ip: string;
  device: string;
  vpn: string;
  privacySignals: string;
}

interface SupabaseSignal {
  rule: string;
  source: string;
  ip?: string;
  userAgent?: string;
}

const privacyCache = new Map<string, { expiresAt: number; signals: PrivacySignals | null }>();
const CACHE_MS = 60 * 60 * 1000;
const LOCKDOWN_CACHE_MS = 1000;
const NETWORK_BLOCK_MIN_SECONDS = 96 * 60 * 60;
const NETWORK_BLOCK_MAX_SECONDS = 5 * 7 * 24 * 60 * 60;
const DISTRIBUTED_BLOCK_WINDOW_MS = 15 * 60 * 1000;
const DISTRIBUTED_BLOCK_THRESHOLD = 3;
let lockdownCache: { active: boolean; expiresAt: number } | null = null;

function truncate(value: unknown, max = 1024): string {
  const text = String(value ?? "-");
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function isPrivateIp(ip: string): boolean {
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith("fc") ||
    ip.startsWith("fd")
  );
}

function describeDevice(userAgent = ""): string {
  const os = /iPhone|iPad|iPod/i.test(userAgent)
    ? "iOS"
    : /Android/i.test(userAgent)
      ? "Android"
      : /Windows/i.test(userAgent)
        ? "Windows"
        : /Macintosh|Mac OS X/i.test(userAgent)
          ? "macOS"
          : /Linux/i.test(userAgent)
            ? "Linux"
            : "Unknown OS";
  const kind = /iPhone|Android.+Mobile/i.test(userAgent)
    ? "Phone"
    : /iPad|Tablet|Android/i.test(userAgent)
      ? "Tablet"
      : "PC";
  return `${kind} - ${os}`;
}

async function lookupPrivacy(ip: string): Promise<PrivacySignals | null> {
  if (!env.IPINFO_TOKEN || !isIP(ip) || isPrivateIp(ip)) {
    return null;
  }
  const cached = privacyCache.get(ip);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.signals;
  }

  try {
    const host = ip.includes(":") ? "v6.ipinfo.io" : "ipinfo.io";
    const response = await fetch(`https://${host}/${encodeURIComponent(ip)}/privacy`, {
      headers: { authorization: `Bearer ${env.IPINFO_TOKEN}` },
      signal: AbortSignal.timeout(2500)
    });
    if (!response.ok) {
      throw new Error(`IPinfo returned HTTP ${response.status}`);
    }
    const values = (await response.json()) as Partial<PrivacySignals>;
    const signals = {
      vpn: values.vpn === true,
      proxy: values.proxy === true,
      tor: values.tor === true,
      relay: values.relay === true,
      hosting: values.hosting === true,
      service: typeof values.service === "string" ? values.service : ""
    };
    privacyCache.set(ip, { expiresAt: Date.now() + CACHE_MS, signals });
    return signals;
  } catch {
    privacyCache.set(ip, { expiresAt: Date.now() + 5 * 60 * 1000, signals: null });
    return null;
  }
}

async function contextFor(ip: string, userAgent?: string): Promise<SecurityContext> {
  const signals = await lookupPrivacy(ip);
  const privacySignals = signals
    ? [
        signals.proxy ? "Proxy" : "",
        signals.tor ? "Tor" : "",
        signals.relay ? "Relay" : "",
        signals.hosting ? "Hosting" : "",
        signals.service
      ].filter(Boolean).join(", ") || "None detected"
    : env.IPINFO_TOKEN
      ? "Unavailable"
      : "Unknown - IPINFO_TOKEN is not configured";
  return {
    ip,
    device: describeDevice(userAgent),
    vpn: signals ? (signals.vpn ? "Yes" : "No") : "Unknown",
    privacySignals
  };
}

function auditSecurityEvent(action: string, context: SecurityContext, metadata: Record<string, unknown>) {
  void db
    .from("audit_logs")
    .insert({
      actor_type: "security",
      actor_id: context.ip,
      action,
      entity_type: "security_event",
      metadata: { ...metadata, ...context }
    })
    .then(({ error }) => {
      if (error) {
        console.error("Could not record security audit event", error.message);
      }
    });
}

function auditOperationalSecurityEvent(action: string, metadata: Record<string, unknown>) {
  void db
    .from("audit_logs")
    .insert({
      actor_type: "security",
      actor_id: "vps-security-ops",
      action,
      entity_type: "security_event",
      metadata
    })
    .then(({ error }) => {
      if (error) {
        console.error("Could not record operational security audit event", error.message);
      }
    });
}

async function sendOperationalSecurityAlert(
  title: string,
  metadata: Record<string, unknown>
) {
  auditOperationalSecurityEvent(`security.${String(metadata.event ?? "operational_alert")}`, metadata);
  const delivered = await sendWebhook("security_alert", {
    content: "@everyone",
    embeds: [{
      title,
      color: 0xff315f,
      timestamp: new Date().toISOString(),
      fields: Object.entries(metadata).map(([name, value]) => ({
        name: truncate(name, 256),
        value: truncate(value)
      }))
    }]
  }, { mentionEveryone: true });
  if (!delivered) {
    throw new Error("Global security_alert webhook route is not configured");
  }
}

export async function sendDashboardSecurityAlert(
  request: FastifyRequest,
  title: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const context = await contextFor(request.ip, request.headers["user-agent"]);
  auditSecurityEvent(`security.${String(metadata.event ?? "dashboard_alert")}`, context, metadata);
  await sendWebhook("security_alert", {
    content: "@everyone",
    embeds: [{
      title,
      color: 0xff315f,
      timestamp: new Date().toISOString(),
      fields: [
        { name: "IP address", value: truncate(context.ip), inline: true },
        { name: "Device", value: truncate(context.device), inline: true },
        { name: "VPN", value: truncate(context.vpn), inline: true },
        { name: "Privacy signals", value: truncate(context.privacySignals) },
        ...Object.entries(metadata).map(([name, value]) => ({
          name: truncate(name, 256),
          value: truncate(value)
        }))
      ]
    }]
  }, { mentionEveryone: true });
}

function findString(value: unknown, keys: Set<string>): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, nested] of Object.entries(value)) {
    if (keys.has(key.toLowerCase()) && typeof nested === "string" && nested.trim()) {
      return nested;
    }
    const found = findString(nested, keys);
    if (found) return found;
  }
  return undefined;
}

function classifySupabaseLog(value: unknown): SupabaseSignal | null {
  const text = JSON.stringify(value);
  const rules: Array<[string, RegExp]> = [
    ["Database authentication failure", /(password authentication failed|authentication failed|invalid password|invalid login|no pg_hba\.conf entry)/i],
    ["Database permission denied", /(permission denied|not authorized|unauthorized|forbidden)/i],
    ["Privileged database change", /(AUDIT:.*,(ROLE|DDL),|\bALTER\s+ROLE\b|\bCREATE\s+ROLE\b|\bDROP\s+ROLE\b|\bGRANT\s+|\bREVOKE\s+|\bDROP\s+(TABLE|SCHEMA|DATABASE)\b|\bTRUNCATE\s+)/i]
  ];
  const match = rules.find(([, pattern]) => pattern.test(text));
  if (!match) return null;
  return {
    rule: match[0],
    source: findString(value, new Set(["source", "product", "service", "identifier"])) ?? "Supabase log drain",
    ip: findString(value, new Set(["x_real_ip", "x-real-ip", "cf_connecting_ip", "cf-connecting-ip", "remote_addr", "ip"])),
    userAgent: findString(value, new Set(["user_agent", "user-agent", "x_forwarded_user_agent"]))
  };
}

export function supabaseLogsFrom(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["logs", "events", "result"]) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [body];
}

export async function sendSupabaseSecurityAlerts(logs: unknown[]): Promise<number> {
  const signals = logs.map(classifySupabaseLog).filter((signal): signal is SupabaseSignal => signal !== null).slice(0, 10);
  for (const signal of signals) {
    const context = await contextFor(signal.ip ?? "Unavailable in drained event", signal.userAgent);
    auditSecurityEvent("security.supabase_signal", context, { rule: signal.rule, source: signal.source });
    await sendWebhook("security_alert", {
      content: "@everyone",
      embeds: [{
        title: "Supabase security signal",
        color: 0xff315f,
        timestamp: new Date().toISOString(),
        fields: [
          { name: "Rule", value: truncate(signal.rule) },
          { name: "Source", value: truncate(signal.source), inline: true },
          { name: "IP address", value: truncate(context.ip), inline: true },
          { name: "Device", value: signal.userAgent ? truncate(context.device) : "Unavailable for this drained event", inline: true },
          { name: "VPN", value: truncate(context.vpn), inline: true },
          { name: "Privacy signals", value: truncate(context.privacySignals) }
        ]
      }]
    }, { mentionEveryone: true });
  }
  return signals.length;
}

function recoveryCode(prefix: string) {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function recoveryCodeHash(code: string) {
  return createHash("sha256").update(code).digest("hex");
}

export function randomDashboardNetworkBlockSeconds() {
  return randomInt(NETWORK_BLOCK_MIN_SECONDS, NETWORK_BLOCK_MAX_SECONDS + 1);
}

export async function issueNetworkUnblockRecoveryCode(
  networkKey: string,
  expiresAt: string
) {
  const code = recoveryCode("confetti-network");
  const result = await db.rpc("issue_security_recovery_token", {
    requested_action: "network_unblock",
    requested_network_key: networkKey,
    requested_token_hash: recoveryCodeHash(code),
    requested_expires_at: expiresAt
  });
  if (result.error) throw new Error(result.error.message);
  return result.data === true ? code : null;
}

export async function isFrontendLockdownActive(options: { fresh?: boolean } = {}) {
  const now = Date.now();
  if (!options.fresh && lockdownCache && lockdownCache.expiresAt > now) {
    return lockdownCache.active;
  }
  const result = await db
    .from("frontend_lockdown_state")
    .select("active")
    .eq("id", true)
    .single();
  if (result.error) throw new Error(result.error.message);
  lockdownCache = { active: result.data.active === true, expiresAt: now + LOCKDOWN_CACHE_MS };
  return lockdownCache.active;
}

export async function activateFrontendLockdown(reason: string, actor: string) {
  const code = recoveryCode("confetti-lockdown");
  const result = await db.rpc("activate_frontend_lockdown", {
    requested_reason: reason,
    requested_actor: actor,
    requested_token_hash: recoveryCodeHash(code)
  });
  if (result.error) throw new Error(result.error.message);
  if (result.data !== true) return false;

  lockdownCache = { active: true, expiresAt: Date.now() + LOCKDOWN_CACHE_MS };
  await sendOperationalSecurityAlert("Confetti frontend lockdown activated", {
    event: "frontend_lockdown_activated",
    severity: "critical",
    reason,
    actor,
    recovery_code: code,
    instructions: "On the VPS, run: docker compose exec -it server npm --prefix apps/server run security:ops"
  });
  return true;
}

export async function maybeActivateFrontendLockdownForDistributedLoginAttack() {
  const result = await db
    .from("dashboard_network_blocks")
    .select("network_key", { count: "exact", head: true })
    .gt("blocked_until", new Date().toISOString())
    .gte("updated_at", new Date(Date.now() - DISTRIBUTED_BLOCK_WINDOW_MS).toISOString());
  if (result.error) throw new Error(result.error.message);
  if ((result.count ?? 0) < DISTRIBUTED_BLOCK_THRESHOLD) return false;

  return activateFrontendLockdown(
    `${result.count} distinct dashboard networks were blocked within 15 minutes`,
    "automatic-distributed-login-defense"
  );
}

export async function redeemSecurityRecoveryCode(code: string) {
  const result = await db.rpc("redeem_security_recovery_token", {
    requested_token_hash: recoveryCodeHash(code.trim())
  });
  if (result.error) throw new Error(result.error.message);
  const recovery = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!recovery) throw new Error("Recovery code did not return an action");

  if (recovery.redeemed_action === "frontend_unlock") {
    lockdownCache = { active: false, expiresAt: Date.now() + LOCKDOWN_CACHE_MS };
    await sendOperationalSecurityAlert("Confetti frontend lockdown revoked", {
      event: "frontend_lockdown_revoked",
      severity: "warning",
      actor: "interactive-vps-recovery"
    });
  } else if (recovery.redeemed_action === "network_unblock") {
    await sendOperationalSecurityAlert("Dashboard network block revoked", {
      event: "dashboard_network_block_revoked",
      severity: "warning",
      actor: "interactive-vps-recovery",
      network: recovery.redeemed_network_key
    });
  } else {
    throw new Error("Recovery code returned an unsupported action");
  }

  return recovery as { redeemed_action: "frontend_unlock" | "network_unblock"; redeemed_network_key: string | null };
}

function normalizeIp(ip: string) {
  if (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4) {
    return ip.slice(7);
  }

  return ip.toLowerCase();
}

function ipv6Prefix64(ip: string) {
  const [head = "", tail = ""] = ip.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missingParts = Math.max(0, 8 - headParts.length - tailParts.length);

  return [...headParts, ...Array(missingParts).fill("0"), ...tailParts]
    .slice(0, 4)
    .map((part) => part.padStart(4, "0"))
    .join(":");
}

export function dashboardNetworkKey(ip: string) {
  const normalizedIp = normalizeIp(ip);
  const ipVersion = isIP(normalizedIp);

  if (ipVersion === 4) {
    return `ipv4:${normalizedIp}`;
  }

  if (ipVersion === 6) {
    return `ipv6-64:${ipv6Prefix64(normalizedIp)}`;
  }

  return `unknown:${normalizedIp}`;
}
