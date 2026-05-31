alter table public.app_settings
  add column privacy_cash_enabled boolean not null default false,
  add column privacy_min_delay_hours integer not null default 24 check (privacy_min_delay_hours >= 24),
  add column privacy_max_delay_hours integer not null default 72,
  add column owners_discord_guild_id text check (owners_discord_guild_id is null or owners_discord_guild_id ~ '^[0-9]{15,22}$'),
  add column owners_notifications_channel_id text check (owners_notifications_channel_id is null or owners_notifications_channel_id ~ '^[0-9]{15,22}$'),
  add column rotation_warn_after_days integer not null default 14 check (rotation_warn_after_days > 0),
  add column rotation_warn_after_legs integer not null default 6 check (rotation_warn_after_legs > 0),
  add column rotation_warn_after_usd numeric(18, 2) not null default 7500 check (rotation_warn_after_usd > 0),
  add column rotation_warn_after_weekly_legs integer not null default 4 check (rotation_warn_after_weekly_legs > 0),
  add constraint app_settings_privacy_delay_range check (privacy_max_delay_hours >= privacy_min_delay_hours);

alter table public.websites alter column company_wallet_address drop not null;
alter table public.teams add column manager_wallet_updated_at timestamptz;

create table public.owner_profiles (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (length(trim(display_name)) > 0),
  discord_user_id text not null unique check (discord_user_id ~ '^[0-9]{15,22}$'),
  discord_username text,
  solana_wallet_address text,
  active boolean not null default true,
  wallet_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.owner_wallet_update_history (
  id uuid primary key default gen_random_uuid(),
  owner_profile_id uuid not null references public.owner_profiles(id),
  old_wallet_address text,
  new_wallet_address text not null,
  actor_id text not null,
  created_at timestamptz not null default now()
);

create table public.manager_wallet_change_requests (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  old_wallet_address text,
  new_wallet_address text not null,
  requested_by_actor_type text not null check (requested_by_actor_type in ('dashboard', 'discord')),
  requested_by_actor_id text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by_owner_profile_id uuid references public.owner_profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index manager_wallet_change_requests_one_pending_per_team
on public.manager_wallet_change_requests(team_id)
where status = 'pending';

create table public.privacy_cash_shield_jobs (
  id uuid primary key default gen_random_uuid(),
  website_id uuid not null references public.websites(id),
  revenue_wallet_id uuid not null references public.revenue_wallets(id),
  idempotency_key text not null unique,
  asset_key text not null check (asset_key = 'sol'),
  source_balance_raw numeric(40, 0) not null check (source_balance_raw >= 0),
  reserve_raw numeric(40, 0) not null check (reserve_raw >= 0),
  shield_raw numeric(40, 0) not null check (shield_raw > 0),
  private_balance_before_raw numeric(40, 0),
  signature text unique,
  status text not null check (status in ('dry_run', 'pending', 'processing', 'succeeded', 'review_required')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.privacy_cash_payout_batches (
  id uuid primary key default gen_random_uuid(),
  shield_job_id uuid not null unique references public.privacy_cash_shield_jobs(id),
  website_id uuid not null references public.websites(id),
  revenue_wallet_id uuid not null references public.revenue_wallets(id),
  team_id uuid not null references public.teams(id),
  asset_key text not null check (asset_key = 'sol'),
  manager_wallet_address text not null,
  owner_wallet_addresses text[] not null check (cardinality(owner_wallet_addresses) = 3),
  shield_raw numeric(40, 0) not null check (shield_raw > 0),
  net_distribution_raw numeric(40, 0) not null check (net_distribution_raw > 0),
  estimated_fee_raw numeric(40, 0) not null check (estimated_fee_raw >= 0),
  dust_raw numeric(40, 0) not null check (dust_raw >= 0),
  status text not null check (status in ('dry_run', 'pending', 'processing', 'succeeded', 'review_required')),
  notification_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.privacy_cash_withdrawal_jobs (
  id uuid primary key default gen_random_uuid(),
  payout_batch_id uuid not null references public.privacy_cash_payout_batches(id) on delete cascade,
  website_id uuid not null references public.websites(id),
  team_id uuid not null references public.teams(id),
  asset_key text not null check (asset_key = 'sol'),
  recipient_kind text not null check (recipient_kind in ('owner_1', 'owner_2', 'owner_3', 'manager')),
  recipient_key text not null,
  owner_profile_id uuid references public.owner_profiles(id),
  leg_index integer not null check (leg_index >= 0 and leg_index < 4),
  recipient_wallet_address text not null,
  net_raw numeric(40, 0) not null check (net_raw > 0),
  gross_raw numeric(40, 0) not null check (gross_raw >= net_raw),
  estimated_fee_raw numeric(40, 0) not null check (estimated_fee_raw >= 0),
  actual_net_raw numeric(40, 0),
  actual_fee_raw numeric(40, 0),
  estimated_usd numeric(40, 8),
  signature text unique,
  scheduled_for timestamptz not null,
  status text not null check (status in ('dry_run', 'pending', 'processing', 'succeeded', 'review_required')),
  attempts integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (payout_batch_id, recipient_key, leg_index)
);

create index privacy_cash_withdrawal_jobs_due_idx
on public.privacy_cash_withdrawal_jobs(status, scheduled_for);

create table public.wallet_rotation_notifications (
  id uuid primary key default gen_random_uuid(),
  wallet_kind text not null check (wallet_kind in ('owner', 'manager')),
  owner_profile_id uuid references public.owner_profiles(id),
  team_id uuid references public.teams(id),
  wallet_address text not null,
  reason_key text not null,
  created_at timestamptz not null default now(),
  unique nulls not distinct (wallet_kind, owner_profile_id, team_id, wallet_address, reason_key)
);

create table public.privacy_cash_worker_locks (
  name text primary key,
  lock_owner text not null,
  locked_until timestamptz not null
);

create trigger set_owner_profiles_updated_at before update on public.owner_profiles
for each row execute function public.set_updated_at();

create or replace function public.prevent_owner_discord_id_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.discord_user_id <> old.discord_user_id then
    raise exception 'Owner Discord user IDs are immutable';
  end if;
  return new;
end;
$$;

create trigger prevent_owner_discord_id_change before update on public.owner_profiles
for each row execute function public.prevent_owner_discord_id_change();

create trigger set_manager_wallet_change_requests_updated_at before update on public.manager_wallet_change_requests
for each row execute function public.set_updated_at();
create trigger set_privacy_cash_shield_jobs_updated_at before update on public.privacy_cash_shield_jobs
for each row execute function public.set_updated_at();
create trigger set_privacy_cash_payout_batches_updated_at before update on public.privacy_cash_payout_batches
for each row execute function public.set_updated_at();
create trigger set_privacy_cash_withdrawal_jobs_updated_at before update on public.privacy_cash_withdrawal_jobs
for each row execute function public.set_updated_at();

create or replace function public.acquire_privacy_cash_worker_lock(
  requested_lock_owner text,
  lease_seconds integer default 900
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.privacy_cash_worker_locks (name, lock_owner, locked_until)
  values ('privacy-cash', requested_lock_owner, now() + make_interval(secs => lease_seconds))
  on conflict (name) do update
  set lock_owner = excluded.lock_owner,
      locked_until = excluded.locked_until
  where privacy_cash_worker_locks.locked_until < now()
     or privacy_cash_worker_locks.lock_owner = requested_lock_owner;

  return exists (
    select 1
    from public.privacy_cash_worker_locks
    where name = 'privacy-cash'
      and lock_owner = requested_lock_owner
      and locked_until > now()
  );
end;
$$;

create or replace function public.release_privacy_cash_worker_lock(
  requested_lock_owner text
)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.privacy_cash_worker_locks
  where name = 'privacy-cash'
    and lock_owner = requested_lock_owner;
$$;

create or replace function public.claim_privacy_cash_withdrawal_jobs(batch_size integer default 4)
returns setof public.privacy_cash_withdrawal_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.privacy_cash_withdrawal_jobs
  set status = 'processing',
      attempts = attempts + 1
  where id in (
    select id
    from public.privacy_cash_withdrawal_jobs
    where status = 'pending'
      and scheduled_for <= now()
    order by scheduled_for
    for update skip locked
    limit greatest(batch_size, 1)
  )
  returning *;
end;
$$;

alter table public.owner_profiles enable row level security;
alter table public.owner_wallet_update_history enable row level security;
alter table public.manager_wallet_change_requests enable row level security;
alter table public.privacy_cash_shield_jobs enable row level security;
alter table public.privacy_cash_payout_batches enable row level security;
alter table public.privacy_cash_withdrawal_jobs enable row level security;
alter table public.wallet_rotation_notifications enable row level security;
alter table public.privacy_cash_worker_locks enable row level security;

revoke all on public.owner_profiles from anon, authenticated;
revoke all on public.owner_wallet_update_history from anon, authenticated;
revoke all on public.manager_wallet_change_requests from anon, authenticated;
revoke all on public.privacy_cash_shield_jobs from anon, authenticated;
revoke all on public.privacy_cash_payout_batches from anon, authenticated;
revoke all on public.privacy_cash_withdrawal_jobs from anon, authenticated;
revoke all on public.wallet_rotation_notifications from anon, authenticated;
revoke all on public.privacy_cash_worker_locks from anon, authenticated;

revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function public.claim_chain_events(integer) to service_role;
grant execute on function public.acquire_website_lock(uuid, text, integer) to service_role;
grant execute on function public.release_website_lock(uuid, text) to service_role;
grant execute on function public.acquire_privacy_cash_worker_lock(text, integer) to service_role;
grant execute on function public.release_privacy_cash_worker_lock(text) to service_role;
grant execute on function public.claim_privacy_cash_withdrawal_jobs(integer) to service_role;
