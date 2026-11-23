import type { ReactNode } from "react";
import { type ComparedStat, detectComparison, formatStat, rowWinner } from "@/lib/comparison";
import { dateFormat, numberFormat, percent } from "@/lib/locale";
import { AskLink } from "./ask-link";
import { EntityIcon } from "./entity-icon";
import { HomeProofPager } from "./home-proof-pager";
import type { HomeProof, HomeProofs, ProofOf } from "./home-proofs-data";
import type { Locale } from "./i18n/locales";
import { SHELL } from "./i18n/shell";
import { PlayerAvatar } from "./player-avatar";
import { TEXT_LINK } from "./site-footer";

const DUEL_STATS = ["derived:kda", "avg_cs", "avg_damage", "avg_gold_diff_15"];

const ROW = "grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-t border-line py-1.5";

const BIG = "shrink-0 text-6xl tracking-[-0.04em]";

type Pair = [number, number];

type Who = { name: string; detail?: string | null; image: ReactNode };

const shortName = (name: string) => name.replace(/\s*\(.*?\)\s*$/, "");

type Texts = (typeof SHELL)[Locale]["home"]["proof"];

const longDay = (locale: Locale, time: number) => dateFormat(locale, { dateStyle: "long" }).format(new Date(time));

const shortDay = (locale: Locale, time: number) => dateFormat(locale, { dateStyle: "medium" }).format(new Date(time));

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

const share = (locale: Locale, part: number, whole: number) => percent(locale, whole ? Math.round((100 * part) / whole) : 0);

const leaderOf = ([a, b]: Pair): 0 | 1 | null => (a === b ? null : a > b ? 0 : 1);

function Heads({ who }: { who: Who[] }) {
  return (
    <div className="mt-4 flex items-center justify-between gap-4">
      {who.map((w, i) => (
        <div key={w.name} className={`flex min-w-0 items-center gap-3 ${i === 1 ? "flex-row-reverse text-right" : ""}`}>
          {w.image}
          <div className="min-w-0">
            <div className="text-base leading-snug font-semibold text-balance wrap-anywhere" translate="no">
              {shortName(w.name)}
            </div>
            {w.detail && (
              <div className="truncate text-xs text-muted" title={w.detail} translate="no">
                {w.detail}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Score({ values, label, highlight = true }: { values: Pair; label: string; highlight?: boolean }) {
  const leader = highlight ? leaderOf(values) : null;
  const tone = (i: 0 | 1) => (leader === i ? "text-accent" : "");
  const bar = (i: 0 | 1) => (leader === i ? "bg-accent" : "bg-muted/50");

  return (
    <>
      <div className="mt-4 flex items-baseline justify-between gap-4 leading-none font-semibold tabular-nums">
        <span className={`${BIG} ${tone(0)}`}>{values[0]}</span>
        <span className="min-w-0 text-center text-xs leading-snug font-normal text-muted">{label}</span>
        <span className={`${BIG} ${tone(1)}`}>{values[1]}</span>
      </div>
      <div aria-hidden className="mt-3 flex h-1.5 gap-0.5">
        <span className={bar(0)} style={{ flexGrow: values[0] }} />
        <span className={bar(1)} style={{ flexGrow: values[1] }} />
      </div>
    </>
  );
}

const logo = (p: { icons: Record<string, string>; iconTones: Record<string, "dark" | "light"> }, team: string) =>
  p.icons[team] ? (
    <EntityIcon src={p.icons[team]} size={48} tone={p.iconTones[team]} />
  ) : (
    <span aria-hidden className="flex size-12 shrink-0 items-center justify-center border border-line text-base text-muted select-none">
      {team.slice(0, 2)}
    </span>
  );

const statTone = (s: ComparedStat, i: 0 | 1) => {
  const winner = rowWinner(s);

  return winner === i ? "font-semibold text-foreground" : winner == null ? "text-foreground" : "text-muted";
};

type LatestSide = NonNullable<ProofOf<"duel">["latest"]>["a"];

function LatestPick({ side, align }: { side: LatestSide; align: "left" | "right" }) {
  return (
    <span className={`flex min-w-0 items-center gap-2 ${align === "right" ? "flex-row-reverse" : ""}`}>
      {side.championIcon && <EntityIcon src={side.championIcon} size={24} />}
      <span className="truncate max-sm:hidden">{side.champion}</span>
      <span className="tabular-nums">{[side.kills, side.deaths, side.assists].map((n) => n ?? "–").join("/")}</span>
    </span>
  );
}

function Duel({ p, locale, text }: { p: ProofOf<"duel">; locale: Locale; text: Texts }) {
  const comparison = detectComparison(p.h2h, p.profiles, null, locale);
  const wins = comparison?.stats.find((s) => s.key === "wins")?.values;
  const games = comparison?.stats.find((s) => s.key === "games")?.values[0];

  if (!comparison || wins?.[0] == null || wins[1] == null || !games) return null;

  const stats = DUEL_STATS.flatMap((key) => comparison.stats.find((s) => s.key === key) ?? []);
  const lane = p.lanes.same === games && p.lanes.roles.length === 1 ? p.lanes.roles[0].role : null;

  return (
    <>
      <Heads who={comparison.players.map((c) => ({ name: c.name, detail: c.profile?.teams[0], image: <PlayerAvatar name={c.name} photo={c.profile?.photo} size={48} /> }))} />
      <Score values={[wins[0], wins[1]]} label={text.wins} />
      <p className="mt-3 text-sm">
        {text.duel.met(games)}
        {lane && text.duel.allInLane(lane)}
      </p>
      <ul className="mt-4 text-sm">
        {stats.map((s) => (
          <li key={s.key} className={ROW}>
            <span className={`tabular-nums ${statTone(s, 0)}`}>{formatStat(s, s.values[0], locale)}</span>
            <span className="text-xs text-muted">{s.label}</span>
            <span className={`text-right tabular-nums ${statTone(s, 1)}`}>{formatStat(s, s.values[1], locale)}</span>
          </li>
        ))}
        {p.latest && (
          <li className={ROW}>
            <LatestPick side={p.latest.a} align="left" />
            <span className="text-center text-xs text-muted">
              {p.latest.playedAt == null ? text.duel.game : text.duel.gameOf(shortDay(locale, p.latest.playedAt * 1000))}
            </span>
            <LatestPick side={p.latest.b} align="right" />
          </li>
        )}
      </ul>
    </>
  );
}

function Teams({ p, locale, text }: { p: ProofOf<"teams">; locale: Locale; text: Texts }) {
  return (
    <>
      <Heads who={[p.teamA, p.teamB].map((team) => ({ name: team, image: logo(p, team) }))} />
      <Score values={[p.seriesA, p.seriesB]} label={text.teams.seriesWon} />
      <p className="mt-3 text-sm">{text.teams.summary(p.seriesCount, p.gamesA, p.gamesB)}</p>
      <ul className="mt-4 text-sm">
        {p.series.map((s) => (
          <li key={`${s.label}:${s.playedAt}`} className={ROW}>
            <span className={`tabular-nums ${s.winsA > s.winsB ? "font-semibold" : "text-muted"}`}>{s.winsA}</span>
            <span className="text-center text-xs text-muted">
              {[s.label, s.playedAt != null && shortDay(locale, s.playedAt * 1000)].filter(Boolean).join(" · ")}
            </span>
            <span className={`text-right tabular-nums ${s.winsB > s.winsA ? "font-semibold" : "text-muted"}`}>{s.winsB}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Series({ p, locale, text }: { p: ProofOf<"series">; locale: Locale; text: Texts }) {
  const won = (g: ProofOf<"series">["games"][number], team: "a" | "b") =>
    g.winner === team && (
      <>
        <span className="font-semibold">{text.series.won}</span>
        {g.side && <span className="text-xs text-muted"> {text.series.side[g.side]}</span>}
      </>
    );

  return (
    <>
      <Heads who={[p.teamA, p.teamB].map((team) => ({ name: team, image: logo(p, team) }))} />
      <Score values={[p.winsA, p.winsB]} label={text.series.gamesWon} />
      <p className="mt-3 text-sm">{[p.bestOf != null && `BO${p.bestOf}`, p.playedAt != null && longDay(locale, p.playedAt * 1000)].filter(Boolean).join(", ")}</p>
      <ul className="mt-4 text-sm">
        {p.games.map((g, i) => (
          <li key={i} className={ROW}>
            <span>{won(g, "a")}</span>
            <span className="text-center text-xs text-muted tabular-nums">
              {[g.n != null && text.series.game(g.n), g.durationS != null && clock(g.durationS)].filter(Boolean).join(" · ")}
            </span>
            <span className="text-right">{won(g, "b")}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Champion({ p, locale, text }: { p: ProofOf<"champion">; locale: Locale; text: Texts }) {
  const kda = p.kda == null ? null : numberFormat(locale, 2).format(p.kda);

  return (
    <>
      <Heads who={[{ name: p.champion, detail: text.champion.presence(share(locale, p.picks + p.bans, p.games), p.games), image: p.icon && <EntityIcon src={p.icon} size={48} /> }]} />
      <div className="mt-4 flex items-baseline justify-between gap-4 leading-none font-semibold tabular-nums">
        <span className={BIG}>
          {p.picks}
          <span className="ml-2 text-xs font-normal tracking-normal text-muted">{text.champion.picks}</span>
        </span>
        <span className={`${BIG} text-accent`}>
          <span className="mr-2 text-xs font-normal tracking-normal text-muted">{text.champion.bans}</span>
          {p.bans}
        </span>
      </div>
      <div aria-hidden className="mt-3 flex h-1.5 gap-0.5">
        <span className="bg-muted/50" style={{ flexGrow: p.picks }} />
        <span className="bg-accent" style={{ flexGrow: p.bans }} />
        <span className="bg-line" style={{ flexGrow: Math.max(0, p.games - p.picks - p.bans) }} />
      </div>
      <p className="mt-3 text-sm">{text.champion.summary(p.picks, share(locale, p.wins, p.picks), kda)}</p>
      <ul className="mt-4 text-sm">
        {p.players.map((player) => (
          <li key={player.player} className="grid grid-cols-[1fr_auto] items-baseline gap-3 border-t border-line py-1.5">
            <span className="min-w-0 truncate" translate="no">
              {shortName(player.player)}
              {player.team && <span className="text-xs text-muted"> {player.team}</span>}
            </span>
            <span className="text-xs text-muted tabular-nums">{text.record(player.games, player.wins)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Runes({ p, locale, text }: { p: ProofOf<"runes">; locale: Locale; text: Texts }) {
  const most = Math.max(...p.keystones.map((k) => k.games));

  return (
    <>
      <Heads who={[{ name: p.player, detail: p.profile?.teams[0], image: <PlayerAvatar name={p.player} photo={p.profile?.photo} size={48} /> }]} />
      <Score values={[p.wins, p.games - p.wins]} label={text.runes.winsLosses} />
      <p className="mt-3 text-sm">{text.runes.summary(p.games)}</p>
      <ul className="mt-4 text-sm">
        {p.keystones.map((k) => (
          <li key={k.rune} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-t border-line py-1.5">
            {k.icon ? <EntityIcon src={k.icon} size={24} /> : <span className="size-6" />}
            <span className="min-w-0">
              <span className="block truncate" title={k.rune}>
                {k.rune}
              </span>
              <span aria-hidden className="mt-1 block h-1 bg-muted/50" style={{ width: `${(100 * k.games) / most}%` }} />
            </span>
            <span className="text-right text-xs text-muted tabular-nums">
              {text.record(k.games, k.wins)} · {share(locale, k.wins, k.games)}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Body({ p, locale, text }: { p: HomeProof; locale: Locale; text: Texts }) {
  if (p.kind === "duel") return <Duel p={p} locale={locale} text={text} />;

  if (p.kind === "teams") return <Teams p={p} locale={locale} text={text} />;

  if (p.kind === "series") return <Series p={p} locale={locale} text={text} />;

  if (p.kind === "champion") return <Champion p={p} locale={locale} text={text} />;

  return <Runes p={p} locale={locale} text={text} />;
}

export const proofScript = (count: number) =>
  `{const s=document.currentScript.parentElement,p=new URLSearchParams(location.search).get("proof"),n=p===null||p===""?NaN:Number(p),f=Number.isInteger(n)&&n>=0&&n<${count};s.setAttribute("data-proof",f?n:Math.floor(Math.random()*${count}));if(f)s.setAttribute("data-proof-fixed","")}`;

export function HomeProofsView({ locale, proofs }: { locale: Locale; proofs: HomeProofs }) {
  const text = SHELL[locale].home.proof;
  const shown = proofs[locale];

  if (!shown.length) return null;

  return (
    <div data-proofs suppressHydrationWarning className="min-w-0 lg:border-l lg:border-line lg:pl-10">
      <script dangerouslySetInnerHTML={{ __html: proofScript(shown.length) }} />
      <div className="proof-stack grid">
        {shown.map((p, i) => (
          <section key={p.kind} data-proof-item={i} aria-labelledby={`proof-${p.kind}`} className="flex min-w-0 flex-col">
            <h2 id={`proof-${p.kind}`} className="text-base font-semibold text-balance">
              {p.title}
            </h2>
            <Body p={p} locale={locale} text={text} />
            <p className="mt-auto border-t border-line pt-3 text-xs leading-relaxed text-muted">
              {text.sources}{" "}
              {p.sources.map((source, n) => (
                <span key={source.url}>
                  {n > 0 && ", "}
                  <a className={TEXT_LINK} href={source.url} target="_blank" rel="noreferrer">
                    {source.label}
                  </a>
                </span>
              ))}
              .{" "}
              <AskLink question={p.question} className={`${TEXT_LINK} text-foreground`}>
                {text.open}
              </AskLink>
            </p>
          </section>
        ))}
      </div>
      <HomeProofPager label={text.pager} titles={shown.map((p) => p.title)} />
    </div>
  );
}
