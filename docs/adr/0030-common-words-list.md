# Everyday words that are also player handles

Some player handles are everyday words ("Paris", "Life", "Knight"). `src/lib/agent/common-words.ts` holds the list the entity detection uses to tell them apart: a handle found in `COMMON_WORDS` only names a player in a question that is about esport (`detectMentions` in `src/lib/agent/understand.ts`).

## Rules

- Source and licence: the 5 000 most frequent words of French and of English in the OpenSubtitles 2018 frequency lists (hermitdave/FrequencyWords, CC BY-SA 4.0). The attribution must stay with the file.
- The words are stored as normalized aliases: accents stripped, as the alias tables compare them.
- Only words of four letters or more are kept, because shorter handles are always treated as ambiguous anyway.
- First names and cities are in the list too ("paris", "peter"): subtitles are full of them, and they are exactly the handles that collide. Do not prune them as noise.
