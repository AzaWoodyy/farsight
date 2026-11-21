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

export function runeIcon(name: string, stored: string | null): string | null {
  const path = PATHS.get(name);

  return stored ?? (path ? `${CDN}/${path}` : null);
}

const TREES = new Map([
  ["Domination", "Styles/7200_Domination.png"],
  ["Precision", "Styles/7201_Precision.png"],
  ["Sorcery", "Styles/7202_Sorcery.png"],
  ["Inspiration", "Styles/7203_Whimsy.png"],
  ["Resolve", "Styles/7204_Resolve.png"],
]);

export function treeIcon(tree: string): string | null {
  const path = TREES.get(tree);

  return path ? `${CDN}/${path}` : null;
}
