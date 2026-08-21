import Link from "next/link";
import type { Entity, SectorSignals } from "@/lib/types";

// Structural / geo tags — don't render as sector chips (they're not
// themes). Kept in sync with the same set used by
// aggregate-by-sector.mjs.
const STRUCTURAL_TAGS = new Set([
  "etf",
  "developer",
  "canada",
  "brazil",
  "emerging-markets",
]);

// Sector chips on the ticker header — deep-links into /themes with
// a hash anchor so the target sector card scrolls into view. Only
// renders tags that actually appear in the current sector-signals
// snapshot; the rest are silently dropped (avoids dead links to
// too-thin sectors that got filtered out of the rollup).
export function SectorChips({
  entity,
  sectorSignals,
}: {
  entity: Entity;
  sectorSignals: SectorSignals | null;
}) {
  const tags = Array.isArray(entity.sectorTags) ? entity.sectorTags : [];
  if (tags.length === 0) return null;

  const inRollup = new Set(
    (sectorSignals?.sectors ?? []).map((s) => s.sector),
  );
  // Render tags that map to a sector currently in the rollup;
  // structural tags never render.
  const chips = tags.filter(
    (t) => !STRUCTURAL_TAGS.has(t) && inRollup.has(t),
  );
  if (chips.length === 0) return null;

  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-1.5"
      aria-label="Sector themes for this ticker"
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.07em] text-tx3">
        themes:
      </span>
      {chips.map((tag) => (
        <Link
          key={tag}
          href={`/themes#sector-${encodeURIComponent(tag)}`}
          className="rounded-[4px] border border-bd bg-panel2/60 px-1.5 py-[2px] font-mono text-[10.5px] uppercase tracking-[0.06em] text-tx-mid hover:border-brand/40 hover:text-brand-fg"
          title={`Open /themes → ${tag} section`}
        >
          {tag}
        </Link>
      ))}
    </div>
  );
}
