import { decryptVersionedSourceSecret, parseSecretKey } from "@payment/shared";
import { Pool } from "pg";
import { env } from "./env.js";

if (!env.SOURCE_DATABASE_URL) {
  throw new Error("SOURCE_DATABASE_URL is not configured");
}
if (!env.SOURCE_INTERMEDIATE_WALLET_ENCRYPTION_KEY) {
  throw new Error("SOURCE_INTERMEDIATE_WALLET_ENCRYPTION_KEY is not configured");
}

const connection = new URL(env.SOURCE_DATABASE_URL);
connection.search = "";
const pool = new Pool({
  connectionString: connection.toString(),
  max: 1,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 10_000,
  ssl: { rejectUnauthorized: env.SOURCE_DATABASE_SSL_REJECT_UNAUTHORIZED }
});

try {
  const result = await pool.query<{
    intermediate_wallet: string;
    intermediate_private_key_encrypted: string;
  }>(
    `select intermediate_wallet, intermediate_private_key_encrypted
     from public.sites
     where intermediate_wallet is not null
       and intermediate_private_key_encrypted is not null`
  );
  if (result.rows.length === 0) {
    throw new Error("No encrypted intermediate wallets were found in the Telegram database");
  }

  for (const row of result.rows) {
    const secret = decryptVersionedSourceSecret(
      row.intermediate_private_key_encrypted,
      env.SOURCE_INTERMEDIATE_WALLET_ENCRYPTION_KEY
    );
    const signer = parseSecretKey(secret);
    if (signer.publicKey.toBase58() !== row.intermediate_wallet) {
      throw new Error("A decrypted private key does not match its intermediate wallet address");
    }
  }

  console.log(`Source wallet encryption key verified for ${result.rows.length} wallet(s).`);
} catch (error) {
  console.error(
    `Source wallet encryption key verification failed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
