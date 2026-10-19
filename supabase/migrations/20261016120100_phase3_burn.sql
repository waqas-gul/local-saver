-- Phase 3: burn after download (DEC-015; 03 §5, 04 §7.1, phase 3 §17.8).
--
-- A burn share is claimed by the first person who downloads (or reveals) it: one device on the
-- network, or one link-viewer session. The claim is a single conditional UPDATE under the share's
-- row lock, so exactly one claimant wins however many arrive at once (T-037). The claimant then
-- has a grace window, capped at the share's expiry (D-6), with at most 3 download URLs per file
-- (or 3 reveals of a text), after which the share is consumed. Creators never claim (DEC-015):
-- the verified creator may download until it is consumed (D-7).
--
-- Who may create one is decided in the app (Q-008): features.burnAfterDownload, or the Free
-- plan while the free_burn_after_download flag is on (beta and testing). Off by default.

-- ---------------------------------------------------------------------------
-- Claim columns and checks (phase 3 §17.8.1)
-- ---------------------------------------------------------------------------
alter table app.shares
  add column claimed_at timestamptz,
  -- A device claimant: the verified user and their device (plain IDs, like downloads.user_id).
  add column claimed_by_user_id uuid,
  add column claimed_device_id uuid,
  -- A link-viewer claimant: the SHA-256 of their session cookie, never the cookie (C-8).
  add column claimed_link_session_hash bytea check (octet_length(claimed_link_session_hash) = 32),
  -- The link the viewer used, for audit. No foreign key: share_links cascade from shares, and a
  -- cyclic ON DELETE SET NULL on the row being deleted is avoided (deviation from 04 §7.1).
  add column claimed_link_id text check (claimed_link_id ~ '^[A-Za-z0-9_-]{16}$'),
  add column claim_grace_until timestamptz;

alter table app.shares
  -- Unclaimed open shares have no claim; a claim stays on the row after the share ends, whatever
  -- the reason (consumed, or deleted or blocked while claimed), for audit.
  add constraint shares_claim_columns check (
    status not in ('pending_upload', 'active')
    or (claimed_at is null and claimed_by_user_id is null and claimed_device_id is null
        and claimed_link_session_hash is null and claimed_link_id is null and claim_grace_until is null)),
  add constraint shares_claim_complete check (
    status <> 'claimed'
    or (claimed_at is not null and claim_grace_until is not null
        and ((claimed_by_user_id is not null and claimed_device_id is not null and claimed_link_session_hash is null)
             or (claimed_by_user_id is null and claimed_device_id is null and claimed_link_session_hash is not null)))),
  add constraint shares_claim_grace check (
    claim_grace_until is null
    or (claim_grace_until <= claimed_at + interval '6 hours' and claim_grace_until <= expires_at)),
  add constraint shares_consumed_requires_burn check (status <> 'consumed' or burn_after_download);

create index shares_claim_grace_idx on app.shares (claim_grace_until) where status = 'claimed';

-- Issuances during grace are counted per (share, file, event): only the claimant gets any then.
alter table app.downloads drop constraint downloads_event_check;
alter table app.downloads add constraint downloads_event_check
  check (event in ('url_issued', 'preview_issued', 'burn_claimed', 'burn_retry', 'text_revealed'));

insert into app.runtime_flags (key, enabled, value, note) values
  ('burn_after_download_enabled', true, '{}', 'Kill switch: creating new burn-after-download shares (existing ones keep working)'),
  ('free_burn_after_download', false, '{}', 'Q-008: the Free plan may create burn-after-download shares while on (beta and testing). Off by default; production stays off until the owner decides.')
on conflict (key) do nothing;

set role app_owner;

-- ---------------------------------------------------------------------------
-- Functions (SECURITY INVOKER, called by app_server inside the request's transaction)
-- ---------------------------------------------------------------------------

-- Grace (03 §5.4): 15 minutes plus a second per MiB, at most 6 hours. Capped at expiry by the caller.
create function app.burn_grace(p_total_bytes bigint)
returns interval
language sql immutable security invoker set search_path = ''
as $$
  select least(interval '15 minutes' + make_interval(secs => ceil(greatest(coalesce(p_total_bytes, 0), 0) / 1048576.0)::double precision),
               interval '6 hours');
$$;

-- The claim (03 §5.3, phase 3 §17.8.2). Exactly one claimant kind: a device (user and device) or
-- a link session hash. Outcomes:
--   claimed             this call won the share; issuance 1
--   retry               the claimant again, inside grace: issuance n (≤ 3 per file, or per text)
--   retry_limit         the claimant has used their 3 issuances for this file (or text)
--   already_downloaded  someone else claimed it, or it is consumed (by_you: the caller was the claimant)
--   not_claimable       not an active, unexpired burn share of this kind: answer as for any share
-- The losing UPDATE waits for the winner's row lock and then, under READ COMMITTED, re-checks
-- `status = 'active'` against the committed row and updates nothing. Stricter isolation would
-- make it fail instead (40001), so it is refused here.
create function app.claim_burn_share(
  p_share_id uuid,
  p_file_id uuid,
  p_purpose text,
  p_claimant_user_id uuid,
  p_claimant_device_id uuid,
  p_link_session_hash bytea,
  p_link_id text,
  p_url_ttl_seconds integer,
  p_user_agent_family text
)
returns table (outcome text, claim_grace_until timestamptz, issuance integer, by_you boolean)
language plpgsql volatile security invoker set search_path = ''
as $$
declare
  v_device boolean := p_claimant_user_id is not null or p_claimant_device_id is not null;
  v_viewer boolean := p_link_session_hash is not null;
  v_kind text := case p_purpose when 'file' then 'files' when 'text' then 'text' end;
  v_share app.shares;
  v_mine boolean;
  v_used integer;
  v_event text;
  v_won boolean := false;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'claim_burn_share must run under READ COMMITTED' using errcode = '25001';
  end if;
  if v_device = v_viewer
     or (v_device and (p_claimant_user_id is null or p_claimant_device_id is null))
     or (v_viewer and (octet_length(p_link_session_hash) <> 32 or p_link_id is null))
     or v_kind is null
     or ((p_purpose = 'file') <> (p_file_id is not null))
     or (p_purpose = 'file' and (p_url_ttl_seconds is null or p_url_ttl_seconds not between 1 and 300)) then
    raise exception 'invalid claim arguments' using errcode = '22023';
  end if;
  -- The caller found the file verified; it may have been ended since (then: already downloaded).
  if p_purpose = 'file' and not exists (select 1 from app.files f where f.id = p_file_id and f.share_id = p_share_id) then
    raise exception 'the file is not a file of this share' using errcode = '22023';
  end if;

  update app.shares s
     set status = 'claimed',
         claimed_at = now(),
         claimed_by_user_id = p_claimant_user_id,
         claimed_device_id = p_claimant_device_id,
         claimed_link_session_hash = p_link_session_hash,
         claimed_link_id = case when v_viewer then p_link_id end,
         claim_grace_until = least(now() + app.burn_grace(s.total_bytes), s.expires_at),
         updated_at = now()
   where s.id = p_share_id
     and s.status = 'active'
     and s.burn_after_download
     and s.kind = v_kind
     and s.expires_at > now()
     and (p_claimant_user_id is null or s.created_by_user_id is distinct from p_claimant_user_id)
  returning s.* into v_share;

  if found then
    v_won := true;
    v_event := case when p_purpose = 'file' then 'burn_claimed' else 'text_revealed' end;
    v_used := 0;
  else
    -- Lost, or not claimable: read the latest committed state under the row lock.
    select * into v_share from app.shares s where s.id = p_share_id for update;
    if not found then
      return query select 'not_claimable'::text, null::timestamptz, 0, false;
      return;
    end if;
    if p_claimant_user_id is not null and v_share.created_by_user_id = p_claimant_user_id then
      raise exception 'creators never claim their own share' using errcode = '22023';
    end if;
    v_mine := coalesce(case when v_device
                            then v_share.claimed_by_user_id = p_claimant_user_id and v_share.claimed_device_id = p_claimant_device_id
                            else v_share.claimed_link_session_hash = p_link_session_hash end, false);

    if v_share.kind <> v_kind or not v_share.burn_after_download then
      return query select 'not_claimable'::text, null::timestamptz, 0, false;
      return;
    end if;
    if v_share.status = 'claimed' and v_mine and now() < v_share.claim_grace_until and v_share.expires_at > now() then
      select count(*)::integer into v_used
        from app.downloads d
       where d.share_id = p_share_id
         and ((p_purpose = 'file' and d.file_id = p_file_id and d.event in ('burn_claimed', 'burn_retry'))
              or (p_purpose = 'text' and d.event = 'text_revealed'));
      if v_used >= 3 then
        return query select 'retry_limit'::text, v_share.claim_grace_until, v_used, true;
        return;
      end if;
      v_event := case when p_purpose = 'file' then 'burn_retry' else 'text_revealed' end;
    elsif v_share.status in ('claimed', 'consumed') then
      return query select 'already_downloaded'::text, null::timestamptz, 0, v_mine;
      return;
    else
      return query select 'not_claimable'::text, null::timestamptz, 0, false;
      return;
    end if;
  end if;

  insert into app.downloads (share_id, file_id, network_space_id, actor_kind, user_id, device_id, link_id, event,
                             url_expires_at, user_agent_family, retention_until)
  values (p_share_id, p_file_id, v_share.network_space_id,
          case when v_device then 'network_device' else 'link_viewer' end,
          p_claimant_user_id, p_claimant_device_id, case when v_viewer then p_link_id end, v_event,
          case when p_purpose = 'file' then now() + make_interval(secs => p_url_ttl_seconds) end,
          left(p_user_agent_family, 60),
          now() + make_interval(days => coalesce((v_share.entitlement_snapshot ->> 'historyRetentionDays')::integer, 30)));

  return query select case when v_won then 'claimed' else 'retry' end, v_share.claim_grace_until, v_used + 1, true;
end
$$;

-- "I've got it" (phase 3 §17.8.6): the claimant ends the share now. Returns consumed, or
-- already_consumed for the same claimant (idempotent), or not_claimant for anyone else.
create function app.confirm_burn_received(
  p_share_id uuid,
  p_claimant_user_id uuid,
  p_claimant_device_id uuid,
  p_link_session_hash bytea
)
returns text
language plpgsql security invoker set search_path = ''
as $$
declare
  v_device boolean := p_claimant_user_id is not null or p_claimant_device_id is not null;
  v_share app.shares;
  v_mine boolean;
begin
  if v_device = (p_link_session_hash is not null)
     or (v_device and (p_claimant_user_id is null or p_claimant_device_id is null)) then
    raise exception 'invalid claimant' using errcode = '22023';
  end if;
  select * into v_share from app.shares s where s.id = p_share_id for update;
  if not found then
    return 'not_claimant';
  end if;
  v_mine := coalesce(case when v_device
                          then v_share.claimed_by_user_id = p_claimant_user_id and v_share.claimed_device_id = p_claimant_device_id
                          else v_share.claimed_link_session_hash = p_link_session_hash end, false);
  if not v_mine or v_share.status not in ('claimed', 'consumed') then
    return 'not_claimant';
  end if;
  if v_share.status = 'consumed' then
    return 'already_consumed';
  end if;
  perform app.end_share(p_share_id, 'consumed');
  return 'consumed';
end
$$;

-- Job: finalize-burn-claims (every minute). Ends claimed shares whose grace is over; their objects
-- are deleted after the 5-minute margin (end_share). Access already stopped at claim_grace_until.
create function app.finalize_claims(p_batch integer)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  for v_id in
    select s.id from app.shares s
     where s.status = 'claimed' and s.claim_grace_until <= now()
     order by s.claim_grace_until
     limit p_batch
     for update skip locked
  loop
    if app.end_share(v_id, 'consumed') then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end
$$;

reset role;

revoke execute on all functions in schema app from public;

grant execute on function
  app.burn_grace(bigint),
  app.claim_burn_share(uuid, uuid, text, uuid, uuid, bytea, text, integer, text),
  app.confirm_burn_received(uuid, uuid, uuid, bytea)
to app_server;
-- finalize_claims is a job: pg_cron only (phase 3 §17.6).
