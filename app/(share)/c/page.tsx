import type { Metadata } from "next";
import { CodeEntry } from "@/components/share/code-entry";

export const metadata: Metadata = { title: "Enter a share code · Local Saver" };

/** /c: open a share with a short code (DEC-014). */
export default function CodePage() {
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-medium">Enter a share code</h1>
      <p className="text-sm text-muted-foreground">Someone gave you a code like 7KQ4M-X9D2P? Type it here to open what they shared.</p>
      <CodeEntry />
    </div>
  );
}
