-- Phase 4D, P4-21: merge and account-deletion coverage for rooms, history and links (phase 4 §17.5.4, §17.5.7, §17.9;
-- T-053.3, T-053.12, T-053.13, T4-A5).
--
-- Every app column that holds a user or device ID now has a rule in both flows, and
-- supabase/tests/phase4_account_coverage.test.sql fails when one appears without it:
--   * the merge moves every storage reservation row of the anonymous user, finished ones too (they were left behind,
--     naming a deleted user); everything else it already moved (P4-06, P4-17);
--   * account deletion also finishes the burn claims the account still holds on other people's shares, and clears
--     its identity from other people's records (the download log, burn claims, room removals, text edits): those
--     records stay, as their owners' history, saying what happened and never who (D4-20). Its finished reservations
--     and merge intents go with it.
-- No table changes. Both functions keep their owners (the migration role) and grants; merge_anonymous_user stays
-- SECURITY DEFINER, delete_due_accounts INVOKER (run by pg_cron as its owner once P4-22 schedules it).

-- ---------------------------------------------------------------------------
-- merge_anonymous_user, P4-21 version: as P4-17's, but every reservation row moves.
-- ---------------------------------------------------------------------------
create or replace function app.merge_anonymous_user(
  p_intent_id uuid,
  p_secret_hmacs bytea[],
  p_target_user_id uuid,
  p_target_session_id uuid,
  p_device_id uuid,
  p_device_cap integer
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_intent app.merge_intents;
  v_source uuid;
  v_source_anonymous boolean;
  v_target_anonymous boolean;
  v_device app.devices;
  v_active integer;
  v_shares integer;
  v_links integer;
  v_memberships integer := 0;
  v_n integer;
  v_committed bigint := 0;
  v_reserved bigint := 0;
  v_files integer := 0;
  v_result jsonb;
  r record;
begin
  if p_intent_id is null or p_secret_hmacs is null or p_target_user_id is null or p_target_session_id is null
     or p_device_id is null or p_device_cap is null or p_device_cap < 1 then
    raise exception 'invalid merge arguments' using errcode = '22023';
  end if;

  -- 1. The intent, locked: redemptions of one intent run one after another (M6). The secret and the
  -- device are the proof (M1, M2).
  select * into v_intent from app.merge_intents i where i.id = p_intent_id for update;
  if not found or not (v_intent.secret_hmac = any (p_secret_hmacs)) or v_intent.anon_device_id <> p_device_id then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  -- 2. Already redeemed: the same account gets the stored result (a retry, a double click, M4).
  if v_intent.status = 'completed' then
    if v_intent.target_user_id = p_target_user_id then
      return v_intent.result || jsonb_build_object('outcome', 'merged', 'replayed', true);
    end if;
    return jsonb_build_object('outcome', 'conflict');
  end if;
  if v_intent.status <> 'open' or v_intent.expires_at <= now() then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  v_source := v_intent.anon_user_id;

  -- 3. Both users, locked in UUID order (M7). The source is still anonymous, the target permanent, and
  -- the session is the target's own: only a signed-in session of the account can receive (M13).
  for r in select u.id, u.is_anonymous from auth.users u where u.id in (v_source, p_target_user_id) order by u.id for update loop
    if r.id = v_source then
      v_source_anonymous := r.is_anonymous;
    else
      v_target_anonymous := r.is_anonymous;
    end if;
  end loop;
  if v_source_anonymous is null then
    return jsonb_build_object('outcome', 'unavailable');
  end if;
  if v_source = p_target_user_id or v_source_anonymous is distinct from true or v_target_anonymous is distinct from false
     or not exists (select 1 from auth.sessions s where s.id = p_target_session_id and s.user_id = p_target_user_id) then
    return jsonb_build_object('outcome', 'invalid');
  end if;
  select * into v_device from app.devices d where d.id = p_device_id for update;
  if not found or v_device.user_id <> v_source or v_device.revoked_at is not null then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  -- 4. Suspension on either side (M11, D4-4): a suspended user's data and record stay where they are.
  if exists (select 1 from app.user_flags f where f.user_id in (v_source, p_target_user_id) and f.suspended_at is not null) then
    return jsonb_build_object('outcome', 'suspended');
  end if;

  -- 5. Locks: the source's rooms and both users' member rows in them (room first, P4-17), the source's shares,
  -- its active reservations, both ledger rows (M8).
  perform 1 from app.rooms rm
   where rm.id in (select m.room_id from app.room_members m where m.user_id = v_source)
   order by rm.id
     for no key update;
  perform 1 from app.room_members m
   where m.user_id in (v_source, p_target_user_id)
     and m.room_id in (select m2.room_id from app.room_members m2 where m2.user_id = v_source)
   order by m.room_id, m.user_id
     for update;
  perform 1 from app.shares s
   where s.created_by_user_id = v_source or (s.billing_subject_type = 'user' and s.billing_subject_id = v_source)
      or s.claimed_by_user_id = v_source
   order by s.id
     for update;
  perform 1 from app.storage_reservations res
   where res.subject_type = 'user' and res.subject_id = v_source and res.status = 'active'
   order by res.id
     for update;
  perform 1 from app.storage_usage u
   where u.subject_type = 'user' and u.subject_id in (v_source, p_target_user_id)
   order by u.subject_id
     for update;

  -- 6. The device cap (M12): the account's active devices plus the one moving in. A device the
  -- browser's new session already has (registered before the merge) is replaced, so not counted.
  select count(*)::integer into v_active
    from app.devices d
   where d.user_id = p_target_user_id and d.revoked_at is null and d.auth_session_id is distinct from p_target_session_id;
  if v_active + 1 > p_device_cap then
    return jsonb_build_object('outcome', 'device_limit', 'maxDevices', p_device_cap, 'activeDevices', v_active);
  end if;

  -- 7. Ownership (the coverage lists: supabase/tests/phase4_accounts.test.sql, M10, and phase4_account_coverage.test.sql,
  -- P4-21). Snapshots are
  -- unchanged: what the anonymous user created keeps its Free snapshot.
  update app.devices d
     set revoked_at = now(), revoked_reason = 'merge', revoked_by_device_id = p_device_id
   where d.user_id = p_target_user_id and d.auth_session_id = p_target_session_id and d.revoked_at is null;
  update app.shares s set created_by_user_id = p_target_user_id where s.created_by_user_id = v_source;
  get diagnostics v_shares = row_count;
  update app.shares s set billing_subject_id = p_target_user_id
   where s.billing_subject_type = 'user' and s.billing_subject_id = v_source;
  -- A burn claim moves with its device (M15).
  update app.shares s set claimed_by_user_id = p_target_user_id where s.claimed_by_user_id = v_source;
  update app.share_links l set created_by_user_id = p_target_user_id where l.created_by_user_id = v_source;
  get diagnostics v_links = row_count;
  update app.share_links l set revoked_by_user_id = p_target_user_id where l.revoked_by_user_id = v_source;
  -- Room memberships (P4-17): the account's removed row in a room comes back when the source is active there;
  -- otherwise the source's row moves. Rows left behind (the account was already a member) go with the source.
  update app.room_members t
     set joined_via = s.joined_via, invite_id = s.invite_id, joined_device_id = s.joined_device_id, joined_at = s.joined_at,
         removed_at = null, removed_by_user_id = null, removed_reason = null
    from app.room_members s
   where s.user_id = v_source and s.removed_at is null and s.role = 'member'
     and t.room_id = s.room_id and t.user_id = p_target_user_id and t.removed_at is not null and t.role = 'member';
  get diagnostics v_n = row_count;
  v_memberships := v_n;
  with moved as (
    update app.room_members s set user_id = p_target_user_id
     where s.user_id = v_source
       and not exists (select 1 from app.room_members t where t.room_id = s.room_id and t.user_id = p_target_user_id)
    returning s.removed_at
  )
  select v_memberships + count(*) filter (where moved.removed_at is null) into v_memberships from moved;
  update app.room_members m set removed_by_user_id = p_target_user_id where m.removed_by_user_id = v_source;
  update app.devices d
     set user_id = p_target_user_id, auth_session_id = p_target_session_id, last_seen_at = now()
   where d.id = p_device_id;
  update app.network_presence p set user_id = p_target_user_id where p.device_id = p_device_id;
  update app.downloads dl set user_id = p_target_user_id where dl.user_id = v_source;
  update app.abuse_reports ar set reporter_user_id = p_target_user_id where ar.reporter_user_id = v_source;
  if exists (select 1 from app.user_flags f where f.user_id = v_source and f.upload_restricted) then
    insert into app.user_flags (user_id, upload_restricted) values (p_target_user_id, true)
    on conflict (user_id) do update set upload_restricted = true, updated_at = now();
  end if;

  -- 8. The ledger: the source's committed and reserved bytes and files join the target's row.
  select u.bytes_committed, u.bytes_reserved, u.files_committed into v_committed, v_reserved, v_files
    from app.storage_usage u where u.subject_type = 'user' and u.subject_id = v_source;
  v_committed := coalesce(v_committed, 0);
  v_reserved := coalesce(v_reserved, 0);
  v_files := coalesce(v_files, 0);
  if v_committed > 0 or v_reserved > 0 or v_files > 0 then
    insert into app.storage_usage (subject_type, subject_id) values ('user', p_target_user_id) on conflict do nothing;
    update app.storage_usage u
       set bytes_committed = u.bytes_committed + v_committed,
           bytes_reserved = u.bytes_reserved + v_reserved,
           files_committed = u.files_committed + v_files,
           updated_at = now()
     where u.subject_type = 'user' and u.subject_id = p_target_user_id;
  end if;
  delete from app.storage_usage u where u.subject_type = 'user' and u.subject_id = v_source;
  -- Every reservation row moves (P4-21): active ones are counted above; finished ones are the uploads' record.
  update app.storage_reservations res set subject_id = p_target_user_id
   where res.subject_type = 'user' and res.subject_id = v_source;

  -- 9. Today's upload volume (M11): a merge can't reset the daily budget.
  insert into app.rate_counters as rc (key, window_start, value, expires_at)
  select 'upload_kib:user:' || p_target_user_id::text, c.window_start, c.value, c.expires_at
    from app.rate_counters c
   where c.key = 'upload_kib:user:' || v_source::text and c.expires_at > now()
  on conflict (key, window_start) do update set value = rc.value + excluded.value;
  delete from app.rate_counters c where c.key = 'upload_kib:user:' || v_source::text;

  -- 10. The anonymous user goes; its sessions, identities, other devices, flags, idempotency keys and leftover
  -- member rows cascade. Its audit events keep its ID (history stays truthful).
  delete from auth.users u where u.id = v_source and u.is_anonymous;

  -- 11. Done (M16).
  v_result := jsonb_build_object('shares', v_shares, 'links', v_links, 'devices', 1, 'memberships', v_memberships, 'bytes', v_committed);
  update app.merge_intents i
     set status = 'completed', target_user_id = p_target_user_id, completed_at = now(), result = v_result
   where i.id = p_intent_id;
  insert into app.audit_events (actor_kind, actor_user_id, actor_device_id, action, target_type, target_id, metadata)
  values ('device', p_target_user_id, p_device_id, 'account.merged', 'user', p_target_user_id::text,
          v_result || jsonb_build_object('anonUserId', v_source));
  return v_result || jsonb_build_object('outcome', 'merged');
end
$$;

-- ---------------------------------------------------------------------------
-- delete-due-accounts, P4-21 version (§17.5.7; T4-A5's execution, the coverage list in
-- supabase/tests/phase4_account_coverage.test.sql). For each due account, in this order:
--   1. its open rooms are deleted (delete_room: their shares end, links and invites are revoked, members removed);
--   2. its open shares end (end_share: objects queued, its links revoked);
--   3. burn shares it claimed and is still in the grace of are finished (consumed), as finalize_claims would at the
--      end of the grace: nobody can use that claim any more;
--   4. its identity is cleared from other people's records, which stay (their history, D4-20): the download log
--      (user and device), burn claims, room removals it made, text edits from its devices;
--   5. its finished storage reservations, merge intents, devices, ledger row and profile are deleted;
--   6. the Auth user is deleted: sessions, identities, flags, idempotency keys and memberships in other rooms cascade
--      (a member.changed signal for each active one); shares, links, rooms and invites keep a null creator.
-- Kept on purpose: audit events (their own retention), billing records (accounting law), operator overrides and
-- abuse reports (evidence, D-3). Tombstones stay until their snapshot dates. Suspended accounts still wait for an
-- operator (D4-6 pending). Still not scheduled (P4-22).
-- ---------------------------------------------------------------------------
create or replace function app.delete_due_accounts(p_batch integer)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  r record;
  v_room uuid;
  v_share uuid;
  v_ended integer;
  v_rooms integer;
  v_claims integer;
  v_devices uuid[];
  v_count integer := 0;
begin
  if p_batch is null or p_batch < 1 then
    raise exception 'invalid batch' using errcode = '22023';
  end if;
  for r in
    select p.user_id from app.profiles p
     where p.deletion_scheduled_for <= now()
       and not exists (select 1 from app.user_flags f where f.user_id = p.user_id and f.suspended_at is not null)
     order by p.deletion_scheduled_for
     limit p_batch
       for update of p skip locked
  loop
    perform 1 from auth.users u where u.id = r.user_id for update;
    v_devices := array(select d.id from app.devices d where d.user_id = r.user_id);
    -- 1. Rooms first: an open room must keep its owner (rooms_owner_while_open).
    v_rooms := 0;
    for v_room in select rm.id from app.rooms rm where rm.owner_user_id = r.user_id and rm.deleted_at is null order by rm.id loop
      if app.delete_room(v_room, r.user_id, 'account_deleted') is not null then
        v_rooms := v_rooms + 1;
      end if;
    end loop;
    -- 2. Its own shares, in any room or network.
    v_ended := 0;
    for v_share in select s.id from app.shares s where s.created_by_user_id = r.user_id and s.ended_at is null order by s.id loop
      if app.end_share(v_share, 'account_deleted') then
        v_ended := v_ended + 1;
      end if;
    end loop;
    -- 3. Its claims on other people's burn shares: consumed now, as at the end of the grace.
    v_claims := 0;
    for v_share in select s.id from app.shares s where s.claimed_by_user_id = r.user_id and s.status = 'claimed' order by s.id loop
      if app.end_share(v_share, 'consumed') then
        v_claims := v_claims + 1;
      end if;
    end loop;
    -- 4. Other people's records keep what happened, not who (D4-20).
    update app.shares s set claimed_by_user_id = null, claimed_device_id = null where s.claimed_by_user_id = r.user_id;
    update app.downloads dl set user_id = null, device_id = null where dl.user_id = r.user_id or dl.device_id = any (v_devices);
    update app.room_members m set removed_by_user_id = null where m.removed_by_user_id = r.user_id;
    update app.text_items t set updated_by_device_id = null where t.updated_by_device_id = any (v_devices);
    update app.devices d set revoked_by_device_id = null where d.revoked_by_device_id = any (v_devices) and d.user_id <> r.user_id;
    -- 5. Its own bookkeeping.
    delete from app.storage_reservations res where res.subject_type = 'user' and res.subject_id = r.user_id and res.status <> 'active';
    delete from app.merge_intents i where i.target_user_id = r.user_id or i.anon_user_id = r.user_id;
    delete from app.devices d where d.user_id = r.user_id;
    delete from app.storage_usage u where u.subject_type = 'user' and u.subject_id = r.user_id;
    delete from app.profiles p where p.user_id = r.user_id;
    insert into app.audit_events (actor_kind, action, target_type, target_id, metadata)
    values ('system', 'account.deleted', 'user', r.user_id::text,
            jsonb_build_object('sharesEnded', v_ended, 'roomsDeleted', v_rooms, 'claimsFinished', v_claims));
    -- 6. The Auth user.
    delete from auth.users u where u.id = r.user_id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;
