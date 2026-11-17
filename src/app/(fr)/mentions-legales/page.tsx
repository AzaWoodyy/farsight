import { pageMetadata } from "../../i18n/metadata";
import { LEGAL } from "../../legal/content";
import { LegalPage } from "../../legal/legal-page";

export const metadata = pageMetadata("fr", "legal", { title: LEGAL.fr.title, description: LEGAL.fr.description });

export default function Legal() {
  return <LegalPage locale="fr" />;
}
