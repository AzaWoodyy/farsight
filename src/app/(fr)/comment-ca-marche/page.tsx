import { HOW } from "../../how/content";
import { HowPage } from "../../how/how-page";
import { pageMetadata } from "../../i18n/metadata";

export const metadata = pageMetadata("fr", "how", { title: HOW.fr.title, description: HOW.fr.description });

export default function How() {
  return <HowPage locale="fr" />;
}
