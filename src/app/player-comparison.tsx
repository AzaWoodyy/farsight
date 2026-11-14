"use client";

import { type ReactNode, useState } from "react";
import { type ComparedPlayer, type ComparedStat, type Comparison, formatDelta, formatStat, rowWinner } from "@/lib/comparison";

/** Layouts of a two-player comparison; `table` is the generic table it replaces. */
export const VARIANTS = [
  { id: "face", label: "face-à-face" },
  { id: "cartes", label: "cartes" },
  { id: "ascii", label: "barres ascii" },
  { id: "ecarts", label: "écarts" },
  { id: "tableau", label: "tableau brut" },
] as const;

export type Variant = (typeof VARIANTS)[number]["id"];

const isVariant = (v: string | null): v is Variant => VARIANTS.some((x) => x.id === v);

/** The layout named by `?variant=` in the address bar, face-à-face by default. */
function initialVariant(): Variant {
  if (typeof window === "undefined") return "face";

  const v = new URLSearchParams(window.location.search).get("variant");

  return isVariant(v) ? v : "face";
}

export function PlayerComparison({ comparison, table }: { comparison: Comparison; table: ReactNode }) {
  const [variant, setVariant] = useState<Variant>(initialVariant);

  function choose(v: Variant) {
    setVariant(v);
    // Keep the layout in the URL, so a shared link opens on it.
    const url = new URL(window.location.href);

    url.searchParams.set("variant", v);
    window.history.replaceState(null, "", url);
  }

  return (
    <div className="mt-4">
      <div role="group" aria-label="Affichage de la comparaison" className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted">affichage</span>
        {VARIANTS.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => choose(v.id)}
            aria-pressed={variant === v.id}
            className={`border px-2 py-0.5 transition-colors duration-150 hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${
              variant === v.id ? "border-accent text-accent" : "border-dashed border-line text-muted"
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>
      {variant === "face" && <FaceOff c={comparison} />}
      {variant === "cartes" && <Cards c={comparison} />}
      {variant === "ascii" && <AsciiBars c={comparison} />}
      {variant === "ecarts" && <Deltas c={comparison} />}
      {variant === "tableau" && table}
      <p className="mt-2 text-[11px] text-muted">
        <span aria-hidden>*</span> calculé par la page à partir des colonnes renvoyées
        {comparison.players.some((p) => p.profile) ? " · équipes et rôle lus dans la base, sur la compétition et la période de la question" : ""}
      </p>
    </div>
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

// 1. Face-à-face: mirrored bars from a central label column -----------------------------------

function FaceOff({ c }: { c: Comparison }) {
  const [a, b] = c.players;

  return (
    <div className="mt-3 border border-line">
      <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3 border-b border-line px-3 py-2">
        <Who p={a} align="right" />
        <span className="pb-0.5 text-xs text-muted">vs</span>
        <Who p={b} align="left" />
      </div>
      <ul className="px-3 py-2 text-xs">
        {c.stats.map((s) => (
          <li key={s.key} className="grid grid-cols-[1fr_7.5rem_1fr] items-center gap-3 py-1 sm:grid-cols-[1fr_9rem_1fr]">
            <MirrorBar s={s} i={0} />
            <span className="truncate text-center text-muted">
              <Label s={s} />
            </span>
            <MirrorBar s={s} i={1} />
          </li>
        ))}
      </ul>
      <p className="border-t border-dashed border-line px-3 py-2 text-xs text-muted">
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

// 2. Cards: one card per player with the headline figures, then the rest ------------------------

const HEADLINE = new Set(["winrate", "win_rate", "kda"]);

const GAMES = new Set(["games", "games_played", "parties", "nb_games", "game_count"]);

function Cards({ c }: { c: Comparison }) {
  const headline = c.stats.filter((s) => HEADLINE.has(s.base));
  const games = c.stats.find((s) => GAMES.has(s.base));
  const wins = c.stats.find((s) => s.base === "wins" || s.base === "victoires");
  const rest = c.stats.filter((s) => !headline.includes(s) && s !== games && s !== wins);

  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      {c.players.map((p, idx) => {
        const i = idx === 0 ? 0 : 1;
        const g = games?.values[i];
        const w = wins?.values[i];

        return (
          <article key={p.name} className={`border ${c.leader === i ? "border-accent/60" : "border-line"}`}>
            <header className="flex items-start justify-between gap-3 border-b border-line px-3 py-2">
              <Who p={p} align="left" />
              {c.leader === i && <span className="shrink-0 text-[11px] text-accent">devant {c.wins[i]}–{c.wins[i === 0 ? 1 : 0]}</span>}
            </header>
            <dl className="grid grid-cols-3 gap-2 border-b border-dashed border-line px-3 py-3">
              {g != null && (
                <div>
                  <dt className="text-[11px] text-muted">bilan</dt>
                  <dd className="text-lg tabular-nums">
                    {w != null ? `${w}-${g - w}` : g}
                    <span className="ml-1 text-[11px] text-muted">{w != null ? "V-D" : "parties"}</span>
                  </dd>
                </div>
              )}
              {headline.map((s) => (
                <div key={s.key}>
                  <dt className="text-[11px] text-muted">
                    <Label s={s} />
                  </dt>
                  <dd className={`text-lg tabular-nums ${tone(s, i)}`}>{formatStat(s, s.values[i])}</dd>
                </div>
              ))}
            </dl>
            <dl className="px-3 py-2 text-xs">
              {rest.map((s) => (
                <div key={s.key} className="flex items-baseline justify-between gap-3 py-0.5">
                  <dt className="truncate text-muted">
                    <Label s={s} />
                  </dt>
                  <dd className={`tabular-nums ${tone(s, i)}`}>
                    {rowWinner(s) === i && (
                      <span aria-label="meilleur" className="mr-1">
                        ▲
                      </span>
                    )}
                    {formatStat(s, s.values[i])}
                  </dd>
                </div>
              ))}
            </dl>
          </article>
        );
      })}
    </div>
  );
}

// 3. ASCII bars: the console's own vocabulary, one line per player and stat --------------------

const WIDTH = 20;

const bar = (ratio: number) => {
  const n = Math.round(ratio * WIDTH);

  return { full: "█".repeat(n), empty: "░".repeat(WIDTH - n) };
};

function AsciiBars({ c }: { c: Comparison }) {
  const pad = Math.max(...c.players.map((p) => p.name.length));

  return (
    <div className="mt-3 overflow-x-auto border border-line px-3 py-2 text-xs leading-relaxed">
      {c.stats.map((s) => (
        <div key={s.key} className="py-1">
          <div className="text-muted">
            ── <Label s={s} />
          </div>
          {c.players.map((p, idx) => {
            const i = idx === 0 ? 0 : 1;
            const { full, empty } = bar(share(s, i));

            return (
              <div key={p.name} className="whitespace-pre" aria-label={`${p.name} : ${formatStat(s, s.values[i])}`}>
                <span aria-hidden>
                  <span translate="no">{p.name.padEnd(pad)}</span> <span className={rowWinner(s) === i ? "text-accent" : "text-muted"}>{full}</span>
                  <span className="text-line">{empty}</span> <span className={`tabular-nums ${tone(s, i)}`}>{formatStat(s, s.values[i])}</span>
                  {rowWinner(s) === i ? <span className="text-accent"> ◂</span> : ""}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// 4. Deltas: a ledger of differences, the advantage named on each row ------------------------

function Deltas({ c }: { c: Comparison }) {
  const [a, b] = c.players;

  return (
    <div className="mt-3 overflow-x-auto border border-line">
      <table className="w-full min-w-[520px] border-collapse text-left text-xs">
        <thead className="border-b border-line">
          <tr className="text-muted">
            <th scope="col" className="px-3 py-2 font-normal">
              stat
            </th>
            <th scope="col" className="px-3 py-2 text-right font-normal" translate="no">
              {a.name}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-normal" translate="no">
              {b.name}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-normal">
              écart ({a.name} − {b.name})
            </th>
            <th scope="col" className="px-3 py-2 font-normal">
              avantage
            </th>
          </tr>
        </thead>
        <tbody>
          {c.stats.map((s) => {
            const w = rowWinner(s);

            return (
              <tr key={s.key} className="border-b border-dashed border-line last:border-0">
                <th scope="row" className="px-3 py-1.5 font-normal text-muted">
                  <Label s={s} />
                </th>
                <td className={`px-3 py-1.5 text-right tabular-nums ${tone(s, 0)}`}>{formatStat(s, s.values[0])}</td>
                <td className={`px-3 py-1.5 text-right tabular-nums ${tone(s, 1)}`}>{formatStat(s, s.values[1])}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{formatDelta(s)}</td>
                <td className="px-3 py-1.5">
                  {w == null ? <span className="text-muted">{s.better == null ? "—" : "égalité"}</span> : <span className="text-accent">{c.players[w].name}</span>}
                  {s.better === "lower" && <span className="ml-1 text-muted">(moins = mieux)</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
