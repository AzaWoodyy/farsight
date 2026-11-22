import { frFR } from "@clerk/localizations";

type French = typeof frFR;

const NEVER_SHOWN = [
  "apiKeys",
  "billing",
  "configureDirectorySync",
  "configureSSO",
  "createOrganization",
  "impersonationFab",
  "maintenanceMode",
  "oauthConsent",
  "oauthDeviceVerification",
  "organizationList",
  "organizationProfile",
  "organizationSwitcher",
  "taskChooseOrganization",
  "taskSetupMfa",
  "waitlist",
  "web3SolanaWalletButtons",
] as const satisfies readonly (keyof French)[];

const SIGNED_OUT_ONLY = ["signIn", "signUp"] as const satisfies readonly (keyof French)[];

const SIGNED_IN_ONLY = ["reverification", "userButton", "userProfile"] as const satisfies readonly (keyof French)[];

function without(dropped: readonly (keyof French)[]): Partial<French> {
  const left = new Set<string>([...NEVER_SHOWN, ...dropped]);

  return Object.fromEntries(Object.entries(frFR).filter(([key]) => !left.has(key)));
}

export const FRENCH_AT_THE_DOOR = without(SIGNED_IN_ONLY);

export const FRENCH_IN_THE_ROOM = without(SIGNED_OUT_ONLY);
