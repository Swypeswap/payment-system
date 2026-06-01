create table public.domain_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  color_label text not null default '#ff315f' check (color_label ~ '^#[0-9A-Fa-f]{6}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index domain_groups_name_ci on public.domain_groups(lower(name));

alter table public.domains
  add column domain_group_id uuid references public.domain_groups(id) on delete set null,
  add column color_label text not null default '#ff315f' check (color_label ~ '^#[0-9A-Fa-f]{6}$');

create trigger set_domain_groups_updated_at before update on public.domain_groups
for each row execute function public.set_updated_at();

alter table public.domain_groups enable row level security;
revoke all on public.domain_groups from anon, authenticated;
