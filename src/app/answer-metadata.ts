import type { Metadata } from "next";
import { connection } from "next/server";
import { z } from "zod";
import { shareCard } from "@/lib/agent/share";
import { CARD_SIZE } from "./brand/answer-card";
import { SITE } from "./brand/site";
import { type Locale, OG_LOCALE, PATHS } from "./i18n/locales";
import { pageMetadata } from "./i18n/metadata";
import { questionIn, questionPath } from "./question-link";

const Search = z.object({ q: z.string() });

/**
 * On a preview deployment the image is the deployment's own, so a link preview can be checked before production;
 * anywhere else its address resolves against `metadataBase`, the public site.
 */
const cardOrigin = () => (process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");

/**
 * Metadata of a home page opened on a question (`?q=`): the Open Graph and Twitter title, sentence and image
 * (`/api/card`) of its answer, for the preview a chat draws of the link. The home page's own metadata when the rules do not
 * answer the question. The canonical stays the home page either way: an answer is not a page to index.
 */
export async function answerMetadata(locale: Locale, search: Record<string, string | string[] | undefined>): Promise<Metadata> {
  const home = pageMetadata(locale, "home");
  // A repeated `q` is nobody's question; one `q` goes through the same strict reading as in the browser.
  const q = Search.safeParse(search).data?.q;
  const question = q == null ? null : questionIn(`?${new URLSearchParams({ q })}`);

  // The answer reads the database over the network and the clock: rendered per request, never while prerendering.
  if (question) await connection();

  const card = question ? await shareCard(question, locale) : null;

  if (!question || !card) return home;

  const text = { title: card.title, description: card.line };
  const image = { url: `${cardOrigin()}/api/card?${new URLSearchParams({ l: locale, q: question })}`, ...CARD_SIZE, alt: card.title };

  // The page's own <title> stays the home page's: the console asks other questions without leaving the page,
  // and a tab named after the first one would lie about the next.
  return {
    ...home,
    openGraph: { type: "website", locale: OG_LOCALE[locale], siteName: SITE.name, ...text, url: questionPath(PATHS.home[locale], question), images: [image] },
    twitter: { card: "summary_large_image", ...text, images: [image] },
  };
}
