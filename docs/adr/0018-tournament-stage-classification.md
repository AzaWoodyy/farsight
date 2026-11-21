# A tournament's stage is read from its Leaguepedia page name

`classifyTournament` (`scripts/data/scope.ts`) decides what a tournament page is from its page name, not from Cargo. The Cargo `IsQualifier` flag is unreliable (the Worlds Play-In is flagged as a qualifier, early regional finals are not), and regional qualifiers share the `World Championship` league label, so the page name is the source of truth.

## Rules

- `event`: an international event page whose games live on sub-stages (Worlds and MSI from 2017); it holds the final standings only. The classifier never returns it: the derivation (`scripts/data/derive.ts`) sets it on a page that another page names as its `eventPage`.
- `main_event`, `play_in`: stages of the international event itself, and of European Masters / EMEA Masters, which split into Play-In and Main Event although they are not international leagues (hence the `Main Event` test in the domestic branch).
- `qualifier`: regional finals, qualifying series, promotion, LCQ. Anything else under an international league label is not the event itself and is a qualifier too.
- `season`, `playoffs`: domestic league splits.
- A showmatch page is not competitive and is not classified (null).
