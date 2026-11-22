"use client";

import { useState } from "react";
import { isMissingWikiImage, loadedMissingWikiImage } from "./missing-wiki-image";

export function EntityIcon({ src, size = 20, tone }: { src: string; size?: number; tone?: "dark" | "light" }) {
  const [failed, setFailed] = useState(false);

  if (failed) return null;

  return (
    // oxlint-disable-next-line nextjs/no-img-element
    <img
      ref={(img) => {
        if (loadedMissingWikiImage(img)) setFailed(true);
      }}
      src={src}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
      data-tone={tone}
      className="entity-icon shrink-0 object-contain"
      loading="lazy"
      onLoad={(e) => {
        if (isMissingWikiImage(e.currentTarget)) setFailed(true);
      }}
      onError={() => setFailed(true)}
    />
  );
}
