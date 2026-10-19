-- Phase 4D database tests (P4-21): merge and account-deletion coverage for rooms, history and links (phase 4 §17.5.4,
-- §17.5.7, §17.9; T-053.3, T-053.13, T4-A5). Every app column that holds a user or device ID has a rule in both flows
-- (a new one fails here until it has); after a merge nothing names the anonymous user, and after an account deletion
-- nothing names the account or its devices, except what is kept on purpose: audit events, billing records, operator
-- overrides, abuse reports (evidence, D-3) and the payer on tombstones until their dates. What a deleted account did
-- to other people's things stays as their history, saying what happened and never who (D4-20).
begin;
create extension if not exists pgtap with schema extensions;

select plan(25);

-- ---------------------------------------------------------------------------
-- The coverage list: every column holding a user or device ID, by name or by foreign key
-- ---------------------------------------------------------------------------
select set_eq(
  $q$select c.table_name::text || '.' || c.column_name::text from information_schema.columns c
      where c.table_schema = 'app' and c.data_type = 'uuid'
        and (c.column_name like '%user_id%' or c.column_name like '%device_id%' or c.column_name in ('billing_subject_id', 'subject_id'))
     union
     select regexp_replace(k.conrelid::regclass::text, '^app\.', '') || '.' || a.attname from pg_constraint k
       join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
      where k.contype = 'f' and k.connamespace = 'app'::regnamespace and k.confrelid in ('auth.users'::regclass, 'app.devices'::regclass)$q$,
  $q$select x from unnest(array[
    -- column                              merge (anonymous → account)            account deletion
    'abuse_reports.reporter_user_id',   -- re-pointed                             kept (evidence, D-3)
    'audit_events.actor_user_id',       -- kept (history stays truthful)          kept (audit, its own retention)
    'audit_events.actor_device_id',     -- kept (the device keeps its ID)         kept (audit)
    'billing_checkouts.subject_id',     -- none (accounts only)                   kept (billing records)
    'billing_customers.subject_id',     -- none                                   kept
    'billing_disputes.subject_id',      -- none                                   kept
    'billing_events.subject_id',        -- none                                   kept
    'subscriptions.subject_id',         -- none                                   kept
    'entitlement_overrides.subject_id', -- none (operators refuse anonymous)      kept (operator record)
    'devices.user_id',                  -- the merging device moves; others go    deleted
    'devices.revoked_by_device_id',     -- the device keeps its ID                cleared on other users' devices
    'downloads.user_id',                -- re-pointed (history)                   cleared: the record stays, not who
    'downloads.device_id',              -- the device keeps its ID                cleared
    'idempotency_keys.user_id',         -- cascades                               cascades
    'merge_intents.anon_user_id',       -- the intent itself                      deleted
    'merge_intents.anon_device_id',     -- the intent itself                      deleted
    'merge_intents.target_user_id',     -- the intent itself                      deleted
    'network_presence.user_id',         -- re-pointed with the device             cascades with the devices
    'network_presence.device_id',       -- the device keeps its ID                cascades
    'profiles.user_id',                 -- none (anonymous)                       deleted
    'room_invites.created_by_user_id',  -- none (rooms are Pro)                   set null (the room's invites are revoked first)
    'room_members.user_id',             -- re-pointed, or left to cascade         cascades (member.changed for active rows)
    'room_members.removed_by_user_id',  -- re-pointed                             cleared
    'room_members.joined_device_id',    -- the device keeps its ID                set null with the device
    'rooms.owner_user_id',              -- none (rooms are Pro)                   the rooms are deleted, then set null
    'share_links.created_by_user_id',   -- re-pointed                             set null (the links are revoked first)
    'share_links.created_by_device_id', -- the device keeps its ID                set null
    'share_links.revoked_by_user_id',   -- re-pointed                             set null
    'shares.created_by_user_id',        -- re-pointed                             set null (the shares end first)
    'shares.created_by_device_id',      -- the device keeps its ID                set null
    'shares.billing_subject_id',        -- re-pointed                             kept on the tombstone until its date
    'shares.claimed_by_user_id',        -- re-pointed (M15)                       claims finished, then cleared
    'shares.claimed_device_id',         -- the device keeps its ID                cleared
    'storage_reservations.subject_id',  -- every row re-pointed (P4-21)           finished rows deleted
    'storage_usage.subject_id',         -- summed into the target                 deleted
    'text_items.updated_by_device_id',  -- the device keeps its ID                cleared
    'user_flags.user_id'                -- upload_restricted ORed; cascades       cascades
  ]) as x$q$,
  'every column holding a user or device ID has a merge rule and a deletion rule (P4-21 coverage)');

-- ---------------------------------------------------------------------------
-- Fixtures: users 4b…, devices 4bd…, sessions 4be…, one network
--   01 O, an account: owns room RO and shares   02 U, the account to delete   03 M, member of U's room RU
--   04 X, removed from RU by U                   05 A, the merge's anonymous source   06 T, the merge's target account
--   07 V, a neighbour on the network
-- ---------------------------------------------------------------------------
insert into auth.users (id, instance_id, aud, role, email, is_anonymous, encrypted_password, created_at, updated_at)
select ('4b000000-0000-4000-8000-0000000000' || n)::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       case when anon then null else 'c' || n || '@example.com' end, anon, '', now(), now()
  from (values ('01', false), ('02', false), ('03', true), ('04', true), ('05', true), ('06', false), ('07', true)) as v(n, anon);
insert into auth.sessions (id, user_id, created_at, updated_at)
select ('4be00000-0000-4000-8000-0000000000' || n)::uuid, ('4b000000-0000-4000-8000-0000000000' || n)::uuid, now(), now()
  from unnest(array['01', '02', '03', '04', '05', '06', '07']) as n;
insert into app.devices (id, user_id, label, auth_session_id)
select ('4bd00000-0000-4000-8000-0000000000' || n)::uuid, ('4b000000-0000-4000-8000-0000000000' || n)::uuid, 'Device ' || n,
       ('4be00000-0000-4000-8000-0000000000' || n)::uuid
  from unnest(array['01', '02', '03', '04', '05', '06', '07']) as n;
insert into app.network_spaces (id, network_key, key_version, family) values ('4bf00000-0000-4000-8000-000000000001', decode(repeat('4b', 32), 'hex'), 1, 6);

create function pg_temp.u(p text) returns uuid language sql immutable as $$ select ('4b000000-0000-4000-8000-0000000000' || p)::uuid $$;
create function pg_temp.d(p text) returns uuid language sql immutable as $$ select ('4bd00000-0000-4000-8000-0000000000' || p)::uuid $$;
create function pg_temp.s(p text) returns uuid language sql immutable as $$ select ('4ba00000-0000-4000-8000-0000000000' || p)::uuid $$;
create function pg_temp.f(p text) returns uuid language sql immutable as $$ select ('4bb00000-0000-4000-8000-0000000000' || p)::uuid $$;
create temp table cr (step text primary key, room_id uuid) on commit drop;
grant select, insert on cr to app_server;
create function pg_temp.room(p text) returns uuid language sql stable as $$ select room_id from cr where step = p $$;

-- Every row of every coverage column that names one of these IDs, as table.column.
create function pg_temp.refs(p_ids uuid[]) returns setof text language plpgsql as $$
declare
  c record;
  n integer;
begin
  for c in select table_name, column_name from information_schema.columns
            where table_schema = 'app' and data_type = 'uuid'
              and (column_name like '%user_id%' or column_name like '%device_id%' or column_name in ('billing_subject_id', 'subject_id')) loop
    execute format('select count(*)::int from app.%I where %I = any ($1)', c.table_name, c.column_name) into n using p_ids;
    if n > 0 then
      return next c.table_name || '.' || c.column_name;
    end if;
  end loop;
end
$$;

-- A share: network (files or text) or room (text). Status active unless given.
create function pg_temp.share(p_id uuid, p_owner text, p_kind text, p_room uuid default null, p_burn boolean default false)
returns void language sql as $$
  insert into app.shares (id, scope, network_space_id, room_id, kind, created_by_user_id, created_by_device_id, billing_subject_type,
                          billing_subject_id, status, retention_class, expires_at, burn_after_download, file_count, total_bytes,
                          entitlement_snapshot)
  values (p_id, case when p_room is null then 'network' else 'room' end,
          case when p_room is null then '4bf00000-0000-4000-8000-000000000001'::uuid end, p_room, p_kind, pg_temp.u(p_owner),
          pg_temp.d(p_owner), 'user', pg_temp.u(p_owner), 'active', 'd7', now() + interval '1 day', p_burn,
          case when p_kind = 'files' then 1 else 0 end, 10, '{"historyRetentionDays": 30}');
$$;
create function pg_temp.file(p_id uuid, p_share uuid) returns void language sql as $$
  insert into app.files (id, share_id, network_space_id, object_key, original_name, declared_mime, stored_content_type,
                         declared_size_bytes, size_bytes, upload_status, upload_expires_at)
  values (p_id, p_share, '4bf00000-0000-4000-8000-000000000001', 'd7/2026/10/18/' || p_id::text, 'x.bin', 'application/octet-stream',
          'application/octet-stream', 10, 10, 'verified', now() + interval '2 hours');
$$;
create function pg_temp.download(p_share uuid, p_file uuid, p_actor text, p_who text) returns void language sql as $$
  insert into app.downloads (share_id, file_id, network_space_id, actor_kind, user_id, device_id, event, retention_until)
  values (p_share, p_file, '4bf00000-0000-4000-8000-000000000001', p_actor, pg_temp.u(p_who), pg_temp.d(p_who),
          case when p_file is null then 'text_revealed' else 'url_issued' end, now() + interval '30 days');
$$;
-- A burn share of O claimed by p_who, in its grace.
create function pg_temp.claim(p_share uuid, p_who text) returns void language sql as $$
  update app.shares set status = 'claimed', claimed_at = now(), claim_grace_until = now() + interval '15 minutes',
                        claimed_by_user_id = pg_temp.u(p_who), claimed_device_id = pg_temp.d(p_who)
   where id = p_share;
$$;

grant app_server to current_user;
set local role app_server;
insert into cr select 'ro', c.room_id from app.create_room(pg_temp.u('01'), pg_temp.d('01'), 'Other room', true, '{"v": 2, "limits": {"maxRoomMembers": 50}}', 20) c;
insert into cr select 'ru', c.room_id from app.create_room(pg_temp.u('02'), pg_temp.d('02'), 'Leaving room', true, '{"v": 2, "limits": {"maxRoomMembers": 50}}', 20) c;
reset role;

-- O's things that U and A touch: a file share, two burn shares.
select pg_temp.share(pg_temp.s('01'), '01', 'files');
select pg_temp.file(pg_temp.f('01'), pg_temp.s('01'));
select pg_temp.share(pg_temp.s('02'), '01', 'text', null, true);
select pg_temp.share(pg_temp.s('03'), '01', 'text', null, true);
select pg_temp.share(pg_temp.s('04'), '01', 'text', null, true);

-- ---------------------------------------------------------------------------
-- The merge (T-053.3): A, an anonymous member of RO, with shares, links, history, a claim and reservations, into T
-- ---------------------------------------------------------------------------
insert into app.room_members (room_id, user_id, role, joined_via, invite_id, joined_device_id)
values (pg_temp.room('ro'), pg_temp.u('05'), 'member', 'invite_link', 'InviteForRoomRO1', pg_temp.d('05'));
select pg_temp.share(pg_temp.s('51'), '05', 'files');
select pg_temp.file(pg_temp.f('51'), pg_temp.s('51'));
select pg_temp.share(pg_temp.s('52'), '05', 'text', pg_temp.room('ro'));
insert into app.share_links (id, share_id, secret_hmac, pepper_version, created_by_user_id, created_by_device_id, expires_at, entitlement_snapshot,
                             revoked_at, revoke_reason, revoked_by_user_id)
values ('LinkOfAnonymous1', pg_temp.s('51'), decode(repeat('51', 32), 'hex'), 1, pg_temp.u('05'), pg_temp.d('05'), now() + interval '1 day', '{}',
        now(), 'creator', pg_temp.u('05'));
select pg_temp.download(pg_temp.s('51'), pg_temp.f('51'), 'network_device', '07');   -- a neighbour downloads A's file
select pg_temp.download(pg_temp.s('01'), pg_temp.f('01'), 'network_device', '05');   -- A downloads O's file
select pg_temp.claim(pg_temp.s('02'), '05');
insert into app.storage_reservations (subject_type, subject_id, file_id, bytes, status, expires_at, settled_at)
values ('user', pg_temp.u('05'), pg_temp.f('51'), 10, 'committed', now() + interval '1 hour', now()),
       ('user', pg_temp.u('05'), null, 5, 'active', now() + interval '1 hour', null);
insert into app.storage_usage (subject_type, subject_id, bytes_committed, bytes_reserved, files_committed) values ('user', pg_temp.u('05'), 10, 5, 1);
insert into app.abuse_reports (share_id, category, reporter_kind, reporter_user_id) values (pg_temp.s('01'), 'spam', 'device', pg_temp.u('05'));
insert into app.network_presence (space_id, device_id, user_id, present_until)
values ('4bf00000-0000-4000-8000-000000000001', pg_temp.d('05'), pg_temp.u('05'), now() + interval '5 minutes');
insert into app.merge_intents (id, anon_user_id, anon_device_id, secret_hmac, pepper_version, expires_at)
values ('4bc00000-0000-4000-8000-000000000005', pg_temp.u('05'), pg_temp.d('05'), decode(repeat('a5', 32), 'hex'), 1, now() + interval '1 hour');

select is(
  (select app.merge_anonymous_user('4bc00000-0000-4000-8000-000000000005', array[decode(repeat('a5', 32), 'hex')], pg_temp.u('06'),
                                   '4be00000-0000-4000-8000-000000000006', pg_temp.d('05'), 10) ->> 'outcome'),
  'merged', 'the merge runs');
select is_empty(
  $q$select r from pg_temp.refs(array[pg_temp.u('05')]) as r where r not in ('audit_events.actor_user_id', 'merge_intents.anon_user_id')$q$,
  'after the merge nothing names the anonymous user but its own audit events and the intent');
select is(
  (select array[(select count(*)::int from app.room_members where room_id = pg_temp.room('ro') and user_id = pg_temp.u('06') and removed_at is null),
                (select count(*)::int from app.shares where created_by_user_id = pg_temp.u('06')),
                (select count(*)::int from app.share_links where created_by_user_id = pg_temp.u('06') and revoked_by_user_id = pg_temp.u('06')),
                (select count(*)::int from app.downloads where user_id = pg_temp.u('06')),
                (select count(*)::int from app.storage_reservations where subject_id = pg_temp.u('06')),
                (select count(*)::int from app.shares where claimed_by_user_id = pg_temp.u('06') and claimed_device_id = pg_temp.d('05'))]),
  array[1, 2, 1, 1, 2, 1],
  'the account has the membership, the room and network shares, the link, the download record, both reservations and the claim');
select is((select count(*)::int from app.downloads where share_id = pg_temp.s('51') and user_id = pg_temp.u('07')), 1,
  'the neighbour''s download of the moved share stays on it: the account''s history now');

-- ---------------------------------------------------------------------------
-- Account deletion (T4-A5's execution): U owns RU (a member, a removed member, an invite, a room link, a member's
-- post), is a member of RO with a post there, has a share with a link and its download record, downloaded O's
-- file, claimed one of O's burn shares (in grace) and consumed another, edited a text, reported a share, has billing
-- records, an operator override, a reservation and a completed merge intent.
-- ---------------------------------------------------------------------------
insert into app.room_members (room_id, user_id, role, joined_via, invite_id, joined_device_id, removed_at, removed_reason, removed_by_user_id)
values (pg_temp.room('ru'), pg_temp.u('03'), 'member', 'invite_link', 'InviteForRoomRU1', pg_temp.d('03'), null, null, null),
       (pg_temp.room('ru'), pg_temp.u('04'), 'member', 'invite_link', 'InviteForRoomRU2', pg_temp.d('04'), now(), 'removed', pg_temp.u('02')),
       (pg_temp.room('ro'), pg_temp.u('02'), 'member', 'invite_link', 'InviteForRoomRO2', pg_temp.d('02'), null, null, null);
insert into app.room_invites (id, room_id, kind, secret_hmac, pepper_version, created_by_user_id, expires_at)
values ('InviteOfAccountU', pg_temp.room('ru'), 'invite_link', decode(repeat('21', 32), 'hex'), 1, pg_temp.u('02'), now() + interval '1 day');
insert into app.share_links (id, target_type, room_id, secret_hmac, pepper_version, created_by_user_id, created_by_device_id, expires_at, entitlement_snapshot)
values ('RoomLinkOfUser02', 'room', pg_temp.room('ru'), decode(repeat('22', 32), 'hex'), 1, pg_temp.u('02'), pg_temp.d('02'), now() + interval '1 day', '{"v": 2}');
select pg_temp.share(pg_temp.s('31'), '03', 'text', pg_temp.room('ru'));          -- M's post in U's room
select pg_temp.share(pg_temp.s('21'), '02', 'files');                              -- U's network share
select pg_temp.file(pg_temp.f('21'), pg_temp.s('21'));
select pg_temp.share(pg_temp.s('22'), '02', 'text', pg_temp.room('ro'));          -- U's post in O's room
select pg_temp.share(pg_temp.s('23'), '02', 'text');                               -- U's text, edited from U's device
insert into app.text_items (share_id, content, content_bytes, updated_by_device_id) values (pg_temp.s('23'), 'edited', 6, pg_temp.d('02'));
insert into app.share_links (id, share_id, secret_hmac, pepper_version, created_by_user_id, created_by_device_id, expires_at, entitlement_snapshot)
values ('ShareLinkOfUser2', pg_temp.s('21'), decode(repeat('23', 32), 'hex'), 1, pg_temp.u('02'), pg_temp.d('02'), now() + interval '1 day', '{}');
select pg_temp.download(pg_temp.s('21'), pg_temp.f('21'), 'network_device', '07');   -- V downloads U's file (U's history)
select pg_temp.download(pg_temp.s('01'), pg_temp.f('01'), 'network_device', '02');   -- U downloads O's file (O's history)
select pg_temp.download(pg_temp.s('04'), null, 'network_device', '02');              -- U reveals O's burn text
select pg_temp.claim(pg_temp.s('03'), '02');
select pg_temp.claim(pg_temp.s('04'), '02');
select app.end_share(pg_temp.s('04'), 'consumed');
insert into app.storage_reservations (subject_type, subject_id, file_id, bytes, status, expires_at, settled_at)
values ('user', pg_temp.u('02'), pg_temp.f('21'), 10, 'committed', now() + interval '1 hour', now());
insert into app.merge_intents (id, anon_user_id, anon_device_id, secret_hmac, pepper_version, status, target_user_id, expires_at, completed_at, result)
values ('4bc00000-0000-4000-8000-000000000002', gen_random_uuid(), pg_temp.d('02'), decode(repeat('b2', 32), 'hex'), 1, 'completed', pg_temp.u('02'),
        now() + interval '1 hour', now(), '{}');
insert into app.subscriptions (provider, provider_subscription_id, provider_customer_id, subject_type, subject_id, plan, billing_interval, status,
                               current_period_end, cancel_at_period_end, provider_updated_at)
values ('fake', 'sub_4b02', 'cus_4b02', 'user', pg_temp.u('02'), 'pro', 'month', 'canceled', now(), false, now());
insert into app.billing_customers (subject_type, subject_id, provider, provider_customer_id) values ('user', pg_temp.u('02'), 'fake', 'cus_4b02');
insert into app.profiles (user_id, deletion_requested_at, deletion_scheduled_for) values (pg_temp.u('02'), now() - interval '8 days', now() - interval '1 second');
select app.admin_grant_override(pg_temp.u('02'), 'plan', '"pro"', 'tests', 'ops', null);
insert into app.abuse_reports (share_id, category, reporter_kind, reporter_user_id) values (pg_temp.s('01'), 'other', 'device', pg_temp.u('02'));
insert into app.storage_usage (subject_type, subject_id, bytes_committed, files_committed) values ('user', pg_temp.u('02'), 10, 1);

select ok(app.delete_due_accounts(1000) >= 1, 'the deletion job runs');
select is((select count(*)::int from auth.users where id = pg_temp.u('02')), 0, 'the account is gone');
select is_empty(
  $q$select r from pg_temp.refs(array[pg_temp.u('02'), pg_temp.d('02')]) as r
      where r not in ('audit_events.actor_user_id', 'audit_events.actor_device_id', 'abuse_reports.reporter_user_id', 'subscriptions.subject_id',
                      'billing_customers.subject_id', 'billing_checkouts.subject_id', 'billing_events.subject_id', 'billing_disputes.subject_id',
                      'entitlement_overrides.subject_id', 'shares.billing_subject_id')$q$,
  'afterwards only audit events, billing records, the override, the report and the tombstones'' payer name the account or its device');

-- Its room: deleted, with its link, invite and members; the member's post ended.
select is((select row(deleted_at is not null, owner_user_id)::text from app.rooms where id = pg_temp.room('ru')), row(true, null::uuid)::text,
  'its room is deleted and has no owner left');
select is(
  (select array[(select revoke_reason from app.share_links where id = 'RoomLinkOfUser02'),
                (select (revoked_at is not null)::text from app.room_invites where id = 'InviteOfAccountU'),
                (select removed_reason from app.room_members where room_id = pg_temp.room('ru') and user_id = pg_temp.u('03')),
                (select end_reason from app.shares where id = pg_temp.s('31'))]),
  array['room_deleted', 'true', 'room_deleted', 'room_deleted'],
  'the room''s link is revoked, its invite too, its member removed and the member''s post ended');
select is((select removed_by_user_id from app.room_members where room_id = pg_temp.room('ru') and user_id = pg_temp.u('04')), null,
  'who removed the earlier member is no longer recorded');

-- Another person's room: untouched, but without the account; its post there ended.
select is((select row(deleted_at is null, owner_user_id)::text from app.rooms where id = pg_temp.room('ro')), row(true, pg_temp.u('01'))::text,
  'the other room stays, with its owner');
select is((select count(*)::int from app.room_members where room_id = pg_temp.room('ro') and user_id = pg_temp.u('02')), 0,
  'the account''s membership there went with it');
select ok(exists (select 1 from realtime.messages m where m.topic = 'room:' || pg_temp.room('ro')::text
                   and m.payload ->> 'type' = 'member.changed' and m.payload ->> 'change' = 'removed'),
  'and the room''s members are told (member.changed)');
select is((select row(status, end_reason)::text from app.shares where id = pg_temp.s('22')), row('deleted', 'account_deleted')::text,
  'its post in the other room ended');

-- Its own share: ended, its link revoked, the tombstone and its history kept until their dates, with nobody's name.
select is(
  (select row(s.status, s.end_reason, s.created_by_user_id, s.created_by_device_id, l.revoked_at is not null, l.created_by_user_id)::text
     from app.shares s join app.share_links l on l.share_id = s.id where s.id = pg_temp.s('21')),
  row('deleted', 'account_deleted', null::uuid, null::uuid, true, null::uuid)::text,
  'its share ended, its link revoked; neither names the account');
select is((select count(*)::int from app.downloads where share_id = pg_temp.s('21') and user_id = pg_temp.u('07')), 1,
  'the record of its share''s download stays until its date (nobody can read it: the share has no creator)');

-- What it did to other people's things: still their history, without who.
select is(
  (select array_agg(row(actor_kind, event, user_id, device_id)::text order by event) from app.downloads
    where share_id in (pg_temp.s('01'), pg_temp.s('04')) and network_space_id = '4bf00000-0000-4000-8000-000000000001'
      and actor_kind = 'network_device' and user_id is distinct from pg_temp.u('06')),
  array[row('network_device', 'text_revealed', null::uuid, null::uuid)::text, row('network_device', 'url_issued', null::uuid, null::uuid)::text],
  'its downloads of other people''s shares stay in their history, by actor kind, with no user or device');
select is((select row(status, end_reason, claimed_by_user_id, claimed_device_id)::text from app.shares where id = pg_temp.s('03')),
  row('consumed', 'consumed', null::uuid, null::uuid)::text, 'a burn share it claimed and was still in the grace of is consumed now');
select is((select row(status, claimed_by_user_id, claimed_device_id)::text from app.shares where id = pg_temp.s('04')),
  row('consumed', null::uuid, null::uuid)::text, 'one it consumed earlier no longer names it');
select is((select updated_by_device_id from app.text_items where share_id = pg_temp.s('23')), null, 'nor does a text it edited');

-- Kept: billing records, the override, its report; deleted: its intent and reservations.
select is(
  (select array[(select count(*)::int from app.subscriptions where subject_id = pg_temp.u('02')),
                (select count(*)::int from app.billing_customers where subject_id = pg_temp.u('02')),
                (select count(*)::int from app.entitlement_overrides where subject_id = pg_temp.u('02')),
                (select count(*)::int from app.abuse_reports where reporter_user_id = pg_temp.u('02')),
                (select count(*)::int from app.merge_intents where target_user_id = pg_temp.u('02')),
                (select count(*)::int from app.storage_reservations where subject_id = pg_temp.u('02'))]),
  array[1, 1, 1, 1, 0, 0],
  'billing records, the override and the report are kept; its merge intent and reservations are not');
select is(
  (select metadata from app.audit_events where action = 'account.deleted' and target_id = pg_temp.u('02')::text),
  '{"sharesEnded": 3, "roomsDeleted": 1, "claimsFinished": 1}'::jsonb,
  'the deletion is audited with its counts (its room''s share ended with the room)');

-- O and T are untouched.
select is((select count(*)::int from auth.users where id in (pg_temp.u('01'), pg_temp.u('06'))), 2, 'nobody else was deleted');
select is((select row(status, created_by_user_id)::text from app.shares where id = pg_temp.s('01')), row('active', pg_temp.u('01'))::text,
  'and other people''s shares are still theirs');

select * from finish();
rollback;
