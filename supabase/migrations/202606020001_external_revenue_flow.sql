alter table public.app_settings
  add column company_privacy_cash_threshold_usd numeric(18, 2) not null default 100 check (company_privacy_cash_threshold_usd > 0),
  add column revenue_wallet_sol_reserve numeric(18, 9) not null default 0.005 check (revenue_wallet_sol_reserve >= 0),
  add column revenue_dust_threshold_usd numeric(18, 2) not null default 10 check (revenue_dust_threshold_usd >= 0),
  add column company_wallet_sol_reserve numeric(18, 9) not null default 0.005 check (company_wallet_sol_reserve >= 0),
  add column company_rotation_long_days integer not null default 30 check (company_rotation_long_days > 0),
  add column company_rotation_high_volume_usd numeric(18, 2) not null default 100000 check (company_rotation_high_volume_usd > 0),
  add column company_rotation_short_days integer not null default 7 check (company_rotation_short_days > 0),
  add column company_rotation_lower_volume_usd numeric(18, 2) not null default 25000 check (company_rotation_lower_volume_usd > 0),
  add column source_sync_enabled boolean not null default false;

alter table public.notification_routes
  drop constraint notification_routes_kind_check;

alter table public.notification_routes
  add constraint notification_routes_kind_check check (kind in (
    'website_request',
    'website_activation',
    'deposit',
    'payout',
    'security_alert',
    'worker_error',
    'revenue_deposit_received',
    'revenue_swap_completed',
    'revenue_split_completed',
    'unsafe_spl_detected',
    'awaiting_sol_for_fees',
    'performer_configuration_invalid',
    'swap_failed',
    'company_threshold_reached',
    'company_privacy_cash_deposited',
    'company_privacy_cash_payout_released',
    'company_wallet_rotation_due',
    'company_wallet_rotated',
    'company_wallet_generation_failed',
    'retired_revenue_wallet_deletion_due',
    'retired_revenue_wallet_deleted',
    'retired_revenue_wallet_deletion_expired',
    'erased_revenue_wallet_received_funds',
    'archived_company_wallet_deletion_due',
    'archived_company_wallet_deleted',
    'archived_company_wallet_deletion_expired'
  ));

alter table public.notification_routes
  add column mention_everyone boolean not null default false;

create table public.source_performer_snapshots (
  telegram_user_id bigint primary key,
  telegram_username text,
  payout_wallet text,
  commission_pct numeric(7, 4) check (commission_pct is null or (commission_pct >= 0 and commission_pct <= 100)),
  approved boolean not null default false,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now()
);

create table public.external_revenue_wallets (
  id uuid primary key default gen_random_uuid(),
  external_site_id uuid not null unique,
  domain text not null,
  address text not null unique,
  encrypted_private_key_blob text,
  external_status text not null,
  mirror_status text not null default 'active' check (mirror_status in ('active', 'retired', 'key_erased')),
  external_performer_id bigint,
  source_created_at timestamptz not null,
  source_updated_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  retired_at timestamptz,
  empty_since timestamptz,
  key_erased_at timestamptz,
  current_sol_lamports numeric(40, 0) not null default 0 check (current_sol_lamports >= 0),
  current_token_balances jsonb not null default '[]'::jsonb,
  last_balance_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (mirror_status = 'active' and retired_at is null and key_erased_at is null)
    or (mirror_status = 'retired' and retired_at is not null and key_erased_at is null)
    or (mirror_status = 'key_erased' and retired_at is not null and key_erased_at is not null and encrypted_private_key_blob is null)
  )
);

create index external_revenue_wallets_monitor_idx
on public.external_revenue_wallets(mirror_status, updated_at);

create table public.company_wallets (
  id uuid primary key default gen_random_uuid(),
  address text not null unique,
  encrypted_private_key text,
  encryption_nonce text,
  encryption_auth_tag text,
  encryption_key_version integer check (encryption_key_version is null or encryption_key_version > 0),
  status text not null check (status in ('active', 'archived', 'key_erased')),
  activated_at timestamptz not null default now(),
  archived_at timestamptz,
  empty_since timestamptz,
  key_erased_at timestamptz,
  received_volume_usd numeric(40, 8) not null default 0 check (received_volume_usd >= 0),
  current_sol_lamports numeric(40, 0) not null default 0 check (current_sol_lamports >= 0),
  current_token_balances jsonb not null default '[]'::jsonb,
  last_balance_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'active' and archived_at is null and key_erased_at is null)
    or (status = 'archived' and archived_at is not null and key_erased_at is null)
    or (status = 'key_erased' and archived_at is not null and key_erased_at is not null and encrypted_private_key is null and encryption_nonce is null and encryption_auth_tag is null)
  )
);

create unique index company_wallets_one_active
on public.company_wallets(status)
where status = 'active';

create table public.external_revenue_balance_snapshots (
  id uuid primary key default gen_random_uuid(),
  external_revenue_wallet_id uuid not null references public.external_revenue_wallets(id),
  sol_lamports numeric(40, 0) not null check (sol_lamports >= 0),
  token_balances jsonb not null default '[]'::jsonb,
  sol_usd_price numeric(40, 8),
  estimated_sol_value_usd numeric(40, 8),
  created_at timestamptz not null default now()
);

create table public.external_revenue_deposits (
  id uuid primary key default gen_random_uuid(),
  chain_event_id uuid references public.chain_events(id),
  external_revenue_wallet_id uuid not null references public.external_revenue_wallets(id),
  signature text not null,
  assets jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (signature, external_revenue_wallet_id)
);

create table public.external_revenue_swap_attempts (
  id uuid primary key default gen_random_uuid(),
  external_revenue_wallet_id uuid not null references public.external_revenue_wallets(id),
  input_mint text not null,
  input_amount_raw numeric(40, 0) not null check (input_amount_raw > 0),
  estimated_usd_value numeric(40, 8),
  estimated_output_lamports numeric(40, 0),
  actual_output_lamports numeric(40, 0),
  status text not null check (status in ('waiting', 'skipped', 'review_required', 'submitted', 'succeeded', 'failed')),
  reason text,
  signature text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.external_revenue_split_attempts (
  id uuid primary key default gen_random_uuid(),
  external_revenue_wallet_id uuid not null references public.external_revenue_wallets(id),
  company_wallet_id uuid not null references public.company_wallets(id),
  idempotency_key text not null unique,
  performer_telegram_user_id bigint not null,
  performer_wallet_address text not null,
  commission_pct numeric(7, 4) not null check (commission_pct >= 0 and commission_pct <= 100),
  source_balance_lamports numeric(40, 0) not null check (source_balance_lamports >= 0),
  reserve_lamports numeric(40, 0) not null check (reserve_lamports >= 0),
  fee_lamports numeric(40, 0) not null check (fee_lamports >= 0),
  performer_lamports numeric(40, 0) not null check (performer_lamports >= 0),
  company_lamports numeric(40, 0) not null check (company_lamports >= 0),
  estimated_company_usd numeric(40, 8),
  signature text unique,
  raw_transaction_base64 text,
  last_valid_block_height numeric(40, 0),
  status text not null check (status in ('dry_run', 'submitted', 'succeeded', 'failed', 'expired', 'review_required')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.company_wallet_receipts (
  id uuid primary key default gen_random_uuid(),
  company_wallet_id uuid not null references public.company_wallets(id),
  external_revenue_split_attempt_id uuid not null unique references public.external_revenue_split_attempts(id),
  amount_lamports numeric(40, 0) not null check (amount_lamports > 0),
  estimated_usd numeric(40, 8),
  created_at timestamptz not null default now()
);

create table public.review_required_items (
  id uuid primary key default gen_random_uuid(),
  reason_key text not null,
  wallet_kind text not null check (wallet_kind in ('external_revenue', 'company')),
  external_revenue_wallet_id uuid references public.external_revenue_wallets(id),
  company_wallet_id uuid references public.company_wallets(id),
  severity text not null default 'warning' check (severity in ('warning', 'high', 'critical')),
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'resolved')),
  notified_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (wallet_kind = 'external_revenue' and external_revenue_wallet_id is not null and company_wallet_id is null)
    or (wallet_kind = 'company' and external_revenue_wallet_id is null and company_wallet_id is not null)
  )
);

create unique index review_required_items_one_open_reason
on public.review_required_items(reason_key, wallet_kind, coalesce(external_revenue_wallet_id, company_wallet_id))
where status = 'open';

create table public.wallet_lifecycle_requests (
  id uuid primary key default gen_random_uuid(),
  action text not null check (action in ('company_rotation', 'revenue_key_erasure', 'company_key_erasure')),
  external_revenue_wallet_id uuid references public.external_revenue_wallets(id),
  company_wallet_id uuid references public.company_wallets(id),
  action_token_hash text not null unique check (action_token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'claimed', 'completed', 'expired', 'cancelled', 'failed')),
  expires_at timestamptz,
  claimed_by_owner_profile_id uuid references public.owner_profiles(id),
  claimed_at timestamptz,
  completed_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (action = 'company_rotation' and external_revenue_wallet_id is null and company_wallet_id is not null)
    or (action = 'revenue_key_erasure' and external_revenue_wallet_id is not null and company_wallet_id is null and expires_at is not null)
    or (action = 'company_key_erasure' and external_revenue_wallet_id is null and company_wallet_id is not null and expires_at is not null)
  )
);

create unique index wallet_lifecycle_requests_one_pending_action
on public.wallet_lifecycle_requests(action, coalesce(external_revenue_wallet_id, company_wallet_id))
where status = 'pending';

create table public.company_privacy_cash_shield_jobs (
  id uuid primary key default gen_random_uuid(),
  company_wallet_id uuid not null references public.company_wallets(id),
  idempotency_key text not null unique,
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

create table public.company_privacy_cash_payout_batches (
  id uuid primary key default gen_random_uuid(),
  shield_job_id uuid not null unique references public.company_privacy_cash_shield_jobs(id),
  company_wallet_id uuid not null references public.company_wallets(id),
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

create table public.company_privacy_cash_withdrawal_jobs (
  id uuid primary key default gen_random_uuid(),
  payout_batch_id uuid not null references public.company_privacy_cash_payout_batches(id) on delete cascade,
  company_wallet_id uuid not null references public.company_wallets(id),
  recipient_kind text not null check (recipient_kind in ('owner_1', 'owner_2', 'owner_3')),
  recipient_key text not null,
  owner_profile_id uuid not null references public.owner_profiles(id),
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

create index company_privacy_cash_withdrawal_jobs_due_idx
on public.company_privacy_cash_withdrawal_jobs(status, scheduled_for);

create table public.external_revenue_wallet_locks (
  external_revenue_wallet_id uuid primary key references public.external_revenue_wallets(id) on delete cascade,
  lock_owner text not null,
  locked_until timestamptz not null
);

create trigger set_external_revenue_wallets_updated_at before update on public.external_revenue_wallets
for each row execute function public.set_updated_at();
create trigger set_company_wallets_updated_at before update on public.company_wallets
for each row execute function public.set_updated_at();
create trigger set_external_revenue_swap_attempts_updated_at before update on public.external_revenue_swap_attempts
for each row execute function public.set_updated_at();
create trigger set_external_revenue_split_attempts_updated_at before update on public.external_revenue_split_attempts
for each row execute function public.set_updated_at();
create trigger set_review_required_items_updated_at before update on public.review_required_items
for each row execute function public.set_updated_at();
create trigger set_wallet_lifecycle_requests_updated_at before update on public.wallet_lifecycle_requests
for each row execute function public.set_updated_at();
create trigger set_company_privacy_cash_shield_jobs_updated_at before update on public.company_privacy_cash_shield_jobs
for each row execute function public.set_updated_at();
create trigger set_company_privacy_cash_payout_batches_updated_at before update on public.company_privacy_cash_payout_batches
for each row execute function public.set_updated_at();
create trigger set_company_privacy_cash_withdrawal_jobs_updated_at before update on public.company_privacy_cash_withdrawal_jobs
for each row execute function public.set_updated_at();

create or replace function public.acquire_external_revenue_wallet_lock(
  requested_wallet_id uuid,
  requested_lock_owner text,
  lease_seconds integer default 180
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.external_revenue_wallet_locks (external_revenue_wallet_id, lock_owner, locked_until)
  values (requested_wallet_id, requested_lock_owner, now() + make_interval(secs => lease_seconds))
  on conflict (external_revenue_wallet_id) do update
  set lock_owner = excluded.lock_owner,
      locked_until = excluded.locked_until
  where external_revenue_wallet_locks.locked_until < now()
     or external_revenue_wallet_locks.lock_owner = requested_lock_owner;

  return exists (
    select 1
    from public.external_revenue_wallet_locks
    where external_revenue_wallet_id = requested_wallet_id
      and lock_owner = requested_lock_owner
      and locked_until > now()
  );
end;
$$;

create or replace function public.release_external_revenue_wallet_lock(
  requested_wallet_id uuid,
  requested_lock_owner text
)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.external_revenue_wallet_locks
  where external_revenue_wallet_id = requested_wallet_id
    and lock_owner = requested_lock_owner;
$$;

create or replace function public.claim_company_privacy_cash_withdrawal_jobs(batch_size integer default 4)
returns setof public.company_privacy_cash_withdrawal_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.company_privacy_cash_withdrawal_jobs
  set status = 'processing',
      attempts = attempts + 1
  where id in (
    select id
    from public.company_privacy_cash_withdrawal_jobs
    where status = 'pending'
      and scheduled_for <= now()
    order by scheduled_for
    for update skip locked
    limit greatest(batch_size, 1)
  )
  returning *;
end;
$$;

create or replace function public.claim_wallet_lifecycle_request(
  requested_token_hash text,
  requested_owner_profile_id uuid
)
returns public.wallet_lifecycle_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.wallet_lifecycle_requests;
begin
  update public.wallet_lifecycle_requests
  set
    status = 'claimed',
    claimed_by_owner_profile_id = requested_owner_profile_id,
    claimed_at = now()
  where action_token_hash = requested_token_hash
    and status = 'pending'
    and (expires_at is null or expires_at > now())
  returning * into result;

  if result.id is null then
    raise exception 'This action request is invalid, expired, or already claimed';
  end if;

  return result;
end;
$$;

create or replace function public.rotate_company_wallet(
  requested_old_wallet_id uuid,
  generated_address text,
  generated_encrypted_private_key text,
  generated_encryption_nonce text,
  generated_encryption_auth_tag text,
  generated_encryption_key_version integer
)
returns public.company_wallets
language plpgsql
security definer
set search_path = public
as $$
declare
  old_wallet public.company_wallets;
  new_wallet public.company_wallets;
begin
  update public.company_wallets
  set status = 'archived',
      archived_at = now()
  where id = requested_old_wallet_id
    and status = 'active'
  returning * into old_wallet;

  if old_wallet.id is null then
    raise exception 'The original company wallet is no longer active';
  end if;

  insert into public.company_wallets (
    address,
    encrypted_private_key,
    encryption_nonce,
    encryption_auth_tag,
    encryption_key_version,
    status
  ) values (
    generated_address,
    generated_encrypted_private_key,
    generated_encryption_nonce,
    generated_encryption_auth_tag,
    generated_encryption_key_version,
    'active'
  )
  returning * into new_wallet;

  return new_wallet;
end;
$$;

alter table public.source_performer_snapshots enable row level security;
alter table public.external_revenue_wallets enable row level security;
alter table public.company_wallets enable row level security;
alter table public.external_revenue_balance_snapshots enable row level security;
alter table public.external_revenue_deposits enable row level security;
alter table public.external_revenue_swap_attempts enable row level security;
alter table public.external_revenue_split_attempts enable row level security;
alter table public.company_wallet_receipts enable row level security;
alter table public.review_required_items enable row level security;
alter table public.wallet_lifecycle_requests enable row level security;
alter table public.company_privacy_cash_shield_jobs enable row level security;
alter table public.company_privacy_cash_payout_batches enable row level security;
alter table public.company_privacy_cash_withdrawal_jobs enable row level security;
alter table public.external_revenue_wallet_locks enable row level security;

revoke all on public.source_performer_snapshots from anon, authenticated;
revoke all on public.external_revenue_wallets from anon, authenticated;
revoke all on public.company_wallets from anon, authenticated;
revoke all on public.external_revenue_balance_snapshots from anon, authenticated;
revoke all on public.external_revenue_deposits from anon, authenticated;
revoke all on public.external_revenue_swap_attempts from anon, authenticated;
revoke all on public.external_revenue_split_attempts from anon, authenticated;
revoke all on public.company_wallet_receipts from anon, authenticated;
revoke all on public.review_required_items from anon, authenticated;
revoke all on public.wallet_lifecycle_requests from anon, authenticated;
revoke all on public.company_privacy_cash_shield_jobs from anon, authenticated;
revoke all on public.company_privacy_cash_payout_batches from anon, authenticated;
revoke all on public.company_privacy_cash_withdrawal_jobs from anon, authenticated;
revoke all on public.external_revenue_wallet_locks from anon, authenticated;

revoke all on function public.acquire_external_revenue_wallet_lock(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.release_external_revenue_wallet_lock(uuid, text) from public, anon, authenticated;
revoke all on function public.claim_company_privacy_cash_withdrawal_jobs(integer) from public, anon, authenticated;
revoke all on function public.claim_wallet_lifecycle_request(text, uuid) from public, anon, authenticated;
revoke all on function public.rotate_company_wallet(uuid, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.acquire_external_revenue_wallet_lock(uuid, text, integer) to service_role;
grant execute on function public.release_external_revenue_wallet_lock(uuid, text) to service_role;
grant execute on function public.claim_company_privacy_cash_withdrawal_jobs(integer) to service_role;
grant execute on function public.claim_wallet_lifecycle_request(text, uuid) to service_role;
grant execute on function public.rotate_company_wallet(uuid, text, text, text, text, integer) to service_role;
