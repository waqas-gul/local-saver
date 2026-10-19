import { AppShell } from "@/components/local/app-shell";
import { LocalHome } from "@/components/local/local-home";

// "This network": everyone on the same Wi-Fi/network sees what is posted here (DEC-031).
export default function Home() {
  return (
    <AppShell>
      <h1 className="sr-only">Local Saver</h1>
      <LocalHome />
    </AppShell>
  );
}
