import type { Metadata } from "next";
import { headers } from "next/headers";
import { connection } from "next/server";
import { z } from "zod";
import { shareCard } from "@/lib/agent/share";
import { rateLimited } from "@/lib/http/request-policy";
import { CARD_SIZE } from "./brand/answer-card";
import { SITE } from "./brand/site";
import { type Locale, OG_LOCALE, PATHS } from "./i18n/locales";
import { pageMetadata } from "./i18n/metadata";
import { questionIn, questionPath } from "./question-link";

const Search = z.object({ q: z.string() });

const cardOrigin = () => (process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");

export async function answerMetadata(locale: Locale, search: Record<string, string | string[] | undefined>): Promise<Metadata> {
  const home = pageMetadata(locale, "home");
  const q = Search.safeParse(search).data?.q;
  const question = q == null ? null : questionIn(`?${new URLSearchParams({ q })}`);

  if (!question) return home;

  await connection();

  if (rateLimited(new Request("https://link.invalid/", { headers: await headers() }), "link")) return home;

  const card = await shareCard(question, locale);

  if (!card) return home;

  const text = { title: card.title, description: card.line };
  const image = { url: `${cardOrigin()}/api/card?${new URLSearchParams({ l: locale, q: question })}`, ...CARD_SIZE, alt: card.title };

  return {
    ...home,
    openGraph: { type: "website", locale: OG_LOCALE[locale], siteName: SITE.name, ...text, url: questionPath(PATHS.home[locale], question), images: [image] },
    twitter: { card: "summary_large_image", ...text, images: [image] },
  };
}
