-- Phase 4D database tests (P4-17): private rooms (phase 4 §17.8.4, §17.11, §17.12; T-034, T4-R11, T4-R13, T4-R14).
-- Tables, keys, constraints and grants; app.room_role, app.create_room (the room cap), app.accept_room_invite
-- (the secret, expiry, revocation, uses, the member cap, rejoin), app.delete_room; Realtime room topics (members
-- only, no presence) and their ID-only signals; room shares never touching a network (G-R2, G-R3); a room
-- member's burn claim; memberships moving in a merge; account deletion deleting the owner's rooms; purging.
begin;
create extension if not exists pgtap with schema extensions;

select plan(100);

-- ---------------------------------------------------------------------------
-- Structure, keys and grants
-- ---------------------------------------------------------------------------
select has_table('app', 'rooms', 'app.rooms exists');
select has_table('app', 'room_members', 'app.room_members exists');
select has_table('app', 'room_invites', 'app.room_invites exists');
select col_is_pk('app', 'room_members', array['room_id', 'user_id'], 'a membership is one (room, user)');
select ok((select indisunique from pg_index where indexrelid = 'app.room_members_id_key'::regclass), 'the opaque memberId is unique');
select ok((select indisunique from pg_index where indexrelid = 'app.room_members_one_owner_idx'::regclass), 'one active owner per room');
select is(
  (select array_agg(indexname::text order by indexname) from pg_indexes
    where schemaname = 'app'
      and indexname in ('rooms_owner_idx', 'rooms_deleted_idx', 'room_members_user_idx', 'room_members_active_idx', 'room_members_removed_idx',
                        'room_invites_room_idx', 'room_invites_expiry_idx', 'shares_room_feed_idx', 'shares_room_idx')),
  array['room_invites_expiry_idx', 'room_invites_room_idx', 'room_members_active_idx', 'room_members_removed_idx', 'room_members_user_idx',
        'rooms_deleted_idx', 'rooms_owner_idx', 'shares_room_feed_idx', 'shares_room_idx'],
  'the lookup indexes exist: rooms by owner, memberships by user and by room, invites by room, room feeds, and the purges');
select fk_ok('app', 'room_members', 'room_id', 'app', 'rooms', 'id', 'members belong to a room');
select fk_ok('app', 'room_invites', 'room_id', 'app', 'rooms', 'id', 'invites belong to a room');
select fk_ok('app', 'shares', 'room_id', 'app', 'rooms', 'id', 'a room share names its room');
select is(
  (select confdeltype from pg_constraint where conrelid = 'app.shares'::regclass and contype = 'f'
     and conkey = array[(select attnum from pg_attribute where attrelid = 'app.shares'::regclass and attname = 'room_id')]::int2[]),
  'r', 'a room with share rows can''t be hard-deleted (ON DELETE RESTRICT; tombstones first)');
select ok(
  (select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('app.rooms'::regclass, 'app.room_members'::regclass, 'app.room_invites'::regclass)),
  'RLS is on for every room table');
select ok(
  has_table_privilege('app_server', 'app.rooms', 'SELECT,INSERT,UPDATE,DELETE')
  and has_table_privilege('app_server', 'app.room_members', 'SELECT,INSERT,UPDATE,DELETE')
  and has_table_privilege('app_server', 'app.room_invites', 'SELECT,INSERT,UPDATE,DELETE')
  and not has_table_privilege('authenticated', 'app.room_members', 'SELECT')
  and not has_table_privilege('anon', 'app.room_invites', 'SELECT')
  and not has_table_privilege('app_janitor', 'app.rooms', 'SELECT'),
  'the server has DML on the room tables; client roles and the janitor have nothing');
select ok(
  has_function_privilege('app_server', 'app.room_role(uuid, uuid)', 'EXECUTE')
  and has_function_privilege('app_server', 'app.create_room(uuid, uuid, text, boolean, jsonb, integer)', 'EXECUTE')
  and has_function_privilege('app_server', 'app.accept_room_invite(text, bytea[], uuid, uuid)', 'EXECUTE')
  and has_function_privilege('app_server', 'app.delete_room(uuid, uuid, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app.accept_room_invite(text, bytea[], uuid, uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'app.room_role(uuid, uuid)', 'EXECUTE')
  and not has_function_privilege('app_server', 'app.emit_member_changed()', 'EXECUTE'),
  'the room functions are the server''s; clients can call none; the signal triggers are callable by no one');

-- ---------------------------------------------------------------------------
-- Fixtures: users 47…<n>, devices 47d…, sessions 47e…
--   01 owner (account)   02 member (anonymous)   03 outsider   04 removed member   05 owner of room B
--   06 suspended member  07 member whose device was revoked   08 merge source (anonymous)   09 merge target
--   0a account due for deletion (owns room D)
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, is_anonymous, encrypted_password, created_at, updated_at)
select ('47000000-0000-4000-8000-0000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       case when anon then null else 'r' || n || '@example.com' end, anon, '', now(), now()
  from (values ('01', false), ('02', true), ('03', true), ('04', true), ('05', false), ('06', true), ('07', true), ('08', true),
               ('09', false), ('0a', false)) as u(n, anon);
insert into auth.sessions (id, user_id, created_at, updated_at)
select ('47e00000-0000-4000-8000-0000000000' || n)::uuid, ('47000000-0000-4000-8000-0000000000' || n)::uuid, now(), now()
  from unnest(array['01', '02', '03', '04', '05', '06', '07', '08', '09', '0a']) as n;
insert into app.devices (id, user_id, label, auth_session_id)
select ('47d00000-0000-4000-8000-0000000000' || n)::uuid, ('47000000-0000-4000-8000-0000000000' || n)::uuid, 'Device ' || n,
       ('47e00000-0000-4000-8000-0000000000' || n)::uuid
  from unnest(array['01', '02', '03', '04', '05', '06', '07', '08', '09', '0a']) as n;
update app.devices set revoked_at = now(), revoked_reason = 'user' where id = '47d00000-0000-4000-8000-000000000007';
insert into app.user_flags (user_id, suspended_at, reason) values ('47000000-0000-4000-8000-000000000006', now(), 'test');
insert into app.network_spaces (id, network_key, key_version, family)
values ('47f00000-0000-4000-8000-000000000001', decode(repeat('47', 32), 'hex'), 1, 4);

create temp table rr (step text primary key, outcome text, room_id uuid) on commit drop;
create temp table topic_checks (label text primary key, allowed boolean) on commit drop;
grant insert on topic_checks to authenticated;
grant select, insert on rr to app_server;
grant select on rr to authenticated;

create function pg_temp.u(p text) returns uuid language sql immutable as $$ select ('47000000-0000-4000-8000-0000000000' || p)::uuid $$;
create function pg_temp.d(p text) returns uuid language sql immutable as $$ select ('47d00000-0000-4000-8000-0000000000' || p)::uuid $$;
create function pg_temp.room(p_step text) returns uuid language sql stable as $$ select room_id from rr where step = p_step $$;
create function pg_temp.hmac(p text) returns bytea language sql immutable as $$ select decode(repeat(p, 32), 'hex') $$;
create function pg_temp.invite(p_id text, p_room uuid, p_fill text, p_max integer default null, p_expires interval default '1 hour') returns void
language sql as $$
  insert into app.room_invites (id, room_id, kind, secret_hmac, pepper_version, created_by_user_id, expires_at, max_uses)
  values (p_id, p_room, 'invite_link', pg_temp.hmac(p_fill), 1, (select owner_user_id from app.rooms where id = p_room), now() + p_expires, p_max);
$$;
create function pg_temp.accept(p_step text, p_invite text, p_fill text, p_user text) returns void language sql as $$
  insert into rr select p_step, a.outcome, a.room_id
    from app.accept_room_invite(p_invite, array[pg_temp.hmac(p_fill)], pg_temp.u(p_user), pg_temp.d(p_user)) a;
$$;
create function pg_temp.active(p_room uuid) returns integer language sql stable as $$
  select count(*)::int from app.room_members where room_id = p_room and removed_at is null $$;

-- ---------------------------------------------------------------------------
-- Creating rooms (E17): the owner's membership comes with the room; the cap holds
-- ---------------------------------------------------------------------------
grant app_server to current_user;
set local role app_server;
insert into rr select 'create-a', c.outcome, c.room_id
  from app.create_room(pg_temp.u('01'), pg_temp.d('01'), 'Room A', true, '{"v": 2, "limits": {"maxRoomMembers": 4}}', 2) c;
insert into rr select 'create-a2', c.outcome, c.room_id
  from app.create_room(pg_temp.u('01'), pg_temp.d('01'), 'Calm Harbor', false, '{"v": 2, "limits": {"maxRoomMembers": 4}}', 2) c;
insert into rr select 'create-a3', c.outcome, c.room_id
  from app.create_room(pg_temp.u('01'), pg_temp.d('01'), 'One too many', true, '{"v": 2, "limits": {"maxRoomMembers": 4}}', 2) c;
insert into rr select 'create-b', c.outcome, c.room_id
  from app.create_room(pg_temp.u('05'), pg_temp.d('05'), 'Room B', true, '{"v": 2, "limits": {"maxRoomMembers": 50}}', 20) c;
reset role;

select is((select outcome from rr where step = 'create-a'), 'created', 'a room is created');
select is(
  (select row(role, joined_via, joined_device_id, invite_id is null)::text from app.room_members
    where room_id = pg_temp.room('create-a') and user_id = pg_temp.u('01')),
  row('owner', 'creator', pg_temp.d('01'), true)::text, 'its owner is a member: role owner, joined as creator, from their device');
select is((select owner_user_id from app.rooms where id = pg_temp.room('create-a')), pg_temp.u('01'), 'the room records its owner');
select is((select row(outcome, room_id)::text from rr where step = 'create-a3'), row('room_limit', null::uuid)::text,
  'the owner''s open rooms stay under the cap (409 ROOM_LIMIT)');
select is((select count(*)::int from app.rooms where owner_user_id = pg_temp.u('01')), 2, 'a refused creation leaves no room');

-- Room scope never meets a network (G-R2) and always names its room.
select throws_ok($q$
  insert into app.shares (scope, kind, billing_subject_type, billing_subject_id, status, retention_class, expires_at, entitlement_snapshot)
  values ('room', 'text', 'user', '47000000-0000-4000-8000-000000000001', 'active', 'd7', now() + interval '1 day', '{}')$q$,
  '23514', null, 'a room share needs its room');
select throws_ok(format($q$
  insert into app.shares (scope, room_id, network_space_id, kind, billing_subject_type, billing_subject_id, status, retention_class,
                          expires_at, entitlement_snapshot)
  values ('room', %L, '47f00000-0000-4000-8000-000000000001', 'text', 'user', '47000000-0000-4000-8000-000000000001', 'active', 'd7',
          now() + interval '1 day', '{}')$q$, pg_temp.room('create-a')),
  '23514', null, 'a room share can''t carry a network space (G-R2)');
select throws_ok(format($q$
  insert into app.shares (scope, room_id, network_space_id, kind, billing_subject_type, billing_subject_id, status, retention_class,
                          expires_at, entitlement_snapshot)
  values ('network', %L, '47f00000-0000-4000-8000-000000000001', 'text', 'user', '47000000-0000-4000-8000-000000000001', 'active', 'd7',
          now() + interval '1 day', '{}')$q$, pg_temp.room('create-a')),
  '23514', null, 'a network share can''t be in a room');
select throws_ok(format($q$
  insert into app.shares (scope, room_id, kind, billing_subject_type, billing_subject_id, status, retention_class, expires_at, entitlement_snapshot)
  values ('link_only', %L, 'text', 'user', '47000000-0000-4000-8000-000000000001', 'active', 'd7', now() + interval '1 day', '{}')$q$,
  pg_temp.room('create-a')),
  '23514', null, 'a link-only share can''t be in a room');

-- Room, member and invite checks.
select throws_ok($q$insert into app.rooms (owner_user_id, label, entitlement_snapshot) values ('47000000-0000-4000-8000-000000000001', '', '{}')$q$,
  '23514', null, 'a room label is never empty');
select throws_ok($q$insert into app.rooms (owner_user_id, label, entitlement_snapshot) values ('47000000-0000-4000-8000-000000000001', E'Café', '{}')$q$,
  '23514', null, 'a room label is stored NFC-normalized');
select throws_ok($q$insert into app.rooms (label, entitlement_snapshot) values ('No owner', '{}')$q$,
  '23514', null, 'an open room always has an owner');
select throws_ok(format($q$update app.room_members set removed_at = now(), removed_reason = 'left' where room_id = %L and role = 'owner'$q$,
  pg_temp.room('create-a')), '23514', null, 'the owner can''t leave (D4-18)');
select throws_ok(format($q$insert into app.room_members (room_id, user_id, role, joined_via) values (%L, '47000000-0000-4000-8000-000000000003', 'member', 'creator')$q$,
  pg_temp.room('create-a')), '23514', null, 'only the owner joined as the creator');
select throws_ok(format($q$insert into app.room_members (room_id, user_id, role, joined_via) values (%L, '47000000-0000-4000-8000-000000000003', 'member', 'invite_link')$q$,
  pg_temp.room('create-a')), '23514', null, 'a member who joined by invite records the invite');
select throws_ok(format($q$
  insert into app.room_invites (id, room_id, kind, secret_hmac, pepper_version, expires_at, max_uses)
  values ('PairingTooLong01', %L, 'pairing', decode(repeat('aa', 32), 'hex'), 1, now() + interval '11 minutes', 1)$q$, pg_temp.room('create-a')),
  '23514', null, 'a pairing invite lives at most 10 minutes');
select throws_ok(format($q$
  insert into app.room_invites (id, room_id, kind, secret_hmac, pepper_version, expires_at, max_uses)
  values ('PairingTwoUses01', %L, 'pairing', decode(repeat('aa', 32), 'hex'), 1, now() + interval '5 minutes', 2)$q$, pg_temp.room('create-a')),
  '23514', null, 'a pairing invite is single use');
select throws_ok(format($q$
  insert into app.room_invites (id, room_id, kind, secret_hmac, pepper_version, expires_at)
  values ('InviteTooLong001', %L, 'invite_link', decode(repeat('aa', 32), 'hex'), 1, now() + interval '7 days 1 minute')$q$, pg_temp.room('create-a')),
  '23514', null, 'an invite link lives at most 7 days');
select throws_ok(format($q$
  insert into app.room_invites (id, room_id, kind, secret_hmac, pepper_version, expires_at)
  values ('InviteShortHmac1', %L, 'invite_link', decode(repeat('aa', 16), 'hex'), 1, now() + interval '1 hour')$q$, pg_temp.room('create-a')),
  '23514', null, 'an invite stores a 32-byte HMAC, never the secret');
select throws_ok(format($q$
  insert into app.room_invites (id, room_id, kind, secret_hmac, pepper_version, expires_at, max_uses, use_count)
  values ('InviteOverused01', %L, 'invite_link', decode(repeat('aa', 32), 'hex'), 1, now() + interval '1 hour', 1, 2)$q$, pg_temp.room('create-a')),
  '23514', null, 'an invite is never used more than its maximum');

-- ---------------------------------------------------------------------------
-- Accepting invites (T-034, E19)
-- ---------------------------------------------------------------------------
select pg_temp.invite('InviteRoomA00001', pg_temp.room('create-a'), 'a1');
select pg_temp.invite('InviteRoomA0Once', pg_temp.room('create-a'), 'a2', 1);
select pg_temp.invite('InviteRoomB00001', pg_temp.room('create-b'), 'b1');
select pg_temp.invite('InviteExpired001', pg_temp.room('create-a'), 'a3', null, '1 second');
update app.room_invites set created_at = now() - interval '1 hour', expires_at = now() - interval '1 minute' where id = 'InviteExpired001';
select pg_temp.invite('InviteRevoked001', pg_temp.room('create-a'), 'a4');
update app.room_invites set revoked_at = now() where id = 'InviteRevoked001';

set local role app_server;
select pg_temp.accept('wrong-secret', 'InviteRoomA00001', 'ff', '02');
select pg_temp.accept('unknown', 'InviteUnknown001', 'a1', '02');
select pg_temp.accept('b-secret-on-a', 'InviteRoomA00001', 'b1', '02');
select pg_temp.accept('join', 'InviteRoomA00001', 'a1', '02');
select pg_temp.accept('join-again', 'InviteRoomA00001', 'a1', '02');
select pg_temp.accept('once', 'InviteRoomA0Once', 'a2', '04');
select pg_temp.accept('once-replay-other', 'InviteRoomA0Once', 'a2', '03');
select pg_temp.accept('once-replay-same', 'InviteRoomA0Once', 'a2', '04');
select pg_temp.accept('expired', 'InviteExpired001', 'a3', '03');
select pg_temp.accept('revoked', 'InviteRevoked001', 'a4', '03');
select pg_temp.accept('b-join', 'InviteRoomB00001', 'b1', '03');
reset role;

select is((select outcome from rr where step = 'wrong-secret'), 'unavailable', 'a wrong secret is unavailable (404)');
select is((select outcome from rr where step = 'unknown'), 'unavailable', 'an unknown invite is unavailable, the same answer (404)');
select is((select outcome from rr where step = 'b-secret-on-a'), 'unavailable', 'another invite''s secret opens nothing (Room B''s on Room A)');
select is((select row(outcome, room_id)::text from rr where step = 'join'), row('joined', pg_temp.room('create-a'))::text,
  'the right secret joins the invite''s room');
select is(
  (select row(role, joined_via, invite_id, joined_device_id)::text from app.room_members where room_id = pg_temp.room('create-a') and user_id = pg_temp.u('02')),
  row('member', 'invite_link', 'InviteRoomA00001', pg_temp.d('02'))::text, 'the anonymous member joined by that invite, from their device (D4-19)');
select is((select row(outcome, room_id)::text from rr where step = 'join-again'), row('already_member', pg_temp.room('create-a'))::text,
  'joining again is idempotent');
select is((select use_count from app.room_invites where id = 'InviteRoomA00001'), 1, 'wrong secrets and repeats use nothing; the join used one');
select is((select outcome from rr where step = 'once'), 'joined', 'a single-use invite works once');
select is((select outcome from rr where step = 'once-replay-other'), 'expired', 'and never again for anyone else (replay → 410)');
select is((select outcome from rr where step = 'once-replay-same'), 'already_member', 'its own user repeating it is already a member');
select is((select outcome from rr where step = 'expired'), 'expired', 'an expired invite is refused after proof (410)');
select is((select outcome from rr where step = 'revoked'), 'expired', 'a revoked invite is refused after proof (410)');
select is((select row(outcome, room_id)::text from rr where step = 'b-join'), row('joined', pg_temp.room('create-b'))::text,
  'Room B''s invite joins Room B only');
select is((select count(*)::int from app.room_members where user_id = pg_temp.u('03') and room_id = pg_temp.room('create-a')), 0,
  'the outsider is in no room of A''s after the refusals');

-- The member cap (E19, D4-14): room A's snapshot allows 4. Owner, 02 and 04 are in; 06 fills it; 07 is refused.
set local role app_server;
select pg_temp.accept('fill', 'InviteRoomA00001', 'a1', '06');
select pg_temp.accept('over-cap', 'InviteRoomA00001', 'a1', '07');
reset role;
select is((select outcome from rr where step = 'fill'), 'joined', 'members up to the room''s snapshot cap join');
select is((select outcome from rr where step = 'over-cap'), 'member_limit', 'one more is refused (409 ROOM_MEMBER_LIMIT)');
select is(pg_temp.active(pg_temp.room('create-a')), 4, 'the room holds exactly its cap');

-- Removal, then a rejoin with a valid invite (the matrix: a removed member may rejoin).
update app.room_members set removed_at = now(), removed_reason = 'removed', removed_by_user_id = pg_temp.u('01')
 where room_id = pg_temp.room('create-a') and user_id = pg_temp.u('04');
create temp table member_before on commit drop as
  select id, joined_at from app.room_members where room_id = pg_temp.room('create-a') and user_id = pg_temp.u('04');
select is(app.room_role(pg_temp.room('create-a'), pg_temp.u('04')), null, 'a removed member has no role');
update app.room_members set joined_at = now() - interval '1 hour' where room_id = pg_temp.room('create-a') and user_id = pg_temp.u('04');
set local role app_server;
select pg_temp.accept('rejoin', 'InviteRoomA00001', 'a1', '04');
reset role;
select is((select outcome from rr where step = 'rejoin'), 'joined', 'a removed member rejoins with a valid invite');
select is(
  (select row(m.id = b.id, m.removed_at is null, m.removed_reason is null, m.joined_at = now())::text
     from app.room_members m, member_before b where m.room_id = pg_temp.room('create-a') and m.user_id = pg_temp.u('04')),
  row(true, true, true, true)::text, 'the same membership row comes back, cleared, joined now');

-- ---------------------------------------------------------------------------
-- room_role (§17.11.2)
-- ---------------------------------------------------------------------------
select is(app.room_role(pg_temp.room('create-a'), pg_temp.u('01')), 'owner', 'the owner''s role');
select is(app.room_role(pg_temp.room('create-a'), pg_temp.u('02')), 'member', 'a member''s role');
select is(app.room_role(pg_temp.room('create-a'), pg_temp.u('03')), null, 'a non-member has none');
select is(app.room_role(pg_temp.room('create-a'), pg_temp.u('05')), null, 'another room''s owner has none here');

-- ---------------------------------------------------------------------------
-- Realtime room topics (§17.8.4)
-- ---------------------------------------------------------------------------
create function pg_temp.topic(p_label text, p_user text, p_topic text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', pg_temp.u(p_user), 'role', 'authenticated', 'session_id', ('47e00000-0000-4000-8000-0000000000' || p_user))::text, true);
  insert into topic_checks values (p_label, app_realtime.can_access_topic(p_topic));
end
$$;
grant execute on function pg_temp.topic(text, text, text) to authenticated;
-- 07 joins room B, then (already) has a revoked device.
insert into app.room_members (room_id, user_id, role, joined_via, invite_id) values (pg_temp.room('create-b'), pg_temp.u('07'), 'member', 'invite_link', 'InviteRoomB00001');
set local role authenticated;
select pg_temp.topic('owner', '01', 'room:' || pg_temp.room('create-a'));
select pg_temp.topic('member', '02', 'room:' || pg_temp.room('create-a'));
select pg_temp.topic('outsider', '03', 'room:' || pg_temp.room('create-a'));
select pg_temp.topic('other owner', '05', 'room:' || pg_temp.room('create-a'));
select pg_temp.topic('suspended member', '06', 'room:' || pg_temp.room('create-a'));
select pg_temp.topic('revoked device', '07', 'room:' || pg_temp.room('create-b'));
select pg_temp.topic('malformed', '02', 'room:' || pg_temp.room('create-a') || ':x');
select set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.u('02'), 'role', 'authenticated')::text, true);
insert into topic_checks values ('no session', app_realtime.can_access_topic('room:' || pg_temp.room('create-a')));
reset role;
select is((select allowed from topic_checks where label = 'owner'), true, 'the owner may join room:{id}');
select is((select allowed from topic_checks where label = 'member'), true, 'an active member may join room:{id}');
select is(
  (select bool_or(allowed) from topic_checks where label in ('outsider', 'other owner', 'suspended member', 'revoked device', 'malformed', 'no session')),
  false, 'non-members, another room''s owner, a suspended member, a revoked device''s session, malformed topics and tokens without a session are refused');

-- ---------------------------------------------------------------------------
-- Signals: room shares go to the room and the creator, never to a network (G-R3); membership changes
-- ---------------------------------------------------------------------------
insert into app.shares (id, scope, room_id, kind, created_by_user_id, created_by_device_id, billing_subject_type, billing_subject_id,
                        status, retention_class, expires_at, entitlement_snapshot)
values ('a4700000-0000-4000-8000-000000000001', 'room', pg_temp.room('create-a'), 'text', pg_temp.u('02'), pg_temp.d('02'), 'user', pg_temp.u('02'),
        'active', 'd7', now() + interval '1 day', '{}');
insert into app.text_items (share_id, content, content_bytes) values ('a4700000-0000-4000-8000-000000000001', 'hello room', 10);
update app.text_items set version = 2 where share_id = 'a4700000-0000-4000-8000-000000000001';
select is(
  (select array_agg(split_part(topic, ':', 1) order by topic) from realtime.messages
    where payload ->> 'shareId' = 'a4700000-0000-4000-8000-000000000001' and payload ->> 'status' = 'active'),
  array['room', 'user'], 'a new room share is signalled on its room and to its creator, on no net: topic (G-R3)');
select is(
  (select topic from realtime.messages
    where payload ->> 'shareId' = 'a4700000-0000-4000-8000-000000000001' and payload ->> 'version' = '2' and topic like 'room:%'),
  'room:' || pg_temp.room('create-a'), 'a text edit is signalled on the room too');
select is(
  (select count(*)::int from realtime.messages where topic = 'room:' || pg_temp.room('create-a') and event = 'member.changed'
      and payload ->> 'change' = 'joined'),
  5, 'each join was signalled on the room (the owner''s, 02, 04, 06 and the rejoin)');
select is(
  (select payload - 'v' - 'id' from realtime.messages where topic = 'user:' || pg_temp.u('04') and event = 'membership.changed'
      and payload ->> 'change' = 'removed'),
  jsonb_build_object('type', 'membership.changed', 'roomId', pg_temp.room('create-a'), 'change', 'removed'),
  'the removed member''s own topic says which room, and nothing else');
update app.rooms set label = 'Room A renamed' where id = pg_temp.room('create-a');
select is((select count(*)::int from realtime.messages where topic = 'room:' || pg_temp.room('create-a') and event = 'room.updated'), 1,
  'a rename is signalled on the room');
-- A removed member is refused at their next join (RISK-007: a channel already joined lasts until the token refreshes).
update app.room_members set removed_at = now(), removed_reason = 'left', removed_by_user_id = pg_temp.u('02')
 where room_id = pg_temp.room('create-a') and user_id = pg_temp.u('02');
set local role authenticated;
select pg_temp.topic('removed member', '02', 'room:' || pg_temp.room('create-a'));
reset role;
update app.room_members set removed_at = null, removed_reason = null, removed_by_user_id = null
 where room_id = pg_temp.room('create-a') and user_id = pg_temp.u('02');
select is((select allowed from topic_checks where label = 'removed member'), false, 'a removed member may not join room:{id} again');

-- A room member's burn claim is logged as room_member, with the room (DEC-015).
insert into app.shares (id, scope, room_id, kind, created_by_user_id, billing_subject_type, billing_subject_id, status, retention_class,
                        expires_at, burn_after_download, entitlement_snapshot)
values ('a4700000-0000-4000-8000-000000000002', 'room', pg_temp.room('create-a'), 'text', pg_temp.u('01'), 'user', pg_temp.u('01'),
        'active', 'd7', now() + interval '1 day', true, '{}');
insert into app.text_items (share_id, content, content_bytes) values ('a4700000-0000-4000-8000-000000000002', 'burn in a room', 14);
select is(
  (select outcome from app.claim_burn_share('a4700000-0000-4000-8000-000000000002', null, 'text', pg_temp.u('02'), pg_temp.d('02'), null, null, null, null)),
  'claimed', 'the first member other than the creator claims a room burn share');
select is(
  (select row(actor_kind, room_id, network_space_id)::text from app.downloads where share_id = 'a4700000-0000-4000-8000-000000000002'),
  row('room_member', pg_temp.room('create-a'), null::uuid)::text, 'the claim is logged as a room member''s, in the room, with no network');

-- ---------------------------------------------------------------------------
-- Deleting a room (T4-R14): shares end, links and invites revoked, members removed, soft deletion
-- ---------------------------------------------------------------------------
insert into app.shares (id, scope, room_id, kind, created_by_user_id, billing_subject_type, billing_subject_id, status, retention_class,
                        expires_at, file_count, total_bytes, entitlement_snapshot)
values ('a4700000-0000-4000-8000-000000000003', 'room', pg_temp.room('create-a'), 'files', pg_temp.u('02'), 'user', pg_temp.u('02'),
        'active', 'd7', now() + interval '1 day', 1, 5, '{}');
insert into app.files (id, share_id, object_key, original_name, declared_mime, stored_content_type, declared_size_bytes, size_bytes,
                       upload_status, upload_expires_at)
values ('84700000-0000-4000-8000-000000000003', 'a4700000-0000-4000-8000-000000000003', 'd7/2026/10/17/84700000-0000-4000-8000-000000000003',
        'r.bin', 'application/octet-stream', 'application/octet-stream', 5, 5, 'verified', now() + interval '2 hours');
insert into app.share_links (id, share_id, secret_hmac, pepper_version, created_by_user_id, expires_at, entitlement_snapshot)
values ('RoomShareLink001', 'a4700000-0000-4000-8000-000000000001', decode(repeat('71', 32), 'hex'), 1, pg_temp.u('02'), now() + interval '1 hour', '{}');

set local role app_server;
select is(app.delete_room(pg_temp.room('create-a'), pg_temp.u('02'), 'deleted_by_owner'), null, 'a member can''t delete the room');
select is(app.delete_room(pg_temp.room('create-a'), pg_temp.u('05'), 'deleted_by_owner'), null, 'another room''s owner can''t either');
select is(app.room_role(pg_temp.room('create-a'), pg_temp.u('02')), 'member', 'refused deletions changed nothing');
select is(app.delete_room(pg_temp.room('create-a'), pg_temp.u('01'), 'deleted_by_owner'), 3, 'the owner deletes it: its three open shares end (a claimed one too)');
select is(app.delete_room(pg_temp.room('create-a'), pg_temp.u('01'), 'deleted_by_owner'), null, 'deleting it again does nothing');
reset role;
select is(
  (select array_agg(row(status, end_reason)::text order by id) from app.shares where room_id = pg_temp.room('create-a') and burn_after_download = false),
  array[row('deleted', 'room_deleted')::text, row('deleted', 'room_deleted')::text], 'every open room share ended as room_deleted');
select is((select count(*)::int from app.object_deletions where object_key = 'd7/2026/10/17/84700000-0000-4000-8000-000000000003' and completed_at is null), 1,
  'their objects are queued for the janitor');
select is((select revoke_reason from app.share_links where id = 'RoomShareLink001'), 'share_ended', 'share links to room shares are revoked');
select is((select count(*)::int from app.room_invites where room_id = pg_temp.room('create-a') and revoked_at is null), 0, 'every invite is revoked');
select is(
  (select count(*)::int from app.room_members where room_id = pg_temp.room('create-a') and (removed_at is null or removed_reason <> 'room_deleted')),
  0, 'every member, the owner included, is removed (room_deleted)');
select ok((select deleted_at is not null from app.rooms where id = pg_temp.room('create-a')), 'the room is soft-deleted');
select is(app.room_role(pg_temp.room('create-a'), pg_temp.u('01')), null, 'nobody has a role in a deleted room');
select is((select metadata ->> 'sharesEnded' from app.audit_events where action = 'room.deleted' and target_id = pg_temp.room('create-a')::text), '3',
  'the deletion is audited');
select is((select count(*)::int from realtime.messages where topic = 'room:' || pg_temp.room('create-a') and event = 'room.deleted'), 1,
  'the room''s topic hears that it was deleted');
select is(
  (select count(*)::int from realtime.messages where event = 'membership.changed' and payload ->> 'change' = 'room_deleted'
      and payload ->> 'roomId' = pg_temp.room('create-a')::text),
  4, 'each member''s own topic hears it');
set local role app_server;
select pg_temp.accept('after-delete', 'InviteRoomA00001', 'a1', '03');
reset role;
select is((select outcome from rr where step = 'after-delete'), 'expired', 'an invite of a deleted room is refused after proof (410)');
set local role authenticated;
select pg_temp.topic('member after delete', '02', 'room:' || pg_temp.room('create-a'));
reset role;
select is((select allowed from topic_checks where label = 'member after delete'), false, 'a deleted room''s topic admits nobody');

-- No signal on any room or user topic carries anything but IDs and states (T-018, extended).
select is(
  (select count(*)::int from realtime.messages m, jsonb_object_keys(m.payload) as k
    where (m.topic like 'room:%' or m.topic like 'user:%')
      and k not in ('v', 'type', 'shareId', 'status', 'version', 'change', 'roomId', 'id')),
  0, 'room signal payloads contain only IDs and state');

-- ---------------------------------------------------------------------------
-- Merge (P4-21 brought forward): memberships move from the anonymous source to the account
-- ---------------------------------------------------------------------------
-- Room M1: only the source is a member. Room M2: the target was removed, the source is active.
-- Room M3: both are active. Room B: the source was removed.
insert into rr select 'm1', c.outcome, c.room_id from app.create_room(pg_temp.u('05'), pg_temp.d('05'), 'M1', true, '{"limits": {"maxRoomMembers": 50}}', 20) c;
insert into rr select 'm2', c.outcome, c.room_id from app.create_room(pg_temp.u('05'), pg_temp.d('05'), 'M2', true, '{"limits": {"maxRoomMembers": 50}}', 20) c;
insert into rr select 'm3', c.outcome, c.room_id from app.create_room(pg_temp.u('05'), pg_temp.d('05'), 'M3', true, '{"limits": {"maxRoomMembers": 50}}', 20) c;
insert into app.room_members (room_id, user_id, role, joined_via, invite_id, removed_at, removed_reason, removed_by_user_id)
values (pg_temp.room('m1'), pg_temp.u('08'), 'member', 'invite_link', 'InviteM100000001', null, null, null),
       (pg_temp.room('m2'), pg_temp.u('08'), 'member', 'invite_link', 'InviteM200000001', null, null, null),
       (pg_temp.room('m2'), pg_temp.u('09'), 'member', 'invite_link', 'InviteM200000002', now(), 'left', pg_temp.u('09')),
       (pg_temp.room('m3'), pg_temp.u('08'), 'member', 'invite_link', 'InviteM300000001', null, null, null),
       (pg_temp.room('m3'), pg_temp.u('09'), 'member', 'invite_link', 'InviteM300000002', null, null, null),
       (pg_temp.room('create-b'), pg_temp.u('08'), 'member', 'invite_link', 'InviteRoomB00001', now(), 'left', pg_temp.u('08'));
insert into app.merge_intents (id, anon_user_id, anon_device_id, secret_hmac, pepper_version, expires_at)
values ('f4700000-0000-4000-8000-000000000008', pg_temp.u('08'), pg_temp.d('08'), pg_temp.hmac('88'), 1, now() + interval '1 hour');
select is(
  (select app.merge_anonymous_user('f4700000-0000-4000-8000-000000000008', array[pg_temp.hmac('88')], pg_temp.u('09'),
                                   '47e00000-0000-4000-8000-000000000009', pg_temp.d('08'), 10) ->> 'memberships'),
  '2', 'the merge reports the memberships the account gained (M1 moved, M2 back)');
select is(
  (select array_agg(row(r.label, m.removed_at is null)::text order by r.label) from app.room_members m join app.rooms r on r.id = m.room_id
    where m.user_id = pg_temp.u('09')),
  array[row('M1', true)::text, row('M2', true)::text, row('M3', true)::text, row('Room B', false)::text],
  'the account is active in M1, M2 and M3, and Room B still shows the source''s departure');
select is((select count(*)::int from app.room_members where user_id = pg_temp.u('08')), 0, 'no membership is left on the source');
select is(
  (select array[pg_temp.active(pg_temp.room('m1')), pg_temp.active(pg_temp.room('m2')), pg_temp.active(pg_temp.room('m3'))]),
  array[2, 2, 2], 'no room gained a member it didn''t have: the merge only re-points');

-- ---------------------------------------------------------------------------
-- Account deletion deletes the owner's rooms first (an open room must keep its owner)
-- ---------------------------------------------------------------------------
select throws_ok(format($q$delete from auth.users where id = %L$q$, pg_temp.u('05')), '23514', null,
  'an owner''s Auth user can''t simply vanish while a room of theirs is open');
insert into rr select 'd', c.outcome, c.room_id from app.create_room(pg_temp.u('0a'), pg_temp.d('0a'), 'Doomed', true, '{"limits": {"maxRoomMembers": 50}}', 20) c;
insert into app.shares (id, scope, room_id, kind, created_by_user_id, billing_subject_type, billing_subject_id, status, retention_class,
                        expires_at, entitlement_snapshot)
values ('a4700000-0000-4000-8000-00000000000d', 'room', pg_temp.room('d'), 'text', pg_temp.u('0a'), 'user', pg_temp.u('0a'),
        'active', 'd7', now() + interval '1 day', '{}');
insert into app.profiles (user_id, deletion_requested_at, deletion_scheduled_for) values (pg_temp.u('0a'), now() - interval '8 days', now() - interval '1 day');
select ok(app.delete_due_accounts(100) >= 1, 'the deletion job runs');
select is((select count(*)::int from auth.users where id = pg_temp.u('0a')), 0, 'the due account is deleted');
select is((select row(deleted_at is not null, owner_user_id)::text from app.rooms where id = pg_temp.room('d')), row(true, null::uuid)::text,
  'its room was deleted first; the owner reference goes with the user');
select is((select end_reason from app.shares where id = 'a4700000-0000-4000-8000-00000000000d'), 'room_deleted', 'and the room''s shares ended');

-- ---------------------------------------------------------------------------
-- Purging: invites 7 days after they end, removed members after 30 days, deleted rooms without share rows
-- ---------------------------------------------------------------------------
update app.room_invites set created_at = now() - interval '9 days', expires_at = now() - interval '8 days' where id = 'InviteRoomB00001';
update app.room_members set removed_at = now() - interval '31 days' where room_id = pg_temp.room('create-b') and user_id = pg_temp.u('09');
update app.rooms set deleted_at = now() - interval '31 days' where id in (pg_temp.room('create-a'), pg_temp.room('d'));
delete from app.shares where room_id = pg_temp.room('d');
select ok(app.purge_ephemeral() >= 3, 'purge-ephemeral runs');
select is((select count(*)::int from app.room_invites where id = 'InviteRoomB00001'), 0, 'an invite 7 days past its expiry is purged');
select is((select count(*)::int from app.room_members where room_id = pg_temp.room('create-b') and user_id = pg_temp.u('09')), 0,
  'a membership removed 30 days ago is purged');
select is(
  (select array_agg(id = pg_temp.room('create-a')) from app.rooms where id in (pg_temp.room('create-a'), pg_temp.room('d'))),
  array[true], 'a deleted room goes once no share row refers to it; one with share tombstones stays');

select * from finish();
rollback;
