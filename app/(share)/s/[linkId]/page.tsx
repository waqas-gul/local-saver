import { SharedView } from "@/components/share/shared-view";

/**
 * /s/{linkId}#k={secret}: the share page (DEC-013). The server never sees the secret (it is in
 * the fragment) and never looks the link up here: the response is the same shell for every link
 * ID, existing or not, and a GET changes nothing (T-033). The browser unlocks.
 */
export default async function SharePage({ params }: PageProps<"/s/[linkId]">) {
  const { linkId } = await params;
  return (
    <>
      <h1 className="sr-only">Shared with you</h1>
      <SharedView linkId={linkId} />
    </>
  );
}
