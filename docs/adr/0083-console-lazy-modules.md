# The chat and the answer views load after the home page, without next/dynamic

The chat engine (AI SDK, zod) and the answer views (tables, comparison, scoreboard...) weigh more than the home page itself, so they are kept out of its first load and fetched by hand in `src/app/agent-console.tsx` (`loadModules`, the `modules` state).

## Rules

- `./chat-engine` and `./answer-view` are only ever imported dynamically (`import()` in `loadModules`; `import type` elsewhere). A static import from the console or from a component of the home page puts them back in the first load. `src/app/answer-view.tsx` holds the answer and everything it can show for that reason.
- They load once the page is idle (`requestIdleCallback` after `load`), or as soon as the visitor focuses the question field or asks a question, whichever comes first (`preload`).
- The loaded modules are kept in React state rather than behind `next/dynamic` or `React.lazy`: with a Suspense boundary, each answer was held back about 300 ms after the stream had ended. Do not replace the state with a lazy component.
- Both modules load in one `Promise.all`, so an answer always has its views once the chat exists.
