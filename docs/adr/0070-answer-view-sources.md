# Where the fields of an answer's views come from

The view types of `src/lib/agent/types.ts` are filled by the tools from Leaguepedia's tables, and a few of their fields follow a convention of the source that the type cannot show.

## Rules

- Sides are Leaguepedia's: blue is `Team1`, red is `Team2`, in `TimelineView` and `SeriesGame` (and the scoreboard). Do not derive the side from the Riot JSON's team ids in one place and from the scoreboard in another.
- `PlayerProfile` (teams by games played, most played role first) is read from the database for the question's scope, never from the rows of a generated SQL query: a text-to-SQL answer has no reliable team or role column.
- `GameScoreboard` comes from Leaguepedia's scoreboard tables, which cover every league, the LPL included. Only the Riot timeline is missing for the LPL, so an end-of-game recap must not be refused on the grounds that in-game data is absent.
- `TeamSeries.winner` is the winner read from the score, except for a series known from the match schedule whose recorded winner disagrees with its score: then the schedule's own winner is kept. It is null for a draw.
