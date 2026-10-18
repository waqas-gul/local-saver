-- Phase 4D database tests (P4-18): QR pairing invites (phase 4 §17.8.4.1; T-034, E19, E20, the server side of T4-R15).
-- The pairing kind of app.room_invites: exactly one use (a missing maximum is refused, not unlimited) and at most
-- 10 minutes; app.accept_room_invite with pairing codes (a wrong secret, another room's code, single use and its
-- replay, the same person again, expiry at exactly 10 minutes, revocation, a deleted room, the member cap); the
-- joined member's room topic and signals; purging.
begin;
create extension if not exists pgtap with schema extensions;

select plan(31);

-- ---------------------------------------------------------------------------
-- Fixtures: users 48…<n>, devices 48d…, sessions 48e…
--   01 owner of rooms P and R (account)   02 joiner (anonymous)   03 second scanner (anonymous)
--   04 owner of room Q (account)   05 fills room P's cap (anonymous)   06 suspended   07 device revoked
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, is_anonymous, encrypted_password, created_at, updated_at)
select ('48000000-0000-4000-8000-0000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       case when anon then null else 'p' || n || '@example.com' end, anon, '', now(), now()
  from (values ('01', false), ('02', true), ('03', true), ('04', false), ('05', true), ('06', true), ('07', true)) as u(n, anon);
insert into auth.sessions (id, user_id, created_at, updated_at)
select ('48e00000-0000-4000-8000-0000000000' || n)::uuid, ('48000000-0000-4000-8000-0000000000' || n)::uuid, now(), now()
  from unnest(array['01', '02', '03', '04', '05', '06', '07']) as n;
insert into app.devices (id, user_id, label, auth_session_id)
select ('48d00000-0000-4000-8000-0000000000' || n)::uuid, ('48000000-0000-4000-8000-0000000000' || n)::uuid, 'Device ' || n,
       ('48e00000-0000-4000-8000-0000000000' || n)::uuid
  from unnest(array['01', '02', '03', '04', '05', '06', '07']) as n;
update app.devices set revoked_at = now(), revoked_reason = 'user' where id = '48d00000-0000-4000-8000-000000000007';
insert into app.user_flags (user_id, suspended_at, reason) values ('48000000-0000-4000-8000-000000000006', now(), 'test');

create temp table pr (step text primary key, outcome text, room_id uuid) on commit drop;
create temp table pairing_topics (label text primary key, allowed boolean) on commit drop;
grant insert on pairing_topics to authenticated;
grant select, insert on pr to app_server;
grant select on pr to authenticated;

create function pg_temp.u(p text) returns uuid language sql immutable as $$ select ('48000000-0000-4000-8000-0000000000' || p)::uuid $$;
create function pg_temp.d(p text) returns uuid language sql immutable as $$ select ('48d00000-0000-4000-8000-0000000000' || p)::uuid $$;
create function pg_temp.room(p_step text) returns uuid language sql stable as $$ select room_id from pr where step = p_step $$;
create function pg_temp.hmac(p text) returns bytea language sql immutable as $$ select decode(repeat(p, 32), 'hex') $$;
-- A pairing invite made p_age ago, living its full 10 minutes from then (one use, as the service makes them).
create function pg_temp.pairing(p_id text, p_room uuid, p_fill text, p_age interval default '0') returns void language sql as $$
  insert into app.room_invites (id, room_id, kind, secret_hmac, pepper_version, created_by_user_id, created_at, expires_at, max_uses)
  values (p_id, p_room, 'pairing', pg_temp.hmac(p_fill), 1, (select owner_user_id from app.rooms where id = p_room),
          now() - p_age, now() - p_age + interval '10 minutes', 1);
$$;
create function pg_temp.accept(p_step text, p_invite text, p_fill text, p_user text) returns void language sql as $$
  insert into pr select p_step, a.outcome, a.room_id
    from app.accept_room_invite(p_invite, array[pg_temp.hmac(p_fill)], pg_temp.u(p_user), pg_temp.d(p_user)) a;
$$;
create function pg_temp.uses(p_id text) returns integer language sql stable as $$ select use_count from app.room_invites where id = p_id $$;

-- Room P (01, a member cap of 3), room Q (04), room R (01, to delete).
grant app_server to current_user;
set local role app_server;
insert into pr select 'room-p', c.outcome, c.room_id
  from app.create_room(pg_temp.u('01'), pg_temp.d('01'), 'Room P', true, '{"v": 2, "limits": {"maxRoomMembers": 3}}', 20) c;
insert into pr select 'room-q', c.outcome, c.room_id
  from app.create_room(pg_temp.u('04'), pg_temp.d('04'), 'Room Q', true, '{"v": 2, "limits": {"maxRoomMembers": 50}}', 20) c;
insert into pr select 'room-r', c.outcome, c.room_id
  from app.create_room(pg_temp.u('01'), pg_temp.d('01'), 'Room R', true, '{"v": 2, "limits": {"maxRoomMembers": 50}}', 20) c;
reset role;

-- ---------------------------------------------------------------------------
-- The pairing kind's shape: one use, 10 minutes
-- ---------------------------------------------------------------------------
select throws_ok(format($q$
  insert into app.room_invites (id, room_id, kind, secret_hmac, pepper_version, expires_at)
  values ('PairingNoMax0001', %L, 'pairing', decode(repeat('aa', 32), 'hex'), 1, now() + interval '5 minutes')$q$, pg_temp.room('room-p')),
  '23514', null, 'a pairing invite without a maximum is refused: a missing maximum would be unlimited');
select throws_ok(format($q$
  insert into app.room_invites (id, room_id, kind, secret_hmac, pepper_version, expires_at, max_uses)
  values ('PairingTwoUses02', %L, 'pairing', decode(repeat('aa', 32), 'hex'), 1, now() + interval '5 minutes', 2)$q$, pg_temp.room('room-p')),
  '23514', null, 'a pairing invite is never good for two people');
select lives_ok(format($q$
  insert into app.room_invites (id, room_id, kind, secret_hmac, pepper_version, expires_at, max_uses)
  values ('PairingFullTen01', %L, 'pairing', decode(repeat('ab', 32), 'hex'), 1, now() + interval '10 minutes', 1)$q$, pg_temp.room('room-p')),
  'a pairing invite may live exactly 10 minutes');
select throws_ok(format($q$
  insert into app.room_invites (id, room_id, kind, secret_hmac, pepper_version, expires_at, max_uses)
  values ('PairingTenPlus01', %L, 'pairing', decode(repeat('aa', 32), 'hex'), 1, now() + interval '10 minutes 1 second', 1)$q$,
  pg_temp.room('room-p')),
  '23514', null, 'and not a second longer');
select lives_ok(format($q$
  insert into app.room_invites (id, room_id, kind, secret_hmac, pepper_version, expires_at)
  values ('InviteNoMax00001', %L, 'invite_link', decode(repeat('ac', 32), 'hex'), 1, now() + interval '1 day')$q$, pg_temp.room('room-p')),
  'an invite link may still have no maximum (unlimited uses, E21)');

-- ---------------------------------------------------------------------------
-- Accepting a pairing code (T-034, E19)
-- ---------------------------------------------------------------------------
select pg_temp.pairing('PairP00000000001', pg_temp.room('room-p'), 'c1');
select pg_temp.pairing('PairQ00000000001', pg_temp.room('room-q'), 'd1');
select pg_temp.pairing('PairP0Expired001', pg_temp.room('room-p'), 'c2', '11 minutes');
select pg_temp.pairing('PairP0Boundary01', pg_temp.room('room-p'), 'c3', '10 minutes');
select pg_temp.pairing('PairP0Revoked001', pg_temp.room('room-p'), 'c4');
update app.room_invites set revoked_at = now() where id = 'PairP0Revoked001';
select pg_temp.pairing('PairP0Late000001', pg_temp.room('room-p'), 'c5', '9 minutes 59 seconds');
select pg_temp.pairing('PairP0Full000001', pg_temp.room('room-p'), 'c6');

set local role app_server;
select pg_temp.accept('wrong', 'PairP00000000001', 'ff', '02');
select pg_temp.accept('q-secret-on-p', 'PairP00000000001', 'd1', '02');
select pg_temp.accept('unknown', 'PairUnknown00001', 'c1', '02');
select pg_temp.accept('join', 'PairP00000000001', 'c1', '02');
select pg_temp.accept('again', 'PairP00000000001', 'c1', '02');
select pg_temp.accept('replay', 'PairP00000000001', 'c1', '03');
select pg_temp.accept('expired', 'PairP0Expired001', 'c2', '03');
select pg_temp.accept('boundary', 'PairP0Boundary01', 'c3', '03');
select pg_temp.accept('revoked', 'PairP0Revoked001', 'c4', '03');
select pg_temp.accept('late', 'PairP0Late000001', 'c5', '05');
select pg_temp.accept('full', 'PairP0Full000001', 'c6', '03');
select pg_temp.accept('q-join', 'PairQ00000000001', 'd1', '03');
reset role;

select is((select outcome from pr where step = 'wrong'), 'unavailable', 'a wrong secret is unavailable (404)');
select is((select outcome from pr where step = 'q-secret-on-p'), 'unavailable', 'room Q''s pairing secret opens nothing in room P');
select is((select outcome from pr where step = 'unknown'), 'unavailable', 'an unknown code is the same answer (404)');
select is((select row(outcome, room_id)::text from pr where step = 'join'), row('joined', pg_temp.room('room-p'))::text,
  'the right secret joins the code''s own room');
select is(
  (select row(role, joined_via, invite_id, joined_device_id)::text from app.room_members where room_id = pg_temp.room('room-p') and user_id = pg_temp.u('02')),
  row('member', 'pairing', 'PairP00000000001', pg_temp.d('02'))::text, 'the member is recorded as joined by pairing, with the code and the device');
select is((select row(outcome, room_id)::text from pr where step = 'again'), row('already_member', pg_temp.room('room-p'))::text,
  'the same person scanning again is already a member (idempotent)');
select is((select outcome from pr where step = 'replay'), 'expired', 'a used code never admits a second person (replay → 410)');
select is(pg_temp.uses('PairP00000000001'), 1, 'a wrong secret, the repeat and the replay used nothing: one use, the join');
select is(
  (select array_agg(outcome order by step) from pr where step in ('expired', 'boundary', 'revoked')),
  array['expired', 'expired', 'expired'], 'expired, exactly 10 minutes old, and revoked codes are refused after proof (410)');
select is((select outcome from pr where step = 'late'), 'joined', 'a code 9 minutes 59 seconds old still works');
select is((select outcome from pr where step = 'full'), 'member_limit', 'a code can''t pass the room''s member cap (409 ROOM_MEMBER_LIMIT)');
select is(pg_temp.uses('PairP0Full000001'), 0, 'a refused join leaves the code unused');
select is((select count(*)::int from app.room_members where room_id = pg_temp.room('room-p') and removed_at is null), 3,
  'room P holds exactly its cap: the owner and two people paired in');
select is((select row(outcome, room_id)::text from pr where step = 'q-join'), row('joined', pg_temp.room('room-q'))::text,
  'room Q''s code joins room Q only');
select is((select count(*)::int from app.room_members where room_id = pg_temp.room('room-p') and user_id = pg_temp.u('03')), 0,
  'the second scanner is in no room of P''s after every refusal');

-- A deleted room's code is revoked with it and refused.
select pg_temp.pairing('PairR00000000001', pg_temp.room('room-r'), 'e1');
set local role app_server;
select ok(app.delete_room(pg_temp.room('room-r'), pg_temp.u('01'), 'deleted_by_owner') is not null, 'room R is deleted by its owner');
select pg_temp.accept('deleted-room', 'PairR00000000001', 'e1', '03');
reset role;
select is((select revoked_at is not null from app.room_invites where id = 'PairR00000000001'), true, 'deleting a room revokes its pairing codes');
select is((select outcome from pr where step = 'deleted-room'), 'expired', 'and a deleted room''s code is refused (410)');

-- ---------------------------------------------------------------------------
-- After pairing: the room topic and the signals (§17.8.4)
-- ---------------------------------------------------------------------------
-- 06 (suspended) and 07 (device revoked) pair into room Q; the API refuses them first (requireCaller), the topic too.
select pg_temp.pairing('PairQ0Suspended1', pg_temp.room('room-q'), 'd2');
select pg_temp.pairing('PairQ0Revoked001', pg_temp.room('room-q'), 'd3');
set local role app_server;
select pg_temp.accept('q-suspended', 'PairQ0Suspended1', 'd2', '06');
select pg_temp.accept('q-revoked', 'PairQ0Revoked001', 'd3', '07');
reset role;
create function pg_temp.topic(p_label text, p_user text, p_topic text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', pg_temp.u(p_user), 'role', 'authenticated', 'session_id', ('48e00000-0000-4000-8000-0000000000' || p_user))::text, true);
  insert into pairing_topics values (p_label, app_realtime.can_access_topic(p_topic));
end
$$;
grant execute on function pg_temp.topic(text, text, text) to authenticated;
set local role authenticated;
select pg_temp.topic('paired member', '02', 'room:' || pg_temp.room('room-p'));
select pg_temp.topic('refused scanner', '03', 'room:' || pg_temp.room('room-p'));
select pg_temp.topic('paired into q', '03', 'room:' || pg_temp.room('room-q'));
select pg_temp.topic('suspended', '06', 'room:' || pg_temp.room('room-q'));
select pg_temp.topic('revoked device', '07', 'room:' || pg_temp.room('room-q'));
select pg_temp.topic('paired member, other room', '02', 'room:' || pg_temp.room('room-q'));
reset role;
select is((select allowed from pairing_topics where label = 'paired member'), true, 'a member who paired in may join room:{id}');
select is((select allowed from pairing_topics where label = 'paired into q'), true, 'so may the scanner, for the room they paired into');
select is(
  (select bool_or(allowed) from pairing_topics where label in ('refused scanner', 'suspended', 'revoked device', 'paired member, other room')),
  false, 'a refused scanner, a suspended account, a revoked device''s session and another room''s member may not');

select is(
  (select payload - 'v' - 'id' from realtime.messages where topic = 'user:' || pg_temp.u('02') and event = 'membership.changed'),
  jsonb_build_object('type', 'membership.changed', 'roomId', pg_temp.room('room-p'), 'change', 'joined'),
  'the paired member''s own topic hears the room they joined, and nothing else');
select is(
  (select count(*)::int from realtime.messages
    where topic = 'room:' || pg_temp.room('room-p') and event = 'member.changed' and payload ->> 'change' = 'joined'),
  3, 'the room''s topic hears each join (the owner''s at creation, then two by pairing), never a refused one');
select is((select count(*)::int from realtime.messages where topic = 'user:' || pg_temp.u('03') and payload ->> 'roomId' = pg_temp.room('room-p')::text), 0,
  'a refused scanner is told nothing about room P');

-- ---------------------------------------------------------------------------
-- Purging (§17.12): a pairing code goes 7 days after it ended
-- ---------------------------------------------------------------------------
select pg_temp.pairing('PairOld000000001', pg_temp.room('room-p'), 'c7', '8 days');
select ok(app.purge_ephemeral() >= 1, 'purge-ephemeral runs');
select is(
  (select array_agg(id order by id) from app.room_invites where id in ('PairOld000000001', 'PairP00000000001')),
  array['PairP00000000001'], 'a code 7 days past its expiry is purged; today''s stays');

select * from finish();
rollback;
