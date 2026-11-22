# Security headers are static and set in next.config.ts

Every response carries the same headers, written in `headers()` of `next.config.ts`, with one wider Content-Security-Policy for the two conversation pages. The pages are prerendered, so the policy cannot depend on the request, and each value below was chosen against a more obvious one.

## Rules

- The Content-Security-Policy allows `'unsafe-inline'` scripts (`script-src 'self' 'unsafe-inline'`): static rendering needs Next's inline bootstrap scripts, and a nonce-based policy would force every page to render per request. The policy must also stay compatible with BotID, whose challenge script is proxied through same-origin rewrites (`withBotId`), so `'self'` covers it; do not tighten `script-src` or `connect-src` without checking both.
- `Strict-Transport-Security` is set by hand to `max-age=63072000; includeSubDomains`: Vercel sends HSTS without `includeSubDomains`, and every subdomain is served by Vercel over HTTPS, so they are covered too. There is no `preload`: the browsers' preload lists are a commitment that takes months to undo.
- `Cross-Origin-Opener-Policy: same-origin`: the site opens no window it talks to, so outgoing links must not keep a handle on this one either.
- `Referrer-Policy: strict-origin`, the origin alone even for requests to this site: the address of an answer holds its question (`?q=`), and the analytics scripts and their beacons are same-origin requests that would carry it as their referrer. Do not relax it to `strict-origin-when-cross-origin`.
- `/chat` and `/en/chat` get their own Content-Security-Policy (`chatCsp`), the site's policy plus what Clerk loads: its script and API on the instance's host, its bot protection (`cdn.protect.clerk.com`, `*.protect.clerk.com`, the Cloudflare challenge in `script-src` and `frame-src`), its telemetry and the account images of `img.clerk.com`. No other page gets these origins: only those two pages load Clerk ([0121](0121-conversation-accounts-and-configuration.md)). Without them Clerk's protection script and its connections were blocked and nobody could sign in.
- The Clerk host is read from the publishable key, which encodes it (`clerkHost`, `src/lib/auth/chat-config.ts`): a development and a production instance have different hosts, and a host written in the policy would be wrong for one of them. Without a key, or with one that does not decode to a host name, the policy names no Clerk host.
- The conversation's policy is still static: the key is read when `next.config.ts` is evaluated, so changing the Clerk instance needs a new build.
- The frame an agent's view is drawn in is a `srcdoc` document: it inherits the policy of the conversation page and needs no source of its own ([0119](0119-agent-html-views-sandboxed-frame.md)).
