import { HOW } from "../../how/content";
import { HowPage } from "../../how/how-page";
import { pageMetadata } from "../../i18n/metadata";

export const metadata = pageMetadata("en", "how", { title: HOW.en.title, description: HOW.en.description });

export default function How() {
  return <HowPage locale="en" />;
}
