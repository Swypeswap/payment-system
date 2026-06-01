create table public.security_recovery_tokens (
  id uuid primary key default gen_random_uuid(),
  action text not null check (action in ('network_unblock', 'frontend_unlock')),
  network_key text,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (
    (action = 'network_unblock' and network_key is not null and expires_at is not null)
    or
    (action = 'frontend_unlock' and network_key is null)
  )
);

create unique index security_recovery_tokens_active_network_idx
on public.security_recovery_tokens(network_key)
where action = 'network_unblock' and consumed_at is null;

create unique index security_recovery_tokens_active_frontend_idx
on public.security_recovery_tokens(action)
where action = 'frontend_unlock' and consumed_at is null;

create table public.frontend_lockdown_state (
  id boolean primary key default true check (id),
  active boolean not null default false,
  reason text,
  activated_by text,
  activated_at timestamptz,
  unlocked_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.frontend_lockdown_state (id) values (true);

create trigger set_frontend_lockdown_state_updated_at before update on public.frontend_lockdown_state
for each row execute function public.set_updated_at();

alter table public.security_recovery_tokens enable row level security;
alter table public.frontend_lockdown_state enable row level security;
revoke all on public.security_recovery_tokens from anon, authenticated;
revoke all on public.frontend_lockdown_state from anon, authenticated;
grant select on public.frontend_lockdown_state to service_role;

create or replace function public.record_dashboard_login_failure(
  requested_network_key text,
  requested_ip text,
  requested_block_seconds integer
)
returns public.dashboard_network_blocks
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.dashboard_network_blocks;
begin
  if requested_block_seconds < 345600 or requested_block_seconds > 3024000 then
    raise exception 'Dashboard login block duration is outside the permitted range';
  end if;

  insert into public.dashboard_network_blocks as blocks (
    network_key,
    latest_ip,
    failed_attempts,
    first_failed_at,
    blocked_until
  )
  values (
    requested_network_key,
    requested_ip,
    1,
    now(),
    null
  )
  on conflict (network_key) do update set
    latest_ip = excluded.latest_ip,
    failed_attempts = case
      when blocks.first_failed_at < now() - interval '15 minutes' then 1
      else blocks.failed_attempts + 1
    end,
    first_failed_at = case
      when blocks.first_failed_at < now() - interval '15 minutes' then now()
      else blocks.first_failed_at
    end,
    blocked_until = case
      when (
        case
          when blocks.first_failed_at < now() - interval '15 minutes' then 1
          else blocks.failed_attempts + 1
        end
      ) >= 2
        then greatest(
          coalesce(blocks.blocked_until, '-infinity'::timestamptz),
          now() + make_interval(secs => requested_block_seconds)
        )
      else case
        when blocks.blocked_until is not null and blocks.blocked_until <= now() then null
        else blocks.blocked_until
      end
    end
  returning * into result;

  return result;
end;
$$;

create or replace function public.issue_security_recovery_token(
  requested_action text,
  requested_network_key text,
  requested_token_hash text,
  requested_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_id uuid;
begin
  delete from public.security_recovery_tokens
  where consumed_at is null
    and expires_at is not null
    and expires_at <= now();

  insert into public.security_recovery_tokens (
    action,
    network_key,
    token_hash,
    expires_at
  )
  values (
    requested_action,
    requested_network_key,
    requested_token_hash,
    requested_expires_at
  )
  on conflict do nothing
  returning id into inserted_id;

  return inserted_id is not null;
end;
$$;

create or replace function public.activate_frontend_lockdown(
  requested_reason text,
  requested_actor text,
  requested_token_hash text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  was_activated boolean;
begin
  update public.frontend_lockdown_state
  set
    active = true,
    reason = requested_reason,
    activated_by = requested_actor,
    activated_at = now(),
    unlocked_at = null
  where id = true and active = false
  returning true into was_activated;

  if coalesce(was_activated, false) then
    insert into public.security_recovery_tokens (
      action,
      network_key,
      token_hash,
      expires_at
    )
    values (
      'frontend_unlock',
      null,
      requested_token_hash,
      null
    );
  end if;

  return coalesce(was_activated, false);
end;
$$;

create or replace function public.redeem_security_recovery_token(
  requested_token_hash text
)
returns table (
  redeemed_action text,
  redeemed_network_key text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  token public.security_recovery_tokens;
begin
  select *
  into token
  from public.security_recovery_tokens
  where token_hash = requested_token_hash
    and consumed_at is null
    and (expires_at is null or expires_at > now())
  for update;

  if token.id is null then
    raise exception 'Invalid, expired, or already-used recovery code';
  end if;

  update public.security_recovery_tokens
  set consumed_at = now()
  where id = token.id;

  if token.action = 'network_unblock' then
    delete from public.dashboard_network_blocks
    where network_key = token.network_key;
  elsif token.action = 'frontend_unlock' then
    update public.frontend_lockdown_state
    set
      active = false,
      unlocked_at = now()
    where id = true;
  end if;

  return query select token.action, token.network_key;
end;
$$;

revoke all on function public.record_dashboard_login_failure(text, text) from public, anon, authenticated;
revoke all on function public.record_dashboard_login_failure(text, text, integer) from public, anon, authenticated;
revoke all on function public.issue_security_recovery_token(text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.activate_frontend_lockdown(text, text, text) from public, anon, authenticated;
revoke all on function public.redeem_security_recovery_token(text) from public, anon, authenticated;
grant execute on function public.record_dashboard_login_failure(text, text, integer) to service_role;
grant execute on function public.issue_security_recovery_token(text, text, text, timestamptz) to service_role;
grant execute on function public.activate_frontend_lockdown(text, text, text) to service_role;
grant execute on function public.redeem_security_recovery_token(text) to service_role;

drop function public.record_dashboard_login_failure(text, text);
