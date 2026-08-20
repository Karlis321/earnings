import { store } from "@/server/store";
import { EmptyState } from "@/components/primitives";
import { ScreenTable } from "@/components/screens/ScreenTable";
import type { ScreenFramework } from "@/lib/types";

// Feature 4C — /screens view. Renders the two framework rubrics
// (blue-ocean, rule-breaker) with a chip toggle. Absent → empty
// state pointing at the workflow. Reads both files in parallel so
// tab-switching is instant.

interface Props {
  searchParams: Promise<{ framework?: string }>;
}

export const dynamic = "force-dynamic";

const FRAMEWORK_LABEL: Record<ScreenFramework, string> = {
  "blue-ocean": "Blue Ocean · value-innovation",
  "rule-breaker": "Rule Breaker · Motley Fool",
};

export default async function ScreensPage({ searchParams }: Props) {
  const sp = await searchParams;
  const requested = (sp.framework as ScreenFramework) ?? "blue-ocean";
  const framework: ScreenFramework =
    requested === "rule-breaker" ? "rule-breaker" : "blue-ocean";

  const [blueOcean, ruleBreaker] = await Promise.all([
    store.readScreen ? store.readScreen("blue-ocean") : Promise.resolve(null),
    store.readScreen ? store.readScreen("rule-breaker") : Promise.resolve(null),
  ]);

  const current = framework === "blue-ocean" ? blueOcean : ruleBreaker;

  if (!current) {
    return (
      <div className="mx-auto max-w-[1400px] px-10 py-8">
        <div className="mb-6">
          <div className="mono-eyebrow mb-3">§ Screens · Framework rubrics</div>
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">
            No {FRAMEWORK_LABEL[framework]} snapshot yet
          </h1>
        </div>
        <EmptyState
          title="Workflow hasn't run yet"
          hint="framework-screen.yml fires on the 1st/2nd of each month, or dispatch it manually from the GitHub Actions tab (choose blue-ocean or rule-breaker + batch_size). First run scores 8 tickers; chained runs cover the ~1,000-name universe over multiple days."
        />
      </div>
    );
  }

  const blueOceanCount = blueOcean?.screens.length ?? 0;
  const ruleBreakerCount = ruleBreaker?.screens.length ?? 0;

  return (
    <div className="mx-auto max-w-[1800px] px-10 py-8">
      <div className="mb-6">
        <div className="mono-eyebrow mb-3">§ Screens · Framework rubrics</div>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em]">
          {current.screens.length} companies screened · {FRAMEWORK_LABEL[framework]}
        </h1>
        <p className="mt-2 max-w-[68ch] text-[13px] text-tx-mid">
          Composite = mean of the {current.dimensions.length} dimensions
          shown in the header. Sorted composite descending. Cards score
          slowly — the monthly workflow refreshes each ticker at a 45-day
          minimum staleness window.
        </p>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-tx3">
          <span>updated {current.generatedAt.slice(0, 16).replace("T", " ")}Z</span>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap rounded-button border border-bd bg-s1 p-[3px]">
          <a
            href="/screens?framework=blue-ocean"
            className={`rounded-[6px] px-3 py-[5px] text-[12.5px] ${
              framework === "blue-ocean"
                ? "bg-s3 font-medium text-tx"
                : "text-tx2 hover:text-tx"
            }`}
          >
            Blue Ocean{" "}
            <span className="ml-1 font-mono text-[10.5px] text-tx3">
              {blueOceanCount}
            </span>
          </a>
          <a
            href="/screens?framework=rule-breaker"
            className={`rounded-[6px] px-3 py-[5px] text-[12.5px] ${
              framework === "rule-breaker"
                ? "bg-s3 font-medium text-tx"
                : "text-tx2 hover:text-tx"
            }`}
          >
            Rule Breaker{" "}
            <span className="ml-1 font-mono text-[10.5px] text-tx3">
              {ruleBreakerCount}
            </span>
          </a>
        </div>
      </div>

      <ScreenTable screen={current} />
    </div>
  );
}
