import { ImageResponse } from "next/og";
import { Mark } from "./brand/logo";
import { PALETTE } from "./brand/site";

export const size = { width: 180, height: 180 };

export const contentType = "image/png";

export default function AppleIcon() {
  const { background, foreground, accent } = PALETTE.dark;

  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background }}>
      <Mark fg={foreground} accent={accent} size={120} />
    </div>,
    size,
  );
}
