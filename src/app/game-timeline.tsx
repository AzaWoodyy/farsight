import { useLocale, useUi } from "./i18n/locale-context";
import type { Ui } from "./i18n/ui";
import type { Side, TimelineView } from "@/lib/agent/types";
import { type Locale, thousands } from "@/lib/locale";

const W = 720;
const H = 220;
const PAD = { left: 52, right: 12, top: 26, bottom: 30 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

const SIDE_CLS: Record<Side, string> = { blue: "text-blue", red: "text-red" };

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const gold = (n: number, locale: Locale) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${thousands(locale, Math.abs(n))}`;

function eventText(e: TimelineView["events"][number], t: Ui["timeline"]): string {
  if (e.kind === "grubs") return e.detail ?? t.events.grubs;

  return e.detail ? t.detailed(t.events[e.kind], e.detail) : t.events[e.kind];
}

export function GameTimeline({ timeline: t }: { timeline: TimelineView }) {
  const ui = useUi();
  const locale = useLocale();
  const { marks } = ui.timeline;
  const end = Math.max(t.durationS ?? 0, t.gold.at(-1)?.s ?? 0, 60);
  const peak = Math.max(2000, ...t.gold.map((g) => Math.abs(g.diff)));
  const max = Math.ceil(peak / 2000) * 2000;
  const x = (s: number) => PAD.left + (s / end) * PLOT_W;
  const y = (diff: number) => PAD.top + PLOT_H / 2 - (diff / max) * (PLOT_H / 2);
  const zero = y(0);
  const line = t.gold.map((g, i) => `${i ? "L" : "M"}${x(g.s).toFixed(1)},${y(g.diff).toFixed(1)}`).join(" ");
  const area = t.gold.length ? `${line} L${x(t.gold.at(-1)!.s).toFixed(1)},${zero} L${x(t.gold[0].s).toFixed(1)},${zero} Z` : "";
  const ticks = Array.from({ length: Math.floor(end / 300) + 1 }, (_, i) => i * 300);
  const name = (side: Side) => (side === "blue" ? t.blue : t.red);
  const winner = t.winner ? name(t.winner) : null;
  const at15 = t.gold.find((g) => Math.abs(g.s - 900) <= 30);

  return (
    <div className="mt-4 border border-line">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-3 py-2 text-xs">
        <span>
          <span className="text-blue">{t.blue}</span> <span className="text-muted">({ui.side.blue}) vs</span> <span className="text-red">{t.red}</span>{" "}
          <span className="text-muted">({ui.side.red})</span>
        </span>
        <span className="text-muted">
          {t.label}
          {t.durationS ? ` · ${clock(t.durationS)}` : ""}
          {winner ? ui.timeline.victory : ""}
          {winner && <span className={SIDE_CLS[t.winner!]}>{winner}</span>}
          {` · match-v${t.version}`}
        </span>
      </div>

      <figure className="px-1 pt-2">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full"
          role="img"
          aria-label={ui.timeline.chart(t.blue, t.red, at15 ? gold(at15.diff, locale) : null)}
        >
          <defs>
            <clipPath id="gold-blue">
              <rect x={0} y={0} width={W} height={zero} />
            </clipPath>
            <clipPath id="gold-red">
              <rect x={0} y={zero} width={W} height={H - zero} />
            </clipPath>
          </defs>

          {[-max, -max / 2, max / 2, max].map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className="stroke-line" strokeDasharray="2 4" />
              <text x={PAD.left - 6} y={y(v) + 3} textAnchor="end" className={`text-[10px] ${v > 0 ? "fill-blue" : "fill-red"}`}>
                {gold(v, locale)}
              </text>
            </g>
          ))}
          <line x1={PAD.left} x2={W - PAD.right} y1={zero} y2={zero} className="stroke-muted" />
          <text x={PAD.left - 6} y={zero + 3} textAnchor="end" className="fill-muted text-[10px]">
            0
          </text>

          {ticks.map((s) => (
            <g key={s}>
              <line x1={x(s)} x2={x(s)} y1={PAD.top} y2={H - PAD.bottom} className="stroke-line" strokeDasharray="1 5" />
              <text x={x(s)} y={H - PAD.bottom + 14} textAnchor="middle" className="fill-muted text-[10px]">
                {s / 60}
              </text>
            </g>
          ))}
          <text x={W - PAD.right} y={H - 4} textAnchor="end" className="fill-muted text-[10px]">
            min
          </text>

          <path d={area} clipPath="url(#gold-blue)" className="fill-blue/15" />
          <path d={area} clipPath="url(#gold-red)" className="fill-red/15" />
          <path d={line} fill="none" className="stroke-foreground" strokeWidth={1.5} strokeLinejoin="round" />
          {t.gold.map((g) => (
            <circle key={g.s} cx={x(g.s)} cy={y(g.diff)} r={2.2} className="fill-foreground">
              <title>{`${clock(g.s)} : ${gold(g.diff, locale)} (${g.diff === 0 ? ui.timeline.tie : name(g.diff > 0 ? "blue" : "red")})`}</title>
            </circle>
          ))}

          {/* Blue side's events above the plot, red side's below the axis labels. */}
          {t.events.map((e, i) => {
            const top = e.side === "blue";
            const cx = x(e.s);
            const cy = top ? PAD.top - 12 : H - PAD.bottom + 4;
            const cls = top ? "fill-blue" : "fill-red";

            return (
              <g key={`${e.s}-${e.kind}-${i}`}>
                <title>{`${clock(e.s)} ${name(e.side)} : ${eventText(e, ui.timeline)}`}</title>
                {marks[e.kind] ? (
                  <text x={cx} y={top ? cy + 4 : cy + 22} textAnchor="middle" className={`${cls} text-[9px] font-semibold`}>
                    {marks[e.kind]}
                  </text>
                ) : (
                  <line x1={cx} x2={cx} y1={top ? PAD.top - 6 : H - PAD.bottom - 6} y2={top ? PAD.top : H - PAD.bottom} className={top ? "stroke-blue" : "stroke-red"} />
                )}
              </g>
            );
          })}
        </svg>
        <figcaption className="px-2 pb-2 text-[11px] text-muted">
          {ui.timeline.caption(t.blue, t.red)}
        </figcaption>
      </figure>

      <div className="border-t border-line px-3 py-2">
        <h3 className="text-xs uppercase tracking-widest text-muted">── {ui.timeline.keyEvents}</h3>
        <ol className="mt-2 grid grid-cols-[1fr_auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <li className="contents text-muted">
            <span className="text-right text-blue">{t.blue}</span>
            <span className="text-center">min</span>
            <span className="text-red">{t.red}</span>
          </li>
          {t.events.map((e, i) => (
            <li key={`${e.s}-${e.kind}-${i}`} className="contents">
              <span className={`text-right ${e.side === "blue" ? SIDE_CLS.blue : ""}`}>{e.side === "blue" ? `${eventText(e, ui.timeline)} ◂` : ""}</span>
              <span className="text-center tabular-nums text-muted">{clock(e.s)}</span>
              <span className={e.side === "red" ? SIDE_CLS.red : ""}>{e.side === "red" ? `▸ ${eventText(e, ui.timeline)}` : ""}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
