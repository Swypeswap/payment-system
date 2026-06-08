# Relink The Telegram Supabase Database

This procedure changes only the read-only Telegram/source database. The payment-system Supabase project remains the writable database used by the dashboard and worker.

## 1. Create The Read-Only Role

In the new Telegram Supabase project's SQL editor, generate a long unique password and run:

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
  id, domain, intermediate_wallet, created_at, updated_at, status,
  performer_id, is_promo_site, wallet_auto_generated,
  intermediate_private_key_encrypted, intermediate_key_encrypted_at
) on public.sites to payment_sync_reader;

grant select (
  telegram_user_id, telegram_username, payout_wallet, created_at, updated_at,
  customer_id, referral_code, referred_by_performer_id, referral_code_used,
  lifetime_volume_usd, lifetime_connects, lifetime_hits
) on public.performers to payment_sync_reader;

grant select (telegram_user_id)
on public.approved_performers to payment_sync_reader;

grant select (
  referred_performer_id, referrer_performer_id, referral_code_used,
  referral_commission_pct, referred_username_at_launch,
  referrer_username_at_launch
) on public.performer_referrals to payment_sync_reader;
```

If these tables have RLS enabled, also run:

```sql
create policy payment_sync_reader_sites_select
on public.sites for select to payment_sync_reader using (true);

create policy payment_sync_reader_performers_select
on public.performers for select to payment_sync_reader using (true);

create policy payment_sync_reader_approved_performers_select
on public.approved_performers for select to payment_sync_reader using (true);

create policy payment_sync_reader_referrals_select
on public.performer_referrals for select to payment_sync_reader using (true);
```

The role intentionally has no insert, update, delete, function-execution, or key-management permission.

## 2. Build The Pooler URL

Open **Connect > Direct connection / Session pooler** in the new source project. Use the session pooler on port `5432`.

The username must include the new project reference:

```text
postgresql://payment_sync_reader.NEW_PROJECT_REF:URL_ENCODED_PASSWORD@POOLER_HOST:5432/postgres?sslmode=require
```

Encode special password characters in PowerShell:

```powershell
[uri]::EscapeDataString('YOUR_ROLE_PASSWORD')
```

Do not use the Supabase `postgres` or service-role credential for source sync.

## 3. Update The Worker Environment

On the VPS:

```bash
cd ~/payment-system
cp .env ".env.backup.$(date +%Y%m%d-%H%M%S)"
nano .env
```

Change:

```dotenv
SOURCE_DATABASE_URL=postgresql://payment_sync_reader.NEW_PROJECT_REF:URL_ENCODED_PASSWORD@POOLER_HOST:5432/postgres?sslmode=require
SOURCE_INTERMEDIATE_WALLET_ENCRYPTION_KEY=THE_KEY_USED_BY_THE_NEW_TELEGRAM_PROJECT
SOURCE_DATABASE_SSL_REJECT_UNAUTHORIZED=false
```

`SOURCE_INTERMEDIATE_WALLET_ENCRYPTION_KEY` is not a newly generated payment-system key. It must be the exact 32-byte base64 key that encrypted `sites.intermediate_private_key_encrypted` in the new Telegram project.

## 4. Restart And Verify

Restart only the worker:

```bash
docker compose up -d --build worker
docker compose logs --tail=200 worker
```

In the dashboard:

1. Open **Settings** and ensure source sync is enabled.
2. Open **Revenue**.
3. Confirm the diagnostics show `Configured`, a recent successful sync, and the expected site/performer counts.
4. Expand several performers and verify payout wallet, customer ID, referral code, referrer, and linked domains.
5. Confirm an offline site still appears while its `sites` row exists.

The mirror reconciles a site by source UUID or intermediate-wallet address, which supports a project switch where the same wallet has a new site UUID.

## 5. Failure Checks

Use:

```bash
docker compose exec worker node -e 'console.log(new URL(process.env.SOURCE_DATABASE_URL).hostname)'
docker compose logs --tail=300 worker | grep -i "source.sync"
```

Expected errors:

- `permission denied`: add the missing column grant and RLS policy.
- `password authentication failed`: verify the role password, project-ref suffix, and URL encoding.
- `ECONNREFUSED 127.0.0.1:5432`: the environment variable was not loaded or has the wrong name.
- AES-GCM/decryption failure: the source encryption key does not match the new Telegram project.

Never paste either database password or encryption key into Discord, screenshots, Git, or dashboard fields.
