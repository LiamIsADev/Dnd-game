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
