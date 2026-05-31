import { startDiscordBot } from "./discord.js";
import { env } from "./env.js";
import { syncHeliusWebhook } from "./helius.js";
import { assertPureJsBigintBuffer } from "./privacy-cash.js";
import {
  evaluateWalletRotationRecommendations,
  processPendingChainEvents,
  processPendingPrivacyCashWithdrawals,
  reconcileAllWebsites,
  recoverInterruptedPrivacyCashWithdrawals,
  recoverPrivacyCashShields,
  recoverSubmittedPayouts
} from "./processor.js";

function repeat(name: string, task: () => Promise<void>, intervalMs: number) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await task();
    } catch (error) {
      console.error(`${name} failed:`, error);
    } finally {
      running = false;
    }
  };
  void run();
  return setInterval(() => void run(), intervalMs);
}

console.log(`Starting worker ${env.WORKER_ID} on ${env.SOLANA_CLUSTER}; DRY_RUN=${env.DRY_RUN}`);
assertPureJsBigintBuffer();
await startDiscordBot();
await recoverSubmittedPayouts();
await recoverPrivacyCashShields();
await recoverInterruptedPrivacyCashWithdrawals();
repeat("chain event processor", processPendingChainEvents, env.EVENT_INTERVAL_MS);
repeat("website reconciler", reconcileAllWebsites, env.RECONCILE_INTERVAL_MS);
repeat("Privacy Cash withdrawal processor", processPendingPrivacyCashWithdrawals, env.PRIVACY_CASH_INTERVAL_MS);
repeat("wallet rotation recommender", evaluateWalletRotationRecommendations, env.ROTATION_CHECK_INTERVAL_MS);
repeat("Helius webhook sync", syncHeliusWebhook, env.HELIUS_SYNC_INTERVAL_MS);
