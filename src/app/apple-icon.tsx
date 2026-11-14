import { ImageResponse } from "next/og";
import { Mark } from "./brand/logo";
import { PALETTE } from "./brand/site";

export const size = { width: 180, height: 180 };

export const contentType = "image/png";

/** Home-screen icon: the mark on the dark background (iOS rounds the corners itself). */
export default function AppleIcon() {
  const { background, foreground, muted, accent } = PALETTE.dark;

  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background }}>
      <Mark fg={foreground} accent={accent} lane={muted} size={120} />
    </div>,
    size,
  );
}
