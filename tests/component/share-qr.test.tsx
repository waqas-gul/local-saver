import { render, screen } from "@testing-library/react";
import { decodeQR } from "qr/decode.js";
import { describe, expect, it } from "vitest";
import { ShareQr } from "@/components/qr/share-qr";

/** QR codes are generated locally and contain exactly the share URL, secret included (03 §4.3, AC-2.6 URL part). */

const URL_WITH_SECRET = `http://127.0.0.1:3102/s/AbCdEfGhIjKlMnOp#k=${"Zx9_-".repeat(8)}abc`;

/** Rasterize the rendered SVG path ourselves (jsdom has no canvas) and decode it. */
function decodeRendered(svg: SVGSVGElement): string {
  const modules = Number(svg.getAttribute("viewBox")!.split(" ")[2]);
  const dark = new Set<string>();
  for (const match of svg.querySelector("path")!.getAttribute("d")!.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) dark.add(`${match[1]},${match[2]}`);
  const scale = 4;
  const width = modules * scale;
  const data = new Uint8Array(width * width * 4);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const value = dark.has(`${Math.floor(x / scale)},${Math.floor(y / scale)}`) ? 0 : 255;
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  return decodeQR({ width, height: width, data });
}

describe("ShareQr", () => {
  it("encodes the full share URL, fragment and secret included", () => {
    render(<ShareQr url={URL_WITH_SECRET} />);
    const svg = screen.getByTestId("share-qr") as unknown as SVGSVGElement;
    expect(decodeRendered(svg)).toBe(URL_WITH_SECRET);
  });

  it("is an accessible image drawn locally, with no image URL or third-party request", () => {
    const { container } = render(<ShareQr url={URL_WITH_SECRET} />);
    expect(screen.getByRole("img", { name: "QR code for the share link" })).toBeDefined();
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    // The secret is only inside the drawn modules, never in an attribute.
    expect(container.innerHTML).not.toContain("Zx9_-");
  });
});
