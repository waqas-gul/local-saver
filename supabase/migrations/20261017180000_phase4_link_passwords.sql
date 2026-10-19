-- Phase 4D, P4-16: link passwords (phase 4 §17.8.3, §17.12.2; 03 §4.7; DEC-021, D4-24).
--
-- A password protects a link: a viewer needs the link's secret (or a short code) AND the password. The
-- service (lib/server/links/password.ts) hashes and verifies; the database stores the hash, keeps the
-- version and checks the grant's proof:
--
--   share_links.password_hash          scrypt PHC string (N = 2^17, r = 8, p = 1), the only accepted format.
--                                      D4-24 chose scrypt: no native package (deviation DV4-70).
--   share_links.password_version       +1 on every set, change or removal. Kept by a trigger, so no code
--                                      path can change the password without invalidating every grant.
--   share_links.password_set_at        when the current password was set (null without one).
--   share_links.password_locked_until  10 wrong passwords in 15 minutes lock new attempts for 15 minutes.
--   link_grants.password_verified_at   when this grant proved the password. A grant opens a password link
--                                      only if it proved the link's current version (lib/server/links/grants.ts,
--                                      accessFor, on every viewer request), whether a secret or a code made it.
--
-- No callable SQL function (§17.12.3): failure counting reuses app.rate_limit_hit and the lock is the
-- column above, written by the service. The trigger function below is a backstop, like check_link_expiry.

alter table app.share_links
  add column password_hash text,
  add column password_version integer not null default 0,
  add column password_set_at timestamptz,
  add column password_locked_until timestamptz,
  -- Never plaintext: exactly the format this build verifies, so a weaker hash can't be stored.
  add constraint share_links_password_hash check (
    password_hash is null
    or (char_length(password_hash) <= 512
        and password_hash ~ '^\$scrypt\$ln=17,r=8,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$')),
  add constraint share_links_password_version check (password_version >= 0),
  add constraint share_links_password_set check ((password_hash is null) = (password_set_at is null));

-- A proof belongs to one grant: it can't predate the grant (a new unlock or code refreshes the grant and
-- must clear it) or outlive it.
alter table app.link_grants
  add column password_verified_at timestamptz,
  add constraint link_grants_password_verified check (
    password_verified_at is null or (password_verified_at >= granted_at and password_verified_at <= expires_at));

set role app_owner;

-- The version follows the hash and nothing else: an insert starts at 0 (1 with a password); an update that
-- sets a different hash, or removes it, adds 1. Writes to the version or the time themselves are ignored,
-- so old grants can never be revived by winding the version back.
create function app.share_links_password_state()
returns trigger
language plpgsql security invoker set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.password_version := case when new.password_hash is null then 0 else 1 end;
    new.password_set_at := case when new.password_hash is null then null else now() end;
  elsif new.password_hash is distinct from old.password_hash then
    new.password_version := old.password_version + 1;
    new.password_set_at := case when new.password_hash is null then null else now() end;
  else
    new.password_version := old.password_version;
    new.password_set_at := old.password_set_at;
  end if;
  return new;
end
$$;
revoke all on function app.share_links_password_state() from public;

create trigger share_links_password_state
  before insert or update of password_hash, password_version, password_set_at on app.share_links
  for each row execute function app.share_links_password_state();

reset role;
