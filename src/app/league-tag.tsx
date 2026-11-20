import { useUi } from "./i18n/locale-context";

/**
 * The league a team played in over the answer's period, beside its name: "LCK", "LCK CL", or "LFL D2 → LFL"
 * when it moved up. Nothing when the answer has none for that name.
 */
export function LeagueTag({ leagues }: { leagues?: string[] }) {
  const ui = useUi();

  if (!leagues?.length) return null;

  return (
    <span title={ui.teamLeague(leagues)} className="shrink-0 whitespace-nowrap border border-line px-1 text-[10px] font-normal leading-4 tracking-wider text-muted" translate="no">
      <span aria-hidden="true">{leagues.join(" → ")}</span>
      <span className="sr-only">{ui.teamLeague(leagues)}</span>
    </span>
  );
}
