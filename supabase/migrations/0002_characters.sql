-- Step 2: saved characters.
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Run 0001_profiles.sql first. It is safe to run more than once.

create table if not exists public.characters (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists characters_owner_idx on public.characters (owner_id, updated_at desc);

alter table public.characters enable row level security;

-- Players can only see, create, change and delete their own characters.
-- (Step 3 will add a rule letting a campaign's Dungeon Master see the party's characters.)
drop policy if exists "Players read their own characters" on public.characters;
create policy "Players read their own characters"
  on public.characters for select
  to authenticated
  using ((select auth.uid()) = owner_id);

drop policy if exists "Players create their own characters" on public.characters;
create policy "Players create their own characters"
  on public.characters for insert
  to authenticated
  with check ((select auth.uid()) = owner_id);

drop policy if exists "Players update their own characters" on public.characters;
create policy "Players update their own characters"
  on public.characters for update
  to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

drop policy if exists "Players delete their own characters" on public.characters;
create policy "Players delete their own characters"
  on public.characters for delete
  to authenticated
  using ((select auth.uid()) = owner_id);

-- Reuses the updated_at helper from 0001_profiles.sql.
drop trigger if exists characters_touch_updated_at on public.characters;
create trigger characters_touch_updated_at
  before update on public.characters
  for each row execute function public.touch_updated_at();

-- Keep any one character's saved data to a sensible size (about 1 MB).
alter table public.characters drop constraint if exists characters_data_size;
alter table public.characters add constraint characters_data_size check (pg_column_size(data) < 1000000);
