import type { Metadata } from "next";
import { AppShell } from "@/components/local/app-shell";
import { InviteAccept } from "@/components/room/invite-accept";

export const metadata: Metadata = { title: "Join a room · Local Saver" };

/**
 * /j/{inviteId}#k={secret}: joining a room (phase 4 §17.8.4.1). The server never sees the secret (it is in the
 * fragment) and never looks the invite up here: every invite ID gets the same shell, and a GET changes nothing. The
 * browser previews and, once the person confirms, accepts.
 */
export default async function JoinPage({ params }: PageProps<"/j/[inviteId]">) {
  const { inviteId } = await params;
  return (
    <AppShell>
      <h1 className="sr-only">Join a room</h1>
      <InviteAccept inviteId={inviteId} />
    </AppShell>
  );
}
