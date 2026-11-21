# Game timeline: what each event means and how it is read from Riot JSON

`parseTimeline` in `src/lib/sources/timeline.ts` turns one game's Riot JSON (match-v4 or match-v5) into the gold difference at every frame and a list of key events, each with its time and the Riot team that got it. Riot's esports JSON does not say everything directly, so several events are defined here.

## Rules

- Gold difference: total gold of team 100 minus team 200 at each frame (one frame per minute, plus the last one at the end of the game).
- First blood: the credited first blood of `./first-blood`, given to the killer's team; an execution by a tower or minions is not one, and there is none when it is unknown.
- Towers and inhibitors: a `BUILDING_KILL` event names in `teamId` the team that lost the building. The other team gets the event, whoever last hit it, minions included.
- Dragons, elder, herald, baron, Atakhan: the killer's team. match-v5 gives it (`killerTeamId`); match-v4 does not, and it is found through the killer's participant (`monsterTeam`). A kill with no champion killer is left out.
- Void grubs taken by the same team within 90 s (`GRUBS_WINDOW_MS`) make one event with a count.
- Ace: all five players of a team dead at once. Riot's esports timelines carry no ace event, so it is computed: each death lasts the base respawn time of the victim's level (`BASE_RESPAWN_S`, the BRW table by champion level 1 to 18, without the extra time added after 15 minutes). This is an underestimate on purpose: an ace is never reported where the five deaths did not overlap. Do not add the time-based increase without checking it against real games.
- `gameDuration` is in seconds, but match-v4 and early match-v5 report milliseconds for some games: `durationSeconds` treats a value above 20 000 as milliseconds.
- A match-v5 JSON may come wrapped as `{ metadata, info }`: `unwrap` reads `info` when it is there, for the stats and the timeline alike.
- One malformed event must not cost the whole timeline: the events of a frame are parsed one by one and an unreadable one is dropped (`Frame.events`), while a wrong shape of the frames themselves still throws.
- `TIMELINE_FORMAT` is part of the cache key of parsed timelines (Vercel Runtime Cache, 30 days). Bump it when the parsed shape or any definition above changes: cached timelines of an older format are then ignored instead of being served for a month.
