import type { ComparedPlayer, ComparedStat, Comparison } from "@/lib/comparison";
import { formatStat, rowWinner } from "@/lib/comparison";
import { useLocale, useUi } from "./i18n/locale-context";
import { PlayerAvatar } from "./player-avatar";

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
  const ui = useUi();

  return (
    <p className="mt-2 text-[11px] text-muted">
      <span aria-hidden>*</span> {ui.comparison.computed}
      {c.players.some((p) => p.profile) ? ui.comparison.profiles : ""}
    </p>
  );
}

function Label({ s }: { s: ComparedStat }) {
  const ui = useUi();

  return (
    <>
      {s.label}
      {s.derived && (
        <span aria-label={ui.comparison.computedMark} className="text-muted">
          *
        </span>
      )}
    </>
  );
}

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
    <div className={`flex min-w-0 items-center gap-2 ${align === "right" ? "flex-row-reverse text-right" : ""}`}>
      <PlayerAvatar name={p.name} photo={p.profile?.photo} size={44} />
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold" translate="no">
          {p.name}
        </div>
        {p.profile && (
          <div className="truncate text-[11px] text-muted">
            {[p.profile.role, p.profile.teams.join(", ")].filter(Boolean).join(" · ")}
          </div>
        )}
      </div>
    </div>
  );
}

/** `focus`: key of the statistic the question names, set apart from the rest. */
export function FaceOff({ c, focus = null }: { c: Comparison; focus?: string | null }) {
  const ui = useUi();
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
      <p className="border-t border-dashed border-line px-3 py-2 text-xs text-muted">
        {c.leader == null ? (
          <>{ui.comparison.tie(c.wins[0], c.wins[1])}</>
        ) : (
          <>
            <span className="text-accent">{c.players[c.leader].name}</span> {ui.comparison.ahead(c.wins[c.leader], c.wins[0] + c.wins[1])}
          </>
        )}
      </p>
    </div>
  );
}

/**
 * Two players of whom one has no game in the scope: still one against the other in the heading, then the
 * absent one's side says so once, and the other's side lists that player's figures. No bars and no verdict:
 * there is nothing to measure them against.
 */
export function OneSided({ c, absent, scope, focus = null }: { c: Comparison; absent: 0 | 1; scope: string; focus?: string | null }) {
  const ui = useUi();
  const locale = useLocale();
  const present = absent === 0 ? 1 : 0;
  const [a, b] = c.players;
  const nothing = <div className="truncate text-[11px] text-muted">{ui.versus.noGames(scope)}</div>;

  return (
    <div className="border border-line">
      <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-3 border-b border-line px-3 py-2">
        <div className="min-w-0 text-right">
          <Who p={a} align="right" />
          {absent === 0 && nothing}
        </div>
        <span className="pt-0.5 text-xs text-muted">vs</span>
        <div className="min-w-0">
          <Who p={b} align="left" />
          {absent === 1 && nothing}
        </div>
      </div>
      <div className="grid sm:grid-cols-2">
        <p
          className={`flex items-center justify-center border-dashed border-line px-3 py-3 text-center text-xs text-muted ${
            absent === 0 ? "border-b sm:border-r sm:border-b-0" : "border-t sm:order-last sm:border-t-0 sm:border-l"
          }`}
        >
          <span>
            <span translate="no">{c.players[absent].name}</span> {ui.versus.nothingToCompare(scope)}
          </span>
        </p>
        <dl className="px-3 py-2 text-xs">
          {c.stats.map((s) => (
            <div key={s.key} className={`flex items-baseline justify-between gap-3 border-b border-dashed border-line/60 py-1 last:border-0 ${s.key === focus ? "font-semibold" : ""}`}>
              <dt className={s.key === focus ? "text-foreground" : "text-muted"}>
                <Label s={s} />
              </dt>
              <dd className="tabular-nums">{formatStat(s, s.values[present], locale)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

function MirrorBar({ s, i }: { s: ComparedStat; i: 0 | 1 }) {
  const locale = useLocale();
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
      <span className={`w-14 shrink-0 tabular-nums ${left ? "text-right" : ""} ${tone(s, i)}`}>{formatStat(s, s.values[i], locale)}</span>
    </div>
  );
}
