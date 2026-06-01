alter table public.websites
  drop constraint websites_domain_id_key,
  drop constraint websites_revenue_wallet_id_key;

create unique index websites_one_active_assignment_per_domain
on public.websites(domain_id)
where active;

create unique index websites_one_active_assignment_per_revenue_wallet
on public.websites(revenue_wallet_id)
where active;
