import { WRAPPED_SOL_MINT } from "@payment/shared";
import { VersionedTransaction, type Keypair } from "@solana/web3.js";
import { env } from "./env.js";

interface TokenInfo {
  id: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  verification?: string;
  isVerified?: boolean;
  organicScore?: number;
  usdPrice?: number;
  audit?: { isSus?: boolean };
}

interface SwapOrder {
  transaction?: string;
  requestId?: string;
  outAmount?: string;
  outputAmount?: string;
  priceImpactPct?: string | number;
  error?: string;
  errorMessage?: string;
}

function apiHeaders(): Record<string, string> {
  if (!env.JUPITER_API_KEY) {
    throw new Error("JUPITER_API_KEY is required for Jupiter API calls");
  }
  return { "x-api-key": env.JUPITER_API_KEY };
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: apiHeaders() });
  if (!response.ok) throw new Error(`Jupiter GET failed with HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export async function getTokenInfo(mint: string): Promise<TokenInfo | null> {
  const rows = await getJson<TokenInfo[]>(
    `https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`
  );
  return rows.find((row) => row.id === mint) ?? null;
}

export async function getSolUsdPrice(): Promise<number> {
  const prices = await getJson<Record<string, { usdPrice?: number }>>(
    `https://api.jup.ag/price/v3?ids=${WRAPPED_SOL_MINT}`
  );
  const price = prices[WRAPPED_SOL_MINT]?.usdPrice;
  if (!price || !Number.isFinite(price)) {
    throw new Error("Jupiter did not return a trustworthy SOL price");
  }
  return price;
}

export async function getSwapOrder(
  inputMint: string,
  inputAmountRaw: string,
  taker: string
): Promise<SwapOrder> {
  const query = new URLSearchParams({
    inputMint,
    outputMint: WRAPPED_SOL_MINT,
    amount: inputAmountRaw,
    taker
  });
  return getJson<SwapOrder>(`https://api.jup.ag/swap/v2/order?${query}`);
}

export function getOrderOutputLamports(order: SwapOrder): bigint {
  const raw = order.outAmount ?? order.outputAmount;
  if (!raw || !/^[0-9]+$/.test(raw)) {
    throw new Error(order.errorMessage ?? order.error ?? "Jupiter order has no output amount");
  }
  return BigInt(raw);
}

export function getOrderPriceImpactPercent(order: SwapOrder): number {
  const fraction = Number(order.priceImpactPct ?? 0);
  if (!Number.isFinite(fraction) || fraction < 0) {
    throw new Error("Jupiter returned an invalid price impact");
  }
  return fraction * 100;
}

export async function signAndExecuteSwap(order: SwapOrder, signer: Keypair) {
  if (!order.transaction || !order.requestId) {
    throw new Error(order.errorMessage ?? order.error ?? "Jupiter order cannot be executed");
  }
  const transaction = VersionedTransaction.deserialize(
    Buffer.from(order.transaction, "base64")
  );
  transaction.sign([signer]);
  const signedTransaction = Buffer.from(transaction.serialize()).toString("base64");
  const response = await fetch("https://api.jup.ag/swap/v2/execute", {
    method: "POST",
    headers: { ...apiHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ signedTransaction, requestId: order.requestId })
  });
  if (!response.ok) throw new Error(`Jupiter execute failed with HTTP ${response.status}`);
  const result = (await response.json()) as {
    status?: string;
    signature?: string;
    error?: string;
    errorMessage?: string;
    outputAmount?: string;
    outAmount?: string;
  };
  if (result.status?.toLowerCase() !== "success" || !result.signature) {
    throw new Error(result.errorMessage ?? result.error ?? `Jupiter swap status: ${result.status}`);
  }
  return result;
}
