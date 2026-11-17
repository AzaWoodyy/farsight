import type { RosterPlayer, TeamRoster as View } from "@/lib/agent/types";
import { EntityIcon } from "./entity-icon";
import { useUi } from "./i18n/locale-context";
import { PlayerAvatar } from "./player-avatar";

const ROLES: { role: string; label: string }[] = [
  { role: "Top", label: "Top" },
  { role: "Jungle", label: "Jungle" },
  { role: "Mid", label: "Mid" },
  { role: "Bot", label: "ADC" },
  { role: "Support", label: "Support" },
];

/**
 * A team's roster over a period: one block per role, its starter (most games) first, then the other
 * players fielded in the role, each with their games, record and tournaments. The tournaments of the
 * scope follow, with their Leaguepedia pages.
 */
export function TeamRoster({ r, logos, tones }: { r: View; logos: Record<string, string>; tones: Record<string, "dark" | "light"> }) {
  const ui = useUi();
  const known = new Set(ROLES.map((x) => x.role));
  const roles = [...ROLES, ...[...new Set(r.players.map((p) => p.role))].flatMap((x) => (known.has(x) ? [] : [{ role: x, label: x }]))];

  return (
    <div className="mt-4">
      <div className="border border-line px-3 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold" translate="no">
          {logos[r.team] && <EntityIcon src={logos[r.team]} size={32} tone={tones[r.team]} />}
          {r.team}
        </div>
        <p className="mt-1 text-xs text-muted tabular-nums">
          {[r.scope || ui.roster.allSeasons, ui.games(r.games), `${r.wins}-${r.games - r.wins}`, ui.roster.tournamentCount(r.tournaments.length)].join(" · ")}
        </p>
        {r.names.length > 1 && <p className="mt-1 text-[11px] text-muted">{ui.roster.names(r.names.join(", "))}</p>}
      </div>

      <h3 className="mt-6 text-xs uppercase tracking-widest text-muted">── {ui.roster.byRole}</h3>
      {/* relative: the sr-only header is absolutely positioned and would widen the page from outside the scroller. */}
      <div className="relative mt-2 overflow-x-auto border border-line">
        <table className="w-full min-w-[560px] border-collapse text-left text-xs">
          <thead className="border-b border-line text-[11px] text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-normal">
                {ui.roster.role}
              </th>
              <th scope="col" className="px-3 py-2 font-normal">
                {ui.roster.player}
              </th>
              <th scope="col" className="px-3 py-2 text-right font-normal">
                {ui.gamesLabel}
              </th>
              <th scope="col" className="px-3 py-2 text-right font-normal">
                {ui.record}
              </th>
              <th scope="col" className="px-3 py-2 font-normal">
                {ui.roster.tournaments}
              </th>
            </tr>
          </thead>
          {roles.map(({ role, label }) => {
            const list = r.players.filter((p) => p.role === role);

            return list.length ? (
              <tbody key={role} className="border-b border-line last:border-0">
                {list.map((p, i) => (
                  <PlayerRow key={`${p.role}-${p.player}`} p={p} label={i === 0 ? label : ""} />
                ))}
              </tbody>
            ) : null;
          })}
        </table>
      </div>
      <p className="mt-2 text-[11px] text-muted">
        <span className="text-accent">●</span> {ui.roster.starterNote}
      </p>

      <h3 className="mt-6 text-xs uppercase tracking-widest text-muted">── {ui.roster.tournaments}</h3>
      <ul className="mt-2 space-y-1 text-xs leading-6">
        {r.tournaments.map((t) => (
          <li key={t.source.url} className="flex items-center gap-3">
            <a href={t.source.url} target="_blank" rel="noreferrer" title={t.source.label} className="tap underline decoration-line underline-offset-2 hover:text-accent">
              {t.label}
            </a>
            <span className="text-muted tabular-nums">{ui.games(t.games)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PlayerRow({ p, label }: { p: RosterPlayer; label: string }) {
  const ui = useUi();

  return (
    <tr className="border-b border-dashed border-line align-top last:border-0">
      <td className="whitespace-nowrap px-3 py-1.5 text-muted">{label}</td>
      <td className="whitespace-nowrap px-3 py-1.5">
        <span className="flex items-center gap-2">
          <PlayerAvatar name={p.player} photo={p.photo} size={28} />
          <span>
            <span className={p.starter ? "text-accent" : "text-muted"} aria-hidden="true">
              {p.starter ? "● " : "○ "}
            </span>
            <a href={p.source.url} target="_blank" rel="noreferrer" title={p.source.label} translate="no" className={`tap underline decoration-line underline-offset-2 hover:text-accent ${p.starter ? "font-semibold" : ""}`}>
              {p.player}
            </a>
            <span className="sr-only">{p.starter ? ui.roster.starter : ui.roster.substitute}</span>
          </span>
        </span>
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums">{p.games}</td>
      <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-muted">
        {p.wins}-{p.games - p.wins}
      </td>
      <td className="px-3 py-1.5 text-muted">{p.tournaments.join(", ")}</td>
    </tr>
  );
}
