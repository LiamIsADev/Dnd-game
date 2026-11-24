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
