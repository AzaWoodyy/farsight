"use client";

import { useState } from "react";
import type { PlayerPhoto } from "@/lib/agent/types";

export function PlayerAvatar({ name, photo, size }: { name: string; photo: PlayerPhoto | null | undefined; size: number }) {
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size };

  if (!photo || failed)
    return (
      <span aria-hidden="true" className="flex shrink-0 items-center justify-center border border-line text-muted select-none" style={{ ...box, fontSize: Math.round(size / 3) }}>
        {name.replace(/\s*\(.*?\)\s*$/, "").slice(0, 2)}
      </span>
    );

  return (
    // oxlint-disable-next-line nextjs/no-img-element
    <img
      src={photo.url}
      alt=""
      title={`${name} · photo${photo.year == null ? "" : ` ${photo.year}`} (Leaguepedia)`}
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="strict-origin"
      onError={() => setFailed(true)}
      className="shrink-0 border border-line bg-line/40 object-cover object-top"
      style={box}
    />
  );
}
