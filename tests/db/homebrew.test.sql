-- Homebrew tests: private libraries, campaign switches, DM-only monsters.
-- Run with tests/db/run.sh (after security.test.sql, which makes t_eq and t_true).
\set ON_ERROR_STOP 1

reset role;
create table public.h_ids (k text primary key, v uuid);
grant select, insert on public.h_ids to authenticated;
create or replace function public.hid(key text) returns uuid language sql stable as $$ select v from public.h_ids where k = key $$;
grant execute on function public.hid(text) to authenticated;
create or replace function public.h_fails(q text, msg text) returns void language plpgsql as $$
begin
  begin
    execute q;
  exception when others then
    raise notice 'ok: % (%)', msg, sqlerrm;
    return;
  end;
  raise exception 'FAILED: %', msg;
end $$;
grant execute on function public.h_fails(text, text) to authenticated;

insert into auth.users values
  ('eeeeeeee-0000-0000-0000-000000000001', 'hb-dm@example.com'),
  ('eeeeeeee-0000-0000-0000-000000000002', 'hb-player@example.com'),
  ('eeeeeeee-0000-0000-0000-000000000003', 'hb-other@example.com');

set role authenticated;

/* DM makes a campaign and two homebrew items. */
set request.jwt.claim.sub = 'eeeeeeee-0000-0000-0000-000000000001';
with x as (insert into public.campaigns (name) values ('Homebrew Hollow') returning id) insert into public.h_ids select 'camp', id from x;
with x as (insert into public.homebrew (kind, name, data) values ('monster', 'Mud Troll', '{"name": "Mud Troll"}') returning id) insert into public.h_ids select 'troll', id from x;
with x as (insert into public.homebrew (kind, name, data) values ('spell', 'Mud Bolt', '{"name": "Mud Bolt"}') returning id) insert into public.h_ids select 'bolt', id from x;
with x as (insert into public.homebrew (kind, name, data) values ('weapon', 'Secret Sword', '{"name": "Secret Sword"}') returning id) insert into public.h_ids select 'sword', id from x;
select public.h_fails($q$ insert into public.homebrew (kind, name) values ('vehicle', 'Cart') $q$, 'unknown kinds are refused');
select t_eq(public.homebrew_add(hid('camp'), hid('troll')), true, 'DM homebrew is switched on when added');
select public.homebrew_add(hid('camp'), hid('bolt'));

/* A player joins and adds their own homebrew. */
set request.jwt.claim.sub = 'eeeeeeee-0000-0000-0000-000000000002';
select t_eq((select count(*)::int from public.homebrew), 0, 'nothing visible before joining');
reset role;
insert into public.campaign_members (campaign_id, user_id, role) values (public.hid('camp'), 'eeeeeeee-0000-0000-0000-000000000002', 'player');
set role authenticated;
set request.jwt.claim.sub = 'eeeeeeee-0000-0000-0000-000000000002';
select t_eq((select string_agg(name, ',' order by name) from public.homebrew), 'Mud Bolt', 'player sees the DM''s switched-on spell, not the monster or unadded sword');
update public.homebrew set name = 'Hacked' where id = hid('bolt');
select t_eq((select name from public.homebrew where id = hid('bolt')), 'Mud Bolt', 'DM''s spell unchanged');
with x as (insert into public.homebrew (kind, name, data) values ('species', 'Mudling', '{"name": "Mudling"}') returning id) insert into public.h_ids select 'mudling', id from x;
select t_eq(public.homebrew_add(hid('camp'), hid('mudling')), false, 'a player''s homebrew waits for the DM');
select public.h_fails($q$ select public.homebrew_add(hid('camp'), hid('sword')) $q$, 'cannot add someone else''s homebrew');
select public.h_fails($q$ select public.homebrew_set_enabled(hid('camp'), hid('mudling'), true) $q$, 'players cannot switch homebrew on');
select public.h_fails($q$ insert into public.campaign_homebrew (campaign_id, homebrew_id, enabled) values (hid('camp'), hid('mudling'), true) $q$, 'players cannot write the switch table directly');

/* Another player in the campaign doesn't see pending homebrew. */
reset role;
insert into public.campaign_members (campaign_id, user_id, role) values (public.hid('camp'), 'eeeeeeee-0000-0000-0000-000000000003', 'player');
set role authenticated;
set request.jwt.claim.sub = 'eeeeeeee-0000-0000-0000-000000000003';
select t_eq((select string_agg(name, ',' order by name) from public.homebrew), 'Mud Bolt', 'other player: only switched-on, non-monster items');

/* The DM sees the pending species and switches it on. */
set request.jwt.claim.sub = 'eeeeeeee-0000-0000-0000-000000000001';
select t_eq((select count(*)::int from public.homebrew where id = hid('mudling')), 1, 'DM can review a pending player item');
select public.homebrew_set_enabled(hid('camp'), hid('mudling'), true);
set request.jwt.claim.sub = 'eeeeeeee-0000-0000-0000-000000000003';
select t_eq((select string_agg(name, ',' order by name) from public.homebrew), 'Mud Bolt,Mudling', 'switched-on player species now visible');
select t_eq((select count(*)::int from public.campaign_homebrew), 3, 'members see the campaign''s homebrew list');

/* Removing and switching off. */
set request.jwt.claim.sub = 'eeeeeeee-0000-0000-0000-000000000002';
select public.homebrew_remove(hid('camp'), hid('bolt'));
select t_eq((select count(*)::int from public.campaign_homebrew where homebrew_id = hid('bolt')), 1, 'a player cannot remove the DM''s item');
set request.jwt.claim.sub = 'eeeeeeee-0000-0000-0000-000000000001';
select public.homebrew_set_enabled(hid('camp'), hid('mudling'), false);
set request.jwt.claim.sub = 'eeeeeeee-0000-0000-0000-000000000003';
select t_eq((select count(*)::int from public.homebrew where id = hid('mudling')), 0, 'switched off again: hidden');
set request.jwt.claim.sub = 'eeeeeeee-0000-0000-0000-000000000002';
select t_eq((select count(*)::int from public.homebrew where id = hid('mudling')), 1, 'the owner always sees their own');
select public.homebrew_remove(hid('camp'), hid('mudling'));
select t_eq((select count(*)::int from public.campaign_homebrew where homebrew_id = hid('mudling')), 0, 'a player can take their own item out');
delete from public.homebrew where id = hid('mudling');
set request.jwt.claim.sub = 'eeeeeeee-0000-0000-0000-000000000001';
select t_eq((select count(*)::int from public.homebrew), 3, 'DM still has their three items');

reset role;
