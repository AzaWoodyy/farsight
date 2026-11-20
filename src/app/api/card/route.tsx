import { shareCard } from "@/lib/agent/share";
import { rateLimited } from "@/lib/http/request-policy";
import { DEFAULT_LOCALE, LOCALES } from "@/lib/locale";
import { answerCard, CARD_SIZE } from "../../brand/answer-card";
import { shareCard as siteCard } from "../../brand/share-card";
import { questionIn } from "../../question-link";

/**
 * The image of a link to an answer: `GET /api/card?l=<language>&q=<question>`, named by the metadata of that
 * link (answer-metadata). Chat services ask for it, so no BotID here: the answer is computed by the rules
 * alone, never by the model, and a question they do not answer gets the site's own card.
 */
export async function GET(req: Request) {
  if (rateLimited(req, "card")) return new Response("too many requests", { status: 429, headers: { "Retry-After": "600" } });

  const url = new URL(req.url);
  const locale = LOCALES.find((l) => l === url.searchParams.get("l")) ?? DEFAULT_LOCALE;
  const question = questionIn(url.search);
  const card = question ? await shareCard(question, locale) : null;
  const image = await (card ? answerCard(card, locale) : siteCard(locale, CARD_SIZE));

  // An answer changes with the database, reloaded without a deployment: kept as long as the app's own caches.
  image.headers.set("Cache-Control", "public, max-age=300, s-maxage=300");

  return image;
}
