-- Rules automation tests: attacks, saves, damage, death saves, turns, rests, XP.
-- Run with tests/db/run.sh (after security.test.sql, which leaves t_eq/t_true behind).
\set ON_ERROR_STOP 1

reset role;
create table public.r_ids (k text primary key, v uuid);
grant select, insert on public.r_ids to authenticated;
insert into auth.users values
  ('aaaaaaaa-1111-0000-0000-000000000001', 'dm2@example.com'),
  ('bbbbbbbb-1111-0000-0000-000000000002', 'pia@example.com'),
  ('cccccccc-1111-0000-0000-000000000003', 'quin@example.com');
insert into public.characters (id, owner_id, name, data) values
  ('22222222-0000-0000-0000-00000000000b', 'bbbbbbbb-1111-0000-0000-000000000002', 'Pia',
   '{"level": 3, "classId": "fighter", "hp": {"current": 20, "temp": 0}, "conditions": [], "deathSaves": {"successes": 0, "failures": 0}, "slotsUsed": {}}'),
  ('22222222-0000-0000-0000-00000000000c', 'cccccccc-1111-0000-0000-000000000003', 'Quin',
   '{"level": 3, "classId": "warlock", "hp": {"current": 5, "temp": 0}, "conditions": [], "slotsUsed": {"2": 2}}');

set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-1111-0000-0000-000000000001';
with x as (insert into public.campaigns (name) values ('Rules test') returning id) insert into public.r_ids select 'c', id from x;
with x as (insert into public.maps (campaign_id, name, cols, rows, vision) values ((select v from r_ids where k = 'c'), 'Arena', 10, 10, 0) returning id)
  insert into public.r_ids select 'm', id from x;
update public.campaigns set active_map_id = (select v from r_ids where k = 'm') where id = (select v from r_ids where k = 'c');
update public.maps set revealed = repeat('1', 100) where id = (select v from r_ids where k = 'm');

reset role;
create temp table r_code as select join_code from public.campaigns where name = 'Rules test';
grant select on r_code to authenticated;
set role authenticated;
set request.jwt.claim.sub = 'bbbbbbbb-1111-0000-0000-000000000002';
select public.join_campaign((select join_code from r_code));
update public.campaign_members set character_id = '22222222-0000-0000-0000-00000000000b' where user_id = auth.uid();
set request.jwt.claim.sub = 'cccccccc-1111-0000-0000-000000000003';
select public.join_campaign((select join_code from r_code));
update public.campaign_members set character_id = '22222222-0000-0000-0000-00000000000c' where user_id = auth.uid();

set request.jwt.claim.sub = 'aaaaaaaa-1111-0000-0000-000000000001';
with x as (insert into public.tokens (campaign_id, map_id, kind, name, x, y, owner_id, character_id)
  values ((select v from r_ids where k = 'c'), (select v from r_ids where k = 'm'), 'pc', 'Pia', 1, 1, 'bbbbbbbb-1111-0000-0000-000000000002', '22222222-0000-0000-0000-00000000000b') returning id)
  insert into public.r_ids select 'pia', id from x;
with x as (insert into public.tokens (campaign_id, map_id, kind, name, x, y, owner_id, character_id)
  values ((select v from r_ids where k = 'c'), (select v from r_ids where k = 'm'), 'pc', 'Quin', 2, 1, 'cccccccc-1111-0000-0000-000000000003', '22222222-0000-0000-0000-00000000000c') returning id)
  insert into public.r_ids select 'quin', id from x;
with x as (insert into public.tokens (campaign_id, map_id, kind, name, x, y) values ((select v from r_ids where k = 'c'), (select v from r_ids where k = 'm'), 'monster', 'Ogre', 5, 5) returning id)
  insert into public.r_ids select 'ogre', id from x;
with x as (insert into public.tokens (campaign_id, map_id, kind, name, x, y) values ((select v from r_ids where k = 'c'), (select v from r_ids where k = 'm'), 'monster', 'Fire Imp', 6, 5) returning id)
  insert into public.r_ids select 'imp', id from x;
with x as (insert into public.tokens (campaign_id, map_id, kind, name, x, y, hidden) values ((select v from r_ids where k = 'c'), (select v from r_ids where k = 'm'), 'monster', 'Lurker', 7, 7, true) returning id)
  insert into public.r_ids select 'lurker', id from x;
insert into public.token_secrets (token_id, campaign_id, hp_current, hp_max, ac, saves, xp) values
  ((select v from r_ids where k = 'ogre'), (select v from r_ids where k = 'c'), 59, 59, 11, '{"dex": -1, "con": 3}', 450);
insert into public.token_secrets (token_id, campaign_id, hp_current, hp_max, ac, saves, immune, resist) values
  ((select v from r_ids where k = 'imp'), (select v from r_ids where k = 'c'), 30, 30, 13, '{"dex": 3}', '{Fire}', '{Cold}');
-- The DM's browser keeps the party's AC, HP max and saves here.
insert into public.token_secrets (token_id, campaign_id, hp_current, hp_max, ac, saves) values
  ((select v from r_ids where k = 'pia'), (select v from r_ids where k = 'c'), null, 28, 18, '{"dex": 1, "con": 5}'),
  ((select v from r_ids where k = 'quin'), (select v from r_ids where k = 'c'), null, 21, 12, '{"dex": 2}');

/* --------------------------------------------------------------- attacks */
set request.jwt.claim.sub = 'bbbbbbbb-1111-0000-0000-000000000002';
do $$ begin
  perform public.attack((select v from public.r_ids where k = 'ogre'), (select v from public.r_ids where k = 'pia'), 5, '1d8');
  raise exception 'FAILED: player attacked with the ogre';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok: players can only attack with their own token';
end $$;
do $$ begin
  perform public.attack((select v from public.r_ids where k = 'pia'), (select v from public.r_ids where k = 'lurker'), 5, '1d8');
  raise exception 'FAILED: player attacked a hidden enemy';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok: players can''t target what they can''t see';
end $$;

-- A huge bonus hits unless the d20 shows a 1; damage comes off the ogre's HP.
do $$
declare r jsonb; hits int := 0; misses int := 0; dealt int := 0; i int;
begin
  for i in 1 .. 40 loop
    r := public.attack((select v from public.r_ids where k = 'pia'), (select v from public.r_ids where k = 'ogre'), 30, '1d4', 'Slashing', 'normal', 'Dagger');
    if (r ->> 'hit')::boolean then hits := hits + 1; dealt := dealt + (r ->> 'damage')::int; else misses := misses + 1; end if;
    if r ? 'ac' then raise exception 'FAILED: attack result reveals AC'; end if;
    exit when (r ->> 'dead')::boolean;
  end loop;
  perform public.t_true(hits > 0, 'attacks with a big bonus hit');
  perform public.t_true(dealt > 0, 'hits deal damage');
end $$;
select t_eq((select count(*)::int from public.token_secrets), 0, 'player still can''t read enemy HP');
select t_true((select count(*) > 0 from public.rolls where label like 'Pia attacks Ogre%'), 'attacks go in the roll log');
select t_true((select bool_and(result ->> 'kind' = 'attack') from public.rolls where label like 'Pia attacks Ogre%'), 'log has the attack result');

set request.jwt.claim.sub = 'aaaaaaaa-1111-0000-0000-000000000001';
select t_true((select hp_current < 59 from public.token_secrets where token_id = (select v from r_ids where k = 'ogre')), 'ogre lost HP');
-- Finish the ogre off.
select public.adjust_hp((select v from r_ids where k = 'ogre'), -200);
select t_eq((select hp_current from public.token_secrets where token_id = (select v from r_ids where k = 'ogre')), 0, 'HP never goes below 0');
select t_true((select 'Dead' = any(conditions) from public.tokens where id = (select v from r_ids where k = 'ogre')), 'a monster at 0 HP is marked Dead');
select public.adjust_hp((select v from r_ids where k = 'ogre'), 10);
select t_true((select not ('Dead' = any(conditions)) from public.tokens where id = (select v from r_ids where k = 'ogre')), 'healing a monster clears Dead');

-- Immunity and resistance
do $$
declare r jsonb; i int;
begin
  for i in 1 .. 10 loop
    r := public.attack((select v from public.r_ids where k = 'ogre'), (select v from public.r_ids where k = 'imp'), 30, '10', 'Fire');
    if (r ->> 'hit')::boolean then
      perform public.t_eq((r ->> 'damage')::int, 0, 'fire immunity cancels fire damage');
      exit;
    end if;
  end loop;
  for i in 1 .. 10 loop
    r := public.attack((select v from public.r_ids where k = 'ogre'), (select v from public.r_ids where k = 'imp'), 30, '10', 'cold');
    if (r ->> 'hit')::boolean and not (r ->> 'crit')::boolean then
      perform public.t_eq((r ->> 'damage')::int, 5, 'cold resistance halves damage');
      exit;
    end if;
  end loop;
end $$;

/* ------------------------------------------------- player characters */
-- 30 damage to Pia (20 HP, max 28): unconscious, not dead.
select public.adjust_hp((select v from r_ids where k = 'pia'), -30);
select t_eq((select (data -> 'hp' ->> 'current')::int from public.characters where name = 'Pia'), 0, 'player character drops to 0 HP');
select t_true((select data -> 'conditions' ? 'Unconscious' from public.characters where name = 'Pia'), 'and falls Unconscious');
select t_true((select 'Unconscious' = any(conditions) from public.tokens where id = (select v from r_ids where k = 'pia')), 'the token shows Unconscious too');
select t_true((select not (data -> 'conditions' ? 'Dead') from public.characters where name = 'Pia'), 'but is not dead');
select public.adjust_hp((select v from r_ids where k = 'pia'), -3);
select t_eq((select (data -> 'deathSaves' ->> 'failures')::int from public.characters where name = 'Pia'), 1, 'damage at 0 HP is a failed death save');

-- Start the death saves from 0 so a natural 1 can't kill Pia in this test.
reset role;
update public.characters set data = jsonb_set(data, '{deathSaves}', '{"successes": 0, "failures": 0}') where name = 'Pia';
set role authenticated;
set request.jwt.claim.sub = 'bbbbbbbb-1111-0000-0000-000000000002';
select public.death_save((select v from r_ids where k = 'pia'));
select t_true((select (data -> 'deathSaves' ->> 'failures')::int + (data -> 'deathSaves' ->> 'successes')::int >= 1
                 or (data -> 'hp' ->> 'current')::int = 1 from public.characters where name = 'Pia'), 'death save is recorded');
set request.jwt.claim.sub = 'cccccccc-1111-0000-0000-000000000003';
do $$ begin
  perform public.death_save((select v from public.r_ids where k = 'pia'));
  raise exception 'FAILED: rolled someone else''s death save';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok: players can''t roll death saves for others';
end $$;
-- Healing brings Pia back.
select public.heal((select v from r_ids where k = 'quin'), (select v from r_ids where k = 'pia'), '5', 'Potion');
reset role;
select t_true((select (data -> 'hp' ->> 'current')::int between 5 and 6 and not (data -> 'conditions' ? 'Unconscious')
               from public.characters where name = 'Pia'), 'healing wakes a downed character');
select t_eq((select (data -> 'deathSaves' ->> 'failures')::int from public.characters where name = 'Pia'), 0, 'and resets death saves');
-- Massive damage: leftover damage of at least max HP kills outright.
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-1111-0000-0000-000000000001';
select public.adjust_hp((select v from r_ids where k = 'quin'), -40);
select t_true((select data -> 'conditions' ? 'Dead' from public.characters where name = 'Quin'), 'massive damage kills instantly');
select public.set_condition((select v from r_ids where k = 'quin'), 'Dead', false);
select public.adjust_hp((select v from r_ids where k = 'quin'), 21);

/* ------------------------------------------------------- saving throws */
select public.adjust_hp((select v from r_ids where k = 'ogre'), 100);
do $$
declare r jsonb;
begin
  r := public.saving_throw((select v from public.r_ids where k = 'quin'),
         array[(select v from public.r_ids where k = 'ogre'), (select v from public.r_ids where k = 'imp')],
         'dex', 40, '8', 'Fire', true, 'Prone', 'Fireball');
  perform public.t_eq(jsonb_array_length(r -> 'targets'), 2, 'everyone in the area saves');
  perform public.t_eq((r -> 'targets' -> 0 ->> 'damage')::int, 8, 'failed save takes full damage');
  perform public.t_eq((r -> 'targets' -> 1 ->> 'damage')::int, 0, 'immunity still applies to saves');
  r := public.saving_throw((select v from public.r_ids where k = 'quin'),
         array[(select v from public.r_ids where k = 'ogre')], 'dex', 1, '8', 'Cold', true, '', 'Ice');
  perform public.t_eq((r -> 'targets' -> 0 ->> 'damage')::int, 4, 'successful save takes half');
end $$;
select t_true((select 'Prone' = any(conditions) from public.tokens where id = (select v from r_ids where k = 'ogre')), 'failed save adds the condition');
select public.set_condition((select v from r_ids where k = 'ogre'), 'Prone', false);
select t_true((select not ('Prone' = any(conditions)) from public.tokens where id = (select v from r_ids where k = 'ogre')), 'DM can remove a condition');

set request.jwt.claim.sub = 'bbbbbbbb-1111-0000-0000-000000000002';
select public.set_condition((select v from r_ids where k = 'pia'), 'Poisoned', true);
reset role;
select t_true((select data -> 'conditions' ? 'Poisoned' from public.characters where name = 'Pia'), 'a player''s condition is saved on their character');
set role authenticated;
set request.jwt.claim.sub = 'bbbbbbbb-1111-0000-0000-000000000002';
do $$ begin
  perform public.set_condition((select v from public.r_ids where k = 'ogre'), 'Blinded', true);
  raise exception 'FAILED: player changed an enemy''s conditions directly';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok: players can''t change enemies'' conditions directly';
end $$;

/* --------------------------------------------------------------- turns */
set request.jwt.claim.sub = 'aaaaaaaa-1111-0000-0000-000000000001';
select public.combat_start((select v from r_ids where k = 'c'));
select public.roll_initiative((select v from r_ids where k = 'ogre'), 30);
select public.roll_initiative((select v from r_ids where k = 'imp'), -10);
set request.jwt.claim.sub = 'bbbbbbbb-1111-0000-0000-000000000002';
select public.roll_initiative((select v from r_ids where k = 'pia'), 10);
do $$ begin
  perform public.roll_initiative((select v from public.r_ids where k = 'quin'), 30);
  raise exception 'FAILED: rolled initiative for someone else';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok: players roll initiative only for themselves';
end $$;
do $$ begin
  perform public.combat_next((select v from public.r_ids where k = 'c'));
  raise exception 'FAILED: player advanced someone else''s turn';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok: players can''t skip other turns';
end $$;
set request.jwt.claim.sub = 'aaaaaaaa-1111-0000-0000-000000000001';
select t_eq(public.combat_next((select v from r_ids where k = 'c')), (select v from r_ids where k = 'ogre'), 'highest initiative goes first');
select t_eq(public.combat_next((select v from r_ids where k = 'c')), (select v from r_ids where k = 'pia'), 'then the next highest');
set request.jwt.claim.sub = 'bbbbbbbb-1111-0000-0000-000000000002';
select t_eq(public.combat_next((select v from r_ids where k = 'c')), (select v from r_ids where k = 'imp'), 'a player can end their own turn');
set request.jwt.claim.sub = 'aaaaaaaa-1111-0000-0000-000000000001';
select public.combat_next((select v from r_ids where k = 'c'));
select t_eq((select combat_round from public.campaigns where id = (select v from r_ids where k = 'c')), 2, 'wrapping around starts round 2');
select public.adjust_hp((select v from r_ids where k = 'pia'), -20);
select public.set_condition((select v from r_ids where k = 'pia'), 'Unconscious', true);
select t_eq(public.combat_next((select v from r_ids where k = 'c')), (select v from r_ids where k = 'pia'), 'downed characters still get a turn (for death saves)');
select public.combat_end((select v from r_ids where k = 'c'));
select t_true((select combat_round is null from public.campaigns where id = (select v from r_ids where k = 'c')), 'combat ends');

/* --------------------------------------------- slots, rests and XP */
set request.jwt.claim.sub = 'cccccccc-1111-0000-0000-000000000003';
select public.use_slot('22222222-0000-0000-0000-00000000000c', 1, 1);
do $$ begin
  perform public.use_slot('22222222-0000-0000-0000-00000000000b', 1, 1);
  raise exception 'FAILED: used someone else''s spell slot';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok: players only spend their own slots';
end $$;
set request.jwt.claim.sub = 'aaaaaaaa-1111-0000-0000-000000000001';
select public.party_rest((select v from r_ids where k = 'c'), 'short');
reset role;
select t_eq((select data -> 'slotsUsed' from public.characters where name = 'Quin'), '{}'::jsonb, 'warlocks get slots back on a short rest');
update public.characters set data = jsonb_set(data, '{slotsUsed}', '{"1": 2}') where name = 'Pia';
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-1111-0000-0000-000000000001';
select public.party_rest((select v from r_ids where k = 'c'), 'short');
reset role;
select t_eq((select data -> 'slotsUsed' from public.characters where name = 'Pia'), '{"1": 2}'::jsonb, 'other classes don''t on a short rest');
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-1111-0000-0000-000000000001';
select public.party_rest((select v from r_ids where k = 'c'), 'long');
reset role;
select t_eq((select (data -> 'hp' ->> 'current')::int from public.characters where name = 'Pia'), 28, 'long rest restores HP');
select t_eq((select data -> 'slotsUsed' from public.characters where name = 'Pia'), '{}'::jsonb, 'and spell slots');
select t_true((select not (data -> 'conditions' ? 'Unconscious') from public.characters where name = 'Pia'), 'and wakes you up');

set role authenticated;
set request.jwt.claim.sub = 'bbbbbbbb-1111-0000-0000-000000000002';
do $$ begin
  perform public.award_xp((select v from public.r_ids where k = 'c'), 1000);
  raise exception 'FAILED: player awarded XP';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok: only the DM awards XP';
end $$;
set request.jwt.claim.sub = 'aaaaaaaa-1111-0000-0000-000000000001';
select t_eq(public.award_xp((select v from r_ids where k = 'c'), 900), 450, 'XP is split across the party');
reset role;
select t_eq((select (data ->> 'xp')::int from public.characters where name = 'Quin'), 450, 'and added to each character');

-- Hit dice on a short rest
set role authenticated;
set request.jwt.claim.sub = 'bbbbbbbb-1111-0000-0000-000000000002';
select public.adjust_hp((select v from r_ids where k = 'pia'), -10);
select public.spend_hit_die((select v from r_ids where k = 'pia'), 10, 2);
reset role;
select t_eq((select (data ->> 'hitDiceSpent')::int from public.characters where name = 'Pia'), 1, 'spending a Hit Die is tracked');
select t_true((select (data -> 'hp' ->> 'current')::int between 21 and 28 from public.characters where name = 'Pia'), 'and heals');

-- Internal helpers are not callable from the browser.
set role authenticated;
do $$ begin
  perform public.change_hp((select v from public.r_ids where k = 'ogre'), -100, false);
  raise exception 'FAILED: called change_hp directly';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok: internal helpers are locked';
end $$;
reset role;
