import { say } from "./messages";

export const MINUTES = [10, 15, 20] as const;

export type Minute = (typeof MINUTES)[number];

export const PLAYER_METRICS = [
  "solo_kills",
  "penta_kills",
  "quadra_kills",
  "triple_kills",
  "double_kills",
  "first_bloods",
  "kills_before_10",
  "gold_diff",
  "cs_diff",
  "xp_diff",
  "gold",
  "cs",
  "xp",
  "wards_placed",
  "wards_killed",
  "control_wards",
  "plates",
] as const;

export type PlayerMetric = (typeof PLAYER_METRICS)[number];

export const TEAM_METRICS = [
  "first_blood",
  "first_tower",
  "first_dragon",
  "first_herald",
  "first_baron",
  "gold_diff",
  "kills_before_10",
  "plates",
  "dragon_soul",
  "elder_dragons",
] as const;

export type TeamMetric = (typeof TEAM_METRICS)[number];

export type Aggregate = "sum" | "avg" | "rate";

type MetricDef = {
  label: string;
  en: string;
  aggregate: Aggregate;
  column: string;
  snapshot?: true;
};

const at = (column: string) => ({ column, snapshot: true as const });

export const PLAYER_METRIC_DEFS: Record<PlayerMetric, MetricDef> = {
  solo_kills: { label: "solo kills", en: "solo kills", aggregate: "sum", column: "solo_kills" },
  penta_kills: { label: "pentakills", en: "pentakills", aggregate: "sum", column: "penta_kills" },
  quadra_kills: { label: "quadrakills", en: "quadrakills", aggregate: "sum", column: "quadra_kills" },
  triple_kills: { label: "triple kills", en: "triple kills", aggregate: "sum", column: "triple_kills" },
  double_kills: { label: "double kills", en: "double kills", aggregate: "sum", column: "double_kills" },
  first_bloods: { label: "first bloods", en: "first bloods", aggregate: "sum", column: "first_blood_kill" },
  kills_before_10: { label: "kills avant 10 min", en: "kills before 10 min", aggregate: "sum", column: "kills_10" },
  gold_diff: { label: "écart d'or face à l'adversaire direct", en: "gold difference with the lane opponent", aggregate: "avg", ...at("gold_diff") },
  cs_diff: { label: "écart de CS face à l'adversaire direct", en: "CS difference with the lane opponent", aggregate: "avg", ...at("cs_diff") },
  xp_diff: { label: "écart d'XP face à l'adversaire direct", en: "XP difference with the lane opponent", aggregate: "avg", ...at("xp_diff") },
  gold: { label: "or", en: "gold", aggregate: "avg", ...at("gold") },
  cs: { label: "CS", en: "CS", aggregate: "avg", ...at("cs") },
  xp: { label: "XP", en: "XP", aggregate: "avg", ...at("xp") },
  wards_placed: { label: "wards posées", en: "wards placed", aggregate: "avg", column: "wards_placed" },
  wards_killed: { label: "wards détruites", en: "wards killed", aggregate: "avg", column: "wards_killed" },
  control_wards: { label: "control wards achetées", en: "control wards bought", aggregate: "avg", column: "control_wards" },
  plates: { label: "plaques de tourelle", en: "turret plates", aggregate: "sum", column: "plates" },
};

export const TEAM_METRIC_DEFS: Record<TeamMetric, MetricDef> = {
  first_blood: { label: "first blood", en: "first blood", aggregate: "rate", column: "first_blood" },
  first_tower: { label: "première tourelle", en: "first tower", aggregate: "rate", column: "first_tower" },
  first_dragon: { label: "premier dragon", en: "first dragon", aggregate: "rate", column: "first_dragon" },
  first_herald: { label: "premier héraut", en: "first herald", aggregate: "rate", column: "first_herald" },
  first_baron: { label: "premier baron", en: "first baron", aggregate: "rate", column: "first_baron" },
  gold_diff: { label: "écart d'or d'équipe", en: "team gold difference", aggregate: "avg", ...at("gold_diff") },
  kills_before_10: { label: "kills avant 10 min", en: "kills before 10 min", aggregate: "avg", column: "kills_10" },
  plates: { label: "plaques de tourelle prises", en: "turret plates taken", aggregate: "avg", column: "plates" },
  dragon_soul: { label: "âme du dragon", en: "dragon soul", aggregate: "rate", column: "dragon_soul" },
  elder_dragons: { label: "dragons ancestraux", en: "elder dragons", aggregate: "sum", column: "elder_dragons" },
};

export function metricColumn(def: MetricDef, minute: Minute | null): string {
  return def.snapshot ? `${def.column}_${minute ?? 15}` : def.column;
}

export function metricLabel(def: MetricDef, minute: Minute | null): string {
  return say(def.snapshot ? `${def.label} à ${minute ?? 15} min` : def.label, def.snapshot ? `${def.en} at ${minute ?? 15} min` : def.en);
}

const ELEMENTS = "infernale?s?|infernaux|(?:des |de l'|d')?oc[ée]ans?|(?:des |de la )?montagnes?|mountains?|(?:des |du )?nuages?|clouds?|hextech|chemtech|techno-?chimiques?";

const word = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, "iu");

export const MINUTE = /(?<![\p{L}\p{N}])(?:(?:à|a|at|@)\s*(\d{1,2})(?:\s*(?:min(?:ute)?s?|'))?(?![\p{L}\p{N}])|(\d{1,2})\s*(?:min(?:ute)?s?(?!\p{L})|'))/iu;

export function detectMinute(question: string): number | null {
  const n = MINUTE.exec(question)?.slice(1).find(Boolean);

  return n == null ? null : Number(n);
}

export const heldMinute = (n: number | null): Minute | null => MINUTES.find((m) => m === n) ?? null;

export const isSnapshot = (cue: Pick<MetricCue, "player" | "team">): boolean =>
  (cue.player != null && PLAYER_METRIC_DEFS[cue.player].snapshot === true) || (cue.team != null && TEAM_METRIC_DEFS[cue.team].snapshot === true);

const AT_MINUTE = "(?:à|a|at|@) ?\\d{1,2} ?(?:min(?:ute)?s?|')";

const CUES: { pattern: RegExp; player: PlayerMetric | null; team: TeamMetric | null }[] = [
  { pattern: word("solo ?kills?"), player: "solo_kills", team: null },
  { pattern: word("penta ?kills?|pentas?"), player: "penta_kills", team: null },
  { pattern: word("quadra ?kills?|quadras?"), player: "quadra_kills", team: null },
  { pattern: word("triple ?kills?"), player: "triple_kills", team: null },
  { pattern: word("double ?kills?"), player: "double_kills", team: null },
  { pattern: word("multi ?kills?"), player: "penta_kills", team: null },
  { pattern: word("first ?bloods?|premiers? sangs?"), player: "first_bloods", team: "first_blood" },
  { pattern: word("first ?towers?|premi[eè]res? tou?r(?:elle)?s?"), player: null, team: "first_tower" },
  { pattern: word("first ?dragons?|first ?drakes?|premiers? dragons?"), player: null, team: "first_dragon" },
  { pattern: word("(?:dragons?|drakes?) ancestra(?:l|ux)|elder ?(?:dragons?|drakes?)|elders?|ancestra(?:l|ux)"), player: null, team: "elder_dragons" },
  {
    pattern: word(
      `[âa]mes? (?:du |de |des |d')(?:dragons?|drakes?)|[âa]mes? (?:${ELEMENTS})|âmes?|(?:${ELEMENTS}) souls?|(?:dragon|drake) ?souls?|souls?|` +
        `types? de (?:dragons?|drakes?)|[ée]l[ée]ments? (?:de|des|du) (?:dragons?|drakes?)|(?:dragons?|drakes?) (?:[ée]l[ée]mentaires?|${ELEMENTS})|(?:${ELEMENTS}) (?:dragons?|drakes?)`,
    ),
    player: null,
    team: "dragon_soul",
  },
  { pattern: word("first ?heralds?|premiers? h[ée]rauts?"), player: null, team: "first_herald" },
  { pattern: word("first ?barons?|first ?nashors?|premiers? barons?|premiers? nashors?"), player: null, team: "first_baron" },
  {
    pattern: word("kills? (?:avant|before|en moins de|sous) (?:les )?10|kills? (?:à|a|at) 10|early kills?|kills? en early"),
    player: "kills_before_10",
    team: "kills_before_10",
  },
  { pattern: word("cs ?diff(?:erence)?s?|[ée]carts? de cs|diff[ée]rences? de cs|cs d'avance|avance (?:en|de) cs"), player: "cs_diff", team: null },
  { pattern: word("xp ?diff(?:erence)?s?|[ée]carts? d'(?:xp|exp[ée]rience)|diff[ée]rences? d'(?:xp|exp[ée]rience)"), player: "xp_diff", team: null },
  {
    pattern: word("gold ?diff(?:erence)?s?|gold ?leads?|golds? d'avance|[ée]carts? (?:d'or|de golds?)|diff[ée]rences? (?:d'or|de golds?)|avance (?:en|d') ?or|avance en golds?"),
    player: "gold_diff",
    team: "gold_diff",
  },
  { pattern: word("control ?wards?|pinks?|balises? de contr[ôo]le"), player: "control_wards", team: null },
  { pattern: word("(?:wards?|balises?) (?:d[ée]truites?|killed|cleared|tu[ée]es?)|dewards?"), player: "wards_killed", team: null },
  { pattern: word("wards?|balises?"), player: "wards_placed", team: null },
  { pattern: word("plates?|plaques?"), player: "plates", team: "plates" },
  { pattern: word(`(?:gold|golds|or) (?:à|a|at|@) ?(?:10|15|20)|(?:gold|golds|or) ${AT_MINUTE}`), player: "gold", team: null },
  { pattern: word(`cs (?:à|a|at|@) ?(?:10|15|20)|cs ${AT_MINUTE}`), player: "cs", team: null },
  { pattern: word(`(?:xp|exp[ée]rience) (?:à|a|at|@) ?(?:10|15|20)|(?:xp|exp[ée]rience) ${AT_MINUTE}`), player: "xp", team: null },
];

export const isDragonCue = (cue: Pick<MetricCue, "team">): boolean => cue.team === "dragon_soul" || cue.team === "elder_dragons";

export const DRAGON_ELEMENT = word(ELEMENTS);

export type MetricCue = { player: PlayerMetric | null; team: TeamMetric | null; minute: Minute | null; askedMinute: number | null; mention: string };

export function detectMetric(question: string): MetricCue | null {
  for (const c of CUES) {
    const m = c.pattern.exec(question);

    if (m) {
      const askedMinute = detectMinute(question);

      return { player: c.player, team: c.team, minute: heldMinute(askedMinute), askedMinute, mention: m[0] };
    }
  }

  return null;
}
