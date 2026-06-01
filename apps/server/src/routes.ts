import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  NOTIFICATION_KINDS,
  decryptSecret,
  encryptSecret,
  parseSecretKey,
  parseDomain,
  toHttpsWebsiteUrl,
  validateSolanaWalletAddress
} from "@payment/shared";
import { z } from "zod";
import { audit } from "./audit.js";
import { db, unwrap } from "./db.js";
import { env } from "./env.js";
import { encryptWebhookUrl, listRedactedRoutes, sendWebhook } from "./notifications.js";
import { createSessionToken, dashboardCookie, isValidSession } from "./session.js";

const uuid = z.string().uuid();
const optionalNumber = z.number().nonnegative().nullable().optional();
const percent = z.number().min(0).max(100);
const colorLabel = z.string().regex(/^#[0-9a-fA-F]{6}$/);

function csvCell(value: unknown): string {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function downloadFilename(label: string): string {
  const normalized = label.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
  return normalized || "revenue-wallet";
}

function getHeliusSignature(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.signature === "string") {
    return payload.signature;
  }
  const events = payload.events as Record<string, Record<string, unknown>> | undefined;
  for (const event of Object.values(events ?? {})) {
    if (typeof event.signature === "string") {
      return event.signature;
    }
  }
  return undefined;
}

function heliusEventKey(payload: Record<string, unknown>, index: number): string {
  const signature = getHeliusSignature(payload);
  if (signature) {
    return `helius:${signature}`;
  }
  return `helius:${createHash("sha256")
    .update(`${index}:${JSON.stringify(payload)}`)
    .digest("hex")}`;
}

async function requireDashboard(request: FastifyRequest, reply: FastifyReply) {
  const token = request.cookies[dashboardCookie.name];
  if (!(await isValidSession(token))) {
    return reply.code(401).send({ error: "Authentication required" });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    const origin = request.headers.origin;
    if (origin) {
      const expected = env.PUBLIC_BASE_URL ?? `${request.protocol}://${request.headers.host}`;
      if (origin !== expected) {
        return reply.code(403).send({ error: "Origin check failed" });
      }
    }
  }
}

async function updateTeamWallet(
  teamId: string,
  address: string,
  actorType: "dashboard" | "discord",
  actorId: string
) {
  const wallet = validateSolanaWalletAddress(address);
  const team = unwrap(
    await db.from("teams").select("manager_wallet_address").eq("id", teamId).single()
  );
  unwrap(
    await db
      .from("teams")
      .update({ manager_wallet_address: wallet, manager_wallet_updated_at: new Date().toISOString() })
      .eq("id", teamId)
      .select("id")
      .single()
  );
  unwrap(
    await db
      .from("wallet_update_history")
      .insert({
        team_id: teamId,
        old_wallet_address: team.manager_wallet_address,
        new_wallet_address: wallet,
        actor_type: actorType,
        actor_id: actorId
      })
      .select("id")
      .single()
  );
  return wallet;
}

async function requestTeamWalletUpdate(teamId: string, address: string, actorId: string) {
  const wallet = validateSolanaWalletAddress(address);
  const team = unwrap(
    await db.from("teams").select("manager_wallet_address").eq("id", teamId).single()
  );
  const pending = await db
    .from("manager_wallet_change_requests")
    .select("id")
    .eq("team_id", teamId)
    .eq("status", "pending")
    .maybeSingle();
  if (pending.error) throw new Error(pending.error.message);
  const values = {
    team_id: teamId,
    old_wallet_address: team.manager_wallet_address,
    new_wallet_address: wallet,
    requested_by_actor_type: "dashboard",
    requested_by_actor_id: actorId,
    status: "pending"
  };
  return pending.data
    ? unwrap(
        await db.from("manager_wallet_change_requests").update(values).eq("id", pending.data.id).select("*").single()
      )
    : unwrap(await db.from("manager_wallet_change_requests").insert(values).select("*").single());
}

export async function registerRoutes(app: FastifyInstance) {
  app.post(
    "/api/login",
    { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { password } = z.object({ password: z.string().min(1) }).parse(request.body);
      if (!(await bcrypt.compare(password, env.DASHBOARD_PASSWORD_HASH))) {
        return reply.code(401).send({ error: "Invalid password" });
      }
      const token = await createSessionToken();
      reply.setCookie(dashboardCookie.name, token, dashboardCookie.options);
      return { ok: true };
    }
  );

  app.post("/api/logout", async (_request, reply) => {
    reply.clearCookie(dashboardCookie.name, { path: "/" });
    return { ok: true };
  });

  app.post("/webhooks/helius", async (request, reply) => {
    if (request.headers.authorization !== env.HELIUS_WEBHOOK_AUTH) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const deliveries = z.array(z.record(z.unknown())).parse(request.body);
    if (deliveries.length === 0) {
      return reply.send({ ok: true });
    }
    const rows = deliveries.map((payload, index) => ({
      provider: "helius",
      provider_event_key: heliusEventKey(payload, index),
      signature: getHeliusSignature(payload),
      payload
    }));
    const { error } = await db.from("chain_events").upsert(rows, {
      onConflict: "provider_event_key",
      ignoreDuplicates: true
    });
    if (error) {
      request.log.error(error, "Could not enqueue Helius deliveries");
      return reply.code(500).send({ error: "Could not enqueue deliveries" });
    }
    return { ok: true };
  });

  app.register(async (protectedApi) => {
    protectedApi.addHook("preHandler", requireDashboard);

    protectedApi.get("/api/bootstrap", async () => {
      const [
        settings,
        teams,
        managers,
        owners,
        wallets,
        walletGroups,
        domains,
        websites,
        requests,
        deposits,
        swaps,
        payouts,
        privacyCashWithdrawals,
        managerWalletRequests,
        rotationNotifications,
        auditLogs,
        walletHistory,
        routes
      ] = await Promise.all([
        db.from("app_settings").select("*").eq("id", true).single(),
        db
          .from("teams")
          .select("*,team_managers(manager_id,managers(id,display_name,discord_user_id,discord_username,active))")
          .order("name"),
        db.from("managers").select("*").order("display_name"),
        db.from("owner_profiles").select("*").order("display_name"),
        db
          .from("revenue_wallets")
          .select("id,label,address,active,wallet_group_id,color_label,created_at,updated_at,wallet_groups(id,name,color_label)")
          .order("label"),
        db.from("wallet_groups").select("*").order("name"),
        db.from("domains").select("*").order("domain"),
        db
          .from("websites")
          .select("*,domains(domain,status),teams(name,manager_wallet_address,payout_discord_channel_id),revenue_wallets(label,address)")
          .order("created_at", { ascending: false }),
        db.from("website_requests").select("*,teams(name)").order("created_at", { ascending: false }).limit(50),
        db.from("deposits").select("*,websites(domains(domain)),revenue_wallets(address)").order("created_at", { ascending: false }).limit(50),
        db.from("swap_attempts").select("*,websites(domains(domain))").order("created_at", { ascending: false }).limit(50),
        db.from("privacy_cash_payout_batches").select("*,websites(domains(domain))").order("created_at", { ascending: false }).limit(50),
        db.from("privacy_cash_withdrawal_jobs").select("*,websites(domains(domain))").order("created_at", { ascending: false }).limit(100),
        db.from("manager_wallet_change_requests").select("*,teams(name)").order("created_at", { ascending: false }).limit(50),
        db.from("wallet_rotation_notifications").select("*").order("created_at", { ascending: false }).limit(100),
        db.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(100),
        db.from("wallet_update_history").select("*,teams(name)").order("created_at", { ascending: false }).limit(50),
        listRedactedRoutes()
      ]);

      return {
        settings: unwrap(settings),
        teams: unwrap(teams),
        managers: unwrap(managers),
        owners: unwrap(owners),
        wallets: unwrap(wallets),
        walletGroups: unwrap(walletGroups),
        domains: unwrap(domains),
        websites: unwrap(websites),
        websiteRequests: unwrap(requests),
        deposits: unwrap(deposits),
        swaps: unwrap(swaps),
        payouts: unwrap(payouts),
        privacyCashWithdrawals: unwrap(privacyCashWithdrawals),
        managerWalletRequests: unwrap(managerWalletRequests),
        rotationNotifications: unwrap(rotationNotifications),
        auditLogs: unwrap(auditLogs),
        walletHistory: unwrap(walletHistory),
        notificationRoutes: routes
      };
    });

    protectedApi.put("/api/settings", async (request) => {
      const values = z
        .object({
          global_threshold_usd: z.number().positive(),
          global_sol_reserve: z.number().nonnegative(),
          min_swap_usd: z.number().nonnegative(),
          max_price_impact_pct: z.number().nonnegative(),
          min_organic_score: percent,
          privacy_cash_enabled: z.boolean(),
          privacy_min_delay_hours: z.number().int().min(24),
          privacy_max_delay_hours: z.number().int().min(24),
          owners_discord_guild_id: z.string().regex(/^[0-9]{15,22}$/).nullable(),
          owners_notifications_channel_id: z.string().regex(/^[0-9]{15,22}$/).nullable(),
          rotation_warn_after_days: z.number().int().positive(),
          rotation_warn_after_legs: z.number().int().positive(),
          rotation_warn_after_usd: z.number().positive(),
          rotation_warn_after_weekly_legs: z.number().int().positive(),
          swaps_enabled: z.boolean(),
          live_payouts_enabled: z.boolean(),
          emergency_paused: z.boolean(),
          discord_manager_role_ids: z.array(z.string().regex(/^[0-9]{15,22}$/)),
          discord_staff_role_ids: z.array(z.string().regex(/^[0-9]{15,22}$/))
        })
        .parse(request.body);
      if (values.privacy_max_delay_hours < values.privacy_min_delay_hours) {
        throw new Error("Maximum Privacy Cash delay must be at least the minimum delay");
      }
      const data = unwrap(
        await db.from("app_settings").update(values).eq("id", true).select("*").single()
      );
      await audit("settings.updated", "app_settings", "true", {
        emergency_paused: values.emergency_paused,
        swaps_enabled: values.swaps_enabled,
        live_payouts_enabled: values.live_payouts_enabled
      });
      return data;
    });

    protectedApi.post("/api/domains/import", async (request) => {
      const { domains } = z.object({ domains: z.string().min(1) }).parse(request.body);
      const parsed = [...new Set(domains.split(/[,\n]/).map((value) => value.trim()).filter(Boolean).map(parseDomain))];
      const { error } = await db
        .from("domains")
        .upsert(parsed.map((domain) => ({ domain })), {
          onConflict: "domain",
          ignoreDuplicates: true
        });
      if (error) throw new Error(error.message);
      await audit("domains.imported", "domains", undefined, { count: parsed.length });
      return { imported: parsed.length };
    });

    protectedApi.delete("/api/domains/:id", async (request) => {
      const { id } = z.object({ id: uuid }).parse(request.params);
      unwrap(
        await db.from("domains").update({ status: "archived" }).eq("id", id).select("id").single()
      );
      await audit("domain.archived", "domain", id);
      return { ok: true };
    });

    protectedApi.post("/api/managers", async (request) => {
      const values = z
        .object({
          display_name: z.string().trim().min(1),
          discord_user_id: z.string().regex(/^[0-9]{15,22}$/),
          discord_username: z.string().trim().optional()
        })
        .parse(request.body);
      const data = unwrap(await db.from("managers").insert(values).select("*").single());
      await audit("manager.created", "manager", data.id);
      return data;
    });

    protectedApi.delete("/api/managers/:id", async (request) => {
      const { id } = z.object({ id: uuid }).parse(request.params);
      unwrap(
        await db.from("managers").update({ active: false }).eq("id", id).select("id").single()
      );
      await audit("manager.archived", "manager", id);
      return { ok: true };
    });

    protectedApi.post("/api/owners", async (request) => {
      const values = z
        .object({
          display_name: z.string().trim().min(1),
          discord_user_id: z.string().regex(/^[0-9]{15,22}$/),
          discord_username: z.string().trim().optional(),
          solana_wallet_address: z.string().optional()
        })
        .parse(request.body);
      const activeOwners = unwrap(
        await db.from("owner_profiles").select("id").eq("active", true)
      );
      if (activeOwners.length >= 3) throw new Error("Only three active owner profiles are allowed");
      const data = unwrap(
        await db
          .from("owner_profiles")
          .insert({
            ...values,
            solana_wallet_address: values.solana_wallet_address
              ? validateSolanaWalletAddress(values.solana_wallet_address)
              : null,
            wallet_updated_at: values.solana_wallet_address ? new Date().toISOString() : null
          })
          .select("*")
          .single()
      );
      await audit("owner.created", "owner_profile", data.id);
      return data;
    });

    protectedApi.put("/api/owners/:id", async (request) => {
      const { id } = z.object({ id: uuid }).parse(request.params);
      const values = z
        .object({
          display_name: z.string().trim().min(1).optional(),
          discord_username: z.string().trim().optional(),
          solana_wallet_address: z.string().optional(),
          active: z.boolean().optional()
        })
        .parse(request.body);
      const previous = unwrap(
        await db.from("owner_profiles").select("*").eq("id", id).single()
      );
      const wallet = values.solana_wallet_address
        ? validateSolanaWalletAddress(values.solana_wallet_address)
        : undefined;
      const data = unwrap(
        await db
          .from("owner_profiles")
          .update({
            ...values,
            solana_wallet_address: wallet,
            wallet_updated_at: wallet ? new Date().toISOString() : undefined
          })
          .eq("id", id)
          .select("*")
          .single()
      );
      if (wallet && wallet !== previous.solana_wallet_address) {
        unwrap(
          await db
            .from("owner_wallet_update_history")
            .insert({
              owner_profile_id: id,
              old_wallet_address: previous.solana_wallet_address,
              new_wallet_address: wallet,
              actor_id: "shared-staff-account"
            })
            .select("id")
            .single()
        );
      }
      await audit("owner.updated", "owner_profile", id);
      return data;
    });

    protectedApi.post("/api/teams", async (request) => {
      const values = z
        .object({
          name: z.string().trim().min(1),
          manager_wallet_address: z.string().optional(),
          payout_discord_channel_id: z.string().regex(/^[0-9]{15,22}$/).optional(),
          payout_message: z.string().trim().min(1).optional()
        })
        .parse(request.body);
      const insert = {
        ...values,
        manager_wallet_address: values.manager_wallet_address
          ? validateSolanaWalletAddress(values.manager_wallet_address)
          : null,
        manager_wallet_updated_at: values.manager_wallet_address ? new Date().toISOString() : null
      };
      const data = unwrap(await db.from("teams").insert(insert).select("*").single());
      await audit("team.created", "team", data.id);
      return data;
    });

    protectedApi.put("/api/teams/:id", async (request) => {
      const { id } = z.object({ id: uuid }).parse(request.params);
      const values = z
        .object({
          name: z.string().trim().min(1).optional(),
          manager_wallet_address: z.string().optional(),
          payout_discord_channel_id: z.string().regex(/^[0-9]{15,22}$/).nullable().optional(),
          payout_message: z.string().trim().min(1).optional(),
          active: z.boolean().optional()
        })
        .parse(request.body);
      const wallet = values.manager_wallet_address;
      const update = { ...values };
      delete update.manager_wallet_address;
      if (Object.keys(update).length) {
        unwrap(await db.from("teams").update(update).eq("id", id).select("id").single());
      }
      if (wallet) {
        await requestTeamWalletUpdate(id, wallet, "shared-staff-account");
      }
      await audit("team.updated", "team", id);
      return { ok: true };
    });

    protectedApi.post("/api/teams/:id/managers", async (request) => {
      const { id } = z.object({ id: uuid }).parse(request.params);
      const { manager_id } = z.object({ manager_id: uuid }).parse(request.body);
      unwrap(
        await db
          .from("team_managers")
          .upsert({ team_id: id, manager_id }, { onConflict: "team_id,manager_id" })
          .select("*")
          .single()
      );
      await audit("team.manager_assigned", "team", id, { manager_id });
      return { ok: true };
    });

    protectedApi.delete("/api/teams/:teamId/managers/:managerId", async (request) => {
      const { teamId, managerId } = z
        .object({ teamId: uuid, managerId: uuid })
        .parse(request.params);
      const { error } = await db
        .from("team_managers")
        .delete()
        .eq("team_id", teamId)
        .eq("manager_id", managerId);
      if (error) throw new Error(error.message);
      await audit("team.manager_removed", "team", teamId, { manager_id: managerId });
      return { ok: true };
    });

    protectedApi.post("/api/manager-wallet-requests/:id/:decision", async (request) => {
      const { id, decision } = z
        .object({ id: uuid, decision: z.enum(["approved", "rejected"]) })
        .parse(request.params);
      const pending = unwrap(
        await db
          .from("manager_wallet_change_requests")
          .select("*")
          .eq("id", id)
          .eq("status", "pending")
          .single()
      );
      if (decision === "approved") {
        await updateTeamWallet(
          pending.team_id,
          pending.new_wallet_address,
          "dashboard",
          "shared-staff-account"
        );
      }
      unwrap(
        await db
          .from("manager_wallet_change_requests")
          .update({ status: decision, reviewed_at: new Date().toISOString() })
          .eq("id", id)
          .eq("status", "pending")
          .select("id")
          .single()
      );
      await audit(`team.wallet_change_${decision}`, "manager_wallet_change_request", id, {
        team_id: pending.team_id
      });
      return { ok: true };
    });

    protectedApi.post("/api/wallet-groups", async (request) => {
      const values = z
        .object({
          name: z.string().trim().min(1),
          color_label: colorLabel
        })
        .parse(request.body);
      const data = unwrap(
        await db.from("wallet_groups").insert(values).select("*").single()
      );
      await audit("wallet_group.created", "wallet_group", data.id, values);
      return data;
    });

    protectedApi.put("/api/wallet-groups/:id", async (request) => {
      const { id } = z.object({ id: uuid }).parse(request.params);
      const values = z
        .object({
          name: z.string().trim().min(1),
          color_label: colorLabel
        })
        .parse(request.body);
      const data = unwrap(
        await db.from("wallet_groups").update(values).eq("id", id).select("*").single()
      );
      await audit("wallet_group.updated", "wallet_group", id, values);
      return data;
    });

    protectedApi.post("/api/wallets/export-csv", async (request, reply) => {
      const { status } = z
        .object({ status: z.enum(["active", "archived", "both"]) })
        .parse(request.body);
      const wallets = unwrap(
        await db
          .from("revenue_wallets")
          .select("label,address,active,color_label,created_at,updated_at,wallet_groups(name,color_label)")
          .order("label")
      ) as unknown as Array<{
        label: string;
        address: string;
        active: boolean;
        color_label: string;
        created_at: string;
        updated_at: string;
        wallet_groups: { name: string; color_label: string } | null;
      }>;
      const filtered = wallets.filter((wallet) =>
        status === "both" || wallet.active === (status === "active")
      );
      const rows = [
        ["Label", "Address", "Status", "Group", "Group color", "Wallet color", "Created", "Updated"],
        ...filtered.map((wallet) => [
          wallet.label,
          wallet.address,
          wallet.active ? "Active" : "Archived",
          wallet.wallet_groups?.name ?? "Ungrouped",
          wallet.wallet_groups?.color_label ?? "",
          wallet.color_label,
          wallet.created_at,
          wallet.updated_at
        ])
      ];
      const csv = `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
      await audit("revenue_wallet.csv_exported", "revenue_wallet", undefined, {
        status,
        count: filtered.length
      });
      return reply
        .header("cache-control", "no-store, max-age=0")
        .header("pragma", "no-cache")
        .header("content-disposition", `attachment; filename="revenue-wallets-${status}.csv"`)
        .type("text/csv; charset=utf-8")
        .send(csv);
    });

    protectedApi.post(
      "/api/wallets/:id/export-private-key",
      { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
      async (request, reply) => {
        const { id } = z.object({ id: uuid }).parse(request.params);
        const { password } = z.object({ password: z.string().min(1) }).parse(request.body);
        const passwordMatches = await bcrypt.compare(password, env.DASHBOARD_PASSWORD_HASH);
        if (!passwordMatches) {
          throw new Error("Invalid dashboard password");
        }

        const wallet = unwrap(
          await db
            .from("revenue_wallets")
            .select("label,address,encrypted_private_key,encryption_nonce,encryption_auth_tag,encryption_key_version")
            .eq("id", id)
            .single()
        );
        const privateKey = decryptSecret(
          {
            ciphertext: wallet.encrypted_private_key,
            nonce: wallet.encryption_nonce,
            authTag: wallet.encryption_auth_tag,
            keyVersion: wallet.encryption_key_version
          },
          env.MASTER_ENCRYPTION_KEY
        );
        await audit("revenue_wallet.private_key_exported", "revenue_wallet", id, {
          address: wallet.address
        });
        return reply
          .header("cache-control", "no-store, max-age=0")
          .header("pragma", "no-cache")
          .header("x-content-type-options", "nosniff")
          .header("content-disposition", `attachment; filename="${downloadFilename(wallet.label)}-private-key.txt"`)
          .type("text/plain; charset=utf-8")
          .send(privateKey);
      }
    );

    protectedApi.post("/api/wallets/import", async (request) => {
      const values = z
        .object({
          label: z.string().trim().min(1),
          private_key: z.string().min(1),
          wallet_group_id: uuid.nullable().optional(),
          new_group_name: z.string().trim().min(1).optional(),
          new_group_color_label: colorLabel.optional(),
          color_label: colorLabel
        })
        .parse(request.body);
      if (values.wallet_group_id && values.new_group_name) {
        throw new Error("Choose an existing wallet group or create a new group, not both");
      }
      const keypair = parseSecretKey(values.private_key);
      const address = keypair.publicKey.toBase58();
      const duplicate = await db.from("revenue_wallets").select("id").eq("address", address).maybeSingle();
      if (duplicate.error) throw new Error(duplicate.error.message);
      if (duplicate.data) throw new Error("Revenue wallet is already imported");

      const encrypted = encryptSecret(values.private_key.trim(), env.MASTER_ENCRYPTION_KEY);
      let walletGroupId = values.wallet_group_id ?? null;
      if (values.new_group_name) {
        const group = unwrap(
          await db
            .from("wallet_groups")
            .insert({
              name: values.new_group_name,
              color_label: values.new_group_color_label ?? "#64f5b5"
            })
            .select("*")
            .single()
        );
        walletGroupId = group.id;
        await audit("wallet_group.created", "wallet_group", group.id, {
          name: group.name,
          color_label: group.color_label
        });
      }
      const data = unwrap(
        await db
          .from("revenue_wallets")
          .insert({
            label: values.label,
            address,
            wallet_group_id: walletGroupId,
            color_label: values.color_label,
            encrypted_private_key: encrypted.ciphertext,
            encryption_nonce: encrypted.nonce,
            encryption_auth_tag: encrypted.authTag,
            encryption_key_version: encrypted.keyVersion
          })
          .select("id,label,address,active,wallet_group_id,color_label,created_at")
          .single()
      );
      await audit("revenue_wallet.imported", "revenue_wallet", data.id, {
        address: data.address
      });
      return data;
    });

    protectedApi.put("/api/wallets/:id", async (request) => {
      const { id } = z.object({ id: uuid }).parse(request.params);
      const values = z
        .object({
          label: z.string().trim().min(1).optional(),
          wallet_group_id: uuid.nullable().optional(),
          color_label: colorLabel.optional(),
          active: z.boolean().optional()
        })
        .parse(request.body);
      const data = unwrap(
        await db.from("revenue_wallets").update(values).eq("id", id).select("id,label,address,active,wallet_group_id,color_label,updated_at").single()
      );
      await audit("revenue_wallet.updated", "revenue_wallet", id, values);
      return data;
    });

    protectedApi.delete("/api/wallets/:id", async (request) => {
      const { id } = z.object({ id: uuid }).parse(request.params);
      unwrap(
        await db
          .from("revenue_wallets")
          .update({ active: false })
          .eq("id", id)
          .select("id")
          .single()
      );
      await audit("revenue_wallet.archived", "revenue_wallet", id);
      return { ok: true };
    });

    protectedApi.post("/api/websites", async (request) => {
      const values = z
        .object({
          domain_id: uuid,
          team_id: uuid,
          revenue_wallet_id: uuid,
          company_wallet_address: z.string().optional(),
          remarks: z.string().default(""),
          threshold_usd: optionalNumber,
          manager_percent: percent.nullable().optional(),
          company_percent: percent.nullable().optional(),
          sol_reserve: optionalNumber
        })
        .parse(request.body);
      if (
        (values.manager_percent === null || values.manager_percent === undefined) !==
        (values.company_percent === null || values.company_percent === undefined)
      ) {
        throw new Error("Set both website payout percentages or leave both empty");
      }
      if (
        values.manager_percent !== null &&
        values.manager_percent !== undefined &&
        values.company_percent !== null &&
        values.company_percent !== undefined &&
        values.manager_percent + values.company_percent !== 100
      ) {
        throw new Error("Website payout percentages must add up to 100");
      }
      const insert = {
        ...values,
        company_wallet_address: values.company_wallet_address
          ? validateSolanaWalletAddress(values.company_wallet_address)
          : null
      };
      const data = unwrap(await db.from("websites").insert(insert).select("*").single());
      unwrap(
        await db
          .from("domains")
          .update({ status: "assigned" })
          .eq("id", values.domain_id)
          .select("id")
          .single()
      );
      await audit("website.created", "website", data.id);
      return data;
    });

    protectedApi.put("/api/websites/:id", async (request) => {
      const { id } = z.object({ id: uuid }).parse(request.params);
      const values = z
        .object({
          team_id: uuid.optional(),
          revenue_wallet_id: uuid.optional(),
          company_wallet_address: z.string().optional(),
          hosted: z.boolean().optional(),
          remarks: z.string().optional(),
          threshold_usd: optionalNumber,
          manager_percent: percent.nullable().optional(),
          company_percent: percent.nullable().optional(),
          sol_reserve: optionalNumber,
          active: z.boolean().optional()
        })
        .parse(request.body);
      if (
        (values.manager_percent === null || values.manager_percent === undefined) !==
        (values.company_percent === null || values.company_percent === undefined)
      ) {
        throw new Error("Set both website payout percentages or leave both empty");
      }
      if (
        values.manager_percent !== null &&
        values.manager_percent !== undefined &&
        values.company_percent !== null &&
        values.company_percent !== undefined &&
        values.manager_percent + values.company_percent !== 100
      ) {
        throw new Error("Website payout percentages must add up to 100");
      }
      const previous = unwrap(
        await db
          .from("websites")
          .select("hosted,team_id,remarks,domains(domain)")
          .eq("id", id)
          .single()
      ) as { hosted: boolean; team_id: string; remarks: string; domains: { domain: string } };
      const update = {
        ...values,
        company_wallet_address: values.company_wallet_address
          ? validateSolanaWalletAddress(values.company_wallet_address)
          : undefined
      };
      unwrap(await db.from("websites").update(update).eq("id", id).select("id").single());
      await audit("website.updated", "website", id, values);
      if (values.hosted === true && previous.hosted === false) {
        const websiteUrl = toHttpsWebsiteUrl(previous.domains.domain);
        const teamId = values.team_id ?? previous.team_id;
        const remarks = values.remarks ?? previous.remarks;
        await sendWebhook(
          "website_activation",
          {
            content: "@everyone",
            embeds: [
              {
                title: "Website activated",
                url: websiteUrl,
                description: websiteUrl,
                color: 0x22c55e,
              },
              {
                title: "Remarks",
                description: remarks || "No remarks",
                color: 0x64f5b5
              }
            ]
          },
          { teamId, mentionEveryone: true }
        );
      }
      return { ok: true };
    });

    protectedApi.delete("/api/websites/:id", async (request) => {
      const { id } = z.object({ id: uuid }).parse(request.params);
      const website = unwrap(
        await db.from("websites").select("domain_id").eq("id", id).single()
      );
      unwrap(
        await db
          .from("websites")
          .update({ active: false, hosted: false })
          .eq("id", id)
          .select("id")
          .single()
      );
      unwrap(
        await db
          .from("domains")
          .update({ status: "archived" })
          .eq("id", website.domain_id)
          .select("id")
          .single()
      );
      await audit("website.archived", "website", id);
      return { ok: true };
    });

    protectedApi.post("/api/notification-routes", async (request) => {
      const values = z
        .object({
          kind: z.enum(NOTIFICATION_KINDS),
          team_id: uuid.nullable().optional(),
          name: z.string().trim().min(1),
          webhook_url: z.string().url(),
          enabled: z.boolean().default(true)
        })
        .parse(request.body);
      const encrypted = encryptWebhookUrl(values.webhook_url);
      const row = {
        kind: values.kind,
        team_id: values.team_id ?? null,
        name: values.name,
        enabled: values.enabled,
        encrypted_webhook_url: encrypted.ciphertext,
        encryption_nonce: encrypted.nonce,
        encryption_auth_tag: encrypted.authTag,
        encryption_key_version: encrypted.keyVersion
      };
      const data = unwrap(
        await db
          .from("notification_routes")
          .upsert(row, { onConflict: "kind,team_id" })
          .select("id,kind,team_id,name,enabled,updated_at")
          .single()
      );
      await audit("notification_route.saved", "notification_route", data.id, {
        kind: data.kind,
        team_id: data.team_id
      });
      return data;
    });

    protectedApi.post("/api/notification-routes/:id/test", async (request) => {
      const { id } = z.object({ id: uuid }).parse(request.params);
      const route = unwrap(
        await db.from("notification_routes").select("kind,team_id").eq("id", id).single()
      );
      const delivered = await sendWebhook(
        route.kind,
        { content: "Payment platform webhook test succeeded." },
        { teamId: route.team_id ?? undefined }
      );
      return { delivered };
    });

    protectedApi.delete("/api/notification-routes/:id", async (request) => {
      const { id } = z.object({ id: uuid }).parse(request.params);
      const { error } = await db.from("notification_routes").delete().eq("id", id);
      if (error) throw new Error(error.message);
      await audit("notification_route.deleted", "notification_route", id);
      return { ok: true };
    });
  });
}
