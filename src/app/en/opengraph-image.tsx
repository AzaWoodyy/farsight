import { shareAlt, shareCard } from "../brand/share-card";

export const alt = shareAlt("en");

export const size = { width: 1200, height: 630 };

export const contentType = "image/png";

export default function OpenGraphImage() {
  return shareCard("en", size);
}
