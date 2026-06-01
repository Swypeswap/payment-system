# Solana Team Payout Platform

A protected dashboard, Discord bot, and payout worker for website-specific Solana revenue wallets.

## Safety Defaults

The checked-in defaults do not move money:

- `DRY_RUN=true` is an Ubuntu-level kill switch.
- The database starts with `emergency_paused=true`.
- SPL swaps and live payouts start disabled.
- Revenue-wallet private keys are encrypted with AES-256-GCM before they enter Supabase.
- The encryption master key stays in the Ubuntu `.env` file and must never be stored in Supabase.
- Revenue wallets can be grouped and color-labeled. CSV exports contain metadata only; per-wallet private-key downloads are password-confirmed, explicit audited actions.
- Domains can be grouped, color-labeled, archived, restored, and permanently deleted when they have no website history.
- Dashboard login attempts are rate-limited and security alerts can be delivered through the global `security_alert` Discord webhook route.
- Incoming Helius events and submitted payouts are deduplicated.
- Submitted payout transactions are stored and recovered after worker restarts.
- Suspicious, unpriced, unroutable, or high-impact tokens are quarantined instead of swapped.
- Privacy Cash starts disabled and only runs on Solana mainnet after every kill switch allows it.
- Every guarded SPL conversion, including USDC, settles to native SOL before Privacy Cash shielding.
- SOL payouts are split into delayed randomized legs. Interrupted private withdrawals require manual review and are never retried blindly.

Custom vanity wallets work normally as long as they are valid on-curve Solana public keys.

## Components

- `apps/server`: protected dashboard API, static dashboard, authenticated Helius endpoint, and optional authenticated Supabase log-drain receiver.
- `apps/worker`: Discord bot, Helius registration, periodic reconciliation, swaps, Privacy Cash shielding, delayed randomized withdrawals, and wallet-rotation recommendations.
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

## 2. Create Discord App

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

## 3. Create Helius And Jupiter Keys

1. Create a Helius account and API key in the [Helius dashboard](https://dashboard.helius.dev/).
2. Put the key in `HELIUS_API_KEY`.
3. Use its devnet RPC URL as `SOLANA_RPC_URL` while testing.
4. Create a Jupiter API key in the [Jupiter Developer Platform](https://developers.jup.ag/).
5. Put it in `JUPITER_API_KEY`.

The worker creates or updates one authenticated Helius webhook for all hosted website revenue wallets. Helius can start on its free plan. Jupiter also offers a free tier. Confirm current pricing and limits before production traffic.

## 4. Prepare Ubuntu

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

## 5. Generate Secrets On PowerShell

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
2. Add an `IPINFO_TOKEN` to Ubuntu `.env` to enrich alerts with VPN and proxy detection. Without it, VPN status is reported as `Unknown`.
3. Generate a separate random `SUPABASE_LOG_DRAIN_AUTH` value and add it to Ubuntu `.env`.
4. If your Supabase plan supports Log Drains, create a generic HTTP log drain:
   - Endpoint: `https://YOUR_DASHBOARD_DOMAIN/webhooks/supabase/logs`
   - Header: `Authorization: Bearer YOUR_SUPABASE_LOG_DRAIN_AUTH`
   - Gzip: disabled

The receiver raises alerts for authentication failures, permission failures, and privileged database changes. Supabase API logs may include an IP address and user agent. Direct Postgres activity does not provide browser device details, so those fields are reported as unavailable when the drained event does not contain them. Enable and tune [Supabase pgAudit](https://supabase.com/docs/guides/database/extensions/pgaudit) separately if you need deeper database activity logging.

For local development, install every package with:

```powershell
npm run install:all
```

## 6. Start In Devnet Dry-Run Mode

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

1. Add global Discord webhook routes.
2. Add manager Discord IDs.
3. Add exactly three owner profiles with Discord IDs. Add teams, assign managers, and configure each team channel and payout message.
4. Import devnet revenue-wallet private keys.
5. Bulk-import domains.
6. Assign a domain, team, revenue wallet, and optional website overrides.
7. Toggle **Hosted** for the website.
8. Keep the emergency pause enabled initially.

## 7. Verify Before Mainnet

Complete this checklist on devnet:

1. `/request-website` sends the expected request notification.
2. A regular member cannot run either command.
3. A manager can update only an assigned team's wallet.
4. Invalid and off-curve wallet values are rejected.
5. Toggling **Hosted** sends an `@everyone` activation message.
6. A devnet SOL deposit appears in the dashboard and Discord.
7. Dry-run Privacy Cash shield batches and randomized SOL payout legs appear above the configured USD threshold.
8. Restarting `worker` does not duplicate a deposit or payout.
9. The emergency pause prevents swaps and payouts.
10. A notification-route test succeeds from the dashboard.

Privacy Cash does not offer devnet support. Devnet verifies application logic only. Protocol integration must use a tightly capped mainnet canary.

## 8. Enable Mainnet Carefully

1. Change `SOLANA_CLUSTER=mainnet-beta`.
2. Use a production Helius RPC URL.
3. Recreate the hosted website assignments with mainnet revenue wallets.
4. Start with a low-value website and keep `DRY_RUN=true`.
5. Confirm deposit detection and dry-run payout calculations.
6. Add three linked owner profiles and set the owners Discord channel. Register both guilds with `docker compose exec worker npm run register:discord`.
7. In the dashboard, disable **Emergency pause**, then enable **Guarded SPL swaps**, **Privacy Cash**, and **Live payouts**.
8. Change `DRY_RUN=false` in Ubuntu `.env`.
9. Restart:

```bash
docker compose up -d
docker compose logs -f worker
```

The environment switch and dashboard switches must all allow movement before funds are sent.

## Operations

Back up the Ubuntu `.env` securely. If `MASTER_ENCRYPTION_KEY` is lost, imported private keys and webhook URLs cannot be recovered. If it is exposed, pause the platform, rotate every revenue wallet, rotate Discord webhooks, and replace the master key.

Useful commands:

```bash
docker compose ps
docker compose logs -f worker
docker compose restart worker
docker compose exec worker npm run register:discord
```

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
