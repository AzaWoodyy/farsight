import { rootMetadata } from "../i18n/metadata";
import { RootShell, VIEWPORT } from "../root-shell";

export const metadata = rootMetadata("en");

export const viewport = VIEWPORT;

export default function EnglishLayout({ children }: LayoutProps<"/en">) {
  return <RootShell locale="en">{children}</RootShell>;
}
