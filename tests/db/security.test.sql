-- Security tests for the campaign tables: checks that players only ever get
-- what the DM has shown them. Run with tests/db/run.sh.
\set ON_ERROR_STOP 1

create or replace function public.t_eq(actual anyelement, expected anyelement, what text) returns void
language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAILED: % (expected %, got %)', what, expected, actual;
  end if;
  raise notice 'ok: %', what;
end $$;
create or replace function public.t_true(cond boolean, what text) returns void
language plpgsql as $$
begin
  if not coalesce(cond, false) then raise exception 'FAILED: %', what; end if;
  raise notice 'ok: %', what;
end $$;
grant execute on function public.t_eq(anyelement, anyelement, text) to authenticated;
grant execute on function public.t_true(boolean, text) to authenticated;

-- Shared scratch space for ids, readable by everyone in the test.
create table public.t_ids (k text primary key, v uuid);
grant select, insert on public.t_ids to authenticated;

insert into auth.users values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'dm@example.com'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'bree@example.com'),
  ('cccccccc-0000-0000-0000-000000000003', 'cal@example.com'),
  ('dddddddd-0000-0000-0000-000000000004', 'outsider@example.com');
insert into public.profiles (id, display_name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Dee the DM'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'Bree'),
  ('cccccccc-0000-0000-0000-000000000003', 'Cal'),
  ('dddddddd-0000-0000-0000-000000000004', 'Outsider')
on conflict (id) do update set display_name = excluded.display_name;

/* --------------------------------------------------------- DM sets up */
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';

with x as (insert into public.campaigns (name) values ('Lost Mine') returning id) insert into public.t_ids select 'campaign', id from x;
select t_eq((select role from public.campaign_members where user_id = auth.uid()), 'dm', 'DM is added as a member');
select t_true((select join_code ~ '^[A-HJ-NP-Z2-9]{6}$' from public.campaigns), 'join code is 6 clear characters');

with x as (insert into public.maps (campaign_id, name, cols, rows, vision)
  values ((select v from t_ids where k = 'campaign'), 'Cave', 10, 10, 2) returning id) insert into public.t_ids select 'map', id from x;
select t_eq((select char_length(revealed) from public.maps), 100, 'fog starts the size of the map');
select t_eq((select revealed !~ '1' from public.maps), true, 'fog starts fully hidden');
update public.campaigns set active_map_id = (select v from t_ids where k = 'map');

with x as (insert into public.maps (campaign_id, name) values ((select v from t_ids where k = 'campaign'), 'Secret lair') returning id) insert into public.t_ids select 'map2', id from x;

with x as (insert into public.tokens (campaign_id, map_id, kind, name, x, y, hidden)
  values ((select v from t_ids where k = 'campaign'), (select v from t_ids where k = 'map'), 'monster', 'Goblin', 1, 1, true) returning id) insert into public.t_ids select 'goblin', id from x;
with x as (insert into public.tokens (campaign_id, map_id, kind, name, x, y, hidden)
  values ((select v from t_ids where k = 'campaign'), (select v from t_ids where k = 'map'), 'monster', 'Bandit', 2, 1, false) returning id) insert into public.t_ids select 'bandit', id from x;
with x as (insert into public.tokens (campaign_id, map_id, kind, name, x, y, hidden)
  values ((select v from t_ids where k = 'campaign'), (select v from t_ids where k = 'map'), 'monster', 'Dragon', 8, 8, false) returning id) insert into public.t_ids select 'dragon', id from x;
insert into public.token_secrets (token_id, campaign_id, hp_current, hp_max, ac)
values ((select v from t_ids where k = 'dragon'), (select v from t_ids where k = 'campaign'), 200, 200, 19);
with x as (insert into public.handouts (campaign_id, title, image_path)
  values ((select v from t_ids where k = 'campaign'), 'The boss', (select v from t_ids where k = 'campaign')::text || '/boss.png') returning id) insert into public.t_ids select 'handout', id from x;
insert into storage.objects (bucket_id, name) values ('campaign-images', (select v from t_ids where k = 'campaign')::text || '/boss.png');
select t_eq((select count(*)::int from public.tokens), 3, 'DM sees every token');

/* ------------------------------------------------------- outsider */
set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000004';
select t_eq((select count(*)::int from public.campaigns), 0, 'outsider sees no campaigns');
select t_eq((select count(*)::int from public.tokens), 0, 'outsider sees no tokens');
select t_eq((select count(*)::int from storage.objects), 0, 'outsider sees no images');
do $$ begin
  perform public.join_campaign('ZZZZZZ');
  raise exception 'FAILED: wrong code should not join';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok: wrong join code is refused';
end $$;
do $$ begin
  perform public.roll_dice((select v from public.t_ids where k = 'campaign'), '1d20');
  raise exception 'FAILED: outsider rolled';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok: outsider cannot roll in the campaign';
end $$;

/* ---------------------------------------------------------- players join */
reset role;
create temp table t_code as select join_code from public.campaigns;
grant select on t_code to authenticated;
set role authenticated;

set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
select t_eq(public.join_campaign(lower((select join_code from t_code))), (select v from t_ids where k = 'campaign'), 'player joins with the code (any case)');
select t_eq((select role from public.campaign_members where user_id = auth.uid()), 'player', 'joined as a player');
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select public.join_campaign((select join_code from t_code));

set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
select t_eq((select count(*)::int from public.campaign_members), 3, 'player sees the party');
select t_eq((select count(*)::int from public.maps), 1, 'player only sees the active map');
select t_eq((select name from public.maps), 'Cave', 'and it is the active one');
select t_eq((select count(*)::int from public.tokens), 0, 'player sees no tokens while everything is fogged or hidden');
select t_eq((select count(*)::int from public.token_secrets), 0, 'player never sees token secrets');
select t_eq((select count(*)::int from public.handouts), 0, 'player does not see unshown handouts');
select t_eq((select count(*)::int from storage.objects), 0, 'player cannot open unshown images');

-- Player can't write map data directly.
update public.maps set revealed = repeat('1', 100);
select t_eq((select revealed !~ '1' from public.maps), true, 'player cannot clear the fog by editing the map');
update public.tokens set hidden = false;
delete from public.tokens;
do $$ begin
  insert into public.tokens (campaign_id, map_id, kind, name)
  values ((select v from public.t_ids where k = 'campaign'), (select v from public.t_ids where k = 'map'), 'pc', 'Sneaky');
  raise exception 'FAILED: player inserted a token';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok: player cannot create tokens';
end $$;
do $$ begin
  insert into public.rolls (campaign_id, user_id, roller_name, expr, total, detail)
  values ((select v from public.t_ids where k = 'campaign'), auth.uid(), 'Bree', '1d20', 20, '[]');
  raise exception 'FAILED: player faked a roll';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok: player cannot write a fake roll';
end $$;
do $$ begin
  update public.campaign_members set role = 'dm' where user_id = auth.uid();
  raise exception 'FAILED: player promoted themselves';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok: player cannot make themselves DM';
end $$;

/* --------------------------------------------------- DM places party token */
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select t_eq((select count(*)::int from public.tokens), 3, 'DM still has all tokens after player attempts');
with x as (insert into public.tokens (campaign_id, map_id, kind, name, x, y, owner_id)
  values ((select v from t_ids where k = 'campaign'), (select v from t_ids where k = 'map'), 'pc', 'Bree''s hero', 0, 0, 'bbbbbbbb-0000-0000-0000-000000000002') returning id) insert into public.t_ids select 'pc', id from x;

set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
select t_eq((select count(*)::int from public.tokens), 1, 'player sees their own token even in fog');
select public.move_token((select v from t_ids where k = 'pc'), 1, 0);
select t_true((select substr(revealed, 1 * 10 + 2, 1) = '1' from public.maps), 'moving reveals the fog around the token');
select t_eq((select string_agg(name, ',' order by name) from public.tokens), 'Bandit,Bree''s hero', 'revealed visible enemy appears; hidden goblin and far dragon do not');
do $$ begin
  perform public.move_token((select v from public.t_ids where k = 'bandit'), 5, 5);
  raise exception 'FAILED: player moved an enemy';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok: player cannot move other tokens';
end $$;
select public.move_token((select v from t_ids where k = 'pc'), 500, -3);
select t_eq((select x || ',' || y from public.tokens where id = (select v from t_ids where k = 'pc')), '9,0', 'moves are kept on the map');

-- Choosing a character
reset role;
insert into public.characters (id, owner_id, name, data) values
  ('11111111-0000-0000-0000-00000000000b', 'bbbbbbbb-0000-0000-0000-000000000002', 'Bree''s hero', '{}'),
  ('11111111-0000-0000-0000-00000000000c', 'cccccccc-0000-0000-0000-000000000003', 'Cal''s hero', '{}');
set role authenticated;
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
update public.campaign_members set character_id = '11111111-0000-0000-0000-00000000000b' where user_id = auth.uid();
select t_eq((select character_id from public.campaign_members where user_id = auth.uid()), '11111111-0000-0000-0000-00000000000b'::uuid, 'player brings their own character');
do $$ begin
  update public.campaign_members set character_id = '11111111-0000-0000-0000-00000000000c' where user_id = auth.uid();
  raise exception 'FAILED: player used someone else''s character';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok: player cannot bring someone else''s character';
end $$;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select t_eq((select name from public.characters), 'Bree''s hero', 'DM can read characters brought to the campaign (and only those)');
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select t_eq((select count(*)::int from public.characters), 1, 'other players only see their own characters');

/* --------------------------------------------------------------- dice */
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
select t_true((select total between 6 and 25 from public.roll_dice((select v from t_ids where k = 'campaign'), '1d20 + 5', 'Attack', 'advantage')), 'server roll is in range');
select t_eq((select jsonb_array_length(detail -> 0 -> 'dice') from public.rolls order by created_at desc limit 1), 2, 'advantage rolls two d20s');
select t_true((select total between 3 and 18 from public.roll_dice((select v from t_ids where k = 'campaign'), '4d6kh3')), '4d6 keep 3 is in range');
select public.roll_dice((select v from t_ids where k = 'campaign'), '1d20', 'Secret', 'normal', true);
do $$ begin
  perform public.roll_dice((select v from public.t_ids where k = 'campaign'), '200d6');
  raise exception 'FAILED: huge roll allowed';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok: silly dice are refused';
end $$;
do $$ begin
  perform public.roll_dice((select v from public.t_ids where k = 'campaign'), '1d20; drop table x');
  raise exception 'FAILED: junk expression allowed';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok: junk dice text is refused';
end $$;
select t_eq((select roller_name from public.rolls limit 1), 'Bree', 'roll is labelled with the roller''s name');
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
select t_eq((select count(*)::int from public.rolls), 2, 'other players see public rolls but not private ones');
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select t_eq((select count(*)::int from public.rolls), 3, 'DM sees private rolls too');

/* ----------------------------------------------- DM reveals things */
update public.handouts set shown = true;
update public.tokens set hidden = false where name = 'Goblin';
update public.maps set revealed = overlay(revealed placing '1' from 8 * 10 + 9 for 1) where name = 'Cave';
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
select t_eq((select count(*)::int from public.handouts), 1, 'player sees a handout once shown');
select t_eq((select count(*)::int from storage.objects), 1, 'and can open its image');
select t_eq((select count(*)::int from public.tokens), 4, 'unhidden goblin and dragon in revealed square appear');
select t_eq((select count(*)::int from public.token_secrets), 0, 'still no enemy HP for players');
do $$ begin
  insert into storage.objects (bucket_id, name) values ('campaign-images', (select v from public.t_ids where k = 'campaign')::text || '/hack.png');
  raise exception 'FAILED: player uploaded an image';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
  raise notice 'ok: players cannot upload campaign images';
end $$;

/* --------------------------------------------------- switching maps */
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
update public.campaigns set active_map_id = (select v from t_ids where k = 'map2');
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
select t_eq((select name from public.maps), 'Secret lair', 'player now sees only the new active map');
select t_eq((select count(*)::int from public.tokens), 0, 'tokens on the old map disappear for players');

/* -------------------------------------------------- resizing keeps fog */
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
update public.maps set cols = 12 where name = 'Cave';
select t_eq((select char_length(revealed) from public.maps where name = 'Cave'), 120, 'fog is resized with the map');
select t_eq((select substr(revealed, 1 * 12 + 2, 1) from public.maps where name = 'Cave'), '1', 'revealed squares survive a resize');

/* ------------------------------------------------------- leaving */
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000003';
delete from public.campaign_members where user_id = auth.uid();
select t_eq((select count(*)::int from public.campaigns), 0, 'a player who leaves no longer sees the campaign');
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000002';
delete from public.campaign_members where role = 'dm';
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select t_eq((select count(*)::int from public.campaign_members where role = 'dm'), 1, 'players cannot remove the DM');

reset role;
