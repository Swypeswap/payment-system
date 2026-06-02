# Confetti Revenue Control

A protected dashboard, Discord bot, and payout worker for Telegram-managed website revenue wallets.

The current payout flow is:

1. The in-house Telegram system creates and owns each website record.
2. This platform mirrors Telegram `sites`, `performers`, and `approved_performers` through a read-only Postgres role.
3. When a mirrored revenue wallet receives SOL, USDC, or SPL tokens, the worker sells safe SPL/USDC balances to SOL and immediately splits native SOL between the performer and company wallet using the latest approved commission percent.
4. When the active company wallet reaches the configured USD threshold, it deposits to Privacy Cash and releases randomized delayed owner payouts as 33/33/34.

## Safety Defaults

The checked-in defaults do not move money:

- `DRY_RUN=true` is an Ubuntu-level kill switch.
- The database starts with `emergency_paused=true`.
- SPL swaps and live payouts start disabled.
- Telegram source sync starts disabled in the dashboard.
- Telegram source database access uses a read-only role. The dashboard server does not receive the source database URL or the source wallet decryption key.
- Mirrored revenue-wallet private keys are stored encrypted for the worker only. They are never displayed or exportable from the dashboard.
- Company-wallet private keys are encrypted with AES-256-GCM. Dashboard reveal requires password re-entry, is rate-limited, and is audited. Company keys are never sent through Discord.
- The encryption master key stays in the Ubuntu `.env` file and must never be stored in Supabase.
- Legacy local revenue wallets can still be grouped and color-labeled. CSV exports contain metadata only; per-wallet private-key downloads are password-confirmed, explicit audited actions.
- Domains can be grouped, color-labeled, archived, restored, and permanently deleted when they have no website history.
- Archived website assignments retain their audit history. Return an archived domain to the pool before linking it again; only one active website can use a domain or revenue wallet at a time.
- Dashboard login attempts are rate-limited. Two failed passwords within 15 minutes block the public IPv4 address or IPv6 `/64` network for a randomized 96-hour to five-week period, and security alerts can be delivered through the global `security_alert` Discord webhook route.
- Network blocks include a one-time VPS recovery code in the owners security webhook. Three distinct blocked networks within 15 minutes automatically place only the frontend into lockdown while Helius ingestion, Supabase log ingestion, health checks, and the payout worker continue running.
- Dashboard sessions are backed by durable records. The Security page lists active IP addresses and devices and can revoke every session immediately. New-login webhooks link directly to that authenticated review page.
- The overview includes payout-readiness and operations-health panels. A manual reconciliation button requests the worker's normal guarded Privacy Cash pass without bypassing pauses, thresholds, leases, or idempotency checks.
- Incoming Helius events and submitted payouts are deduplicated.
- Submitted payout transactions are stored and recovered after worker restarts.
- Suspicious, unpriced, unroutable, or high-impact tokens are quarantined instead of swapped.
- Privacy Cash starts disabled and only runs on Solana mainnet after every kill switch allows it.
- Every guarded SPL conversion, including USDC, settles to native SOL before performer/company splitting.
- Company funds only enter Privacy Cash after the company wallet threshold is reached. Owner payouts are split into delayed randomized SOL legs. Interrupted private withdrawals require manual review and are never retried blindly.
- Retired mirrored revenue-wallet keys can be erased only after the wallet is empty for three continuous days and one owner confirms the one-time Discord action. Public address tombstones remain monitored.

Custom vanity wallets work normally as long as they are valid on-curve Solana public keys.

## Components

- `apps/server`: protected dashboard API, static dashboard, authenticated Helius endpoint, and optional authenticated Supabase log-drain receiver.
- `apps/worker`: Discord bot, Helius registration, read-only Telegram source sync, revenue-wallet swaps/splits, company-wallet reconciliation, Privacy Cash shielding, delayed randomized withdrawals, and wallet-rotation actions.
- `packages/shared`: encryption, wallet validation, constants, and payout-setting resolution.
- `supabase/migrations`: Postgres schema, RLS lockdown, event claiming, and worker leases.

## 1. Create Supabase

1. Create a Supabase project and record its project reference from the dashboard URL.
2. From this repository, run `npx supabase login`.
3. Run `npx supabase link --project-ref YOUR_PROJECT_REFERENCE`.
4. Run `npx supabase db push`.
5. Open **Settings > API Keys** and record:
   - Project URL as `SUPABASE_URL`.
   - A backend secret key as `SUPABASE_SERVICE_ROLE_KEY`. The environment-variable name is retained for compatibility.
6. Never expose the backend secret key in a browser, Discord bot response, or repository.

RLS is enabled and browser roles are revoked. Only the backend services use the service-role key.

## 2. Connect The Telegram Source Database

The Telegram Supabase project is a separate source of truth. This platform must only read it.

Create a read-only Postgres role in the Telegram Supabase SQL editor and grant only the columns needed by the worker:

```sql
create role payment_sync_reader with
  login
  password 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD'
  nosuperuser
  nocreatedb
  nocreaterole
  noinherit
  noreplication
  nobypassrls
  connection limit 2;

grant connect on database postgres to payment_sync_reader;
grant usage on schema public to payment_sync_reader;

grant select (
  id,
  domain,
  intermediate_wallet,
  created_at,
  updated_at,
  status,
  performer_id,
  is_promo_site,
  wallet_auto_generated,
  intermediate_private_key_encrypted,
  intermediate_key_encrypted_at
) on public.sites to payment_sync_reader;

grant select (
  telegram_user_id,
  telegram_username,
  payout_wallet,
  created_at,
  updated_at
) on public.performers to payment_sync_reader;

grant select (
  telegram_user_id,
  telegram_username,
  commission_pct,
  approved_at
) on public.approved_performers to payment_sync_reader;
```

Put the read-only pooler URL in Ubuntu `.env` as `SOURCE_DATABASE_URL`. Use the source wallet decryption key from the Telegram system as `SOURCE_INTERMEDIATE_WALLET_ENCRYPTION_KEY`.

```dotenv
SOURCE_DATABASE_URL=postgresql://payment_sync_reader.PROJECT_REF:PASSWORD@aws-1-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require
SOURCE_INTERMEDIATE_WALLET_ENCRYPTION_KEY=
SOURCE_DATABASE_SSL_REJECT_UNAUTHORIZED=false
SOURCE_SYNC_INTERVAL_MS=15000
```

`docker-compose.yml` intentionally clears these two source values for the `server` container. Only the worker receives them.

## 3. Create Discord App

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Add a bot and record its token as `DISCORD_BOT_TOKEN`.
3. Record the application ID as `DISCORD_APPLICATION_ID`.
4. Enable Developer Mode in Discord and copy your server ID as `DISCORD_GUILD_ID`.
5. Invite the bot with the `bot` and `applications.commands` scopes. Grant it permission to view and send messages in team payout channels.
6. Create a separate owners-only Discord server and invite the same bot. Record that server ID as `DISCORD_OWNERS_GUILD_ID`.
7. Create a private owners notification channel. Add its server and channel IDs under **Settings** in this platform.
8. Create a manager role and optionally a staff role in the manager server. Copy their IDs.
9. After deployment, add the role IDs under **Settings** in this platform.
10. Run `docker compose exec worker npm run register:discord`.
11. In the manager server, open **Server Settings > Integrations > your bot** and allow:
   - `/wallet-update` for the manager role only.
   - `/request-website` for the manager role and optional staff role.

The bot also verifies roles and manager-to-team assignments server-side. In the owners server, `/owner-wallet-update`, `/approve-manager-wallet`, and `/reject-manager-wallet` are registered separately. Only owner profiles linked by immutable Discord user ID can use them.

## 4. Create Helius And Jupiter Keys

1. Create a Helius account and API key in the [Helius dashboard](https://dashboard.helius.dev/).
2. Put the key in `HELIUS_API_KEY`.
3. Use its devnet RPC URL as `SOLANA_RPC_URL` while testing.
4. Create a Jupiter API key in the [Jupiter Developer Platform](https://developers.jup.ag/).
5. Put it in `JUPITER_API_KEY`.

The worker creates or updates one authenticated Helius webhook for all hosted website revenue wallets. Helius can start on its free plan. Jupiter also offers a free tier. Confirm current pricing and limits before production traffic.

## 5. Prepare Ubuntu

Use Ubuntu 24.04 LTS or newer.

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
newgrp docker
docker run hello-world
docker compose version
git clone YOUR_REPOSITORY_URL payment-system
cd payment-system
cp .env.example .env
```

Allow inbound SSH from your IP and inbound TCP ports `80` and `443` from the internet. Do not expose port `3000`. Point a DNS `A` record such as `payouts.example.com` to the Ubuntu server. Caddy will obtain the TLS certificate automatically.

## 6. Generate Secrets On PowerShell

On your trusted Windows workstation:

```powershell
npm install
npm run generate:secrets
node ./scripts/hash-password.mjs "THE_GENERATED_DASHBOARD_PASSWORD"
```

Store the displayed dashboard password in your password manager. Put only its generated hash in `DASHBOARD_PASSWORD_HASH`.

Copy the following generated values into the Ubuntu `.env` file:

```dotenv
MASTER_ENCRYPTION_KEY=
SESSION_SECRET=
HELIUS_WEBHOOK_AUTH=
DASHBOARD_PASSWORD_HASH=
```

Fill the remaining Supabase, Discord, Helius, Jupiter, domain, and RPC values from [`.env.example`](./.env.example).

## Optional Security Monitoring

1. In the dashboard, save a global `security_alert` Discord webhook route.
2. Add an `IPINFO_TOKEN` from [IPinfo](https://ipinfo.io/account/token) to Ubuntu `.env` to enrich alerts with VPN and proxy detection. IPinfo Plus provides VPN, proxy, Tor, and relay detail. IPinfo Core provides limited anonymous and hosting flags. Without a compatible token, the alert reports a safe HTTP diagnostic.
3. Generate a separate random `SUPABASE_LOG_DRAIN_AUTH` value and add it to Ubuntu `.env`.
4. If your Supabase plan supports Log Drains, create a generic HTTP log drain:
   - Endpoint: `https://YOUR_DASHBOARD_DOMAIN/webhooks/supabase/logs`
   - Header: `Authorization: Bearer YOUR_SUPABASE_LOG_DRAIN_AUTH`
   - Gzip: disabled

The receiver raises alerts for authentication failures, permission failures, and privileged database changes. Supabase API logs may include an IP address and user agent. Direct Postgres activity does not provide browser device details, so those fields are reported as unavailable when the drained event does not contain them. Enable and tune [Supabase pgAudit](https://supabase.com/docs/guides/database/extensions/pgaudit) separately if you need deeper database activity logging.

Treat the owners security webhook channel as sensitive. Its one-time recovery codes are randomly generated 256-bit bearer secrets. Supabase stores only SHA-256 hashes of those codes. Use the interactive VPS command to redeem a network-unblock or frontend-unlock code:

```bash
docker compose exec -it server npm --prefix apps/server run security:ops
```

The same command can manually place the frontend into complete lockdown. During lockdown, the dashboard HTML, assets, login endpoint, and dashboard APIs return a minimal `503`. Background payout processing remains separate and continues running. Redeeming a code sends a new owners security webhook alert.

For local development, install every package with:

```powershell
npm run install:all
```

## 7. Start In Devnet Dry-Run Mode

Keep these values:

```dotenv
SOLANA_CLUSTER=devnet
DRY_RUN=true
```

Start the services:

```bash
docker compose up -d --build
docker compose logs -f server worker
```

Open `https://YOUR_DASHBOARD_DOMAIN` and sign in with the generated password.

In the dashboard:

1. Add each Discord webhook route separately. Deposit, swap, split, company threshold, Privacy Cash, wallet lifecycle, security, and worker-error notifications can all use different webhooks and independent `@everyone` settings.
2. Add exactly three active owner profiles with Discord IDs and Solana wallets.
3. Set the owners Discord server and notification channel.
4. Open **Company** and generate the initial company wallet. Reveal/copy the private key only after password re-entry, then store it securely offline.
5. Confirm `SOURCE_DATABASE_URL` and `SOURCE_INTERMEDIATE_WALLET_ENCRYPTION_KEY` are present only for the worker.
6. Keep **External Telegram sync**, **Guarded SPL and USDC swaps**, **Company Privacy Cash**, **Live payouts**, and **Emergency pause** in the safe state until you finish the checks below.

The top-right `PAUSED` badge means **Emergency pause** is enabled. To leave the safe default, open **Settings**, uncheck **Emergency pause**, and save. The badge changes to `DRY RUN` or `LIVE` depending on the other payout switches and Ubuntu `DRY_RUN`.

## 8. Verify Before Mainnet

Complete this checklist on devnet:

1. `docker compose exec worker npm run register:discord` registers owner commands and lifecycle buttons.
2. The dashboard shows the mirrored Telegram source rows after **External Telegram sync** is enabled.
3. The mirrored revenue wallet count matches the Telegram `sites` table rows that have a wallet and encrypted key.
4. A test deposit creates a separate deposit notification.
5. A safe SPL or USDC balance creates a separate swap notification and settles to SOL.
6. The performer/company split notification uses the latest `approved_performers.commission_pct` and `performers.payout_wallet`.
7. If a performer is missing approval, commission, or wallet, processing stops and creates a review-required notification.
8. When the company threshold is reached, a company Privacy Cash shield job and randomized owner withdrawal legs are created in dry-run mode.
9. Restarting `worker` does not duplicate deposits, swaps, splits, lifecycle requests, or payout legs.
10. Emergency pause prevents swaps, splits, and Privacy Cash movement.

Privacy Cash does not offer devnet support. Devnet verifies application logic only. Protocol integration must use a tightly capped mainnet canary.

## 9. Enable Mainnet Carefully

1. Change `SOLANA_CLUSTER=mainnet-beta`.
2. Use a production Helius RPC URL.
3. Confirm the Telegram source DB contains the real mainnet revenue-wallet rows.
4. Start with a low-value site and keep `DRY_RUN=true`.
5. Confirm deposit detection, guarded swap decisions, performer/company split calculation, and dry-run company Privacy Cash planning.
6. Register both Discord guilds with `docker compose exec worker npm run register:discord`.
7. In the dashboard, enable **External Telegram sync**, disable **Emergency pause**, then enable **Guarded SPL and USDC swaps**, **Company Privacy Cash**, and **Live payouts**.
8. Change `DRY_RUN=false` in Ubuntu `.env`.
9. Restart:

```bash
docker compose up -d
docker compose logs -f worker
```

The environment switch and dashboard switches must all allow movement before funds are sent.

## Operations

Back up the Ubuntu `.env` securely. If `MASTER_ENCRYPTION_KEY` is lost, company wallets and local encrypted secrets cannot be recovered. If `SOURCE_INTERMEDIATE_WALLET_ENCRYPTION_KEY` is lost, mirrored Telegram revenue-wallet keys cannot be decrypted. If either is exposed, pause the platform, rotate affected wallets, rotate Discord webhooks, and replace the exposed key.

Useful commands:

```bash
docker compose ps
docker compose logs -f worker
docker compose restart worker
docker compose exec worker npm run register:discord
```

The worker syncs the Telegram source database according to `SOURCE_SYNC_INTERVAL_MS`, reconciles company Privacy Cash according to `RECONCILE_INTERVAL_MS`, and polls durable manual reconciliation requests. The dashboard shows mirrored revenue wallets, company-wallet status, Privacy Cash jobs, review-required items, active sessions, worker heartbeat, last Helius event, queue depth, review-required jobs, and delayed withdrawal count.

Review [`SECURITY.md`](./SECURITY.md) before enabling mainnet transfers.

The worker intentionally installs dependencies with `--ignore-scripts`. Do not remove that flag: it keeps the optional vulnerable `bigint-buffer` native binding disabled and forces the guarded pure-JavaScript fallback.

## External Documentation

- [Discord application commands](https://docs.discord.com/developers/interactions/application-commands)
- [Discord interactions and modals](https://docs.discord.com/developers/platform/interactions)
- [Helius authenticated webhooks](https://www.helius.dev/docs/faqs/webhooks)
- [Jupiter Swap API V2](https://developers.jup.ag/docs/swap)
- [Jupiter Price API V3](https://developers.jup.ag/docs/price)
- [Jupiter Tokens API](https://developers.jup.ag/docs/tokens)
- [Solana RPC commitments](https://solana.com/docs/rpc)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase Log Drains](https://supabase.com/docs/guides/telemetry/log-drains)
- [Supabase pgAudit](https://supabase.com/docs/guides/database/extensions/pgaudit)
- [IPinfo privacy detection](https://ipinfo.io/developers/privacy-detection-api)
- [Privacy Cash backend SDK](https://privacycash.mintlify.app/sdk/overview)
- [Privacy Cash privacy tips](https://privacycash.mintlify.app/documentation/user-docs/privacy-tips)
