import { shareCard } from "@/lib/agent/share";
import { rateLimited } from "@/lib/http/request-policy";
import { DEFAULT_LOCALE, LOCALES } from "@/lib/locale";
import { answerCard, CARD_SIZE } from "../../brand/answer-card";
import { shareCard as siteCard } from "../../brand/share-card";
import { questionIn } from "../../question-link";

export async function GET(req: Request) {
  if (rateLimited(req, "card")) return new Response("too many requests", { status: 429, headers: { "Retry-After": "600" } });

  const url = new URL(req.url);
  const locale = LOCALES.find((l) => l === url.searchParams.get("l")) ?? DEFAULT_LOCALE;
  const question = questionIn(url.search);
  const canonical = `?${new URLSearchParams(question ? { l: locale, q: question } : { l: locale })}`;

  if (url.search !== canonical) return Response.redirect(new URL(`/api/card${canonical}`, url), 308);

  const card = question ? await shareCard(question, locale) : null;
  const image = await (card ? answerCard(card, locale) : siteCard(locale, CARD_SIZE));

  image.headers.set("Cache-Control", "public, max-age=300, s-maxage=300");

  return image;
}
