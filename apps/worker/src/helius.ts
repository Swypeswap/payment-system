import { db, unwrap, workerAudit } from "./db.js";
import { env } from "./env.js";

function enabled(): boolean {
  return Boolean(env.HELIUS_API_KEY && env.HELIUS_WEBHOOK_URL && env.HELIUS_WEBHOOK_AUTH);
}

function sameStrings(left: string[] = [], right: string[] = []) {
  return [...left].sort().join(",") === [...right].sort().join(",");
}

export async function syncHeliusWebhook() {
  if (!enabled()) {
    console.warn("Helius sync disabled: HELIUS_API_KEY, HELIUS_WEBHOOK_URL, or HELIUS_WEBHOOK_AUTH is missing");
    return;
  }
  const settings = unwrap(await db.from("app_settings").select("helius_webhook_id").eq("id", true).single());
  const [websites, externalRevenueWallets, companyWallets] = await Promise.all([
    db
      .from("websites")
      .select("revenue_wallets(address)")
      .eq("active", true)
      .eq("hosted", true),
    db
      .from("external_revenue_wallets")
      .select("address")
      .in("mirror_status", ["active", "retired", "key_erased"]),
    db
      .from("company_wallets")
      .select("address")
      .in("status", ["active", "archived"])
  ]);
  if (websites.error) throw new Error(websites.error.message);
  if (externalRevenueWallets.error) throw new Error(externalRevenueWallets.error.message);
  if (companyWallets.error) throw new Error(companyWallets.error.message);
  const legacyWebsites = websites.data as unknown as Array<{ revenue_wallets: { address: string } }>;
  const addresses = [...new Set([
    ...legacyWebsites.map((row) => row.revenue_wallets.address),
    ...externalRevenueWallets.data.map((row) => row.address),
    ...companyWallets.data.map((row) => row.address)
  ])];
  if (addresses.length === 0) {
    console.warn("Helius sync skipped: no hosted website revenue wallets");
    return;
  }

  const webhookType = env.SOLANA_CLUSTER === "devnet" ? "enhancedDevnet" : "enhanced";
  const body = {
    webhookURL: env.HELIUS_WEBHOOK_URL,
    transactionTypes: ["ANY"],
    accountAddresses: addresses,
    webhookType,
    authHeader: env.HELIUS_WEBHOOK_AUTH
  };
  let id = settings.helius_webhook_id as string | null;
  if (id) {
    const currentResponse = await fetch(
      `https://api-mainnet.helius-rpc.com/v0/webhooks/${id}?api-key=${env.HELIUS_API_KEY}`
    );
    if (currentResponse.status === 404) {
      id = null;
    } else if (!currentResponse.ok) {
      throw new Error(`Helius webhook lookup failed with HTTP ${currentResponse.status}`);
    } else {
      const current = (await currentResponse.json()) as {
        webhookURL?: string;
        transactionTypes?: string[];
        accountAddresses?: string[];
        webhookType?: string;
        authHeader?: string;
      };
      const unchanged =
        current.webhookURL === body.webhookURL &&
        current.webhookType === body.webhookType &&
        current.authHeader === body.authHeader &&
        sameStrings(current.transactionTypes, body.transactionTypes) &&
        sameStrings(current.accountAddresses, body.accountAddresses);
      if (unchanged) return;
    }
  }
  const endpoint = id
    ? `https://api-mainnet.helius-rpc.com/v0/webhooks/${id}?api-key=${env.HELIUS_API_KEY}`
    : `https://api-mainnet.helius-rpc.com/v0/webhooks?api-key=${env.HELIUS_API_KEY}`;
  const response = await fetch(endpoint, {
    method: id ? "PUT" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Helius webhook sync failed with HTTP ${response.status}`);
  }
  const result = (await response.json()) as { webhookID: string };
  if (!settings.helius_webhook_id || !id) {
    unwrap(
      await db
        .from("app_settings")
        .update({ helius_webhook_id: result.webhookID })
        .eq("id", true)
        .select("id")
        .single()
    );
  }
  await workerAudit("helius.synced", "helius_webhook", result.webhookID, {
    address_count: addresses.length,
    cluster: env.SOLANA_CLUSTER
  });
}
