create table public.wallet_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  color_label text not null default '#64f5b5' check (color_label ~ '^#[0-9A-Fa-f]{6}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index wallet_groups_name_ci on public.wallet_groups(lower(name));

alter table public.revenue_wallets
  add column wallet_group_id uuid references public.wallet_groups(id) on delete set null,
  add column color_label text not null default '#64f5b5' check (color_label ~ '^#[0-9A-Fa-f]{6}$');

create trigger set_wallet_groups_updated_at before update on public.wallet_groups
for each row execute function public.set_updated_at();

alter table public.wallet_groups enable row level security;
revoke all on public.wallet_groups from anon, authenticated;
