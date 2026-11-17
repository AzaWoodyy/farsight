"use client";

import { type ReactNode, useMemo, useState } from "react";
import { type ChampionItem, type ChampionItems, type ChampionPool as Pool, type ChampionProfile as Profile, type ChampionSetups, RUNE_KINDS, type RuneKind } from "@/lib/agent/types";
import { type ChampionRanking as Ranking, formatChampionValue } from "@/lib/champions";
import { ITEM_KIND_LABEL, ITEM_KINDS, type ItemKind } from "@/lib/domain/items";
import { compareText, numberFormat } from "@/lib/locale";
import { useLocale, useUi } from "./i18n/locale-context";

/** Figures written in the language of the page: a number, a possibly missing one, a share of a total. */
function useFigures() {
  const number = numberFormat(useLocale(), 2);
  const ui = useUi();

  return {
    number,
    nd: (v: number | null, signed = false) => (v == null ? ui.noData : `${signed && v > 0 ? "+" : v < 0 ? "−" : ""}${number.format(Math.abs(v))}`),
    pct: (n: number, d: number) => (d ? ui.percent(Math.round((100 * n) / d)) : ui.noData),
  };
}

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

/** A figure's name for screen readers, where the column header is only visual. */
const Label = ({ children }: { children: string }) => <span className="sr-only">{children} : </span>;

/**
 * A sortable column header. Its accessible name keeps the visible label and adds the sort state, since
 * these lists are not tables and cannot carry `aria-sort`.
 */
function SortHeader({ active, dir, label, title, className, onClick }: { active: boolean; dir: 1 | -1; label: string; title: string; className: string; onClick: () => void }) {
  const ui = useUi();

  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      // A button does not inherit capitals from its row: set here, as in the plain table's headers.
      className={`${className} whitespace-nowrap uppercase hover:text-accent pointer-coarse:min-h-11 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${active ? "text-foreground" : ""}`}
    >
      <span className="sr-only">{ui.champion.sortBy}</span>
      {label}
      <span aria-hidden className="ml-1 inline-block w-2">
        {active ? (dir === 1 ? "↑" : "↓") : ""}
      </span>
      {active && <span className="sr-only">{dir === 1 ? ui.champion.ascending : ui.champion.descending}</span>}
    </button>
  );
}

/** How many metrics sit beside the ranking one in the champion view. */
const SIDE_METRICS = 5;

/** Champions ranked: one line per champion, a gauge on the ranking metric, the other metrics beside it. */
export function ChampionRankingView({ ranking, fallback }: { ranking: Ranking; fallback: ReactNode }) {
  const locale = useLocale();
  const ui = useUi();
  const [asTable, setAsTable] = useState(false);
  const primary = ranking.metrics[ranking.primary];
  const max = Math.max(...ranking.lines.map((l) => Math.abs(l.values[ranking.primary] ?? 0)), 0);
  const rest = ranking.metrics.map((m, i) => ({ m, i })).filter(({ i }) => i !== ranking.primary);
  // A ranking can hold fifteen figures: the champion view keeps the first ones beside the gauge, the table view has them all.
  const others = rest.slice(0, SIDE_METRICS);
  const hidden = rest.length - others.length;

  return (
    <div className="mt-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <p className="text-muted">
          {ui.champion.rankedBy} <span className="text-foreground">{primary.label}</span> · {ui.champion.count(ranking.lines.length)}
          {hidden > 0 && !asTable ? ui.champion.hiddenColumns(hidden) : ""}
        </p>
        <button
          type="button"
          onClick={() => setAsTable(!asTable)}
          aria-pressed={asTable}
          className="tap border border-dashed border-line px-2 py-0.5 text-muted transition-colors duration-150 hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent active:scale-[0.97]"
        >
          {asTable ? ui.champion.championsView : ui.champion.tableView}
        </button>
      </div>
      {asTable ? (
        // The plain table starts where the champion list does: switching views changes the content, not its place.
        <div className="[&>div]:mt-0">{fallback}</div>
      ) : (
        <div className="border border-line">
          {/* Same header as the plain table (height, size, capitals): switching views keeps it in place. */}
          <div aria-hidden className="hidden items-center gap-3 border-b border-line px-3 py-2 text-xs tracking-wider text-muted uppercase sm:flex">
            <span className="w-8 shrink-0">#</span>
            <span className="min-w-0 flex-1">champion</span>
            <span className="w-24 shrink-0 text-right text-foreground">{primary.label}</span>
            {others.map(({ m }) => (
              <span key={m.key} className="w-24 shrink-0 text-right">
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
                        <Gauge share={max ? Math.abs(value ?? 0) / max : 0} label={`${primary.label} : ${formatChampionValue(value, primary.percent, locale)}`} />
                      </div>
                    </div>
                  </div>
                  <span aria-hidden className="text-right font-semibold tabular-nums text-accent sm:w-24 sm:shrink-0">{formatChampionValue(value, primary.percent, locale)}</span>
                  {/* Phone width: the other metrics wrap under the name; wider: one column each. */}
                  <dl className="col-span-3 col-start-1 flex flex-wrap gap-x-3 gap-y-0.5 pl-[calc(2rem+0.75rem+28px+0.5rem)] text-[11px] text-muted sm:hidden">
                    {others.map(({ m, i }) => (
                      <div key={m.key} className="flex gap-1">
                        <dt>{m.label}</dt>
                        <dd className="tabular-nums text-foreground">{formatChampionValue(l.values[i], m.percent, locale)}</dd>
                      </div>
                    ))}
                  </dl>
                  {others.map(({ m, i }) => (
                    <span key={m.key} className="hidden w-24 shrink-0 text-right tabular-nums sm:block">
                      <Label>{m.label}</Label>
                      {formatChampionValue(l.values[i], m.percent, locale)}
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
  const ui = useUi();
  const { nd, pct } = useFigures();
  const presence = p.games ? (p.picks + p.bans) / p.games : 0;
  const losses = p.picks - p.wins;
  const maxRole = Math.max(1, ...p.roles.map((r) => r.games));

  const draft = [
    { label: "picks", value: String(p.picks) },
    { label: "bans", value: String(p.bans) },
    { label: ui.champion.wins, value: p.picks ? `${p.wins}-${losses} · ${pct(p.wins, p.picks)}` : ui.noData },
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
            {p.scope || ui.allCompetitions} · {ui.champion.gameCount(p.games)}
          </div>
          <div className="mt-2 flex items-center gap-2 text-[11px]">
            <span className="shrink-0 text-muted">{ui.champion.presence}</span>
            <Gauge share={presence} label={`${ui.champion.presence} ${pct(p.picks + p.bans, p.games)}`} />
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
          ── {ui.champion.averages}
        </h3>
        <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          {p.averages.map((a) => (
            <div key={a.key} className="flex items-baseline justify-between gap-2 border-b border-dashed border-line/60 py-0.5">
              <dt className="truncate text-muted">{a.label}</dt>
              <dd className="shrink-0 tabular-nums" title={a.counted < p.picks ? ui.champion.countedOn(a.counted, p.picks) : undefined}>
                {nd(a.value, a.signed)}
                {a.value != null && a.counted < p.picks && <span className="ml-1 text-[10px] text-muted">({a.counted})</span>}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-1 text-[10px] text-muted">
          {ui.champion.averagesNote}
        </p>
      </section>

      <div className="grid sm:grid-cols-2">
        <section aria-labelledby="champion-players" className="border-b border-line px-3 py-2 sm:border-b-0 sm:border-r">
          <h3 id="champion-players" className="text-[11px] text-muted">
            ── {ui.champion.players}
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
                  <span className="text-right tabular-nums">{pl.games} {ui.champion.gamesShort}</span>
                  <span className="text-right tabular-nums" title={ui.champion.winrateTitle}>
                    {pct(pl.wins, pl.games)}
                  </span>
                  <span className="text-right tabular-nums text-muted">KDA {nd(pl.kda)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-muted">{ui.champion.noPick}</p>
          )}
        </section>
        <section aria-labelledby="champion-roles" className="px-3 py-2">
          <h3 id="champion-roles" className="text-[11px] text-muted">
            ── {ui.champion.roles}
          </h3>
          {p.roles.length ? (
            <ul className="mt-1 space-y-1 text-xs">
              {p.roles.map((r) => (
                <li key={r.role} className="grid grid-cols-[4.5rem_1fr_3.5rem] items-center gap-2">
                  <span>{r.role}</span>
                  <Gauge share={r.games / maxRole} label={`${r.role} : ${ui.champion.gameCount(r.games)}`} />
                  <span className="text-right tabular-nums text-muted">{r.games}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-muted">{ui.noData}</p>
          )}
        </section>
      </div>

      <ChampionItemsSection key={`${p.champion}|${p.scope}`} items={p.items} />
      <ChampionSetupsSection key={`setups|${p.champion}|${p.scope}`} setups={p.setups} />
    </div>
  );
}

type ItemSortKey = "item" | "games" | "winrate";

/** Lines shown per list of spells or runes. */
const SETUP_LINES = 6;

/** One spell pair or rune: icons, name, share of the games that have the data, games and win rate. */
function SetupLine({ rank, icons, name, games, wins, of }: { rank: number; icons: { name: string; src: string | null }[]; name: string; games: number; wins: number; of: number }) {
  const ui = useUi();
  const { pct } = useFigures();
  const wr = games >= ITEM_WINRATE_MIN_GAMES ? (100 * wins) / games : null;

  return (
    <li className="flex items-center gap-3 border-b border-dashed border-line px-2 py-1.5 text-xs last:border-0">
      <span className="w-5 shrink-0 tabular-nums text-muted">{rank}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="flex shrink-0 gap-0.5">
          {icons.map((i) => (
            <ChampionIcon key={i.name} name={i.name} src={i.src} size={24} />
          ))}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate" translate="no" title={name}>
            {name}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <Gauge share={of ? games / of : 0} label={ui.champion.shareOfGames(name, pct(games, of))} />
            <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-muted">{pct(games, of)}</span>
          </div>
        </div>
      </div>
      <span className="w-14 shrink-0 text-right font-semibold tabular-nums text-accent">
        <Label>{ui.gamesLabel}</Label>
        {games}
      </span>
      <span className={`w-14 shrink-0 text-right tabular-nums ${wr == null ? "text-muted" : ""}`} title={`${wins}-${games - wins}`}>
        <Label>winrate</Label>
        {wr == null ? (
          <>
            <span aria-hidden>·</span>
            <span className="sr-only">{ui.champion.winrateHidden(ITEM_WINRATE_MIN_GAMES)}</span>
          </>
        ) : (
          ui.percent(Math.round(wr))
        )}
      </span>
    </li>
  );
}

/** The champion's summoner spell pairs and runes (by part of the page), from the scoreboards: share of the games that list them. */
function ChampionSetupsSection({ setups }: { setups: ChampionSetups }) {
  const ui = useUi();
  const kinds = RUNE_KINDS.filter((k) => setups.runes.some((r) => r.kind === k));
  const [kind, setKind] = useState<RuneKind>(kinds[0] ?? "keystone");
  const runes = setups.runes.filter((r) => r.kind === kind).slice(0, SETUP_LINES);
  const runeGames = kind === "keystone" ? setups.keystoneGames : setups.pageGames;

  if (!setups.spells.length && !setups.runes.length && !setups.notes.length) return null;

  return (
    <section aria-labelledby="champion-setups" className="border-t border-line px-3 py-2">
      <h3 id="champion-setups" className="text-[11px] text-muted">
        ── {ui.champion.setups} <span className="text-muted/80">{ui.champion.setupsSource}</span>
      </h3>

      <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
        {setups.spells.length > 0 && (
          <div className="min-w-0">
            <p className="text-[11px] text-muted">{ui.champion.spellGames(setups.spellGames)}</p>
            <ol className="mt-1 border border-line">
              {setups.spells.slice(0, SETUP_LINES).map((s, i) => (
                <SetupLine
                  key={s.spells.map((x) => x.name).join("+")}
                  rank={i + 1}
                  icons={s.spells.map((x) => ({ name: x.name, src: x.iconUrl }))}
                  name={s.spells.map((x) => x.name).join(" + ")}
                  games={s.games}
                  wins={s.wins}
                  of={setups.spellGames}
                />
              ))}
            </ol>
          </div>
        )}

        {setups.runes.length > 0 && (
          <div className="min-w-0">
            <div role="group" aria-label={ui.champion.runePart} className="flex flex-wrap items-center gap-1.5 text-[11px]">
              {kinds.map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={kind === k}
                  onClick={() => setKind(k)}
                  className={`tap press border px-2 py-0.5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${
                    kind === k ? "border-accent text-accent" : "border-dashed border-line text-muted hover:border-accent hover:text-accent"
                  }`}
                >
                  {ui.champion.runeKinds[k]}
                </button>
              ))}
              <span className="text-muted">· {ui.champion.gameCount(runeGames)}</span>
            </div>
            <ol className="mt-1 border border-line">
              {runes.map((r, i) => (
                <SetupLine key={r.rune} rank={i + 1} icons={[{ name: r.rune, src: r.icon }]} name={r.tree ? `${r.rune} · ${r.tree}` : r.rune} games={r.games} wins={r.wins} of={runeGames} />
              ))}
            </ol>
          </div>
        )}
      </div>

      {setups.notes.map((n) => (
        <p key={n} className="mt-1 text-[10px] text-warn">
          {n}
        </p>
      ))}
    </section>
  );
}

/** Below this many games, an item's win rate is not shown: one game more or less swings it too much. */
const ITEM_WINRATE_MIN_GAMES = 5;

/** Lines shown before "voir tout". */
const ITEM_LINES = 8;

const winrateOf = (i: ChampionItem) => (i.games >= ITEM_WINRATE_MIN_GAMES ? (100 * i.wins) / i.games : null);

/**
 * The champion's most built items: end-of-game inventories, filtered by kind (completed items first),
 * each line with its share of the champion's games and, on enough games, its win rate.
 */
function ChampionItemsSection({ items }: { items: ChampionItems }) {
  const locale = useLocale();
  const ui = useUi();
  const { pct } = useFigures();

  const columns: { key: ItemSortKey; label: string; title: string }[] = [
    { key: "games", label: ui.gamesLabel, title: ui.champion.itemGamesTitle },
    { key: "winrate", label: "winrate", title: ui.champion.itemWinrateTitle(ITEM_WINRATE_MIN_GAMES) },
  ];

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
          const order = sort.key === "item" ? compareText(locale, a.item, b.item) : compareFigures(sort.key === "games" ? a.games : winrateOf(a), sort.key === "games" ? b.games : winrateOf(b), sort.dir);

          return order * sort.dir || b.games - a.games;
        }),
    [items.items, kind, sort, locale],
  );

  const shown = all ? lines : lines.slice(0, ITEM_LINES);
  const max = Math.max(...lines.map((l) => l.games), 0);

  const toggle = (key: ItemSortKey) => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "item" ? 1 : -1 }));

  const header = (key: ItemSortKey, label: string, title: string, className: string) => (
    <SortHeader active={sort.key === key} dir={sort.dir} label={label} title={title} className={className} onClick={() => toggle(key)} />
  );

  return (
    <section aria-labelledby="champion-items" className="border-t border-line px-3 py-2">
      <h3 id="champion-items" className="text-[11px] text-muted">
        ── {ui.champion.itemsHeading} <span className="text-muted/80">{ui.champion.itemsSource(items.games)}</span>
      </h3>

      {items.items.length > 0 && (
        <>
          <div role="group" aria-label={ui.champion.itemKind} className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
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
                {k === "all" ? ui.champion.all : ITEM_KIND_LABEL[locale][k]} <span className="tabular-nums">{counts.get(k)}</span>
              </button>
            ))}
          </div>

          <div className="mt-2 border border-line">
            <div className="flex items-center gap-3 border-b border-line px-2 py-1 text-[11px] text-muted">
              <span className="w-5 shrink-0">#</span>
              {header("item", "item", ui.champion.alphabetical, "min-w-0 flex-1 text-left")}
              {columns.map((c) => (
                <span key={c.key} className="w-16 shrink-0 text-right">
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
                        <div className="truncate" translate="no" title={l.kind ? `${l.item} (${ITEM_KIND_LABEL[locale][l.kind]})` : l.item}>
                          {l.item}
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          <Gauge share={max ? l.games / max : 0} label={ui.champion.shareOfGames(l.item, pct(l.games, items.games))} />
                          <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-muted">{pct(l.games, items.games)}</span>
                        </div>
                      </div>
                    </div>
                    <span className="w-16 shrink-0 text-right font-semibold tabular-nums text-accent">
                      <Label>{ui.gamesLabel}</Label>
                      {l.games}
                    </span>
                    <span
                      className={`w-16 shrink-0 text-right tabular-nums ${wr == null ? "text-muted" : ""}`}
                      title={wr == null ? ui.champion.winrateHiddenTitle(ITEM_WINRATE_MIN_GAMES, `${l.wins}-${l.games - l.wins}`) : `${l.wins}-${l.games - l.wins}`}
                    >
                      <Label>winrate</Label>
                      {wr == null ? (
                        <>
                          <span aria-hidden>·</span>
                          <span className="sr-only">{ui.champion.winrateHidden(ITEM_WINRATE_MIN_GAMES)}</span>
                        </>
                      ) : (
                        ui.percent(Math.round(wr))
                      )}
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
              {all ? ui.champion.collapse : ui.champion.showItems(lines.length)}
            </button>
          )}
        </>
      )}

      {items.items.length === 0 && !items.notes.length && <p className="mt-1 text-xs text-muted">{ui.champion.noPick}</p>}
      {items.notes.map((n) => (
        <p key={n} className="mt-1 text-[10px] text-warn">
          {n}
        </p>
      ))}
      {items.items.length > 0 && (
        <p className="mt-1 text-[10px] text-muted">
          {ui.champion.itemsNote(ITEM_WINRATE_MIN_GAMES)}
        </p>
      )}
    </section>
  );
}

type PoolKey = "games" | "wins" | "winrate" | "kda" | "share" | "champion";


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
  const locale = useLocale();
  const ui = useUi();
  const { number, nd, pct } = useFigures();

  const columns: { key: PoolKey; label: string; title: string }[] = [
    { key: "games", label: ui.gamesLabel, title: ui.champion.poolGamesTitle },
    { key: "wins", label: ui.record, title: ui.champion.recordTitle },
    { key: "winrate", label: "winrate", title: ui.champion.winrateOfGames },
    { key: "kda", label: "KDA", title: ui.champion.kdaTitle },
    { key: "share", label: ui.champion.share, title: ui.champion.shareTitle },
  ];

  const [asTable, setAsTable] = useState(false);
  const [sort, setSort] = useState<{ key: PoolKey; dir: 1 | -1 }>({ key: "games", dir: -1 });

  const lines = useMemo(
    () =>
      [...pool.lines].sort((a, b) => {
        const order = sort.key === "champion" ? compareText(locale, a.champion, b.champion) : compareFigures(a[sort.key], b[sort.key], sort.dir);

        // Ties keep the most played first.
        return order * sort.dir || b.games - a.games;
      }),
    [pool.lines, sort, locale],
  );

  const maxShare = Math.max(...pool.lines.map((l) => l.share), 0);
  const team = pool.subject === "team";

  const toggle = (key: PoolKey) => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "champion" ? 1 : -1 }));

  const header = (key: PoolKey, label: string, title: string, className: string) => (
    <SortHeader active={sort.key === key} dir={sort.dir} label={label} title={title} className={className} onClick={() => toggle(key)} />
  );

  const diversity = [
    { label: ui.gamesLabel, value: String(pool.games) },
    { label: ui.champion.result, value: `${pool.wins}-${pool.losses} · ${pct(pool.wins, pool.games)}` },
    { label: ui.champion.unique, value: String(pool.unique) },
    { label: ui.champion.top3Share, value: ui.percent(number.format(pool.top3Share)) },
  ];

  return (
    <div className="mt-4">
      <div className="border border-line">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-3 py-2 text-xs">
          <p className="min-w-0 truncate">
            <span translate="no" className="font-semibold">
              {pool.name}
            </span>
            <span className="text-muted"> · {pool.scope || ui.allCompetitions}</span>
          </p>
          <button
            type="button"
            onClick={() => setAsTable(!asTable)}
            aria-pressed={asTable}
            className="tap border border-dashed border-line px-2 py-0.5 text-muted transition-colors duration-150 hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent active:scale-[0.97]"
          >
            {asTable ? ui.champion.championsView : ui.champion.tableView}
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
          <Gauge share={pool.top3Share / 100} label={ui.champion.top3(ui.percent(number.format(pool.top3Share)))} />
          <span className="shrink-0 text-muted">
            {team ? ui.champion.picks(pool.picks) : ui.champion.gameCount(pool.games)}
          </span>
        </div>
      </div>

      {asTable ? (
        // Same gap as the champion list: switching views changes the content, not its place.
        <div className="[&>div]:mt-2">{fallback}</div>
      ) : (
        <div className="mt-2 border border-line">
          {/* Same header as the plain table (height, size, capitals): switching views keeps it in place. */}
          <div className="flex items-center gap-3 border-b border-line px-3 py-2 text-xs tracking-wider text-muted uppercase">
            <span className="w-6 shrink-0">#</span>
            {header("champion", "champion", ui.champion.alphabetical, "min-w-0 flex-1 text-left")}
            {columns.map((c) => (
              <span key={c.key} className={c.key === "games" || c.key === "winrate" ? "w-20 shrink-0 text-right" : "hidden w-20 shrink-0 text-right sm:block"}>
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
                      <Gauge share={maxShare ? l.share / maxShare : 0} label={ui.champion.poolShare(ui.percent(number.format(l.share)))} />
                    </div>
                  </div>
                </div>
                <span className="w-20 shrink-0 text-right font-semibold tabular-nums text-accent">
                  <Label>{ui.gamesLabel}</Label>
                  {l.games}
                </span>
                <span className="hidden w-20 shrink-0 text-right tabular-nums sm:block">
                  <Label>{ui.record}</Label>
                  {l.wins}-{l.losses}
                </span>
                <span className="w-20 shrink-0 text-right tabular-nums">
                  <Label>winrate</Label>
                  {ui.percent(number.format(l.winrate))}
                </span>
                <span className="hidden w-20 shrink-0 text-right tabular-nums sm:block">
                  <Label>KDA</Label>
                  {nd(l.kda)}
                </span>
                <span className="hidden w-20 shrink-0 text-right tabular-nums text-muted sm:block">
                  <Label>{ui.champion.share}</Label>
                  {ui.percent(number.format(l.share))}
                </span>
                {/* Phone width: the columns that do not fit wrap under the name. */}
                <dl className="flex w-full flex-wrap gap-x-3 pl-[calc(1.5rem+0.75rem+28px+0.5rem)] text-[11px] text-muted sm:hidden">
                  <div className="flex gap-1">
                    <dt>{ui.record}</dt>
                    <dd className="tabular-nums text-foreground">
                      {l.wins}-{l.losses}
                    </dd>
                  </div>
                  <div className="flex gap-1">
                    <dt>KDA</dt>
                    <dd className="tabular-nums text-foreground">{nd(l.kda)}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt>{ui.champion.share}</dt>
                    <dd className="tabular-nums text-foreground">{ui.percent(number.format(l.share))}</dd>
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
