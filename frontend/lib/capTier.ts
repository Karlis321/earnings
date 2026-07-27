// Market-cap tiering (USD).
//
//   mega   ≥ $200B
//   large  $10B – $200B
//   mid    $2B – $10B
//   small  $250M – $2B
//   unknown  everything else (nano-cap, missing data, non-equity)
//
// Definitions match the standard institutional split; `mega` is broken out
// so a portfolio watchlist can distinguish NVDA/MSFT-style names from
// merely-"large" names without recalculating.

import type { CapTier } from "./types";

const MEGA = 200_000_000_000;
const LARGE = 10_000_000_000;
const MID = 2_000_000_000;
const SMALL = 250_000_000;

export function capTierFor(marketCapUsd: number | null | undefined): CapTier {
  if (marketCapUsd == null || Number.isNaN(marketCapUsd)) return "unknown";
  if (marketCapUsd >= MEGA) return "mega";
  if (marketCapUsd >= LARGE) return "large";
  if (marketCapUsd >= MID) return "mid";
  if (marketCapUsd >= SMALL) return "small";
  return "unknown";
}

export function capTierLabel(t: CapTier): string {
  return {
    mega: "Mega ≥ $200B",
    large: "Large $10B–$200B",
    mid: "Mid $2B–$10B",
    small: "Small $250M–$2B",
    unknown: "Nano / unknown",
  }[t];
}
