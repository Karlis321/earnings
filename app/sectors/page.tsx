import Link from "next/link";
import { data } from "@/lib/data";
import { Panel } from "@/components/primitives";

export default function SectorsPage() {
  const sectors = data.getSectors();
  return (
    <div className="mx-auto max-w-[1200px] px-10 py-8">
      <div className="mb-6">
        <div className="mono-eyebrow mb-3">§ Sectors · Phase 3</div>
        <h1 className="text-[28px] font-semibold tracking-[-0.02em]">
          Sector view
        </h1>
        <p className="mt-2 max-w-[64ch] text-[13.5px] text-tx2">
          Thematic grouping across covered names. The LLM sector-read is
          disabled in $0 mode.
        </p>
      </div>

      <Panel eyebrow="Sectors · from registry sectorTags" padded={false}>
        <div className="grid grid-cols-1 divide-y divide-bd md:grid-cols-2 md:divide-y-0">
          {sectors.map((s) => (
            <Link
              key={s.id}
              href={`/sectors/${encodeURIComponent(s.id)}`}
              className="flex items-center justify-between px-5 py-4 hover:bg-hover"
            >
              <div>
                <div className="text-[14px] text-tx capitalize">{s.id}</div>
                <div className="mt-1 font-mono text-[11px] text-tx3">
                  {s.count} member{s.count === 1 ? "" : "s"}
                </div>
              </div>
              <span className="text-tx3">→</span>
            </Link>
          ))}
        </div>
      </Panel>
    </div>
  );
}
