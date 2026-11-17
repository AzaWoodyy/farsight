import { rootMetadata } from "../i18n/metadata";
import { RootShell, VIEWPORT } from "../root-shell";

export const metadata = rootMetadata("fr");

export const viewport = VIEWPORT;

export default function FrenchLayout({ children }: LayoutProps<"/">) {
  return <RootShell locale="fr">{children}</RootShell>;
}
