# The split of the question reaches every tool call, or the answer says it was not applied

A split the question names ("LEC Spring 2024") was dropped on the way to a tool four times (#21 twice, #30, #158): each route builder had to remember `split: e.split`, and a tool without a split argument answered on the whole season without a word. Thirteen tools still had no split argument.

## Rules

- **One place applies it.** `inQuestionSplit` (`src/lib/agent/query.ts`) runs on every typed call, from the rules router and from the model router, before `bindTool`. A route builder that forgets the split cannot drop it.
- **A tool takes a split when its schema has a `split` field** (`takesSplit`, read from the registry): no list to keep in step. Such a tool gets the split of the question unless the call already names one.
- **A tool without a split field answers on the whole season and says so** (`route.splitNotApplied`, in both languages). Giving one of those tools a real split filter removes the note for it, with no other change.
