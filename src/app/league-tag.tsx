import { useUi } from "./i18n/locale-context";

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
