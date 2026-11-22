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
