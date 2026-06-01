alter table public.audit_logs drop constraint audit_logs_actor_type_check;
alter table public.audit_logs
  add constraint audit_logs_actor_type_check
  check (actor_type in ('dashboard', 'discord', 'worker', 'system', 'security'));

alter table public.wallet_balance_snapshots
  add column sol_usd_price numeric(40, 8),
  add column estimated_sol_value_usd numeric(40, 8);

create table public.dashboard_session_control (
  id boolean primary key default true check (id),
  generation bigint not null default 1 check (generation > 0),
  updated_at timestamptz not null default now()
);

insert into public.dashboard_session_control (id) values (true);

create table public.dashboard_sessions (
  id uuid primary key,
  generation bigint not null check (generation > 0),
  ip_address text not null,
  network_key text not null,
  device text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index dashboard_sessions_active_idx
on public.dashboard_sessions(revoked_at, expires_at desc);

create table public.worker_heartbeats (
  worker_id text primary key,
  started_at timestamptz not null,
  last_seen_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb
);

create table public.manual_reconciliation_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by text not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'succeeded', 'failed')),
  claimed_by text,
  error text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create trigger set_dashboard_session_control_updated_at before update on public.dashboard_session_control
for each row execute function public.set_updated_at();

create trigger set_manual_reconciliation_requests_updated_at before update on public.manual_reconciliation_requests
for each row execute function public.set_updated_at();

create or replace function public.claim_manual_reconciliation_request(
  requested_worker_id text
)
returns setof public.manual_reconciliation_requests
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.manual_reconciliation_requests
  set
    status = 'processing',
    claimed_by = requested_worker_id,
    claimed_at = now(),
    error = null
  where id = (
    select id
    from public.manual_reconciliation_requests
    where status = 'pending'
       or (status = 'processing' and claimed_at < now() - interval '15 minutes')
    order by created_at
    for update skip locked
    limit 1
  )
  returning *;
end;
$$;

create or replace function public.revoke_all_dashboard_sessions()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.dashboard_session_control
  set generation = generation + 1
  where id = true;

  update public.dashboard_sessions
  set revoked_at = now()
  where revoked_at is null;
end;
$$;

alter table public.dashboard_session_control enable row level security;
alter table public.dashboard_sessions enable row level security;
alter table public.worker_heartbeats enable row level security;
alter table public.manual_reconciliation_requests enable row level security;

revoke all on public.dashboard_session_control from anon, authenticated;
revoke all on public.dashboard_sessions from anon, authenticated;
revoke all on public.worker_heartbeats from anon, authenticated;
revoke all on public.manual_reconciliation_requests from anon, authenticated;
revoke all on function public.claim_manual_reconciliation_request(text) from public, anon, authenticated;
revoke all on function public.revoke_all_dashboard_sessions() from public, anon, authenticated;
grant execute on function public.claim_manual_reconciliation_request(text) to service_role;
grant execute on function public.revoke_all_dashboard_sessions() to service_role;
