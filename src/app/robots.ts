import type { MetadataRoute } from "next";
import { SITE } from "./brand/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: ["/", "/api/card"], disallow: "/api/" },
    sitemap: `${SITE.url}/sitemap.xml`,
  };
}
