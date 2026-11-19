import type { MetadataRoute } from "next";
import { SITE } from "./brand/site";

export default function robots(): MetadataRoute.Robots {
  return {
    // `/api/card` is the image of a link's preview: a chat service that obeys robots.txt (X) must be able to fetch it.
    rules: { userAgent: "*", allow: ["/", "/api/card"], disallow: "/api/" },
    sitemap: `${SITE.url}/sitemap.xml`,
  };
}
