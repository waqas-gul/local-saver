import { describe, expect, it } from "vitest";
import { cleanLabel, generateDeviceLabel, platformFromUserAgent, userAgentFamily } from "@/lib/server/devices/labels";

const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  android:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
  ipad: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1",
};

describe("device labels", () => {
  it("generates a friendly two-word label within 40 characters", () => {
    const label = generateDeviceLabel(() => 0);
    expect(label).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(label.length).toBeLessThanOrEqual(40);
    expect(generateDeviceLabel(() => 0.999)).not.toBe(label);
  });

  it("derives a coarse platform from the user agent", () => {
    expect(platformFromUserAgent(UA.iphone)).toBe("iPhone · Safari");
    expect(platformFromUserAgent(UA.android)).toBe("Android · Chrome");
    expect(platformFromUserAgent(UA.windowsEdge)).toBe("Windows · Edge");
    expect(platformFromUserAgent(UA.macSafari)).toBe("Mac · Safari");
    expect(platformFromUserAgent(UA.linuxFirefox)).toBe("Linux · Firefox");
    expect(platformFromUserAgent(UA.ipad)).toBe("iPad · Chrome");
    expect(platformFromUserAgent(null)).toBe("");
    expect(platformFromUserAgent("x".repeat(1000)).length).toBeLessThanOrEqual(60);
  });

  it("cleans user-chosen labels: invisible and bidi characters, whitespace, 40 characters", () => {
    expect(cleanLabel("  Kitchen‮   Laptop ​ ")).toBe("Kitchen Laptop");
    expect(cleanLabel("a".repeat(60))).toHaveLength(40);
    expect(cleanLabel(" ‮ ")).toBe("");
    expect(cleanLabel("line\nbreak")).toBe("line break");
  });

  it("reduces the user agent to a browser family for the download log", () => {
    expect(userAgentFamily(UA.windowsEdge)).toBe("Edge");
    expect(userAgentFamily(UA.linuxFirefox)).toBe("Firefox");
    expect(userAgentFamily("curl/8.0")).toBe("Other");
  });
});
