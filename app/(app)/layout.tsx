import { AppProviders } from "@/lib/client/providers";

/** The app itself ("This network", My uploads): Supabase session, device, Realtime (DEC-034). */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return <AppProviders>{children}</AppProviders>;
}
