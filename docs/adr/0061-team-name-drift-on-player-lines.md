# A team can be written two ways inside one game

Leaguepedia sometimes writes a team one way on the game and another way on its player lines, which gives two rows in `teams` for one side of a game. Tools must take a player's team side and opponent from the side of the game, not from equality of team ids.

## Rules

- Example: an LCK CL 2025 game has the blue team "Dplus KIA Challengers" on the game and "Dplus Kia Challengers" on its five player lines, against KT Rolster Challengers on red (`seededCaseDrift` in `scripts/rankings.test.ts`).
- `player_recent_games` and `game_records` find a player's opponent from the side: Rahel's opponent is "KT Rolster Challengers", not his own team under its other spelling.
- `team_leaderboard` counts the player lines of a team written another way for its side: "Dplus KIA Challengers" still gets its 10 kills and 5 champions for that game.
