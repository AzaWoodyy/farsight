/**
 * Icons of the runes the current Data Dragon no longer lists: the runes Riot removed since 2018 (Zombie Ward,
 * Predator, Kleptomancy...) and the stat shards, which `runesReforged.json` never listed. Their images are
 * still served under Data Dragon's unversioned `cdn/img/`, at the paths older versions gave.
 *
 * Read when the database has no icon for a rune, so an old game's rune page shows every rune as an icon.
 */
const CDN = "https://ddragon.leagueoflegends.com/cdn/img/perk-images";

const PATHS = new Map([
  ["Predator", "Styles/Domination/Predator/Predator.png"],
  ["Zombie Ward", "Styles/Domination/ZombieWard/ZombieWard.png"],
  ["Ghost Poro", "Styles/Domination/GhostPoro/GhostPoro.png"],
  ["Eyeball Collection", "Styles/Domination/EyeballCollection/EyeballCollection.png"],
  ["Ravenous Hunter", "Styles/Domination/RavenousHunter/RavenousHunter.png"],
  ["Ingenious Hunter", "Styles/Domination/IngeniousHunter/IngeniousHunter.png"],
  ["Kleptomancy", "Styles/Inspiration/Kleptomancy/Kleptomancy.png"],
  ["Prototype: Omnistone", "Styles/Inspiration/MasterKey/MasterKey.png"],
  ["Perfect Timing", "Styles/Inspiration/PerfectTiming/PerfectTiming.png"],
  ["Future's Market", "Styles/Inspiration/FuturesMarket/FuturesMarket.png"],
  ["Minion Dematerializer", "Styles/Inspiration/MinionDematerializer/MinionDematerializer.png"],
  ["Overheal", "Styles/Precision/Overheal.png"],
  ["Legend: Tenacity", "Styles/Precision/LegendTenacity/LegendTenacity.png"],
  ["Phase Rush", "Styles/Sorcery/PhaseRush/PhaseRush.png"],
  ["Nullifying Orb", "Styles/Sorcery/NullifyingOrb/Pokeshield.png"],
  // Stat shards.
  ["Adaptive Force", "StatMods/StatModsAdaptiveForceIcon.png"],
  ["Armor", "StatMods/StatModsArmorIcon.png"],
  ["Attack Speed", "StatMods/StatModsAttackSpeedIcon.png"],
  ["Ability Haste", "StatMods/StatModsCDRScalingIcon.png"],
  ["Magic Resistance", "StatMods/StatModsMagicResIcon.MagicResist_Fix.png"],
  ["Health Scaling", "StatMods/StatModsHealthScalingIcon.png"],
  ["Health", "StatMods/StatModsHealthPlusIcon.png"],
  ["Move Speed", "StatMods/StatModsMovementSpeedIcon.png"],
  ["Tenacity and Slow Resist", "StatMods/StatModsTenacityIcon.png"],
]);

/** The icon of a rune: the one stored with it, else the one of a removed rune or a stat shard; null when neither. */
export function runeIcon(name: string, stored: string | null): string | null {
  const path = PATHS.get(name);

  return stored ?? (path ? `${CDN}/${path}` : null);
}
