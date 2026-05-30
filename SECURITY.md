# Security Notes

## Custody Boundary

This platform is custodial software. Imported revenue-wallet private keys can authorize transfers.

- Keep `MASTER_ENCRYPTION_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `.env` outside source control.
- Restrict Ubuntu SSH access and file permissions for `.env`.
- Keep `DRY_RUN=true`, `emergency_paused=true`, swaps disabled, and live payouts disabled until devnet verification is complete.
- Use low-balance revenue wallets. Do not import treasury wallets.
- Rotate revenue wallets, webhook URLs, and the master key immediately if the Ubuntu host is compromised.

## Dependency Audit

As of May 30, 2026, `npm audit --omit=dev --audit-level=high` reports no high-severity production dependency findings.

The current upstream `@solana/web3.js@1.98.4` package depends on `jayson`, which depends on `uuid@8.3.2`. npm reports the moderate advisory `GHSA-w5hq-g745-h8pq`: missing buffer bounds checks in UUID v3/v5/v6 when a caller supplies a buffer. This platform does not call those UUID buffer APIs. There is currently no upstream-compatible Web3.js fix; forcing npm's suggested downgrade would break the Solana client. Recheck this advisory during dependency updates.
