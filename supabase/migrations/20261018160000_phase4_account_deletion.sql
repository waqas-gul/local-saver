-- Phase 4D, P4-22: the account-deletion flow (phase 4 §17.5.7, D4-6 and D4-30 as recommended; T4-A5, T4-A6).
--
-- The request and cancel functions (P4-03) and the deletion job (P4-03, P4-17, P4-21) already exist; this wires them:
--   * cancel_account_deletion refuses a deletion whose date has passed: the grace is over, and the job may be running;
--   * run_job knows delete-due-accounts, which calls app.delete_due_accounts, the one deletion mechanism (P4-21's);
--   * pg_cron runs it every hour (the plan says daily: with an hourly run an account goes within the hour after the
--     date the app shows, not up to a day later);
--   * a change of an account's deletion state sends account.changed on its user topic, so its other browsers show or
--     hide the deletion banner and refetch their plan at once.
-- No table changes. DELETE /api/v1/me and POST /api/v1/me/deletion/cancel (lib/server/accounts/delete.ts) call the
-- request and cancel functions; nothing the app can call runs the job: delete_due_accounts and run_job stay granted to
-- nobody, and pg_cron runs the job as its owner (the migration role, which may delete from auth.users).

set role app_owner;

-- ---------------------------------------------------------------------------
-- cancel_account_deletion, P4-22 version: only during the grace. As P4-03's otherwise.
-- ---------------------------------------------------------------------------
create or replace function app.cancel_account_deletion(p_user_id uuid)
returns boolean
language plpgsql security invoker set search_path = ''
as $$
begin
  update app.profiles p
     set deletion_requested_at = null, deletion_scheduled_for = null, updated_at = now()
   where p.user_id = p_user_id and p.deletion_requested_at is not null and p.deletion_scheduled_for > now();
  if not found then
    -- Nothing pending, or its date has passed (the job deletes the account at its next run).
    return false;
  end if;
  insert into app.audit_events (actor_kind, actor_user_id, action, target_type, target_id)
  values ('device', p_user_id, 'account.deletion_cancelled', 'user', p_user_id::text);
  return true;
end
$$;

reset role;

-- ---------------------------------------------------------------------------
-- account.changed for the deletion state (§17.14): the same ID-free signal the subscription trigger sends. Owned by
-- the migration role, like the other realtime.send triggers (realtime.messages has RLS).
-- ---------------------------------------------------------------------------
create function app.emit_deletion_changed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if (new.deletion_requested_at, new.deletion_scheduled_for) is distinct from (old.deletion_requested_at, old.deletion_scheduled_for) then
    perform realtime.send(jsonb_build_object('v', 1, 'type', 'account.changed'), 'account.changed', 'user:' || new.user_id::text, true);
  end if;
  return null;
end
$$;

create trigger profiles_emit_deletion_changed
  after update of deletion_requested_at, deletion_scheduled_for on app.profiles
  for each row execute function app.emit_deletion_changed();

-- ---------------------------------------------------------------------------
-- The job runner, P4-22 version: adds delete-due-accounts (100 accounts a run). Otherwise as Phase 4C. A failure rolls
-- the whole run back and is recorded on the heartbeat (/health/cron: jobs failing); runbooks/account-deletion.md.
-- ---------------------------------------------------------------------------
create or replace function app.run_job(p_job text)
returns void
language plpgsql security invoker set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_job is null or p_job not in ('trigger-storage-janitor', 'finalize-burn-claims', 'purge-tombstones',
                                    'cleanup-anonymous-users', 'reconcile-storage-usage', 'reconcile-r2-orphans',
                                    'cron-heartbeat', 'trigger-billing-reconcile', 'delete-due-accounts') then
    raise exception 'unknown job' using errcode = '22023';
  end if;
  perform app.job_started(p_job);
  begin
    if p_job = 'trigger-storage-janitor' then
      v_result := jsonb_build_object('delete', app.trigger_storage_janitor('delete'),
                                     'reconcile', app.trigger_storage_janitor('reconcile'));
    elsif p_job = 'finalize-burn-claims' then
      v_result := jsonb_build_object('finalized', app.finalize_claims(500));
    elsif p_job = 'purge-tombstones' then
      v_result := app.purge_tombstones(1000);
    elsif p_job = 'cleanup-anonymous-users' then
      v_result := jsonb_build_object('deleted', app.cleanup_anonymous_users(1000));
    elsif p_job = 'reconcile-storage-usage' then
      v_result := app.reconcile_storage_usage(1000);
    elsif p_job = 'reconcile-r2-orphans' then
      v_result := app.start_storage_reconcile();
    elsif p_job = 'trigger-billing-reconcile' then
      v_result := app.trigger_billing_reconcile();
    elsif p_job = 'delete-due-accounts' then
      v_result := jsonb_build_object('deleted', app.delete_due_accounts(100));
    else
      v_result := '{}'::jsonb;
    end if;
    perform app.record_job_run(p_job, true, v_result);
  exception when others then
    perform app.record_job_run(p_job, false, '{}'::jsonb, sqlstate || ' ' || left(sqlerrm, 180));
    raise warning 'job % failed: % %', p_job, sqlstate, sqlerrm;
  end;
end
$$;

revoke execute on all functions in schema app from public;
-- emit_deletion_changed, run_job and delete_due_accounts: granted to nobody (the trigger fires as the table's; pg_cron
-- runs the job as its owner).

-- Hourly at :23 (offset from the */5 and */10 jobs and from every daily job).
select cron.schedule('delete-due-accounts', '23 * * * *', $$select app.run_job('delete-due-accounts')$$);
