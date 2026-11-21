# Security headers are static and set in next.config.ts

Every response carries the same headers, written in `headers()` of `next.config.ts`. The pages are prerendered, so the policy cannot depend on the request, and each value below was chosen against a more obvious one.

## Rules

- The Content-Security-Policy allows `'unsafe-inline'` scripts (`script-src 'self' 'unsafe-inline'`): static rendering needs Next's inline bootstrap scripts, and a nonce-based policy would force every page to render per request. The policy must also stay compatible with BotID, whose challenge script is proxied through same-origin rewrites (`withBotId`), so `'self'` covers it; do not tighten `script-src` or `connect-src` without checking both.
- `Strict-Transport-Security` is set by hand to `max-age=63072000; includeSubDomains`: Vercel sends HSTS without `includeSubDomains`, and every subdomain is served by Vercel over HTTPS, so they are covered too. There is no `preload`: the browsers' preload lists are a commitment that takes months to undo.
- `Cross-Origin-Opener-Policy: same-origin`: the site opens no window it talks to, so outgoing links must not keep a handle on this one either.
- `Referrer-Policy: strict-origin`, the origin alone even for requests to this site: the address of an answer holds its question (`?q=`), and the analytics scripts and their beacons are same-origin requests that would carry it as their referrer. Do not relax it to `strict-origin-when-cross-origin`.
