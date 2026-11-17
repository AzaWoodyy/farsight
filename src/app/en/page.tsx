import { HomePage } from "../home-page";
import { pageMetadata } from "../i18n/metadata";

export const metadata = pageMetadata("en", "home");

export default function Home() {
  return <HomePage locale="en" />;
}
