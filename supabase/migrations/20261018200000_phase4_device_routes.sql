-- Phase 4, P4-26: the device routes ask whether the token's Auth session still exists (phase 4 §33; ARCHITECTURE §5.3).
--
-- GET /api/v1/me/devices and DELETE /api/v1/me/devices/{id} take the token alone, because a browser refused at the
-- device cap has no device yet and must still see what it can revoke. Until now they never asked whether that token's
-- Auth session still existed, so a revoked or signed-out browser could list the account's devices and revoke the
-- others until its access token expired (up to an hour). Registration and the merge already check it inside their own
-- functions; this function answers the same question for the two routes. No table changes.

-- ---------------------------------------------------------------------------
-- Owned by the migration role: it reads auth.sessions.
-- ---------------------------------------------------------------------------

-- The state of a token's Auth session, for the routes without a device:
--   revoked  a revoked device of the user is bound to it (401 DEVICE_REVOKED; the browser signs out)
--   ended    it was signed out, revoked or deleted, or isn't the user's (401 UNAUTHENTICATED)
--   live     otherwise, with or without a device of its own
-- revoke_device deletes the session too; the revoked check comes first so that browser is told why, as register_device
-- tells it.
create function app.auth_session_state(p_user_id uuid, p_session_id uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when exists (select 1 from app.devices d
                  where d.user_id = p_user_id and d.auth_session_id = p_session_id and d.revoked_at is not null) then 'revoked'
    when exists (select 1 from auth.sessions s where s.id = p_session_id and s.user_id = p_user_id) then 'live'
    else 'ended'
  end;
$$;

revoke execute on function app.auth_session_state(uuid, uuid) from public;
grant execute on function app.auth_session_state(uuid, uuid) to app_server;
