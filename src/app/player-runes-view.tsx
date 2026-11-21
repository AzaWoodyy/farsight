"use client";

import { type ReactNode, useMemo, useState } from "react";
import { type ChampionRune, type PlayerRunes, type RuneKind, type RuneTree } from "@/lib/agent/types";
import { treeIcon } from "@/lib/domain/rune-icons";
import { compareText } from "@/lib/locale";
import { ChampionIcon, compareFigures, Gauge, ITEM_WINRATE_MIN_GAMES, Label, SetupLine, SortHeader, useFigures } from "./champion-view";
import { useLocale, useUi } from "./i18n/locale-context";

const toneOf = (kind: RuneKind) => (kind === "shard" ? "light" : undefined);

type KeystoneKey = "rune" | "games" | "winrate";

const winrateOf = (games: number, wins: number) => (games >= ITEM_WINRATE_MIN_GAMES ? (100 * wins) / games : null);

function Winrate({ games, wins }: { games: number; wins: number }) {
  const ui = useUi();
  const wr = winrateOf(games, wins);
  const record = `${wins}-${games - wins}`;

  return (
    <span className={`w-14 shrink-0 text-right tabular-nums ${wr == null ? "text-muted" : ""}`} title={wr == null ? ui.champion.winrateHiddenTitle(ITEM_WINRATE_MIN_GAMES, record) : record}>
      {wr == null ? (
        <>
          <Label>{ui.record}</Label>
          {record}
          <span className="sr-only">, {ui.champion.winrateHidden(ITEM_WINRATE_MIN_GAMES)}</span>
        </>
      ) : (
        <>
          <Label>winrate</Label>
          {ui.percent(Math.round(wr))}
        </>
      )}
    </span>
  );
}

function Heading({ id, children, count }: { id: string; children: string; count?: string }) {
  return (
    <h3 id={id} className="text-[11px] text-muted">
      ── {children}
      {count && <span className="text-muted/80"> · {count}</span>}
    </h3>
  );
}

export function PlayerRunesView({ r, fallback }: { r: PlayerRunes; fallback: ReactNode }) {
  const ui = useUi();
  const t = ui.runes;
  const { pct } = useFigures();
  const [asTable, setAsTable] = useState(false);
  const keystones = r.runes.filter((x) => x.kind === "keystone");

  const facts = [
    { label: t.games, value: String(r.games) },
    { label: t.record, value: `${r.wins}-${r.games - r.wins} · ${pct(r.wins, r.games)}` },
    { label: t.keystoneKnown, value: t.of(r.keystoneGames, r.games) },
    { label: t.pageKnown, value: t.of(r.pageGames, r.games) },
  ];

  return (
    <div className="mt-4">
      <div className="border border-line">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-3 py-2 text-xs">
          <p className="flex min-w-0 flex-wrap items-center gap-x-1.5">
            <span translate="no" className="font-semibold">
              {r.player}
            </span>
            <span className="text-muted">· {r.scope || ui.allCompetitions}</span>
            {r.champion && (
              <span className="inline-flex items-center gap-1 text-muted">
                ·
                <ChampionIcon name={r.champion.name} src={r.champion.icon} size={16} />
                <span translate="no" className="text-foreground">
                  {r.champion.name}
                </span>
              </span>
            )}
            {r.role && <span className="text-muted">· {r.role}</span>}
          </p>
          <button
            type="button"
            onClick={() => setAsTable(!asTable)}
            aria-pressed={asTable}
            className="tap border border-dashed border-line px-2 py-0.5 text-muted transition-colors duration-150 hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent active:scale-[0.97]"
          >
            {asTable ? t.runesView : ui.champion.tableView}
          </button>
        </div>
        <dl className="grid grid-cols-2 text-xs sm:grid-cols-4">
          {facts.map((d) => (
            <div key={d.label} className="border-b border-dashed border-line px-3 py-2 sm:border-b-0 [&:nth-child(odd)]:border-r sm:border-r sm:last:border-r-0">
              <dt className="text-[11px] text-muted">{d.label}</dt>
              <dd className="tabular-nums">{d.value}</dd>
            </div>
          ))}
        </dl>
        {r.notes.length > 0 && (
          <div className="border-t border-line px-3 py-2">
            {r.notes.map((n) => (
              <p key={n} className="text-[11px] text-warn">
                {n}
              </p>
            ))}
          </div>
        )}
      </div>

      {asTable ? (
        <div className="[&>div]:mt-2">{fallback}</div>
      ) : keystones.length === 0 ? (
        <p className="mt-2 border border-line px-3 py-2 text-xs text-muted">{t.noRunes}</p>
      ) : (
        <>
          <Keystones keystones={keystones} of={r.keystoneGames} />
          <Trees trees={r.trees} keystoneGames={r.keystoneGames} pageGames={r.pageGames} />
          {r.pageGames > 0 && (
            <>
              <RunesByTree runes={r.runes} of={r.pageGames} />
              <Pages r={r} />
            </>
          )}
        </>
      )}
    </div>
  );
}

function Keystones({ keystones, of }: { keystones: ChampionRune[]; of: number }) {
  const ui = useUi();
  const locale = useLocale();
  const t = ui.runes;
  const { pct } = useFigures();
  const [sort, setSort] = useState<{ key: KeystoneKey; dir: 1 | -1 }>({ key: "games", dir: -1 });

  const lines = useMemo(
    () =>
      [...keystones].sort((a, b) => {
        const order =
          sort.key === "rune" ? compareText(locale, a.rune, b.rune) : sort.key === "games" ? a.games - b.games : compareFigures(winrateOf(a.games, a.wins), winrateOf(b.games, b.wins), sort.dir);

        return order * sort.dir || b.games - a.games;
      }),
    [keystones, sort, locale],
  );

  const toggle = (key: KeystoneKey) => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "rune" ? 1 : -1 }));

  const header = (key: KeystoneKey, label: string, title: string, className: string) => (
    <SortHeader active={sort.key === key} dir={sort.dir} label={label} title={title} className={className} onClick={() => toggle(key)} />
  );

  return (
    <section aria-labelledby="runes-keystones" className="mt-2 border border-line">
      <div className="px-3 pt-2">
        <Heading id="runes-keystones" count={ui.champion.gameCount(of)}>
          {t.keystones}
        </Heading>
      </div>
      <div className="mt-2 flex items-center gap-2 border-y border-line px-3 py-2 text-xs tracking-normal text-muted uppercase sm:gap-3 sm:tracking-wider">
        <span className="w-5 shrink-0">#</span>
        {header("rune", t.rune, ui.champion.alphabetical, "min-w-0 flex-1 text-left")}
        <span className="w-16 shrink-0 text-right">{header("games", ui.gamesLabel, t.keystonesNote, "w-full text-right")}</span>
        <span className="w-14 shrink-0 text-right sm:w-16">{header("winrate", "winrate", ui.champion.winrateOfGames, "w-full text-right")}</span>
      </div>
      <ol>
        {lines.map((k, i) => (
          <li key={k.rune} className="flex items-center gap-2 border-b border-dashed border-line px-3 py-2 text-xs last:border-0 sm:gap-3">
            <span className="w-5 shrink-0 tabular-nums text-muted">{i + 1}</span>
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <ChampionIcon name={k.rune} src={k.icon} size={36} />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                  <span className="text-sm leading-tight" translate="no">
                    {k.rune}
                  </span>
                  {k.tree && (
                    <span className="text-[11px] text-muted" translate="no">
                      {k.tree}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <Gauge share={of ? k.games / of : 0} label={ui.champion.shareOfGames(k.rune, pct(k.games, of))} />
                  <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-muted">{pct(k.games, of)}</span>
                </div>
              </div>
            </div>
            <span className="w-16 shrink-0 text-right font-semibold tabular-nums text-accent">
              <Label>{ui.gamesLabel}</Label>
              {k.games}
            </span>
            <span className="flex w-14 shrink-0 justify-end sm:w-16">
              <Winrate games={k.games} wins={k.wins} />
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Trees({ trees, keystoneGames, pageGames }: { trees: RuneTree[]; keystoneGames: number; pageGames: number }) {
  const ui = useUi();
  const t = ui.runes;

  const part = (which: RuneTree["part"], title: string, of: number) => {
    const shown = trees.filter((x) => x.part === which);

    return (
      <section aria-labelledby={`runes-tree-${which}`} className="min-w-0 px-3 py-2">
        <Heading id={`runes-tree-${which}`} count={ui.champion.gameCount(of)}>
          {title}
        </Heading>
        {shown.length > 0 ? (
          <ol className="mt-2 border border-line">
            {shown.map((x, i) => (
              <SetupLine key={x.tree} rank={i + 1} icons={[{ name: x.tree, src: treeIcon(x.tree) }]} name={x.tree} games={x.games} wins={x.wins} of={of} winrate={<Winrate games={x.games} wins={x.wins} />} />
            ))}
          </ol>
        ) : (
          <p className="mt-1 text-xs text-muted">{t.noPages}</p>
        )}
      </section>
    );
  };

  return (
    <div className="mt-2 border border-line">
      <div className="grid md:grid-cols-2">
        <div className="min-w-0 border-b border-line md:border-r md:border-b-0">{part("primary", t.primaryTree, keystoneGames)}</div>
        <div className="min-w-0">{part("secondary", t.secondaryTree, pageGames)}</div>
      </div>
      <p className="border-t border-line px-3 py-1.5 text-[10px] text-muted">{t.treesNote}</p>
    </div>
  );
}

const PAGE_PARTS = ["primary", "secondary", "shard"] as const;

function RunesByTree({ runes, of }: { runes: ChampionRune[]; of: number }) {
  const ui = useUi();
  const t = ui.runes;
  const parts = PAGE_PARTS.filter((k) => runes.some((r) => r.kind === k));
  const [part, setPart] = useState<(typeof PAGE_PARTS)[number]>(parts[0] ?? "primary");
  const shown = runes.filter((r) => r.kind === part);
  const groups = [...new Set(shown.map((r) => r.tree ?? ""))].map((tree) => ({ tree, runes: shown.filter((r) => (r.tree ?? "") === tree) }));

  return (
    <section aria-labelledby="runes-by-tree" className="mt-2 border border-line px-3 py-2">
      <Heading id="runes-by-tree" count={ui.champion.gameCount(of)}>
        {t.byTree}
      </Heading>
      <div role="group" aria-label={ui.champion.runePart} className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        {parts.map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={part === k}
            onClick={() => setPart(k)}
            className={`tap press border px-2 py-0.5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${
              part === k ? "border-accent text-accent" : "border-dashed border-line text-muted hover:border-accent hover:text-accent"
            }`}
          >
            {ui.champion.runeKinds[k]}
          </button>
        ))}
      </div>
      <div className={`mt-2 grid gap-2 ${groups.length > 1 ? "md:grid-cols-2" : ""}`}>
        {groups.map((g) => (
          <div key={g.tree} className="min-w-0">
            {g.tree && (
              <p className="mb-1 flex items-center gap-1.5 text-[11px] text-muted" translate="no">
                {treeIcon(g.tree) && <ChampionIcon name={g.tree} src={treeIcon(g.tree)} size={16} />}
                {g.tree}
              </p>
            )}
            <ol aria-label={g.tree ? t.treeRunes(g.tree, g.runes.length) : ui.champion.runeKinds.shard} className="border border-line">
              {g.runes.map((x, i) => (
                <SetupLine key={x.rune} rank={i + 1} icons={[{ name: x.rune, src: x.icon, tone: toneOf(x.kind) }]} name={x.rune} games={x.games} wins={x.wins} of={of} winrate={<Winrate games={x.games} wins={x.wins} />} />
              ))}
            </ol>
          </div>
        ))}
      </div>
      <p className="mt-1 text-[10px] text-muted">{t.byTreeNote}</p>
    </section>
  );
}

function Pages({ r }: { r: PlayerRunes }) {
  const ui = useUi();
  const t = ui.runes;
  const { pct } = useFigures();

  return (
    <section aria-labelledby="runes-pages" className="mt-2 border border-line px-3 py-2">
      <Heading id="runes-pages" count={ui.champion.gameCount(r.pageGames)}>
        {t.pages}
      </Heading>
      <ol className="mt-2 border border-line">
        {r.pages.map((p, i) => {
          const names = p.runes.map((x) => x.rune).join(", ");

          return (
            <li key={names} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-dashed border-line px-2 py-2 text-xs last:border-0">
              <span className="w-5 shrink-0 tabular-nums text-muted">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <ul aria-label={t.pageRunes} className="flex flex-wrap items-center gap-1">
                  {p.runes.map((x, j) => (
                    <li key={`${x.kind}-${x.rune}`} className={x.kind === "secondary" && p.runes[j - 1]?.kind !== "secondary" ? "ml-2" : ""} title={x.tree ? `${x.rune} · ${x.tree}` : x.rune}>
                      <ChampionIcon name={x.rune} src={x.icon} size={x.kind === "keystone" ? 28 : 20} />
                      <span className="sr-only">{x.rune}</span>
                    </li>
                  ))}
                </ul>
                <p aria-hidden className="mt-1 text-[10px] leading-snug text-muted" translate="no">
                  {names}
                </p>
              </div>
              <span className="w-14 shrink-0 text-right font-semibold tabular-nums text-accent">
                <Label>{ui.gamesLabel}</Label>
                {p.games}
                <span className="block text-[10px] font-normal text-muted">
                  <Label>{ui.champion.share}</Label>
                  {pct(p.games, r.pageGames)}
                </span>
              </span>
              <Winrate games={p.games} wins={p.wins} />
            </li>
          );
        })}
      </ol>
      <p className="mt-1 text-[10px] text-muted">{t.pagesNote}</p>
    </section>
  );
}
