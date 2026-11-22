# Accounts exist on the conversation paths only, and the conversation opens by its configuration

The conversation costs model calls and stores what a person wrote, so it needs accounts; the rest of the site needs none and keeps none. Clerk is therefore loaded on `/chat`, `/en/chat` and their API routes only, and the conversation is open when its configuration is there, whatever the environment is called.

This is the one exception to "no proxy, cookie or `Accept-Language` redirect" (AGENTS.md, Languages): a proxy runs, and Clerk sets its session cookies, on those paths and nowhere else. The language is still chosen by the URL alone.

## Rules

- `chatConfigured` (`src/lib/auth/chat-config.ts`) is true when `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `THREADS_DATABASE_URL` are all set. Nothing reads `VERCEL_ENV` or `NODE_ENV` to decide: the same build is closed without the keys and open with them.
- Without the configuration the site builds and answers with no Clerk key at all (CI, `bun run pages:check`, a local run): the two pages answer 200 and say the conversation is not open (`SHELL[locale].chat.closed`), and `/api/chat`, `/api/threads` and `/api/clerk/webhook` answer 404.
- `src/proxy.ts` matches `/chat`, `/en/chat`, `/api/chat` and `/api/threads/:path*` and nothing else. It runs `clerkMiddleware()` when the conversation is configured and lets the request through otherwise: Clerk's middleware cannot run without its keys, and the closed page must still answer.
- The webhook route is not in the matcher: Clerk calls it without a session, and the route checks the signature itself.
- `ClerkProvider` is mounted by `ChatGate` (`src/app/chat/chat-gate.tsx`), inside the conversation pages: no layout mounts it, so no other page loads Clerk's script or sets its cookies.
- The link to the conversation in the home page's header is rendered only when `chatConfigured()` is true. The home pages are static, so the link follows the configuration of the build.
- Both pages are `noindex` and are absent from the sitemap.
- The page reads the session on the server and never the database while it renders: the saved conversations are fetched by the browser from `/api/threads`. While the session is read, the page shows an opening state (`ChatLoading`) instead of an empty screen.
- The sign-in button stays disabled, with a waiting label, until Clerk's script is ready: a click before that was lost.
- Clerk's interface takes the site's colour variables, its monospaced font and square corners (`APPEARANCE`), and is in the language of the page. The French texts are reduced to what each screen shows (`src/app/chat/clerk-french.ts`: sign-in and sign-up at the door, the account button and profile in the room); the English page ships no translation.
- The security headers of these two pages allow what Clerk loads ([0105](0105-security-headers.md)).
