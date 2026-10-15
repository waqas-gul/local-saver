"use client";

import { useQuery } from "@tanstack/react-query";
import { previewQuery } from "@/lib/client/queries/shares";
import { useRuntime } from "@/lib/client/runtime";
import type { FileDto } from "@/lib/shared/api/schemas";

/**
 * Thumbnail for a verified raster image (03 §6): a 300 s presigned GET rendered with a plain
 * <img>, never next/image, so private bytes never pass through the web server.
 */
export function FilePreview({ file }: { file: FileDto }) {
  const runtime = useRuntime();
  const { data } = useQuery(previewQuery(runtime?.api ?? null, file.id));
  if (!data) return <div className="size-12 shrink-0 animate-pulse rounded-md bg-muted" aria-hidden />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- deliberate: no image optimization of user content
    <img src={data.url} alt={file.name} className="size-12 shrink-0 rounded-md object-cover" referrerPolicy="no-referrer" />
  );
}
