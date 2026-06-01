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
- Revenue-wallet CSV exports contain metadata only. Private-key exports are separate, per-wallet, authenticated, password-confirmed, rate-limited, audited, and returned with `no-store` headers.

## Dashboard Boundary

- Dashboard login attempts are rate-limited. Two failed passwords within 15 minutes block the public IPv4 address or IPv6 `/64` network for a cryptographically randomized period between 96 hours and five weeks.
- Configure a global owners-only `security_alert` Discord webhook before production. Network blocks include a one-time 256-bit VPS recovery code, while Supabase stores only its SHA-256 hash. Redeeming a recovery code is interactive, consumes it once, and emits a new webhook alert.
- Three distinct blocked networks within 15 minutes automatically lock down the frontend. Dashboard pages, assets, login, and dashboard APIs return a minimal `503`; authenticated Helius ingestion, authenticated Supabase log ingestion, health checks, and the separate payout worker remain available.
- Use `docker compose exec -it server npm --prefix apps/server run security:ops` on the VPS to redeem a recovery code or manually activate complete frontend lockdown.
- Configure `IPINFO_TOKEN` to enrich security alerts with VPN and proxy detection. If the lookup is not configured or unavailable, the alert reports `Unknown`.
- The dashboard clears password fields on load, after login attempts, and whenever a sensitive export closes. Password inputs request no browser autofill. A password-manager extension can still override page hints, so enforce that policy in managed browsers as well.
- The server trusts exactly one reverse-proxy hop because Docker exposes it through Caddy only. Do not expose the server container's port `3000` directly.
- Inputs are schema-validated and database access uses the Supabase query builder. Do not add raw SQL built from dashboard input.
- Browser roles remain revoked and Row Level Security remains enabled. The service-role secret must stay server-side.
- Responses include a restrictive Content Security Policy, frame blocking, MIME sniffing protection, referrer restrictions, and a permissions policy.

## Ubuntu Secret Boundary

- Store `.env` as `root:root` with mode `600`, keep backups encrypted offline, and prefer provider-supported full-disk encryption or an external secret manager for stronger at-rest protection.
- Root cannot be forced to enter an additional `.env` password while the application is running. A root-equivalent user can inspect files, process memory, mounted credentials, or container configuration. Encryption protects secrets at rest, not after the running service has received them.
- Prefer SSH keys with passphrases, disable direct root SSH login, and disable SSH password authentication after verifying key access in a second terminal. Keep provider-console recovery available before changing SSH settings.

## Supabase Monitoring

- If your Supabase plan supports Log Drains, configure an uncompressed generic HTTP drain to `https://YOUR_DASHBOARD_DOMAIN/webhooks/supabase/logs` with `Authorization: Bearer YOUR_SUPABASE_LOG_DRAIN_AUTH`.
- The receiver emits alerts for authentication failures, permission failures, and privileged database changes without copying raw SQL statements into Discord.
- Supabase API logs can contain an IP address and user agent. Direct Postgres events do not reliably contain browser device metadata because no browser is involved.
- Enable and tune Supabase `pgAudit` separately for deeper database activity logging. Treat alerts as detection signals, not proof that the database has been breached.

## Dependency Audit

As of June 1, 2026, the Privacy Cash SDK dependency tree still reports the high-severity advisory `GHSA-3gc7-fjrx-p6mg` in `bigint-buffer@1.1.5`. No patched npm release exists. The vulnerable code path is the package's optional native binding. Worker installs use `--ignore-scripts`, and worker startup refuses to run if `bigint_buffer.node` exists. This forces the package's pure-JavaScript fallback. Recheck this exception whenever the Privacy Cash SDK or Solana SPL dependencies change.

The worker pins `bfj@9.1.3` and `ws@8.21.0` through npm overrides to remove advisories inherited from the current Privacy Cash SDK dependency tree.

The current upstream `@solana/web3.js@1.98.4` package depends on `jayson`, which depends on `uuid@8.3.2`. npm reports the moderate advisory `GHSA-w5hq-g745-h8pq`: missing buffer bounds checks in UUID v3/v5/v6 when a caller supplies a buffer. This platform does not call those UUID buffer APIs. There is currently no upstream-compatible Web3.js fix; forcing npm's suggested downgrade would break the Solana client. Recheck this advisory during dependency updates.
