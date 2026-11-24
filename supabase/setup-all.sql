-- Everything the site needs in the database, in one file.
-- Supabase dashboard: SQL Editor -> New query -> paste all of this -> Run.
-- It is safe to run again: run it after every update to be sure nothing is missing.
-- Made from supabase/migrations (0001_profiles.sql to 0007_homebrew.sql) by scripts/build-setup-sql.mjs.

-- ===================================================== 0001_profiles.sql

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

-- ===================================================== 0002_characters.sql

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

-- Newer Supabase projects don't expose new tables to signed-in users
-- automatically, so grant access explicitly. Row-level security below still
-- decides which rows each player can see or change.
grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.characters to authenticated;

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

-- ===================================================== 0003_campaigns.sql

-- Step 3: campaigns and the live table.
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Run 0001 and 0002 first. It is safe to run more than once.
--
-- Security model
-- --------------
-- * The Dungeon Master (DM) of a campaign can see and change everything in it.
-- * Players can only see what the DM has shown them. Hidden tokens, tokens
--   standing in fog, monster HP/notes, inactive maps and unshown images are
--   filtered out by the database itself, so they never reach a player's browser.
-- * Players can't write map data directly. They move their own token, join
--   campaigns and roll dice through the functions at the bottom of this file,
--   which check permissions first. Dice are rolled by the server so nobody can
--   fake a roll.

/* ------------------------------------------------------------- helpers */

-- 6-character join code without look-alike letters (no I, O, 0, 1).
create or replace function public.new_join_code()
returns text
language sql
volatile
set search_path = ''
as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '')
  from generate_series(1, 6);
$$;

-- Turn the first folder of a storage path into a uuid (null if it isn't one).
create or replace function public.try_uuid(value text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case when value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then value::uuid end;
$$;

/* -------------------------------------------------------------- tables */

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  dm_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  join_code text not null unique default public.new_join_code(),
  active_map_id uuid,
  -- Bumped whenever anything in the campaign changes, so every open browser
  -- knows to refresh what it is allowed to see.
  version bigint not null default 0,
  last_change text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.campaign_members (
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('dm', 'player')),
  character_id uuid references public.characters (id) on delete set null,
  joined_at timestamptz not null default now(),
  primary key (campaign_id, user_id)
);
create index if not exists campaign_members_user_idx on public.campaign_members (user_id);

create table if not exists public.maps (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  cols int not null default 30 check (cols between 5 and 100),
  rows int not null default 20 check (rows between 5 and 100),
  -- How far (in squares) a player's token reveals the fog around it.
  vision int not null default 6 check (vision between 0 and 30),
  background_path text,
  -- One character per square, row by row: '1' = revealed, '0' = fog.
  revealed text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists maps_campaign_idx on public.maps (campaign_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'campaigns_active_map_fk') then
    alter table public.campaigns
      add constraint campaigns_active_map_fk foreign key (active_map_id) references public.maps (id) on delete set null;
  end if;
end $$;

create table if not exists public.tokens (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  map_id uuid not null references public.maps (id) on delete cascade,
  kind text not null check (kind in ('pc', 'monster', 'npc')),
  name text not null check (char_length(name) between 1 and 80),
  color text not null default '#8b2c2c' check (color ~ '^#[0-9a-fA-F]{6}$'),
  size int not null default 1 check (size between 1 and 4),
  x int not null default 0,
  y int not null default 0,
  hidden boolean not null default false,
  owner_id uuid references auth.users (id) on delete set null,
  character_id uuid references public.characters (id) on delete set null,
  monster_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tokens_map_idx on public.tokens (map_id);

-- DM-only details for a token (enemy HP, AC, notes). Players never see these.
create table if not exists public.token_secrets (
  token_id uuid primary key references public.tokens (id) on delete cascade,
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  hp_current int,
  hp_max int,
  ac int,
  notes text check (char_length(notes) <= 5000)
);

-- Images the DM can show to players (boss art, maps, letters...).
create table if not exists public.handouts (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  title text not null default '' check (char_length(title) <= 120),
  image_path text not null,
  shown boolean not null default false,
  shown_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists handouts_campaign_idx on public.handouts (campaign_id);

create table if not exists public.rolls (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  roller_name text not null,
  label text not null default '',
  expr text not null,
  mode text not null default 'normal',
  total int not null,
  nat_roll int,
  detail jsonb not null,
  private boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists rolls_campaign_idx on public.rolls (campaign_id, created_at desc);

/* ---------------------------------------------- permission helper functions */
-- security definer so they can be used inside row-level security rules
-- without those rules looping back on themselves.

create or replace function public.is_campaign_member(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.campaign_members m where m.campaign_id = cid and m.user_id = auth.uid());
$$;

create or replace function public.is_campaign_dm(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.campaigns c where c.id = cid and c.dm_id = auth.uid());
$$;

create or replace function public.is_active_map(mid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.campaigns c where c.active_map_id = mid);
$$;

create or replace function public.cell_revealed(mid uuid, cx int, cy int)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select cx >= 0 and cy >= 0 and cx < m.cols and cy < m.rows
       and substr(m.revealed, cy * m.cols + cx + 1, 1) = '1'
    from public.maps m where m.id = mid
  ), false);
$$;

/* --------------------------------------------------------------- triggers */

-- The DM automatically becomes a member of their own campaign.
create or replace function public.campaign_add_dm()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.campaign_members (campaign_id, user_id, role)
  values (new.id, new.dm_id, 'dm')
  on conflict (campaign_id, user_id) do update set role = 'dm';
  return new;
end;
$$;

drop trigger if exists campaigns_add_dm on public.campaigns;
create trigger campaigns_add_dm
  after insert on public.campaigns
  for each row execute function public.campaign_add_dm();

drop trigger if exists campaigns_touch_updated_at on public.campaigns;
create trigger campaigns_touch_updated_at
  before update on public.campaigns
  for each row execute function public.touch_updated_at();

drop trigger if exists tokens_touch_updated_at on public.tokens;
create trigger tokens_touch_updated_at
  before update on public.tokens
  for each row execute function public.touch_updated_at();

-- Keep the fog string the right length when a map is created or resized,
-- keeping whatever was revealed in squares that still exist.
create or replace function public.maps_fit_fog()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  fog text := '';
  old_cols int;
  r int;
  c int;
begin
  if new.revealed is not null and char_length(new.revealed) = new.cols * new.rows
     and (tg_op = 'INSERT' or (old.cols = new.cols and old.rows = new.rows)) then
    if new.revealed !~ '^[01]*$' then
      raise exception 'Fog data must only contain 0 and 1';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and char_length(old.revealed) = old.cols * old.rows then
    old_cols := old.cols;
    for r in 0 .. new.rows - 1 loop
      for c in 0 .. new.cols - 1 loop
        if r < old.rows and c < old_cols then
          fog := fog || substr(old.revealed, r * old_cols + c + 1, 1);
        else
          fog := fog || '0';
        end if;
      end loop;
    end loop;
    new.revealed := fog;
  else
    new.revealed := repeat('0', new.cols * new.rows);
  end if;
  return new;
end;
$$;

drop trigger if exists maps_fit_fog on public.maps;
create trigger maps_fit_fog
  before insert or update on public.maps
  for each row execute function public.maps_fit_fog();

-- Tell every open browser in the campaign that something changed.
create or replace function public.bump_campaign()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.campaigns
     set version = version + 1, last_change = tg_table_name
   where id = coalesce(new.campaign_id, old.campaign_id);
  return coalesce(new, old);
end;
$$;

drop trigger if exists bump_on_members on public.campaign_members;
create trigger bump_on_members after insert or update or delete on public.campaign_members
  for each row execute function public.bump_campaign();
drop trigger if exists bump_on_maps on public.maps;
create trigger bump_on_maps after insert or update or delete on public.maps
  for each row execute function public.bump_campaign();
drop trigger if exists bump_on_tokens on public.tokens;
create trigger bump_on_tokens after insert or update or delete on public.tokens
  for each row execute function public.bump_campaign();
drop trigger if exists bump_on_token_secrets on public.token_secrets;
create trigger bump_on_token_secrets after insert or update or delete on public.token_secrets
  for each row execute function public.bump_campaign();
drop trigger if exists bump_on_handouts on public.handouts;
create trigger bump_on_handouts after insert or update or delete on public.handouts
  for each row execute function public.bump_campaign();

-- A token's campaign must match its map's campaign; secrets must match their token.
create or replace function public.tokens_check_campaign()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'tokens' then
    if not exists (select 1 from public.maps m where m.id = new.map_id and m.campaign_id = new.campaign_id) then
      raise exception 'That map is not in this campaign';
    end if;
    if new.owner_id is not null and not exists (
      select 1 from public.campaign_members cm where cm.campaign_id = new.campaign_id and cm.user_id = new.owner_id) then
      raise exception 'Token owner must be in the campaign';
    end if;
  else
    if not exists (select 1 from public.tokens t where t.id = new.token_id and t.campaign_id = new.campaign_id) then
      raise exception 'That token is not in this campaign';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists tokens_check_campaign on public.tokens;
create trigger tokens_check_campaign before insert or update on public.tokens
  for each row execute function public.tokens_check_campaign();
drop trigger if exists token_secrets_check_campaign on public.token_secrets;
create trigger token_secrets_check_campaign before insert or update on public.token_secrets
  for each row execute function public.tokens_check_campaign();

-- The active map must belong to the campaign.
create or replace function public.campaigns_check_active_map()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.active_map_id is not null and not exists (
    select 1 from public.maps m where m.id = new.active_map_id and m.campaign_id = new.id) then
    raise exception 'That map is not in this campaign';
  end if;
  if tg_op = 'UPDATE' and new.dm_id <> old.dm_id then
    raise exception 'The DM of a campaign can''t be changed';
  end if;
  if tg_op = 'UPDATE' and new.join_code <> old.join_code and new.join_code !~ '^[A-HJ-NP-Z2-9]{6}$' then
    raise exception 'Invalid join code';
  end if;
  return new;
end;
$$;

drop trigger if exists campaigns_check_active_map on public.campaigns;
create trigger campaigns_check_active_map before insert or update on public.campaigns
  for each row execute function public.campaigns_check_active_map();

/* ------------------------------------------------------ row-level security */

alter table public.campaigns enable row level security;
alter table public.campaign_members enable row level security;
alter table public.maps enable row level security;
alter table public.tokens enable row level security;
alter table public.token_secrets enable row level security;
alter table public.handouts enable row level security;
alter table public.rolls enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.campaigns to authenticated;
grant select, delete on table public.campaign_members to authenticated;
grant update (character_id) on table public.campaign_members to authenticated;
grant select, insert, update, delete on table public.maps to authenticated;
grant select, insert, update, delete on table public.tokens to authenticated;
grant select, insert, update, delete on table public.token_secrets to authenticated;
grant select, insert, update, delete on table public.handouts to authenticated;
grant select on table public.rolls to authenticated;

-- campaigns
drop policy if exists "Members see their campaigns" on public.campaigns;
create policy "Members see their campaigns" on public.campaigns for select to authenticated
  using (dm_id = (select auth.uid()) or public.is_campaign_member(id));
drop policy if exists "Anyone signed in can start a campaign" on public.campaigns;
create policy "Anyone signed in can start a campaign" on public.campaigns for insert to authenticated
  with check (dm_id = (select auth.uid()));
drop policy if exists "DM updates campaign" on public.campaigns;
create policy "DM updates campaign" on public.campaigns for update to authenticated
  using (dm_id = (select auth.uid())) with check (dm_id = (select auth.uid()));
drop policy if exists "DM deletes campaign" on public.campaigns;
create policy "DM deletes campaign" on public.campaigns for delete to authenticated
  using (dm_id = (select auth.uid()));

-- campaign_members (joining happens through join_campaign below)
drop policy if exists "Members see the party" on public.campaign_members;
create policy "Members see the party" on public.campaign_members for select to authenticated
  using (public.is_campaign_member(campaign_id));
drop policy if exists "Players choose their character" on public.campaign_members;
create policy "Players choose their character" on public.campaign_members for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and (character_id is null or exists (
      select 1 from public.characters ch where ch.id = character_id and ch.owner_id = (select auth.uid())))
  );
drop policy if exists "Players leave, DM removes players" on public.campaign_members;
create policy "Players leave, DM removes players" on public.campaign_members for delete to authenticated
  using (role = 'player' and (user_id = (select auth.uid()) or public.is_campaign_dm(campaign_id)));

-- maps: players only ever get the active map
drop policy if exists "DM sees all maps, players the active one" on public.maps;
create policy "DM sees all maps, players the active one" on public.maps for select to authenticated
  using (public.is_campaign_dm(campaign_id) or (public.is_campaign_member(campaign_id) and public.is_active_map(id)));
drop policy if exists "DM manages maps" on public.maps;
create policy "DM manages maps" on public.maps for all to authenticated
  using (public.is_campaign_dm(campaign_id)) with check (public.is_campaign_dm(campaign_id));

-- tokens: players see their own tokens, and others only if not hidden and not in fog
drop policy if exists "Tokens players are allowed to see" on public.tokens;
create policy "Tokens players are allowed to see" on public.tokens for select to authenticated
  using (
    public.is_campaign_dm(campaign_id)
    or (
      public.is_campaign_member(campaign_id)
      and public.is_active_map(map_id)
      and (owner_id = (select auth.uid()) or (not hidden and public.cell_revealed(map_id, x, y)))
    )
  );
drop policy if exists "DM manages tokens" on public.tokens;
create policy "DM manages tokens" on public.tokens for all to authenticated
  using (public.is_campaign_dm(campaign_id)) with check (public.is_campaign_dm(campaign_id));

-- token_secrets: DM only
drop policy if exists "DM only token secrets" on public.token_secrets;
create policy "DM only token secrets" on public.token_secrets for all to authenticated
  using (public.is_campaign_dm(campaign_id)) with check (public.is_campaign_dm(campaign_id));

-- handouts: players only see ones the DM is showing
drop policy if exists "Shown handouts" on public.handouts;
create policy "Shown handouts" on public.handouts for select to authenticated
  using (public.is_campaign_dm(campaign_id) or (shown and public.is_campaign_member(campaign_id)));
drop policy if exists "DM manages handouts" on public.handouts;
create policy "DM manages handouts" on public.handouts for all to authenticated
  using (public.is_campaign_dm(campaign_id)) with check (public.is_campaign_dm(campaign_id));

-- rolls: everyone in the campaign sees public rolls; private rolls only the roller and DM
drop policy if exists "Campaign rolls" on public.rolls;
create policy "Campaign rolls" on public.rolls for select to authenticated
  using (
    public.is_campaign_member(campaign_id)
    and (not private or user_id = (select auth.uid()) or public.is_campaign_dm(campaign_id))
  );

-- characters: a DM can read the characters their players brought to the campaign
drop policy if exists "DM reads party characters" on public.characters;
create policy "DM reads party characters" on public.characters for select to authenticated
  using (exists (
    select 1 from public.campaign_members m
    join public.campaigns c on c.id = m.campaign_id
    where m.character_id = characters.id and c.dm_id = (select auth.uid())
  ));

/* ------------------------------------------------------------- functions */

-- Join a campaign with its 6-character code. Returns the campaign id.
create or replace function public.join_campaign(code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  cid uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first';
  end if;
  select id into cid from public.campaigns where join_code = upper(regexp_replace(code, '\s', '', 'g'));
  if cid is null then
    raise exception 'No campaign has that code. Check it with your DM.';
  end if;
  insert into public.campaign_members (campaign_id, user_id, role)
  values (cid, auth.uid(), 'player')
  on conflict (campaign_id, user_id) do nothing;
  return cid;
end;
$$;

-- Reveal the fog in a circle around a square.
create or replace function public.reveal_circle(mid uuid, cx int, cy int, radius int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.maps%rowtype;
  fog text;
  r int;
  c int;
  i int;
begin
  select * into m from public.maps where id = mid for update;
  if not found then return; end if;
  fog := m.revealed;
  for r in greatest(0, cy - radius) .. least(m.rows - 1, cy + radius) loop
    for c in greatest(0, cx - radius) .. least(m.cols - 1, cx + radius) loop
      if (c - cx) * (c - cx) + (r - cy) * (r - cy) <= radius * radius then
        i := r * m.cols + c + 1;
        fog := overlay(fog placing '1' from i for 1);
      end if;
    end loop;
  end loop;
  if fog <> m.revealed then
    update public.maps set revealed = fog where id = mid;
  end if;
end;
$$;

-- Move a token. The DM can move any token; a player only their own, on the
-- active map. Player characters reveal the fog around where they stop.
create or replace function public.move_token(token uuid, nx int, ny int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tokens%rowtype;
  m public.maps%rowtype;
  dm boolean;
begin
  select * into t from public.tokens where id = token;
  if not found then
    raise exception 'Token not found';
  end if;
  select * into m from public.maps where id = t.map_id;
  dm := public.is_campaign_dm(t.campaign_id);
  if not dm then
    if t.owner_id is distinct from auth.uid() or not public.is_campaign_member(t.campaign_id) or not public.is_active_map(t.map_id) then
      raise exception 'You can only move your own token';
    end if;
  end if;
  nx := greatest(0, least(m.cols - t.size, nx));
  ny := greatest(0, least(m.rows - t.size, ny));
  update public.tokens set x = nx, y = ny where id = token;
  if t.kind = 'pc' and m.vision > 0 then
    perform public.reveal_circle(m.id, nx + (t.size - 1) / 2, ny + (t.size - 1) / 2, m.vision);
  end if;
end;
$$;

-- Roll dice on the server, e.g. '1d20+5', '2d6+3', '4d6kh3'.
-- mode: 'normal', 'advantage' or 'disadvantage' (applies to a single d20).
create or replace function public.roll_dice(cid uuid, expr text, label text default '', mode text default 'normal', private boolean default false)
returns public.rolls
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  clean text := lower(regexp_replace(coalesce(expr, ''), '\s', '', 'g'));
  rec record;
  m text[];
  sign int;
  cnt int;
  sides int;
  keep int;
  dice int[];
  kept int[];
  total int := 0;
  nat int := null;
  parts jsonb := '[]'::jsonb;
  d20_terms int := 0;
  roller text;
  i int;
  result public.rolls;
begin
  if not public.is_campaign_member(cid) then
    raise exception 'You are not in this campaign';
  end if;
  if mode not in ('normal', 'advantage', 'disadvantage') then
    raise exception 'Unknown roll mode';
  end if;
  clean := replace(clean, '−', '-');
  if clean = '' or char_length(clean) > 60 or clean !~ '^[+-]?(\d*d\d+(kh\d+)?|\d+)([+-](\d*d\d+(kh\d+)?|\d+))*$' then
    raise exception 'Can''t read dice "%"', expr;
  end if;
  select count(*) into d20_terms from regexp_matches(clean, '(^|[+-])(1?)d20(?!\d)', 'g');
  -- The whole expression was checked above, so matching term by term reads all of it.
  for rec in select regexp_matches(clean, '([+-]?)(?:(\d*)d(\d+)(?:kh(\d+))?|(\d+))', 'g') as g loop
    m := rec.g;
    sign := case when m[1] = '-' then -1 else 1 end;
    if m[5] is not null then
      total := total + sign * m[5]::int;
      parts := parts || jsonb_build_object('value', m[5]::int, 'sign', sign);
      continue;
    end if;
    cnt := coalesce(nullif(m[2], '')::int, 1);
    sides := m[3]::int;
    keep := m[4]::int;
    if cnt < 1 or cnt > 100 or sides < 1 or sides > 1000 or keep > cnt then
      raise exception 'Too many dice or sides';
    end if;
    if sides = 20 and cnt = 1 and d20_terms = 1 and mode <> 'normal' then
      cnt := 2;
      keep := 1;
    end if;
    dice := array[]::int[];
    for i in 1 .. cnt loop
      dice := dice || (1 + floor(random() * sides))::int;
    end loop;
    if keep is not null and sides = 20 and cnt = 2 and mode = 'disadvantage' and d20_terms = 1 then
      kept := array(select d from unnest(dice) d order by d asc limit 1);
    elsif keep is not null then
      kept := array(select d from unnest(dice) d order by d desc limit keep);
    else
      kept := dice;
    end if;
    total := total + sign * (select coalesce(sum(k), 0) from unnest(kept) k)::int;
    if sides = 20 and d20_terms = 1 and nat is null then
      nat := kept[1];
    end if;
    parts := parts || jsonb_build_object('dice', to_jsonb(dice), 'kept', to_jsonb(kept), 'sides', sides, 'sign', sign);
  end loop;

  select coalesce(p.display_name, 'Someone') into roller from public.profiles p where p.id = auth.uid();
  insert into public.rolls (campaign_id, user_id, roller_name, label, expr, mode, total, nat_roll, detail, private)
  values (cid, auth.uid(), coalesce(roller, 'Someone'), left(coalesce(label, ''), 80), clean, mode, total, nat, parts, coalesce(private, false))
  returning * into result;
  return result;
end;
$$;

revoke all on function public.reveal_circle(uuid, int, int, int) from public, anon, authenticated;
revoke all on function public.join_campaign(text) from public, anon;
revoke all on function public.move_token(uuid, int, int) from public, anon;
revoke all on function public.roll_dice(uuid, text, text, text, boolean) from public, anon;
grant execute on function public.join_campaign(text) to authenticated;
grant execute on function public.move_token(uuid, int, int) to authenticated;
grant execute on function public.roll_dice(uuid, text, text, text, boolean) to authenticated;

/* ------------------------------------------------------- live updates */
-- Browsers listen for changes to these tables (still filtered by the rules above).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'campaigns') then
      alter publication supabase_realtime add table public.campaigns;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'rolls') then
      alter publication supabase_realtime add table public.rolls;
    end if;
  end if;
end $$;

/* ------------------------------------------------------------ images */
-- Private bucket for map backgrounds and handouts, stored as <campaign id>/<file>.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('campaign-images', 'campaign-images', false, 5242880, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

drop policy if exists "DM uploads campaign images" on storage.objects;
create policy "DM uploads campaign images" on storage.objects for insert to authenticated
  with check (bucket_id = 'campaign-images' and public.is_campaign_dm(public.try_uuid((storage.foldername(name))[1])));

drop policy if exists "DM changes campaign images" on storage.objects;
create policy "DM changes campaign images" on storage.objects for update to authenticated
  using (bucket_id = 'campaign-images' and public.is_campaign_dm(public.try_uuid((storage.foldername(name))[1])));

drop policy if exists "DM deletes campaign images" on storage.objects;
create policy "DM deletes campaign images" on storage.objects for delete to authenticated
  using (bucket_id = 'campaign-images' and public.is_campaign_dm(public.try_uuid((storage.foldername(name))[1])));

-- Players can only open an image while it is the active map's background or a shown handout.
drop policy if exists "Read campaign images the DM has shown" on storage.objects;
create policy "Read campaign images the DM has shown" on storage.objects for select to authenticated
  using (
    bucket_id = 'campaign-images'
    and (
      public.is_campaign_dm(public.try_uuid((storage.foldername(name))[1]))
      or (
        public.is_campaign_member(public.try_uuid((storage.foldername(name))[1]))
        and (
          exists (select 1 from public.handouts h where h.image_path = storage.objects.name and h.shown)
          or exists (
            select 1 from public.maps m join public.campaigns c on c.active_map_id = m.id
            where m.background_path = storage.objects.name)
        )
      )
    )
  );

-- ===================================================== 0004_rules.sql

-- Step 4: rules automation.
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Run 0001, 0002 and 0003 first. It is safe to run more than once.
--
-- The database rolls every attack, save and damage die and applies the
-- result, so nobody can fake a roll and players never learn an enemy's AC,
-- HP or saving throw bonuses. The DM's browser works out the party's AC,
-- HP and saves from their character sheets and keeps them up to date here.

/* --------------------------------------------------------------- columns */
alter table public.tokens add column if not exists conditions text[] not null default '{}';
alter table public.tokens add column if not exists initiative int;

alter table public.token_secrets add column if not exists saves jsonb not null default '{}'::jsonb;
alter table public.token_secrets add column if not exists resist text[] not null default '{}';
alter table public.token_secrets add column if not exists immune text[] not null default '{}';
alter table public.token_secrets add column if not exists vulnerable text[] not null default '{}';
alter table public.token_secrets add column if not exists xp int;

alter table public.campaigns add column if not exists combat_round int;
alter table public.campaigns add column if not exists combat_turn uuid;

-- What happened in a roll (hit or miss, damage, each target's save), for the roll log.
alter table public.rolls add column if not exists result jsonb;

/* -------------------------------------------------------------- helpers */

-- Can the signed-in person see this token? Same rule as the tokens table's policy.
create or replace function public.can_see_token(tid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.tokens t
    where t.id = tid
      and (
        public.is_campaign_dm(t.campaign_id)
        or (
          public.is_campaign_member(t.campaign_id)
          and public.is_active_map(t.map_id)
          and (t.owner_id = auth.uid() or (not t.hidden and public.cell_revealed(t.map_id, t.x, t.y)))
        )
      )
  );
$$;

-- Can the signed-in person act for this token (DM: any token; player: their own)?
create or replace function public.can_act_for(tid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.tokens t
    where t.id = tid
      and (public.is_campaign_dm(t.campaign_id)
           or (t.owner_id = auth.uid() and public.is_campaign_member(t.campaign_id) and public.is_active_map(t.map_id)))
  );
$$;

-- Roll a dice expression. Returns {total, nat, detail, expr}.
-- mode applies to a single d20; crit doubles every die (critical hit damage).
create or replace function public.dice_roll(expr text, mode text default 'normal', crit boolean default false)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  clean text := replace(lower(regexp_replace(coalesce(expr, ''), '\s', '', 'g')), '−', '-');
  rec record;
  m text[];
  sign int;
  cnt int;
  sides int;
  keep int;
  dice int[];
  kept int[];
  total int := 0;
  nat int := null;
  parts jsonb := '[]'::jsonb;
  d20_terms int := 0;
  i int;
begin
  if coalesce(mode, 'normal') not in ('normal', 'advantage', 'disadvantage') then
    raise exception 'Unknown roll mode';
  end if;
  if clean = '' or char_length(clean) > 60 or clean !~ '^[+-]?(\d*d\d+(kh\d+)?|\d+)([+-](\d*d\d+(kh\d+)?|\d+))*$' then
    raise exception 'Can''t read dice "%"', expr;
  end if;
  select count(*) into d20_terms from regexp_matches(clean, '(^|[+-])(1?)d20(?!\d)', 'g');
  for rec in select regexp_matches(clean, '([+-]?)(?:(\d*)d(\d+)(?:kh(\d+))?|(\d+))', 'g') as g loop
    m := rec.g;
    sign := case when m[1] = '-' then -1 else 1 end;
    if m[5] is not null then
      total := total + sign * m[5]::int;
      parts := parts || jsonb_build_object('value', m[5]::int, 'sign', sign);
      continue;
    end if;
    cnt := coalesce(nullif(m[2], '')::int, 1);
    sides := m[3]::int;
    keep := m[4]::int;
    if cnt < 1 or cnt > 100 or sides < 1 or sides > 1000 or keep > cnt then
      raise exception 'Too many dice or sides';
    end if;
    if crit then
      cnt := cnt * 2;
      keep := keep * 2;
    end if;
    if sides = 20 and cnt = 1 and d20_terms = 1 and coalesce(mode, 'normal') <> 'normal' then
      cnt := 2;
      keep := 1;
    end if;
    dice := array[]::int[];
    for i in 1 .. cnt loop
      dice := dice || (1 + floor(random() * sides))::int;
    end loop;
    if keep is not null and sides = 20 and cnt = 2 and mode = 'disadvantage' and d20_terms = 1 then
      kept := array(select d from unnest(dice) d order by d asc limit 1);
    elsif keep is not null then
      kept := array(select d from unnest(dice) d order by d desc limit keep);
    else
      kept := dice;
    end if;
    total := total + sign * (select coalesce(sum(k), 0) from unnest(kept) k)::int;
    if sides = 20 and d20_terms = 1 and nat is null then
      nat := kept[1];
    end if;
    parts := parts || jsonb_build_object('dice', to_jsonb(dice), 'kept', to_jsonb(kept), 'sides', sides, 'sign', sign);
  end loop;
  return jsonb_build_object('total', total, 'nat', nat, 'detail', parts, 'expr', clean);
end;
$$;

-- Write a line in the campaign's roll log.
create or replace function public.log_roll(cid uuid, label text, roll jsonb, mode text, private boolean, result jsonb)
returns public.rolls
language plpgsql
security definer
set search_path = ''
as $$
declare
  roller text;
  out_row public.rolls;
begin
  select coalesce(p.display_name, 'Someone') into roller from public.profiles p where p.id = auth.uid();
  insert into public.rolls (campaign_id, user_id, roller_name, label, expr, mode, total, nat_roll, detail, private, result)
  values (cid, auth.uid(), coalesce(roller, 'Someone'), left(coalesce(label, ''), 120), coalesce(roll ->> 'expr', ''),
          coalesce(mode, 'normal'), coalesce((roll ->> 'total')::int, 0), (roll ->> 'nat')::int,
          coalesce(roll -> 'detail', '[]'::jsonb), coalesce(private, false), result)
  returning * into out_row;
  return out_row;
end;
$$;

-- Resistance halves, immunity cancels, vulnerability doubles (by damage type).
create or replace function public.adjust_damage(amount int, dtype text, s public.token_secrets)
returns int
language plpgsql
immutable
set search_path = ''
as $$
declare
  t text := lower(trim(coalesce(dtype, '')));
begin
  if amount <= 0 or t = '' or s.token_id is null then
    return greatest(amount, 0);
  end if;
  if exists (select 1 from unnest(s.immune) x where lower(x) = t) then
    return 0;
  end if;
  if exists (select 1 from unnest(s.resist) x where lower(x) = t) then
    amount := amount / 2;
  end if;
  if exists (select 1 from unnest(s.vulnerable) x where lower(x) = t) then
    amount := amount * 2;
  end if;
  return amount;
end;
$$;

create or replace function public.add_condition(conds jsonb, name text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when coalesce(conds, '[]'::jsonb) ? name then coalesce(conds, '[]'::jsonb) else coalesce(conds, '[]'::jsonb) || to_jsonb(name) end;
$$;

create or replace function public.remove_condition(conds jsonb, name text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(c), '[]'::jsonb) from jsonb_array_elements(coalesce(conds, '[]'::jsonb)) c where c <> to_jsonb(name);
$$;

-- Change a token's hit points by delta (negative = damage, positive = healing).
-- Player characters: temporary HP first, unconscious at 0, failed death saves
-- when hit at 0, and instant death when the leftover damage reaches their max.
-- Returns {hp, down, dead, dealt} where dealt is the damage actually taken.
create or replace function public.change_hp(tid uuid, delta int, crit boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tokens%rowtype;
  s public.token_secrets%rowtype;
  ch public.characters%rowtype;
  d jsonb;
  hp_max int;
  cur int;
  tmp int;
  dmg int;
  left_over int;
  fails int;
  down boolean := false;
  dead boolean := false;
begin
  select * into t from public.tokens where id = tid;
  select * into s from public.token_secrets where token_id = tid;
  if t.kind = 'pc' and t.character_id is not null then
    select * into ch from public.characters where id = t.character_id for update;
    d := ch.data;
    hp_max := coalesce(s.hp_max, nullif(d -> 'hp' ->> 'current', '')::int, 1);
    cur := coalesce(nullif(d -> 'hp' ->> 'current', '')::int, hp_max);
    tmp := coalesce(nullif(d -> 'hp' ->> 'temp', '')::int, 0);
    if delta < 0 then
      dmg := -delta;
      left_over := greatest(dmg - tmp, 0);
      tmp := greatest(tmp - dmg, 0);
      if cur = 0 and left_over > 0 then
        -- Already down: each hit is a failed death save (two for a critical hit).
        fails := least(3, coalesce((d -> 'deathSaves' ->> 'failures')::int, 0) + case when crit then 2 else 1 end);
        if left_over >= hp_max then fails := 3; end if;
        d := jsonb_set(d, '{deathSaves,failures}', to_jsonb(fails), true);
        if fails >= 3 then
          d := jsonb_set(d, '{conditions}', public.add_condition(d -> 'conditions', 'Dead'));
          dead := true;
        end if;
      elsif left_over >= cur and left_over > 0 then
        if left_over - cur >= hp_max then
          dead := true;
          d := jsonb_set(d, '{conditions}', public.add_condition(d -> 'conditions', 'Dead'));
        end if;
        cur := 0;
        down := true;
        d := jsonb_set(d, '{conditions}', public.add_condition(d -> 'conditions', 'Unconscious'));
      else
        cur := cur - left_over;
      end if;
    else
      if cur = 0 and delta > 0 and not (coalesce(d -> 'conditions', '[]'::jsonb) ? 'Dead') then
        d := jsonb_set(d, '{conditions}', public.remove_condition(d -> 'conditions', 'Unconscious'));
        d := jsonb_set(d, '{deathSaves}', '{"successes": 0, "failures": 0}'::jsonb, true);
      end if;
      if not (coalesce(d -> 'conditions', '[]'::jsonb) ? 'Dead') then
        cur := least(hp_max, cur + delta);
      end if;
      dmg := 0;
    end if;
    d := jsonb_set(d, '{hp}', jsonb_build_object('current', cur, 'temp', tmp), true);
    update public.characters set data = d where id = ch.id;
    return jsonb_build_object('hp', cur, 'down', down, 'dead', dead, 'dealt', coalesce(dmg, 0));
  end if;

  -- Enemies and NPCs: hit points live in token_secrets.
  if s.token_id is null then
    insert into public.token_secrets (token_id, campaign_id) values (t.id, t.campaign_id) returning * into s;
  end if;
  hp_max := s.hp_max;
  cur := coalesce(s.hp_current, s.hp_max, 0);
  if delta < 0 then
    cur := greatest(0, cur + delta);
  else
    cur := case when hp_max is null then cur + delta else least(hp_max, cur + delta) end;
  end if;
  update public.token_secrets set hp_current = cur where token_id = tid;
  if cur = 0 and delta < 0 and not ('Dead' = any(t.conditions)) then
    update public.tokens set conditions = array_append(conditions, 'Dead') where id = tid;
    down := true;
    dead := true;
  elsif cur > 0 and 'Dead' = any(t.conditions) then
    update public.tokens set conditions = array_remove(conditions, 'Dead') where id = tid;
  end if;
  return jsonb_build_object('hp', cur, 'down', down, 'dead', dead, 'dealt', greatest(-delta, 0));
end;
$$;

/* --------------------------------------------- keep the table in sync */

-- When a character changes (damage, conditions, level up...), update its
-- tokens' conditions and tell the open campaigns to refresh.
create or replace function public.characters_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  conds text[];
begin
  if new.data is not distinct from old.data and new.name is not distinct from old.name then
    return new;
  end if;
  conds := array(select jsonb_array_elements_text(coalesce(new.data -> 'conditions', '[]'::jsonb)));
  update public.tokens set conditions = conds where character_id = new.id and conditions is distinct from conds;
  update public.campaigns c set version = version + 1, last_change = 'characters'
   where exists (select 1 from public.campaign_members m where m.campaign_id = c.id and m.character_id = new.id);
  return new;
end;
$$;

drop trigger if exists characters_sync on public.characters;
create trigger characters_sync after update on public.characters
  for each row execute function public.characters_sync();

/* ------------------------------------------------------------ combat */

create or replace function public.roll_initiative(token uuid, bonus int, mode text default 'normal')
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tokens%rowtype;
  r jsonb;
  total int;
begin
  if not public.can_act_for(token) then
    raise exception 'You can only roll initiative for your own token';
  end if;
  select * into t from public.tokens where id = token;
  bonus := greatest(-10, least(30, coalesce(bonus, 0)));
  r := public.dice_roll('1d20', mode);
  total := (r ->> 'total')::int + bonus;
  r := r || jsonb_build_object('total', total, 'expr', '1d20' || case when bonus >= 0 then '+' else '' end || bonus,
                               'detail', (r -> 'detail') || jsonb_build_array(jsonb_build_object('value', abs(bonus), 'sign', sign(bonus)::int)));
  update public.tokens set initiative = total where id = token;
  perform public.log_roll(t.campaign_id, t.name || ': Initiative', r, mode, t.hidden,
                          jsonb_build_object('kind', 'initiative', 'token', t.id));
  return total;
end;
$$;

create or replace function public.combat_start(cid uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_campaign_dm(cid) then
    raise exception 'Only the DM can start combat';
  end if;
  update public.tokens set initiative = null where campaign_id = cid and initiative is not null;
  update public.campaigns set combat_round = 1, combat_turn = null, version = version + 1, last_change = 'campaigns' where id = cid;
end;
$$;

create or replace function public.combat_end(cid uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_campaign_dm(cid) then
    raise exception 'Only the DM can end combat';
  end if;
  update public.campaigns set combat_round = null, combat_turn = null, version = version + 1, last_change = 'campaigns' where id = cid;
  update public.tokens set initiative = null where campaign_id = cid and initiative is not null;
end;
$$;

-- Move to the next creature in initiative order, skipping the dead and
-- defeated. The DM can always do this; a player can end their own turn.
create or replace function public.combat_next(cid uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.campaigns%rowtype;
  ids uuid[];
  pos int;
  n int;
  i int;
  nxt uuid;
  rnd int;
begin
  select * into c from public.campaigns where id = cid for update;
  if c.combat_round is null then
    raise exception 'There is no combat going on';
  end if;
  if not public.is_campaign_dm(cid) and not (c.combat_turn is not null and exists (
      select 1 from public.tokens t where t.id = c.combat_turn and t.owner_id = auth.uid())) then
    raise exception 'It isn''t your turn';
  end if;
  ids := array(
    select t.id from public.tokens t
    left join public.token_secrets s on s.token_id = t.id
    where t.campaign_id = cid and t.map_id = c.active_map_id and t.initiative is not null
      and not ('Dead' = any(t.conditions))
    order by t.initiative desc, t.created_at, t.id);
  n := coalesce(array_length(ids, 1), 0);
  if n = 0 then
    update public.campaigns set combat_turn = null, version = version + 1, last_change = 'campaigns' where id = cid;
    return null;
  end if;
  pos := array_position(ids, c.combat_turn);
  rnd := c.combat_round;
  if c.combat_turn is null then
    nxt := ids[1];
  elsif pos is null then
    -- The current creature left the fight; go to the next one by initiative.
    select t.id into nxt from public.tokens t
     where t.id = any(ids)
       and (t.initiative < coalesce((select initiative from public.tokens where id = c.combat_turn), 999))
     order by t.initiative desc, t.created_at, t.id limit 1;
    if nxt is null then
      nxt := ids[1];
      rnd := rnd + 1;
    end if;
  else
    i := pos + 1;
    if i > n then
      i := 1;
      rnd := rnd + 1;
    end if;
    nxt := ids[i];
  end if;
  update public.campaigns set combat_turn = nxt, combat_round = rnd, version = version + 1, last_change = 'campaigns' where id = cid;
  return nxt;
end;
$$;

/* ------------------------------------------------------- attacks */

-- Make an attack roll against a target's Armor Class and, on a hit, roll
-- and apply the damage. A natural 20 always hits and doubles the damage dice;
-- a natural 1 always misses.
create or replace function public.attack(
  attacker uuid, target uuid, bonus int, damage text default '', damage_type text default '',
  mode text default 'normal', label text default '', extra jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.tokens%rowtype;
  t public.tokens%rowtype;
  s public.token_secrets%rowtype;
  r jsonb;
  nat int;
  total int;
  ac int;
  hit boolean;
  crit boolean;
  dmg jsonb := null;
  dealt int := 0;
  hp jsonb := null;
  what text;
  result jsonb;
  part jsonb;
  more jsonb;
  extras jsonb := '[]'::jsonb;
begin
  if not public.can_act_for(attacker) then
    raise exception 'You can only attack with your own token';
  end if;
  if not public.can_see_token(target) then
    raise exception 'You can''t see that target';
  end if;
  select * into a from public.tokens where id = attacker;
  select * into t from public.tokens where id = target;
  if a.campaign_id <> t.campaign_id then
    raise exception 'That target is not in this campaign';
  end if;
  select * into s from public.token_secrets where token_id = target;
  bonus := greatest(-10, least(30, coalesce(bonus, 0)));
  ac := coalesce(s.ac, 10);
  r := public.dice_roll('1d20', mode);
  nat := (r ->> 'nat')::int;
  total := nat + bonus;
  crit := nat = 20;
  hit := nat = 20 or (nat <> 1 and total >= ac);
  r := r || jsonb_build_object('total', total, 'expr', '1d20' || case when bonus >= 0 then '+' else '' end || bonus,
                               'detail', (r -> 'detail') || jsonb_build_array(jsonb_build_object('value', abs(bonus), 'sign', sign(bonus)::int)));
  if hit and coalesce(damage, '') <> '' then
    dmg := public.dice_roll(damage, 'normal', crit);
    dealt := public.adjust_damage(greatest((dmg ->> 'total')::int, 0), damage_type, s);
    -- Extra damage of other types (e.g. a ghoul's bite: Piercing plus Necrotic).
    if jsonb_typeof(extra) = 'array' then
      for part in select * from jsonb_array_elements(extra) limit 4 loop
        more := public.dice_roll(part ->> 'dice', 'normal', crit);
        dealt := dealt + public.adjust_damage(greatest((more ->> 'total')::int, 0), part ->> 'type', s);
        extras := extras || jsonb_build_object('type', part ->> 'type', 'roll', more);
      end loop;
    end if;
    if dealt > 0 then
      hp := public.change_hp(target, -dealt, crit);
    end if;
  end if;
  what := coalesce(nullif(label, ''), 'Attack');
  result := jsonb_build_object(
    'kind', 'attack', 'attacker', a.name, 'target', t.name, 'hit', hit, 'crit', crit,
    'damage', dealt, 'damageType', nullif(damage_type, ''), 'damageRoll', dmg, 'extra', extras,
    'down', coalesce((hp ->> 'down')::boolean, false), 'dead', coalesce((hp ->> 'dead')::boolean, false));
  perform public.log_roll(a.campaign_id,
    a.name || ' attacks ' || t.name || ' (' || what || ')', r, mode, a.hidden or t.hidden, result);
  return result;
end;
$$;

-- Several creatures make a saving throw against a DC (e.g. Fireball).
-- Damage is rolled once: full on a failed save, half on a success when the
-- effect allows it. A condition (e.g. Frightened) is added on a failed save.
create or replace function public.saving_throw(
  source uuid, targets uuid[], ability text, dc int, damage text default '', damage_type text default '',
  half boolean default true, condition text default '', label text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  src public.tokens%rowtype;
  t public.tokens%rowtype;
  s public.token_secrets%rowtype;
  dmg jsonb := null;
  base int := 0;
  sr jsonb;
  bonus int;
  total int;
  ok boolean;
  dealt int;
  hp jsonb;
  rows jsonb := '[]'::jsonb;
  any_hidden boolean := false;
  tid uuid;
  result jsonb;
begin
  if not public.can_act_for(source) then
    raise exception 'You can only use your own token';
  end if;
  if ability not in ('str', 'dex', 'con', 'int', 'wis', 'cha') then
    raise exception 'Unknown ability';
  end if;
  if coalesce(array_length(targets, 1), 0) = 0 or array_length(targets, 1) > 30 then
    raise exception 'Choose between 1 and 30 targets';
  end if;
  select * into src from public.tokens where id = source;
  dc := greatest(1, least(40, coalesce(dc, 10)));
  if coalesce(damage, '') <> '' then
    dmg := public.dice_roll(damage, 'normal', false);
    base := greatest((dmg ->> 'total')::int, 0);
  end if;
  any_hidden := src.hidden;
  foreach tid in array targets loop
    if not public.can_see_token(tid) then
      raise exception 'You can''t see one of those targets';
    end if;
    select * into t from public.tokens where id = tid;
    if t.campaign_id <> src.campaign_id then
      raise exception 'That target is not in this campaign';
    end if;
    select * into s from public.token_secrets where token_id = tid;
    bonus := coalesce((s.saves ->> ability)::int, 0);
    sr := public.dice_roll('1d20', 'normal');
    total := (sr ->> 'total')::int + bonus;
    ok := total >= dc;
    dealt := 0;
    if base > 0 and (not ok or half) then
      dealt := public.adjust_damage(case when ok then base / 2 else base end, damage_type, s);
    end if;
    hp := null;
    if dealt > 0 then
      hp := public.change_hp(tid, -dealt, false);
    end if;
    if not ok and coalesce(condition, '') <> '' then
      perform public.set_conditions_internal(tid, condition, true);
    end if;
    any_hidden := any_hidden or t.hidden;
    rows := rows || jsonb_build_object('name', t.name, 'roll', (sr ->> 'nat')::int, 'total', total, 'saved', ok,
                                       'damage', dealt, 'down', coalesce((hp ->> 'down')::boolean, false));
  end loop;
  result := jsonb_build_object('kind', 'save', 'source', src.name, 'ability', ability, 'dc', dc,
                               'damageType', nullif(damage_type, ''), 'condition', nullif(condition, ''),
                               'damageRoll', dmg, 'targets', rows);
  perform public.log_roll(src.campaign_id,
    src.name || ': ' || coalesce(nullif(label, ''), upper(ability) || ' save') || ' (DC ' || dc || ')',
    coalesce(dmg, jsonb_build_object('total', dc, 'expr', '', 'detail', '[]'::jsonb)), 'normal', any_hidden, result);
  return result;
end;
$$;

-- Healing (a spell, a potion...): roll and add hit points.
create or replace function public.heal(healer uuid, target uuid, amount text, label text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h public.tokens%rowtype;
  t public.tokens%rowtype;
  r jsonb;
  hp jsonb;
  result jsonb;
begin
  if not public.can_act_for(healer) then
    raise exception 'You can only heal with your own token';
  end if;
  if not public.can_see_token(target) then
    raise exception 'You can''t see that target';
  end if;
  select * into h from public.tokens where id = healer;
  select * into t from public.tokens where id = target;
  r := public.dice_roll(amount, 'normal', false);
  hp := public.change_hp(target, greatest((r ->> 'total')::int, 0), false);
  result := jsonb_build_object('kind', 'heal', 'source', h.name, 'target', t.name, 'amount', greatest((r ->> 'total')::int, 0));
  perform public.log_roll(h.campaign_id, h.name || ' heals ' || t.name || coalesce(' (' || nullif(label, '') || ')', ''),
                          r, 'normal', h.hidden or t.hidden, result);
  return result;
end;
$$;

-- Directly change hit points (the DM's damage and heal buttons, or a player
-- taking damage from something the site doesn't model). delta < 0 = damage.
create or replace function public.adjust_hp(target uuid, delta int, temp boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tokens%rowtype;
  ch public.characters%rowtype;
begin
  if not public.can_act_for(target) then
    raise exception 'You can only change your own hit points';
  end if;
  select * into t from public.tokens where id = target;
  if temp then
    if t.character_id is null then
      raise exception 'Temporary hit points are for player characters';
    end if;
    select * into ch from public.characters where id = t.character_id for update;
    -- Temporary hit points don't stack: keep the higher amount.
    update public.characters
       set data = jsonb_set(data, '{hp,temp}', to_jsonb(greatest(coalesce(nullif(data -> 'hp' ->> 'temp', '')::int, 0), greatest(delta, 0))), true)
     where id = ch.id;
    return jsonb_build_object('temp', greatest(delta, 0));
  end if;
  return public.change_hp(target, greatest(-9999, least(9999, coalesce(delta, 0))), false);
end;
$$;

/* ----------------------------------------------------------- conditions */

create or replace function public.set_conditions_internal(tid uuid, cond_name text, present boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tokens%rowtype;
begin
  select * into t from public.tokens where id = tid;
  if t.kind = 'pc' and t.character_id is not null then
    update public.characters
       set data = jsonb_set(data, '{conditions}',
                  case when present then public.add_condition(data -> 'conditions', cond_name)
                       else public.remove_condition(data -> 'conditions', cond_name) end, true)
     where id = t.character_id;
  elsif present and not (cond_name = any(t.conditions)) then
    update public.tokens set conditions = array_append(conditions, cond_name) where id = tid;
  elsif not present then
    update public.tokens set conditions = array_remove(conditions, cond_name) where id = tid;
  end if;
end;
$$;

create or replace function public.set_condition(token uuid, name text, present boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.can_act_for(token) then
    raise exception 'You can only change conditions on your own token';
  end if;
  if char_length(coalesce(name, '')) not between 1 and 40 then
    raise exception 'Unknown condition';
  end if;
  perform public.set_conditions_internal(token, name, present);
end;
$$;

/* ---------------------------------------------------------- death saves */

create or replace function public.death_save(token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tokens%rowtype;
  ch public.characters%rowtype;
  d jsonb;
  r jsonb;
  nat int;
  succ int;
  fail int;
  outcome text;
begin
  if not public.can_act_for(token) then
    raise exception 'You can only roll death saves for your own character';
  end if;
  select * into t from public.tokens where id = token;
  if t.character_id is null then
    raise exception 'Only player characters make death saving throws';
  end if;
  select * into ch from public.characters where id = t.character_id for update;
  d := ch.data;
  if coalesce(nullif(d -> 'hp' ->> 'current', '')::int, 1) > 0 then
    raise exception 'Death saving throws are only made at 0 hit points';
  end if;
  if coalesce(d -> 'conditions', '[]'::jsonb) ? 'Dead' then
    raise exception 'This character has died';
  end if;
  r := public.dice_roll('1d20', 'normal');
  nat := (r ->> 'nat')::int;
  succ := coalesce((d -> 'deathSaves' ->> 'successes')::int, 0);
  fail := coalesce((d -> 'deathSaves' ->> 'failures')::int, 0);
  if nat = 20 then
    -- Back on their feet with 1 hit point.
    d := jsonb_set(d, '{hp,current}', '1'::jsonb, true);
    d := jsonb_set(d, '{conditions}', public.remove_condition(d -> 'conditions', 'Unconscious'));
    succ := 0;
    fail := 0;
    outcome := 'Natural 20! Back up with 1 HP';
  elsif nat = 1 then
    fail := fail + 2;
  elsif nat >= 10 then
    succ := succ + 1;
  else
    fail := fail + 1;
  end if;
  if outcome is null then
    if fail >= 3 then
      d := jsonb_set(d, '{conditions}', public.add_condition(d -> 'conditions', 'Dead'));
      outcome := 'Has died';
      fail := 3;
    elsif succ >= 3 then
      outcome := 'Stable';
      succ := 3;
    else
      outcome := succ || ' successes, ' || fail || ' failures';
    end if;
  end if;
  d := jsonb_set(d, '{deathSaves}', jsonb_build_object('successes', succ, 'failures', fail), true);
  update public.characters set data = d where id = ch.id;
  perform public.log_roll(t.campaign_id, t.name || ': Death saving throw', r, 'normal', false,
                          jsonb_build_object('kind', 'death', 'outcome', outcome));
  return jsonb_build_object('roll', nat, 'successes', succ, 'failures', fail, 'outcome', outcome);
end;
$$;

/* ------------------------------------------- spell slots, rests and XP */

-- The character's owner (or the campaign's DM) spends or gets back a spell slot.
create or replace function public.can_edit_character(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.characters c where c.id = cid and c.owner_id = auth.uid())
      or exists (select 1 from public.campaign_members m join public.campaigns c on c.id = m.campaign_id
                 where m.character_id = cid and c.dm_id = auth.uid());
$$;

create or replace function public.use_slot(char_id uuid, level int, used int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.can_edit_character(char_id) then
    raise exception 'You can only change your own character';
  end if;
  if level not between 1 and 9 or used not between 0 and 9 then
    raise exception 'Unknown spell slot';
  end if;
  update public.characters
     set data = jsonb_set(case when jsonb_typeof(data -> 'slotsUsed') = 'object' then data else jsonb_set(data, '{slotsUsed}', '{}'::jsonb, true) end,
                          array['slotsUsed', level::text], to_jsonb(used), true)
   where id = char_id;
end;
$$;

-- Spend one Hit Die on a short rest: roll it, add the Con modifier, heal.
create or replace function public.spend_hit_die(token uuid, die int, con_mod int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tokens%rowtype;
  ch public.characters%rowtype;
  r jsonb;
  amount int;
  lvl int;
begin
  if not public.can_act_for(token) then
    raise exception 'You can only use your own Hit Dice';
  end if;
  select * into t from public.tokens where id = token;
  select * into ch from public.characters where id = t.character_id for update;
  if ch.id is null then
    raise exception 'Only player characters have Hit Dice';
  end if;
  if die not in (6, 8, 10, 12) then
    raise exception 'Unknown Hit Die';
  end if;
  lvl := greatest(1, least(20, coalesce((ch.data ->> 'level')::int, 1)));
  if coalesce((ch.data ->> 'hitDiceSpent')::int, 0) >= lvl then
    raise exception 'No Hit Dice left. They come back on a long rest.';
  end if;
  update public.characters set data = jsonb_set(data, '{hitDiceSpent}', to_jsonb(coalesce((data ->> 'hitDiceSpent')::int, 0) + 1), true)
   where id = ch.id;
  r := public.dice_roll('1d' || die, 'normal');
  amount := greatest(1, (r ->> 'total')::int + greatest(-5, least(10, coalesce(con_mod, 0))));
  perform public.change_hp(token, amount, false);
  perform public.log_roll(t.campaign_id, t.name || ': Hit Die', r || jsonb_build_object('total', amount), 'normal', false,
                          jsonb_build_object('kind', 'heal', 'source', t.name, 'target', t.name, 'amount', amount));
  return jsonb_build_object('healed', amount);
end;
$$;

-- The DM calls a short or long rest for the whole party.
create or replace function public.party_rest(cid uuid, kind text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  m record;
  d jsonb;
  hp_max int;
  n int := 0;
begin
  if not public.is_campaign_dm(cid) then
    raise exception 'Only the DM can call a rest';
  end if;
  if kind not in ('short', 'long') then
    raise exception 'Unknown rest';
  end if;
  for m in
    select ch.id, ch.data,
           (select s.hp_max from public.tokens t join public.token_secrets s on s.token_id = t.id
             where t.character_id = ch.id and t.campaign_id = cid and s.hp_max is not null limit 1) as hp_max
      from public.campaign_members cm join public.characters ch on ch.id = cm.character_id
     where cm.campaign_id = cid
  loop
    d := m.data;
    if coalesce(d -> 'conditions', '[]'::jsonb) ? 'Dead' then
      continue;
    end if;
    if kind = 'long' then
      -- Back to full HP (blank = full), all Hit Dice and spell slots back, one less Exhaustion.
      d := jsonb_set(d, '{hp}', jsonb_build_object('current', m.hp_max, 'temp', 0), true);
      d := jsonb_set(d, '{hitDiceSpent}', '0'::jsonb, true);
      d := jsonb_set(d, '{slotsUsed}', '{}'::jsonb, true);
      d := jsonb_set(d, '{deathSaves}', '{"successes": 0, "failures": 0}'::jsonb, true);
      d := jsonb_set(d, '{exhaustion}', to_jsonb(greatest(0, coalesce((d ->> 'exhaustion')::int, 0) - 1)), true);
      d := jsonb_set(d, '{conditions}', public.remove_condition(d -> 'conditions', 'Unconscious'));
    elsif d ->> 'classId' = 'warlock' then
      -- Warlocks get their Pact Magic slots back on a short rest.
      d := jsonb_set(d, '{slotsUsed}', '{}'::jsonb, true);
    end if;
    update public.characters set data = d where id = m.id;
    n := n + 1;
  end loop;
  perform public.log_roll(cid, case when kind = 'long' then 'The party takes a long rest' else 'The party takes a short rest' end,
                          jsonb_build_object('total', 0, 'expr', '', 'detail', '[]'::jsonb), 'normal', false,
                          jsonb_build_object('kind', 'rest', 'rest', kind));
  return n;
end;
$$;

-- The DM gives experience points, split evenly across the party's characters.
create or replace function public.award_xp(cid uuid, amount int)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
  each_xp int;
begin
  if not public.is_campaign_dm(cid) then
    raise exception 'Only the DM can award XP';
  end if;
  amount := greatest(0, least(1000000, coalesce(amount, 0)));
  select count(*) into n from public.campaign_members where campaign_id = cid and role = 'player' and character_id is not null;
  if n = 0 or amount = 0 then
    return 0;
  end if;
  each_xp := amount / n;
  update public.characters ch
     set data = jsonb_set(data, '{xp}', to_jsonb(coalesce((data ->> 'xp')::int, 0) + each_xp), true)
   where ch.id in (select character_id from public.campaign_members where campaign_id = cid and role = 'player' and character_id is not null);
  perform public.log_roll(cid, 'Each character gains ' || each_xp || ' XP',
                          jsonb_build_object('total', each_xp, 'expr', '', 'detail', '[]'::jsonb), 'normal', false,
                          jsonb_build_object('kind', 'xp', 'each', each_xp));
  return each_xp;
end;
$$;

/* --------------------------------------------------------- permissions */
-- Internal helpers can't be called from the browser.
revoke all on function public.dice_roll(text, text, boolean) from public, anon, authenticated;
revoke all on function public.log_roll(uuid, text, jsonb, text, boolean, jsonb) from public, anon, authenticated;
revoke all on function public.adjust_damage(int, text, public.token_secrets) from public, anon, authenticated;
revoke all on function public.change_hp(uuid, int, boolean) from public, anon, authenticated;
revoke all on function public.set_conditions_internal(uuid, text, boolean) from public, anon, authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.roll_initiative(uuid, int, text)', 'public.combat_start(uuid)', 'public.combat_end(uuid)',
    'public.combat_next(uuid)', 'public.attack(uuid, uuid, int, text, text, text, text, jsonb)',
    'public.saving_throw(uuid, uuid[], text, int, text, text, boolean, text, text)',
    'public.heal(uuid, uuid, text, text)', 'public.adjust_hp(uuid, int, boolean)',
    'public.set_condition(uuid, text, boolean)', 'public.death_save(uuid)',
    'public.use_slot(uuid, int, int)', 'public.spend_hit_die(uuid, int, int)',
    'public.party_rest(uuid, text)', 'public.award_xp(uuid, int)',
    'public.can_see_token(uuid)', 'public.can_act_for(uuid)', 'public.can_edit_character(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ===================================================== 0005_turns.sql

-- Step 5: turns in combat.
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Run 0001 to 0004 first. It is safe to run more than once.
--
-- During combat each creature gets, on its turn, one action, one bonus
-- action and its speed in movement, plus one reaction per round (it comes
-- back at the start of its turn). The database keeps count, so players can
-- only act and move on their own turn and only as much as the rules allow.
-- The DM is never blocked: the site only records what their creatures used,
-- as a reminder.

/* --------------------------------------------------------------- columns */

-- What a creature has used this turn: {actions_used, actions, attacks_left,
-- bonus, reaction, moved, dash, surged, slot_spell, bonus_spell}.
-- Missing keys mean "nothing used yet".
alter table public.tokens add column if not exists turn jsonb not null default '{}'::jsonb;

-- What a creature can do, written by the DM's browser from the character
-- sheet or stat block: {speed, attacks, level, actionSurge, secondWind,
-- rage, slots: {"1": 4, ...}}. Players can't change it.
alter table public.tokens add column if not exists stats jsonb not null default '{}'::jsonb;

/* -------------------------------------------------------------- helpers */

create or replace function public.jint(j jsonb, k text, d int default 0)
returns int
language sql
immutable
set search_path = ''
as $$
  select coalesce(case when jsonb_typeof(j -> k) = 'number' then (j ->> k)::numeric::int end, d);
$$;

create or replace function public.jbool(j jsonb, k text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(case when jsonb_typeof(j -> k) = 'boolean' then (j ->> k)::boolean end, false);
$$;

-- Conditions that stop a creature from taking actions, bonus actions and reactions.
create or replace function public.incapacitating(conds text[])
returns text
language sql
immutable
set search_path = ''
as $$
  select c from unnest(coalesce(conds, '{}')) c
   where c in ('Dead', 'Unconscious', 'Petrified', 'Paralyzed', 'Stunned', 'Incapacitated') limit 1;
$$;

-- A creature's speed in feet right now: 0 while Grappled, Restrained,
-- Paralyzed, Petrified, Unconscious or dead.
create or replace function public.move_speed(t public.tokens)
returns int
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(t.conditions, '{}') && array['Dead', 'Unconscious', 'Petrified', 'Paralyzed', 'Grappled', 'Restrained'] then 0
    else greatest(0, least(200, public.jint(t.stats, 'speed', 30)))
  end;
$$;

-- Which of those conditions is keeping a creature still (for messages).
create or replace function public.held_by(conds text[])
returns text
language sql
immutable
set search_path = ''
as $$
  select c from unnest(coalesce(conds, '{}')) c
   where c in ('Dead', 'Unconscious', 'Petrified', 'Paralyzed', 'Grappled', 'Restrained') limit 1;
$$;

-- Spend a spell slot for a token's character. Players are stopped when they
-- have none left of that level.
create or replace function public.spend_slot(tid uuid, slot int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tokens%rowtype;
  ch public.characters%rowtype;
  have int;
  used int;
begin
  if coalesce(slot, 0) = 0 then
    return;
  end if;
  if slot not between 1 and 9 then
    raise exception 'Unknown spell slot';
  end if;
  select * into t from public.tokens where id = tid;
  if t.character_id is null then
    return; -- the DM's creatures don't track slots here
  end if;
  select * into ch from public.characters where id = t.character_id for update;
  have := public.jint(t.stats -> 'slots', slot::text, -1);
  used := public.jint(ch.data -> 'slotsUsed', slot::text, 0);
  if have >= 0 and used >= have and not public.is_campaign_dm(t.campaign_id) then
    raise exception 'You have no level % spell slots left. They come back when you rest.', slot;
  end if;
  update public.characters
     set data = jsonb_set(case when jsonb_typeof(data -> 'slotsUsed') = 'object' then data else jsonb_set(data, '{slotsUsed}', '{}'::jsonb, true) end,
                          array['slotsUsed', slot::text], to_jsonb(used + 1), true)
   where id = ch.id;
end;
$$;

-- Use part of a creature's turn: 'action', 'bonus' (bonus action),
-- 'reaction', or 'attack' (one attack of the Attack action; Extra Attack
-- gives more than one per action). spell = this is a spell being cast,
-- slot = the spell slot it uses (0 for a cantrip or no spell).
-- Outside combat nothing is counted, but spell slots are still spent.
create or replace function public.spend_turn(tid uuid, use text, slot int default 0, spell boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tokens%rowtype;
  c public.campaigns%rowtype;
  dm boolean;
  tr jsonb;
  was_attack boolean := false;
  why text;
begin
  if use is null or use not in ('action', 'bonus', 'reaction', 'attack') then
    raise exception 'Unknown kind of action';
  end if;
  select * into t from public.tokens where id = tid for update;
  select * into c from public.campaigns where id = t.campaign_id;
  dm := public.is_campaign_dm(t.campaign_id);
  tr := coalesce(t.turn, '{}'::jsonb);

  if c.combat_round is not null and not dm then
    why := public.incapacitating(t.conditions);
    if why is not null then
      raise exception '% can''t act while %.', t.name, lower(why);
    end if;
    if use = 'reaction' then
      if public.jbool(tr, 'reaction') then
        raise exception 'You''ve already used your reaction. It comes back at the start of your turn.';
      end if;
    elsif c.combat_turn is null then
      raise exception 'Combat has started. Wait for your turn.';
    elsif c.combat_turn <> t.id then
      raise exception 'It isn''t your turn. Wait for your turn to act.';
    end if;
  end if;

  if c.combat_round is not null then
    if use = 'attack' then
      if public.jint(tr, 'attacks_left') > 0 then
        tr := tr || jsonb_build_object('attacks_left', public.jint(tr, 'attacks_left') - 1);
      else
        use := 'action';
        was_attack := true;
      end if;
    end if;
    if use = 'action' then
      if not dm and public.jint(tr, 'actions_used') >= public.jint(tr, 'actions', 1) then
        raise exception 'You''ve already used your action this turn.';
      end if;
      tr := tr || jsonb_build_object('actions_used', public.jint(tr, 'actions_used') + 1,
                                     'attacks_left', case when was_attack then greatest(0, least(8, public.jint(t.stats, 'attacks', 1)) - 1) else 0 end);
    elsif use = 'bonus' then
      if not dm and public.jbool(tr, 'bonus') then
        raise exception 'You''ve already used your bonus action this turn.';
      end if;
      tr := tr || '{"bonus": true}'::jsonb;
    elsif use = 'reaction' then
      tr := tr || '{"reaction": true}'::jsonb;
    end if;
    -- Casting a spell with a bonus action means the only other spell you can
    -- cast that turn is a cantrip (and the other way round).
    if spell and use in ('action', 'bonus') and coalesce(slot, 0) > 0 then
      if not dm and public.jbool(tr, 'slot_spell') and (public.jbool(tr, 'bonus_spell') or use = 'bonus') then
        raise exception 'You''ve cast a spell with a bonus action this turn, so the only other spell you can cast is a cantrip.';
      end if;
      tr := tr || '{"slot_spell": true}'::jsonb;
    end if;
    if spell and use = 'bonus' then
      tr := tr || '{"bonus_spell": true}'::jsonb;
    end if;
    update public.tokens set turn = tr where id = tid;
  end if;

  perform public.spend_slot(tid, slot);
end;
$$;

-- Movement left this turn (feet). Dash adds the creature's speed again.
create or replace function public.movement_left(t public.tokens)
returns int
language sql
immutable
set search_path = ''
as $$
  select public.move_speed(t) * (1 + public.jint(t.turn, 'dash')) - public.jint(t.turn, 'moved');
$$;

/* -------------------------------------------------------------- moving */

-- Move a token. The DM can move any token any distance. In combat a player
-- can only move on their turn, 5 feet per square (diagonals too), up to
-- their speed; crawling while Prone costs double. Player characters reveal
-- the fog around where they stop.
create or replace function public.move_token(token uuid, nx int, ny int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tokens%rowtype;
  m public.maps%rowtype;
  c public.campaigns%rowtype;
  dm boolean;
  cost int;
  lft int;
  why text;
begin
  select * into t from public.tokens where id = token for update;
  if not found then
    raise exception 'Token not found';
  end if;
  select * into m from public.maps where id = t.map_id;
  select * into c from public.campaigns where id = t.campaign_id;
  dm := public.is_campaign_dm(t.campaign_id);
  if not dm then
    if t.owner_id is distinct from auth.uid() or not public.is_campaign_member(t.campaign_id) or not public.is_active_map(t.map_id) then
      raise exception 'You can only move your own token';
    end if;
  end if;
  nx := greatest(0, least(m.cols - t.size, nx));
  ny := greatest(0, least(m.rows - t.size, ny));
  if nx = t.x and ny = t.y then
    return;
  end if;
  if c.combat_round is not null and t.map_id = c.active_map_id then
    cost := greatest(abs(nx - t.x), abs(ny - t.y)) * 5;
    if 'Prone' = any(t.conditions) then
      cost := cost * 2;
    end if;
    if not dm then
      if c.combat_turn is distinct from t.id then
        raise exception 'You can only move on your turn.';
      end if;
      why := public.held_by(t.conditions);
      if why is not null then
        raise exception '% can''t move while %.', t.name, lower(why);
      end if;
      lft := public.movement_left(t);
      if cost > lft then
        raise exception 'That''s % ft away. You have % ft of movement left this turn.', cost, greatest(lft, 0);
      end if;
    end if;
    -- Count it against the creature's turn (not when the DM shoves a player around).
    if c.combat_turn = t.id and (not dm or t.kind <> 'pc') then
      update public.tokens set turn = turn || jsonb_build_object('moved', public.jint(turn, 'moved') + cost) where id = token;
    end if;
  end if;
  update public.tokens set x = nx, y = ny where id = token;
  if t.kind = 'pc' and m.vision > 0 then
    perform public.reveal_circle(m.id, nx + (t.size - 1) / 2, ny + (t.size - 1) / 2, m.vision);
  end if;
end;
$$;

/* --------------------------------------------------------- the turn order */

create or replace function public.combat_start(cid uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_campaign_dm(cid) then
    raise exception 'Only the DM can start combat';
  end if;
  update public.tokens set initiative = null, turn = '{}'::jsonb
   where campaign_id = cid and (initiative is not null or turn <> '{}'::jsonb);
  update public.campaigns set combat_round = 1, combat_turn = null, version = version + 1, last_change = 'campaigns' where id = cid;
end;
$$;

create or replace function public.combat_end(cid uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_campaign_dm(cid) then
    raise exception 'Only the DM can end combat';
  end if;
  update public.campaigns set combat_round = null, combat_turn = null, version = version + 1, last_change = 'campaigns' where id = cid;
  update public.tokens set initiative = null, turn = '{}'::jsonb
   where campaign_id = cid and (initiative is not null or turn <> '{}'::jsonb);
end;
$$;

-- Move to the next creature in initiative order, skipping the dead. The DM
-- can always do this; a player can end their own turn. The creature whose
-- turn starts gets its action, bonus action, reaction and movement back.
create or replace function public.combat_next(cid uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.campaigns%rowtype;
  ids uuid[];
  pos int;
  n int;
  i int;
  nxt uuid;
  rnd int;
begin
  select * into c from public.campaigns where id = cid for update;
  if c.combat_round is null then
    raise exception 'There is no combat going on';
  end if;
  if not public.is_campaign_dm(cid) and not (c.combat_turn is not null and exists (
      select 1 from public.tokens t where t.id = c.combat_turn and t.owner_id = auth.uid())) then
    raise exception 'It isn''t your turn';
  end if;
  ids := array(
    select t.id from public.tokens t
    where t.campaign_id = cid and t.map_id = c.active_map_id and t.initiative is not null
      and not ('Dead' = any(t.conditions))
    order by t.initiative desc, t.created_at, t.id);
  n := coalesce(array_length(ids, 1), 0);
  if n = 0 then
    update public.campaigns set combat_turn = null, version = version + 1, last_change = 'campaigns' where id = cid;
    return null;
  end if;
  pos := array_position(ids, c.combat_turn);
  rnd := c.combat_round;
  if c.combat_turn is null then
    nxt := ids[1];
  elsif pos is null then
    select t.id into nxt from public.tokens t
     where t.id = any(ids)
       and (t.initiative < coalesce((select initiative from public.tokens where id = c.combat_turn), 999))
     order by t.initiative desc, t.created_at, t.id limit 1;
    if nxt is null then
      nxt := ids[1];
      rnd := rnd + 1;
    end if;
  else
    i := pos + 1;
    if i > n then
      i := 1;
      rnd := rnd + 1;
    end if;
    nxt := ids[i];
  end if;
  update public.tokens set turn = '{}'::jsonb where id = nxt;
  update public.campaigns set combat_turn = nxt, combat_round = rnd, version = version + 1, last_change = 'campaigns' where id = cid;
  return nxt;
end;
$$;

/* ------------------------------------------------------- damage */

-- Resistance halves, immunity cancels, vulnerability doubles (by damage type).
-- A raging creature resists Bludgeoning, Piercing and Slashing.
create or replace function public.adjust_damage(amount int, dtype text, s public.token_secrets)
returns int
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t text := lower(trim(coalesce(dtype, '')));
begin
  if amount <= 0 or t = '' or s.token_id is null then
    return greatest(amount, 0);
  end if;
  if exists (select 1 from unnest(s.immune) x where lower(x) = t) then
    return 0;
  end if;
  if exists (select 1 from unnest(s.resist) x where lower(x) = t)
     or (t in ('bludgeoning', 'piercing', 'slashing')
         and exists (select 1 from public.tokens k where k.id = s.token_id and 'Raging' = any(k.conditions))) then
    amount := amount / 2;
  end if;
  if exists (select 1 from unnest(s.vulnerable) x where lower(x) = t) then
    amount := amount * 2;
  end if;
  return amount;
end;
$$;

/* ------------------------------------------------------- attacks */

-- Attack one or more targets (Scorching Ray's rays, Eldritch Blast's beams;
-- the same target can be listed more than once). Each one is its own attack
-- roll against the target's Armor Class and, on a hit, its own damage roll.
-- The roll log gets a line for the attack (hit or miss) and, on a hit, a
-- separate line for the damage. auto = the spell always hits (Magic Missile).
-- use: 'attack' (a weapon attack), 'action' or 'bonus' (casting a spell),
-- 'reaction'. slot = the spell slot it uses.
drop function if exists public.attack(uuid, uuid, int, text, text, text, text, jsonb);
create or replace function public.attack(
  attacker uuid, targets uuid[], bonus int, damage text default '', damage_type text default '',
  mode text default 'normal', label text default '', extra jsonb default '[]'::jsonb,
  use text default 'attack', slot int default 0, spell boolean default false, auto boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.tokens%rowtype;
  t public.tokens%rowtype;
  s public.token_secrets%rowtype;
  target uuid;
  r jsonb;
  nat int;
  total int;
  ac int;
  hit boolean;
  crit boolean;
  dmg jsonb;
  rolled int;
  dealt int;
  hp jsonb;
  what text;
  one jsonb;
  results jsonb := '[]'::jsonb;
  part jsonb;
  more jsonb;
  extras jsonb;
  expr text;
  detail jsonb;
  secret boolean;
begin
  if not public.can_act_for(attacker) then
    raise exception 'You can only attack with your own token';
  end if;
  if coalesce(array_length(targets, 1), 0) = 0 or array_length(targets, 1) > 10 then
    raise exception 'Choose between 1 and 10 targets';
  end if;
  select * into a from public.tokens where id = attacker;
  perform public.spend_turn(attacker, use, slot, spell);
  bonus := greatest(-10, least(30, coalesce(bonus, 0)));
  what := coalesce(nullif(label, ''), 'Attack');
  foreach target in array targets loop
    if not public.can_see_token(target) then
      raise exception 'You can''t see that target';
    end if;
    select * into t from public.tokens where id = target;
    if a.campaign_id <> t.campaign_id then
      raise exception 'That target is not in this campaign';
    end if;
    select * into s from public.token_secrets where token_id = target;
    secret := a.hidden or t.hidden;
    if auto then
      hit := true;
      crit := false;
    else
      ac := coalesce(s.ac, 10);
      r := public.dice_roll('1d20', mode);
      nat := (r ->> 'nat')::int;
      total := nat + bonus;
      crit := nat = 20;
      hit := nat = 20 or (nat <> 1 and total >= ac);
      r := r || jsonb_build_object('total', total, 'expr', '1d20' || case when bonus >= 0 then '+' else '' end || bonus,
                                   'detail', (r -> 'detail') || jsonb_build_array(jsonb_build_object('value', abs(bonus), 'sign', sign(bonus)::int)));
      perform public.log_roll(a.campaign_id, a.name || ' attacks ' || t.name || ' (' || what || ')', r, mode, secret,
        jsonb_build_object('kind', 'attack', 'attacker', a.name, 'target', t.name, 'hit', hit, 'crit', crit));
    end if;
    dmg := null;
    dealt := 0;
    hp := null;
    extras := '[]'::jsonb;
    if hit and coalesce(damage, '') <> '' then
      dmg := public.dice_roll(damage, 'normal', crit);
      rolled := greatest((dmg ->> 'total')::int, 0);
      dealt := public.adjust_damage(rolled, damage_type, s);
      expr := dmg ->> 'expr';
      detail := dmg -> 'detail';
      -- Extra damage of other types (e.g. a ghoul's bite: Piercing plus Necrotic).
      if jsonb_typeof(extra) = 'array' then
        for part in select * from jsonb_array_elements(extra) limit 4 loop
          more := public.dice_roll(part ->> 'dice', 'normal', crit);
          rolled := rolled + greatest((more ->> 'total')::int, 0);
          dealt := dealt + public.adjust_damage(greatest((more ->> 'total')::int, 0), part ->> 'type', s);
          extras := extras || jsonb_build_object('type', part ->> 'type', 'roll', more);
          expr := expr || '+' || (more ->> 'expr');
          detail := detail || (more -> 'detail');
        end loop;
      end if;
      if dealt > 0 then
        hp := public.change_hp(target, -dealt, crit);
      end if;
      perform public.log_roll(a.campaign_id, t.name || ' takes damage (' || what || ')',
        jsonb_build_object('total', rolled, 'expr', expr, 'detail', detail), 'normal', secret,
        jsonb_build_object('kind', 'damage', 'attacker', a.name, 'target', t.name, 'crit', crit, 'damage', dealt, 'rolled', rolled,
                           'damageType', nullif(damage_type, ''), 'extra', (select coalesce(jsonb_agg(e ->> 'type'), '[]'::jsonb) from jsonb_array_elements(extras) e),
                           'down', coalesce((hp ->> 'down')::boolean, false), 'dead', coalesce((hp ->> 'dead')::boolean, false)));
    end if;
    one := jsonb_build_object(
      'kind', 'attack', 'attacker', a.name, 'target', t.name, 'hit', hit, 'crit', crit, 'auto', auto,
      'damage', dealt, 'damageType', nullif(damage_type, ''), 'damageRoll', dmg, 'extra', extras,
      'down', coalesce((hp ->> 'down')::boolean, false), 'dead', coalesce((hp ->> 'dead')::boolean, false));
    results := results || one;
  end loop;
  if jsonb_array_length(results) = 1 then
    return results -> 0;
  end if;
  return jsonb_build_object('kind', 'attacks', 'attacker', a.name, 'results', results);
end;
$$;

-- Several creatures make a saving throw against a DC (e.g. Fireball).
-- Damage is rolled once: full on a failed save, half on a success when the
-- effect allows it. A condition (e.g. Frightened) is added on a failed save.
-- area = the spell's shape on the map, so every screen can show it.
drop function if exists public.saving_throw(uuid, uuid[], text, int, text, text, boolean, text, text);
create or replace function public.saving_throw(
  source uuid, targets uuid[], ability text, dc int, damage text default '', damage_type text default '',
  half boolean default true, condition text default '', label text default '',
  use text default 'action', slot int default 0, spell boolean default false, area jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  src public.tokens%rowtype;
  t public.tokens%rowtype;
  s public.token_secrets%rowtype;
  dmg jsonb := null;
  base int := 0;
  sr jsonb;
  bonus int;
  total int;
  ok boolean;
  dealt int;
  hp jsonb;
  rows jsonb := '[]'::jsonb;
  any_hidden boolean := false;
  tid uuid;
  result jsonb;
begin
  if not public.can_act_for(source) then
    raise exception 'You can only use your own token';
  end if;
  if ability not in ('str', 'dex', 'con', 'int', 'wis', 'cha') then
    raise exception 'Unknown ability';
  end if;
  if coalesce(array_length(targets, 1), 0) > 30 then
    raise exception 'Choose up to 30 targets';
  end if;
  if area is not null and (jsonb_typeof(area) <> 'object' or char_length(area::text) > 400) then
    area := null;
  end if;
  if coalesce(array_length(targets, 1), 0) = 0 and area is null then
    raise exception 'Choose at least one target';
  end if;
  select * into src from public.tokens where id = source;
  perform public.spend_turn(source, use, slot, spell);
  dc := greatest(1, least(40, coalesce(dc, 10)));
  if coalesce(damage, '') <> '' then
    dmg := public.dice_roll(damage, 'normal', false);
    base := greatest((dmg ->> 'total')::int, 0);
  end if;
  any_hidden := src.hidden;
  foreach tid in array coalesce(targets, '{}') loop
    if not public.can_see_token(tid) then
      raise exception 'You can''t see one of those targets';
    end if;
    select * into t from public.tokens where id = tid;
    if t.campaign_id <> src.campaign_id then
      raise exception 'That target is not in this campaign';
    end if;
    select * into s from public.token_secrets where token_id = tid;
    bonus := coalesce((s.saves ->> ability)::int, 0);
    sr := public.dice_roll('1d20', 'normal');
    total := (sr ->> 'total')::int + bonus;
    ok := total >= dc;
    dealt := 0;
    if base > 0 and (not ok or half) then
      dealt := public.adjust_damage(case when ok then base / 2 else base end, damage_type, s);
    end if;
    hp := null;
    if dealt > 0 then
      hp := public.change_hp(tid, -dealt, false);
    end if;
    if not ok and coalesce(condition, '') <> '' then
      perform public.set_conditions_internal(tid, condition, true);
    end if;
    any_hidden := any_hidden or t.hidden;
    rows := rows || jsonb_build_object('name', t.name, 'roll', (sr ->> 'nat')::int, 'total', total, 'saved', ok,
                                       'damage', dealt, 'down', coalesce((hp ->> 'down')::boolean, false));
  end loop;
  result := jsonb_build_object('kind', 'save', 'source', src.name, 'ability', ability, 'dc', dc,
                               'damageType', nullif(damage_type, ''), 'condition', nullif(condition, ''),
                               'damageRoll', dmg, 'targets', rows, 'area', area, 'map', src.map_id);
  perform public.log_roll(src.campaign_id,
    src.name || ': ' || coalesce(nullif(label, ''), upper(ability) || ' save') || ' (DC ' || dc || ')',
    coalesce(dmg, jsonb_build_object('total', dc, 'expr', '', 'detail', '[]'::jsonb)), 'normal', any_hidden, result);
  return result;
end;
$$;

-- Healing (a spell, a potion...): roll once and give each target that many hit points.
drop function if exists public.heal(uuid, uuid, text, text);
create or replace function public.heal(
  healer uuid, targets uuid[], amount text, label text default '',
  use text default 'action', slot int default 0, spell boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  h public.tokens%rowtype;
  t public.tokens%rowtype;
  r jsonb;
  tid uuid;
  n int;
  names text[] := '{}';
  secret boolean;
  result jsonb;
begin
  if not public.can_act_for(healer) then
    raise exception 'You can only heal with your own token';
  end if;
  if coalesce(array_length(targets, 1), 0) = 0 or array_length(targets, 1) > 12 then
    raise exception 'Choose between 1 and 12 creatures to heal';
  end if;
  select * into h from public.tokens where id = healer;
  perform public.spend_turn(healer, use, slot, spell);
  r := public.dice_roll(amount, 'normal', false);
  n := greatest((r ->> 'total')::int, 0);
  secret := h.hidden;
  foreach tid in array targets loop
    if not public.can_see_token(tid) then
      raise exception 'You can''t see that target';
    end if;
    select * into t from public.tokens where id = tid;
    if t.campaign_id <> h.campaign_id then
      raise exception 'That target is not in this campaign';
    end if;
    perform public.change_hp(tid, n, false);
    names := names || t.name;
    secret := secret or t.hidden;
  end loop;
  result := jsonb_build_object('kind', 'heal', 'source', h.name, 'target', array_to_string(names, ', '), 'amount', n);
  perform public.log_roll(h.campaign_id, h.name || ' heals ' || array_to_string(names, ', ') || coalesce(' (' || nullif(label, '') || ')', ''),
                          r, 'normal', secret, result);
  return result;
end;
$$;

/* ------------------------------------------------- other things to do */

-- what:
--   'dash', 'disengage', 'dodge', 'hide', 'help', 'ready': the standard
--     actions (use = 'bonus' for a Rogue's Cunning Action).
--   'stand': stand up from Prone, using half your speed.
--   'spell': cast a spell that doesn't target anyone (Shield, Misty Step...).
--   'action_surge', 'second_wind', 'rage', 'end_rage': class features.
create or replace function public.combat_action(token uuid, what text, use text default 'action', slot int default 0, label text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tokens%rowtype;
  c public.campaigns%rowtype;
  ch public.characters%rowtype;
  dm boolean;
  key text;
  most int;
  used int;
  r jsonb;
  amount int;
  cost int;
  line text;
  result jsonb := jsonb_build_object('kind', 'action', 'what', what);
begin
  if not public.can_act_for(token) then
    raise exception 'You can only act for your own token';
  end if;
  select * into t from public.tokens where id = token;
  select * into c from public.campaigns where id = t.campaign_id;
  dm := public.is_campaign_dm(t.campaign_id);
  label := left(coalesce(nullif(trim(label), ''), ''), 80);

  if what in ('dash', 'disengage', 'dodge', 'hide', 'help', 'ready') then
    perform public.spend_turn(token, use, 0, false);
    if what = 'dash' then
      update public.tokens set turn = turn || jsonb_build_object('dash', public.jint(turn, 'dash') + 1) where id = token;
    end if;
    line := t.name || ' takes the ' || initcap(what) || ' action' || case when use = 'bonus' then ' (bonus action)' else '' end;

  elsif what = 'stand' then
    if not ('Prone' = any(t.conditions)) then
      raise exception '% isn''t Prone.', t.name;
    end if;
    if c.combat_round is not null then
      cost := public.move_speed(t) / 2;
      if not dm then
        if c.combat_turn is distinct from t.id then
          raise exception 'You can only stand up on your turn.';
        end if;
        if public.move_speed(t) = 0 then
          raise exception '% can''t stand up while their speed is 0.', t.name;
        end if;
        if cost > public.movement_left(t) then
          raise exception 'Standing up takes % ft of movement. You have % ft left.', cost, greatest(public.movement_left(t), 0);
        end if;
      end if;
      if c.combat_turn = t.id then
        update public.tokens set turn = turn || jsonb_build_object('moved', public.jint(turn, 'moved') + cost) where id = token;
      end if;
    end if;
    perform public.set_conditions_internal(token, 'Prone', false);
    line := t.name || ' stands up';

  elsif what = 'spell' then
    if label = '' then
      raise exception 'Which spell?';
    end if;
    perform public.spend_turn(token, use, slot, true);
    line := t.name || ' casts ' || label || case when use = 'bonus' then ' (bonus action)' when use = 'reaction' then ' (reaction)' else '' end;

  elsif what in ('action_surge', 'second_wind', 'rage') then
    key := case what when 'action_surge' then 'actionSurge' when 'second_wind' then 'secondWind' else 'rage' end;
    most := public.jint(t.stats, key, 0);
    if most <= 0 then
      raise exception '% doesn''t have %.', t.name, initcap(replace(what, '_', ' '));
    end if;
    select * into ch from public.characters where id = t.character_id for update;
    used := public.jint(ch.data -> 'featureUses', key, 0);
    if used >= most and not dm then
      raise exception 'No uses of % left. They come back when you rest.', initcap(replace(what, '_', ' '));
    end if;
    if what = 'action_surge' then
      if c.combat_round is not null and not dm then
        if c.combat_turn is distinct from t.id then
          raise exception 'You can only use Action Surge on your turn.';
        end if;
        if public.jbool(t.turn, 'surged') then
          raise exception 'You can only use Action Surge once per turn.';
        end if;
      end if;
      if c.combat_round is not null then
        update public.tokens set turn = turn || jsonb_build_object('actions', public.jint(turn, 'actions', 1) + 1, 'surged', true) where id = token;
      end if;
      line := t.name || ' uses Action Surge and gets another action';
    elsif what = 'second_wind' then
      perform public.spend_turn(token, 'bonus', 0, false);
      r := public.dice_roll('1d10', 'normal');
      amount := (r ->> 'total')::int + greatest(1, least(20, public.jint(t.stats, 'level', 1)));
      perform public.change_hp(token, amount, false);
      result := result || jsonb_build_object('kind', 'heal', 'source', t.name, 'target', t.name, 'amount', amount);
      r := r || jsonb_build_object('total', amount, 'expr', '1d10+' || greatest(1, least(20, public.jint(t.stats, 'level', 1))));
      line := t.name || ' uses Second Wind';
    else
      if 'Raging' = any(t.conditions) then
        raise exception '% is already raging.', t.name;
      end if;
      perform public.spend_turn(token, 'bonus', 0, false);
      perform public.set_conditions_internal(token, 'Raging', true);
      line := t.name || ' flies into a Rage (resists Bludgeoning, Piercing and Slashing)';
    end if;
    if ch.id is not null then
      update public.characters
         set data = jsonb_set(case when jsonb_typeof(data -> 'featureUses') = 'object' then data else jsonb_set(data, '{featureUses}', '{}'::jsonb, true) end,
                              array['featureUses', key], to_jsonb(used + 1), true)
       where id = ch.id;
    end if;

  elsif what = 'end_rage' then
    perform public.set_conditions_internal(token, 'Raging', false);
    line := t.name || '''s Rage ends';

  else
    raise exception 'Unknown action';
  end if;

  perform public.log_roll(t.campaign_id, line,
    coalesce(r, jsonb_build_object('total', 0, 'expr', '', 'detail', '[]'::jsonb)), 'normal', t.hidden, result);
  -- Tell the table to refresh even when only the turn changed.
  update public.campaigns set version = version + 1, last_change = 'tokens' where id = t.campaign_id;
  return result;
end;
$$;

/* ---------------------------------------------------------------- rests */

-- The DM calls a short or long rest for the whole party. Also gives back
-- Action Surge, Second Wind and Rage.
create or replace function public.party_rest(cid uuid, kind text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  m record;
  d jsonb;
  u jsonb;
  n int := 0;
begin
  if not public.is_campaign_dm(cid) then
    raise exception 'Only the DM can call a rest';
  end if;
  if kind not in ('short', 'long') then
    raise exception 'Unknown rest';
  end if;
  for m in
    select ch.id, ch.data,
           (select s.hp_max from public.tokens t join public.token_secrets s on s.token_id = t.id
             where t.character_id = ch.id and t.campaign_id = cid and s.hp_max is not null limit 1) as hp_max
      from public.campaign_members cm join public.characters ch on ch.id = cm.character_id
     where cm.campaign_id = cid
  loop
    d := m.data;
    if coalesce(d -> 'conditions', '[]'::jsonb) ? 'Dead' then
      continue;
    end if;
    u := case when jsonb_typeof(d -> 'featureUses') = 'object' then d -> 'featureUses' else '{}'::jsonb end;
    if kind = 'long' then
      d := jsonb_set(d, '{hp}', jsonb_build_object('current', m.hp_max, 'temp', 0), true);
      d := jsonb_set(d, '{hitDiceSpent}', '0'::jsonb, true);
      d := jsonb_set(d, '{slotsUsed}', '{}'::jsonb, true);
      d := jsonb_set(d, '{deathSaves}', '{"successes": 0, "failures": 0}'::jsonb, true);
      d := jsonb_set(d, '{exhaustion}', to_jsonb(greatest(0, coalesce((d ->> 'exhaustion')::int, 0) - 1)), true);
      d := jsonb_set(d, '{conditions}', public.remove_condition(public.remove_condition(d -> 'conditions', 'Unconscious'), 'Raging'));
      u := '{}'::jsonb;
    else
      if d ->> 'classId' = 'warlock' then
        d := jsonb_set(d, '{slotsUsed}', '{}'::jsonb, true);
      end if;
      -- Action Surge comes back; Second Wind and Rage get one use back.
      u := u || jsonb_build_object('actionSurge', 0,
                                   'secondWind', greatest(0, public.jint(u, 'secondWind') - 1),
                                   'rage', greatest(0, public.jint(u, 'rage') - 1));
    end if;
    d := jsonb_set(d, '{featureUses}', u, true);
    update public.characters set data = d where id = m.id;
    n := n + 1;
  end loop;
  perform public.log_roll(cid, case when kind = 'long' then 'The party takes a long rest' else 'The party takes a short rest' end,
                          jsonb_build_object('total', 0, 'expr', '', 'detail', '[]'::jsonb), 'normal', false,
                          jsonb_build_object('kind', 'rest', 'rest', kind));
  return n;
end;
$$;

/* --------------------------------------------------------- permissions */
revoke all on function public.spend_slot(uuid, int) from public, anon, authenticated;
revoke all on function public.spend_turn(uuid, text, int, boolean) from public, anon, authenticated;
revoke all on function public.adjust_damage(int, text, public.token_secrets) from public, anon, authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.move_token(uuid, int, int)', 'public.combat_start(uuid)', 'public.combat_end(uuid)', 'public.combat_next(uuid)',
    'public.attack(uuid, uuid[], int, text, text, text, text, jsonb, text, int, boolean, boolean)',
    'public.saving_throw(uuid, uuid[], text, int, text, text, boolean, text, text, text, int, boolean, jsonb)',
    'public.heal(uuid, uuid[], text, text, text, int, boolean)',
    'public.combat_action(uuid, text, text, int, text)', 'public.party_rest(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ===================================================== 0006_exploration.sql

-- Step 6: exploration mode.
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Run 0001 to 0005 first. It is safe to run more than once.
--
-- The DM switches the table between three modes:
--   Free Roam   - players move as far as they like (explore_round is null).
--   Exploration - players move up to explore_feet (150 by default) each
--                 exploration round; the DM starts the next round when the
--                 story is ready to move on.
--   Combat      - initiative and turns (0004 and 0005). Exploration stays
--                 on underneath, so ending combat goes back to it.
-- The DM is never limited.

alter table public.campaigns add column if not exists explore_round int;
alter table public.campaigns add column if not exists explore_feet int not null default 150;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'campaigns_explore_feet_range') then
    alter table public.campaigns add constraint campaigns_explore_feet_range check (explore_feet between 5 and 1000);
  end if;
end $$;

/* ------------------------------------------------------- switching modes */

-- Start exploration (or change how far players may move each round).
create or replace function public.explore_start(cid uuid, feet int default 150)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_campaign_dm(cid) then
    raise exception 'Only the DM can start exploration';
  end if;
  feet := greatest(5, least(1000, coalesce(feet, 150)));
  if (select explore_round from public.campaigns where id = cid) is not null then
    -- Already exploring: just change the limit.
    update public.campaigns set explore_feet = feet, version = version + 1, last_change = 'campaigns' where id = cid;
    return;
  end if;
  update public.tokens set turn = turn - 'explored' where campaign_id = cid and turn ? 'explored';
  update public.campaigns set explore_round = 1, explore_feet = feet, version = version + 1, last_change = 'campaigns'
   where id = cid;
end;
$$;

-- Next exploration round: everyone gets their movement back.
create or replace function public.explore_next(cid uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  rnd int;
begin
  if not public.is_campaign_dm(cid) then
    raise exception 'Only the DM can start the next round';
  end if;
  if (select explore_round from public.campaigns where id = cid) is null then
    raise exception 'Exploration isn''t on';
  end if;
  update public.tokens set turn = turn - 'explored' where campaign_id = cid and turn ? 'explored';
  update public.campaigns set explore_round = explore_round + 1, version = version + 1, last_change = 'campaigns'
   where id = cid returning explore_round into rnd;
  return rnd;
end;
$$;

-- Back to Free Roam.
create or replace function public.explore_end(cid uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_campaign_dm(cid) then
    raise exception 'Only the DM can end exploration';
  end if;
  update public.tokens set turn = turn - 'explored' where campaign_id = cid and turn ? 'explored';
  update public.campaigns set explore_round = null, version = version + 1, last_change = 'campaigns' where id = cid;
end;
$$;

/* -------------------------------------------------------------- moving */

-- Move a token. The DM can move any token any distance.
-- Combat: a player only moves on their turn, up to their speed (see 0005).
-- Exploration: a player moves up to the round's limit (150 ft by default).
-- 5 feet per square, diagonals too; crawling while Prone costs double.
-- Player characters reveal the fog around where they stop.
create or replace function public.move_token(token uuid, nx int, ny int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.tokens%rowtype;
  m public.maps%rowtype;
  c public.campaigns%rowtype;
  dm boolean;
  cost int;
  lft int;
  why text;
begin
  select * into t from public.tokens where id = token for update;
  if not found then
    raise exception 'Token not found';
  end if;
  select * into m from public.maps where id = t.map_id;
  select * into c from public.campaigns where id = t.campaign_id;
  dm := public.is_campaign_dm(t.campaign_id);
  if not dm then
    if t.owner_id is distinct from auth.uid() or not public.is_campaign_member(t.campaign_id) or not public.is_active_map(t.map_id) then
      raise exception 'You can only move your own token';
    end if;
  end if;
  nx := greatest(0, least(m.cols - t.size, nx));
  ny := greatest(0, least(m.rows - t.size, ny));
  if nx = t.x and ny = t.y then
    return;
  end if;
  cost := greatest(abs(nx - t.x), abs(ny - t.y)) * 5;
  if 'Prone' = any(t.conditions) then
    cost := cost * 2;
  end if;
  if c.combat_round is not null and t.map_id = c.active_map_id then
    if not dm then
      if c.combat_turn is distinct from t.id then
        raise exception 'You can only move on your turn.';
      end if;
      why := public.held_by(t.conditions);
      if why is not null then
        raise exception '% can''t move while %.', t.name, lower(why);
      end if;
      lft := public.movement_left(t);
      if cost > lft then
        raise exception 'That''s % ft away. You have % ft of movement left this turn.', cost, greatest(lft, 0);
      end if;
    end if;
    if c.combat_turn = t.id and (not dm or t.kind <> 'pc') then
      update public.tokens set turn = turn || jsonb_build_object('moved', public.jint(turn, 'moved') + cost) where id = token;
    end if;
  elsif c.explore_round is not null and t.map_id = c.active_map_id and not dm then
    why := public.held_by(t.conditions);
    if why is not null then
      raise exception '% can''t move while %.', t.name, lower(why);
    end if;
    lft := c.explore_feet - public.jint(t.turn, 'explored');
    if cost > lft then
      raise exception 'That''s % ft away. You have % ft left this exploration round; the DM will start the next one.', cost, greatest(lft, 0);
    end if;
    update public.tokens set turn = turn || jsonb_build_object('explored', public.jint(turn, 'explored') + cost) where id = token;
  end if;
  update public.tokens set x = nx, y = ny where id = token;
  if t.kind = 'pc' and m.vision > 0 then
    perform public.reveal_circle(m.id, nx + (t.size - 1) / 2, ny + (t.size - 1) / 2, m.vision);
  end if;
end;
$$;

/* --------------------------------------------------------- permissions */
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.explore_start(uuid, int)', 'public.explore_next(uuid)', 'public.explore_end(uuid)',
    'public.move_token(uuid, int, int)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ===================================================== 0007_homebrew.sql

-- Step 7: homebrew.
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Run 0001 to 0006 first. It is safe to run more than once.
--
-- Everyone has a private homebrew library: monsters, spells, weapons, armor,
-- classes, subclasses, species, backgrounds, feats and magic items. Each item
-- is stored in the same shape as the built-in rules data (in `data`).
--
-- A campaign picks which homebrew it uses (campaign_homebrew):
--   * the DM's own items are switched on as soon as they're added;
--   * a player's items wait until the DM switches them on.
-- Everyone in the campaign can then read the switched-on items, except
-- monsters, which only the DM can read. Owners can always read their own.

create table if not exists public.homebrew (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null,
  name text not null check (char_length(name) between 1 and 120),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.homebrew drop constraint if exists homebrew_kind;
alter table public.homebrew add constraint homebrew_kind check (
  kind in ('monster', 'spell', 'weapon', 'armor', 'class', 'subclass', 'species', 'background', 'feat', 'magic-item')
);
alter table public.homebrew drop constraint if exists homebrew_data_size;
alter table public.homebrew add constraint homebrew_data_size check (pg_column_size(data) < 500000);

create index if not exists homebrew_owner_idx on public.homebrew (owner_id, kind, name);

create table if not exists public.campaign_homebrew (
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  homebrew_id uuid not null references public.homebrew (id) on delete cascade,
  added_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  enabled boolean not null default false,
  added_at timestamptz not null default now(),
  primary key (campaign_id, homebrew_id)
);

create index if not exists campaign_homebrew_item_idx on public.campaign_homebrew (homebrew_id);

alter table public.homebrew enable row level security;
alter table public.campaign_homebrew enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.homebrew to authenticated;
grant select, insert, update, delete on table public.campaign_homebrew to authenticated;

/* ----------------------------------------------------------- who sees what */

-- Can the signed-in user read this homebrew item through one of their campaigns?
create or replace function public.can_read_homebrew(hid uuid, hkind text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.campaign_homebrew ch
      join public.campaigns c on c.id = ch.campaign_id
     where ch.homebrew_id = hid
       and (
         -- The DM sees everything added to their campaign, switched on or not,
         -- so they can decide whether to allow a player's homebrew.
         c.dm_id = auth.uid()
         -- Players see switched-on items, but never monsters.
         or (ch.enabled and hkind <> 'monster' and public.is_campaign_member(c.id))
       )
  );
$$;

drop policy if exists "Read own or campaign homebrew" on public.homebrew;
create policy "Read own or campaign homebrew" on public.homebrew for select to authenticated
  using ((select auth.uid()) = owner_id or public.can_read_homebrew(id, kind));

drop policy if exists "Create own homebrew" on public.homebrew;
create policy "Create own homebrew" on public.homebrew for insert to authenticated
  with check ((select auth.uid()) = owner_id);

drop policy if exists "Change own homebrew" on public.homebrew;
create policy "Change own homebrew" on public.homebrew for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

drop policy if exists "Delete own homebrew" on public.homebrew;
create policy "Delete own homebrew" on public.homebrew for delete to authenticated
  using ((select auth.uid()) = owner_id);

drop trigger if exists homebrew_touch_updated_at on public.homebrew;
create trigger homebrew_touch_updated_at
  before update on public.homebrew
  for each row execute function public.touch_updated_at();

-- Members see which homebrew their campaign uses (the item itself is still
-- protected by the policy above).
drop policy if exists "Members see campaign homebrew" on public.campaign_homebrew;
create policy "Members see campaign homebrew" on public.campaign_homebrew for select to authenticated
  using (public.is_campaign_member(campaign_id) or public.is_campaign_dm(campaign_id));

-- Changes go through the functions below.

/* ------------------------------------------------------- campaign actions */

-- Add one of your homebrew items to a campaign you're in. The DM's own items
-- are switched on straight away; a player's wait for the DM.
create or replace function public.homebrew_add(cid uuid, hid uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  dm boolean := public.is_campaign_dm(cid);
begin
  if not (dm or public.is_campaign_member(cid)) then
    raise exception 'You are not in this campaign';
  end if;
  if not exists (select 1 from public.homebrew where id = hid and owner_id = auth.uid()) then
    raise exception 'You can only add your own homebrew';
  end if;
  insert into public.campaign_homebrew (campaign_id, homebrew_id, added_by, enabled)
  values (cid, hid, auth.uid(), dm)
  on conflict (campaign_id, homebrew_id) do nothing;
  update public.campaigns set version = version + 1, last_change = 'homebrew' where id = cid;
  return dm;
end;
$$;

-- The DM switches an item on or off for the campaign.
create or replace function public.homebrew_set_enabled(cid uuid, hid uuid, on_off boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_campaign_dm(cid) then
    raise exception 'Only the DM can switch homebrew on or off';
  end if;
  update public.campaign_homebrew set enabled = on_off where campaign_id = cid and homebrew_id = hid;
  update public.campaigns set version = version + 1, last_change = 'homebrew' where id = cid;
end;
$$;

-- Take an item out of a campaign: the DM can remove anything, a player only
-- what they added.
create or replace function public.homebrew_remove(cid uuid, hid uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.campaign_homebrew
   where campaign_id = cid and homebrew_id = hid
     and (public.is_campaign_dm(cid) or added_by = auth.uid());
  update public.campaigns set version = version + 1, last_change = 'homebrew' where id = cid;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.can_read_homebrew(uuid, text)', 'public.homebrew_add(uuid, uuid)',
    'public.homebrew_set_enabled(uuid, uuid, boolean)', 'public.homebrew_remove(uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
