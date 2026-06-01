create table public.dashboard_network_blocks (
  network_key text primary key,
  latest_ip text not null,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  first_failed_at timestamptz not null default now(),
  blocked_until timestamptz,
  updated_at timestamptz not null default now()
);

create trigger set_dashboard_network_blocks_updated_at before update on public.dashboard_network_blocks
for each row execute function public.set_updated_at();

alter table public.dashboard_network_blocks enable row level security;
revoke all on public.dashboard_network_blocks from anon, authenticated;
grant select on public.dashboard_network_blocks to service_role;

create or replace function public.record_dashboard_login_failure(
  requested_network_key text,
  requested_ip text
)
returns public.dashboard_network_blocks
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.dashboard_network_blocks;
begin
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
          now() + interval '24 hours'
        )
      else blocks.blocked_until
    end
  returning * into result;

  return result;
end;
$$;

create or replace function public.clear_dashboard_login_failures(
  requested_network_key text
)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.dashboard_network_blocks
  where network_key = requested_network_key
    and (blocked_until is null or blocked_until <= now());
$$;

revoke all on function public.record_dashboard_login_failure(text, text) from public, anon, authenticated;
revoke all on function public.clear_dashboard_login_failures(text) from public, anon, authenticated;
grant execute on function public.record_dashboard_login_failure(text, text) to service_role;
grant execute on function public.clear_dashboard_login_failures(text) to service_role;
