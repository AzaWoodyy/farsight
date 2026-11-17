"use client";

import { useState } from "react";

/**
 * The small image beside a name in a table. Decorative (the name is right there), and gone if the image host
 * refuses it. Loaded as is: next/image would spend the Vercel image-optimization quota on 20 px icons.
 */
export function EntityIcon({ src, size = 20 }: { src: string; size?: number }) {
  const [failed, setFailed] = useState(false);

  if (failed) return null;

  return (
    // oxlint-disable-next-line nextjs/no-img-element
    <img src={src} alt="" width={size} height={size} style={{ width: size, height: size }} className="shrink-0 object-contain" loading="lazy" onError={() => setFailed(true)} />
  );
}
