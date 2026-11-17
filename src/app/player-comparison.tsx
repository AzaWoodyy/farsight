import type { ComparedPlayer, ComparedStat, Comparison } from "@/lib/comparison";
import { formatStat, rowWinner } from "@/lib/comparison";

/**
 * Two players face to face: one row per stat, mirrored bars from a central label, the better value in the
 * accent color. Derived figures (winrate, KDA) are marked as computed by the page.
 */
export function PlayerComparison({ comparison }: { comparison: Comparison }) {
  return (
    <div className="mt-4">
      <FaceOff c={comparison} />
      <ComparisonNote c={comparison} />
    </div>
  );
}

/** What the page computed itself, and where the teams and roles come from. */
export function ComparisonNote({ c }: { c: Comparison }) {
  return (
    <p className="mt-2 text-[11px] text-muted">
      <span aria-hidden>*</span> calculé par la page à partir des colonnes renvoyées
      {c.players.some((p) => p.profile) ? " · équipes et rôle lus dans la base, sur la compétition et la période de la question" : ""}
    </p>
  );
}

const Label = ({ s }: { s: ComparedStat }) => (
  <>
    {s.label}
    {s.derived && (
      <span aria-label=" (calculé)" className="text-muted">
        *
      </span>
    )}
  </>
);

/** Text and weight of a value: the better one in the accent color. */
const tone = (s: ComparedStat, i: 0 | 1) => {
  const w = rowWinner(s);

  return w === i ? "text-accent font-semibold" : w == null ? "" : "text-muted";
};

/** Share of the row's largest absolute value, for bar lengths. */
function share(s: ComparedStat, i: 0 | 1): number {
  const max = Math.max(...s.values.map((v) => Math.abs(v ?? 0)));
  const v = s.values[i];

  return v == null || max === 0 ? 0 : Math.abs(v) / max;
}

function Who({ p, align }: { p: ComparedPlayer; align: "left" | "right" }) {
  return (
    <div className={`min-w-0 ${align === "right" ? "text-right" : ""}`}>
      <div className="truncate text-sm font-semibold" translate="no">
        {p.name}
      </div>
      {p.profile && (
        <div className="truncate text-[11px] text-muted">
          {[p.profile.role, p.profile.teams.join(", ")].filter(Boolean).join(" · ")}
        </div>
      )}
    </div>
  );
}

/** `focus`: key of the statistic the question names, set apart from the rest. */
export function FaceOff({ c, focus = null }: { c: Comparison; focus?: string | null }) {
  const [a, b] = c.players;

  return (
    <div className="border border-line">
      <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3 border-b border-line px-3 py-2">
        <Who p={a} align="right" />
        <span className="pb-0.5 text-xs text-muted">vs</span>
        <Who p={b} align="left" />
      </div>
      <ul className="px-3 py-2 text-xs">
        {c.stats.map((s) => (
          <li
            key={s.key}
            className={`grid grid-cols-[1fr_7.5rem_1fr] items-center gap-3 py-1 sm:grid-cols-[1fr_9rem_1fr] ${
              s.key === focus ? "mb-1 border-b border-dashed border-line pb-2" : ""
            }`}
          >
            <MirrorBar s={s} i={0} />
            <span className={`truncate text-center ${s.key === focus ? "font-semibold text-foreground" : "text-muted"}`}>
              <Label s={s} />
            </span>
            <MirrorBar s={s} i={1} />
          </li>
        ))}
      </ul>
      {/* No line compared (one of the two has no figure): no verdict to give. */}
      <p hidden={c.wins[0] + c.wins[1] === 0} className="border-t border-dashed border-line px-3 py-2 text-xs text-muted">
        {c.leader == null ? (
          <>égalité sur les lignes comparées ({c.wins[0]}–{c.wins[1]})</>
        ) : (
          <>
            <span className="text-accent">{c.players[c.leader].name}</span> devant sur {c.wins[c.leader]} lignes sur {c.wins[0] + c.wins[1]}
          </>
        )}
      </p>
    </div>
  );
}

function MirrorBar({ s, i }: { s: ComparedStat; i: 0 | 1 }) {
  const winner = rowWinner(s) === i;
  const left = i === 0;

  return (
    <div className={`flex min-w-0 items-center gap-2 ${left ? "flex-row-reverse" : ""}`}>
      <div className={`flex h-2 flex-1 ${left ? "justify-end" : ""}`}>
        <div
          className={`h-full ${winner ? "bg-accent" : "bg-muted/40"}`}
          style={{ width: `${(share(s, i) * 100).toFixed(1)}%` }}
        />
      </div>
      <span className={`w-14 shrink-0 tabular-nums ${left ? "text-right" : ""} ${tone(s, i)}`}>{formatStat(s, s.values[i])}</span>
    </div>
  );
}
