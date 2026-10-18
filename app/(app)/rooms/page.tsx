import type { Metadata } from "next";
import { AppShell } from "@/components/local/app-shell";
import { RoomsHome } from "@/components/room/room-list";

export const metadata: Metadata = { title: "Rooms · Local Saver" };

// Private rooms (phase 4 §17.8.4): the caller's rooms, from any network.
export default function RoomsPage() {
  return (
    <AppShell>
      <h1 className="sr-only">Rooms</h1>
      <RoomsHome />
    </AppShell>
  );
}
