# zod runs jitless in the browser

The site's Content Security Policy does not allow `eval`. zod probes for its JIT compiler by calling `Function("")`; under that CSP the probe fails silently, but the browser still reports it as a CSP violation, which Lighthouse counts against Best Practices. `src/app/zod-client.ts` therefore sets `config({ jitless: true })`.

## Rules

- The client only parses small payloads, so the JIT brings nothing there: turning it off costs no measurable time.
- `src/app/zod-client.ts` must be imported first by every client module that parses with zod, directly or through the AI SDK (today `chat-engine.tsx`, `answer-view.tsx`, `lab/lab-menu.tsx`): the probe runs on the first parse, so the configuration has to be in place before any schema is used. A new client entry point that uses zod needs the same first import.
