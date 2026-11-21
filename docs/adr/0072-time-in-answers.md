# Years and dates in questions and answers

The period a question may ask about and the dates an answer shows follow the data, not the visitor's machine.

## Rules

- Leaguepedia's competition history begins in 2011: `YEAR_MIN` in `src/lib/domain/years.ts` is that year, and `periodProblem` refuses an earlier one. The upper bound is not a constant: it is the year of the question's clock (`now`), so a year in the future is refused whenever the question is asked.
- Dates are always formatted in UTC (`dateFormat` in `src/lib/locale.ts` forces `timeZone: "UTC"`): a game has one date, whoever reads it. Without it the same game would show a different day depending on where the server or the reader is.
