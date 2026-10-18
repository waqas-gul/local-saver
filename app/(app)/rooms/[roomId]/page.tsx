import type { Metadata } from "next";
import { AppShell } from "@/components/local/app-shell";
import { RoomPage } from "@/components/room/room-view";

export const metadata: Metadata = { title: "Room · Local Saver" };

/**
 * /rooms/{roomId}: one room. The server renders the same shell for every ID and looks nothing up; the browser asks the
 * API, which answers only an active member (phase 4 §17.11.2).
 */
export default async function RoomRoute({ params }: PageProps<"/rooms/[roomId]">) {
  const { roomId } = await params;
  return (
    <AppShell>
      <h1 className="sr-only">Room</h1>
      <RoomPage roomId={roomId} />
    </AppShell>
  );
}
