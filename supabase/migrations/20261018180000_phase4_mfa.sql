-- Phase 4D, P4-24: MFA (phase 4 §17.5.9, D4-30; T4-A12).
--
-- An account with a verified authenticator (a Supabase Auth TOTP factor) uses the app only at aal2. The API refuses its
-- aal1 sessions (lib/server/auth/session.ts, 403 MFA_REQUIRED); this makes Realtime refuse them too. Supabase Auth ends
-- an account's aal1 sessions when its first factor is confirmed, but their access tokens stay valid until they expire,
-- and a later sign-in by email code is aal1 until it confirms with the authenticator. Enrolling, confirming and removing
-- a factor are Supabase Auth's own calls. No table changes.

-- can_access_topic (owned by app_owner) asks app.mfa_enrolled, which the migration role owns (it may read
-- auth.mfa_factors) and which only app_server could call until now.
grant execute on function app.mfa_enrolled(uuid) to app_owner;

set role app_owner;

-- ---------------------------------------------------------------------------
-- Realtime topic authorization, P4-24 version: as P4-17's, plus aal2 for an account with an authenticator, on every
-- topic (user:, net:, room:), joining and tracking presence alike.
-- ---------------------------------------------------------------------------
create or replace function app_realtime.can_access_topic(p_topic text)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_claims jsonb;
  v_uid uuid;
  v_session uuid;
  v_kind text;
  v_id uuid;
begin
  begin
    v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    v_uid := (v_claims ->> 'sub')::uuid;
    v_session := (v_claims ->> 'session_id')::uuid;
    v_id := split_part(p_topic, ':', 2)::uuid;
  exception when others then
    return false;
  end;
  if v_uid is null or v_id is null then
    return false;
  end if;
  v_kind := split_part(p_topic, ':', 1);
  if p_topic <> v_kind || ':' || v_id::text then
    return false;
  end if;

  if jsonb_typeof(v_claims -> 'amr') = 'array'
     and exists (select 1 from jsonb_array_elements(v_claims -> 'amr') a where a ->> 'method' = 'password') then
    return false;
  end if;
  -- A revoked device's access token is valid until it expires; its session gets nothing on (re)join.
  if v_session is not null
     and exists (select 1 from app.devices d where d.auth_session_id = v_session and d.revoked_at is not null) then
    return false;
  end if;
  -- P4-24: an account with a verified authenticator joins nothing below aal2, as in the API (D4-30, §17.5.9).
  if coalesce(v_claims ->> 'aal', 'aal1') <> 'aal2' and app.mfa_enrolled(v_uid) then
    return false;
  end if;

  if v_kind = 'user' then
    return v_id = v_uid;
  elsif v_kind = 'net' then
    return v_session is not null
       and coalesce((select f.enabled from app.runtime_flags f where f.key = 'local_sharing_enabled'), true)
       and not exists (select 1 from app.user_flags uf where uf.user_id = v_uid and uf.suspended_at is not null)
       and exists (
         select 1
           from app.devices d
           join app.network_presence p on p.device_id = d.id
           join app.network_spaces s on s.id = p.space_id
          where d.auth_session_id = v_session and d.user_id = v_uid and d.revoked_at is null
            and p.space_id = v_id and p.present_until > now() and s.status = 'ok');
  elsif v_kind = 'room' then
    return v_session is not null
       and not exists (select 1 from app.user_flags uf where uf.user_id = v_uid and uf.suspended_at is not null)
       and exists (select 1 from app.devices d where d.auth_session_id = v_session and d.user_id = v_uid and d.revoked_at is null)
       and exists (
         select 1
           from app.room_members m
           join app.rooms r on r.id = m.room_id
          where m.room_id = v_id and m.user_id = v_uid and m.removed_at is null and r.deleted_at is null);
  end if;
  return false;
end
$$;

reset role;

revoke execute on all functions in schema app from public;
revoke execute on all functions in schema app_realtime from public;
grant execute on function app_realtime.can_access_topic(text) to authenticated;
