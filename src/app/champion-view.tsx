"use client";

import { type ReactNode, useMemo, useState } from "react";
import type { ChampionItem, ChampionItems, ChampionPool as Pool, ChampionProfile as Profile } from "@/lib/agent/types";
import { type ChampionRanking as Ranking, formatChampionValue } from "@/lib/champions";
import { ITEM_KIND_LABEL, ITEM_KINDS, type ItemKind } from "@/lib/domain/items";

const NUMBER = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });

const nd = (v: number | null, signed = false) => (v == null ? "n/d" : `${signed && v > 0 ? "+" : v < 0 ? "−" : ""}${NUMBER.format(Math.abs(v))}`);

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)} %` : "n/d");

/**
 * A Data Dragon square icon, or the champion's first letters in a box when the icon is missing or fails
 * to load. Plain <img>: next/image would spend the shared Vercel Hobby image quota for no LCP gain.
 */
export function ChampionIcon({ name, src, size }: { name: string; src: string | null; size: number }) {
  const [failed, setFailed] = useState(false);

  if (!src || failed)
    return (
      <span
        aria-hidden
        style={{ width: size, height: size }}
        className="flex shrink-0 items-center justify-center border border-line text-[10px] uppercase text-muted"
      >
        {name.replace(/[^\p{L}]/gu, "").slice(0, 2)}
      </span>
    );

  return (
    // oxlint-disable-next-line nextjs/no-img-element
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      style={{ width: size, height: size }}
      className="shrink-0 border border-line"
    />
  );
}

/** A horizontal ASCII-like gauge: filled share in accent, the rest dotted. */
function Gauge({ share, label }: { share: number; label: string }) {
  return (
    <div role="img" aria-label={label} className="relative h-1.5 w-full bg-[repeating-linear-gradient(90deg,var(--line)_0_2px,transparent_2px_4px)]">
      <div className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${Math.min(100, Math.max(0, share * 100)).toFixed(1)}%` }} />
    </div>
  );
}

/** Champions ranked: one line per champion, a gauge on the ranking metric, the other metrics beside it. */
export function ChampionRankingView({ ranking, fallback }: { ranking: Ranking; fallback: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  const primary = ranking.metrics[ranking.primary];
  const max = Math.max(...ranking.lines.map((l) => Math.abs(l.values[ranking.primary] ?? 0)), 0);
  const others = ranking.metrics.map((m, i) => ({ m, i })).filter(({ i }) => i !== ranking.primary);

  return (
    <div className="mt-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <p className="text-muted">
          classé par <span className="text-foreground">{primary.label}</span> · {ranking.lines.length} champion{ranking.lines.length > 1 ? "s" : ""}
        </p>
        <button
          type="button"
          onClick={() => setAsTable(!asTable)}
          aria-pressed={asTable}
          className="tap border border-dashed border-line px-2 py-0.5 text-muted transition-colors duration-150 hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent active:scale-[0.97]"
        >
          {asTable ? "vue champions" : "vue tableau"}
        </button>
      </div>
      {asTable ? (
        fallback
      ) : (
        <div className="border border-line">
          <div aria-hidden className="hidden items-center gap-3 border-b border-line px-3 py-1.5 text-[11px] text-muted sm:flex">
            <span className="w-8 shrink-0">#</span>
            <span className="min-w-0 flex-1">champion</span>
            <span className="w-[4.5rem] shrink-0 text-right text-foreground">{primary.label}</span>
            {others.map(({ m }) => (
              <span key={m.key} className="w-[4.5rem] shrink-0 text-right">
                {m.label}
              </span>
            ))}
          </div>
          <ol>
            {ranking.lines.map((l) => {
              const value = l.values[ranking.primary];

              return (
                <li
                  key={l.champion}
                  className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-dashed border-line px-3 py-2 text-xs last:border-0 sm:flex"
                >
                  <span className="tabular-nums text-muted sm:w-8 sm:shrink-0">{l.rank}</span>
                  <div className="flex min-w-0 items-center gap-2 sm:flex-1">
                    <ChampionIcon name={l.champion} src={l.icon} size={28} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate" translate="no">
                        {l.champion}
                      </div>
                      <div className="mt-1">
                        <Gauge share={max ? Math.abs(value ?? 0) / max : 0} label={`${primary.label} : ${formatChampionValue(value, primary.percent)}`} />
                      </div>
                    </div>
                  </div>
                  <span className="text-right font-semibold tabular-nums text-accent sm:w-[4.5rem] sm:shrink-0">{formatChampionValue(value, primary.percent)}</span>
                  {/* Phone width: the other metrics wrap under the name; wider: one column each. */}
                  <dl className="col-span-3 col-start-1 flex flex-wrap gap-x-3 gap-y-0.5 pl-[calc(2rem+0.75rem+28px+0.5rem)] text-[11px] text-muted sm:hidden">
                    {others.map(({ m, i }) => (
                      <div key={m.key} className="flex gap-1">
                        <dt>{m.label}</dt>
                        <dd className="tabular-nums text-foreground">{formatChampionValue(l.values[i], m.percent)}</dd>
                      </div>
                    ))}
                  </dl>
                  {others.map(({ m, i }) => (
                    <span key={m.key} className="hidden w-[4.5rem] shrink-0 text-right tabular-nums sm:block">
                      {formatChampionValue(l.values[i], m.percent)}
                    </span>
                  ))}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}

/** One champion in the scope: draft figures, averages per game, roles and the players who played it most. */
export function ChampionProfileView({ p }: { p: Profile }) {
  const presence = p.games ? (p.picks + p.bans) / p.games : 0;
  const losses = p.picks - p.wins;
  const maxRole = Math.max(1, ...p.roles.map((r) => r.games));

  const draft = [
    { label: "picks", value: String(p.picks) },
    { label: "bans", value: String(p.bans) },
    { label: "victoires", value: p.picks ? `${p.wins}-${losses} · ${pct(p.wins, p.picks)}` : "n/d" },
    { label: "KDA", value: nd(p.kda) },
  ];

  return (
    <div className="mt-4 border border-line">
      <div className="flex items-center gap-3 border-b border-line px-3 py-3">
        <ChampionIcon name={p.champion} src={p.icon} size={48} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" translate="no">
            {p.champion}
          </div>
          <div className="truncate text-[11px] text-muted">
            {p.scope || "toutes compétitions"} · {p.games} parties
          </div>
          <div className="mt-2 flex items-center gap-2 text-[11px]">
            <span className="shrink-0 text-muted">présence</span>
            <Gauge share={presence} label={`présence ${pct(p.picks + p.bans, p.games)}`} />
            <span className="w-10 shrink-0 text-right font-semibold tabular-nums text-accent">{pct(p.picks + p.bans, p.games)}</span>
          </div>
        </div>
      </div>

      <dl className="grid grid-cols-2 border-b border-line text-xs sm:grid-cols-4">
        {draft.map((d) => (
          <div key={d.label} className="border-b border-dashed border-line px-3 py-2 last:border-b-0 sm:border-b-0 [&:nth-child(-n+2)]:border-b sm:[&:nth-child(-n+2)]:border-b-0">
            <dt className="text-[11px] text-muted">{d.label}</dt>
            <dd className="tabular-nums">{d.value}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="champion-averages" className="border-b border-line px-3 py-2">
        <h3 id="champion-averages" className="text-[11px] text-muted">
          ── moyennes par partie jouée
        </h3>
        <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          {p.averages.map((a) => (
            <div key={a.key} className="flex items-baseline justify-between gap-2 border-b border-dashed border-line/60 py-0.5">
              <dt className="truncate text-muted">{a.label}</dt>
              <dd className="shrink-0 tabular-nums" title={a.counted < p.picks ? `sur ${a.counted} parties sur ${p.picks}` : undefined}>
                {nd(a.value, a.signed)}
                {a.value != null && a.counted < p.picks && <span className="ml-1 text-[10px] text-muted">({a.counted})</span>}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-1 text-[10px] text-muted">
          (n) : moyenne sur n parties seulement, les autres n&apos;ont pas la donnée · n/d : donnée absente pour cette époque ou ce périmètre
        </p>
      </section>

      <div className="grid sm:grid-cols-2">
        <section aria-labelledby="champion-players" className="border-b border-line px-3 py-2 sm:border-b-0 sm:border-r">
          <h3 id="champion-players" className="text-[11px] text-muted">
            ── joueurs (classés par parties)
          </h3>
          {p.players.length ? (
            <ul className="mt-1 text-xs">
              {p.players.map((pl) => (
                <li
                  key={pl.player}
                  className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-baseline gap-x-3 border-b border-dashed border-line/60 py-1 last:border-0"
                >
                  <span className="min-w-0 truncate">
                    <span translate="no">{pl.player}</span>
                    {pl.team && <span className="ml-1 text-[11px] text-muted">{pl.team}</span>}
                  </span>
                  <span className="text-right tabular-nums">{pl.games} p.</span>
                  <span className="text-right tabular-nums" title="taux de victoire">
                    {pct(pl.wins, pl.games)}
                  </span>
                  <span className="text-right tabular-nums text-muted">KDA {nd(pl.kda)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-muted">aucun pick dans ce périmètre</p>
          )}
        </section>
        <section aria-labelledby="champion-roles" className="px-3 py-2">
          <h3 id="champion-roles" className="text-[11px] text-muted">
            ── rôles
          </h3>
          {p.roles.length ? (
            <ul className="mt-1 space-y-1 text-xs">
              {p.roles.map((r) => (
                <li key={r.role} className="grid grid-cols-[4.5rem_1fr_3.5rem] items-center gap-2">
                  <span>{r.role}</span>
                  <Gauge share={r.games / maxRole} label={`${r.role} : ${r.games} parties`} />
                  <span className="text-right tabular-nums text-muted">{r.games}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-muted">n/d</p>
          )}
        </section>
      </div>

      <ChampionItemsSection key={`${p.champion}|${p.scope}`} items={p.items} />
    </div>
  );
}

type ItemSortKey = "item" | "games" | "winrate";

/** Below this many games, an item's win rate is not shown: one game more or less swings it too much. */
const ITEM_WINRATE_MIN_GAMES = 5;

/** Lines shown before "voir tout". */
const ITEM_LINES = 8;

const ITEM_COLUMNS: { key: ItemSortKey; label: string; title: string }[] = [
  { key: "games", label: "parties", title: "parties finies avec l'item" },
  { key: "winrate", label: "winrate", title: `victoires / parties avec l'item, dès ${ITEM_WINRATE_MIN_GAMES} parties` },
];

const winrateOf = (i: ChampionItem) => (i.games >= ITEM_WINRATE_MIN_GAMES ? (100 * i.wins) / i.games : null);

/**
 * The champion's most built items: end-of-game inventories, filtered by kind (completed items first),
 * each line with its share of the champion's games and, on enough games, its win rate.
 */
function ChampionItemsSection({ items }: { items: ChampionItems }) {
  const counts = new Map<ItemKind | "all", number>([["all", items.items.length]]);

  for (const i of items.items) if (i.kind) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);

  const kinds = ITEM_KINDS.filter((k) => counts.has(k));
  const [kind, setKind] = useState<ItemKind | "all">(kinds[0] ?? "all");
  const [sort, setSort] = useState<{ key: ItemSortKey; dir: 1 | -1 }>({ key: "games", dir: -1 });
  const [all, setAll] = useState(false);

  const lines = useMemo(
    () =>
      items.items
        .filter((i) => kind === "all" || i.kind === kind)
        .sort((a, b) => {
          const order = sort.key === "item" ? a.item.localeCompare(b.item, "fr") : compareFigures(sort.key === "games" ? a.games : winrateOf(a), sort.key === "games" ? b.games : winrateOf(b), sort.dir);

          return order * sort.dir || b.games - a.games;
        }),
    [items.items, kind, sort],
  );

  const shown = all ? lines : lines.slice(0, ITEM_LINES);
  const max = Math.max(...lines.map((l) => l.games), 0);

  const toggle = (key: ItemSortKey) => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "item" ? 1 : -1 }));

  const header = (key: ItemSortKey, label: string, title: string, className: string) => {
    const active = sort.key === key;

    return (
      <button
        type="button"
        title={title}
        onClick={() => toggle(key)}
        aria-label={`trier par ${label}`}
        className={`${className} whitespace-nowrap hover:text-accent pointer-coarse:min-h-11 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${active ? "text-foreground" : ""}`}
      >
        {label}
        <span aria-hidden className="ml-0.5 inline-block w-2">
          {active ? (sort.dir === 1 ? "↑" : "↓") : ""}
        </span>
      </button>
    );
  };

  return (
    <section aria-labelledby="champion-items" className="border-t border-line px-3 py-2">
      <h3 id="champion-items" className="text-[11px] text-muted">
        ── items les plus pris <span className="text-muted/80">· inventaire de fin de partie{items.games ? ` · ${items.games} parties` : ""}</span>
      </h3>

      {items.items.length > 0 && (
        <>
          <div role="group" aria-label="type d'item" className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
            {[...kinds, "all" as const].map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => {
                  setKind(k);
                  setAll(false);
                }}
                className={`tap press border px-2 py-0.5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${
                  kind === k ? "border-accent text-accent" : "border-dashed border-line text-muted hover:border-accent hover:text-accent"
                }`}
              >
                {k === "all" ? "tous" : ITEM_KIND_LABEL[k]} <span className="tabular-nums">{counts.get(k)}</span>
              </button>
            ))}
          </div>

          <div className="mt-2 border border-line">
            <div className="flex items-center gap-3 border-b border-line px-2 py-1 text-[11px] text-muted">
              <span className="w-5 shrink-0">#</span>
              {header("item", "item", "ordre alphabétique", "min-w-0 flex-1 text-left")}
              {ITEM_COLUMNS.map((c) => (
                <span key={c.key} className="w-14 shrink-0 text-right">
                  {header(c.key, c.label, c.title, "w-full text-right")}
                </span>
              ))}
            </div>
            <ol>
              {shown.map((l, i) => {
                const wr = winrateOf(l);

                return (
                  <li key={l.item} className="flex items-center gap-3 border-b border-dashed border-line px-2 py-1.5 text-xs last:border-0">
                    <span className="w-5 shrink-0 tabular-nums text-muted">{i + 1}</span>
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <ChampionIcon name={l.item} src={l.icon} size={24} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate" translate="no" title={l.kind ? `${l.item} (${ITEM_KIND_LABEL[l.kind]})` : l.item}>
                          {l.item}
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          <Gauge share={max ? l.games / max : 0} label={`${l.item} : ${pct(l.games, items.games)} des parties`} />
                          <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-muted">{pct(l.games, items.games)}</span>
                        </div>
                      </div>
                    </div>
                    <span className="w-14 shrink-0 text-right font-semibold tabular-nums text-accent">{l.games}</span>
                    <span
                      className={`w-14 shrink-0 text-right tabular-nums ${wr == null ? "text-muted" : ""}`}
                      title={wr == null ? `moins de ${ITEM_WINRATE_MIN_GAMES} parties : winrate non affiché (${l.wins}-${l.games - l.wins})` : `${l.wins}-${l.games - l.wins}`}
                    >
                      {wr == null ? "·" : `${Math.round(wr)} %`}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>

          {lines.length > ITEM_LINES && (
            <button
              type="button"
              onClick={() => setAll(!all)}
              aria-expanded={all}
              className="tap press mt-2 border border-dashed border-line px-2 py-0.5 text-[11px] text-muted hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
            >
              {all ? "réduire" : `voir les ${lines.length} items`}
            </button>
          )}
        </>
      )}

      {items.items.length === 0 && !items.notes.length && <p className="mt-1 text-xs text-muted">aucun pick dans ce périmètre</p>}
      {items.notes.map((n) => (
        <p key={n} className="mt-1 text-[10px] text-warn">
          {n}
        </p>
      ))}
      {items.items.length > 0 && (
        <p className="mt-1 text-[10px] text-muted">
          % : part des parties du champion finies avec l&apos;item · winrate dès {ITEM_WINRATE_MIN_GAMES} parties, à lire avec prudence : un item fini se voit plus dans les parties longues ou gagnées
        </p>
      )}
    </section>
  );
}

type PoolKey = "games" | "wins" | "winrate" | "kda" | "share" | "champion";

const POOL_COLUMNS: { key: PoolKey; label: string; title: string }[] = [
  { key: "games", label: "parties", title: "parties jouées sur le champion" },
  { key: "wins", label: "V-D", title: "victoires - défaites" },
  { key: "winrate", label: "winrate", title: "victoires / parties" },
  { key: "kda", label: "KDA", title: "(kills + assists) / morts" },
  { key: "share", label: "part", title: "part du pool : parties sur le champion / tous les picks" },
];


/** Two figures in the sort direction; a missing one (a KDA without deaths data) goes last either way. */
function compareFigures(x: number | null, y: number | null, dir: 1 | -1): number {
  if (x == null || y == null) return x == null ? (y == null ? 0 : dir) : -dir;

  return x - y;
}

/**
 * A player's or a team's champion pool: diversity on top (distinct champions, share of the three most played),
 * then one line per champion with its icon, sortable on every column.
 */
export function ChampionPoolView({ pool, fallback }: { pool: Pool; fallback: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  const [sort, setSort] = useState<{ key: PoolKey; dir: 1 | -1 }>({ key: "games", dir: -1 });

  const lines = useMemo(
    () =>
      [...pool.lines].sort((a, b) => {
        const order = sort.key === "champion" ? a.champion.localeCompare(b.champion, "fr") : compareFigures(a[sort.key], b[sort.key], sort.dir);

        // Ties keep the most played first.
        return order * sort.dir || b.games - a.games;
      }),
    [pool.lines, sort],
  );

  const maxShare = Math.max(...pool.lines.map((l) => l.share), 0);
  const team = pool.subject === "team";

  const toggle = (key: PoolKey) => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "champion" ? 1 : -1 }));

  const header = (key: PoolKey, label: string, title: string, className: string) => {
    const active = sort.key === key;

    return (
      <button
        type="button"
        title={title}
        onClick={() => toggle(key)}
        aria-label={`trier par ${label}`}
        className={`${className} whitespace-nowrap hover:text-accent pointer-coarse:min-h-11 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${active ? "text-foreground" : ""}`}
      >
        {label}
        <span aria-hidden className="ml-0.5 inline-block w-2">
          {active ? (sort.dir === 1 ? "↑" : "↓") : ""}
        </span>
      </button>
    );
  };

  const diversity = [
    { label: "parties", value: String(pool.games) },
    { label: "bilan", value: `${pool.wins}-${pool.losses} · ${pct(pool.wins, pool.games)}` },
    { label: "champions uniques", value: String(pool.unique) },
    { label: "part du top 3", value: `${NUMBER.format(pool.top3Share)} %` },
  ];

  return (
    <div className="mt-4">
      <div className="border border-line">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-3 py-2 text-xs">
          <p className="min-w-0 truncate">
            <span translate="no" className="font-semibold">
              {pool.name}
            </span>
            <span className="text-muted"> · {pool.scope || "toutes compétitions"}</span>
          </p>
          <button
            type="button"
            onClick={() => setAsTable(!asTable)}
            aria-pressed={asTable}
            className="tap border border-dashed border-line px-2 py-0.5 text-muted transition-colors duration-150 hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent active:scale-[0.97]"
          >
            {asTable ? "vue champions" : "vue tableau"}
          </button>
        </div>
        <dl className="grid grid-cols-2 text-xs sm:grid-cols-4">
          {diversity.map((d) => (
            <div key={d.label} className="border-b border-dashed border-line px-3 py-2 sm:border-b-0 [&:nth-child(odd)]:border-r sm:border-r sm:last:border-r-0">
              <dt className="text-[11px] text-muted">{d.label}</dt>
              <dd className="tabular-nums">{d.value}</dd>
            </div>
          ))}
        </dl>
        <div className="flex items-center gap-2 border-t border-line px-3 py-2 text-[11px]">
          <span className="shrink-0 text-muted">top 3</span>
          <Gauge share={pool.top3Share / 100} label={`les trois champions les plus joués font ${NUMBER.format(pool.top3Share)} % du pool`} />
          <span className="shrink-0 text-muted">
            {team ? `${pool.picks} picks` : `${pool.games} parties`}
          </span>
        </div>
      </div>

      {asTable ? (
        fallback
      ) : (
        <div className="mt-2 border border-line">
          <div className="flex items-center gap-3 border-b border-line px-3 py-1.5 text-[11px] text-muted">
            <span className="w-6 shrink-0">#</span>
            {header("champion", "champion", "ordre alphabétique", "min-w-0 flex-1 text-left")}
            {POOL_COLUMNS.map((c) => (
              <span key={c.key} className={c.key === "games" || c.key === "winrate" ? "w-14 shrink-0 text-right" : "hidden w-14 shrink-0 text-right sm:block"}>
                {header(c.key, c.label, c.title, "w-full text-right")}
              </span>
            ))}
          </div>
          <ol>
            {lines.map((l, i) => (
              <li key={l.champion} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-dashed border-line px-3 py-2 text-xs last:border-0">
                <span className="w-6 shrink-0 tabular-nums text-muted">{i + 1}</span>
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <ChampionIcon name={l.champion} src={l.icon} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate" translate="no">
                      {l.champion}
                      {team && l.players.length > 0 && (
                        <span className="ml-1 text-[11px] text-muted">{l.players.slice(0, 2).map((p) => `${p.player} ×${p.games}`).join(", ")}</span>
                      )}
                    </div>
                    <div className="mt-1">
                      <Gauge share={maxShare ? l.share / maxShare : 0} label={`part du pool : ${NUMBER.format(l.share)} %`} />
                    </div>
                  </div>
                </div>
                <span className="w-14 shrink-0 text-right font-semibold tabular-nums text-accent">{l.games}</span>
                <span className="hidden w-14 shrink-0 text-right tabular-nums sm:block">
                  {l.wins}-{l.losses}
                </span>
                <span className="w-14 shrink-0 text-right tabular-nums">{NUMBER.format(l.winrate)} %</span>
                <span className="hidden w-14 shrink-0 text-right tabular-nums sm:block">{nd(l.kda)}</span>
                <span className="hidden w-14 shrink-0 text-right tabular-nums text-muted sm:block">{NUMBER.format(l.share)} %</span>
                {/* Phone width: the columns that do not fit wrap under the name. */}
                <dl className="flex w-full flex-wrap gap-x-3 pl-[calc(1.5rem+0.75rem+28px+0.5rem)] text-[11px] text-muted sm:hidden">
                  <div className="flex gap-1">
                    <dt>V-D</dt>
                    <dd className="tabular-nums text-foreground">
                      {l.wins}-{l.losses}
                    </dd>
                  </div>
                  <div className="flex gap-1">
                    <dt>KDA</dt>
                    <dd className="tabular-nums text-foreground">{nd(l.kda)}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt>part</dt>
                    <dd className="tabular-nums text-foreground">{NUMBER.format(l.share)} %</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
