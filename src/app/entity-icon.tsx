"use client";

import { useState } from "react";

/**
 * The small image beside a name (a team's logo, a dragon). Decorative (the name is right there), and gone if
 * the image host refuses it. Loaded as is: next/image would spend the Vercel image-optimization quota on 20 px
 * icons.
 *
 * `tone`: the image is nearly black or nearly white all over. On a page of the same tone it would disappear,
 * so it gets a contrasting plate there, and only there (globals.css, `.entity-icon`).
 */
export function EntityIcon({ src, size = 20, tone }: { src: string; size?: number; tone?: "dark" | "light" }) {
  const [failed, setFailed] = useState(false);

  if (failed) return null;

  return (
    // oxlint-disable-next-line nextjs/no-img-element
    <img src={src} alt="" width={size} height={size} style={{ width: size, height: size }} data-tone={tone} className="entity-icon shrink-0 object-contain" loading="lazy" onError={() => setFailed(true)} />
  );
}
