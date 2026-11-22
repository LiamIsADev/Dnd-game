-- Step 1: player profiles.
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- It is safe to run more than once.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Newer Supabase projects don't expose new tables to signed-in users
-- automatically, so grant access explicitly. Row-level security below still
-- decides which rows each player can see or change.
grant usage on schema public to authenticated;
grant select, insert, update on table public.profiles to authenticated;

-- Any signed-in player can see display names (needed later to show party members).
drop policy if exists "Profiles are visible to signed-in users" on public.profiles;
create policy "Profiles are visible to signed-in users"
  on public.profiles for select
  to authenticated
  using (true);

-- Players can only create and edit their own profile.
drop policy if exists "Players insert their own profile" on public.profiles;
create policy "Players insert their own profile"
  on public.profiles for insert
  to authenticated
  with check ((select auth.uid()) = id);

drop policy if exists "Players update their own profile" on public.profiles;
create policy "Players update their own profile"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- Keep updated_at current.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- Create a profile automatically the first time someone signs in,
-- using the part of their email before the @ as a starting name.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(coalesce(nullif(split_part(new.email, '@', 1), ''), 'Adventurer'), 40))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for anyone who signed up before this script was run.
insert into public.profiles (id, display_name)
select u.id, left(coalesce(nullif(split_part(u.email, '@', 1), ''), 'Adventurer'), 40)
from auth.users u
on conflict (id) do nothing;
