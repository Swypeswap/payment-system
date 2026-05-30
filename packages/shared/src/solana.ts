import { PublicKey } from "@solana/web3.js";

export function validateSolanaWalletAddress(address: string): string {
  const trimmed = address.trim();
  let publicKey: PublicKey;
  try {
    publicKey = new PublicKey(trimmed);
  } catch {
    throw new Error("Invalid Solana wallet address");
  }

  if (!PublicKey.isOnCurve(publicKey.toBytes())) {
    throw new Error("Address is not an on-curve Solana wallet");
  }

  return publicKey.toBase58();
}
