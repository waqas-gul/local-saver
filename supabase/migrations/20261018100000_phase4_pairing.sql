-- Phase 4D, P4-18: QR pairing (phase 4 §17.8.4.1; E20, T-034).
--
-- P4-17 created the pairing kind of app.room_invites with its rules: at most 10 minutes (room_invites_lifetime) and
-- one use (room_invites_pairing_once). The second was written `kind <> 'pairing' or max_uses = 1`, which a missing
-- maximum passes (a CHECK accepts NULL), and app.accept_room_invite reads a missing maximum as unlimited uses. The
-- service always writes 1, but the database is the backstop: a pairing invite must name exactly one use.
--
-- Nothing else changes: app.accept_room_invite already records joined_via from the invite's kind, counts uses under
-- the invite's lock and holds the member cap under the room's; purge_ephemeral already purges pairing invites 7 days
-- after they end.

alter table app.room_invites drop constraint room_invites_pairing_once;
alter table app.room_invites
  add constraint room_invites_pairing_once check (kind <> 'pairing' or max_uses is not distinct from 1);
