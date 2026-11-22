# The conversation's test data exists in development only

The conversation page has no automated test, and its layout breaks on what real accounts hold: long names, unbreakable e-mail addresses and URLs, missing fields, non-Latin scripts, a very long thread. `src/app/chat/worst-case.ts` replaces the saved conversations with such values behind `?data=`.

## Rules

- `?data=worst`, `empty`, `one` and `long` (200 messages) are read by `dataMode`, which answers `demo` (the real conversations) unless `NODE_ENV` is `development`. The floating menu that switches between them (`DataToggle`) is rendered under the same condition. A preview or production deployment ignores the parameter.
- A test set is shown as conversations that are not saved (`unsaved`): nothing is written to `farsight_users` and nothing is read from it.
- `worst` also replaces the name shown for the account (`WORST_LOGIN`): the account button is one of the places a long address overflowed.
- The values are made up (`example.com`, an image URL that does not exist on purpose): no real account or conversation is in the file.
- After a change to the conversation's layout, look at `?data=worst` and `?data=long` at phone width: that set is what found the overflows the page had.
