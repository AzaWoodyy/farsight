import { notFound } from "next/navigation";

/**
 * Any address no page answers. Each language has its own root layout, so an unmatched URL has no layout to
 * draw a 404 in: this route sends it to the not-found page of its language.
 */
export default function Unmatched() {
  notFound();
}
