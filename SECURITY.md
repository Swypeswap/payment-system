# Security Notes

## Custody Boundary

This platform is custodial software. Imported revenue-wallet private keys can authorize transfers.

- Keep `MASTER_ENCRYPTION_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `.env` outside source control.
- Restrict Ubuntu SSH access and file permissions for `.env`.
- Keep `DRY_RUN=true`, `emergency_paused=true`, swaps disabled, and live payouts disabled until devnet verification is complete.
- Use low-balance revenue wallets. Do not import treasury wallets.
- Rotate revenue wallets, webhook URLs, and the master key immediately if the Ubuntu host is compromised.
- Privacy Cash is mainnet-only. Keep `privacy_cash_enabled=false` until a capped mainnet canary has been reviewed.
- Treat every Privacy Cash or relayer outage as a manual-review event. Never retry an interrupted withdrawal without checking the recipient transaction first.
- Owner and manager payout addresses are public addresses only. The Discord bot must never request seed phrases or private keys.
- Owner wallet updates are authorized by the linked immutable Discord user ID. Usernames are display metadata only.

## Dependency Audit

As of June 1, 2026, the Privacy Cash SDK dependency tree still reports the high-severity advisory `GHSA-3gc7-fjrx-p6mg` in `bigint-buffer@1.1.5`. No patched npm release exists. The vulnerable code path is the package's optional native binding. Worker installs use `--ignore-scripts`, and worker startup refuses to run if `bigint_buffer.node` exists. This forces the package's pure-JavaScript fallback. Recheck this exception whenever the Privacy Cash SDK or Solana SPL dependencies change.

The worker pins `bfj@9.1.3` and `ws@8.21.0` through npm overrides to remove advisories inherited from the current Privacy Cash SDK dependency tree.

The current upstream `@solana/web3.js@1.98.4` package depends on `jayson`, which depends on `uuid@8.3.2`. npm reports the moderate advisory `GHSA-w5hq-g745-h8pq`: missing buffer bounds checks in UUID v3/v5/v6 when a caller supplies a buffer. This platform does not call those UUID buffer APIs. There is currently no upstream-compatible Web3.js fix; forcing npm's suggested downgrade would break the Solana client. Recheck this advisory during dependency updates.
