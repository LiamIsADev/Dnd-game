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
  update public.campaigns set combat_round = 1, combat_turn = null where id = cid;
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
  update public.campaigns set combat_round = null, combat_turn = null where id = cid;
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
    update public.campaigns set combat_turn = null where id = cid;
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
  update public.campaigns set combat_turn = nxt, combat_round = rnd where id = cid;
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
