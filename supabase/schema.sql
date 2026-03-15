create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  profile text not null,
  total_asset bigint not null default 10000000,
  selected_codes text[] not null default '{}',
  holdings jsonb not null default '[]'::jsonb,
  realized_profit numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_user_name_unique unique (user_id, name)
);

create index if not exists profiles_user_updated_idx
  on public.profiles (user_id, updated_at desc);

alter table public.profiles enable row level security;

create policy if not exists "Users can read own profiles"
  on public.profiles
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy if not exists "Users can insert own profiles"
  on public.profiles
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy if not exists "Users can update own profiles"
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy if not exists "Users can delete own profiles"
  on public.profiles
  for delete
  to authenticated
  using (auth.uid() = user_id);
