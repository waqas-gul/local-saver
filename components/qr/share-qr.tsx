"use client";

import { encodeQR } from "qr";
import { useMemo } from "react";

/**
 * QR code for a share link (03 §4.3), generated in the browser from the full URL, fragment and
 * secret included. No third-party QR service ever sees it. Error correction level M and the
 * standard 4-module quiet zone, drawn as one SVG path (no innerHTML).
 */
export function ShareQr({ url, size = 200, label = "QR code for the share link" }: { url: string; size?: number; label?: string }) {
  const { path, modules } = useMemo(() => {
    const matrix = encodeQR(url, "raw", { ecc: "medium", border: 4 });
    let d = "";
    matrix.forEach((row, y) => row.forEach((dark, x) => dark && (d += `M${x} ${y}h1v1h-1z`)));
    return { path: d, modules: matrix.length };
  }, [url]);

  return (
    <svg
      role="img"
      aria-label={label}
      data-testid="share-qr"
      width={size}
      height={size}
      viewBox={`0 0 ${modules} ${modules}`}
      shapeRendering="crispEdges"
      className="rounded-md bg-white"
    >
      <rect width={modules} height={modules} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
