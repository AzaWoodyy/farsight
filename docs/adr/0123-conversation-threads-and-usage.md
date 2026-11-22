# Saved conversations and usage live in their own schema, under their own role

The esports data is read-only for the app and replaced as a whole by each load. What accounts write (their conversations, their daily message count) is kept apart from it: schema `farsight_users`, role `farsight_threads`, connection string `THREADS_DATABASE_URL`, all created by `db/threads.sql` and read and written by `src/lib/threads/store.ts`.

## Rules

- `db:load` swaps the schema `farsight` and never touches `farsight_users`: a daily data update cannot lose a conversation. `db/threads.sql` is run by hand and is not a migration of `db/migrations`, which describe the schema the load rebuilds.
- `farsight_app` stays read-only and has no right on `farsight_users`; `farsight_threads` has no right on the esports data and its `search_path` is `farsight_users` alone. Neither connection string can do the other's work.
- A conversation is one row of `threads`, its messages as one JSON document. Its id is a UUID made by the browser at the first message, the same one sent as `conversationId` with each turn.
- The browser saves the whole conversation after each finished turn (`PUT /api/threads/<id>`) and lists them once per visit (`GET /api/threads`). The server never rebuilds a conversation from the turns it streamed.
- A write names its owner in the statement itself: the upsert updates a row only when its `user_id` is the caller's, and a conversation of another account answers 404, as if it did not exist.
- Limits of a save: `ThreadMessages` (200 messages, 60 parts each) and `THREAD_MAX_BYTES` (600 000 bytes, answered 413). The title is the start of the first message of the visitor (`TITLE_MAX_LENGTH`).
- An account keeps its `KEPT_THREADS` (30) most recent conversations: saving a 31st deletes the oldest. Apart from that, a conversation is kept until its owner deletes it. A deletion in the page can be undone for a moment, which saves the conversation again.
- An account sends at most `DAILY_MESSAGES` (100) messages per UTC day. `spendMessage` counts in one statement (an upsert that only increments under the limit), so two requests at once cannot both take the last message; it runs after the request is validated and before the model is called. Past the limit `/api/chat` answers 429 with `daily_limit`, and the page says so in its language.
- The count is by account, in the database, where the per-IP counter of the code is per instance ([0106](0106-instance-rate-limit.md)). Usage rows older than `USAGE_KEPT_DAYS` (7) are deleted by about one message in fifty (`CLEANUP_SHARE`): no scheduled job exists for it.
- A deleted account takes its conversations and its usage with it: Clerk's `user.deleted` webhook reaches `/api/clerk/webhook`, which checks the signature (`CLERK_WEBHOOK_SIGNING_SECRET`) and calls `forgetUser`. Without the secret the route answers 404; a bad signature answers 400.
- The store has its own small pool (3 connections), handed to `attachDatabasePool` on Vercel like the data pool.
- No personal data is stored beside the conversation: a row holds Clerk's user id, never an e-mail address or a name.
