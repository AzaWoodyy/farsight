"use client";

import { type ReactNode, useMemo, useState } from "react";
import type { Answer, VersusGame, VersusSide, VersusView } from "@/lib/agent/types";
import { type Comparison, detectComparison } from "@/lib/comparison";
import { ComparisonNote, FaceOff } from "./player-comparison";

/** Games listed before "show all". */
const FIRST_GAMES = 10;

const DATE = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * Two players set against each other. When they met: the face-to-face over those games (with a tab for
 * their statistics over the whole scope), then the games themselves. Otherwise: the statistics over the
 * scope and a sentence saying they never met.
 */
export function Versus({ v, profiles, fallback }: { v: VersusView; profiles: Answer["profiles"]; fallback: ReactNode }) {
  const h2h = useMemo(() => (v.h2h ? detectComparison(v.h2h, profiles) : null), [v.h2h, profiles]);
  const global = useMemo(() => detectComparison(v.global, profiles), [v.global, profiles]);
  const [tab, setTab] = useState<"h2h" | "global">("h2h");
  const shown = first(h2h && tab === "h2h" ? h2h : global, v.focus);
  const met = v.h2h ? Number(v.h2h.rows[0]?.[v.h2h.columns.indexOf("games")] ?? 0) : 0;

  // One of them has no game in the scope: nothing to set face to face, the plain table says so.
  if (!shown) return <>{fallback}</>;

  const tabs = [
    { id: "h2h" as const, label: `face à face · ${met} partie${met > 1 ? "s" : ""}` },
    { id: "global" as const, label: `global · ${v.scope || "toutes compétitions"}` },
  ];

  return (
    <div className="mt-4">
      {h2h ? (
        <div role="group" aria-label="Statistiques comparées" className="mb-2 flex flex-wrap gap-2 text-xs">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-pressed={tab === t.id}
              className={`tap border px-2 py-0.5 transition-colors duration-150 hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${
                tab === t.id ? "border-accent text-accent" : "border-dashed border-line text-muted"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      ) : (
        <p className="mb-2 text-xs text-muted">
          <span translate="no">{v.playerA}</span> et <span translate="no">{v.playerB}</span> ne se sont jamais affrontés
          {v.scope ? ` ${v.scope}` : ""} : statistiques sur toutes leurs parties.
        </p>
      )}
      {met > 0 && <Lanes v={v} met={met} />}
      <FaceOff c={shown} focus={v.focus} />
      <ComparisonNote c={shown} />
      {v.games.length > 0 && <Games v={v} />}
    </div>
  );
}

/** The statistic the question names, moved to the top of the face-off. */
function first(c: Comparison | null, focus: string | null): Comparison | null {
  if (!c || !focus) return c;
  const asked = c.stats.filter((s) => s.key === focus);

  return asked.length ? { ...c, stats: [...asked, ...c.stats.filter((s) => s.key !== focus)] } : c;
}

/** Whether their games against each other were lane face-offs: same role on both sides. */
function Lanes({ v, met }: { v: VersusView; met: number }) {
  const { same, roles } = v.lanes;

  return (
    <p className="mb-2 text-xs text-muted">
      même lane :{" "}
      <span className={same ? "text-foreground" : ""}>
        {same} partie{same > 1 ? "s" : ""} sur {met}
      </span>
      {roles.length > 0 && ` (${roles.map((r) => (roles.length > 1 ? `${r.role} ${r.games}` : r.role)).join(", ")})`}
      {same === 0 && " : ils ne se sont jamais affrontés au même poste"}
    </p>
  );
}

function Games({ v }: { v: VersusView }) {
  const [all, setAll] = useState(false);
  const list = all ? v.games : v.games.slice(0, FIRST_GAMES);

  return (
    <div className="mt-6">
      <h3 className="text-xs uppercase tracking-widest text-muted">── leurs parties face à face</h3>
      {/* relative: the sr-only "source" header is absolutely positioned; without a positioned scroller it is laid
          out against the page and widens it (horizontal scroll on phones). */}
      <div className="relative mt-2 overflow-x-auto border border-line">
        <table className="w-full min-w-[720px] border-collapse text-left text-xs">
          <thead className="border-b border-line text-[11px] text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-normal">
                date
              </th>
              <th scope="col" className="px-3 py-2 font-normal">
                compétition
              </th>
              <th scope="col" className="px-3 py-2 font-normal" translate="no">
                {v.playerA}
              </th>
              <th scope="col" className="px-3 py-2 font-normal" translate="no">
                {v.playerB}
              </th>
              <th scope="col" className="px-3 py-2 font-normal">
                vainqueur
              </th>
              <th scope="col" className="px-3 py-2 font-normal">
                <span className="sr-only">source</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((g, i) => (
              <GameRow key={`${g.playedAt}-${i}`} g={g} v={v} />
            ))}
          </tbody>
        </table>
      </div>
      {v.games.length > FIRST_GAMES && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          aria-expanded={all}
          className="tap mt-2 border border-dashed border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent"
        >
          {all ? `afficher les ${FIRST_GAMES} dernières` : `afficher les ${v.games.length} parties`}
        </button>
      )}
    </div>
  );
}

function GameRow({ g, v }: { g: VersusGame; v: VersusView }) {
  const winner = g.winA == null ? null : g.winA ? v.playerA : v.playerB;

  return (
    <tr className="border-b border-dashed border-line last:border-0 align-middle">
      <td className="px-3 py-1.5 whitespace-nowrap tabular-nums text-muted">{g.playedAt ? DATE.format(new Date(g.playedAt * 1000)) : "—"}</td>
      <td className="px-3 py-1.5">{g.label}</td>
      <td className="px-3 py-1.5">
        <Side s={g.a} won={g.winA === true} />
      </td>
      <td className="px-3 py-1.5">
        <Side s={g.b} won={g.winA === false} />
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap">{winner ? <span className="text-accent">{winner}</span> : <span className="text-muted">—</span>}</td>
      <td className="px-3 py-1.5">
        <a href={g.source.url} target="_blank" rel="noreferrer" title={g.source.label} className="tap underline decoration-line underline-offset-2 hover:text-accent">
          source
        </a>
      </td>
    </tr>
  );
}

function Side({ s, won }: { s: VersusSide; won: boolean }) {
  return (
    <div className="flex items-center gap-2">
      {s.championIcon && s.champion ? (
        // Data Dragon icons: next/image would spend the shared Vercel Hobby image quota for no LCP gain.
        // oxlint-disable-next-line nextjs/no-img-element
        <img src={s.championIcon} alt={s.champion} title={s.champion} width={22} height={22} loading="lazy" className="h-[22px] w-[22px] border border-line" />
      ) : (
        <span className="w-[22px] text-[10px] text-muted">{s.champion?.slice(0, 3) ?? "?"}</span>
      )}
      <span className="tabular-nums">
        {s.kills ?? "?"}/<span className="text-error">{s.deaths ?? "?"}</span>/{s.assists ?? "?"}
      </span>
      <span className={`min-w-0 truncate text-[11px] ${won ? "text-foreground" : "text-muted"}`}>
        {s.team ?? ""}
        {s.role && <span className="ml-1 text-muted">· {s.role}</span>}
      </span>
    </div>
  );
}
