import type { MetadataRoute } from "next";

/** Share, invite, code and room routes must never be indexed (03 §4.9). */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", disallow: ["/api/", "/s/", "/j/", "/c", "/rooms/"] },
  };
}
