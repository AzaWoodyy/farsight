import type { GameScoreboard as Scoreboard, ScoreboardPlayer, ScoreboardTeam, Side } from "@/lib/agent/types";

const SIDE_LABEL: Record<Side, string> = { blue: "côté bleu", red: "côté rouge" };

const SIDE_TEXT: Record<Side, string> = { blue: "text-blue", red: "text-red" };

const SIDE_BAR: Record<Side, string> = { blue: "bg-blue", red: "bg-red" };

const ROLE_SHORT = new Map([
  ["Top", "TOP"],
  ["Jungle", "JGL"],
  ["Mid", "MID"],
  ["Bot", "BOT"],
  ["Support", "SUP"],
]);

const INT = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });

const ONE = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const kilo = (n: number | null) => (n == null ? "n/d" : `${ONE.format(n / 1000)}k`);

const OBJECTIVES: { key: keyof Omit<ScoreboardTeam, "name" | "dragonKinds" | "soul">; label: string }[] = [
  { key: "kills", label: "kills" },
  { key: "gold", label: "or" },
  { key: "towers", label: "tours" },
  { key: "inhibitors", label: "inhibiteurs" },
  { key: "dragons", label: "dragons" },
  { key: "barons", label: "barons" },
  { key: "heralds", label: "hérauts" },
  { key: "grubs", label: "larves" },
];

/**
 * End-of-game recap in the console's style: the winner's block first, as in the client's end screen,
 * then the loser's. Only what Leaguepedia's scoreboard tables hold; a missing field reads "n/d".
 */
export function GameScoreboard({ scoreboard: sb }: { scoreboard: Scoreboard }) {
  const order: Side[] = sb.winner === "red" ? ["red", "blue"] : ["blue", "red"];
  const minutes = sb.durationS ? sb.durationS / 60 : null;
  const maxDamage = Math.max(1, ...sb.players.map((p) => p.damage ?? 0));

  return (
    <section aria-label="Récapitulatif de fin de partie" className="mt-4 border border-line">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-3 py-2 text-xs">
        <h3 className="uppercase tracking-widest text-muted">── fin de partie</h3>
        <span className="text-muted">
          {sb.label}
          {sb.durationS ? ` · ${clock(sb.durationS)}` : ""}
          {sb.patch ? ` · patch ${sb.patch}` : ""}
        </span>
      </div>
      {order.map((side) => (
        <TeamBlock
          key={side}
          side={side}
          team={side === "blue" ? sb.blue : sb.red}
          result={sb.winner == null ? null : sb.winner === side}
          players={sb.players.filter((p) => p.side === side)}
          minutes={minutes}
          maxDamage={maxDamage}
        />
      ))}
    </section>
  );
}

function TeamBlock({
  side,
  team,
  result,
  players,
  minutes,
  maxDamage,
}: {
  side: Side;
  team: ScoreboardTeam;
  result: boolean | null;
  players: ScoreboardPlayer[];
  minutes: number | null;
  maxDamage: number;
}) {
  return (
    <div className="border-b border-line last:border-0">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3 pt-3 pb-2">
        <p className="text-sm">
          <span className={result ? "font-semibold text-accent" : "text-muted"}>{result == null ? "Résultat inconnu" : result ? "Victoire" : "Défaite"}</span>{" "}
          <span className="text-muted">({SIDE_LABEL[side]})</span> <span className={SIDE_TEXT[side]}>{team.name}</span>
        </p>
        <dl className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
          {OBJECTIVES.map((o) => (
            <div key={o.key} className="flex gap-1">
              <dt className="text-muted">{o.label}</dt>
              <dd className="tabular-nums">
                {o.key === "gold" ? kilo(team.gold) : (team[o.key] ?? "n/d")}
                {o.key === "dragons" && team.dragonKinds.length ? <span className="text-muted"> ({team.dragonKinds.join(", ")})</span> : null}
              </dd>
            </div>
          ))}
          {team.soul ? (
            <div className="flex gap-1">
              <dt className="text-muted">âme</dt>
              <dd className="text-accent">{team.soul}</dd>
            </div>
          ) : null}
        </dl>
      </div>
      {/* relative: keeps the sr-only caption inside the scroller (see team-h2h). */}
      <div className="relative overflow-x-auto">
        {/* Fixed column widths: both teams' tables line up column for column. */}
        <table className="w-full min-w-[860px] table-fixed border-collapse text-left text-xs">
          <caption className="sr-only">
            {team.name}, {SIDE_LABEL[side]}
          </caption>
          <colgroup>
            <col />
            <col className="w-[160px]" />
            <col className="w-[84px]" />
            <col className="w-[200px]" />
            <col className="w-[64px]" />
            <col className="w-[72px]" />
            <col className="w-[64px]" />
          </colgroup>
          <thead>
            <tr className="text-[11px] text-muted">
              <th scope="col" className="px-3 py-1 font-normal">
                champion · joueur
              </th>
              <th scope="col" className="px-2 py-1 font-normal">
                objets
              </th>
              <th scope="col" className="px-2 py-1 text-right font-normal">
                K/D/A
              </th>
              <th scope="col" className="px-2 py-1 font-normal">
                dégâts infligés
              </th>
              <th scope="col" className="px-2 py-1 text-right font-normal">
                or
              </th>
              <th scope="col" className="px-2 py-1 text-right font-normal">
                CS
              </th>
              <th scope="col" className="px-3 py-1 text-right font-normal">
                vision
              </th>
            </tr>
          </thead>
          <tbody>
            {players.map((p) => (
              <PlayerRow key={p.player} p={p} minutes={minutes} maxDamage={maxDamage} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Icon({ src, alt, size }: { src: string; alt: string; size: number }) {
  // Data Dragon icons: next/image would spend the Vercel Hobby image-optimization quota (shared
  // with the portfolio) without any LCP gain.
  // oxlint-disable-next-line nextjs/no-img-element
  return <img src={src} alt={alt} title={alt} width={size} height={size} loading="lazy" className="shrink-0 border border-line" style={{ width: size, height: size }} />;
}

function PlayerRow({ p, minutes, maxDamage }: { p: ScoreboardPlayer; minutes: number | null; maxDamage: number }) {
  const kda = p.kills != null && p.deaths != null && p.assists != null ? (p.deaths === 0 ? null : (p.kills + p.assists) / p.deaths) : undefined;
  const slots = Array.from({ length: 6 }, (_, i) => p.items[i] ?? null);

  return (
    <tr className="border-t border-dashed border-line align-middle">
      <td className="px-3 py-1.5">
        <div className="flex items-center gap-2">
          <div className="relative">
            {p.championIcon && p.champion ? (
              <Icon src={p.championIcon} alt={p.champion} size={32} />
            ) : (
              <span className="flex h-8 w-8 items-center justify-center border border-line text-[10px] text-muted">{p.champion?.slice(0, 3) ?? "?"}</span>
            )}
            {p.keystoneIcon && p.keystone && (
              <span className="absolute -right-1.5 -bottom-1.5 rounded-full bg-background">
                {/* oxlint-disable-next-line nextjs/no-img-element */}
                <img src={p.keystoneIcon} alt={p.keystone} title={p.keystone} width={16} height={16} loading="lazy" className="h-4 w-4" />
              </span>
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="w-7 shrink-0 text-[10px] text-muted">{p.role ? (ROLE_SHORT.get(p.role) ?? p.role) : ""}</span>
              <span className="truncate font-semibold" translate="no">
                {p.player.replace(/\s*\(.*?\)\s*$/, "")}
              </span>
            </div>
            <div className="ml-9 truncate text-[11px] text-muted" translate="no">
              {p.champion ?? "champion n/d"}
              {p.keystone && !p.keystoneIcon ? ` · ${p.keystone}` : ""}
            </div>
            {(p.spells.length > 0 || p.runes.length > 0) && (
              <div className="mt-0.5 ml-9 flex items-center gap-2">
                <ul className="flex gap-0.5" aria-label="Sorts d'invocateur">
                  {p.spells.map((s) => (
                    <li key={s.name} className="text-[10px] text-muted">
                      {s.iconUrl ? <Icon src={s.iconUrl} alt={s.name} size={14} /> : s.name}
                    </li>
                  ))}
                </ul>
                {/* The page after the keystone, without the stat shards (no icon): primary tree, then secondary tree. */}
                {p.runes.some((r) => r.kind !== "shard") && (
                  <ul className="flex items-center gap-px" aria-label="Runes">
                    {p.runes
                      .filter((r) => r.kind !== "shard")
                      .map((r, i) => (
                        <li key={i} className={`text-[10px] text-muted ${r.kind === "secondary" && p.runes[i - 1]?.kind === "primary" ? "ml-1" : ""}`}>
                          {r.iconUrl ? (
                            // oxlint-disable-next-line nextjs/no-img-element
                            <img src={r.iconUrl} alt={r.name} title={r.name} width={14} height={14} loading="lazy" className="h-3.5 w-3.5" />
                          ) : (
                            r.name
                          )}
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            )}
            {/* Phone width: the K/D/A column is off screen, behind the horizontal scroll; repeat it here. */}
            <div className="ml-9 text-[11px] tabular-nums sm:hidden" aria-hidden>
              {p.kills ?? "?"}/<span className="text-error">{p.deaths ?? "?"}</span>/{p.assists ?? "?"}
              <span className="text-muted"> · {kilo(p.gold)} or</span>
            </div>
          </div>
        </div>
      </td>
      <td className="px-2 py-1.5">
        <ul className="flex gap-0.5" aria-label="Objets">
          {slots.map((item, i) =>
            item ? (
              <li key={i}>
                <Icon src={item.iconUrl} alt={item.name} size={22} />
              </li>
            ) : (
              <li key={i} aria-hidden className="h-[22px] w-[22px] border border-dashed border-line" />
            ),
          )}
        </ul>
      </td>
      <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">
        <div>
          {p.kills ?? "?"}/<span className="text-error">{p.deaths ?? "?"}</span>/{p.assists ?? "?"}
        </div>
        <div className="text-[11px] text-muted">{kda === undefined ? "" : kda === null ? "KDA parfait" : `KDA ${ONE.format(kda)}`}</div>
      </td>
      <td className="px-2 py-1.5">
        {p.damage == null ? (
          <span className="text-muted">n/d</span>
        ) : (
          <div className="w-44">
            <div className="flex items-baseline justify-between gap-2 tabular-nums">
              <span>{INT.format(p.damage)}</span>
              {minutes && <span className="text-[11px] text-muted">{INT.format(p.damage / minutes)}/min</span>}
            </div>
            <div className="mt-0.5 h-1.5 bg-line/60">
              <div className={`h-full ${SIDE_BAR[p.side]}`} style={{ width: `${((100 * p.damage) / maxDamage).toFixed(1)}%` }} />
            </div>
          </div>
        )}
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums">{kilo(p.gold)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">
        <div>{p.cs ?? "n/d"}</div>
        {p.cs != null && minutes && <div className="text-[11px] text-muted">{ONE.format(p.cs / minutes)}/min</div>}
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums">{p.vision ?? "n/d"}</td>
    </tr>
  );
}
