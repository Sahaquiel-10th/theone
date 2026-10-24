import type { AccountProfile, AppearanceScene } from "../server/betaProfile";

/** Missing preferences from existing accounts inherit the approved default.
 * Device execution never writes back to this account-level choice. */
export function resolvedAppearanceScene(profile?: Pick<AccountProfile, "appearance"> | null): AppearanceScene {
  return profile?.appearance?.scene === "silver" ? "silver" : "graphite";
}

export type { AppearanceScene };
