# Player versus view: both players always face each other

The versus view (`src/app/versus.tsx`) compares two players. Two details of its layout answer problems that are not visible in the code.

## Rules

- `bothPlayers`: a player without any game in the scope has no line in the tool's `global` table. The view gives that player an empty line (0 games, every other figure null, shown as n/d) in the right order, so that the two still stand face to face and the absence reads as an absence, instead of a one-line table about the other player alone. Do not drop the synthetic row or filter it out upstream.
- `Games`: the horizontal scroller around the games table is `relative`. The table's last header is an `sr-only` "source" label, which is absolutely positioned; without a positioned scroller it is laid out against the page and widens it, which gives a horizontal scroll on phones.
