import { pageMetadata } from "../../i18n/metadata";
import { LEGAL } from "../../legal/content";
import { LegalPage } from "../../legal/legal-page";

export const metadata = pageMetadata("en", "legal", { title: LEGAL.en.title, description: LEGAL.en.description });

export default function Legal() {
  return <LegalPage locale="en" />;
}
