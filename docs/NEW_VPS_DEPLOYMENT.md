# Move Confetti Revenue Control To A New VPS

This is a controlled cutover. Never run the old and new payout workers live at the same time.

## 1. Inventory And Back Up

On the old VPS:

```bash
cd ~/payment-system
docker compose ps
docker compose logs --tail=200 worker
cp .env ".env.backup.$(date +%Y%m%d-%H%M%S)"
git rev-parse HEAD
```

Securely retain the old `.env`. The following values must remain identical on the new VPS:

- `MASTER_ENCRYPTION_KEY`, required to decrypt company-wallet keys and encrypted dashboard secrets.
- `SOURCE_INTERMEDIATE_WALLET_ENCRYPTION_KEY`, required to decrypt source revenue-wallet keys.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, unless the writable payment database is also intentionally migrated.
- Discord, Helius, Jupiter, session, webhook-auth, and dashboard-password values.

Do not email the `.env` or commit it to Git.

## 2. Create And Harden The New VPS

Create Ubuntu 24.04 LTS with an SSH key. In the provider firewall allow:

- TCP `22` only from your administrative IP where practical.
- TCP `80` and `443` from the internet.
- No public access to `3000`.

Log in with the SSH key, create a non-root sudo user, and install Docker using Docker's official Ubuntu repository:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
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
docker compose version
```

## 3. Install The Application

```bash
git clone https://github.com/Swypeswap/payment-system.git ~/payment-system
cd ~/payment-system
cp .env.example .env
chmod 600 .env
```

Transfer the real `.env` over an encrypted SSH/SCP connection, then edit these host-specific values:

```dotenv
PUBLIC_BASE_URL=https://YOUR_DASHBOARD_DOMAIN
HELIUS_WEBHOOK_URL=https://YOUR_DASHBOARD_DOMAIN/webhooks/helius
DASHBOARD_DOMAIN=YOUR_DASHBOARD_DOMAIN
DRY_RUN=true
```

Keep `DRY_RUN=true` during installation. Also leave the database emergency pause enabled.

## 4. Apply The Writable Database Migrations

On a trusted workstation with the repository:

```powershell
npx supabase login
npx supabase link --project-ref YOUR_PAYMENT_SYSTEM_PROJECT_REF
npx supabase db push
```

This targets the payment-system Supabase project, not the Telegram source project. The source project receives only the read-only role from `SOURCE_DATABASE_RELINK.md`.

## 5. Start The Frontend Without The Worker

Point the dashboard DNS `A`/`AAAA` record to the new VPS. Then:

```bash
cd ~/payment-system
docker compose up -d --build server caddy
docker compose ps
docker compose logs --tail=200 server caddy
```

Verify HTTPS, login, Security, Revenue diagnostics, Company wallet history, owner percentages, and Privacy Cash queues. The encrypted company wallet must still be readable after password re-entry; if it is not, stop and restore the original `MASTER_ENCRYPTION_KEY`.

## 6. Perform The Worker Cutover

First stop the old worker:

```bash
cd ~/payment-system
docker compose stop worker
docker compose ps
```

Then start exactly one worker on the new VPS:

```bash
cd ~/payment-system
docker compose up -d --build worker
docker compose exec worker npm run register:discord
docker compose logs -f worker
```

Confirm:

1. Worker heartbeat is online.
2. Source sync counts match the new Telegram database.
3. Helius events reach the new HTTPS webhook.
4. There are no duplicate or stuck split/shield/withdrawal jobs.
5. Owner allocation has 2-5 active owners and totals exactly 100%.
6. Company wallet and Privacy Cash recovery data are present.

## 7. Enable Live Operation

After the checks pass:

1. Set `SOLANA_CLUSTER=mainnet-beta`.
2. Keep `DRY_RUN=true` for one final reconciliation.
3. Enable source sync, guarded swaps, Privacy Cash, and live payouts in the dashboard.
4. Disable emergency pause only when readiness is green.
5. Change VPS `.env` to `DRY_RUN=false`.
6. Recreate the containers so the environment change is loaded:

```bash
docker compose up -d --force-recreate server worker
docker compose logs --tail=300 worker
```

## 8. Decommission The Old VPS

Keep the old worker stopped. Retain the old VPS only long enough to confirm DNS, webhooks, sessions, logs, and at least one guarded low-value cycle. Then remove secrets from the old host and delete it through the provider.

Official references:

- Docker Engine on Ubuntu: https://docs.docker.com/engine/install/ubuntu/
- Supabase CLI project linking: https://supabase.com/docs/reference/cli/supabase-link
- Supabase migration deployment: https://supabase.com/docs/reference/cli/supabase-db-push
- Supabase database connections and poolers: https://supabase.com/docs/guides/database/connecting-to-postgres
- Hetzner Cloud firewalls: https://docs.hetzner.com/cloud/firewalls/getting-started/creating-a-firewall/
