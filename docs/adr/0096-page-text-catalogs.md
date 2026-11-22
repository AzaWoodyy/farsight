# Text catalogs of the pages, and the texts that stay in English

The texts of the console and of the answer views live in `src/app/i18n/ui.ts`, typed so that `en` must have every key of `fr`. The texts of the conversation page (`/chat`) have their own catalog, `src/app/i18n/chat.ts`, typed the same way, so the home page does not ship them. Two conventions are not visible from the types.

## Rules

- A text with a number or a name in it is a function, not a template filled by the caller, so each language keeps its own word order and plural (French marks the plural from two, English for everything but one).
- What the agent itself writes (titles, summaries, notes, table headers, follow-ups) is not in this catalog: it comes with the answer, already in the language of the question's page.
- Riot's boilerplate for third-party products (`RIOT_BOILERPLATE`, `src/app/site-footer.tsx`) is quoted word for word and stays in English in every language: developer.riotgames.com/policies/general asks for it "in a location that is readily visible to players". On a page in another language it comes after a summary in that language; the footer gives the notice in one sentence and the legal page (`RiotNotices`, `src/app/legal/content.tsx`) the full text, in a `lang="en"` block. Do not translate it.
- In the conversation, the titles and cells of a result card and the agent's sentences come with the answer as well, and are not in `chat.ts` ([0120](0120-chat-result-cards.md)). Clerk's own screens are translated by Clerk's catalog, reduced to what the page shows ([0121](0121-conversation-accounts-and-configuration.md)).
