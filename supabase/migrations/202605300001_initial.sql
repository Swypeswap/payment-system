create extension if not exists pgcrypto;

create table public.app_settings (
  id boolean primary key default true check (id),
  global_threshold_usd numeric(18, 2) not null default 100 check (global_threshold_usd > 0),
  global_manager_percent numeric(7, 4) not null default 10 check (global_manager_percent >= 0 and global_manager_percent <= 100),
  global_company_percent numeric(7, 4) not null default 90 check (global_company_percent >= 0 and global_company_percent <= 100),
  global_sol_reserve numeric(18, 9) not null default 0.02 check (global_sol_reserve >= 0),
  min_swap_usd numeric(18, 2) not null default 1 check (min_swap_usd >= 0),
  max_price_impact_pct numeric(9, 4) not null default 5 check (max_price_impact_pct >= 0),
  min_organic_score numeric(7, 4) not null default 0 check (min_organic_score >= 0 and min_organic_score <= 100),
  swaps_enabled boolean not null default false,
  live_payouts_enabled boolean not null default false,
  emergency_paused boolean not null default true,
  discord_manager_role_ids text[] not null default '{}',
  discord_staff_role_ids text[] not null default '{}',
  helius_webhook_id text,
  updated_at timestamptz not null default now(),
  check (global_manager_percent + global_company_percent = 100)
);

insert into public.app_settings (id) values (true);

create table public.managers (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (length(trim(display_name)) > 0),
  discord_user_id text not null unique check (discord_user_id ~ '^[0-9]{15,22}$'),
  discord_username text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(trim(name)) > 0),
  manager_wallet_address text,
  payout_discord_channel_id text check (payout_discord_channel_id is null or payout_discord_channel_id ~ '^[0-9]{15,22}$'),
  payout_message text not null default 'New payout for the team. GG! 💸 🎉',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.team_managers (
  team_id uuid not null references public.teams(id) on delete cascade,
  manager_id uuid not null references public.managers(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (team_id, manager_id)
);

create table public.revenue_wallets (
  id uuid primary key default gen_random_uuid(),
  label text not null check (length(trim(label)) > 0),
  address text not null unique,
  encrypted_private_key text not null,
  encryption_nonce text not null,
  encryption_auth_tag text not null,
  encryption_key_version integer not null default 1 check (encryption_key_version > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.domains (
  id uuid primary key default gen_random_uuid(),
  domain text not null unique check (length(trim(domain)) > 0),
  status text not null default 'pool' check (status in ('pool', 'assigned', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.websites (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid not null unique references public.domains(id),
  team_id uuid not null references public.teams(id),
  revenue_wallet_id uuid not null unique references public.revenue_wallets(id),
  company_wallet_address text not null,
  hosted boolean not null default false,
  remarks text not null default '',
  threshold_usd numeric(18, 2) check (threshold_usd is null or threshold_usd > 0),
  manager_percent numeric(7, 4) check (manager_percent is null or (manager_percent >= 0 and manager_percent <= 100)),
  company_percent numeric(7, 4) check (company_percent is null or (company_percent >= 0 and company_percent <= 100)),
  sol_reserve numeric(18, 9) check (sol_reserve is null or sol_reserve >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (manager_percent is null and company_percent is null)
    or
    (manager_percent is not null and company_percent is not null and manager_percent + company_percent = 100)
  )
);

create table public.notification_routes (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('website_request', 'website_activation', 'deposit', 'payout', 'security_alert', 'worker_error')),
  team_id uuid references public.teams(id) on delete cascade,
  name text not null,
  encrypted_webhook_url text not null,
  encryption_nonce text not null,
  encryption_auth_tag text not null,
  encryption_key_version integer not null default 1 check (encryption_key_version > 0),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (kind, team_id)
);

create table public.website_requests (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id),
  requested_by_discord_user_id text not null,
  requested_by_username text not null,
  ideas text not null default '',
  preferences text not null default '',
  website_count integer not null check (website_count > 0 and website_count <= 100),
  status text not null default 'open' check (status in ('open', 'in_progress', 'completed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.wallet_update_history (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id),
  old_wallet_address text,
  new_wallet_address text not null,
  actor_type text not null check (actor_type in ('dashboard', 'discord')),
  actor_id text not null,
  created_at timestamptz not null default now()
);

create table public.chain_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'helius',
  provider_event_key text not null unique,
  signature text,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'processed', 'failed')),
  attempts integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index chain_events_pending_idx on public.chain_events(status, created_at);

create table public.deposits (
  id uuid primary key default gen_random_uuid(),
  chain_event_id uuid references public.chain_events(id),
  website_id uuid not null references public.websites(id),
  revenue_wallet_id uuid not null references public.revenue_wallets(id),
  signature text not null,
  asset_key text not null,
  asset_mint text,
  raw_amount numeric(40, 0) not null check (raw_amount > 0),
  decimals integer not null check (decimals >= 0 and decimals <= 18),
  amount numeric(40, 18) not null check (amount > 0),
  created_at timestamptz not null default now(),
  unique (signature, revenue_wallet_id, asset_key)
);

create table public.swap_attempts (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id),
  revenue_wallet_id uuid not null references public.revenue_wallets(id),
  input_mint text not null,
  input_amount_raw numeric(40, 0) not null,
  estimated_usd_value numeric(40, 8),
  estimated_output_lamports numeric(40, 0),
  actual_output_lamports numeric(40, 0),
  status text not null check (status in ('skipped', 'quarantined', 'submitted', 'succeeded', 'failed')),
  reason text,
  signature text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.payout_attempts (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id),
  revenue_wallet_id uuid not null references public.revenue_wallets(id),
  idempotency_key text not null unique,
  manager_wallet_address text not null,
  company_wallet_address text not null,
  source_balance_lamports numeric(40, 0) not null,
  reserve_lamports numeric(40, 0) not null,
  manager_lamports numeric(40, 0) not null,
  company_lamports numeric(40, 0) not null,
  signature text unique,
  raw_transaction_base64 text,
  last_valid_block_height numeric(40, 0),
  status text not null check (status in ('dry_run', 'submitted', 'succeeded', 'failed', 'expired')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.wallet_balance_snapshots (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id),
  revenue_wallet_id uuid not null references public.revenue_wallets(id),
  sol_lamports numeric(40, 0) not null,
  token_balances jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table public.website_processing_locks (
  website_id uuid primary key references public.websites(id) on delete cascade,
  lock_owner text not null,
  locked_until timestamptz not null
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null check (actor_type in ('dashboard', 'discord', 'worker', 'system')),
  actor_id text not null,
  action text not null,
  entity_type text not null,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_logs_created_idx on public.audit_logs(created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_app_settings_updated_at before update on public.app_settings
for each row execute function public.set_updated_at();
create trigger set_managers_updated_at before update on public.managers
for each row execute function public.set_updated_at();
create trigger set_teams_updated_at before update on public.teams
for each row execute function public.set_updated_at();
create trigger set_revenue_wallets_updated_at before update on public.revenue_wallets
for each row execute function public.set_updated_at();
create trigger set_domains_updated_at before update on public.domains
for each row execute function public.set_updated_at();
create trigger set_websites_updated_at before update on public.websites
for each row execute function public.set_updated_at();
create trigger set_notification_routes_updated_at before update on public.notification_routes
for each row execute function public.set_updated_at();
create trigger set_website_requests_updated_at before update on public.website_requests
for each row execute function public.set_updated_at();
create trigger set_swap_attempts_updated_at before update on public.swap_attempts
for each row execute function public.set_updated_at();
create trigger set_payout_attempts_updated_at before update on public.payout_attempts
for each row execute function public.set_updated_at();

create or replace function public.claim_chain_events(batch_size integer default 20)
returns setof public.chain_events
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.chain_events
  set status = 'processing',
      attempts = attempts + 1
  where id in (
    select id
    from public.chain_events
    where status = 'pending'
       or (status = 'failed' and attempts < 5)
       or (status = 'processing' and created_at < now() - interval '10 minutes')
    order by created_at
    for update skip locked
    limit greatest(batch_size, 1)
  )
  returning *;
end;
$$;

create or replace function public.acquire_website_lock(
  requested_website_id uuid,
  requested_lock_owner text,
  lease_seconds integer default 120
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.website_processing_locks (website_id, lock_owner, locked_until)
  values (requested_website_id, requested_lock_owner, now() + make_interval(secs => lease_seconds))
  on conflict (website_id) do update
  set lock_owner = excluded.lock_owner,
      locked_until = excluded.locked_until
  where website_processing_locks.locked_until < now()
     or website_processing_locks.lock_owner = requested_lock_owner;

  return exists (
    select 1
    from public.website_processing_locks
    where website_id = requested_website_id
      and lock_owner = requested_lock_owner
      and locked_until > now()
  );
end;
$$;

create or replace function public.release_website_lock(
  requested_website_id uuid,
  requested_lock_owner text
)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.website_processing_locks
  where website_id = requested_website_id
    and lock_owner = requested_lock_owner;
$$;

alter table public.app_settings enable row level security;
alter table public.managers enable row level security;
alter table public.teams enable row level security;
alter table public.team_managers enable row level security;
alter table public.revenue_wallets enable row level security;
alter table public.domains enable row level security;
alter table public.websites enable row level security;
alter table public.notification_routes enable row level security;
alter table public.website_requests enable row level security;
alter table public.wallet_update_history enable row level security;
alter table public.chain_events enable row level security;
alter table public.deposits enable row level security;
alter table public.swap_attempts enable row level security;
alter table public.payout_attempts enable row level security;
alter table public.wallet_balance_snapshots enable row level security;
alter table public.website_processing_locks enable row level security;
alter table public.audit_logs enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
