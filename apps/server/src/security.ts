import type { FastifyRequest } from "fastify";
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

export async function sendDashboardSecurityAlert(
  request: FastifyRequest,
  title: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const context = await contextFor(request.ip, request.headers["user-agent"]);
  auditSecurityEvent(`security.${String(metadata.event ?? "dashboard_alert")}`, context, metadata);
  await sendWebhook("security_alert", {
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
  });
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
    });
  }
  return signals.length;
}
