# LLM calls: no reasoning budget, prompts in one language, technical reasons kept in the trace

LLM calls go through OpenRouter with a small output budget (`LLM_CALL` in `src/lib/agent/llm.ts`), and their prompts and the visitor-facing fallbacks live in the typed catalogs of `src/lib/agent/messages.ts`.

## Rules

- The model is created with `reasoning: { effort: "none" }` (`configured()` in `llm.ts`). Reasoning tokens count against `maxOutputTokens`: with the default effort they used most of the 600-token budget and cut the JSON answers short. Raising the effort means raising the budget with it.
- The summary prompt gives the model its facts as JSON under a key named in the language of the prompt (`factsKey`: `faits` in French), like the instructions around it, so the whole prompt is in the language the answer must be written in.
- When nothing can answer (`searchGaveNothing`, `cannotAnswerYet`), the visitor reads a sentence in their own words, with a suggestion to rephrase. The technical reason (no typed tool covers the question, no model available) stays in the trace and must not be added to that text.
