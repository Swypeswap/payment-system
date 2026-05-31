import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { LAMPORTS_PER_SOL, type PrivacyCashFeeConfig } from "@payment/shared";
import type { Keypair } from "@solana/web3.js";
import { PrivacyCash } from "privacycash";
import { z } from "zod";
import { db, unwrap } from "./db.js";
import { env } from "./env.js";

const protocolConfigSchema = z.object({
  withdraw_fee_rate: z.number().min(0).max(0.999999),
  withdraw_rent_fee: z.number().nonnegative(),
  minimum_withdrawal: z.object({
    sol: z.number().positive()
  })
});

export type PrivacyCashAsset = "sol";

export interface PrivacyCashAssetConfig extends PrivacyCashFeeConfig {
  minimumWithdrawalRaw: number;
}

let expectedFeeConfig: PrivacyCashAssetConfig | null = null;

export function assertPureJsBigintBuffer() {
  const require = createRequire(import.meta.url);
  const entrypoint = require.resolve("bigint-buffer");
  const nativeBinding = path.resolve(path.dirname(entrypoint), "../build/Release/bigint_buffer.node");
  if (existsSync(nativeBinding)) {
    throw new Error(
      "Refusing to start: bigint-buffer native bindings are disabled because of GHSA-3gc7-fjrx-p6mg. Reinstall worker dependencies with --ignore-scripts."
    );
  }
}

function sameFeeConfig(left: PrivacyCashFeeConfig, right: PrivacyCashFeeConfig) {
  return (
    left.withdrawFeeRate === right.withdrawFeeRate &&
    left.withdrawBaseFeeLamports === right.withdrawBaseFeeLamports
  );
}

function sameAssetConfig(left: PrivacyCashAssetConfig, right: PrivacyCashAssetConfig) {
  return sameFeeConfig(left, right) && left.minimumWithdrawalRaw === right.minimumWithdrawalRaw;
}

export async function loadPrivacyCashFeeConfig(): Promise<PrivacyCashAssetConfig> {
  const response = await fetch("https://api3.privacycash.org/config");
  if (!response.ok) {
    throw new Error(`Privacy Cash config request failed with HTTP ${response.status}`);
  }
  const raw = protocolConfigSchema.parse(await response.json());
  const config = {
    withdrawFeeRate: raw.withdraw_fee_rate,
    withdrawBaseFeeLamports: Math.ceil(raw.withdraw_rent_fee * LAMPORTS_PER_SOL),
    minimumWithdrawalRaw: Math.ceil(raw.minimum_withdrawal.sol * LAMPORTS_PER_SOL)
  };
  if (expectedFeeConfig && !sameAssetConfig(expectedFeeConfig, config)) {
    throw new Error(
      "Privacy Cash fees changed while the worker was running. Restart the worker before processing withdrawals."
    );
  }
  expectedFeeConfig = config;
  return config;
}

export function createPrivacyCashClient(signer: Keypair) {
  return new PrivacyCash({
    RPC_url: env.SOLANA_RPC_URL,
    owner: signer,
    enableDebug: true
  }).setLogger((level, message) => {
    if (level === "error") console.error("Privacy Cash:", message);
  });
}

export async function withPrivacyCashLease<T>(task: () => Promise<T>): Promise<T | null> {
  const locked = unwrap(
    await db.rpc("acquire_privacy_cash_worker_lock", {
      requested_lock_owner: env.WORKER_ID,
      lease_seconds: 900
    })
  );
  if (!locked) return null;
  try {
    return await task();
  } finally {
    await db.rpc("release_privacy_cash_worker_lock", {
      requested_lock_owner: env.WORKER_ID
    });
  }
}
