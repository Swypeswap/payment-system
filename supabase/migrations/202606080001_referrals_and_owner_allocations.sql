alter table public.owner_profiles
  add column payout_percent numeric(7, 4) not null default 0
  check (payout_percent >= 0 and payout_percent <= 100);

with active_owners as (
  select
    id,
    row_number() over (order by created_at, id) as owner_number,
    count(*) over () as owner_count
  from public.owner_profiles
  where active = true
)
update public.owner_profiles as owner
set payout_percent = case
  when active_owners.owner_count = 1 then 100
  when active_owners.owner_count = 2 then 50
  when active_owners.owner_count = 3 and active_owners.owner_number < 3 then 33
  when active_owners.owner_count = 3 then 34
  when active_owners.owner_number < active_owners.owner_count
    then trunc(100::numeric / active_owners.owner_count, 4)
  else 100 - trunc(100::numeric / active_owners.owner_count, 4) * (active_owners.owner_count - 1)
end
from active_owners
where owner.id = active_owners.id;

do $$
begin
  if (select count(*) from public.owner_profiles where active = true) > 5 then
    raise exception 'Deactivate owners before migrating: no more than five active owner profiles are allowed';
  end if;
end;
$$;

create or replace function public.validate_owner_payout_allocation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  active_owner_count integer;
  active_percentage_total numeric;
begin
  select
    count(*) filter (where active),
    coalesce(sum(payout_percent) filter (where active), 0)
  into active_owner_count, active_percentage_total
  from (
    select
      case when id = new.id then new.active else active end as active,
      case when id = new.id then new.payout_percent else payout_percent end as payout_percent
    from public.owner_profiles
    union all
    select new.active, new.payout_percent
    where tg_op = 'INSERT'
  ) proposed;

  if active_owner_count > 5 then
    raise exception 'No more than five active owner profiles are allowed';
  end if;
  if active_percentage_total > 100 then
    raise exception 'Active owner payout percentages cannot exceed 100%%';
  end if;
  return new;
end;
$$;

create trigger validate_owner_payout_allocation
before insert or update of active, payout_percent on public.owner_profiles
for each row execute function public.validate_owner_payout_allocation();

alter table public.source_performer_snapshots
  add column customer_id text,
  add column referral_code text,
  add column referred_by_performer_id bigint,
  add column referral_code_used text,
  add column referral_commission_pct numeric(7, 4)
    check (referral_commission_pct is null or (referral_commission_pct >= 0 and referral_commission_pct <= 100)),
  add column referrer_username text,
  add column referrer_payout_wallet text,
  add column referrer_approved boolean not null default false,
  add column lifetime_volume_usd numeric(40, 8),
  add column lifetime_connects bigint,
  add column lifetime_hits bigint;

alter table public.external_revenue_split_attempts
  add column company_pct numeric(7, 4) not null default 25
    check (company_pct >= 0 and company_pct <= 100),
  add column referrer_telegram_user_id bigint,
  add column referrer_wallet_address text,
  add column referral_pct numeric(7, 4)
    check (referral_pct is null or (referral_pct >= 0 and referral_pct <= 100)),
  add column referrer_lamports numeric(40, 0) not null default 0
    check (referrer_lamports >= 0),
  add constraint external_revenue_split_referral_consistency check (
    (
      referrer_telegram_user_id is null
      and referrer_wallet_address is null
      and referral_pct is null
      and referrer_lamports = 0
    )
    or
    (
      referrer_telegram_user_id is not null
      and referrer_wallet_address is not null
      and referral_pct is not null
      and referrer_lamports > 0
    )
  );

alter table public.company_privacy_cash_payout_batches
  drop constraint if exists company_privacy_cash_payout_batches_owner_wallet_addresses_check,
  add constraint company_privacy_cash_payout_batches_owner_wallet_addresses_check
    check (cardinality(owner_wallet_addresses) between 2 and 5);

alter table public.company_privacy_cash_withdrawal_jobs
  drop constraint if exists company_privacy_cash_withdrawal_jobs_recipient_kind_check,
  add constraint company_privacy_cash_withdrawal_jobs_recipient_kind_check
    check (recipient_kind in ('owner_1', 'owner_2', 'owner_3', 'owner_4', 'owner_5'));

alter table public.privacy_cash_payout_batches
  drop constraint if exists privacy_cash_payout_batches_owner_wallet_addresses_check,
  add constraint privacy_cash_payout_batches_owner_wallet_addresses_check
    check (cardinality(owner_wallet_addresses) between 2 and 5);

alter table public.privacy_cash_withdrawal_jobs
  drop constraint if exists privacy_cash_withdrawal_jobs_recipient_kind_check,
  add constraint privacy_cash_withdrawal_jobs_recipient_kind_check
    check (recipient_kind in ('owner_1', 'owner_2', 'owner_3', 'owner_4', 'owner_5', 'manager'));
