# The in-code rate limit: per instance, bounded, second to the firewall

`rateLimited` in `src/lib/http/request-policy.ts` counts requests per IP and per 10-minute window in a `Map` held by one function instance. The limit shared by all instances is the Vercel firewall rule (docs/deploy.md); this one supplements it and only has to stay cheap and bounded.

## Rules

- `RATE_LIMITS.ask` (30) mirrors the firewall rule `ask rate limit` of docs/deploy.md: change both together.
- `card` (the answer image) and `link` (the pages `/q` and `/en/q` a link to an answer opens) allow 300: the link previews of many visitors come from the few addresses of one chat service, so a limit sized for one person would cut the previews of everyone.
- Every window has the same length (`WINDOW_MS`), so the insertion order of the `Map` is the expiry order. This is what lets the cleanup of a full table stop at the first live counter instead of scanning 10 000 entries. It holds only because an expired key is deleted before it is set again: re-inserting moves it to the end of the insertion order. Removing that `delete`, or giving routes different windows, breaks the cleanup.
- When the table is full (`MAX_BUCKETS`) and nothing has expired, the oldest counter is evicted, which forgets that address's count. This is accepted: the shared limit is the firewall's job, and this table must only stay bounded.
- `/api/chat` counts on the `ask` counter (`requestPolicy(req, "ask")`): a question and a conversation message from one address share the 30 of a window on an instance. The firewall rule covers `/api/ask` only; what bounds the conversation across instances is the account, invited by hand and capped per day in the database ([0123](0123-conversation-threads-and-usage.md)).
