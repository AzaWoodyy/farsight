# Running generated SQL: one deadline, bounded slots, server-side cuts, dropped connections

Generated SQL is the only code path that runs text the model wrote. `executeGeneratedQuery` in `src/lib/db/generated-query.ts` runs it in a `READ ONLY` transaction as `farsight_sql` (which reads the `v_*` views only) under a 4-second `statement_timeout`, so that the database itself refuses a write, a base table or a long query, including what the static guard cannot see. The details below keep one slow or hostile query from holding the instance's small pool.

## Rules

- `MAX_SQL_CHILDREN = 3` generated queries run at once per instance: each holds a pooled connection for up to `SQL_TIMEOUT_MS`, and the pool (`createPool`, `max = 5`) must keep connections for the typed tools.
- Waiting for a slot, waiting for a connection and running the statement share one `SQL_TIMEOUT_MS` deadline: the `statement_timeout` is set to what remains, not to 4 seconds again.
- `MIN_RUN_MS = 100`: when less than this is left once a slot is free, the query is not started and `SqlTimeoutError` is thrown; the deadline has in effect passed.
- In `acquire` / `release`, a released slot is handed straight to the next waiter without decrementing `running`: `running` only goes down when nobody waits. Decrementing and re-incrementing would let a new caller take the slot ahead of the queue.
- `bounded()` wraps the query so that the server returns each row as JSON text with a running byte count and stops past `MAX_RESULT_BYTES` (and `LIMIT maxRows`): an oversized result is never sent to the function. The last line returned has a NULL row and a total over the cap, which is how the caller knows the cut happened.
- On abort, the connection is destroyed (`client.release(true)`) rather than cancelled: Postgres cancels the statement when it next writes to the closed socket, and the statement timeout bounds it in any case.
- `signal.throwIfAborted()` is called again after `acquire`: an abort that fired while waiting for a slot happened before `connectBy` registered its listener and would otherwise be missed.
- Errors returned to the agent carry only the Postgres message, cut to 2 000 characters, never the error object: it can hold the connection's details (host, user).
- A connection whose transaction failed is released as broken and dropped instead of being rolled back and reused.
