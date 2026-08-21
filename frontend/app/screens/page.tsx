import { store } from "@/server/store";
import { EmptyState } from "@/components/primitives";
import { ScreenTable } from "@/components/screens/ScreenTable";
import type { ScreenFramework } from "@/lib/types";

// Feature 4C — /screens view. Renders three framework rubrics
// (blue-ocean, rule-breaker, qarv) with a chip toggle. Absent →
// empty state pointing at the workflow (or refresh script for
// qarv). Reads all three files in parallel so tab-switching is
// instant.

interface Props {
  searchParams: Promise<{ framework?: string; ticker?: string }>;
}

export const dynamic = "force-dynamic";

const FRAMEWORK_LABEL: Record<ScreenFramework, string> = {
  "blue-ocean": "Blue Ocean · value-innovation",
  "rule-breaker": "Rule Breaker · Motley Fool",
  qarv: "QARV · Quality / Assets / Revisions / Value",
};

const FRAMEWORKS: ScreenFramework[] = ["blue-ocean", "rule-breaker", "qarv"];

function isFramework(v: string | undefined): v is ScreenFramework {
  return v === "blue-ocean" || v === "rule-breaker" || v === "qarv";
}

export default async function ScreensPage({ searchParams }: Props) {
  const sp = await searchParams;
  const framework: ScreenFramework = isFramework(sp.framework)
    ? sp.framework
    : "blue-ocean";
  // Optional deep-link ticker — when present, ScreenTable auto-
  // expands + scrolls + rings that row on mount. Coming from
  // TickerSignals framework badges on /s/[ticker].
  const highlightTicker = sp.ticker ?? null;

  const [blueOcean, ruleBreaker, qarv, sharedState] = await Promise.all([
    store.readScreen ? store.readScreen("blue-ocean") : Promise.resolve(null),
    store.readScreen ? store.readScreen("rule-breaker") : Promise.resolve(null),
    store.readScreen ? store.readScreen("qarv") : Promise.resolve(null),
    store.readSharedState(),
  ]);

  const byFramework: Record<
    ScreenFramework,
    import("@/lib/types").Screen | null
  > = {
    "blue-ocean": blueOcean,
    "rule-breaker": ruleBreaker,
    qarv,
  };
  const current = byFramework[framework];
  const counts: Record<ScreenFramework, number> = {
    "blue-ocean": blueOcean?.screens.length ?? 0,
    "rule-breaker": ruleBreaker?.screens.length ?? 0,
    qarv: qarv?.screens.length ?? 0,
  };

  function TabStrip() {
    return (
      <div className="flex flex-wrap rounded-button border border-bd bg-s1 p-[3px]">
        {FRAMEWORKS.map((f) => (
          <a
            key={f}
            href={`/screens?framework=${f}`}
            className={`rounded-[6px] px-3 py-[5px] text-[12.5px] ${
              framework === f
                ? "bg-s3 font-medium text-tx"
                : "text-tx2 hover:text-tx"
            }`}
          >
            {f === "blue-ocean"
              ? "Blue Ocean"
              : f === "rule-breaker"
              ? "Rule Breaker"
              : "QARV"}{" "}
            <span className="ml-1 font-mono text-[10.5px] text-tx3">
              {counts[f]}
            </span>
          </a>
        ))}
      </div>
    );
  }

  // Empty branch — still render the tab chips + header so the user
  // can flip to a framework that isn't empty. Hint text differs for
  // qarv (mechanical) vs the LLM-narrative frameworks.
  if (!current) {
    const hint =
      framework === "qarv"
        ? "Run scripts/run-qarv-screen.mjs to compute Quality / Assets / Revisions / Value percentile scores over the universe. Mechanical — no LLM, no workflow — takes ~2s."
        : "The framework-screen workflow rates ~1,000 US operating names on 5 frozen dimensions each. Cadence is monthly per framework — Blue Ocean fires the 1st, Rule Breaker the 2nd, at 12:00 UTC. Each run scores 8 tickers and self-chains until the universe is covered.";
    return (
      <div className="mx-auto max-w-[1400px] px-10 py-8">
        <div className="mb-6">
          <div className="mono-eyebrow mb-3">§ Screens · Framework rubrics</div>
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">
            {FRAMEWORK_LABEL[framework]} — no snapshot yet
          </h1>
          <p className="mt-2 max-w-[68ch] text-[13px] text-tx-mid">{hint}</p>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <TabStrip />
        </div>

        <EmptyState
          title="Waiting for first run"
          hint={
            framework === "qarv"
              ? "node scripts/run-qarv-screen.mjs will populate the entire universe in one pass."
              : "To fire earlier: open the repo's Actions tab, pick 'framework-screen', click 'Run workflow', choose the framework + batch_size."
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1800px] px-10 py-8">
      <div className="mb-6">
        <div className="mono-eyebrow mb-3">§ Screens · Framework rubrics</div>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">
          {current.screens.length} companies screened · {FRAMEWORK_LABEL[framework]}
        </h1>
        <p className="mt-2 max-w-[68ch] text-[13px] text-tx-mid">
          {framework === "qarv"
            ? `Composite = mean of the ${current.dimensions.length} percentile-ranked factors. Sorted composite descending. Refreshes deterministically from events-index — re-run scripts/run-qarv-screen.mjs whenever new earnings land.`
            : `Composite = mean of the ${current.dimensions.length} dimensions shown in the header. Sorted composite descending. Cards score slowly — the monthly workflow refreshes each ticker at a 45-day minimum staleness window.`}
        </p>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-tx3">
          <span>updated {current.generatedAt.slice(0, 16).replace("T", " ")}Z</span>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <TabStrip />
      </div>

      <ScreenTable
        screen={current}
        highlightTicker={highlightTicker}
        initialState={sharedState}
      />
    </div>
  );
}
