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
