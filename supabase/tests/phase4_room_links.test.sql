-- Phase 4D database tests (P4-19): read-only room links (phase 4 §17.8.5, §17.12; T4-R5, R6, R12; E22).
-- share_links gains the room target: a room link names its room and no share, a share link its share and no room;
-- a room link has no short code, lives at most 30 days and never follows a share's expiry; deleting the room
-- revokes its links ('room_deleted'); purging the room takes its links and their grants. A room share ending
-- leaves the room link alone; a link viewer's claim of a room burn share is logged as the link's, in the room.
begin;
create extension if not exists pgtap with schema extensions;

select plan(28);

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------
select has_column('app', 'share_links', 'room_id', 'share_links.room_id exists');
select fk_ok('app', 'share_links', 'room_id', 'app', 'rooms', 'id', 'a room link belongs to a room');
select is(
  (select confdeltype from pg_constraint where conrelid = 'app.share_links'::regclass and contype = 'f'
     and conkey = array[(select attnum from pg_attribute where attrelid = 'app.share_links'::regclass and attname = 'room_id')]::int2[]),
  'c', 'a room''s links go with the room row (ON DELETE CASCADE)');
select col_is_null('app', 'share_links', 'share_id', 'share_id is nullable now: a room link has none');
select ok(
  (select indexdef ~ '\(room_id, created_at DESC\) WHERE \(target_type = ''room''::text\)' from pg_indexes
    where schemaname = 'app' and indexname = 'share_links_room_idx'),
  'room links are found by room, newest first');

-- ---------------------------------------------------------------------------
-- Fixtures: users 49…, devices 49d…, sessions 49e…
--   01 owner of rooms R and S (account)   02 member of R (anonymous)
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, is_anonymous, encrypted_password, created_at, updated_at)
select ('49000000-0000-4000-8000-0000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       case when anon then null else 'l' || n || '@example.com' end, anon, '', now(), now()
  from (values ('01', false), ('02', true)) as u(n, anon);
insert into auth.sessions (id, user_id, created_at, updated_at)
select ('49e00000-0000-4000-8000-0000000000' || n)::uuid, ('49000000-0000-4000-8000-0000000000' || n)::uuid, now(), now()
  from unnest(array['01', '02']) as n;
insert into app.devices (id, user_id, label, auth_session_id)
select ('49d00000-0000-4000-8000-0000000000' || n)::uuid, ('49000000-0000-4000-8000-0000000000' || n)::uuid, 'Device ' || n,
       ('49e00000-0000-4000-8000-0000000000' || n)::uuid
  from unnest(array['01', '02']) as n;

create temp table lr (step text primary key, outcome text, room_id uuid) on commit drop;
grant select, insert on lr to app_server;
create function pg_temp.room(p_step text) returns uuid language sql stable as $$ select room_id from lr where step = p_step $$;
-- A room link, live for p_life, made p_age ago.
create function pg_temp.link(p_id text, p_room uuid, p_life interval default '1 day', p_age interval default '0') returns void
language sql as $$
  insert into app.share_links (id, target_type, room_id, secret_hmac, pepper_version, created_by_user_id, created_at, expires_at,
                               entitlement_snapshot)
  values (p_id, 'room', p_room, decode(repeat('5a', 32), 'hex'), 1, '49000000-0000-4000-8000-000000000001', now() - p_age,
          now() - p_age + p_life, '{"v": 2}');
$$;

grant app_server to current_user;
set local role app_server;
insert into lr select 'room-r', c.outcome, c.room_id
  from app.create_room('49000000-0000-4000-8000-000000000001', '49d00000-0000-4000-8000-000000000001', 'Room R', true,
                       '{"v": 2, "limits": {"maxRoomMembers": 50}}', 20) c;
insert into lr select 'room-s', c.outcome, c.room_id
  from app.create_room('49000000-0000-4000-8000-000000000001', '49d00000-0000-4000-8000-000000000001', 'Room S', true,
                       '{"v": 2, "limits": {"maxRoomMembers": 50}}', 20) c;
reset role;
insert into app.room_members (room_id, user_id, role, joined_via, invite_id)
values (pg_temp.room('room-r'), '49000000-0000-4000-8000-000000000002', 'member', 'invite_link', 'InviteForRoomR01');

-- ---------------------------------------------------------------------------
-- The target checks (C4-10 widened; still no network-feed link, Q-028)
-- ---------------------------------------------------------------------------
select lives_ok($q$select pg_temp.link('RoomLinkR0000001', pg_temp.room('room-r'))$q$, 'a room link names its room and no share');
select throws_ok(
  $q$insert into app.share_links (id, target_type, secret_hmac, pepper_version, expires_at, entitlement_snapshot)
     values ('RoomLinkNoRoom01', 'room', decode(repeat('5a', 32), 'hex'), 1, now() + interval '1 day', '{}')$q$,
  '23514', null, 'a room link needs its room');
insert into app.shares (id, scope, room_id, kind, created_by_user_id, created_by_device_id, billing_subject_type, billing_subject_id,
                        status, retention_class, expires_at, burn_after_download, entitlement_snapshot)
values ('a4900000-0000-4000-8000-000000000001', 'room', pg_temp.room('room-r'), 'text', '49000000-0000-4000-8000-000000000002',
        '49d00000-0000-4000-8000-000000000002', 'user', '49000000-0000-4000-8000-000000000002', 'active', 'd7', now() + interval '1 day',
        false, '{}'),
       ('a4900000-0000-4000-8000-000000000002', 'room', pg_temp.room('room-r'), 'text', '49000000-0000-4000-8000-000000000002',
        '49d00000-0000-4000-8000-000000000002', 'user', '49000000-0000-4000-8000-000000000002', 'active', 'd7', now() + interval '1 day',
        true, '{}');
insert into app.text_items (share_id, content, content_bytes)
values ('a4900000-0000-4000-8000-000000000001', 'plain room note', 15), ('a4900000-0000-4000-8000-000000000002', 'read once', 9);
select throws_ok(format($q$
  insert into app.share_links (id, target_type, room_id, share_id, secret_hmac, pepper_version, expires_at, entitlement_snapshot)
  values ('RoomLinkAndShare', 'room', %L, 'a4900000-0000-4000-8000-000000000001', decode(repeat('5a', 32), 'hex'), 1,
          now() + interval '1 hour', '{}')$q$, pg_temp.room('room-r')),
  '23514', null, 'a room link targets the room only, never also a share');
select throws_ok(format($q$
  insert into app.share_links (id, share_id, room_id, secret_hmac, pepper_version, expires_at, entitlement_snapshot)
  values ('ShareLinkInRoom1', 'a4900000-0000-4000-8000-000000000001', %L, decode(repeat('5a', 32), 'hex'), 1,
          now() + interval '1 hour', '{}')$q$, pg_temp.room('room-r')),
  '23514', null, 'a share link names no room');
select throws_ok(
  $q$insert into app.share_links (id, secret_hmac, pepper_version, expires_at, entitlement_snapshot)
     values ('ShareLinkNoShare', decode(repeat('5a', 32), 'hex'), 1, now() + interval '1 hour', '{}')$q$,
  '23514', null, 'a share link still needs its share');
select throws_ok(
  $q$insert into app.share_links (id, target_type, secret_hmac, pepper_version, expires_at, entitlement_snapshot)
     values ('NetworkFeedLink1', 'network', decode(repeat('5a', 32), 'hex'), 1, now() + interval '1 hour', '{}')$q$,
  '23514', null, 'there is no network-feed link (Q-028, DEC-033)');
select throws_ok(format($q$
  insert into app.share_links (id, target_type, room_id, secret_hmac, pepper_version, short_code_hmac, short_code_pepper_version,
                               short_code_expires_at, expires_at, entitlement_snapshot)
  values ('RoomLinkWithCode', 'room', %L, decode(repeat('5a', 32), 'hex'), 1, decode(repeat('c9', 32), 'hex'), 1,
          now() + interval '10 minutes', now() + interval '1 day', '{}')$q$, pg_temp.room('room-r')),
  '23514', null, 'a room link has no short code');
select throws_ok($q$select pg_temp.link('RoomLinkTooLong1', pg_temp.room('room-r'), '30 days 1 second')$q$,
  '23514', null, 'a room link lives at most 30 days (D4-17)');
select lives_ok($q$select pg_temp.link('RoomLinkThirtyD1', pg_temp.room('room-r'), '30 days')$q$, 'exactly 30 days is allowed');
select throws_ok(format($q$
  insert into app.share_links (id, target_type, room_id, secret_hmac, pepper_version, expires_at, follows_share_expiry, entitlement_snapshot)
  values ('RoomLinkFollows1', 'room', %L, decode(repeat('5a', 32), 'hex'), 1, now() + interval '1 day', true, '{}')$q$,
  pg_temp.room('room-r')),
  '23514', null, 'a room link never follows a share''s expiry');

-- ---------------------------------------------------------------------------
-- Room shares ending, burn claims through a room link, operator blocks
-- ---------------------------------------------------------------------------
select ok(app.end_share('a4900000-0000-4000-8000-000000000001', 'deleted_by_creator'), 'a room share ends');
select is((select revoked_at from app.share_links where id = 'RoomLinkR0000001'), null, 'a room share ending leaves the room link alone');
select is(
  (select outcome from app.claim_burn_share('a4900000-0000-4000-8000-000000000002', null, 'text', null, null,
                                            decode(repeat('ab', 32), 'hex'), 'RoomLinkR0000001', null, 'Firefox')),
  'claimed', 'a room link''s viewer session claims a room burn share');
select is(
  (select row(actor_kind, link_id, room_id, network_space_id, event)::text from app.downloads where share_id = 'a4900000-0000-4000-8000-000000000002'),
  row('link_viewer', 'RoomLinkR0000001', pg_temp.room('room-r'), null::uuid, 'text_revealed')::text,
  'the claim is logged as the link viewer''s, in the room, with no network');
select pg_temp.link('RoomLinkBlocked1', pg_temp.room('room-r'));
select ok((app.admin_block_link('RoomLinkBlocked1', 'test', 'tests') ->> 'linkId') = 'RoomLinkBlocked1', 'an operator blocks a room link');
select is((select revoke_reason from app.share_links where id = 'RoomLinkBlocked1'), 'blocked', 'it is revoked as blocked');

-- ---------------------------------------------------------------------------
-- Deleting the room revokes its links (§17.8.4); purging it takes them, with their grants
-- ---------------------------------------------------------------------------
select pg_temp.link('RoomLinkS0000001', pg_temp.room('room-s'));
set local role app_server;
select ok(app.delete_room(pg_temp.room('room-r'), '49000000-0000-4000-8000-000000000001', 'deleted_by_owner') is not null, 'room R is deleted');
reset role;
select is(
  (select array_agg(revoke_reason order by id) from app.share_links where room_id = pg_temp.room('room-r') and id <> 'RoomLinkBlocked1'),
  array['room_deleted', 'room_deleted'], 'every live link of the room is revoked as room_deleted');
select is((select revoke_reason from app.share_links where id = 'RoomLinkBlocked1'), 'blocked', 'an already revoked link keeps its reason');
select is((select revoked_at from app.share_links where id = 'RoomLinkS0000001'), null, 'another room''s link is untouched');

insert into app.link_sessions (id_hash, expires_at) values (decode(repeat('cd', 32), 'hex'), now() + interval '1 day');
insert into app.link_grants (session_id_hash, link_id, granted_via, expires_at)
values (decode(repeat('cd', 32), 'hex'), 'RoomLinkS0000001', 'secret', now() + interval '1 hour');
set local role app_server;
select ok(app.delete_room(pg_temp.room('room-s'), '49000000-0000-4000-8000-000000000001', 'deleted_by_owner') is not null, 'room S is deleted');
reset role;
update app.rooms set deleted_at = now() - interval '31 days' where id = pg_temp.room('room-s');
select ok(app.purge_ephemeral() >= 1, 'purge-ephemeral runs');
select is(
  (select count(*)::int from app.share_links where id = 'RoomLinkS0000001') + (select count(*)::int from app.link_grants where link_id = 'RoomLinkS0000001'),
  0, 'a purged room takes its links and their grants');

select * from finish();
rollback;
