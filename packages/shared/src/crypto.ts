import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

export interface EncryptedValue {
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion: number;
}

export class SourceSecretDecryptionError extends Error {
  constructor() {
    super(
      "Source wallet decryption failed: SOURCE_INTERMEDIATE_WALLET_ENCRYPTION_KEY does not match the Telegram database encryption key, or the encrypted blob is corrupted"
    );
    this.name = "SourceSecretDecryptionError";
  }
}

export function decodeMasterKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error("MASTER_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

export function encryptSecret(
  plaintext: string,
  encodedMasterKey: string,
  keyVersion = 1
): EncryptedValue {
  const key = decodeMasterKey(encodedMasterKey);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final()
  ]);

  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion
  };
}

export function decryptSecret(
  encrypted: EncryptedValue,
  encodedMasterKey: string
): string {
  const key = decodeMasterKey(encodedMasterKey);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(encrypted.nonce, "base64")
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
}

export function decryptVersionedSourceSecret(
  encryptedBlob: string,
  encodedSourceKey: string
): string {
  const [version, nonce, ciphertextWithAuthTag] = encryptedBlob.split(":");
  if (version !== "v1" || !nonce || !ciphertextWithAuthTag) {
    throw new Error("Source private key must use v1:<iv>:<ciphertext> format");
  }
  const key = Buffer.from(encodedSourceKey, "base64");
  if (key.length !== 32) {
    throw new Error("SOURCE_INTERMEDIATE_WALLET_ENCRYPTION_KEY must decode to 32 bytes");
  }
  const encrypted = Buffer.from(ciphertextWithAuthTag, "base64");
  if (encrypted.length <= 16) {
    throw new Error("Source private key ciphertext is malformed");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"));
    decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
    return Buffer.concat([
      decipher.update(encrypted.subarray(0, encrypted.length - 16)),
      decipher.final()
    ]).toString("utf8");
  } catch {
    throw new SourceSecretDecryptionError();
  }
}

export function parseSecretKey(input: string): Keypair {
  const trimmed = input.trim();
  let bytes: Uint8Array;

  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      !Array.isArray(parsed) ||
      parsed.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
    ) {
      throw new Error("JSON private key must be an array of bytes");
    }
    bytes = Uint8Array.from(parsed);
  } else {
    try {
      bytes = bs58.decode(trimmed);
    } catch {
      bytes = Buffer.from(trimmed, "base64");
    }
  }

  if (bytes.length === 64) {
    return Keypair.fromSecretKey(bytes);
  }
  if (bytes.length === 32) {
    return Keypair.fromSeed(bytes);
  }
  throw new Error("Private key must decode to a 32-byte seed or 64-byte secret key");
}

export function secretKeyToBase58(input: string): string {
  return bs58.encode(parseSecretKey(input).secretKey);
}
