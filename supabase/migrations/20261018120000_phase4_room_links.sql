-- Phase 4D, P4-19: read-only room links (phase 4 §17.8.5, §17.12; Q-009, D4-16, D4-17; E22).
--
-- A room link is a share_links row whose target is a private room instead of one share: whoever holds its secret
-- (and, if set, its password) sees the room's current and future active shares through the existing unlock, grant
-- and viewer machinery, never its members, invites, settings, name, network or presence. There is still no link
-- to a network's feed (Q-028, DEC-033).
--
--   target_type   'share' or 'room' (C4-10's check widened)
--   share_id      nullable now: set exactly for share links
--   room_id       set exactly for room links; the room row's deletion takes them (purge_ephemeral removes a
--                 deleted room only once no share row refers to it), and with them their grants
--
-- Room links have no short code (the planned create body has none; a code would open a whole room), live at most
-- 30 days (the longest of D4-17's options) and never follow a share's expiry. Deleting a room revokes its links
-- ('room_deleted'), under the room's row lock, like its invites; creating one takes the room FOR KEY SHARE, so a
-- deletion in progress finishes first and the new link is revoked with the rest, or the creation sees the deleted
-- room. app.rooms has no kind column (P4-17): every Phase 4 room is private.

alter table app.share_links drop constraint share_links_target_type_check;
alter table app.share_links
  add constraint share_links_target_type_check check (target_type in ('share', 'room')),
  alter column share_id drop not null,
  add column room_id uuid references app.rooms (id) on delete cascade,
  add constraint share_links_target check (
    (target_type = 'share') = (share_id is not null) and (target_type = 'room') = (room_id is not null)),
  add constraint share_links_room_no_code check (target_type <> 'room' or short_code_hmac is null),
  add constraint share_links_room_lifetime check (target_type <> 'room' or expires_at <= created_at + interval '30 days'),
  add constraint share_links_room_own_expiry check (target_type <> 'room' or not follows_share_expiry);
alter table app.share_links drop constraint share_links_revoke_reason_check;
alter table app.share_links
  add constraint share_links_revoke_reason_check check (revoke_reason in ('creator', 'share_ended', 'blocked', 'room_deleted'));
create index share_links_room_idx on app.share_links (room_id, created_at desc) where target_type = 'room';

set role app_owner;

-- ---------------------------------------------------------------------------
-- app.delete_room, P4-19 version: also revokes the room's links ('room_deleted', their codes cleared), after its
-- invites and before its members. Otherwise as P4-17.
-- ---------------------------------------------------------------------------
create or replace function app.delete_room(p_room_id uuid, p_by_user_id uuid, p_reason text)
returns integer
language plpgsql volatile security invoker set search_path = ''
as $$
declare
  v_room app.rooms;
  v_share uuid;
  v_ended integer := 0;
  v_links integer;
begin
  if p_room_id is null or p_by_user_id is null or p_reason is null or p_reason not in ('deleted_by_owner', 'account_deleted') then
    raise exception 'invalid room deletion' using errcode = '22023';
  end if;
  select * into v_room from app.rooms r where r.id = p_room_id for update;
  if not found or v_room.deleted_at is not null or v_room.owner_user_id is distinct from p_by_user_id then
    return null;
  end if;
  for v_share in select s.id from app.shares s where s.room_id = p_room_id and s.ended_at is null order by s.id loop
    if app.end_share(v_share, 'room_deleted') then
      v_ended := v_ended + 1;
    end if;
  end loop;
  update app.room_invites i set revoked_at = now() where i.room_id = p_room_id and i.revoked_at is null;
  update app.share_links l
     set revoked_at = now(), revoke_reason = 'room_deleted', revoked_by_user_id = p_by_user_id,
         short_code_hmac = null, short_code_pepper_version = null, short_code_expires_at = null
   where l.room_id = p_room_id and l.target_type = 'room' and l.revoked_at is null;
  get diagnostics v_links = row_count;
  update app.room_members m
     set removed_at = now(), removed_by_user_id = p_by_user_id, removed_reason = 'room_deleted'
   where m.room_id = p_room_id and m.removed_at is null;
  update app.rooms r set deleted_at = now() where r.id = p_room_id;
  insert into app.audit_events (actor_kind, actor_user_id, action, target_type, target_id, metadata)
  values (case when p_reason = 'account_deleted' then 'system' else 'device' end, p_by_user_id, 'room.deleted', 'room',
          p_room_id::text, jsonb_build_object('reason', p_reason, 'sharesEnded', v_ended, 'linksRevoked', v_links));
  return v_ended;
end
$$;

reset role;
