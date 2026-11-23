-- Turn tests: actions, bonus actions, reactions, movement and spell slots in combat.
-- Run with tests/db/run.sh after rules.test.sql (it reuses that campaign).
\set ON_ERROR_STOP 1

reset role;
create or replace function public.t_fails(q text, pattern text, msg text)
returns void
language plpgsql
as $$
begin
  begin
    execute q;
  exception when others then
    if sqlerrm ilike '%' || pattern || '%' then
      raise notice 'ok: %', msg;
      return;
    end if;
    raise exception 'FAILED: % (wrong error: %)', msg, sqlerrm;
  end;
  raise exception 'FAILED: %', msg;
end;
$$;
create or replace function public.rid(key text) returns uuid language sql stable as $$ select v from public.r_ids where k = key $$;
create or replace function public.turn_of(key text) returns jsonb language sql stable as $$ select turn from public.tokens where id = public.rid(key) $$;

set role authenticated;
-- The DM's browser writes what each creature can do.
set request.jwt.claim.sub = 'aaaaaaaa-1111-0000-0000-000000000001';
update public.tokens set x = 0, y = 0, conditions = '{}', stats = '{"speed": 30, "attacks": 2, "level": 5, "actionSurge": 1, "secondWind": 2}' where id = rid('pia');
update public.tokens set x = 0, y = 4, stats = '{"speed": 30, "slots": {"1": 2}}' where id = rid('quin');
update public.tokens set x = 2, y = 0, conditions = '{}' where id = rid('ogre');
select public.combat_start(rid('c'));
update public.tokens set initiative = 20 where id = rid('pia');
update public.tokens set initiative = 10 where id = rid('ogre');
update public.tokens set initiative = 5 where id = rid('quin');
update public.tokens set initiative = null where id in (rid('imp'), rid('lurker'));
reset role;
update public.characters set data = data || '{"slotsUsed": {}, "featureUses": {}, "conditions": []}' where name in ('Pia', 'Quin');
set role authenticated;

/* ------------------------------------------- before anyone's turn */
set request.jwt.claim.sub = 'bbbbbbbb-1111-0000-0000-000000000002';
select t_fails($q$select public.move_token(public.rid('pia'), 1, 0)$q$, 'only move on your turn', 'no moving before the first turn');
select t_fails($q$select public.attack(public.rid('pia'), array[public.rid('ogre')], 5, '1d8')$q$, 'wait for your turn', 'no attacking before the first turn');

set request.jwt.claim.sub = 'aaaaaaaa-1111-0000-0000-000000000001';
select t_eq(public.combat_next(rid('c')), rid('pia'), 'Pia goes first');

/* ---------------------------------------------- someone else's turn */
set request.jwt.claim.sub = 'cccccccc-1111-0000-0000-000000000003';
select t_fails($q$select public.attack(public.rid('quin'), array[public.rid('ogre')], 5, '1d8')$q$, 'isn''t your turn', 'no attacking on someone else''s turn');
select t_fails($q$select public.move_token(public.rid('quin'), 1, 4)$q$, 'only move on your turn', 'no moving on someone else''s turn');
select t_fails($q$select public.combat_action(public.rid('quin'), 'dash')$q$, 'isn''t your turn', 'no Dash on someone else''s turn');
-- Reactions work on anyone's turn, once.
select public.combat_action(rid('quin'), 'spell', 'reaction', 1, 'Shield');
reset role;
select t_eq((select (data -> 'slotsUsed' ->> '1')::int from public.characters where name = 'Quin'), 1, 'a reaction spell spends its slot');
set role authenticated;
set request.jwt.claim.sub = 'cccccccc-1111-0000-0000-000000000003';
select t_fails($q$select public.combat_action(public.rid('quin'), 'spell', 'reaction', 0, 'Shield')$q$, 'already used your reaction', 'one reaction per round');

/* --------------------------------------------------------- movement */
set request.jwt.claim.sub = 'bbbbbbbb-1111-0000-0000-000000000002';
select public.move_token(rid('pia'), 3, 3); -- diagonal: 3 squares = 15 ft
select t_eq(public.jint(turn_of('pia'), 'moved'), 15, 'diagonal squares cost 5 ft each');
select public.move_token(rid('pia'), 6, 3);
select t_eq(public.jint(turn_of('pia'), 'moved'), 30, 'movement adds up');
select t_fails($q$select public.move_token(public.rid('pia'), 7, 3)$q$, '0 ft of movement left', 'can''t move past your speed');
select public.combat_action(rid('pia'), 'dash');
select public.move_token(rid('pia'), 9, 3);
select t_eq(public.jint(turn_of('pia'), 'moved'), 45, 'Dash gives more movement');
select t_eq(public.jint(turn_of('pia'), 'actions_used'), 1, 'Dash uses the action');

/* ---------------------------------------------------------- actions */
select t_fails($q$select public.attack(public.rid('pia'), array[public.rid('ogre')], 5, '1d8')$q$, 'already used your action', 'no attack after using the action');
select public.combat_action(rid('pia'), 'action_surge');
select t_eq(public.jint(turn_of('pia'), 'actions', 1), 2, 'Action Surge gives a second action');
select t_fails($q$select public.combat_action(public.rid('pia'), 'action_surge')$q$, 'no uses', 'Action Surge only once before a rest');
-- Extra Attack: two attacks for one action.
select public.attack(rid('pia'), array[rid('ogre')], 5, '1d8', 'Slashing', 'normal', 'Longsword');
select t_eq(public.jint(turn_of('pia'), 'attacks_left'), 1, 'Extra Attack leaves a second attack');
select public.attack(rid('pia'), array[rid('ogre')], 5, '1d8', 'Slashing', 'normal', 'Longsword');
select t_fails($q$select public.attack(public.rid('pia'), array[public.rid('ogre')], 5, '1d8')$q$, 'already used your action', 'no third attack');
-- Bonus action once.
select public.combat_action(rid('pia'), 'second_wind');
select t_true(public.jbool(turn_of('pia'), 'bonus'), 'Second Wind uses the bonus action');
select t_fails($q$select public.attack(public.rid('pia'), array[public.rid('ogre')], 5, '1d4', 'Piercing', 'normal', 'Dagger', '[]', 'bonus')$q$,
               'already used your bonus action', 'one bonus action per turn');
reset role;
select t_eq((select (data -> 'featureUses' ->> 'secondWind')::int from public.characters where name = 'Pia'), 1, 'Second Wind uses are counted');

/* ------------------------------------------------------- the roll log */
select t_true((select count(*) > 0 from public.rolls where result ->> 'kind' = 'damage' and label like 'Ogre takes damage%'), 'damage gets its own log line');
select t_true((select bool_and(not (result ? 'damage')) from public.rolls where label like 'Pia attacks Ogre (Longsword)%'), 'the attack line only says hit or miss');

/* --------------------------------------------------- the DM's turn */
set request.jwt.claim.sub = 'aaaaaaaa-1111-0000-0000-000000000001';
select t_eq(public.combat_next(rid('c')), rid('ogre'), 'then the ogre');
select public.move_token(rid('ogre'), 9, 9);
select public.attack(rid('ogre'), array[rid('pia')], 5, '1');
select public.attack(rid('ogre'), array[rid('pia')], 5, '1');
select t_eq(public.jint(turn_of('ogre'), 'actions_used'), 2, 'the DM isn''t blocked, but what the monster used is recorded');
select t_eq(public.jint(turn_of('ogre'), 'moved'), 45, 'and how far it moved');
set request.jwt.claim.sub = 'bbbbbbbb-1111-0000-0000-000000000002';
select t_fails($q$select public.combat_next(public.rid('c'))$q$, 'isn''t your turn', 'players can''t end someone else''s turn');

/* ------------------------------------------------------ spell slots */
set request.jwt.claim.sub = 'aaaaaaaa-1111-0000-0000-000000000001';
select t_eq(public.combat_next(rid('c')), rid('quin'), 'then Quin');
select t_eq(turn_of('quin'), '{}'::jsonb, 'a new turn starts fresh (reaction back)');
set request.jwt.claim.sub = 'cccccccc-1111-0000-0000-000000000003';
select public.combat_action(rid('quin'), 'spell', 'bonus', 1, 'Healing Word');
select t_fails($q$select public.combat_action(public.rid('quin'), 'spell', 'action', 1, 'Burning Hands')$q$, 'only other spell you can cast is a cantrip', 'bonus action spell: the other spell must be a cantrip');
select public.combat_action(rid('quin'), 'spell', 'action', 0, 'Fire Bolt');
reset role;
select t_eq((select (data -> 'slotsUsed' ->> '1')::int from public.characters where name = 'Quin'), 2, 'both slots used');
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-1111-0000-0000-000000000001';
update public.tokens set turn = '{}' where id = rid('quin');
set request.jwt.claim.sub = 'cccccccc-1111-0000-0000-000000000003';
select t_fails($q$select public.combat_action(public.rid('quin'), 'spell', 'action', 1, 'Burning Hands')$q$, 'no level 1 spell slots left', 'no casting without a slot');
select t_fails($q$select public.saving_throw(public.rid('quin'), array[public.rid('ogre')], 'dex', 13, '3d6', 'Fire', true, '', 'Burning Hands', 'action', 1, true)$q$,
               'no level 1 spell slots left', 'no area spell without a slot either');
select t_eq(public.jint(turn_of('quin'), 'actions_used'), 0, 'a blocked spell doesn''t use the action');

/* ------------------------------------------------------- conditions */
set request.jwt.claim.sub = 'aaaaaaaa-1111-0000-0000-000000000001';
select public.set_condition(rid('quin'), 'Grappled', true);
set request.jwt.claim.sub = 'cccccccc-1111-0000-0000-000000000003';
select t_fails($q$select public.move_token(public.rid('quin'), 1, 4)$q$, 'can''t move while grappled', 'Grappled: speed 0');
set request.jwt.claim.sub = 'aaaaaaaa-1111-0000-0000-000000000001';
select public.set_condition(rid('quin'), 'Grappled', false);
select public.set_condition(rid('quin'), 'Prone', true);
set request.jwt.claim.sub = 'cccccccc-1111-0000-0000-000000000003';
select public.move_token(rid('quin'), 1, 4);
select t_eq(public.jint(turn_of('quin'), 'moved'), 10, 'crawling while Prone costs double');
select public.combat_action(rid('quin'), 'stand');
select t_eq(public.jint(turn_of('quin'), 'moved'), 25, 'standing up costs half your speed');
select t_true((select not ('Prone' = any(conditions)) from public.tokens where id = rid('quin')), 'and ends Prone');
set request.jwt.claim.sub = 'aaaaaaaa-1111-0000-0000-000000000001';
select public.set_condition(rid('quin'), 'Stunned', true);
set request.jwt.claim.sub = 'cccccccc-1111-0000-0000-000000000003';
select t_fails($q$select public.attack(public.rid('quin'), array[public.rid('ogre')], 5, '1d8', 'Fire', 'normal', 'Fire Bolt', '[]', 'action', 0, true)$q$, 'can''t act while stunned', 'Stunned: no actions');
set request.jwt.claim.sub = 'aaaaaaaa-1111-0000-0000-000000000001';
select public.set_condition(rid('quin'), 'Stunned', false);

/* ------------------------------------------- several targets, rage, rests */
update public.tokens set turn = '{}' where id = rid('quin');
set request.jwt.claim.sub = 'cccccccc-1111-0000-0000-000000000003';
do $$
declare r jsonb;
begin
  r := public.attack(public.rid('quin'), array[public.rid('ogre'), public.rid('ogre')], 5, '1d10', 'Force', 'normal', 'Eldritch Blast', '[]', 'action', 0, true);
  perform public.t_eq(jsonb_array_length(r -> 'results'), 2, 'two beams make two attacks');
  perform public.t_eq(public.jint(public.turn_of('quin'), 'actions_used'), 1, 'for one action');
  r := public.saving_throw(public.rid('quin'), '{}', 'dex', 13, '', '', true, '', 'Fireball', 'bonus', 0, true, '{"shape": "sphere", "x": 4, "y": 4, "size": 20}');
  perform public.t_eq(r -> 'area' ->> 'shape', 'sphere', 'the area is saved for every screen to draw');
end $$;

set request.jwt.claim.sub = 'aaaaaaaa-1111-0000-0000-000000000001';
update public.tokens set stats = stats || '{"rage": 2}' where id = rid('pia');
select public.combat_next(rid('c'));
select t_true((select combat_turn = rid('pia') from public.campaigns where id = rid('c')), 'back to Pia');
set request.jwt.claim.sub = 'bbbbbbbb-1111-0000-0000-000000000002';
select public.combat_action(rid('pia'), 'rage');
select t_true((select 'Raging' = any(conditions) from public.tokens where id = rid('pia')), 'Rage shows on the token');
reset role;
select t_eq(public.adjust_damage(10, 'Slashing', (select s from public.token_secrets s where token_id = public.rid('pia'))), 5, 'raging halves Slashing damage');
select t_eq(public.adjust_damage(10, 'Fire', (select s from public.token_secrets s where token_id = public.rid('pia'))), 10, 'but not Fire');
set role authenticated;

set request.jwt.claim.sub = 'aaaaaaaa-1111-0000-0000-000000000001';
select public.party_rest(rid('c'), 'short');
reset role;
select t_eq((select (data -> 'featureUses' ->> 'actionSurge')::int from public.characters where name = 'Pia'), 0, 'a short rest gives back Action Surge');
select t_eq((select (data -> 'featureUses' ->> 'secondWind')::int from public.characters where name = 'Pia'), 0, 'and one use of Second Wind');
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-1111-0000-0000-000000000001';
select public.combat_end(rid('c'));
select t_eq((select count(*)::int from public.tokens where campaign_id = rid('c') and turn <> '{}'), 0, 'ending combat clears the turns');
set request.jwt.claim.sub = 'bbbbbbbb-1111-0000-0000-000000000002';
select public.move_token(rid('pia'), 0, 9);
select t_true((select y = 9 from public.tokens where id = rid('pia')), 'outside combat, movement is free');

-- Internal helpers are not callable from the browser.
do $$ begin
  perform public.spend_turn(public.rid('pia'), 'action', 0, false);
  raise exception 'FAILED: called spend_turn directly';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok: spend_turn is locked';
end $$;
reset role;
