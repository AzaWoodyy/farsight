import type { PlayerProfile } from "@/lib/agent/types";
import { useUi } from "./i18n/locale-context";
import { PlayerAvatar } from "./player-avatar";

/** Teams shown before the "+n": a long career would push the line past a phone's width. */
const TEAMS = 3;

/**
 * Who a player's statistics are about: their photo of the period, main role and teams over the scope of the answer.
 * The photo links to its Leaguepedia file page, which names its author and licence.
 */
export function PlayerHeader({ p }: { p: PlayerProfile }) {
  const ui = useUi();
  const extra = p.teams.length - TEAMS;

  return (
    <div className="mt-4 flex items-center gap-3">
      {p.photo ? (
        <a href={p.photo.source} target="_blank" rel="noreferrer" aria-label={ui.player.photo(p.photo.year)} className="shrink-0">
          <PlayerAvatar name={p.player} photo={p.photo} size={56} />
        </a>
      ) : (
        <PlayerAvatar name={p.player} photo={null} size={56} />
      )}
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold" translate="no">
          {p.player}
        </div>
        <div className="truncate text-xs text-muted">
          {[p.role, p.teams.slice(0, TEAMS).join(", ") + (extra > 0 ? ui.player.more(extra) : "")].filter(Boolean).join(" · ")}
        </div>
        {p.photo && <div className="text-[11px] text-muted">{ui.player.photo(p.photo.year)}</div>}
      </div>
    </div>
  );
}
